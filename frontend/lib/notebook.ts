// The pocket notebook's page: one plain note, kept in lofai.notebook as
// {v:1, text, updatedAt}. Pure: reading never throws, and taking a line out
// to Tasks (and putting it back) is plain string work.

export const NOTEBOOK_KEY = "lofai.notebook"
// an unreadable or newer note is kept here, once, before anything is written over it
export const NOTEBOOK_BROKEN_KEY = "lofai.notebook.broken"
export const NOTEBOOK_VERSION = 1
export const NOTE_MAX_CHARS = 20000

export interface Note { text: string; updatedAt: number }
export type NoteStatus = "empty" | "ok" | "unreadable" | "future"

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff

// at most NOTE_MAX_CHARS, never cutting an emoji in half
export function clampNote(text: string): string {
  if (text.length <= NOTE_MAX_CHARS) return text
  const end = isHigh(text.charCodeAt(NOTE_MAX_CHARS - 1)) ? NOTE_MAX_CHARS - 1 : NOTE_MAX_CHARS
  return text.slice(0, end)
}

export function parseNote(raw: string | null): { note: Note; status: NoteStatus } {
  const blank: Note = { text: "", updatedAt: 0 }
  if (raw === null) return { note: blank, status: "empty" }
  let data: unknown
  try { data = JSON.parse(raw) } catch { return { note: blank, status: "unreadable" } }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { note: blank, status: "unreadable" }
  const { v, text, updatedAt } = data as Record<string, unknown>
  if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v || v < 1) return { note: blank, status: "unreadable" }
  const future = v > NOTEBOOK_VERSION
  // a newer build's note still has its words, if they're where we'd look
  if (typeof text !== "string") return { note: blank, status: future ? "future" : "unreadable" }
  const at = typeof updatedAt === "number" && isFinite(updatedAt) ? updatedAt : 0
  return { note: { text: clampNote(text), updatedAt: at }, status: future ? "future" : "ok" }
}

export function serializeNote(text: string, now: number): string {
  return JSON.stringify({ v: NOTEBOOK_VERSION, text: clampNote(text), updatedAt: now })
}

// Opening the saved page. An unreadable or newer note is kept aside first,
// once (only if nothing is kept there yet), before anything can be written
// over it. A newer one still opens with its words; an unreadable one starts
// a fresh page, and says so if it was kept.
export function openNote(raw: string | null, asideTaken: boolean): { text: string; keepAside: boolean; notice: boolean } {
  const { note, status } = parseNote(raw)
  const keepAside = raw !== null && !asideTaken && (status === "unreadable" || status === "future")
  return { text: note.text, keepAside, notice: keepAside && status === "unreadable" }
}

// Another tab saved the page. Its words come over unless this tab has
// changes of its own still to save (those win, at their save). A removed or
// unreadable value is never taken: this page keeps what it shows.
export function fromOtherTab(raw: string | null, dirty: boolean): string | null {
  if (dirty || raw === null) return null
  const { note, status } = parseNote(raw)
  return status === "ok" || (status === "future" && note.text) ? note.text : null
}

// What the foot of the page says, if anything: a short line that fits the
// pocket, and the whole sentence (for a title and screen readers). A save
// that failed matters most.
export interface Notice { short: string; full: string }
export function pageNotice(o: { saveError: boolean; full: boolean; setAside: boolean }): Notice | null {
  if (o.saveError) return { short: "not saved · here for this visit", full: "This browser couldn't save your note. It's here for this visit." }
  if (o.full) return { short: "page full · move a line to tasks", full: "This page is full. Moving a thought to tasks makes room." }
  if (o.setAside) return { short: "last note unreadable · fresh page", full: "Your last note couldn't be read, so this page starts fresh." }
  return null
}

export interface Line { start: number; end: number; text: string }

