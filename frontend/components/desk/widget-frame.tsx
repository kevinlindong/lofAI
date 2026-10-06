"use client"

import { createContext, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { DotGlyph, DotPattern } from "@/components/dot-glyph"
import type { MenuItem, Surface, WidgetDefinition } from "@/components/desk/types"
import type { Bucket, Form, SizeId } from "@/lib/board"

export interface WidgetFrameApi {
  id: string | null
  size: SizeId | null
  // "tall": xl below six columns, the same content stacked 2×4
  form: Form
  expanded: boolean
  // a tray, dial sheet or picker unfolding over the neighbours: the frame
  // rises above the others and its surface follows the content until it folds
  setExpanded(on: boolean): void
  // extras for the grip menu
  setMenuItems(items: MenuItem[]): void
}

const noop = () => {}
const LOOSE: WidgetFrameApi = { id: null, size: null, form: null, expanded: false, setExpanded: noop, setMenuItems: noop }
const WidgetFrameContext = createContext<WidgetFrameApi>(LOOSE)

// outside a frame (a preview, a test page) everything here is a no-op
export function useWidgetFrame(): WidgetFrameApi {
  return useContext(WidgetFrameContext)
}

// how far down each open tray or sheet reaches, in slot rows from the desk's
// top. frames contain their layout, so the page can't see past the last row
// on its own: the desk grows to hold the deepest one (--reach) while it's open
const REACH: Record<string, number> = {}
function reach(desk: HTMLElement) {
  const rows = Object.keys(REACH).reduce((most, id) => Math.max(most, REACH[id]), 0)
  if (rows) desk.style.setProperty("--reach", String(rows))
  else desk.style.removeProperty("--reach")
}

// what each widget registered for its grip menu. read when the menu opens, so
// a widget updating its extras never re-renders anything
const MENUS: Record<string, MenuItem[]> = {}
export function menuItemsOf(id: string): MenuItem[] {
  return Object.prototype.hasOwnProperty.call(MENUS, id) ? MENUS[id] : []
}

// The thumbtack, in dots, small enough to live in a 24px circle: from the
// side (unpinned, offered on hover), and its round head from above once it's
// in, with one dot of shine. Five dots square: at a 1.5px dot (1px gaps) it
// is 11.5 across, at 2.5 the landing footprint's mark
export const TACK_SIDE = [".XXX.", "XXXXX", "..X..", "..X..", "..X.."]
export const TACK_HEAD = [".XXX.", "XXXXX", "XXXXX", "XXXXX", ".XXX."]
const TACK_SHINE = [".....", ".X...", ".....", ".....", "....."]
// the glyph in the circle: 1.5px dots with a 1px gap
const TACK_DOT = 1.5
const BURST = [0, 1, 2, 3, 4, 5, 6, 7]

// The tack's head, shared with the landing footprint's "this will pin" mark.
// Its one dot of shine is for the bigger mark: in the 24px circle there is no
// room for it, and the filled circle says "in" on its own
export function TackHead({ dot = TACK_DOT, shine = false }: { dot?: number; shine?: boolean }) {
  return (
    <span className="tack-head">
      <DotPattern rows={TACK_HEAD} dot={dot} />
      {shine && <DotPattern rows={TACK_SHINE} dot={dot} className="tack-shine" color="color-mix(in srgb, currentColor 35%, white)" />}
    </span>
  )
}

interface FrameProps {
  id: string
  def: WidgetDefinition
  size: SizeId
  form: Form
  bucket: Bucket
  surface: Surface
  x: number
  y: number
  w: number
  h: number
  pinned: boolean
  // on its way into the drawer
  leaving?: boolean
}

// Memoized on plain numbers and strings: the radio provider hands out a new
// value on every render, and that must never reach the frames. The committed
// slot is --x/--y and the footprint --w/--h; motion moves frames with the
// individual `translate`/`scale`/`rotate` properties, which React never sets.
export const WidgetFrame = memo(function WidgetFrame({ id, def, size, form, bucket, surface, x, y, w, h, pinned, leaving }: FrameProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpandedState] = useState(false)

  useLayoutEffect(() => () => { delete MENUS[id] }, [id])

  const setExpanded = useCallback((on: boolean) => setExpandedState(on), [])
  const setMenuItems = useCallback((items: MenuItem[]) => { MENUS[id] = items }, [id])

  // unfolded near the bottom: room for it on the page, and it comes into view
  useLayoutEffect(() => {
    const body = bodyRef.current
    const desk = body?.closest<HTMLElement>(".desk")
    if (!expanded || !body || !desk) return
    const pitch = parseFloat(getComputedStyle(desk).getPropertyValue("--pitch-y")) || 1
    const gap = parseFloat(getComputedStyle(desk).getPropertyValue("--gap")) || 0
    REACH[id] = Math.ceil((body.getBoundingClientRect().bottom - desk.getBoundingClientRect().top + gap) / pitch)
    reach(desk)
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    body.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" })
    return () => {
      delete REACH[id]
      reach(desk)
    }
  }, [expanded, id])

  const api = useMemo<WidgetFrameApi>(() => ({ id, size, form, expanded, setExpanded, setMenuItems }),
    [id, size, form, expanded, setExpanded, setMenuItems])

  const Component = def.Component
  const resizable = def.sizes.length > 1

  return (
    <section
      className="wf"
      id={`widget-${id}`}
      aria-label={def.name}
      aria-roledescription="widget"
      tabIndex={-1}
      data-type={def.type}
      data-size={size}
      data-form={form ?? undefined}
      data-surface={surface}
      data-pinned={pinned || undefined}
      data-expanded={expanded || undefined}
      data-leaving={leaving || undefined}
      style={{ "--x": x, "--y": y, "--w": w, "--h": h } as CSSProperties}
    >
      {/* elevation: pre-rendered, only their opacity ever moves */}
      <span className="wf-shadow wf-contact" aria-hidden />
      <span className="wf-shadow wf-cast" aria-hidden />
      <button
        type="button"
        className="wf-grip"
        data-grip
        aria-label={`Move ${def.name}`}
        aria-haspopup="menu"
        aria-expanded="false"
        aria-describedby={`desk-help ${id}-state`}
      >
        <DotGlyph name="grip" dot={2} />
      </button>
      <button
        type="button"
        className="wf-pin"
        data-pin
        aria-pressed={pinned}
        aria-label={`Pin ${def.name}`}
        title={pinned ? "Unpin" : "Pin in place"}
      >
        <span className="wf-pin-pulse" aria-hidden />
        <span className="wf-pin-burst" aria-hidden>{BURST.map((i) => <i key={i} style={{ "--i": i } as CSSProperties} />)}</span>
        <span className="wf-pin-glyphs" aria-hidden>
          <span className="wf-pin-side"><DotPattern rows={TACK_SIDE} dot={TACK_DOT} /></span>
          <span className="wf-pin-head"><TackHead /></span>
        </span>
      </button>
      <div ref={bodyRef} className="wf-body">
        <div className="wf-surface" aria-hidden />
        <div className="wf-content">
          <WidgetFrameContext.Provider value={api}>
            <Component id={id} size={size} form={form} bucket={bucket} />
          </WidgetFrameContext.Provider>
        </div>
      </div>
      {resizable && <span className="wf-resize" data-resize aria-hidden><DotGlyph name="resize" dot={2} /></span>}
      <div className="wf-deco" aria-hidden />
      <span id={`${id}-state`} className="sr-only">{pinned ? "Pinned in place." : ""}</span>
    </section>
  )
})
