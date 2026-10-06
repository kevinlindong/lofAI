import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

// the day is the local one, so every case pins its zone. node re-reads TZ
// whenever it's assigned, in this realm and the module's
process.env.TZ = "America/New_York"

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
  TODAY_KEY, BEAD_MIN_PX, BEAD_MAX_PX, BEAD_GAP_PX, BEAD_ROW_PX, dayBounds, landedToday, finishedToday, focusTime, summarize, beadSize,
  beadsThatFit, dayLine, dayStamp, parseKept, serializeKept, keepFinished, withKept, dayMarkdown, markdownText,
} = loadModule("./day-summary")
// the module lives in its own realm, so compare what storage would hold
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
const MIN = 60 * 1000
const HOUR = 60 * MIN
const block = (end, minutes = 25, taskId = null) => ({ start: end - minutes * MIN, end, minutes, taskId })
const done = (id, doneAt, text = id) => ({ id, text, done: true, doneAt })
const open = (id, text = id) => ({ id, text, done: false })

assert.equal(TODAY_KEY, "lofai.today")

// ── the copy ────────────────────────────────────────────────────────────
{
  const NOW = new Date(2026, 8, 29, 17, 0).getTime()
  const at = (h, m = 0) => new Date(2026, 8, 29, h, m).getTime()
  const empty = summarize([], [], NOW)
  assert.equal(empty.sentence, "Nothing needed today. The room's here when you are.")
  same([empty.minutes, empty.blocks, empty.finished], [0, [], 0])
  assert.ok(empty.parts.every((p) => !p.strong), "an empty day has no numbers to set in bold")

  const focusOnly = summarize([block(at(9, 30), 25), block(at(11), 25)], [], NOW)
  assert.equal(focusOnly.sentence, "You made room for 50 minutes of focus.")
  same(focusOnly.parts.filter((p) => p.strong).map((p) => p.text), ["50 minutes"])

  const tasksOnly = summarize([], [done("a", at(9)), done("b", at(10)), done("c", at(16)), open("d")], NOW)
  assert.equal(tasksOnly.sentence, "You finished 3 small things.")
  same(tasksOnly.parts.filter((p) => p.strong).map((p) => p.text), ["3 small things"])

  const both = summarize([block(at(9, 30), 25), block(at(10, 30), 25), block(at(14), 25)], [done("a", at(9)), done("b", at(10)), done("c", at(16))], NOW)
  assert.equal(both.sentence, "You made room for 1 h 15 m of focus and 3 small things.")
  same(both.parts.filter((p) => p.strong).map((p) => [p.text, p.spoken ?? null]), [["1 h 15 m", "1 hour 15 minutes"], ["3 small things", null]])
  same([both.minutes, both.blocks, both.finished], [75, [25, 25, 25], 3])

  assert.equal(summarize([block(at(9), 1)], [done("a", at(9))], NOW).sentence, "You made room for 1 minute of focus and 1 small thing.")
  assert.equal(summarize([block(at(9), 60)], [], NOW).sentence, "You made room for 1 h of focus.")
  assert.equal(summarize([block(at(9), 60), block(at(11), 60), block(at(13), 5)], [], NOW).sentence, "You made room for 2 h 5 m of focus.")
  same(focusTime(0), { text: "0 minutes", spoken: "0 minutes" })
  same(focusTime(61), { text: "1 h 1 m", spoken: "1 hour 1 minute" })
  same(focusTime(120), { text: "2 h", spoken: "2 hours" })
  same(focusTime(179.6), { text: "3 h", spoken: "3 hours" })
  // a sliver of a block is still some focus
  assert.equal(summarize([block(at(9), 0.3)], [], NOW).minutes, 1)
  console.log("PASS each copy variant reads right, with the numbers in bold")
}

