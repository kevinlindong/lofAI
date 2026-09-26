"""The stationary-hiss filter removes a bed and keeps the music."""

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import styles  # noqa: E402
from hiss_filter import HOP, HissFilter  # noqa: E402
from session import Session  # noqa: E402

RATE = 48_000


def _pcm(stereo: np.ndarray) -> bytes:
    return np.clip(np.round(stereo * 32767.0), -32768, 32767).astype("<i2").tobytes()


def _float(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").reshape(-1, 2).astype(np.float64) / 32768.0


def _stream(filter_, signal: np.ndarray, chunk=19_200) -> np.ndarray:
    out = [filter_.process(_pcm(signal[i : i + chunk])) for i in range(0, len(signal), chunk)]
    y = _float(b"".join(out))
    # Output lags input by one hop; line the two up.
    return y[HOP:], signal[: len(y) - HOP]


def _band_power(x: np.ndarray, low: float, high: float) -> float:
    spectrum = np.abs(np.fft.rfft(x.mean(axis=1) * np.hanning(len(x)))) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / RATE)
    return float(spectrum[(freqs >= low) & (freqs < high)].sum())


def _db(ratio: float) -> float:
    return 10.0 * np.log10(ratio + 1e-30)


def _hiss(rng, seconds: float, dbfs: float) -> np.ndarray:
    noise = rng.normal(0.0, 10 ** (dbfs / 20), (int(seconds * RATE), 2))
    # keep it in the band the filter works on, like the measured beds
    spectrum = np.fft.rfft(noise, axis=0)
    freqs = np.fft.rfftfreq(len(noise), 1.0 / RATE)
    spectrum[freqs < 4_000] = 0
    return np.fft.irfft(spectrum, n=len(noise), axis=0)


