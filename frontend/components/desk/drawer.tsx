"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react"
import { flushSync } from "react-dom"
import { DotGlyph } from "@/components/dot-glyph"
import { useDesk, type DeskToast } from "@/components/desk/desk-provider"
import type { Carry, DragController } from "@/components/desk/drag-controller"
import { DrawerPull } from "@/components/desk/drawer-pull"
import { silhouette } from "@/components/desk/grip-menu"
import { definitionOf, specsFor, surfaceOf, WIDGETS } from "@/components/desk/registry"
import { runToastUndo, Toasts } from "@/components/desk/toasts"
import type { WidgetDefinition } from "@/components/desk/types"
import { DotPattern } from "@/components/dot-glyph"
import { footprint, own, planTakeOut, planTidy, type Bucket, type SizeId } from "@/lib/board"
import { arrangementOf, knownTypes, type BoardSave, type KnownTypes } from "@/lib/board-storage"

// keys that belong to whatever has focus; the radio's shortcuts wait for the same
const OWN_KEYS = 'input, textarea, select, button, a, summary, [role="slider"], [contenteditable], dialog'
// the sheet folds to this strip while something is carried; the pull grows to it
const STRIP_H = 48
const PULL_STRIP_W = 280
const FLY_MS = 320

interface Ghost { n: number; id: string; def: WidgetDefinition; size: SizeId; width: number; height: number; returning: boolean }

let known: KnownTypes | null = null
const knownNow = () => known ?? (known = knownTypes(specsFor()))

const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
const modalOpen = () => { try { return !!document.querySelector("dialog:modal") } catch { return !!document.querySelector("dialog[open]") } }

// what's in the drawer: built widgets that aren't on the desk, in registry order
function drawerIds(save: BoardSave): string[] {
  const rank = (id: string) => WIDGETS.findIndex((def) => def.type === save.instances[id].type)
  return Object.keys(save.instances)
    .filter((id) => !save.instances[id].onDesk && definitionOf(save.instances[id].type))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
}

interface DrawerProps {
  controller: DragController
  bucket: Bucket
  cols: number
  boardWidth: number
}

