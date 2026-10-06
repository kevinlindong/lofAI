// The desk's pure engine (desk v3): a lattice of fitted slots, the standard
// sizes, and a layout where every widget simply has its own spot. Pins are the
// user's explicit choice and nothing else moves them. No DOM and no React: the
// desk calls these per render and per drag slot, and the unit tests run them in
// a vm, so imports stay relative. Positions are in slots unless a name says px.

export type Bucket = "desk" | "compact" | "phone"
export type SizeId = "s" | "m" | "l" | "w" | "xl"
export type WidgetType = "radio" | "tasks" | "timer" | "cat" | "desk-task" | "notebook" | "clock" | "today"
// small to large, so + / − walk them
export const SIZE_IDS: SizeId[] = ["s", "m", "l", "w", "xl"]
export const BUCKETS: Bucket[] = ["desk", "compact", "phone"]

// a slot's width is capped so a wide window doesn't blow the cards up, and its
// height so the usual desk (FIT_ROWS rows) fits a short window
export const COL_MAX = 224, ROW_MIN = 128, FIT_ROWS = 4
// keep the previous slot until the hand is this far past the halfway line
export const HYSTERESIS = 0.2
// open rows under the deepest widget while arranging, so there's somewhere to drop
export const SPARE_ROWS = 1
// the deepest row a saved spot may name
export const MAX_ROW = 200

// read once: the placing loops call these per slot, and in the unit tests' vm
// every read of a global like Math is dear
const { abs, floor, max, min, round, sqrt } = Math
const { keys } = Object
const clamp = (v: number, lo: number, hi: number) => min(max(v, lo), max(lo, hi))
const finite = (v: unknown): v is number => typeof v === "number" && isFinite(v)
// ids come from storage, so "constructor" must not find Object.prototype's
const hasOwn = Object.prototype.hasOwnProperty
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return hasOwn.call(record, key) ? record[key] : undefined
}

// --- metrics ---

export interface BucketSpec {
  bucket: Bucket; minWidth: number; cols: number; gap: number; margin: number
  // px above the board, and kept clear under it for the drawer pull
  top: number; bottom: number
  colMin: number
  // shrink the rows so FIT_ROWS of them fit the window's height
  fitHeight: boolean
}
// widest first
export const BUCKET_SPECS: BucketSpec[] = [
  { bucket: "desk", minWidth: 1280, cols: 6, gap: 20, margin: 80, top: 40, bottom: 72, colMin: 150, fitHeight: true },
  { bucket: "compact", minWidth: 740, cols: 4, gap: 20, margin: 40, top: 64, bottom: 72, colMin: 150, fitHeight: true },
  // 136: a 320px phone would push the board past the window at 150
  { bucket: "phone", minWidth: 0, cols: 2, gap: 16, margin: 16, top: 64, bottom: 88, colMin: 136, fitHeight: false },
]

export interface Metrics {
  bucket: Bucket; cols: number; gap: number; margin: number
  // slots are no longer square: colW × rowH, so the two pitches differ
  colW: number; rowH: number; pitchX: number; pitchY: number
  top: number; bottom: number; boardWidth: number; originX: number; visibleRows: number
}

export function specOf(bucket: Bucket): BucketSpec {
  for (const spec of BUCKET_SPECS) if (spec.bucket === bucket) return spec
  return BUCKET_SPECS[0]
}
export const colsOf = (bucket: Bucket): number => specOf(bucket).cols
export function bucketFor(vw: number): Bucket {
  for (const spec of BUCKET_SPECS) if (vw >= spec.minWidth) return spec.bucket
  return BUCKET_SPECS[BUCKET_SPECS.length - 1].bucket
}

export function metricsFor(vw: number, vh: number): Metrics {
  const w = finite(vw) ? vw : 0, h = finite(vh) ? vh : 0
  const b = specOf(bucketFor(w))
  const colW = clamp(floor((w - 2 * b.margin - (b.cols - 1) * b.gap) / b.cols), b.colMin, COL_MAX)
  // the phone keeps square slots; elsewhere four rows fit the window, and a row
  // is never taller than it is wide
  const rowH = b.fitHeight
    ? clamp(floor((h - b.top - b.bottom - (FIT_ROWS - 1) * b.gap) / FIT_ROWS), ROW_MIN, colW)
    : colW
  const pitchX = colW + b.gap, pitchY = rowH + b.gap
  const boardWidth = b.cols * colW + (b.cols - 1) * b.gap
  return {
    bucket: b.bucket, cols: b.cols, gap: b.gap, margin: b.margin, colW, rowH, pitchX, pitchY,
    top: b.top, bottom: b.bottom, boardWidth, originX: round((w - boardWidth) / 2),
    visibleRows: max(1, floor((h - b.top - b.bottom + b.gap) / pitchY)),
  }
}

// --- geometry ---

export interface Slot { x: number; y: number }
export interface Rect extends Slot { w: number; h: number }
export interface Item extends Rect { id: string }
export interface Placed extends Item { pinned: boolean }
// "tall": xl below the desk's six columns, the same content stacked 2×4
export type Form = "tall" | null

