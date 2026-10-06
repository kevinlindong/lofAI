"use client"

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react"
import { useDesk } from "@/components/desk/desk-provider"
import { useWidgetFrame } from "@/components/desk/widget-frame"
import type { PreviewProps, WidgetDefinition, WidgetProps } from "@/components/desk/types"
import {
  CLOCK_KEY, WELCOME_FOR_MS, clockStep, darkGlyph, dayLine, formatTime, glyphLayout, hourDotsAt, localIso, minuteStart, monthBeforeDay, parseClockPrefs,
  prefers24h, serializeClockPrefs, timeGlyphs, weekdayOf, welcomeBack, welcomeLeft, welcomeParts, type Glyph,
} from "@/lib/clock"

// --- 12 or 24 hours: what was chosen (lofai.clock), else what the locale
// uses. One store for the widget, its drawer preview, and other tabs ---

let chosen: boolean | null | undefined
let localeH24: boolean | undefined
const listeners = new Set<() => void>()

function readH24(): boolean {
  if (chosen === undefined) {
    try { chosen = parseClockPrefs(localStorage.getItem(CLOCK_KEY))?.h24 ?? null } catch { chosen = null }
  }
  if (chosen !== null) return chosen
  if (localeH24 === undefined) {
    try { localeH24 = prefers24h(new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()) } catch { localeH24 = true }
  }
  return localeH24
}
const notify = () => listeners.forEach((listener) => listener())
function onStorage(event: StorageEvent) {
  if (event.key !== CLOCK_KEY && event.key !== null) return
  chosen = undefined
  notify()
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener("storage", onStorage)
  }
}
// false when the browser wouldn't keep it; it still holds for this visit
function chooseH24(h24: boolean): boolean {
  chosen = h24
  notify()
  try {
    localStorage.setItem(CLOCK_KEY, serializeClockPrefs({ h24 }))
    return true
  } catch { return false }
}
const useH24 = () => useSyncExternalStore(subscribe, readH24, () => true)

// "tuesday, september 29" where people say the month first
let monthFirstCache: boolean | undefined
function monthFirst(): boolean {
  if (monthFirstCache === undefined) {
    try {
      const parts = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).formatToParts(new Date(2026, 0, 15))
      monthFirstCache = monthBeforeDay(parts.map((part) => part.type))
    } catch { monthFirstCache = false }
  }
  return monthFirstCache
}

// --- the wall clock, to the minute ---

// One timeout a minute, aimed at the boundary; none while the tab is hidden,
// and the time is read again the moment it's back. `awake` hears how long
// nobody could have been looking (a hidden tab, a laptop asleep with the lid shut).
function useMinute(awake: (awayMs: number) => void): number {
  const [minute, setMinute] = useState(() => minuteStart(Date.now()))
  const heard = useRef(awake)
  heard.current = awake
  useEffect(() => {
    let timer = 0
    let seen = Date.now()
    // what's shown and the next turn, from the same reading of the wall
    const read = (now: number) => {
      const step = clockStep(now)
      setMinute(step.minute)
      window.clearTimeout(timer)
      timer = document.visibilityState === "visible" ? window.setTimeout(tick, step.wait) : 0
    }
    const tick = () => {
      const now = Date.now()
      heard.current(now - seen)
      seen = now
      read(now)
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick()
      else { window.clearTimeout(timer); seen = Date.now() }
    }
    // a Mac asleep with the tab showing may hold the timer back until well
    // after waking; the window coming back into focus reads the wall again
    const onFocus = () => { if (document.visibilityState === "visible") tick() }
    // the render read the wall a moment ago, and a minute may have turned
    // since (the rest of the desk commits first); a no-op if it hasn't
    read(seen)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onFocus)
    window.addEventListener("pageshow", onFocus)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("pageshow", onFocus)
    }
  }, [])
  return minute
}

