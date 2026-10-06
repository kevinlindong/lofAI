// The saved desk, v3 (lib/board-storage.ts): the parser never throws and tells
// empty, unreadable and future saves apart; v3 repairs; v1 and v2 saves migrate
// (membership and sizes survive, every old layout and auto-pin goes, so the v3
// defaults take over); the committed plans fold back into the save.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const modules = new Map()
function loadModule(name) {
  name = name.replace(/^\.\//, "")
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const exports = {}
  modules.set(name, exports)
  // wrapped in a function: in a vm, names at a script's top level are slow to read
  vm.runInNewContext(`(function (exports, require) {${compiled}\n})`, {}, { filename: `lib/${name}.ts` })(exports, loadModule)
  return exports
}

const {
  BOARD_KEY, BROKEN_KEY, V1_BACKUP_KEY, V2_BACKUP_KEY, BOARD_VERSION, BOARD_MIGRATIONS, backupKeyFor,
  parseBoard, serializeBoard, defaultSave, knownTypes, arrangementOf, withArrangement,
} = loadModule("./board-storage")
const { layoutOf, planDrop, planPin, planPutAway, planTakeOut, planTidy, MAX_ROW } = loadModule("./board")
const { DEFAULT_ORDER, DEFAULT_ON_DESK, DEFAULT_SIZES, DEFAULT_AT } = loadModule("./board-defaults")

// the module lives in its own realm, so compare what storage would hold
const plain = (v) => JSON.parse(JSON.stringify(v))
const deep = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message)
const slots = (items) => Object.fromEntries(Array.from(items, (it) => [it.id, [it.x, it.y]]))
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
const pick = (rand, list) => list[int(rand, 0, list.length - 1)]
const deepFreeze = (v) => { if (v && typeof v === "object") { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]) } return v }

// the registry as the Desk stage has it: the eight widgets (their sizes small
// to large), plus a multi-instance type to check the instance cap
const sizes = (...ids) => ids.map((id) => ({ id, label: id }))
const SPECS = {
  radio: { type: "radio", sizes: sizes("m", "l", "w", "xl"), defaultSize: "xl", maxInstances: 1 },
  tasks: { type: "tasks", sizes: sizes("m", "l"), defaultSize: "l", maxInstances: 1 },
  timer: { type: "timer", sizes: sizes("s", "m"), defaultSize: "m", maxInstances: 1 },
  cat: { type: "cat", sizes: sizes("s", "m", "l"), defaultSize: "m", maxInstances: 1 },
  "desk-task": { type: "desk-task", sizes: sizes("s", "m"), defaultSize: "m", maxInstances: 1 },
  notebook: { type: "notebook", sizes: sizes("m", "l"), defaultSize: "m", maxInstances: 1 },
  clock: { type: "clock", sizes: sizes("s", "m"), defaultSize: "s", maxInstances: 1 },
  today: { type: "today", sizes: sizes("m"), defaultSize: "m", maxInstances: 1 },
  note: { type: "note", sizes: sizes("s", "m"), defaultSize: "s", maxInstances: 2 },
}
const KNOWN = knownTypes(SPECS)
const STATUSES = ["empty", "ok", "repaired", "unreadable", "future"]

const valid = () => ({
  v: 3,
  instances: {
    radio: { type: "radio", onDesk: true },
    tasks: { type: "tasks", onDesk: true },
    timer: { type: "timer", onDesk: false },
    cat: { type: "cat", onDesk: true },
    "desk-task": { type: "desk-task", onDesk: false },
    notebook: { type: "notebook", onDesk: true },
    clock: { type: "clock", onDesk: false },
    today: { type: "today", onDesk: false },
    "note-0a1b2c3d": { type: "note", onDesk: true },
  },
  order: ["tasks", "radio", "timer", "cat", "notebook", "note-0a1b2c3d", "desk-task", "clock", "today"],
  sizes: { tasks: "m", radio: "l", timer: "s", cat: "m", notebook: "l", "note-0a1b2c3d": "s", "desk-task": "m", clock: "m", today: "m" },
  layouts: {
    // the clock is in the drawer and keeps the spot it comes back to
    desk: { at: { tasks: { x: 0, y: 0 }, radio: { x: 2, y: 0 }, cat: { x: 5, y: 3 }, notebook: { x: 0, y: 2 }, "note-0a1b2c3d": { x: 4, y: 2 }, clock: { x: 0, y: 4 } }, pins: ["cat"] },
    phone: { at: { notebook: { x: 0, y: 2 } }, pins: ["notebook"] },
  },
  emptyByChoice: false,
  hints: { drawerOpened: true, welcomed: true, deskTaskPlaced: true },
  savedAt: 1790000000000,
})
const parse = (value, known = KNOWN) => parseBoard(typeof value === "string" || value === null ? value : JSON.stringify(value), known)
const edited = (edit) => { const save = valid(); edit(save); return save }
// a parsed save's invariants, whatever came in
function wellFormed(save, known = KNOWN, message = "") {
  const ids = Object.keys(save.instances)
  assert.equal(save.v, 3, message)
  deep([...save.order].sort(), [...ids].sort(), `${message}: every instance in the order, once`)
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]{1,40}$/, message)
    const spec = known[save.instances[id].type]
    if (spec) assert.ok(spec.sizes.includes(save.sizes[id]), `${message}: ${id} has one of its sizes`)
    else if (id in save.sizes) assert.ok(["s", "m", "l", "w", "xl"].includes(save.sizes[id]), message)
  }
  for (const id of Object.keys(save.sizes)) assert.ok(ids.includes(id), message)
  for (const bucket of Object.keys(save.layouts)) {
    assert.ok(["desk", "compact", "phone"].includes(bucket), message)
    const layout = save.layouts[bucket]
    deep(Object.keys(layout).sort(), ["at", "pins"], message)
    for (const id of Object.keys(layout.at)) {
      const p = layout.at[id]
      assert.ok(ids.includes(id), message)
      assert.ok(Number.isInteger(p.x) && p.x >= 0 && p.x <= 5 && Number.isInteger(p.y) && p.y >= 0 && p.y <= MAX_ROW, `${message}: ${JSON.stringify(p)}`)
      deep(Object.keys(p), ["x", "y"], message)
    }
    assert.ok(Array.isArray(layout.pins), message)
    for (const id of layout.pins) assert.ok(ids.includes(id), `${message}: a pin on a stranger`)
    deep(layout.pins, [...new Set(layout.pins)], `${message}: no duplicate pins`)
  }
  assert.ok(Number.isFinite(save.savedAt), message)
}