const FOOT: Record<string, [number, number]> = { s: [1, 1], m: [2, 1], l: [2, 2], w: [4, 2], xl: [4, 4] }
export function footprint(size: SizeId, cols: number): { w: number; h: number; form: Form } {
  const c = max(1, cols)
  // the full radio stacks below six columns, so the rest can sit beside it
  if (size === "xl" && c < 6) return { w: min(2, c), h: 4, form: "tall" }
  // the wide one falls back to its L content
  if (size === "w" && c < 4) return { w: min(2, c), h: 2, form: null }
  const f = own(FOOT, size) ?? FOOT.s
  return { w: min(f[0], c), h: f[1], form: null }
}
// the size whose content is drawn: W has no room of its own on a narrow board
export const contentSize = (size: SizeId, cols: number): SizeId => (size === "w" && max(1, cols) < 4 ? "l" : size)

export function rectPx(r: Rect, m: Pick<Metrics, "pitchX" | "pitchY" | "gap">): { left: number; top: number; width: number; height: number } {
  return { left: r.x * m.pitchX, top: r.y * m.pitchY, width: r.w * m.pitchX - m.gap, height: r.h * m.pitchY - m.gap }
}

// The slot under a carried widget's top-left (board px). Near a boundary it
// keeps the previous slot, so a hand resting on the line doesn't flicker.
// `hand` (board px): the pointer. The cell it's over is always one the widget
// lands on, so let go over a neighbour's lower half it lands on that
// neighbour, not the row under it (a gap counts half to each side).
export function slotAt(left: number, top: number, fp: { w: number; h: number }, m: Metrics, maxY: number, prev: Slot | null,
                       hand?: Slot): Slot {
  const axis = (px: number, pitch: number, at: number | undefined, span: number, was: number | null, hi: number) => {
    const raw = finite(px) && pitch > 0 ? px / pitch : 0
    const cell = finite(at) && pitch > 0 ? (at + m.gap / 2) / pitch : null
    // the slot it had holds while the hand is over it or the gaps around it
    const slack = (m.gap / 2 + 2) / pitch
    const covers = (n: number) => cell === null || (cell >= n - slack && cell < n + span + slack)
    if (was !== null && abs(raw - was) < 0.5 + HYSTERESIS && covers(was)) return clamp(was, 0, hi)
    let n = round(raw)
    if (cell !== null) n = clamp(n, floor(cell) - span + 1, floor(cell))
    return clamp(n, 0, hi)
  }
  return {
    x: axis(left, m.pitchX, hand?.x, min(fp.w, m.cols), prev ? prev.x : null, m.cols - min(fp.w, m.cols)),
    y: axis(top, m.pitchY, hand?.y, fp.h, prev ? prev.y : null, max(0, maxY)),
  }
}

// shared edges are not overlap
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function deepest(items: Rect[]): number {
  let d = 0
  for (const r of items) d = max(d, r.y + r.h)
  return d
}

const byReading = (a: Item, b: Item) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
// stable: equal keys keep their input order
export function readingOrder<T extends Item>(items: T[]): T[] {
  return items.map((_, i) => i).sort((i, j) => byReading(items[i], items[j]) || i - j).map((i) => items[i])
}
export const orderOf = (items: Item[]): string[] => readingOrder(items).map((it) => it.id)

// rows the board is drawn with: down to the fold at rest, and a spare row
// under the deepest widget while arranging
export function boardRows(items: Rect[], m: Pick<Metrics, "visibleRows">, arranging: boolean): number {
  return max(m.visibleRows, deepest(items) + (arranging ? SPARE_ROWS : 0))
}

// --- occupancy: one bitmask per row (a board is at most 6 columns) ---

type Rows = number[]
const maskOf = (x: number, w: number) => ((1 << w) - 1) << x
function fits(rows: Rows, x: number, y: number, w: number, h: number, cols: number): boolean {
  if (x < 0 || y < 0 || x + w > cols) return false
  const m = maskOf(x, w)
  for (let r = y; r < y + h; r++) if (r < rows.length && rows[r] & m) return false
  return true
}
function put(rows: Rows, x: number, y: number, w: number, h: number) {
  const m = maskOf(x, w)
  for (let r = y; r < y + h; r++) {
    while (rows.length <= r) rows.push(0)
    rows[r] |= m
  }
}
const rowsOf = (taken: Rect[]): Rows => {
  const rows: Rows = []
  for (const r of taken) put(rows, r.x, r.y, r.w, r.h)
  return rows
}

// the first free spot in reading order, or null when `rows` bounds the search
function firstIn(rows: Rows, w: number, h: number, cols: number, limit: number): Slot | null {
  for (let y = 0; y + h <= limit; y++) for (let x = 0; x + w <= cols; x++) if (fits(rows, x, y, w, h, cols)) return { x, y }
  return null
}
// the first free spot in reading order; `limit` caps y + h (the rows in view)
export function firstFree(taken: Rect[], w: number, h: number, cols: number, limit?: number): Slot | null {
  const rows = rowsOf(taken)
  return firstIn(rows, w, h, cols, finite(limit) ? limit : rows.length + h + 1)
}

