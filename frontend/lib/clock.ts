// The clock's pure parts: what it says, the dots it says it in, the day's
// hour dots, when the next minute begins, and the welcome back. Relative
// imports only (the unit tests load this file on its own).

export const CLOCK_KEY = "lofai.clock"
// back after this long away, the date line says hello first
export const WELCOME_AFTER_MS = 20 * 60 * 60 * 1000
// for the first minute
export const WELCOME_FOR_MS = 60 * 1000
// the day's dots: an hour each from 8am to midnight
export const FIRST_HOUR = 8
export const HOURS = 16

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

export interface ClockTime {
  // what the dots show: "9:07" or "12:45" on a 12-hour clock, "09:07" on a 24-hour one
  digits: string
  period: "am" | "pm" | null
  // what a screen reader hears
  text: string
}

const two = (n: number) => (n < 10 ? `0${n}` : String(n))

export function formatTime(date: Date, h24: boolean): ClockTime {
  const h = date.getHours()
  const mm = two(date.getMinutes())
  if (h24) {
    const digits = `${two(h)}:${mm}`
    return { digits, period: null, text: digits }
  }
  const period = h < 12 ? "am" : "pm"
  const digits = `${h % 12 || 12}:${mm}`
  return { digits, period, text: `${digits} ${period}` }
}

export const weekdayOf = (date: Date) => WEEKDAYS[date.getDay()]

// the wall time as a <time dateTime>: "2026-09-29T14:05", local, to the minute
export const localIso = (date: Date) =>
  `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`

// "tuesday, 29 september", or "tuesday, september 29" where the month comes first
export function dayLine(date: Date, monthFirst = false): string {
  const day = date.getDate()
  const month = MONTHS[date.getMonth()]
  return `${weekdayOf(date)}, ${monthFirst ? `${month} ${day}` : `${day} ${month}`}`
}

// whether this locale says the month before the day (Intl's formatToParts types)
export function monthBeforeDay(parts: string[]): boolean {
  const month = parts.indexOf("month"), day = parts.indexOf("day")
  return month >= 0 && day >= 0 && month < day
}

export type HourMark = "past" | "now" | "future"

// one dot per hour from 8am to midnight; before 8 the whole day is still ahead
export function hourDotsAt(hour: number): HourMark[] {
  const out: HourMark[] = []
  for (let i = 0; i < HOURS; i++) {
    const h = FIRST_HOUR + i
    out.push(h < hour ? "past" : h === hour ? "now" : "future")
  }
  return out
}
export const hourDots = (date: Date) => hourDotsAt(date.getHours())

// until the next minute begins on the wall, in (0, 60000]
export function msToNextMinute(now: number | Date): number {
  const d = typeof now === "number" ? new Date(now) : now
  return 60000 - (d.getSeconds() * 1000 + d.getMilliseconds())
}
// the start of this minute
export const minuteStart = (now: number) => now + msToNextMinute(now) - 60000

// a moment past the turn, so the wall has really moved on when it's read
export const LATE_MS = 30
// the minute to show and how long until the next, from one reading of the
// wall: what's shown and when it next changes can never disagree
export function clockStep(now: number): { minute: number; wait: number } {
  const wait = msToNextMinute(now)
  return { minute: now + wait - 60000, wait: wait + LATE_MS }
}

// a real return: a day's worth away, give or take a night's sleep
export function welcomeBack(awayMs: number | null | undefined): boolean {
  return typeof awayMs === "number" && isFinite(awayMs) && awayMs >= WELCOME_AFTER_MS
}
// never how long it's been; only that it's good to see them, and what day it is
export const welcomeParts = (date: Date) => ({ greeting: "nice to see you", day: `it's ${weekdayOf(date)}` })
export function welcomeLine(date: Date): string {
  const { greeting, day } = welcomeParts(date)
  return `${greeting} · ${day}`
}
// how much of the visit's first minute is left, counted from when the page
// was first in view (a tab that opened in the background hasn't been seen yet)
export const welcomeLeft = (firstSeenAt: number, now: number) => WELCOME_FOR_MS - (now - firstSeenAt)

// --- 12 or 24 hours (lofai.clock) ---

export interface ClockPrefs { h24: boolean }