assert.equal(BOARD_KEY, "lofai.board")
assert.equal(BROKEN_KEY, "lofai.board.broken")
assert.equal(V1_BACKUP_KEY, "lofai.board.v1")
assert.equal(V2_BACKUP_KEY, "lofai.board.v2")
assert.equal(BOARD_VERSION, 3)
assert.equal(backupKeyFor(1), "lofai.board.v1")
assert.equal(backupKeyFor(2), "lofai.board.v2")
assert.equal(backupKeyFor(3), null)
deep(KNOWN.radio, { sizes: ["m", "l", "w", "xl"], defaultSize: "xl", maxInstances: 1 })
// the only saved keys this module ever names (SPEC2 §9.3.5: everything else is
// another feature's and is never touched)
{
  const source = readFileSync(new URL("../lib/board-storage.ts", import.meta.url), "utf8")
  const named = [...new Set(source.match(/"lofai\.[a-z0-9.-]+"/g) ?? [])].sort()
  deep(named, ['"lofai.board"', '"lofai.board.broken"', '"lofai.board.future"', '"lofai.board.v1"', '"lofai.board.v2"'], "no other key is named")
}

// valid input comes back as it went in
{
  const { save, status, migratedFrom } = parse(valid())
  assert.equal(status, "ok")
  assert.equal(migratedFrom, null, "no migration at v3")
  deep(save, valid())
  wellFormed(save)
}
console.log("PASS a valid v3 board reads back unchanged")

// nothing saved, and saves that can't be read
{
  deep(parse(null), { save: null, status: "empty", migratedFrom: null })
  for (const raw of ["{", "[]", "", "null", "42", '"board"', "true", "[1, 2]", '{"v": 3}', '{"v": 3, "instances": []}', '{"v": 1}', '{"v": 1, "instances": 3}']) {
    deep(parse(raw), { save: null, status: "unreadable", migratedFrom: null }, raw)
  }
  for (const v of [0, -1, 1.5, "3", null, true]) deep(parse({ ...valid(), v }), { save: null, status: "unreadable", migratedFrom: null }, `v: ${v}`)
  deep(parse(edited((save) => { delete save.v })), { save: null, status: "unreadable", migratedFrom: null })
  deep(parse({ ...valid(), v: 4 }), { save: null, status: "future", migratedFrom: null })
  deep(parse({ v: 99, anything: "at all" }), { save: null, status: "future", migratedFrom: null })
}
console.log("PASS empty, unreadable and future saves are told apart")