// the nearest spot where w×h fits, by Euclidean distance between top-lefts,
// then the smaller y, then the smaller x (rows under everything are free, so
// there is always one)
function nearestIn(rows: Rows, x0: number, y0: number, w: number, h: number, cols: number): Slot {
  const hi = cols - w
  let best: Slot | null = null, bestE = Infinity
  // a spot in ring d is at least d away, so once d² passes the best there is
  // nothing left to find
  for (let d = 0; (!best || d * d <= bestE) && d <= rows.length + h + cols + 2; d++) {
    for (let y = max(0, y0 - d); y <= y0 + d; y++) {
      for (let x = max(0, x0 - d); x <= min(hi, x0 + d); x++) {
        if (max(abs(x - x0), abs(y - y0)) !== d || !fits(rows, x, y, w, h, cols)) continue
        const e = (x - x0) * (x - x0) + (y - y0) * (y - y0)
        if (e < bestE || (e === bestE && best !== null && (y < best.y || (y === best.y && x < best.x)))) { best = { x, y }; bestE = e }
      }
    }
  }
  return best ?? { x: 0, y: rows.length }
}
export const nearestFree = (taken: Rect[], from: Slot, w: number, h: number, cols: number): Slot =>
  nearestIn(rowsOf(taken), from.x, from.y, w, h, cols)

// --- the layout model ---

// One bucket's layout: which widgets are on the desk (in reading-order
// memory), each one's size (global to every bucket) and its own spot here, and
// this bucket's pins. A widget stays exactly where it was put down, with open
// space around it if that's where it was let go.
export interface Arrangement {
  order: string[]
  sizes: Record<string, SizeId>
  at: Record<string, Slot>
  pins: Record<string, true>
}

const sizeOf = (sizes: Record<string, SizeId>, id: string): SizeId => own(sizes, id) ?? "s"
const fpOf = (sizes: Record<string, SizeId>, id: string, cols: number) => footprint(sizeOf(sizes, id), cols)
const finiteSlot = (p: unknown): p is Slot => typeof p === "object" && p !== null && finite((p as Slot).x) && finite((p as Slot).y)

function uniq(ids: string[]): string[] {
  const out: string[] = []
  const seen: Record<string, true> = {}
  for (const id of ids) if (typeof id === "string" && !own(seen, id)) { seen[id] = true; out.push(id) }
  return out
}
export function copySlots(at: Record<string, Slot>): Record<string, Slot> {
  const out: Record<string, Slot> = {}
  for (const k of keys(at)) if (finiteSlot(at[k])) out[k] = { x: at[k].x, y: at[k].y }
  return out
}
const copyPins = (pins: Record<string, true>): Record<string, true> => {
  const out: Record<string, true> = {}
  for (const k of keys(pins)) if (pins[k] === true) out[k] = true
  return out
}
const copySizes = (sizes: Record<string, SizeId>): Record<string, SizeId> => {
  const out: Record<string, SizeId> = {}
  for (const k of keys(sizes)) out[k] = sizes[k]
  return out
}
const withoutKey = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const out: Record<string, T> = {}
  for (const k of keys(record)) if (k !== key) out[k] = record[k]
  return out
}

interface Want extends Item { pinned: boolean; known: boolean }

// What the desk draws: every widget at its own spot. Spots are clamped into
// the columns, and anything that would overlap (a size grew, the board
// narrowed) takes the nearest free spot instead — pins first, so a pin keeps
// its place. Deterministic: the same arrangement always gives the same layout,
// whatever order the save wrote its keys in.
export function layoutOf(a: Arrangement, cols: number): Placed[] {
  const c = max(1, cols)
  const want: Want[] = []
  for (const id of uniq(a.order)) {
    const { w, h } = fpOf(a.sizes, id, c)
    const p = own(a.at, id)
    const known = finiteSlot(p)
    want.push({
      id, w, h, pinned: own(a.pins, id) === true,
      x: known ? clamp(round(p.x), 0, c - w) : 0, y: known ? clamp(round(p.y), 0, MAX_ROW) : 0, known,
    })
  }
  const sorted = readingOrder(want)
  const rows: Rows = []
  const out: Placed[] = []
  const take = (it: Want, spot: Slot) => {
    put(rows, spot.x, spot.y, it.w, it.h)
    out.push({ id: it.id, x: spot.x, y: spot.y, w: it.w, h: it.h, pinned: it.pinned })
  }
  const moved: Want[] = [], loose: Want[] = []
  for (const it of sorted) {
    if (!it.known) { loose.push(it); continue }
    if (!it.pinned) continue
    if (fits(rows, it.x, it.y, it.w, it.h, c)) take(it, it)
    else moved.push(it)
  }
  for (const it of sorted) {
    if (!it.known || it.pinned) continue
    if (fits(rows, it.x, it.y, it.w, it.h, c)) take(it, it)
    else moved.push(it)
  }
  for (const it of moved) take(it, nearestIn(rows, it.x, it.y, it.w, it.h, c))
  // no spot at all (a widget the save forgot): the first free one
  for (const it of loose) take(it, firstIn(rows, it.w, it.h, c, rows.length + it.h + 1) ?? { x: 0, y: rows.length })
  return readingOrder(out)
}

// The flow helper: every id into the first free spot in reading order. A
// layout derived from an order alone — a fresh bucket, and tidying up.
export function pack(order: string[], sizes: Record<string, SizeId>, cols: number, taken: Rect[] = []): Placed[] {
  const c = max(1, cols)
  const rows = rowsOf(taken)
  const out: Placed[] = []
  for (const id of uniq(order)) {
    const { w, h } = fpOf(sizes, id, c)
    const spot = firstIn(rows, w, h, c, rows.length + h + 1) ?? { x: 0, y: rows.length }
    put(rows, spot.x, spot.y, w, h)
    out.push({ id, x: spot.x, y: spot.y, w, h, pinned: false })
  }
  return readingOrder(out)
}

// --- plans ---