// When the page was first in view: its start for most visits, later for a
// tab that opened in the background (pinned, restored, cmd-clicked)
let firstSeenAt: number | null = null
if (typeof document !== "undefined") {
  if (document.visibilityState === "visible") firstSeenAt = Date.now() - performance.now()
  else {
    const onShown = () => {
      if (document.visibilityState !== "visible") return
      firstSeenAt = Date.now()
      document.removeEventListener("visibilitychange", onShown)
    }
    document.addEventListener("visibilitychange", onShown)
  }
}

// Back after a long while (a day, give or take a night): the date line says
// hello for a minute. At the start of a visit that's the desk's lofai.seen;
// later it's the tab or the laptop waking up after one.
function useWelcome(returnedAfterMs: number | null) {
  const [until, setUntil] = useState(0)
  useEffect(() => {
    if (!welcomeBack(returnedAfterMs)) return
    // the visit's first minute in view, however late the clock came out of the drawer
    const begin = (seenAt: number) => {
      const left = welcomeLeft(seenAt, Date.now())
      if (left > 0) setUntil(Date.now() + left)
    }
    if (firstSeenAt !== null) {
      begin(firstSeenAt)
      return
    }
    // opened in the background: the minute starts when someone looks
    const onShown = () => {
      if (document.visibilityState !== "visible") return
      document.removeEventListener("visibilitychange", onShown)
      begin(firstSeenAt ?? Date.now())
    }
    document.addEventListener("visibilitychange", onShown)
    return () => document.removeEventListener("visibilitychange", onShown)
  }, [returnedAfterMs])
  useEffect(() => {
    if (!until) return
    const timer = window.setTimeout(() => setUntil(0), Math.max(0, until - Date.now()))
    return () => window.clearTimeout(timer)
  }, [until])
  const awake = useCallback((awayMs: number) => {
    if (welcomeBack(awayMs)) setUntil(Date.now() + WELCOME_FOR_MS)
  }, [])
  return { hello: until > 0, awake }
}

// --- the dots ---

// Every place keeps its cell and every dot stays mounted, only marked lit, so
// when the minute (or the hour) turns the changed digits' dots go out and
// come on one by one, and a narrow one or a missing tens is just a margin
const DotCell = memo(function DotCell({ glyph: { key, rows, narrow, blank } }: { glyph: Glyph }) {
  return (
    <span
      className={key === "c" ? "clock-glyph is-colon" : "clock-glyph"}
      data-narrow={narrow} data-blank={blank}
      style={{ "--cols": rows[0].length } as CSSProperties}
    >
      {rows.flatMap((row, r) => row.split("").map((dot, c) => (
        <i key={`${r}-${c}`} data-on={dot === "X" || undefined} style={{ "--r": r } as CSSProperties} />
      )))}
    </span>
  )
}, (a, b) => a.glyph.rows === b.glyph.rows && a.glyph.narrow === b.glyph.narrow && a.glyph.blank === b.glyph.blank)

// When the time changes width (a tens of hours comes or goes, or a leading
// one), the old time goes out where it stands, and then the new one comes on
// in its own places: nothing lit ever slides, and no moment shows a mix
const OUT_MS = 330
const calm = () => document.documentElement.classList.contains("low-power") || matchMedia("(prefers-reduced-motion: reduce)").matches

const DotTime = memo(function DotTime({ digits, still = false }: { digits: string; still?: boolean }) {
  const [shown, setShown] = useState(digits)
  const [out, setOut] = useState(false)
  useEffect(() => {
    if (digits === shown) return
    if (still || calm() || glyphLayout(timeGlyphs(digits)) === glyphLayout(timeGlyphs(shown))) {
      setOut(false)
      setShown(digits)
      return
    }
    setOut(true)
    const timer = window.setTimeout(() => { setOut(false); setShown(digits) }, OUT_MS)
    return () => window.clearTimeout(timer)
  }, [digits, shown, still])
  const glyphs = timeGlyphs(shown)
  return (
    <span className="clock-digits" aria-hidden>
      {glyphs.map((glyph) => <DotCell key={glyph.key} glyph={out ? darkGlyph(glyph) : glyph} />)}
    </span>
  )
})