// v3 repairs
{
  // an unknown type is kept but never arranged
  const aquarium = parse(edited((save) => {
    save.instances.aquarium = { type: "aquarium", onDesk: true }
    save.order.splice(1, 0, "aquarium")
    save.sizes.aquarium = "xl"
    save.layouts.desk.at.aquarium = { x: 0, y: 9 }
    save.layouts.desk.pins.push("aquarium")
  }))
  assert.equal(aquarium.status, "ok")
  deep(aquarium.save.instances.aquarium, { type: "aquarium", onDesk: true })
  assert.equal(aquarium.save.sizes.aquarium, "xl")
  deep(aquarium.save.layouts.desk.at.aquarium, { x: 0, y: 9 })
  const a = arrangementOf(aquarium.save, "desk", KNOWN)
  assert.ok(!a.order.includes("aquarium") && !("aquarium" in a.sizes) && !("aquarium" in a.pins), "not rendered")
  // an unknown type's size is a standard one or nothing
  const tank = parse(edited((save) => { save.instances.aquarium = { type: "aquarium", onDesk: false }; save.order.push("aquarium"); save.sizes.aquarium = "tank" }))
  assert.equal(tank.status, "repaired"); assert.ok(!("aquarium" in tank.save.sizes))
  const bare = parse(edited((save) => { save.instances.aquarium = { type: "aquarium", onDesk: false }; save.order.push("aquarium") }))
  assert.equal(bare.status, "ok", "no size for an unknown type is fine")
  // a duplicate singleton, a bad id, a bad entry, a capped multi-instance type
  const dupes = parse(edited((save) => {
    save.instances["radio-2"] = { type: "radio", onDesk: true }
    save.instances["Bad Id"] = { type: "tasks", onDesk: true }
    save.instances.broken = "nope"
    save.instances["note-1"] = { type: "note", onDesk: true }
    save.instances["note-2"] = { type: "note", onDesk: false }
    save.order.push("radio-2", "Bad Id", "broken", "note-1", "note-2")
  }))
  assert.equal(dupes.status, "repaired")
  deep(Object.keys(dupes.save.instances).sort(), [...Object.keys(valid().instances), "note-1"].sort(), "a second radio, a bad id, junk and a third note go")
  wellFormed(dupes.save)
  // onDesk that isn't a boolean, extra keys
  const loose = parse(edited((save) => { save.instances.tasks = { type: "tasks", onDesk: "yes" }; save.instances.cat.extra = 1 }))
  assert.equal(loose.status, "repaired")
  assert.equal(loose.save.instances.tasks.onDesk, false)
  deep(loose.save.instances.cat, { type: "cat", onDesk: true })
  // a size it doesn't have: its default
  for (const size of ["xxl", "huge", 3, null]) {
    const r = parse(edited((save) => { save.sizes.tasks = size }))
    assert.equal(r.status, "repaired", String(size)); assert.equal(r.save.sizes.tasks, "l")
  }
  assert.equal(parse(edited((save) => { save.sizes.radio = "w" })).status, "ok", "the wide radio is one of its sizes")
  const noSize = parse(edited((save) => { delete save.sizes.timer }))
  assert.equal(noSize.status, "repaired"); assert.equal(noSize.save.sizes.timer, "m")
  const noSizes = parse(edited((save) => { delete save.sizes }))
  assert.equal(noSizes.status, "repaired"); assert.equal(noSizes.save.sizes.radio, "xl")
  const ghostSize = parse(edited((save) => { save.sizes.ghost = "s" }))
  assert.equal(ghostSize.status, "repaired"); assert.ok(!("ghost" in ghostSize.save.sizes))
  // bad spots: not numbers, off the board, rounded, unknown buckets and ids
  const spots = parse(edited((save) => {
    save.layouts.desk.at = { cat: { x: "3", y: 1 }, notebook: { x: -3, y: 9999 }, tasks: { x: 2.6, y: 1.2 }, ghost: { x: 0, y: 0 }, radio: null, clock: { x: 9, y: 0, z: 1 } }
    save.layouts.stack = { at: {}, pins: [] }
    save.layouts.compact = "nope"
  }))
  assert.equal(spots.status, "repaired")
  deep(spots.save.layouts, {
    desk: { at: { tasks: { x: 3, y: 1 }, notebook: { x: 0, y: 200 }, clock: { x: 5, y: 0 } }, pins: ["cat"] },
    phone: { at: { notebook: { x: 0, y: 2 } }, pins: ["notebook"] },
  }, "the readable spots are kept, the rest go")
  wellFormed(spots.save)
  // bad pins
  const pins = parse(edited((save) => { save.layouts.desk.pins = ["cat", "cat", "ghost", 7, "radio"] }))
  assert.equal(pins.status, "repaired")
  deep(pins.save.layouts.desk.pins, ["radio", "cat"], "deduped, strangers dropped, in reading-order memory")
  const notAList = parse(edited((save) => { save.layouts.desk.pins = { cat: true } }))
  assert.equal(notAList.status, "repaired"); deep(notAList.save.layouts.desk.pins, [])
  const noAt = parse(edited((save) => { delete save.layouts.desk.at }))
  assert.equal(noAt.status, "repaired"); deep(noAt.save.layouts.desk, { at: {}, pins: ["cat"] })
  const extraKey = parse(edited((save) => { save.layouts.desk.scroll = 3 }))
  assert.equal(extraKey.status, "repaired"); deep(Object.keys(extraKey.save.layouts.desk).sort(), ["at", "pins"])
  const noLayouts = parse(edited((save) => { delete save.layouts }))
  assert.equal(noLayouts.status, "repaired"); deep(noLayouts.save.layouts, {})
  // overlapping spots are left for layoutOf at render (it repairs deterministically)
  const overlap = parse(edited((save) => { save.layouts.desk.at = { cat: { x: 0, y: 0 }, notebook: { x: 0, y: 0 } } }))
  assert.equal(overlap.status, "ok")
  // order: first occurrence wins; strangers dropped; the missing appended, the desk's first, registry order
  const order = parse(edited((save) => { save.order = ["cat", "cat", "ghost", 7, "radio", "today"] }))
  assert.equal(order.status, "repaired")
  deep(order.save.order, ["cat", "radio", "today", "tasks", "notebook", "note-0a1b2c3d", "timer", "desk-task", "clock"])
  const noOrder = parse(edited((save) => { delete save.order }))
  assert.equal(noOrder.status, "repaired")
  deep(noOrder.save.order, ["radio", "tasks", "cat", "notebook", "note-0a1b2c3d", "timer", "desk-task", "clock", "today"])
  // hints, emptyByChoice, savedAt, unknown top-level keys
  const odd = parse(edited((save) => { save.hints = { welcomed: true, drawerOpened: "yes", confetti: true }; save.emptyByChoice = "no"; save.savedAt = "soon"; save.extra = 1 }))
  assert.equal(odd.status, "repaired")
  deep(odd.save.hints, { welcomed: true }); assert.equal(odd.save.emptyByChoice, undefined); assert.equal(odd.save.savedAt, 0)
  const junkHints = parse(edited((save) => { save.hints = [true] }))
  assert.equal(junkHints.status, "repaired"); assert.equal(junkHints.save.hints, undefined)
  // ids that would find Object.prototype
  const proto = parse('{"v":3,"instances":{"constructor":{"type":"radio","onDesk":true},"__proto__":{"type":"tasks","onDesk":true}},"order":["constructor"],"sizes":{},"layouts":{},"savedAt":1}')
  assert.equal(proto.status, "repaired")
  deep(proto.save.instances, {})
}
console.log("PASS v3 repairs: unknown types kept, singletons, ids, sizes, spots, pins, order, hints")

