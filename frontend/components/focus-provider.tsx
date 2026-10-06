"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRadio } from "@/components/radio-provider"
import { useTasks } from "@/components/tasks-provider"
import {
  SESSIONS_KEY, TIMER_KEY, clampRest, clampWork, mergeSessions, parseSessions, parseTimerPrefs, recordSession, serializeSessions, serializeTimerPrefs,
  type FocusPhase, type FocusSession, type Landing,
} from "@/lib/focus-store"

export type { FocusPhase, FocusSession, Landing } from "@/lib/focus-store"

export interface FocusApi {
  phase: FocusPhase; running: boolean; workMin: number; restMin: number; totalSec: number
  landing: Landing | null; sessions: FocusSession[]; saveError: string
  toggle(): void; start(o?: { minutes?: number; phase?: FocusPhase }): void; pause(): void
  reset(): void; rewind(): void; setDuration(phase: FocusPhase, minutes: number): void
  dismissLanding(): void
}
export interface FocusClock { timeLeft: number; elapsed: number }

// two contexts, so the 200ms tick re-renders only what shows the time
const FocusContext = createContext<FocusApi | null>(null)
const FocusClockContext = createContext<FocusClock | null>(null)

const SAVE_ERROR = "This browser couldn't save your focus time. It's here for this visit."

