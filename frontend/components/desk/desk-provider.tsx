"use client"

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"
import type { DropZone } from "@/components/desk/drag-controller"
import { scrollToShow } from "@/components/desk/show"
import { focusWidget as focusTakenOut } from "@/components/desk/toasts"
import { definitionOf, specsFor } from "@/components/desk/registry"
import type { DeskEvent, ShownDesk } from "@/components/desk/types"
import { layoutOf, own, planPutAway, planTakeOut, planTidy, type Arrangement, type Bucket, type SizeId, type Slot } from "@/lib/board"
import {
  arrangementOf, backupKeyFor, BOARD_KEY, BROKEN_KEY, FUTURE_KEY, defaultSave, knownTypes, parseBoard, serializeBoard, withArrangement,
  type BoardSave, type KnownTypes, type ParseStatus,
} from "@/lib/board-storage"

// What the desk component shows: which bucket is on screen and how many
// columns it has, for actions that plan on it (put away, take out, tidy).
export interface BoardView {
  bucket(): Bucket
  cols(): number
  // how many whole rows reach the fold, so a take-out can land in view
  rows(): number
  // the frames as last drawn, in reading order (a "layout" event says when they change)
  shown(): ShownDesk
}

// what the desk's drag controller lends everyone else (the drawer, the toasts)
export interface LiftControls {
  cancel(): void
  setArranging(reason: string, on: boolean): void
  setDropZone(zone: DropZone | null): void
  // a commit whose frames glide from where they were to where they land
  flip(commit: () => void): void
  // a widget just out of the drawer: it rises from where it came from (a
  // tile, whose picture rides along), and its footprint flashes on the lattice
  rise(id: string, from: DOMRect | null, art?: HTMLElement | null): void
}

// spoken: the live region already said it, so the toast shows it without
// reading it twice
export interface DeskToast { id: number; message: string; undo: (() => void) | null; widget: string | null; spoken: boolean }
// taking a widget out: at a size, near another, or (a carry out of the
// drawer) exactly the arrangement that was shown at the drop
export interface TakeOut {
  size?: SizeId
  near?: string
  arrangement?: Arrangement
  // said after where it went (who moved to make room for a drop)
  also?: string
}
type Hint = keyof NonNullable<BoardSave["hints"]>

export interface DeskApi {
  save: BoardSave
  loaded: boolean
  status: ParseStatus | null
  // on the desk and built, in reading order
  onDesk: string[]
  isOnDesk(id: string): boolean
  // a widget type this build has (its module exports a definition)
  isBuilt(type: string): boolean
  // every change below is one undoable step and is saved (debounced)
  change(next: (save: BoardSave) => BoardSave): void
  // a plan's arrangement for one bucket, as the engine made it
  commit(bucket: Bucket, a: Arrangement): void
  putAway(id: string): void
  takeOut(id: string, o?: TakeOut): void
  // takeOut from an event: its neighbours make room, it rises into place
  // (from a tile, if given), its spot flashes, it's brought into view, and
  // focus goes to its grip (unless focus: false, when it came out for
  // something else, like a task put on the desk)
  bringOut(id: string, o?: TakeOut & { from?: DOMRect | null; art?: HTMLElement | null; focus?: boolean }): void
  // gravity: everything unpinned rises as far as it fits
  tidy(): void
  reset(): void
  undo(): void
  redo(): void
  canUndo: boolean
  canRedo: boolean
  // remembered, but not undoable
  setHint(name: Hint): void
  focusWidget(id: string): void
  toast(message: string, o?: { undo?: true | (() => void); ms?: number; widget?: string; spoken?: true }): void
  currentToast: DeskToast | null
  dismissToast(): void
  // a pointer or focus resting on the toast keeps it up
  holdToast(on: boolean): void
  // the drawer sheet (the pull, D, the Menu, the empty desk)
  drawerOpen: boolean
  setDrawerOpen(open: boolean): void
  announce(text: string): void
  on(listener: (event: DeskEvent) => void): () => void
  emit(event: DeskEvent): void
  // the frames as the desk last drew them, for widgets that care where the
  // others are (the cat's neighbours); null before the desk has drawn
  shown(): ShownDesk | null
  // a drag or resize in progress: saving waits until it's over
  setSession(active: boolean): void
  // put back whatever is in hand (a dialog or the drawer opening over a lift)
  cancelLift(): void
  // the lattice for something other than a drag (the open drawer); it shows
  // while anyone asks for it
  setArranging(reason: string, on: boolean): void
  // somewhere a carried widget can be dropped to put it away (the pull)
  setDropZone(zone: DropZone | null): void
  registerLift(controls: LiftControls | null): void
  registerBoard(view: BoardView | null): void
  registerLive(el: HTMLElement | null): void
  // how long since this browser last had the desk open (lofai.seen)
  returnedAfterMs: number | null
  // someone who used lofAI before the desk: no board yet, but tasks or a theme
  welcome: boolean
  dismissWelcome(): void
  saveFailed: boolean
  brokenNotice: "unreadable" | "future" | null
  dismissBrokenNotice(): void
}

