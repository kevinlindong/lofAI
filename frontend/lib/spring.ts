// The desk's motion: exact damped springs (stiffness, damping, mass), a body
// per animated element with a spring per channel, and one animator that runs
// a frame only while something moves. Retargeting keeps each channel's value
// and velocity, so nothing ever jumps. Pure maths plus a scheduler seam: the
// unit tests drive it with a fake clock, and the DOM writing is the render
// callback's (components/desk/motion.ts). Times are ms unless a name says s.

export interface Spring { stiffness: number; damping: number; mass: number }

const { abs, cos, exp, max, min, sin, sqrt } = Math

export function dampingRatio(s: Spring): number {
  return s.damping / (2 * sqrt(s.stiffness * s.mass))
}

// one step of the closed form, written into these (no allocation per frame)
let outX = 0, outV = 0
// x0: displacement from the target, v0: velocity; t in seconds, any size
function solve(k: number, c: number, m: number, x0: number, v0: number, t: number) {
  if (!(k > 0) || !(m > 0) || !(t > 0)) {
    // no spring to speak of: already there; no time: nothing changes
    if (t > 0) { outX = 0; outV = 0 } else { outX = x0; outV = v0 }
    return
  }
  const w0 = sqrt(k / m), z = max(0, c) / (2 * sqrt(k * m))
  if (abs(z - 1) < 1e-4) {
    // critically damped
    const e = exp(-w0 * t), b = v0 + w0 * x0
    outX = e * (x0 + b * t)
    outV = e * (b - w0 * (x0 + b * t))
  } else if (z < 1) {
    const wd = w0 * sqrt(1 - z * z), e = exp(-z * w0 * t)
    const b = (v0 + z * w0 * x0) / wd, co = cos(wd * t), si = sin(wd * t)
    outX = e * (x0 * co + b * si)
    outV = e * ((b * wd - z * w0 * x0) * co - (x0 * wd + z * w0 * b) * si)
  } else {
    const r = sqrt(z * z - 1), r1 = -w0 * (z - r), r2 = -w0 * (z + r)
    const c2 = (v0 - r1 * x0) / (r2 - r1), c1 = x0 - c2
    const e1 = exp(r1 * t), e2 = exp(r2 * t)
    outX = c1 * e1 + c2 * e2
    outV = c1 * r1 * e1 + c2 * r2 * e2
  }
}

// exact for under-, critically and over-damped motion; dt in seconds
export function springStep(s: Spring, value: number, velocity: number, target: number, dt: number): { value: number; velocity: number } {
  solve(s.stiffness, s.damping, s.mass, value - target, velocity, dt)
  return { value: target + outX, velocity: outV }
}

// Seconds until a step of `distance` (launched at `velocity`) stays within
// restDelta of its target and under restSpeed, to the millisecond.
export function settleTime(s: Spring, distance: number, velocity = 0, restDelta = 0.5, restSpeed = 10): number {
  const w0 = sqrt(s.stiffness / s.mass), z = dampingRatio(s)
  // the slowest decay rate the motion has, for how far ahead to look
  const rate = z < 1 ? z * w0 : w0 * (z - sqrt(max(0, z * z - 1)))
  if (!(rate > 0)) return Infinity
  const horizon = min(60, 40 / rate + 1)
  // sampled every millisecond: the last sample still outside the rest band
  let x = -distance, v = velocity, last = 0
  const dt = 0.001
  for (let i = 1; i * dt <= horizon; i++) {
    solve(s.stiffness, s.damping, s.mass, x, v, dt)
    x = outX; v = outV
    if (abs(x) > restDelta || abs(v) > restSpeed) last = i
  }
  return last / 1000
}

// a pull that gives less the further it goes: odd, monotone, always under limit
export function rubberBand(offset: number, limit: number): number {
  if (!(limit > 0) || !isFinite(offset)) return 0
  const sign = offset < 0 ? -1 : 1
  return sign * limit * (1 - 1 / (abs(offset) / limit + 1))
}

