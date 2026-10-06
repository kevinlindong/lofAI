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
  CLOCK_KEY, WELCOME_AFTER_MS, WELCOME_FOR_MS, HOURS, DIGITS, LATE_MS,
  formatTime, weekdayOf, localIso, dayLine, monthBeforeDay, hourDots, hourDotsAt, msToNextMinute, minuteStart, clockStep,
  welcomeBack, welcomeLine, welcomeParts, welcomeLeft, parseClockPrefs, serializeClockPrefs, prefers24h,
  timeGlyphs, darkGlyph, glyphLayout, glyphColumns,
} = loadModule("./clock")
// the module lives in its own realm, so compare plain values
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
// local wall time, whatever zone the test runs in
const at = (h, m = 0, s = 0, ms = 0, day = 29) => new Date(2026, 8, day, h, m, s, ms)
const HOUR = 60 * 60 * 1000

assert.equal(CLOCK_KEY, "lofai.clock")
assert.equal(WELCOME_FOR_MS, 60000)
assert.equal(WELCOME_AFTER_MS, 20 * HOUR)

// formatTime: 12 and 24 hours, midnight and noon, leading zeros only on 24
for (const [h, m, twelve, period, twentyFour] of [
  [0, 0, "12:00", "am", "00:00"],
  [0, 5, "12:05", "am", "00:05"],
  [9, 7, "9:07", "am", "09:07"],
  [11, 59, "11:59", "am", "11:59"],
  [12, 0, "12:00", "pm", "12:00"],
  [13, 5, "1:05", "pm", "13:05"],
  [23, 59, "11:59", "pm", "23:59"],
]) {
  same(formatTime(at(h, m), false), { digits: twelve, period, text: `${twelve} ${period}` }, `${h}:${m} 12h`)
  same(formatTime(at(h, m), true), { digits: twentyFour, period: null, text: twentyFour }, `${h}:${m} 24h`)
}
// seconds never show
assert.equal(formatTime(at(14, 5, 59, 999), true).digits, "14:05")
console.log("PASS formatTime: 12h without a leading zero, am/pm, 24h with one, midnight and noon")

// dayLine and the weekday
assert.equal(dayLine(at(10)), "tuesday, 29 september")
assert.equal(dayLine(at(10), true), "tuesday, september 29")
assert.equal(dayLine(new Date(2027, 0, 1)), "friday, 1 january")
assert.equal(dayLine(new Date(2026, 11, 31, 23, 59)), "thursday, 31 december")
assert.equal(weekdayOf(at(10, 0, 0, 0, 30)), "wednesday")
for (let d = 0; d < 7; d++) assert.match(dayLine(new Date(2026, 8, 27 + d)), /^[a-z]+day, \d{1,2} [a-z]+$/)
assert.equal(monthBeforeDay(["month", "literal", "day"]), true)
assert.equal(monthBeforeDay(["day", "literal", "month"]), false)
assert.equal(monthBeforeDay(["weekday"]), false)
assert.equal(localIso(at(9, 5, 30)), "2026-09-29T09:05")
assert.equal(localIso(new Date(2027, 0, 1, 0, 0)), "2027-01-01T00:00")
console.log("PASS dayLine: lowercase weekday, day and month, in either order")

// hourDots: sixteen, 8am to midnight
const count = (marks, kind) => marks.filter((mark) => mark === kind).length
for (let h = 0; h < 24; h++) {
  const marks = hourDotsAt(h)
  assert.equal(marks.length, HOURS)
  assert.equal(HOURS, 16)
  if (h < 8) same(marks, Array(16).fill("future"), `${h}: all still ahead`)
  else {
    assert.equal(count(marks, "past"), h - 8, `${h} past`)
    assert.equal(count(marks, "now"), 1, `${h} now`)
    assert.equal(marks[h - 8], "now")
    assert.equal(count(marks, "future"), 23 - h, `${h} future`)
    // past, then now, then future, in that order
    assert.equal(marks.join(" "), [...Array(h - 8).fill("past"), "now", ...Array(23 - h).fill("future")].join(" "))
  }
}
same(hourDots(at(14, 30)), hourDotsAt(14))
assert.equal(hourDots(at(8))[0], "now")
assert.equal(hourDots(at(23, 59))[15], "now")
same(hourDots(at(0, 30)), Array(16).fill("future"))
console.log("PASS hourDots: 16 marks, past/now/future around the current hour, all ahead before 8am")