export type PlanKind = "home" | "move"
// why a plan landed where it did (for the tests and the announcements):
// home: let go where it was; exact: it landed on the target slot; beside: the
// target didn't take it (a pin there, or a bigger widget with no room to move
// over into), so it took the nearest spot that does;
// below: a take-out with no room in view, so it went under everything;
// push: it landed on the target slot, and a bigger widget there went down its
// column to make room;
// trade: let go over a bigger widget with no room to move, the two traded sides;
// step: a keyboard step, a resize, a pin toggle or a take-out
export type PlanRule = "home" | "exact" | "push" | "beside" | "below" | "trade" | "step"
export interface Reflow {
  // what to commit for this bucket (order, spots and pins)
  arrangement: Arrangement
  items: Placed[]
  // other ids whose slot changed vs the pickup layout, nearest first
  moved: string[]
}
export interface Plan extends Reflow {
  landing: Placed
  kind: PlanKind
  rule: PlanRule
}

const find = (items: Placed[], id: string): Placed | null => {
  for (const it of items) if (it.id === id) return it
  return null
}
const indexById = (items: Placed[]) => {
  const out: Record<string, Placed> = {}
  for (const it of items) out[it.id] = it
  return out
}
const centreDist2 = (a: Rect, b: Rect) => {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2), dy = a.y + a.h / 2 - (b.y + b.h / 2)
  return dx * dx + dy * dy
}

// the others that moved from the pickup layout, nearest the landing first
export function movedFrom(pickup: Record<string, Placed>, items: Placed[], id: string, landing: Rect | null): string[] {
  const list: Placed[] = []
  for (const it of items) {
    if (it.id === id) continue
    const was = own(pickup, it.id)
    if (!was || was.x !== it.x || was.y !== it.y) list.push(it)
  }
  const sorted = readingOrder(list)
  if (landing) {
    const d = sorted.map((it) => centreDist2(it, landing))
    return sorted.map((_, i) => i).sort((i, j) => d[i] - d[j] || i - j).map((i) => sorted[i].id)
  }
  return sorted.map((it) => it.id)
}

// a widget's room on the board, to tell a bigger one from a smaller one
const areaOf = (r: { w: number; h: number }) => r.w * r.h

// the first free spot in reading order inside the span of a pushed widget and
// the spot the dragged one left: the room the drag freed, so a neighbour moves
// over into it rather than away
function freedIn(rows: Rows, v: Rect, home: Rect, cols: number): Slot | null {
  const x0 = min(v.x, home.x), y0 = min(v.y, home.y)
  const x1 = max(v.x + v.w, home.x + home.w), y1 = max(v.y + v.h, home.y + home.h)
  for (let y = y0; y + v.h <= y1; y++) for (let x = x0; x + v.w <= x1; x++) if (fits(rows, x, y, v.w, v.h, cols)) return { x, y }
  return null
}

interface Shove {
  items: Placed[]
  // the first widget bigger than the dragged one with no freed room to take:
  // it won't be shoved, so this spot doesn't take the drop
  blocked: string | null
  // the first other widget pushed deeper than `limit`: nor does this one
  deep: string | null
}

// The widget at T, and the unpinned widgets it now covers moved out of the
// way, in reading order: an equal size swaps into the spot it came from; else
// it moves over into the room the drag freed; else it is pushed down its
// columns, taking the widgets under it along (they keep their columns and only
// go down); only one no bigger than the dragged widget is pushed (`blocked`
// otherwise). Pins never move.
// home: the dragged widget's pickup spot (null: a tile from the drawer).
function displace(items: Placed[], id: string, T: Slot, fp: { w: number; h: number }, home: Rect | null, cols: number, limit: number): Shove {
  const rect: Rect = { x: T.x, y: T.y, w: fp.w, h: fp.h }
  const victims: Placed[] = [], keep: Placed[] = []
  for (const it of readingOrder(items)) {
    if (it.id === id) continue
    if (!it.pinned && overlaps(it, rect)) victims.push(it)
    else keep.push(it)
  }
  const rows = rowsOf(keep)
  put(rows, T.x, T.y, fp.w, fp.h)
  const settled: Placed[] = [{ id, x: T.x, y: T.y, w: fp.w, h: fp.h, pinned: false }]
  const pushed: Placed[] = []
  let blocked: string | null = null
  for (const v of victims) {
    const same = home && v.w === fp.w && v.h === fp.h && fits(rows, home.x, home.y, v.w, v.h, cols)
    const spot = same ? home : home ? freedIn(rows, v, home, cols) : null
    if (spot) {
      put(rows, spot.x, spot.y, v.w, v.h)
      settled.push({ id: v.id, x: spot.x, y: spot.y, w: v.w, h: v.h, pinned: false })
      continue
    }
    if (!blocked && areaOf(v) > areaOf(fp)) blocked = v.id
    pushed.push(v)
  }
  if (!pushed.length) return { items: readingOrder(keep.concat(settled)), blocked, deep: null }
  // the push: the pins and the settled stay; everyone else, in reading order,
  // keeps its column and goes down until it fits
  const after: Rows = []
  const out: Placed[] = []
  for (const it of settled) put(after, it.x, it.y, it.w, it.h)
  for (const it of keep) if (it.pinned) { put(after, it.x, it.y, it.w, it.h); out.push(it) }
  let deep: string | null = null
  for (const it of readingOrder(keep.filter((k) => !k.pinned).concat(pushed))) {
    let y = it.y
    while (!fits(after, it.x, y, it.w, it.h, cols)) y++
    put(after, it.x, y, it.w, it.h)
    if (y === it.y) { out.push(it); continue }
    out.push({ id: it.id, x: it.x, y, w: it.w, h: it.h, pinned: false })
    if (!deep && y + it.h > limit) deep = it.id
  }
  return { items: readingOrder(out.concat(settled)), blocked, deep }
}