// --- poses ---

export type Channel = "x" | "y" | "scale" | "sx" | "sy" | "rotate" | "opacity" | "lift"
export type Pose = Record<Channel, number>
export const CHANNELS: Channel[] = ["x", "y", "scale", "sx", "sy", "rotate", "opacity", "lift"]
// x/y px, scale factors, rotate degrees, opacity and lift (the cast shadow) 0–1
export const REST_POSE: Pose = { x: 0, y: 0, scale: 1, sx: 1, sy: 1, rotate: 0, opacity: 1, lift: 0 }
// close enough to call it still, per channel (speeds per second)
export const REST: Record<Channel, { delta: number; speed: number }> = {
  x: { delta: 0.2, speed: 5 }, y: { delta: 0.2, speed: 5 },
  scale: { delta: 0.0005, speed: 0.01 }, sx: { delta: 0.0005, speed: 0.01 }, sy: { delta: 0.0005, speed: 0.01 },
  rotate: { delta: 0.02, speed: 0.5 },
  opacity: { delta: 0.002, speed: 0.02 }, lift: { delta: 0.002, speed: 0.02 },
}

// --- motion tokens (SPEC2 §7.2), mass 1 ---

export type TokenName = "lift" | "follow" | "tilt" | "reflow" | "footprint" | "drop" | "squash" | "shadow"
  | "pinUp" | "strike" | "pop" | "resist" | "wiggle" | "morph" | "rise" | "stow"
const spring = (stiffness: number, damping: number): Spring => ({ stiffness, damping, mass: 1 })
export const MOTION: Record<TokenName, Spring> = {
  // the carried widget swells a little past 1.03 and settles: it's in the hand
  lift: spring(520, 30),
  // critically damped, 16ms: one frame of smoothing that hides pointer jitter
  follow: spring(3600, 120),
  // leans into the hand's speed and sways back through a fraction of a degree
  tilt: spring(260, 20),
  // neighbours: near-critical, so they glide out of the way without bouncing
  reflow: spring(380, 36),
  footprint: spring(700, 50),
  // lands with the release's momentum and a small overshoot
  drop: spring(420, 30),
  // the squash on contact rings once and a bit (of a ≤2.2% squash)
  squash: spring(700, 20),
  // the cast shadow tucks in without bouncing
  shadow: spring(300, 34),
  // the pin: the tack's anticipation and strike (the widget never moves)
  pinUp: spring(900, 42),
  strike: spring(1600, 44),
  // unpin: the tack pops and tips away
  pop: spring(500, 22),
  // a tug on a pinned widget: its tack strains and springs back, and wobbles
  resist: spring(600, 30),
  wiggle: spring(900, 18),
  // resize: the shell
  morph: spring(420, 38),
  // the drawer: tile to slot, slot to pull
  rise: spring(300, 26),
  stow: spring(380, 34),
}

export type MotionMode = "full" | "low" | "reduced"
// low power: every spring critically damped and a little stiffer, so nothing
// overshoots and everything is done about as soon
export const LOW_STIFFNESS = 1.4
export function modeSpring(s: Spring, mode: MotionMode): Spring {
  if (mode !== "low") return s
  const k = s.stiffness * LOW_STIFFNESS
  return { stiffness: k, damping: 2 * sqrt(k * s.mass), mass: s.mass }
}

// --- the hand ---

export interface Sample { x: number; y: number; t: number }
// the carried widget's speed at release is clamped to this (px/s)
export const RELEASE_MAX = 2400
// tilt: degrees per px/s of horizontal speed, and the most it leans
export const TILT_PER_SPEED = 0.004, TILT_MAX = 2

