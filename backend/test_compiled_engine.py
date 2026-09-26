"""Tests for the chunk renderer: state flattening, batched codec, compile plumbing."""

import gc
import os
import sys
import unittest
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _mlx():
    try:
        import mlx.core as mx
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise unittest.SkipTest(f"MLX unavailable: {exc}")
    return mx


def _sl():
    try:
        import magenta_rt  # noqa: F401 - installs the vendored sequence_layers hook
        import sequence_layers.mlx as sl
    except ImportError as exc:  # pragma: no cover
        raise unittest.SkipTest(f"sequence_layers unavailable: {exc}")
    return sl


class FlattenTests(unittest.TestCase):
    def test_round_trips_nested_state_with_sequences_dicts_and_constants(self):
        mx = _mlx()
        sl = _sl()
        from compiled_engine import flatten, leaf_count, rebuild

        seq = sl.Sequence(mx.arange(6).reshape(1, 2, 3), mx.ones((1, 2), dtype=mx.bool_))
        masked = sl.Sequence.from_values(mx.zeros((1, 1, 4), dtype=mx.int32))
        tree = (
            (),
            masked,
            (mx.array([[1, 2]], dtype=mx.uint32), seq, [(), (mx.zeros(3),)], 7),
            {"temperature": mx.array([1.0]), "top_k": mx.array([100], dtype=mx.int32)},
            None,
        )
        leaves, skeleton = flatten(tree, mx)
        self.assertEqual(len(leaves), leaf_count(skeleton))
        self.assertEqual(len(leaves), 2 + 1 + 2 + 1 + 2)
        self.assertTrue(all(isinstance(leaf, mx.array) for leaf in leaves))

        rebuilt = rebuild(skeleton, leaves)
        self.assertEqual(rebuilt[0], ())
        self.assertIs(type(rebuilt[1]), type(masked))
        self.assertIs(type(rebuilt[2][1]), type(seq))
        self.assertEqual(rebuilt[2][3], 7)
        self.assertIsNone(rebuilt[4])
        self.assertEqual(list(rebuilt[3]), ["temperature", "top_k"])
        np.testing.assert_array_equal(np.asarray(rebuilt[2][1].values), np.asarray(seq.values))
        np.testing.assert_array_equal(np.asarray(rebuilt[1].mask), np.asarray(masked.mask))
        # Skeletons are hashable and equal for equal structure.
        self.assertEqual(hash(skeleton), hash(flatten(rebuilt, mx)[1]))

    def test_leaf_count_mismatch_is_reported(self):
        mx = _mlx()
        from compiled_engine import SkeletonMismatch, flatten, rebuild

        leaves, skeleton = flatten((mx.zeros(1), mx.zeros(1)), mx)
        with self.assertRaises(SkeletonMismatch):
            rebuild(skeleton, leaves[:1])

    def test_flatten_and_rebuild_leave_no_cyclic_garbage(self):
        """A self-referential closure would keep every state array alive.

        The codec state is a set of views into a chunk's activations, so any
        cycle here pins hundreds of megabytes until the collector runs.
        """
        mx = _mlx()
        from compiled_engine import flatten, rebuild

        tree = (mx.zeros((4, 4)), [mx.ones(2), (mx.zeros(1), {"k": mx.ones(1)})])
        gc.collect()
        gc.disable()
        try:
            for _ in range(20):
                leaves, skeleton = flatten(tree, mx)
                tree = rebuild(skeleton, leaves)
            del leaves, skeleton
            self.assertEqual(gc.collect(), 0)
        finally:
            gc.enable()


class _FakeCodecLayer:
    """A causal layer with delay state: out[t] = tok[t] + tok[t-1]."""

    def __init__(self, sl, mx):
        self.sl = sl
        self.mx = mx

    def step_with_emits(self, x, state, *, training=False, constants=None):
        mx = self.mx
        (previous,) = state
        values = x.values.astype(mx.int32)
        shifted = mx.concatenate([previous, values[:, :-1]], axis=1)
        out = values + shifted
        # Return a view into this chunk's activations, exactly as the codec does.
        return self.sl.Sequence(out, x.mask), (values[:, -1:],), ()


