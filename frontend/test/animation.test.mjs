import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const cache = new Map()
function load(name, globals = {}) {
  if (cache.has(name)) return cache.get(name)
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: id => load(id.replace(/^\.\//, "")),
    ...globals,
  })
  cache.set(name, module.exports)
  return module.exports
}

const { BlobSet, SURFACE, surfaceDistance } = load("dot-field")
{
  const blobs = new BlobSet()
  blobs.add(-3.2, 7.1, 5.4)
  blobs.add(9.6, 4.2, 3.7, -0.4)
  blobs.add(11.5, -2.6, 4.1, 0.7)
  for (const pitch of [0.7, 1, 6.3, 18]) {
    const w = 29, h = 19, ox = -7.3, oy = -5.4
    const field = new Float32Array(w * h)
    blobs.scatter(field, w, h, pitch, ox, oy)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        assert.ok(Math.abs(field[y * w + x] - blobs.at(ox + x * pitch, oy + y * pitch)) < 1e-6)
      }
    }
  }
  blobs.reset()
  const empty = new Float32Array(12).fill(1)
  blobs.scatter(empty, 4, 3)
  assert.ok(empty.every(v => v === 0))
  assert.ok(Number.isFinite(surfaceDistance(empty, 0, 4)))
  assert.ok(Number.isFinite(surfaceDistance(new Float32Array(1), 0, 1)))
  console.log("PASS  bounded scattering matches point sampling at arbitrary pitch and origin")
}

{
  const blobs = new BlobSet()
  blobs.add(-3.2, 7.1, 5.4)
  blobs.add(9.6, 4.2, 3.7, -0.4)
  blobs.add(11.5, -2.6, 4.1, 0.7)
  const epsilon = 0.0001
  for (const pitch of [0.7, 1, 6.3, 18]) {
    for (let angle = 0; angle < Math.PI * 2; angle += 0.07) {
      const x = Math.cos(angle) * 9, y = Math.sin(angle) * 9
      const dx = (blobs.at(x + epsilon, y) - blobs.at(x - epsilon, y)) / (2 * epsilon)
      const dy = (blobs.at(x, y + epsilon) - blobs.at(x, y - epsilon)) / (2 * epsilon)
      const expected = (blobs.at(x, y) - SURFACE) / Math.max(0.025, Math.hypot(dx, dy) * pitch)
      assert.ok(Math.abs(blobs.surfaceDistanceAt(x, y, pitch) - expected) < 1e-6,
        "radial edge distance must follow the continuous field gradient")
    }
  }
  blobs.reset()
  blobs.add(0, 0, 10)
  for (const radius of [0, 9.99, 10, 10.01, 25]) {
    const expected = blobs.surfaceDistanceAt(radius, 0, 2)
    assert.ok(Number.isFinite(expected))
    for (let angle = 0; angle < Math.PI * 2; angle += 0.07) {
      assert.ok(Math.abs(blobs.surfaceDistanceAt(Math.cos(angle) * radius,
        Math.sin(angle) * radius, 2) - expected) < 1e-10,
      "a circular surface must have the same soft edge at every angle")
    }
  }
  assert.ok(blobs.surfaceDistanceAt(9.99, 0) > 0)
  assert.ok(Math.abs(blobs.surfaceDistanceAt(10, 0)) < 1e-10)
  assert.ok(blobs.surfaceDistanceAt(10.01, 0) < 0)
  console.log("PASS  radial field sampling stays continuous, rotation invariant, and finite")
}

const pet = load("pet-scene")

