"""Session control, seed-reset, and stale-resume regression tests."""

import os
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from session import SUSPENDED, Session  # noqa: E402
import session_manager as manager_mod  # noqa: E402
from session_manager import SessionManager  # noqa: E402


class PlanEngine:
    def embed(self, _prompt, _reference=None):
        return np.zeros(768, dtype=np.float32)

    @staticmethod
    def style_cache_key(prompt, reference=None):
        return f"{prompt}:{reference or ''}"


class ReadyEngine:
    ready = True


class SpeedEngine:
    ready = True
    target_rtf = 1.15

    def __init__(self, factor, confident=True):
        self.factor = factor
        self.confident = confident

    def realtime_factor(self):
        return self.factor

    def throughput_ready(self):
        return self.confident


class SessionControlTests(unittest.TestCase):
    def test_station_and_live_controls_reach_one_prompt_only_plan(self):
        session = Session(
            "controls",
            "neutral",
            "guitar",
            station="rainy-piano",
        )
        session.request_controls(
            {"bpm": 88, "groove": 0.8, "intensity": 0.7, "drums": False}
        )
        plan = session.conditioning_plan(PlanEngine(), 100)

        self.assertEqual(sum(run.frames for run in plan), 100)
        self.assertTrue(all(run.notes is None for run in plan))
        self.assertTrue(all(run.drum == 0 for run in plan))
        self.assertEqual(session.control_payload()["bpm"], 88)
        self.assertEqual(session.control_payload()["groove"], 0.8)

    def test_new_variation_changes_seed_and_invalidates_inflight_render(self):
        session = Session("old", "neutral", "guitar")
        epoch = session.prepare_render()
        old_seed = session.seed

        new_seed = session.request_variation("new")

        self.assertNotEqual(new_seed, old_seed)
        self.assertFalse(session.render_is_current(epoch))
        next_epoch = session.prepare_render()
        self.assertTrue(session.render_is_current(next_epoch))
        self.assertEqual(session.seed, new_seed)

    def test_deferred_old_pcm_is_dropped_after_variation_ack(self):
        session = Session("old-pcm", "neutral", "guitar")
        old_epoch = session.prepare_render()
        queued = []

        # This models a worker callback that has been scheduled onto the event
        # loop but has not run. The variation acknowledgement wins the race.
        session.request_variation("fresh-pcm")
        queued.append("variation-ack")
        delivered = session.deliver_if_current(old_epoch, queued.append, b"old")

        self.assertFalse(delivered)
        self.assertEqual(queued, ["variation-ack"])

    def test_style_change_starts_on_the_next_chunk(self):
        session = Session("prompt-change", "neutral", "guitar")
        engine = PlanEngine()
        session.conditioning_plan(engine, 10)
        session.request_controls({"mood": "lively", "instrument": "brass"})

        plan = session.conditioning_plan(engine, 20)
        self.assertIn("bright upbeat", session._active_prompt)
        self.assertIn("muted trumpet", session._active_prompt)
        self.assertIn("bright upbeat", plan[-1].key)

    def test_an_unembedded_prompt_waits_without_stalling_the_stream(self):
        class SlowEmbedEngine(PlanEngine):
            def __init__(self):
                self.ready_prompts = set()
                self.prefetched = []

            def embedding_ready(self, prompt, _reference=None):
                return prompt in self.ready_prompts

            def prefetch_embedding(self, prompt, _reference=None):
                self.prefetched.append(prompt)

        session = Session("async-embed", "neutral", "guitar", station="dusty-beats")
        engine = SlowEmbedEngine()
        session.conditioning_plan(engine, 10)
        before = session._active_prompt
        session.request_controls({"customPrompt": "rainy tokyo night"})

        # Not embedded yet: the current style keeps playing, and the new
        # prompt goes to the background embedder once.
        session.conditioning_plan(engine, 10)
        session.conditioning_plan(engine, 10)
        self.assertEqual(session._active_prompt, before)
        self.assertTrue(engine.prefetched)
        self.assertTrue(all("rainy tokyo night" in p for p in engine.prefetched))

        engine.ready_prompts.add(engine.prefetched[-1])
        session.conditioning_plan(engine, 10)
        self.assertIn("rainy tokyo night", session._active_prompt)

    def test_drum_mute_applies_on_the_next_chunk(self):
        session = Session("drum-mute", "neutral", "guitar")
        engine = PlanEngine()
        session.conditioning_plan(engine, 10)
        session.request_controls({"bpm": 96, "drums": False})

        plan = session.conditioning_plan(engine, 20)
        self.assertTrue(all(run.drum == 0 for run in plan))
        self.assertEqual(session.control_payload()["bpm"], 96)

    def test_free_text_prompt_reaches_the_style_plan(self):
        session = Session("prompt", "neutral", "guitar", station="dusty-beats")
        engine = PlanEngine()
        session.conditioning_plan(engine, 10)
        session.request_controls({"customPrompt": "rainy tokyo saxophone"})

        plan = session.conditioning_plan(engine, 200)
        self.assertEqual(session.station, "custom")
        self.assertIn("rainy tokyo saxophone", session._active_prompt)
        self.assertTrue(session._active_prompt.startswith("instrumental lo-fi"))
        # The landed style run carries the scaffolded prompt as its cache key.
        self.assertIn("rainy tokyo saxophone", plan[-1].key)

    def test_granular_dials_change_the_run_sampling(self):
        session = Session("dials", "neutral", "guitar", station="dusty-beats")
        engine = PlanEngine()
        baseline = session.conditioning_plan(engine, 10)[0].sampling
        session.request_controls({"adherence": 1.0, "variation": 1.0})
        steered = session.conditioning_plan(engine, 10)[0].sampling

        # More adherence raises MusicCoCa guidance; more variation raises
        # temperature. Both stay within the safe clamps.
        self.assertGreater(steered.cfg_musiccoca, baseline.cfg_musiccoca)
        self.assertGreater(steered.temperature, baseline.temperature)
        self.assertLessEqual(steered.cfg_musiccoca, 6.0)
        self.assertLessEqual(steered.temperature, 1.3)

    def test_returning_to_active_style_cancels_pending_bar_change(self):
        session = Session("cancel-style", "neutral", "guitar")
        engine = PlanEngine()
        session.conditioning_plan(engine, 10)

        session.request_controls({"mood": "lively", "instrument": "brass"})
        session.request_controls({"mood": "neutral", "instrument": "guitar"})

        self.assertIsNone(session._pending_style)
        session.conditioning_plan(engine, 200)
        self.assertIn("warm mellow", session._active_prompt)
        self.assertIn("jazz guitar", session._active_prompt)

    def test_new_variation_starts_directly_on_requested_style(self):
        session = Session(
            "old-style", "neutral", "guitar", station="dusty-beats"
        )
        engine = PlanEngine()
        session.conditioning_plan(engine, 10)
        session.request_controls({"station": "rainy-piano"})

        session.request_variation("new-style")
        session.prepare_render()
        plan = session.conditioning_plan(engine, 1)

        self.assertIsNone(session._pending_style)
        self.assertFalse(session._ramping)
        self.assertIn("intimate felt piano", plan[0].key)
        self.assertEqual(session.station, "rainy-piano")

    def test_missing_stale_id_is_replaced_instead_of_reseeding_it(self):
        manager = SessionManager()
        manager.engine = ReadyEngine()
        manager._running = True
        manager._new_id = lambda: "fresh-id"

        session, resumed = manager.attach("expired-id", "neutral", "guitar")

        self.assertFalse(resumed)
        self.assertEqual(session.id, "fresh-id")
        self.assertNotIn("expired-id", manager._sessions)

    def test_manager_rekeys_live_session_for_a_new_variation(self):
        manager = SessionManager()
        manager.engine = ReadyEngine()
        manager._running = True
        manager._new_id = lambda: "first"
        session, _ = manager.attach(None, "neutral", "guitar")
        manager._new_id = lambda: "second"

        new_id, seed = manager.new_variation(session)

        self.assertEqual(new_id, "second")
        self.assertEqual(seed, session.seed)
        self.assertNotIn("first", manager._sessions)
        self.assertIs(manager._sessions["second"], session)

    def test_detach_clears_only_its_callbacks_and_invalidates_transport(self):
        manager = SessionManager()
        manager.engine = ReadyEngine()
        manager._running = True
        old_audio = lambda _pcm, _epoch: None
        old_status = lambda _payload: None
        session, _ = manager.attach(
            None,
            "neutral",
            "guitar",
            epoch_sink=old_audio,
            on_status=old_status,
        )
        session.state = object()
        epoch = session.prepare_render()

        manager.detach(session, epoch_sink=old_audio, on_status=old_status)

        self.assertIsNone(session.epoch_sink)
        self.assertIsNone(session.on_status)
        self.assertEqual(session.status, SUSPENDED)
        self.assertFalse(session.render_is_current(epoch))
        self.assertIn(session, manager._release_queue)

    def test_old_socket_detach_cannot_suspend_a_new_receiver(self):
        manager = SessionManager()
        manager.engine = ReadyEngine()
        manager._running = True
        old_audio = lambda _pcm, _epoch: None
        old_status = lambda _payload: None
        session, _ = manager.attach(
            None,
            "neutral",
            "guitar",
            epoch_sink=old_audio,
            on_status=old_status,
        )
        new_audio = lambda _pcm, _epoch: None
        new_status = lambda _payload: None
        session.epoch_sink = new_audio
        session.on_status = new_status
        epoch = session.prepare_render()

        detached = manager.detach(
            session, epoch_sink=old_audio, on_status=old_status
        )

        self.assertFalse(detached)
        self.assertIs(session.epoch_sink, new_audio)
        self.assertIs(session.on_status, new_status)
        self.assertTrue(session.render_is_current(epoch))

    def test_connected_paused_session_is_not_evicted_for_admission(self):
        manager = SessionManager()
        manager.engine = ReadyEngine()
        manager._running = True
        connected = Session("connected", "neutral", "guitar")
        connected.status = SUSPENDED
        connected.epoch_sink = lambda _pcm, _epoch: None
        manager._sessions[connected.id] = connected

        with patch.object(manager_mod, "MAX_TOTAL", 1):
            with self.assertRaisesRegex(RuntimeError, "capacity"):
                manager.attach(None, "neutral", "guitar")

        self.assertIs(manager._sessions[connected.id], connected)

    def test_detached_paused_session_makes_room_without_event_thread_release(self):
        manager = SessionManager()
        manager.engine = ReadyEngine()
        manager._running = True
        detached = Session("detached", "neutral", "guitar")
        detached.status = SUSPENDED
        detached.state = object()
        manager._sessions[detached.id] = detached

        with patch.object(manager_mod, "MAX_TOTAL", 1):
            replacement, _ = manager.attach(None, "neutral", "guitar")

        self.assertNotIn(detached.id, manager._sessions)
        self.assertIn(detached, manager._release_queue)
        self.assertIsNotNone(detached.state)
        self.assertIs(manager._sessions[replacement.id], replacement)

    def test_measured_capacity_promotes_and_queues_without_overcommit(self):
        manager = SessionManager()
        manager.engine = SpeedEngine(2.5)
        manager._running = True
        with patch.object(manager_mod, "MAX_ACTIVE", 3):
            first, _ = manager.attach(None, "neutral", "guitar")
            second, _ = manager.attach(None, "neutral", "guitar")
            third, _ = manager.attach(None, "neutral", "guitar")
            self.assertEqual(len(manager._active), 2)
            self.assertEqual(third.status, "queued")

            manager.engine.factor = 3.6
            self.assertTrue(manager._reconcile_capacity())
            self.assertEqual(len(manager._active), 3)

            manager.engine.factor = 1.2
            self.assertTrue(manager._reconcile_capacity())
            self.assertEqual(manager._active, [first])
            self.assertEqual(second.status, "queued")
            self.assertEqual(third.status, "queued")

    def test_unsettled_throughput_never_opens_extra_slots(self):
        manager = SessionManager()
        manager.engine = SpeedEngine(99.0, confident=False)
        manager._running = True
        with patch.object(manager_mod, "MAX_ACTIVE", 3):
            manager.attach(None, "neutral", "guitar")
            second, _ = manager.attach(None, "neutral", "guitar")

        self.assertEqual(len(manager._active), 1)
        self.assertEqual(second.status, "queued")


if __name__ == "__main__":
    unittest.main(verbosity=2)