// ── the local day, across the clock changes (New York) ───────────────────
{
  // spring forward: 8 March 2026 has 23 hours. midnight EST is 05:00Z, the
  // next midnight (EDT) is 04:00Z on the 9th
  const spring = dayBounds(Date.UTC(2026, 2, 8, 16))
  same(spring, { start: Date.UTC(2026, 2, 8, 5), end: Date.UTC(2026, 2, 9, 4) })
  assert.equal(spring.end - spring.start, 23 * HOUR)
  const springNow = Date.UTC(2026, 2, 8, 20)
  const springBlocks = [
    block(spring.start - 1), block(spring.start), block(Date.UTC(2026, 2, 8, 7, 30)), block(spring.end - 1),
    // 00:30 EDT on the 9th: inside a naive 24-hour window, but tomorrow
    block(Date.UTC(2026, 2, 9, 4, 30)), block(spring.end),
  ]
  same(landedToday(springBlocks, springNow).map((s) => s.end), [spring.start, Date.UTC(2026, 2, 8, 7, 30), spring.end - 1])
  same(finishedToday([done("before", spring.start - 1), done("first", spring.start), done("last", spring.end - 1), done("next", Date.UTC(2026, 2, 9, 4, 30))], springNow).map((t) => t.id), ["first", "last"])

  // fall back: 1 November 2026 has 25 hours, and 1:30 happens twice
  const fall = dayBounds(Date.UTC(2026, 10, 1, 16))
  same(fall, { start: Date.UTC(2026, 10, 1, 4), end: Date.UTC(2026, 10, 2, 5) })
  assert.equal(fall.end - fall.start, 25 * HOUR)
  const fallNow = Date.UTC(2026, 10, 2, 4, 45)
  const fallBlocks = [
    block(Date.UTC(2026, 10, 1, 5, 30)), block(Date.UTC(2026, 10, 1, 6, 30)),
    // 23:30 EST: past a naive 24-hour window, still today
    block(Date.UTC(2026, 10, 2, 4, 30), 50),
    block(fall.end),
  ]
  const fallDay = summarize(fallBlocks, [done("late", Date.UTC(2026, 10, 2, 4, 59))], fallNow)
  same([fallDay.blocks, fallDay.finished], [[25, 25, 50], 1])
  assert.equal(fallDay.sentence, "You made room for 1 h 40 m of focus and 1 small thing.")

  // every moment of those days (and the days around them) agrees on its day
  for (const [y, m, d] of [[2026, 2, 7], [2026, 2, 8], [2026, 2, 9], [2026, 9, 31], [2026, 10, 1], [2026, 10, 2]]) {
    const first = dayBounds(new Date(y, m, d, 12).getTime())
    for (let t = first.start; t < first.end; t += 7 * MIN) same(dayBounds(t), first, new Date(t).toString())
  }
  console.log("PASS days run local midnight to midnight across New York's 23- and 25-hour days")
}

// ── every zone: named with DST, and fixed offsets ────────────────────────
{
  const zones = [
    "America/New_York", "Europe/London", "Australia/Sydney", "Australia/Lord_Howe", "America/Santiago",
    "Pacific/Chatham", "Asia/Kolkata", "UTC", "Etc/GMT-14", "Etc/GMT+12",
  ]
  const lengths = new Set()
  for (const zone of zones) {
    process.env.TZ = zone
    const from = Date.UTC(2026, 0, 1), to = Date.UTC(2027, 0, 1)
    for (let now = from; now < to; now += 3 * HOUR + 17 * MIN) {
      const b = dayBounds(now)
      const date = new Date(now).getDate()
      assert.ok(b.start <= now && now < b.end, `${zone} ${new Date(now).toISOString()}`)
      // the day begins and ends at a change of local date
      assert.equal(new Date(b.start).getDate(), date, zone)
      assert.notEqual(new Date(b.start - 1).getDate(), date, zone)
      assert.equal(new Date(b.end - 1).getDate(), date, zone)
      assert.notEqual(new Date(b.end).getDate(), date, zone)
      // and the days tile with no gap and no overlap
      assert.equal(dayBounds(b.end).start, b.end, zone)
      lengths.add((b.end - b.start) / HOUR)
    }
    // with a fixed offset every day is exactly a day, starting at local midnight
    if (zone === "UTC" || zone.startsWith("Etc/")) {
      const b = dayBounds(Date.UTC(2026, 8, 29, 12))
      assert.equal(b.end - b.start, 24 * HOUR, zone)
      assert.equal(new Date(b.start).getHours() + new Date(b.start).getMinutes(), 0, zone)
    }
  }
  // 23 and 25 (most DST), 23.5 and 24.5 (Lord Howe's half-hour shift)
  same(Array.from(lengths).sort((a, b) => a - b), [23, 23.5, 24, 24.5, 25])

  // a fixed offset far from UTC: +14 starts its day at 10:00Z the day before
  process.env.TZ = "Etc/GMT-14"
  same(dayBounds(Date.UTC(2026, 8, 29, 9)), { start: Date.UTC(2026, 8, 28, 10), end: Date.UTC(2026, 8, 29, 10) })
  same(landedToday([block(Date.UTC(2026, 8, 28, 9, 59)), block(Date.UTC(2026, 8, 28, 10)), block(Date.UTC(2026, 8, 29, 10))], Date.UTC(2026, 8, 29, 9)).map((s) => s.end), [Date.UTC(2026, 8, 28, 10)])
  // Santiago skips midnight when summer time starts (6 September 2026): the day starts at 01:00
  process.env.TZ = "America/Santiago"
  const skipped = dayBounds(new Date(2026, 8, 6, 12).getTime())
  assert.equal(new Date(skipped.start).getHours(), 1)
  assert.equal(skipped.end - skipped.start, 23 * HOUR)
  process.env.TZ = "America/New_York"
  console.log("PASS day bounds hold in 10 zones over a year: DST, half-hour DST, skipped midnights, fixed offsets")
}