class RendererTests(unittest.TestCase):
    def _renderer(self, *, batch_codec=True, compile_enabled=False):
        mx = _mlx()
        sl = _sl()
        from compiled_engine import ChunkRenderer

        layer0 = SimpleNamespace()  # no fast-engine attributes: compile must stay off
        codec = _FakeCodecLayer(sl, mx)
        sampler = SimpleNamespace(layers=[layer0, codec])
        config = SimpleNamespace(num_active_codebooks=None, num_codebooks=12)
        return (
            ChunkRenderer(
                sampler, config, mx, sl, compile_enabled=compile_enabled, batch_codec=batch_codec
            ),
            mx,
        )

    def test_batched_decode_matches_per_frame_decode_and_carries_state(self):
        batched, mx = self._renderer(batch_codec=True)
        per_frame, _ = self._renderer(batch_codec=False)
        frames = [mx.array([[[i, 10 * i]]], dtype=mx.uint32) for i in range(1, 6)]
        # One codec layer, whose own state is a one-tuple.
        state = ((mx.zeros((1, 1, 2), dtype=mx.int32),),)

        pcm_a, state_a = batched.decode(frames, state)
        pcm_b, state_b = per_frame.decode(frames, state)
        mx.eval(pcm_a, pcm_b, state_a, state_b)
        np.testing.assert_array_equal(np.asarray(pcm_a), np.asarray(pcm_b))
        np.testing.assert_array_equal(np.asarray(state_a[0][0]), np.asarray(state_b[0][0]))
        # out[t] = tok[t] + tok[t-1]: [1, 3, 5, 7, 9] for the first channel.
        np.testing.assert_array_equal(np.asarray(pcm_a)[0, :, 0], [1, 3, 5, 7, 9])
        np.testing.assert_array_equal(np.asarray(state_a[0][0])[0, 0], [5, 50])

    def test_returned_state_is_detached_from_chunk_activations(self):
        renderer, mx = self._renderer()
        from compiled_engine import flatten

        frames = [mx.array([[[i, i]]], dtype=mx.uint32) for i in range(1, 11)]
        state = ((mx.zeros((1, 1, 2), dtype=mx.int32),),)
        _pcm, new_state = renderer.decode(frames, state)
        mx.eval(new_state)
        leaves, _ = flatten(new_state, mx)
        for leaf in leaves:
            # Detached leaves are their own buffers: contiguous() is a no-op
            # copy here, so the values survive dropping every other reference.
            self.assertEqual(tuple(leaf.shape), (1, 1, 2))
        np.testing.assert_array_equal(np.asarray(leaves[0])[0, 0], [10, 10])

    def test_compile_is_refused_without_the_fast_engine(self):
        renderer, _ = self._renderer(compile_enabled=True)
        self.assertFalse(renderer.compiled)
        self.assertEqual(renderer.status.compile_disabled_reason, "fast engine not installed")
        self.assertIn("compile off", renderer.status.summary())

    def test_a_failing_compiled_codec_falls_back_to_eager_and_stays_off(self):
        renderer, mx = self._renderer(batch_codec=True)
        renderer._compile_codec = True
        renderer.status.compiled_codec = True

        def broken(*_args, **_kwargs):
            raise RuntimeError("trace exploded")

        renderer._codec_fn = broken
        frames = [mx.array([[[i, i]]], dtype=mx.uint32) for i in range(1, 4)]
        state = ((mx.zeros((1, 1, 2), dtype=mx.int32),),)
        with self.assertLogs("compiled_engine", level="WARNING") as logs:
            pcm, _new_state = renderer.decode(frames, state)
        mx.eval(pcm)
        np.testing.assert_array_equal(np.asarray(pcm)[0, :, 0], [1, 3, 5])
        self.assertFalse(renderer._compile_codec)
        self.assertFalse(renderer.status.compiled_codec)
        self.assertIn("trace exploded", logs.output[0])

    def test_prewarm_covers_every_count_and_chunk_length_once(self):
        renderer, _ = self._renderer(compile_enabled=False)
        renderer._compile_step = True  # pretend compilation is live
        calls = []
        counts = []
        elapsed = renderer.prewarm(
            lambda frames: calls.append(frames),
            [10, 11, 12],
            (8, 10, 10, 0),
            counts.append,
        )
        self.assertEqual(counts, [10, 11, 12])
        self.assertEqual(calls, [8, 10] * 3)
        self.assertGreaterEqual(elapsed, 0.0)

    def test_prewarm_is_a_no_op_when_nothing_is_compiled(self):
        renderer, _ = self._renderer(compile_enabled=False)
        self.assertEqual(renderer.prewarm(lambda frames: self.fail("rendered"), [12], (10,), lambda c: None), 0.0)


class StatusTests(unittest.TestCase):
    def test_summary_reports_each_installed_piece(self):
        from compiled_engine import RendererStatus

        self.assertEqual(RendererStatus().summary(), "batched codec")
        self.assertEqual(
            RendererStatus(batched_codec=False, compiled_step=True, compiled_codec=True).summary(),
            "per-frame codec, compiled step, compiled codec",
        )
        self.assertEqual(
            RendererStatus(compile_requested=True, compile_disabled_reason="x").summary(),
            "batched codec, compile off (x)",
        )


