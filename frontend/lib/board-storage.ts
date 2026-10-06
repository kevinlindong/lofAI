// The saved desk, v3. parseBoard never throws: anything it can't read comes
// back as a status and the desk falls back to the usual layout. Unknown widget
// types are kept (not rendered) so a downgrade never loses them. v1 saves
// (measured rows, the separate Sound widget) and v2 saves (a flow order with
// auto-pins) both migrate to free placement: membership and sizes survive, the
// layouts don't, so the v3 defaults take over.
import { BUCKETS, MAX_ROW, mergeOrder, own } from "./board"
import type { Arrangement, Bucket, SizeId, Slot, Specs } from "./board"
import { deriveAt, DEFAULT_ON_DESK, DEFAULT_ORDER, DEFAULT_SIZES } from "./board-defaults"

export const BOARD_KEY = "lofai.board"
export const BROKEN_KEY = "lofai.board.broken"
// a save from a newer lofAI, kept apart from unreadable ones
export const FUTURE_KEY = "lofai.board.future"
// the raw older string, copied once on the first v3 write
export const V1_BACKUP_KEY = "lofai.board.v1"
export const V2_BACKUP_KEY = "lofai.board.v2"
export const BOARD_VERSION = 3

// one bucket's layout: where its widgets sit (a widget in the drawer keeps its
// entry, which is the spot it comes back to) and which of them are pinned
export interface SavedLayout { at: Record<string, Slot>; pins: string[] }

export interface BoardSave {
  v: 3
  // every instance, out or in the drawer
  instances: Record<string, { type: string; onDesk: boolean }>
  // every instance id, in reading-order memory: the drawer's order, and what a
  // bucket nobody has arranged yet derives its spots from
  order: string[]
  // every instance of a known type, kept while it's in the drawer
  sizes: Record<string, SizeId>
  // present once that bucket has been arranged; arranging one never touches another
  layouts: Partial<Record<Bucket, SavedLayout>>
  emptyByChoice?: boolean
  hints?: { drawerOpened?: true; welcomed?: true; deskTaskPlaced?: true }
  savedAt: number
}

export interface KnownTypes { [type: string]: { sizes: SizeId[]; defaultSize: SizeId; maxInstances: number } }
export type ParseStatus = "empty" | "ok" | "repaired" | "unreadable" | "future"
export interface Parsed { save: BoardSave | null; status: ParseStatus; migratedFrom: number | null }

const ID = /^[a-z0-9-]{1,40}$/
const HINTS = ["drawerOpened", "welcomed", "deskTaskPlaced"] as const
const TOP_KEYS = ["v", "instances", "order", "sizes", "layouts", "emptyByChoice", "hints", "savedAt"]
const SIZES: string[] = ["s", "m", "l", "w", "xl"]
// a spot's column: 0 to the widest board's last
const MAX_X = 5

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === "number" && isFinite(v)
const status = (s: ParseStatus): Parsed => ({ save: null, status: s, migratedFrom: null })

// where the raw string of an older save is kept, so nothing is lost
export function backupKeyFor(version: number): string | null {
  if (version === 1) return V1_BACKUP_KEY
  if (version === 2) return V2_BACKUP_KEY
  return null
}

// what parseBoard needs to know about the registry's widgets
export function knownTypes(specs: Specs): KnownTypes {
  const known: KnownTypes = {}
  for (const type of Object.keys(specs)) {
    const spec = specs[type]
    known[type] = { sizes: spec.sizes.map((s) => s.id), defaultSize: spec.defaultSize, maxInstances: spec.maxInstances }
  }
  return known
}

export function defaultSave(now: number): BoardSave {
  const instances: BoardSave["instances"] = {}
  const sizes: Record<string, SizeId> = {}
  for (const id of DEFAULT_ORDER) {
    instances[id] = { type: id, onDesk: DEFAULT_ON_DESK.indexOf(id) >= 0 }
    sizes[id] = DEFAULT_SIZES[id]
  }
  // no layouts: every bucket starts from its default spots
  return { v: 3, instances, order: DEFAULT_ORDER.slice(), sizes, layouts: {}, savedAt: now }
}

