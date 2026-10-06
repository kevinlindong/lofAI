"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { flushSync } from "react-dom"
import { useDesk, type BoardView } from "@/components/desk/desk-provider"
import { DragController, LEAVE_MS, LEAVE_REDUCED_MS, type DragHost } from "@/components/desk/drag-controller"
import { DeskDrawer } from "@/components/desk/drawer"
import { GripMenu } from "@/components/desk/grip-menu"
import { runToastUndo } from "@/components/desk/toasts"
import { definitionOf, sizeLabel, specsFor, surfaceOf } from "@/components/desk/registry"
import type { ShownDesk, ShownFrame, Surface, WidgetDefinition } from "@/components/desk/types"
import { menuItemsOf, TackHead, WidgetFrame } from "@/components/desk/widget-frame"
import { DotPattern } from "@/components/dot-glyph"
// the cat asleep, in dots: the same one napping in its drawer tile
import { SLEEPING } from "@/components/widgets/cat/art"
import {
  boardRows, contentSize, deepest, footprint, layoutOf, metricsFor, own,
  type Arrangement, type Bucket, type Form, type Metrics, type Placed, type SizeId,
} from "@/lib/board"
import { arrangementOf, knownTypes, type BoardSave, type KnownTypes } from "@/lib/board-storage"

// before the window is known (the static render), and hidden until it is
const FIRST_VIEW = { width: 1440, height: 800 }

interface Frame {
  id: string
  def: WidgetDefinition
  size: SizeId
  // the size whose content is drawn: W has no room of its own on a narrow board
  draw: SizeId
  form: Form
  surface: Surface
  x: number
  y: number
  w: number
  h: number
  pinned: boolean
}
interface Layout { save: BoardSave; bucket: Bucket; cols: number; a: Arrangement; items: Placed[]; frames: Frame[] }
// what re-renders the board: the bucket, its columns, and how many rows reach the fold
interface View { bucket: Bucket; cols: number; visibleRows: number }

let known: KnownTypes | null = null
const knownNow = () => known ?? (known = knownTypes(specsFor()))
// ⌘Z and friends wait while someone is typing
const TYPING = "input, textarea, select, [contenteditable], dialog"
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const viewOf = (m: Metrics): View => ({ bucket: m.bucket, cols: m.cols, visibleRows: m.visibleRows })

// The render pass: this bucket's arrangement (what's out, their sizes, their
// own spots here and this bucket's pins), drawn at those spots. Nothing is measured.
function computeLayout(save: BoardSave, view: View): Layout {
  const a = arrangementOf(save, view.bucket, knownNow())
  const items = layoutOf(a, view.cols)
  const frames: Frame[] = []
  // DOM order is reading order, so Tab walks the desk the way it reads
  for (const it of items) {
    const def = definitionOf(save.instances[it.id].type)
    if (!def) continue
    const size = own(a.sizes, it.id) ?? def.defaultSize
    const draw = contentSize(size, view.cols)
    frames.push({
      id: it.id, def, size, draw, form: footprint(size, view.cols).form, surface: surfaceOf(def, draw),
      x: it.x, y: it.y, w: it.w, h: it.h, pinned: it.pinned,
    })
  }
  return { save, bucket: view.bucket, cols: view.cols, a, items, frames }
}

// Nothing out: the lattice shows faintly, the music keeps going, and the
// drawer (or the usual desk) is a press away.
function EmptyDesk() {
  const { setDrawerOpen, reset } = useDesk()
  return (
    <div className="desk-empty">
      <span className="desk-empty-cat" aria-hidden><DotPattern rows={SLEEPING} dot={6} /></span>
      <p className="desk-empty-title">An empty desk. Nice.</p>
      <p className="desk-empty-copy">The music keeps going. Take something out when you want it.</p>
      <div className="desk-empty-actions">
        <button type="button" className="key desk-go" onClick={() => setDrawerOpen(true)}>Open the drawer</button>
        <button
          type="button"
          className="key"
          onClick={() => {
            reset()
            document.querySelector<HTMLElement>(".desk .wf [data-grip]")?.focus({ preventScroll: true })
          }}
        >
          Put the usual back
        </button>
      </div>
    </div>
  )
}

