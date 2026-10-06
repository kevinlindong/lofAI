// The desk's engine, v3 (lib/board.ts, lib/board-defaults.ts): fitted slot
// metrics, the size vocabulary, free placement with explicit pins, the drop
// rule and its properties, keyboard steps, resize, pins, tidy and the drawer.
// Pure, so it runs in a vm.
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
  // wrapped in a function: in a vm, names at a script's top level are slow to
  // read, and the property runs below make a few hundred thousand plans
  vm.runInNewContext(`(function (exports, require) {${compiled}\n})`, {}, { filename: `lib/${name}.ts` })(exports, loadModule)
  return exports
}

const {
  SIZE_IDS, BUCKETS, COL_MAX, ROW_MIN, FIT_ROWS, HYSTERESIS, SPARE_ROWS, MAX_ROW, BUCKET_SPECS,
  metricsFor, bucketFor, specOf, colsOf, footprint, contentSize, rectPx, slotAt, overlaps, deepest,
  readingOrder, orderOf, boardRows, own, firstFree, nearestFree, layoutOf, pack,
  planDrop, planInsert, planKey, planResize, planPin, planTidy, planTakeOut, planPutAway,
  mergeOrder, rippleDelays, sizeStep,
} = loadModule("./board")
const { DEFAULT_ORDER, DEFAULT_ON_DESK, DEFAULT_SIZES, DEFAULT_AT, deriveAt, defaultArrangement } = loadModule("./board-defaults")

// the engine lives in its own realm (its arrays have their own prototype), so
// compare plain copies
const plain = (v) => JSON.parse(JSON.stringify(v))
const deep = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message)
const slots = (items) => Object.fromEntries(Array.from(items, (it) => [it.id, [it.x, it.y]]))
const at = (items, id) => Array.from(items).find((it) => it.id === id)
const noOverlaps = (items, message) => {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      assert.ok(!overlaps(items[i], items[j]), `${message}: ${JSON.stringify(items[i])} overlaps ${JSON.stringify(items[j])}`)
    }
  }
}
const inBounds = (items, cols, message) => {
  for (const it of items) {
    assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.w <= cols && Number.isInteger(it.x) && Number.isInteger(it.y),
      `${message}: ${JSON.stringify(it)} is off the board`)
  }
}
// seeded, so a failing board can be replayed
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
const shuffled = (rand, list) => {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) { const j = int(rand, 0, i); [out[i], out[j]] = [out[j], out[i]] }
  return out
}
// every widget's sizes, as SPEC3-delta §3 has them
const SIZES = { radio: ["m", "l", "w", "xl"], tasks: ["m", "l"], timer: ["s", "m"], cat: ["s", "m", "l"], "desk-task": ["s", "m"], notebook: ["m", "l"], clock: ["s", "m"], today: ["m"] }
const USUAL = (bucket = "desk") => defaultArrangement(bucket)
const board = (order, sizes, at = {}, pins = {}) => ({ order, sizes, at, pins })
const pinned = (...ids) => Object.fromEntries(ids.map((id) => [id, true]))

// 1. metrics: every row of SPEC3-delta §2, the bucket edges, the rows in view
{
  // vw, vh, bucket, colW, rowH, boardWidth, visibleRows, originX
  const table = [
    [1920, 1080, "desk", 224, 224, 1444, 4, 238], [1512, 860, "desk", 208, 172, 1348, 4, 82],
    [1440, 900, "desk", 196, 182, 1276, 4, 82], [1440, 800, "desk", 196, 157, 1276, 4, 82],
    [1440, 780, "desk", 196, 152, 1276, 4, 82], [1366, 768, "desk", 184, 149, 1204, 4, 81],
    // the spec's table says 128 for this one, but its own formula says 137 and
    // every other row agrees with the formula
    [1280, 720, "desk", 170, 137, 1120, 4, 80], [1280, 620, "desk", 170, 128, 1120, 3, 80],
    [1279, 800, "compact", 224, 151, 956, 4, 162], [1024, 768, "compact", 221, 143, 944, 4, 40],
    [768, 1024, "compact", 157, 157, 688, 5, 40], [740, 900, "compact", 150, 150, 660, 4, 40],
    [739, 900, "phone", 224, 224, 464, 3, 138], [390, 844, "phone", 171, 171, 358, 3, 16],
    [375, 667, "phone", 163, 163, 342, 2, 17], [320, 700, "phone", 136, 136, 288, 3, 16],
  ]
  for (const [vw, vh, bucket, colW, rowH, boardWidth, visibleRows, originX] of table) {
    const m = metricsFor(vw, vh)
    const got = [m.bucket, m.colW, m.rowH, m.boardWidth, m.visibleRows, m.originX]
    deep(got, [bucket, colW, rowH, boardWidth, visibleRows, originX], `metrics at ${vw}×${vh}`)
    assert.equal(m.cols, colsOf(bucket), `columns at ${vw}×${vh}`)
    assert.equal(m.pitchX, m.colW + m.gap, "pitchX")
    assert.equal(m.pitchY, m.rowH + m.gap, "pitchY")
    assert.ok(m.rowH <= m.colW, `a row is never taller than it is wide at ${vw}×${vh}`)
    assert.ok(m.colW <= COL_MAX && m.rowH >= Math.min(ROW_MIN, m.colW), `slot bounds at ${vw}×${vh}`)
  }
  assert.equal(bucketFor(1280), "desk")
  assert.equal(bucketFor(1279), "compact")
  assert.equal(bucketFor(740), "compact")
  assert.equal(bucketFor(739), "phone")
  assert.equal(bucketFor(0), "phone")
  deep([colsOf("desk"), colsOf("compact"), colsOf("phone")], [6, 4, 2], "columns per bucket")
  deep(BUCKET_SPECS.map((s) => s.bucket), BUCKETS, "the specs are the buckets, widest first")
  // nothing blows up without a window
  const none = metricsFor(NaN, NaN)
  assert.ok(none.colW > 0 && none.rowH > 0 && none.visibleRows >= 1, "metrics with no window")
  assert.equal(specOf("phone").cols, 2)
  deep([FIT_ROWS, HYSTERESIS, SPARE_ROWS, MAX_ROW, COL_MAX, ROW_MIN], [4, 0.2, 1, 200, 224, 128], "the constants")
}

// 2. the usual desk fits the window with no scrolling
{
  for (const [vw, vh] of [[1440, 800], [1280, 720], [1512, 860], [1440, 900]]) {
    const m = metricsFor(vw, vh)
    const items = layoutOf(USUAL(m.bucket), m.cols)
    assert.equal(deepest(items), FIT_ROWS, `the usual desk is ${FIT_ROWS} rows at ${vw}×${vh}`)
    assert.ok(deepest(items) <= m.visibleRows, `the usual desk is in view at ${vw}×${vh}`)
    const px = deepest(items) * m.pitchY - m.gap
    assert.ok(px <= vh - m.top - m.bottom, `the usual desk fits ${vw}×${vh} (${px} in ${vh - m.top - m.bottom})`)
  }
}

