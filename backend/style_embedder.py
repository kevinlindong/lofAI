"""Embed unseen style prompts in a separate process.

MusicCoCa runs on the CPU through TFLite. lofAI releases its interpreters once
the station prompts are warm (several hundred megabytes), so the first custom
prompt after that rebuilds the text encoder - and that rebuild holds Python's
GIL for over half a second (580 ms measured on an M3 Pro), which freezes the
model thread no matter which thread asks for it. Doing the work in a
short-lived child process keeps the GIL, and the interpreter memory, out of
the streaming process entirely: the child starts when a new prompt arrives
and exits once it has been idle for a while.
"""

from __future__ import annotations

import logging
import multiprocessing
import threading
from concurrent.futures import Future, ProcessPoolExecutor

import numpy as np

log = logging.getLogger(__name__)

IDLE_SECONDS = 60.0

_MODEL = None


def _load():
    global _MODEL
    from magenta_rt import musiccoca

    _MODEL = musiccoca.MusicCoCa()


def _embed_text(prompt: str) -> np.ndarray:
    # Same call as MagentaRT2System.embed_style(prompt, use_mapper=True).
    result = _MODEL.embed(prompt, True, True, 0)
    return np.asarray(result, dtype=np.float32)


class ProcessEmbedder:
    """One child process at a time, started on demand, stopped when idle."""

    def __init__(self, idle_seconds: float = IDLE_SECONDS):
        self._idle_seconds = idle_seconds
        self._lock = threading.Lock()
        self._executor: ProcessPoolExecutor | None = None
        self._pending = 0
        self._idle_timer: threading.Timer | None = None

    def submit(self, prompt: str) -> Future:
        with self._lock:
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            if self._executor is None:
                self._executor = ProcessPoolExecutor(
                    max_workers=1,
                    mp_context=multiprocessing.get_context("spawn"),
                    initializer=_load,
                )
            self._pending += 1
            future = self._executor.submit(_embed_text, prompt)
        future.add_done_callback(self._finished)
        return future

    def _finished(self, _future):
        with self._lock:
            self._pending -= 1
            if self._pending or self._executor is None:
                return
            self._idle_timer = threading.Timer(self._idle_seconds, self._stop_if_idle)
            self._idle_timer.daemon = True
            self._idle_timer.start()

    def _stop_if_idle(self):
        with self._lock:
            if self._pending or self._executor is None:
                return
            executor, self._executor = self._executor, None
            self._idle_timer = None
        executor.shutdown(wait=False, cancel_futures=True)

    def close(self):
        with self._lock:
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            executor, self._executor = self._executor, None
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)