// the arrangement a set of placed widgets commits: their spots, the spots
// remembered for the widgets in the drawer, and the reading order
function arrangeFrom(a: Arrangement, items: Placed[], sizes: Record<string, SizeId>, pins: Record<string, true>,
                     order?: string[]): Arrangement {
  const at = copySlots(a.at)
  for (const it of items) at[it.id] = { x: it.x, y: it.y }
  return { order: order ?? orderOf(items), sizes, at, pins }
}

const slotIn = (t: Slot | null | undefined, fallback: Slot, fp: { w: number; h: number }, cols: number): Slot => ({
  x: clamp(t && finite(t.x) ? round(t.x) : fallback.x, 0, cols - fp.w),
  y: clamp(t && finite(t.y) ? round(t.y) : fallback.y, 0, MAX_ROW),
})
const pinRowsOf = (items: Placed[], id: string): Rows => {
  const rows: Rows = []
  for (const it of items) if (it.pinned && it.id !== id) put(rows, it.x, it.y, it.w, it.h)
  return rows
}

// Where a drop at t lands, against the pickup layout: on t if t takes it, else
// on the nearest spot that does. A spot takes it when it's clear of the pins,
// shoves no bigger widget further than the room the drag freed, and pushes no
// one else deeper than `limit` (the rows the desk reaches); while t is inside
// those rows, so is the spot. Nearest: Chebyshev rings out from t, then
// Euclidean distance, then anywhere but home (on a full desk a drop between
// two spots is a move, not a refusal), then the smaller y, then x. Home always
// takes it, and with none (a tile from the drawer) the rows under everything do.
function landIn(items: Placed[], id: string, t: Slot, fp: { w: number; h: number }, home: Rect | null, cols: number,
                limit: number): { T: Slot; shove: Shove; slid: boolean } {
  const pins = pinRowsOf(items, id)
  const isHome = (x: number, y: number) => home !== null && x === home.x && y === home.y
  const takes = (x: number, y: number): Shove | null => {
    if (!fits(pins, x, y, fp.w, fp.h, cols)) return null
    if (isHome(x, y)) return { items, blocked: null, deep: null }
    const s = displace(items, id, { x, y }, fp, home, cols, limit)
    return s.blocked || s.deep ? null : s
  }
  const exact = takes(t.x, t.y)
  if (exact) return { T: t, shove: exact, slid: false }
  const hi = cols - fp.w
  const search = (inside: boolean, reach: number): { T: Slot; shove: Shove; slid: boolean } | null => {
    for (let d = 1; d <= reach; d++) {
      let best: Slot | null = null, bestE = Infinity, bestHome = false, shove: Shove | null = null
      for (let y = max(0, t.y - d); y <= min(MAX_ROW, t.y + d); y++) {
        if (inside && y + fp.h > limit) break
        for (let x = max(0, t.x - d); x <= min(hi, t.x + d); x++) {
          if (max(abs(x - t.x), abs(y - t.y)) !== d) continue
          const e = (x - t.x) * (x - t.x) + (y - t.y) * (y - t.y), h = isHome(x, y)
          if (best && !(e < bestE || (e === bestE && !h && bestHome))) continue
          const s = takes(x, y)
          if (s) { best = { x, y }; bestE = e; bestHome = h; shove = s }
        }
      }
      if (best && shove) return { T: best, shove, slid: true }
    }
    return null
  }
  // let go inside the desk, it stays inside; failing that (a full desk and a
  // tile from the drawer), anywhere
  const found = (t.y + fp.h <= limit ? search(true, max(cols, limit)) : null) ?? search(false, MAX_ROW + limit + cols + 8)
  if (found) return found
  // unreachable; a safe answer all the same
  const T = home ? { x: home.x, y: home.y } : { x: 0, y: max(limit, deepest(items)) }
  return { T, shove: home ? { items, blocked: null, deep: null } : displace(items, id, T, fp, null, cols, Infinity), slid: true }
}

const homePlan = (a: Arrangement, items: Placed[], me: Placed): Plan => ({
  arrangement: arrangeFrom(a, items, a.sizes, copyPins(a.pins), uniq(a.order)),
  items, landing: me, kind: "home", rule: "home", moved: [],
})
const movePlan = (a: Arrangement, items: Placed[], id: string, next: Placed[], sizes: Record<string, SizeId>, rule: PlanRule): Plan => {
  const landing = find(next, id)!
  return {
    arrangement: arrangeFrom(a, next, sizes, copyPins(a.pins)),
    items: next, landing, kind: "move", rule, moved: movedFrom(indexById(items), next, id, landing),
  }
}

