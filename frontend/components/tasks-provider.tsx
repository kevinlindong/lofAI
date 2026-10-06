"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ConnectionsPanel } from "@/components/connections-panel"
import { useRadio } from "@/components/radio-provider"
import { integrationRequest, serviceName, type Task } from "@/lib/integrations"
import { DESK_TASK_KEY, TASKS_KEY, TASK_MAX_CHARS, mergeImported, parseDeskTask, restoreTasks, serializeDeskTask, setDone } from "@/lib/tasks-store"

// a task just added, and whether this browser kept it (it may only be here for this visit)
export interface Added { task: Task; saved: boolean }

export interface TasksApi {
  tasks: Task[]; mounted: boolean; pending: ReadonlySet<string>; saveError: string; actionError: string
  // toggle resolves true once the task changed, false if it didn't (its service said no, or it's gone)
  add(text: string): Added | null; toggle(id: string): Promise<boolean>; remove(id: string): void
  // a removed task back where it was in the list (an Undo); a no-op if it's there already
  restore(task: Task, index: number): void
  clearDone(): void; importTasks(incoming: Task[]): void; stopSync(id: string): void
  activeTaskId: string | null; activeTask: Task | null; setActiveTask(id: string | null): void
  // takes this task off the desk if it's still the one there (safe after its widget has gone)
  clearActiveTask(id: string): void
  connectionsOpen: boolean; openConnections(): void; closeConnections(): void
}

const TasksContext = createContext<TasksApi | null>(null)
const UNSAVED = "Your list is here for this visit, but this browser couldn't save it. Export a copy in Connections."

