// pure focus-timer prefs and the session log. nothing here touches storage;
// FocusProvider reads and writes, these only parse, record and prune.
export const TIMER_KEY = "lofai.timer"
export const SESSIONS_KEY = "lofai.sessions"
export const WORK_MIN = 1, WORK_MAX = 60, WORK_DEFAULT = 25
export const REST_MIN = 1, REST_MAX = 30, REST_DEFAULT = 5
export const SESSION_DAYS = 14
export const SESSION_CAP = 500
const DAY_MS = 24 * 60 * 60 * 1000

export type FocusPhase = "focus" | "rest"
export interface TimerPrefs { work: number; rest: number }
export interface FocusSession { start: number; end: number; minutes: number; taskId: string | null }
// a focus block that just ended on its own, waiting for a soft landing
export interface Landing { at: number; minutes: number; taskId: string | null }

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

export const clampWork = (minutes: unknown) => clampInt(minutes, WORK_MIN, WORK_MAX, WORK_DEFAULT)
export const clampRest = (minutes: unknown) => clampInt(minutes, REST_MIN, REST_MAX, REST_DEFAULT)

// never throws; anything unreadable falls back to 25 and 5
export function parseTimerPrefs(raw: string | null): TimerPrefs {
  let data: unknown = null
  try { data = raw ? JSON.parse(raw) : null } catch { /* defaults below */ }
  const prefs = data && typeof data === "object" && (data as { v?: unknown }).v === 1 ? data as Partial<TimerPrefs> : {}
  return { work: clampWork(prefs.work), rest: clampRest(prefs.rest) }
}

export function serializeTimerPrefs(prefs: TimerPrefs): string {
  return JSON.stringify({ v: 1, work: clampWork(prefs.work), rest: clampRest(prefs.rest) })
}

function readSession(value: unknown): FocusSession | null {
  if (!value || typeof value !== "object") return null
  const s = value as Partial<FocusSession>
  if (typeof s.start !== "number" || !isFinite(s.start) || typeof s.end !== "number" || !isFinite(s.end) || s.end < s.start) return null
  if (typeof s.minutes !== "number" || !isFinite(s.minutes) || s.minutes <= 0) return null
  return { start: s.start, end: s.end, minutes: s.minutes, taskId: typeof s.taskId === "string" ? s.taskId : null }
}

// oldest first. drops anything that ended over 14 days ago, then keeps the
// newest 500
export function pruneSessions(sessions: FocusSession[], now: number): FocusSession[] {
  const since = now - SESSION_DAYS * DAY_MS
  const kept = sessions.filter((s) => s.end >= since).sort((a, b) => a.end - b.end)
  return kept.length > SESSION_CAP ? kept.slice(kept.length - SESSION_CAP) : kept
}

// never throws; unreadable data reads as an empty log
export function parseSessions(raw: string | null, now: number): FocusSession[] {
  let data: unknown = null
  try { data = raw ? JSON.parse(raw) : null } catch { return [] }
  if (!data || typeof data !== "object" || (data as { v?: unknown }).v !== 1) return []
  const list = (data as { sessions?: unknown }).sessions
  if (!Array.isArray(list)) return []
  const sessions: FocusSession[] = []
  for (const entry of list) {
    const s = readSession(entry)
    if (s) sessions.push(s)
  }
  return pruneSessions(sessions, now)
}

// the stored log and this tab's, each block once: a failed write leaves the
// stored copy behind what this visit has seen, and another tab may be ahead
export function mergeSessions(a: FocusSession[], b: FocusSession[]): FocusSession[] {
  const seen: Record<string, true> = {}
  return a.concat(b).filter((s) => {
    const key = `${s.start}:${s.end}`
    if (seen[key]) return false
    seen[key] = true
    return true
  })
}

export function recordSession(sessions: FocusSession[], session: FocusSession, now: number): FocusSession[] {
  return pruneSessions(sessions.concat([session]), now)
}

export function serializeSessions(sessions: FocusSession[]): string {
  return JSON.stringify({ v: 1, sessions })
}
