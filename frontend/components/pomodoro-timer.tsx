"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { DotGlyph } from "@/components/dot-glyph"
import { FineDial } from "@/components/fine-dial"

interface PomodoroTimerProps {
  onRunningChange: (running: boolean) => void
}

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.ceil(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}

export function PomodoroTimer({ onRunningChange }: PomodoroTimerProps) {
  const [workDuration, setWorkDuration] = useState(25)
  const [breakDuration, setBreakDuration] = useState(5)
  const [isBreak, setIsBreak] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [timeLeft, setTimeLeft] = useState(25 * 60)
  // counts presses only to replay the reset key's whoosh
  const [rewinds, setRewinds] = useState(0)
  // a pointer that has just arrived on the play key. only it gets the tug, so
  // a cursor left resting there after a pause isn't nagged to start again
  const [eager, setEager] = useState(false)

  // the phase ends at a wall-clock instant, not after N ticks. counting ticks
  // drifts, and drifts more the longer the tab is backgrounded.
  const deadlineRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // the interval closes over the phase; a ref is the only copy it can trust
  const isBreakRef = useRef(isBreak)
  isBreakRef.current = isBreak

  const total = (isBreak ? breakDuration : workDuration) * 60

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

  useEffect(() => {
    onRunningChange(isRunning && !isBreak)
  }, [isRunning, isBreak, onRunningChange])

  useEffect(() => {
    if (!isRunning) return
    const id = setInterval(() => {
      const left = (deadlineRef.current - Date.now()) / 1000
      if (left <= 0) {
        setTimeLeft(0)
        setIsRunning(false)
        void audioRef.current?.play().catch(() => {})
        const wasBreak = isBreakRef.current
        setIsBreak(!wasBreak)
        setTimeLeft((wasBreak ? workDuration : breakDuration) * 60)
        return
      }
      setTimeLeft(left)
    }, 200)
    return () => clearInterval(id)
  }, [isRunning, workDuration, breakDuration])

  const toggle = useCallback(() => {
    setIsRunning((running) => {
      if (running) return false
      deadlineRef.current = Date.now() + timeLeft * 1000
      return true
    })
  }, [timeLeft])

  const reset = useCallback(() => {
    setIsRunning(false)
    setIsBreak(false)
    setTimeLeft(workDuration * 60)
  }, [workDuration])

  const rewind = useCallback(() => {
    reset()
    setRewinds((n) => n + 1)
  }, [reset])

  const setPhaseDuration = (minutes: number, forBreak: boolean) => {
    if (forBreak) setBreakDuration(minutes)
    else setWorkDuration(minutes)
    if (!isRunning && isBreak === forBreak) setTimeLeft(minutes * 60)
  }

  const elapsed = total > 0 ? 1 - timeLeft / total : 0
  const progress = `${Math.min(1, Math.max(0, elapsed)) * 100}%`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="label">{isBreak ? "Break" : "Focus"}</span>
        <span className="label">{isRunning ? "running" : "held"}</span>
      </div>

      <div className="flex items-center justify-between gap-4">
        <span
          className="tabular-nums leading-none"
          style={{
            fontSize: "2.6rem",
            letterSpacing: "0.02em",
            color: isRunning ? "var(--accent)" : "var(--text)",
          }}
        >
          {formatTime(timeLeft)}
        </span>

        <div className="timer-keys">
          <button
            type="button"
            onClick={() => {
              setEager(false)
              toggle()
            }}
            onPointerEnter={(event) => setEager(event.pointerType !== "touch")}
            onPointerDown={() => setEager(false)}
            onPointerLeave={() => setEager(false)}
            className="key timer-key timer-toggle"
            data-running={isRunning || undefined}
            data-eager={eager || undefined}
            aria-label={isRunning ? "Pause timer" : "Start timer"}
          >
            <span className="timer-face">
              <DotGlyph name={isRunning ? "pauseSmall" : "playSmall"} dot={2} morph className="timer-glyph" />
            </span>
          </button>
          <button type="button" onClick={rewind} className="key timer-key timer-reset" aria-label="Reset timer">
            {/* remounted per press, so the whoosh replays every time */}
            <span key={rewinds} className="timer-face" data-rewinding={rewinds > 0 || undefined}>
              <DotGlyph name="rewind" dot={2} className="timer-glyph" />
            </span>
          </button>
        </div>
      </div>

      <div
        className="flow-meter"
        style={{ "--progress": progress } as CSSProperties}
        role="progressbar"
        aria-label={`${isBreak ? "Break" : "Focus"} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(elapsed * 100)}
      >
        <span />
      </div>

      <div className="grid grid-cols-2 gap-x-5 gap-y-3">
        <FineDial
          label="Work"
          formatValue={(minutes) => `${minutes} min`}
          value={workDuration}
          min={1}
          max={60}
          neutral={25}
          disabled={isRunning}
          disabledReason="Pause the timer to adjust"
          onChange={(v) => setPhaseDuration(v, false)}
        />
        <FineDial
          label="Rest"
          formatValue={(minutes) => `${minutes} min`}
          value={breakDuration}
          min={1}
          max={30}
          neutral={5}
          disabled={isRunning}
          disabledReason="Pause the timer to adjust"
          onChange={(v) => setPhaseDuration(v, true)}
        />
      </div>
    </div>
  )
}

export default PomodoroTimer
