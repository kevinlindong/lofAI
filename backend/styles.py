"""Curated, deliberately short MusicCoCa style targets.

MusicCoCa is a contrastive music-style encoder, not an instruction-following
language model. Audible tags work better than asking it to compose, mix, or
master. Named stations therefore use one compact target while ``custom``
combines the two legacy controls without changing the transport.

An optional owned/licensed WAV can anchor each named station in MusicCoCa's
native audio embedding space. Put files named ``<station>.wav`` in
``MRT_STYLE_REFERENCE_DIR``; the engine blends them with the text embedding.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import os
from pathlib import Path


MOODS = ("somber", "neutral", "lively")
INSTRUMENTS = ("piano", "guitar", "brass")

DEFAULT_MOOD = "neutral"
DEFAULT_INSTRUMENT = "guitar"
DEFAULT_STATION = "dusty-beats"
CUSTOM_STATION = "custom"

# A listener's free-text prompt is wrapped in this scaffold before it reaches
# MusicCoCa. The station is a text-to-audio model, so a raw prompt can wander
# anywhere; anchoring every request to "instrumental lo-fi" keeps the vibe of
# the room while still letting the words steer instruments, mood, and texture.
# MusicCoCa is a style encoder rather than an instruction follower, so we keep
# the scaffold short and concrete for the same reason the curated prompts are.
CUSTOM_PROMPT_PREFIX = "instrumental lo-fi"
MAX_CUSTOM_PROMPT_CHARS = 120


def scaffold_custom_prompt(text: str | None) -> str | None:
    """Wrap a listener's free text in the lofi scaffold, or return None.

    Returns ``None`` when the text is empty after trimming so callers fall back
    to the mood/instrument mix. Control characters are stripped and the result
    is length-capped: a long adjective pile-up dilutes MusicCoCa conditioning
    rather than improving it.
    """
    if not isinstance(text, str):
        return None
    cleaned = " ".join(text.replace("\n", " ").split())
    cleaned = "".join(ch for ch in cleaned if ch.isprintable())
    cleaned = cleaned.strip()[:MAX_CUSTOM_PROMPT_CHARS].strip()
    if not cleaned:
        return None
    lowered = cleaned.lower()
    # Avoid a doubled "lo-fi" if the listener already asked for it.
    if "lo-fi" in lowered or "lofi" in lowered:
        return cleaned
    return f"{CUSTOM_PROMPT_PREFIX}, {cleaned}"


@dataclass(frozen=True)
class Station:
    slug: str
    label: str
    prompt: str
    mood: str
    instrument: str
    bpm: int
    groove: float
    intensity: float
    # Multiplies MusicCoCa guidance for this station. Sparse stations leave
    # the model's own feedback the most room to grow a hiss bed between
    # notes, and stronger guidance slows that; it would also push "dusty"
    # textures harder on stations whose prompt asks for them.
    guidance: float = 1.0


STATIONS: dict[str, Station] = {
    "dusty-beats": Station(
        "dusty-beats",
        "Dusty Beats",
        "instrumental mellow lo-fi hip hop, dusty drums, warm jazz guitar",
        "neutral",
        "guitar",
        76,
        0.62,
        0.42,
    ),
    "rainy-piano": Station(
        "rainy-piano",
        "Rainy Piano",
        "instrumental ambient lo-fi, intimate felt piano, sparse brushed drums",
        "somber",
        "piano",
        68,
        0.40,
        0.28,
        # 1.25x (MusicCoCa CFG 5.0 at the defaults): on 8-minute takes under
        # the clean-anchor guard this halved the splices it needed (0 vs 2
        # and 3 vs 6 on two seeds) and cut the worst floor by up to 10 dB.
        # The same boost on dusty-beats doubled its splices instead.
        guidance=1.25,
    ),
    "jazz-cafe": Station(
        "jazz-cafe",
        "Jazz Cafe",
        "instrumental late-night jazzhop trio, warm clean guitar, upright bass, brushed drums",
        "neutral",
        "guitar",
        82,
        0.70,
        0.52,
    ),
    "sunlit-groove": Station(
        "sunlit-groove",
        "Sunlit Groove",
        "instrumental soulful jazzhop, muted trumpet, Rhodes keys, crisp relaxed drums",
        "lively",
        "brass",
        94,
        0.78,
        0.68,
    ),
}

MOOD_STYLE = {
    "somber": "melancholy",
    "neutral": "warm mellow",
    "lively": "bright upbeat",
}

INSTRUMENT_STYLE = {
    "piano": "felt piano",
    "guitar": "jazz guitar",
    "brass": "muted trumpet",
}

CUSTOM_PROMPTS = {
    (mood, instrument): (
        f"lo-fi hip hop, {MOOD_STYLE[mood]}, {INSTRUMENT_STYLE[instrument]}"
    )
    for mood in MOODS
    for instrument in INSTRUMENTS
}


def normalize(mood: str, instrument: str) -> tuple[str, str]:
    mood = mood if mood in MOODS else DEFAULT_MOOD
    instrument = instrument if instrument in INSTRUMENTS else DEFAULT_INSTRUMENT
    return mood, instrument


def normalize_station(station: str | None) -> str:
    if station == CUSTOM_STATION:
        return CUSTOM_STATION
    return station if station in STATIONS else DEFAULT_STATION


# Words that ask MusicCoCa for recording texture - the sound editor's "vinyl
# crackle", "warm tape" and "soft rain" effects, or a typed prompt. When a
# listener asks for texture, the hiss filter stands aside rather than
# removing exactly what was requested.
NOISE_TEXTURE_WORDS = ("vinyl", "crackle", "tape", "rain", "hiss", "static", "noise")


def requests_noise_texture(prompt: str | None) -> bool:
    """Whether a style prompt explicitly asks for a noise-like texture."""
    if not prompt:
        return False
    words = prompt.lower()
    return any(word in words for word in NOISE_TEXTURE_WORDS)


def station_guidance(station: str | None) -> float:
    """MusicCoCa guidance multiplier for a station; 1.0 for custom prompts."""
    preset = STATIONS.get(station) if station else None
    return preset.guidance if preset is not None else 1.0


def station_defaults(station: str | None) -> Station:
    return STATIONS.get(normalize_station(station), STATIONS[DEFAULT_STATION])


def prompt_for(
    mood: str,
    instrument: str,
    station: str = CUSTOM_STATION,
    custom_prompt: str | None = None,
) -> str:
    station = normalize_station(station)
    if station != CUSTOM_STATION:
        return STATIONS[station].prompt
    scaffolded = scaffold_custom_prompt(custom_prompt)
    if scaffolded is not None:
        return scaffolded
    return CUSTOM_PROMPTS[normalize(mood, instrument)]


def audio_reference_for(station: str | None) -> str | None:
    """Return a station's optional local WAV anchor, if configured and safe."""
    root = os.environ.get("MRT_STYLE_REFERENCE_DIR", "").strip()
    station = normalize_station(station)
    if not root or station == CUSTOM_STATION:
        return None
    candidate = Path(root).expanduser() / f"{station}.wav"
    return str(candidate.resolve()) if candidate.is_file() else None


def all_prompts() -> list[str]:
    # Only listener-facing stations belong on the startup path. Legacy custom
    # combinations are embedded lazily if an older client requests one.
    return [station.prompt for station in STATIONS.values()]


def reference_map() -> dict[str, str]:
    result: dict[str, str] = {}
    for station in STATIONS:
        reference = audio_reference_for(station)
        if reference is not None:
            result[STATIONS[station].prompt] = reference
    return result


def public_options() -> dict:
    return {
        "defaultStation": DEFAULT_STATION,
        "customStation": CUSTOM_STATION,
        "stations": [asdict(station) for station in STATIONS.values()],
        "moods": list(MOODS),
        "instruments": list(INSTRUMENTS),
        "maxCustomPromptChars": MAX_CUSTOM_PROMPT_CHARS,
        "limits": {
            "bpm": [60, 110],
            "groove": [0.0, 1.0],
            "intensity": [0.0, 1.0],
            # Listener-facing granular dials, normalized 0..1. The backend maps
            # them onto safe MusicCoCa guidance and sampler ranges.
            "adherence": [0.0, 1.0],
            "variation": [0.0, 1.0],
        },
    }