// 3. footprints, forms and the content a narrow board draws
{
  const table = {
    6: { s: [1, 1, null], m: [2, 1, null], l: [2, 2, null], w: [4, 2, null], xl: [4, 4, null] },
    4: { s: [1, 1, null], m: [2, 1, null], l: [2, 2, null], w: [4, 2, null], xl: [2, 4, "tall"] },
    2: { s: [1, 1, null], m: [2, 1, null], l: [2, 2, null], w: [2, 2, null], xl: [2, 4, "tall"] },
  }
  for (const cols of [6, 4, 2]) {
    for (const size of SIZE_IDS) {
      const f = footprint(size, cols)
      deep([f.w, f.h, f.form], table[cols][size], `${size} at ${cols} columns`)
    }
    for (const size of SIZE_IDS) assert.equal(contentSize(size, cols), cols < 4 && size === "w" ? "l" : size, `content of ${size} at ${cols}`)
  }
  deep(SIZE_IDS, ["s", "m", "l", "w", "xl"], "small to large")
  // junk falls back to the smallest
  deep(footprint("nope", 6), { w: 1, h: 1, form: null }, "an unknown size")
}

// 4. geometry
{
  const m = metricsFor(1440, 800)
  deep(rectPx({ x: 1, y: 2, w: 2, h: 1 }, m), { left: m.pitchX, top: 2 * m.pitchY, width: 2 * m.pitchX - m.gap, height: m.pitchY - m.gap }, "rectPx")
  assert.ok(!overlaps({ x: 0, y: 0, w: 2, h: 1 }, { x: 2, y: 0, w: 2, h: 1 }), "shared edges are not overlap")
  assert.ok(overlaps({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 }), "a corner is overlap")
  assert.equal(deepest([{ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 3, w: 1, h: 2 }]), 5, "deepest")
  const items = [{ id: "b", x: 2, y: 0, w: 1, h: 1 }, { id: "a", x: 0, y: 1, w: 1, h: 1 }, { id: "c", x: 0, y: 0, w: 1, h: 1 }]
  deep(orderOf(items), ["c", "b", "a"], "reading order")
  deep(readingOrder([{ id: "y", x: 0, y: 0, w: 1, h: 1 }, { id: "x", x: 0, y: 0, w: 1, h: 1 }]).map((it) => it.id), ["x", "y"], "ties go by id")
  deep(boardRows([{ x: 0, y: 0, w: 1, h: 2 }], { visibleRows: 4 }, false), 4, "rows at rest")
  deep(boardRows([{ x: 0, y: 0, w: 1, h: 6 }], { visibleRows: 4 }, true), 7, "a spare row while arranging")
  // slotAt: the halfway line plus the hysteresis, and the clamps
  const fp = { w: 2, h: 1 }
  deep(slotAt(0, 0, fp, m, 6, null), { x: 0, y: 0 }, "the origin")
  deep(slotAt(m.pitchX * 0.6, 0, fp, m, 6, null), { x: 1, y: 0 }, "past the halfway line")
  deep(slotAt(m.pitchX * 0.6, 0, fp, m, 6, { x: 0, y: 0 }), { x: 0, y: 0 }, "the hand holds the slot it had")
  deep(slotAt(m.pitchX * 0.8, 0, fp, m, 6, { x: 0, y: 0 }), { x: 1, y: 0 }, "and lets go past the hysteresis")
  deep(slotAt(1e9, 1e9, fp, m, 3, null), { x: 4, y: 3 }, "clamped to the board")
  deep(slotAt(NaN, NaN, fp, m, 3, null), { x: 0, y: 0 }, "junk reads as the origin")
  // with the hand: the cell under it is always one it lands on. held by its
  // top edge and let go low over row 1, its top-left is past row 2's halfway
  // line, yet it lands on row 1, the row under the hand
  const low = 1 * m.pitchY + 0.85 * m.rowH
  deep(slotAt(0, low - 16, fp, m, 6, null), { x: 0, y: 2 }, "the top-left alone rounds down a row")
  deep(slotAt(0, low - 16, fp, m, 6, null, { x: 20, y: low }), { x: 0, y: 1 }, "the hand keeps it on the row it's over")
  deep(slotAt(0, low - 16, fp, m, 6, { x: 0, y: 0 }, { x: 20, y: low }), { x: 0, y: 1 }, "and the hysteresis never holds a slot the hand has left")
  // held by its right half, the hand over column 3 lands it on 2 and 3
  deep(slotAt(1.6 * m.pitchX, 0, fp, m, 6, null, { x: 3.5 * m.pitchX, y: 20 }), { x: 2, y: 0 }, "the hand's cell is inside it")
  deep(slotAt(1.6 * m.pitchX, 0, fp, m, 6, { x: 1, y: 0 }, { x: 3.5 * m.pitchX, y: 20 }), { x: 2, y: 0 }, "even from a slot the hand was near")
  assert.equal(own({}, "constructor"), undefined, "own only sees its own keys")
}

