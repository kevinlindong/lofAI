"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { DotGlyph, DotPattern } from "@/components/dot-glyph"
import { DotVisualizer } from "@/components/dot-visualizer"
import { FineDial } from "@/components/fine-dial"
import { SoundPanel } from "@/components/sound-panel"
import { StationEmblem, StationPicker } from "@/components/station-picker"
import { useRadio } from "@/components/radio-provider"
import { useWidgetFrame } from "@/components/desk/widget-frame"
import type { PreviewProps, WidgetDefinition, WidgetProps } from "@/components/desk/types"
import { canvasLoop } from "@/lib/canvas-loop"
import { lowPowerActive } from "@/lib/render-budget"
import { CUSTOM_STATION, MOODS, spokenWord, STATION_PRESETS, stationFor, VIBES, type RadioControls, type SoundOption } from "@/lib/sound-recipe"

// The music in one widget: the ring and its play key, the stations, the
// sentence and the dials. Four sizes of the same radio: a mini player (M),
// the ring (L), the ring beside the panel (W), and the whole card (XL: the
// ring on top, the panel under it — the old music card, stacked).

// the caption is shorter than the sentence: "mellow lo-fi", not "mellow lo-fi beats"
const CAPTION_WORD: Record<string, string> = { lofi: "lo-fi" }
const captionWord = (option?: SoundOption) => (option ? CAPTION_WORD[option.id] ?? spokenWord(option) : "")
const volumeWord = (value: number) => (value === 0 ? "muted" : "")

// what's on air, in a line under the ring
function caption(controls: RadioControls): { where: string; sound: string } {
  const playing = stationFor(controls)
  const recipe = playing?.recipe ?? controls.recipe
  if (!recipe) return { where: "your own words", sound: "" }
  const mood = captionWord(MOODS.find((option) => option.id === recipe.mood))
  const vibe = captionWord(VIBES.find((option) => option.id === recipe.vibe))
  return { where: playing ? playing.label.toLowerCase() : "your mix", sound: `${mood} ${vibe}`.trim() }
}

// A station change from anywhere but the panel's own dial (the mini
// player's steppers, the ring's row of emblems) goes the same way the dial
// does: the cat notices, and the station tunes in.
export function useStationSelect() {
  const { controls, selectStation, handlePetEvent } = useRadio()
  const on = stationFor(controls)?.id
  return useCallback((station: string) => {
    if (station !== on) handlePetEvent("complete")
    selectStation(station)
  }, [on, selectStation, handlePetEvent])
}

function PlayKey({ small = false }: { small?: boolean }) {
  const { wantsAudio, togglePlayback } = useRadio()
  return (
    <button
      type="button"
      onClick={togglePlayback}
      aria-label={wantsAudio ? "Pause" : "Play"}
      aria-pressed={wantsAudio}
      className={`key play-key${small ? " is-small" : ""}`}
    >
      <DotGlyph name={wantsAudio ? "pause" : "play"} dot={small ? 3 : 4} />
    </button>
  )
}

// Five dots that follow the music at a gentle 12fps, written as one --level
// on one span. Still in low power and reduced motion.
function LevelMeter() {
  const ref = useRef<HTMLSpanElement>(null)
  const { getLevel, isLive } = useRadio()
  const level = useRef({ get: getLevel, live: isLive })
  level.current = { get: getLevel, live: isLive }
  const loopRef = useRef<ReturnType<typeof canvasLoop> | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let smooth = 0
    const still = () => el.style.setProperty("--level", level.current.live ? "0.6" : "0")
    loopRef.current = canvasLoop(el, (_now, dt) => {
      if (lowPowerActive()) { still(); return }
      const target = level.current.live ? Math.min(1, level.current.get() * 4) : 0
      smooth += (target - smooth) * (1 - Math.exp(-dt / 0.12))
      el.style.setProperty("--level", smooth.toFixed(2))
    }, still, { fps: 12, lowPowerFps: 12 })
    return () => { loopRef.current?.dispose(); loopRef.current = null }
  }, [])
  useEffect(() => { loopRef.current?.redraw() }, [isLive])

  return (
    <span ref={ref} className="radio-level" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ "--i": i } as CSSProperties} />)}
    </span>
  )
}

function Volume() {
  const { volume, setVolume } = useRadio()
  return <FineDial label="volume" value={volume} describe={volumeWord} onChange={setVolume} />
}

// the ring, its key and status inside, and what's on air under it
function Ring() {
  const { controls, label, isLive, getSpectrum } = useRadio()
  const line = caption(controls)
  return (
    <div className="radio-widget" data-live={isLive ? "" : undefined}>
      <div className="visualizer-stage radio-ring">
        <DotVisualizer getSpectrum={getSpectrum} active={isLive}>
          <div className="radio-ring-key">
            <PlayKey />
            <span className="play-status">{label}</span>
          </div>
          <p className="radio-caption"><b>{line.where}</b>{line.sound && ` · ${line.sound}`}</p>
        </DotVisualizer>
      </div>
    </div>
  )
}