// msToNextMinute: lands exactly on the next minute
assert.equal(msToNextMinute(at(12, 0, 0, 0)), 60000)
assert.equal(msToNextMinute(at(12, 0, 59, 999)), 1)
assert.equal(msToNextMinute(at(12, 0, 30, 500)), 29500)
assert.equal(msToNextMinute(at(23, 59, 59, 0).getTime()), 1000)
let seed = 7
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const start = new Date(2026, 0, 1).getTime()
for (let i = 0; i < 5000; i++) {
  // across a whole year, DST changes included
  const t = start + Math.floor(random() * 366 * 24 * HOUR)
  const wait = msToNextMinute(t)
  assert.ok(wait > 0 && wait <= 60000, `wait ${wait}`)
  const next = new Date(t + wait)
  assert.equal(next.getSeconds(), 0)
  assert.equal(next.getMilliseconds(), 0)
  assert.notEqual(`${next.getHours()}:${next.getMinutes()}`, `${new Date(t).getHours()}:${new Date(t).getMinutes()}`, "a new minute")
  const s = minuteStart(t)
  assert.ok(s <= t && t - s < 60000)
  assert.equal(new Date(s).getSeconds(), 0)
  assert.equal(minuteStart(s), s)
}
console.log("PASS msToNextMinute lands on the next minute boundary (5000 times through a year)")

// clockStep: the minute shown and the next turn come from one reading, so a
// minute that turns between the render and the timer being set is never skipped
assert.ok(LATE_MS > 0 && LATE_MS < 100)
for (let i = 0; i < 5000; i++) {
  const now = start + Math.floor(random() * 366 * 24 * HOUR)
  const { minute, wait } = clockStep(now)
  assert.equal(minute, minuteStart(now))
  assert.ok(minute <= now && now < minute + 60000, "shows the minute it is")
  assert.equal(minuteStart(now + wait), minute + 60000, "wakes in the very next minute")
  assert.equal(now + wait - (minute + 60000), LATE_MS, "just past the turn")
}
// rendered at 14:04:59.990, the timer set 20ms later: the step taken then shows 14:05 and aims at 14:06
const render = at(14, 4, 59, 990).getTime(), mount = render + 20
assert.equal(new Date(clockStep(render).minute).getMinutes(), 4)
assert.equal(new Date(clockStep(mount).minute).getMinutes(), 5, "caught up at mount")
assert.equal(new Date(mount + clockStep(mount).wait).getMinutes(), 6)
console.log("PASS clockStep: what's shown and when it next changes agree, even across a turn at mount")

