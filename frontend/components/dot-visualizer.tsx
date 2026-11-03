"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { canvasLoop } from "@/lib/canvas-loop"
import { smoothstep } from "@/lib/dot-field"
import { BANDS, bandOf, WAVE_LIVE, WAVE_REST, WEDGES } from "@/lib/wave-scene"

interface DotVisualizerProps {
  getSpectrum: (out: Uint8Array) => number
  active: boolean
  children?: ReactNode
}

const INNER = 0.52
const OUTER = 0.96
const PALETTE_VARS = ["--dot-0", "--dot-1", "--dot-2", "--dot-3", "--dot-4", "--dot-5", "--dot-6"]
const TAU = Math.PI * 2

// The matrix: rows of dots round the key about this far apart, in px, at
// every size, laid like brickwork. Within a band's wedge each row holds one
// dot more or one fewer than the row inside it, centred, so every row sits
// half a dot over from its neighbours and the dots pack evenly, a pitch from
// each of the six round them, all the way out. The wedges widen by taking
// more dots rather than spreading them, so the gaps between wedges stay thin
// and even instead of fanning open toward the edge.
const SPACING = 5
// rows a hexagon's height apart, so each dot is a pitch from the row's
const ROW = Math.sqrt(3) / 2
const MIN_ROWS = 10
const MAX_ROWS = 21
// the gap between wedges, as the distance between the dots either side of
// it, in pitches: about one dot left out, and never under a third of one
const GAP = 2.2
const TIGHT = 1.35

// The dots are liquid where they are lit: each row of a wedge fuses side to
// side into one brick of beads, joined by the neck two metaballs a pitch
// apart make, and the bricks stack staggered, so a wedge reads as a little
// wall of poured beads with the matrix still showing between its courses.
// The row at a wedge's tip fills by the share of a row the level has
// reached, its beads swelling and its necks widening with it, so a wedge
// grows smoothly rather than a row at a time. Drawn as circles and strokes
// rather than traced from a field, which keeps the ring's three thousand
// dots well under a millisecond. In pitches: a bead's radius, and a neck's
// half-width.
const BEAD = 0.42
const NECK = 0.24

// The quiet ring: every wedge this many rows deep round the key, with a slow
// swell orbiting it so the room still feels awake while nothing plays. The
// reduced-motion still is the same, unswollen.
const REST_LEN = 3
const REST_SWELL = 0.06

// What moves a wedge, as shares of its travel from the quiet ring to the
// matrix's edge. Every wedge stands out with how loud the music is; each then
// reaches with its band's level, and further with each hit (its rise over its
// own last tenth of a second), so a kick lifts the crown and a snare the
// shoulders.
const SWELL = 0.08
const LEVEL = 0.55
const PUNCH = 0.55
const PULSE_SLOW = 0.1