// Where a carried widget lands if let go with its top-left at slot `target`,
// planned against the pickup snapshot (never a previous preview, so a sweep
// across the desk and back restores it): on the target, or the nearest spot
// that takes it (landIn). A widget never shoves a bigger one out of its way,
// only over into the room it left; nobody is pushed past the rows the desk
// reaches (`view`: the rows in the window, when they reach further). A drop is
// never refused, and nothing is ever pinned by a drop.
// null: it's pinned or not on the desk (the caller resists).
export function planDrop(a: Arrangement, id: string, target: Slot, cols: number, view = 0, depth = 0): Plan | null {
  const c = max(1, cols)
  const items = layoutOf(a, c)
  const me = find(items, id)
  if (!me || me.pinned) return null
  const t = slotIn(target, me, me, c)
  const limit = max(view, deepest(items))
  const { T, shove, slid } = landIn(items, id, t, me, me, c, limit)
  const home = T.x === me.x && T.y === me.y
  if (!slid && !home) return movePlan(a, items, id, shove.items, a.sizes, "exact")
  if (depth === 0 && !(t.x === me.x && t.y === me.y)) {
    // let go over a bigger widget with no room to move over into: it goes
    // down its column to make room, when everyone still fits the rows the
    // desk reaches (a phone's column: the two simply change places)
    if (fits(pinRowsOf(items, id), t.x, t.y, me.w, me.h, c)) {
      const down = displace(items, id, t, me, me, c, limit)
      if (!down.deep) return movePlan(a, items, id, down.items, a.sizes, "push")
    }
    // failing that, mostly over it, the two trade sides rather than it
    // sliding off to the nearest spot (on a full desk, back down its own
    // column: it would barely move), unless that spot is the nearer one to
    // where it was let go
    const traded = sideSwap(a, items, me, t, c, view)
    const aim: Rect = { x: t.x, y: t.y, w: me.w, h: me.h }
    if (traded && (home || centreDist2(traded.landing, aim) <= centreDist2({ x: T.x, y: T.y, w: me.w, h: me.h }, aim))) return traded
  }
  if (home) return homePlan(a, items, me)
  return movePlan(a, items, id, shove.items, a.sizes, "beside")
}

const overlapArea = (a: Rect, b: Rect) =>
  max(0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x)) * max(0, min(a.y + a.h, b.y + b.h) - max(a.y, b.y))

// Let go mostly over a bigger widget that has no room to move into (the cat
// over the radio on a full desk), the two trade sides: the bigger one steps
// over toward where the dragged one came from, and the rest make room as if
// it had been dragged there itself. Then the dragged one is set down as near
// where it was let go as its new side allows (the row under the hand, say).
// null when that doesn't bring the dragged widget anywhere new, or would push
// someone past the rows the desk reaches.
function sideSwap(a: Arrangement, items: Placed[], me: Placed, t: Slot, cols: number, view: number): Plan | null {
  const rect: Rect = { x: t.x, y: t.y, w: me.w, h: me.h }
  let big: Placed | null = null, most = 0
  for (const it of items) {
    if (it.id === me.id || it.pinned || areaOf(it) <= areaOf(me)) continue
    const o = overlapArea(it, rect)
    if (o > most) { most = o; big = it }
  }
  if (!big || most * 2 < areaOf(me)) return null
  const beside = me.x >= big.x + big.w || me.x + me.w <= big.x
  const to = beside
    ? { x: big.x + (me.x > big.x ? me.w : -me.w), y: big.y }
    : { x: big.x, y: big.y + (me.y > big.y ? me.h : -me.h) }
  const p = planDrop(a, big.id, to, cols, view, 1)
  if (!p || p.kind === "home") return null
  const limit = max(view, deepest(items))
  const inRows = (plan: Plan) => {
    for (const it of plan.items) if (it.y + it.h > limit) return false
    return true
  }
  // (never by sending the bigger one back: that would undo the trade)
  const stepped = find(p.items, big.id)!
  const near = planDrop(p.arrangement, me.id, t, cols, view, 1)
  const back = near ? find(near.items, big.id) : null
  const q = near && near.kind === "move" && inRows(near) && back && back.x === stepped.x && back.y === stepped.y ? near : p
  const landing = find(q.items, me.id)
  if (!landing || (landing.x === me.x && landing.y === me.y) || !inRows(q)) return null
  return { ...q, landing, kind: "move", rule: "trade", moved: movedFrom(indexById(items), q.items, me.id, landing) }
}

// a tile carried out of the drawer: the same rule with no spot of its own, so
// the widgets it covers have no room to move over into and are pushed down
export function planInsert(a: Arrangement, id: string, size: SizeId, target: Slot, cols: number, view = 0): Plan {
  const c = max(1, cols)
  const sizes = copySizes(a.sizes)
  sizes[id] = size
  const rest: Arrangement = { order: uniq(a.order).filter((other) => other !== id), sizes, at: withoutKey(copySlots(a.at), id), pins: withoutKey(copyPins(a.pins), id) }
  const items = layoutOf(rest, c)
  const fp = footprint(size, c)
  const t = slotIn(target, { x: 0, y: deepest(items) }, fp, c)
  const { shove, slid } = landIn(items, id, t, fp, null, c, max(view, deepest(items)))
  return movePlan(rest, items, id, shove.items, sizes, slid ? "beside" : "exact")
}

// --- keyboard ---

export type KeyMove = "left" | "right" | "up" | "down" | "first" | "last"
// why a step went nowhere: the board's edge, a pinned widget in the way, or a
// widget that won't budge (bigger, with no room to move over into)
export type KeyResist = "edge" | "pin" | "blocked"
export interface KeyResult {
  plan: Plan | null
  resist: KeyResist | null
  // the pin that blocked it (itself, when the lifted widget is the pinned one),
  // or the widget that wouldn't budge
  by: string | null
}
const STEP: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }
const resisted = (resist: KeyResist | null, by: string | null): KeyResult => ({ plan: null, resist, by })