// the v1 saves, written by hand in the v1 format
const V1_DEFAULT = () => ({
  v: 1,
  instances: {
    radio: { type: "radio", onDesk: true }, sound: { type: "sound", onDesk: true }, tasks: { type: "tasks", onDesk: true },
    timer: { type: "timer", onDesk: true }, cat: { type: "cat", onDesk: true }, "desk-task": { type: "desk-task", onDesk: false },
    notebook: { type: "notebook", onDesk: false }, clock: { type: "clock", onDesk: false }, today: { type: "today", onDesk: false },
  },
  layouts: {},
  savedAt: 1789000000000,
})
// dragged about at 1440, a different compact desk, the notebook out, the clock put away
const V1_REARRANGED = () => ({
  v: 1,
  instances: {
    radio: { type: "radio", onDesk: true }, sound: { type: "sound", onDesk: true }, tasks: { type: "tasks", onDesk: true },
    timer: { type: "timer", onDesk: true }, cat: { type: "cat", onDesk: true }, "desk-task": { type: "desk-task", onDesk: false },
    notebook: { type: "notebook", onDesk: true }, clock: { type: "clock", onDesk: false }, today: { type: "today", onDesk: false },
  },
  layouts: {
    desk: { items: [
      { id: "tasks", size: "l", x: 1, y: 0, h: 14 },
      { id: "radio", size: "m", x: 8, y: 0, h: 12 },
      { id: "sound", size: "m", x: 12, y: 0, h: 15 },
      { id: "cat", size: "s", x: 8, y: 12, h: 7 },
      { id: "notebook", size: "page", x: 1, y: 14, h: 10 },
      { id: "timer", size: "s", x: 12, y: 15, h: 6 },
    ] },
    compact: { items: [
      { id: "radio", size: "mini", x: 0, y: 0, h: 4 },
      { id: "timer", size: "m", x: 4, y: 0 },
    ] },
  },
  stack: { order: ["radio", "cat", "timer", "tasks", "sound", "notebook"] },
  remembered: { desk: { clock: { size: "day", x: 1, y: 30, h: 7 } }, compact: { today: { size: "m", x: 0, y: 9 } } },
  emptyByChoice: false,
  hints: { drawerOpened: true, welcomed: true, deskTaskPlaced: true },
  savedAt: 1789500000000,
})
const migrated = (old, from = 1) => {
  const r = parse(old)
  assert.ok(r.save, JSON.stringify(r))
  assert.equal(r.migratedFrom, from)
  wellFormed(r.save)
  return r
}

