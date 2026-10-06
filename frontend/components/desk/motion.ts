// The desk's renderer for lib/spring: one Animator for every frame, tack,
// surface, footprint, the pull and the carry's ghost. The render callback
// writes `translate`, `scale`, `rotate` and `opacity` straight onto the
// element (and the frame's two shadow layers' opacity from `lift`), only when
// the string changes. A body resting at REST_POSE clears its inline styles,
// so CSS owns every resting state. With reduced motion only opacity is ever
// written: positions change instantly and moves read as short crossfades.
import { Animator, type Body, type MotionMode, type Pose, type Scheduler } from "@/lib/spring"
import { lowPowerActive } from "@/lib/render-budget"

// body keys: `f:{id}` a frame, `t:{id}` its tack, `s:{id}` its surface layer,
// `c:{id}` its content, and "fp" (the landing footprint), "pull", "ghost"
type Kind = "frame" | "tack" | "surface" | "content" | "footprint" | "pull" | "ghost"

interface Target {
  kind: Kind
  el: HTMLElement | null
  cast: HTMLElement | null
  contact: HTMLElement | null
  // what's written now, so an unchanged frame writes nothing
  t: string; s: string; r: string; o: string; lift: string
}

const PREFIX = "widget-"
const PERF_RING = 600
const EPS = 1e-4

const kindOf = (key: string): Kind => {
  switch (key.charAt(0)) {
    case "f": return key === "fp" ? "footprint" : "frame"
    case "t": return "tack"
    case "s": return "surface"
    case "c": return "content"
    case "p": return "pull"
    default: return "ghost"
  }
}
const atRest = (p: Pose) =>
  Math.abs(p.x) < EPS && Math.abs(p.y) < EPS && Math.abs(p.scale - 1) < EPS && Math.abs(p.sx - 1) < EPS &&
  Math.abs(p.sy - 1) < EPS && Math.abs(p.rotate) < EPS && Math.abs(p.opacity - 1) < EPS && Math.abs(p.lift) < EPS

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
// the budget's flag, or its class (the CSS follows the class)
export const lowPowered = () => lowPowerActive() || (typeof document !== "undefined" && document.documentElement.classList.contains("low-power"))

// with ?deskperf in the URL, each frame's JS time (the drag's step and the
// animator) goes into a ring at window.__lofaiDeskFrames, for the perf test
function perfScheduler(): Scheduler | undefined {
  if (typeof window === "undefined" || !/[?&]deskperf\b/.test(window.location.search)) return undefined
  const ring: number[] = []
  ;(window as unknown as { __lofaiDeskFrames: number[] }).__lofaiDeskFrames = ring
  return {
    now: () => performance.now(),
    request: (cb) => requestAnimationFrame((t) => {
      const start = performance.now()
      cb(t)
      ring.push(performance.now() - start)
      if (ring.length > PERF_RING) ring.shift()
    }),
    cancel: (id) => cancelAnimationFrame(id),
  }
}

export class DeskMotion {
  readonly anim: Animator
  private targets: Record<string, Target> = {}
  private desk: HTMLElement | null = null
  private current: MotionMode = "full"

  constructor() {
    this.anim = new Animator((key, pose, resting) => this.render(key, pose, resting), perfScheduler())
  }

  attach(desk: HTMLElement | null) { this.desk = desk }

  get mode(): MotionMode { return this.current }

  // read the page's motion settings (at every lift and every commit)
  sync(): MotionMode {
    const mode: MotionMode = reducedMotion() ? "reduced" : lowPowered() ? "low" : "full"
    if (mode !== this.current) {
      this.current = mode
      this.anim.setMode(mode)
      // nothing left leaning or offset from before
      if (mode === "reduced") for (const key of Object.keys(this.targets)) this.clearTransforms(this.targets[key])
    }
    return mode
  }

  body(key: string): Body { return this.anim.body(key) }
  has(key: string): boolean { return this.anim.has(key) }

  // the element is gone (a frame put away, a ghost dropped): forget its body
  forget(key: string) {
    this.anim.drop(key)
    const t = this.targets[key]
    if (t) this.clear(t)
    delete this.targets[key]
  }

  flush() { this.anim.flush() }

  dispose() {
    this.anim.dispose()
    this.targets = {}
  }

