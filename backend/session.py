# per-user generation session

import hashlib
import os
import threading
import time

import numpy as np

import engine as engine_mod
import styles
from music_controls import MusicControls
from hiss_filter import HissFilter
from take_health import TakeFloorMonitor


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


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# How long a station change takes to fully land. The stream glides to the new
# style over this window and then sits exactly on it.
STYLE_RAMP_SECONDS = max(
    engine_mod.FRAME_SECONDS, _env_float("MRT_STYLE_RAMP_SECONDS", 0.32)
)

# The finest slice of a chunk that can carry its own style. Splitting only while
# a transition is active keeps the normal prompt path to one conditioning run.
STYLE_STEP_FRAMES = max(1, _env_int("MRT_STYLE_STEP_FRAMES", 2))

# Clean-anchor memory for long takes (see take_health). An anchor is the
# sampled tokens of a stretch of this take whose own quiet moments were
# verified free of hiss. The default fills mrt2_small's whole ~19.7 s
# receptive field (12 layers x 41 frames): a shorter anchor was measured to
# re-drift within half a minute, because the most recent "clean" stretch
# already carried the faint start of the next hiss bed. Priming costs about
# 2.5-3 ms per frame on an M3 Pro and runs between chunks.
ANCHOR_SECONDS = max(4.0, min(19.6, _env_float("MRT_ANCHOR_SECONDS", 19.6)))
ANCHOR_FRAMES = int(round(ANCHOR_SECONDS * engine_mod.FRAMES_PER_SECOND))
# How often a newly verified stretch is considered for the pool.
ANCHOR_INTERVAL_SECONDS = 15.0
# The pool keeps the cleanest few stretches. A re-prime uses the cleanest,
# preferring the most recent among those within ANCHOR_TIE_DB of it so the
# music jumps back no further than it must.
ANCHOR_POOL = 4
ANCHOR_TIE_DB = 1.5
# Re-primes are spaced at least this far apart in audio time, doubling each
# time one is needed again within REPRIME_RETRY_SECONDS of the last (capped
# at REPRIME_MAX_BACKOFF doublings). A floor that keeps coming back is either
# the station genuinely getting busier (brushed drums read much like hiss) or
# a take the memory cannot hold; either way, jumping back every minute would
# cost more music than it saves, and the fresh-state splice takes over.
REPRIME_MIN_INTERVAL_SECONDS = 45.0
REPRIME_RETRY_SECONDS = 120.0
REPRIME_MAX_BACKOFF = 3

ACTIVE = "active"
QUEUED = "queued"
SUSPENDED = "suspended"


def _smoothstep(t: float) -> float:
    # ease the ramp so the transition sounds musical rather than mechanical
    return t * t * (3.0 - 2.0 * t)


def _blend(a: np.ndarray, b: np.ndarray, t: float) -> np.ndarray:
    # Match MusicCoCa's native prompt mixer: normalized weights, linear sum,
    # then RVQ. Renormalizing the vector after mixing changes the token path
    # and is not how Magenta's interactive runtime blends prompt surfaces.
    return ((1.0 - t) * a + t * b).astype(np.float32)


