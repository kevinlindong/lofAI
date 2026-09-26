"use client"

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { DotGlyph } from "@/components/dot-glyph"
import { applyTheme, getActiveTheme, THEMES, type ThemeId } from "@/lib/themes"

const SHORTCUTS = [
  { href: "#radio", label: "Radio", icon: "music" },
  { href: "#tasks", label: "Tasks", icon: "list" },
  { href: "#focus-timer", label: "Focus timer", icon: "timer" },
] as const

export function PageMenu() {
  const [openPanel, setOpenPanel] = useState<"menu" | "settings" | null>(null)
  const [theme, setTheme] = useState<ThemeId>("dark")
  const [saved, setSaved] = useState(true)
  const menuRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef(0)

  useEffect(() => {
    setTheme(getActiveTheme())
  }, [])

  useEffect(() => {
    if (!openPanel) return
    if (openPanel === "menu") {
      const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
      items?.[firstItemRef.current === -1 ? items.length - 1 : 0]?.focus({ preventScroll: true })
    } else {
      backRef.current?.focus({ preventScroll: true })
    }

    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenPanel(null)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [openPanel])

  const closePanel = () => {
    setOpenPanel(null)
    triggerRef.current?.focus({ preventScroll: true })
  }

  const handleMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    const index = items.indexOf(document.activeElement as HTMLElement)
    let next = index
    if (event.key === "ArrowDown") next = (index + 1) % items.length
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = items.length - 1
    else return
    event.preventDefault()
    items[next]?.focus()
  }

  const chooseTheme = (id: ThemeId) => {
    setTheme(id)
    setSaved(applyTheme(id))
  }

  return (
    <div className="page-toolbar">
      <nav
        ref={menuRef}
        className="page-menu"
        aria-label="Workspace menu"
        onBlur={(event) => {
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
            setOpenPanel(null)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && openPanel) {
            event.preventDefault()
            closePanel()
          }
        }}
      >
        <button
          ref={triggerRef}
          id="page-menu-trigger"
          type="button"
          className="key menu-trigger"
          aria-haspopup={openPanel === "settings" ? undefined : "menu"}
          aria-expanded={openPanel !== null}
          aria-controls="page-menu-options"
          onClick={() => {
            firstItemRef.current = 0
            setOpenPanel(openPanel ? null : "menu")
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              firstItemRef.current = event.key === "ArrowUp" ? -1 : 0
              setOpenPanel("menu")
            }
          }}
        >
          <DotGlyph name="menu" dot={2} />
          <span>Menu</span>
          <DotGlyph name="chevron" dot={2} className="menu-chevron" />
        </button>

        {openPanel === "menu" && (
          <div
            id="page-menu-options"
            className="menu-dropdown"
            role="menu"
            aria-labelledby="page-menu-trigger"
            onKeyDown={handleMenuKey}
          >
            {SHORTCUTS.map((shortcut) => (
              <a
                key={shortcut.href}
                href={shortcut.href}
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                onClick={() => setOpenPanel(null)}
              >
                <DotGlyph name={shortcut.icon} dot={2} />
                <span>{shortcut.label}</span>
              </a>
            ))}
            <div className="menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              onClick={() => setOpenPanel("settings")}
            >
              <DotGlyph name="settings" dot={2} />
              <span>Settings</span>
            </button>
          </div>
        )}
        {openPanel === "settings" && (
          <section
            id="page-menu-options"
            className="menu-dropdown settings-panel"
            aria-labelledby="settings-title"
            aria-describedby="settings-description"
          >
            <div className="settings-heading">
              <div>
                <div className="settings-title">
                  <button
                    ref={backRef}
                    type="button"
                    className="key settings-back"
                    aria-label="Back to menu"
                    onClick={() => {
                      firstItemRef.current = -1
                      setOpenPanel("menu")
                    }}
                  >
                    <DotGlyph name="chevron" dot={2} />
                  </button>
                  <h2 id="settings-title">Settings</h2>
                </div>
                <p id="settings-description">Make this space feel like yours.</p>
              </div>
              <button
                type="button"
                className="key settings-close"
                aria-label="Close settings"
                onClick={closePanel}
              >
                <DotGlyph name="cross" dot={2} />
              </button>
            </div>

            <fieldset className="theme-picker" aria-describedby="theme-hint">
              <legend>Color theme</legend>
              <p id="theme-hint">A little change of atmosphere.</p>
              <div className="theme-grid">
                {THEMES.map((option) => (
                  <label key={option.id} className="theme-option">
                    <input
                      type="radio"
                      name="color-theme"
                      value={option.id}
                      aria-label={option.name}
                      checked={theme === option.id}
                      onChange={() => chooseTheme(option.id)}
                    />
                    <span className="theme-option-body">
                      <span
                        className={`theme-preview theme-${option.id}${option.dark ? " dark" : ""}`}
                        aria-hidden
                      >
                        <span className="theme-preview-player"><span /></span>
                        <span className="theme-preview-panels"><span /><span /></span>
                      </span>
                      <span className="theme-option-title">
                        <span>{option.name}</span>
                        <DotGlyph name="check" dot={2} className="theme-check" />
                      </span>
                      <span className="theme-option-description">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="settings-note" role="status">
              {saved
                ? "Themes apply instantly and are saved on this device."
                : "Theme applied. Your browser couldn’t save this choice."}
            </p>
          </section>
        )}
      </nav>
    </div>
  )
}