// 5. the default layouts: the old pre-widget composition, per bucket
{
  deep(DEFAULT_ORDER, ["radio", "tasks", "timer", "cat", "desk-task", "notebook", "clock", "today"], "registry order")
  deep(DEFAULT_ON_DESK, ["radio", "tasks", "timer", "cat"], "what starts out")
  deep(DEFAULT_SIZES, { radio: "xl", tasks: "l", timer: "m", cat: "m", "desk-task": "m", notebook: "m", clock: "s", today: "m" }, "default sizes")
  const expected = {
    // radio full on the left; the cat, Tasks and the timer down the right
    desk: { radio: [0, 0], cat: [4, 0], tasks: [4, 1], timer: [4, 3] },
    // the old page at 1024 too: the tall radio on the left, the cat, Tasks and the timer down the right
    compact: { radio: [0, 0], cat: [2, 0], tasks: [2, 1], timer: [2, 3] },
    phone: { radio: [0, 0], cat: [0, 4], tasks: [0, 5], timer: [0, 7] },
  }
  for (const bucket of BUCKETS) {
    const cols = colsOf(bucket)
    const a = USUAL(bucket)
    deep(a.at, Object.fromEntries(Object.keys(expected[bucket]).map((id) => [id, { x: expected[bucket][id][0], y: expected[bucket][id][1] }])), `${bucket} spots`)
    deep(a.pins, {}, `nothing is pinned on the ${bucket}`)
    const items = layoutOf(a, cols)
    deep(slots(items), expected[bucket], `${bucket} layout`)
    noOverlaps(items, `${bucket} layout`)
    inBounds(items, cols, `${bucket} layout`)
    assert.equal(at(items, "radio").h, 4, "the radio is the full card")
    assert.equal(at(items, "radio").w, bucket === "desk" ? 4 : 2, "and it stacks below six columns")
    deep(DEFAULT_AT[bucket], a.at, `${bucket} table`)
  }
  // every widget out: the other four take the first free spots in reading order
  deep(slots(layoutOf(defaultArrangement("desk", DEFAULT_ORDER), 6)),
    { radio: [0, 0], cat: [4, 0], tasks: [4, 1], timer: [4, 3], "desk-task": [0, 4], notebook: [2, 4], clock: [4, 4], today: [0, 5] }, "a full desk")
  deep(slots(layoutOf(defaultArrangement("compact", DEFAULT_ORDER), 4)),
    { radio: [0, 0], cat: [2, 0], tasks: [2, 1], timer: [2, 3], "desk-task": [0, 4], notebook: [2, 4], clock: [0, 5], today: [1, 5] }, "a full compact desk")
  deep(slots(layoutOf(defaultArrangement("phone", DEFAULT_ORDER), 2)),
    { radio: [0, 0], cat: [0, 4], tasks: [0, 5], timer: [0, 7], "desk-task": [0, 8], notebook: [0, 9], clock: [0, 10], today: [0, 11] }, "a full phone desk")
  // a usual widget at a size its default spot can't hold flows instead
  const grown = deriveAt("desk", ["radio", "cat", "tasks"], { radio: "xl", cat: "l", tasks: "l" })
  deep(grown, { radio: { x: 0, y: 0 }, cat: { x: 4, y: 0 }, tasks: { x: 4, y: 2 } }, "a grown cat pushes Tasks to the first free spot")
  // and a bucket derives its own spots, never another's
  assert.notDeepEqual(plain(deriveAt("desk", DEFAULT_ON_DESK, DEFAULT_SIZES)), plain(deriveAt("phone", DEFAULT_ON_DESK, DEFAULT_SIZES)), "one bucket per layout")
  // gravity, so a shrunk or put-away widget leaves no gap where nobody arranged
  deep(deriveAt("compact", DEFAULT_ON_DESK, { ...DEFAULT_SIZES, radio: "w" }),
    { radio: { x: 0, y: 0 }, tasks: { x: 0, y: 2 }, cat: { x: 2, y: 2 }, timer: { x: 2, y: 3 } }, "the wide radio: the rest come up under it")
  deep(deriveAt("phone", ["tasks", "timer", "cat"], DEFAULT_SIZES), { cat: { x: 0, y: 0 }, tasks: { x: 0, y: 1 }, timer: { x: 0, y: 3 } }, "the radio put away on the phone")
  deep(deriveAt("desk", DEFAULT_ON_DESK, { ...DEFAULT_SIZES, cat: "s" }).tasks, { x: 4, y: 1 }, "a gap beside a widget stays: gravity keeps columns")
  deep(deriveAt("desk", ["radio", "tasks", "timer"], DEFAULT_SIZES), { radio: { x: 0, y: 0 }, tasks: { x: 4, y: 0 }, timer: { x: 4, y: 2 } }, "no cat on the desk: Tasks and the timer come up")
}

// 6. layoutOf: every widget at its own spot, with the smallest repair that keeps
// the board sane
{
  const sizes = { timer: "m", clock: "s" }
  // off the board: clamped in
  deep(slots(layoutOf(board(["radio"], { radio: "xl" }, { radio: { x: 5, y: 0 } }), 6)), { radio: [2, 0] }, "clamped into the columns")
  deep(slots(layoutOf(board(["clock"], { clock: "s" }, { clock: { x: 1, y: 9999 } }), 6)), { clock: [1, MAX_ROW] }, "clamped to the deepest row")
  // open space is kept: a widget let go on its own stays there
  deep(slots(layoutOf(board(["clock", "timer"], sizes, { clock: { x: 5, y: 0 }, timer: { x: 0, y: 4 } }), 6)),
    { clock: [5, 0], timer: [0, 4] }, "separated widgets stay separated")
  // an overlap (a size grew, the board narrowed): the first in reading order
  // keeps its spot, the other takes the nearest free one — ties go to the
  // smaller y, then the smaller x
  deep(slots(layoutOf(board(["timer", "clock"], sizes, { timer: { x: 0, y: 0 }, clock: { x: 1, y: 0 } }), 6)),
    { timer: [0, 0], clock: [2, 0] }, "the overlapped one moves")
  // a pin keeps its spot whatever else wanted it
  deep(slots(layoutOf(board(["timer", "clock"], sizes, { timer: { x: 0, y: 0 }, clock: { x: 1, y: 0 } }, pinned("clock")), 6)),
    { clock: [1, 0], timer: [0, 1] }, "the pin is placed first")
  // no spot at all: the first free one
  deep(slots(layoutOf(board(["timer", "clock"], sizes, { timer: { x: 0, y: 2 } }), 6)), { clock: [0, 0], timer: [0, 2] }, "a widget the save forgot")
  // deterministic: the keys' order never shows
  const a = board(["timer", "clock"], sizes, { timer: { x: 2, y: 1 }, clock: { x: 0, y: 0 } })
  const b = board(["clock", "timer"], sizes, { clock: { x: 0, y: 0 }, timer: { x: 2, y: 1 } })
  deep(layoutOf(a, 6), layoutOf(b, 6), "the same arrangement, the same layout")
  // pinned shows on the item
  const items = layoutOf(board(["timer", "clock"], sizes, { timer: { x: 0, y: 0 }, clock: { x: 4, y: 0 } }, pinned("timer")), 6)
  deep(items.map((it) => [it.id, it.pinned]), [["timer", true], ["clock", false]], "the pins are marked")
}

// 7. pack and the spot finders (helpers: an order with no spots of its own)
{
  deep(slots(pack(["radio", "tasks", "timer", "cat"], DEFAULT_SIZES, 6)),
    { radio: [0, 0], tasks: [4, 0], timer: [4, 2], cat: [4, 3] }, "the flow helper fills the first free spots")
  deep(slots(pack(["clock"], { clock: "s" }, 6, [{ x: 0, y: 0, w: 1, h: 1 }])), { clock: [1, 0] }, "pack around what's taken")
  deep(firstFree([{ x: 0, y: 0, w: 6, h: 1 }], 2, 1, 6), { x: 0, y: 1 }, "the first free spot")
  assert.equal(firstFree([{ x: 0, y: 0, w: 6, h: 1 }], 2, 1, 6, 1), null, "no room inside the rows in view")
  deep(firstFree([{ x: 0, y: 0, w: 6, h: 1 }], 2, 1, 6, 2), { x: 0, y: 1 }, "room inside the rows in view")
  deep(nearestFree([{ x: 0, y: 0, w: 2, h: 1 }], { x: 0, y: 0 }, 2, 1, 6), { x: 0, y: 1 }, "the nearest free spot, by distance")
  deep(nearestFree([{ x: 2, y: 2, w: 2, h: 1 }], { x: 2, y: 2 }, 2, 1, 6), { x: 2, y: 1 }, "a tie goes to the smaller y")
}

