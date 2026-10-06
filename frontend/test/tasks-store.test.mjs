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

const { SERVICES, safeWebUrl } = loadModule("./integrations")
const { TASKS_KEY, DESK_TASK_KEY, restoreTasks, mergeImported, setDone, parseDeskTask, serializeDeskTask } = loadModule("./tasks-store")
// the module lives in its own realm, so compare what storage would hold
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message)
const counter = (prefix = "new") => { let n = 0; return () => `${prefix}-${++n}` }

// TodoList's restore and import, verbatim from before the move, as the reference
function oldRestoreSource(value) {
  if (!value || typeof value !== "object") return
  const source = value
  if (!SERVICES.some((s) => s.id === source.provider) || typeof source.source !== "string" || typeof source.id !== "string") return
  return { provider: source.provider, source: source.source, id: source.id, url: safeWebUrl(source.url), sync: source.sync === true }
}
function oldRestore(saved, newId) {
  let todos = []
  if (saved) {
    const parsed = JSON.parse(saved)
    if (Array.isArray(parsed)) {
      const seen = new Set()
      todos = parsed.flatMap((t) => {
        if (!t || typeof t.text !== "string") return []
        let id = typeof t.id === "string" ? t.id : newId()
        if (seen.has(id)) id = newId()
        seen.add(id)
        return [{ id, text: t.text, done: t.done === true || t.completed === true, source: oldRestoreSource(t.source) }]
      })
    } else throw new Error("The saved list has an unexpected shape")
  }
  return todos
}
function oldImport(previous, incoming, inflight) {
  const next = [...previous]
  for (const task of incoming) {
    const index = next.findIndex((old) => task.source
      ? old.source?.provider === task.source.provider && old.source.source === task.source.source && old.source.id === task.source.id
      : !old.source && old.text === task.text && old.done === task.done)
    if (index < 0) next.push(task)
    else if (task.source && !inflight.has(next[index].id)) next[index] = { ...task, id: next[index].id, done: task.source.sync ? task.done : next[index].done }
  }
  return next
}
function oldRestoreOrUnreadable(saved, newId) {
  try { return { tasks: oldRestore(saved, newId), readable: true } } catch { return { tasks: [], readable: false } }
}

assert.equal(TASKS_KEY, "todos")
assert.equal(DESK_TASK_KEY, "lofai.desk-task")

// legacy shapes
const legacy = restoreTasks('[{"text":"a","completed":true}]', counter())
assert.equal(legacy.readable, true)
same(legacy.tasks, [{ id: "new-1", text: "a", done: true }])
assert.deepEqual(Object.keys(legacy.tasks[0]), ["id", "text", "done", "source"], "the same keys as before, source left undefined")
const mixed = JSON.stringify([
  { id: "x", text: "one", done: false }, { id: "x", text: "dup" }, "str", null, 5, [], { text: 7 }, { id: 3, text: "numid" },
  { text: "src", source: { provider: "todoist", source: "p", id: "9", url: "javascript:alert(1)", sync: true } },
  { text: "src2", done: true, source: { provider: "github", source: "o/r", id: "12", url: "https://github.com/o/r/issues/12", sync: "yes" } },
  { text: "badsrc", source: { provider: "nope", source: "p", id: "9" } }, { id: "", text: "emptyid", completed: false, done: true },
  { id: "y", text: "extra keys", done: 1, completed: "true", colour: "red" },
])
const restored = restoreTasks(mixed, counter())
same(restored.tasks, oldRestore(mixed, counter()))
same(restored.tasks.map((t) => t.id), ["x", "new-1", "new-2", "new-3", "new-4", "new-5", "", "y"], "missing and duplicate ids get new ones")
assert.equal(restored.tasks[3].source.url, undefined, "unsafe links are dropped")
assert.equal(restored.tasks[4].source.sync, false, "only a literal true turns sync on")
assert.equal(restored.tasks[5].source, undefined, "unknown services are dropped")
assert.equal(restored.tasks[7].done, false, "only a literal true counts as done")
console.log("PASS legacy lists restore exactly as TodoList did: completed becomes done, ids repaired, junk dropped")

// unreadable data is reported, never guessed at
for (const raw of ["{", '{"a":1}', '"str"', "5", "null", "true", '{"tasks":[]}']) {
  const result = restoreTasks(raw, counter())
  assert.equal(result.readable, false, raw)
  assert.equal(result.tasks.length, 0, raw)
  assert.equal(oldRestoreOrUnreadable(raw, counter()).readable, false, `${raw} was unreadable before too`)
}
for (const raw of [null, "", "[]"]) {
  const result = restoreTasks(raw, counter())
  assert.equal(result.readable, true, String(raw))
  assert.equal(result.tasks.length, 0)
}
console.log("PASS an unreadable list reads as unreadable, and nothing saved reads as an empty list")