function rgb(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (!hex) return null
  const n = parseInt(hex[1], 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

export function DotVisualizer({ getSpectrum, active, children }: DotVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  const specRef = useRef(getSpectrum)
  activeRef.current = active
  specRef.current = getSpectrum

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let loop: ReturnType<typeof canvasLoop> | undefined
    let palette: string[] = []
    let restInk: number[] | null = null, liveInk: number[] | null = null
    let wedgeColor = ""
    // the unlit matrix, cached until the size or the theme changes
    const panel = document.createElement("canvas")
    const panelCtx = panel.getContext("2d")
    let panelDirty = true
    const readPalette = () => {
      const style = getComputedStyle(document.documentElement)
      palette = PALETTE_VARS.map(v => style.getPropertyValue(v).trim() || "#000")
      restInk = rgb(palette[WAVE_REST])
      liveInk = rgb(palette[WAVE_LIVE])
      wedgeColor = ""
      panelDirty = true
      loop?.redraw()
    }
    readPalette()
    const themeWatch = new MutationObserver(readPalette)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

    const bins = new Uint8Array(1024)
    const bandLo = new Int32Array(BANDS)
    const bandHi = new Int32Array(BANDS)
    // About 45 Hz to 5.4 kHz at 48 kHz, widening up the scale. Lo-fi is
    // rolled off above that, so bands spent there sit dark at the bottom of
    // the ring between snares.
    for (let i = 0; i < BANDS; i++) {
      bandLo[i] = Math.round(2 + Math.pow(i / BANDS, 1.8) * 230)
      bandHi[i] = Math.max(bandLo[i] + 1, Math.round(2 + Math.pow((i + 1) / BANDS, 1.8) * 230))
    }
    const bandFloor = new Float32Array(BANDS).fill(1)
    const bandCeil = new Float32Array(BANDS)
    const shape = new Float32Array(BANDS)
    // each band's recent level, its largest rise lately, and its hit now
    const pulseSlow = new Float32Array(BANDS), pulseCeil = new Float32Array(BANDS)
    const pulse = new Float32Array(BANDS)
    let listening = false
    let loudCeil = 0
    // how far each wedge stands, on a spring, and how far that is in rows
    const amp = new Float32Array(WEDGES), velocity = new Float32Array(WEDGES)
    const reach = new Float32Array(WEDGES)
    // how awake the wedges' ink is, 0 at rest to 1 while the music plays
    let awake = 0

    let size = 0, dpr = 0, pitch = 1, rows = 0
    // per dot: where it is, and its wedge and row; the pairs of dots side by
    // side in a row, which a neck joins when both are lit; and each dot's ink
    let dotX = new Float32Array(0), dotY = new Float32Array(0)
    let dotWedge = new Int32Array(0), dotRow = new Int32Array(0)
    let links = new Int32Array(0)
    let ink = new Float32Array(0)

    const resize = () => {
      const nextSize = Math.max(120, Math.min(wrap.clientWidth, wrap.clientHeight))
      const nextDpr = Math.min(2, window.devicePixelRatio || 1)
      if (size === nextSize && dpr === nextDpr) return
      size = nextSize
      dpr = nextDpr
      canvas.width = Math.round(size * dpr)
      canvas.height = Math.round(size * dpr)
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const mid = size / 2
      const inner = mid * INNER
      const span = mid * OUTER - inner
      rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(span / (SPACING * ROW)) + 1))
      const step = span / (rows - 1)
      pitch = step / ROW

      // How many dots each row of a wedge holds: as many as fit with the gap
      // to spare, and one more or one fewer than the row inside it, which is
      // what keeps the rows staggered; but never so many that the gap closes
      // below its tightest, so a wedge too narrow for two stays a single
      // file of dots until there is room.
      const counts: number[] = []
      for (let k = 0; k < rows; k++) {
        const room = (TAU * (inner + k * step) / WEDGES) / pitch
        const fit = room - GAP + 1, most = Math.max(1, Math.floor(room - TIGHT + 1))
        if (!k) { counts.push(Math.min(most, Math.max(1, Math.round(fit)))); continue }
        const was = counts[k - 1]
        const either = [was - 1, was + 1].filter(m => m >= 1 && m <= most)
        counts.push(either.length ? either.reduce((a, b) => Math.abs(a - fit) <= Math.abs(b - fit) ? a : b) : Math.min(was, most))
      }

      const xs: number[] = [], ys: number[] = [], wedge: number[] = [], row: number[] = []
      const pairs: number[] = []
      for (let w = 0; w < WEDGES; w++) {
        // half a wedge off the vertical, so the bass pair sits either side of it
        const centre = (w + 0.5) / WEDGES * TAU - Math.PI / 2
        for (let k = 0; k < rows; k++) {
          const radius = inner + k * step, m = counts[k], first = xs.length
          for (let i = 0; i < m; i++) {
            const angle = centre + (i - (m - 1) / 2) * pitch / radius
            xs.push(Math.cos(angle) * radius)
            ys.push(Math.sin(angle) * radius)
            wedge.push(w)
            row.push(k)
            if (i) pairs.push(first + i - 1, first + i)
          }
        }
      }
      dotX = Float32Array.from(xs)
      dotY = Float32Array.from(ys)
      dotWedge = Int32Array.from(wedge)
      dotRow = Int32Array.from(row)
      links = Int32Array.from(pairs)
      ink = new Float32Array(xs.length)
      panelDirty = true
      loop?.redraw()
    }
    resize()
    const sizeWatch = new ResizeObserver(resize)
    sizeWatch.observe(wrap)

    const draw = (now: number, dt: number, resting = false) => {
      const written = !resting && activeRef.current ? specRef.current(bins) : 0
      let gain = 0
      if (written > 0) {
        let loud = 0
        for (let i = 0; i < BANDS; i++) {
          const hi = Math.max(1, Math.min(written, bandHi[i]))
          const lo = Math.min(bandLo[i], hi - 1)
          let sum = 0
          for (let b = lo; b < hi; b++) sum += bins[b]
          const level = sum / (hi - lo) / 255
          // The floor follows a held note up within a few seconds, so a band
          // stands out for what it is doing now rather than for being loud
          // all along, and a steep curve keeps the in-between low so the
          // hits stand clear of it. (Clamped below too: the floor is a
          // float32 and can round a hair above the level it was just set to.)
          bandCeil[i] = Math.max(level, bandCeil[i] - dt * 0.06)
          bandFloor[i] = Math.min(level, bandFloor[i] + dt * 0.2)
          const t = Math.max(0, Math.min(1, (level - bandFloor[i]) / Math.max(0.15, bandCeil[i] - bandFloor[i])))
          shape[i] = Math.pow(t, 2.4)
          loud += level
          // The hit: the rise over the band's last tenth of a second, as a
          // share of the largest lately. Measured from the music's first
          // frame, so it arrives without a jolt.
          if (!listening) pulseSlow[i] = level
          const rise = Math.max(0, level - pulseSlow[i])
          pulseSlow[i] += (level - pulseSlow[i]) * (1 - Math.exp(-dt / PULSE_SLOW))
          pulseCeil[i] = Math.max(rise, 0.04, pulseCeil[i] * (1 - dt * 0.25))
          pulse[i] = rise / pulseCeil[i]
        }
        loud /= BANDS
        loudCeil = Math.max(loud, loudCeil - dt * 0.14)
        gain = loudCeil > 0.02 ? Math.min(1, loud / loudCeil) : 0
      }
      listening = written > 0

      const orbit = now / 1900
      const travel = rows - REST_LEN
      for (let w = 0; w < WEDGES; w++) {
        const band = bandOf(w)
        const want = written > 0 ? Math.min(1, gain * (SWELL + LEVEL * shape[band] + PUNCH * pulse[band])) :
          resting ? 0 : REST_SWELL * Math.max(0, Math.cos((w + 0.5) / WEDGES * TAU - orbit)) ** 3
        // A critically damped spring gives a hit momentum without overshoot:
        // it rises within about 50 ms, so a wedge lands with its hit rather
        // than after it, and settles back rather than drops.
        const omega = want > amp[w] ? 40 : 10
        const decay = Math.exp(-omega * dt)
        const delta = amp[w] - want
        const step = (velocity[w] + omega * delta) * dt
        amp[w] = resting ? want : want + (delta + step) * decay
        velocity[w] = resting ? 0 : (velocity[w] - omega * step) * decay
        reach[w] = Math.min(rows, REST_LEN + travel * Math.max(0, amp[w]))
      }
      // each dot's ink: whole rows, then the share of the next
      for (let i = 0; i < ink.length; i++) ink[i] = Math.max(0, Math.min(1, reach[dotWedge[i]] - dotRow[i]))

      // The wedges' ink wakes a step deeper while the music plays and
      // softens again once it stops.
      const wake = written > 0 ? 1 : 0
      const woke = awake
      awake = resting ? wake : awake + (wake - awake) * (1 - Math.exp(-dt / 0.35))
      if (!wedgeColor || awake !== woke) {
        if (restInk && liveInk) {
          const k = smoothstep(0, 1, awake), live = liveInk
          wedgeColor = `rgb(${restInk.map((c, i) => Math.round(c + (live[i] - c) * k)).join(",")})`
        } else wedgeColor = palette[WAVE_LIVE]
      }

      if (panelDirty && panelCtx) {
        panelDirty = false
        panel.width = canvas.width
        panel.height = canvas.height
        panelCtx.setTransform(dpr, 0, 0, dpr, size / 2 * dpr, size / 2 * dpr)
        panelCtx.beginPath()
        const r = Math.max(0.7, pitch * 0.17)
        for (let i = 0; i < dotX.length; i++) {
          panelCtx.moveTo(dotX[i] + r, dotY[i])
          panelCtx.arc(dotX[i], dotY[i], r, 0, TAU)
        }
        panelCtx.fillStyle = palette[0]
        panelCtx.fill()
      }

      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(panel, 0, 0, size, size)
      ctx.save()
      ctx.translate(size / 2, size / 2)
      ctx.strokeStyle = wedgeColor
      ctx.fillStyle = wedgeColor
      // The necks, by how lit the dimmer of their two beads is: whole, or
      // one of two widths as the tip row fills (none until its beads are a
      // third grown, so a neck never shows as a thread between specks);
      // then the beads over them.
      for (let n = 2; n >= 0; n--) {
        ctx.beginPath()
        let any = false
        for (let p = 0; p < links.length; p += 2) {
          const a = links[p], b = links[p + 1], lit = Math.min(ink[a], ink[b])
          if ((n === 2 ? lit < 1 : n === 1 ? lit < 0.65 || lit >= 1 : lit < 0.35 || lit >= 0.65)) continue
          ctx.moveTo(dotX[a], dotY[a])
          ctx.lineTo(dotX[b], dotY[b])
          any = true
        }
        if (!any) continue
        ctx.lineWidth = NECK * 2 * pitch * (n === 2 ? 1 : n === 1 ? 0.75 : 0.5)
        ctx.stroke()
      }
      ctx.beginPath()
      const bead = BEAD * pitch
      for (let i = 0; i < ink.length; i++) {
        const r = bead * Math.sqrt(ink[i])
        if (r < 0.2) continue
        ctx.moveTo(dotX[i] + r, dotY[i])
        ctx.arc(dotX[i], dotY[i], r, 0, TAU)
      }
      ctx.fill()
      ctx.restore()
    }

    // Low power halves the painting; the wedges' damping is time-based, so
    // they move the same way at either rate.
    loop = canvasLoop(canvas, draw, () => draw(0, 1, true), { fps: 60, lowPowerFps: 30 })
    return () => {
      loop?.dispose()
      themeWatch.disconnect()
      sizeWatch.disconnect()
    }
  }, [])

  return (
    <div ref={wrapRef} className="relative aspect-square w-full max-w-[min(52vh,29rem)]">
      <canvas ref={canvasRef} className="absolute inset-0 m-auto" aria-hidden />
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  )
}

export default DotVisualizer
