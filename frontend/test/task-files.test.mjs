import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { webcrypto } from "node:crypto"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const source = readFileSync(new URL("../lib/task-files.ts", import.meta.url), "utf8")
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const context = { exports: {}, crypto: webcrypto, TextEncoder }
vm.runInNewContext(compiled, context)
const { parseTaskFile, taskCsv, taskMarkdown, calendarFile } = context.exports

const tasks = [{ id: "one", text: 'Plan a "tiny", useful thing', done: false }, { id: "two", text: "Finish the notebook ☕", done: true }]
for (const [name, data] of [["list.json", JSON.stringify(tasks)], ["list.csv", taskCsv(tasks)], ["list.md", taskMarkdown(tasks)]]) {
  assert.deepEqual(JSON.parse(JSON.stringify(parseTaskFile(name, data))).map(({ text, done }) => ({ text, done })), tasks.map(({ text, done }) => ({ text, done })))
}
assert.equal(parseTaskFile("list.csv", '\uFEFFtext,done\r\n"line one\nline two",true')[0].text, "line one\nline two")
assert.match(taskCsv([{ text: "=SUM(1,2)", done: false }]), /"'=SUM\(1,2\)"/)
assert.match(taskCsv([{ text: "  @danger", done: false }]), /"'  @danger"/)
assert.equal(parseTaskFile("list.json", '{"tasks":[null,{"text":"kept","completed":true},123]}')[0].done, true)
assert.throws(() => parseTaskFile("list.csv", 'text,done\n"unfinished,true'), /unfinished/)
assert.throws(() => parseTaskFile("list.csv", "name,status\nhello,no"), /column/)
assert.throws(() => parseTaskFile("list.json", "{}"), /array/)
assert.throws(() => parseTaskFile("list.md", "# Just a heading"), /No tasks/)
assert.throws(() => parseTaskFile("list.json", JSON.stringify(Array.from({ length: 1001 }, () => ({ text: "too many" })))), /1000/)
assert.throws(() => parseTaskFile("list.txt", "x".repeat(1_000_001)), /1 MB/)

const maliciousTitle = "Calm, focused; ☕ ".repeat(15) + "\nEND:VEVENT\nBEGIN:VEVENT"
const ics = calendarFile(maliciousTitle, new Date("2026-09-26T15:30:00-07:00"), 25)
assert.match(ics, /DTSTART:20260926T223000Z/)
assert.match(ics, /DTEND:20260926T225500Z/)
assert.equal(ics.split("\r\n").filter((line) => line === "BEGIN:VEVENT").length, 1)
assert.equal(ics.split("\r\n").filter((line) => line === "END:VEVENT").length, 1)
for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line, "utf8") <= 75)
const unfolded = ics.replace(/\r\n /g, "")
assert.ok(unfolded.includes("Calm\\, focused\\; ☕"))
assert.ok(unfolded.includes("\\nEND:VEVENT\\nBEGIN:VEVENT"))
assert.throws(() => calendarFile("focus", new Date("invalid"), 25), /start time/)
assert.throws(() => calendarFile("focus", new Date(), 0), /duration/)
console.log("PASS task transfer roundtrips, malformed-file limits, CSV formula protection, and timezone-safe escaped calendar export")