// The hand's velocity (px/s): the least-squares slope of the samples in the
// last windowMs before the newest one. Under two samples: still.
export function pointerVelocity(samples: Sample[], windowMs = 48): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 }
  let newest = -Infinity
  for (const s of samples) newest = max(newest, s.t)
  let n = 0, st = 0, sx = 0, sy = 0
  for (const s of samples) if (newest - s.t <= windowMs) { n++; st += s.t; sx += s.x; sy += s.y }
  if (n < 2) return { vx: 0, vy: 0 }
  const mt = st / n, mx = sx / n, my = sy / n
  let tt = 0, tx = 0, ty = 0
  for (const s of samples) {
    if (newest - s.t > windowMs) continue
    const d = s.t - mt
    tt += d * d; tx += d * (s.x - mx); ty += d * (s.y - my)
  }
  if (!(tt > 0)) return { vx: 0, vy: 0 }
  return { vx: (tx / tt) * 1000, vy: (ty / tt) * 1000 }
}

export function tiltFor(vx: number): number {
  return max(-TILT_MAX, min(TILT_MAX, (isFinite(vx) ? vx : 0) * TILT_PER_SPEED))
}

// The contact squash's impulse (per second) for a landing at `speed` px/s:
// flatter and wider, harder the faster it came in (1.2–2.2% at its deepest).
export function squashImpulse(speed: number): { sx: number; sy: number } {
  const s = max(0, min(1, (isFinite(speed) ? abs(speed) : 0) / 1500))
  const sy = -(0.5 + 0.45 * s)
  return { sx: -0.6 * sy, sy }
}

// --- bodies and the animator ---

export interface Body {
  readonly key: string
  pose(): Pose
  velocity(): Pose
  // where each channel is headed (a delayed target counts)
  target(): Pose
  // Retarget: keeps value and velocity (unless a velocity is given). With a
  // delay (ms) the channel keeps heading for its old target until then.
  to(values: Partial<Pose>, spring: Spring, o?: { velocity?: Partial<Pose>; delay?: number }): void
  // value = target, velocity 0
  jump(values: Partial<Pose>): void
  // add to value and target (a FLIP rebase: the motion carries on as it was)
  shift(values: Partial<Pose>): void
  // add velocity (squash impulses, wiggles); spring: what brings it back
  // (default: the channel's own, else reflow)
  kick(velocity: Partial<Pose>, spring?: Spring): void
  // time-based linear opacity (reduced motion's crossfades)
  fade(opacity: number, ms: number): void
  resting(): boolean
  // called each time the body comes to rest (once per rest); unsubscribe
  onRest(cb: () => void): () => void
}

export interface Scheduler { now(): number; request(cb: (t: number) => void): number; cancel(id: number): void }

// requestAnimationFrame where there is one; elsewhere frames are the
// caller's to drive (tests call frame())
function defaultScheduler(): Scheduler {
  const g: any = typeof globalThis !== "undefined" ? globalThis : {}
  const now = () => (g.performance && typeof g.performance.now === "function" ? g.performance.now() : Date.now())
  if (typeof g.requestAnimationFrame === "function") {
    return { now, request: (cb) => g.requestAnimationFrame(cb), cancel: (id) => g.cancelAnimationFrame(id) }
  }
  if (typeof g.setTimeout === "function") {
    return { now, request: (cb) => g.setTimeout(() => cb(now()), 16), cancel: (id) => g.clearTimeout(id) }
  }
  return { now, request: () => 0, cancel: () => {} }
}

interface Track {
  value: number; velocity: number; target: number
  spring: Spring | null
  moving: boolean
  // a retarget waiting for its delay
  pending: { target: number; spring: Spring; at: number; velocity: number | null } | null
  fade: { from: number; to: number; start: number; ms: number } | null
}

const finite = (v: unknown): v is number => typeof v === "number" && isFinite(v)
// tilt, wobble and squash: low power has none of them (they jump, kicks do nothing)
const SWAY: Partial<Record<Channel, true>> = { rotate: true, sx: true, sy: true }

class BodyImpl implements Body {
  readonly key: string
  readonly tracks: Record<Channel, Track>
  // handed to render; rewritten in place
  readonly shown: Pose
  active = false
  dirty = false
  since = 0
  listeners: (() => void)[] = []
  private anim: Animator