const DeskContext = createContext<DeskApi | null>(null)

const UNDO_STEPS = 20
const WRITE_MS = 300
const TOAST_MS = 6000
const ANNOUNCE_MS = 150
const SEEN_KEY = "lofai.seen"
const SEEN_EVERY_MS = 5 * 60 * 1000

// the name a sentence uses ("Task card is in the drawer."), which can differ from its title
const nameOf = (save: BoardSave, id: string) => {
  const def = definitionOf(own(save.instances, id)?.type ?? "")
  return def?.spokenName ?? def?.name ?? id
}
const modKey = () => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Control")

// built types this save doesn't mention yet (it's older than them) wait in
// the drawer, at their usual size, last in the order
function withBuilt(save: BoardSave, known: KnownTypes): BoardSave {
  const missing = Object.keys(known).filter((type) => !own(save.instances, type))
  if (!missing.length) return save
  const instances = { ...save.instances }
  const sizes = { ...save.sizes }
  const order = save.order.slice()
  for (const type of missing) {
    instances[type] = { type, onDesk: false }
    sizes[type] = known[type].defaultSize
    if (order.indexOf(type) < 0) order.push(type)
  }
  return { ...save, instances, sizes, order }
}

function readSeen(): number | null {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null")
    return seen && seen.v === 1 && typeof seen.at === "number" && isFinite(seen.at) ? seen.at : null
  } catch { return null }
}

