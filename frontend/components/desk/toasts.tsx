"use client"

import { forwardRef, useEffect } from "react"
import type { DeskToast } from "@/components/desk/desk-provider"

const WELCOME_MS = 8000

// a widget just brought back (or out): focus goes to what it marks for that
// (a notebook's page), else its grip
export function focusWidget(id: string): boolean {
  const frame = document.getElementById(`widget-${id}`)
  const field = frame?.querySelector<HTMLElement>("[data-focus-on-take-out]")
  const target = field ?? frame?.querySelector<HTMLElement>("[data-grip]")
  target?.focus({ preventScroll: true })
  // a field just taken out has nothing of its own to undo yet, so ⌘Z there
  // still undoes the desk until the first keystroke (or it loses focus)
  if (field && target === field) {
    field.dataset.untouched = ""
    const done = () => {
      delete field.dataset.untouched
      field.removeEventListener("input", done)
      field.removeEventListener("blur", done)
    }
    field.addEventListener("input", done)
    field.addEventListener("blur", done)
  }
  return !!target
}

// A toast's Undo, by its button or by ⌘Z: the toast goes, its undo runs, and
// focus goes to the widget it was about (or, with that gone, the pull), so
// it never falls to the page.
export function runToastUndo(t: DeskToast, dismiss: () => void) {
  dismiss()
  if (!t.undo) return
  t.undo()
  if (t.widget && focusWidget(t.widget)) return
  document.querySelector<HTMLElement>('[aria-controls="desk-drawer"]')?.focus({ preventScroll: true })
}

interface ToastsProps {
  // over the open drawer rather than the pull
  drawerOpen: boolean
  toast: DeskToast | null
  onUndo(toast: DeskToast): void
  onHold(on: boolean): void
  // someone who used lofAI before the desk: one note, until they've seen it
  welcome: boolean
  onWelcomed(): void
}

// One note at a time, just above the pull: a toast after putting away,
// tidying or resetting (with Undo), a widget's own note, or the
// returning-user note.
export const Toasts = forwardRef<HTMLDivElement, ToastsProps>(function Toasts({ drawerOpen, toast, onUndo, onHold, welcome, onWelcomed }, ref) {
  const showWelcome = welcome && !toast
  useEffect(() => {
    if (!showWelcome) return
    const timer = window.setTimeout(onWelcomed, WELCOME_MS)
    return () => window.clearTimeout(timer)
  }, [showWelcome, onWelcomed])

  const hold = {
    onPointerEnter: () => onHold(true),
    onPointerLeave: () => onHold(false),
    onFocus: () => onHold(true),
    onBlur: () => onHold(false),
  }
  const note = (t: DeskToast) => (
    <div key={t.id} className="desk-toast">
      <span>{t.message}</span>
      {t.undo && (
        <button type="button" className="desk-toast-undo" onClick={() => onUndo(t)}>
          Undo
        </button>
      )}
    </div>
  )

  return (
    <div ref={ref} className="desk-notes" data-drawer={drawerOpen || undefined}>
      {/* always there, so a new message is read out when it arrives; what the
          desk has already said out loud goes in the quiet slot beside it */}
      <div className="desk-toast-slot" role="status" {...hold}>{toast && !toast.spoken && note(toast)}</div>
      <div className="desk-toast-slot" {...hold}>{toast && toast.spoken && note(toast)}</div>
      <div className="desk-toast-slot" role="status">
        {showWelcome && (
          <div className="desk-toast is-welcome">
            <span>
              Everything on the desk can move now.{" "}
              <span className="welcome-pointer">Drag it by a quiet spot, or open the drawer.</span>
              <span className="welcome-touch">Press and hold a quiet spot to move it, or open the drawer.</span>
            </span>
            <button type="button" className="desk-toast-undo" onClick={onWelcomed}>got it</button>
          </div>
        )}
      </div>
    </div>
  )
})

export default Toasts