// The board: every widget in a frame on a lattice of colW × rowH slots, each
// at its own saved spot in this bucket (lib/board layoutOf). The slot metrics reach the frames as CSS
// variables written straight onto .desk, so resizing the window re-renders
// only when the bucket, the columns or the rows to the fold change.
export function Desk() {
  const desk = useDesk()
  const { save, loaded, registerBoard, registerLive, registerLift } = desk
  const deskRef = useRef<HTMLDivElement>(null)
  const metrics = useRef<Metrics>(metricsFor(FIRST_VIEW.width, FIRST_VIEW.height))
  const [view, setView] = useState<View>(() => viewOf(metrics.current))
  const [ready, setReady] = useState(false)

  const layout = useMemo(() => computeLayout(save, view), [save, view])
  const latest = useRef({ layout, view })
  // the actions change identity every render; the controller reads the latest
  const api = useRef(desk)
  api.current = desk
  const [menu, setMenu] = useState<{ id: string; grip: HTMLElement } | null>(null)
  const menuOpen = useRef(false)
  menuOpen.current = menu !== null
  // frames on their way into the drawer: still drawn where they were
  const [leaving, setLeaving] = useState<Record<string, { frame: Frame; index: number }>>({})
  // the frames as last committed (see shownKey below)
  const shownRef = useRef<ShownDesk>({ bucket: "desk", frames: [] })

  // everything the drag controller borrows: the rendered layout, and commits
  // that flush at once, so a drop can spring frames into their new slots
  const [controller] = useState(() => {
    const host: DragHost = {
      shot: () => {
        const { layout: shown } = latest.current
        const m = metrics.current
        if (m.bucket !== shown.bucket || m.cols !== shown.cols) return null
        return { bucket: shown.bucket, cols: shown.cols, m, a: shown.a, items: shown.items }
      },
      widget: (id) => {
        const inst = own(latest.current.layout.save.instances, id)
        const def = inst ? definitionOf(inst.type) : null
        if (!def) return null
        return { name: def.spokenName ?? def.name, sizes: def.sizes.map((s) => s.id), label: (size) => sizeLabel(def, size) }
      },
      commit: (a) => flushSync(() => api.current.commit(latest.current.layout.bucket, a)),
      carryIn: (id, size, a, also) => flushSync(() => api.current.takeOut(id, { size, arrangement: a, also })),
      putAway: (id) => flushSync(() => api.current.putAway(id)),
      openMenu: (id, grip) => setMenu((open) => (open && open.id === id ? null : { id, grip })),
      menuOpen: () => menuOpen.current || !!document.getElementById("page-menu-options"),
      announce: (text) => api.current.announce(text),
      emit: (event) => api.current.emit(event),
      setSession: (active) => api.current.setSession(active),
    }
    return new DragController(host)
  })

  // frames moving in the DOM (a new reading order) drop focus; put it back
  const order = layout.frames.map((f) => f.id).join(" ")
  const lastOrder = useRef(order)
  const focused = useRef<Element | null>(null)
  if (order !== lastOrder.current && typeof document !== "undefined") focused.current = document.activeElement

  useLayoutEffect(() => {
    latest.current = { layout, view }
  })

  useLayoutEffect(() => {
    if (order === lastOrder.current) return
    lastOrder.current = order
    const el = focused.current as HTMLElement | null
    focused.current = null
    if (el && el !== document.activeElement && el.isConnected && typeof el.focus === "function") el.focus({ preventScroll: true })
  }, [order])

  // metrics: one observer on the shell, batched per frame. A new slot size
  // is only CSS; a new bucket, column count or fold re-renders
  useLayoutEffect(() => {
    const el = deskRef.current
    if (!el) return
    const shell = el.closest(".site-shell") ?? document.documentElement
    let frame = 0
    const measure = () => {
      frame = 0
      const was = metrics.current
      // the root's width picks the bucket and the slot. with a classic
      // scrollbar Chrome counts the stable gutter in it, so the board sits
      // half a gutter nearer the edges there; the shell still centres it
      const m = metricsFor(document.documentElement.clientWidth, window.innerHeight)
      metrics.current = m
      el.style.setProperty("--col", `${m.colW}px`)
      el.style.setProperty("--row", `${m.rowH}px`)
      el.style.setProperty("--gap", `${m.gap}px`)
      el.style.setProperty("--pitch-x", `${m.pitchX}px`)
      el.style.setProperty("--pitch-y", `${m.pitchY}px`)
      el.style.setProperty("--cols", String(m.cols))
      el.style.setProperty("--top", `${m.top}px`)
      el.style.setProperty("--bottom", `${m.bottom}px`)
      // a drag's cached geometry is stale on a new board
      if (m.bucket !== was.bucket || m.cols !== was.cols || m.pitchX !== was.pitchX || m.pitchY !== was.pitchY) controller.cancel()
      const v = latest.current.view
      if (m.bucket !== v.bucket || m.cols !== v.cols || m.visibleRows !== v.visibleRows) setView(viewOf(m))
    }
    measure()
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const watch = new ResizeObserver(schedule)
    watch.observe(shell)
    window.addEventListener("resize", schedule)
    return () => {
      watch.disconnect()
      window.removeEventListener("resize", schedule)
      cancelAnimationFrame(frame)
    }
  }, [controller])

  // a bucket change never remounts anything; a grip menu doesn't survive it
  const bucket = layout.bucket
  const lastBucket = useRef<Bucket | null>(null)
  useLayoutEffect(() => {
    if (lastBucket.current !== null && lastBucket.current !== bucket) setMenu(null)
    lastBucket.current = bucket
  }, [bucket])

  // shown once the save and the metrics are in: nothing waits on measuring
  useLayoutEffect(() => { if (loaded) setReady(true) }, [loaded])

  useLayoutEffect(() => {
    const el = deskRef.current
    if (el) controller.attach(el)
    registerLift(controller)
    return () => { registerLift(null); controller.detach() }
  }, [controller, registerLift])
  useEffect(() => () => controller.dispose(), [controller])

  // ⌘Z / Ctrl+Z undo; ⌘⇧Z, Ctrl+Shift+Z or Ctrl+Y redo. Not while typing, and
  // not with a widget in hand. (The provider glides what moves.) While a
  // widget's own Undo toast is up ("Nicely done.", "Thought moved to tasks."),
  // ⌘Z is that toast's Undo, not the desk step under it. A step that sends
  // the focused widget to the drawer moves focus on rather than dropping it
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat || controller.active) return
      if (event.target instanceof Element && event.target.closest(TYPING) && !event.target.matches("[data-focus-on-take-out][data-untouched]")) return
      const key = event.key.toLowerCase()
      const z = key === "z" || event.code === "KeyZ"
      const redo = (z && event.shiftKey) || (event.ctrlKey && !event.metaKey && !event.shiftKey && (key === "y" || event.code === "KeyY"))
      if (!redo && !(z && !event.shiftKey)) return
      const { canUndo, canRedo, undo: back, redo: forward, currentToast: shown, dismissToast } = api.current
      if (!redo && shown?.undo && shown.undo !== back) {
        event.preventDefault()
        setMenu(null)
        runToastUndo(shown, dismissToast)
        return
      }
      if (redo ? !canRedo : !canUndo) return
      event.preventDefault()
      setMenu(null)
      controller.keepFocus(redo ? forward : back)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [controller])

  useEffect(() => {
    const board: BoardView = {
      bucket: () => latest.current.layout.bucket,
      cols: () => latest.current.layout.cols,
      rows: () => latest.current.view.visibleRows,
      shown: () => shownRef.current,
    }
    registerBoard(board)
    return () => registerBoard(null)
  }, [registerBoard])

  // the first time anything is picked up, the lesson's learned: the grips
  // that showed faintly for a newcomer go back to showing only on hover
  const learned = !!save.hints?.welcomed
  useEffect(() => {
    if (learned) return
    return api.current.on((event) => { if (event.kind === "lift") api.current.setHint("welcomed") })
  }, [learned])

  // Put away, it stays drawn where it was while it flies into the drawer
  // (the controller moves it), then unmounts. The desk has already moved on.
  const { on } = desk
  useEffect(() => on((event) => {
    if (event.kind !== "put-away") return
    const shown = latest.current.layout
    const index = shown.frames.findIndex((f) => f.id === event.id)
    if (index < 0) return
    const id = event.id
    setLeaving((prev) => ({ ...prev, [id]: { frame: shown.frames[index], index } }))
    window.setTimeout(() => setLeaving((prev) => {
      if (!own(prev, id)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    }), reducedMotion() ? LEAVE_REDUCED_MS : LEAVE_MS)
  }), [on])

  // brought back before it was gone (an undo): it's a widget again
  useLayoutEffect(() => {
    const back = Object.keys(leaving).filter((id) => layout.frames.some((f) => f.id === id))
    if (!back.length) return
    setLeaving((prev) => {
      const next = { ...prev }
      for (const id of back) delete next[id]
      return next
    })
  }, [layout, leaving])

  // the frames to draw: the layout's, plus any still leaving, where they were
  const frames = layout.frames.slice()
  const gone: Record<string, true> = {}
  for (const id of Object.keys(leaving)) {
    if (frames.some((f) => f.id === id)) continue
    const l = leaving[id]
    gone[id] = true
    frames.splice(Math.min(l.index, frames.length), 0, l.frame)
  }

  // the frames as drawn, for whoever cares where the others are (the cat's
  // neighbours): published once they're committed, and a "layout" event says so.
  // keyed on what's drawn, so springs, drags and re-renders say nothing
  const shownFrames: ShownFrame[] = frames.map((f) => ({
    id: f.id, x: f.x, y: f.y, w: f.w, h: f.h, bare: f.surface === "bare", leaving: !!own(gone, f.id),
  }))
  const shownKey = `${bucket} ${shownFrames.map((f) => `${f.id}:${f.x},${f.y},${f.w},${f.h}${f.bare ? "b" : ""}${f.leaving ? "l" : ""}`).join(" ")}`
  const nextShown = useRef<ShownDesk>({ bucket, frames: shownFrames })
  nextShown.current = { bucket, frames: shownFrames }
  useLayoutEffect(() => {
    shownRef.current = nextShown.current
    api.current.emit({ kind: "layout" })
  }, [shownKey])

  const empty = loaded && layout.frames.length === 0
  const deep = deepest(layout.items)
  const rows = boardRows(layout.items, view, false)
  // the lattice's wells, drawn to the spare row a drag adds, so a lift
  // inserts nothing
  const wellRows = Math.max(rows, boardRows(layout.items, view, true))
  const wells = useMemo(() => {
    const out: { x: number; y: number }[] = []
    for (let y = 0; y < wellRows; y++) for (let x = 0; x < view.cols; x++) out.push({ x, y })
    return out
  }, [wellRows, view.cols])

  // the widget whose menu is open, if it's still on the desk
  const menuFrame = menu ? layout.frames.find((f) => f.id === menu.id) : undefined
  useEffect(() => { if (menu && !menuFrame) setMenu(null) }, [menu, menuFrame])
  const closeMenu = (toGrip: boolean) => {
    const grip = menu?.grip
    setMenu(null)
    if (toGrip) grip?.focus({ preventScroll: true })
  }
  // Move earlier / Move later: its place in reading order (-1 pinned, which can't move)
  const menuPlace = menuFrame
    ? (menuFrame.pinned ? { index: -1, count: 0 } : { index: layout.frames.findIndex((f) => f.id === menuFrame.id), count: layout.frames.length })
    : { index: 0, count: 0 }

  return (
    <>
      <div
        ref={deskRef}
        className="desk"
        data-bucket={bucket}
        data-ready={ready || undefined}
        data-empty={empty || undefined}
        data-new={(loaded && !learned) || undefined}
        style={{ "--rows": rows, "--rows-arranging": wellRows, "--deep": deep } as CSSProperties}
      >
        <div className="desk-grid" aria-hidden>
          {wells.map((w) => <i key={`${w.x},${w.y}`} style={{ "--x": w.x, "--y": w.y } as CSSProperties} />)}
        </div>
        <div className="desk-flash" aria-hidden />
        {/* a ring of dots round a slot as its widget is pinned or unpinned */}
        <div className="desk-held" aria-hidden>
          <svg><rect width="100%" height="100%" rx="36" /></svg>
        </div>
        <div className="desk-landing" aria-hidden>
          <span className="desk-landing-pin"><TackHead dot={2.5} shine /></span>
        </div>
        {/* the resize handle's size name, over the footprint it snaps to */}
        <div className="desk-chip" aria-hidden />
        {frames.map((f) => (
          <WidgetFrame
            key={f.id} id={f.id} def={f.def} size={f.draw} form={f.form} bucket={bucket} surface={f.surface}
            x={f.x} y={f.y} w={f.w} h={f.h} pinned={f.pinned} leaving={!!own(gone, f.id)}
          />
        ))}
        {empty && <EmptyDesk />}
      </div>
      <DeskDrawer controller={controller} bucket={bucket} cols={view.cols} boardWidth={metrics.current.boardWidth} />
      {menu && menuFrame && (
        <GripMenu
          def={menuFrame.def}
          size={menuFrame.size}
          grip={menu.grip}
          sizes={menuFrame.def.sizes.map((s) => {
            const fp = footprint(s.id, view.cols)
            return { id: s.id, label: s.label, w: fp.w, h: fp.h }
          })}
          pinned={menuFrame.pinned}
          place={menuPlace}
          extras={menuItemsOf(menuFrame.id)}
          onSize={(size) => { closeMenu(true); controller.resize(menuFrame.id, size) }}
          onMove={() => { closeMenu(true); controller.startMove(menuFrame.id) }}
          onStep={(dir) => controller.step(menuFrame.id, dir)}
          onPin={() => { closeMenu(true); controller.togglePin(menuFrame.id) }}
          onPutAway={() => { setMenu(null); controller.putAway(menuFrame.id) }}
          onClose={closeMenu}
        />
      )}
      <div id="desk-live" ref={registerLive} aria-live="polite" className="sr-only" />
      <p id="desk-help" className="sr-only">
        Drag a widget by any quiet spot to move it; the others make room. It stays exactly where you let it go.
        With the keyboard, arrow keys on its handle pick it up and move it a space at a time, P pins it, and Enter opens its menu.
      </p>
    </>
  )
}

export default Desk