// The desk's arrangement: which widgets are out, the reading-order memory,
// sizes, each bucket's own spots and pins, and the undo history. Widget data lives in its own
// providers, so nothing here ever destroys anything.
export function DeskProvider({ children }: { children: ReactNode }) {
  const known = useMemo(() => knownTypes(specsFor()), [])
  const [save, setSave] = useState<BoardSave>(() => withBuilt(defaultSave(0), known))
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<ParseStatus | null>(null)
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  const [currentToast, setCurrentToast] = useState<DeskToast | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [brokenNotice, setBrokenNotice] = useState<"unreadable" | "future" | null>(null)
  const [returnedAfterMs, setReturnedAfterMs] = useState<number | null>(null)
  const [welcome, setWelcome] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // actions read and write the latest save synchronously; state follows
  const saveRef = useRef(save)
  const stacks = useRef<{ undo: BoardSave[]; redo: BoardSave[] }>({ undo: [], redo: [] })
  const board = useRef<BoardView | null>(null)
  const lift = useRef<LiftControls | null>(null)
  const live = useRef<HTMLElement | null>(null)
  const listeners = useRef(new Set<(event: DeskEvent) => void>())
  const writeTimer = useRef(0)
  const toastTimer = useRef(0)
  const toastCount = useRef(0)
  const session = useRef(false)
  const pendingWrite = useRef(false)
  // an unreadable, future or v1 board is left as it was until someone really
  // changes the desk; a hint alone (the drawer opened) doesn't count
  const preserving = useRef(false)
  // an older save, kept as it was: its raw string is copied once to
  // lofai.board.v1 / lofai.board.v2 on the first v3 write
  const oldRaw = useRef<{ key: string; raw: string } | null>(null)
  const spoken = useRef({ at: 0, timer: 0, text: "", flip: false })

  // --- load (before paint, so the desk never shows the wrong arrangement) ---
  useLayoutEffect(() => {
    let raw: string | null = null
    let storage = true
    try { raw = localStorage.getItem(BOARD_KEY) } catch { storage = false }
    const parsed = parseBoard(raw, known)
    if (parsed.status === "unreadable" || parsed.status === "future") {
      // kept once, as it was, and never written over until someone changes the
      // desk. the notice comes with the stash, so it's said once, not every visit.
      // a newer lofAI's save has its own place, and a second different string
      // takes the next one, so an earlier stash never costs a later one
      const kind = parsed.status
      const base = kind === "future" ? FUTURE_KEY : BROKEN_KEY
      try {
        for (const key of [base, `${base}.2`, `${base}.3`]) {
          const kept = localStorage.getItem(key)
          if (kept === (raw ?? "")) break
          if (kept === null) {
            localStorage.setItem(key, raw ?? "")
            setBrokenNotice(kind)
            break
          }
        }
      } catch { /* still the usual desk */ }
    }
    const backup = parsed.migratedFrom !== null ? backupKeyFor(parsed.migratedFrom) : null
    if (backup && raw !== null) oldRaw.current = { key: backup, raw }
    const next = withBuilt(parsed.save ?? defaultSave(Date.now()), known)
    // a migrated save is left alone until someone really changes the desk
    preserving.current = parsed.status === "unreadable" || parsed.status === "future" || oldRaw.current !== null
    saveRef.current = next
    setSave(next)
    setStatus(parsed.status)
    // someone from before the desk: tasks or a theme, but never a desk. the
    // desk marks lofai.seen on every visit, so a new visitor's second visit isn't one
    if (storage && parsed.status === "empty") {
      try {
        setWelcome(localStorage.getItem(SEEN_KEY) === null &&
          (localStorage.getItem("todos") !== null || localStorage.getItem("lofai.theme") !== null))
      } catch { /* a first visit */ }
    }
    const seen = readSeen()
    if (seen !== null) setReturnedAfterMs(Math.max(0, Date.now() - seen))
    setLoaded(true)
  }, [known])

  // --- saving ---
  const write = useCallback(() => {
    window.clearTimeout(writeTimer.current)
    writeTimer.current = 0
    if (!pendingWrite.current || session.current) return
    pendingWrite.current = false
    try {
      // the older save is kept once, as it was, before v3 takes its key
      const old = oldRaw.current
      if (old !== null) {
        if (localStorage.getItem(old.key) === null) localStorage.setItem(old.key, old.raw)
        oldRaw.current = null
      }
      localStorage.setItem(BOARD_KEY, serializeBoard({ ...saveRef.current, savedAt: Date.now() }))
      setSaveFailed(false)
    } catch { setSaveFailed(true) }
  }, [])
  const scheduleWrite = useCallback(() => {
    pendingWrite.current = true
    window.clearTimeout(writeTimer.current)
    writeTimer.current = window.setTimeout(write, WRITE_MS)
  }, [write])

  useEffect(() => {
    const mark = () => { try { localStorage.setItem(SEEN_KEY, JSON.stringify({ v: 1, at: Date.now() })) } catch { /* only for the welcome back */ } }
    // leaving: the last change is saved now rather than lost to the debounce
    const leave = () => { write(); mark() }
    const onVisibility = () => { if (document.visibilityState === "hidden") leave() }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", leave)
    const every = window.setInterval(mark, SEEN_EVERY_MS)
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", leave)
      window.clearInterval(every)
    }
  }, [write])

  const syncHistory = useCallback(() => {
    setHistory({ undo: stacks.current.undo.length, redo: stacks.current.redo.length })
  }, [])

  // another tab saved the desk: take its arrangement rather than overwrite it
  // on our next write. a carry in progress finishes first
  const deferred = useRef<(() => void) | null>(null)
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== BOARD_KEY || event.newValue === null) return
      const parsed = parseBoard(event.newValue, known)
      if (parsed.save === null || parsed.status === "unreadable" || parsed.status === "future") return
      const adopt = () => {
        const next = withBuilt(parsed.save!, known)
        saveRef.current = next
        setSave(next)
        // this tab's history is for a desk that no longer exists
        stacks.current = { undo: [], redo: [] }
        syncHistory()
        // nothing to echo back
        pendingWrite.current = false
        window.clearTimeout(writeTimer.current)
        preserving.current = false
        oldRaw.current = null
      }
      if (session.current) deferred.current = adopt
      else adopt()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [known, syncHistory])

  const apply = useCallback((next: BoardSave, record = true) => {
    const prev = saveRef.current
    if (next === prev) return
    if (record) {
      preserving.current = false
      // a toast's button is for the step it came with; a newer step retires it
      window.clearTimeout(toastTimer.current)
      setCurrentToast(null)
      const h = stacks.current
      h.undo.push(prev)
      if (h.undo.length > UNDO_STEPS) h.undo.shift()
      h.redo = []
      syncHistory()
    }
    saveRef.current = next
    setSave(next)
    if (!preserving.current) scheduleWrite()
  }, [scheduleWrite, syncHistory])

  // --- telling people ---
  const announce = useCallback((text: string) => {
    const s = spoken.current
    s.text = text
    const say = () => {
      s.timer = 0
      s.at = Date.now()
      // the same words twice still count as news
      s.flip = !s.flip
      if (live.current) live.current.textContent = s.flip ? s.text : `${s.text} `
    }
    const wait = s.at + ANNOUNCE_MS - Date.now()
    if (wait <= 0) say()
    else if (!s.timer) s.timer = window.setTimeout(say, wait)
  }, [])

  // what moves glides into place. call these from events, not effects: the
  // commit is flushed at once so the frames can glide from where they were
  const animated = useCallback((fn: () => void) => {
    const controls = lift.current
    if (controls) controls.flip(() => flushSync(fn))
    else fn()
  }, [])

  // hints aren't part of the history: an undo never un-sees the drawer
  const restore = useCallback((from: "undo" | "redo") => {
    const h = stacks.current
    const target = h[from].pop()
    if (!target) return
    // a toast's button was for the step on top; once that step has moved, it's stale
    window.clearTimeout(toastTimer.current)
    setCurrentToast(null)
    const prev = saveRef.current
    h[from === "undo" ? "redo" : "undo"].push(prev)
    const next = { ...target, hints: prev.hints }
    saveRef.current = next
    setSave(next)
    scheduleWrite()
    syncHistory()
    // say what came back or went; anything else (a move, a size, a pin) is just undone
    const ids = Object.keys(next.instances)
    const back = ids.filter((id) => next.instances[id].onDesk && !own(prev.instances, id)?.onDesk)
    const gone = ids.filter((id) => !next.instances[id].onDesk && own(prev.instances, id)?.onDesk)
    announce(back.length === 1 && !gone.length ? `${nameOf(next, back[0])} is back on the desk.`
      : gone.length === 1 && !back.length ? `${nameOf(next, gone[0])} is in the drawer.`
      : from === "undo" ? "Undone." : "Redone.")
  }, [scheduleWrite, syncHistory, announce])
  const undo = useCallback(() => animated(() => restore("undo")), [animated, restore])
  const redo = useCallback(() => animated(() => restore("redo")), [animated, restore])

  const dismissToast = useCallback(() => {
    window.clearTimeout(toastTimer.current)
    setCurrentToast(null)
  }, [])
  const toastMs = useRef(TOAST_MS)
  const toast = useCallback((message: string, o: { undo?: true | (() => void); ms?: number; widget?: string; spoken?: true } = {}) => {
    window.clearTimeout(toastTimer.current)
    const undoWith = o.undo === true ? undo : o.undo ?? null
    setCurrentToast({ id: ++toastCount.current, message, undo: undoWith, widget: o.widget ?? null, spoken: !!o.spoken })
    toastMs.current = o.ms ?? TOAST_MS
    toastTimer.current = window.setTimeout(() => setCurrentToast(null), toastMs.current)
  }, [undo])
  // resting on it holds it; letting go gives it its time again
  const holdToast = useCallback((on: boolean) => {
    window.clearTimeout(toastTimer.current)
    if (!on) toastTimer.current = window.setTimeout(() => setCurrentToast(null), toastMs.current)
  }, [])

  const on = useCallback((listener: (event: DeskEvent) => void) => {
    listeners.current.add(listener)
    return () => { listeners.current.delete(listener) }
  }, [])
  const emit = useCallback((event: DeskEvent) => {
    for (const listener of Array.from(listeners.current)) listener(event)
  }, [])

  // the bucket on screen and its columns (the usual desk before the desk has drawn)
  const where = useCallback(() => ({
    bucket: board.current?.bucket() ?? ("desk" as Bucket), cols: board.current?.cols() ?? 6, rows: board.current?.rows() ?? 4,
  }), [])

  // --- changes ---
  const change = useCallback((fn: (save: BoardSave) => BoardSave) => apply(fn(saveRef.current)), [apply])

  const commit = useCallback((bucket: Bucket, a: Arrangement) => {
    const s = saveRef.current
    const next = withArrangement(s, bucket, a, known, Date.now())
    if (a.order.length) next.emptyByChoice = false
    apply(next)
  }, [apply, known])

  const setHint = useCallback((name: Hint) => {
    const s = saveRef.current
    if (s.hints?.[name]) return
    apply({ ...s, hints: { ...s.hints, [name]: true } }, false)
  }, [apply])

  // into the drawer: nobody closes up behind it, and its place in the order,
  // its size and the spot it held here stay in the save for when it comes back
  const putAway = useCallback((id: string) => {
    const s = saveRef.current
    const inst = own(s.instances, id)
    if (!inst || !inst.onDesk) return
    const { bucket, cols } = where()
    const a = arrangementOf(s, bucket, known)
    let next: BoardSave
    if (a.order.indexOf(id) >= 0) next = withArrangement(s, bucket, planPutAway(a, id, cols).arrangement, known, Date.now())
    else next = { ...s, instances: { ...s.instances, [id]: { ...inst, onDesk: false } } }
    next.emptyByChoice = arrangementOf(next, bucket, known).order.length === 0
    apply(next)
    emit({ kind: "put-away", id })
    const name = nameOf(s, id)
    announce(`${name} is in the drawer. Press ${modKey()} Z to bring it back.`)
    toast(`${name} is in the drawer.`, { undo: true, widget: id, spoken: true })
  }, [apply, emit, announce, toast, known, where])

  // out of the drawer: back on the spot it held here if that's still free,
  // else the first free spot in view (or exactly as a carry showed it)
  const takeOut = useCallback((id: string, o: TakeOut = {}) => {
    const s = saveRef.current
    const inst = own(s.instances, id)
    const def = inst ? definitionOf(inst.type) : null
    if (!inst || inst.onDesk || !def) return
    const { bucket, cols, rows } = where()
    let a = o.arrangement
    if (!a || a.order.indexOf(id) < 0) {
      const ok = (size: SizeId | undefined) => !!size && def.sizes.some((option) => option.id === size)
      const size = ok(o.size) ? o.size! : ok(own(s.sizes, id)) ? own(s.sizes, id)! : def.defaultSize
      const layout = s.layouts[bucket]
      const at: Slot | null = layout ? own(layout.at, id) ?? null : null
      a = planTakeOut(arrangementOf(s, bucket, known), id, size, cols, { at, near: o.near ?? null, rows }).arrangement
    }
    const next = withArrangement(s, bucket, a, known, Date.now())
    next.emptyByChoice = false
    apply(next)
    emit({ kind: "take-out", id })
    const at = layoutOf(a, cols).find((it) => it.id === id)
    const spot = at ? ` at column ${at.x + 1}, row ${at.y + 1}` : ""
    announce(`${def.spokenName ?? def.name} is on the desk${spot}.${o.also ?? ""}`)
  }, [apply, emit, announce, known, where])

  // focus lands on the grip, or on what the widget marks for it (a notebook's page)
  const focusGrip = useCallback((id: string) => { focusTakenOut(id) }, [])

  const bringOut = useCallback((id: string, o: TakeOut & { from?: DOMRect | null; art?: HTMLElement | null; focus?: boolean } = {}) => {
    animated(() => takeOut(id, o))
    if (!own(saveRef.current.instances, id)?.onDesk) return
    // out past the fold: into view before it rises, at once, so the rise
    // starts from where it will be seen
    const frame = document.getElementById(`widget-${id}`)
    const dy = frame ? scrollToShow(frame) : 0
    if (dy) window.scrollBy({ top: dy, behavior: "instant" })
    lift.current?.rise(id, o.from ?? null, o.art ?? null)
    if (o.focus !== false) focusGrip(id)
  }, [animated, takeOut, focusGrip])

  // Tidy up: gravity. Every unpinned widget in this bucket rises as far as it
  // fits, keeping its column; the pins stay. Nothing moves: no step to undo
  const tidy = useCallback(() => {
    const s = saveRef.current
    const { bucket, cols } = where()
    const plan = planTidy(arrangementOf(s, bucket, known), cols)
    if (!plan.moved.length) {
      announce("Already tidy.")
      return
    }
    animated(() => {
      apply(withArrangement(s, bucket, plan.arrangement, known, Date.now()))
      announce("Tidied up.")
      toast("Tidied up.", { undo: true, spoken: true })
    })
  }, [animated, apply, announce, toast, known, where])

  // the usual desk in every bucket. types this build doesn't know stay kept, in the drawer
  const reset = useCallback(() => {
    const s = saveRef.current
    const base = withBuilt(defaultSave(Date.now()), known)
    const instances = { ...base.instances }
    const order = base.order.slice()
    for (const id of Object.keys(s.instances)) {
      if (own(instances, id)) continue
      instances[id] = { ...s.instances[id], onDesk: false }
      order.push(id)
    }
    animated(() => {
      apply({ ...base, instances, order, hints: s.hints })
      announce("The usual desk is back.")
      toast("The usual desk is back.", { undo: true, spoken: true })
    })
  }, [animated, apply, announce, toast, known])

  // on the desk: bring it into view and focus it; in the drawer: take it out
  const focusWidget = useCallback((id: string) => {
    if (!own(saveRef.current.instances, id)?.onDesk) { bringOut(id); return }
    const frame = document.getElementById(`widget-${id}`)
    frame?.focus({ preventScroll: true })
    frame?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }, [bringOut])

  const setSession = useCallback((active: boolean) => {
    session.current = active
    if (!active && deferred.current) {
      const adopt = deferred.current
      deferred.current = null
      adopt()
    }
    if (!active && pendingWrite.current) scheduleWrite()
  }, [scheduleWrite])
  const registerBoard = useCallback((view: BoardView | null) => { board.current = view }, [])
  const shown = useCallback(() => board.current?.shown() ?? null, [])
  const registerLift = useCallback((controls: LiftControls | null) => { lift.current = controls }, [])
  const cancelLift = useCallback(() => { lift.current?.cancel() }, [])
  const setArranging = useCallback((reason: string, on: boolean) => { lift.current?.setArranging(reason, on) }, [])
  const setDropZone = useCallback((zone: DropZone | null) => { lift.current?.setDropZone(zone) }, [])
  const registerLive = useCallback((el: HTMLElement | null) => { live.current = el }, [])
  const dismissBrokenNotice = useCallback(() => setBrokenNotice(null), [])
  const dismissWelcome = useCallback(() => {
    setWelcome(false)
    setHint("welcomed")
  }, [setHint])

  // on the desk in every bucket alike: membership is global
  const onDesk = useMemo(() => arrangementOf(save, "desk", known).order, [save, known])
  const isOnDesk = useCallback((id: string) => onDesk.indexOf(id) >= 0, [onDesk])
  const isBuilt = useCallback((type: string) => !!definitionOf(type), [])

  const api = useMemo<DeskApi>(() => ({
    save, loaded, status, onDesk, isOnDesk, isBuilt,
    change, commit, putAway, takeOut, bringOut, tidy, reset,
    undo, redo, canUndo: history.undo > 0, canRedo: history.redo > 0,
    setHint, focusWidget, toast, currentToast, dismissToast, holdToast, drawerOpen, setDrawerOpen, announce, on, emit, shown,
    setSession, cancelLift, setArranging, setDropZone, registerLift, registerBoard, registerLive,
    returnedAfterMs, welcome, dismissWelcome, saveFailed, brokenNotice, dismissBrokenNotice,
  }), [save, loaded, status, onDesk, isOnDesk, isBuilt, change, commit, putAway, takeOut, bringOut, tidy, reset,
    undo, redo, history, setHint, focusWidget, toast, currentToast, dismissToast, holdToast, drawerOpen, announce, on, emit, shown,
    setSession, cancelLift, setArranging, setDropZone, registerLift, registerBoard, registerLive, returnedAfterMs, welcome, dismissWelcome,
    saveFailed, brokenNotice, dismissBrokenNotice])

  return <DeskContext.Provider value={api}>{children}</DeskContext.Provider>
}

export function useDesk(): DeskApi {
  const api = useContext(DeskContext)
  if (!api) throw new Error("useDesk must be used within DeskProvider")
  return api
}