{
  // the v1 usual desk becomes the v3 usual desk
  const def = migrated(V1_DEFAULT())
  assert.equal(def.status, "ok")
  deep(def.save, { ...defaultSave(1789000000000) }, "the same as a fresh v3 desk")
  deep(slots(layoutOf(arrangementOf(def.save, "desk", KNOWN), 6)), { radio: [0, 0], cat: [4, 0], tasks: [4, 1], timer: [4, 3] }, "the old composition")

  // a rearranged desk: the order is its reading order, Sound read as Radio
  const re = migrated(V1_REARRANGED())
  assert.equal(re.status, "ok")
  deep(re.save.order, ["tasks", "radio", "cat", "notebook", "timer", "desk-task", "clock", "today"])
  deep(re.save.sizes, { tasks: "l", radio: "xl", cat: "s", notebook: "l", timer: "s", "desk-task": "m", clock: "m", today: "m" },
    "the radio is the full card, notebook page → l, cat s, timer s, the clock's remembered day → m")
  assert.ok(!("sound" in re.save.instances))
  assert.equal(re.save.instances.radio.onDesk, true)
  deep(re.save.layouts, {}, "no layouts: the v3 defaults take over")
  deep(re.save.hints, { drawerOpened: true, welcomed: true, deskTaskPlaced: true })
  assert.equal(re.save.emptyByChoice, false)
  assert.equal(re.save.savedAt, 1789500000000)
  for (const key of ["stack", "remembered", "pins"]) assert.ok(!(key in re.save), `${key} is gone`)
  // the compact layout when the desk has none
  const compactOnly = migrated({ ...V1_REARRANGED(), layouts: { compact: V1_REARRANGED().layouts.compact } })
  deep(compactOnly.save.order.slice(0, 2), ["radio", "timer"])
  assert.equal(compactOnly.save.sizes.timer, "m")

  // Sound out and Radio away: Radio comes out, as the full card
  const soundOut = V1_DEFAULT()
  soundOut.instances.radio.onDesk = false
  soundOut.layouts = { desk: { items: [{ id: "sound", size: "l", x: 7, y: 0, h: 15 }, { id: "tasks", size: "m", x: 1, y: 0 }] } }
  soundOut.remembered = { desk: { radio: { size: "mini", x: 0, y: 0 } } }
  const so = migrated(soundOut)
  assert.equal(so.save.instances.radio.onDesk, true)
  assert.equal(so.save.sizes.radio, "xl")
  deep(so.save.order.slice(0, 2), ["tasks", "radio"], "Radio takes Sound's place in the reading order")

  // whatever ring the v1 radio had, it comes back as the full card
  for (const was of ["m", "l", "mini", "weird"]) {
    const away = V1_DEFAULT()
    away.instances.sound.onDesk = false
    away.layouts = { desk: { items: [{ id: "radio", size: was, x: 2, y: 0 }, { id: "tasks", size: "s", x: 7, y: 0 }] } }
    const r = migrated(away)
    assert.equal(r.save.instances.radio.onDesk, true)
    assert.equal(r.save.sizes.radio, "xl", `radio ${was}`)
  }
  // both in the drawer: Radio stays away, still the full card
  const bothAway = V1_DEFAULT()
  bothAway.instances.sound.onDesk = false
  bothAway.instances.radio.onDesk = false
  bothAway.remembered = { compact: { radio: { size: "m", x: 0, y: 0 } } }
  const ba = migrated(bothAway)
  assert.equal(ba.save.instances.radio.onDesk, false); assert.equal(ba.save.sizes.radio, "xl")
  // no Radio at all: Sound's instance becomes it
  const noRadio = V1_DEFAULT()
  delete noRadio.instances.radio
  const nr = migrated(noRadio)
  deep(nr.save.instances.radio, { type: "radio", onDesk: true })
  assert.equal(nr.save.sizes.radio, "xl")
  const noRadioAway = V1_DEFAULT()
  delete noRadioAway.instances.radio
  noRadioAway.instances.sound.onDesk = false
  deep(migrated(noRadioAway).save.instances.radio, { type: "radio", onDesk: false })
  // no Sound at all: Radio is the full card all the same
  const noSound = V1_DEFAULT()
  delete noSound.instances.sound
  noSound.layouts = { desk: { items: [{ id: "radio", size: "mini", x: 2, y: 0 }] } }
  assert.equal(migrated(noSound).save.sizes.radio, "xl")

  // stack-only (last seen on a phone)
  const stack = V1_DEFAULT()
  stack.stack = { order: ["radio", "cat", "timer", "tasks", "sound", "ghost", 4] }
  const st = migrated(stack)
  deep(st.save.order, ["radio", "cat", "timer", "tasks", "desk-task", "notebook", "clock", "today"])

  // every row of the size table
  const table = [
    ["tasks", "s", "l"], ["tasks", "m", "l"], ["tasks", "l", "l"], ["tasks", "huge", "l"],
    ["timer", "s", "s"], ["timer", "m", "m"], ["timer", "l", "m"],
    ["cat", "s", "s"], ["cat", "m", "m"], ["cat", "l", "l"],
    ["desk-task", "s", "s"], ["desk-task", "m", "m"],
    ["notebook", "pocket", "m"], ["notebook", "page", "l"], ["notebook", "m", "m"],
    ["clock", "time", "s"], ["clock", "day", "m"], ["clock", "s", "s"],
    ["today", "m", "m"], ["today", "l", "m"],
  ]
  for (const [type, was, now] of table) {
    for (const where of ["desk", "compact", "remembered.desk", "remembered.compact"]) {
      const save = V1_DEFAULT()
      save.instances[type].onDesk = !where.startsWith("remembered")
      if (where.startsWith("remembered")) save.remembered = { [where.split(".")[1]]: { [type]: { size: was, x: 0, y: 0 } } }
      else save.layouts = { [where]: { items: [{ id: type, size: was, x: 0, y: 0 }] } }
      assert.equal(migrated(save).save.sizes[type], now, `${type} ${was} from ${where}`)
    }
  }
  // the desk's size wins over compact's, and both over a remembered one
  const both = V1_DEFAULT()
  both.layouts = { desk: { items: [{ id: "cat", size: "l", x: 0, y: 0 }] }, compact: { items: [{ id: "cat", size: "s", x: 0, y: 0 }] } }
  both.remembered = { desk: { cat: { size: "m", x: 0, y: 0 } } }
  assert.equal(migrated(both).save.sizes.cat, "l")

  // unknown v1 types survive (and keep their place in the order)
  const unknown = V1_REARRANGED()
  unknown.instances.aquarium = { type: "aquarium", onDesk: true }
  unknown.layouts.desk.items.push({ id: "aquarium", size: "tank", x: 16, y: 0, h: 8 })
  const un = migrated(unknown)
  deep(un.save.instances.aquarium, { type: "aquarium", onDesk: true })
  deep(un.save.order.slice(0, 3), ["tasks", "radio", "aquarium"])
  assert.ok(!("aquarium" in un.save.sizes))
  assert.ok(!arrangementOf(un.save, "desk", KNOWN).order.includes("aquarium"))

  // pure: the input never changes (frozen, so a write would throw)
  for (const old of [V1_DEFAULT(), V1_REARRANGED(), unknown, stack, soundOut]) {
    const before = JSON.stringify(old)
    BOARD_MIGRATIONS[1](deepFreeze(old))
    assert.equal(JSON.stringify(old), before)
  }
  // and never throws on garbage inside a v1 object
  const garbage = [
    { v: 1, instances: { radio: null, sound: 7, "Bad Id": { type: "tasks" }, tasks: { type: 3, onDesk: 1 } }, layouts: 5 },
    { v: 1, instances: {}, layouts: { desk: "x", compact: { items: "y" } }, stack: { order: "z" }, remembered: [] },
    { v: 1, instances: { radio: { type: "radio", onDesk: true } }, layouts: { desk: { items: [null, 3, { id: 5 }, { id: "radio", x: "a", y: {} }, { id: "radio" }] } }, remembered: { desk: { radio: 4 }, compact: null } },
    { v: 1, instances: { sound: { type: "sound" }, radio: { type: "tasks", onDesk: true } }, hints: "x", emptyByChoice: 4, savedAt: "later" },
    { v: 1, instances: { sound: { type: "sound", onDesk: true }, radio: "junk" } },
    { v: 1, instances: [] }, { v: 1, instances: null }, { v: 1 }, [], null, 3, "v1",
    { v: 1, instances: { a: { type: "radio", onDesk: true } }, layouts: { desk: { items: [{ id: "a", size: {}, x: Infinity, y: -Infinity }] } } },
  ]
  for (const g of garbage) {
    assert.doesNotThrow(() => BOARD_MIGRATIONS[1](g), JSON.stringify(g))
    const r = parse(JSON.stringify(g))
    assert.ok(STATUSES.includes(r.status), JSON.stringify(g))
    if (r.save) wellFormed(r.save, KNOWN, JSON.stringify(g))
  }
  const soundOnly = parse(garbage[4])
  deep(soundOnly.save.instances, { radio: { type: "radio", onDesk: true } }, "a junk radio gives way to Sound's")
}
console.log("PASS v1 → v3: the usual desk, a rearranged desk, Sound out or away, stack-only, every size, unknown types, pure, garbage")

