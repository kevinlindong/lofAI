# magenta realtime 2 inference engine

import hashlib
import importlib.metadata
import logging
import math
import os
import tempfile
import threading
import time
import warnings
from collections import OrderedDict, deque
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from audio_quality import require_startup_pcm_quality
from compiled_engine import flatten as flatten_state
from melody import piano_roll

log = logging.getLogger(__name__)


@contextmanager
def _ignore_upstream_shape_probe_warnings():
    """Hide warnings caused by SequenceLayers reducing an unfilled shape dummy."""
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=r"(invalid value|overflow) encountered in reduce",
            category=RuntimeWarning,
        )
        yield


class EngineStopping(RuntimeError):
    """Raised on the model thread when application shutdown is requested."""


@dataclass(frozen=True)
class SamplingControls:
    """Per-run sampler controls, so listeners can steer without reloading."""

    temperature: float
    top_k: int
    cfg_musiccoca: float
    cfg_notes: float
    cfg_drums: float


@dataclass(frozen=True)
class ConditioningRun:
    """One run of frames that share style, notes, drums, and sampler values."""

    style: np.ndarray
    key: str | None
    notes: Any
    frames: int
    drum: int | None = None
    sampling: SamplingControls | None = None

# mrt2 emits 40ms frames of 48khz stereo audio
FRAMES_PER_SECOND = 25
SAMPLE_RATE = 48000
CHANNELS = 2
FRAME_SECONDS = 1.0 / FRAMES_PER_SECOND

# spectrostream stacks residual quantisers per frame and the depthformer samples
# them one after another, so the codebook count is very nearly a dial on how
# long a frame takes to render: about 1.1ms of a 40ms budget each on an m1.
#
# Ten layers preserves the useful codec detail on the M1 Air while leaving the
# runtime tuner one inexpensive step to spend if the browser reports pressure.
MAX_CODEBOOKS = 12
MIN_CODEBOOKS = 10
ABSOLUTE_MIN_CODEBOOKS = 8

# Frames per calibration probe. One global burn-in fills kernels, then each
# candidate is measured over a full second so pipeline startup noise and one
# unusually slow frame do not decide the answer. A full walk to the configured
# floor still adds only a few seconds to startup.
PROBE_FRAMES = 25

# how long the tuner sits still after a change. long enough that the estimate
# has actually caught up with the new setting, so it cannot chase itself.
TUNE_DWELL_SECONDS = 6.0

# Recent chunks used to measure actual audio produced / total render time.
# A median hides recurring stalls even when their cost drains the reservoir.
# Only quality reductions may exclude one worst chunk, so an isolated hiccup
# need not spend fidelity; repeated stalls still count against the budget.
COST_WINDOW = 9
MIN_TUNE_SAMPLES = 5


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _mlx_version() -> str:
    try:
        return importlib.metadata.version("mlx")
    except importlib.metadata.PackageNotFoundError:
        return "?"


