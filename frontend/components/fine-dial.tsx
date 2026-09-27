"use client"

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react"
import { RollingText } from "@/components/rolling-text"

interface FineDialProps {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  disabled?: boolean
  disabledReason?: string
  formatValue?: (value: number) => string
  // the dial's word for a value, shown beside the number
  describe?: (value: number) => string
  // where a double-click returns to, marked on the rail; the fill grows from
  // here, and a coarse drag clicks into it
  neutral?: number
}

// Dragging away from the rail slows it down, like a video scrubber: past the
// first distance a pixel moves a quarter as far, past the second a tenth.
// Shift does the same from anywhere.
const FINE_DISTANCE = 28
const FINER_DISTANCE = 84
// how close a coarse drag has to come to neutral to click into it
const DETENT = 2
const TICKS = Array.from({ length: 11 }, (_, i) => i * 10)

type Speed = 1 | 0.25 | 0.1

const clamp = (value: number) => Math.max(0, Math.min(100, value))

export function FineDial({ label, value, onChange, describe, neutral, min = 0, max = 100, disabled = false, disabledReason, formatValue }: FineDialProps) {
  const id = useId()
  const railRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLSpanElement>(null)
  // the unrounded position, so slow drags still move between whole numbers
  const drag = useRef<{ pointerId: number; x: number; t: number; exact: number; moved: boolean } | null>(null)
  // how far the thumb leans into the drag, -1..1, eased toward `leanTarget`
  const lean = useRef({ now: 0, target: 0, frame: 0 })
  const reducedMotion = useRef(false)
  const [speed, setSpeed] = useState<Speed | null>(null)
  const [moving, setMoving] = useState(false)
  const [clicks, setClicks] = useState(0)

  const endDrag = useCallback(() => {
    const pointerId = drag.current?.pointerId
    drag.current = null
    setSpeed(null)
    setMoving(false)
    cancelAnimationFrame(lean.current.frame)
    lean.current.frame = 0
    // let go: the lean springs back upright through the CSS transition
    lean.current.target = 0
    lean.current.now = 0
    thumbRef.current?.style.setProperty("--lean", "0")
    if (pointerId !== undefined && railRef.current?.hasPointerCapture(pointerId)) {
      railRef.current.releasePointerCapture(pointerId)
    }
  }, [])

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)")
    const state = lean.current
    const updateMotion = () => {
      reducedMotion.current = preference.matches
      if (preference.matches) {
        cancelAnimationFrame(state.frame)
        state.frame = 0
        state.now = 0
        state.target = 0
        thumbRef.current?.style.setProperty("--lean", "0")
      }
    }
    updateMotion()
    preference.addEventListener("change", updateMotion)
    return () => {
      preference.removeEventListener("change", updateMotion)
      cancelAnimationFrame(state.frame)
    }
  }, [])

  useEffect(() => {
    if (disabled) endDrag()
  }, [disabled, endDrag])

  const toPercent = (number: number) => clamp(((number - min) / (max - min)) * 100)
  const fromPercent = (percent: number) => min + (percent / 100) * (max - min)
  const neutralPosition = neutral === undefined ? undefined : toPercent(neutral)

  const commit = (next: number) => {
    if (disabled) return
    const rounded = Math.max(min, Math.min(max, Math.round(next)))
    if (rounded !== value) onChange(rounded)
  }

  const positionAt = (clientX: number) => {
    const rect = railRef.current!.getBoundingClientRect()
    return clamp(((clientX - rect.left) / rect.width) * 100)
  }

  // The thumb leans and stretches with the speed of the drag, then eases
  // upright when the hand slows. Written straight to the element: this runs
  // every frame of a drag and nothing else needs to re-render for it.
  const animateLean = () => {
    const state = lean.current
    state.now += (state.target - state.now) * 0.3
    state.target *= 0.82
    thumbRef.current?.style.setProperty("--lean", state.now.toFixed(3))
    state.frame = drag.current ? requestAnimationFrame(animateLean) : 0
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || !event.isPrimary || drag.current) return
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const exact = positionAt(event.clientX)
    drag.current = { pointerId: event.pointerId, x: event.clientX, t: event.timeStamp, exact, moved: false }
    setSpeed(1)
    // the first press glides the thumb to the pointer; after that it follows
    commit(fromPercent(exact))
    cancelAnimationFrame(lean.current.frame)
    if (!reducedMotion.current) lean.current.frame = requestAnimationFrame(animateLean)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (disabled || !state || event.pointerId !== state.pointerId) return
    const rect = railRef.current!.getBoundingClientRect()
    const away = Math.abs(event.clientY - (rect.top + rect.height / 2))
    const next: Speed = away > FINER_DISTANCE ? 0.1 : away > FINE_DISTANCE || event.shiftKey ? 0.25 : 1
    const dx = event.clientX - state.x
    const dt = Math.max(1, event.timeStamp - state.t)
    lean.current.target = Math.max(-1, Math.min(1, (dx / dt) * 0.9))
    state.exact = next === 1 ? positionAt(event.clientX) : clamp(state.exact + (dx / rect.width) * 100 * next)
    state.x = event.clientX
    state.t = event.timeStamp
    if (!state.moved && dx !== 0) { state.moved = true; setMoving(true) }
    if (next !== speed) setSpeed(next)

    let target = state.exact
    if (next === 1 && neutralPosition !== undefined && Math.abs(state.exact - neutralPosition) <= DETENT) {
      target = neutralPosition
      if (value !== neutral) {
        setClicks((count) => count + 1)
        navigator.vibrate?.(6)
      }
    }
    commit(fromPercent(target))
  }

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId === drag.current?.pointerId) endDrag()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step = event.shiftKey ? 10 : 1
    const next = {
      ArrowLeft: value - step, ArrowDown: value - step, ArrowRight: value + step, ArrowUp: value + step,
      PageDown: value - 10, PageUp: value + 10, Home: min, End: max,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    commit(next)
  }

  const reset = () => {
    if (disabled || neutral === undefined || value === neutral) return
    commit(neutral)
    setClicks((count) => count + 1)
  }

  const position = toPercent(value)
  const from = neutralPosition ?? 0
  const style = {
    "--at": `${position}%`,
    "--fill-start": `${Math.min(from, position)}%`,
    "--fill-size": `${Math.abs(position - from)}%`,
  } as CSSProperties
  const word = describe?.(value) ?? ""
  const readout = formatValue?.(value) ?? `${value}`
  const state = [
    "fine-dial",
    disabled && "is-disabled",
    speed && "is-held",
    moving && "is-dragging",
    speed && speed < 1 && "is-fine",
    neutral !== undefined && value === neutral && "is-neutral",
  ].filter(Boolean).join(" ")

  return (
    <div className={state} style={style}>
      <div className="fine-dial-head">
        <span id={`${id}-label`} className="fine-dial-label">{label}</span>
        <span className="fine-dial-readout" aria-hidden>
          {speed && speed < 1 && <span className="fine-dial-speed">{speed === 0.25 ? "fine" : "finer"}</span>}
          {word && <span className="fine-dial-word"><RollingText text={word} /></span>}
          <span className="fine-dial-value">{readout}</span>
        </span>
      </div>
      <div
        ref={railRef}
        className="fine-dial-rail"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-disabled={disabled || undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={word ? `${readout}, ${word}` : readout}
        title={disabled ? disabledReason : neutral === undefined ? "Drag away from the line for finer steps" : "Drag away from the line for finer steps · double-click to reset"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onKeyDown={onKeyDown}
        onDoubleClick={reset}
      >
        <span className="fine-dial-track" aria-hidden />
        <span className="fine-dial-fill" aria-hidden />
        <span className="fine-dial-comb" aria-hidden />
        <span className="fine-dial-ticks" aria-hidden>
          {TICKS.map((tick) => <i key={tick} style={{ left: `${tick}%` }} data-on={(tick >= Math.min(from, position) && tick <= Math.max(from, position)) || undefined} />)}
        </span>
        {neutralPosition !== undefined && <span key={clicks} className="fine-dial-notch" style={{ left: `${neutralPosition}%` }} data-clicked={clicks > 0 || undefined} aria-hidden />}
        <span ref={thumbRef} className="fine-dial-thumb" aria-hidden />
      </div>
    </div>
  )
}

export default FineDial