// a v2 save, written by hand in the v2 format (a flow order and the auto-pins)
const V2_SAVE = () => ({
  v: 2,
  instances: {
    radio: { type: "radio", onDesk: true }, tasks: { type: "tasks", onDesk: true }, timer: { type: "timer", onDesk: true },
    cat: { type: "cat", onDesk: true }, notebook: { type: "notebook", onDesk: false }, clock: { type: "clock", onDesk: false },
    "desk-task": { type: "desk-task", onDesk: false }, today: { type: "today", onDesk: false },
  },
  order: ["tasks", "radio", "timer", "cat", "notebook", "desk-task", "clock", "today"],
  sizes: { tasks: "l", radio: "xl", timer: "s", cat: "l", notebook: "m", "desk-task": "m", clock: "s", today: "m" },
  pins: { desk: { cat: { x: 4, y: 2 } }, compact: { radio: { x: 0, y: 0 } } },
  emptyByChoice: false,
  hints: { drawerOpened: true, pinExplained: true },
  savedAt: 1791000000000,
})

{
  const r = migrated(V2_SAVE(), 2)
  assert.equal(r.status, "ok")
  deep(r.save.instances, V2_SAVE().instances, "membership survives")
  deep(r.save.order, V2_SAVE().order, "so does the order")
  deep(r.save.sizes, V2_SAVE().sizes, "and the sizes that are still valid (the radio's xl is the full card now)")
  deep(r.save.layouts, {}, "every v2 layout and auto-pin goes")
  assert.ok(!("pins" in r.save), "the v2 pins key is gone")
  deep(r.save.hints, { drawerOpened: true }, "the hint behind v2's \"Pinned it there\" note goes with the auto-pins")
  assert.equal(r.save.emptyByChoice, false)
  assert.equal(r.save.savedAt, 1791000000000)
  // a v3 save that still carries it: the retired hint is dropped as a repair
  const old = parse(edited((save) => { save.hints.pinExplained = true }))
  assert.equal(old.status, "repaired")
  deep(old.save.hints, valid().hints)
  // so the desk comes back as the usual composition, with nothing pinned
  const a = arrangementOf(r.save, "desk", KNOWN)
  deep(a.pins, {}, "nothing is pinned any more")
  // (the big cat doesn't fit its spot, so it flows under the radio, and the
  // column it left closes up)
  deep(slots(layoutOf(a, 6)), { radio: [0, 0], tasks: [4, 0], timer: [4, 2], cat: [0, 4] }, "the defaults, around the sizes it had")
  // a v2 size this build dropped falls back to the type's default
  const odd = V2_SAVE()
  odd.sizes.tasks = "s"
  const fixed = parse(odd)
  assert.equal(fixed.status, "repaired"); assert.equal(fixed.save.sizes.tasks, "l")
  // unknown types survive a v2 save too
  const fish = V2_SAVE()
  fish.instances.aquarium = { type: "aquarium", onDesk: true }
  fish.order.push("aquarium")
  fish.sizes.aquarium = "xl"
  const withFish = migrated(fish, 2)
  deep(withFish.save.instances.aquarium, { type: "aquarium", onDesk: true })
  assert.equal(withFish.save.sizes.aquarium, "xl")
  // pure, and never throws on garbage inside a v2 object
  const before = JSON.stringify(V2_SAVE())
  BOARD_MIGRATIONS[2](deepFreeze(V2_SAVE()))
  assert.equal(JSON.stringify(V2_SAVE()), before)
  const garbage = [
    { v: 2, instances: null }, { v: 2, instances: [] }, { v: 2 }, { v: 2, instances: { radio: 7 }, order: "x", sizes: 3, pins: [] },
    { v: 2, instances: { radio: { type: "radio", onDesk: true } }, order: [null, 5], sizes: { radio: {} }, pins: { desk: 1 } },
  ]
  for (const g of garbage) {
    assert.doesNotThrow(() => BOARD_MIGRATIONS[2](g), JSON.stringify(g))
    const parsed = parse(JSON.stringify(g))
    assert.ok(STATUSES.includes(parsed.status), JSON.stringify(g))
    if (parsed.save) wellFormed(parsed.save, KNOWN, JSON.stringify(g))
  }
}
console.log("PASS v2 → v3: membership and sizes kept, every flow layout and auto-pin dropped, pure, garbage")

// serializing: a fixpoint on valid saves, fixed key order
{
  const raw = serializeBoard(parse(valid()).save)
  assert.equal(serializeBoard(parse(raw).save), raw)
  deep(parse(raw).save, valid())
  deep(Object.keys(JSON.parse(raw)), ["v", "instances", "order", "sizes", "layouts", "emptyByChoice", "hints", "savedAt"])
  deep(Object.keys(JSON.parse(raw).layouts.desk), ["at", "pins"])
  // the same save written in another key order serializes the same
  const shuffled = valid()
  shuffled.sizes = Object.fromEntries(Object.entries(shuffled.sizes).reverse())
  shuffled.layouts = {
    phone: shuffled.layouts.phone,
    desk: { pins: ["cat"], at: Object.fromEntries(Object.entries(shuffled.layouts.desk.at).reverse()) },
  }
  shuffled.hints = { deskTaskPlaced: true, welcomed: true, drawerOpened: true }
  assert.equal(serializeBoard(parse(shuffled).save), raw)
  // a migrated save settles too
  for (const old of [V1_REARRANGED(), V2_SAVE()]) {
    const save = parse(old).save
    const once = serializeBoard(save)
    const again = parse(once)
    assert.equal(again.status, "ok"); assert.equal(again.migratedFrom, null)
    assert.equal(serializeBoard(again.save), once)
  }
  // optional fields left out when absent
  const lean = serializeBoard(defaultSave(5))
  assert.ok(!lean.includes("hints") && !lean.includes("emptyByChoice"))
  assert.equal(parse(lean).status, "ok")
}
console.log("PASS serializeBoard ∘ parseBoard is a fixpoint, keys in a fixed order")

