"""Chunk renderer: sample every frame's tokens first, then decode audio once.

The stock ``MagentaRT2Sampler.step_with_emits`` runs all five stages for one
frame at a time: conditioning encoder, temporal transformer, depth sampling
loop, SpectroStream codec, int16 conversion. Only the first three are
autoregressive. The codec is a causal convolutional decoder whose ``step`` on
a ``T``-frame token sequence produces the same samples as ``T`` single-frame
steps, but at ``T = 10`` it costs roughly a third per frame: its 143 MB of
float32 conv kernels are read once per chunk instead of once per frame, and
the 3x3 convolutions stop wasting most of each launch on a one-frame window.
lofAI already delivers audio in whole chunks, so decoding the chunk's tokens
in one call changes when the codec runs, not when the listener hears it.

Optionally, the sampling half of the depthformer step (``fast_engine``'s
``_lofai_sample_step``) and the batched codec are traced with ``mx.compile``.
Compilation removes most of the Python graph-construction time from the model
thread and fuses the hundreds of small element-wise kernels in the depth loop.
sequence_layers keeps its streaming state in nested tuples that contain
``Sequence`` objects, which ``mx.compile`` cannot accept, so state is
flattened to arrays at the boundary and rebuilt inside the traced function.
The active codebook count is Python control flow inside the step, so one
trace is kept per count; ``mx.compile`` handles differing shapes (chunk
length, first-frame token dtype) with its own per-signature cache.

Compiled output is not bit-identical to eager output: fused kernels round
bf16 intermediates differently, which nudges the sampling distribution at the
noise-floor level (total variation about 0.03 in local measurement) and can
flip a flat-distribution token in the deep codebooks. That is the same class
of trade the sliced-logits projection already makes. ``MRT_COMPILE=0`` keeps
the eager step; ``MRT_BATCH_CODEC=0`` decodes one frame at a time.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

_CFG_SCALE_PREFIX = "classifier_free_guidance_scale"


class SkeletonMismatch(RuntimeError):
    """A traced step returned a state tree shaped unlike its input."""


def _is_sequence(value) -> bool:
    return (
        hasattr(value, "values")
        and hasattr(value, "mask")
        and not isinstance(value, (tuple, list, dict))
        and type(value).__name__ in ("Sequence", "MaskedSequence")
    )


def flatten(tree, mx):
    """Split a sequence_layers state tree into array leaves and a skeleton.

    The skeleton is a hashable description of everything that is not an
    array: container types, ``Sequence`` subclasses, dict keys, and any
    non-array constants. ``rebuild(skeleton, leaves)`` inverts it.

    Deliberately written without recursive closures: a closure that refers
    to itself forms a reference cycle, and one that also captured ``leaves``
    would keep every state array alive until the cyclic garbage collector
    ran - with the codec state being views of a chunk's activations, that
    pinned hundreds of megabytes of GPU memory at unpredictable times.
    """
    leaves: list = []
    skeleton = _flatten_into(tree, leaves, mx)
    return leaves, skeleton


def _flatten_into(node, leaves: list, mx):
    if isinstance(node, mx.array):
        leaves.append(node)
        return ("A",)
    if _is_sequence(node):
        leaves.append(node.values)
        leaves.append(node.mask)
        return ("S", type(node))
    if isinstance(node, tuple):
        return ("T", tuple(_flatten_into(item, leaves, mx) for item in node))
    if isinstance(node, list):
        return ("L", tuple(_flatten_into(item, leaves, mx) for item in node))
    if isinstance(node, dict):
        return ("D", tuple((key, _flatten_into(node[key], leaves, mx)) for key in node))
    return ("C", node)


def leaf_count(skeleton) -> int:
    tag = skeleton[0]
    if tag == "A":
        return 1
    if tag == "S":
        return 2
    if tag in ("T", "L"):
        return sum(leaf_count(item) for item in skeleton[1])
    if tag == "D":
        return sum(leaf_count(item) for _key, item in skeleton[1])
    return 0


def rebuild(skeleton, leaves):
    """Rebuild the tree described by ``skeleton`` from a flat leaf sequence."""
    cursor = [0]
    tree = _rebuild_from(skeleton, leaves, cursor)
    if cursor[0] != len(leaves):
        raise SkeletonMismatch(
            f"skeleton consumed {cursor[0]} leaves but {len(leaves)} were given"
        )
    return tree


def _rebuild_from(node, leaves, cursor: list):
    tag = node[0]
    if tag == "A":
        if cursor[0] >= len(leaves):
            raise SkeletonMismatch("skeleton needs more leaves than were given")
        value = leaves[cursor[0]]
        cursor[0] += 1
        return value
    if tag == "S":
        if cursor[0] + 1 >= len(leaves):
            raise SkeletonMismatch("skeleton needs more leaves than were given")
        values, mask = leaves[cursor[0]], leaves[cursor[0] + 1]
        cursor[0] += 2
        return node[1](values, mask)
    if tag == "T":
        return tuple(_rebuild_from(item, leaves, cursor) for item in node[1])
    if tag == "L":
        return [_rebuild_from(item, leaves, cursor) for item in node[1]]
    if tag == "D":
        return {key: _rebuild_from(item, leaves, cursor) for key, item in node[1]}
    return node[1]


@dataclass
class RendererStatus:
    """What the renderer is actually doing, for /health and logs."""

    batched_codec: bool = True
    compiled_step: bool = False
    compiled_codec: bool = False
    compile_requested: bool = False
    compile_disabled_reason: str | None = None
    traces: dict = field(default_factory=dict)

    def summary(self) -> str:
        parts = ["batched codec" if self.batched_codec else "per-frame codec"]
        if self.compiled_step:
            parts.append("compiled step")
        if self.compiled_codec:
            parts.append("compiled codec")
        if self.compile_requested and not (self.compiled_step or self.compiled_codec):
            parts.append(
                "compile off"
                + (f" ({self.compile_disabled_reason})" if self.compile_disabled_reason else "")
            )
        return ", ".join(parts)


class ChunkRenderer:
    """Renders one chunk: depthformer frames, then the codec over all of them."""

    def __init__(
        self,
        sampler,
        depth_config,
        mx,
        sl,
        *,
        compile_enabled: bool = True,
        batch_codec: bool = True,
    ):
        self.mx = mx
        self.sl = sl
        self.layer0 = sampler.layers[0]
        self.codec_layers = tuple(sampler.layers[1:])
        self.config = depth_config
        self.status = RendererStatus(
            batched_codec=batch_codec, compile_requested=compile_enabled
        )
        self._step_fns: dict = {}
        self._codec_fns: dict = {}
        self._prime_fns: dict = {}
        self._compile_step = False
        self._compile_codec = False
        if compile_enabled:
            self._enable_compile()

    # --- setup ---

    def _enable_compile(self):
        mx = self.mx
        if not hasattr(mx, "compile"):
            self.status.compile_disabled_reason = "mlx has no compile"
            return
        fast = getattr(self.layer0, "_lofai_fast_engine", None)
        if fast is None or not getattr(self.layer0, "_lofai_sample_step", None):
            # Without the specialized step the encoder and sampler are one
            # function whose conditioning cache is keyed by object identity;
            # tracing it would just churn that cache. Keep eager.
            self.status.compile_disabled_reason = "fast engine not installed"
            return
        if not fast.cached_encoder:
            self.status.compile_disabled_reason = "conditioning encoder is stateful"
            return
        self._compile_step = True
        self._compile_codec = True
        self.status.compiled_step = True
        self.status.compiled_codec = True

    @property
    def compiled(self) -> bool:
        return self._compile_step or self._compile_codec

    @property
    def active_codebooks(self) -> int:
        config = self.config
        return int(
            getattr(config, "num_active_codebooks", None) or config.num_codebooks
        )

    # --- conditioning ---

    def encode(self, block, encoder_state, constants):
        """Run the conditioning encoder once for a block (cached by identity)."""
        encode = getattr(self.layer0, "_lofai_encode", None)
        if encode is None:
            return None
        return encode(block, encoder_state, constants)

    # --- depthformer frames ---

    def stepper(self, state) -> "_Stepper":
        return _Stepper(self, state)

    def _step_fn(self, key, state_skeleton, constants_skeleton, encoded_type):
        fn = self._step_fns.get(key)
        if fn is not None:
            return fn
        mx, sl, layer0 = self.mx, self.sl, self.layer0
        state_leaves = leaf_count(state_skeleton)
        sample_step = layer0._lofai_sample_step

        def traced(enc_values, enc_mask, *leaves):
            state = rebuild(state_skeleton, leaves[:state_leaves])
            constants = rebuild(constants_skeleton, leaves[state_leaves:])
            encoded = encoded_type(enc_values, enc_mask)
            tokens, new_state = sample_step(encoded, state, constants)
            new_leaves, new_skeleton = flatten(new_state, mx)
            if new_skeleton != state_skeleton:
                raise SkeletonMismatch("depthformer state changed shape across a step")
            return (tokens.values, *new_leaves)

        fn = mx.compile(traced)
        self._step_fns[key] = fn
        self.status.traces["step"] = len(self._step_fns)
        return fn

    # --- teacher-forced priming ---

    def primer(self, state, block, encoded, constants, tokens) -> "_Primer":
        """Prepare to force ``state`` through known token frames ``[N, Q]``."""
        return _Primer(self, state, block, encoded, constants, tokens)

    def _prime_fn(self, key, state_skeleton, constants_skeleton, encoded_type):
        fn = self._prime_fns.get(key)
        if fn is not None:
            return fn
        mx, sl, layer0 = self.mx, self.sl, self.layer0
        state_leaves = leaf_count(state_skeleton)
        decoder = layer0.decoder
        conditioning_name = layer0.conditioning_name
        from magenta_rt.mlx.depthformer import _mean_in_f32

        def traced(enc_values, enc_mask, forced, *leaves):
            # The temporal half of the specialized step with the depth loop
            # replaced by the known frame: embed the previous frame, advance
            # the temporal transformer, and hold ``forced`` as the frame the
            # next step will embed. Mirrors MultivariateDecoder's own
            # forced_tokens branch, which never runs the depth body either.
            state = rebuild(state_skeleton, leaves[:state_leaves])
            constants = rebuild(constants_skeleton, leaves[state_leaves:])
            encoder_state, _previous_output, sampler_state, delay = state
            rng, previous_frame, temporal_state, step_count = sampler_state
            sampler_constants = dict(constants)
            sampler_constants[conditioning_name] = encoded_type(enc_values, enc_mask)
            embedded = decoder.embedder.layer(previous_frame)
            temporal_inputs = embedded.apply_values(_mean_in_f32, axis=-2)
            _outputs, temporal_state = decoder.temporal_body.step(
                temporal_inputs,
                temporal_state,
                training=False,
                constants=sampler_constants,
            )
            frame = sl.Sequence.from_values(forced)
            new_state = (
                encoder_state,
                frame,
                (rng, frame, temporal_state, step_count + 1),
                delay,
            )
            new_leaves, new_skeleton = flatten(new_state, mx)
            if new_skeleton != state_skeleton:
                raise SkeletonMismatch("depthformer state changed shape while priming")
            return tuple(new_leaves)

        fn = mx.compile(traced)
        self._prime_fns[key] = fn
        self.status.traces["prime"] = len(self._prime_fns)
        return fn

    def _disable_step_compile(self, reason: str):
        if self._compile_step:
            log.warning("compiled depthformer step disabled: %s", reason)
        self._compile_step = False
        self.status.compiled_step = False
        self.status.compile_disabled_reason = reason

    # --- codec ---

    def decode(self, frame_tokens: list, codec_state: tuple):
        """Decode a chunk's token frames to int16 PCM values of shape [1, N, 2].

        The codec's streaming state comes back as slices of the chunk's
        intermediate activations. Left as views they would keep every large
        buffer of the chunk alive for as long as the listener's state lives
        (about a gigabyte per 10-frame chunk in local measurement), so each
        state leaf is detached into its own small buffer before it is
        returned.
        """
        mx = self.mx
        if self.status.batched_codec:
            tokens = frame_tokens[0] if len(frame_tokens) == 1 else mx.concatenate(
                frame_tokens, axis=1
            )
            pcm, codec_state = self._decode_once(tokens, codec_state)
        else:
            parts = []
            for tokens in frame_tokens:
                pcm, codec_state = self._decode_once(tokens, codec_state)
                parts.append(pcm)
            pcm = parts[0] if len(parts) == 1 else mx.concatenate(parts, axis=1)
        return pcm, self.detach_state(codec_state)

    def detach_state(self, state):
        """Copy every array leaf of ``state`` out of any larger donor buffer."""
        mx = self.mx
        leaves, skeleton = flatten(state, mx)
        return rebuild(skeleton, [mx.contiguous(leaf) for leaf in leaves])

    def _decode_once(self, tokens, codec_state):
        if self._compile_codec:
            leaves, skeleton = flatten(codec_state, self.mx)
            key = (self.active_codebooks, skeleton)
            try:
                fn = self._codec_fn(key, skeleton)
                out = fn(tokens, *leaves)
                return out[0], rebuild(skeleton, out[1:])
            except Exception as exc:  # noqa: BLE001 - fall back rather than drop audio
                self._compile_codec = False
                self.status.compiled_codec = False
                log.warning("compiled codec disabled: %s: %s", type(exc).__name__, exc)
        return self._decode_eager(tokens, codec_state)

    def _decode_eager(self, tokens, codec_state):
        x = self.sl.Sequence.from_values(tokens)
        new_state = []
        for layer, layer_state in zip(self.codec_layers, codec_state):
            x, layer_state, _ = layer.step_with_emits(
                x, layer_state, training=False, constants={}
            )
            new_state.append(layer_state)
        return x.values, tuple(new_state)

    def _codec_fn(self, key, skeleton):
        fn = self._codec_fns.get(key)
        if fn is not None:
            return fn
        mx = self.mx
        decode_eager = self._decode_eager

        def traced(tokens, *leaves):
            pcm, new_state = decode_eager(tokens, rebuild(skeleton, leaves))
            new_leaves, new_skeleton = flatten(new_state, mx)
            if new_skeleton != skeleton:
                raise SkeletonMismatch("codec state changed shape across a step")
            return (pcm, *new_leaves)

        fn = mx.compile(traced)
        self._codec_fns[key] = fn
        self.status.traces["codec"] = len(self._codec_fns)
        return fn

    # --- warmup ---

    def prewarm(self, render, counts, frame_counts, set_codebooks) -> float:
        """Trace every (codebook count, chunk length) the live path will use.

        ``render(frames)`` must run one chunk from a fresh state. Tracing
        happens on the first call for each signature; doing it here keeps it
        off the first listener's chunk. Returns the wall time spent.
        """
        if not self.compiled:
            return 0.0
        started = time.monotonic()
        for count in counts:
            set_codebooks(count)
            for frames in sorted(set(int(value) for value in frame_counts if value > 0)):
                render(frames)
        return time.monotonic() - started


class _Stepper:
    """Advances one listener's depthformer state frame by frame within a chunk.

    In compiled mode the state lives as a flat list of arrays between frames
    and is rebuilt into its tree form once, when the chunk ends.
    """

    def __init__(self, renderer: ChunkRenderer, state):
        self.renderer = renderer
        self.mx = renderer.mx
        self.state = state
        self.encoder_state = state[0]
        self.leaves = None
        self.skeleton = None
        self.fn = None
        self._constants_skeleton = None
        if renderer._compile_step:
            self.leaves, self.skeleton = flatten(state, self.mx)

    def step(self, block, encoded, constants):
        """Return this frame's tokens [1, 1, Q] and the arrays to evaluate."""
        renderer = self.renderer
        if self.leaves is not None and encoded is not None and not any(
            key.startswith(_CFG_SCALE_PREFIX) for key in constants
        ):
            constants_leaves, constants_skeleton = flatten(constants, self.mx)
            key = (
                renderer.active_codebooks,
                self.skeleton,
                constants_skeleton,
                type(encoded),
            )
            try:
                fn = renderer._step_fn(key, self.skeleton, constants_skeleton, type(encoded))
                out = fn(encoded.values, encoded.mask, *self.leaves, *constants_leaves)
            except Exception as exc:  # noqa: BLE001 - a broken trace must not end the stream
                renderer._disable_step_compile(f"{type(exc).__name__}: {exc}")
                self.state = rebuild(self.skeleton, self.leaves)
                self.leaves = None
            else:
                self.leaves = list(out[1:])
                return out[0], out
        elif self.leaves is not None:
            # Eager fallback mid-chunk: rebuild the tree once and stay eager.
            self.state = rebuild(self.skeleton, self.leaves)
            self.leaves = None

        tokens, self.state = renderer.layer0.step(
            block, self.state, training=False, constants=constants
        )
        leaves, _ = flatten(self.state, self.mx)
        return tokens.values, (tokens.values, *leaves)

    def final_state(self):
        if self.leaves is not None:
            return rebuild(self.skeleton, self.leaves)
        return self.state