// the line the caret is on (start inclusive, end at its line break)
export function lineAt(text: string, caret: number): Line {
  const at = Math.max(0, Math.min(text.length, Math.floor(caret) || 0))
  const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1
  const nl = text.indexOf("\n", at)
  const end = nl < 0 ? text.length : nl
  return { start, end, text: text.slice(start, end) }
}

// a note line as a task: no list marker or checkbox in front, one space between words
const MARKER = /^\s*(?:(?:[-*+•·–—]|\d{1,3}[.)])\s+)?(?:\[[ xX]?\]\s*)?/
export function taskText(line: string): string {
  return line.replace(MARKER, "").replace(/\s+/g, " ").trim()
}

export interface Taken {
  // the page without it, and where its caret goes
  text: string
  caret: number
  // what goes to Tasks
  line: string
  // enough to put it back: the page as it was is
  // text.slice(0, at) + removed + text.slice(at + kept.length), with the caret at `from`
  at: number
  removed: string
  kept: string
  from: number
}

// Take the caret's line off the page, for Tasks. A blank line (or a bare
// bullet) gives null. A line longer than a task can hold gives the task what
// fits, cut at a word, and the rest stays on the page, so nothing is lost.
export function takeLine(text: string, caret: number, max = Infinity): Taken | null {
  const from = Math.max(0, Math.min(text.length, Math.floor(caret) || 0))
  const { start, end, text: raw } = lineAt(text, from)
  const task = taskText(raw)
  if (!task) return null
  if (task.length > max) {
    let cut = task.lastIndexOf(" ", max)
    if (cut < max / 2) cut = isHigh(task.charCodeAt(max - 1)) ? max - 1 : max
    const line = task.slice(0, cut).trim()
    const kept = task.slice(cut).trim()
    return { text: text.slice(0, start) + kept + text.slice(end), caret: start, line, at: start, removed: raw, kept, from }
  }
  // the line goes with its line break: the one after it, or before it on the last line
  if (end < text.length) {
    return { text: text.slice(0, start) + text.slice(end + 1), caret: start, line: task, at: start, removed: raw + "\n", kept: "", from }
  }
  if (start > 0) {
    return { text: text.slice(0, start - 1), caret: start - 1, line: task, at: start - 1, removed: "\n" + raw, kept: "", from }
  }
  return { text: "", caret: 0, line: task, at: 0, removed: raw, kept: "", from }
}

// Undo: the page as it was, if nothing changed since. If the only new words
// were written where the caret was left, the line goes back around them, as
// it sat. Anything else, and it goes back as a line at the end, so it's never
// lost. `whole` is false only when a full page had no room for all of it (the
// task should stay where it is then).
export function putBack(current: string, taken: Taken): { text: string; caret: number; whole: boolean } {
  const { at, removed, kept } = taken
  const head = taken.text.slice(0, at)
  const tail = taken.text.slice(at + kept.length)
  const rest = kept + tail
  let full: string
  let caret: number
  if (current === taken.text) {
    full = head + removed + tail
    caret = taken.from
  } else if (current.length >= head.length + rest.length && current.slice(0, at) === head && current.slice(current.length - rest.length) === rest) {
    const typed = current.slice(at, current.length - rest.length)
    if (removed.charAt(0) === "\n") {
      // the last line: what was written went on the end of the line before it
      full = head + typed + removed + tail
      caret = full.length - tail.length
    } else if (removed.charAt(removed.length - 1) === "\n") {
      // a middle line: it went at the start of the line after it
      full = head + removed + typed + tail
      caret = at + removed.length - 1
    } else if (kept) {
      // a long line's first part: in front of what stayed
      full = head + typed + removed + tail
      caret = at + typed.length + removed.length
    } else {
      // the only line: what was written comes after it
      full = removed + "\n" + typed
      caret = removed.length
    }
  } else {
    full = current + (current && current.charAt(current.length - 1) !== "\n" ? "\n" : "") + taken.line
    caret = full.length
  }
  const text = clampNote(full)
  return { text, caret: Math.min(caret, text.length), whole: text.length === full.length }
}