def _seed_for(session_id: str) -> int:
    """Return the same stable 32-bit seed used by the offline composer."""
    digest = hashlib.blake2s(session_id.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") & 0xFFFFFFFF


class Session:
    # one user's endless stream: its own model state, style, and pacing

    def __init__(
        self,
        session_id: str,
        mood: str,
        instrument: str,
        *,
        station: str | None = None,
        controls: dict | None = None,
    ):
        self.id = session_id
        self.status = QUEUED
        self.created_at = time.monotonic()
        self.last_seen = self.created_at

        # opaque mrt2 streaming state - this is what makes the stream endless
        # and what we hold onto across a pause
        self.state = None

        # Planning holds this lock across style advancement. Re-entrancy keeps
        # the smaller public helpers usable without letting a WebSocket control
        # request split that transaction.
        self._lock = threading.RLock()
        self.controls = MusicControls.initial(
            mood, instrument, station=station, payload=controls
        )
        self.mood = self.controls.mood
        self.instrument = self.controls.instrument
        self.station = self.controls.station
        self._active_prompt = self.controls.prompt()
        self._active_reference = self.controls.reference()
        self._pending_style: tuple[str, str | None] | None = None
        self.seed = _seed_for(session_id)

        # New variation invalidates a render already in flight. The worker is
        # the only thread that releases the corresponding MLX state.
        self._render_epoch = 0
        self._reset_requested = False

        # style ramp
        self._current: np.ndarray | None = None
        # the prompt `_current` is exactly, or None while it is a blend of two.
        # the engine caches tokenized conditioning under it.
        self._current_key: str | None = None
        self._active_style_key: str | None = None
        self._ramp_from: np.ndarray | None = None
        self._ramp_to: np.ndarray | None = None
        self._ramp_elapsed = 0.0
        self._ramping = False

        # pacing: monotonic time at which everything generated so far will have
        # finished playing
        self.playhead = 0.0
        self._paused_lead = 0.0
        self._preserve_paused_audio = False
        self.generated_seconds = 0.0

        # gaps the listener actually heard. the client reports these when its
        # reservoir empties - only it knows, since it is the thing playing.
        self.gaps = 0

        # wall time spent active, for the measured real time factor
        self._active_since: float | None = None
        self._active_wall = 0.0

        # how much audio this session has rendered so far, which is how the
        # worker knows to start it in small chunks and grow to steady state
        self.chunks_rendered = 0

        # Watches the delivered PCM for the recurrent-state failure where the
        # model slowly amplifies a hiss bed it has fed back to itself. The
        # worker consults it and, when a take has audibly drifted, crossfades
        # onto a fresh state without touching the session or transport.
        self.floor_monitor = TakeFloorMonitor()
        self._refreshes = 0
        # Set when a station change arrives while the floor is already voting
        # for drift: the new station should not inherit a state that has
        # begun to hiss. The worker performs the same crossfade it uses for a
        # sustained drift, at a moment that is already a musical boundary.
        self._refresh_requested = False

        # Removes the stationary hiss floor from the PCM the listener hears
        # (hiss_filter). Worker thread only; reset at every new take.
        self.hiss_filter = HissFilter()
        self._hiss_filter_active = False

        # Clean-anchor memory, owned by the worker thread. `_recent_tokens`
        # holds the last ANCHOR_FRAMES sampled frames rendered under one
        # unchanged conditioning; `anchor` is a verified-clean copy of them,
        # and `primer` a standby state being teacher-forced through it.
        self._recent_tokens: list[np.ndarray] = []
        self._recent_frames = 0
        self._recent_conditioning = None
        # (high-band floor dB, generated seconds, tokens), cleanest few only
        self._anchors: list[tuple[float, float, np.ndarray]] = []
        self._anchor_conditioning = None
        self._anchor_at = -float("inf")
        self.primer = None
        self.primer_seed: int | None = None
        self.primer_started = 0.0
        self.primer_started_audio = 0.0
        self._reprimes = 0
        self._last_reprime_at = -float("inf")
        self._reprime_backoff = 0

        # Set by the websocket handler while a client is attached. The worker
        # supplies ``(pcm, render_epoch)`` so deferred event-loop delivery can
        # reject audio from a superseded variation.
        self.sink = None
        self.epoch_sink = None
        self.on_status = None

    # --- control (called from the websocket handler) ---

    def request_style(
        self, mood: str, instrument: str, *, station: str | None = None
    ) -> tuple[str, str]:
        payload = {"mood": mood, "instrument": instrument}
        if station is not None:
            payload["station"] = station
        self.request_controls(payload)
        return self.mood, self.instrument

    def request_controls(self, payload: dict) -> dict:
        """Validate and atomically queue listener music controls."""
        with self._lock:
            next_controls = self.controls.update(payload)
            self.controls = next_controls
            self.mood = next_controls.mood
            self.instrument = next_controls.instrument
            self.station = next_controls.station
            next_target = (next_controls.prompt(), next_controls.reference())
            current_target = (self._active_prompt, self._active_reference)
            if next_target != current_target:
                self._pending_style = next_target
            else:
                # Moving a style away and back before the next render cancels that
                # queued timbre instead of landing a stale intermediate value.
                self._pending_style = None

            return next_controls.payload()

    def control_payload(self) -> dict:
        with self._lock:
            return self.controls.payload()

    def request_variation(self, new_id: str) -> int:
        with self._lock:
            self.id = new_id
            self.seed = _seed_for(new_id)
            self._request_reset_locked()
            return self.seed

    def request_transport_reset(self) -> int:
        """Invalidate in-flight work and restart this take on its next render."""
        with self._lock:
            self._request_reset_locked()
            return self._render_epoch

    def _request_reset_locked(self):
        self._render_epoch += 1
        self._reset_requested = True
        # Audio already queued on the client is reset at the matching transport
        # boundary. Make this session due immediately on its next activation.
        self.playhead = time.monotonic()
        self._paused_lead = 0.0

    def prepare_render(self) -> int:
        """Apply a requested reset on the MLX-owning worker thread."""
        with self._lock:
            if self._reset_requested:
                self.state = None
                self.seed = _seed_for(self.id)
                self.generated_seconds = 0.0
                self.chunks_rendered = 0
                self._active_wall = 0.0
                self._active_since = time.monotonic() if self.status == ACTIVE else None
                # A new take is a genuine clean boundary.  Preserve the
                # listener's current control values, but do not carry a stale
                # style ramp or a previously queued station into the new model
                # state.  The next plan embeds the requested target outright.
                self._active_prompt = self.controls.prompt()
                self._active_reference = self.controls.reference()
                self._pending_style = None
                self._current = None
                self._current_key = None
                self._active_style_key = None
                self._ramp_from = None
                self._ramp_to = None
                self._ramp_elapsed = 0.0
                self._ramping = False
                self._reset_requested = False
                self._refresh_requested = False
                self.floor_monitor.reset()
                self.forget_anchor()
                self.hiss_filter.reset()
            return self._render_epoch

    def next_refresh_seed(self) -> int:
        """Deterministic seed for the nth mid-take state refresh."""
        with self._lock:
            self._refreshes += 1
            return _seed_for(f"{self.id}:refresh:{self._refreshes}")

    @property
    def refreshes(self) -> int:
        return self._refreshes

    def consume_refresh_request(self) -> bool:
        """Return and clear a pending mid-take state refresh request."""
        with self._lock:
            requested = self._refresh_requested
            self._refresh_requested = False
            return requested

    def render_is_current(self, epoch: int) -> bool:
        with self._lock:
            return epoch == self._render_epoch

    # --- clean-anchor memory (worker thread only) ---

    @staticmethod
    def _plan_conditioning(plan):
        """One hashable conditioning identity for a plan, or None if it varies.

        Style ramps (keyless blends) and plans that mix conditionings cannot
        be replayed as one block, so they never become anchor memory.
        """
        identities = {
            (getattr(run, "key", None), getattr(run, "drum", None)) for run in plan
        }
        if len(identities) != 1:
            return None
        identity = identities.pop()
        return identity if identity[0] is not None else None

    def note_chunk(self, tokens, plan):
        """Record a rendered chunk's sampled frames and maybe take an anchor."""
        conditioning = self._plan_conditioning(plan) if tokens is not None else None
        if conditioning is None or conditioning != self._recent_conditioning:
            self._recent_tokens = []
            self._recent_frames = 0
        if conditioning is not None and conditioning != self._anchor_conditioning:
            # Memory rendered under another station or drum setting cannot
            # continue this one.
            self._anchors = []
            self._anchor_conditioning = None
            self.primer = None
            self.primer_seed = None
        self._recent_conditioning = conditioning
        if conditioning is None:
            return
        self._recent_tokens.append(np.asarray(tokens, dtype=np.uint32))
        self._recent_frames += len(tokens)
        while (
            len(self._recent_tokens) > 1
            and self._recent_frames - len(self._recent_tokens[0]) >= ANCHOR_FRAMES
        ):
            self._recent_frames -= len(self._recent_tokens.pop(0))
        if (
            self._recent_frames >= ANCHOR_FRAMES
            and self.generated_seconds - self._anchor_at >= ANCHOR_INTERVAL_SECONDS
            and self.floor_monitor.recent_is_clean(ANCHOR_SECONDS)
        ):
            floor_db = self.floor_monitor.recent_high_floor_db(ANCHOR_SECONDS)
            tokens = np.concatenate(self._recent_tokens)[-ANCHOR_FRAMES:]
            self._anchors.append((floor_db, self.generated_seconds, tokens))
            if len(self._anchors) > ANCHOR_POOL:
                # Drop the noisiest; among equals, the oldest.
                worst = max(self._anchors, key=lambda a: (a[0], -a[1]))
                self._anchors.remove(worst)
            self._anchor_conditioning = conditioning
            self._anchor_at = self.generated_seconds

    @property
    def anchor(self) -> np.ndarray | None:
        """Tokens of the stretch a re-prime would continue from, if any."""
        anchors = list(self._anchors)
        if not anchors:
            return None
        best = min(a[0] for a in anchors)
        near = [a for a in anchors if a[0] <= best + ANCHOR_TIE_DB]
        return max(near, key=lambda a: a[1])[2]

    def filter_pcm(self, pcm: bytes) -> bytes:
        """The chunk the listener hears: hiss floor removed unless requested."""
        active = not styles.requests_noise_texture(self._active_prompt)
        if active != self._hiss_filter_active:
            # Switching in or out must not replay audio buffered in the filter.
            self.hiss_filter.reset()
            self._hiss_filter_active = active
        return self.hiss_filter.process(pcm) if active else pcm

    def restart_recent_tokens(self):
        """Begin a new run of recent frames after a splice; the anchor stays."""
        self._recent_tokens = []
        self._recent_frames = 0
        self._recent_conditioning = None

    def forget_anchor(self):
        self.restart_recent_tokens()
        self._last_reprime_at = -float("inf")
        self._reprime_backoff = 0
        self._anchors = []
        self._anchor_conditioning = None
        self._anchor_at = -float("inf")
        self.primer = None
        self.primer_seed = None

    def anchor_run(self, plan):
        """The plan run a primer may use, if the anchor matches the plan."""
        if not self._anchors:
            return None
        if self._plan_conditioning(plan) != self._anchor_conditioning:
            return None
        return plan[-1]

    def reprime_allowed(self) -> bool:
        """Whether enough audio has passed since the last re-prime."""
        wait = REPRIME_MIN_INTERVAL_SECONDS * (2 ** self._reprime_backoff)
        return self.generated_seconds - self._last_reprime_at >= wait

    def next_reprime_seed(self) -> int:
        with self._lock:
            return _seed_for(f"{self.id}:reprime:{self._reprimes + 1}")

    def _note_reprime_attempt(self):
        """Space the next attempt: back off when the last one did not hold."""
        wait = REPRIME_MIN_INTERVAL_SECONDS * (2 ** self._reprime_backoff)
        since = self.generated_seconds - self._last_reprime_at
        if since < wait + REPRIME_RETRY_SECONDS:
            # Needed again soon after it was allowed: the floor is coming
            # straight back, so wait twice as long next time.
            self._reprime_backoff = min(REPRIME_MAX_BACKOFF, self._reprime_backoff + 1)
        else:
            self._reprime_backoff = 0
        self._last_reprime_at = self.generated_seconds

    def note_reprime(self, seed: int):
        self._note_reprime_attempt()
        with self._lock:
            self._reprimes += 1
            self.seed = seed
        self.primer = None
        self.primer_seed = None

    def abandon_primer(self):
        """Drop an unfinished or failed standby; it counts as an attempt.

        Otherwise a standby that cannot finish (no idle time on this
        machine, or a deterministic failure) would restart from frame zero
        on the very next chunk, forever, and hold off the fresh-state splice
        a drifted take needs.
        """
        self.primer = None
        self.primer_seed = None
        self._note_reprime_attempt()

    @property
    def reprimes(self) -> int:
        return self._reprimes

    def release_state(self):
        """Release MLX-backed recurrent state; called only by the model worker."""
        with self._lock:
            self.state = None
            self.primer = None
            self.primer_seed = None

    def deliver_if_current(self, epoch: int, deliver, item) -> bool:
        """Serialize an event-loop delivery against variation resets.

        The worker can validate a render before scheduling a thread-safe
        callback, then lose a race to a variation acknowledgement before that
        callback runs.  Rechecking and queueing while holding the session lock
        makes the old-PCM/ack ordering unambiguous: the PCM is either queued
        before the reset or discarded after it.
        """
        with self._lock:
            if epoch != self._render_epoch:
                return False
            deliver(item)
            return True

    def touch(self):
        self.last_seen = time.monotonic()

    # --- pacing (called from the worker) ---

    def needs_audio(self, now: float, lookahead: float) -> bool:
        # true when this session has less than `lookahead` seconds of audio
        # generated but unplayed
        return self.status == ACTIVE and (self.playhead - now) < lookahead

    def due_in(self, now: float, lookahead: float) -> float:
        # seconds until this session wants its next chunk, so the worker can
        # sleep exactly that long instead of waking up to ask
        if self.status != ACTIVE:
            return float("inf")
        return (self.playhead - now) - lookahead

    def start_clock(self):
        now = time.monotonic()
        self.playhead = now + self._paused_lead
        self._paused_lead = 0.0
        self._preserve_paused_audio = False
        self._active_since = now

    def stop_clock(self, preserve_audio: bool = False):
        # bank the wall time so the real time factor survives a pause
        now = time.monotonic()
        self._paused_lead = max(0.0, self.playhead - now) if preserve_audio else 0.0
        self._preserve_paused_audio = preserve_audio
        if self._active_since is not None:
            self._active_wall += now - self._active_since
            self._active_since = None

    def note_generated(self, seconds: float):
        now = time.monotonic()
        if self.status == SUSPENDED and self._preserve_paused_audio:
            # A pause can race the inference call already in flight. Its PCM is
            # retained by the stopped worklet, so keep the matching lead here.
            self._paused_lead += seconds
            self.playhead = now + self._paused_lead
        elif self.playhead < now:
            # generation fell behind the wall clock; rebase so we don't spend
            # forever trying to make up a deficit we cannot make up
            self.playhead = now
        self.playhead += seconds
        self.generated_seconds += seconds
        self.chunks_rendered += 1

    def note_gap(self):
        self.gaps += 1

    def realtime_factor(self) -> float:
        # seconds of audio produced per second of wall clock. below 1.0 means
        # the machine cannot render this model live, and the client's reservoir
        # drains at (1 - factor) per second.
        wall = self._active_wall
        if self._active_since is not None:
            wall += time.monotonic() - self._active_since
        if wall <= 0.0:
            return 0.0
        return self.generated_seconds / wall

    # --- style (called from the worker) ---

    @staticmethod
    def _style_key(engine, prompt: str, reference: str | None) -> str:
        make_key = getattr(engine, "style_cache_key", None)
        return make_key(prompt, reference) if make_key is not None else prompt

    @staticmethod
    def _embed_style(engine, prompt: str, reference: str | None) -> np.ndarray:
        return engine.embed(prompt, reference) if reference else engine.embed(prompt)

    def _activate_pending_style(self, engine):
        with self._lock:
            pending = self._pending_style
        if pending is not None and self._current is not None:
            # A prompt nobody has embedded yet (a new custom mix) goes to the
            # background embedder; the current style keeps playing until it
            # is ready rather than stalling the model thread for the second
            # MusicCoCa's text encoder takes to rebuild.
            ready = getattr(engine, "embedding_ready", None)
            prefetch = getattr(engine, "prefetch_embedding", None)
            if ready is not None and prefetch is not None and not ready(*pending):
                prefetch(*pending)
                return
        with self._lock:
            if self._pending_style != pending:
                # A newer request replaced it while the embedder worked.
                return
            self._pending_style = None

        if pending is not None:
            prompt, reference = pending
            self._active_prompt = prompt
            self._active_reference = reference
            self._active_style_key = self._style_key(engine, prompt, reference)
            # The recurrent state - and any drift it carries - survives a
            # station change. Learn the new station's floor, but keep the
            # take's earlier one as a cap so a bed carried across cannot
            # become the new normal. If the floor was already voting for
            # drift, have the worker splice onto a fresh state at this
            # boundary instead.
            if self.floor_monitor.suspicious:
                self._refresh_requested = True
            relearn = getattr(self.floor_monitor, "relearn_baseline", None)
            if relearn is not None:
                relearn()
            else:
                self.floor_monitor.reset()
            self.forget_anchor()
            if self._current is not None:
                # ramp from wherever we are now, which may itself be mid-ramp
                self._ramp_from = self._current
                self._ramp_to = self._embed_style(engine, prompt, reference)
                self._ramp_elapsed = 0.0
                self._ramping = True

    def _style_segments(
        self, engine, frames: int
    ) -> list[tuple[np.ndarray, str | None, int]]:
        """Render style runs without consuming a newly pending target."""

        if self._current is None:
            # first chunk of the session: start on the requested style outright
            self._current = self._embed_style(
                engine, self._active_prompt, self._active_reference
            )
            self._active_style_key = self._style_key(
                engine, self._active_prompt, self._active_reference
            )
            self._current_key = self._active_style_key

        plan: list[tuple[np.ndarray, str | None, int]] = []
        remaining = frames
        while remaining > 0:
            if self._ramping:
                ramp_frames_left = max(
                    1,
                    round(
                        (STYLE_RAMP_SECONDS - self._ramp_elapsed)
                        / engine_mod.FRAME_SECONDS
                    ),
                )
                take = min(STYLE_STEP_FRAMES, remaining, ramp_frames_left)
            else:
                take = remaining
            remaining -= take
            if self._ramping:
                seconds = take * engine_mod.FRAME_SECONDS
                # Condition the whole segment at its midpoint rather than its
                # end, avoiding an immediate jump on every control change.
                style, key = self._ramp_at(self._ramp_elapsed + seconds * 0.5)
                plan.append((style, key, take))
                self._advance_ramp(seconds)
            else:
                plan.append((self._current, self._current_key, take))
        return plan

    def style_plan(self, engine, frames: int) -> list[tuple[np.ndarray, str | None, int]]:
        """Return prompt-style runs, applying changes on the next model chunk."""
        if frames <= 0:
            return []
        self._activate_pending_style(engine)
        return self._style_segments(engine, frames)

    def conditioning_plan(
        self, engine, frames: int
    ) -> list[engine_mod.ConditioningRun]:
        with self._lock:
            return self._conditioning_plan(engine, frames)

    def _conditioning_plan(
        self, engine, frames: int
    ) -> list[engine_mod.ConditioningRun]:
        """Build the minimal conditioning MRT2 needs for live generation."""
        if frames <= 0:
            return []
        style_runs = self.style_plan(engine, frames)
        with self._lock:
            controls = self.controls
        sampling = self._sampling_for(engine, controls)
        drum = None if controls.drums else 0
        return [
            engine_mod.ConditioningRun(
                style=style,
                key=key,
                notes=None,
                drum=drum,
                frames=run_frames,
                sampling=sampling,
            )
            for style, key, run_frames in style_runs
        ]

    @staticmethod
    def _sampling_for(engine, controls=None) -> engine_mod.SamplingControls:
        base = (
            engine.default_sampling()
            if hasattr(engine, "default_sampling")
            else engine_mod.SamplingControls(1.0, 100, 3.0, 1.0, 1.0)
        )
        if controls is None:
            return base
        overrides = controls.sampling_overrides()
        # Clamp the derived values to ranges the model tolerates for live,
        # long-running takes. These bounds bracket the tuned production
        # defaults (temperature 1.0, MusicCoCa CFG 4.0) without letting a
        # listener push the stream somewhere it drifts or collapses.
        temperature = _clamp(
            base.temperature * overrides["temperature_scale"], 0.7, 1.3
        )
        # A station that asks for more guidance keeps the dial's full travel,
        # up to the 7.0 the CFG conditioning token can encode.
        ceiling = min(7.0, 6.0 * styles.station_guidance(controls.station))
        cfg_musiccoca = _clamp(
            base.cfg_musiccoca * overrides["cfg_musiccoca_scale"], 3.0, ceiling
        )
        return engine_mod.SamplingControls(
            temperature=temperature,
            top_k=base.top_k,
            cfg_musiccoca=cfg_musiccoca,
            cfg_notes=base.cfg_notes,
            cfg_drums=base.cfg_drums,
        )

    def _ramp_at(self, elapsed: float) -> tuple[np.ndarray, str | None]:
        t = min(1.0, elapsed / STYLE_RAMP_SECONDS)
        if t >= 1.0:
            return self._ramp_to, self._active_style_key
        return _blend(self._ramp_from, self._ramp_to, _smoothstep(t)), None

    def _advance_ramp(self, seconds: float):
        self._ramp_elapsed += seconds
        t = min(1.0, self._ramp_elapsed / STYLE_RAMP_SECONDS)
        if t >= 1.0:
            self._current = self._ramp_to
            self._current_key = self._active_style_key
            self._ramping = False
        else:
            self._current = _blend(self._ramp_from, self._ramp_to, _smoothstep(t))
            self._current_key = None

    def snapshot(self) -> dict:
        controls = self.control_payload()
        return {
            "id": self.id,
            "status": self.status,
            **controls,
            "seed": self.seed,
            "generatedSeconds": round(self.generated_seconds, 1),
            "realtimeFactor": round(self.realtime_factor(), 3),
            "gaps": self.gaps,
            "takeRefreshes": self._refreshes,
            "takeReprimes": self._reprimes,
            # Read from the event loop while the worker may edit the pool.
            "cleanAnchor": bool(self._anchors),
        }
