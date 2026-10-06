// What today looked like, for the Today postcard: the focus blocks that
// landed and the small things finished, inside the local calendar day. pure;
// the widget reads the providers and storage and hands them in. no streaks,
// scores or comparisons: a day is only ever held up against itself.
import type { FocusSession } from "./focus-store"
import type { Task } from "./integrations"

// finished things the list no longer holds (cleared, removed), so the day
// still remembers them
export const TODAY_KEY = "lofai.today"
const KEPT_CAP = 200
const TEXT_MAX = 500

// a bead's diameter by area: an hour is the biggest, a 50-minute block looks
// twice a 25, and short blocks never shrink past a readable dot
export const BEAD_MIN_PX = 6
export const BEAD_MAX_PX = 14
const BEAD_FULL_MIN = 60

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

export interface DayBounds { start: number; end: number }
export interface SentencePart { text: string; strong?: true; spoken?: string }
export interface DaySummary {
  // focus minutes, rounded
  minutes: number
  // each block that landed today, in minutes, oldest first
  blocks: number[]
  // small things finished today
  finished: number
  // as it reads, and the same split so the numbers can be set in bold
  sentence: string
  parts: SentencePart[]
}
export interface KeptThing { id: string; text: string; doneAt: number }

// the local day holding `now`, midnight to midnight: 23 or 25 hours when the
// clocks change, and where midnight itself is skipped it starts at the first
// instant that exists
export function dayBounds(now: number): DayBounds {
  const d = new Date(now)
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate()
  return { start: new Date(y, m, day).getTime(), end: new Date(y, m, day + 1).getTime() }
}

const within = (b: DayBounds, t: unknown): t is number => typeof t === "number" && isFinite(t) && t >= b.start && t < b.end

// a block belongs to the day it landed on
export function landedToday(sessions: FocusSession[], now: number): FocusSession[] {
  const b = dayBounds(now)
  return sessions.filter((s) => within(b, s.end) && s.minutes > 0).sort((a, c) => a.end - c.end)
}

// done, and done today; each id once
export function finishedToday(tasks: Task[], now: number): Task[] {
  const b = dayBounds(now)
  const seen: Record<string, true> = {}
  return tasks.filter((t) => {
    if (!t || t.done !== true || !within(b, t.doneAt) || Object.prototype.hasOwnProperty.call(seen, t.id)) return false
    seen[t.id] = true
    return true
  })
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// "50 minutes", "1 h 15 m", "2 h"; spoken in full
export function focusTime(minutes: number): { text: string; spoken: string } {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) {
    const text = plural(total, "minute", "minutes")
    return { text, spoken: text }
  }
  const h = Math.floor(total / 60), m = total % 60
  return {
    text: m ? `${h} h ${m} m` : `${h} h`,
    spoken: m ? `${plural(h, "hour", "hours")} ${plural(m, "minute", "minutes")}` : plural(h, "hour", "hours"),
  }
}

export function sentenceParts(minutes: number, finished: number): SentencePart[] {
  const time = focusTime(minutes)
  const strongTime: SentencePart = { text: time.text, strong: true, spoken: time.spoken }
  const things: SentencePart = { text: plural(finished, "small thing", "small things"), strong: true }
  if (minutes > 0 && finished > 0) return [{ text: "You made room for " }, strongTime, { text: " of focus and " }, things, { text: "." }]
  if (minutes > 0) return [{ text: "You made room for " }, strongTime, { text: " of focus." }]
  if (finished > 0) return [{ text: "You finished " }, things, { text: "." }]
  return [{ text: "Nothing needed today. The room's here when you are." }]
}

export function summarize(sessions: FocusSession[], tasks: Task[], now: number): DaySummary {
  const blocks = landedToday(sessions, now).map((s) => s.minutes)
  const sum = blocks.reduce((total, m) => total + m, 0)
  // a block always counts as some focus, however it was rounded
  const minutes = blocks.length ? Math.max(1, Math.round(sum)) : 0
  const finished = finishedToday(tasks, now).length
  const parts = sentenceParts(minutes, finished)
  return { minutes, blocks, finished, sentence: parts.map((p) => p.text).join(""), parts }
}

export function beadSize(minutes: number): number {
  const m = typeof minutes === "number" && isFinite(minutes) ? Math.max(0, minutes) : 0
  return Math.round(Math.min(BEAD_MAX_PX, Math.max(BEAD_MIN_PX, BEAD_MAX_PX * Math.sqrt(m / BEAD_FULL_MIN))))
}

// the string is one line, never a wrap: room is the narrowest postcard's
// text (a 320px phone), and a long day ends in a quiet "+N" for the rest
export const BEAD_GAP_PX = 6
export const BEAD_ROW_PX = 248
const MORE_PX = 28

// how many beads of these diameters, in order, fit the line
export function beadsThatFit(sizes: number[], room = BEAD_ROW_PX): number {
  let all = -BEAD_GAP_PX
  for (const d of sizes) all += BEAD_GAP_PX + d
  if (all <= room) return sizes.length
  // the rest get a count: leave it its place after the last bead shown
  let n = 0, w = sizes[0]
  while (w + BEAD_GAP_PX + MORE_PX <= room) w += BEAD_GAP_PX + sizes[++n]
  return n
}

