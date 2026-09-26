"use client"

import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { STATION_PRESETS } from "@/lib/sound-recipe"

interface StationPickerProps {
  station: string
  onSelect: (station: string) => void
}

interface Pill {
  left: number
  right: number
  top: number
  height: number
  // which edge leads, so the pill stretches toward where it is going
  heading: "left" | "right" | null
}

// Four stations and, when the sound is your own, a fifth "your mix". One pill
// sits behind whichever is playing: its leading edge sets off first and the
// trailing edge follows, so it stretches across and lands with a small squash.
export function StationPicker({ station, onSelect }: StationPickerProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<Pill | null>(null)
  const index = STATION_PRESETS.findIndex((preset) => preset.id === station)
  const custom = index === -1

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const place = () => {
      const target = row.querySelector<HTMLElement>("[data-active]")
      if (!target) return
      setPill((previous) => {
        const left = target.offsetLeft
        const right = row.clientWidth - left - target.offsetWidth
        const heading = !previous || previous.top !== target.offsetTop ? null : left > previous.left ? "right" : left < previous.left ? "left" : previous.heading
        return { left, right, top: target.offsetTop, height: target.offsetHeight, heading }
      })
    }
    place()
    const watch = new ResizeObserver(place)
    watch.observe(row)
    return () => watch.disconnect()
  }, [station, custom])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const count = STATION_PRESETS.length
    const next = {
      ArrowLeft: (from - 1 + count) % count, ArrowUp: (from - 1 + count) % count,
      ArrowRight: (from + 1) % count, ArrowDown: (from + 1) % count,
      Home: 0, End: count - 1,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    onSelect(STATION_PRESETS[next].id)
    rowRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  const pillStyle = pill && ({
    left: pill.left, right: pill.right, top: pill.top, height: pill.height,
  } as CSSProperties)

  return (
    <div ref={rowRef} className="stations" role="radiogroup" aria-label="Station">
      {pill && (
        <span className="stations-pill" style={pillStyle!} data-heading={pill.heading ?? undefined} aria-hidden>
          <span key={station} className="stations-pill-body" />
        </span>
      )}
      {STATION_PRESETS.map((preset, i) => (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={i === index}
          data-active={i === index || undefined}
          tabIndex={i === index || (custom && i === 0) ? 0 : -1}
          className="station"
          title={preset.description}
          onClick={() => onSelect(preset.id)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          {preset.label.toLowerCase()}
        </button>
      ))}
      {custom && <span className="station is-yours" data-active>your mix</span>}
    </div>
  )
}

export default StationPicker
