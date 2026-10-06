import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const modules = new Map()
function loadModule(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL(`../lib/${name.replace("./", "")}.ts`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const context = { exports: {}, require: loadModule }
  vm.runInNewContext(compiled, context)
  modules.set(name, context.exports)
  return context.exports
}

const { TIMER_TALL_PX, TIMER_WIDE_PX, TIMER_NOTE_PX, timerFit, landsInSheet } = loadModule("./timer-fit")
const { metricsFor, footprint } = loadModule("./board")

// the content box of a widget of this footprint at this window: the frame
// minus the card's padding, which is what the timer measures
const PAD_MAX = 20, PAD_MIN = 16
const contentBox = (vw, vh, size) => {
  const m = metricsFor(vw, vh)
  const f = footprint(size, m.cols)
  const pad = m.bucket === "phone" ? PAD_MIN : Math.min(PAD_MAX, Math.max(PAD_MIN, (m.colW - 150) * 0.2 + PAD_MIN))
  return {
    width: f.w * m.colW + (f.w - 1) * m.gap - 2 * pad,
    height: f.h * m.rowH + (f.h - 1) * m.gap - 2 * pad,
  }
}

{
  // the thresholds themselves
  assert.equal(timerFit(400, TIMER_TALL_PX), "tall")
  assert.equal(timerFit(400, TIMER_TALL_PX - 1), "wide")
  assert.equal(timerFit(TIMER_WIDE_PX, TIMER_TALL_PX - 1), "wide")
  assert.equal(timerFit(TIMER_WIDE_PX - 1, TIMER_TALL_PX - 1), "narrow")
  // a box that hasn't been measured yet reads as the roomy one, so the first
  // paint (and the server's) is the stacked card
  assert.equal(timerFit(0, 0), "tall")
  assert.equal(timerFit(320, -1), "tall")
}

{
  // every window the desk is specified for, at both of the timer's sizes
  const windows = [
    [1920, 1080, "tall"], [1512, 860, "tall"], [1440, 900, "tall"], [1440, 800, "tall"],
    [1440, 780, "tall"], [1366, 768, "wide"], [1280, 720, "wide"], [1280, 620, "wide"],
    [1279, 800, "wide"], [1024, 768, "wide"], [768, 1024, "tall"], [740, 900, "tall"],
    [390, 844, "tall"], [375, 667, "tall"], [320, 568, "narrow"],
  ]
  for (const [vw, vh, expected] of windows) {
    const box = contentBox(vw, vh, "m")
    assert.equal(timerFit(box.width, box.height), expected, `m at ${vw}×${vh} (${box.width}×${box.height})`)
    // the 1×1 box is never wide: just the time stacks at every window
    const small = contentBox(vw, vh, "s")
    assert.notEqual(timerFit(small.width, small.height), "wide", `s at ${vw}×${vh} (${small.width}×${small.height})`)
  }
}

{
  // the landing rule: just the time always opens a sheet; with dials, only a
  // box tall enough for the whole note keeps it under the time
  assert.equal(landsInSheet(TIMER_NOTE_PX, "s"), true)
  assert.equal(landsInSheet(400, "s"), true)
  assert.equal(landsInSheet(TIMER_NOTE_PX, "m"), false)
  assert.equal(landsInSheet(TIMER_NOTE_PX - 1, "m"), true)
  assert.equal(landsInSheet(88, "m"), true)
  // unmeasured: the roomy one, so the first paint doesn't show a line it is
  // about to replace
  assert.equal(landsInSheet(0, "m"), false)
  // and every window, so the table is the record of which is which
  const sheet = {
    "1920x1080": false, "1512x860": false, "1440x900": false, "1440x800": true,
    "1440x780": true, "1366x768": true, "1280x720": true, "1280x620": true,
    "1279x800": true, "1024x768": true, "768x1024": true, "740x900": true,
    "390x844": false, "375x667": false, "320x568": true,
  }
  for (const key of Object.keys(sheet)) {
    const [vw, vh] = key.split("x").map(Number)
    assert.equal(landsInSheet(contentBox(vw, vh, "m").height, "m"), sheet[key], `m at ${key}`)
    assert.equal(landsInSheet(contentBox(vw, vh, "s").height, "s"), true, `s at ${key}`)
  }
}

console.log("timer-fit ok")