  private resolve(key: string): Target | null {
    let t = this.targets[key]
    if (t && t.el && t.el.isConnected) return t
    const kind = kindOf(key)
    const id = key.slice(2)
    const frame = kind === "frame" || kind === "tack" || kind === "surface" || kind === "content" ? document.getElementById(PREFIX + id) : null
    let el: HTMLElement | null = null
    switch (kind) {
      case "frame": el = frame; break
      case "tack": el = frame?.querySelector<HTMLElement>(":scope > .wf-pin .wf-pin-glyphs") ?? null; break
      case "surface": el = frame?.querySelector<HTMLElement>(":scope > .wf-body > .wf-surface") ?? null; break
      case "content": el = frame?.querySelector<HTMLElement>(":scope > .wf-body > .wf-content") ?? null; break
      case "footprint": el = this.desk?.querySelector<HTMLElement>(":scope > .desk-landing") ?? null; break
      case "pull": el = document.querySelector<HTMLElement>(".drawer-pull"); break
      case "ghost": el = document.querySelector<HTMLElement>(".drawer-ghost"); break
    }
    if (!el) return null
    t = {
      kind, el,
      cast: kind === "frame" ? el.querySelector<HTMLElement>(":scope > .wf-cast") : null,
      contact: kind === "frame" ? el.querySelector<HTMLElement>(":scope > .wf-contact") : null,
      t: "", s: "", r: "", o: "", lift: "",
    }
    this.targets[key] = t
    return t
  }

  private render(key: string, pose: Pose, resting: boolean) {
    const t = this.resolve(key)
    if (!t || !t.el) return
    if (resting && atRest(pose)) { this.clear(t); return }
    const el = t.el
    if (t.kind === "frame" && !el.hasAttribute("data-moving")) el.setAttribute("data-moving", "")
    if (this.current !== "reduced") {
      if (t.kind !== "pull") {
        const tr = Math.abs(pose.x) < 0.005 && Math.abs(pose.y) < 0.005 ? "" : `${pose.x.toFixed(2)}px ${pose.y.toFixed(2)}px`
        if (tr !== t.t) { t.t = tr; el.style.translate = tr }
      }
      const a = pose.scale * pose.sx, b = pose.scale * pose.sy
      const sc = Math.abs(a - 1) < 0.00005 && Math.abs(b - 1) < 0.00005 ? "" : `${a.toFixed(4)} ${b.toFixed(4)}`
      if (sc !== t.s) { t.s = sc; el.style.scale = sc }
      const rot = t.kind === "pull" || Math.abs(pose.rotate) < 0.005 ? "" : `${pose.rotate.toFixed(3)}deg`
      if (rot !== t.r) { t.r = rot; el.style.rotate = rot }
    }
    const op = Math.abs(pose.opacity - 1) < 0.001 ? "" : Math.max(0, Math.min(1, pose.opacity)).toFixed(3)
    if (op !== t.o) { t.o = op; el.style.opacity = op }
    if (t.kind === "frame") {
      const l = Math.max(0, Math.min(1, pose.lift))
      const lift = l < 0.002 ? "" : l.toFixed(3)
      if (lift !== t.lift) {
        t.lift = lift
        // the cast shadow is the lift; it tucks in a little as it fades. the
        // contact shadow gives way to it
        if (t.cast) {
          t.cast.style.opacity = lift
          // (full motion only: low power has no cast shadow, reduced no transforms)
          t.cast.style.scale = lift && l < 0.999 && this.current === "full" ? (0.96 + 0.04 * l).toFixed(4) : ""
        }
        if (t.contact) t.contact.style.opacity = lift ? (1 - 0.65 * l).toFixed(3) : ""
      }
    }
  }

  private clearTransforms(t: Target) {
    const el = t.el
    if (!el) return
    if (t.t) { t.t = ""; el.style.translate = "" }
    if (t.s) { t.s = ""; el.style.scale = "" }
    if (t.r) { t.r = ""; el.style.rotate = "" }
  }

  private clear(t: Target) {
    const el = t.el
    if (!el) return
    this.clearTransforms(t)
    if (t.o) { t.o = ""; el.style.opacity = "" }
    if (t.lift) {
      t.lift = ""
      if (t.cast) { t.cast.style.opacity = ""; t.cast.style.scale = "" }
      if (t.contact) t.contact.style.opacity = ""
    }
    if (t.kind === "frame") el.removeAttribute("data-moving")
  }
}

