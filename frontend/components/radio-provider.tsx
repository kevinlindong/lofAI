"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { PetEvent, PetSignal } from "@/components/pet"
import { DEFAULT_LISTENER_CONTROLS, MrtStream, type StreamState } from "@/lib/mrt-stream"
import { LoadGovernor, setLowPower } from "@/lib/render-budget"
import { soundDraftFor, STATION_PRESETS, type RadioControls, type SoundDraft } from "@/lib/sound-recipe"

const IDLE_STATE: StreamState = {
  status: "idle", queuePosition: 0, listeners: 0, capacity: 0,
  message: null, bufferProgress: 0, variationPending: false,
}

function statusLabel(state: StreamState, wantsAudio: boolean): string {
  if (state.variationPending) return "finding a new take"
  switch (state.status) {
    case "loading": return state.message ?? "warming up the model"
    case "connecting": return state.message ?? "connecting"
    case "queued": return state.queuePosition > 0 ? `waiting for a slot · #${state.queuePosition}` : "waiting for a slot"
    case "buffering": return `catching up · ${Math.round(state.bufferProgress * 100)}%`
    case "live": return "live"
    case "paused": return "held"
    case "error": return state.message ?? "something broke"
    default: return wantsAudio ? "starting" : "ready"
  }
}

function useRadioState() {
  const [controls, setControls] = useState<RadioControls>({ ...DEFAULT_LISTENER_CONTROLS })
  const [soundDraft, setSoundDraft] = useState<SoundDraft>(() => soundDraftFor(DEFAULT_LISTENER_CONTROLS))
  const [volume, setVolume] = useState(100)
  const [wantsAudio, setWantsAudio] = useState(false)
  const [streamState, setStreamState] = useState<StreamState>(IDLE_STATE)
  const [petSignal, setPetSignal] = useState<PetSignal | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const streamRef = useRef<MrtStream | null>(null)
  const previousVolume = useRef(100)

  const selectStation = (station: string, overrides: Partial<RadioControls> = {}) => {
    const preset = STATION_PRESETS.find((entry) => entry.id === station)
    if (!preset) return
    setControls({ ...controls, ...overrides, station, customPrompt: "", recipe: undefined })
    setSoundDraft((draft) => ({ ...draft, mode: "builder", recipe: preset.recipe }))
  }

  useEffect(() => {
    // The governor turns on low-power rendering when the model is short of
    // headroom on this machine (lib/render-budget).
    const stream = new MrtStream(setStreamState, new LoadGovernor())
    streamRef.current = stream
    return () => {
      stream.destroy()
      streamRef.current = null
      setLowPower(false)
    }
  }, [])

  useEffect(() => { streamRef.current?.setControls(controls) }, [controls])
  useEffect(() => { streamRef.current?.setVolume(volume / 100) }, [volume])
  useEffect(() => {
    if (streamState.status === "error" && wantsAudio) setWantsAudio(false)
  }, [streamState.status, wantsAudio])

  const pausePlayback = useCallback(() => {
    streamRef.current?.pause()
    setWantsAudio(false)
  }, [])

  const togglePlayback = useCallback(async () => {
    if (!streamRef.current) return
    if (wantsAudio) { pausePlayback(); return }
    setWantsAudio(true)
    await streamRef.current.start(controls)
  }, [wantsAudio, controls, pausePlayback])

  const requestVariation = useCallback(() => { streamRef.current?.newVariation() }, [])
  const getLevel = useCallback(() => streamRef.current?.level() ?? 0, [])
  const getSpectrum = useCallback((out: Uint8Array) => streamRef.current?.spectrum(out) ?? 0, [])
  const handlePetEvent = useCallback((kind: PetEvent) => { setPetSignal({ kind, at: Date.now() }) }, [])
  const toggleMute = useCallback(() => {
    if (volume > 0) { previousVolume.current = volume; setVolume(0) }
    else setVolume(previousVolume.current || 60)
  }, [volume])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey ||
        target.closest("input, textarea, select, button, a, summary, [contenteditable], dialog")) return
      if (event.code === "Space") { event.preventDefault(); void togglePlayback() }
      if (event.key.toLowerCase() === "m") toggleMute()
      if (event.key.toLowerCase() === "n" && wantsAudio && !streamState.variationPending) requestVariation()
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [togglePlayback, toggleMute, requestVariation, wantsAudio, streamState.variationPending])

  const label = useMemo(() => statusLabel(streamState, wantsAudio), [streamState, wantsAudio])
  return {
    controls, setControls, soundDraft, setSoundDraft, selectStation,
    volume, setVolume, wantsAudio, streamState,
    isLive: streamState.status === "live", petSignal, focusMode, setFocusMode,
    togglePlayback, requestVariation, getLevel, getSpectrum, handlePetEvent,
    toggleMute, label,
  }
}

const RadioContext = createContext<ReturnType<typeof useRadioState> | null>(null)

export function RadioProvider({ children }: { children: ReactNode }) {
  const radio = useRadioState()
  return <RadioContext.Provider value={radio}>{children}</RadioContext.Provider>
}

export function useRadio() {
  const radio = useContext(RadioContext)
  if (!radio) throw new Error("useRadio must be used within RadioProvider")
  return radio
}
