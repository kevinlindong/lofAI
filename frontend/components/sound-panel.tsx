"use client"

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { DotGlyph } from "@/components/dot-glyph"
import { FineDial } from "@/components/fine-dial"
import { RollingText } from "@/components/rolling-text"
import { StationPicker } from "@/components/station-picker"
import { useRadio } from "@/components/radio-provider"
import { MAX_CUSTOM_PROMPT_CHARS } from "@/lib/mrt-stream"
import {
  buildSoundPrompt, CUSTOM_STATION, EFFECTS, INSTRUMENTS, MAX_EFFECTS, MAX_INSTRUMENTS,
  MOODS, sameRecipe, STATION_PRESETS, VIBES, type SoundOption, type SoundRecipe,
} from "@/lib/sound-recipe"

type Slot = "mood" | "vibe" | "instruments" | "effects"

// Edits to the sentence tune in by themselves once the listener pauses, so a
// few quick picks become one style change for the model rather than several.
// The edited word's underline fills over this time as the countdown.
const TUNE_DELAY_MS = 900
const TUNED_FLASH_MS = 1600

// How a choice reads in the sentence. The prompt sent to the model is unchanged.
const SPOKEN: Record<string, string> = {
  lofi: "lo-fi beats", soulful: "soul", dreamy: "dreamy lo-fi", rhodes: "Rhodes keys",
}
const say = (option?: SoundOption) => (option ? SPOKEN[option.id] ?? option.label.toLowerCase() : "")
const sayAll = (options: readonly SoundOption[], ids: string[]) => {
  const words = ids.map((id) => say(options.find((option) => option.id === id)))
  return words.length < 2 ? words[0] ?? "" : `${words.slice(0, -1).join(", ")} & ${words[words.length - 1]}`
}
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const TRAYS: Record<Slot, { options: readonly SoundOption[]; label: string; hint: string }> = {
  mood: { options: MOODS, label: "Mood", hint: "pick one" },
  vibe: { options: VIBES, label: "Style", hint: "pick one" },
  instruments: { options: INSTRUMENTS, label: "Instruments", hint: `up to ${MAX_INSTRUMENTS} · another pick replaces the first` },
  effects: { options: EFFECTS, label: "Texture", hint: `up to ${MAX_EFFECTS}, or none` },
}

const PROMPT_IDEAS = [
  { label: "rainy rooftop", prompt: "rainy Tokyo rooftop, mellow saxophone, soft piano, distant rain" },
  { label: "slow sunday", prompt: "lazy Sunday morning, warm jazz guitar, Rhodes keys, gentle tape warmth" },
  { label: "midnight arcade", prompt: "dreamy chiptune lo-fi, music box, soft synth pads, sleepy midnight mood" },
]

// Five bands per dial, so the neutral 50 sits in the middle of one.
const inBands = (words: string[]) => (value: number) => words[Math.min(words.length - 1, Math.floor(value / 20))]
const styleWord = inBands(["loose", "relaxed", "balanced", "close", "strict"])
const variationWord = inBands(["steady", "settled", "balanced", "wandering", "adventurous"])
const volumeWord = (value: number) => (value === 0 ? "muted" : "")

// A word in the sentence that opens its tray. A span rather than a button so
// long choices wrap with the line like the rest of the text.
function Word({ label, text, open, ghost, pressed, charge, trayId, onToggle, wordRef }: {
  label: string; text: string; open?: boolean; ghost?: boolean; pressed?: boolean
  charge?: "charging" | "tuned"; trayId?: string
  onToggle: () => void; wordRef?: (node: HTMLSpanElement | null) => void
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onToggle()
  }
  return (
    <span
      ref={wordRef}
      role="button"
      tabIndex={0}
      className={`word${ghost ? " is-ghost" : ""}${charge ? ` is-${charge}` : ""}`}
      aria-label={`${label}: ${text}`}
      aria-expanded={open}
      aria-pressed={pressed}
      aria-controls={open ? trayId : undefined}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <RollingText text={text} />
    </span>
  )
}

