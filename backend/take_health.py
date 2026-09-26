"""Detecting and repairing a take whose noise floor drifts upward.

MRT2 continues its own recurrent audio: whatever it just played is the
context for what it plays next. That feedback has a failure attractor - once
a bright sustained texture (tape hiss, cymbal wash) enters the roughly
20-second context window, the model tends to continue and amplify it. It
takes two measured forms:

- On sparse stations, broadband 3-13 kHz hiss grows in the gaps between
  notes. On 10-minute rainy-piano takes rendered with the live
  configuration, the 5-20 kHz level of the quietest 50 ms blocks starts near
  -70 dBFS, typically reaches -60 dBFS by 2-3 minutes and -50 dBFS by four;
  one take ran away to -35 dBFS with two thirds of its quiet-block energy
  above 5 kHz - a whistle-and-static texture that buries the music.
- On busy stations, a 14-20 kHz bed grows steadily under the music. A
  dusty-beats take's stationary 14-20 kHz level climbed monotonically from
  -87 dBFS to -41 dBFS over six minutes while its 5-10 kHz band did not
  move; a jazz-cafe take rose 29 dB in that band inside two minutes. A
  detector that stopped at 14 kHz never saw either.

The drift is present with and without ``mx.compile``, at eight-bit and at
full precision, and at temperature 0.9, so it is the model's habit rather
than an artefact of this pipeline; it is per-take, not constant, and some
takes recede on their own.

``TakeFloorMonitor`` watches the stream the listener actually receives. It
profiles the quietest blocks - the gaps between notes, where a hiss bed is
exposed - and compares a frozen early-take baseline against a trailing
window. Its high-band level must become audibly louder and stay there before
it reports drift. The overall floor is diagnostic: a bed can brighten well
before its total level changes. Stereo power is measured before combining
channels, so wide or opposite-phase noise cannot disappear in a mono fold.

Two thresholds gate a drift vote. The relative one needs the high band of
the floor to rise ``HIGH_BAND_RISE_DB`` over the take's own baseline and to
be loud enough to hear; an earlier -52 dBFS audibility gate let a captured
take sit at -55 to -60 dBFS - plainly audible hiss after the browser's +5 dB
makeup - for ten minutes without a single vote. The absolute one,
``RUNAWAY_HIGH_DBFS``, needs no baseline at all: a floor that loud is hiss on
every station, and it is the only defence when the baseline itself was
learned from an already-drifting take (a station change carries the
recurrent state, and its drift, into a fresh baseline). Replayed against
nine captured takes, the current constants fire on every runaway between
2.2 and 5.5 minutes (the full-precision take at 8.8, when its drift finally
began) and never on the two healthy busy takes.

The repair is a server-side equal-power crossfade onto a fresh
recurrent state (same station, new seed), which reads as a radio track
change rather than a dropout: PCM flow, session identity, and the client
transport are untouched.

The preferred fresh state is not an empty one. ``Session`` keeps an
*anchor*: the tokens of a recent stretch of this take whose own quiet-block
floor was verified clean. A standby state teacher-forced through those tokens
continues the same music from a memory with no hiss in it. Measured on the
runaway takes above, re-priming from a clean anchor held the 5-20 kHz floor
within a few dB of its start for the full eight minutes, where the unguarded
takes climbed 20-30 dB. Because that repair is cheap and musically
continuous, it is triggered by the earlier ``rising`` signal instead of
waiting for ``drifted``.
"""

from __future__ import annotations

from collections import deque

import numpy as np

SAMPLE_RATE = 48_000
CHANNELS = 2

BLOCK_SECONDS = 0.05
BLOCK_FRAMES = int(SAMPLE_RATE * BLOCK_SECONDS)

# The floor is the quietest tenth of blocks in a window: between-note gaps,
# not the performance.
FLOOR_PERCENTILE = 10.0