class MRTEngine:
    # wraps one loaded mrt2 model, shared by every session
    #
    # the model itself is stateless across calls: generate() takes the
    # streaming state in and hands a new one back, so a single loaded model can
    # serve any number of sessions as long as each keeps its own state.
    #
    # IMPORTANT: load() and generate() must run on the same thread, for the
    # whole life of the process. mlx streams are thread local, so a model loaded
    # on one thread and called from another dies with "There is no Stream(gpu,
    # 1) in current thread". SessionManager satisfies this by loading and
    # generating on its single worker thread. the musiccoca tflite interpreters
    # behind embed() are not thread safe either, so they want the same thread.

    def __init__(self):
        self.size = os.environ.get("MRT_MODEL_SIZE", "mrt2_small")
        # "python" builds the model from the safetensors checkpoint and runs it
        # eagerly. "mlxfn" runs a graph exported by `mrt mlx export`, which is
        # nominally faster - but every graph exported by the tested MLX 0.32.x
        # builds decodes to white noise: no energy below 200hz, 91% above
        # 4khz, zero crossing rate 0.50. that reproduces through the library's
        # own `mrt mlx generate` CLI, at 8-bit and unquantized, and with 0, 1
        # and 2 cfg branches, so it is the exporter and not this app. the same
        # version gap stops mlx 0.32.x importing google's published .mlxfn at
        # all. keep the eager path until a newer mlx ships; whatever the export
        # was worth, the eager path pipelines now and has closed some of it.
        self.backend = os.environ.get("MRT_BACKEND", "python")
        # Eight-bit weights are the live default. On this project's baseline
        # 8GB M1 the 4-bit/8-bit gap was ~1.7ms per frame, and the specialized
        # step loop below buys that back without spending fidelity; on an
        # M3-class machine the gap is ~0.8ms against a 20ms frame. Four-bit
        # round-to-nearest quantization of the *entire* sampler - including
        # the SpectroStream codec decoder that turns tokens into waveforms and
        # every embedding table - was the largest audible cost in the old
        # default. When 4-bit is explicitly requested for memory, the codec
        # keeps 8-bit weights: token prediction degrades gracefully, decoding
        # those tokens to audio does not.
        self.bits = _env_int("MRT_BITS", 8)

        # Match magentart::core's live defaults for sampling. CFG is encoded
        # as conditioning tokens here, so scale choices cost no throughput.
        # Notes guidance defaults to the library's 1.0: the live path never
        # sends MIDI, and both checkpoints were trained with the notes CFG
        # token co-varying with real piano-roll data. Telling the model every
        # frame to follow a fully masked score with strength 5 is conditioning
        # it outside anything it saw in training; 5.0 remains reasonable only
        # when actual notes are supplied (the evaluation harness may do so).
        self.temperature = _env_float("MRT_TEMPERATURE", 1.0)
        self.top_k = _env_int("MRT_TOP_K", 100)
        # MusicCoCa guidance is the strongest lever on long-take stability. At
        # the library's live default of 3.0, sparse stations (rainy-piano, no
        # drums) reliably drifted into a self-fed hiss bed: the quiet-gap
        # 5-20 kHz floor climbed from ~-70 dBFS to -33 to -42 dBFS within 4-8
        # minutes across every seed measured, with up to half the quiet-block
        # energy above 5 kHz - audible static that grows until it buries the
        # music. Raising the scale to 4.0 holds the model to the station's
        # timbre instead: the same seeds peaked near -60 dBFS and receded to
        # -74 dBFS rather than running away, and hiss share stayed under ~6%.
        # Busy stations (dusty-beats, jazz-cafe) were unchanged - already
        # stable at 3.0, still stable at 4.0. CFG is encoded as conditioning
        # tokens here, so a higher scale costs no throughput. The take guard
        # remains the backstop for the takes that still drift.
        #
        # Sparse stations can ask for more through styles.Station.guidance;
        # a higher global default was tried and made dusty-beats' "dusty"
        # texture, and its splices, worse.
        self.cfg_musiccoca = _env_float("MRT_CFG_MUSICCOCA", 4.0)
        self.cfg_notes = _env_float("MRT_CFG_NOTES", 1.0)
        self.cfg_drums = _env_float("MRT_CFG_DRUMS", 1.0)

        # Send MusicCoCa's full 12-level RVQ token stack. Neither mrt2 model
        # was trained with style-token masking (`mask_musiccoca=False` in the
        # model configs): every training frame carried all 12 levels, with
        # only independent 15% per-token dropout. Masking the fine half at
        # inference therefore puts the conditioning encoder outside its
        # training distribution on every frame - it audibly weakened style
        # adherence rather than stabilising it. The mask remains available as
        # an explicit experiment via MRT_STYLE_TOKEN_LEVELS.
        self.style_token_levels = max(
            1, min(12, _env_int("MRT_STYLE_TOKEN_LEVELS", 12))
        )

        # what the auto-tuner aims for. anything under 1.0 means the machine
        # renders slower than it plays, which no amount of buffering can hide
        # for long; the margin over 1.0 covers the model being slower on some
        # passages than others and the rest of the box wanting the gpu too.
        #
        # this is deliberately modest. codebooks are the currency being spent
        # and they are audible, so the aim is enough headroom to ride out a
        # wobble - not enough to never think about it again. gaps the listener
        # actually reports buy an extra step down, which is the honest signal.
        self.target_rtf = _env_float("MRT_TARGET_RTF", 1.18)
        self.mlx_cache_mb = _env_int("MRT_MLX_CACHE_MB", 384)
        # Opt-in: keep up to this much MLX memory wired (resident) so macOS
        # cannot compress or page the model out from under a stream when the
        # browser and other apps push an 8GB machine into swap. The model
        # needs about 450MB at rest and ~1GB while rendering a chunk. Wired
        # memory is unavailable to every other process, so this is a choice
        # for the listener to make; 0 leaves it to the OS.
        self.wired_limit_mb = max(0, _env_int("MRT_WIRED_LIMIT_MB", 0))
        self.fast_sampler_enabled = _env_int("MRT_FAST_SAMPLER", 1) != 0
        self.fast_engine_enabled = _env_int("MRT_FAST_ENGINE", 1) != 0
        # Trace the depthformer step and the codec with mx.compile. Removes
        # most Python graph-building from the model thread and fuses the depth
        # loop's small kernels; output differs from eager only by bf16
        # rounding (see compiled_engine).
        self.compile_enabled = _env_int("MRT_COMPILE", 1) != 0
        # Decode a chunk's tokens in one codec call instead of one per frame.
        # Exactly the same samples; roughly a third of the codec time.
        self.batch_codec_enabled = _env_int("MRT_BATCH_CODEC", 1) != 0
        # Replace MusicCoCa's TFLite RVQ with a verified NumPy replica and drop
        # the resident TFLite interpreters once the station prompts are warm.
        self.native_tokenizer_enabled = _env_int("MRT_NATIVE_STYLE_TOKENIZER", 1) != 0
        self.release_style_model_enabled = _env_int("MRT_RELEASE_STYLE_MODEL", 1) != 0
        # Chunk lengths the live path renders, so compiled graphs for them
        # can be traced before the first listener. SessionManager overrides
        # this with its configured chunk sizes.
        self.live_frame_counts: tuple[int, ...] = (
            max(1, _env_int("MRT_FIRST_CHUNK_FRAMES", 8)),
            max(1, _env_int("MRT_CHUNK_FRAMES", 10)),
        )

        # 0 keeps the live auto-tuner; any other value pins the codebook count.
        # Evaluation and offline renders explicitly pin all 12, while the live
        # path refuses to pretend a permanently sub-real-time stream is viable.
        self.pinned_codebooks = _env_int("MRT_CODEBOOKS", 0)
        self.min_codebooks = max(
            ABSOLUTE_MIN_CODEBOOKS,
            min(MAX_CODEBOOKS, _env_int("MRT_MIN_CODEBOOKS", MIN_CODEBOOKS)),
        )
        self.codebooks = MAX_CODEBOOKS
        self.max_codebooks = MAX_CODEBOOKS

        self._system = None
        self._warm = False
        self._style_key = None
        self._notes_key = None
        self._drums_key = None
        self._embeddings: dict[tuple[str, str | None], np.ndarray] = {}
        self._style_tokens: dict[tuple[str, int], tuple[int, ...]] = {}
        self._blocks: OrderedDict[tuple, tuple] = OrderedDict()
        self.conditioning_cache_size = max(
            64, _env_int("MRT_CONDITIONING_CACHE_SIZE", 128)
        )
        self.audio_style_blend = max(
            0.0, min(1.0, _env_float("MRT_AUDIO_STYLE_BLEND", 0.75))
        )
        self._load_lock = threading.Lock()
        self._interpreter_lock = threading.RLock()
        self._embed_lock = threading.Lock()
        self._embed_executor = None
        self._process_embedder = None
        self._embed_futures: dict = {}
        self._embed_failed: set = set()
        self.process_embedder_enabled = _env_int("MRT_PROCESS_EMBEDDER", 1) != 0
        self._stop_requested = threading.Event()
        self.load_error: str | None = None

        # fast path handles, filled in by _prepare_fast_path
        self._fast = False
        self._fast_sampling = False
        self._fast_engine = None
        self._renderer = None
        self._tokenizer = None
        self._released_interpreters: list[str] = []
        self._sampler = None
        self._input_spec = None
        self._depth_config = None
        self._keepalive_value = None
        # Sampled token frames of the most recent generate() call, [frames, 12]
        # uint32, or None when the stock loop (which hides them) is in use.
        self.last_tokens: np.ndarray | None = None

        # (model frames, elapsed seconds), weighted by actual audio duration
        self._costs: deque[tuple[int, float]] = deque(maxlen=COST_WINDOW)
        self._last_known_cost = 0.0
        self._cost_lock = threading.Lock()
        self._active_streams = 1
        self._last_tune = 0.0
        self._deficit_since: float | None = None
        cache_root = os.environ.get(
            "MRT_EMBEDDING_CACHE",
            str(Path.home() / "Library" / "Caches" / "lofai" / "embeddings"),
        )
        self._embedding_cache_dir = Path(cache_root).expanduser() if cache_root else None

    @property
    def ready(self) -> bool:
        # not just loaded but warmed: embedding the prompts takes a few seconds,
        # and a session promoted before that finishes would report itself live
        # while the listener sits in silence
        return self._system is not None and self._warm

    def realtime_factor(self) -> float:
        # seconds of audio rendered per second of wall clock, as measured
        cost = self._typical_cost()
        if cost <= 0.0:
            return 0.0
        return FRAME_SECONDS / cost

    def effective_realtime_factor(self, *, ignore_worst: bool = False) -> float:
        """Measured render headroom available to each concurrent listener."""
        cost = self._typical_cost(ignore_worst=ignore_worst)
        factor = FRAME_SECONDS / cost if cost > 0.0 else 0.0
        with self._cost_lock:
            active_streams = self._active_streams
        return factor / max(1, active_streams)

    def throughput_ready(self) -> bool:
        """Whether enough same-quality renders exist for admission decisions."""
        with self._cost_lock:
            return len(self._costs) >= MIN_TUNE_SAMPLES

    def _typical_cost(self, *, ignore_worst: bool = False) -> float:
        with self._cost_lock:
            costs = tuple(self._costs)
            fallback = self._last_known_cost
        if not costs:
            return fallback
        if ignore_worst and len(costs) >= MIN_TUNE_SAMPLES:
            worst = max(range(len(costs)), key=lambda i: costs[i][1] / costs[i][0])
            costs = costs[:worst] + costs[worst + 1:]
        return sum(seconds for _, seconds in costs) / sum(frames for frames, _ in costs)

    def _seed_cost(self, cost: float):
        # start the window off at what calibration just measured, so the first
        # listener is judged against a real number rather than one chunk
        with self._cost_lock:
            self._costs.clear()
            for _ in range(COST_WINDOW):
                self._costs.append((PROBE_FRAMES, cost * PROBE_FRAMES))
            self._last_known_cost = cost
        self._deficit_since = None

    def _clear_costs(self):
        with self._cost_lock:
            if self._costs:
                self._last_known_cost = sum(s for _, s in self._costs) / sum(
                    f for f, _ in self._costs
                )
            self._costs.clear()
        self._deficit_since = None

    def prepare_start(self):
        self._stop_requested.clear()
        self.load_error = None

    def request_stop(self):
        self._stop_requested.set()

    def _raise_if_stopping(self):
        if self._stop_requested.is_set():
            raise EngineStopping("engine shutdown requested")

    def load(self):
        # build the model and warm it up - takes tens of seconds
        with self._load_lock:
            self._raise_if_stopping()
            if self._system is not None:
                return

            from magenta_rt.config import (
                DRUM_PIANOROLL,
                MUSICCOCA,
                PIANOROLL_WITH_ONSETS,
            )

            self._style_key = MUSICCOCA.key
            self._notes_key = PIANOROLL_WITH_ONSETS.key
            self._drums_key = DRUM_PIANOROLL.key
            started = time.monotonic()
            # Bound MLX's reusable-buffer cache from the first allocation. The
            # weight load and quantization otherwise leave more than a
            # gigabyte of freed buffers cached, and on an 8 GB machine that
            # transient is swap pressure. Loading was not slower under the
            # limit in local measurement.
            self._limit_mlx_cache()

            if self.backend == "mlxfn":
                log.warning(
                    "MRT_BACKEND=mlxfn requested, but exported graphs decode to "
                    "noise under mlx %s and cannot honor per-take decoder seeds; "
                    "using the eager python model instead",
                    _mlx_version(),
                )
                self.backend = "python"

            if self._system is None:
                self._system = self._load_python()
                self._raise_if_stopping()
                self._prepare_fast_path()

            log.info(
                "model loaded in %.1fs (%s backend)",
                time.monotonic() - started,
                self.backend,
            )

    def _load_mlxfn(self):
        # exported graph, if a future mlx ever exports one that decodes
        from magenta_rt.mlx.system import MagentaRT2SystemStdMlxfn

        log.info("loading %s (mlxfn backend)", self.size)
        return MagentaRT2SystemStdMlxfn(
            size=self.size,
            temperature=self.temperature,
            top_k=self.top_k,
            cfg_scales={
                "musiccoca": self.cfg_musiccoca,
                "notes": self.cfg_notes,
                "drums": self.cfg_drums,
            },
        )

    @_ignore_upstream_shape_probe_warnings()
    def _load_python(self):
        # model built and quantized at load time from the safetensors checkpoint
        from magenta_rt.mlx.system import MagentaRT2System

        if self.bits not in (0, 4, 8):
            raise ValueError("MRT_BITS must be 0 (full precision), 4, or 8")

        precision = "full precision" if self.bits == 0 else f"{self.bits}-bit"
        log.info("loading %s (python backend, %s)", self.size, precision)
        # SequenceLayers asks NumPy for the *shape* of a mean over an unfilled
        # dummy array while materializing deferred layers. No value is consumed.
        #
        # At 4 bits the library call would also quantize the SpectroStream
        # codec decoder and every embedding table to 4-bit round-to-nearest,
        # which is where most of the audible damage was. Load unquantized in
        # that case and quantize the two halves separately below.
        library_bits = self.bits or None
        if self.bits == 4:
            library_bits = None
        system = MagentaRT2System(
            size=self.size,
            bits=library_bits,
            temperature=self.temperature,
            top_k=self.top_k,
            cfg_scales={
                "musiccoca": self.cfg_musiccoca,
                "notes": self.cfg_notes,
                "drums": self.cfg_drums,
            },
        )
        if self.bits == 4:
            import mlx.nn as nn

            # Language model at 4-bit for memory-constrained machines; the
            # audio codec keeps 8-bit weights. The codec is 52M of the 282M
            # parameters, so this costs a fraction of the saved bandwidth
            # while keeping token-to-waveform decoding clean.
            nn.quantize(system._sampler.depthformer, group_size=32, bits=4)
            nn.quantize(system._sampler.spectrostream, group_size=64, bits=8)
            log.info("quantized: depthformer 4-bit, spectrostream codec 8-bit")
        return system

    def _prepare_fast_path(self):
        # our own step loop needs three things the library keeps private: the
        # sampler, its conditioning builder, and the depthformer config that
        # carries the codebook count. if a future release moves any of them we
        # fall back to the stock generate() - slower and with a fixed quality,
        # but working, which beats refusing to start.
        try:
            import mlx.core as mx
            import sequence_layers.mlx as sl

            # held rather than imported per chunk: sequence_layers is vendored
            # behind an import hook, and the generate loop should not be paying
            # to rediscover it
            self._mx = mx
            self._sl = sl
            self._keepalive_value = mx.array([0.0], dtype=mx.float32)

            if self.fast_sampler_enabled:
                try:
                    from magenta_rt.mlx import depthformer
                    from fast_sampler import install as install_fast_sampler

                    self._fast_sampling = install_fast_sampler(
                        depthformer, mx, self.top_k
                    )
                except Exception as exc:  # noqa: BLE001 - optional specialization
                    log.warning("fast sampler unavailable; using Magenta's: %s", exc)
                    self._fast_sampling = False

            if self.fast_engine_enabled:
                try:
                    from fast_engine import install as install_fast_engine

                    self._fast_engine = install_fast_engine(self._system, mx, sl)
                except Exception as exc:  # noqa: BLE001 - optional specialization
                    log.warning(
                        "fast engine unavailable; using the stock step: %s", exc
                    )
                    self._fast_engine = None

            system = self._system
            self._sampler = system._sampler
            self._input_spec = sl.ChannelSpec(
                shape=(system._num_channels,), dtype=mx.int32
            )
            system._build_conditioning({}, None, None, None)

            config = system._sampler.depthformer.sampler.decoder.config
            if hasattr(config, "num_active_codebooks"):
                self._depth_config = config
                self.max_codebooks = int(config.num_codebooks)
                self.codebooks = self.max_codebooks
            from compiled_engine import ChunkRenderer

            self._renderer = ChunkRenderer(
                system._sampler,
                config,
                mx,
                sl,
                compile_enabled=self.compile_enabled,
                batch_codec=self.batch_codec_enabled,
            )
            log.info("chunk renderer: %s", self._renderer.status.summary())
            self._fast = True
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "the library internals this build pipelines against have moved "
                "(%s); falling back to the stock generate loop",
                exc,
            )
            self._fast = False

    # --- style ---

    def embedding_ready(self, prompt: str, reference: str | None = None) -> bool:
        """Whether a style can be used now without waiting on the embedder.

        True once cached - or once background embedding has failed, so the
        caller embeds it in-process rather than waiting forever.
        """
        key = self._embedding_key(prompt, reference)
        return key in self._embeddings or key in self._embed_failed

    def prefetch_embedding(self, prompt: str, reference: str | None = None):
        """Embed a new prompt on the background embedder, once.

        MusicCoCa runs on the CPU through TFLite and never touches MLX, so it
        does not need the model thread; after warm-up its interpreters are
        released, and rebuilding the text encoder for an unknown prompt takes
        about a second - long enough to empty a listener's reservoir if the
        model thread waited for it.
        """
        key = self._embedding_key(prompt, reference)
        if key in self._embeddings or key in self._embed_failed:
            return
        with self._embed_lock:
            future = self._embed_futures.get(key)
            if future is not None and not future.done():
                return
            if reference is None and self.process_embedder_enabled:
                # Rebuilding the text encoder holds the GIL for over half a
                # second, so a thread is not enough: embed in a child process
                # (style_embedder), which also keeps the interpreter's memory
                # out of this one.
                if self._process_embedder is None:
                    from style_embedder import ProcessEmbedder

                    self._process_embedder = ProcessEmbedder()
                future = self._process_embedder.submit(prompt)
                future.add_done_callback(
                    lambda done, key=key: self._store_embedding(key, done)
                )
            else:
                if self._embed_executor is None:
                    from concurrent.futures import ThreadPoolExecutor

                    self._embed_executor = ThreadPoolExecutor(
                        max_workers=1, thread_name_prefix="musiccoca"
                    )
                future = self._embed_executor.submit(
                    self._embed_in_background, prompt, reference
                )
            self._embed_futures[key] = future

    def _store_embedding(self, key, future):
        try:
            embedding = np.asarray(future.result(), dtype=np.float32)
            if embedding.shape != (768,) or not np.isfinite(embedding).all():
                raise ValueError(f"unexpected embedding shape {embedding.shape}")
        except Exception as exc:  # noqa: BLE001 - fall back to in-process embedding
            log.warning("background embedding of %r failed: %s", key[0], exc)
            self._embed_failed.add(key)
            return
        self._embeddings[key] = embedding

    def _embed_in_background(self, prompt: str, reference: str | None):
        try:
            self.embed(prompt, reference)
        except Exception:  # noqa: BLE001 - the worker will embed it itself
            log.exception("background embedding failed for %r", prompt)
            self._embed_failed.add(self._embedding_key(prompt, reference))

    @staticmethod
    def _embedding_key(prompt: str, reference: str | None):
        reference_key = str(Path(reference).expanduser().resolve()) if reference else None
        return (prompt, reference_key)

    def embed(self, prompt: str, reference: str | None = None) -> np.ndarray:
        """Embed a short style label, optionally anchored by a local WAV.

        Text is always mapped into MusicCoCa's audio space.  A reference uses
        the native audio encoder and is linearly blended with the text target;
        this keeps the station named while grounding its actual timbre.
        """
        cache_key = self._embedding_key(prompt, reference)
        reference_key = cache_key[1]
        cached = self._embeddings.get(cache_key)
        if cached is not None:
            return cached
        # The TFLite interpreters are not thread safe; the model thread and
        # the background embedder take turns.
        with self._interpreter_lock:
            cached = self._embeddings.get(cache_key)
            if cached is not None:
                return cached
            return self._embed_uncached(prompt, reference_key, cache_key)

    def _embed_uncached(self, prompt: str, reference_key: str | None, cache_key) -> np.ndarray:
        # The mapper projects text into the audio side of MusicCoCa's shared
        # space before RVQ. This is the path used by Magenta's own MLX CLI and
        # native runtime; without it most prompt tokens differ and conditioning
        # is markedly less faithful. Embeddings are warmed once, so it adds no
        # cost to live generation.
        text_embedding = np.asarray(
            self._system.embed_style(prompt, use_mapper=True), dtype=np.float32
        )
        embedding = text_embedding
        if reference_key is not None:
            from magenta_rt.audio import Waveform

            waveform = Waveform.from_file(reference_key)
            audio_embedding = np.asarray(
                self._system.embed_style(waveform), dtype=np.float32
            )
            weight = self.audio_style_blend
            embedding = ((1.0 - weight) * text_embedding + weight * audio_embedding).astype(
                np.float32
            )
            log.info(
                "anchored style %r to %s at %.0f%%",
                prompt,
                reference_key,
                weight * 100.0,
            )
        self._embeddings[cache_key] = embedding
        return embedding

    def warm_embeddings(
        self, prompts: list[str], references: dict[str, str] | None = None
    ):
        # pre-embed every prompt so style changes never wait on the text encoder
        self._load_embedding_cache(prompts)
        for prompt in prompts:
            self._raise_if_stopping()
            self.embed(prompt)
        self._save_embedding_cache(prompts)

        references = references or {}
        for prompt, reference in references.items():
            self._raise_if_stopping()
            self.embed(prompt, reference)

        # Tokenizing is a plain residual VQ; run it natively so the live path
        # never touches a TFLite interpreter. Verified against TFLite first.
        self._install_native_tokenizer()

        # MusicCoCa builds its RVQ interpreter lazily. Build and cache every
        # fixed conditioning block now - with and without drums - so no
        # listener pays that startup cost.
        if prompts and self._fast:
            for prompt in prompts:
                self._raise_if_stopping()
                reference = references.get(prompt)
                key = self.style_cache_key(prompt, reference)
                style = self.embed(prompt, reference)
                self._conditioning(style, key)
                self._conditioning(style, key, drum=0)

        self._release_style_model()

    def _install_native_tokenizer(self):
        if not self.native_tokenizer_enabled or self._tokenizer is not None:
            return
        try:
            import style_tokens

            self._tokenizer = style_tokens.load_or_extract(
                self._system._style_model,
                self._embedding_cache_dir,
                list(self._embeddings.values()),
            )
        except Exception as exc:  # noqa: BLE001 - optional specialization
            log.warning("native style tokenizer unavailable: %s", exc)
            self._tokenizer = None

    def _release_style_model(self):
        """Free MusicCoCa's TFLite interpreters once startup no longer needs them.

        The text encoder alone holds hundreds of megabytes resident. Prompts
        are embedded and cached, so the live path only ever tokenizes - and
        with the native tokenizer installed, not even that. Any later request
        for an unknown prompt rebuilds the interpreter it needs transparently.
        """
        if not self.release_style_model_enabled:
            return
        try:
            import style_tokens

            with self._interpreter_lock:
                released = style_tokens.release_interpreters(
                    self._system._style_model,
                    include_quantizer=self._tokenizer is not None,
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("could not release the style model: %s", exc)
            return
        if released:
            self._released_interpreters = released
            log.info(
                "released MusicCoCa TFLite interpreters: %s", ", ".join(released)
            )

    def tokenize_style(self, style: np.ndarray) -> list[int]:
        """Return the 12 MusicCoCa RVQ tokens for a 768-d style embedding."""
        if self._tokenizer is not None:
            return [int(token) for token in self._tokenizer.tokenize(style)]
        with self._interpreter_lock:
            return [int(token) for token in self._system._style_model.tokenize(style)]

    @staticmethod
    def style_cache_key(prompt: str, reference: str | None = None) -> str:
        return prompt if reference is None else f"{prompt}\0audio:{reference}"

    def _embedding_cache_path(self, prompts: list[str]) -> Path | None:
        if self._embedding_cache_dir is None:
            return None
        digest = hashlib.sha256()
        digest.update(b"lofai-musiccoca-mapped-v1\0")
        for prompt in prompts:
            digest.update(prompt.encode("utf-8"))
            digest.update(b"\0")
        resource_dir = getattr(self._system._style_model, "_resource_dir", None)
        if resource_dir is not None:
            for name in ("text_encoder.tflite", "mapper.tflite"):
                path = Path(resource_dir) / name
                try:
                    stat = path.stat()
                    digest.update(f"{name}:{stat.st_size}:{stat.st_mtime_ns}".encode())
                except OSError:
                    return None
        return self._embedding_cache_dir / f"{digest.hexdigest()}.npz"

    def _load_embedding_cache(self, prompts: list[str]):
        path = self._embedding_cache_path(prompts)
        if path is None or not path.is_file():
            return
        try:
            with np.load(path, allow_pickle=False) as cached:
                stored_prompts = cached["prompts"].tolist()
                embeddings = cached["embeddings"]
            if stored_prompts != prompts or embeddings.shape != (len(prompts), 768):
                return
            if embeddings.dtype != np.float32 or not np.isfinite(embeddings).all():
                return
            self._embeddings.update(
                ((prompt, None), embedding)
                for prompt, embedding in zip(prompts, embeddings, strict=True)
            )
            log.info("loaded %d mapped style embeddings from cache", len(prompts))
        except (OSError, ValueError, KeyError):
            log.warning("ignoring invalid style embedding cache %s", path)

    def _save_embedding_cache(self, prompts: list[str]):
        path = self._embedding_cache_path(prompts)
        if path is None or not prompts or not all(
            (prompt, None) in self._embeddings for prompt in prompts
        ):
            return
        if path.is_file():
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            embeddings = np.stack(
                [self._embeddings[(prompt, None)] for prompt in prompts]
            ).astype(np.float32)
            with tempfile.NamedTemporaryFile(
                mode="wb", suffix=".npz", dir=path.parent, delete=False
            ) as temp:
                temp_path = Path(temp.name)
                np.savez_compressed(temp, prompts=np.asarray(prompts), embeddings=embeddings)
            os.replace(temp_path, path)
            log.info("cached %d mapped style embeddings", len(prompts))
        except OSError as exc:
            log.warning("could not cache style embeddings: %s", exc)

    def default_sampling(self) -> SamplingControls:
        return SamplingControls(
            temperature=self.temperature,
            top_k=self.top_k,
            cfg_musiccoca=self.cfg_musiccoca,
            cfg_notes=self.cfg_notes,
            cfg_drums=self.cfg_drums,
        )

    @staticmethod
    def _note_tokens(notes: Any) -> list[int] | None:
        if notes is None or isinstance(notes, (int, np.integer)):
            return piano_roll(None if notes is None else int(notes))
        raw = getattr(notes, "tokens", notes)
        tokens = [int(token) for token in raw]
        if len(tokens) != 128:
            raise ValueError(f"expected 128 piano-roll tokens, got {len(tokens)}")
        if any(token not in (-1, 0, 1, 2, 3) for token in tokens):
            raise ValueError("invalid piano-roll token")
        return tokens

    def _conditioning(
        self,
        style: np.ndarray,
        key: str | None,
        notes: Any = None,
        drum: int | None = None,
        sampling: SamplingControls | None = None,
    ):
        # Tokenize the frame controls into the block consumed by the sampler.
        # Blended embeddings have no stable key and intentionally bypass this
        # cache; fixed station/note/control combinations are reused.
        sampling = sampling or self.default_sampling()
        note_tokens = self._note_tokens(notes)
        if drum is None and hasattr(notes, "drum"):
            drum = int(notes.drum)
        if drum is not None and drum not in (-1, 0, 1):
            raise ValueError(f"invalid drum token: {drum}")
        cache_key = (
            key,
            tuple(note_tokens) if note_tokens is not None else None,
            drum,
            sampling,
        ) if key is not None else None
        if key is not None:
            cached = self._blocks.get(cache_key)
            if cached is not None:
                self._blocks.move_to_end(cache_key)
                return cached

        style_token_key = (key, self.style_token_levels) if key is not None else None
        fixed_tokens = (
            self._style_tokens.get(style_token_key)
            if style_token_key is not None
            else None
        )
        if fixed_tokens is None:
            tokens = self.tokenize_style(style)
            tokens[self.style_token_levels :] = [-1] * (
                len(tokens) - self.style_token_levels
            )
            if style_token_key is not None:
                fixed_tokens = tuple(int(token) for token in tokens)
                self._style_tokens[style_token_key] = fixed_tokens
        tokens = list(fixed_tokens) if fixed_tokens is not None else tokens
        conditioning = {self._style_key: tokens}
        if note_tokens is not None:
            conditioning[self._notes_key] = note_tokens
        if drum is not None:
            conditioning[self._drums_key] = [drum]
        built = self._system._build_conditioning(
            conditioning,
            {
                "musiccoca": sampling.cfg_musiccoca,
                "notes": sampling.cfg_notes,
                "drums": sampling.cfg_drums,
            },
            sampling.temperature,
            sampling.top_k,
        )
        if cache_key is not None:
            self._blocks[cache_key] = built
            self._blocks.move_to_end(cache_key)
            while len(self._blocks) > self.conditioning_cache_size:
                self._blocks.popitem(last=False)
        return built

    # --- quality dial ---

    def set_codebooks(self, count: int) -> bool:
        # how many of spectrostream's residual quantisers the depthformer
        # actually samples. the rest are filled with a dummy token, so shapes -
        # and therefore a live session's state - are unaffected.
        if self._depth_config is None:
            return False

        count = max(self.min_codebooks, min(self.max_codebooks, int(count)))
        if count == self.codebooks:
            return False

        # the config is a frozen dataclass; this is the only field we touch
        object.__setattr__(self._depth_config, "num_active_codebooks", count)
        self.codebooks = count
        return True

    def calibrate(self):
        # pick a codebook count this machine can actually sustain, rather than
        # making the first listener sit through the runtime tuner walking down
        # to it one step at a time.
        #
        # this is the last thing that happens before the engine reports itself
        # ready, so nobody is promoted into a stream mid-measurement.
        self._raise_if_stopping()
        # Trace first, measure second: a compiled graph's first call at a new
        # codebook count or chunk length includes its trace, and a probe that
        # swallowed one would read as a machine far slower than it is and
        # walk the quality dial to the floor for nothing.
        self._prewarm()
        self._raise_if_stopping()
        self._calibrate()
        self._raise_if_stopping()
        self._trim_mlx_cache()
        self._warm = True

    def _prewarm(self):
        # Trace every compiled graph the live path can reach - each reachable
        # codebook count at each live chunk length and the calibration probe
        # length, from a fresh state so the first-frame signature is covered
        # too - before anything is timed or anyone is listening.
        renderer = self._renderer
        if not self._fast or renderer is None or not renderer.compiled:
            return
        if not self._embeddings:
            return
        if self.pinned_codebooks or self._depth_config is None:
            if self.pinned_codebooks and self._depth_config is not None:
                # Calibration pins this count next; trace it, not the default.
                self.set_codebooks(self.pinned_codebooks)
            counts = [self.codebooks]
        else:
            counts = list(range(self.min_codebooks, self.max_codebooks + 1))
        (prompt, reference), style = next(iter(self._embeddings.items()))
        key = self.style_cache_key(prompt, reference)
        chosen = self.codebooks
        frame_counts = (*self.live_frame_counts, PROBE_FRAMES)

        def render(frames: int):
            self._raise_if_stopping()
            self.generate(None, (ConditioningRun(style, key, None, frames),), seed=0)

        elapsed = renderer.prewarm(render, counts, frame_counts, self.set_codebooks)
        self.set_codebooks(chosen)
        if self.last_tokens is not None and len(self.last_tokens) >= 2:
            # Trace the teacher-forced step too (its first frame follows the
            # int32 start token, later ones uint32 samples), so the first
            # re-prime of the day does not pay for compilation mid-stream.
            primer = self.begin_prime(
                self.last_tokens[:2], ConditioningRun(style, key, None, 2), seed=0
            )
            self.advance_prime(primer, 2)
        log.info(
            "prewarmed compiled graphs (%s codebooks x %s frames) in %.1fs: %s",
            "/".join(str(count) for count in counts),
            "/".join(str(frames) for frames in sorted(set(frame_counts))),
            elapsed,
            renderer.status.summary(),
        )

    def _mlx_module(self):
        try:
            return self._mx if self._fast else __import__("mlx.core", fromlist=["core"])
        except (ImportError, AttributeError):
            return None

    def _limit_mlx_cache(self):
        mx = self._mlx_module()
        if mx is None:
            return
        if self.wired_limit_mb > 0 and hasattr(mx, "set_wired_limit"):
            try:
                mx.set_wired_limit(self.wired_limit_mb * 1024 * 1024)
                log.info("MLX wired limit %dMB", self.wired_limit_mb)
            except Exception as exc:  # noqa: BLE001 - above the system limit
                log.warning("could not wire %dMB of MLX memory: %s", self.wired_limit_mb, exc)
        if self.mlx_cache_mb <= 0:
            return
        mx.set_cache_limit(self.mlx_cache_mb * 1024 * 1024)
        mx.clear_cache()

    def _trim_mlx_cache(self):
        # Loading, quantizing and probing leaves roughly 1.5GB of reusable MLX
        # buffers on an 8GB M1, while steady streaming needs about 240MB. Give
        # that headroom back to the OS to avoid swap-driven frame spikes.
        if self.mlx_cache_mb <= 0:
            return
        mx = self._mlx_module()
        if mx is None:
            return
        before = mx.get_cache_memory()
        mx.set_cache_limit(self.mlx_cache_mb * 1024 * 1024)
        mx.clear_cache()
        after = mx.get_cache_memory()
        log.info(
            "trimmed MLX cache %.0fMB -> %.0fMB (limit %dMB)",
            before / (1024 * 1024),
            after / (1024 * 1024),
            self.mlx_cache_mb,
        )

    def _calibrate(self):
        # Every backend must prove that it decodes plausible audio before ready
        # becomes true. This catches silence, clipping, and the known mlxfn
        # white-noise failure before a listener can ever receive its PCM.
        (prompt, reference), style = next(iter(self._embeddings.items()))
        key = self.style_cache_key(prompt, reference)
        plan = (ConditioningRun(style, key, None, PROBE_FRAMES),)
        quality_pcm = []
        pcm, probe_state = self.generate(None, plan)
        quality_pcm.append(pcm)

        if not self._fast or self._depth_config is None:
            started = time.monotonic()
            pcm, _ = self.generate(probe_state, plan)
            cost = (time.monotonic() - started) / PROBE_FRAMES
            quality_pcm.append(pcm)
            self._seed_cost(cost)
            self._require_audio_quality(quality_pcm)
            return

        # One global burn-in is enough for the eager path, and _prewarm has
        # already traced every count the compiled path can reach, so nothing
        # timed below includes a first-call cost. A 25-frame probe gives
        # calibration a stable throughput estimate; live chunks are shorter
        # for latency.

        if self.pinned_codebooks:
            self.set_codebooks(self.pinned_codebooks)
            cost, _, pcm = self._probe(self.codebooks, probe_state, plan)
            quality_pcm.append(pcm)
            self._seed_cost(cost)
            self._require_audio_quality(quality_pcm)
            log.info(
                "codebooks pinned to %d (%.1f ms/frame, %.2fx real time)",
                self.codebooks,
                self._typical_cost() * 1000,
                self.realtime_factor(),
            )
            return

        # walk down from full detail and stop at the first count that fits in
        # the frame budget. fitting a line through two probes and solving was
        # tidier, but a codebook is worth about a millisecond and the probes
        # disagree by nearly as much - across two runs of the same machine the
        # same fit gave 1.09 and 0.69 ms per codebook. there are only five
        # values to choose between, so measuring them is both simpler and right.
        budget = FRAME_SECONDS / self.target_rtf
        count = self.max_codebooks
        cost = 0.0
        for count in range(self.max_codebooks, self.min_codebooks - 1, -1):
            cost, probe_state, pcm = self._probe(count, probe_state, plan)
            quality_pcm.append(pcm)
            if cost <= budget:
                break

        self.set_codebooks(count)
        self._seed_cost(cost)
        self._require_audio_quality(quality_pcm)
        self._last_tune = time.monotonic()
        log.info(
            "calibrated: %d/%d codebooks, %.1f ms/frame -> %.2fx real time "
            "(target %.2fx)",
            self.codebooks,
            self.max_codebooks,
            cost * 1000,
            self.realtime_factor(),
            self.target_rtf,
        )

    def _probe(self, codebooks: int, state, plan) -> tuple[float, object, bytes]:
        # seconds per frame at a given codebook count, measured on throwaway
        # audio nobody hears. A global warm call is made before the walk.
        self.set_codebooks(codebooks)
        started = time.monotonic()
        pcm, state = self.generate(state, plan)
        return (time.monotonic() - started) / PROBE_FRAMES, state, pcm

    def keep_gpu_warm(self):
        """Prevent Metal from downclocking between real-time render bursts."""
        if not self._fast or self._keepalive_value is None:
            return
        value = self._keepalive_value
        self._mx.eval(value + value)

    def _require_audio_quality(self, chunks: list[bytes]):
        report = require_startup_pcm_quality(
            b"".join(chunks), sample_rate=SAMPLE_RATE, channels=CHANNELS
        )
        log.info(
            "startup audio passed: %.1fdBFS RMS, %.3f ZCR, %.3f flatness, "
            "%.1f%% high-band",
            report.rms_dbfs,
            report.zero_crossing_rate,
            report.spectral_flatness,
            report.high_band_fraction * 100.0,
        )

    def note_render(self, frames: int, seconds: float, active_streams: int = 1):
        # Count every completed render in the throughput displayed to clients.
        if frames <= 0 or seconds <= 0.0 or not math.isfinite(seconds):
            return
        with self._cost_lock:
            self._active_streams = max(1, int(active_streams))
            self._costs.append((frames, seconds))
        self._retune(time.monotonic())

    def note_idle(self):
        # Paused time is not evidence of a sustained rendering deficit.
        # Called by the owning worker when no listener is consuming audio.
        self._deficit_since = None

    def note_gap(self):
        # a listener's reservoir actually ran dry. that is the one measurement
        # that is not a proxy for anything, so it skips the dwell and spends a
        # codebook immediately.
        if self.pinned_codebooks or self._depth_config is None:
            return
        if self.set_codebooks(self.codebooks - 1):
            self._clear_costs()
            self._last_tune = time.monotonic()
            log.info(
                "a listener heard a gap; down to %d/%d codebooks",
                self.codebooks,
                self.max_codebooks,
            )

    def note_pressure(self):
        # Act while the client still has audio instead of waiting for a gap.
        # The dwell prevents frequent low-water reports from cascading.
        if self.pinned_codebooks or self._depth_config is None:
            return
        now = time.monotonic()
        if now - self._last_tune < TUNE_DWELL_SECONDS:
            return
        with self._cost_lock:
            sample_count = len(self._costs)
        # A stalled socket, normal first-buffer sawtooth, or throttled tab can
        # also report low water; lowering model quality cannot fix those. Do
        # not spend fidelity while measured rendering still clears its target.
        # Audible gaps remain the unconditional signal in note_gap().
        factor = self.effective_realtime_factor(ignore_worst=True)
        sustained = (
            self._deficit_since is not None
            and now - self._deficit_since >= TUNE_DWELL_SECONDS
        )
        if sample_count < MIN_TUNE_SAMPLES or (factor >= self.target_rtf and not sustained):
            return
        if self.set_codebooks(self.codebooks - 1):
            self._clear_costs()
            self._last_tune = now
            log.info(
                "a listener reservoir is low; down to %d/%d codebooks",
                self.codebooks,
                self.max_codebooks,
            )

    def _retune(self, now: float):
        if self.pinned_codebooks or self._depth_config is None:
            return
        with self._cost_lock:
            sample_count = len(self._costs)
        if sample_count < MIN_TUNE_SAMPLES:
            return

        factor = self.effective_realtime_factor()
        if factor < self.target_rtf:
            if self._deficit_since is None:
                self._deficit_since = now
        else:
            self._deficit_since = None
        if now - self._last_tune < TUNE_DWELL_SECONDS:
            return
        # Even one stall per window is recurring if the actual deficit never
        # recovers. Do not let the isolated-jitter allowance hide that forever.
        sustained = (
            self._deficit_since is not None
            and now - self._deficit_since >= TUNE_DWELL_SECONDS
        )
        if (
            factor < self.target_rtf
            and (
                self.effective_realtime_factor(ignore_worst=True) < self.target_rtf
                or sustained
            )
            and self.codebooks > self.min_codebooks
        ):
            changed = self.set_codebooks(self.codebooks - 1)
        elif factor > self.target_rtf * 1.3 and self.codebooks < self.max_codebooks:
            # only give detail back when there is real headroom, so the two
            # rules cannot chase each other across the same measurement
            changed = self.set_codebooks(self.codebooks + 1)
        else:
            return

        if changed:
            # Samples measured at the old loop depth cannot judge the new one.
            self._clear_costs()
            self._last_tune = now
            log.info(
                "retuned to %d/%d codebooks (%.2fx real time)",
                self.codebooks,
                self.max_codebooks,
                factor,
            )

    # --- generation ---

    def _run_parts(self, run) -> tuple:
        if isinstance(run, ConditioningRun):
            return (
                run.style,
                run.key,
                run.notes,
                run.frames,
                run.drum,
                run.sampling or self.default_sampling(),
            )
        if len(run) == 4:
            style, key, notes, frames = run
            return style, key, notes, frames, None, self.default_sampling()
        if len(run) == 5:
            style, key, notes, frames, drum = run
            return style, key, notes, frames, drum, self.default_sampling()
        if len(run) == 6:
            style, key, notes, frames, drum, sampling = run
            if sampling is None:
                sampling = self.default_sampling()
            elif not isinstance(sampling, SamplingControls):
                sampling = SamplingControls(*sampling)
            return style, key, notes, frames, drum, sampling
        raise ValueError("conditioning run must have 4, 5, or 6 values")

    @_ignore_upstream_shape_probe_warnings()
    def generate(self, state, plan, seed: int | None = None):
        # render one chunk, returning interleaved int16 pcm and the next state
        #
        # A plan contains ConditioningRun values (legacy four-tuples are still
        # accepted). Style, score, drum, and control boundaries split it only
        # where conditioning actually changes.
        #
        # Every frame's tokens are sampled first; the codec then decodes the
        # whole chunk in one call. The listener receives the chunk at the same
        # moment either way, and the codec costs about a third as much.
        self._raise_if_stopping()
        self.last_tokens = None
        if not self._fast:
            return self._generate_stock(state, plan, seed=seed)

        mx = self._mx
        renderer = self._renderer
        if state is None:
            state = self._new_eager_state(seed)

        stepper = renderer.stepper(state[0])
        codec_state = tuple(state[1:])
        frame_tokens = []
        # the graph mlx is still working on. handing it to async_eval and only
        # blocking on it one step later lets this thread build the next frame
        # while the gpu renders this one.
        pending = None

        for run in plan:
            self._raise_if_stopping()
            style, key, notes, frames, drum, sampling = self._run_parts(run)
            block, constants = self._conditioning(
                style, key, notes, drum=drum, sampling=sampling
            )
            encoded = renderer.encode(block, stepper.encoder_state, constants)
            for _ in range(frames):
                if self._stop_requested.is_set():
                    # Do not leave an already-submitted GPU operation running
                    # behind teardown. Drain it, then abandon the partial PCM.
                    if pending is not None:
                        mx.eval(pending)
                    self._raise_if_stopping()
                tokens, targets = stepper.step(block, encoded, constants)
                # the streaming state goes in too: left lazy it would pile up a
                # graph across the whole chunk rather than settling each frame
                mx.async_eval(*targets)
                if pending is not None:
                    mx.eval(pending)
                pending = tokens
                frame_tokens.append(tokens)

        if not frame_tokens:
            return b"", state

        pcm, codec_state = renderer.decode(frame_tokens, codec_state)
        next_state = (stepper.final_state(), *codec_state)
        chunk_tokens = (
            frame_tokens[0] if len(frame_tokens) == 1 else mx.concatenate(frame_tokens, axis=1)
        )
        mx.eval(pcm, chunk_tokens, *flatten_state(next_state, mx)[0])
        # A few hundred bytes per chunk: the sampled frames are what a
        # session keeps as its clean-anchor memory (see Session.note_chunk).
        self.last_tokens = np.array(chunk_tokens[0], dtype=np.uint32)

        # the codec's last layer already emits int16 as [1, frames * 1920, 2] -
        # so this is a copy out of mlx and nothing else.
        samples = np.asarray(pcm[0])
        return np.ascontiguousarray(samples, dtype=np.int16).tobytes(), next_state

    @property
    def supports_priming(self) -> bool:
        """Whether a fresh state can be teacher-forced through known tokens."""
        return self._fast and self._renderer is not None

    def begin_prime(self, tokens: np.ndarray, run: ConditioningRun, seed: int | None):
        """Start forcing a fresh state (under ``seed``) through ``tokens`` [N, 12].

        Drive the returned primer with ``advance_prime`` (resumable, in
        slices) and ``finish_prime``, which yields a state that continues the
        music those tokens encode. ``run`` supplies the conditioning; its
        frame count is ignored.
        """
        if not self.supports_priming:
            raise RuntimeError("priming needs the fast renderer")
        self._raise_if_stopping()
        style, key, notes, _frames, drum, sampling = self._run_parts(run)
        block, constants = self._conditioning(
            style, key, notes, drum=drum, sampling=sampling
        )
        state = self._new_eager_state(seed)
        encoded = self._renderer.encode(block, state[0][0], constants)
        return self._renderer.primer(state, block, encoded, constants, tokens)

    def advance_prime(self, primer, frames: int) -> bool:
        """Force up to ``frames`` more frames; returns whether priming is done."""
        self._raise_if_stopping()
        return primer.advance(frames)

    def finish_prime(self, primer):
        """The primed state, its codec settled on the final forced frames."""
        self._raise_if_stopping()
        # The shortest live chunk length already has a traced codec graph.
        return primer.finish(min(self.live_frame_counts))

    def _new_eager_state(self, seed: int | None):
        """Create the pinned eager sampler state with an optional decoder seed."""
        mx = getattr(self, "_mx", None)
        sl = getattr(self, "_sl", None)
        if mx is None:
            import mlx.core as mx
        if sl is None:
            import sequence_layers.mlx as sl

        input_spec = sl.ChannelSpec(
            shape=(self._system._num_channels,), dtype=mx.int32
        )
        state = self._system._sampler.get_initial_state(
            1, input_spec, constants={}, training=False
        )
        if seed is None:
            return state

        streaming_state = state[0]
        _rng, previous, temporal, step = streaming_state[2]
        seeded_decoder = (
            mx.stack([mx.random.key(int(seed) & 0xFFFFFFFF)]),
            previous,
            temporal,
            step,
        )
        seeded_streaming = (
            streaming_state[0],
            streaming_state[1],
            seeded_decoder,
            streaming_state[3],
        )
        return (seeded_streaming, *state[1:])

    def _generate_stock(self, state, plan, seed: int | None = None):
        # the library's own call, one segment at a time. only used when the
        # fast path could not find what it needs.
        if state is None and seed is not None:
            # Magenta's stock wrapper otherwise initializes every take with
            # decoder key 42. Seed its eager state explicitly so "new take"
            # and fixed-seed comparisons keep the same semantics as fast mode.
            state = self._new_eager_state(seed)
        chunks = []
        for run in plan:
            self._raise_if_stopping()
            style, _key, notes, frames, drum, sampling = self._run_parts(run)
            style_tokens = self.tokenize_style(style)
            style_tokens[self.style_token_levels :] = [-1] * (
                len(style_tokens) - self.style_token_levels
            )
            conditioning = {self._style_key: style_tokens}
            note_tokens = self._note_tokens(notes)
            if note_tokens is not None:
                conditioning[self._notes_key] = note_tokens
            if drum is None and hasattr(notes, "drum"):
                drum = int(notes.drum)
            if drum is not None:
                conditioning[self._drums_key] = [drum]
            waveform, state = self._system.generate(
                conditioning=conditioning,
                cfg_scales={
                    "musiccoca": sampling.cfg_musiccoca,
                    "notes": sampling.cfg_notes,
                    "drums": sampling.cfg_drums,
                },
                temperature=sampling.temperature,
                top_k=sampling.top_k,
                frames=frames,
                state=state,
            )
            samples = np.clip(waveform.samples, -1.0, 1.0)
            chunks.append((samples * 32767.0).astype(np.int16))

        pcm = chunks[0] if len(chunks) == 1 else np.concatenate(chunks, axis=0)
        return np.ascontiguousarray(pcm).tobytes(), state

    def close(self):
        """Release model and cache state on the MLX-owning worker thread."""
        executor = self._embed_executor
        self._embed_executor = None
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)
        embedder = self._process_embedder
        self._process_embedder = None
        if embedder is not None:
            embedder.close()
        self._embed_futures.clear()
        self._warm = False
        self._style_key = None
        self._notes_key = None
        self._drums_key = None
        self._embeddings.clear()
        self._style_tokens.clear()
        self._blocks.clear()
        self._sampler = None
        self._input_spec = None
        self._depth_config = None
        self._keepalive_value = None
        self._renderer = None
        self._tokenizer = None
        self._released_interpreters = []
        self.last_tokens = None
        self._system = None
        self._fast = False
        self._fast_sampling = False
        self._fast_engine = None
        self._active_streams = 1
        with self._cost_lock:
            self._costs.clear()
            self._last_known_cost = 0.0

        mx = getattr(self, "_mx", None)
        if mx is not None:
            try:
                mx.clear_cache()
            except Exception:  # noqa: BLE001 - best-effort native cache release
                log.exception("failed to clear MLX cache during shutdown")