// an hour a dot from 8am to midnight, in fours: morning, afternoon, evening, night
const HourDots = memo(function HourDots({ hour }: { hour: number }) {
  const marks = hourDotsAt(hour)
  return (
    <span className="clock-hours" aria-hidden>
      {[0, 1, 2, 3].map((group) => (
        <span key={group}>{marks.slice(group * 4, group * 4 + 4).map((mark, i) => <i key={i} data-mark={mark} />)}</span>
      ))}
    </span>
  )
})

function Clock({ size }: WidgetProps) {
  const h24 = useH24()
  const { setMenuItems } = useWidgetFrame()
  const { returnedAfterMs, toast, announce } = useDesk()
  const { hello, awake } = useWelcome(returnedAfterMs)
  const minute = useMinute(awake)
  // the date line after the hello comes back in softly, as the hello did
  const greeted = useRef(false)
  if (hello) greeted.current = true

  useEffect(() => {
    setMenuItems([{
      id: "h24", label: "24-hour clock", checked: h24,
      onSelect: () => {
        // said, as a size change from the same menu is
        announce(h24 ? "12-hour clock." : "24-hour clock.")
        if (!chooseH24(!h24)) toast("This browser couldn't save the clock setting. It lasts this visit.")
      },
    }])
  }, [setMenuItems, h24, toast, announce])

  const date = new Date(minute)
  const time = formatTime(date, h24)
  const withDay = size === "m"
  const welcome = welcomeParts(date)
  return (
    <div className="clock" data-size={withDay ? "day" : "time"}>
      <time className="clock-time" dateTime={localIso(date)}>
        <DotTime digits={time.digits} />
        {time.period && <span className="clock-period" aria-hidden>{time.period}</span>}
        <span className="sr-only">{time.text}</span>
      </time>
      {hello ? (
        <p key="hello" className="clock-line" data-hello>
          <span className="clock-hello">{welcome.greeting}</span>{" "}
          <span className="clock-hello-day">· {welcome.day}</span>
        </p>
      ) : (
        <p key="day" className="clock-line" data-turn={greeted.current || undefined}>
          {withDay ? dayLine(date, monthFirst()) : weekdayOf(date)}
        </p>
      )}
      {withDay && <HourDots hour={date.getHours()} />}
    </div>
  )
}

// The drawer's picture shows the minute it was drawn in, read afresh whenever
// the drawer renders (it does as it opens) and never ticking. The page itself
// is drawn at build time, so while it hydrates the picture is a fixed ten past ten
const noUpdates = () => () => {}
const readMinute = () => minuteStart(Date.now())
const TEN_PAST_TEN = new Date(2026, 0, 1, 10, 10)
const useDrawnAt = () => useSyncExternalStore(noUpdates, readMinute, () => null)

function Preview({ size }: PreviewProps) {
  const h24 = useH24()
  const drawn = useDrawnAt()
  const now = drawn === null ? TEN_PAST_TEN : new Date(drawn)
  const time = formatTime(now, h24)
  return (
    <span className="widget-preview preview-clock" data-size={size === "m" ? "day" : "time"} aria-hidden>
      <span className="clock-time">
        <DotTime digits={time.digits} still />
        {time.period && <span className="clock-period">{time.period}</span>}
      </span>
      <span className={`preview-line${size === "m" ? "" : " is-short"}`} />
      {size === "m" && <HourDots hour={now.getHours()} />}
    </span>
  )
}

export const definition: WidgetDefinition = {
  type: "clock",
  name: "Clock",
  blurb: "The time, and a quiet look at the day.",
  // the time alone is bare; with the day it's a card
  sizes: [
    { id: "s", label: "time" },
    { id: "m", label: "with the day", surface: "card" },
  ],
  defaultSize: "s",
  surface: "bare",
  maxInstances: 1,
  Component: Clock,
  Preview,
}