  constructor(key: string, anim: Animator) {
    this.key = key
    this.anim = anim
    const tracks = {} as Record<Channel, Track>
    const shown = {} as Pose
    for (const ch of CHANNELS) {
      tracks[ch] = { value: REST_POSE[ch], velocity: 0, target: REST_POSE[ch], spring: null, moving: false, pending: null, fade: null }
      shown[ch] = REST_POSE[ch]
    }
    this.tracks = tracks
    this.shown = shown
  }

  private read(pick: (t: Track) => number): Pose {
    const out = {} as Pose
    for (const ch of CHANNELS) out[ch] = pick(this.tracks[ch])
    return out
  }
  pose(): Pose { return this.read((t) => t.value) }
  velocity(): Pose { return this.read((t) => t.velocity) }
  target(): Pose { return this.read((t) => (t.pending ? t.pending.target : t.target)) }

  to(values: Partial<Pose>, spring: Spring, o?: { velocity?: Partial<Pose>; delay?: number }): void {
    const mode = this.anim.mode
    const delay = o && finite(o.delay) && o.delay > 0 && mode === "full" ? o.delay : 0
    for (const ch of CHANNELS) {
      const v = values[ch]
      if (!finite(v)) continue
      const t = this.tracks[ch]
      const given = o && o.velocity ? o.velocity[ch] : undefined
      if (mode === "reduced" || (mode === "low" && SWAY[ch])) { this.set(t, v); this.dirty = true; continue }
      if (delay > 0) {
        t.pending = { target: v, spring, at: this.anim.clock() + delay, velocity: finite(given) ? given : null }
        continue
      }
      t.pending = null
      t.fade = null
      t.target = v
      t.spring = spring
      if (finite(given)) t.velocity = given
      t.moving = true
    }
    this.anim.wake(this)
  }

  private set(t: Track, v: number) {
    t.value = v; t.target = v; t.velocity = 0
    t.moving = false; t.pending = null; t.fade = null
  }

  jump(values: Partial<Pose>): void {
    for (const ch of CHANNELS) {
      const v = values[ch]
      if (finite(v)) this.set(this.tracks[ch], v)
    }
    this.dirty = true
    this.anim.wake(this)
  }

  shift(values: Partial<Pose>): void {
    for (const ch of CHANNELS) {
      const d = values[ch]
      if (!finite(d) || d === 0) continue
      const t = this.tracks[ch]
      t.value += d; t.target += d
      if (t.pending) t.pending.target += d
      if (t.fade) { t.fade.from += d; t.fade.to += d }
    }
    this.dirty = true
    this.anim.wake(this)
  }

  kick(velocity: Partial<Pose>, spring?: Spring): void {
    const mode = this.anim.mode
    if (mode === "reduced") return
    for (const ch of CHANNELS) {
      const dv = velocity[ch]
      if (!finite(dv) || dv === 0 || (mode === "low" && SWAY[ch])) continue
      const t = this.tracks[ch]
      if (t.fade) continue
      t.velocity += dv
      if (spring) t.spring = spring
      else if (!t.spring) t.spring = MOTION.reflow
      t.moving = true
    }
    this.anim.wake(this)
  }

  fade(opacity: number, ms: number): void {
    if (!finite(opacity)) return
    const t = this.tracks.opacity
    if (!(ms > 0)) { this.jump({ opacity }); return }
    t.pending = null
    t.velocity = 0
    t.target = opacity
    t.fade = { from: t.value, to: opacity, start: this.anim.clock(), ms }
    t.moving = true
    this.anim.wake(this)
  }

  resting(): boolean {
    for (const ch of CHANNELS) {
      const t = this.tracks[ch]
      if (t.moving || t.pending || t.fade) return false
    }
    return true
  }

  onRest(cb: () => void): () => void {
    this.listeners = this.listeners.concat([cb])
    return () => { this.listeners = this.listeners.filter((other) => other !== cb) }
  }