// 500 random mutations of valid v3, v1 and v2 saves: never throws, a sane
// status, a well-formed save
{
  const rand = prng(42)
  const junk = () => pick(rand, [null, true, false, 0, -1, 7.5, 9999, "", "m", "xl", "radio", [], [1, "a"], {}, { x: 1, y: 2 }, { type: "radio", onDesk: true }])
  const paths = (v, prefix = []) => {
    const out = [prefix]
    if (v && typeof v === "object") for (const k of Object.keys(v)) out.push(...paths(v[k], [...prefix, k]))
    return out
  }
  const mutate = (base) => {
    const save = structuredClone(base)
    for (let n = int(rand, 1, 4); n > 0; n--) {
      const all = paths(save).filter((p) => p.length)
      if (!all.length) break
      const path = pick(rand, all)
      let parent = save
      for (const k of path.slice(0, -1)) parent = parent[k]
      const key = path[path.length - 1]
      const r = rand()
      if (r < 0.3) { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key] }
      else if (r < 0.8) parent[key] = junk()
      else if (Array.isArray(parent)) parent.push(junk())
      else parent[`k${int(rand, 0, 9)}`] = junk()
    }
    return save
  }
  const seen = {}
  for (let n = 0; n < 500; n++) {
    const base = n % 5 === 4 ? V1_REARRANGED() : n % 5 === 3 ? V2_SAVE() : valid()
    const raw = JSON.stringify(mutate(base))
    let r
    assert.doesNotThrow(() => { r = parseBoard(raw, KNOWN) }, raw)
    assert.ok(STATUSES.includes(r.status), raw)
    seen[r.status] = (seen[r.status] ?? 0) + 1
    if (r.save) {
      assert.ok(r.status === "ok" || r.status === "repaired", raw)
      wellFormed(r.save, KNOWN, raw)
      const again = parse(serializeBoard(r.save))
      assert.equal(again.status, "ok", raw)
      deep(again.save, r.save, raw)
      // and whatever came in, the desk can be drawn from it
      for (const bucket of ["desk", "compact", "phone"]) {
        const a = arrangementOf(r.save, bucket, KNOWN)
        const cols = bucket === "desk" ? 6 : bucket === "compact" ? 4 : 2
        const items = layoutOf(a, cols)
        assert.equal(items.length, a.order.length, raw)
        for (const it of items) assert.ok(it.x >= 0 && it.x + it.w <= cols && it.y >= 0, raw)
      }
    } else {
      assert.ok(r.status === "unreadable" || r.status === "future", raw)
    }
    // cut short, anywhere
    const cut = raw.slice(0, int(rand, 0, raw.length))
    assert.doesNotThrow(() => parseBoard(cut, KNOWN))
  }
  assert.ok(seen.repaired > 100 && seen.ok > 0 && seen.unreadable > 0, JSON.stringify(seen))
  console.log(`PASS 500 random mutations: never throws, ${JSON.stringify(seen)}`)
}