// Finished tasks stay on the desk until the person clears them: a small
// record of what they got through. Connections never delete remote work.
// The list lives here rather than in its widget, so putting Tasks away
// keeps it, and Connections can open from anywhere.
export function TasksProvider({ children }: { children: ReactNode }) {
  const { handlePetEvent } = useRadio()
  const [tasks, setTasks] = useState<Task[]>([])
  const [mounted, setMounted] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [actionError, setActionError] = useState("")
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set<string>())
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const inflight = useRef(new Set<string>())
  const canPersist = useRef(true)
  // callbacks read the latest list without being rebuilt on every change
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  useEffect(() => {
    try {
      const restored = restoreTasks(localStorage.getItem(TASKS_KEY), () => crypto.randomUUID())
      if (!restored.readable) throw new Error("The saved list has an unexpected shape")
      setTasks(restored.tasks)
      localStorage.removeItem("todoScore")
    } catch {
      // Preserve unreadable saved data rather than overwriting it with an
      // empty list. New work can still be exported from the connections drawer.
      canPersist.current = false
      setSaveError("This browser couldn't open your saved list. New changes last this visit; export a copy in Connections.")
    }
    try { setActiveTaskId(parseDeskTask(localStorage.getItem(DESK_TASK_KEY))?.taskId ?? null) } catch { /* nothing on the desk */ }
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted || !canPersist.current) return
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); setSaveError("") }
    catch { setSaveError(UNSAVED) }
  }, [tasks, mounted])

  // another tab changed the list: this one takes it (the last word wins, as
  // it always did, but now it's the other tab's word rather than this tab's
  // stale copy writing over it). a task mid-sync here keeps this tab's copy
  // until its service answers. writing it back is a no-op, so tabs settle
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!canPersist.current) return
      if (event.key === DESK_TASK_KEY) {
        // taken off the desk there (removed), or another task put on it
        const id = event.newValue === null ? null : parseDeskTask(event.newValue)?.taskId ?? null
        activeRef.current = id
        setActiveTaskId(id)
        return
      }
      if (event.key !== TASKS_KEY || event.newValue === null) return
      const restored = restoreTasks(event.newValue, () => crypto.randomUUID())
      if (!restored.readable) return
      setTasks((current) => {
        const mine = new Map(current.map((t) => [t.id, t]))
        return restored.tasks.map((t) => (inflight.current.has(t.id) ? mine.get(t.id) ?? t : t))
      })
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const activeRef = useRef(activeTaskId)
  activeRef.current = activeTaskId
  const setActiveTask = useCallback((id: string | null) => {
    activeRef.current = id
    setActiveTaskId(id)
    try {
      if (id) localStorage.setItem(DESK_TASK_KEY, serializeDeskTask({ taskId: id, since: Date.now() }))
      else localStorage.removeItem(DESK_TASK_KEY)
    } catch { /* the desk remembers it for this visit */ }
  }, [])

  const clearActiveTask = useCallback((id: string) => { if (activeRef.current === id) setActiveTask(null) }, [setActiveTask])

  // a task that's gone (removed, cleared, or missing after load) leaves the
  // desk. an unreadable list may still hold it, so leave that one alone.
  useEffect(() => {
    if (mounted && canPersist.current && activeTaskId && !tasks.some((t) => t.id === activeTaskId)) setActiveTask(null)
  }, [mounted, tasks, activeTaskId, setActiveTask])

  // saved at once, not a render later, so a caller can tell whether it was kept
  // (the notebook only moves a line out once its task is safe)
  const add = useCallback((value: string): Added | null => {
    const text = value.trim().slice(0, TASK_MAX_CHARS)
    if (!text) return null
    const task: Task = { id: crypto.randomUUID(), text, done: false }
    const next = [...tasksRef.current, task]
    // back-to-back adds in one tick build on each other
    tasksRef.current = next
    let saved = canPersist.current
    if (saved) {
      try { localStorage.setItem(TASKS_KEY, JSON.stringify(next)) } catch { saved = false }
      setSaveError(saved ? "" : UNSAVED)
    }
    setTasks((previous) => [...previous, task])
    handlePetEvent("add")
    return { task, saved }
  }, [handlePetEvent])

  const toggle = useCallback(async (id: string): Promise<boolean> => {
    const todo = tasksRef.current.find((t) => t.id === id)
    if (!todo || inflight.current.has(id)) return false
    setActionError("")
    const nextDone = !todo.done
    const left = tasksRef.current.filter((t) => !t.done).length
    if (todo.source?.sync) {
      inflight.current.add(id); setPending(new Set(inflight.current))
      try {
        await integrationRequest(`/${todo.source.provider}/items/${encodeURIComponent(todo.source.id)}`, {
          method: "PATCH", body: JSON.stringify({ done: nextDone, source: todo.source.source }),
        })
      } catch (error) {
        setActionError(`${serviceName(todo.source.provider)}: ${error instanceof Error ? error.message : "Couldn't update this task."} Your checkmark hasn't changed. You can retry, or turn off sync beside the task.`)
        return false
      } finally { inflight.current.delete(id); setPending(new Set(inflight.current)) }
    }
    setTasks((previous) => setDone(previous, id, nextDone, Date.now()))
    handlePetEvent(todo.done ? "undo" : left === 1 ? "clear" : "complete")
    return true
  }, [handlePetEvent])

  const remove = useCallback((id: string) => { setTasks((prev) => prev.filter((t) => t.id !== id)) }, [])
  const restore = useCallback((task: Task, index: number) => {
    setTasks((prev) => prev.some((t) => t.id === task.id) ? prev : [...prev.slice(0, index), task, ...prev.slice(index)])
  }, [])
  // a task mid-sync stays until its service answers
  const clearDone = useCallback(() => { setTasks((prev) => prev.filter((t) => !t.done || inflight.current.has(t.id))) }, [])
  const stopSync = useCallback((id: string) => {
    setTasks((prev) => prev.map((task) => task.id === id && task.source ? { ...task, source: { ...task.source, sync: false } } : task))
  }, [])

  const importTasks = useCallback((incoming: Task[]) => {
    setTasks((previous) => mergeImported(previous, incoming, inflight.current))
    if (incoming.length) handlePetEvent("add")
  }, [handlePetEvent])

  const openConnections = useCallback(() => setConnectionsOpen(true), [])
  const closeConnections = useCallback(() => setConnectionsOpen(false), [])

  const activeTask = useMemo(() => activeTaskId ? tasks.find((t) => t.id === activeTaskId) ?? null : null, [tasks, activeTaskId])
  const api = useMemo<TasksApi>(() => ({
    tasks, mounted, pending, saveError, actionError,
    add, toggle, remove, restore, clearDone, importTasks, stopSync,
    activeTaskId, activeTask, setActiveTask, clearActiveTask,
    connectionsOpen, openConnections, closeConnections,
  }), [tasks, mounted, pending, saveError, actionError, add, toggle, remove, restore, clearDone, importTasks, stopSync,
    activeTaskId, activeTask, setActiveTask, clearActiveTask, connectionsOpen, openConnections, closeConnections])

  return <TasksContext.Provider value={api}>
    {children}
    {connectionsOpen && <ConnectionsPanel tasks={tasks} onImport={importTasks} onClose={closeConnections} />}
  </TasksContext.Provider>
}

export function useTasks(): TasksApi {
  const api = useContext(TasksContext)
  if (!api) throw new Error("useTasks must be used within TasksProvider")
  return api
}