  // advance every channel from t0 to t1 (ms); true if anything changed
  advance(t0: number, t1: number, mode: MotionMode): boolean {
    let changed = false
    const from = max(t0, this.since)
    for (const ch of CHANNELS) {
      const t = this.tracks[ch]
      if (!t.moving && !t.pending && !t.fade) continue
      const before = t.value
      let start = from
      if (t.fade) {
        const f = t.fade
        const p = (t1 - f.start) / f.ms
        if (p >= 1) { t.value = f.to; t.fade = null; t.moving = false }
        else t.value = f.from + (f.to - f.from) * max(0, p)
      } else {
        const pend = t.pending
        if (pend && pend.at <= t1) {
          // heading for the old target until the delay is up, then the new one
          const split = max(start, pend.at)
          if (t.moving) this.step(t, ch, (split - start) / 1000, mode)
          t.target = pend.target
          t.spring = pend.spring
          if (pend.velocity !== null) t.velocity = pend.velocity
          t.pending = null
          t.moving = true
          start = split
        }
        if (t.moving) this.step(t, ch, (t1 - start) / 1000, mode)
      }
      if (t.value !== before) changed = true
    }
    return changed
  }

  private step(t: Track, ch: Channel, dt: number, mode: MotionMode) {
    const s = t.spring ? modeSpring(t.spring, mode) : null
    if (s && dt > 0) {
      solve(s.stiffness, s.damping, s.mass, t.value - t.target, t.velocity, dt)
      t.value = t.target + outX
      t.velocity = outV
    } else if (!s) {
      t.value = t.target; t.velocity = 0
    }
    const rest = REST[ch]
    if (abs(t.value - t.target) <= rest.delta && abs(t.velocity) <= rest.speed) {
      t.value = t.target; t.velocity = 0; t.moving = false
    }
  }

  sync() {
    for (const ch of CHANNELS) this.shown[ch] = this.tracks[ch].value
  }
}

export class Animator {
  private bodies: Record<string, BodyImpl> = {}
  private active: BodyImpl[] = []
  private hooks: ((now: number, dt: number) => void)[] = []
  private idlers: (() => void)[] = []
  private sched: Scheduler
  private render: (key: string, pose: Pose, resting: boolean) => void
  private requested = 0
  private ticking = false
  private inFrame = false
  private frameNow = 0
  private last = 0
  private current: MotionMode = "full"

  constructor(render: (key: string, pose: Pose, resting: boolean) => void, scheduler?: Scheduler) {
    this.render = render
    this.sched = scheduler ?? defaultScheduler()
    this.last = this.sched.now()
  }

  get mode(): MotionMode { return this.current }
  // a frame is requested only while a body moves or a beforeFrame hook is registered
  get running(): boolean { return this.active.length > 0 || this.hooks.length > 0 }

  // the animator's time: the frame's while one runs, else the scheduler's
  clock(): number { return this.inFrame ? this.frameNow : this.sched.now() }

  // created at REST_POSE
  body(key: string): Body {
    const had = Object.prototype.hasOwnProperty.call(this.bodies, key) ? this.bodies[key] : undefined
    if (had) return had
    const b = new BodyImpl(key, this)
    this.bodies[key] = b
    return b
  }
  has(key: string): boolean { return Object.prototype.hasOwnProperty.call(this.bodies, key) }

  // forget a body (its element is gone); nothing is rendered for it again
  drop(key: string): void {
    const b = Object.prototype.hasOwnProperty.call(this.bodies, key) ? this.bodies[key] : undefined
    if (!b) return
    delete this.bodies[key]
    b.active = false
    // mid-frame the frame's loop sweeps it out
    if (!this.inFrame) {
      const i = this.active.indexOf(b)
      if (i >= 0) this.active.splice(i, 1)
    }
  }

  // the drag controller's step: same frame, runs first
  beforeFrame(cb: (now: number, dt: number) => void): () => void {
    this.hooks = this.hooks.concat([cb])
    this.schedule()
    return () => { this.hooks = this.hooks.filter((other) => other !== cb) }
  }