// ── blocks and beads ─────────────────────────────────────────────────────
{
  const NOW = new Date(2026, 8, 29, 18).getTime()
  const at = (h, m = 0) => new Date(2026, 8, 29, h, m).getTime()
  const yesterday = new Date(2026, 8, 28, 23, 59).getTime()
  // oldest first by when they landed, whatever order the log is in
  const day = summarize([block(at(15), 10), block(yesterday, 25), block(at(9), 45), block(at(12), 25)], [], NOW)
  same(day.blocks, [45, 25, 10])
  assert.equal(day.minutes, 80)
  // unreadable minutes never count
  same(summarize([{ start: at(8), end: at(9), minutes: 0, taskId: null }], [], NOW).blocks, [])

  same([0, 5, 10, 15, 25, 30, 45, 50, 60, 90].map(beadSize), [6, 6, 6, 7, 9, 10, 12, 13, 14, 14])
  for (const bad of [NaN, -5, Infinity, undefined]) assert.ok(beadSize(bad) >= BEAD_MIN_PX && beadSize(bad) <= BEAD_MAX_PX, String(bad))
  let last = 0
  for (let m = 0; m <= 120; m += 0.5) {
    const d = beadSize(m)
    assert.ok(d >= last && d >= 6 && d <= 14, `bead for ${m}`)
    last = d
  }
  // by area: 50 minutes is about twice 25
  assert.ok(Math.abs((beadSize(50) / beadSize(25)) ** 2 - 2) < 0.2)

  // one line of beads: all of a usual day, and a long one up to its "+N"
  const line = (sizes) => sizes.reduce((w, d) => w + d, 0) + BEAD_GAP_PX * Math.max(0, sizes.length - 1)
  assert.equal(beadsThatFit([]), 0)
  assert.equal(beadsThatFit([9, 9, 7, 12]), 4)
  const fullLine = Array.from({ length: 16 }, () => 9)
  assert.ok(line(fullLine) <= BEAD_ROW_PX)
  assert.equal(beadsThatFit(fullLine), 16, "sixteen 25-minute blocks fit whole, with no count")
  for (const [d, n] of [[6, 70], [9, 30], [14, 13], [14, 40]]) {
    const sizes = Array.from({ length: n }, () => d)
    const shown = beadsThatFit(sizes)
    assert.ok(shown > 0 && shown < n, `${n} of ${d}px`)
    // the beads shown and the count after them stay inside the line
    assert.ok(line(sizes.slice(0, shown)) + BEAD_GAP_PX + 28 <= BEAD_ROW_PX, `${n} of ${d}px`)
    assert.ok(line(sizes.slice(0, shown + 1)) + BEAD_GAP_PX + 28 > BEAD_ROW_PX, `${n} of ${d}px: as many as fit`)
  }
  // mixed sizes, in order; a narrower line holds fewer
  const mixed = [14, 6, 14, 6, 9, 12, 14, 14, 14, 14, 14, 14, 14, 14]
  assert.ok(beadsThatFit(mixed) < mixed.length)
  assert.ok(beadsThatFit(mixed, 120) < beadsThatFit(mixed))
  assert.equal(beadsThatFit([14, 14], 20), 0, "no room at all: only the count")
  console.log("PASS blocks come oldest first; beads are 6-14px by area on one line, the rest a count")
}

