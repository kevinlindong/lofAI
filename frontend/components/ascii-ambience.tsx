"use client"

import { useEffect, useRef } from "react"
import { BlobSet } from "@/lib/dot-field"
import { gridNeighbours, paintInk, type InkCells, type InkGeometry } from "@/lib/ink-render"
import { lowPowerActive, renderBusy } from "@/lib/render-budget"

// the page's background.
//
// this used to be a full-viewport metaball canvas, sampled per pixel and
// composited under every translucent card on the page. it was the reason the
// interface felt heavy, and none of that work survived being covered up.
//
// what stands here now is two things, each costing only what it shows:
//
// - a few large ASCII marks, drifting on CSS keyframes and leaning towards the
//   cursor. the whole layer is animated by the compositor: the cursor arrives
//   as two custom properties, and everything downstream is a composited CSS
//   `translate`. the only javascript is one passive pointermove handler that
//   stores two floats, and one rAF that writes them while the pointer moves.
//
// - the cursor's own mark: liquid ink, dragged across the page's dot matrix.
//   moving the pointer lays droplets along its path; each swells in, fuses
//   with its neighbours through the same tangent-continuous membranes the
//   visualiser and the cat are drawn with (lib/ink-render), and evaporates.
//   this is not the old per-pixel field come back: the ink only ever samples
//   the lattice cells inside the trail's own bounding box - a few hundred
//   cells, not a viewport of pixels - and the draw loop runs only while ink
//   is actually wet. once the last droplet dries the canvas is cleared, the
//   loop stops, and a still cursor costs nothing at all.

// how far each ambient mark is pushed by the cursor, in px at full deflection.
// they differ so the layer reads as having depth - the near marks lead, the far
// ones lag behind, which is the whole trick of parallax.
const PARALLAX = [26, -18, 34, -12, 20, -28]

// the trail's dot lattice. the pitch is the page's texture at background
// scale: small enough to read as the same matrix as everything else, coarse
// enough that a swipe wets a few hundred cells and not thousands.
const PITCH = 18

// the ink, in fractions of the pitch - the same dialect as the visualiser.
// swellIn is doing the most work here: cells at the trail's edge are forever
// wetting and drying, and the fade is what makes that read as bleeding into
// the paper rather than as dots blinking.
const INK: InkGeometry = {
  minRadius: 0.16 * PITCH,
  maxRadius: 0.54 * PITCH,
  spread: 0.5,
  handleSize: 2.4,
  reach: 2.5,
  dryRadius: 0,
  diagonals: true,
  swellIn: 0.25,
}

// where on the field a cell wets and where it saturates. the numbers are in
// units of the lone-blob surface value from lib/dot-field.
const SURFACE = 0.421875
const WET_AT = SURFACE * 0.45
const FULL_AT = SURFACE * 1.5

// a droplet is laid every this many px of pointer travel...
const DROP_SPACING = PITCH * 0.55
// ...at this radius, jittered so the rivulet has a hand-poured edge
const DROP_R = PITCH * 0.46
const DROP_R_JITTER = PITCH * 0.2
// and lives this long, swelling over the first eighth and evaporating away
const DROP_LIFE_MS = 800
const DROP_LIFE_JITTER_MS = 240
// a press pools a proper blot rather than a passing droplet
const PRESS_R = PITCH * 0.95
// the trail's memory. old drops are recycled once the pool is full, which is
// also what bounds the worst-case cost of a frame.
const MAX_DROPS = 32

// how faint the ink is. the background must stay a whisper: the trail should
// read as something happening to the paper, not as a second visualiser.
const TRAIL_ALPHA = 0.38

interface Drop {
  x: number
  y: number
  r: number
  born: number
  life: number
}