  // called whenever every body has come to rest and no hook is left
  onIdle(cb: () => void): () => void {
    this.idlers = this.idlers.concat([cb])
    return () => { this.idlers = this.idlers.filter((other) => other !== cb) }
  }

  // a body has something to do
  wake(b: BodyImpl): void {
    // a dropped body's element is gone
    if (!this.has(b.key) || this.bodies[b.key] !== b) return
    if (!b.active) {
      b.active = true
      b.since = this.clock()
      this.active.push(b)
    }
    this.schedule()
  }

  private schedule() {
    if (!this.ticking) {
      // waking from idle: time starts now, not at the last frame long ago
      this.ticking = true
      if (!this.inFrame) this.last = this.sched.now()
    }
    if (!this.requested && !this.inFrame) this.requested = this.sched.request((t) => this.frame(t)) || -1
  }

  // Advance every active body to `now` and render the ones that changed
  // (tests call this directly).
  frame(now: number): void {
    // called directly while a frame is on order: that one would be a second
    // frame every tick from now on
    const pending = this.requested
    this.requested = 0
    if (pending && pending !== -1) this.sched.cancel(pending)
    const t0 = this.last
    const t1 = max(t0, now)
    const dt = t1 - t0
    this.last = t1
    this.inFrame = true
    this.frameNow = t1
    try {
      const hooks = this.hooks
      for (let i = 0; i < hooks.length; i++) hooks[i](t1, dt)
      const list = this.active
      const still: BodyImpl[] = []
      let keep = 0
      for (let i = 0; i < list.length; i++) {
        const b = list[i]
        if (!b.active) continue
        const changed = b.advance(t0, t1, this.current)
        const resting = b.resting()
        if (changed || b.dirty) {
          b.sync()
          b.dirty = false
          this.render(b.key, b.shown, resting)
        }
        if (resting) { b.active = false; still.push(b) }
        else list[keep++] = b
      }
      list.length = keep
      for (const b of still) {
        const cbs = b.listeners
        for (let i = 0; i < cbs.length; i++) cbs[i]()
      }
    } finally {
      this.inFrame = false
    }
    if (this.running) {
      if (!this.requested) this.requested = this.sched.request((t) => this.frame(t)) || -1
    } else if (this.ticking) {
      this.ticking = false
      const cbs = this.idlers
      for (let i = 0; i < cbs.length; i++) cbs[i]()
    }
  }

  // render every body changed since the last frame now, without advancing
  // time (a drop's FLIP needs its offsets on screen before the next paint)
  flush(): void {
    for (const b of this.active) {
      if (!b.dirty) continue
      b.sync()
      b.dirty = false
      this.render(b.key, b.shown, b.resting())
    }
  }

  // low: every spring critically damped at LOW_STIFFNESS×, no stagger, and
  // no tilt, wobble or squash (rotate/sx/sy jump; kicks on them do nothing);
  // reduced: to() jumps, and whatever is moving is where it was headed now
  setMode(mode: MotionMode): void {
    if (mode === this.current) return
    this.current = mode
    if (mode === "full") return
    const keys = Object.keys(this.bodies)
    for (const key of keys) {
      const b = this.bodies[key]
      let moved = false
      for (const ch of CHANNELS) {
        const t = b.tracks[ch]
        if (t.fade || (mode === "low" && !SWAY[ch])) continue
        if (!t.moving && !t.pending) continue
        const v = t.pending ? t.pending.target : t.target
        t.value = v; t.target = v; t.velocity = 0; t.moving = false; t.pending = null
        moved = true
      }
      if (moved) { b.dirty = true; this.wake(b) }
    }
  }

  // stop for good (the desk unmounts)
  dispose(): void {
    if (this.requested && this.requested !== -1) this.sched.cancel(this.requested)
    this.requested = 0
    this.ticking = false
    this.bodies = {}
    this.active = []
    this.hooks = []
    this.idlers = []
  }
}