// ── what the day keeps past "clear done" ─────────────────────────────────
{
  const NOW = new Date(2026, 8, 29, 18).getTime()
  const at = (h, m = 0) => new Date(2026, 8, 29, h, m).getTime()
  const yesterday = new Date(2026, 8, 28, 20).getTime()
  for (const raw of [null, "", "{", "[]", "null", '{"v":1}', '{"v":1,"finished":{}}', '{"v":2,"finished":[]}', "[{\"id\":\"a\"}]"]) {
    same(parseKept(raw, NOW), [], String(raw))
  }
  const raw = JSON.stringify({
    v: 1,
    finished: [
      { id: "b", text: "second", doneAt: at(11) }, { id: "a", text: "first", doneAt: at(9) }, { id: "a", text: "again", doneAt: at(12) },
      { id: "old", text: "yesterday", doneAt: yesterday }, { id: "", text: "no id", doneAt: at(9) }, { id: "c", text: 3, doneAt: at(9) },
      { id: "d", text: "no time" }, null, 7, { id: "e", text: "x".repeat(900), doneAt: at(13) },
    ],
  })
  const kept = parseKept(raw, NOW)
  same(kept.map((k) => k.id), ["a", "b", "e"])
  assert.equal(kept[2].text.length, 500)
  same(parseKept(serializeKept(kept), NOW), kept)
  same(JSON.parse(serializeKept(kept)).v, 1)

  // three done today, one open; the list is cleared of what's done
  const list = [done("t1", at(9), "Draft the intro"), done("t2", at(10), "Water the plants"), done("t3", at(16), "Reply to Maya"), open("t4"), done("t5", yesterday)]
  const seen = keepFinished([], list, NOW)
  same(seen.map((k) => k.id), ["t1", "t2", "t3"])
  const cleared = [open("t4")]
  const afterClear = keepFinished(seen, cleared, NOW)
  same(afterClear.map((k) => k.id), ["t1", "t2", "t3"])
  assert.equal(summarize([], withKept(cleared, afterClear), NOW).sentence, "You finished 3 small things.")
  // reopened while still on the list: no longer finished, and forgotten
  const reopened = [done("t1", at(9)), open("t2"), done("t3", at(16))]
  same(keepFinished(seen, reopened, NOW).map((k) => k.id), ["t1", "t3"])
  assert.equal(summarize([], withKept(reopened, keepFinished(seen, reopened, NOW)), NOW).finished, 2)
  // the list's own text and time win for what it still holds
  same(keepFinished([{ id: "t1", text: "old words", doneAt: at(8) }], [done("t1", at(9), "new words")], NOW), [{ id: "t1", text: "new words", doneAt: at(9) }])
  // kept from yesterday is let go; withKept never doubles an id the list has
  same(keepFinished([{ id: "gone", text: "y", doneAt: yesterday }], [], NOW), [])
  same(withKept([done("t1", at(9))], [{ id: "t1", text: "t1", doneAt: at(9) }]).length, 1)
  // inputs are left alone
  const frozen = Object.freeze([Object.freeze(done("f", at(9)))])
  const frozenKept = Object.freeze([Object.freeze({ id: "g", text: "g", doneAt: at(8) })])
  keepFinished(frozenKept, frozen, NOW)
  summarize(Object.freeze([Object.freeze(block(at(9)))]), withKept(frozen, frozenKept), NOW)
  // one thing is one thing, even listed twice
  assert.equal(finishedToday([done("dup", at(9)), done("dup", at(10))], NOW).length, 1)
  // a task restored or imported as done has no doneAt, so it isn't today's
  assert.equal(finishedToday([{ id: "imp", text: "imp", done: true }], NOW).length, 0)
  console.log("PASS the day keeps what was finished today after the list is cleared, and lets go of reopened things")
}