{
  const { LiquidInk } = load("liquid-ink")
  const lattice = (w, h, pitch = 1) => ({
    count: w * h,
    x: Float32Array.from({ length: w * h }, (_, i) => (i % w) * pitch),
    y: Float32Array.from({ length: w * h }, (_, i) => Math.floor(i / w) * pitch),
  })
  // Sample the actual painted curves, including their winding. These checks
  // measure visible shape changes rather than inspecting private field data.
  const capture = (ink, values, dt = 0) => {
    const paths = []
    let path, x, y
    ink.paint({
      beginPath() {},
      moveTo(px, py) { paths.push(path = [[px, py]]); x = px; y = py },
      bezierCurveTo(ax, ay, bx, by, ex, ey) {
        for (let i = 1; i <= 16; i++) {
          const t = i / 16, u = 1 - t
          path.push([
            u ** 3 * x + 3 * u * u * t * ax + 3 * u * t * t * bx + t ** 3 * ex,
            u ** 3 * y + 3 * u * u * t * ay + 3 * u * t * t * by + t ** 3 * ey,
          ])
        }
        x = ex; y = ey
      },
      closePath() {}, fill() {},
    }, Float32Array.from(values), "ink", dt)
    assert.ok(paths.every(p => p.every(point => point.every(Number.isFinite))))
    return paths
  }
  const area = path => path.reduce((sum, [x, y], i) => {
    const [nx, ny] = path[(i + 1) % path.length]
    return sum + x * ny - y * nx
  }, 0) / 2
  const totalArea = paths => paths.reduce((sum, path) => sum + area(path), 0)
  const section = (paths, x) => {
    const ys = []
    for (const path of paths) for (let i = 0; i < path.length; i++) {
      const a = path[i], b = path[(i + 1) % path.length]
      if ((a[0] <= x && b[0] > x) || (b[0] <= x && a[0] > x)) {
        ys.push(a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))
      }
    }
    return ys.length ? Math.max(...ys) - Math.min(...ys) : 0
  }
  const pair = new LiquidInk(lattice(2, 1), 1)
  assert.equal(capture(pair, [0.3, 0.3]).length, 2)
  assert.equal(capture(pair, [0.5, 0.5]).length, 1,
    "ink split between adjacent cells must maintain a neck during transfer")
  let transferArea = totalArea(capture(pair, [1, 0]))
  for (let i = 1; i <= 200; i++) {
    const paths = capture(pair, [1 - i / 200, i / 200])
    const next = totalArea(paths)
    assert.ok(Math.abs(next - transferArea) < 0.025, "transferring ink must not pop at contact or release")
    transferArea = next
  }
  let neck = 0
  for (const fill of [0.55, 0.6, 0.7, 0.85, 1]) {
    const paths = capture(pair, [fill, fill])
    assert.equal(paths.length, 1)
    const next = section(paths, 0.5)
    assert.ok(next > neck + 0.02, "the connecting neck must keep widening as ink pools")
    neck = next
  }
  let previous = 0
  for (let i = 0; i <= 1000; i++) {
    const next = totalArea(capture(pair, [i / 1000, i / 1000]))
    assert.ok(Math.abs(next - previous) < 0.025, "a growing or merging droplet must not pop")
    previous = next
  }
  const pool = new LiquidInk(lattice(2, 2), 1)
  let hole = Infinity
  for (const fill of [0.5, 0.58, 0.65]) {
    const paths = capture(pool, [fill, fill, fill, fill])
    const holes = paths.filter(p => area(p) < 0)
    assert.equal(holes.length, 1, "the pore between four droplets must remain open while ink gathers")
    const next = -area(holes[0])
    assert.ok(next < hole)
    hole = next
  }
  assert.equal(capture(pool, [1, 1, 1, 1]).length, 1, "a full pool must close its center")
  assert.equal(capture(pool, [1, 0, 0, 1]).length, 1, "full droplets must also flow diagonally")
  const dot = new LiquidInk(lattice(1, 1), 1)
  for (const fill of [0.05, 0.15, 0.3, 0.5, 0.8, 1]) {
    const [path] = capture(dot, [fill])
    const radii = path.map(([x, y]) => Math.hypot(x, y))
    assert.ok(Math.max(...radii) / Math.min(...radii) < 1.12,
      "isolated droplets must stay round as they cross sampling rows")
  }
  const settled = capture(pair, [1, 1])
  const releasing = capture(pair, [0, 0], 1 / 60)
  assert.ok(totalArea(releasing) > 0 && totalArea(releasing) < totalArea(settled))
  const evolve = hz => {
    const ink = new LiquidInk(lattice(2, 1), 1)
    capture(ink, [0, 0])
    let paths
    for (let i = 0; i < hz / 2; i++) paths = capture(ink, [0.7, 1], 1 / hz)
    for (let i = 0; i < hz / 10; i++) paths = capture(ink, [0.1, 0.2], 1 / hz)
    return totalArea(paths)
  }
  const at60 = evolve(60)
  for (const hz of [30, 120]) assert.ok(Math.abs(evolve(hz) - at60) < 1e-5)
  assert.deepEqual(capture(pair, [0, 0]), [], "a settled empty frame must clear the surface history")
  assert.deepEqual(capture(new LiquidInk(lattice(0, 0), 1), []), [])
  const small = capture(new LiquidInk(lattice(12, 12), 1), new Float32Array(144).fill(1))
  const big = capture(new LiquidInk(lattice(24, 24), 1), new Float32Array(576).fill(1))
  assert.equal(small.length, 1)
  assert.equal(big.length, 1)
  assert.ok(big[0].length < small[0].length * 2.2, "solid fill should paint its perimeter, not every cell")
  console.log("PASS  liquid necks widen, pores close gradually, droplets stay round, and release follows elapsed time")
}