// welcomeBack: 20 hours or more, nothing else
for (const away of [null, undefined, NaN, Infinity, -1, 0, 60000, 19 * HOUR, 20 * HOUR - 1]) assert.equal(welcomeBack(away), false, String(away))
for (const away of [20 * HOUR, 21 * HOUR, 3 * 24 * HOUR, 400 * 24 * HOUR]) assert.equal(welcomeBack(away), true, String(away))
assert.equal(welcomeLine(at(9)), "nice to see you · it's tuesday")
same(welcomeParts(at(9)), { greeting: "nice to see you", day: "it's tuesday" })
// the minute counts from when the page was first in view, not from when it loaded
const seenAt = at(9).getTime()
assert.equal(welcomeLeft(seenAt, seenAt), WELCOME_FOR_MS)
assert.equal(welcomeLeft(seenAt, seenAt + 20000), 40000)
assert.ok(welcomeLeft(seenAt, seenAt + 60000) <= 0, "over after a minute in view")
// opened hidden at 9:00, first looked at two minutes later: the whole minute is still to come
assert.equal(welcomeLeft(seenAt + 120000, seenAt + 120000), WELCOME_FOR_MS)
for (let d = 0; d < 7; d++) {
  const line = welcomeLine(new Date(2026, 8, 27 + d))
  assert.match(line, /^nice to see you · it's [a-z]+day$/)
  // never how long it's been
  assert.doesNotMatch(line, /\d|away|\bdays?\b|miss|been|since|ago/)
}
console.log("PASS welcomeBack: only 20h or more away; the line never says how long")

// prefs: never throws, anything unexpected means the locale decides
for (const raw of [null, "", "{", "[]", "null", "true", '{"h24":true}', '{"v":2,"h24":true}', '{"v":1,"h24":"yes"}', '{"v":1}']) {
  assert.equal(parseClockPrefs(raw), null, String(raw))
}
same(parseClockPrefs('{"v":1,"h24":true}'), { h24: true })
same(parseClockPrefs('{"v":1,"h24":false,"extra":1}'), { h24: false })
for (const h24 of [true, false]) {
  same(JSON.parse(serializeClockPrefs({ h24 })), { v: 1, h24 })
  same(parseClockPrefs(serializeClockPrefs({ h24 })), { h24 })
}
assert.equal(prefers24h({ hourCycle: "h23" }), true)
assert.equal(prefers24h({ hourCycle: "h24" }), true)
assert.equal(prefers24h({ hourCycle: "h12" }), false)
assert.equal(prefers24h({ hourCycle: "h11" }), false)
assert.equal(prefers24h({ hour12: true }), false)
assert.equal(prefers24h({ hour12: false }), true)
assert.equal(prefers24h({}), true)
// this machine's own locale gives an answer either way
assert.equal(typeof prefers24h(new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()), "boolean")
console.log("PASS clock prefs parse without throwing, round-trip, and default from the locale's hour cycle")

// the dots: every glyph is 7 rows of one width, made of dots and gaps only
for (const key of Object.keys(DIGITS)) {
  const rows = DIGITS[key]
  assert.equal(rows.length, 7, key)
  for (const row of rows) {
    assert.equal(row.length, rows[0].length, `${key} is rectangular`)
    assert.match(row, /^[X.]+$/)
  }
  assert.equal(rows[0].length, key === ":" ? 1 : key === "1" ? 3 : 5, `${key} width`)
  // no empty edge columns or rows: the spacing between glyphs is the layout's
  assert.ok(rows.some((row) => row[0] === "X") && rows.some((row) => row[row.length - 1] === "X"), `${key} fills its width`)
}
// all ten digits are different pictures
assert.equal(new Set(Object.values(DIGITS).map((rows) => rows.join("/"))).size, 11)
const keysOf = (digits) => timeGlyphs(digits).map((g) => g.key).join(" ")
const flags = (digits) => glyphLayout(timeGlyphs(digits))
const widthOf = (glyphs) => glyphs.reduce((sum, g) => sum + glyphColumns(g), 0)
const ONE = DIGITS["1"].map((row) => `.${row}.`).join("/")
// every place has its cell, always: a digit that changes keeps its dots, which turn on and off
for (const digits of ["12:05", "9:07", "11:11", "1:00", "00:00", "23:59"]) assert.equal(keysOf(digits), "h0 h1 c m0 m1", digits)
// b: no tens of hours, n: a leading one, w: five wide
assert.equal(flags("9:07"), "bwwww")
assert.equal(flags("1:05"), "bnwww")
assert.equal(flags("12:05"), "nwwww")
assert.equal(flags("11:11"), "nwwww", "only the leading one is narrow")
assert.equal(flags("10:00"), "nwwww")
assert.equal(flags("01:15"), "wwwww")
assert.equal(flags("21:11"), "wwwww")
// every digit's cell is five wide (a one in its middle), the colon one
for (const g of timeGlyphs("11:11")) assert.equal(g.rows[0].length, g.key === "c" ? 1 : 5)
for (const g of timeGlyphs("11:11")) if (g.key !== "c") assert.equal(g.rows.join("/"), ONE, "the same one everywhere")
assert.equal(timeGlyphs("9:07")[0].rows.join(""), ".".repeat(35), "a missing tens is dark")
// going out where it stands: the same place, every dot off
for (const g of timeGlyphs("12:58")) {
  const dark = darkGlyph(g)
  assert.equal(dark.key, g.key)
  assert.equal(dark.narrow, g.narrow)
  assert.equal(dark.rows.length, 7)
  assert.equal(dark.rows[0].length, g.rows[0].length)
  assert.ok(dark.rows.every((row) => !row.includes("X")))
}
// through a whole day, 12 and 24 hours: the width never changes within an
// hour, and between hours only where the number of digits or a leading one does
const changes = { true: [], false: [] }
for (const h24 of [true, false]) {
  let before = null
  for (let h = 0; h < 24; h++) {
    const widths = new Set()
    for (let m = 0; m < 60; m++) {
      const glyphs = timeGlyphs(formatTime(at(h, m), h24).digits)
      widths.add(widthOf(glyphs))
      assert.ok(glyphs.every((g) => g.rows.length === 7))
      const layout = glyphLayout(glyphs)
      if (before !== null && layout !== before) changes[h24].push(`${h}:${m}`)
      before = layout
    }
    assert.equal(widths.size, 1, `${h24 ? 24 : 12}h, hour ${h}: the same width all hour`)
  }
}
same(changes.true, ["10:0", "20:0"], "24h: only at ten and at eight in the evening")
// 12h: to and from a lone leading one (12 to 1, 1 to 2) and at ten, morning and evening
same(changes.false, ["1:0", "2:0", "10:0", "13:0", "14:0", "22:0"], "12h: only at 1, 2 and 10")
console.log("PASS dot digits: 5x7 glyphs in stable places, a narrow leading one, width changes only when it must")
