# session lifecycle plus the single generation worker

import gc
import logging
import os
import threading
import time
from collections import deque

import engine as engine_mod
import styles
from session import ACTIVE, QUEUED, SUSPENDED, Session
from take_health import crossfade_pcm
from worker_priority import configure_worker_priority

log = logging.getLogger(__name__)


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


# Audio generated per model call. Ten frames stays about 1.17x real time on the
# baseline M1 while halving the control granularity of the former 20-frame call.
CHUNK_FRAMES = max(1, _env_int("MRT_CHUNK_FRAMES", 10))
CHUNK_SECONDS = CHUNK_FRAMES / engine_mod.FRAMES_PER_SECOND

# Use one shorter first burst, then the steady batch size. This gives the
# browser early progress without keeping the inefficient one-frame cadence.
FIRST_CHUNK_FRAMES = max(1, _env_int("MRT_FIRST_CHUNK_FRAMES", 8))

# how far ahead of the wall clock a session may run. this is the reservoir the
# client drinks from, and it is also the dominant term in control latency: audio
# already generated cannot be restyled, because the model state has moved past
# it. it used to be six seconds because the model rendered slower than real
# time and the reservoir was all that stood between the listener and a gap.
# The engine adapts above its listener-facing quality floor; the client grows
# its own prebuffer when measured speed is close to the line. This server-side
# lead mainly covers scheduling jitter and bounds how stale a style change can
# be.
LOOKAHEAD_SECONDS = max(0.0, _env_float("MRT_LOOKAHEAD_SECONDS", 0.4))

# concurrent streams. one model instance serves all of them from one thread, so
# this is bounded by how much faster than real time the model runs. watch
# realtimeFactor in /health: it needs to stay above 1.0 per active session.
MAX_ACTIVE = max(1, _env_int("MRT_MAX_SESSIONS", 1))

# how long a paused or disconnected session keeps its state before being reaped
SESSION_TTL = _env_float("MRT_SESSION_TTL", 300.0)

# Guards long takes against the model amplifying its own noise floor. When a
# session's quiet-block floor rises audibly above its own early baseline, the
# worker crossfades onto a fresh recurrent state mid-stream. See take_health.
TAKE_GUARD = _env_int("MRT_TAKE_GUARD", 1) != 0

# Prefer repairing a drifting take by re-priming a standby state from the
# take's own verified-clean recent memory (Session.anchor) over restarting it
# from silence. The standby is teacher-forced in slices while the worker would
# otherwise idle, so no listener waits on it; a fresh state remains the
# fallback when no clean anchor exists or priming cannot finish in time.
TAKE_REPRIME = _env_int("MRT_TAKE_REPRIME", 1) != 0

# Remove the stationary hiss floor from every stream before it is sent (see
# hiss_filter). The take guard still watches the unfiltered model output.
HISS_FILTER = _env_int("MRT_HISS_FILTER", 1) != 0

# Opt-in diagnostics: write the PCM each session actually sends to a WAV file
# in this directory, so what a listener heard can be measured afterwards.
RECORD_DIR = os.environ.get("MRT_RECORD_DIR", "").strip()
PRIME_SLICE_FRAMES = 16
PRIME_TIMEOUT_SECONDS = 20.0
# Idle time kept free after a priming slice, and the per-frame cost assumed
# before one has been measured (a conservative M1-class figure).
PRIME_SLACK_MARGIN_SECONDS = 0.01
PRIME_FRAME_COST_SECONDS = 0.008

# ceiling on retained sessions, so suspended state cannot pile up unbounded
MAX_TOTAL = max(MAX_ACTIVE, _env_int("MRT_MAX_SESSIONS_TOTAL", 8))

# longest the worker sleeps when nobody needs audio
IDLE_WAIT = 0.25
GPU_KEEPALIVE_SECONDS = 0.02
STATUS_INTERVAL_SECONDS = 4.0


