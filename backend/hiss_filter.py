"""Remove the stationary hiss floor from a stream before the listener hears it.

MRT2 generates its own hiss (see take_health): lo-fi prompts ask MusicCoCa
for recording texture, and the model's feedback amplifies whatever bed it
already has. The take guard keeps the model's *memory* from running away,
but it acts on a rise and returns a take only to the level it began at - a
bed that is audible from the first minute stays audible. This filter removes
the bed itself, from the first second, on every stream.

It is a streaming spectral suppressor restricted to the band hiss lives in
(above ~2-3.5 kHz; the body of the music passes untouched):

- The noise floor of each frequency bin is the 20th percentile of its power
  over the last three seconds, corrected to a mean. Hiss is present in every
  frame; notes, hats, and brushes come and go, so they sit far above that
  percentile and are kept. A component present in more than ~80% of frames
  for three seconds - a steady bed, or a whistle - is treated as floor.
- Gains are Wiener gains from a decision-directed a-priori SNR (Ephraim and
  Malah), which keeps transients sharp and avoids the "musical noise" that
  plain subtraction leaves, with a -20 dB floor so nothing is gated to
  silence.

Measured on 8-minute takes rendered through the live engine, the quietest
blocks' 5-20 kHz level fell 17-20 dB (a clean rainy-piano take from -62..-74
to -81..-94 dBFS; a runaway's -39 dBFS peak to -57), while loud blocks lost
1-4 dB on a busy station. Cost is about 5 ms of NumPy per 400 ms chunk on an
M3 Pro; latency is one 21 ms hop.
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 48_000
CHANNELS = 2

FFT_SIZE = 2048
HOP = FFT_SIZE // 2
# Below LOW_HZ the signal is untouched; the gain fades in up to FULL_HZ.
LOW_HZ = 2_000.0
FULL_HZ = 3_500.0
HISTORY_SECONDS = 3.0
QUANTILE = 0.2
# Noise power is over-estimated by this factor before the Wiener gain, so a
# bed that fluctuates a little is still removed rather than left at half level.
OVERSUBTRACT = 1.5
MIN_GAIN_DB = -20.0
DECISION_DIRECTED = 0.95
# The percentile is recomputed every few frames; the floor moves over seconds.
UPDATE_FRAMES = 8

# Whistles: the model also rings at fixed pitches (5.25, 8.4, 3.3 kHz were
# measured, +25 to +38 dB over the neighbouring bins) re-excited with the
# notes, so they are present too intermittently for the percentile floor.
# A bin whose three-second *median* stands this far above the median of its
# neighbourhood, above WHISTLE_LOW_HZ, is treated as a whistle and gets that
# median as its noise estimate. Broadband music (hats, brushes) never forms
# such a narrow peak; a sustained bright partial held for over half of three
# seconds would, which is why the prominence bar is high.
WHISTLE_LOW_HZ = 4_000.0
WHISTLE_PROMINENCE_DB = 18.0
WHISTLE_NEIGHBOURHOOD_BINS = 12
# A whistle is pure artifact, so it may be cut further than the bed.
WHISTLE_MIN_GAIN_DB = -35.0
# Above this, lo-fi carries only brief hats and cymbal shimmer, while busy
# stations grow a pulsing bed of closely spaced whistles (15-18 kHz measured)
# that hides from the prominence test behind its own neighbours. Here the
# median, not the low percentile, sets the floor: whatever sounds for more
# than half of three seconds is removed, transients above it are kept.
AIR_LOW_HZ = 13_000.0
# The same busy-station bed also rings in *with* each hat: loud for a frame,
# gone the next, so no floor estimate can hold it. Up here no instrument has
# narrow partials - a real hat is flat within a frame - so each frame's bins
# are clipped to within DEWHISTLE_DB of their local spectral envelope. The
# hat's broadband energy stays; the comb of whistles riding on it goes.
DEWHISTLE_LOW_HZ = 12_000.0
DEWHISTLE_DB = 8.0
DEWHISTLE_ENVELOPE_BINS = 16


class HissFilter:
    """Streaming stationary-hiss suppressor over interleaved int16 stereo."""

    def __init__(self):
        self._window = np.sqrt(np.hanning(FFT_SIZE + 1)[:FFT_SIZE]).astype(np.float32)
        freqs = np.fft.rfftfreq(FFT_SIZE, 1.0 / SAMPLE_RATE)
        ramp = np.clip((freqs - LOW_HZ) / (FULL_HZ - LOW_HZ), 0.0, 1.0)
        weight = (0.5 - 0.5 * np.cos(np.pi * ramp)).astype(np.float32)
        self._first_bin = int(np.argmax(weight > 0.0))
        self._weight = weight[self._first_bin :]
        self._whistle_band = freqs[self._first_bin :] >= WHISTLE_LOW_HZ
        self._air_band = freqs[self._first_bin :] >= AIR_LOW_HZ
        self._dewhistle_bin = int(np.argmax(freqs >= DEWHISTLE_LOW_HZ))
        self._dewhistle_ratio = 10.0 ** (DEWHISTLE_DB / 10.0)
        self._median_correction = OVERSUBTRACT / np.log(2.0)
        self._prominence = 10.0 ** (WHISTLE_PROMINENCE_DB / 10.0)
        self._whistle_min_gain = np.float32(10.0 ** (WHISTLE_MIN_GAIN_DB / 20.0))
        self._bins = len(freqs)
        self._history_frames = max(8, int(HISTORY_SECONDS * SAMPLE_RATE / HOP))
        # Mean of an exponentially distributed periodogram from its quantile.
        self._correction = OVERSUBTRACT / -np.log(1.0 - QUANTILE)
        self._min_gain = np.float32(10.0 ** (MIN_GAIN_DB / 20.0))
        self.reset()

    def reset(self):
        """Forget everything: the next audio is a new take."""
        band = self._bins - self._first_bin
        self._tail = np.zeros((FFT_SIZE - HOP, CHANNELS), np.float32)
        self._overlap = np.zeros((FFT_SIZE - HOP, CHANNELS), np.float32)
        self._pending = np.zeros((0, CHANNELS), np.float32)
        self._history = np.zeros((self._history_frames, band), np.float32)
        self._frames = 0
        self._noise: np.ndarray | None = None
        self._floor_gain = np.full(band, self._min_gain, np.float32)
        self._previous: np.ndarray | None = None

    def process(self, pcm: bytes) -> bytes:
        """Filter one chunk. Output is delayed by one hop and returned in whole hops."""
        usable = len(pcm) - len(pcm) % (2 * CHANNELS)
        if usable <= 0:
            return b""
        samples = (
            np.frombuffer(pcm[:usable], dtype="<i2").reshape(-1, CHANNELS).astype(np.float32)
            / 32768.0
        )
        buffered = np.concatenate([self._pending, samples]) if self._pending.size else samples
        frames = len(buffered) // HOP
        if frames == 0:
            self._pending = buffered.copy()
            return b""
        span = np.concatenate([self._tail, buffered[: frames * HOP]])
        index = np.arange(frames)[:, None] * HOP + np.arange(FFT_SIZE)[None, :]
        spectra = np.fft.rfft(span[index] * self._window[None, :, None], axis=1)
        power = (np.abs(spectra) ** 2).mean(axis=2).astype(np.float32)
        gains = self._gains(power) * self._dewhistle(power)
        filtered = np.fft.irfft(spectra * gains[:, :, None], n=FFT_SIZE, axis=1).astype(
            np.float32
        ) * self._window[None, :, None]

        out = np.zeros(((frames + 1) * HOP, CHANNELS), np.float32)
        out[: FFT_SIZE - HOP] += self._overlap
        for frame in range(frames):
            out[frame * HOP : frame * HOP + FFT_SIZE] += filtered[frame]
        self._overlap = out[frames * HOP :].copy()
        self._tail = span[frames * HOP :].copy()
        self._pending = buffered[frames * HOP :].copy()
        result = out[: frames * HOP]
        return (
            np.clip(np.round(result * 32768.0), -32768, 32767).astype("<i2").tobytes()
        )

    def _gains(self, power: np.ndarray) -> np.ndarray:
        gains = np.ones_like(power)
        start = self._first_bin
        warmup = max(8, self._history_frames // 4)
        for frame in range(power.shape[0]):
            band = power[frame, start:]
            smoothed = band.copy()
            # A light blur across neighbouring bins steadies the periodogram.
            smoothed[1:-1] = 0.25 * band[:-2] + 0.5 * band[1:-1] + 0.25 * band[2:]
            self._history[self._frames % self._history_frames] = smoothed
            self._frames += 1
            if self._frames < warmup:
                continue
            if self._noise is None or self._frames % UPDATE_FRAMES == 0:
                self._noise = self._estimate_noise()
            noise = self._noise
            posterior = np.maximum(band / noise - 1.0, 0.0)
            if self._previous is None:
                prior = posterior
            else:
                prior = (
                    DECISION_DIRECTED * self._previous / noise
                    + (1.0 - DECISION_DIRECTED) * posterior
                )
            gain = np.maximum(prior / (1.0 + prior), self._floor_gain)
            self._previous = gain * gain * band
            gains[frame, start:] = 1.0 - self._weight * (1.0 - gain)
        return gains

    def _dewhistle(self, power: np.ndarray) -> np.ndarray:
        """Per-frame gains that flatten narrow peaks above DEWHISTLE_LOW_HZ."""
        gains = np.ones_like(power)
        high = power[:, self._dewhistle_bin :]
        if high.shape[1] <= 2 * DEWHISTLE_ENVELOPE_BINS:
            return gains
        pad = DEWHISTLE_ENVELOPE_BINS
        padded = np.pad(high, ((0, 0), (pad, pad)), mode="edge")
        windows = np.lib.stride_tricks.sliding_window_view(padded, 2 * pad + 1, axis=1)
        envelope = np.median(windows, axis=2) * self._dewhistle_ratio
        gains[:, self._dewhistle_bin :] = np.sqrt(
            np.minimum(1.0, envelope / (high + 1e-20))
        )
        return gains

    def _estimate_noise(self) -> np.ndarray:
        filled = min(self._frames, self._history_frames)
        low, median = np.quantile(self._history[:filled], (QUANTILE, 0.5), axis=0)
        noise = low * self._correction
        # Neighbourhood level of the median spectrum, by a running median over
        # a small window (a whistle is a few bins wide; the window is not).
        pad = WHISTLE_NEIGHBOURHOOD_BINS
        padded = np.pad(median, pad, mode="edge")
        windows = np.lib.stride_tricks.sliding_window_view(padded, 2 * pad + 1)
        neighbourhood = np.median(windows, axis=1)
        noise = np.where(
            self._air_band, np.maximum(noise, median * self._median_correction), noise
        )
        whistle = self._whistle_band & (median > neighbourhood * self._prominence)
        if whistle.any():
            # Take the whistle's shoulders with it.
            whistle = whistle | np.roll(whistle, 1) | np.roll(whistle, -1)
            noise = np.where(whistle, np.maximum(noise, median * self._median_correction), noise)
        self._floor_gain = np.where(whistle, self._whistle_min_gain, self._min_gain).astype(
            np.float32
        )
        return (noise + 1e-20).astype(np.float32)