// The drawer: a pull at the bottom centre, and a non-modal sheet listing what
// isn't on the desk. Take things out by click (they go back where they were)
// or carry them out by their tile; put them back by dropping them on the
// pull. The board stays live the whole time. Toasts sit just above the pull.
export function DeskDrawer({ controller, bucket, cols, boardWidth }: DrawerProps) {
  const deskApi = useDesk()
  const { save, drawerOpen: open, setDrawerOpen } = deskApi
  const api = useRef(deskApi)
  api.current = deskApi
  const sheetRef = useRef<HTMLDivElement>(null)
  const pullRef = useRef<HTMLButtonElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<HTMLDivElement>(null)
  const flyTimer = useRef(0)
  const carries = useRef(0)
  const noticeSeen = useRef(false)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [chosen, setChosen] = useState<Record<string, SizeId>>({})
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const askRef = useRef<HTMLButtonElement>(null)
  const openRef = useRef(open)
  openRef.current = open

  const away = useMemo(() => drawerIds(save), [save])
  const awayTypes = useMemo(() => away.map((id) => save.instances[id].type), [away, save])
  // the chosen chip, else the size it had when it was put away, else its usual one
  const sizeOf = (id: string, def: WidgetDefinition): SizeId => {
    const want = own(chosen, id) ?? own(save.sizes, id)
    return def.sizes.some((size) => size.id === want) ? want! : def.defaultSize
  }
  // the spot it held here when it went in, still free: it goes straight back to it
  const held = save.layouts[bucket]
  const desk = useMemo(() => arrangementOf(save, bucket, knownNow()), [save, bucket])
  const backToSpot = (id: string, size: SizeId) => {
    const spot = held ? own(held.at, id) : undefined
    if (!spot) return false
    const { landing } = planTakeOut(desk, id, size, cols, { at: spot })
    return landing.x === spot.x && landing.y === spot.y
  }
  // Tidy up is gravity: it's there to press while anything would rise
  const canTidy = useMemo(() => planTidy(desk, cols).moved.length > 0, [desk, cols])

  const close = useCallback((focusPull: boolean) => {
    setDrawerOpen(false)
    if (focusPull) pullRef.current?.focus({ preventScroll: true })
  }, [setDrawerOpen])

  // opening: the lattice shows, anything in hand goes back, the pull loses its
  // label for good, and focus goes to the first tile
  useLayoutEffect(() => {
    const d = api.current
    controller.setArranging("drawer", open)
    if (!open) {
      setConfirming(false)
      // the unreadable-board notice is said once: gone after it's been seen
      if (noticeSeen.current) { noticeSeen.current = false; d.dismissBrokenNotice() }
      return
    }
    controller.cancel()
    d.setHint("drawerOpened")
    if (d.welcome) d.dismissWelcome()
    if (d.brokenNotice) noticeSeen.current = true
    const sheet = sheetRef.current
    // the row stays mounted while the drawer's shut, and tiles put away meanwhile
    // were added ahead of the one it had snapped to: it starts from the first again
    const row = sheet?.querySelector<HTMLElement>(".drawer-tiles")
    if (row) row.scrollLeft = 0
    const first = sheet?.querySelector<HTMLElement>(".tile") ?? sheet?.querySelector<HTMLElement>(".drawer-done")
    first?.focus({ preventScroll: true })
    // a sheet still turning visible can refuse focus for a frame: once more then
    let retry = 0
    if (first && document.activeElement !== first) {
      retry = requestAnimationFrame(() => { if (openRef.current && first.isConnected) first.focus({ preventScroll: true }) })
    }
    return () => cancelAnimationFrame(retry)
  }, [open, controller])

  // one put away while the drawer is open (dropped on its strip) comes into
  // view in the row, which scrolls on its own; the page never moves for it
  const seenAway = useRef<string[]>([])
  useLayoutEffect(() => {
    const was = seenAway.current
    seenAway.current = away
    const added = away.find((id) => was.indexOf(id) < 0)
    const row = sheetRef.current?.querySelector<HTMLElement>(".drawer-tiles")
    const item = added ? document.getElementById(`tile-${added}-name`)?.closest<HTMLElement>(".drawer-item") : null
    if (!openRef.current || !row || !item) return
    const r = row.getBoundingClientRect(), i = item.getBoundingClientRect(), pad = 24
    if (i.left < r.left + pad) row.scrollLeft -= r.left + pad - i.left
    else if (i.right > r.right - pad) row.scrollLeft += i.right - (r.right - pad)
  }, [away])

  // where a carried widget can be let go to put it away: the pull, or the
  // open sheet (which folds to a strip). Asked once per lift
  useEffect(() => {
    const pull = pullRef.current, sheet = sheetRef.current
    if (!pull || !sheet) return
    controller.setDropZone(open
      ? { element: sheet, box: () => stripBox(sheet) }
      : {
          element: pull,
          box: () => {
            const r = pull.getBoundingClientRect(), cx = r.left + r.width / 2
            return { left: cx - PULL_STRIP_W / 2 - 8, right: cx + PULL_STRIP_W / 2 + 8, top: r.bottom - STRIP_H - 8, bottom: window.innerHeight }
          },
        })
    return () => controller.setDropZone(null)
  }, [open, controller])

  // notes sit above the open sheet: how tall it is (it only changes with its tiles)
  useEffect(() => {
    const sheet = sheetRef.current, notes = notesRef.current
    if (!sheet || !notes || typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(() => notes.style.setProperty("--drawer-h", `${sheet.offsetHeight}px`))
    watch.observe(sheet)
    return () => watch.disconnect()
  }, [])

  // D opens and closes it; Esc closes it, or else the toast
  const focusIsOurs = useCallback(() => {
    const at = document.activeElement
    return !at || at === document.body || !!sheetRef.current?.contains(at) || !!pullRef.current?.contains(at)
  }, [])
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || modalOpen()) return
      if (event.key === "Escape") {
        if (controller.busy) return
        // focus goes back to the pull only from the drawer itself (or from
        // nowhere): someone working on the desk keeps their place
        if (openRef.current) { event.preventDefault(); close(focusIsOurs()) }
        else if (api.current.currentToast) api.current.dismissToast()
        return
      }
      if (event.key.toLowerCase() !== "d" || controller.active) return
      // a grip or the pull has no use for D of its own
      if (event.target instanceof Element && event.target.closest(OWN_KEYS) && !event.target.closest("[data-grip], .drawer-pull")) return
      event.preventDefault()
      if (openRef.current) close(focusIsOurs())
      else setDrawerOpen(true)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [controller, close, setDrawerOpen, focusIsOurs])

  // a click outside closes it (a drag's click is swallowed, so a drag doesn't).
  // listening from the next task, so the click that opened it isn't counted
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target || !target.isConnected) return
      if (sheetRef.current?.contains(target) || pullRef.current?.contains(target) || target.closest(".desk-toast, .grip-menu")) return
      close(false)
    }
    const timer = window.setTimeout(() => document.addEventListener("click", onClick), 0)
    return () => { window.clearTimeout(timer); document.removeEventListener("click", onClick) }
  }, [open, close])

  // the returning-user note goes with the first drag
  const welcome = deskApi.welcome
  useEffect(() => {
    if (!welcome) return
    return api.current.on((event) => { if (event.kind === "lift") api.current.dismissWelcome() })
  }, [welcome])

  const takeOutTile = (id: string, tile: HTMLElement) => {
    const def = definitionOf(save.instances[id].type)
    if (!def) return
    const art = tile.querySelector<HTMLElement>(".tile-preview")
    const from = (art ?? tile).getBoundingClientRect()
    setDrawerOpen(false)
    deskApi.bringOut(id, { size: sizeOf(id, def), from, art })
  }

  const pressTile = (event: PointerEvent<HTMLButtonElement>, id: string, def: WidgetDefinition) => {
    const sheet = sheetRef.current
    if (event.button !== 0 || !sheet) return
    const size = sizeOf(id, def)
    const carry: Carry = {
      id, size, tile: event.currentTarget,
      strip: { element: sheet, box: () => stripBox(sheet) },
      lift: (width, height) => {
        window.clearTimeout(flyTimer.current)
        flushSync(() => setGhost({ n: ++carries.current, id, def, size, width, height, returning: false }))
        return ghostRef.current
      },
      end: (placed) => {
        if (placed) {
          setGhost(null)
          setDrawerOpen(false)
          return
        }
        // the sheet opens again under the ghost flying home
        setGhost((g) => g && { ...g, returning: true })
        flyTimer.current = window.setTimeout(() => setGhost(null), reducedMotion() ? 0 : FLY_MS)
      },
    }
    controller.pressTile(event.nativeEvent, carry)
  }

  const choose = (id: string, size: SizeId) => setChosen((prev) => ({ ...prev, [id]: size }))
  const chipKeys = (event: KeyboardEvent<HTMLDivElement>, id: string, def: WidgetDefinition) => {
    const at = def.sizes.findIndex((size) => size.id === sizeOf(id, def))
    const n = def.sizes.length
    let next = at
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (at + 1) % n
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (at - 1 + n) % n
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = n - 1
    else return
    event.preventDefault()
    choose(id, def.sizes[next].id)
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }

  // asking first: focus goes to the answer that goes ahead
  useLayoutEffect(() => { if (confirming) confirmRef.current?.focus({ preventScroll: true }) }, [confirming])

  const tidyUp = () => {
    close(true)
    deskApi.tidy()
  }
  const putBack = () => {
    close(true)
    deskApi.reset()
  }

  const undoToast = (t: DeskToast) => runToastUndo(t, deskApi.dismissToast)

  const ghostDef = ghost?.def
  const GhostPreview = ghostDef?.Preview
  const ghostSurface = ghost && ghostDef ? surfaceOf(ghostDef, ghost.size) : undefined

  return (
    <>
      <DrawerPull ref={pullRef} open={open} labelled={!save.hints?.drawerOpened} away={awayTypes} onToggle={() => (open ? close(true) : setDrawerOpen(true))} />
      <Toasts
        ref={notesRef}
        drawerOpen={open}
        toast={deskApi.currentToast}
        onUndo={undoToast}
        onHold={deskApi.holdToast}
        welcome={deskApi.welcome && deskApi.loaded}
        onWelcomed={deskApi.dismissWelcome}
      />
      <div
        ref={sheetRef}
        id="desk-drawer"
        className="drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="desk-drawer-title"
        data-open={open || undefined}
        data-carrying={(ghost && !ghost.returning) || undefined}
        style={{ "--board-w": `${boardWidth}px` } as CSSProperties}
      >
        {/* folded while something is carried: what letting go here does */}
        <p className="drawer-strip" aria-hidden>
          <DotGlyph name="drawer" dot={2} />
          <span className="drawer-strip-keep">drop it back here to keep it in the drawer</span>
          <span className="drawer-strip-away">put it in the drawer</span>
        </p>
        <div className="drawer-sheet">
          <header className="drawer-head">
            <div>
              <h2 id="desk-drawer-title">The drawer</h2>
              <p>Take something out. Put something back. Everything keeps its place.</p>
            </div>
            <button type="button" className="key drawer-done" onClick={() => close(true)}>Done</button>
          </header>

          {away.length > 0 ? (
            <ul className="drawer-tiles dot-scroll">
              {away.map((id) => {
                const def = definitionOf(save.instances[id].type)!
                const size = sizeOf(id, def)
                const Preview = def.Preview
                const back = backToSpot(id, size)
                return (
                  <li key={id} className="drawer-item">
                    <button
                      type="button"
                      className="tile"
                      data-type={def.type}
                      aria-labelledby={`tile-${id}-name`}
                      aria-describedby={`tile-${id}-blurb${back ? ` tile-${id}-back` : ""}`}
                      onClick={(event) => takeOutTile(id, event.currentTarget)}
                      onPointerDown={(event) => pressTile(event, id, def)}
                      onContextMenu={(event) => { if (controller.busy) event.preventDefault() }}
                    >
                      <span className="tile-preview" data-surface={surfaceOf(def, size)}><Preview size={size} /></span>
                      <span id={`tile-${id}-name`} className="tile-name">{def.name}</span>
                      <span id={`tile-${id}-blurb`} className="tile-blurb">{def.blurb}</span>
                      {back && <span id={`tile-${id}-back`} className="tile-back">goes back to its spot</span>}
                    </button>
                    {/* one size: the chips' row stays, empty, so every tile is as tall as the rest */}
                    {def.sizes.length < 2 && <div className="tile-sizes" aria-hidden />}
                    {def.sizes.length > 1 && (
                      <div className="tile-sizes" role="radiogroup" aria-label={`${def.name} size`} onKeyDown={(event) => chipKeys(event, id, def)}>
                        {def.sizes.map((option) => {
                          const fp = footprint(option.id, cols)
                          return (
                            <button
                              key={option.id}
                              type="button"
                              role="radio"
                              aria-checked={option.id === size}
                              tabIndex={option.id === size ? 0 : -1}
                              className="tile-chip"
                              onClick={() => choose(id, option.id)}
                            >
                              <span className="tile-chip-shape" aria-hidden><DotPattern rows={silhouette(fp.w, fp.h)} dot={1} /></span>
                              {option.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="drawer-empty">Everything&apos;s out on the desk.</p>
          )}

          <footer className="drawer-foot">
            {confirming ? (
              <div className="drawer-confirm" role="group" aria-labelledby="desk-drawer-confirm">
                <p id="desk-drawer-confirm">Put the usual back? Everything keeps its contents.</p>
                <button ref={confirmRef} type="button" className="key desk-go" onClick={putBack}>Put it back</button>
                <button type="button" className="key" onClick={() => { setConfirming(false); requestAnimationFrame(() => askRef.current?.focus()) }}>Keep mine</button>
              </div>
            ) : (
              <div className="drawer-actions">
                <span className="drawer-tidy">
                  <button type="button" className="drawer-link" onClick={tidyUp} disabled={!canTidy} aria-describedby={canTidy ? undefined : "desk-drawer-tidy"}>Tidy up</button>
                  {!canTidy && <span id="desk-drawer-tidy" className="drawer-link-note">Already tidy.</span>}
                </span>
                <button ref={askRef} type="button" className="drawer-link" onClick={() => setConfirming(true)}>Put the usual back</button>
              </div>
            )}
            {deskApi.saveFailed && <p className="drawer-note">This browser couldn&apos;t save your arrangement. It lasts this visit.</p>}
            {deskApi.brokenNotice && (
              <p className="drawer-note">{deskApi.brokenNotice === "future"
                ? "This arrangement was saved by a newer lofAI, so the desk is back to the usual here. It's kept as it was. Your tasks and notes are safe."
                : "Your arrangement couldn't be read, so the desk is back to the usual. Your tasks and notes are safe."}</p>
            )}
          </footer>
        </div>
      </div>
      {ghost && GhostPreview && (
        <div
          key={ghost.n}
          ref={ghostRef}
          className="drawer-ghost"
          data-surface={ghostSurface}
          aria-hidden
          style={{ width: ghost.width, height: ghost.height }}
        >
          <GhostPreview size={ghost.size} />
        </div>
      )}
    </>
  )
}

// the sheet folded: its width, the bottom strip of the window
function stripBox(sheet: HTMLElement) {
  const r = sheet.getBoundingClientRect()
  return { left: r.left, right: r.right, top: window.innerHeight - STRIP_H - 8, bottom: window.innerHeight }
}

export default DeskDrawer
