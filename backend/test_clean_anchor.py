"""Clean-anchor memory: early drift warning, anchor pool, and the re-prime splice."""

import os
import sys
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import engine as engine_mod  # noqa: E402
import session as session_mod  # noqa: E402
from session import Session  # noqa: E402
from take_health import TakeFloorMonitor, crossfade_pcm  # noqa: E402
from test_take_health import _feed_seconds, _music_second  # noqa: E402


def _take(rng, gap_floor_dbfs: float, seconds: int) -> np.ndarray:
    return np.concatenate(
        [_music_second(rng, gap_floor_dbfs, gap_hiss=True) for _ in range(seconds)]
    )


class EarlyWarningTests(unittest.TestCase):
    def test_rising_fires_on_a_rise_too_small_to_count_as_drift(self):
        rng = np.random.default_rng(21)
        monitor = TakeFloorMonitor()
        _feed_seconds(monitor, _take(rng, -72.0, 60))
        self.assertFalse(monitor.rising)
        # About +10 dB in the high band at -64 dBFS: audible between notes,
        # but below the young-take drift rule's -60 dBFS audibility gate.
        _feed_seconds(monitor, _take(rng, -62.0, 50))
        self.assertTrue(monitor.rising)
        self.assertFalse(monitor.drifted)

    def test_rising_ignores_inaudible_floors(self):
        rng = np.random.default_rng(22)
        monitor = TakeFloorMonitor()
        _feed_seconds(monitor, _take(rng, -92.0, 60))
        _feed_seconds(monitor, _take(rng, -80.0, 50))
        self.assertFalse(monitor.rising)

    def test_stable_take_never_rises(self):
        rng = np.random.default_rng(23)
        monitor = TakeFloorMonitor()
        _feed_seconds(monitor, _take(rng, -70.0, 150))
        self.assertFalse(monitor.rising)

    def test_restart_trailing_keeps_the_baseline_but_forgets_votes(self):
        rng = np.random.default_rng(24)
        monitor = TakeFloorMonitor()
        _feed_seconds(monitor, _take(rng, -72.0, 60))
        _feed_seconds(monitor, _take(rng, -62.0, 50))
        self.assertTrue(monitor.rising)
        monitor.restart_trailing()
        self.assertFalse(monitor.rising)
        self.assertIsNotNone(monitor._baseline_high_floor)
        # Clean audio after the splice is judged against the same baseline.
        _feed_seconds(monitor, _take(rng, -72.0, 45))
        self.assertFalse(monitor.rising)
        self.assertTrue(monitor.recent_is_clean(19.6))

    def test_recent_is_clean_measures_only_the_recent_stretch(self):
        rng = np.random.default_rng(25)
        monitor = TakeFloorMonitor()
        _feed_seconds(monitor, _take(rng, -72.0, 35))
        # No baseline yet: only the absolute ceiling applies.
        self.assertTrue(monitor.recent_is_clean(19.6))
        self.assertFalse(monitor.recent_is_clean(40.0), "not enough audio yet")
        _feed_seconds(monitor, _take(rng, -72.0, 30))
        self.assertTrue(monitor.recent_is_clean(19.6))
        _feed_seconds(monitor, _take(rng, -64.0, 25))
        self.assertFalse(monitor.recent_is_clean(19.6))
        self.assertGreater(monitor.recent_high_floor_db(19.6), -70.0)


class StyleChangeBaselineTests(unittest.TestCase):
    def test_a_busier_style_cannot_raise_the_reference(self):
        rng = np.random.default_rng(31)
        monitor = TakeFloorMonitor()
        _feed_seconds(monitor, _take(rng, -72.0, 60))
        clean = monitor._baseline_high_floor
        monitor.relearn_baseline()
        # the take carries a louder bed into the new style
        _feed_seconds(monitor, _take(rng, -62.0, 60))
        self.assertLessEqual(monitor._baseline_high_floor, clean)
        self.assertFalse(monitor._relearning)
        self.assertTrue(monitor.rising, "judged against the clean reference")

    def test_a_quieter_style_lowers_the_reference(self):
        rng = np.random.default_rng(32)
        monitor = TakeFloorMonitor()
        _feed_seconds(monitor, _take(rng, -62.0, 60))
        louder = monitor._baseline_high_floor
        monitor.relearn_baseline()
        _feed_seconds(monitor, _take(rng, -74.0, 60))
        self.assertLess(monitor._baseline_high_floor, louder * 0.5)


class StubMonitor:
    """Only what Session's anchor bookkeeping reads."""

    def __init__(self):
        self.clean = True
        self.floor_db = -72.0
        self.drifted = False
        self.rising = False
        self.restarts = 0
        self.resets = 0

    def recent_is_clean(self, _seconds):
        return self.clean

    def recent_high_floor_db(self, _seconds):
        return self.floor_db

    def observe(self, _pcm):
        pass

    def describe(self):
        return "stub"

    def restart_trailing(self):
        self.restarts += 1
        self.rising = False
        self.drifted = False

    def reset(self):
        self.resets += 1
        self.rising = False
        self.drifted = False