// The timer lives here rather than in its widget, so it keeps running while
// the widget is resized or put away.
export function FocusProvider({ children }: { children: ReactNode }) {
  const { setFocusMode } = useRadio()
  const { activeTaskId } = useTasks()
  const [workMin, setWorkMin] = useState(25)
  const [restMin, setRestMin] = useState(5)
  const [isBreak, setIsBreak] = useState(false)
  const [running, setRunning] = useState(false)
  const [timeLeft, setTimeLeft] = useState(25 * 60)
  // a one-off block length ("another little bit"); null means the phase's own
  const [blockSec, setBlockSec] = useState<number | null>(null)
  const [landing, setLanding] = useState<Landing | null>(null)
  const [sessions, setSessions] = useState<FocusSession[]>([])
  const [saveError, setSaveError] = useState("")

  // the phase ends at a wall-clock instant, not after N ticks. counting ticks
  // drifts, and drifts more the longer the tab is backgrounded.
  const deadlineRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // when this focus block first started, for the session log
  const blockStartRef = useRef<number | null>(null)
  const sessionsRef = useRef<FocusSession[]>([])
  // the interval and the stable callbacks close over these; refs are the
  // only copies they can trust
  const live = useRef({ isBreak, running, timeLeft, workMin, restMin, blockSec, activeTaskId })
  live.current = { isBreak, running, timeLeft, workMin, restMin, blockSec, activeTaskId }

  const totalSec = blockSec ?? (isBreak ? restMin : workMin) * 60

  useEffect(() => {
    const audio = new Audio("/timer-end.mp3")
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
      if (audioRef.current === audio) audioRef.current = null
    }
  }, [])

  // durations persist; the session and phase still start fresh on reload
  useEffect(() => {
    let prefs = parseTimerPrefs(null)
    try { prefs = parseTimerPrefs(localStorage.getItem(TIMER_KEY)) } catch { /* defaults */ }
    setWorkMin(prefs.work); setRestMin(prefs.rest); setTimeLeft(prefs.work * 60)
    try { sessionsRef.current = parseSessions(localStorage.getItem(SESSIONS_KEY), Date.now()) } catch { /* an empty log */ }
    setSessions(sessionsRef.current)
  }, [])

  useEffect(() => {
    setFocusMode(running && !isBreak)
  }, [running, isBreak, setFocusMode])

  const record = useCallback((session: FocusSession) => {
    const now = Date.now()
    // re-read first, so another tab's blocks aren't written over, and keep
    // this tab's too: after a failed write the stored copy is behind
    let saved: FocusSession[] = []
    try { saved = parseSessions(localStorage.getItem(SESSIONS_KEY), now) } catch { /* this tab's copy */ }
    const next = recordSession(mergeSessions(saved, sessionsRef.current), session, now)
    sessionsRef.current = next
    setSessions(next)
    try { localStorage.setItem(SESSIONS_KEY, serializeSessions(next)); setSaveError("") }
    catch { setSaveError(SAVE_ERROR) }
  }, [])

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const left = (deadlineRef.current - Date.now()) / 1000
      if (left <= 0) {
        setTimeLeft(0)
        setRunning(false)
        void audioRef.current?.play().catch(() => {})
        const { isBreak: wasBreak, workMin: work, restMin: rest, blockSec: block, activeTaskId: taskId } = live.current
        if (!wasBreak) {
          const end = deadlineRef.current
          const minutes = (block ?? work * 60) / 60
          record({ start: blockStartRef.current ?? end - minutes * 60000, end, minutes, taskId })
          setLanding({ at: end, minutes, taskId })
        }
        blockStartRef.current = null
        setBlockSec(null)
        setIsBreak(!wasBreak)
        setTimeLeft((wasBreak ? work : rest) * 60)
        return
      }
      setTimeLeft(left)
    }, 200)
    return () => clearInterval(id)
  }, [running, record])

  const start = useCallback((o: { minutes?: number; phase?: FocusPhase } = {}) => {
    const now = live.current
    const toBreak = o.phase ? o.phase === "rest" : now.isBreak
    if (now.running && toBreak === now.isBreak && o.minutes === undefined) return
    let left = now.timeLeft
    if (o.minutes !== undefined || toBreak !== now.isBreak) {
      const block = o.minutes !== undefined ? Math.max(1, Math.round(o.minutes)) * 60 : null
      left = block ?? (toBreak ? now.restMin : now.workMin) * 60
      setIsBreak(toBreak); setBlockSec(block); setTimeLeft(left)
      blockStartRef.current = null
    }
    if (!toBreak && blockStartRef.current === null) blockStartRef.current = Date.now()
    deadlineRef.current = Date.now() + left * 1000
    setLanding(null)
    setRunning(true)
  }, [])

  const pause = useCallback(() => setRunning(false), [])
  const toggle = useCallback(() => { if (live.current.running) pause(); else start() }, [pause, start])

  const reset = useCallback(() => {
    setRunning(false)
    setIsBreak(false)
    setBlockSec(null)
    setTimeLeft(live.current.workMin * 60)
    setLanding(null)
    blockStartRef.current = null
  }, [])
  // the reset key. the whoosh it replays is the widget's own
  const rewind = useCallback(() => reset(), [reset])

  // changing a duration only restarts the clock when it's held on that phase
  const setDuration = useCallback((phase: FocusPhase, minutes: number) => {
    const forBreak = phase === "rest"
    const value = forBreak ? clampRest(minutes) : clampWork(minutes)
    const { running: isRunning, isBreak: onBreak, workMin: work, restMin: rest } = live.current
    if (forBreak) setRestMin(value)
    else setWorkMin(value)
    if (!isRunning && onBreak === forBreak) {
      setTimeLeft(value * 60); setBlockSec(null)
      blockStartRef.current = null
    }
    try { localStorage.setItem(TIMER_KEY, serializeTimerPrefs(forBreak ? { work, rest: value } : { work: value, rest })); setSaveError("") }
    catch { setSaveError(SAVE_ERROR) }
  }, [])

  const dismissLanding = useCallback(() => setLanding(null), [])

  const api = useMemo<FocusApi>(() => ({
    phase: isBreak ? "rest" : "focus", running, workMin, restMin, totalSec, landing, sessions, saveError,
    toggle, start, pause, reset, rewind, setDuration, dismissLanding,
  }), [isBreak, running, workMin, restMin, totalSec, landing, sessions, saveError, toggle, start, pause, reset, rewind, setDuration, dismissLanding])

  const elapsed = totalSec > 0 ? Math.min(1, Math.max(0, 1 - timeLeft / totalSec)) : 0
  const clock = useMemo<FocusClock>(() => ({ timeLeft, elapsed }), [timeLeft, elapsed])

  return <FocusContext.Provider value={api}>
    <FocusClockContext.Provider value={clock}>{children}</FocusClockContext.Provider>
  </FocusContext.Provider>
}

export function useFocus(): FocusApi {
  const api = useContext(FocusContext)
  if (!api) throw new Error("useFocus must be used within FocusProvider")
  return api
}

export function useFocusClock(): FocusClock {
  const clock = useContext(FocusClockContext)
  if (!clock) throw new Error("useFocusClock must be used within FocusProvider")
  return clock
}