// --- v1 → v3 ---

// v1 sizes by type (the v1 registry's ids) to the standard ones; the radio is
// not here because the full card is now its default at every size it had
const V1_SIZES: Record<string, Record<string, SizeId>> = {
  tasks: { s: "l", m: "l", l: "l" },
  timer: { s: "s", m: "m" },
  cat: { s: "s", m: "m", l: "l" },
  "desk-task": { s: "s", m: "m" },
  notebook: { pocket: "m", page: "l" },
  clock: { time: "s", day: "m" },
  today: { m: "m" },
}
// the v1 usual desk's order, when a save has no layout to read one from
const V1_USUAL = ["radio", "sound", "tasks", "timer", "cat"]

// registry order for the ones no layout mentions: known types first
function registryRank(type: unknown): number {
  const i = typeof type === "string" ? DEFAULT_ORDER.indexOf(type) : -1
  return i < 0 ? DEFAULT_ORDER.length : i
}

function migrate1(old: any): any {
  if (!isObject(old)) return old
  const out: Json = { v: 3 }
  const inst = old.instances
  if (!isObject(inst)) {
    // nothing to read: parse says so
    out.instances = inst
    return out
  }

  // instances: all but Sound; Radio is out if either was
  let sound: { onDesk: boolean } | null = null
  for (const id of Object.keys(inst)) {
    const e = inst[id]
    if (isObject(e) && e.type === "sound" && !sound) sound = { onDesk: e.onDesk === true }
  }
  const soundOut = !!sound && sound.onDesk
  const instances: Json = {}
  let hasRadio = false
  for (const id of Object.keys(inst)) if (id === "radio" && isObject(inst[id]) && (inst[id] as Json).type === "radio") hasRadio = true
  for (const id of Object.keys(inst)) {
    const e = inst[id]
    if (!ID.test(id)) continue
    if ((isObject(e) && e.type === "sound") || id === "sound") {
      // Sound's place goes to Radio when there was no Radio
      if (sound && !hasRadio && !own(instances, "radio")) instances.radio = { type: "radio", onDesk: soundOut }
      continue
    }
    if (id === "radio") {
      if (hasRadio) instances.radio = { type: "radio", onDesk: (e as Json).onDesk === true || soundOut }
      // not a radio at all: Sound's becomes the one
      if (hasRadio || sound) continue
    }
    instances[id] = isObject(e) ? { type: e.type, onDesk: e.onDesk } : e
  }
  const typeOf = (id: string) => {
    const e = own(instances, id)
    return isObject(e) && typeof e.type === "string" ? e.type : null
  }
  const onDesk = (id: string) => {
    const e = own(instances, id)
    return isObject(e) && e.onDesk === true
  }

  // order: the desk layout's reading order (else compact's, else the stack's,
  // else the v1 usual), Sound read as Radio; then the rest, out first
  const layouts = isObject(old.layouts) ? old.layouts : {}
  const itemsOf = (bucket: string): Json[] | null => {
    const layout = own(layouts, bucket)
    if (!isObject(layout) || !Array.isArray(layout.items)) return null
    const items = layout.items.filter((p: unknown): p is Json => isObject(p) && typeof p.id === "string")
    return items.length ? items : null
  }
  const desk = itemsOf("desk"), compact = itemsOf("compact")
  const num = (v: unknown) => (finite(v) ? v : 0)
  const reading = (items: Json[]) => items.map((p, i) => ({ id: p.id as string, x: num(p.x), y: num(p.y), i }))
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.i - b.i)
    .map((p) => p.id)
  let seq: string[]
  const stack = isObject(old.stack) && Array.isArray(old.stack.order) ? old.stack.order.filter((id: unknown) => typeof id === "string") : []
  if (desk) seq = reading(desk)
  else if (compact) seq = reading(compact)
  else if (stack.length) seq = stack
  else seq = V1_USUAL
  const order: string[] = []
  const add = (id: string) => { if (own(instances, id) && order.indexOf(id) < 0) order.push(id) }
  for (const id of seq) add(id === "sound" ? "radio" : id)
  const rest = Object.keys(instances).filter((id) => order.indexOf(id) < 0)
  const keyIndex = (id: string) => rest.indexOf(id)
  rest.sort((a, b) => (onDesk(a) === onDesk(b) ? 0 : onDesk(a) ? -1 : 1) || registryRank(typeOf(a)) - registryRank(typeOf(b)) || keyIndex(a) - keyIndex(b))
  for (const id of rest) add(id)
  out.instances = instances
  out.order = order

  // sizes: the v1 size from the desk layout, else compact, else where it was
  // remembered, mapped to the standard ones; the radio becomes the full card
  const remembered = isObject(old.remembered) ? old.remembered : {}
  const v1Size = (id: string): string | null => {
    for (const items of [desk, compact]) {
      if (!items) continue
      for (const p of items) if (p.id === id && typeof p.size === "string") return p.size
    }
    for (const bucket of ["desk", "compact"]) {
      const spots = own(remembered, bucket)
      const spot = isObject(spots) ? own(spots, id) : undefined
      if (isObject(spot) && typeof spot.size === "string") return spot.size
    }
    return null
  }
  const sizes: Json = {}
  for (const id of order) {
    const type = typeOf(id)
    if (!type) continue
    if (type === "radio") { sizes[id] = "xl"; continue }
    const table = own(V1_SIZES, type)
    if (!table) continue
    const was = v1Size(id)
    const mapped = was !== null ? own(table, was) : undefined
    sizes[id] = mapped ?? own(DEFAULT_SIZES, type)
  }
  out.sizes = sizes
  // v1 measured rows and pinned nothing: the v3 defaults take over
  out.layouts = {}

  if (old.emptyByChoice !== undefined) out.emptyByChoice = old.emptyByChoice
  if (old.hints !== undefined) out.hints = isObject(old.hints) ? { ...old.hints } : old.hints
  if (old.savedAt !== undefined) out.savedAt = old.savedAt
  return out
}