def _run(key="station", drum=None, frames=10):
    return engine_mod.ConditioningRun(
        style=np.zeros(4, dtype=np.float32), key=key, notes=None, frames=frames, drum=drum
    )


def _tokens(start: int, frames: int = 10) -> np.ndarray:
    # Distinct, recognisable frames: frame i holds i in every level.
    return np.repeat(np.arange(start, start + frames, dtype=np.uint32)[:, None], 12, axis=1)


class AnchorPoolTests(unittest.TestCase):
    def setUp(self):
        self.session = Session("anchor-test", "neutral", "guitar")
        self.monitor = StubMonitor()
        self.session.floor_monitor = self.monitor
        self.frame = 0

    def _chunk(self, key="station", drum=None, frames=10):
        self.session.note_chunk(_tokens(self.frame, frames), [_run(key, drum, frames)])
        self.session.note_generated(frames * engine_mod.FRAME_SECONDS)
        self.frame += frames

    def _fill(self, seconds: float, **kwargs):
        for _ in range(int(round(seconds * 2.5))):
            self._chunk(**kwargs)

    def test_an_anchor_needs_a_full_clean_window(self):
        self._fill(session_mod.ANCHOR_SECONDS - 0.4)
        self.assertIsNone(self.session.anchor)
        self._chunk()
        anchor = self.session.anchor
        self.assertIsNotNone(anchor)
        self.assertEqual(anchor.shape, (session_mod.ANCHOR_FRAMES, 12))
        # exactly the most recent frames, in order
        self.assertEqual(int(anchor[-1, 0]), self.frame - 1)
        self.assertEqual(int(anchor[0, 0]), self.frame - session_mod.ANCHOR_FRAMES)

    def test_a_hissy_window_never_becomes_an_anchor(self):
        self.monitor.clean = False
        self._fill(60.0)
        self.assertIsNone(self.session.anchor)

    def test_station_or_drum_changes_forget_the_memory(self):
        self._fill(25.0)
        self.assertIsNotNone(self.session.anchor)
        self._chunk(drum=0)
        self.assertIsNone(self.session.anchor)
        self._fill(25.0, drum=0)
        self.assertIsNotNone(self.session.anchor)
        self.session.forget_anchor()
        self.assertIsNone(self.session.anchor)

    def test_style_ramps_never_become_memory(self):
        self._fill(15.0)
        self._chunk(key=None)  # a keyless blend mid-ramp
        self._fill(10.0)
        self.assertIsNone(self.session.anchor, "the ramp broke the window")

    def test_the_pool_prefers_the_cleanest_recent_stretch(self):
        floors = [-70.0, -74.0, -73.0, -65.0, -71.0]
        captured = []
        for floor in floors:
            self.monitor.floor_db = floor
            self._fill(session_mod.ANCHOR_INTERVAL_SECONDS + 4.8)
            captured.append(int(self.session._anchors[-1][2][-1, 0]))
        pool = self.session._anchors
        self.assertEqual(len(pool), session_mod.ANCHOR_POOL)
        self.assertNotIn(-65.0, [a[0] for a in pool], "the noisiest is dropped")
        # -74 is cleanest; -73 is within the tie margin and more recent.
        self.assertEqual(int(self.session.anchor[-1, 0]), captured[2])

    def test_anchor_run_requires_the_anchor_conditioning(self):
        self._fill(25.0)
        self.assertIsNotNone(self.session.anchor_run([_run()]))
        self.assertIsNone(self.session.anchor_run([_run(key="other")]))
        self.assertIsNone(self.session.anchor_run([_run(key=None)]))


class FakePrimer:
    def __init__(self, tokens, seed, frames_needed=3):
        self.tokens = tokens
        self.seed = seed
        self.left = frames_needed

    @property
    def done(self):
        return self.left <= 0

    def advance(self, frames):
        self.left -= 1
        return self.done


class PrimingEngine:
    OLD = np.full(4000, 8000, dtype=np.int16).tobytes()
    PRIMED = np.full(4000, -8000, dtype=np.int16).tobytes()
    FRESH = np.full(4000, 1000, dtype=np.int16).tobytes()
    supports_priming = True
    codebooks = 12
    max_codebooks = 12

    def __init__(self):
        self.primers = []
        self.generated = []
        self.last_tokens = None

    def begin_prime(self, tokens, run, seed):
        primer = FakePrimer(tokens, seed)
        self.primers.append(primer)
        return primer

    def advance_prime(self, primer, frames):
        return primer.advance(frames)

    def finish_prime(self, primer):
        assert primer.done
        return ("primed", primer.seed)

    def generate(self, state, plan, seed=None):
        self.generated.append((state, seed))
        self.last_tokens = _tokens(0)
        if isinstance(state, tuple) and state[0] == "primed":
            return self.PRIMED, "after-primed"
        if state is None:
            return self.FRESH, "after-fresh"
        return self.OLD, "after-old"


