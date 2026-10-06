// The desk's motion (lib/spring.ts): the exact spring against a numerical
// integrator, retargeting that keeps momentum, the motion tokens' numbers
// (SPEC2 §7.2), the rubber band, the hand's speed, and the animator on a
// fake clock (frames only while something moves, delays, rests, the FLIP
// shift, low power and reduced motion).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
function loadModule(name) {
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const exports = {}
  // wrapped in a function: in a vm, names at a script's top level are slow to read
  vm.runInNewContext(`(function (exports, require) {${compiled}\n})`, {}, { filename: `lib/${name}.ts` })(exports, () => ({}))
  return exports
}

const {
  dampingRatio, springStep, settleTime, rubberBand, CHANNELS, REST_POSE, REST, MOTION, LOW_STIFFNESS, modeSpring,
  RELEASE_MAX, TILT_MAX, pointerVelocity, tiltFor, squashImpulse, Animator,
} = loadModule("spring")

const plain = (v) => JSON.parse(JSON.stringify(v))
const deep = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message)
const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`)
const spring = (stiffness, damping, mass = 1) => ({ stiffness, damping, mass })

// requestAnimationFrame on a clock the test turns
function fakeClock() {
  let t = 0, next = 0
  const queue = new Map()
  return {
    now: () => t,
    request: (cb) => { queue.set(++next, cb); return next },
    cancel: (id) => { queue.delete(id) },
    pending: () => queue.size,
    tick(ms = 16) {
      t += ms
      const run = [...queue.values()]
      queue.clear()
      for (const cb of run) cb(t)
    },
    // frames until nothing asks for one (or the cap)
    settle(ms = 16, cap = 400) {
      let n = 0
      while (queue.size && n++ < cap) this.tick(ms)
      return n
    },
  }
}
function rig(mode) {
  const clock = fakeClock()
  const log = []
  const anim = new Animator((key, pose, resting) => log.push({ key, pose: { ...pose }, resting, t: clock.now() }), clock)
  if (mode) anim.setMode(mode)
  return { clock, log, anim }
}

// 1. the closed form matches RK4 at 0.1ms steps, under-, critically and over-damped
{
  const rk4 = (s, x, v, target, T, h = 1e-4) => {
    const acc = (x, v) => (-s.stiffness * (x - target) - s.damping * v) / s.mass
    for (let t = 0; t < T - 1e-12; t += h) {
      const k1x = v, k1v = acc(x, v)
      const k2x = v + (h / 2) * k1v, k2v = acc(x + (h / 2) * k1x, v + (h / 2) * k1v)
      const k3x = v + (h / 2) * k2v, k3v = acc(x + (h / 2) * k2x, v + (h / 2) * k2v)
      const k4x = v + h * k3v, k4v = acc(x + h * k3x, v + h * k3v)
      x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x)
      v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)
    }
    return { x, v }
  }
  for (const zeta of [0.3, 1, 2]) {
    for (const [k, m] of [[400, 1], [900, 2.5]]) {
      const s = spring(k, 2 * zeta * Math.sqrt(k * m), m)
      close(dampingRatio(s), zeta, 1e-12, "the damping ratio")
      for (const [x0, v0, target] of [[0, 0, 100], [30, -800, -20], [5, 2400, 5]]) {
        for (const T of [0.016, 0.1, 0.35]) {
          const want = rk4(s, x0, v0, target, T)
          const got = springStep(s, x0, v0, target, T)
          close(got.value, want.x, 1e-6, `ζ ${zeta}, k ${k}, m ${m}, ${T}s: value`)
          close(got.velocity, want.v, 1e-5, `ζ ${zeta}, k ${k}, m ${m}, ${T}s: velocity`)
        }
      }
    }
  }
  // the edges: no time changes nothing; forever is the target
  deep(springStep(MOTION.drop, 3, 7, 50, 0), { value: 3, velocity: 7 })
  deep(springStep(MOTION.drop, 3, 7, 50, -1), { value: 3, velocity: 7 })
  const forever = springStep(MOTION.drop, 3, 7, 50, 1e6)
  close(forever.value, 50, 1e-9, "at the end of time"); close(forever.velocity, 0, 1e-9, "and still")
}
console.log("PASS springStep: the exact closed form matches RK4 at 0.1ms for ζ 0.3, 1 and 2")

// 2. exact for any dt: one 100ms step is ten 10ms steps (and any other split)
{
  for (const name of Object.keys(MOTION)) {
    const s = MOTION[name]
    const one = springStep(s, 0, 300, 216, 0.1)
    let step = { value: 0, velocity: 300 }
    for (let i = 0; i < 10; i++) step = springStep(s, step.value, step.velocity, 216, 0.01)
    close(step.value, one.value, 1e-9, `${name}: value`)
    close(step.velocity, one.velocity, 1e-8, `${name}: velocity`)
    let odd = { value: 0, velocity: 300 }
    for (const dt of [0.003, 0.041, 0.0005, 0.0555]) odd = springStep(s, odd.value, odd.velocity, 216, dt)
    close(odd.value, one.value, 1e-9, `${name}: uneven frames`)
  }
}
console.log("PASS springStep: exact for any frame length")

// 3. retargeting mid-flight keeps value and velocity continuous
{
  const { clock, anim } = rig()
  const b = anim.body("w")
  b.to({ x: 200 }, MOTION.reflow)
  for (let i = 0; i < 5; i++) clock.tick(16)
  const x = b.pose().x, v = b.velocity().x
  assert.ok(x > 0 && x < 200 && v > 0, "mid-flight")
  b.to({ x: -100 }, MOTION.drop)
  assert.equal(b.pose().x, x, "retargeting doesn't move it")
  assert.equal(b.velocity().x, v, "nor change its speed")
  assert.equal(b.target().x, -100)
  clock.tick(1)
  const x1 = b.pose().x, v1 = b.velocity().x
  // one millisecond on: where its speed took it, and its speed barely changed
  close(x1, x + v * 0.001, Math.abs(MOTION.drop.stiffness * (x + 100)) * 1e-6 + 1e-3, "position is continuous")
  close(v1, v, (MOTION.drop.stiffness * Math.abs(x + 100) + MOTION.drop.damping * Math.abs(v)) * 0.0011, "velocity is continuous")
  assert.ok(x1 > x, "momentum carries it on past the turn")
  // a velocity handed over (a release) replaces its own
  b.to({ x: 0 }, MOTION.drop, { velocity: { x: 1800 } })
  assert.equal(b.velocity().x, 1800)
  clock.settle()
  assert.equal(b.pose().x, 0); assert.ok(b.resting())
}
console.log("PASS retargeting keeps value and velocity; a handed-over velocity is taken as is")

// 4. the tokens: damping ratio, overshoot and settle time as SPEC2 §7.2 lists them
{
  // [ζ, overshoot %, settle ms, how the settle was measured: distance, launch speed, rest band]
  const TABLE = {
    lift: [0.66, 6.4, 400, 30, 0, 0.1], follow: [1.0, 0, 156, 216], tilt: [0.62, 8.3, 600, 216], reflow: [0.92, 0.1, 350, 216],
    footprint: [0.94, 0, 280, 216], drop: [0.73, 3.4, 400, 216], squash: [0.38, 27.7, 440, 30], shadow: [0.98, 0, 450, 216],
    pinUp: [0.70, 4.6, 275, 216], strike: [0.55, 12.6, 270, 216], pop: [0.49, 16.9, 570, 216],
    resist: [0.61, 8.8, 430, 216], wiggle: [0.30, 37.2, 410, 0, 480], morph: [0.93, 0, 340, 216], rise: [0.75, 2.8, 470, 216],
    stow: [0.87, 0.4, 390, 216],
  }
  deep(Object.keys(MOTION).sort(), Object.keys(TABLE).sort(), "every token, and only those")
  const overshoot = (s) => {
    let x = -216, v = 0, peak = 0
    for (let i = 0; i < 3000; i++) { const n = springStep(s, x, v, 0, 0.001); x = n.value; v = n.velocity; peak = Math.max(peak, x / 216) }
    return peak * 100
  }
  for (const name of Object.keys(TABLE)) {
    const [zeta, over, settle, distance, velocity = 0, band = 0.5] = TABLE[name]
    const s = MOTION[name]
    assert.equal(s.mass, 1)
    close(dampingRatio(s), zeta, 0.006, `${name} ζ`)
    close(overshoot(s), over, 0.5, `${name} overshoot`)
    const ms = settleTime(s, distance, velocity, band) * 1000
    assert.ok(Math.abs(ms - settle) <= settle * 0.1, `${name} settles in ${ms}ms, not ~${settle}ms`)
  }
  close(1000 / Math.sqrt(MOTION.follow.stiffness), 16.7, 0.1, "follow: a 16ms time constant")
  // flung: the drop keeps the release speed and still lands within ~340ms
  const flung = settleTime(MOTION.drop, 120, 1800) * 1000
  assert.ok(flung >= 300 && flung <= 400, `a flung drop settles in ${flung}ms`)
  // low power: critically damped at 1.4× stiffness, done about as soon (reflow ~360ms, drop ~345ms)
  for (const [name, ms] of [["reflow", 360], ["drop", 345]]) {
    const low = modeSpring(MOTION[name], "low")
    close(dampingRatio(low), 1, 1e-12, `low ${name} ζ`)
    assert.equal(low.stiffness, MOTION[name].stiffness * LOW_STIFFNESS)
    close(overshoot(low), 0, 1e-9, `low ${name} never overshoots`)
    const t = settleTime(low, 216) * 1000
    assert.ok(Math.abs(t - ms) <= ms * 0.1, `low ${name} settles in ${t}ms`)
  }
  assert.equal(modeSpring(MOTION.drop, "full"), MOTION.drop)
  assert.equal(modeSpring(MOTION.drop, "reduced"), MOTION.drop)
  assert.equal(settleTime(MOTION.drop, 0.1, 1), 0, "already at rest")
}
console.log("PASS the 17 tokens: damping ratio, overshoot and settle time as SPEC2 lists them, and low power's")

// 5. the rubber band: odd, monotone, bounded by its limit
{
  let last = -Infinity
  for (let o = -500; o <= 500; o += 0.5) {
    const r = rubberBand(o, 24)
    assert.ok(Math.abs(r) < 24, "bounded")
    assert.ok(r > last, "monotone")
    close(rubberBand(-o, 24), -r, 1e-12, "odd")
    assert.ok(Math.abs(r) <= Math.abs(o) + 1e-12, "never more than the pull")
    last = r
  }
  assert.equal(rubberBand(0, 24), 0)
  deep([10, 40, 160].map((o) => Math.round(rubberBand(o, 24) * 10) / 10), [7.1, 15, 20.9], "10px → 7, 40px → 15, 160px → 21")
  assert.equal(rubberBand(50, 0), 0); assert.equal(rubberBand(NaN, 24), 0)
}
console.log("PASS rubberBand: odd, monotone and bounded (10 → 7.1, 40 → 15, 160 → 20.9)")

// 6. the animator on a fake clock
{
  // a frame is asked for only while something moves; it renders only what changed
  const { clock, log, anim } = rig()
  const a = anim.body("a"), b = anim.body("b")
  assert.equal(anim.running, false); assert.equal(clock.pending(), 0, "nothing moves: no frame")
  deep(a.pose(), REST_POSE)
  a.to({ x: 100, scale: 1.03 }, MOTION.lift)
  assert.equal(anim.running, true); assert.equal(clock.pending(), 1)
  a.to({ lift: 1 }, MOTION.lift)
  assert.equal(clock.pending(), 1, "one frame, however many bodies move")
  clock.tick(16)
  assert.ok(log.length === 1 && log[0].key === "a", "only the moving body renders")
  assert.ok(log[0].pose.x > 0 && log[0].pose.x < 100 && log[0].resting === false)
  const frames = clock.settle()
  assert.ok(frames > 10 && frames < 60, `rested after ${frames} frames`)
  assert.equal(clock.pending(), 0, "every body rests: no more frames")
  assert.equal(anim.running, false)
  assert.ok(log.every((e) => e.key === "a"), "b never rendered")
  const last = log[log.length - 1]
  assert.equal(last.resting, true)
  deep(last.pose, { ...REST_POSE, x: 100, scale: 1.03, lift: 1 }, "it rests exactly on its targets")
  for (let i = 1; i < log.length; i++) assert.ok(log[i].t > log[i - 1].t, "one render per frame")
  assert.ok(b.resting(), "b never moved")

  // back to REST_POSE: the last render says so (the renderer clears its styles then)
  a.to({ x: 0, scale: 1, lift: 0 }, MOTION.drop)
  clock.settle()
  deep(log[log.length - 1].pose, REST_POSE); assert.equal(log[log.length - 1].resting, true)

  // onRest: once per rest
  let rests = 0
  const off = a.onRest(() => rests++)
  a.to({ y: 40 }, MOTION.reflow); clock.settle()
  assert.equal(rests, 1, "once when it comes to rest")
  clock.tick(16); clock.tick(16)
  assert.equal(rests, 1, "not again while it stays still")
  b.to({ x: 10 }, MOTION.reflow); clock.settle()
  assert.equal(rests, 1, "not for another body")
  a.to({ y: 0 }, MOTION.reflow); clock.settle()
  assert.equal(rests, 2, "and again at the next rest")
  off()
  a.to({ y: 5 }, MOTION.reflow); clock.settle()
  assert.equal(rests, 2, "unsubscribed")
  // onIdle: when the whole desk comes to rest
  let idles = 0
  anim.onIdle(() => idles++)
  a.to({ x: 50 }, MOTION.reflow); b.to({ x: 0 }, MOTION.drop)
  clock.settle()
  assert.equal(idles, 1)
}
{
  // delay: the channel keeps heading for its old target until then
  const { clock, log, anim } = rig()
  const a = anim.body("a"), n = anim.body("n")
  a.to({ x: 100 }, MOTION.reflow)
  clock.tick(16)
  a.to({ x: -100 }, MOTION.reflow, { delay: 64 })
  assert.equal(a.target().x, -100, "target() tells where it's headed")
  let prev = a.pose().x
  for (let t = 16; t < 64; t += 16) {
    clock.tick(16)
    assert.ok(a.pose().x > prev, `still heading for 100 at ${t + 16}ms`)
    prev = a.pose().x
  }
  clock.tick(16); clock.tick(16); clock.tick(16)
  assert.ok(a.velocity().x < 0, "then for -100")
  clock.settle()
  assert.equal(a.pose().x, -100)
  // a delayed start from rest renders nothing until it's due, and the frames keep coming
  log.length = 0
  n.to({ x: 30 }, MOTION.reflow, { delay: 100 })
  clock.tick(16); clock.tick(16); clock.tick(16); clock.tick(16); clock.tick(16); clock.tick(16)
  assert.equal(log.length, 0, "held")
  assert.equal(clock.pending(), 1, "but still ticking")
  clock.tick(16)
  assert.ok(log.length === 1 && log[0].pose.x > 0, "off it goes")
  // the delay is exact: started mid-frame, it moves by the time since it was due
  const { clock: c2, anim: an2 } = rig()
  const d1 = an2.body("d")
  d1.to({ x: 30 }, MOTION.reflow, { delay: 100 })
  c2.tick(116)
  close(d1.pose().x, 30 + springStep(MOTION.reflow, -30, 0, 0, 0.016).value, 1e-9, "16ms past its delay")
}
{
  // shift (the FLIP rebase): the motion carries on exactly as it was, offset
  const { clock, anim } = rig()
  const a = anim.body("a"), b = anim.body("b")
  a.to({ x: 216, y: -40 }, MOTION.drop); b.to({ x: 216, y: -40 }, MOTION.drop)
  clock.tick(16); clock.tick(16); clock.tick(16)
  b.shift({ x: -216, y: 432 })
  close(b.pose().x + 216, a.pose().x, 1e-9, "nothing moves on screen (x)")
  close(b.pose().y - 432, a.pose().y, 1e-9, "nothing moves on screen (y)")
  deep([b.target().x, b.target().y], [0, 392])
  for (let i = 0; i < 40; i++) {
    clock.tick(16)
    close(b.pose().x + 216, a.pose().x, 1e-9, "x carries on")
    close(b.pose().y - 432, a.pose().y, 1e-9, "y carries on")
    close(b.velocity().x, a.velocity().x, 1e-9, "same speed")
  }
  // shifting a resting body renders the offset (on flush, before the next paint)
  const { clock: c2, log, anim: an2 } = rig()
  const r = an2.body("r")
  r.shift({ x: 40 })
  an2.flush()
  assert.ok(log.length === 1 && log[0].pose.x === 40 && log[0].resting === true, "flushed at once")
  assert.equal(c2.pending(), 1)
  c2.settle()
  assert.equal(log.length, 1, "and not rendered again")
  r.to({ x: 0 }, MOTION.drop); c2.settle()
  assert.equal(r.pose().x, 0)
}
{
  // kick: an impulse that springs back (the squash, the wiggle)
  const { clock, anim } = rig()
  const b = anim.body("w")
  const imp = squashImpulse(0)
  b.kick({ sy: imp.sy, sx: imp.sx }, MOTION.squash)
  let min = 1, at = 0
  for (let t = 1; t <= 600; t++) { clock.tick(1); if (b.pose().sy < min) { min = b.pose().sy; at = t } }
  close(1 - min, 0.012, 0.001, "a 1.2% squash"); close(at, 49, 2, "at 49ms")
  assert.ok(b.resting()); assert.equal(b.pose().sy, 1)
  const hard = squashImpulse(3000)
  deep(hard, { sx: 0.57, sy: -0.95 })
  assert.ok(Math.abs(squashImpulse(750).sy) > Math.abs(squashImpulse(0).sy))
  const hit = springStep(MOTION.squash, 0, hard.sy, 0, 0.049)
  close(-hit.value, 0.022, 0.001, "2.2% when it came in fast")
  // a kick with no spring of its own uses reflow
  const k = anim.body("k")
  k.kick({ rotate: 27 })
  clock.tick(16)
  assert.ok(k.pose().rotate > 0)
  clock.settle(); assert.equal(k.pose().rotate, 0)
}
{
  // beforeFrame: the drag step runs first, every frame, while registered
  const { clock, anim, log } = rig()
  const b = anim.body("carried")
  const calls = []
  const off = anim.beforeFrame((now, dt) => { calls.push([now, dt, b.pose().x]); b.to({ x: now }, MOTION.follow) })
  assert.equal(anim.running, true); assert.equal(clock.pending(), 1)
  clock.tick(16); clock.tick(16); clock.tick(20)
  deep(calls.map(([now, dt]) => [now, dt]), [[16, 16], [32, 16], [52, 20]])
  assert.ok(calls[2][2] > 0, "the hook sees last frame's pose")
  assert.ok(log.length >= 2)
  off()
  clock.settle()
  assert.equal(anim.running, false); assert.equal(clock.pending(), 0)
  // waking after a long quiet spell: time starts at the wake, not at the last frame
  clock.tick(5000)
  const gaps = []
  const off2 = anim.beforeFrame((now, dt) => gaps.push(dt))
  clock.tick(16)
  deep(gaps, [16], "no 5-second step")
  off2(); clock.settle()
  // a frame run by hand while one is on order doesn't leave two running
  const direct = anim.body("direct")
  direct.to({ x: 100 }, MOTION.reflow)
  assert.equal(clock.pending(), 1)
  anim.frame(clock.now() + 8)
  assert.equal(clock.pending(), 1, "still one frame on order")
  let rendersPerTick = log.length
  clock.tick(16)
  assert.equal(log.length - rendersPerTick, 1, "one render a tick")
  clock.settle()
  // dropped bodies are forgotten; dispose cancels the frame
  b.to({ x: 500 }, MOTION.reflow)
  anim.drop("carried")
  const before = log.length
  clock.settle()
  assert.equal(log.length, before, "a dropped body renders no more")
  b.to({ x: 0 }, MOTION.reflow)
  assert.equal(anim.running, false, "and can't be woken")
  const fresh = anim.body("carried")
  assert.notEqual(fresh, b); deep(fresh.pose(), REST_POSE)
  fresh.to({ x: 3 }, MOTION.reflow)
  anim.dispose()
  assert.equal(clock.pending(), 0)
}
{
  // low power: no overshoot anywhere, and no stagger
  const { clock, anim } = rig("low")
  assert.equal(anim.mode, "low")
  const b = anim.body("b")
  b.to({ x: 216, scale: 1.03 }, MOTION.lift)
  let peak = 0, peakScale = 0
  for (let i = 0; i < 100; i++) { clock.tick(16); peak = Math.max(peak, b.pose().x); peakScale = Math.max(peakScale, b.pose().scale) }
  assert.ok(peak <= 216 + 1e-9 && peakScale <= 1.03 + 1e-12, `no overshoot (${peak}, ${peakScale})`)
  const d = anim.body("d")
  d.to({ x: 50 }, MOTION.reflow, { delay: 120 })
  clock.tick(16)
  assert.ok(d.pose().x > 0, "no stagger: it goes at once")
  // and no tilt, wobble or squash: rotate and sx/sy jump, kicks on them are nothing
  const t = anim.body("t")
  t.to({ rotate: 2, x: 20 }, MOTION.tilt)
  assert.equal(t.pose().rotate, 2, "rotate jumps"); assert.ok(t.pose().x < 20, "x still springs")
  t.to({ rotate: 0 }, MOTION.tilt)
  t.kick({ rotate: 480, sy: -0.9, sx: 0.5 }, MOTION.wiggle)
  deep([t.velocity().rotate, t.velocity().sx, t.velocity().sy], [0, 0, 0])
  clock.settle()
  assert.equal(t.pose().rotate, 0)
  // switching mid-flight keeps it where it is
  const { clock: c2, anim: an2 } = rig()
  const m = an2.body("m")
  m.to({ x: 216 }, MOTION.wiggle); m.to({ rotate: 2 }, MOTION.tilt); c2.tick(16); c2.tick(16)
  const x = m.pose().x, v = m.velocity().x
  assert.ok(m.pose().rotate > 0 && m.pose().rotate < 2)
  an2.setMode("low")
  deep([m.pose().x, m.velocity().x], [x, v], "no jump")
  deep([m.pose().rotate, m.velocity().rotate], [2, 0], "a tilt in progress settles at once")
  c2.settle()
  assert.equal(m.pose().x, 216)
}
{
  // reduced motion: positions jump, delays and kicks don't happen, fades interpolate linearly
  const { clock, log, anim } = rig("reduced")
  const b = anim.body("b")
  b.to({ x: 216, y: 432, scale: 1.03, rotate: 2 }, MOTION.drop, { delay: 200, velocity: { x: 900 } })
  deep(b.pose(), { ...REST_POSE, x: 216, y: 432, scale: 1.03, rotate: 2 }, "at once")
  deep(b.velocity(), { ...REST_POSE, scale: 0, sx: 0, sy: 0, opacity: 0 })
  assert.ok(b.resting())
  clock.tick(16)
  assert.equal(log.length, 1); assert.equal(log[0].resting, true)
  assert.equal(clock.pending(), 0, "one frame to show it, then quiet")
  b.kick({ x: 500 })
  assert.equal(clock.pending(), 0, "a kick is nothing")
  // the crossfade: a dip to 0.6 and back over 120ms
  log.length = 0
  b.jump({ opacity: 0.6 })
  b.fade(1, 120)
  const seen = []
  for (let i = 0; i < 10; i++) { clock.tick(12); seen.push(b.pose().opacity) }
  seen.forEach((o, i) => close(o, 0.6 + 0.4 * Math.min(1, (i + 1) / 10), 1e-9, `linear at ${(i + 1) * 12}ms`))
  assert.ok(b.resting()); assert.equal(clock.pending(), 0)
  assert.equal(log[log.length - 1].resting, true)
  assert.equal(log[log.length - 1].pose.opacity, 1)
  // switching into reduced mid-flight: everything is where it was going
  const { clock: c2, anim: an2 } = rig()
  const m = an2.body("m")
  m.to({ x: 216 }, MOTION.reflow); m.to({ y: 50 }, MOTION.reflow, { delay: 500 }); c2.tick(16)
  an2.setMode("reduced")
  deep([m.pose().x, m.pose().y], [216, 50]); assert.ok(m.resting())
  c2.settle(); assert.equal(c2.pending(), 0)
  // fades work in full motion too, and a to() on opacity takes over from one
  const { clock: c3, anim: an3 } = rig()
  const f = an3.body("f")
  f.fade(0, 160)
  c3.tick(80); close(f.pose().opacity, 0.5, 1e-9, "halfway")
  f.to({ opacity: 1 }, MOTION.reflow)
  c3.settle(); assert.equal(f.pose().opacity, 1)
  f.fade(0.25, 0); assert.equal(f.pose().opacity, 0.25, "no time: a jump")
}
{
  // fake-clock determinism, and frame timing doesn't change the motion
  const run = (frames) => {
    const { clock, log, anim } = rig()
    const a = anim.body("a"), b = anim.body("b")
    a.to({ x: 300, rotate: 2 }, MOTION.drop, { velocity: { x: -600 } })
    b.to({ y: 216 }, MOTION.reflow, { delay: 48 })
    const out = []
    for (const ms of frames) { clock.tick(ms); out.push([clock.now(), a.pose().x, a.pose().rotate, b.pose().y]) }
    return { out, log }
  }
  const even = Array(20).fill(16)
  deep(run(even), run(even), "the same frames, the same motion, the same renders")
  const uneven = [7, 25, 16, 16, 30, 2, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16]
  const e = run(even).out, u = run(uneven).out
  // compare at the times both runs share (the first 320ms, before any snaps to rest)
  for (const row of u) {
    const match = e.find((r) => r[0] === row[0])
    if (!match) continue
    close(row[1], match[1], 1e-9, `x at ${row[0]}ms`); close(row[3], match[3], 1e-9, `y at ${row[0]}ms`)
  }
}
console.log("PASS the animator: frames only while moving, renders only what changed, delays, rests, shift, kick, hooks, low and reduced")

// the hand: speed from the last 48ms, tilt, and the constants
{
  const line = Array.from({ length: 12 }, (_, i) => ({ x: 100 + 2 * i * 8, y: 50 - 0.5 * i * 8, t: 1000 + i * 8 }))
  const v = pointerVelocity(line)
  close(v.vx, 2000, 1e-6, "2px/ms is 2000px/s"); close(v.vy, -500, 1e-6, "and up")
  // only the last 48ms count: an old change of direction is forgotten
  const turned = [...Array.from({ length: 6 }, (_, i) => ({ x: -10 * i, y: 0, t: i * 8 })), ...Array.from({ length: 10 }, (_, i) => ({ x: -50 + 5 * (i + 1), y: 0, t: 48 + (i + 1) * 8 }))]
  close(pointerVelocity(turned).vx, 625, 1e-6, "the recent heading")
  deep(pointerVelocity([]), { vx: 0, vy: 0 }); deep(pointerVelocity([{ x: 1, y: 1, t: 5 }]), { vx: 0, vy: 0 })
  deep(pointerVelocity([{ x: 1, y: 1, t: 5 }, { x: 9, y: 1, t: 5 }]), { vx: 0, vy: 0 }, "no time between them: still")
  // noisy but steady: close to the true speed
  let seed = 9
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2
  const noisy = Array.from({ length: 7 }, (_, i) => ({ x: 1.2 * i * 8 + noise(), y: 0, t: i * 8 }))
  close(pointerVelocity(noisy).vx, 1200, 120, "least squares smooths jitter")
  assert.equal(tiltFor(250), 1); assert.equal(tiltFor(1000), TILT_MAX); assert.equal(tiltFor(-9000), -TILT_MAX); assert.equal(tiltFor(NaN), 0)
  assert.equal(RELEASE_MAX, 2400)
  deep(CHANNELS, ["x", "y", "scale", "sx", "sy", "rotate", "opacity", "lift"])
  deep(REST_POSE, { x: 0, y: 0, scale: 1, sx: 1, sy: 1, rotate: 0, opacity: 1, lift: 0 })
  deep(REST, {
    x: { delta: 0.2, speed: 5 }, y: { delta: 0.2, speed: 5 }, scale: { delta: 0.0005, speed: 0.01 }, sx: { delta: 0.0005, speed: 0.01 },
    sy: { delta: 0.0005, speed: 0.01 }, rotate: { delta: 0.02, speed: 0.5 }, opacity: { delta: 0.002, speed: 0.02 }, lift: { delta: 0.002, speed: 0.02 },
  })
}
console.log("PASS the hand: least-squares speed over 48ms, tilt clamped to 2°, the rest bands")

// budget guard: a busy frame (ten bodies, a hook) is far under the 2ms a frame allows
{
  const { clock, anim } = rig()
  const bodies = Array.from({ length: 10 }, (_, i) => anim.body(`w${i}`))
  let x = 0
  anim.beforeFrame(() => { x += 7; bodies[0].to({ x, y: x / 2, rotate: tiltFor(400) }, MOTION.follow) })
  const warm = () => {
    for (let i = 1; i < 10; i++) bodies[i].to({ x: (clock.now() % 432) - 216, y: i * 20 }, MOTION.reflow, { delay: i * 12 })
    bodies[0].to({ scale: 1.03, lift: 1 }, MOTION.lift)
  }
  for (let i = 0; i < 200; i++) { if (i % 20 === 0) warm(); clock.tick(16) }
  const started = performance.now()
  for (let i = 0; i < 2000; i++) { if (i % 20 === 0) warm(); clock.tick(16) }
  const per = (performance.now() - started) / 2000
  assert.ok(per < 0.5, `${per.toFixed(4)}ms a frame`)
  console.log(`PASS budget: ten moving bodies and a hook cost ${per.toFixed(4)}ms a frame (the frame allows 2ms)`)
}