// null: nothing chosen yet (or unreadable), so the locale decides
export function parseClockPrefs(raw: string | null): ClockPrefs | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    return data && typeof data === "object" && data.v === 1 && typeof data.h24 === "boolean" ? { h24: data.h24 } : null
  } catch {
    return null
  }
}
export const serializeClockPrefs = (prefs: ClockPrefs) => JSON.stringify({ v: 1, h24: prefs.h24 })

// Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
export function prefers24h(o: { hourCycle?: string; hour12?: boolean }): boolean {
  if (o.hourCycle) return o.hourCycle === "h23" || o.hourCycle === "h24"
  return o.hour12 === undefined ? true : !o.hour12
}

// --- the dots ---

// Struck on a 5×7 grid like the rest of the dot glyphs, with soft corners so
// the numbers read round rather than boxy. A plain zero (no slash), an open
// four (the crossed one reads as a plus at a glance), and a one three dots wide
export const DIGITS: Record<string, readonly string[]> = {
  "0": [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  "1": [".X.", "XX.", ".X.", ".X.", ".X.", ".X.", "XXX"],
  "2": [".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX"],
  "3": [".XXX.", "X...X", "....X", "..XX.", "....X", "X...X", ".XXX."],
  "4": ["X...X", "X...X", "X...X", "XXXXX", "....X", "....X", "....X"],
  "5": ["XXXXX", "X....", "XXXX.", "....X", "....X", "X...X", ".XXX."],
  "6": ["..XX.", ".X...", "X....", "XXXX.", "X...X", "X...X", ".XXX."],
  "7": ["XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X..."],
  "8": [".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX."],
  "9": [".XXX.", "X...X", "X...X", ".XXXX", "....X", "...X.", ".XX.."],
  ":": [".", ".", "X", ".", "X", ".", "."],
}
// every digit sits in a cell five dots wide, a one in the middle of its cell
const CELLS: Record<string, readonly string[]> = {}
Object.keys(DIGITS).forEach((ch) => {
  const rows = DIGITS[ch]
  CELLS[ch] = ch === ":" || rows[0].length === 5 ? rows : rows.map((row) => `.${row}.`)
})
const BLANK = DIGITS["0"].map(() => ".....")

export type GlyphKey = "h0" | "h1" | "c" | "m0" | "m1"
export interface Glyph {
  // Where it sits. Each place keeps its cell, and so its dots, all day: a
  // changed digit's dots go out and come on one by one, wherever it changed
  key: GlyphKey
  rows: readonly string[]
  // a leading one, flush with the edge: drawn in its cell's middle three
  // columns, and the cell pulled in to fit them
  narrow?: true
  // no tens of hours ("9:07"): every dot dark, and the cell takes no room
  blank?: true
}

// The time's cells, always h0 h1 : m0 m1. Every digit is five wide except a
// leading one, so the time keeps its width all hour, and only changes when
// the number of digits does, or a leading one comes or goes
export function timeGlyphs(digits: string): Glyph[] {
  const [hours, minutes] = digits.split(":")
  const hh = hours.length < 2 ? ` ${hours}` : hours
  const lead = hh[0] === " " ? 1 : 0
  const out: Glyph[] = []
  const add = (key: GlyphKey, ch: string, leading: boolean) => {
    const rows = ch === ":" ? undefined : CELLS[ch]
    if (!rows) out.push({ key, rows: BLANK, blank: true })
    else if (leading && ch === "1") out.push({ key, rows, narrow: true })
    else out.push({ key, rows })
  }
  add("h0", hh[0], lead === 0)
  add("h1", hh[1], lead === 1)
  out.push({ key: "c", rows: DIGITS[":"] })
  add("m0", (minutes ?? "")[0] ?? "", false)
  add("m1", (minutes ?? "")[1] ?? "", false)
  return out
}
// the same place with every dot out: the old time, going out where it stands
const DARK_COLON = DIGITS[":"].map(() => ".")
export const darkGlyph = (glyph: Glyph): Glyph => ({ ...glyph, rows: glyph.key === "c" ? DARK_COLON : BLANK })
// how the time is laid out: when this changes, so does the time's width
export const glyphLayout = (glyphs: Glyph[]) => glyphs.map((g) => (g.blank ? "b" : g.narrow ? "n" : "w")).join("")
// how many columns of dots the time shows, for the tests
export const glyphColumns = (glyph: Glyph) => (glyph.blank ? 0 : glyph.narrow ? 3 : glyph.rows[0].length)
