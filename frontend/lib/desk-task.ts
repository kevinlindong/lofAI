// On the desk (components/widgets/desk-task): the words and small choices
// the widget makes, kept pure so they can be tested. Relative imports only.
import { safeWebUrl, serviceName, type ServiceId, type Task } from "./integrations"
import { parseDeskTask } from "./tasks-store"

// the picker shows a handful, never the whole list
export const PICK_LIMIT = 6
// "another little bit" after a block lands
export const LITTLE_BIT_MIN = 10
// a task pinned this recently was pinned for this widget to show (a pin from
// the list can take the widget out of the drawer): its ribbon still drops in
export const FRESH_PIN_MS = 1000

// open tasks to choose from, in the list's order, without the one already out
export function pickable(tasks: Task[], activeId: string | null, limit = PICK_LIMIT): { shown: Task[]; more: number } {
  const open = tasks.filter((task) => !task.done && task.id !== activeId)
  return { shown: open.slice(0, limit), more: Math.max(0, open.length - limit) }
}

export function minutesPhrase(minutes: number): string {
  const m = Math.max(1, Math.round(minutes))
  return `${m} minute${m === 1 ? "" : "s"}`
}

// the soft landing, when a block ends on its own. the time is the part worth
// noticing, so it comes apart from the rest
export function landingParts(minutes: number, withTask: boolean): { time: string; rest: string } {
  return { time: minutesPhrase(minutes), rest: ` ${withTask ? "with this" : "of focus"}. nicely done.` }
}

// the picker with nothing to offer: an empty list, or one that's all done
export function pickNone(total: number, pinned: boolean): string {
  if (pinned) return "Nothing else on the list."
  return total > 0 ? "Everything's done. Write a new one?" : "Nothing on the list yet."
}

// where focus goes when a soft landing moves on (by keyboard): the key that
// carries on in the next view. just the task (S) has no focus key, and a task
// finished from the list meanwhile offers the next one
export function keyAfterLanding(small: boolean, task: { done: boolean } | null, focusing: boolean): "focus" | "pick" | "swap" {
  if (!task) return focusing ? "focus" : "pick"
  return task.done || small ? "swap" : "focus"
}

// a service's reason, as the Tasks list words it, said from out here
export function hereCopy(message: string): string {
  return message.replace("beside the task.", "beside it in Tasks.")
}

// m:ss, unpadded (it reads inside a sentence): "18:42", "9:05"
export function clockText(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  const secs = total % 60
  return `${Math.floor(total / 60)}:${secs < 10 ? "0" : ""}${secs}`
}

// to the minute, for a screen reader, so it isn't handed every tick
export function spokenLeft(seconds: number): string {
  return `${minutesPhrase(Math.max(1, Math.ceil(seconds / 60)))} left`
}

export const littleBit = (workMin: number) => Math.max(1, Math.min(LITTLE_BIT_MIN, workMin))

export interface ClockState { phase: "focus" | "rest"; running: boolean; timeLeft: number; totalSec: number; workMin: number }
export type FocusMode = "start" | "pause" | "resume"

// The one focus key. Held, it offers a fresh block ("start 25 min" beside a
// task, "just focus" without one); running, it shows what's left and pauses;
// paused partway, it picks up where it was. During a rest it still offers
// focus: that's a choice to cut the breather short.
export function focusKey(c: ClockState, withTask: boolean): { mode: FocusMode; text: string; label: string } {
  if (c.running && c.phase === "focus") {
    return { mode: "pause", text: `${clockText(c.timeLeft)} left`, label: `Pause focus, ${spokenLeft(c.timeLeft)}` }
  }
  if (!c.running && c.phase === "focus" && c.timeLeft > 0 && c.timeLeft < c.totalSec - 0.5) {
    return { mode: "resume", text: `resume · ${clockText(c.timeLeft)}`, label: `Resume focus, ${spokenLeft(c.timeLeft)}` }
  }
  return withTask
    ? { mode: "start", text: `start ${c.workMin} min`, label: `Start ${minutesPhrase(c.workMin)} of focus on this` }
    : { mode: "start", text: "just focus", label: `Just focus, for ${minutesPhrase(c.workMin)}` }
}

// where an imported task came from, and a link back when it's a safe one
export function sourceBadge(task: Task | null): { provider: ServiceId; name: string; url?: string } | null {
  if (!task?.source) return null
  return { provider: task.source.provider, name: serviceName(task.source.provider), url: safeWebUrl(task.source.url) }
}

export function pinnedJustNow(raw: string | null, taskId: string | null, now: number, ms = FRESH_PIN_MS): boolean {
  const saved = parseDeskTask(raw)
  return !!saved && !!taskId && saved.taskId === taskId && saved.since > 0 && now - saved.since >= 0 && now - saved.since < ms
}