@unittest.skipUnless(
    os.environ.get("LOFAI_MODEL_TESTS") == "1",
    "set LOFAI_MODEL_TESTS=1 to run the real-model renderer checks (loads MRT2)",
)
class RealModelTests(unittest.TestCase):
    """Slow, opt-in checks against the actual checkpoint."""

    @classmethod
    def setUpClass(cls):
        os.environ["MRT_COMPILE"] = "1"
        import engine as engine_mod
        import styles

        cls.engine = engine_mod.MRTEngine()
        cls.engine.live_frame_counts = (8, 10)
        cls.engine.load()
        cls.engine.warm_embeddings(styles.all_prompts())
        cls.engine.calibrate()
        prompt = styles.all_prompts()[0]
        cls.style = cls.engine.embed(prompt)
        cls.key = cls.engine.style_cache_key(prompt)

    @classmethod
    def tearDownClass(cls):
        cls.engine.close()

    def _render(self, frames, state, seed):
        from engine import ConditioningRun

        return self.engine.generate(state, (ConditioningRun(self.style, self.key, None, frames),), seed=seed)

    def test_batched_codec_matches_per_frame_codec_within_one_lsb(self):
        renderer = self.engine._renderer
        a, _ = self._render(10, None, 77)
        renderer.status.batched_codec = False
        try:
            b, _ = self._render(10, None, 77)
        finally:
            renderer.status.batched_codec = True
        a = np.frombuffer(a, dtype=np.int16).astype(np.int32)
        b = np.frombuffer(b, dtype=np.int16).astype(np.int32)
        self.assertEqual(a.shape, b.shape)
        self.assertLessEqual(int(np.abs(a - b).max()), 1)

    def test_compiled_render_is_deterministic_and_memory_stable(self):
        import mlx.core as mx

        first, state = self._render(10, None, 5)
        again, _ = self._render(10, None, 5)
        self.assertEqual(first, again)
        gc.collect()
        mx.clear_cache()
        baseline = mx.get_active_memory()
        for _ in range(3):
            _pcm, state = self._render(10, state, 5)
        gc.collect()
        mx.clear_cache()
        # A chunk's activations must not stay pinned behind the returned state.
        self.assertLess(mx.get_active_memory() - baseline, 64 * 1024 * 1024)

    def test_compiled_priming_matches_the_library_forced_step(self):
        import mlx.core as mx
        from compiled_engine import flatten
        from engine import ConditioningRun

        _pcm, state = self._render(10, None, 11)
        _pcm, state = self._render(10, state, 11)
        tokens = np.concatenate([self.engine.last_tokens] * 6)  # 60 known frames
        run = ConditioningRun(self.style, self.key, None, 10)
        primer = self.engine.begin_prime(tokens, run, seed=3)
        while not self.engine.advance_prime(primer, 16):
            pass
        compiled = primer.leaves
        self.assertIsNotNone(compiled, "priming should run compiled")

        layer0 = self.engine._system._sampler.layers[0]
        eager = self.engine._new_eager_state(3)[0]
        for frame in tokens:
            _, eager = layer0.step(
                primer.block,
                eager,
                forced_tokens=mx.array(frame[None, None, :], dtype=mx.uint32),
                training=False,
                constants=primer.constants,
            )
        expected, _ = flatten(eager, mx)
        self.assertEqual(len(expected), len(compiled))
        for a, b in zip(expected, compiled):
            self.assertEqual(a.shape, b.shape)
            if a.size <= 1:
                continue
            a32 = np.asarray(a.astype(mx.float32))
            b32 = np.asarray(b.astype(mx.float32))
            scale = max(1.0, float(np.abs(a32).max()))
            # bf16 rounding differs between fused and eager kernels only
            self.assertLess(float(np.abs(a32 - b32).max()) / scale, 0.05)

    def test_a_primed_state_continues_the_stream(self):
        from engine import ConditioningRun

        _pcm, state = self._render(10, None, 21)
        frames = []
        for _ in range(8):
            _pcm, state = self._render(10, state, 21)
            frames.append(self.engine.last_tokens)
        run = ConditioningRun(self.style, self.key, None, 10)
        primer = self.engine.begin_prime(np.concatenate(frames), run, seed=9)
        while not self.engine.advance_prime(primer, 32):
            pass
        primed = self.engine.finish_prime(primer)
        pcm, _state = self._render(10, primed, 9)
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768.0
        self.assertEqual(samples.size, 10 * 1920 * 2)
        rms = float(np.sqrt(np.mean(samples**2)))
        self.assertGreater(rms, 10 ** (-60 / 20), "a primed state must not start from silence")


if __name__ == "__main__":
    unittest.main(verbosity=2)