// "tuesday, 29 september 2026": with the year, for a copy read months later
export function dayLine(now: number): string {
  const d = new Date(now)
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

// 2026-09-29, the local date
export function dayStamp(now: number): string {
  const d = new Date(now)
  const two = (n: number) => (n < 10 ? "0" : "") + n
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

// ── what the day remembers past "clear done" ─────────────────────────────

function readKept(value: unknown): KeptThing | null {
  if (!value || typeof value !== "object") return null
  const k = value as Partial<KeptThing>
  if (typeof k.id !== "string" || !k.id || typeof k.text !== "string" || typeof k.doneAt !== "number" || !isFinite(k.doneAt)) return null
  return { id: k.id, text: k.text.slice(0, TEXT_MAX), doneAt: k.doneAt }
}

const byDone = (a: KeptThing, b: KeptThing) => a.doneAt - b.doneAt

// never throws; only today's survive, each id once
export function parseKept(raw: string | null, now: number): KeptThing[] {
  let data: unknown = null
  try { data = raw ? JSON.parse(raw) : null } catch { return [] }
  if (!data || typeof data !== "object" || (data as { v?: unknown }).v !== 1) return []
  const list = (data as { finished?: unknown }).finished
  if (!Array.isArray(list)) return []
  const b = dayBounds(now)
  const seen: Record<string, true> = {}
  const out: KeptThing[] = []
  for (const entry of list) {
    const k = readKept(entry)
    if (!k || !within(b, k.doneAt) || Object.prototype.hasOwnProperty.call(seen, k.id)) continue
    seen[k.id] = true
    out.push(k)
  }
  return out.sort(byDone).slice(-KEPT_CAP)
}

export function serializeKept(kept: KeptThing[]): string {
  return JSON.stringify({ v: 1, finished: kept.map(({ id, text, doneAt }) => ({ id, text, doneAt })) })
}

// The list decides for everything it still holds: done today is kept (with
// its latest text and time), reopened is let go. What it no longer holds and
// was finished today stays: clearing tidies the list, it doesn't undo the day.
export function keepFinished(kept: KeptThing[], tasks: Task[], now: number): KeptThing[] {
  const b = dayBounds(now)
  const inList: Record<string, true> = {}
  for (const t of tasks) if (t && typeof t.id === "string") inList[t.id] = true
  const live = finishedToday(tasks, now).map((t) => ({ id: t.id, text: String(t.text).slice(0, TEXT_MAX), doneAt: t.doneAt as number }))
  const seen: Record<string, true> = {}
  for (const k of live) seen[k.id] = true
  const gone = kept.filter((k) => {
    if (Object.prototype.hasOwnProperty.call(inList, k.id) || Object.prototype.hasOwnProperty.call(seen, k.id) || !within(b, k.doneAt)) return false
    seen[k.id] = true
    return true
  })
  return live.concat(gone).sort(byDone).slice(-KEPT_CAP)
}

// the list, plus what the day kept that the list let go, as finished tasks
export function withKept(tasks: Task[], kept: KeptThing[]): Task[] {
  const inList: Record<string, true> = {}
  for (const t of tasks) inList[t.id] = true
  const extra = kept.filter((k) => !Object.prototype.hasOwnProperty.call(inList, k.id))
  return extra.length ? tasks.concat(extra.map((k) => ({ id: k.id, text: k.text, done: true, doneAt: k.doneAt }))) : tasks
}

// ── a copy to keep ───────────────────────────────────────────────────────

const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

// a task's words as they were typed: one line, and nothing in them (an
// imported `*args` or "[WIP]") turns into bold, a link or a heading
export function markdownText(text: string): string {
  return String(text).replace(/[\r\n]+/g, " ").trim().replace(/[\\`*_[\]<>#~]/g, "\\$&")
}

// The postcard as Markdown: the sentence, then each block and each finished
// thing. `time` formats a clock time (the browser's own format by default).
export function dayMarkdown(sessions: FocusSession[], tasks: Task[], now: number, o: { time?: (ms: number) => string } = {}): string {
  const time = o.time ?? clockTime
  const summary = summarize(sessions, tasks, now)
  const strong = summary.parts.map((p) => (p.strong ? `**${p.text}**` : p.text)).join("")
  const lines = [`# Today · ${dayLine(now)}`, "", strong]
  const blocks = landedToday(sessions, now)
  if (blocks.length) {
    lines.push("", "## Focus", "")
    for (const s of blocks) lines.push(`- ${focusTime(Math.max(1, Math.round(s.minutes))).text}, ${time(s.start)} to ${time(s.end)}`)
  }
  const done = finishedToday(tasks, now).sort((a, c) => (a.doneAt as number) - (c.doneAt as number))
  if (done.length) {
    lines.push("", "## Finished", "")
    for (const t of done) lines.push(`- [x] ${markdownText(t.text)}`)
  }
  lines.push("", "_A postcard from lofAI._", "")
  return lines.join("\n")
}
