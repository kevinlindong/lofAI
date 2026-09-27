# fastapi server for lofai - one magenta realtime 2 stream per listener

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import engine as engine_mod
import session_manager as manager_mod
import styles
from integrations import router as integrations_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("lofai")

# This queue is transport slack, not another playback buffer. A healthy socket
# drains it immediately; four seconds is ample to identify a suspended tab
# without retaining half a minute of stale music.
OUTBOX_LIMIT = max(4, int(4.0 / manager_mod.CHUNK_SECONDS))

manager = manager_mod.SessionManager()

DEFAULT_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
}
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.environ.get(
        "LOFAI_ALLOWED_ORIGINS", ",".join(sorted(DEFAULT_ORIGINS))
    ).split(",")
    if origin.strip()
}

CONTROL_FIELDS = (
    "station",
    "mood",
    "instrument",
    "bpm",
    "groove",
    "intensity",
    "melody",
    "drums",
    "customPrompt",
    "adherence",
    "variation",
)


def _music_controls(message: dict) -> dict:
    return {key: message[key] for key in CONTROL_FIELDS if key in message}


def _origin_allowed(origin: str | None) -> bool:
    return not origin or "*" in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager.start()
    try:
        yield
    finally:
        manager.stop()


app = FastAPI(lifespan=lifespan)
app.include_router(integrations_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _offer(queue: asyncio.Queue, item):
    # Never block the worker thread. Return True if queueing would lose PCM so
    # the socket owner can reconnect instead of concealing a sequence hole.
    # Control messages are small and worth delivering; report if one evicts
    # audio for the same reason.
    if not queue.full():
        queue.put_nowait(item)
        return False

    if isinstance(item, bytes):
        return True

    try:
        removed = queue.get_nowait()
    except asyncio.QueueEmpty:
        removed = None
    queue.put_nowait(item)
    return isinstance(removed, bytes)


async def _drain(websocket: WebSocket, queue: asyncio.Queue):
    # the one writer for this socket - starlette websockets cannot be sent on
    # from two tasks at once, so control messages queue behind audio here
    try:
        while True:
            item = await queue.get()
            if isinstance(item, bytes):
                await websocket.send_bytes(item)
            else:
                await websocket.send_json(item)
    except (WebSocketDisconnect, RuntimeError):
        pass


@app.websocket("/ws/session")
async def session_socket(websocket: WebSocket):
    # one socket per listener: json for control, binary frames for pcm audio
    origin = websocket.headers.get("origin")
    if not _origin_allowed(origin):
        log.warning("rejected websocket origin %s", origin)
        await websocket.close(code=1008, reason="origin not allowed")
        return
    await websocket.accept()
    loop = asyncio.get_running_loop()
    outbox: asyncio.Queue = asyncio.Queue(maxsize=OUTBOX_LIMIT)
    closing_for_overflow = False
    closed = False
    helper_tasks: set[asyncio.Task] = set()
    session_holder = []

    async def close_for_overflow():
        try:
            await websocket.close(code=1013, reason="audio backlog")
        except RuntimeError:
            pass

    async def close_for_terminal_error():
        # Let the single writer flush the JSON error first so the listener sees
        # the useful model failure rather than only a generic close reason.
        await asyncio.sleep(0)
        try:
            await websocket.close(code=1011, reason="model failed to load")
        except RuntimeError:
            pass

    def deliver(item):
        nonlocal closing_for_overflow
        if closed or closing_for_overflow:
            return
        if _offer(outbox, item):
            # Never resume after silently dropping a middle PCM packet: that
            # would splice unrelated samples and click. Reconnect/reset is a
            # clean, recoverable discontinuity for a wedged client.
            closing_for_overflow = True
            task = asyncio.create_task(close_for_overflow())
            helper_tasks.add(task)

    def clear_pcm_from_outbox():
        # A variation acknowledgement is a transport barrier. Old queued PCM
        # must not sit in front of it, and controls must never silently evict a
        # binary packet from the middle of the stream.
        controls = []
        while True:
            try:
                item = outbox.get_nowait()
            except asyncio.QueueEmpty:
                break
            if not isinstance(item, bytes):
                controls.append(item)
        for item in controls:
            outbox.put_nowait(item)

    def deliver_epoch(pcm, epoch):
        loop.call_soon_threadsafe(
            lambda: session_holder
            and session_holder[0].deliver_if_current(epoch, deliver, pcm)
        )

    def deliver_status(payload):
        def apply_status():
            deliver(payload)
            if payload.get("terminal") is True and not closed:
                task = asyncio.create_task(close_for_terminal_error())
                helper_tasks.add(task)

        loop.call_soon_threadsafe(apply_status)

    try:
        hello = await asyncio.wait_for(websocket.receive_json(), timeout=10.0)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        await websocket.close(code=1002)
        return

    if not isinstance(hello, dict):
        await websocket.close(code=1002)
        return

    try:
        session, resumed = manager.attach(
            hello.get("sessionId"),
            hello.get("mood", styles.DEFAULT_MOOD),
            hello.get("instrument", styles.DEFAULT_INSTRUMENT),
            epoch_sink=deliver_epoch,
            on_status=deliver_status,
            station=hello.get("station"),
            controls=_music_controls(hello),
        )
    except RuntimeError:
        failed = bool(getattr(manager.engine, "load_error", None))
        await websocket.close(
            code=1011 if failed else 1013,
            reason="model failed to load" if failed else "backend unavailable",
        )
        return
    session_holder.append(session)
    log.info("%s session %s", "resumed" if resumed else "opened", session.id[:8])

    deliver(
        {
            "type": "hello",
            "sessionId": session.id,
            "resumed": resumed,
            "sampleRate": engine_mod.SAMPLE_RATE,
            "channels": engine_mod.CHANNELS,
            "chunkSeconds": manager_mod.CHUNK_SECONDS,
            **session.control_payload(),
        },
    )
    deliver(manager.status_for(session))

    drain = asyncio.create_task(_drain(websocket, outbox))
    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue

            kind = message.get("type")
            session.touch()

            if kind == "style":
                session.request_style(
                    message.get("mood", session.mood),
                    message.get("instrument", session.instrument),
                    station=message.get("station"),
                )
                deliver({"type": "style", **session.control_payload()})

            elif kind == "controls":
                session.request_controls(_music_controls(message))
                deliver({"type": "controls", **session.control_payload()})

            elif kind == "variation":
                new_id, seed = manager.new_variation(session)
                clear_pcm_from_outbox()
                deliver(
                    {
                        "type": "variation",
                        "sessionId": new_id,
                        "seed": seed,
                        **session.control_payload(),
                    },
                )

            elif kind == "pause":
                manager.suspend(session, preserve_audio=True)

            elif kind == "resume":
                manager.resume(session)

            elif kind == "gap":
                # the client ran its reservoir dry and had to refill. only it
                # can tell us this - the server has no idea what was audible -
                # so it is also the one honest input the quality tuner gets.
                manager.report_gap(session)

            elif kind == "pressure":
                manager.report_pressure()

            elif kind == "ping":
                deliver({"type": "pong"})

    except (WebSocketDisconnect, ValueError, RuntimeError):
        pass
    finally:
        closed = True
        drain.cancel()
        # the state stays warm for MRT_SESSION_TTL so a reconnect or an unpause
        # can reuse its identity. Audio/model transport restarts together since
        # a disconnected browser cannot prove how much queued PCM it heard.
        manager.detach(
            session,
            epoch_sink=deliver_epoch,
            on_status=deliver_status,
        )
        tasks = (drain, *helper_tasks)
        for task in tasks:
            task.cancel()
        # gather retrieves every exception as well as waiting for cancellation;
        # no helper task can outlive its socket or become an unobserved error.
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info("detached session %s", session.id[:8])


@app.get("/health")
async def health_check():
    return {"status": "ok", **manager.stats()}


@app.get("/music/options")
async def music_options():
    """Public station metadata and validated control ranges for clients."""
    return styles.public_options()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("LOFAI_BACKEND_HOST", "127.0.0.1"),
        port=8000,
        ws_per_message_deflate=False,
    )
