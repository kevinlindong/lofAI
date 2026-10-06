// The usual desk (desk v3): the old pre-widget composition, per bucket. The
// radio card holds the left (the top on a phone), and the cat, Tasks and the
// Focus timer come down the other side. Nothing is pinned, and each bucket has
// its own spots: arranging one never rewrites another.
import { colsOf, firstFree, footprint, overlaps, own, planTidy, type Arrangement, type Bucket, type Rect, type SizeId, type Slot } from "./board"

// registry order, which is the drawer's and the reading-order memory's start
export const DEFAULT_ORDER: string[] = ["radio", "tasks", "timer", "cat", "desk-task", "notebook", "clock", "today"]
export const DEFAULT_ON_DESK: string[] = ["radio", "tasks", "timer", "cat"]
export const DEFAULT_SIZES: Record<string, SizeId> = {
  radio: "xl", tasks: "l", timer: "m", cat: "m", "desk-task": "m", notebook: "m", clock: "s", today: "m",
}

// the spots the four usual widgets start on in each bucket
export const DEFAULT_AT: Record<Bucket, Record<string, Slot>> = {
  // radio full (4×4) on the left; cat, Tasks, timer stacked on the right
  desk: { radio: { x: 0, y: 0 }, cat: { x: 4, y: 0 }, tasks: { x: 4, y: 1 }, timer: { x: 4, y: 3 } },
  // the same at four columns, the radio in its tall form: it fits one screen
  // down to 740px, as the old page did above 960px
  compact: { radio: { x: 0, y: 0 }, cat: { x: 2, y: 0 }, tasks: { x: 2, y: 1 }, timer: { x: 2, y: 3 } },
  // one column of cards, the radio in its tall form
  phone: { radio: { x: 0, y: 0 }, cat: { x: 0, y: 4 }, tasks: { x: 0, y: 5 }, timer: { x: 0, y: 7 } },
}

const free = (taken: Rect[], rect: Rect) => {
  for (const r of taken) if (overlaps(r, rect)) return false
  return true
}

// A bucket nobody has arranged yet: the usual widgets take their default spots
// (at whatever size they are now, so one that no longer fits there flows
// instead), and anything else on the desk takes the first free spot in reading
// order. Then gravity, as Tidy up has it, so the gaps a shrunk or put-away
// widget leaves close up; the usual sizes are already tidy.
export function deriveAt(bucket: Bucket, order: string[], sizes: Record<string, SizeId>): Record<string, Slot> {
  const cols = colsOf(bucket)
  const table = own(DEFAULT_AT, bucket) ?? DEFAULT_AT.desk
  const at: Record<string, Slot> = {}
  const taken: Rect[] = []
  const rest: { id: string; w: number; h: number }[] = []
  const known: Record<string, SizeId> = {}
  for (const id of order) {
    if (own(at, id)) continue
    known[id] = own(sizes, id) ?? own(DEFAULT_SIZES, id) ?? "s"
    const { w, h } = footprint(known[id], cols)
    const spot = own(table, id)
    const rect: Rect = { x: spot ? Math.min(spot.x, Math.max(0, cols - w)) : 0, y: spot ? spot.y : 0, w, h }
    if (spot && free(taken, rect)) {
      taken.push(rect)
      at[id] = { x: rect.x, y: rect.y }
    } else rest.push({ id, w, h })
  }
  for (const it of rest) {
    if (own(at, it.id)) continue
    const spot = firstFree(taken, it.w, it.h, cols) ?? { x: 0, y: 0 }
    taken.push({ x: spot.x, y: spot.y, w: it.w, h: it.h })
    at[it.id] = spot
  }
  return planTidy({ order, sizes: known, at, pins: {} }, cols).arrangement.at
}

// the usual desk as the engine takes it (onDesk: which of the defaults are out)
export function defaultArrangement(bucket: Bucket = "desk", onDesk: string[] = DEFAULT_ON_DESK): Arrangement {
  const order = DEFAULT_ORDER.filter((id) => onDesk.indexOf(id) >= 0)
  const sizes: Record<string, SizeId> = {}
  for (const id of order) sizes[id] = DEFAULT_SIZES[id]
  return { order, sizes, at: deriveAt(bucket, order, sizes), pins: {} }
}