// --- v2 → v3 ---

// Membership and the sizes survive. Every v2 layout and pin goes: they were
// flow layouts with the auto-pins the user didn't ask for, so the new defaults
// take over.
function migrate2(old: any): any {
  if (!isObject(old)) return old
  const out: Json = { v: 3 }
  const inst = old.instances
  if (!isObject(inst)) {
    out.instances = inst
    return out
  }
  const instances: Json = {}
  for (const id of Object.keys(inst)) {
    const e = inst[id]
    instances[id] = isObject(e) ? { type: e.type, onDesk: e.onDesk } : e
  }
  out.instances = instances
  out.order = Array.isArray(old.order) ? old.order.slice() : old.order
  // the v2 vocabulary is a subset of v3's; the radio's "xl" is the full card now
  if (isObject(old.sizes)) {
    const sizes: Json = {}
    for (const id of Object.keys(old.sizes)) sizes[id] = old.sizes[id]
    out.sizes = sizes
  } else out.sizes = old.sizes
  out.layouts = {}
  if (old.emptyByChoice !== undefined) out.emptyByChoice = old.emptyByChoice
  // the hint behind v2's "Pinned it there" note goes with the auto-pins
  if (old.hints !== undefined) {
    if (isObject(old.hints)) {
      const hints: Json = {}
      for (const key of Object.keys(old.hints)) if (key !== "pinExplained") hints[key] = old.hints[key]
      out.hints = hints
    } else out.hints = old.hints
  }
  if (old.savedAt !== undefined) out.savedAt = old.savedAt
  return out
}