class HissFilterTests(unittest.TestCase):
    def test_a_stationary_bed_is_removed(self):
        rng = np.random.default_rng(1)
        bed = _hiss(rng, 12.0, -50.0)
        y, x = _stream(HissFilter(), bed)
        tail = slice(6 * RATE, 11 * RATE)  # after the three-second estimate settles
        reduction = _db(_band_power(y[tail], 4_000, 20_000) / _band_power(x[tail], 4_000, 20_000))
        self.assertLess(reduction, -15.0)

    def test_transients_above_the_bed_are_kept(self):
        rng = np.random.default_rng(2)
        seconds = 12.0
        bed = _hiss(rng, seconds, -60.0)
        hats = np.zeros_like(bed)
        for start in range(0, int(seconds * RATE), RATE // 4):  # a hat every 250 ms
            burst = _hiss(rng, 0.03, -24.0)
            hats[start : start + len(burst)] += burst[: len(hats) - start]
        y, x = _stream(HissFilter(), bed + hats)
        tail = slice(6 * RATE, 11 * RATE)
        kept = _db(_band_power(y[tail], 4_000, 20_000) / _band_power(x[tail], 4_000, 20_000))
        self.assertGreater(kept, -1.5, "hat energy must survive")

    def test_notes_that_come_and_go_are_kept(self):
        t = np.arange(int(12 * RATE)) / RATE
        # a 6 kHz partial sounding for 0.8 s of every 2 s, decaying
        gate = ((t % 2.0) < 0.8) * np.exp(-3.0 * (t % 2.0))
        note = 0.05 * np.sin(2 * np.pi * 6_000 * t) * gate
        signal = np.stack([note, note], axis=1)
        y, x = _stream(HissFilter(), signal)
        tail = slice(6 * RATE, 11 * RATE)
        kept = _db(_band_power(y[tail], 5_500, 6_500) / _band_power(x[tail], 5_500, 6_500))
        self.assertGreater(kept, -1.5)

    def test_an_intermittent_whistle_is_cut(self):
        rng = np.random.default_rng(6)
        t = np.arange(int(12 * RATE)) / RATE
        # rings for 0.7 s of every second - too often for a note, too
        # irregularly present for the percentile floor alone
        gate = (t % 1.0) < 0.7
        whistle = 0.02 * np.sin(2 * np.pi * 5_250 * t) * gate
        signal = np.stack([whistle, whistle], axis=1) + _hiss(rng, 12.0, -70.0)
        y, x = _stream(HissFilter(), signal)
        tail = slice(6 * RATE, 11 * RATE)
        cut = _db(_band_power(y[tail], 5_200, 5_300) / _band_power(x[tail], 5_200, 5_300))
        self.assertLess(cut, -20.0)

    def test_a_hat_keeps_its_energy_while_a_ringing_comb_on_it_is_cut(self):
        rng = np.random.default_rng(7)
        seconds = 10.0
        n = int(seconds * RATE)
        t = np.arange(n) / RATE
        hats = np.zeros((n, 2))
        comb = np.zeros(n)
        for start in range(0, n, RATE // 2):  # a hat every 500 ms
            burst = _hiss(rng, 0.05, -30.0)
            hats[start : start + len(burst)] += burst[: n - start]
            ring = np.zeros(n)
            ring[start : start + len(burst)] = 1.0
            for tone in (15_300, 16_500, 17_200):
                comb += 0.03 * np.sin(2 * np.pi * tone * t) * ring
        signal = hats + np.stack([comb, comb], axis=1)
        y, x = _stream(HissFilter(), signal)
        tail = slice(5 * RATE, 9 * RATE)
        ringing = _db(_band_power(y[tail], 16_450, 16_550) / _band_power(x[tail], 16_450, 16_550))
        self.assertLess(ringing, -6.0)
        # the flat part of the hat, away from the comb, is kept
        body = _db(_band_power(y[tail], 13_000, 15_000) / _band_power(x[tail], 13_000, 15_000))
        self.assertGreater(body, -2.0)

    def test_the_body_of_the_music_is_untouched(self):
        rng = np.random.default_rng(3)
        t = np.arange(int(8 * RATE)) / RATE
        low = 0.2 * np.sin(2 * np.pi * 220 * t) + 0.1 * np.sin(2 * np.pi * 880 * t)
        signal = np.stack([low, low], axis=1) + rng.normal(0, 1e-3, (len(t), 2))
        y, x = _stream(HissFilter(), signal)
        tail = slice(4 * RATE, 7 * RATE)
        error = np.sqrt(np.mean((y[tail] - x[tail]) ** 2)) / np.sqrt(np.mean(x[tail] ** 2))
        self.assertLess(error, 0.01)

    def test_chunking_does_not_change_the_result(self):
        rng = np.random.default_rng(4)
        signal = _hiss(rng, 6.0, -40.0) + 0.1 * np.sin(
            2 * np.pi * 330 * np.arange(6 * RATE) / RATE
        )[:, None]
        a, _ = _stream(HissFilter(), signal, chunk=19_200)
        b, _ = _stream(HissFilter(), signal, chunk=7_777)
        n = min(len(a), len(b))
        self.assertLessEqual(np.abs(a[:n] - b[:n]).max() * 32768, 1.0)

    def test_output_keeps_pace_with_input(self):
        filter_ = HissFilter()
        total_in = total_out = 0
        for _ in range(50):
            chunk = _pcm(np.zeros((19_200, 2)))
            total_in += len(chunk)
            total_out += len(filter_.process(chunk))
        self.assertLessEqual(total_in - total_out, 2 * HOP * 4)
        self.assertEqual(filter_.process(b""), b"")

    def test_reset_starts_a_new_take_clean(self):
        filter_ = HissFilter()
        loud = _pcm(np.full((19_200, 2), 0.5))
        filter_.process(loud)
        filter_.reset()
        out = _float(filter_.process(_pcm(np.zeros((19_200, 2)))))
        self.assertEqual(float(np.abs(out).max()), 0.0, "no audio from the old take")


class TextureRequestTests(unittest.TestCase):
    def test_requested_textures_are_recognised(self):
        self.assertTrue(styles.requests_noise_texture("lo-fi hip hop, mellow, soft rain"))
        self.assertTrue(styles.requests_noise_texture("jazz guitar, vinyl crackle"))
        self.assertFalse(styles.requests_noise_texture(styles.STATIONS["rainy-piano"].prompt))
        for station in styles.STATIONS.values():
            self.assertFalse(styles.requests_noise_texture(station.prompt), station.slug)

    def test_a_requested_texture_passes_through(self):
        session = Session("texture-test", "neutral", "guitar")
        rng = np.random.default_rng(5)
        chunk = _pcm(_hiss(rng, 0.4, -40.0))
        session._active_prompt = "lo-fi hip hop, soft rain"
        self.assertEqual(session.filter_pcm(chunk), chunk)
        session._active_prompt = styles.STATIONS["dusty-beats"].prompt
        self.assertNotEqual(session.filter_pcm(chunk), chunk)


if __name__ == "__main__":
    unittest.main(verbosity=2)