// One step for a lifted widget. The arrows move it a slot that way, Home and
// End to the start and end of its row; each is a drop on that spot, so the
// widgets it covers make room. A widget that won't budge is stepped past: the
// arrows go on to the next spot that way that takes it, Home and End come back
// toward it. It resists at the board's edge, at a pin, and when nothing that
// way takes it, rather than sliding somewhere surprising. `from`: the preview
// so far (null: where it was picked up), so steps add up. Where it goes adds
// up from the preview, but the drop is planned from the pickup snapshot, as a
// drag's is: stepping past a widget and back puts that widget back too (no melt).
export function planKey(a: Arrangement, id: string, from: Plan | null, k: KeyMove, cols: number, view = 0): KeyResult {
  const c = max(1, cols)
  const base = from ? from.arrangement : a
  const items = layoutOf(base, c)
  const me = find(items, id)
  if (!me) return resisted(null, null)
  if (me.pinned) return resisted("pin", id)
  const step = own(STEP, k)
  // down can always find a row: one past the deepest widget, no further
  const maxY = max(0, deepest(items) + SPARE_ROWS - me.h)
  const T = step ? { x: me.x + step[0], y: me.y + step[1] } : { x: k === "first" ? 0 : c - me.w, y: me.y }
  const off = (x: number, y: number) => x < 0 || x > c - me.w || y < 0 || y > maxY || (x === me.x && y === me.y)
  if (off(T.x, T.y)) return resisted("edge", null)
  const pickup = layoutOf(a, c)
  const was = find(pickup, id)
  if (!was) return resisted(null, null)
  const limit = max(view, deepest(pickup))
  const [dx, dy] = step ?? [T.x < me.x ? 1 : -1, 0]
  let by: string | null = null
  for (let x = T.x, y = T.y; !off(x, y); x += dx, y += dy) {
    const rect: Rect = { x, y, w: me.w, h: me.h }
    for (const it of readingOrder(items)) if (it.pinned && overlaps(it, rect)) return resisted("pin", it.id)
    if (x === was.x && y === was.y) return { plan: homePlan(a, pickup, was), resist: null, by: null }
    const s = displace(pickup, id, rect, was, was, c, limit)
    if (!s.blocked && !s.deep) return { plan: movePlan(a, pickup, id, s.items, a.sizes, "exact"), resist: null, by: null }
    by = by ?? s.blocked ?? s.deep
  }
  return resisted("blocked", by)
}

// --- resize, pins, the drawer ---

// A global size change, grown in place: it keeps its top-left (clamped into
// the columns), and the unpinned widgets it now covers are pushed down their
// columns, taking the ones under them along. Only a pin in the way moves it:
// then it takes the nearest free spot and nobody else moves. Pins, its own
// included, are respected.
export function planResize(a: Arrangement, id: string, size: SizeId, cols: number): Plan | null {
  const c = max(1, cols)
  const items = layoutOf(a, c)
  const me = find(items, id)
  if (!me) return null
  const sizes = copySizes(a.sizes)
  sizes[id] = size
  const fp = footprint(size, c)
  const x = clamp(me.x, 0, c - fp.w)
  let next: Placed[]
  if (fits(pinRowsOf(items, id), x, me.y, fp.w, fp.h, c)) {
    next = displace(items, id, { x, y: me.y }, fp, null, c, Infinity).items.map((it) => (it.id === id ? { ...it, pinned: me.pinned } : it))
  } else {
    const rows: Rows = []
    for (const it of items) if (it.id !== id) put(rows, it.x, it.y, it.w, it.h)
    const spot = nearestIn(rows, x, me.y, fp.w, fp.h, c)
    next = []
    for (const it of items) next.push(it.id === id ? { id, x: spot.x, y: spot.y, w: fp.w, h: fp.h, pinned: me.pinned } : it)
  }
  const sorted = readingOrder(next)
  const landing = find(sorted, id)!
  return {
    arrangement: arrangeFrom(a, sorted, sizes, copyPins(a.pins)),
    items: sorted, landing, kind: "move", rule: "step", moved: movedFrom(indexById(items), sorted, id, landing),
  }
}

// the tack: on or off at its current spot, and nothing moves either way
export function planPin(a: Arrangement, id: string, on: boolean, cols: number): Plan | null {
  const c = max(1, cols)
  const items = layoutOf(a, c)
  const me = find(items, id)
  if (!me) return null
  const pins = copyPins(a.pins)
  if (on) pins[id] = true
  else delete pins[id]
  const next: Placed[] = []
  for (const it of items) next.push(it.id === id ? { id, x: me.x, y: me.y, w: me.w, h: me.h, pinned: on } : it)
  return {
    arrangement: arrangeFrom(a, next, a.sizes, pins, uniq(a.order)),
    items: next, landing: find(next, id)!, kind: "move", rule: "step", moved: [],
  }
}

// Tidy up: gravity. In reading order every unpinned widget rises to the
// smallest row it fits in, keeping its column; the pins stay where they are.
export function planTidy(a: Arrangement, cols: number): Reflow {
  const c = max(1, cols)
  const items = layoutOf(a, c)
  const rows = pinRowsOf(items, "")
  const out: Placed[] = []
  for (const it of readingOrder(items)) {
    if (it.pinned) { out.push(it); continue }
    let y = 0
    while (!fits(rows, it.x, y, it.w, it.h, c)) y++
    put(rows, it.x, y, it.w, it.h)
    out.push({ id: it.id, x: it.x, y, w: it.w, h: it.h, pinned: false })
  }
  const sorted = readingOrder(out)
  return {
    arrangement: arrangeFrom(a, sorted, a.sizes, copyPins(a.pins)),
    items: sorted, moved: movedFrom(indexById(items), sorted, "", null),
  }
}