{
  const snapshot = f => {
    pet.drawPet({ ...pet.IDLE_FRAME, ...f })
    const nose = Array.from(pet.DETAILS).findIndex((s, i) =>
      s === pet.ACCENT && Math.floor(i / pet.PET_W) < 18)
    return {
      coat: pet.COAT.slice(),
      noseX: nose % pet.PET_W + pet.DETAIL_X[nose],
    }
  }
  const a = snapshot({ gazeX: 0.2499 })
  const b = snapshot({ gazeX: 0.2501 })
  assert.ok(Math.abs(b.noseX - a.noseX - 0.0004) < 1e-6,
    "the face must cross a grid-column boundary without jumping")
  assert.ok(a.coat.every((v, i) => Math.abs(v - b.coat[i]) < 0.01))
  const low = snapshot({ hop: 0.2083 })
  const high = snapshot({ hop: 0.2084 })
  assert.ok(low.coat.every((v, i) => Math.abs(v - high.coat[i]) < 0.01),
    "crossing a rounded floor row must not pop the belly")
  for (const mood of ["idle", "bop", "focus", "purr", "happy", "cheer", "sleep"]) {
    for (let i = 0; i < 60; i++) {
      pet.drawPet({ ...pet.IDLE_FRAME, mood, phase: i / 60, swing: i / 15,
        breathe: i / 30, groove: 1, pulse: i / 60, hop: Math.sin(i / 60 * Math.PI),
        pat: 0.2, gazeX: Math.sin(i / 10), gazeY: Math.cos(i / 10) })
      for (const field of [pet.COAT, pet.RIM, pet.HEAD_SHADOW, pet.INK]) {
        assert.ok(field.every(v => Number.isFinite(v) && v >= 0 && v <= 1))
      }
    }
  }
  console.log("PASS  cat edges and face stay continuous across grid boundaries in every mood")
}

{
  const frames = new Map()
  let id = 0, paints = 0, stills = 0, lastDt = 0, observer
  const events = () => {
    const listeners = new Map()
    return {
      listeners,
      addEventListener(type, fn) { listeners.set(type, fn) },
      removeEventListener(type) { listeners.delete(type) },
      fire(type) { listeners.get(type)?.() },
    }
  }
  const motion = { ...events(), matches: false }
  const document = { ...events(), hidden: false }
  const { canvasLoop } = load("canvas-loop", {
    window: { matchMedia: () => motion }, document,
    requestAnimationFrame: fn => { frames.set(++id, fn); return id },
    cancelAnimationFrame: id => frames.delete(id),
    IntersectionObserver: class {
      constructor(callback) { observer = callback }
      observe() {}
      disconnect() { observer = null }
    },
  })
  const loop = canvasLoop({}, (_now, dt) => { paints++; lastDt = dt }, () => stills++)
  const advance = now => {
    const pending = Array.from(frames.values())
    frames.clear()
    for (const fn of pending) fn(now)
  }
  for (let i = 1; i <= 240; i++) advance(i * 1000 / 120)
  assert.ok(paints >= 119 && paints <= 121, `${paints} paints on a 120Hz display`)
  document.hidden = true
  document.fire("visibilitychange")
  assert.equal(frames.size, 0)
  document.hidden = false
  document.fire("visibilitychange")
  advance(10000)
  assert.equal(lastDt, 1 / 60, "resume must not integrate the hidden interval")
  observer([{ isIntersecting: false }])
  assert.equal(frames.size, 0)
  observer([{ isIntersecting: true }])
  assert.equal(frames.size, 1)
  motion.matches = true
  motion.fire("change")
  assert.equal(frames.size, 0)
  assert.equal(stills, 1)
  loop.redraw()
  assert.equal(stills, 2, "theme/resize must redraw a reduced-motion frame")
  motion.matches = false
  motion.fire("change")
  assert.equal(frames.size, 1)
  loop.dispose()
  assert.equal(frames.size, 0)
  assert.equal(document.listeners.size, 0)
  assert.equal(motion.listeners.size, 0)
  assert.equal(observer, null)
  console.log("PASS  canvas loops cap refresh rate, stop when hidden, and track reduced motion")
}