// the save and the engine: arrangements out, plans back in
{
  const save = parse(valid()).save
  const a = arrangementOf(save, "desk", KNOWN)
  deep(a, {
    order: ["tasks", "radio", "cat", "notebook", "note-0a1b2c3d"],
    sizes: { tasks: "m", radio: "l", cat: "m", notebook: "l", "note-0a1b2c3d": "s" },
    // the clock is in the drawer and keeps the spot it comes back to
    at: { tasks: { x: 0, y: 0 }, radio: { x: 2, y: 0 }, cat: { x: 5, y: 3 }, notebook: { x: 0, y: 2 }, "note-0a1b2c3d": { x: 4, y: 2 }, clock: { x: 0, y: 4 } },
    pins: { cat: true },
  }, "the desk's widgets, their spots here and this bucket's pins")
  deep(slots(layoutOf(a, 6)), { tasks: [0, 0], radio: [2, 0], notebook: [0, 2], "note-0a1b2c3d": [4, 2], cat: [4, 3] }, "the cat's spot is clamped into the columns")
  // a bucket nobody has arranged takes its own default spots
  const compact = arrangementOf(save, "compact", KNOWN)
  deep(compact.pins, {}, "and nothing pinned")
  // (the radio on the left, the cat and Tasks down the right; the rest fill in under them)
  deep(compact.at, { radio: { x: 0, y: 0 }, cat: { x: 2, y: 0 }, tasks: { x: 2, y: 1 }, notebook: { x: 0, y: 2 }, "note-0a1b2c3d": { x: 2, y: 2 } }, "the usual spots, the rest in the first free ones, closed up")
  // a bucket that only names one widget: that one keeps its spot and its pin
  const phone = arrangementOf(save, "phone", KNOWN)
  deep(phone.pins, { notebook: true })
  const phoneItems = layoutOf(phone, 2)
  assert.equal(phoneItems.length, 5)
  deep(slots(phoneItems).notebook, [0, 2], "the pin keeps its spot")
  for (let i = 0; i < phoneItems.length; i++) {
    for (let j = i + 1; j < phoneItems.length; j++) {
      assert.ok(!(phoneItems[i].x < phoneItems[j].x + phoneItems[j].w && phoneItems[j].x < phoneItems[i].x + phoneItems[i].w &&
        phoneItems[i].y < phoneItems[j].y + phoneItems[j].h && phoneItems[j].y < phoneItems[i].y + phoneItems[i].h), "no overlaps")
    }
  }
  // a type this build doesn't know isn't arranged; a size it doesn't have falls back
  const fewer = knownTypes({ radio: SPECS.radio, tasks: { ...SPECS.tasks, sizes: sizes("l") }, cat: SPECS.cat })
  const thin = arrangementOf(save, "desk", fewer)
  deep(thin.order, ["tasks", "radio", "cat"])
  deep(thin.sizes, { tasks: "l", radio: "l", cat: "m" })
  deep(thin.pins, { cat: true })

  // the default save: no layouts at all, so every bucket starts from its own
  const fresh = defaultSave(123)
  deep(fresh.order, DEFAULT_ORDER)
  deep(Object.keys(fresh.instances).filter((id) => fresh.instances[id].onDesk), DEFAULT_ON_DESK)
  deep(fresh.sizes, DEFAULT_SIZES)
  deep(fresh.layouts, {}); assert.equal(fresh.savedAt, 123)
  const usual = arrangementOf(fresh, "desk", KNOWN)
  deep(usual, { order: ["radio", "tasks", "timer", "cat"], sizes: { radio: "xl", tasks: "l", timer: "m", cat: "m" }, at: DEFAULT_AT.desk, pins: {} })

  // a drag committed: this bucket's layout is written, no other
  const drop = planDrop(usual, "timer", { x: 0, y: 4 }, 6)
  const moved = withArrangement(fresh, "desk", drop.arrangement, KNOWN, 200)
  deep(moved.layouts, { desk: { at: { radio: { x: 0, y: 0 }, cat: { x: 4, y: 0 }, tasks: { x: 4, y: 1 }, timer: { x: 0, y: 4 } }, pins: [] } }, "only the desk")
  deep(moved.order, ["radio", "cat", "tasks", "timer", "desk-task", "notebook", "clock", "today"], "the reading-order memory keeps up")
  assert.equal(moved.savedAt, 200)
  deep(fresh.layouts, {}, "the input save is untouched")
  deep(slots(layoutOf(arrangementOf(moved, "desk", KNOWN), 6)), slots(drop.items), "what's saved draws what was shown")
  deep(arrangementOf(moved, "phone", KNOWN).at, DEFAULT_AT.phone, "the phone still starts from its own defaults")
  // arranging the desk never rewrites another bucket's layout
  const both = withArrangement(save, "desk", planDrop(a, "radio", { x: 2, y: 4 }, 6).arrangement, KNOWN, 210)
  deep(both.layouts.phone, valid().layouts.phone, "the phone's layout is exactly as it was")
  deep(both.layouts.desk.at.radio, { x: 2, y: 4 }, "the desk moved")
  deep(both.layouts.desk.pins, ["cat"], "and kept its pin")

  // the tack, committed
  const pin = withArrangement(moved, "desk", planPin(arrangementOf(moved, "desk", KNOWN), "timer", true, 6).arrangement, KNOWN, 250)
  deep(pin.layouts.desk.pins, ["timer"])
  deep(pin.layouts.desk.at, moved.layouts.desk.at, "pinning moves nothing")
  // put away: its spot and size stay for when it comes back, its pin does not
  const away = withArrangement(pin, "desk", planPutAway(arrangementOf(pin, "desk", KNOWN), "timer", 6).arrangement, KNOWN, 300)
  assert.equal(away.instances.timer.onDesk, false)
  assert.equal(away.sizes.timer, "m")
  deep(away.layouts.desk.at.timer, { x: 0, y: 4 }, "the spot is remembered")
  deep(away.layouts.desk.pins, [], "a widget in the drawer is not pinned")
  deep(away.order, pin.order, "and it keeps its place in the order")
  // take out: back to the remembered spot, since that spot is free
  const deskNow = arrangementOf(away, "desk", KNOWN)
  const back = planTakeOut(deskNow, "timer", away.sizes.timer, 6, { at: away.layouts.desk.at.timer, rows: 4 })
  deep(slots(back.items).timer, [0, 4], "right where it was")
  const out = withArrangement(away, "desk", back.arrangement, KNOWN, 400)
  assert.equal(out.instances.timer.onDesk, true)
  deep(out.layouts.desk.at, moved.layouts.desk.at, "the desk is as it was before the put-away")
  // tidy up keeps the pins (it is gravity, not a reset)
  const tidy = withArrangement(pin, "desk", planTidy(arrangementOf(pin, "desk", KNOWN), 6).arrangement, KNOWN, 500)
  deep(tidy.layouts.desk.pins, ["timer"], "the pin stays through a tidy")
  deep(tidy.layouts.desk.at.timer, { x: 0, y: 4 }, "and so does its spot")
  // unknown types keep their membership through a commit
  const withFish = parse(edited((s) => { s.instances.aquarium = { type: "aquarium", onDesk: true }; s.order.push("aquarium") })).save
  const kept = withArrangement(withFish, "desk", arrangementOf(withFish, "desk", KNOWN), KNOWN, 1)
  assert.equal(kept.instances.aquarium.onDesk, true)
  // a commit parses back as it went in
  assert.equal(parse(serializeBoard(out)).status, "ok")
  deep(parse(serializeBoard(out)).save, out)
}
console.log("PASS the save and the engine: arrangementOf per bucket, withArrangement (drag, pin, put away, take out, tidy)")
console.log("board-storage: ok")