// A widget taken out of the drawer: back on its remembered spot in this bucket
// if that spot is free, else the first free spot inside the rows in view, else
// just below everything (the desk scrolls to it). `near`: the free spot
// nearest that widget instead.
export function planTakeOut(a: Arrangement, id: string, size: SizeId, cols: number,
                            o?: { at?: Slot | null; near?: string | null; rows?: number }): Plan {
  const c = max(1, cols)
  const sizes = copySizes(a.sizes)
  sizes[id] = size
  const rest: Arrangement = { order: uniq(a.order).filter((other) => other !== id), sizes, at: withoutKey(copySlots(a.at), id), pins: withoutKey(copyPins(a.pins), id) }
  const items = layoutOf(rest, c)
  const fp = footprint(size, c)
  const rows = rowsOf(items)
  const beside = o && o.near ? find(items, o.near) : null
  const kept = o && finiteSlot(o.at) ? slotIn(o.at, { x: 0, y: 0 }, fp, c) : null
  let spot: Slot | null = null, rule: PlanRule = "step"
  if (beside) spot = nearestIn(rows, beside.x, beside.y, fp.w, fp.h, c)
  else if (kept && fits(rows, kept.x, kept.y, fp.w, fp.h, c)) spot = kept
  if (!spot) {
    const view = o && finite(o.rows) ? o.rows : deepest(items)
    spot = firstIn(rows, fp.w, fp.h, c, max(fp.h, view))
    // past the fold: the first free spot under it in reading order, so a few
    // taken out in a row fill the row below the desk instead of stacking a
    // tower down its left edge (rows past the last are free, so one is found)
    if (!spot) { spot = firstIn(rows, fp.w, fp.h, c, rows.length + fp.h + 1) || { x: 0, y: deepest(items) }; rule = "below" }
  }
  const next = readingOrder(items.concat([{ id, x: spot.x, y: spot.y, w: fp.w, h: fp.h, pinned: false }]))
  return {
    arrangement: arrangeFrom(rest, next, sizes, copyPins(rest.pins)),
    items: next, landing: find(next, id)!, kind: "move", rule, moved: [],
  }
}

// put away: nobody closes up behind it, and its spot here is remembered for
// when it comes back
export function planPutAway(a: Arrangement, id: string, cols: number): Reflow {
  const c = max(1, cols)
  const items = layoutOf(a, c)
  const was = find(items, id)
  const at = copySlots(a.at)
  for (const it of items) at[it.id] = { x: it.x, y: it.y }
  const kept: Placed[] = []
  for (const it of items) if (it.id !== id) kept.push(it)
  return {
    arrangement: { order: orderOf(kept), sizes: a.sizes, at, pins: withoutKey(copyPins(a.pins), id) },
    items: kept, moved: movedFrom(indexById(items), kept, id, was),
  }
}

// The desk's order folded back into the order of every widget: the places the
// desk's widgets held are refilled in the desk's order, so a widget in the
// drawer keeps its place; newcomers go last.
export function mergeOrder(all: string[], desk: string[]): string[] {
  const onDesk: Record<string, true> = {}
  const queue: string[] = []
  for (const id of desk) if (!own(onDesk, id)) { onDesk[id] = true; queue.push(id) }
  const out: string[] = []
  const seen: Record<string, true> = {}
  let next = 0
  for (const id of all) {
    if (own(seen, id)) continue
    seen[id] = true
    if (own(onDesk, id)) out.push(queue[next++])
    else out.push(id)
  }
  while (next < queue.length) out.push(queue[next++])
  return out
}

// --- motion helpers ---

// A delay per moved neighbour so the reflow ripples outward from the landing:
// perSlotMs per whole slot of distance between centres, capped.
export function rippleDelays(items: Placed[], landing: Rect, moved: string[], perSlotMs = 24, maxMs = 120): Record<string, number> {
  const byId = indexById(items)
  const out: Record<string, number> = {}
  for (const id of moved) {
    const it = own(byId, id)
    out[id] = it ? min(maxMs, floor(sqrt(centreDist2(it, landing))) * perSlotMs) : 0
  }
  return out
}

// --- sizes ---

// what the engine and the save need to know about a widget type (the
// registry's definitions fit this as they are)
export interface TypeSpec { sizes: { id: SizeId }[]; defaultSize: SizeId; maxInstances: number }
export type Specs = Record<string, TypeSpec>

// the next of a widget's sizes (small to large) that way, or the same at the ends
export function sizeStep(sizes: SizeId[], current: SizeId, dir: 1 | -1): SizeId {
  if (!sizes.length) return current
  const i = sizes.indexOf(current)
  if (i < 0) {
    // not one of its sizes: the nearest of them that way by the vocabulary
    const rank = SIZE_IDS.indexOf(current)
    const list = dir > 0 ? sizes : sizes.slice().reverse()
    for (const s of list) if ((SIZE_IDS.indexOf(s) - rank) * dir > 0) return s
    return list[list.length - 1]
  }
  return sizes[clamp(i + dir, 0, sizes.length - 1)]
}
