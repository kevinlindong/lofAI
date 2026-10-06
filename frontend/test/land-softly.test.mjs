import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const source = readFileSync(new URL("../lib/land-softly.ts", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const context = { exports: {} }
vm.runInNewContext(compiled, context)
const {
  minutesOf, blockStart, creditedTask, doneTarget, doneLabel, afterDone, anotherBit,
  landingCopy, landingNews, landedLine, stillOpenCopy,
} = context.exports

const MIN = 60000
const END = Date.UTC(2026, 8, 29, 12)
const landing = { at: END, minutes: 25, taskId: "a" }
const open = { id: "a", text: "Draft the intro paragraph", done: false }

// minutes read as words, whole, and never zero
assert.equal(minutesOf(25), "25 minutes")
assert.equal(minutesOf(1), "1 minute")
assert.equal(minutesOf(0.2), "1 minute")
assert.equal(minutesOf(9.6), "10 minutes")

// the block's start comes from its session (pauses included), or its length back from the end
assert.equal(blockStart([{ start: END - 40 * MIN, end: END }], landing), END - 40 * MIN)
assert.equal(blockStart([{ start: 1, end: 2 }, { start: END - 30 * MIN, end: END }, { start: END + 1, end: END + 2 }], landing), END - 30 * MIN)
assert.equal(blockStart([], landing), END - 25 * MIN)
assert.equal(blockStart([{ start: 1, end: 2 }], landing), END - 25 * MIN)

// the minutes go to the task still open
const start = END - 25 * MIN
assert.equal(creditedTask([open], landing, start)?.id, "a")
// or to one checked off while the block ran, or after it landed
assert.equal(creditedTask([{ ...open, done: true, doneAt: start + 5 * MIN }], landing, start)?.id, "a")
assert.equal(creditedTask([{ ...open, done: true, doneAt: END + MIN }], landing, start)?.id, "a")
// never to one finished before the block began, or finished with no record of when
assert.equal(creditedTask([{ ...open, done: true, doneAt: start - MIN }], landing, start), null)
assert.equal(creditedTask([{ ...open, done: true }], landing, start), null)
// nothing on the desk, or a task that's gone, credits nobody
assert.equal(creditedTask([open], { ...landing, taskId: null }, start), null)
assert.equal(creditedTask([open], { ...landing, taskId: "gone" }, start), null)

// [done] finishes an open task; with nothing open it's just done for now
assert.equal(doneTarget(open), "a")
assert.equal(doneTarget({ ...open, done: true }), null)
assert.equal(doneTarget(null), null)
assert.equal(doneLabel(open), "Done with Draft the intro paragraph")
assert.equal(doneLabel({ ...open, done: true }), "Done for now")
assert.equal(doneLabel(null), "Done for now")

// after its toggle: still open means the service said no; done or gone lets the note go
assert.equal(afterDone([open], "a"), "still-open")
assert.equal(afterDone([{ ...open, done: true }], "a"), "finished")
assert.equal(afterDone([], "a"), "finished")

// another little bit: ten minutes at most, never longer than a block
assert.equal(anotherBit(25), 10)
assert.equal(anotherBit(10), 10)
assert.equal(anotherBit(6), 6)
assert.equal(anotherBit(1), 1)

// the words (§6.6), warm and never a score
assert.equal(landingCopy(25, true), "25 minutes with this. nicely done.")
assert.equal(landingCopy(25, false), "25 minutes of focus. nicely done.")
assert.equal(landingCopy(1, false), "1 minute of focus. nicely done.")
assert.equal(landingNews(25, "Draft the intro paragraph"), "25 minutes with Draft the intro paragraph. nicely done.")
assert.equal(landingNews(10, null), "10 minutes of focus. nicely done.")
assert.equal(landedLine(25), "25 minutes. nicely done.")
assert.equal(stillOpenCopy("Todoist"), "Couldn't update Todoist. It's still open.")

console.log("land-softly: ok")
