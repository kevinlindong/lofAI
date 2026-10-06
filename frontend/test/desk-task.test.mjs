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
  const context = { exports: {}, require: loadModule, URL }
  vm.runInNewContext(compiled, context)
  modules.set(name, context.exports)
  return context.exports
}

const {
  PICK_LIMIT, LITTLE_BIT_MIN, FRESH_PIN_MS, pickable, minutesPhrase, clockText, spokenLeft, littleBit,
  focusKey, sourceBadge, pinnedJustNow, landingParts, pickNone, keyAfterLanding, hereCopy,
} = loadModule("./desk-task")
// the module lives in its own realm, so compare plain copies
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)

const task = (id, done = false, extra = {}) => ({ id, text: `task ${id}`, done, ...extra })

// the picker: open tasks in list order, never the one already out, at most six
assert.equal(PICK_LIMIT, 6)
{
  const list = [task("a"), task("b", true), task("c"), task("d"), task("e"), task("f"), task("g"), task("h"), task("i", true)]
  const all = pickable(list, null)
  same(all.shown.map((t) => t.id), ["a", "c", "d", "e", "f", "g"])
  assert.equal(all.more, 1)
  const swap = pickable(list, "c")
  same(swap.shown.map((t) => t.id), ["a", "d", "e", "f", "g", "h"])
  assert.equal(swap.more, 0)
  same(pickable([], null), { shown: [], more: 0 })
  same(pickable([task("x", true)], null), { shown: [], more: 0 })
  same(pickable([task("x")], "x"), { shown: [], more: 0 }, "the only open task is already out")
  same(pickable(list, null, 2).shown.map((t) => t.id), ["a", "c"])
}

// words
assert.equal(minutesPhrase(25), "25 minutes")
assert.equal(minutesPhrase(1), "1 minute")
assert.equal(minutesPhrase(0), "1 minute", "never zero")
assert.equal(minutesPhrase(9.6), "10 minutes")
const line = (minutes, withTask) => { const { time, rest } = landingParts(minutes, withTask); return time + rest }
assert.equal(line(25, true), "25 minutes with this. nicely done.")
assert.equal(line(25, false), "25 minutes of focus. nicely done.")
assert.equal(line(1, false), "1 minute of focus. nicely done.")
same(landingParts(10, true), { time: "10 minutes", rest: " with this. nicely done." })

// the picker with nothing to offer
assert.equal(pickNone(0, false), "Nothing on the list yet.")
assert.equal(pickNone(2, false), "Everything's done. Write a new one?", "a list that's all done isn't empty")
assert.equal(pickNone(3, true), "Nothing else on the list.")
assert.equal(clockText(18 * 60 + 42), "18:42")
assert.equal(clockText(9 * 60 + 5), "9:05")
assert.equal(clockText(0), "0:00")
assert.equal(clockText(-3), "0:00")
assert.equal(clockText(59.2), "1:00", "rounds up, as the timer does")
assert.equal(clockText(60 * 60), "60:00")
assert.equal(spokenLeft(18 * 60 + 42), "19 minutes left")
assert.equal(spokenLeft(20), "1 minute left")
assert.equal(spokenLeft(0), "1 minute left")

// another little bit: ten minutes, or less if the block is shorter
assert.equal(LITTLE_BIT_MIN, 10)
assert.equal(littleBit(25), 10)
assert.equal(littleBit(10), 10)
assert.equal(littleBit(6), 6)
assert.equal(littleBit(0), 1)

