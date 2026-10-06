"use client"

import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { DotGlyph } from "@/components/dot-glyph"
import { FineDial } from "@/components/fine-dial"
import { RollingText } from "@/components/rolling-text"
import { StationPicker } from "@/components/station-picker"
import { useRadio } from "@/components/radio-provider"
import { MAX_CUSTOM_PROMPT_CHARS } from "@/lib/mrt-stream"
import {
  buildSoundPrompt, CUSTOM_STATION, EFFECTS, INSTRUMENTS, MAX_EFFECTS, MAX_INSTRUMENTS,
  MOODS, sameRecipe, spokenWord, STATION_PRESETS, stationFor, VIBES, type SoundOption, type SoundRecipe,
} from "@/lib/sound-recipe"

type Slot = "mood" | "vibe" | "instruments" | "effects"

// Edits to the sentence tune in by themselves once the listener pauses, so a
// few quick picks become one style change for the model rather than several.
// The edited word's underline fills over this time as the countdown.
const TUNE_DELAY_MS = 900
const TUNED_FLASH_MS = 1600

const say = spokenWord
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

// The die on "new take". Every new take throws it: the count picks the face
// and the angle it comes to rest at, and the key restarts the tumble. Only the
// tile is swapped for each throw, so the hand's pose (tipped, crouched) springs
// straight into the hop instead of snapping upright first.
const DIE_FACES = ["die5", "die3", "die6", "die2", "die4", "die1"] as const
const DIE_TILTS = [-8, 7, -4, 10, -11, 4]

// memoized: the panel re-renders on every dial step, and the die only answers `rolling`
const TakeDie = memo(function TakeDie({ rolling }: { rolling: boolean }) {
  const body = useRef<HTMLSpanElement>(null)
  const [take, setTake] = useState({ count: 0, throws: 0 })
  // a layout effect, so the frame before the throw never paints
  useLayoutEffect(() => {
    if (!rolling) return
    // a take that arrives mid-air only changes the face it comes down on
    const airborne = body.current?.getAnimations?.().some((animation) => animation.playState === "running")
    setTake(({ count, throws }) => ({ count: count + 1, throws: airborne ? throws : throws + 1 }))
  }, [rolling])
  const face = take.count % DIE_FACES.length
  return (
    <span className="take-die" style={{ "--face": face, "--tilt": `${DIE_TILTS[face]}deg` } as CSSProperties} aria-hidden>
      <span ref={body} key={take.throws} className="take-die-body" data-thrown={take.throws > 0 || undefined}>
        <span className="take-die-faces">
          {DIE_FACES.map((name) => <DotGlyph key={name} name={name} dot={3} />)}
        </span>
      </span>
    </span>
  )
})

// onExpandedChange: a word tray is open. On the desk that's a transient
// expansion over the neighbours rather than a change in the panel's height.
export function SoundPanel({ onExpandedChange }: { onExpandedChange?: (open: boolean) => void } = {}) {
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
  // the preset on air, named or mixed; none when the sound is the listener's own
  const playing = stationFor(controls)
  const currentRecipe = playing?.recipe ?? controls.recipe
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

  // before the frame's observer sees the tray
  const expandedChange = useRef(onExpandedChange)
  expandedChange.current = onExpandedChange
  useLayoutEffect(() => {
    if (!open) return
    const report = expandedChange.current
    report?.(true)
    return () => report?.(false)
  }, [open])

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
    if (station !== playing?.id) handlePetEvent("complete")
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
      // data-no-lift: a press in an open tray is a choice, never the start of a drag
      <div className="word-tray" id={trayId} role="group" aria-label={`Choose ${tray.label.toLowerCase()}`} data-no-lift>
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
      <StationPicker station={playing?.id ?? CUSTOM_STATION} onSelect={onStation} />

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
              title={wantsAudio || rolling ? "Same sound, a new take" : "Play first, then roll a new take"}
            >
              <TakeDie rolling={rolling} />
              <span className="reroll-label"><span>new take</span><span>rolling…</span></span>
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