// random lists restore byte-for-byte like the old code
let seed = 7
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (list) => list[Math.floor(rand() * list.length)]
const randomSource = () => pick([undefined, null, "x", { provider: pick(["todoist", "linear", "nope", 4]), source: pick(["s", 1]), id: pick(["1", "2", 2]), url: pick([undefined, "https://a.b/c", "ftp://x", "not a url"]), sync: pick([true, false, "true"]) }])
const randomEntry = () => pick([null, 3, "s", [], {
  id: pick([undefined, "a", "b", "c", 1, ""]), text: pick(["t", "u", "", 0, undefined]),
  done: pick([undefined, true, false, "true"]), completed: pick([undefined, true, false]), source: randomSource(),
}])
for (let i = 0; i < 400; i++) {
  const raw = JSON.stringify(Array.from({ length: Math.floor(rand() * 12) }, randomEntry))
  same(restoreTasks(raw, counter()).tasks, oldRestore(raw, counter()), raw)
}
console.log("PASS 400 random legacy lists restore byte-for-byte like the previous build")

// doneAt is additive
const withDoneAt = restoreTasks(JSON.stringify([
  { id: "a", text: "done", done: true, doneAt: 1000 }, { id: "b", text: "open", done: false, doneAt: 1000 },
  { id: "c", text: "bad", done: true, doneAt: "yesterday" }, { id: "d", text: "legacy", completed: true, doneAt: 5 },
]), counter()).tasks
same(withDoneAt.map((t) => t.doneAt ?? null), [1000, null, null, 5])
assert.ok(!("doneAt" in withDoneAt[1]), "an open task carries no doneAt key")
same(restoreTasks(JSON.stringify(withDoneAt), counter()).tasks, withDoneAt, "a saved list reads back unchanged")
console.log("PASS doneAt survives a round trip, only on finished tasks")

// imports: the same matching rules as before
const local = [
  { id: "l1", text: "water the plant", done: false },
  { id: "l2", text: "water the plant", done: true, doneAt: 50 },
  { id: "s1", text: "old title", done: false, source: { provider: "todoist", source: "p", id: "9", sync: true } },
  { id: "s2", text: "copy", done: true, doneAt: 70, source: { provider: "linear", source: "team", id: "L-1", sync: false } },
  { id: "s3", text: "busy", done: false, source: { provider: "github", source: "o/r", id: "3", sync: true } },
  { id: "s4", text: "reopened", done: true, doneAt: 90, source: { provider: "asana", source: "w", id: "7", sync: true } },
]
const incoming = [
  { id: "i1", text: "water the plant", done: false },
  { id: "i2", text: "water the plant", done: false },
  { id: "i3", text: "new local", done: false },
  { id: "i4", text: "new title", done: true, source: { provider: "todoist", source: "p", id: "9", sync: true } },
  { id: "i5", text: "copy, renamed", done: false, source: { provider: "linear", source: "team", id: "L-1", sync: false } },
  { id: "i6", text: "busy, renamed", done: true, source: { provider: "github", source: "o/r", id: "3", sync: true } },
  { id: "i7", text: "reopened", done: false, source: { provider: "asana", source: "w", id: "7", sync: true } },
  { id: "i8", text: "brand new", done: false, source: { provider: "asana", source: "w", id: "8", sync: true } },
]
const inflight = new Set(["s3"])
const merged = mergeImported(local, incoming, inflight)
const strip = (tasks) => tasks.map(({ doneAt, ...task }) => task)
same(strip(merged), strip(oldImport(local, incoming, inflight)), "the same tasks, ignoring doneAt")
same(merged.map((t) => t.id), ["l1", "l2", "s1", "s2", "s3", "s4", "i3", "i8"])
same(merged[2], { id: "s1", text: "new title", done: true, source: incoming[3].source }, "a synced task takes the remote check")
same(merged[3], { id: "s2", text: "copy, renamed", done: true, source: incoming[4].source, doneAt: 70 }, "a local copy keeps its own check and doneAt")
assert.equal(merged[4], local[4], "a task mid-sync is left alone")
assert.ok(!("doneAt" in merged[5]) && merged[5].done === false, "reopened remotely, so no doneAt")
assert.equal(local.length, 6, "the previous list is not mutated")
assert.equal(local[2].text, "old title")
same(mergeImported([], [], new Set()), [])
console.log("PASS imports match as before (sources, local text, inflight, sync-only checks) and keep doneAt")

// setDone
const list = Object.freeze([{ id: "a", text: "a", done: false }, { id: "b", text: "b", done: true, doneAt: 3 }].map(Object.freeze))
const completed = setDone(list, "a", true, 1234)
same(completed[0], { id: "a", text: "a", done: true, doneAt: 1234 })
assert.equal(completed[1], list[1], "other tasks keep their identity")
const reopened = setDone(completed, "b", false, 99)
assert.ok(!("doneAt" in reopened[1]) && reopened[1].done === false)
same(setDone(list, "missing", true, 1), list)
console.log("PASS setDone stamps doneAt on completion and removes it on reopen, without mutating")

// the task on the desk
same(parseDeskTask(serializeDeskTask({ taskId: "abc", since: 42 })), { taskId: "abc", since: 42 })
same(JSON.parse(serializeDeskTask({ taskId: "abc", since: 42 })), { v: 1, taskId: "abc", since: 42 })
for (const raw of [null, "", "{", "[]", '{"v":2,"taskId":"a"}', '{"v":1,"taskId":""}', '{"v":1,"taskId":4}', '{"v":1}']) assert.equal(parseDeskTask(raw), null, String(raw))
same(parseDeskTask('{"v":1,"taskId":"a","since":"soon"}'), { taskId: "a", since: 0 })
console.log("PASS lofai.desk-task parses without throwing and round-trips")