// the focus key
const clock = (o) => ({ phase: "focus", running: false, timeLeft: 1500, totalSec: 1500, workMin: 25, ...o })
same(focusKey(clock(), true), { mode: "start", text: "start 25 min", label: "Start 25 minutes of focus on this" })
same(focusKey(clock(), false), { mode: "start", text: "just focus", label: "Just focus, for 25 minutes" })
same(focusKey(clock({ workMin: 40, timeLeft: 2400, totalSec: 2400 }), true).text, "start 40 min")
same(focusKey(clock({ running: true, timeLeft: 18 * 60 + 42 }), true), { mode: "pause", text: "18:42 left", label: "Pause focus, 19 minutes left" })
same(focusKey(clock({ running: true, timeLeft: 18 * 60 + 42 }), false).mode, "pause", "running without a task shows the time too")
same(focusKey(clock({ timeLeft: 600 }), true), { mode: "resume", text: "resume · 10:00", label: "Resume focus, 10 minutes left" })
same(focusKey(clock({ timeLeft: 1499.8 }), true).mode, "start", "a blink of a pause is still a fresh block")
// a one-off block, paused partway
same(focusKey(clock({ timeLeft: 300, totalSec: 600 }), true).mode, "resume")
// a rest, running or held: focus is still on offer
same(focusKey(clock({ phase: "rest", running: true, timeLeft: 200, totalSec: 300 }), true).mode, "start")
same(focusKey(clock({ phase: "rest", running: false, timeLeft: 300, totalSec: 300 }), false).text, "just focus")
same(focusKey(clock({ phase: "rest", running: false, timeLeft: 120, totalSec: 300 }), true).mode, "start", "a paused rest isn't a paused focus")

// a soft landing moving on by keyboard: focus goes to a key the next view has
assert.equal(keyAfterLanding(false, task("a"), true), "focus")
assert.equal(keyAfterLanding(false, task("a"), false), "focus")
assert.equal(keyAfterLanding(true, task("a"), true), "swap", "just the task has no focus key")
assert.equal(keyAfterLanding(false, task("a", true), true), "swap", "a task done from the list offers the next")
assert.equal(keyAfterLanding(true, null, true), "focus", "without a task, the focus key shows what's left")
assert.equal(keyAfterLanding(false, null, false), "pick")

// a service's reason, said from the widget
assert.equal(hereCopy("Linear: no. Your checkmark hasn't changed. You can retry, or turn off sync beside the task."),
  "Linear: no. Your checkmark hasn't changed. You can retry, or turn off sync beside it in Tasks.")
assert.equal(hereCopy("GitHub: offline."), "GitHub: offline.", "other words pass through")

// where it came from
assert.equal(sourceBadge(null), null)
assert.equal(sourceBadge(task("a")), null)
same(sourceBadge(task("a", false, { source: { provider: "todoist", source: "p1", id: "9", url: "https://todoist.com/showTask?id=9", sync: false } })),
  { provider: "todoist", name: "Todoist", url: "https://todoist.com/showTask?id=9" })
same(sourceBadge(task("a", false, { source: { provider: "linear", source: "t", id: "9", url: "javascript:alert(1)", sync: true } })),
  { provider: "linear", name: "Linear" }, "an unsafe link is left out")
same(sourceBadge(task("a", false, { source: { provider: "github", source: "r", id: "1", sync: false } })), { provider: "github", name: "GitHub" })

// a pin this recent was made for the widget to show (the ribbon still drops)
const NOW = Date.UTC(2026, 8, 29, 12)
const saved = (taskId, since) => JSON.stringify({ v: 1, taskId, since })
assert.equal(FRESH_PIN_MS, 1000)
assert.equal(pinnedJustNow(saved("t1", NOW - 500), "t1", NOW), true)
assert.equal(pinnedJustNow(saved("t1", NOW - 1200), "t1", NOW), false, "a reload")
assert.equal(pinnedJustNow(saved("t1", NOW - 500), "t2", NOW), false, "another task")
assert.equal(pinnedJustNow(saved("t1", NOW + 60000), "t1", NOW), false, "a clock from the future")
assert.equal(pinnedJustNow(saved("t1", 0), "t1", NOW), false)
assert.equal(pinnedJustNow(null, "t1", NOW), false)
assert.equal(pinnedJustNow("{", "t1", NOW), false)
assert.equal(pinnedJustNow(saved("t1", NOW - 500), null, NOW), false)

console.log("desk-task tests passed")