class _Primer:
    """Teacher-forces a depthformer state through known token frames.

    A state primed through the tokens of an earlier stretch of a take is the
    state the model had after playing it, so generation resumes as a
    continuation of that stretch. Work is resumable in slices, letting the
    worker spend idle time between chunks on it rather than stalling a
    stream; each frame costs the temporal transformer only, no depth loop
    and no codec. Compiled like the sampling step when possible, with the
    library's own ``forced_tokens`` step as the eager fallback.
    """

    def __init__(self, renderer: ChunkRenderer, state, block, encoded, constants, tokens):
        mx = renderer.mx
        self.renderer = renderer
        self.mx = mx
        self.block = block
        self.encoded = encoded
        self.constants = constants
        # Live sampled frames are uint32 (an argmax); forcing the same dtype
        # keeps the primed state on the live step's compiled signature.
        self.tokens = mx.array(tokens, dtype=mx.uint32)
        self.total = int(self.tokens.shape[0])
        self.position = 0
        self.codec_state = tuple(state[1:])
        self.state = state[0]
        self.leaves = None
        self.skeleton = None
        self.constants_leaves = None
        self.constants_skeleton = None
        if renderer._compile_step and encoded is not None:
            self.leaves, self.skeleton = flatten(self.state, mx)
            self.constants_leaves, self.constants_skeleton = flatten(constants, mx)

    @property
    def done(self) -> bool:
        return self.position >= self.total

    def advance(self, frames: int) -> bool:
        """Force up to ``frames`` more frames; returns whether priming is done."""
        mx = self.mx
        stop = min(self.total, self.position + max(1, int(frames)))
        while self.position < stop:
            forced = self.tokens[self.position][None, None, :]
            if self.leaves is not None:
                key = (self.skeleton, self.constants_skeleton, type(self.encoded))
                try:
                    fn = self.renderer._prime_fn(
                        key, self.skeleton, self.constants_skeleton, type(self.encoded)
                    )
                    self.leaves = list(
                        fn(
                            self.encoded.values,
                            self.encoded.mask,
                            forced,
                            *self.leaves,
                            *self.constants_leaves,
                        )
                    )
                    mx.async_eval(*self.leaves)
                    self.position += 1
                    continue
                except Exception as exc:  # noqa: BLE001 - fall back rather than fail
                    log.warning("compiled priming disabled: %s: %s", type(exc).__name__, exc)
                    self.state = rebuild(self.skeleton, self.leaves)
                    self.leaves = None
            _, self.state = self.renderer.layer0.step(
                self.block,
                self.state,
                forced_tokens=forced,
                training=False,
                constants=self.constants,
            )
            self.position += 1
        if self.leaves is not None:
            mx.eval(*self.leaves)
        else:
            mx.eval(*flatten(self.state, mx)[0])
        return self.done

    def finish(self, warm_frames: int):
        """Return the primed full sampler state, codec warmed on the last frames.

        The codec is a causal convolution with a short receptive field;
        decoding the final few forced frames settles its buffers so the
        first generated chunk continues from the anchor's sound rather than
        from silence. The decoded audio itself is discarded.
        """
        if not self.done:
            raise RuntimeError("priming has not finished")
        mx = self.mx
        state = rebuild(self.skeleton, self.leaves) if self.leaves is not None else self.state
        codec_state = self.codec_state
        warm = min(self.total, max(0, int(warm_frames)))
        if warm:
            frames = self.tokens[self.total - warm :][None]
            _pcm, codec_state = self.renderer.decode([frames], codec_state)
        full = (state, *codec_state)
        mx.eval(*flatten(full, mx)[0])
        return full