export function AsciiAmbience() {
  const layerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const layer = layerRef.current
    const canvas = canvasRef.current
    if (!layer || !canvas) return
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // ---- the parallax marks -------------------------------------------------
    // -1..1 across the viewport. one write per frame at most, and only on
    // frames where the pointer moved; writing two custom properties cannot
    // force layout, so this never lands on the critical path.
    let nx = 0
    let ny = 0
    let queued = false
    let pointerRaf = 0
    const flush = () => {
      queued = false
      layer.style.setProperty("--ax", nx.toFixed(4))
      layer.style.setProperty("--ay", ny.toFixed(4))
    }

    // ---- the ink trail ------------------------------------------------------
    let dpr = 1
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener("resize", resize)

    let inkColor = "#888"
    const readColor = () => {
      const style = getComputedStyle(document.documentElement)
      inkColor = style.getPropertyValue("--dot-3").trim() || "#888"
    }
    readColor()
    const themeWatch = new MutationObserver(readColor)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

    const drops: Drop[] = []
    const blobs = new BlobSet()

    // the window the ink is sampled through: the cells inside the live drops'
    // bounding box, built fresh each frame. the neighbour tables only depend
    // on the window's dimensions, so they are rebuilt only when those change -
    // and the dimensions are rounded up in blocks of eight cells so a trail
    // breathing by a cell or two does not rebuild anything.
    let winW = 0
    let winH = 0
    let tables: ReturnType<typeof gridNeighbours> | null = null
    let cx = new Float32Array(0)
    let cy = new Float32Array(0)
    let cf = new Float32Array(0)
    let cs = new Uint8Array(0)
    let windowCells: InkCells | null = null
    const windowFor = (gx0: number, gy0: number, w: number, h: number): InkCells => {
      if (w !== winW || h !== winH) {
        winW = w
        winH = h
        tables = gridNeighbours(w, h)
        const n = w * h
        if (cx.length < n) {
          cx = new Float32Array(n)
          cy = new Float32Array(n)
          cf = new Float32Array(n)
          cs = new Uint8Array(n)
        }
        windowCells = {
          count: n,
          x: cx.subarray(0, n), y: cy.subarray(0, n),
          fill: cf.subarray(0, n), shade: cs.subarray(0, n),
          ...tables,
        }
      }
      for (let r = 0; r < h; r++) {
        const py = (gy0 + r) * PITCH + PITCH / 2
        for (let c = 0; c < w; c++) {
          const i = r * w + c
          cx[i] = (gx0 + c) * PITCH + PITCH / 2
          cy[i] = py
        }
      }
      return windowCells!
    }

    // the region painted last frame, cleared before the next one - and after
    // the last one, so nothing is left struck on the canvas when the loop stops
    let dirty: [number, number, number, number] | null = null
    const clearDirty = () => {
      if (!dirty) return
      ctx.clearRect(dirty[0], dirty[1], dirty[2], dirty[3])
      dirty = null
    }

    let raf = 0
    let running = false
    let lastPaint = 0

    const step = (now: number) => {
      if (now - lastPaint < 1000 / 60 - 0.5) {
        raf = requestAnimationFrame(step)
        return
      }
      lastPaint = now
      clearDirty()

      // age the drops; the dead are compacted away
      let alive = 0
      blobs.reset()
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const d of drops) {
        const t = (now - d.born) / d.life
        if (t >= 1) continue
        drops[alive++] = d
        // swell in over the first eighth of life, evaporate over the rest.
        // both ends eased, so the pool never jumps.
        const s = Math.min(1, t / 0.125)
        const r = d.r * (s * s * (3 - 2 * s)) * (1 - t * t)
        if (r <= 0.5) continue
        blobs.add(d.x, d.y, r)
        const reach = r * 2
        if (d.x - reach < minX) minX = d.x - reach
        if (d.x + reach > maxX) maxX = d.x + reach
        if (d.y - reach < minY) minY = d.y - reach
        if (d.y + reach > maxY) maxY = d.y + reach
      }
      drops.length = alive

      if (blobs.count === 0) {
        // dry. stop the loop; the next pointer move starts it again.
        running = false
        return
      }
      raf = requestAnimationFrame(step)

      // the lattice window under the wet region, rounded out to whole cells
      // and up to blocks of eight so its dimensions hold still between frames
      const gx0 = Math.floor(minX / PITCH)
      const gy0 = Math.floor(minY / PITCH)
      const w = Math.min(Math.ceil((Math.ceil(maxX / PITCH) - gx0 + 7) / 8) * 8, 512)
      const h = Math.min(Math.ceil((Math.ceil(maxY / PITCH) - gy0 + 7) / 8) * 8, 512)
      const cells = windowFor(gx0, gy0, w, h)

      blobs.scatter(cells.fill, w, h, PITCH, gx0 * PITCH + PITCH / 2, gy0 * PITCH + PITCH / 2)
      for (let i = 0; i < cells.count; i++) {
        const v = cells.fill[i]
        cells.fill[i] = v <= WET_AT ? 0 : Math.min(1, (v - WET_AT) / (FULL_AT - WET_AT))
      }

      const px = gx0 * PITCH
      const py = gy0 * PITCH
      // a border cell's circle pokes past the window by up to maxRadius minus
      // half the pitch, and a membrane's handles a shade further - pad the
      // cleared rect or slivers of ink survive along the window's edge
      const pad = INK.maxRadius + 2
      dirty = [px - pad, py - pad, w * PITCH + pad * 2, h * PITCH + pad * 2]
      ctx.save()
      ctx.globalAlpha = TRAIL_ALPHA
      paintInk(ctx, cells, INK, [inkColor])
      ctx.restore()
    }

    const wake = () => {
      if (running) return
      running = true
      lastPaint = 0
      raf = requestAnimationFrame(step)
    }

    // droplets are laid along the pointer's path, one per DROP_SPACING of
    // travel, so a fast swipe leaves a rivulet rather than beads at frame rate
    let lastX = -1
    let lastY = -1
    const emit = (x: number, y: number, r: number) => {
      const drop: Drop = {
        x,
        y,
        r,
        born: performance.now(),
        life: DROP_LIFE_MS + Math.random() * DROP_LIFE_JITTER_MS,
      }
      if (drops.length >= MAX_DROPS) drops.shift()
      drops.push(drop)
    }

    const track = (event: PointerEvent) => {
      if (motion.matches || document.hidden) return
      const w = window.innerWidth || 1
      const h = window.innerHeight || 1
      nx = (event.clientX / w) * 2 - 1
      ny = (event.clientY / h) * 2 - 1
      if (!queued) {
        queued = true
        pointerRaf = requestAnimationFrame(flush)
      }

      // In low power the marks keep leaning towards the cursor, but no ink is
      // laid: the trail is the one effect here that paints on every move.
      // The same while a widget is being carried across the desk.
      if (lowPowerActive() || renderBusy()) {
        forget()
        return
      }
      const x = event.clientX
      const y = event.clientY
      if (lastX < 0) {
        lastX = x
        lastY = y
        return
      }
      const dx = x - lastX
      const dy = y - lastY
      const dist = Math.hypot(dx, dy)
      if (dist < DROP_SPACING) return
      const steps = Math.min(Math.floor(dist / DROP_SPACING), MAX_DROPS)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        emit(lastX + dx * t, lastY + dy * t, DROP_R + Math.random() * DROP_R_JITTER)
      }
      lastX = x
      lastY = y
      wake()
    }

    // a press pools ink under the pointer - the one deliberate mark the
    // background can make, and it evaporates like everything else
    const press = (event: PointerEvent) => {
      if (motion.matches || document.hidden || lowPowerActive() || renderBusy()) return
      emit(event.clientX, event.clientY, PRESS_R)
      wake()
    }

    // the cursor leaving the window is not the cursor moving to where it comes
    // back in: forget the path, or re-entry would lay a rivulet clean across
    // the page between the two points
    const forget = () => {
      lastX = -1
      lastY = -1
    }

    const suspend = () => {
      if (!motion.matches && !document.hidden) return
      cancelAnimationFrame(raf)
      cancelAnimationFrame(pointerRaf)
      running = queued = false
      drops.length = 0
      clearDirty()
      forget()
    }

    motion.addEventListener("change", suspend)
    document.addEventListener("visibilitychange", suspend)
    window.addEventListener("pointermove", track, { passive: true })
    window.addEventListener("pointerdown", press, { passive: true })
    document.addEventListener("pointerleave", forget)
    return () => {
      window.removeEventListener("pointermove", track)
      window.removeEventListener("pointerdown", press)
      document.removeEventListener("pointerleave", forget)
      window.removeEventListener("resize", resize)
      themeWatch.disconnect()
      cancelAnimationFrame(raf)
      cancelAnimationFrame(pointerRaf)
      motion.removeEventListener("change", suspend)
      document.removeEventListener("visibilitychange", suspend)
    }
  }, [])

  return (
    <div ref={layerRef} className="ascii-ambience" aria-hidden>
      {PARALLAX.map((depth, i) => (
        <span
          key={i}
          className={`ascii-mark ascii-mark-${i + 1}`}
          style={{ ["--depth" as string]: `${depth}px` }}
        >
          {["/ / /", "~", "[ ]", ": : :", "\\", "( )"][i]}
        </span>
      ))}
      <canvas ref={canvasRef} className="ink-trail" />
    </div>
  )
}

export default AsciiAmbience