// 8. the drop rule (SPEC3-delta §1): it lands where it was let go, the widgets
// it covers make room, and nothing is ever pinned by a drop
{
  const a = USUAL()
  // home: let go where it was picked up, nothing changes
  const home = planDrop(a, "cat", { x: 4, y: 0 }, 6)
  assert.equal(home.kind, "home")
  assert.equal(home.rule, "home")
  deep(home.moved, [], "a home drop moves nobody")
  deep(slots(home.items), slots(layoutOf(a, 6)), "a home drop changes nothing")
  // open space: it stays exactly there and no one else stirs, pinned or not
  const open = planDrop(a, "timer", { x: 0, y: 5 }, 6)
  deep(slots(open.items), { radio: [0, 0], cat: [4, 0], tasks: [4, 1], timer: [0, 5] }, "a widget let go on its own stays there")
  deep(open.moved, [], "nobody else moves")
  assert.equal(open.rule, "exact")
  assert.equal(at(open.items, "timer").pinned, false, "and it is not pinned")
  assert.equal(own(open.arrangement.pins, "timer"), undefined, "no auto-pin")
  // equal sizes swap
  const swap = planDrop(a, "cat", { x: 4, y: 3 }, 6)
  deep(slots(swap.items), { radio: [0, 0], timer: [4, 0], tasks: [4, 1], cat: [4, 3] }, "the cat and the timer trade places")
  deep(swap.moved, ["timer"], "the one it swapped with moved")
  // the ones it covers move over into the room it left, in reading order: the
  // radio two columns right mirrors the desk
  const over = planDrop(a, "radio", { x: 2, y: 0 }, 6)
  deep(slots(over.items), { cat: [0, 0], radio: [2, 0], tasks: [0, 1], timer: [0, 3] }, "three widgets move over into its room")
  noOverlaps(over.items, "after a wide drop")
  deep(slots(planDrop(over.arrangement, "radio", { x: 0, y: 0 }, 6).items), slots(layoutOf(a, 6)), "and carried back, the usual desk again")
  // a bigger one moves over into the room too: the timer onto Tasks' top
  // leaves no hole, and Tasks stays in view
  const up = planDrop(a, "timer", { x: 4, y: 1 }, 6)
  deep(slots(up.items), { radio: [0, 0], cat: [4, 0], timer: [4, 1], tasks: [4, 2] }, "Tasks moves down into the timer's room")
  deep(up.moved, ["tasks"])
  // but it's never shoved out of view: let go mostly over a widget too big to
  // move into the room it left, the two trade sides instead, as if the bigger
  // one had been carried over (the same mirror as the radio two columns right)
  for (const T of [{ x: 3, y: 3 }, { x: 0, y: 3 }]) {
    const side = planDrop(a, "timer", T, 6)
    assert.equal(side.kind, "move", `the timer onto the radio at ${T.x},${T.y} is a move`)
    deep(slots(side.items), { cat: [0, 0], radio: [2, 0], tasks: [0, 1], timer: [0, 3] }, "the timer and the radio trade sides")
    noOverlaps(side.items, "after trading sides")
  }
  // and once they've traded, it's set down as near where it was let go as
  // its new side allows: into the radio's corner, not back up its own column
  const corner = planDrop(a, "timer", { x: 0, y: 0 }, 6)
  assert.equal(corner.rule, "trade")
  deep(slots(corner.items), { timer: [0, 0], radio: [2, 0], tasks: [0, 1], cat: [0, 3] }, "onto the radio's far corner: they trade sides and it takes the corner")
  noOverlaps(corner.items, "after trading into the corner")
  const middle = planDrop(a, "cat", { x: 1, y: 1 }, 6)
  assert.equal(middle.rule, "trade")
  deep(slots(middle.items), { tasks: [0, 0], radio: [2, 0], cat: [0, 2], timer: [0, 3] }, "the cat over the radio's middle: across, a row from where it was let go")
  // with room for it in the desk's rows, a bigger one goes down its column
  // instead: on a phone's one column, Tasks onto the radio's top just goes first
  const phone = defaultArrangement("phone")
  const first = planDrop(phone, "tasks", { x: 0, y: 0 }, 2)
  assert.equal(first.rule, "push")
  deep(slots(first.items), { tasks: [0, 0], radio: [0, 2], cat: [0, 6], timer: [0, 7] }, "Tasks onto the phone's radio: it goes first, the rest go down")
  // over the radio's edge by its own column, its own column is nearer: it
  // stays on its side
  deep(slots(planDrop(a, "cat", { x: 3, y: 1 }, 6).items), { radio: [0, 0], tasks: [4, 0], cat: [4, 2], timer: [4, 3] }, "half over the radio's edge: down its own column")
  // onto Tasks' top, Tasks has no room to move over into, but trading places
  // (the cat just under it) is as near as home, so it trades
  const off = planDrop(a, "cat", { x: 4, y: 1 }, 6)
  deep(slots(off.items), { radio: [0, 0], tasks: [4, 0], cat: [4, 2], timer: [4, 3] }, "the cat onto Tasks' top: they trade")
  const past = planDrop(a, "cat", { x: 4, y: 2 }, 6)
  deep(slots(past.items), { radio: [0, 0], tasks: [4, 0], cat: [4, 2], timer: [4, 3] }, "onto its bottom, they trade")
  // nor is anyone pushed past the rows the desk reaches: one column right, the
  // radio would push the whole stack under it, so it goes the whole way over
  // (as near as home, and a move beats home)
  deep(slots(planDrop(a, "radio", { x: 1, y: 0 }, 6).items), { cat: [0, 0], radio: [2, 0], tasks: [0, 1], timer: [0, 3] }, "the radio one column over: the mirror")
  // the rows in view count too: with room in view, a smaller one is pushed
  // down its columns
  const roomy = board(["radio", "timer"], { radio: "w", timer: "m" }, { radio: { x: 0, y: 0 }, timer: { x: 4, y: 0 } })
  deep(slots(planDrop(roomy, "radio", { x: 1, y: 0 }, 6).items), { timer: [0, 0], radio: [2, 0] }, "past the desk's rows: it goes over, and the timer takes its side")
  const pushed = planDrop(roomy, "radio", { x: 1, y: 0 }, 6, 6)
  deep(slots(pushed.items), { radio: [1, 0], timer: [4, 2] }, "six rows in view: the timer goes down under it")
  assert.equal(pushed.rule, "exact")
  // off the board: clamped, never refused
  deep(slots(planDrop(a, "timer", { x: 9, y: 0 }, 6).items).timer, [4, 0], "clamped into the columns")
  assert.ok(planDrop(a, "timer", { x: 0, y: 999 }, 6), "a deep drop is still a drop")
}