# Skip the first seconds of a take (transport start, style landing), then
# freeze a baseline over the following stretch. The trailing window fills
# from the end of the skip, so the absolute test below can vote before the
# baseline exists.
BASELINE_SKIP_SECONDS = 10.0
BASELINE_SECONDS = 40.0
TRAILING_SECONDS = 30.0

# A hiss bed is, concretely, high-frequency noise in the quietest blocks
# that was not there at the start of the take. The high band of the floor
# must rise this far over its own baseline, and be absolutely loud enough
# to hear, before a chunk votes for drift. The overall floor level is
# reported for observability but deliberately not required: a captured live
# failure grew +22 dB of high-band hiss while its overall floor rose only
# +1 dB (the bed brightened long before it lifted), and healthy takes'
# high-band floors wander far less. Measured runaways rose +14 to +26 dB in
# band and kept rising; the strongest healthy excursion (a brushed-cymbal
# passage on jazz-cafe) reached +10 dB and receded within a window.
#
# Healthy rainy-piano takes keep this band near -70 dBFS in their gaps, so a
# ten-decibel rise lands around -60 dBFS; the browser adds 5 dB of makeup
# before the listener hears it. Anything at or above -60 dBFS here is
# audible hiss between notes.
HIGH_BAND_RISE_DB = 10.0
MIN_AUDIBLE_HIGH_DBFS = -60.0
# A floor this bright is a runaway regardless of what the take started from.
# Healthy busy stations (brushed and crisp drums in the quietest blocks)
# were measured no higher than -44 dBFS over a trailing window; the captured
# runaway sat at -33 to -37 dBFS for over a minute.
RUNAWAY_HIGH_DBFS = -38.0
# Drift must hold in most evaluations across this audio-time window. A fraction
# over a window, not a consecutive streak: one quiet evaluation must not
# reset the clock on a take that has been hissing for a minute. Measuring
# generated audio time also keeps this independent of chunk size, transport
# fragmentation, pauses, or repeated empty input.
EVALUATION_SECONDS = 0.4
SUSTAIN_SECONDS = 30.0
SUSTAIN_FRACTION = 0.8

# Drift accumulates with age while healthy brightening happens early, when
# an arrangement is still building. Once a take is this old, a smaller rise
# counts and it need not hold as long: a young take must sustain a
# HIGH_BAND_RISE_DB rise for SUSTAIN_SECONDS; a mature one is cut after
# MATURE_SUSTAIN_SECONDS of MATURE_RISE_DB. Every measured runaway that
# reached its threshold late kept climbing from there.
MATURE_TAKE_SECONDS = 150.0
MATURE_RISE_DB = 8.0
MATURE_SUSTAIN_SECONDS = 10.0

# Both measured runaway textures live above 5 kHz: the sparse-station hiss
# spans 3-13 kHz and the busy-station bed 14-20 kHz. Starting lower than
# 5 kHz reads brushed snares and guitar harmonics as hiss on jazz-cafe;
# stopping at 14 kHz misses the second texture entirely.
HIGH_BAND_LOW_HZ = 5_000.0
HIGH_BAND_HIGH_HZ = 20_000.0

# The early warning that starts a re-prime from a clean anchor. Drift was
# measured to take 1.5-3 minutes to grow from +5 dB to a runaway, while a
# re-prime is prepared in a few seconds and lands as a short crossfade into
# the same music, so it can act on a smaller, shorter rise than the
# fresh-state splice above: ~6 dB over the take's own baseline, loud enough to
# be heard between notes after the browser's makeup gain, held for 10 seconds.
EARLY_RISE_DB = 6.0
EARLY_MIN_AUDIBLE_HIGH_DBFS = -66.0
EARLY_SUSTAIN_SECONDS = 10.0

# A stretch of the take may become an anchor only when its own quiet-block
# high band sits within this margin of the baseline and below an absolute
# level that is hiss on any station. Before a baseline exists only the
# absolute test applies; the first seconds of a take are never considered.
CLEAN_MARGIN_DB = 3.0
CLEAN_MAX_HIGH_DBFS = -62.0

