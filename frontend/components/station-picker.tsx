"use client"

import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react"
import { GLYPHS } from "@/components/dot-glyph"
import { CUSTOM_STATION, STATION_PRESETS } from "@/lib/sound-recipe"

interface StationPickerProps {
  // the preset on air, or the custom station when the sound is your own
  station: string
  onSelect: (station: string) => void
}

interface Needle {
  // centre of the playing station, or the middle of the dial for your mix
  x: number
  // top and height of that station's column; the dial runs along its foot
  y: number
  height: number
  // which way it last travelled, so it swings back against the move
  heading: "left" | "right" | null
  // it changed rows: rather than fly across the gap it hops, rising out of the dial
  jump: boolean
  // how many stations it crossed, so a long trip takes a little longer
  hops: number
  // where it points, and whether that has changed since the page opened
  station: string
  moved: boolean
}

// A little picture for each station, struck on the same dot grid as the
// icons. "X" dots always show; "a" dots only at rest and "b" dots only in the
// second frame, which a station shows while it plays or under the pointer:
// the sun beams, steam curls off the cup, the lamp switches on, the rain
// steps down and the Z floats up. The owl's "o" and "c" are its eyes open
// and shut, for a blink.
const EMBLEMS: Record<string, readonly string[]> = {
  "sunlit-groove": ["b...X...b", ".X.....X.", "...XXX...", "XbXXXXXbX", "...XXX...", ".X.....X.", "b...X...b"],
  "seaside-bossa": ["....X....", "....XX...", "....XXX..", "....XXXX.", "....X....", "XXXXXXXXX", ".XXXXXXX."],
  "dusty-beats": ["..XXX..", ".XXXXX.", "XX...XX", "XX.X.XX", "XX...XX", ".XXXXX.", "..XXX.."],
  "jazz-cafe": ["..ab.ab..", ".ba.ba...", ".XXXXXX..", ".XXXXXXXX", ".XXXXXX.X", ".XXXXXXXX", "..XXXX..."],
  "desk-lamp": ["..XXXX...", ".X....X..", ".X...XXX.", ".X..XXXXX", ".X...b.b.", ".X..b.b.b", "XXX......"],
  "rainy-piano": ["..XX.....", ".XXXX.XX.", "XXXXXXXXX", ".........", "a.ba.ba.b", ".b..b..b.", "b.ab.ab.a"],
  "night-owl": ["X.......X", ".oo...oo.", "o..o.o..o", "XccX.XccX", ".XX.X.XX.", ".X.....X.", "..XXXXX.."],
  "cloud-nap": ["..XX.bbbb", ".XX..aaXa", "XX....ba.", "XX...bXbb", "XX...aaaa", ".XX......", "..XX....."],
}

// DotPattern's grid with each dot tagged by frame. Drawn once: the panel
// re-renders on every step of a dial drag, and these never change.
const Emblem = memo(function Emblem({ id }: { id: string }) {
  const rows = EMBLEMS[id] ?? GLYPHS.music
  const grid = { gridTemplateColumns: `repeat(${rows[0].length}, 2px)`, gridTemplateRows: `repeat(${rows.length}, 2px)` }
  return (
    <span className="station-emblem" aria-hidden>
      <span className="station-glyph" style={grid}>
        {rows.flatMap((row, r) => row.split("").flatMap((dot, c) => dot === "." ? [] : [
          <span key={`${r}-${c}`} data-frame={dot === "X" ? undefined : dot} style={{ gridArea: `${r + 1} / ${c + 1}` }} />,
        ]))}
      </span>
    </span>
  )
})

// Every station is a mark on a little radio dial. One needle stands on the
// dial under whichever is playing: it glides over, swings back against the
// move and settles. Your own mix sits between stations, in the middle of the
// dial, so nothing along it has to shift to make room.
export function StationPicker({ station, onSelect }: StationPickerProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [needle, setNeedle] = useState<Needle | null>(null)
  const index = STATION_PRESETS.findIndex((preset) => preset.id === station)
  const custom = index === -1

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const place = () => {
      const target = row.querySelector<HTMLElement>("[data-active]")
      const stations = row.querySelectorAll<HTMLElement>(".station")
      // your mix parks on the last row, so its tag hangs clear of the others
      const foot = target ?? stations[stations.length - 1]
      if (!foot) return
      setNeedle((previous) => {
        const x = target ? target.offsetLeft + target.offsetWidth / 2 : row.clientWidth / 2
        const spot = { x, y: foot.offsetTop, height: foot.offsetHeight, station }
        // a resize only follows along; it never replays the swing
        if (!previous || previous.station === station) {
          return { heading: null, jump: false, hops: 0, moved: false, ...previous, ...spot }
        }
        const jump = previous.y !== spot.y
        const heading = jump ? null : x > previous.x ? "right" : x < previous.x ? "left" : previous.heading
        const hops = Math.round((Math.abs(x - previous.x) / foot.offsetWidth) * 100) / 100
        return { ...spot, heading, jump, hops, moved: true }
      })
    }
    place()
    const watch = new ResizeObserver(place)
    watch.observe(row)
    return () => watch.disconnect()
  }, [station])

  // Where the needle stands. It follows the station a moment later, once it
  // has measured the trip, so what happens on landing is timed to the trip.
  const at = needle?.station
  const parked = at !== undefined && !STATION_PRESETS.some((preset) => preset.id === at)

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

  return (
    <div
      ref={rowRef}
      className="stations"
      role="radiogroup"
      aria-label="Station"
      data-moved={needle?.moved || undefined}
      data-heading={needle?.heading ?? undefined}
      data-jump={needle?.jump || undefined}
      style={{ "--count": STATION_PRESETS.length, "--hops": needle?.hops ?? 0 } as CSSProperties}
    >
      {STATION_PRESETS.map((preset, i) => (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={i === index}
          data-active={i === index || undefined}
          tabIndex={i === index || (custom && i === 0) ? 0 : -1}
          className="station"
          data-station={preset.id}
          data-on={at === preset.id || undefined}
          title={preset.description}
          onClick={() => onSelect(preset.id)}
          onKeyDown={(event) => onKeyDown(event, i)}
        >
          <Emblem id={preset.id} />
          <span className="station-name">{preset.label.toLowerCase()}</span>
        </button>
      ))}
      {needle && (
        <>
          {/* its own layer, so the light sits behind the stations rather than over them */}
          <span className="stations-carriage stations-backlight" style={{ transform: `translate(${needle.x}px, ${needle.y}px)` }} aria-hidden>
            {!parked && <span key={at} className="stations-glow" />}
          </span>
          <span className="stations-carriage stations-needle" style={{ transform: `translate(${needle.x}px, ${needle.y}px)`, height: needle.height }}>
            {/* keyed so the swing, and the flash where it lands, play for each station */}
            {parked ? (
              <span key={CUSTOM_STATION} className="stations-needle-mark is-yours">
                <span className="stations-needle-bar" aria-hidden />
                <span className="stations-yours">your mix</span>
              </span>
            ) : (
              <span key={at} className="stations-needle-mark" aria-hidden>
                <span className="stations-lock" />
                <span className="stations-needle-bar" />
              </span>
            )}
          </span>
        </>
      )}
    </div>
  )
}

export default StationPicker