export function SoundPanel() {
  const {
    controls, setControls, soundDraft, setSoundDraft, selectStation,
    volume, setVolume, wantsAudio, handlePetEvent, requestVariation, streamState,
  } = useRadio()
  const id = useId()
  const trayId = `${id}-tray`
  const rootRef = useRef<HTMLDivElement>(null)
  const writerRef = useRef<HTMLTextAreaElement>(null)
  // set when the listener asks for the writer, so it opens with the caret in it
  const focusWriter = useRef(false)
  const words = useRef<Partial<Record<Slot, HTMLSpanElement | null>>>({})
  const [open, setOpen] = useState<Slot | null>(null)
  const [dirty, setDirty] = useState(false)
  // the word being edited, and a count of edits so its countdown restarts
  const [edited, setEdited] = useState<{ slot: Slot; count: number } | null>(null)
  const [tunedAt, setTunedAt] = useState(0)
  const [refused, setRefused] = useState<{ id: string; count: number } | null>(null)
  const rolling = streamState.variationPending

  const { mode, recipe, prompt } = soundDraft
  const nextPrompt = mode === "builder" ? buildSoundPrompt(recipe) : prompt.replace(/\s+/g, " ").trim()
  const currentRecipe = controls.recipe ?? STATION_PRESETS.find((preset) => preset.id === controls.station)?.recipe
  const isCurrent = mode === "builder"
    ? !!currentRecipe && sameRecipe(recipe, currentRecipe)
    : nextPrompt.length > 0 && controls.station === CUSTOM_STATION && !controls.recipe && nextPrompt === controls.customPrompt.trim()
  const canApply = !isCurrent && nextPrompt.length > 0 && nextPrompt.length <= MAX_CUSTOM_PROMPT_CHARS
  const justTuned = tunedAt > 0

  const tuneIn = () => {
    setDirty(false)
    if (!canApply) return
    const preset = mode === "builder" && STATION_PRESETS.find((entry) => sameRecipe(entry.recipe, recipe))
    if (preset) selectStation(preset.id)
    else setControls((current) => ({
      ...current, station: CUSTOM_STATION, customPrompt: nextPrompt, recipe: mode === "builder" ? recipe : undefined,
    }))
    setTunedAt(Date.now())
    // the cat notices when the music changes
    handlePetEvent("complete")
  }
  const tuneInLater = useRef(tuneIn)
  tuneInLater.current = tuneIn

  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => tuneInLater.current(), TUNE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [dirty, recipe])

  useEffect(() => {
    if (!tunedAt) return
    const timer = window.setTimeout(() => { setTunedAt(0); setEdited(null) }, TUNED_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [tunedAt])

  // the writer grows with its words instead of scrolling inside a box
  useLayoutEffect(() => {
    const writer = writerRef.current
    if (!writer) return
    writer.style.height = "auto"
    writer.style.height = `${writer.scrollHeight}px`
    if (focusWriter.current) {
      focusWriter.current = false
      writer.focus()
      writer.setSelectionRange(writer.value.length, writer.value.length)
    }
  }, [prompt, mode])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [open])

  const closeTray = () => {
    if (open) words.current[open]?.focus({ preventScroll: true })
    setOpen(null)
  }

  const updateRecipe = (slot: Slot, next: Partial<SoundRecipe>) => {
    setSoundDraft((draft) => ({ ...draft, recipe: { ...draft.recipe, ...next } }))
    setEdited((previous) => ({ slot, count: (previous?.count ?? 0) + 1 }))
    setTunedAt(0)
    setDirty(true)
  }

  const pick = (slot: Slot, choice: string) => {
    if (slot === "mood" || slot === "vibe") {
      if (recipe[slot] !== choice) updateRecipe(slot, { [slot]: choice })
      closeTray()
      return
    }
    const chosen = recipe[slot]
    if (chosen.includes(choice)) {
      if (slot === "instruments" && chosen.length === 1) {
        // at least one instrument plays: the last one shakes its head instead
        setRefused((previous) => ({ id: choice, count: (previous?.count ?? 0) + 1 }))
        return
      }
      updateRecipe(slot, { [slot]: chosen.filter((entry) => entry !== choice) })
    } else {
      updateRecipe(slot, { [slot]: [...chosen, choice].slice(-(slot === "instruments" ? MAX_INSTRUMENTS : MAX_EFFECTS)) })
    }
  }

  const switchMode = (next: "builder" | "prompt") => {
    if (dirty) tuneIn()
    setOpen(null)
    setSoundDraft((draft) => ({ ...draft, mode: next }))
    focusWriter.current = next === "prompt"
  }

  const onStation = (station: string) => {
    setDirty(false)
    setOpen(null)
    setEdited(null)
    if (station !== controls.station) handlePetEvent("complete")
    selectStation(station)
  }

  const toggleDrums = () => setControls((current) => ({ ...current, drums: !current.drums }))

  const chargeOf = (slot: Slot) =>
    edited?.slot !== slot ? undefined : dirty ? "charging" : justTuned ? "tuned" : undefined

  const word = (slot: Slot, text: string, ghost = false) => (
    <Word
      label={TRAYS[slot].label}
      text={text}
      ghost={ghost}
      open={open === slot}
      charge={chargeOf(slot)}
      trayId={trayId}
      wordRef={(node) => { words.current[slot] = node }}
      onToggle={() => setOpen(open === slot ? null : slot)}
    />
  )

  const renderTray = (slot: Slot) => {
    const tray = TRAYS[slot]
    const single = slot === "mood" || slot === "vibe"
    return (
      <div className="word-tray" id={trayId} role="group" aria-label={`Choose ${tray.label.toLowerCase()}`}>
        <div className="word-tray-options" role={single ? "radiogroup" : undefined} aria-label={tray.label}>
          {tray.options.map((option, i) => {
            const chosen = single ? recipe[slot] === option.id : recipe[slot].includes(option.id)
            const last = slot === "instruments" && chosen && recipe.instruments.length === 1
            const shaking = refused?.id === option.id
            return (
              <button
                key={shaking ? `${option.id}-${refused!.count}` : option.id}
                type="button"
                className={`tray-option${shaking ? " is-refusing" : ""}`}
                style={{ "--i": i } as CSSProperties}
                role={single ? "radio" : undefined}
                aria-checked={single ? chosen : undefined}
                aria-pressed={single ? undefined : chosen}
                aria-disabled={last || undefined}
                title={last ? "At least one instrument plays" : undefined}
                onClick={() => pick(slot, option.id)}
              >
                <span className="tray-option-fill" aria-hidden />
                <span className="tray-option-label">{say(option)}</span>
              </button>
            )
          })}
        </div>
        <div className="word-tray-foot">
          <span>{tray.hint}</span>
          <button type="button" onClick={closeTray}>done</button>
        </div>
      </div>
    )
  }

  let status: ReactNode = null
  if (mode === "builder" && dirty) status = <span className="panel-state is-tuning">tuning in</span>
  else if (justTuned && isCurrent) status = <span key={tunedAt} className="panel-state is-tuned"><DotGlyph name="check" dot={1} />tuned in</span>
  else if (!isCurrent && !nextPrompt) status = <span className="panel-state">a few words will do</span>

  return (
    <div
      ref={rootRef}
      className="sound-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); closeTray() }
      }}
    >
      <StationPicker station={controls.station} onSelect={onStation} />

      <div className="sound-words">
        {mode === "builder" ? (
          <p className={`sentence${edited && dirty ? ` charge-${edited.count % 2}` : ""}`}>
            {word("mood", capitalized(say(MOODS.find((option) => option.id === recipe.mood))))}{" "}
            {word("vibe", say(VIBES.find((option) => option.id === recipe.vibe)))}
            <span className="sentence-glue">, played on </span>
            {word("instruments", sayAll(INSTRUMENTS, recipe.instruments))}
            <span className="sentence-glue">, </span>
            <Word label="Drums" text={controls.drums ? "with drums" : "no drums"} pressed={controls.drums} onToggle={toggleDrums} />
            <span className="sentence-glue">, and </span>
            {word("effects", recipe.effects.length ? sayAll(EFFECTS, recipe.effects) : "nothing extra", !recipe.effects.length)}
            <span className="sentence-glue">.</span>
          </p>
        ) : (
          <div className="writer">
            <textarea
              ref={writerRef}
              className="writer-input"
              value={prompt}
              rows={1}
              maxLength={MAX_CUSTOM_PROMPT_CHARS}
              placeholder="a rainy rooftop, soft piano, nowhere to be…"
              aria-label="Describe the music in your own words"
              aria-describedby={`${id}-count`}
              onChange={(event) => setSoundDraft((draft) => ({ ...draft, prompt: event.target.value.slice(0, MAX_CUSTOM_PROMPT_CHARS) }))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); tuneIn() }
              }}
            />
            <div className="writer-meta">
              <div className="writer-ideas">
                <span>try</span>
                {PROMPT_IDEAS.map((idea, i) => (
                  <button key={idea.label} type="button" style={{ "--i": i } as CSSProperties} onClick={() => setSoundDraft((draft) => ({ ...draft, prompt: idea.prompt }))}>{idea.label}</button>
                ))}
                <button type="button" style={{ "--i": PROMPT_IDEAS.length } as CSSProperties} onClick={() => setSoundDraft((draft) => ({ ...draft, prompt: buildSoundPrompt(draft.recipe) }))}>from the sentence</button>
              </div>
              <span id={`${id}-count`} className={`writer-count${prompt.length >= MAX_CUSTOM_PROMPT_CHARS - 10 ? " is-near" : ""}`} aria-label={`${prompt.length} of ${MAX_CUSTOM_PROMPT_CHARS} characters`}>{prompt.length}/{MAX_CUSTOM_PROMPT_CHARS}</span>
            </div>
          </div>
        )}

        {open && renderTray(open)}

        <div className="sound-foot">
          <div className="sound-foot-state">
            <p role="status">{status}</p>
            {canApply && !dirty && (
              <button type="button" className="tune-in" onClick={tuneIn}>
                tune in{mode === "prompt" && <kbd aria-hidden>↵</kbd>}
              </button>
            )}
          </div>
          <div className="sound-foot-actions">
            <button
              type="button"
              className={`foot-action reroll${rolling ? " is-rolling" : ""}`}
              onClick={requestVariation}
              disabled={!wantsAudio || rolling}
              aria-label="Skip to a new music variation"
              title="Same sound, a new take"
            >
              <span className="refresh-orbit" aria-hidden>
                <DotGlyph name="refresh" dot={1} className="refresh-arrow" />
              </span>
              {rolling ? "finding a take…" : "new take"}
            </button>
            <button type="button" className="foot-action write-toggle" onClick={() => switchMode(mode === "builder" ? "prompt" : "builder")}>
              <DotGlyph name={mode === "builder" ? "pen" : "chevron"} dot={1} className={mode === "builder" ? "write-toggle-pen" : "write-toggle-back"} />
              {mode === "builder" ? "write it yourself" : "back to the sentence"}
            </button>
          </div>
        </div>
      </div>

      <div className="fine-dials" role="group" aria-label="Fine adjustments">
        <FineDial
          label="style match"
          value={Math.round(controls.adherence * 100)}
          neutral={50}
          describe={styleWord}
          onChange={(value) => setControls((current) => ({ ...current, adherence: value / 100 }))}
        />
        <FineDial
          label="variation"
          value={Math.round(controls.variation * 100)}
          neutral={50}
          describe={variationWord}
          onChange={(value) => setControls((current) => ({ ...current, variation: value / 100 }))}
        />
        <FineDial label="volume" value={volume} describe={volumeWord} onChange={setVolume} />
      </div>
    </div>
  )
}

export default SoundPanel