{
  // Low power lowers a loop's frame rate while it runs, and restores it.
  const budget = load("render-budget")
  cache.delete("canvas-loop")
  const frames = new Map()
  let id = 0, paints = 0
  const events = () => {
    const listeners = new Map()
    return {
      listeners,
      addEventListener(type, fn) { listeners.set(type, fn) },
      removeEventListener(type) { listeners.delete(type) },
      fire(type) { listeners.get(type)?.() },
    }
  }
  const motion = { ...events(), matches: false }
  const document = { ...events(), hidden: false }
  const { canvasLoop } = load("canvas-loop", {
    window: { matchMedia: () => motion }, document,
    requestAnimationFrame: fn => { frames.set(++id, fn); return id },
    cancelAnimationFrame: id => frames.delete(id),
    IntersectionObserver: class { observe() {} disconnect() {} },
  })
  const loop = canvasLoop({}, () => { paints++ }, () => {}, { fps: 60, lowPowerFps: 30 })
  let clock = 0
  const second = () => {
    const start = paints
    for (let i = 0; i < 120; i++) {
      clock += 1000 / 120
      const pending = Array.from(frames.values())
      frames.clear()
      for (const fn of pending) fn(clock)
    }
    return paints - start
  }
  const full = second()
  budget.setLowPower(true)
  const low = second()
  budget.setLowPower(false)
  const restored = second()
  assert.ok(full >= 59 && full <= 61, `${full} paints at full rate`)
  assert.ok(low >= 29 && low <= 31, `${low} paints in low power`)
  assert.ok(restored >= 59 && restored <= 61, `${restored} paints after low power`)
  loop.dispose()
  console.log("PASS  low power halves a canvas loop's rate and restores it")
}

{
  // Arranging the desk (render-budget's busy flag) drops a loop to its
  // low-power rate the same way, and never touches a class on <html>: the cat
  // and the visualiser watch that class for theme changes.
  const saved = [cache.get("render-budget"), cache.get("canvas-loop")]
  cache.delete("render-budget")
  cache.delete("canvas-loop")
  const toggles = []
  const html = { classList: { toggle: (...args) => toggles.push(args) } }
  const budget = load("render-budget", { document: { documentElement: html } })
  const frames = new Map()
  let id = 0, paints = 0
  const events = () => ({ addEventListener() {}, removeEventListener() {} })
  const { canvasLoop } = load("canvas-loop", {
    window: { matchMedia: () => ({ ...events(), matches: false }) }, document: { ...events(), hidden: false },
    requestAnimationFrame: fn => { frames.set(++id, fn); return id },
    cancelAnimationFrame: id => frames.delete(id),
    IntersectionObserver: class { observe() {} disconnect() {} },
  })
  let heard = 0
  const stop = budget.onLowPowerChange(() => heard++)
  const loop = canvasLoop({}, () => { paints++ }, () => {}, { fps: 30, lowPowerFps: 20 })
  let clock = 0
  const second = () => {
    const start = paints
    for (let i = 0; i < 120; i++) {
      clock += 1000 / 120
      const pending = Array.from(frames.values())
      frames.clear()
      for (const fn of pending) fn(clock)
    }
    return paints - start
  }
  const full = second()
  budget.setRenderBusy(true)
  budget.setRenderBusy(true)
  assert.equal(budget.renderBusy(), true)
  const busy = second()
  budget.setRenderBusy(false)
  const restored = second()
  assert.ok(full >= 29 && full <= 31, `${full} paints at full rate`)
  assert.ok(busy >= 19 && busy <= 21, `${busy} paints while busy`)
  assert.ok(restored >= 29 && restored <= 31, `${restored} paints after`)
  assert.equal(heard, 2, "listeners hear busy turning on and off, once each")
  assert.equal(toggles.length, 0, "busy never toggles a class on <html>")
  budget.setLowPower(true)
  budget.setRenderBusy(true)
  assert.ok(second() <= 21, "busy in low power stays at the low rate")
  budget.setRenderBusy(false)
  budget.setLowPower(false)
  assert.equal(toggles.length, 2, "only low power itself touches the class")
  loop.dispose()
  stop()
  cache.set("render-budget", saved[0])
  cache.set("canvas-loop", saved[1])
  console.log("PASS  arranging the desk damps canvas loops like low power, with no class on <html>")
}

