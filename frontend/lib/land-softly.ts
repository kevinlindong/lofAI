// Land softly: the pure parts of a focus block that ran out. which task the
// minutes go to, what [done] would act on, and the words. the timer's note
// renders these; nothing here touches storage or finishes anything.

export interface LandingTask { id: string; text: string; done: boolean; doneAt?: number }
export interface LandedBlock { at: number; minutes: number; taskId: string | null }
interface Session { start: number; end: number }

// whole minutes, never "0 minutes"
export function minutesOf(minutes: number): string {
  const m = Math.max(1, Math.round(minutes))
  return `${m} minute${m === 1 ? "" : "s"}`
}

// when the block began, pauses included: its session in the log, or else
// its length back from the end
export function blockStart(sessions: readonly Session[], landing: LandedBlock): number {
  for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].end === landing.at) return sessions[i].start
  return landing.at - landing.minutes * 60000
}

// the task those minutes were for: still open, or checked off after the
// block began. one finished before it started wasn't what they were about
export function creditedTask<T extends LandingTask>(tasks: readonly T[], landing: LandedBlock, startedAt: number): T | null {
  const task = landing.taskId ? tasks.find((t) => t.id === landing.taskId) : undefined
  if (!task) return null
  if (!task.done) return task
  return typeof task.doneAt === "number" && task.doneAt >= startedAt ? task : null
}

// [done] finishes a task only if there's one still open; otherwise it's just done for now
export const doneTarget = (task: LandingTask | null): string | null => task && !task.done ? task.id : null
export const doneLabel = (task: LandingTask | null) => task && !task.done ? `Done with ${task.text}` : "Done for now"

// after [done]'s toggle: finished (or gone meanwhile) lets the note go.
// still open means its service said no, and the note stays for another try
export function afterDone(tasks: readonly LandingTask[], id: string): "finished" | "still-open" {
  const now = tasks.find((t) => t.id === id)
  return now && !now.done ? "still-open" : "finished"
}

// "another little bit": ten minutes at most, never more than a whole block
export const anotherBit = (workMin: number) => Math.max(1, Math.min(10, Math.round(workMin)))

export const landingCopy = (minutes: number, withTask: boolean) => `${minutesOf(minutes)} ${withTask ? "with this" : "of focus"}. nicely done.`
// said once, aloud, as the block lands
export const landingNews = (minutes: number, taskText: string | null) => `${minutesOf(minutes)} ${taskText ? `with ${taskText}` : "of focus"}. nicely done.`
// just the time: the one line that opens the note
export const landedLine = (minutes: number) => `${minutesOf(minutes)}. nicely done.`
export const stillOpenCopy = (service: string) => `Couldn't update ${service}. It's still open.`
