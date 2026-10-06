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

const {
  TIMER_KEY, SESSIONS_KEY, SESSION_CAP, clampWork, clampRest, parseTimerPrefs, serializeTimerPrefs,
  parseSessions, pruneSessions, recordSession, serializeSessions, mergeSessions,
} = loadModule("./focus-store")
// the module lives in its own realm, so compare what storage would hold
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 29, 12)

assert.equal(TIMER_KEY, "lofai.timer")
assert.equal(SESSIONS_KEY, "lofai.sessions")

// prefs clamp and default
for (const raw of [null, "", "{", "[]", "null", "25", '{"work":40,"rest":10}', '{"v":2,"work":40,"rest":10}']) {
  same(parseTimerPrefs(raw), { work: 25, rest: 5 }, String(raw))
}
same(parseTimerPrefs('{"v":1,"work":40,"rest":10}'), { work: 40, rest: 10 })
same(parseTimerPrefs('{"v":1,"work":0,"rest":0}'), { work: 1, rest: 1 })
same(parseTimerPrefs('{"v":1,"work":61,"rest":31}'), { work: 60, rest: 30 })
same(parseTimerPrefs('{"v":1,"work":-5,"rest":1e9}'), { work: 1, rest: 30 })
same(parseTimerPrefs('{"v":1,"work":12.6,"rest":"7"}'), { work: 13, rest: 5 })
same(parseTimerPrefs('{"v":1,"rest":8}'), { work: 25, rest: 8 })
assert.equal(clampWork(NaN), 25)
assert.equal(clampRest(Infinity), 5)
assert.equal(clampWork(60), 60)
assert.equal(clampRest(30), 30)
same(JSON.parse(serializeTimerPrefs({ work: 50, rest: 10 })), { v: 1, work: 50, rest: 10 })
same(JSON.parse(serializeTimerPrefs({ work: 99, rest: 0 })), { v: 1, work: 60, rest: 1 })
for (let work = 1; work <= 60; work++) same(parseTimerPrefs(serializeTimerPrefs({ work, rest: (work % 30) + 1 })), { work, rest: (work % 30) + 1 })
console.log("PASS timer prefs default to 25 and 5, clamp to 1-60 and 1-30, and round-trip")

// sessions parse without throwing
const block = (endDaysAgo, minutes = 25, taskId = null) => {
  const end = NOW - endDaysAgo * DAY
  return { start: end - minutes * 60000, end, minutes, taskId }
}
for (const raw of [null, "", "{", "[]", "null", '{"v":1}', '{"v":1,"sessions":{}}', '{"v":2,"sessions":[]}', JSON.stringify([block(1)])]) {
  same(parseSessions(raw, NOW), [], String(raw))
}
const good = [block(3, 25, "t1"), block(1, 10)]
same(parseSessions(serializeSessions(good), NOW), good)
same(JSON.parse(serializeSessions(good)), { v: 1, sessions: good })
const junk = [null, 4, "x", { start: 1 }, { start: 5, end: 4, minutes: 1 }, { start: 1, end: 2, minutes: 0 }, { start: 1, end: 2, minutes: "25" },
  { ...block(2), taskId: 7 }]
same(parseSessions(JSON.stringify({ v: 1, sessions: [...junk, ...good] }), NOW), [{ ...block(2), taskId: null }, ...good].sort((a, b) => a.end - b.end))
console.log("PASS sessions parse without throwing and drop malformed entries")

// prune at 14 days, cap at 500
const edge = [block(14.001), block(14), block(13.99), block(0)]
same(pruneSessions(edge, NOW), edge.slice(1), "a block that ended exactly 14 days ago stays; older goes")
same(parseSessions(serializeSessions(edge), NOW), edge.slice(1))
const many = Array.from({ length: 620 }, (_, i) => block(13 - i / 100))
const capped = parseSessions(serializeSessions(many), NOW)
assert.equal(capped.length, SESSION_CAP)
same(capped, many.slice(many.length - SESSION_CAP), "the newest 500 are kept")
same(pruneSessions([block(1), block(5), block(3)], NOW), [block(5), block(3), block(1)], "oldest first")
console.log("PASS the log keeps 14 days and at most 500 blocks, newest kept")

// recordSession is pure
const before = Object.freeze([block(20), block(2)].map(Object.freeze))
const added = block(0, 10, "desk")
const recorded = recordSession(before, added, NOW)
same(recorded, [block(2), added])
assert.equal(before.length, 2, "the input is untouched")
assert.notEqual(recorded, before)
same(recordSession(before, added, NOW), recorded, "the same inputs give the same log")
const full = Array.from({ length: SESSION_CAP }, (_, i) => block(10 - i / 100))
const plusOne = recordSession(full, added, NOW)
assert.equal(plusOne.length, SESSION_CAP)
same(plusOne[plusOne.length - 1], added)
same(plusOne[0], full[1], "the oldest block makes room")
console.log("PASS recordSession is pure, prunes and caps")

// merging the stored log with this tab's keeps every block once, whichever is behind
{
  const a = block(3, 25, "t1"), b = block(2), c = block(1, 10)
  // storage stopped at a (a write failed); this tab has seen a, b and c
  same(recordSession(mergeSessions([a], [a, b, c]), block(0), NOW), [a, b, c, block(0)])
  // another tab added b; this tab only knew a
  same(recordSession(mergeSessions([a, b], [a]), c, NOW), [a, b, c])
  same(mergeSessions([], []), [])
  // the same start and end is the same block, even from two copies
  same(mergeSessions([a, b], [{ ...b }, c]), [a, b, c])
}
console.log("PASS the stored log and this tab's merge, each block once")