const PREV = ["..X", ".X.", "X..", ".X.", "..X"]
const NEXT = ["X..", ".X.", "..X", ".X.", "X.."]

// M: the key, what's on, the level, a station either way, and the volume.
// No canvas at all
function Mini() {
  const { controls, label } = useRadio()
  const select = useStationSelect()
  const playing = stationFor(controls)
  // said once a stepper has changed the station, not on load
  const [said, setSaid] = useState("")
  const step = (dir: -1 | 1) => {
    const count = STATION_PRESETS.length
    const at = STATION_PRESETS.findIndex((preset) => preset.id === playing?.id)
    const next = at < 0 ? (dir > 0 ? 0 : count - 1) : (at + dir + count) % count
    select(STATION_PRESETS[next].id)
    setSaid(STATION_PRESETS[next].label.toLowerCase())
  }
  const station = playing ? playing.label.toLowerCase() : controls.recipe ? "your mix" : "your own words"
  return (
    <div className="radio-m">
      <div className="radio-mini">
        <PlayKey small />
        <span className="radio-mini-emblem" aria-hidden>{playing ? <StationEmblem id={playing.id} /> : <DotGlyph name="music" dot={2} />}</span>
        <span className="radio-mini-text">
          <span className="radio-mini-name"><b>{station}</b><LevelMeter /></span>
          <span className="play-status">{label}</span>
        </span>
        <span className="radio-steps">
          <button type="button" className="key radio-step" aria-label="Previous station" onClick={() => step(-1)}><DotPattern rows={PREV} dot={2} /></button>
          <button type="button" className="key radio-step" aria-label="Next station" onClick={() => step(1)}><DotPattern rows={NEXT} dot={2} /></button>
        </span>
      </div>
      <div className="radio-volume"><Volume /></div>
      <span className="sr-only" aria-live="polite">{said}</span>
    </div>
  )
}

// L: the ring, one row of eight emblems (the ring's caption names the one on
// air), and the volume
function RingSize() {
  const { controls } = useRadio()
  const select = useStationSelect()
  const playing = stationFor(controls)
  return (
    <div className="radio-l">
      <div className="radio-l-ring"><Ring /></div>
      <div className="radio-dial"><StationPicker station={playing?.id ?? CUSTOM_STATION} onSelect={select} /></div>
      <div className="radio-volume"><Volume /></div>
    </div>
  )
}

// W: the ring on the left and the whole sound panel beside it. The word
// trays unfold over the neighbours; the writer takes the sentence's place
function Wide() {
  const { setExpanded } = useWidgetFrame()
  return (
    <div className="radio-w">
      <div className="radio-w-ring"><Ring /></div>
      <div className="radio-panel"><SoundPanel onExpandedChange={setExpanded} /></div>
    </div>
  )
}

// XL: the whole card. The ring with its play key and status on top, its
// caption under it, then the sound panel — stations with their names, the
// sentence, new take / write it yourself, the dials. The phone's tall form
// is the same layout in a narrower box
function Full({ tall }: { tall: boolean }) {
  const { setExpanded } = useWidgetFrame()
  return (
    <div className={tall ? "radio-xl is-tall" : "radio-xl"}>
      <div className="radio-xl-ring"><Ring /></div>
      <div className="radio-panel"><SoundPanel onExpandedChange={setExpanded} /></div>
    </div>
  )
}

function Radio({ size, form }: WidgetProps) {
  if (size === "m") return <Mini />
  if (size === "l") return <RingSize />
  if (size === "w") return <Wide />
  return <Full tall={form === "tall"} />
}

function Preview({ size }: PreviewProps) {
  if (size === "m") {
    return (
      <span className="widget-preview preview-radio-mini" aria-hidden>
        <span className="preview-key"><DotGlyph name="play" dot={1} /></span><i /><i />
      </span>
    )
  }
  return (
    <span className="widget-preview preview-radio" data-size={size} aria-hidden>
      <span className="preview-ring"><span className="preview-key"><DotGlyph name="play" dot={2} /></span></span>
      {(size === "w" || size === "xl") && (
        <span className="preview-radio-panel">
          <span className="preview-stations">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</span>
          <span className="preview-line" />
          <span className="preview-rails"><i /><i /><i /></span>
        </span>
      )}
    </span>
  )
}

// three level dots on the pull while the music plays in the drawer
function Peek() {
  const { wantsAudio } = useRadio()
  if (!wantsAudio) return null
  return <span className="peek peek-radio"><i aria-hidden /><i aria-hidden /><i aria-hidden /><span className="sr-only">The radio is playing.</span></span>
}

export const definition: WidgetDefinition = {
  type: "radio",
  name: "Radio",
  blurb: "The music: play, stations, and how it sounds.",
  sizes: [
    { id: "m", label: "mini player" },
    { id: "l", label: "ring" },
    { id: "w", label: "wide" },
    { id: "xl", label: "full radio" },
  ],
  defaultSize: "xl",
  surface: "card",
  maxInstances: 1,
  Component: Radio,
  Preview,
  Peek,
}
