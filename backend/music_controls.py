"""Validation and normalization for listener-facing music controls."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from typing import Any, Mapping

import styles


MIN_BPM = 60
MAX_BPM = 110

# Granular dials are stored normalized 0..1 so the wire protocol and UI never
# depend on the model's internal guidance/sampler ranges. 0.5 is the neutral
# default that reproduces the tuned production behavior.
DEFAULT_ADHERENCE = 0.5
DEFAULT_VARIATION = 0.5


def _clamp_number(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(low, min(high, number))


def _bool(value: Any, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback


def _custom_prompt(value: Any, fallback: str) -> str:
    if value is None:
        return fallback
    if not isinstance(value, str):
        return fallback
    # Trim to the same cap the scaffold enforces so the stored control matches
    # what the model will actually receive.
    return value.replace("\n", " ").strip()[: styles.MAX_CUSTOM_PROMPT_CHARS]


@dataclass(frozen=True)
class MusicControls:
    station: str
    mood: str
    instrument: str
    bpm: int
    groove: float
    intensity: float
    melody: bool
    drums: bool
    # Free-text listener prompt (only meaningful for the custom station) and
    # two normalized granular dials.
    customPrompt: str = ""
    adherence: float = DEFAULT_ADHERENCE
    variation: float = DEFAULT_VARIATION

    @classmethod
    def initial(
        cls,
        mood: str = styles.DEFAULT_MOOD,
        instrument: str = styles.DEFAULT_INSTRUMENT,
        station: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> "MusicControls":
        # Legacy clients did not send a station; retain their mood/instrument
        # semantics. New clients select a curated station and inherit its grid.
        chosen_station = (
            styles.CUSTOM_STATION
            if station is None
            else styles.normalize_station(station)
        )
        if chosen_station == styles.CUSTOM_STATION:
            mood, instrument = styles.normalize(mood, instrument)
            controls = cls(
                chosen_station, mood, instrument, 78, 0.60, 0.45, True, True
            )
        else:
            preset = styles.station_defaults(chosen_station)
            controls = cls(
                chosen_station,
                preset.mood,
                preset.instrument,
                preset.bpm,
                preset.groove,
                preset.intensity,
                True,
                True,
            )
        return controls.update(payload or {}, apply_station_defaults=False)

    def update(
        self,
        payload: Mapping[str, Any],
        *,
        apply_station_defaults: bool = True,
    ) -> "MusicControls":
        next_controls = self
        raw_station = payload.get("station")
        explicit_named_station = False
        if isinstance(raw_station, str):
            station = styles.normalize_station(raw_station)
            explicit_named_station = station != styles.CUSTOM_STATION
            if station != self.station and apply_station_defaults:
                if station == styles.CUSTOM_STATION:
                    next_controls = replace(next_controls, station=station)
                else:
                    preset = styles.station_defaults(station)
                    next_controls = replace(
                        next_controls,
                        station=station,
                        mood=preset.mood,
                        instrument=preset.instrument,
                        bpm=preset.bpm,
                        groove=preset.groove,
                        intensity=preset.intensity,
                    )
            else:
                next_controls = replace(next_controls, station=station)

        # A station is one coherent MusicCoCa target. When it is explicitly
        # selected it wins over stale legacy mood/instrument fields that an old
        # client may still include in the same control snapshot.
        if explicit_named_station:
            preset = styles.station_defaults(raw_station)
            mood, instrument = preset.mood, preset.instrument
        else:
            mood, instrument = styles.normalize(
                payload.get("mood", next_controls.mood),
                payload.get("instrument", next_controls.instrument),
            )
        # Manually steering either legacy axis makes the result a custom mix,
        # unless the client explicitly included the station in this message.
        # A non-empty free-text prompt is the strongest custom signal of all.
        station = next_controls.station
        typed_custom_prompt = (
            isinstance(raw_station, str) is False
            and isinstance(payload.get("customPrompt"), str)
            and payload["customPrompt"].strip() != ""
        )
        if raw_station is None and (
            "mood" in payload or "instrument" in payload or typed_custom_prompt
        ):
            station = styles.CUSTOM_STATION

        # A named station has no free-text prompt; clear any carried-over text
        # so it cannot silently override the curated target on a later message.
        custom_prompt = _custom_prompt(
            payload.get("customPrompt"), next_controls.customPrompt
        )
        if station != styles.CUSTOM_STATION:
            custom_prompt = ""

        return replace(
            next_controls,
            station=station,
            mood=mood,
            instrument=instrument,
            bpm=round(
                _clamp_number(payload.get("bpm"), MIN_BPM, MAX_BPM, next_controls.bpm)
            ),
            groove=_clamp_number(
                payload.get("groove"), 0.0, 1.0, next_controls.groove
            ),
            intensity=_clamp_number(
                payload.get("intensity"), 0.0, 1.0, next_controls.intensity
            ),
            melody=_bool(payload.get("melody"), next_controls.melody),
            drums=_bool(payload.get("drums"), next_controls.drums),
            customPrompt=custom_prompt,
            adherence=_clamp_number(
                payload.get("adherence"), 0.0, 1.0, next_controls.adherence
            ),
            variation=_clamp_number(
                payload.get("variation"), 0.0, 1.0, next_controls.variation
            ),
        )

    def prompt(self) -> str:
        return styles.prompt_for(
            self.mood, self.instrument, self.station, self.customPrompt
        )

    def reference(self) -> str | None:
        return styles.audio_reference_for(self.station)

    def sampling_overrides(self) -> dict[str, float]:
        """Map normalized granular dials onto MusicCoCa/sampler adjustments.

        Returned as multiplicative/additive factors around the engine's tuned
        defaults so this module stays independent of the model's absolute
        numbers. ``adherence`` steers how tightly the model follows the style
        prompt (MusicCoCa CFG); ``variation`` steers how much the sampler
        wanders (temperature). Both are centered at 0.5 == neutral, and the
        ranges are deliberately narrow: the take guard and CFG floor keep long
        takes stable, and a listener should not be able to dial the stream into
        a self-fed hiss bed.
        """
        # adherence 0..1 -> cfg multiplier ~0.85..1.30 (higher = more faithful),
        # times the station's own guidance factor (styles.Station.guidance)
        cfg_scale = (0.85 + self.adherence * 0.45) * styles.station_guidance(self.station)
        # variation 0..1 -> temperature multiplier ~0.80..1.20
        temperature_scale = 0.80 + self.variation * 0.40
        return {
            "cfg_musiccoca_scale": cfg_scale,
            "temperature_scale": temperature_scale,
        }

    def payload(self) -> dict[str, Any]:
        return asdict(self)