// keyed by the version they read; each goes straight to the current one and is
// pure (the input is never changed)
export const BOARD_MIGRATIONS: Record<number, (old: any) => any> = { 1: migrate1, 2: migrate2 }

// --- parse ---

export function parseBoard(raw: string | null, known: KnownTypes): Parsed {
  if (raw === null) return status("empty")
  try {
    return readBoard(raw, known)
  } catch {
    return status("unreadable")
  }
}

function readBoard(raw: string, known: KnownTypes): Parsed {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return status("unreadable")
  }
  if (!isObject(data)) return status("unreadable")
  const v = data.v
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return status("unreadable")
  if (v > BOARD_VERSION) return status("future")
  if (v < BOARD_VERSION) {
    const step = own(BOARD_MIGRATIONS as Record<string, (old: any) => any>, String(v))
    if (!step) return status("unreadable")
    data = step(data)
    if (!isObject(data)) return status("unreadable")
  }
  const d = data as Json
  if (!isObject(d.instances)) return status("unreadable")

  let repaired = Object.keys(d).some((key) => TOP_KEYS.indexOf(key) < 0)
  const fix = () => { repaired = true }

  // instances: valid ids, string types, singletons named after their type
  const instances: BoardSave["instances"] = {}
  const counts: Record<string, number> = {}
  for (const id of Object.keys(d.instances)) {
    const entry = d.instances[id]
    if (!ID.test(id) || !isObject(entry) || typeof entry.type !== "string") { fix(); continue }
    const spec = own(known, entry.type)
    if (spec) {
      const count = own(counts, entry.type) ?? 0
      if ((spec.maxInstances <= 1 && id !== entry.type) || count >= Math.max(1, spec.maxInstances)) { fix(); continue }
      counts[entry.type] = count + 1
    }
    if (typeof entry.onDesk !== "boolean" || Object.keys(entry).length !== 2) fix()
    instances[id] = { type: entry.type, onDesk: entry.onDesk === true }
  }
  const ids = Object.keys(instances)

  // order: every instance once, first occurrence wins; the missing ones go
  // last, the desk's first, in registry order
  const order: string[] = []
  const inOrder: Record<string, true> = {}
  if (Array.isArray(d.order)) {
    for (const id of d.order) {
      if (typeof id === "string" && own(instances, id) && !own(inOrder, id)) { inOrder[id] = true; order.push(id) }
      else fix()
    }
  } else fix()
  const types = Object.keys(known)
  const rank = (id: string) => {
    const i = types.indexOf(instances[id].type)
    return i < 0 ? types.length : i
  }
  const missing = ids.filter((id) => !own(inOrder, id))
  if (missing.length) {
    fix()
    missing.sort((a, b) => (instances[a].onDesk === instances[b].onDesk ? 0 : instances[a].onDesk ? -1 : 1) ||
      rank(a) - rank(b) || ids.indexOf(a) - ids.indexOf(b))
    for (const id of missing) order.push(id)
  }

  // sizes: known types need one of theirs (else their default); unknown types
  // keep a standard size or nothing
  const sizesIn = isObject(d.sizes) ? d.sizes : null
  if (!sizesIn) fix()
  else for (const id of Object.keys(sizesIn)) if (!own(instances, id)) fix()
  const sizes: Record<string, SizeId> = {}
  for (const id of order) {
    const value = sizesIn ? own(sizesIn, id) : undefined
    const spec = own(known, instances[id].type)
    if (spec) {
      if (typeof value === "string" && (spec.sizes as string[]).indexOf(value) >= 0) sizes[id] = value as SizeId
      else { fix(); sizes[id] = spec.defaultSize }
    } else if (value !== undefined) {
      if (typeof value === "string" && SIZES.indexOf(value) >= 0) sizes[id] = value as SizeId
      else fix()
    }
  }

  // layouts: known buckets; spots are whole slots on the board, named for
  // instances (a widget in the drawer may keep one); pins name instances
  const layouts: BoardSave["layouts"] = {}
  if (isObject(d.layouts)) {
    for (const bucket of Object.keys(d.layouts)) if ((BUCKETS as string[]).indexOf(bucket) < 0) fix()
    for (const bucket of BUCKETS) {
      const layout = own(d.layouts, bucket)
      if (layout === undefined) continue
      if (!isObject(layout)) { fix(); continue }
      for (const key of Object.keys(layout)) if (key !== "at" && key !== "pins") fix()
      const spots = layout.at
      const at: Record<string, Slot> = {}
      if (isObject(spots)) {
        for (const id of Object.keys(spots)) if (!own(instances, id)) fix()
        for (const id of order) {
          const p = own(spots, id)
          if (p === undefined) continue
          if (!isObject(p) || !finite(p.x) || !finite(p.y)) { fix(); continue }
          if (Object.keys(p).length !== 2) fix()
          const x = Math.min(Math.max(Math.round(p.x), 0), MAX_X), y = Math.min(Math.max(Math.round(p.y), 0), MAX_ROW)
          if (x !== p.x || y !== p.y) fix()
          at[id] = { x, y }
        }
      } else fix()
      const pins: string[] = []
      if (Array.isArray(layout.pins)) {
        const seen: Record<string, true> = {}
        for (const id of layout.pins) {
          if (typeof id === "string" && own(instances, id) && !own(seen, id)) { seen[id] = true } else fix()
        }
        // in reading-order memory, so equal saves serialize alike
        for (const id of order) if (own(seen, id)) pins.push(id)
      } else fix()
      layouts[bucket] = { at, pins }
    }
  } else fix()

  const save: BoardSave = { v: 3, instances, order, sizes, layouts, savedAt: 0 }

  if (d.emptyByChoice !== undefined) {
    if (typeof d.emptyByChoice === "boolean") save.emptyByChoice = d.emptyByChoice
    else fix()
  }

  if (d.hints !== undefined) {
    if (isObject(d.hints)) {
      const hints: NonNullable<BoardSave["hints"]> = {}
      for (const key of Object.keys(d.hints)) {
        const name = HINTS.find((hint) => hint === key)
        if (name && d.hints[key] === true) hints[name] = true
        else fix()
      }
      save.hints = hints
    } else fix()
  }

  if (finite(d.savedAt)) save.savedAt = d.savedAt
  else fix()

  return { save, status: repaired ? "repaired" : "ok", migratedFrom: v < BOARD_VERSION ? v : null }
}

