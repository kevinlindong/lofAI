"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { DotGlyph } from "@/components/dot-glyph"
import { ServiceIcon } from "@/components/service-icon"
import { ConnectionsPanel } from "@/components/connections-panel"
import { SERVICES, integrationRequest, safeWebUrl, serviceName, type Task, type TaskSource } from "@/lib/integrations"
import type { PetEvent } from "@/components/pet"

interface TodoListProps { onEvent: (kind: PetEvent) => void }

function restoreSource(value: unknown): TaskSource | undefined {
  if (!value || typeof value !== "object") return
  const source = value as Partial<TaskSource>
  if (!SERVICES.some((s) => s.id === source.provider) || typeof source.source !== "string" || typeof source.id !== "string") return
  return { provider: source.provider!, source: source.source, id: source.id, url: safeWebUrl(source.url), sync: source.sync === true }
}

// Finished tasks stay on the desk until the person clears them: a small
// record of what they got through. Connections never delete remote work.
export function TodoList({ onEvent }: TodoListProps) {
  const [todos, setTodos] = useState<Task[]>([])
  const [draft, setDraft] = useState("")
  const [mounted, setMounted] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [actionError, setActionError] = useState("")
  const [pending, setPending] = useState<Set<string>>(new Set())
  const inflight = useRef(new Set<string>())
  const canPersist = useRef(true)

  useEffect(() => {
    try {
      const saved = localStorage.getItem("todos")
      if (saved) {
        const parsed: unknown = JSON.parse(saved)
        if (Array.isArray(parsed)) {
          const seen = new Set<string>()
          setTodos(parsed.flatMap((t) => {
            if (!t || typeof t.text !== "string") return []
            let id = typeof t.id === "string" ? t.id : crypto.randomUUID()
            if (seen.has(id)) id = crypto.randomUUID()
            seen.add(id)
            return [{ id, text: t.text, done: t.done === true || t.completed === true, source: restoreSource(t.source) }]
          }))
        } else throw new Error("The saved list has an unexpected shape")
      }
      localStorage.removeItem("todoScore")
    } catch {
      // Preserve unreadable saved data rather than overwriting it with an
      // empty list. New work can still be exported from the connections drawer.
      canPersist.current = false
      setSaveError("This browser couldn't open your saved list. New changes last this visit; export a copy in Connections.")
    }
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted || !canPersist.current) return
    try { localStorage.setItem("todos", JSON.stringify(todos)); setSaveError("") }
    catch { setSaveError("Your list is here for this visit, but this browser couldn't save it. Export a copy in Connections.") }
  }, [todos, mounted])

  const done = todos.filter((t) => t.done).length
  const left = todos.length - done
  const ordered = useMemo(() => [...todos].sort((a, b) => Number(a.done) - Number(b.done)), [todos])

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setTodos((previous) => [...previous, { id: crypto.randomUUID(), text, done: false }])
    setDraft(""); onEvent("add")
  }

  const toggle = async (id: string) => {
    const todo = todos.find((t) => t.id === id)
    if (!todo || inflight.current.has(id)) return
    setActionError("")
    const nextDone = !todo.done
    if (todo.source?.sync) {
      inflight.current.add(id); setPending(new Set(inflight.current))
      try {
        await integrationRequest(`/${todo.source.provider}/items/${encodeURIComponent(todo.source.id)}`, {
          method: "PATCH", body: JSON.stringify({ done: nextDone, source: todo.source.source }),
        })
      } catch (error) {
        setActionError(`${serviceName(todo.source.provider)}: ${error instanceof Error ? error.message : "Couldn't update this task."} Your checkmark hasn't changed. You can retry, or turn off sync beside the task.`)
        return
      } finally { inflight.current.delete(id); setPending(new Set(inflight.current)) }
    }
    setTodos((previous) => previous.map((t) => t.id === id ? { ...t, done: nextDone } : t))
    onEvent(todo.done ? "undo" : left === 1 ? "clear" : "complete")
  }

  const importTasks = (incoming: Task[]) => {
    setTodos((previous) => {
      const next = [...previous]
      for (const task of incoming) {
        const index = next.findIndex((old) => task.source
          ? old.source?.provider === task.source.provider && old.source.source === task.source.source && old.source.id === task.source.id
          : !old.source && old.text === task.text && old.done === task.done)
        if (index < 0) next.push(task)
        else if (task.source && !inflight.current.has(next[index].id)) next[index] = { ...task, id: next[index].id, done: task.source.sync ? task.done : next[index].done }
      }
      return next
    })
    if (incoming.length) onEvent("add")
  }

  return <div className="task-workspace flex min-h-0 flex-1 flex-col gap-3">
    <div className="task-heading">
      <div><span className="label">Tasks</span>{mounted && todos.length > 0 && <span className="task-count readout">{left === 0 ? "all done" : `${done}/${todos.length} done`}</span>}</div>
      <div className="task-heading-actions">
        {done > 0 && <button type="button" onClick={() => setTodos((prev) => prev.filter((t) => !t.done || pending.has(t.id)))} className="task-clear">Clear done</button>}
        <button type="button" className="key task-connections" onClick={() => setConnectionsOpen(true)} aria-haspopup="dialog"><DotGlyph name="plus" dot={1} /><span>Connections</span></button>
      </div>
    </div>
    <form onSubmit={add} className="flex gap-2">
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="what's one small thing?" maxLength={500} aria-label="New task" className="panel-inset min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]" />
      <button type="submit" className="key px-3 py-2 text-xs" aria-label="Add task"><DotGlyph name="plus" dot={2} /></button>
    </form>
    {(saveError || actionError) && <p className="task-message" role="status">{actionError || saveError}</p>}
    <ul className="dot-scroll task-list min-h-0 flex-1 overflow-y-auto pr-1">
      {todos.length === 0 && <li className="task-empty">{mounted && <><span>A little room for your next thing.</span><button type="button" onClick={() => setConnectionsOpen(true)}>Bring a task from elsewhere ↗</button></>}</li>}
      {ordered.map((todo) => <li key={todo.id} className="task-row group">
        <div className="task-row-main">
          <button type="button" onClick={() => void toggle(todo.id)} disabled={pending.has(todo.id)} aria-pressed={todo.done} aria-label={`${todo.done ? "Reopen" : "Complete"} ${todo.text}`} aria-busy={pending.has(todo.id)} className="task-check flex min-w-0 flex-1 items-center gap-3 text-left text-sm transition-colors hover:text-[var(--accent)]">
            <span className="relative shrink-0" style={{ width: 11, height: 11 }}><DotGlyph name="box" dot={1} className={`absolute inset-0 ${todo.done ? "opacity-25" : "opacity-50"}`} /><DotGlyph name="check" dot={1} className={`absolute inset-0 transition-opacity ${todo.done ? "opacity-100" : "opacity-0 group-hover:opacity-60"}`} color="var(--accent)" /></span>
            <span className="task-text" style={todo.done ? { textDecoration: "line-through", color: "var(--text-dim)" } : undefined}>{todo.text}</span>
          </button>
          <button type="button" disabled={pending.has(todo.id)} onClick={() => setTodos((prev) => prev.filter((t) => t.id !== todo.id))} aria-label={`Remove ${todo.text} from this list`} title="Remove from this list" className="task-remove shrink-0 opacity-30 transition-opacity hover:opacity-100 hover:text-[var(--bad)]"><DotGlyph name="cross" dot={1} /></button>
        </div>
        {todo.source && <div className="task-source"><ServiceIcon service={todo.source.provider} dot={0.6} /><span>{serviceName(todo.source.provider)}</span>
          {safeWebUrl(todo.source.url) && <a href={safeWebUrl(todo.source.url)} target="_blank" rel="noreferrer" aria-label={`Open ${todo.text} in ${serviceName(todo.source.provider)}`}>Open ↗</a>}
          {todo.source.sync ? <button type="button" disabled={pending.has(todo.id)} title="Stop updating the original task" onClick={() => setTodos((prev) => prev.map((task) => task.id === todo.id && task.source ? { ...task, source: { ...task.source, sync: false } } : task))}>{pending.has(todo.id) ? "Updating…" : "Sync on · turn off"}</button> : <span className="task-copy">Local copy</span>}
        </div>}
      </li>)}
    </ul>
    {connectionsOpen && <ConnectionsPanel tasks={todos} onImport={importTasks} onClose={() => setConnectionsOpen(false)} />}
  </div>
}

export default TodoList