// 9. pins: they never move, they can't be dragged, and a drop slides off them
{
  const a = { ...USUAL(), pins: pinned("timer") }
  assert.equal(planDrop(a, "timer", { x: 0, y: 5 }, 6), null, "a pinned widget resists")
  const beside = planDrop(a, "cat", { x: 4, y: 3 }, 6)
  assert.equal(beside.rule, "beside", "the target was under a pin")
  deep(slots(beside.items), { radio: [0, 0], tasks: [4, 0], cat: [4, 2], timer: [4, 3] }, "it takes the nearest spot clear of the pin")
  assert.equal(at(beside.items, "timer").pinned, true, "the pin is still a pin")
  deep(beside.arrangement.pins, { timer: true }, "and the only one")
  // a pin is never a victim
  const past = planDrop(a, "radio", { x: 2, y: 0 }, 6)
  deep(slots(past.items).timer, [4, 3], "the pin stays put")
  noOverlaps(past.items, "around a pin")
}

// 10. the drop properties over 2,000 random boards, pins and all
{
  const ids = Object.keys(SIZES)
  const cheb = (p, q) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y))
  // the span of a widget's old spot and the dragged one's: the room a drag frees
  const within = (r, a, b) => r.x >= Math.min(a.x, b.x) && r.y >= Math.min(a.y, b.y) &&
    r.x + r.w <= Math.max(a.x + a.w, b.x + b.w) && r.y + r.h <= Math.max(a.y + a.h, b.y + b.h)
  let boards = 0, drops = 0, slid = 0, trades = 0, pushes = 0
  for (let seed = 1; seed <= 2000; seed++) {
    const rand = prng(seed)
    const cols = [6, 4, 2][int(rand, 0, 2)]
    const order = shuffled(rand, ids).slice(0, int(rand, 1, ids.length))
    const sizes = {}
    for (const id of order) sizes[id] = SIZES[id][int(rand, 0, SIZES[id].length - 1)]
    const spots = {}
    for (const id of order) spots[id] = { x: int(rand, 0, cols - 1), y: int(rand, 0, 6) }
    const pins = {}
    for (const id of order) if (rand() < 0.25) pins[id] = true
    const a = board(order, sizes, spots, pins)
    const items = layoutOf(a, cols)
    const limit = deepest(items)
    boards++
    noOverlaps(items, `seed ${seed}: the repaired layout`)
    inBounds(items, cols, `seed ${seed}: the repaired layout`)
    // deterministic whatever order the keys came in
    const flipped = {}
    for (const id of order.slice().reverse()) flipped[id] = spots[id]
    deep(layoutOf(board(order.slice().reverse(), sizes, flipped, pins), cols), items, `seed ${seed}: deterministic`)
    const pinnedNow = items.filter((it) => it.pinned)
    for (const me of items) {
      if (me.pinned) {
        assert.equal(planDrop(a, me.id, { x: 0, y: 0 }, cols), null, `seed ${seed}: ${me.id} is pinned`)
        continue
      }
      // every pairwise drop, and every open slot
      const targets = []
      for (const other of items) if (other.id !== me.id) targets.push({ x: Math.min(other.x, cols - me.w), y: other.y, open: false })
      for (let y = 0; y <= deepest(items); y++) {
        for (let x = 0; x + me.w <= cols; x++) {
          if (!items.some((it) => it.id !== me.id && overlaps(it, { x, y, w: me.w, h: me.h }))) targets.push({ x, y, open: true })
        }
      }
      for (const T of targets) {
        const plan = planDrop(a, me.id, T, cols)
        const tag = `seed ${seed}: ${me.id} to ${T.x},${T.y}`
        drops++
        assert.ok(plan, `${tag} was refused`)
        const after = plan.items, byId = Object.fromEntries(Array.from(after, (it) => [it.id, it]))
        noOverlaps(after, tag)
        inBounds(after, cols, tag)
        assert.equal(after.length, items.length, `${tag}: everyone is still on the desk`)
        const landed = byId[me.id]
        deep([plan.landing.x, plan.landing.y], [landed.x, landed.y], `${tag}: the landing is where it is`)
        const isHome = landed.x === me.x && landed.y === me.y, onT = landed.x === T.x && landed.y === T.y
        // trading sides with a bigger widget: the bigger one's drop, so its own
        // neighbours make room for it
        const traded = plan.rule === "trade", pushed = plan.rule === "push"
        if (traded) { trades++; assert.ok(!isHome, `${tag}: a trade that went nowhere`) }
        else if (pushed) { pushes++; assert.ok(onT, `${tag}: a push lands where it was let go`) }
        else assert.equal(plan.rule, isHome ? "home" : onT ? "exact" : "beside", `${tag}: the rule`)
        assert.equal(plan.kind, isHome ? "home" : "move", `${tag}: the kind`)
        if (isHome) deep(plan.moved, [], `${tag}: a home drop moves nobody`)
        // open space always takes it, exactly where it was let go
        if (T.open) assert.ok(onT, `${tag}: an open slot didn't take it`)
        // a slide is never further than home, and stays in the desk's rows
        // when the hand was in them
        if (!onT && !traded) {
          slid++
          assert.ok(cheb(landed, T) <= cheb(me, T), `${tag}: slid further than home`)
          if (T.y + me.h <= limit) assert.ok(landed.y + landed.h <= limit, `${tag}: slid out of the desk's rows`)
        }
        // a drop never pins anything, and never moves a pin
        assert.equal(landed.pinned, false, `${tag}: the drop pinned ${me.id}`)
        deep(plan.arrangement.pins, pins, `${tag}: the pins changed`)
        for (const q of pinnedNow) deep([byId[q.id].x, byId[q.id].y], [q.x, q.y], `${tag}: the pin ${q.id} moved`)
        for (const it of items) {
          if (it.id === me.id) continue
          const now = byId[it.id]
          if (now.x === it.x && now.y === it.y) continue
          // nobody else is pushed past the rows the desk reaches
          assert.ok(now.y + now.h <= limit, `${tag}: ${it.id} pushed out of the desk's rows`)
          // the ones it covers: a swap, over into the freed room, or down their
          // columns, which a bigger one only is when everyone still fits the
          // desk's rows (a push); the rest are only ever pushed down their columns
          const down = now.x === it.x && now.y > it.y
          if (traded) continue
          if (!overlaps(it, landed)) assert.ok(down, `${tag}: ${it.id} moved without being covered or pushed down`)
          else if (it.w * it.h > me.w * me.h) assert.ok(within(now, it, me) || (pushed && down), `${tag}: ${it.id} is bigger and was shoved`)
          else assert.ok(down || within(now, it, me), `${tag}: ${it.id} was flung`)
        }
        // the arrangement it commits draws the same layout, and planning twice
        // gives the same answer
        deep(layoutOf(plan.arrangement, cols), after, `${tag}: the arrangement is the layout`)
        deep(planDrop(a, me.id, T, cols).items, after, `${tag}: planning is pure`)
        // every preview is planned from the pickup snapshot, so sweeping the
        // hand back to the start gives the start again
        const back = planDrop(a, me.id, { x: me.x, y: me.y }, cols)
        assert.equal(back.kind, "home", `seed ${seed}: no way home`)
        deep(back.items, items, `seed ${seed}: sweeping back melted the desk`)
      }
    }
  }
  assert.equal(boards, 2000, "2,000 boards")
  assert.ok(drops > 100000, `${drops} drops is a thin sample`)
  assert.ok(slid > 1000 && slid < drops / 2, `${slid} of ${drops} drops slid`)
  assert.ok(pushes > 500 && trades > 500, `${pushes} pushes and ${trades} trades`)
}

