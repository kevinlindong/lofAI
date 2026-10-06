"use client"

import { forwardRef } from "react"
import { DotGlyph } from "@/components/dot-glyph"
import { WIDGETS } from "@/components/desk/registry"

interface PullProps {
  open: boolean
  // "widgets" stays written out until the drawer has been opened once
  labelled: boolean
  // types in the drawer: the ones with a Peek show a little sign of life
  away: string[]
  onToggle(): void
}

// The drawer's handle: a small pill at the bottom centre. While a widget is
// carried it becomes the strip you drop things on to put them away (the drag
// controller marks it data-drag, and data-over under the pointer).
export const DrawerPull = forwardRef<HTMLButtonElement, PullProps>(function DrawerPull({ open, labelled, away, onToggle }, ref) {
  // registry order; the stylesheet shows the first three that have something to say
  const peeks = WIDGETS.filter((def) => def.Peek && away.indexOf(def.type) >= 0)
  return (
    <button
      ref={ref}
      type="button"
      className="drawer-pull"
      aria-expanded={open}
      aria-controls="desk-drawer"
      aria-keyshortcuts="D"
      data-labelled={labelled || undefined}
      onClick={onToggle}
    >
      <span className="drawer-pull-label">widgets</span>
      <span className="drawer-pull-peeks">
        {peeks.map((def) => {
          const Peek = def.Peek!
          return <Peek key={def.type} />
        })}
      </span>
      <span className="drawer-pull-dots" aria-hidden><DotGlyph name="drawer" dot={2} /></span>
      <span className="drawer-pull-strip" aria-hidden>
        <DotGlyph name="drawer" dot={2} />
        <span>put it in the drawer</span>
      </span>
    </button>
  )
})

export default DrawerPull
