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
  NOTEBOOK_KEY, NOTEBOOK_BROKEN_KEY, NOTE_MAX_CHARS, clampNote, parseNote, serializeNote, lineAt, taskText, takeLine, putBack,
  openNote, fromOtherTab, pageNotice,
} = loadModule("./notebook")
// the module lives in its own realm, so compare plain values
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)

assert.equal(NOTEBOOK_KEY, "lofai.notebook")
assert.equal(NOTEBOOK_BROKEN_KEY, "lofai.notebook.broken")
assert.equal(NOTE_MAX_CHARS, 20000)

// --- the stored note ---
same(parseNote(null), { note: { text: "", updatedAt: 0 }, status: "empty" })
for (const raw of ["", "{", "[]", "null", "42", '"text"', "{}", '{"v":0,"text":"a"}', '{"v":-1,"text":"a"}', '{"v":1.5,"text":"a"}',
  '{"v":"1","text":"a"}', '{"v":1}', '{"v":1,"text":7}', '{"v":null,"text":"a"}']) {
  const parsed = parseNote(raw)
  assert.equal(parsed.status, "unreadable", raw)
  same(parsed.note, { text: "", updatedAt: 0 }, raw)
}
same(parseNote('{"v":1,"text":"call mom\\nbuy oats","updatedAt":1700000000000}'),
  { note: { text: "call mom\nbuy oats", updatedAt: 1700000000000 }, status: "ok" })
same(parseNote('{"v":1,"text":"","updatedAt":5}'), { note: { text: "", updatedAt: 5 }, status: "ok" })
same(parseNote('{"v":1,"text":"a","updatedAt":"soon"}'), { note: { text: "a", updatedAt: 0 }, status: "ok" }, "a bad time is just unknown")
// a newer build's note still reads as words when they're there, but says it's newer
same(parseNote('{"v":2,"text":"from the future","pages":[]}'), { note: { text: "from the future", updatedAt: 0 }, status: "future" })
same(parseNote('{"v":2,"pages":["a"]}'), { note: { text: "", updatedAt: 0 }, status: "future" })
// never throws, whatever it's given
for (let i = 0; i < 400; i++) {
  const bytes = Array.from({ length: (i * 7) % 40 }, (_, k) => String.fromCharCode(32 + ((i * 31 + k * 17) % 95))).join("")
  for (const raw of [bytes, `{"v":1,"text":${JSON.stringify(bytes)}}`, `{${bytes}}`]) {
    const parsed = parseNote(raw)
    assert.equal(typeof parsed.note.text, "string")
  }
}
// round trip
for (const text of ["", "a", "one\ntwo\n", "  spaced  ", "emoji 🐈‍⬛ and tabs\t", "x".repeat(NOTE_MAX_CHARS)]) {
  const stored = JSON.parse(serializeNote(text, 123))
  same(stored, { v: 1, text, updatedAt: 123 })
  same(parseNote(serializeNote(text, 123)), { note: { text, updatedAt: 123 }, status: "ok" })
}
console.log("PASS the stored note parses without throwing, keeps newer notes' words, and round-trips")

// --- opening the saved page ---
same(openNote(null, false), { text: "", keepAside: false, notice: false }, "nothing saved: a fresh page, nothing to keep")
same(openNote(serializeNote("hello", 1), false), { text: "hello", keepAside: false, notice: false })
same(openNote(serializeNote("hello", 1), true), { text: "hello", keepAside: false, notice: false }, "an old stash doesn't matter to a good note")
same(openNote("{", false), { text: "", keepAside: true, notice: true }, "unreadable: kept aside, and said")
same(openNote("{", true), { text: "", keepAside: false, notice: false }, "something's already kept aside: not written over, and said once only")
same(openNote('{"v":2,"text":"from the future"}', false), { text: "from the future", keepAside: true, notice: false }, "newer: kept aside, but opens with its words")
same(openNote('{"v":2,"pages":[]}', false), { text: "", keepAside: true, notice: false })
for (const raw of ["", "[]", "null", '{"v":0}', '{"v":1,"text":3}']) {
  const o = openNote(raw, false)
  assert.equal(o.keepAside, true, raw)
  assert.equal(o.text, "", raw)
}
console.log("PASS an unreadable or newer note is kept aside once before anything is written; only unreadable says so")

