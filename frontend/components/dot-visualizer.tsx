"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { canvasLoop } from "@/lib/canvas-loop"
import { BlobSet, smoothstep } from "@/lib/dot-field"
import { LiquidInk } from "@/lib/liquid-ink"
import { buildWave, SPOKES, WAVE_BODY, WAVE_CREST, WAVE_GLOW } from "@/lib/wave-scene"

interface DotVisualizerProps {
  getSpectrum: (out: Uint8Array) => number
  active: boolean
  children?: ReactNode
}

const RINGS = 11
const INNER = 0.52
const OUTER = 0.96
const PALETTE_VARS = ["--dot-0", "--dot-1", "--dot-2", "--dot-3", "--dot-4", "--dot-5", "--dot-6"]

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
    const readPalette = () => {
      const style = getComputedStyle(document.documentElement)
      palette = PALETTE_VARS.map(v => style.getPropertyValue(v).trim() || "#000")
      loop?.redraw()
    }
    readPalette()
    const themeWatch = new MutationObserver(readPalette)
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

    const half = SPOKES / 2
    const bins = new Uint8Array(1024)
    const bandLo = new Int32Array(half)
    const bandHi = new Int32Array(half)
    for (let i = 0; i < half; i++) {
      bandLo[i] = Math.round(2 + Math.pow(i / half, 2) * 338)
      bandHi[i] = Math.round(2 + Math.pow((i + 1) / half, 2) * 338)
    }
    const bandFloor = new Float32Array(half).fill(1)
    const bandCeil = new Float32Array(half)
    const shape = new Float32Array(half)
    const target = new Float32Array(SPOKES)
    const amp = new Float32Array(SPOKES).fill(0.1)
    const velocity = new Float32Array(SPOKES)
    let loudCeil = 0

    let size = 0, dpr = 0, pitch = 1, inner = 0
    let distance = new Float32Array(0)
    let ink: { count: number; x: Float32Array; y: Float32Array; fill: Float32Array }
    let skirt: LiquidInk, body: LiquidInk, crest: LiquidInk
    const blobs = new BlobSet()

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
      inner = mid * INNER
      pitch = (mid * OUTER - inner) / (RINGS - 1)
      const xs: number[] = [], ys: number[] = []
      for (let ring = 0; ring < RINGS; ring++) {
        const radius = inner + ring * pitch
        // Add beads with circumference so spacing stays near one pitch.
        // Multiples of four keep each ring symmetric about both axes.
        const dots = Math.round(Math.PI * 2 * radius / pitch / 4) * 4
        for (let dot = 0; dot < dots; dot++) {
          const angle = dot / dots * Math.PI * 2 - Math.PI / 2
          xs.push(Math.cos(angle) * radius)
          ys.push(Math.sin(angle) * radius)
        }
      }
      const count = xs.length
      distance = new Float32Array(count)
      ink = {
        count, x: Float32Array.from(xs), y: Float32Array.from(ys),
        fill: new Float32Array(count),
      }
      skirt = new LiquidInk(ink, pitch, { radius: 0.54, attack: 0.06, release: 0.12 })
      body = new LiquidInk(ink, pitch, { radius: 0.54 })
      crest = new LiquidInk(ink, pitch, { radius: 0.48, attack: 0.055, release: 0.09 })
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
        for (let i = 0; i < half; i++) {
          const hi = Math.max(1, Math.min(written, bandHi[i]))
          const lo = Math.min(bandLo[i], hi - 1)
          let sum = 0
          for (let b = lo; b < hi; b++) sum += bins[b]
          const level = sum / (hi - lo) / 255
          bandCeil[i] = Math.max(level, bandCeil[i] - dt * 0.14)
          bandFloor[i] = Math.min(level, bandFloor[i] + dt * 0.05)
          shape[i] = Math.min(1, (level - bandFloor[i]) / Math.max(0.1, bandCeil[i] - bandFloor[i]))
          loud += level
        }
        loud /= half
        loudCeil = Math.max(loud, loudCeil - dt * 0.14)
        gain = loudCeil > 0.02 ? Math.min(1, loud / loudCeil) : 0
      }
      for (let s = 0; s < SPOKES; s++) {
        const i = s < half ? s : SPOKES - 1 - s
        target[s] = written > 0 ? gain * (0.08 + 0.88 * shape[i]) :
          0.09 + (resting ? 0 : 0.025 * Math.sin(now / 1800))
      }
      for (let s = 0; s < SPOKES; s++) {
        // Neighbouring bands tug on each other. A critically damped spring
        // gives transients momentum without overshoot or a sharp velocity jump.
        const want = target[s] * 0.6 +
          (target[(s + SPOKES - 1) % SPOKES] + target[(s + 1) % SPOKES]) * 0.2
        const omega = want > amp[s] ? 24 : 14
        const decay = Math.exp(-omega * dt)
        const delta = amp[s] - want
        const step = (velocity[s] + omega * delta) * dt
        amp[s] = resting ? want : want + (delta + step) * decay
        velocity[s] = resting ? 0 : (velocity[s] - omega * step) * decay
      }
      buildWave(blobs, amp, { inner, span: size * OUTER / 2 - inner, pitch })
      // Sample the field and its gradient at the actual radial bead positions.
      // No square-grid snapping as the surface flows between concentric rings.
      for (let i = 0; i < ink.count; i++) {
        distance[i] = blobs.surfaceDistanceAt(ink.x[i], ink.y[i], pitch)
      }

      ctx.clearRect(0, 0, size, size)
      ctx.save()
      ctx.translate(size / 2, size / 2)
      const fill = ink.fill
      for (let i = 0; i < ink.count; i++) fill[i] = smoothstep(-1.25, 0, distance[i])
      skirt.paint(ctx, fill, palette[WAVE_GLOW], resting ? 0 : dt)
      for (let i = 0; i < ink.count; i++) fill[i] = smoothstep(-0.9, 0.15, distance[i])
      body.paint(ctx, fill, palette[WAVE_BODY], resting ? 0 : dt)
      // A continuous one-cell crest. As it crosses a ring, the next bead
      // swells while the previous one recedes, with no binary edge mask.
      for (let i = 0; i < ink.count; i++) {
        const d = distance[i]
        fill[i] = smoothstep(-0.6, 0.25, d) * (1 - smoothstep(0.25, 1.35, d))
      }
      crest.paint(ctx, fill, palette[WAVE_CREST], resting ? 0 : dt)
      ctx.restore()
    }

    // Low power halves the painting; the ring's damping is time-based, so
    // it moves the same way at either rate.
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