// 10b. the usual desk in the common windows: no drop or arrow step sends
// anyone below the fold or past the desk's rows, so it never opens a hole
// (each usual desk tiles its rows exactly)
{
  for (const [W, H] of [[1440, 800], [1280, 720], [1512, 860], [1024, 768], [390, 844]]) {
    const m = metricsFor(W, H), cols = m.cols, a = USUAL(m.bucket)
    const items = layoutOf(a, cols), reach = Math.max(m.visibleRows, deepest(items))
    if (W >= 1280) assert.equal(reach, m.visibleRows, `${W}×${H}: the usual desk fits the window`)
    const area = items.reduce((n, it) => n + it.w * it.h, 0)
    assert.equal(area, cols * deepest(items), `${W}×${H}: the usual desk tiles its rows`)
    // all in the rows and none overlapping: every slot is still covered.
    // `mover`: the one an arrow walked down past the desk itself
    const tight = (plan, tag, mover = null) => {
      for (const it of plan.items) if (it.id !== mover) assert.ok(it.y + it.h <= reach, `${tag}: ${it.id} ends past row ${reach}`)
      noOverlaps(plan.items, tag)
    }
    for (const me of items) {
      for (let y = 0; y + me.h <= reach; y++) {
        for (let x = 0; x + me.w <= cols; x++) tight(planDrop(a, me.id, { x, y }, cols, m.visibleRows), `${W}×${H}: ${me.id} to ${x},${y}`)
      }
      for (const k of ["left", "right", "up", "down", "first", "last"]) {
        let from = null
        // a few presses in a row, each from the preview so far
        for (let i = 0; i < 4; i++) {
          const r = planKey(a, me.id, from, k, cols, m.visibleRows)
          if (!r.plan) break
          tight(r.plan, `${W}×${H}: ${me.id} ${k} ×${i + 1}`, k === "down" ? me.id : null)
          from = r.plan
        }
      }
    }
  }
  // the repros: the timer onto Tasks' top, and the radio two columns right
  const m = metricsFor(1440, 800), a = USUAL()
  deep(slots(planDrop(a, "timer", { x: 4, y: 1 }, 6, m.visibleRows).items), { radio: [0, 0], cat: [4, 0], timer: [4, 1], tasks: [4, 2] })
  deep(slots(planDrop(a, "radio", { x: 2, y: 0 }, 6, m.visibleRows).items), { cat: [0, 0], radio: [2, 0], tasks: [0, 1], timer: [0, 3] })
}

// 11. planInsert: a tile carried out of the drawer, with no spot to swap into
{
  const a = USUAL()
  const open = planInsert(a, "clock", "s", { x: 0, y: 4 }, 6)
  deep(slots(open.items), { radio: [0, 0], cat: [4, 0], tasks: [4, 1], timer: [4, 3], clock: [0, 4] }, "it lands where it was let go")
  deep(open.moved, [], "nobody else moves")
  assert.equal(at(open.items, "clock").pinned, false, "and it is not pinned")
  deep(open.arrangement.sizes.clock, "s", "its size is remembered")
  assert.ok(open.arrangement.order.indexOf("clock") >= 0, "it joins the order")
  // over a widget no bigger than it: pushed down its column, with the ones
  // under it, as long as they stay in the desk's rows
  const gap = planPutAway(a, "timer", 6).arrangement
  const pushed = planInsert(gap, "timer", "m", { x: 4, y: 0 }, 6)
  deep(slots(pushed.items), { radio: [0, 0], timer: [4, 0], cat: [4, 1], tasks: [4, 2] }, "the cat and Tasks go down a row")
  deep(pushed.moved, ["cat", "tasks"])
  // over a bigger one, or with no room in the desk's rows: the nearest spot
  // that takes it, here under the desk
  const over = planInsert(a, "notebook", "m", { x: 4, y: 1 }, 6)
  deep(slots(over.items), { radio: [0, 0], cat: [4, 0], tasks: [4, 1], timer: [4, 3], notebook: [4, 4] }, "Tasks isn't shoved for it")
  assert.equal(over.rule, "beside")
  deep(over.moved, [], "nobody moves")
  deep(slots(planInsert(a, "notebook", "l", { x: 0, y: 0 }, 6).items).notebook, [0, 4], "nor the radio")
  // over a pin: the nearest spot clear of it
  const beside = planInsert({ ...a, pins: pinned("tasks") }, "notebook", "m", { x: 4, y: 1 }, 6)
  assert.equal(beside.rule, "beside")
  deep(slots(beside.items).tasks, [4, 1], "the pin stays")
  // no target: just below everything
  deep(slots(planInsert(a, "clock", "s", null, 6).items).clock, [0, 4], "with nowhere named, under the desk")
}