// --- another tab saved ---
assert.equal(fromOtherTab(serializeNote("from tab B", 2), false), "from tab B")
assert.equal(fromOtherTab(serializeNote("", 2), false), "", "an emptied page comes over too")
assert.equal(fromOtherTab(serializeNote("from tab B", 2), true), null, "changes waiting to save here win")
assert.equal(fromOtherTab(null, false), null, "a removed note never empties this page")
assert.equal(fromOtherTab("{", false), null, "nor does an unreadable one")
assert.equal(fromOtherTab('{"v":2,"text":"newer"}', false), "newer", "a newer build's words come over")
assert.equal(fromOtherTab('{"v":2,"pages":[]}', false), null, "a newer build's page with no words doesn't")
assert.equal(fromOtherTab(serializeNote("z".repeat(NOTE_MAX_CHARS + 5), 1), false).length, NOTE_MAX_CHARS)
console.log("PASS another tab's save comes over unless this one has changes waiting")

// --- the foot's notice ---
assert.equal(pageNotice({ saveError: false, full: false, setAside: false }), null)
assert.equal(pageNotice({ saveError: true, full: false, setAside: false }).full, "This browser couldn't save your note. It's here for this visit.")
assert.equal(pageNotice({ saveError: true, full: true, setAside: true }).short, pageNotice({ saveError: true, full: false, setAside: false }).short, "a failed save matters most")
assert.match(pageNotice({ saveError: false, full: true, setAside: true }).short, /full/, "then a full page")
assert.match(pageNotice({ saveError: false, full: false, setAside: true }).full, /couldn't be read, so this page starts fresh/)
for (const o of [{ saveError: true }, { full: true }, { setAside: true }]) {
  const n = pageNotice({ saveError: false, full: false, setAside: false, ...o })
  assert.ok(n.short.length <= 34, `short enough for the pocket's foot: ${n.short}`)
  assert.ok(n.full.length > n.short.length)
}
console.log("PASS the foot says one short thing, a failed save first, with the whole sentence kept for screen readers")

// --- the 20,000 character page ---
assert.equal(clampNote("short"), "short")
assert.equal(clampNote("x".repeat(NOTE_MAX_CHARS)).length, NOTE_MAX_CHARS)
assert.equal(clampNote("x".repeat(NOTE_MAX_CHARS + 50)).length, NOTE_MAX_CHARS)
// an emoji straddling the edge isn't cut in half
const straddle = "x".repeat(NOTE_MAX_CHARS - 1) + "🐈" + "tail"
assert.equal(clampNote(straddle).length, NOTE_MAX_CHARS - 1)
assert.equal(clampNote("x".repeat(NOTE_MAX_CHARS - 2) + "🐈" + "tail"), "x".repeat(NOTE_MAX_CHARS - 2) + "🐈")
assert.equal(JSON.parse(serializeNote("y".repeat(NOTE_MAX_CHARS + 9), 1)).text.length, NOTE_MAX_CHARS)
assert.equal(parseNote(JSON.stringify({ v: 1, text: "z".repeat(NOTE_MAX_CHARS * 2) })).note.text.length, NOTE_MAX_CHARS)
console.log("PASS a page holds 20,000 characters and never splits an emoji")

// --- the caret's line ---
const page = "first\nsecond line\n\nlast"
same(lineAt(page, 0), { start: 0, end: 5, text: "first" })
same(lineAt(page, 5), { start: 0, end: 5, text: "first" }, "at the line break, still the line it ends")
same(lineAt(page, 6), { start: 6, end: 17, text: "second line" }, "just after a break, the next line")
same(lineAt(page, 12), { start: 6, end: 17, text: "second line" })
same(lineAt(page, 18), { start: 18, end: 18, text: "" }, "an empty line")
same(lineAt(page, page.length), { start: 19, end: 23, text: "last" })
same(lineAt(page, 999), { start: 19, end: 23, text: "last" }, "clamped past the end")
same(lineAt(page, -4), { start: 0, end: 5, text: "first" }, "clamped before the start")
same(lineAt(page, NaN), { start: 0, end: 5, text: "first" })
same(lineAt("", 0), { start: 0, end: 0, text: "" })
same(lineAt("\nb", 0), { start: 0, end: 0, text: "" }, "a leading break: the empty first line")
same(lineAt("\nb", 1), { start: 1, end: 2, text: "b" })
// brute force: the line always contains the caret and has no break inside
for (let n = 0; n < 300; n++) {
  const text = Array.from({ length: n % 23 }, (_, k) => ((n * 13 + k * 7) % 5 === 0 ? "\n" : "ab c"[(n + k) % 4])).join("")
  for (let c = 0; c <= text.length; c++) {
    const l = lineAt(text, c)
    assert.ok(l.start <= c && c <= l.end, `${JSON.stringify(text)} @${c}`)
    assert.equal(l.text.indexOf("\n"), -1)
    assert.ok(l.start === 0 || text[l.start - 1] === "\n")
    assert.ok(l.end === text.length || text[l.end] === "\n")
  }
}
console.log("PASS lineAt finds the caret's line, edges included")

// --- a line as a task ---
assert.equal(taskText("  call mom  "), "call mom")
assert.equal(taskText("- buy oats"), "buy oats")
assert.equal(taskText("* buy oats"), "buy oats")
assert.equal(taskText("• buy oats"), "buy oats")
assert.equal(taskText("1. buy oats"), "buy oats")
assert.equal(taskText("12) buy oats"), "buy oats")
assert.equal(taskText("- [ ] buy oats"), "buy oats")
assert.equal(taskText("[x] buy oats"), "buy oats")
assert.equal(taskText("[] buy oats"), "buy oats")
assert.equal(taskText("buy\t\toats   today"), "buy oats today")
assert.equal(taskText("-5 degrees out"), "-5 degrees out", "a minus sign isn't a bullet")
assert.equal(taskText("2026. a good year"), "2026. a good year", "a year isn't a numbered item")
assert.equal(taskText("- "), "")
assert.equal(taskText("   "), "")
assert.equal(taskText("- [ ]"), "")
console.log("PASS taskText drops bullets and checkboxes, and keeps the words")

// --- taking a line ---
const rebuild = (t) => t.text.slice(0, t.at) + t.removed + t.text.slice(t.at + t.kept.length)
function taken(text, caret, max) {
  const t = takeLine(text, caret, max)
  if (t) assert.equal(rebuild(t), text, "what was taken rebuilds the page exactly")
  return t
}
{
  const t = taken("a\nbuy oats\nc", 5)
  same({ text: t.text, caret: t.caret, line: t.line }, { text: "a\nc", caret: 2, line: "buy oats" }, "a middle line goes with its break")
}
{
  const t = taken("a\nb\nlast one", 7)
  same({ text: t.text, caret: t.caret, line: t.line }, { text: "a\nb", caret: 3, line: "last one" }, "the last line takes the break before it")
}
{
  const t = taken("only line", 3)
  same({ text: t.text, caret: t.caret, line: t.line }, { text: "", caret: 0, line: "only line" })
}
{
  const t = taken("first\nsecond", 0)
  same({ text: t.text, caret: t.caret, line: t.line }, { text: "second", caret: 0, line: "first" }, "the first line")
}
{
  const t = taken("first\nsecond", 5)
  assert.equal(t.line, "first", "at the end of a line, that line")
}
{
  const t = taken("x\n- [ ] water the basil\ny", 4)
  same({ text: t.text, line: t.line }, { text: "x\ny", line: "water the basil" }, "the bullet stays behind with the line's break")
}
assert.equal(takeLine("a\n\nb", 2), null, "a blank line gives null")
assert.equal(takeLine("a\n   \nb", 3), null, "so does a line of spaces")
assert.equal(takeLine("a\n- \nb", 3), null, "and a bare bullet")
assert.equal(takeLine("", 0), null)
// every caret on every line of a page: the page shrinks by exactly that line
for (let n = 0; n < 200; n++) {
  const lines = Array.from({ length: 1 + (n % 6) }, (_, k) => ((n + k) % 4 === 0 ? "" : `line ${n}-${k}`))
  const text = lines.join("\n")
  for (let c = 0; c <= text.length; c++) {
    const l = lineAt(text, c)
    const t = taken(text, c)
    if (!l.text.trim()) { assert.equal(t, null); continue }
    assert.equal(t.line, l.text.trim())
    const left = lines.slice()
    left.splice(text.slice(0, l.start).split("\n").length - 1, 1)
    assert.equal(t.text, left.join("\n"), `${JSON.stringify(text)} @${c}`)
    assert.ok(t.caret >= 0 && t.caret <= t.text.length)
    assert.ok(t.caret === 0 || t.text[t.caret - 1] === "\n" || t.caret === t.text.length, "the caret lands at a line's edge")
  }
}
console.log("PASS takeLine takes the caret's line with one line break, and a blank line gives null")

// a line longer than a task holds: the task gets what fits, cut at a word, and the rest stays
{
  const long = "one two three four five six seven"
  const t = taken(`a\n${long}\nb`, 4, 14)
  same({ line: t.line, text: t.text, caret: t.caret }, { line: "one two three", text: "a\nfour five six seven\nb", caret: 2 })
  assert.ok(t.line.length <= 14)
}
{
  const t = taken("x".repeat(30), 3, 10)
  same({ line: t.line, text: t.text }, { line: "x".repeat(10), text: "x".repeat(20) }, "no word to cut at: a clean cut")
}
{
  const t = taken("ab " + "c".repeat(30), 1, 10)
  same({ line: t.line, text: t.text }, { line: "ab ccccccc", text: "c".repeat(23) }, "a word boundary too early to be useful: a clean cut")
}
{
  const t = taken("x".repeat(9) + "🐈" + "y", 0, 10)
  assert.equal(t.line, "x".repeat(9), "the cut doesn't split an emoji")
  assert.equal(t.text, "🐈y")
}
for (let n = 1; n < 120; n++) {
  const words = Array.from({ length: 5 + (n % 40) }, (_, k) => "w".repeat(1 + ((n + k) % 9))).join(" ")
  const t = taken(words, 0, 50)
  assert.ok(t.line.length <= 50)
  const joined = (t.line + " " + t.text).replace(/\s+/g, " ").trim()
  assert.equal(joined, words, "the task and what's left make up the whole line")
}
console.log("PASS a line too long for one task leaves the rest on the page")

// --- putting it back ---
{
  const text = "a\nbuy oats\nc"
  const t = taken(text, 6)
  same(putBack(t.text, t), { text, caret: 6, whole: true }, "unchanged since: the page exactly as it was, caret too")
  same(putBack("a\nso c", t), { text: "a\nbuy oats\nso c", caret: 10, whole: true }, "written at the caret: back in its place, above it")
  same(putBack("a\nc and more", t), { text: "a\nc and more\nbuy oats", caret: 21, whole: true }, "written elsewhere: back at the end")
  same(putBack("zz\na\nc", t), { text: "zz\na\nc\nbuy oats", caret: 15, whole: true })
  same(putBack("", t), { text: "buy oats", caret: 8, whole: true })
}
{
  const t = taken("a\nlast", 4)
  same(putBack(t.text, t), { text: "a\nlast", caret: 4, whole: true })
  same(putBack("a more", t), { text: "a more\nlast", caret: 11, whole: true }, "the last line: after what was written on the line before")
}
{
  const t = taken("only", 2)
  same(putBack("new thought", t), { text: "only\nnew thought", caret: 4, whole: true }, "the only line: before what was written since")
}
{
  const t = taken("one two three four", 2, 8)
  same({ line: t.line, text: t.text }, { line: "one two", text: "three four" })
  same(putBack(t.text, t), { text: "one two three four", caret: 2, whole: true })
  same(putBack("so three four", t), { text: "so one two three four", caret: 21, whole: true })
  same(putBack("three four\nnew", t), { text: "three four\nnew\none two", caret: 22, whole: true }, "nothing lost, nothing doubled")
}
{
  const t = taken("a\nb", 2)
  const full = "q".repeat(NOTE_MAX_CHARS)
  const back = putBack(full, t)
  assert.equal(back.text.length, NOTE_MAX_CHARS)
  assert.equal(back.whole, false, "no room on a full page: the task should stay")
}
// whatever was written where the caret was left survives, and so does the line
for (let n = 0; n < 200; n++) {
  const lines = Array.from({ length: 1 + (n % 5) }, (_, k) => `- item ${n}.${k}`)
  const text = lines.join("\n")
  const t = taken(text, (n * 7) % (text.length + 1))
  const typed = ["", "x", " more", "two\nlines"][n % 4]
  const current = t.text.slice(0, t.caret) + typed + t.text.slice(t.caret)
  const back = putBack(current, t)
  assert.ok(back.text.indexOf(t.removed.replace(/\n/g, "")) >= 0, "the line is back")
  assert.equal(back.text.replace(t.removed.replace(/\n/g, ""), "").replace(typed, "").replace(/\n+/g, "\n").replace(/^\n|\n$/g, ""),
    t.text.replace(/\n+/g, "\n").replace(/^\n|\n$/g, ""), "and nothing else changed")
  if (!typed) same(back.text, text)
}
for (let n = 0; n < 150; n++) {
  const text = Array.from({ length: 2 + (n % 5) }, (_, k) => `- item ${n}.${k}`).join("\n")
  const c = (n * 7) % (text.length + 1)
  const t = taken(text, c)
  same(putBack(t.text, t).text, text, "round trip")
}
console.log("PASS putBack restores the page, and never loses the line")