// ── a copy to keep ───────────────────────────────────────────────────────
{
  const NOW = new Date(2026, 8, 29, 18).getTime()
  const at = (h, m = 0) => new Date(2026, 8, 29, h, m).getTime()
  const two = (n) => String(n).padStart(2, "0")
  const time = (ms) => `${new Date(ms).getHours()}:${two(new Date(ms).getMinutes())}`
  assert.equal(dayLine(NOW), "tuesday, 29 september 2026")
  assert.equal(dayStamp(NOW), "2026-09-29")
  assert.equal(dayStamp(new Date(2027, 0, 3, 0, 5).getTime()), "2027-01-03")
  const md = dayMarkdown(
    [block(at(9, 35), 25), block(new Date(2026, 8, 28, 22).getTime()), block(at(14, 25), 50)],
    [done("a", at(10), "Draft the\nintro"), done("b", at(16), "Water the plants"), open("c"), done("old", new Date(2026, 8, 28, 9).getTime())],
    NOW,
    { time },
  )
  assert.equal(md, [
    "# Today · tuesday, 29 september 2026",
    "",
    "You made room for **1 h 15 m** of focus and **2 small things**.",
    "",
    "## Focus",
    "",
    "- 25 minutes, 9:10 to 9:35",
    "- 50 minutes, 13:35 to 14:25",
    "",
    "## Finished",
    "",
    "- [x] Draft the intro",
    "- [x] Water the plants",
    "",
    "_A postcard from lofAI._",
    "",
  ].join("\n"))
  assert.equal(dayMarkdown([], [], NOW, { time }), "# Today · tuesday, 29 september 2026\n\nNothing needed today. The room's here when you are.\n\n_A postcard from lofAI._\n")
  // task words stay words: no bold, links, code, headings or tags from them
  assert.equal(markdownText("Fix the **bold** [link](http://x) and\n# heading"), "Fix the \\*\\*bold\\*\\* \\[link\\](http://x) and \\# heading")
  assert.equal(markdownText("  *args, [WIP] `x` <b> ~~s~~ a_b c\\d  "), "\\*args, \\[WIP\\] \\`x\\` \\<b\\> \\~\\~s\\~\\~ a\\_b c\\\\d")
  assert.equal(markdownText("Water the plants, 3 times."), "Water the plants, 3 times.")
  const escaped = dayMarkdown([], [done("m", at(10), "Read *Middlemarch* [ch. 2]")], NOW, { time })
  assert.match(escaped, /^- \[x\] Read \\\*Middlemarch\\\* \\\[ch\. 2\\\]$/m)
  // the browser's own clock format by default
  assert.match(dayMarkdown([block(at(9, 35))], [], NOW), /- 25 minutes, \S+.* to \S+/)
  console.log("PASS the Markdown copy has the sentence, each block and each finished thing")
}

// ── no streaks, scores or comparisons, in any day ────────────────────────
{
  const NOW = new Date(2026, 8, 29, 23).getTime()
  const at = (i) => new Date(2026, 8, 29, 1, i).getTime()
  const banned = /streak|score|record|best|beat|goal|point|rank|level|average|yesterday|last week|behind|missed|less|fewer|more than|only|just|again|keep it up|%|in a row|days? running/i
  let checked = 0
  for (let blocks = 0; blocks <= 12; blocks++) {
    for (let things = 0; things <= 12; things += 3) {
      const sessions = Array.from({ length: blocks }, (_, i) => block(at(i * 30 + 25), 5 + ((i * 7) % 56)))
      const tasks = Array.from({ length: things }, (_, i) => done(`t${i}`, at(i + 1), "a small thing"))
      const s = summarize(sessions, tasks, NOW)
      assert.doesNotMatch(s.sentence, banned, s.sentence)
      assert.doesNotMatch(dayMarkdown(sessions, tasks, NOW, { time: () => "9:00" }).replace(/a small thing/g, ""), banned)
      checked++
    }
  }
  console.log(`PASS no streak, score or comparison words in ${checked} days of copy`)
}
