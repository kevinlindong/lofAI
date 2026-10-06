"use client"

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import { DotGlyph, DotPattern } from "@/components/dot-glyph"
import type { MenuItem, WidgetDefinition } from "@/components/desk/types"
import type { SizeId } from "@/lib/board"

interface GripMenuProps {
  def: WidgetDefinition
  size: SizeId
  grip: HTMLElement
  // size chips: each of its sizes and its footprint here, for its silhouette
  sizes: { id: SizeId; label: string; w: number; h: number }[]
  pinned: boolean
  // its place in reading order, for Move earlier / Move later (0-based; -1 pinned)
  place: { index: number; count: number }
  extras: MenuItem[]
  onSize(size: SizeId): void
  onMove(): void
  onStep(dir: -1 | 1): void
  onPin(): void
  onPutAway(): void
  // back to the grip, or (a press elsewhere) wherever the press went
  onClose(toGrip: boolean): void
}

const ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)'

// a footprint in dots: a 3×3 block per slot, a dot of air between slots
export function silhouette(w: number, h: number): string[] {
  const row = (lit: boolean) => Array.from({ length: w }, () => (lit ? "XXX" : "...")).join(".")
  const rows: string[] = []
  for (let y = 0; y < h; y++) {
    if (y) rows.push(row(false))
    rows.push(row(true), row(true), row(true))
  }
  return rows
}

// The grip's menu: a portal under the grip, with PageMenu's roving keys.
// Sizes first, then Move and its steps in reading order, the pin, the
// widget's own extras, and the drawer last.
export function GripMenu({ def, size, grip, sizes, pinned, place, extras, onSize, onMove, onStep, onPin, onPutAway, onClose }: GripMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  // anchored under the grip, kept inside the window: with no room below it
  // opens above the grip, and failing that sits on the window's bottom edge.
  // again when a step moves the grip or its own height changes
  const index = place.index
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const anchor = () => {
      const g = grip.getBoundingClientRect(), width = menu.offsetWidth, height = menu.offsetHeight
      const view = document.documentElement
      const left = Math.min(Math.max(8, g.left + g.width / 2 - width / 2), view.clientWidth - width - 8)
      const below = g.bottom + 6, above = g.top - 6 - height
      const top = below + height <= view.clientHeight - 8 ? below : above >= 8 ? above : Math.max(8, view.clientHeight - 8 - height)
      menu.style.left = `${left + window.scrollX}px`
      menu.style.top = `${top + window.scrollY}px`
    }
    anchor()
    if (typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(anchor)
    watch.observe(menu)
    return () => watch.disconnect()
  }, [grip, index])

  useEffect(() => {
    grip.setAttribute("aria-expanded", "true")
    const menu = ref.current
    const items = menu?.querySelectorAll<HTMLElement>(ITEMS)
    const checked = menu?.querySelector<HTMLElement>('[aria-checked="true"][role="menuitemradio"]')
    ;(checked ?? items?.[0])?.focus({ preventScroll: true })
    // a press anywhere else folds it away; the grip's own press is its toggle
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menu?.contains(target) && !grip.contains(target)) close.current(false)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      grip.setAttribute("aria-expanded", "false")
    }
  }, [grip])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      close.current(true)
      return
    }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEMS))
    const at = items.indexOf(document.activeElement as HTMLElement)
    let next = at
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (at + 1) % items.length
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (at - 1 + items.length) % items.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = items.length - 1
    else if (event.key === "p" || event.key === "P") {
      event.preventDefault()
      onPin()
      return
    } else return
    event.preventDefault()
    items[next]?.focus()
  }

  const first = pinned || place.index <= 0
  const last = pinned || place.index >= place.count - 1
  return createPortal(
    <div ref={ref} className="grip-menu" role="menu" aria-label={def.name} onKeyDown={onKeyDown}>
      {sizes.length > 1 && (
        <div className="grip-menu-sizes" role="group" aria-label="Size">
          {sizes.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === size}
              tabIndex={-1}
              className="grip-chip"
              onClick={() => onSize(option.id)}
            >
              <span className="grip-chip-shape" aria-hidden><DotPattern rows={silhouette(option.w, option.h)} dot={2} /></span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item" disabled={pinned} onClick={onMove} aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight">
        <DotGlyph name="grip" dot={2} />
        <span>Move</span>
        <span className="grip-menu-hint" aria-hidden>{pinned ? "pinned" : "arrow keys"}</span>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item" disabled={first} onClick={() => onStep(-1)}>
        <DotGlyph name="chevron" dot={2} className="grip-menu-earlier" />
        <span>Move earlier</span>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item" disabled={last} onClick={() => onStep(1)}>
        <DotGlyph name="chevron" dot={2} className="grip-menu-later" />
        <span>Move later</span>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={onPin} aria-keyshortcuts="P">
        <span className="grip-menu-tack" aria-hidden><DotPattern rows={pinned ? PIN_OFF : PIN_ON} dot={1} /></span>
        <span>{pinned ? "Unpin" : "Pin in place"}</span>
        <span className="grip-menu-hint" aria-hidden>P</span>
      </button>
      {extras.length > 0 && <div className="menu-divider" role="separator" />}
      {extras.map((item) => (
        <button
          key={item.id}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={item.checked}
          tabIndex={-1}
          className="menu-item"
          disabled={item.disabled}
          onClick={() => { close.current(true); item.onSelect() }}
        >
          <span className="grip-menu-mark" aria-hidden>{item.checked && <DotGlyph name="check" dot={2} />}</span>
          <span>{item.label}</span>
          {item.hint && <span className="grip-menu-hint" aria-hidden>{item.hint}</span>}
        </button>
      ))}
      <div className="menu-divider" role="separator" />
      <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={onPutAway}>
        <DotGlyph name="drawer" dot={1} />
        <span>Put in the drawer</span>
      </button>
    </div>,
    document.body,
  )
}

// the tack, small: going in, and coming out
const PIN_ON = [".XXXXX.", "..XXX..", ".XXXXX.", "XXXXXXX", "...X...", "...X..."]
const PIN_OFF = ["..XXX..", ".XXXXX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX.."]

export default GripMenu