class SessionManager:
    # owns every session and the one thread allowed to touch the model

    def __init__(self):
        self.engine = engine_mod.MRTEngine()
        # The engine pre-traces its compiled graphs for exactly the chunk
        # lengths this worker renders.
        self.engine.live_frame_counts = (
            min(CHUNK_FRAMES, FIRST_CHUNK_FRAMES),
            CHUNK_FRAMES,
        )
        self._sessions: dict[str, Session] = {}
        self._active: list[Session] = []
        self._waiting: deque[Session] = deque()
        # Sessions removed by the event-loop thread keep MLX arrays until the
        # owning worker can release them safely.
        self._release_queue: deque[Session] = deque()
        self._lock = threading.RLock()
        self._lifecycle_lock = threading.RLock()
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._running = False
        self._worker: threading.Thread | None = None
        self._cursor = 0
        self._last_reap = time.monotonic()
        self._last_quality = 0
        self._last_status_at = 0.0
        self._worker_qos = "unavailable"
        # Model/config mutations must stay on the MLX worker thread. The event
        # loop only raises these coalesced feedback flags and wakes it.
        self._pending_gap = False
        self._pending_pressure = False
        # Measured seconds per teacher-forced frame, for sizing idle slices.
        self._prime_frame_cost = PRIME_FRAME_COST_SECONDS

    # --- startup / shutdown ---

    def start(self):
        # the worker loads the model itself, off the request path, so the server
        # comes up instantly
        with self._lifecycle_lock:
            with self._lock:
                if self._worker is not None and self._worker.is_alive():
                    return
                self._stopping.clear()
                self._wake.clear()
                self._running = True
                prepare = getattr(self.engine, "prepare_start", None)
                if prepare is not None:
                    prepare()
                self._worker = threading.Thread(
                    target=self._run,
                    name="mrt-worker",
                    daemon=False,
                )
                self._worker.start()

    def _load(self) -> bool:
        # must run on the worker thread - see the note in MRTEngine
        started = time.monotonic()
        try:
            self.engine.load()
            if self._stopping.is_set():
                return False
            prompts = styles.all_prompts()
            references = styles.reference_map()
            if references:
                self.engine.warm_embeddings(prompts, references=references)
            else:
                self.engine.warm_embeddings(prompts)
            if self._stopping.is_set():
                return False
            # measure this machine before anyone listens to it, so the first
            # stream already runs at a quality it can actually sustain
            self.engine.calibrate()
            if self._stopping.is_set():
                return False
        except Exception as exc:  # noqa: BLE001 - surfaced to clients via /health
            if self._stopping.is_set():
                return False
            self.engine.load_error = str(exc)
            log.exception("model failed to load")
            self._broadcast_terminal_error(str(exc))
            return False

        # Loading leaves a quarter of a million long-lived Python objects
        # (MLX module trees, TFLite and JAX imports). A full collection walks
        # all of them - about 40 ms on an M3 Pro, more on an M1 - and lands
        # on this thread at arbitrary moments mid-stream. Freezing them after
        # warm-up leaves the collector only the short-lived per-frame objects.
        gc.collect()
        gc.freeze()
        log.info("model ready in %.1fs", time.monotonic() - started)
        self._last_quality = self.engine.codebooks
        with self._lock:
            self._promote()
        self._broadcast_status()
        return True

    def stop(self):
        # Detach delivery first. A model call already in flight may need a
        # moment to drain, but none of its result may reach a closing loop.
        with self._lifecycle_lock:
            with self._lock:
                self._running = False
                self._stopping.set()
                worker = self._worker
                for session in self._sessions.values():
                    session.sink = None
                    session.epoch_sink = None
                    session.on_status = None

            request_stop = getattr(self.engine, "request_stop", None)
            if request_stop is not None:
                request_stop()
            self._wake.set()
            if worker is threading.current_thread():
                raise RuntimeError("SessionManager.stop() cannot join its own worker")

            if worker is not None:
                # Returning with a live inference thread is not a completed
                # shutdown. The shell supervisor supplies the hard deadline
                # for a genuinely wedged native call.
                worker.join()
                if worker.is_alive():
                    raise RuntimeError("model worker is still running after shutdown")

            with self._lock:
                if self._worker is worker:
                    self._worker = None
                # This is normally already empty from the worker's finally.
                # It also covers stop-before-start and a late failed-load edge.
                self._clear_session_registry_locked()

    # --- session lifecycle (called from the event loop) ---

    def attach(
        self,
        session_id: str | None,
        mood: str,
        instrument: str,
        sink=None,
        on_status=None,
        station: str | None = None,
        controls: dict | None = None,
        epoch_sink=None,
    ) -> tuple[Session, bool]:
        # resume a suspended session by id, or open a new one
        with self._lock:
            if not self._running or self._stopping.is_set():
                raise RuntimeError("session manager is not running")
            existing = self._sessions.get(session_id) if session_id else None
            if existing is not None and (
                existing.sink is not None or existing.epoch_sink is not None
            ):
                # someone is already listening on that id (a duplicated tab, or
                # a stale id someone pasted) - give this client its own stream
                # rather than stealing the audio out from under them, and a new
                # id with it so the registry entry is not clobbered below
                existing = None
                session_id = None

            if session_id and existing is None:
                # A client may retain an id after its server-side state expired
                # or the backend restarted. Reusing that stale string would
                # recreate the same deterministic seed and pretend it resumed.
                session_id = None

            if existing is not None:
                existing.touch()
                existing.sink = sink
                existing.epoch_sink = epoch_sink
                existing.on_status = on_status
                if hasattr(existing, "request_controls"):
                    payload = dict(controls or {})
                    if "mood" not in payload:
                        payload["mood"] = mood
                    if "instrument" not in payload:
                        payload["instrument"] = instrument
                    if station is not None and "station" not in payload:
                        payload["station"] = station
                    existing.request_controls(payload)
                else:
                    existing.request_style(mood, instrument)
                if existing.status == SUSPENDED:
                    self._enqueue(existing)
                self._promote()
                return existing, True

            self._evict_stale()
            self._make_room_for_session()
            if len(self._sessions) >= MAX_TOTAL:
                raise RuntimeError("retained session capacity reached")

            session = Session(
                session_id or self._new_id(),
                mood,
                instrument,
                station=station,
                controls=controls,
            )
            # Bind delivery before promotion so even an unusually fast first
            # inference cannot finish into a missing sink.
            session.sink = sink
            session.epoch_sink = epoch_sink
            session.on_status = on_status
            self._sessions[session.id] = session
            self._enqueue(session)
            self._promote()
            return session, False

    def new_variation(self, session: Session) -> tuple[str, int]:
        """Give a live session a fresh id, seed, and model state.

        The actual MLX state is released by the worker.  Changing the render
        epoch here makes any inference already in flight discard its output.
        """
        with self._lock:
            if not self._running or self._stopping.is_set():
                raise RuntimeError("session manager is not running")
            if self._sessions.get(session.id) is not session:
                raise RuntimeError("session is no longer attached")
            old_id = session.id
            new_id = self._new_id()
            seed = session.request_variation(new_id)
            self._sessions.pop(old_id, None)
            self._sessions[new_id] = session
            session.touch()
        self._wake.set()
        return new_id, seed

    def _new_id(self) -> str:
        import uuid

        return uuid.uuid4().hex

    def _enqueue(self, session: Session):
        session.status = QUEUED
        if session not in self._waiting:
            self._waiting.append(session)

    def suspend(self, session: Session, preserve_audio: bool = False):
        # keep the model state, stop generating
        with self._lock:
            if not self._running or self._stopping.is_set():
                session.sink = None
                session.epoch_sink = None
                session.on_status = None
                return
            if self._sessions.get(session.id) is not session:
                session.sink = None
                session.epoch_sink = None
                session.on_status = None
                return
            self._suspend_locked(session, preserve_audio)
        self._broadcast_status()

    def detach(self, session: Session, *, sink=None, epoch_sink=None, on_status=None):
        """Detach one socket without clearing callbacks installed by a newer one.

        A reconnect can overlap the closing handler of its predecessor.  Match
        callback identities before clearing them so the older handler cannot
        accidentally unplug the newly attached receiver.
        """
        expected = tuple(
            (name, callback)
            for name, callback in (
                ("sink", sink),
                ("epoch_sink", epoch_sink),
                ("on_status", on_status),
            )
            if callback is not None
        )
        if not expected:
            return False

        with self._lock:
            # If even one callback has changed, a newer socket owns the
            # session. The old closing handler must not reset or suspend it.
            if any(getattr(session, name) is not callback for name, callback in expected):
                return False
            for name, _callback in expected:
                setattr(session, name, None)
            if (
                not self._running
                or self._stopping.is_set()
                or self._sessions.get(session.id) is not session
            ):
                return True
            self._suspend_locked(session, preserve_audio=False)
        self._broadcast_status()
        return True

    def _suspend_locked(self, session: Session, preserve_audio: bool):
        """Apply a suspension while the manager lock is held."""
        session.touch()
        if not preserve_audio:
            # Once the receiver is gone we cannot prove which queued PCM it
            # heard. Restart score and recurrent state together on resume.
            session.request_transport_reset()
            # The lightweight session identity may remain resumable, but the
            # old MLX state has no continuity value after that reset. Release
            # it promptly on the owning worker instead of retaining up to
            # MAX_TOTAL recurrent graphs for the full TTL.
            if session.state is not None and session not in self._release_queue:
                self._release_queue.append(session)
                self._wake.set()
        if session.status == ACTIVE:
            session.stop_clock(preserve_audio=preserve_audio)
            self._active = [s for s in self._active if s is not session]
        elif session in self._waiting:
            self._waiting.remove(session)
        elif session.status == SUSPENDED and not preserve_audio:
            # A socket may disconnect after an explicit pause. Its worklet
            # reservoir is now gone, so do not preserve the earlier lead.
            session.stop_clock(preserve_audio=False)
        session.status = SUSPENDED
        self._promote()

    def resume(self, session: Session):
        with self._lock:
            if not self._running or self._stopping.is_set():
                return
            if self._sessions.get(session.id) is not session:
                return
            session.touch()
            if session.status == SUSPENDED:
                self._enqueue(session)
            self._promote()
        self._broadcast_status()

    def report_gap(self, session: Session):
        with self._lock:
            if not self._running or self._stopping.is_set():
                return
            if self._sessions.get(session.id) is not session:
                return
            session.note_gap()
            self._pending_gap = True
        self._wake.set()

    def report_pressure(self):
        with self._lock:
            if not self._running or self._stopping.is_set():
                return
            self._pending_pressure = True
        self._wake.set()

    def _promote(self):
        # fill free slots from the waiting queue. caller holds the lock.
        if self._stopping.is_set() or not self.engine.ready:
            return False

        changed = False
        capacity = self._active_capacity()
        while self._waiting and len(self._active) < capacity:
            session = self._waiting.popleft()
            session.status = ACTIVE
            session.start_clock()
            self._active.append(session)
            changed = True

        if changed:
            self._wake.set()
        return changed

    def _reconcile_capacity(self) -> bool:
        """Queue excess listeners, or promote waiters, as measured speed moves."""
        capacity = self._active_capacity()
        changed = False
        while len(self._active) > capacity:
            session = self._active.pop()
            # The connected worklet keeps consuming its already-generated
            # reservoir while queued. Do not bank that lead as though playback
            # stopped; rebase pacing on promotion and continue the same model
            # state after whatever silence the listener experienced.
            session.stop_clock(preserve_audio=False)
            session.status = QUEUED
            if session not in self._waiting:
                self._waiting.appendleft(session)
            changed = True
        if len(self._active) < capacity:
            changed = self._promote() or changed
        return changed

    def _evict_stale(self):
        # drop suspended sessions past their ttl, then the oldest if still over
        # the retention ceiling. caller holds the lock.
        now = time.monotonic()
        for session in list(self._sessions.values()):
            if (
                session.status == SUSPENDED
                and session.sink is None
                and session.epoch_sink is None
                and now - session.last_seen > SESSION_TTL
            ):
                self._forget(session)

    def _make_room_for_session(self):
        """Prefer detached suspended sessions, never connected paused ones."""
        suspended = sorted(
            (
                s
                for s in self._sessions.values()
                if s.status == SUSPENDED
                and s.sink is None
                and s.epoch_sink is None
            ),
            key=lambda s: s.last_seen,
        )
        while len(self._sessions) >= MAX_TOTAL and suspended:
            self._forget(suspended.pop(0))

    def _forget(self, session: Session):
        # caller holds the lock
        self._sessions.pop(session.id, None)
        self._active = [value for value in self._active if value is not session]
        if session in self._waiting:
            self._waiting.remove(session)
        session.request_transport_reset()
        session.sink = None
        session.epoch_sink = None
        session.on_status = None
        if session not in self._release_queue:
            self._release_queue.append(session)
        self._wake.set()
        log.info("reaped session %s", session.id[:8])

    def _active_capacity(self) -> int:
        """Bound configured concurrency by measured aggregate throughput."""
        confident = getattr(self.engine, "throughput_ready", None)
        if confident is not None and not confident():
            return max(1, min(MAX_ACTIVE, len(self._active)))
        factor = self._raw_realtime_factor()
        if factor <= 0.0:
            # Real engines seed this during calibration. After a quality
            # change the sample window is deliberately cleared; preserve the
            # current allocation but admit no additional streams until fresh
            # evidence arrives.
            return max(1, min(MAX_ACTIVE, len(self._active)))
        target = max(1.0, float(getattr(self.engine, "target_rtf", 1.18)))
        sustainable = max(1, int(factor / target))
        return min(MAX_ACTIVE, sustainable)

    def _per_session_realtime_factor(self) -> float:
        return self._raw_realtime_factor() / max(1, len(self._active))

    def _raw_realtime_factor(self) -> float:
        meter = getattr(self.engine, "realtime_factor", None)
        if meter is None:
            return 0.0
        try:
            return max(0.0, float(meter()))
        except (TypeError, ValueError):
            return 0.0

    # --- status ---

    def status_for(self, session: Session) -> dict:
        with self._lock:
            payload = {
                "type": "status",
                "state": session.status,
                "listeners": len(self._active),
                "capacity": self._active_capacity(),
                # how much faster than real time this machine is rendering. the
                # client sizes its reservoir from it: there is no reason to make
                # someone wait through a deep prebuffer on a box with headroom.
                "realtimeFactor": round(self._per_session_realtime_factor(), 3),
                # Codec depth below its maximum means the tuner is already
                # spending detail to stay real time; the page lightens its
                # own rendering on that signal (frontend/lib/render-budget).
                "codebooks": self.engine.codebooks,
                # A pinned depth is this machine's ceiling, not a deficit.
                "maxCodebooks": getattr(self.engine, "pinned_codebooks", 0)
                or self.engine.max_codebooks,
            }
            if not self.engine.ready:
                payload["state"] = "loading"
                payload["error"] = self.engine.load_error
            elif session.status == QUEUED:
                try:
                    payload["position"] = list(self._waiting).index(session) + 1
                except ValueError:
                    payload["position"] = 0
            return payload

    def _broadcast_status(self):
        # tell every attached client where it stands
        if self._stopping.is_set():
            return
        self._last_status_at = time.monotonic()
        with self._lock:
            sessions = list(self._sessions.values())
        for session in sessions:
            notify = session.on_status
            if notify is not None:
                notify(self.status_for(session))

    def _broadcast_terminal_error(self, message: str):
        """Tell attached sockets that this worker cannot recover in-process."""
        with self._lock:
            sessions = list(self._sessions.values())
        for session in sessions:
            notify = session.on_status
            if notify is not None:
                notify({"type": "error", "message": message, "terminal": True})

    def stats(self) -> dict:
        with self._lock:
            return {
                "ready": self.engine.ready,
                "error": self.engine.load_error,
                "model": self.engine.size,
                "backend": self.engine.backend,
                "bits": self.engine.bits,
                "temperature": self.engine.temperature,
                "topK": self.engine.top_k,
                "cfgMusicCoCa": self.engine.cfg_musiccoca,
                "cfgNotes": self.engine.cfg_notes,
                "cfgDrums": self.engine.cfg_drums,
                "styleTokenLevels": self.engine.style_token_levels,
                "melodyGuided": False,
                "mlxCacheLimitMB": self.engine.mlx_cache_mb,
                "mlxWiredLimitMB": getattr(self.engine, "wired_limit_mb", 0),
                "takeGuard": TAKE_GUARD,
                "hissFilter": HISS_FILTER,
                "takeReprime": TAKE_REPRIME
                and bool(getattr(self.engine, "supports_priming", False)),
                "pipelined": self.engine._fast,
                "workerQoS": self._worker_qos,
                "fastSampler": self.engine._fast_sampling,
                "fastEngine": (
                    self.engine._fast_engine.summary()
                    if getattr(self.engine, "_fast_engine", None) is not None
                    else None
                ),
                "renderer": (
                    self.engine._renderer.status.summary()
                    if getattr(self.engine, "_renderer", None) is not None
                    else None
                ),
                "styleTokenizer": (
                    "native"
                    if getattr(self.engine, "_tokenizer", None) is not None
                    else "tflite"
                ),
                "releasedStyleInterpreters": list(
                    getattr(self.engine, "_released_interpreters", ())
                ),
                "codebooks": self.engine.codebooks,
                "minCodebooks": self.engine.min_codebooks,
                "maxCodebooks": self.engine.max_codebooks,
                "targetRealtimeFactor": self.engine.target_rtf,
                "renderRealtimeFactor": round(self._raw_realtime_factor(), 3),
                "perSessionRealtimeFactor": round(
                    self._per_session_realtime_factor(), 3
                ),
                "realtimeCapable": self._per_session_realtime_factor() >= 1.0,
                "audioStyleReferences": sorted(styles.reference_map()),
                "active": len(self._active),
                "waiting": len(self._waiting),
                "retained": len(self._sessions),
                "capacity": self._active_capacity(),
                "chunkSeconds": CHUNK_SECONDS,
                "lookaheadSeconds": LOOKAHEAD_SECONDS,
                "sessions": [s.snapshot() for s in self._sessions.values()],
            }

    # --- the worker ---

    def _run(self):
        try:
            self._worker_qos = configure_worker_priority()
            if not self._load():
                return

            log.info(
                "worker up: %d frames/chunk (%.0fms), %.1fs lookahead, %d slots, "
                "%d/%d codebooks",
                CHUNK_FRAMES,
                CHUNK_SECONDS * 1000,
                LOOKAHEAD_SECONDS,
                MAX_ACTIVE,
                self.engine.codebooks,
                self.engine.max_codebooks,
            )

            while not self._stopping.is_set():
                self._release_retired()
                self._apply_feedback()
                session = self._next_due()
                if session is None:
                    # Nobody needs audio yet: spend the slack on any standby
                    # state being primed, one short slice at a time so the
                    # next due chunk is never held up for long.
                    if self._advance_primers():
                        continue
                    self._maybe_reap()
                    # sleep until the earliest session actually wants audio rather
                    # than waking a hundred times a second to find out it does not
                    self._wake.wait(self._idle_wait())
                    self._wake.clear()
                    # Magenta's native runner keeps Metal awake between bursts.
                    # Without this, macOS downclocks the M1 GPU and the next
                    # frame can lose the small margin that makes it real time.
                    with self._lock:
                        active = bool(self._active)
                    keep_warm = getattr(self.engine, "keep_gpu_warm", None)
                    if active and keep_warm is not None:
                        keep_warm()
                    elif not active:
                        note_idle = getattr(self.engine, "note_idle", None)
                        if note_idle is not None:
                            note_idle()
                    continue

                maximum_frames = self._chunk_frames(session)
                started = time.monotonic()
                refreshed_seed = None
                try:
                    render_epoch = session.prepare_render()
                    frames = maximum_frames
                    plan = session.conditioning_plan(self.engine, frames)
                    pcm, next_state = self.engine.generate(
                        session.state, plan, seed=session.seed
                    )
                    if TAKE_GUARD:
                        pcm, next_state, refreshed_seed = self._guard_take(
                            session, plan, pcm, next_state
                        )
                    if HISS_FILTER:
                        pcm = session.filter_pcm(pcm)
                except Exception as exc:  # noqa: BLE001 - isolate bad sessions
                    if self._stopping.is_set():
                        break
                    log.exception("generation failed for session %s", session.id[:8])
                    notify = session.on_status
                    if notify is not None:
                        notify({"type": "error", "message": str(exc)})
                    self.suspend(session)
                    continue

                # Shutdown may have arrived while native inference was in
                # flight. Drop both its state transition and PCM in that case.
                if self._stopping.is_set():
                    break
                capacity_changed = False
                with self._lock:
                    # A New variation request may have landed while native
                    # inference was running. Its epoch invalidates both the old
                    # state transition and PCM, preventing a post-reset splice.
                    if not session.render_is_current(render_epoch):
                        continue
                    session.state = next_state
                    if refreshed_seed is not None:
                        session.seed = refreshed_seed
                    self.engine.note_render(
                        frames,
                        time.monotonic() - started,
                        active_streams=max(1, len(self._active)),
                    )
                    session.note_generated(frames * engine_mod.FRAME_SECONDS)
                    capacity_changed = self._reconcile_capacity()
                    epoch_sink = (
                        None if self._stopping.is_set() else session.epoch_sink
                    )
                    sink = None if self._stopping.is_set() else session.sink
                    if RECORD_DIR:
                        self._record(session, render_epoch, pcm)
                    if epoch_sink is not None:
                        # Carry the render generation through the event-loop
                        # handoff. A variation can be acknowledged after this
                        # callback is scheduled but before it actually queues
                        # PCM; the receiver performs the final epoch check.
                        epoch_sink(pcm, render_epoch)
                    elif sink is not None:
                        # Compatibility for direct/internal consumers that use
                        # the historical one-argument callback.
                        sink(pcm)

                if (
                    self.engine.codebooks != self._last_quality
                    or capacity_changed
                    or time.monotonic() - self._last_status_at >= STATUS_INTERVAL_SECONDS
                ):
                    # Throughput can change at the quality floor too. Send
                    # fresh measurements so the client's reservoir can adapt.
                    self._last_quality = self.engine.codebooks
                    self._broadcast_status()
        finally:
            self._release_worker_resources()

    def _release_worker_resources(self):
        # Session states contain MLX arrays, so release them on the same thread
        # that owns the model before clearing the model itself.
        with self._lock:
            sessions = list(self._sessions.values()) + list(self._release_queue)
            self._release_queue.clear()
            self._clear_session_registry_locked()
            self._running = False
        for session in dict.fromkeys(sessions):
            session.release_state()
            session.sink = None
            session.epoch_sink = None
            session.on_status = None

        close = getattr(self.engine, "close", None)
        if close is not None:
            try:
                close()
            except Exception:  # noqa: BLE001 - cleanup must continue
                log.exception("failed to release inference engine resources")
        # The model's object graph has reference cycles; frozen, a restart in
        # this process would keep the old model alive beside the new one.
        gc.unfreeze()

    def _clear_session_registry_locked(self):
        # Caller holds _lock. Return values are not needed: all retained MLX
        # state is nulled by the worker before engine.close(), or by stop after
        # no worker exists.
        for session in self._sessions.values():
            session.state = None
            session.sink = None
            session.epoch_sink = None
            session.on_status = None
        self._sessions.clear()
        self._active.clear()
        self._waiting.clear()
        self._release_queue.clear()
        self._pending_gap = False
        self._pending_pressure = False
        self._cursor = 0

    def _apply_feedback(self):
        # Called only on the worker, preserving MLX's thread affinity.
        with self._lock:
            gap = self._pending_gap
            pressure = self._pending_pressure
            self._pending_gap = False
            self._pending_pressure = False
        if gap:
            self.engine.note_gap()
        elif pressure:
            # A gap already applies the stronger signal; do not spend two
            # codebooks when both reports race into the same loop iteration.
            self.engine.note_pressure()

    def _guard_take(self, session: Session, plan, pcm: bytes, next_state):
        """Watch one rendered chunk for a rising floor and repair the take.

        Returns the PCM to deliver (crossfaded at a splice), the state to
        continue from, and the take's new seed when it moved to another
        state. Called only on the worker, right after ``generate``.
        """
        engine = self.engine
        monitor = session.floor_monitor
        monitor.observe(pcm)
        session.note_chunk(getattr(engine, "last_tokens", None), plan)

        primer = session.primer
        if primer is not None and primer.done and not (monitor.drifted or monitor.rising):
            # The floor settled by itself while the standby was prepared (a
            # bright passage, not a bed): keep playing rather than jump back.
            log.info("session %s floor settled; dropping the standby", session.id[:8])
            session.abandon_primer()
            primer = None
        if primer is not None and primer.done:
            seed = session.primer_seed
            try:
                primed_state = engine.finish_prime(primer)
                fresh_pcm, fresh_state = engine.generate(primed_state, plan, seed=seed)
            except Exception:  # noqa: BLE001 - fall back to the plain guard
                if self._stopping.is_set():
                    raise
                log.exception("re-prime failed for session %s", session.id[:8])
                session.abandon_primer()
            else:
                log.info(
                    "session %s re-primed from its clean memory (%s); crossfading",
                    session.id[:8],
                    monitor.describe(),
                )
                session.note_reprime(seed)
                # Same take, so the baseline still applies; the trailing
                # window must not judge the new state by the old one's hiss.
                monitor.restart_trailing()
                session.restart_recent_tokens()
                session.note_chunk(getattr(engine, "last_tokens", None), plan)
                return crossfade_pcm(pcm, fresh_pcm), fresh_state, seed

        reason = None
        if session.consume_refresh_request():
            # A station change landed while the floor had begun to rise; the
            # boundary is already audible, and the old station's memory
            # cannot continue the new one, so a fresh state costs nothing.
            reason = "station changed while the floor was rising"
        elif monitor.drifted or monitor.rising:
            if self._start_reprime(session, plan):
                return pcm, next_state, None
            if monitor.drifted:
                # The take has audibly grown a hiss bed out of its own
                # feedback and there is no clean memory to return to.
                reason = f"take drifted ({monitor.describe()})"
        if reason is None:
            return pcm, next_state, None

        # Splice onto a fresh recurrent state under the same conditioning:
        # one extra chunk of render cost, no transport or session change.
        refreshed_seed = session.next_refresh_seed()
        fresh_pcm, fresh_state = engine.generate(None, plan, seed=refreshed_seed)
        log.info(
            "session %s %s; crossfading onto a fresh state",
            session.id[:8],
            reason,
        )
        monitor.reset()
        session.forget_anchor()
        session.note_chunk(getattr(engine, "last_tokens", None), plan)
        return crossfade_pcm(pcm, fresh_pcm), fresh_state, refreshed_seed

    def _start_reprime(self, session: Session, plan) -> bool:
        """Start (or keep) priming a standby state; False if none is possible."""
        engine = self.engine
        if not TAKE_REPRIME or not getattr(engine, "supports_priming", False):
            return False
        if session.primer is not None:
            # Measured in audio rendered, so time spent paused or queued does
            # not count against it.
            waited = session.generated_seconds - session.primer_started_audio
            if waited <= PRIME_TIMEOUT_SECONDS:
                return True
            # The worker never had slack to finish it: the machine is at its
            # limit, and the plain guard is the only affordable repair.
            log.warning("priming for session %s timed out", session.id[:8])
            session.abandon_primer()
            return False
        if not session.reprime_allowed():
            return False
        run = session.anchor_run(plan)
        if run is None:
            return False
        seed = session.next_reprime_seed()
        try:
            session.primer = engine.begin_prime(session.anchor, run, seed)
        except Exception:  # noqa: BLE001 - the plain guard still applies
            if self._stopping.is_set():
                raise
            log.exception("could not start priming for session %s", session.id[:8])
            return False
        session.primer_seed = seed
        session.primer_started = time.monotonic()
        session.primer_started_audio = session.generated_seconds
        log.info(
            "session %s floor rising (%s); priming a standby from clean memory",
            session.id[:8],
            session.floor_monitor.describe(),
        )
        return True

    def _advance_primers(self) -> bool:
        """Advance unfinished standbys within the idle time; True if any worked.

        Each slice is sized to finish before the next stream is due, from the
        measured cost of a primed frame, so priming never makes a chunk late:
        on a machine with no slack it simply does not progress, and the
        guard's timeout hands the repair to the fresh-state splice.
        """
        if not TAKE_REPRIME:
            return False
        now = time.monotonic()
        with self._lock:
            pending = [
                s for s in self._active if s.primer is not None and not s.primer.done
            ]
            slack = min(
                (s.due_in(now, LOOKAHEAD_SECONDS) for s in self._active),
                default=float("inf"),
            )
        if not pending:
            return False
        budget = (slack - PRIME_SLACK_MARGIN_SECONDS) / len(pending)
        frames = min(PRIME_SLICE_FRAMES, int(budget / self._prime_frame_cost))
        if frames < 1:
            return False
        for session in pending:
            primer = session.primer
            before = getattr(primer, "position", None)
            started = time.monotonic()
            try:
                self.engine.advance_prime(primer, frames)
            except Exception:  # noqa: BLE001 - drop the standby, keep streaming
                if self._stopping.is_set():
                    return False
                log.exception("priming failed for session %s", session.id[:8])
                session.abandon_primer()
                continue
            advanced = (
                primer.position - before if before is not None else frames
            )
            if advanced > 0:
                per_frame = (time.monotonic() - started) / advanced
                # A slow estimate only shortens slices; a fast one overruns.
                self._prime_frame_cost = max(
                    0.5 * self._prime_frame_cost + 0.5 * per_frame, per_frame
                )
        return True

    def _record(self, session: Session, epoch: int, pcm: bytes):
        """Append a delivered chunk to this take's diagnostic WAV file."""
        import wave

        key = (session.id, epoch)
        recorder = getattr(session, "_recorder", None)
        if recorder is None or recorder[0] != key:
            if recorder is not None:
                recorder[1].close()
            os.makedirs(RECORD_DIR, exist_ok=True)
            path = os.path.join(
                RECORD_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}-{session.id[:8]}-{epoch}.wav"
            )
            handle = wave.open(path, "wb")
            handle.setnchannels(engine_mod.CHANNELS)
            handle.setsampwidth(2)
            handle.setframerate(engine_mod.SAMPLE_RATE)
            session._recorder = (key, handle)
            log.info("recording session %s to %s", session.id[:8], path)
        # writeframes rewrites the header each call, so the file stays valid
        # even if the process is stopped abruptly.
        session._recorder[1].writeframes(pcm)

    def _release_retired(self):
        """Drop reaped MLX state on the only thread allowed to own it."""
        with self._lock:
            retired = list(self._release_queue)
            self._release_queue.clear()
        for session in retired:
            session.release_state()

    def _chunk_frames(self, session: Session) -> int:
        # The reservoir is empty at the top of a take. Send one short burst,
        # then settle immediately into the efficient steady batch.
        if session.chunks_rendered == 0:
            return min(CHUNK_FRAMES, FIRST_CHUNK_FRAMES)
        return CHUNK_FRAMES

    def _next_due(self) -> Session | None:
        # round robin so no session starves when the model is at capacity
        now = time.monotonic()
        with self._lock:
            count = len(self._active)
            for offset in range(count):
                index = (self._cursor + offset) % count
                candidate = self._active[index]
                if candidate.needs_audio(now, LOOKAHEAD_SECONDS):
                    self._cursor = (index + 1) % count
                    return candidate
        return None

    def _idle_wait(self) -> float:
        now = time.monotonic()
        with self._lock:
            if not self._active:
                return IDLE_WAIT
            soonest = min(s.due_in(now, LOOKAHEAD_SECONDS) for s in self._active)
        return max(0.002, min(GPU_KEEPALIVE_SECONDS, soonest))

    def _maybe_reap(self):
        now = time.monotonic()
        if now - self._last_reap < 10.0:
            return
        self._last_reap = now
        with self._lock:
            self._evict_stale()