_EPS = 1e-12


def _dbfs(value: float) -> float:
    return 20.0 * float(np.log10(value + _EPS))


def _floor_profile(rms_values, high_values) -> tuple[float, float]:
    """Level and high-band level of the quietest blocks.

    Blocks are selected by overall RMS - the between-note gaps - and the
    high-band level is measured on those same blocks. Selecting the high
    band independently would find the darkest blocks (a pure bass note)
    rather than the spectrum of the floor itself.
    """
    rms = np.asarray(rms_values, dtype=np.float64)
    high = np.asarray(high_values, dtype=np.float64)
    take = max(1, int(rms.size * FLOOR_PERCENTILE / 100.0))
    quiet = np.argpartition(rms, take - 1)[:take]
    return float(np.median(rms[quiet])), float(np.median(high[quiet]))


class TakeFloorMonitor:
    """Tracks the quiet-block floor of one take from its int16 PCM."""

    def __init__(self):
        blocks = int(TRAILING_SECONDS / BLOCK_SECONDS)
        self._trailing_rms: deque[float] = deque(maxlen=blocks)
        self._trailing_high: deque[float] = deque(maxlen=blocks)
        self._baseline_rms: list[float] = []
        self._baseline_high: list[float] = []
        self._baseline_floor: float | None = None
        self._baseline_high_floor: float | None = None
        self._seen_blocks = 0
        # Where the current baseline started learning, and whether an older
        # one stays in force while a style change's floor is learned.
        self._baseline_start = 0
        self._relearning = False
        self._evaluation_blocks = max(1, round(EVALUATION_SECONDS / BLOCK_SECONDS))
        self._drift_votes: deque[bool] = deque(
            maxlen=max(1, round(max(SUSTAIN_SECONDS, MATURE_SUSTAIN_SECONDS) / EVALUATION_SECONDS))
        )
        self._early_votes: deque[bool] = deque(
            maxlen=max(1, round(EARLY_SUSTAIN_SECONDS / EVALUATION_SECONDS))
        )
        self._remainder = np.empty((0, CHANNELS), dtype=np.float32)
        window = np.hanning(BLOCK_FRAMES).astype(np.float32)
        self._window = window
        freqs = np.fft.rfftfreq(BLOCK_FRAMES, 1.0 / SAMPLE_RATE)
        self._high_bins = (freqs >= HIGH_BAND_LOW_HZ) & (freqs <= HIGH_BAND_HIGH_HZ)
        # Parseval-style scale so band energy reads in sample units.
        self._fft_scale = 1.0 / (np.sum(window**2) * BLOCK_FRAMES / 2.0)

    def reset(self):
        self.__init__()

    def relearn_baseline(self):
        """A style change: learn the new style's floor, keeping the old as a cap.

        The recurrent state - and any bed it has grown - survives a station
        change, so a baseline re-learned from scratch would describe the
        drift, not the music; measured after a switch to a custom mix, the
        delivered floor then crept up 14 dB in three minutes with no repair.
        Until the new baseline is learned the old one keeps judging, and the
        take keeps the lower of the two.
        """
        self.restart_trailing()
        self._baseline_start = self._seen_blocks
        self._baseline_rms = []
        self._baseline_high = []
        self._relearning = self._baseline_floor is not None

    def restart_trailing(self):
        """Forget the trailing window and its votes, keeping the baseline.

        Used after a splice that continues the same take from a clean
        anchor: the baseline still describes this take, but blocks measured
        before the splice must not vote on the audio after it.
        """
        self._trailing_rms.clear()
        self._trailing_high.clear()
        self._drift_votes.clear()
        self._early_votes.clear()

    def observe(self, pcm: bytes):
        """Feed one interleaved int16 stereo chunk in play order."""
        frame_bytes = 2 * CHANNELS
        usable_bytes = len(pcm) - (len(pcm) % frame_bytes)
        if usable_bytes <= 0:
            return
        samples = (
            np.frombuffer(pcm[:usable_bytes], dtype="<i2")
            .reshape(-1, CHANNELS)
            .astype(np.float32)
            / 32768.0
        )
        if self._remainder.size:
            samples = np.concatenate([self._remainder, samples])
        usable = len(samples) // BLOCK_FRAMES * BLOCK_FRAMES
        # A short leftover must not retain a view of a potentially long take.
        self._remainder = samples[usable:].copy()
        if usable:
            blocks = samples[:usable].reshape(-1, BLOCK_FRAMES, CHANNELS)
            rms = np.sqrt(np.mean(blocks**2, axis=(1, 2)) + _EPS)
            spectra = np.abs(
                np.fft.rfft(blocks * self._window[None, :, None], axis=1)
            ) ** 2
            high = np.sqrt(
                np.mean(np.sum(spectra[:, self._high_bins, :], axis=1), axis=1)
                * self._fft_scale
                + _EPS
            )
            for block_rms, block_high in zip(rms, high):
                self._observe_block(float(block_rms), float(block_high))

    def _observe_block(self, rms: float, high: float):
        self._seen_blocks += 1
        seconds = (self._seen_blocks - self._baseline_start) * BLOCK_SECONDS
        if seconds <= BASELINE_SKIP_SECONDS and not self._relearning:
            return
        if (self._baseline_floor is None or self._relearning) and seconds > BASELINE_SKIP_SECONDS:
            if seconds <= BASELINE_SKIP_SECONDS + BASELINE_SECONDS:
                self._baseline_rms.append(rms)
                self._baseline_high.append(high)
            else:
                floor, high_floor = _floor_profile(self._baseline_rms, self._baseline_high)
                if self._relearning and self._baseline_floor is not None:
                    # A new style may lower the take's reference but never
                    # raise it: re-learned from a state that already carried
                    # a rising bed, it would teach the guard to accept it.
                    floor = min(floor, self._baseline_floor)
                    high_floor = min(high_floor, self._baseline_high_floor)
                self._baseline_floor, self._baseline_high_floor = floor, high_floor
                self._baseline_rms = []
                self._baseline_high = []
                self._relearning = False
        self._trailing_rms.append(rms)
        self._trailing_high.append(high)
        if self._seen_blocks % self._evaluation_blocks == 0:
            self._evaluate()

    def _evaluate(self):
        if len(self._trailing_rms) < self._trailing_rms.maxlen:
            return
        floor, high_floor = _floor_profile(self._trailing_rms, self._trailing_high)
        del floor  # reported by describe(); the decision is spectral
        high_db = _dbfs(high_floor)
        rise = (
            high_db - _dbfs(self._baseline_high_floor)
            if self._baseline_high_floor is not None
            else None
        )
        mature = self._seen_blocks * BLOCK_SECONDS >= MATURE_TAKE_SECONDS
        required_rise = MATURE_RISE_DB if mature else HIGH_BAND_RISE_DB
        # Loud enough to be hiss on any station, whatever the take began as.
        drifted = high_db >= RUNAWAY_HIGH_DBFS
        if not drifted and rise is not None:
            drifted = high_db >= MIN_AUDIBLE_HIGH_DBFS and rise >= required_rise
        self._drift_votes.append(drifted)
        early = drifted or (
            rise is not None
            and high_db >= EARLY_MIN_AUDIBLE_HIGH_DBFS
            and rise >= EARLY_RISE_DB
        )
        self._early_votes.append(early)

    @property
    def drifted(self) -> bool:
        votes = self._drift_votes
        if not votes:
            return False
        # A mature take need not hold as long: drift only grows, and the
        # relative test already required a real rise to vote at all. Count
        # the most recent votes over whichever window currently applies.
        mature = self._seen_blocks * BLOCK_SECONDS >= MATURE_TAKE_SECONDS
        window_seconds = MATURE_SUSTAIN_SECONDS if mature else SUSTAIN_SECONDS
        needed = max(1, round(window_seconds / EVALUATION_SECONDS))
        if len(votes) < needed:
            return False
        recent = list(votes)[-needed:]
        return sum(recent) >= SUSTAIN_FRACTION * needed

    @property
    def rising(self) -> bool:
        """Whether the high-band floor has held a smaller rise for 10 seconds.

        Earlier than ``drifted`` by design: it starts a clean-anchor re-prime,
        which costs a few seconds of background work and a short crossfade
        into the same music rather than a new take.
        """
        votes = self._early_votes
        if len(votes) < votes.maxlen:
            return False
        return sum(votes) >= SUSTAIN_FRACTION * len(votes)

    def recent_high_floor_db(self, seconds: float) -> float | None:
        """High-band floor of the most recent ``seconds``, or None if unseen."""
        blocks = int(round(seconds / BLOCK_SECONDS))
        if blocks <= 0 or len(self._trailing_rms) < blocks:
            return None
        rms = list(self._trailing_rms)[-blocks:]
        high = list(self._trailing_high)[-blocks:]
        _floor, high_floor = _floor_profile(rms, high)
        return _dbfs(high_floor)

    def recent_is_clean(self, seconds: float) -> bool:
        """Whether the most recent ``seconds`` of audio have a clean floor.

        Measured on exactly the blocks an anchor would cover, so a stretch
        is only trusted as clean memory when its own quiet moments are.
        """
        high_db = self.recent_high_floor_db(seconds)
        if high_db is None or high_db > CLEAN_MAX_HIGH_DBFS:
            return False
        if self._baseline_high_floor is None:
            return True
        return high_db <= _dbfs(self._baseline_high_floor) + CLEAN_MARGIN_DB

    @property
    def suspicious(self) -> bool:
        """Whether the trailing floor is currently voting for drift.

        Weaker than ``drifted``: the rise has not yet been sustained. Used at
        moments that are already a musical boundary - a station change - where
        carrying a state that has begun to hiss into the next station costs
        nothing to avoid.
        """
        votes = self._drift_votes
        return bool(votes) and votes[-1]

    def describe(self) -> str:
        if not self._trailing_rms:
            return "warming"
        floor, high_floor = _floor_profile(self._trailing_rms, self._trailing_high)
        if self._baseline_floor is None:
            return (
                f"floor {_dbfs(floor):.1f} dBFS, high band {_dbfs(high_floor):.1f} dBFS "
                "(no baseline yet)"
            )
        return (
            f"floor {_dbfs(floor):.1f} dBFS, high band {_dbfs(high_floor):.1f} dBFS "
            f"(baseline {_dbfs(self._baseline_floor):.1f} / "
            f"{_dbfs(self._baseline_high_floor):.1f} dBFS)"
        )


def crossfade_pcm(old_pcm: bytes, new_pcm: bytes) -> bytes:
    """Equal-power crossfade between two equal-length int16 stereo chunks."""
    old = np.frombuffer(old_pcm, dtype=np.int16).astype(np.float32)
    new = np.frombuffer(new_pcm, dtype=np.int16).astype(np.float32)
    frames = min(old.size, new.size) // CHANNELS
    old = old[: frames * CHANNELS].reshape(frames, CHANNELS)
    new = new[: frames * CHANNELS].reshape(frames, CHANNELS)
    theta = np.linspace(0.0, np.pi / 2.0, frames, dtype=np.float32)[:, None]
    mixed = old * np.cos(theta) + new * np.sin(theta)
    return (
        np.clip(np.round(mixed), -32768, 32767)
        .astype(np.int16)
        .reshape(-1)
        .tobytes()
    )