// Fixed key order (as declared; sizes, spots and pins in reading-order
// memory), so equal saves serialize to equal strings. JSON.stringify leaves out
// the optional fields that are undefined.
export function serializeBoard(save: BoardSave): string {
  const instances: BoardSave["instances"] = {}
  for (const id of Object.keys(save.instances)) instances[id] = { type: save.instances[id].type, onDesk: save.instances[id].onDesk }
  const sizes: Record<string, SizeId> = {}
  for (const id of save.order) {
    const size = own(save.sizes, id)
    if (size !== undefined) sizes[id] = size
  }
  const layouts: BoardSave["layouts"] = {}
  for (const bucket of BUCKETS) {
    const layout = save.layouts[bucket]
    if (!layout) continue
    const at: Record<string, Slot> = {}
    for (const id of save.order) {
      const p = own(layout.at, id)
      if (p) at[id] = { x: p.x, y: p.y }
    }
    const pins: string[] = []
    for (const id of save.order) if (layout.pins.indexOf(id) >= 0) pins.push(id)
    layouts[bucket] = { at, pins }
  }
  let hints: BoardSave["hints"]
  if (save.hints) {
    hints = {}
    for (const name of HINTS) if (save.hints[name]) hints[name] = true
  }
  const out: BoardSave = {
    v: 3, instances, order: save.order.slice(), sizes, layouts, emptyByChoice: save.emptyByChoice, hints, savedAt: save.savedAt,
  }
  return JSON.stringify(out)
}