{
  // The governor enters low power on the first sign of pressure and leaves
  // only after a long, clearly healthy stretch, so it cannot oscillate.
  const { LoadGovernor, MIN_LOW_POWER_MS, TROUBLE_MEMORY_MS } = load("render-budget")
  const applied = []
  const governor = new LoadGovernor(value => applied.push(value))
  governor.noteHealth({ realtimeFactor: 2.4, codebooks: 12, maxCodebooks: 12 }, 0)
  governor.noteBuffer(true, 0.8, 100)
  assert.deepEqual(applied, [], "a machine with headroom keeps full rendering")
  governor.noteHealth({ realtimeFactor: 1.3, codebooks: 12, maxCodebooks: 12 }, 1000)
  assert.deepEqual(applied, [true], "a slow render enters low power")
  governor.noteHealth({ realtimeFactor: 1.6, codebooks: 12, maxCodebooks: 12 }, 200_000)
  assert.deepEqual(applied, [true], "a middling speed does not leave low power")
  governor.noteHealth({ realtimeFactor: 2.2, codebooks: 11, maxCodebooks: 12 }, 210_000)
  assert.deepEqual(applied, [true], "reduced codec depth counts as pressure")
  // entered long ago, so only the time since the last trouble matters here
  assert.ok(210_000 - 1000 >= MIN_LOW_POWER_MS)
  const healthyAt = 210_000 + TROUBLE_MEMORY_MS
  governor.noteHealth({ realtimeFactor: 2.2, codebooks: 12, maxCodebooks: 12 }, healthyAt - 1)
  assert.deepEqual(applied, [true], "leaving waits out the trouble memory")
  governor.noteHealth({ realtimeFactor: 2.2, codebooks: 12, maxCodebooks: 12 }, healthyAt)
  assert.deepEqual(applied, [true, false], "a long healthy stretch restores full rendering")
  governor.noteUnderrun(healthyAt + 10)
  assert.deepEqual(applied, [true, false, true], "an audible gap enters low power at once")
  governor.noteBuffer(true, 0.1, healthyAt + 20)
  assert.deepEqual(applied, [true, false, true], "repeated pressure does not re-apply")

  const dips = []
  const bank = new LoadGovernor(value => dips.push(value))
  bank.noteHealth({ realtimeFactor: 2.4, codebooks: 12, maxCodebooks: 12 }, 0)
  bank.noteBuffer(true, 0.1, 100)
  bank.noteBuffer(true, 0.1, 2_000)
  bank.noteBuffer(true, 0.8, 2_100)
  bank.noteBuffer(true, 0.1, 2_200)
  assert.deepEqual(dips, [], "a momentary dip in the reservoir is not pressure")
  bank.noteBuffer(true, 0.1, 5_200)
  assert.deepEqual(dips, [true], "a sustained low reservoir is")
  const dwell = []
  const brief = new LoadGovernor(value => dwell.push(value))
  brief.noteUnderrun(0)
  brief.noteHealth({ realtimeFactor: 2.5, codebooks: 12, maxCodebooks: 12 }, TROUBLE_MEMORY_MS)
  assert.deepEqual(dwell, [true], "low power holds for its minimum dwell")
  brief.noteHealth({ realtimeFactor: 2.5, codebooks: 12, maxCodebooks: 12 }, MIN_LOW_POWER_MS)
  assert.deepEqual(dwell, [true, false])
  console.log("PASS  the load governor enters on pressure and leaves only after a long healthy stretch")
}