// 12. keyboard: one slot at a time, resisting the edge and the pins
{
  const k = board(["timer", "clock"], { timer: "m", clock: "s" }, { timer: { x: 0, y: 0 }, clock: { x: 3, y: 0 } })
  const step = (a, id, from, move) => planKey(a, id, from, move, 6)
  deep(slots(step(k, "clock", null, "left").plan.items), { timer: [0, 0], clock: [2, 0] }, "a slot left")
  deep(slots(step(k, "clock", null, "right").plan.items), { timer: [0, 0], clock: [4, 0] }, "a slot right")
  deep(slots(step(k, "clock", null, "down").plan.items), { timer: [0, 0], clock: [3, 1] }, "a slot down")
  deep(step(k, "clock", null, "up"), { plan: null, resist: "edge", by: null }, "the top of the board")
  deep(step(k, "clock", null, "last").plan.landing.x, 5, "End goes to the end of the row")
  deep(slots(step(k, "clock", null, "first").plan.items), { clock: [0, 0], timer: [1, 0] }, "Home goes to the start, and the timer moves over")
  deep(step(k, "timer", null, "first"), { plan: null, resist: "edge", by: null }, "already at the start")
  deep(step(k, "timer", null, "left"), { plan: null, resist: "edge", by: null }, "the left edge")
  deep(step(k, "clock", null, "right"), step(k, "clock", null, "right"), "the same step twice")
  // steps add up: each one plans from the preview so far
  const first = step(k, "clock", null, "down")
  const second = step(k, "clock", first.plan, "down")
  deep(slots(second.plan.items), { timer: [0, 0], clock: [3, 2] }, "two slots down")
  // and they're planned from the pickup: past the timer and back, it's home again
  const home = step(k, "clock", null, "first")
  deep(slots(home.plan.items), { clock: [0, 0], timer: [1, 0] }, "Home: the timer moves over out of the way")
  const back = step(k, "clock", home.plan, "last")
  deep(slots(back.plan.items), { timer: [0, 0], clock: [5, 0] }, "End: the timer is back where it was, no melt")
  // pins: the step resists instead of sliding somewhere surprising
  const kp = { ...k, pins: pinned("timer") }
  deep(step(kp, "clock", null, "first"), { plan: null, resist: "pin", by: "timer" }, "a pin in the way")
  deep(step(kp, "timer", null, "right"), { plan: null, resist: "pin", by: "timer" }, "a pinned widget can't be walked")
  deep(step(k, "nope", null, "left"), { plan: null, resist: null, by: null }, "a widget that isn't out")
  // on the usual desk: a widget that won't budge is stepped past, and when
  // nothing that way takes it, the step resists instead of shoving the radio
  const u = USUAL()
  const up = step(u, "timer", null, "up")
  deep(slots(up.plan.items), { radio: [0, 0], cat: [4, 0], timer: [4, 1], tasks: [4, 2] }, "up: past Tasks' bottom half, Tasks moves down into its room")
  deep(slots(step(u, "timer", up.plan, "up").plan.items), { radio: [0, 0], timer: [4, 0], tasks: [4, 1], cat: [4, 3] }, "up again: it trades with the cat")
  deep(slots(step(u, "cat", null, "down").plan.items), { radio: [0, 0], tasks: [4, 0], cat: [4, 2], timer: [4, 3] }, "the cat down: past Tasks")
  deep(step(u, "timer", null, "left"), { plan: null, resist: "blocked", by: "radio" }, "the radio won't budge")
  deep(step(u, "timer", null, "first"), { plan: null, resist: "blocked", by: "radio" }, "nor for Home")
  deep(slots(step(u, "radio", null, "right").plan.items), { cat: [0, 0], radio: [2, 0], tasks: [0, 1], timer: [0, 3] }, "the radio right: past the column that pushes the stack away")
}

// 13. resize: it grows in place, keeping its top-left, and pushes the widgets
// it now covers down their columns
{
  const a = USUAL()
  const wide = planResize(a, "radio", "w", 6)
  deep(slots(wide.items), { radio: [0, 0], cat: [4, 0], tasks: [4, 1], timer: [4, 3] }, "the full radio becomes the wide one in place")
  deep([at(wide.items, "radio").w, at(wide.items, "radio").h], [4, 2], "at its new footprint")
  deep(wide.arrangement.sizes.radio, "w", "the size is saved")
  deep(wide.moved, [], "nobody else moves")
  const small = planResize(a, "timer", "s", 6)
  deep(slots(small.items).timer, [4, 3], "a smaller widget stays put")
  // no room where it is: it grows in place all the same, and the column under
  // it goes down, in order
  const grown = planResize(a, "cat", "l", 6)
  deep(slots(grown.items), { radio: [0, 0], cat: [4, 0], tasks: [4, 2], timer: [4, 4] }, "a grown cat stays under the hand")
  deep(grown.moved, ["tasks", "timer"], "and says who moved")
  deep(slots(planResize(grown.arrangement, "cat", "m", 6).items).cat, [4, 0], "and back down, it's still there")
  const tall = planResize(USUAL("phone"), "cat", "l", 2)
  deep(slots(tall.items), { radio: [0, 0], cat: [0, 4], tasks: [0, 6], timer: [0, 8] }, "on the phone too")
  // a pin in the way: the nearest free spot instead, and nobody moves
  const pinnedTasks = planResize({ ...a, pins: pinned("tasks") }, "cat", "l", 6)
  deep(slots(pinnedTasks.items).tasks, [4, 1], "the pin keeps its place")
  deep(slots(pinnedTasks.items).cat, [4, 4], "and the resize goes around it")
  deep(pinnedTasks.moved, [])
  // the columns: clamped in, and only the covered move
  const edge = planResize(board(["clock", "timer"], { clock: "s", timer: "m" }, { clock: { x: 5, y: 0 }, timer: { x: 0, y: 0 } }), "clock", "m", 6)
  deep(slots(edge.items), { timer: [0, 0], clock: [4, 0] }, "clamped into the columns")
  // a pinned widget keeps its pin through a resize
  const pin = planResize({ ...a, pins: pinned("timer") }, "timer", "s", 6)
  assert.equal(at(pin.items, "timer").pinned, true, "still pinned")
  deep(pin.arrangement.pins, { timer: true }, "the pin is kept")
  assert.equal(planResize(a, "nope", "s", 6), null, "a widget that isn't out")
  // growing in place over 500 random boards: it keeps its (clamped) top-left
  // unless a pin is there; the others only ever go down their columns, and
  // with a pin in the way nobody else moves at all
  let resized = 0
  for (let seed = 1; seed <= 500; seed++) {
    const rand = prng(seed * 7919)
    const cols = [6, 4, 2][int(rand, 0, 2)]
    const order = shuffled(rand, Object.keys(SIZES)).slice(0, int(rand, 1, 8))
    const sizes = {}, spots = {}, pins = {}
    for (const id of order) sizes[id] = SIZES[id][int(rand, 0, SIZES[id].length - 1)]
    for (const id of order) spots[id] = { x: int(rand, 0, cols - 1), y: int(rand, 0, 6) }
    for (const id of order) if (rand() < 0.2) pins[id] = true
    const b = board(order, sizes, spots, pins), items = layoutOf(b, cols)
    for (const me of items) {
      for (const size of SIZES[me.id]) {
        const plan = planResize(b, me.id, size, cols), tag = `resize seed ${seed}: ${me.id} to ${size}`
        resized++
        const byId = Object.fromEntries(Array.from(plan.items, (it) => [it.id, it]))
        const fp = footprint(size, cols), x = Math.min(me.x, cols - fp.w)
        const pinned = items.some((q) => q.pinned && q.id !== me.id && overlaps(q, { x, y: me.y, w: fp.w, h: fp.h }))
        noOverlaps(plan.items, tag)
        inBounds(plan.items, cols, tag)
        deep([byId[me.id].w, byId[me.id].h], [fp.w, fp.h], `${tag}: its footprint`)
        assert.equal(byId[me.id].pinned, me.pinned, `${tag}: its pin`)
        if (!pinned) deep([byId[me.id].x, byId[me.id].y], [x, me.y], `${tag}: in place`)
        for (const it of items) {
          if (it.id === me.id) continue
          const now = byId[it.id]
          if (pinned || it.pinned) { deep([now.x, now.y], [it.x, it.y], `${tag}: ${it.id} moved`); continue }
          assert.ok(now.x === it.x && now.y >= it.y, `${tag}: ${it.id} moved other than down`)
        }
        deep(layoutOf(plan.arrangement, cols), plan.items, `${tag}: the arrangement is the layout`)
      }
    }
  }
  assert.ok(resized > 2000, `${resized} resizes is a thin sample`)
}