// --- the save and the engine ---

// One bucket's arrangement: the widgets that are out and of a type this build
// can render, their sizes (defaults where a size isn't theirs), their spots
// here and this bucket's pins. A bucket nobody has arranged yet takes its
// default spots, so editing one bucket never rewrites another. Spots
// remembered for widgets in the drawer come along, for when they come back.
export function arrangementOf(save: BoardSave, bucket: Bucket, known: KnownTypes): Arrangement {
  const order: string[] = []
  const sizes: Record<string, SizeId> = {}
  const add = (id: string) => {
    const inst = own(save.instances, id)
    const spec = inst && inst.onDesk ? own(known, inst.type) : undefined
    if (!spec || order.indexOf(id) >= 0) return
    order.push(id)
    const size = own(save.sizes, id)
    sizes[id] = size !== undefined && spec.sizes.indexOf(size) >= 0 ? size : spec.defaultSize
  }
  for (const id of save.order) add(id)
  for (const id of Object.keys(save.instances)) add(id)
  const layout = save.layouts[bucket]
  if (!layout) return { order, sizes, at: deriveAt(bucket, order, sizes), pins: {} }
  const at: Record<string, Slot> = {}
  for (const id of Object.keys(layout.at)) if (own(save.instances, id)) at[id] = { x: layout.at[id].x, y: layout.at[id].y }
  const pins: Record<string, true> = {}
  for (const id of layout.pins) if (order.indexOf(id) >= 0) pins[id] = true
  return { order, sizes, at, pins }
}

// A plan committed to the save. For the known types, the desk is exactly the
// arrangement's widgets (a known widget missing from it is in the drawer);
// unknown types are left as they are. The reading-order memory folds the desk's
// order back in (put-away widgets keep their places), its sizes are kept, and
// this bucket's layout becomes the arrangement's — no other bucket is touched.
export function withArrangement(save: BoardSave, bucket: Bucket, a: Arrangement, known: KnownTypes, now: number): BoardSave {
  const onDesk: Record<string, true> = {}
  for (const id of a.order) onDesk[id] = true
  const instances: BoardSave["instances"] = {}
  for (const id of Object.keys(save.instances)) {
    const inst = save.instances[id]
    instances[id] = { type: inst.type, onDesk: own(known, inst.type) ? !!own(onDesk, id) : inst.onDesk }
  }
  // singletons are named after their type
  for (const id of a.order) if (!own(instances, id)) instances[id] = { type: id, onDesk: true }
  const sizes: Record<string, SizeId> = {}
  for (const id of Object.keys(save.sizes)) sizes[id] = save.sizes[id]
  for (const id of a.order) {
    const size = own(a.sizes, id)
    if (size !== undefined) sizes[id] = size
  }
  const order = mergeOrder(save.order, a.order)
  const at: Record<string, Slot> = {}
  for (const id of order) {
    const p = own(a.at, id)
    if (!p || !own(instances, id)) continue
    at[id] = { x: Math.min(Math.max(Math.round(p.x), 0), MAX_X), y: Math.min(Math.max(Math.round(p.y), 0), MAX_ROW) }
  }
  const pins: string[] = []
  // a widget this build doesn't know keeps its pin, as its spot and size do
  const kept = save.layouts[bucket]?.pins ?? []
  for (const id of order) {
    const type = own(instances, id)?.type
    if (type !== undefined && !own(known, type)) { if (kept.indexOf(id) !== -1) pins.push(id); continue }
    if (own(a.pins, id) === true && own(onDesk, id)) pins.push(id)
  }
  const layouts: BoardSave["layouts"] = {}
  for (const b of BUCKETS) {
    const layout = save.layouts[b]
    if (b === bucket) layouts[b] = { at, pins }
    else if (layout) layouts[b] = layout
  }
  return { ...save, instances, order, sizes, layouts, savedAt: now }
}