class RepairTests(unittest.TestCase):
    def setUp(self):
        import session_manager as manager_mod

        self.manager_mod = manager_mod
        self.manager = manager_mod.SessionManager()
        self.engine = PrimingEngine()
        self.manager.engine = self.engine
        self.session = Session("repair-test", "neutral", "guitar")
        self.session.status = session_mod.ACTIVE
        self.monitor = StubMonitor()
        self.session.floor_monitor = self.monitor
        self.manager._active.append(self.session)
        self.plan = [_run()]

    def _give_anchor(self):
        for i in range(60):
            self.session.note_chunk(_tokens(i * 10), self.plan)
            self.session.note_generated(0.4)
        self.assertIsNotNone(self.session.anchor)

    def _guard(self):
        return self.manager._guard_take(self.session, self.plan, self.engine.OLD, "live-state")

    def test_rising_floor_primes_a_standby_and_splices_when_ready(self):
        self._give_anchor()
        self.monitor.rising = True
        pcm, state, seed = self._guard()
        # Priming starts in the background; nothing is spliced yet.
        self.assertEqual((pcm, state, seed), (self.engine.OLD, "live-state", None))
        self.assertEqual(len(self.engine.primers), 1)
        primer = self.engine.primers[0]
        np.testing.assert_array_equal(primer.tokens, self.session.anchor)

        # A second rising chunk keeps the same standby rather than restarting.
        self._guard()
        self.assertEqual(len(self.engine.primers), 1)

        while self.manager._advance_primers():
            pass
        self.assertTrue(primer.done)
        self.assertFalse(self.manager._advance_primers(), "no work left")

        pcm, state, seed = self._guard()
        self.assertEqual(pcm, crossfade_pcm(self.engine.OLD, self.engine.PRIMED))
        self.assertEqual(state, "after-primed")
        self.assertEqual(seed, primer.seed)
        self.assertEqual(self.session.reprimes, 1)
        self.assertEqual(self.session.seed, primer.seed)
        self.assertEqual(self.monitor.restarts, 1)
        self.assertEqual(self.monitor.resets, 0, "the take's baseline is kept")
        self.assertIsNone(self.session.primer)
        self.assertIsNotNone(self.session.anchor, "the memory survives the splice")

    def _reprime_now(self):
        self.monitor.rising = True
        self._guard()
        while self.manager._advance_primers():
            pass
        self.monitor.rising = True
        self._guard()
        self.monitor.rising = False

    def test_a_floor_that_keeps_returning_backs_the_reprimes_off(self):
        self._give_anchor()
        self._reprime_now()
        self.assertEqual(self.session.reprimes, 1)
        self.session.note_generated(50.0)
        self._reprime_now()
        self.assertEqual(self.session.reprimes, 2, "one retry at the base interval")
        # Needed again within two minutes: the next wait doubles to 90 s.
        self.session.note_generated(60.0)
        self.monitor.rising = True
        pcm, state, _seed = self._guard()
        self.assertEqual((pcm, state), (self.engine.OLD, "live-state"))
        self.assertIsNone(self.session.primer)
        # A sustained drift during the back-off takes the fresh-state path.
        self.monitor.drifted = True
        pcm, state, _seed = self._guard()
        self.assertEqual(pcm, crossfade_pcm(self.engine.OLD, self.engine.FRESH))
        self.assertEqual(self.session.refreshes, 1)

    def test_priming_only_uses_idle_time(self):
        self._give_anchor()
        self.monitor.rising = True
        self._guard()
        primer = self.engine.primers[0]
        # The stream wants its next chunk now: no slice may delay it.
        self.session.playhead = time.monotonic()
        self.assertFalse(self.manager._advance_primers())
        self.assertEqual(primer.left, 3)
        self.session.playhead = time.monotonic() + 5.0
        self.assertTrue(self.manager._advance_primers())
        self.assertEqual(primer.left, 2)

    def test_a_floor_that_settles_while_priming_drops_the_standby(self):
        self._give_anchor()
        self.monitor.rising = True
        self._guard()
        while self.manager._advance_primers():
            pass
        self.monitor.rising = False
        pcm, state, seed = self._guard()
        self.assertEqual((pcm, state, seed), (self.engine.OLD, "live-state", None))
        self.assertIsNone(self.session.primer)
        self.assertEqual(self.session.reprimes, 0)

    def test_a_floor_that_never_stays_away_reaches_the_longest_back_off(self):
        self._give_anchor()
        waits = []
        for _ in range(6):
            while not self.session.reprime_allowed():
                self.session.note_generated(1.0)
            waits.append(round(self.session.generated_seconds))
            self._reprime_now()
        gaps = [b - a for a, b in zip(waits, waits[1:])]
        base = session_mod.REPRIME_MIN_INTERVAL_SECONDS
        longest = base * 2 ** session_mod.REPRIME_MAX_BACKOFF
        for gap, doubling in zip(gaps[:3], range(3)):
            self.assertLessEqual(abs(gap - base * 2**doubling), 1, gaps)
        self.assertTrue(all(abs(g - longest) <= 1 for g in gaps[3:]), gaps)

    def test_drift_without_clean_memory_falls_back_to_a_fresh_state(self):
        self.monitor.drifted = True
        pcm, state, seed = self._guard()
        self.assertEqual(pcm, crossfade_pcm(self.engine.OLD, self.engine.FRESH))
        self.assertEqual(state, "after-fresh")
        self.assertEqual(self.session.refreshes, 1)
        self.assertEqual(self.monitor.resets, 1)
        self.assertEqual(self.engine.primers, [])

    def test_drift_waits_for_a_standby_that_is_on_its_way(self):
        self._give_anchor()
        self.monitor.drifted = True
        pcm, state, _seed = self._guard()
        self.assertEqual((pcm, state), (self.engine.OLD, "live-state"))
        self.assertEqual(self.session.refreshes, 0)
        self.assertEqual(len(self.engine.primers), 1)

    def test_a_standby_that_cannot_finish_gives_way_to_a_fresh_state(self):
        self._give_anchor()
        self.monitor.drifted = True
        self._guard()
        # The timeout counts audio rendered, not wall time spent paused.
        self.session.primer_started = time.monotonic() - 3600
        pcm, state, _seed = self._guard()
        self.assertEqual((pcm, state), (self.engine.OLD, "live-state"))
        self.session.note_generated(self.manager_mod.PRIME_TIMEOUT_SECONDS + 1)
        pcm, state, _seed = self._guard()
        self.assertEqual(pcm, crossfade_pcm(self.engine.OLD, self.engine.FRESH))
        self.assertEqual(state, "after-fresh")
        self.assertEqual(self.session.refreshes, 1)
        self.assertIsNone(self.session.anchor, "a fresh take starts new memory")

    def test_an_abandoned_standby_is_not_restarted_on_the_next_chunk(self):
        self._give_anchor()
        self.monitor.rising = True
        self._guard()
        self.session.note_generated(self.manager_mod.PRIME_TIMEOUT_SECONDS + 1)
        self._guard()  # times out while only rising
        self.assertIsNone(self.session.primer)
        self._guard()
        self.assertEqual(len(self.engine.primers), 1, "the attempt holds off a retry")

    def test_a_failing_splice_gives_way_to_a_fresh_state(self):
        self._give_anchor()
        self.monitor.drifted = True
        self._guard()
        while self.manager._advance_primers():
            pass

        def broken(_primer):
            raise RuntimeError("priming broke")

        self.engine.finish_prime = broken
        pcm, _state, _seed = self._guard()
        # The failed attempt backs off, so the drifted take is repaired the
        # plain way on this very chunk instead of priming the same failure.
        self.assertEqual(pcm, crossfade_pcm(self.engine.OLD, self.engine.FRESH))
        self.assertEqual(len(self.engine.primers), 1)
        self.assertEqual(self.session.refreshes, 1)

    def test_a_station_change_on_a_rising_floor_uses_a_fresh_state(self):
        self._give_anchor()
        self.session._refresh_requested = True
        self.monitor.rising = True
        pcm, state, _seed = self._guard()
        self.assertEqual(pcm, crossfade_pcm(self.engine.OLD, self.engine.FRESH))
        self.assertEqual(self.engine.primers, [])

    def test_reprime_can_be_disabled(self):
        self._give_anchor()
        self.monitor.rising = True
        original = self.manager_mod.TAKE_REPRIME
        self.manager_mod.TAKE_REPRIME = False
        try:
            pcm, state, _seed = self._guard()
        finally:
            self.manager_mod.TAKE_REPRIME = original
        self.assertEqual((pcm, state), (self.engine.OLD, "live-state"))
        self.assertEqual(self.engine.primers, [])

    def test_a_new_take_drops_memory_and_standby(self):
        self._give_anchor()
        self.monitor.rising = True
        self._guard()
        self.assertIsNotNone(self.session.primer)
        self.session.request_transport_reset()
        self.session.prepare_render()
        self.assertIsNone(self.session.anchor)
        self.assertIsNone(self.session.primer)


if __name__ == "__main__":
    unittest.main(verbosity=2)