// 14. the tack: on and off without moving anything
{
  const a = USUAL()
  const on = planPin(a, "cat", true, 6)
  deep(slots(on.items), slots(layoutOf(a, 6)), "pinning moves nothing")
  deep(on.moved, [], "and nobody else either")
  deep(on.arrangement.pins, { cat: true }, "the pin is saved")
  assert.equal(at(on.items, "cat").pinned, true, "and marked")
  const off = planPin(on.arrangement, "cat", false, 6)
  deep(off.arrangement.pins, {}, "unpinning takes it off")
  deep(slots(off.items), slots(layoutOf(a, 6)), "and the desk is where it was")
  // a widget on its own keeps its open space
  const lonely = board(["clock"], { clock: "s" }, { clock: { x: 5, y: 3 } })
  deep(slots(planPin(lonely, "clock", true, 6).items), { clock: [5, 3] }, "a separated widget stays where it is")
  assert.equal(planPin(a, "nope", true, 6), null, "a widget that isn't out")
}

// 15. tidy up: gravity, with the pins left alone
{
  const gappy = board(["clock", "timer"], { clock: "s", timer: "m" }, { clock: { x: 0, y: 3 }, timer: { x: 2, y: 5 } })
  const tidy = planTidy(gappy, 6)
  deep(slots(tidy.items), { clock: [0, 0], timer: [2, 0] }, "everything rises, keeping its column")
  deep(tidy.moved.slice().sort(), ["clock", "timer"], "both moved")
  const withPin = planTidy({ ...gappy, pins: pinned("clock") }, 6)
  deep(slots(withPin.items), { clock: [0, 3], timer: [2, 0] }, "the pin stays where it is")
  deep(withPin.moved, ["timer"], "only the loose one moved")
  // already tidy: nothing to undo
  const already = planTidy(USUAL(), 6)
  deep(already.moved, [], "the usual desk is already tidy")
  deep(slots(already.items), slots(layoutOf(USUAL(), 6)), "and unchanged")
}

// 16. the drawer: take out and put away
{
  const a = USUAL()
  // its remembered spot, if that spot is free
  const remembered = planTakeOut({ ...a, at: { ...a.at, clock: { x: 0, y: 4 } } }, "clock", "s", 6, { at: { x: 0, y: 4 }, rows: 4 })
  deep(slots(remembered.items).clock, [0, 4], "back where it was")
  assert.equal(remembered.rule, "step")
  // the remembered spot is taken: the first free spot in view, else below
  const below = planTakeOut(a, "notebook", "m", 6, { at: { x: 4, y: 0 }, rows: 4 })
  deep(slots(below.items).notebook, [0, 4], "under the desk when the rows in view are full")
  assert.equal(below.rule, "below", "the desk scrolls to it")
  // the next one goes beside it under the desk, not down a tower on the left
  const next = planTakeOut(below.arrangement, "clock", "s", 6, { rows: 4 })
  deep(slots(next.items).clock, [2, 4], "beside the one under the desk")
  assert.equal(next.rule, "below")
  const room = board(["radio", "tasks", "cat"], DEFAULT_SIZES, { radio: { x: 0, y: 0 }, cat: { x: 4, y: 0 }, tasks: { x: 4, y: 1 } })
  const inView = planTakeOut(room, "notebook", "m", 6, { rows: 4 })
  deep(slots(inView.items).notebook, [4, 3], "the first free spot in view")
  assert.equal(inView.rule, "step")
  // near a widget: the free spot nearest it
  const near = planTakeOut(a, "desk-task", "m", 6, { near: "timer", rows: 4 })
  deep(slots(near.items)["desk-task"], [4, 4], "next to the timer")
  deep(near.arrangement.sizes["desk-task"], "m", "at the size asked for")
  // put away: nobody closes up behind it, and its spot is remembered
  const away = planPutAway(a, "tasks", 6)
  deep(slots(away.items), { radio: [0, 0], cat: [4, 0], timer: [4, 3] }, "the others stay where they are")
  deep(away.moved, [], "nobody moves")
  deep(away.arrangement.at.tasks, { x: 4, y: 1 }, "its spot is kept for when it comes back")
  assert.equal(away.arrangement.order.indexOf("tasks"), -1, "and it is off the desk")
  const pinnedAway = planPutAway({ ...a, pins: pinned("tasks") }, "tasks", 6)
  deep(pinnedAway.arrangement.pins, {}, "a put-away widget is not pinned any more")
}

// 17. order memory, the ripple stagger and the size walk
{
  deep(mergeOrder(["a", "b", "c", "d"], ["c", "a"]), ["c", "b", "a", "d"], "the desk's order folds back in")
  deep(mergeOrder(["a", "b"], ["c"]), ["a", "b", "c"], "a newcomer goes last")
  deep(mergeOrder(["a", "a", "b"], ["b", "b"]), ["a", "b"], "duplicates fall out")
  const items = [{ id: "x", x: 0, y: 0, w: 1, h: 1, pinned: false }, { id: "y", x: 3, y: 0, w: 1, h: 1, pinned: false }]
  deep(rippleDelays(items, { x: 0, y: 0, w: 1, h: 1 }, ["y"]), { y: 72 }, "a delay per slot of distance")
  deep(rippleDelays(items, { x: 0, y: 0, w: 1, h: 1 }, ["y"], 100), { y: 120 }, "capped")
  deep(rippleDelays(items, { x: 0, y: 0, w: 1, h: 1 }, ["gone"]), { gone: 0 }, "a widget that left")
  assert.equal(sizeStep(["m", "l", "w", "xl"], "m", 1), "l", "one size up")
  assert.equal(sizeStep(["m", "l", "w", "xl"], "xl", 1), "xl", "the largest it has")
  assert.equal(sizeStep(["s", "m"], "s", -1), "s", "the smallest it has")
  assert.equal(sizeStep(["m", "l"], "s", 1), "m", "a size it doesn't have, upward")
  assert.equal(sizeStep(["m", "l"], "xl", -1), "l", "a size it doesn't have, downward")
  assert.equal(sizeStep([], "m", 1), "m", "no sizes at all")
}

console.log("board: ok")
