import { SERVICES, safeWebUrl, type Task, type TaskSource } from "./integrations"

// pure task logic, moved out of TodoList so the list outlives its widget.
// the todos key and its shape are unchanged; doneAt is additive.
export const TASKS_KEY = "todos"
export const DESK_TASK_KEY = "lofai.desk-task"
export const TASK_MAX_CHARS = 500

export function restoreSource(value: unknown): TaskSource | undefined {
  if (!value || typeof value !== "object") return
  const source = value as Partial<TaskSource>
  if (!SERVICES.some((s) => s.id === source.provider) || typeof source.source !== "string" || typeof source.id !== "string") return
  return { provider: source.provider!, source: source.source, id: source.id, url: safeWebUrl(source.url), sync: source.sync === true }
}

// readable: false means the saved list is there but can't be opened. the
// caller must never write over it (a later build may still read it).
// JSON.parse errors are caught here; storage access errors are the caller's.
export function restoreTasks(raw: string | null, newId: () => string): { tasks: Task[]; readable: boolean } {
  if (!raw) return { tasks: [], readable: true }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { tasks: [], readable: false } }
  if (!Array.isArray(parsed)) return { tasks: [], readable: false }
  const seen = new Set<string>()
  const tasks = parsed.flatMap((t): Task[] => {
    if (!t || typeof t.text !== "string") return []
    let id = typeof t.id === "string" ? t.id : newId()
    if (seen.has(id)) id = newId()
    seen.add(id)
    const done = t.done === true || t.completed === true
    const task: Task = { id, text: t.text, done, source: restoreSource(t.source) }
    // only a finished task keeps its finish time
    if (done && typeof t.doneAt === "number" && isFinite(t.doneAt)) task.doneAt = t.doneAt
    return [task]
  })
  return { tasks, readable: true }
}

// imported copies match by source; local ones by text and state. a task
// mid-sync keeps its local copy, and only a synced task takes the remote check.
export function mergeImported(prev: Task[], incoming: Task[], inflight: ReadonlySet<string>): Task[] {
  const next = prev.slice()
  for (const task of incoming) {
    const index = next.findIndex((old) => task.source
      ? old.source?.provider === task.source.provider && old.source.source === task.source.source && old.source.id === task.source.id
      : !old.source && old.text === task.text && old.done === task.done)
    if (index < 0) next.push(task)
    else if (task.source && !inflight.has(next[index].id)) {
      const old = next[index]
      const merged: Task = { ...task, id: old.id, done: task.source.sync ? task.done : old.done }
      if (!merged.done) delete merged.doneAt
      else if (old.doneAt !== undefined) merged.doneAt = old.doneAt
      next[index] = merged
    }
  }
  return next
}

export function setDone(tasks: Task[], id: string, done: boolean, now: number): Task[] {
  return tasks.map((t) => {
    if (t.id !== id) return t
    const next: Task = { ...t, done }
    if (done) next.doneAt = now
    else delete next.doneAt
    return next
  })
}

export interface DeskTaskSave { taskId: string; since: number }

export function parseDeskTask(raw: string | null): DeskTaskSave | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (!data || data.v !== 1 || typeof data.taskId !== "string" || !data.taskId) return null
    return { taskId: data.taskId, since: typeof data.since === "number" && isFinite(data.since) ? data.since : 0 }
  } catch { return null }
}

export function serializeDeskTask(save: DeskTaskSave): string {
  return JSON.stringify({ v: 1, taskId: save.taskId, since: save.since })
}
