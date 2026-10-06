"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { DotGlyph, DotPattern, GLYPHS } from "@/components/dot-glyph"
import { useDesk } from "@/components/desk/desk-provider"
import { ServiceIcon } from "@/components/service-icon"
import { useTasks } from "@/components/tasks-provider"
import { safeWebUrl, serviceName } from "@/lib/integrations"

// the bookmark key: an empty ribbon, filled (dot by dot, top down) once the
// task is on the desk. one 5x7 grid for both, so the dots can morph between
// them, struck at the row's small dot like its box and cross
const UNPINNED = ["XXXXX", "X...X", "X...X", "X...X", "X.X.X", "XX.XX", "X...X"]
const PINNED = GLYPHS.bookmark

// presentational: the list, its storage and Connections live in TasksProvider.
// On the desk the list scrolls inside the widget once it can't grow any more.
// `short` is the M widget: one row of header, and every other pixel is list,
// so the input only takes its place while something is being written.
export function TodoList({ short = false }: { short?: boolean }) {
  const {
    tasks: todos, mounted, pending, saveError, actionError, add: addTask, toggle, remove, restore, clearDone, stopSync, openConnections,
    activeTaskId, setActiveTask,
  } = useTasks()
  const { save, isOnDesk, takeOut, bringOut, setHint, isBuilt, toast } = useDesk()
  const [draft, setDraft] = useState("")
  // the row just put on the desk: only its mark drops in, not every mark on load
  const [fresh, setFresh] = useState<string | null>(null)
  // M only: the header has made room for the input
  const [writing, setWriting] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const plus = useRef<HTMLButtonElement | null>(null)
  const added = useRef<string | null>(null)
  // grown to L (or shrunk with the input open), the header is itself again
  const open = short && writing

  const done = todos.filter((t) => t.done).length
  const left = todos.length - done
  const ordered = useMemo(() => [...todos].sort((a, b) => Number(a.done) - Number(b.done)), [todos])
  // a finished task keeps its place on the desk (reopening brings it back) but shows no mark
  const pinnedId = todos.some((t) => t.id === activeTaskId && !t.done) ? activeTaskId : null

  // one task on the desk at a time; pressing it again takes it back off
  const pin = (id: string) => {
    if (activeTaskId === id) { setActiveTask(null); return }
    setActiveTask(id)
    setFresh(id)
    // the first time, On the desk comes out beside the timer to hold it. only
    // once: after that it stays wherever it's put, drawer included. nothing
    // happens while that widget isn't built. focus stays on the key
    if (!save.hints?.deskTaskPlaced && isBuilt("desk-task")) {
      if (!isOnDesk("desk-task")) {
        const list = document.getElementById("widget-tasks")
        if (list?.closest('[data-bucket="phone"]')) {
          // on the phone it goes in after the timer, below the list, and the
          // page stays where it is: the list stays under the finger that put it there
          const before = list.getBoundingClientRect().top
          flushSync(() => takeOut("desk-task", { near: "timer" }))
          const moved = list.getBoundingClientRect().top - before
          if (moved) window.scrollBy({ top: moved, behavior: "instant" })
        } else bringOut("desk-task", { near: "timer", focus: false })
      }
      setHint("deskTaskPlaced")
    }
  }

  // removing is one tap on a small key: it can be taken back, pin and all
  const removeTask = (id: string) => {
    const at = todos.findIndex((t) => t.id === id)
    const task = todos[at]
    if (!task) return
    const pinned = activeTaskId === id
    remove(id)
    toast("Task removed.", {
      undo: () => {
        restore(task, at)
        if (pinned) setActiveTask(id)
      },
      widget: "tasks",
    })
  }

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const next = addTask(draft)
    if (!next) return
    setDraft("")
    added.current = next.task.id
    // in M it stays open for the next one, and keeps the caret
    if (open) input.current?.focus()
  }

  // M: the input takes the header's place, focused, and gives it back on
  // Escape or when it's left empty. Focus goes back to the key that opened it,
  // never to the page
  useEffect(() => { if (open) input.current?.focus() }, [open])
  const closeWriting = (toPlus: boolean) => {
    setWriting(false)
    setDraft("")
    if (toPlus) plus.current?.focus()
  }

  // bring the new row into view inside the list, never by scrolling the page.
  // two frames: the widget grows into free rows first, if it can
  useEffect(() => {
    const id = added.current
    if (!id) return
    added.current = null
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const box = scroller.current
        const row = box?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`)
        if (!box || !row) return
        const top = row.offsetTop, bottom = top + row.offsetHeight
        if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight
        else if (top < box.scrollTop) box.scrollTop = top
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [todos])

  const form = (
    <form onSubmit={add} className="task-form flex gap-2">
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (open && e.key === "Escape") { e.preventDefault(); closeWriting(true) } }}
        onBlur={() => { if (open && !draft.trim()) closeWriting(false) }}
        placeholder="what's one small thing?"
        maxLength={500}
        aria-label="New task"
        className="panel-inset min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]"
      />
      <button type="submit" className="key task-send px-3 py-2 text-xs" aria-label="Add task"><DotGlyph name="plus" dot={2} /></button>
    </form>
  )

  return <div className="task-workspace flex min-h-0 flex-1 flex-col gap-3" data-short={short || undefined}>
    <div className="task-heading" data-writing={open || undefined}>
      {open ? form : <>
        <div><span className="label">Tasks</span>{mounted && todos.length > 0 && <span className="task-count">{left === 0 ? "all done" : `${done}/${todos.length} done`}</span>}</div>
        {short && <button ref={plus} type="button" className="key task-add" onClick={() => setWriting(true)} aria-label="Write a new task" title="Add a task"><DotGlyph name="plus" dot={2} /></button>}
        <button type="button" className="key task-connections" onClick={openConnections} aria-haspopup="dialog" aria-label="Connections" title="Bring tasks in"><DotGlyph name="tray" dot={2} /></button>
      </>}
    </div>
    {!short && form}
    {(saveError || actionError) && <p className="task-message" role="status">{actionError || saveError}</p>}
    <div ref={scroller} className="task-scroll dot-scroll"><div className="task-scroll-inner"><ul className="task-list">
      {todos.length === 0 && <li className="task-empty">{mounted && <><span>A little room for your next thing.</span><button type="button" onClick={openConnections}>Bring a task from elsewhere ↗</button></>}</li>}
      {ordered.map((todo) => <li key={todo.id} className="task-row group" data-task={todo.id}>
        <div className="task-row-main">
          <button type="button" onClick={() => void toggle(todo.id)} disabled={pending.has(todo.id)} aria-pressed={todo.done} aria-label={`${todo.done ? "Reopen" : "Complete"} ${todo.text}`} aria-busy={pending.has(todo.id)} className="task-check flex min-w-0 flex-1 items-center gap-3 text-left text-sm transition-colors hover:text-[var(--accent)]">
            <span className="relative shrink-0" style={{ width: 11, height: 11 }}><DotGlyph name="box" dot={1} className={`absolute inset-0 ${todo.done ? "opacity-25" : "opacity-50"}`} /><DotGlyph name="check" dot={1} className={`absolute inset-0 transition-opacity ${todo.done ? "opacity-100" : "opacity-0 group-hover:opacity-60"}`} color="var(--accent)" /></span>
            <span className="task-text" style={todo.done ? { textDecoration: "line-through", color: "var(--text-dim)" } : undefined}>{todo.text}</span>
          </button>
          {!todo.done && <button type="button" onClick={() => pin(todo.id)} aria-pressed={todo.id === pinnedId} aria-label={todo.id === pinnedId ? `Take ${todo.text} off the desk` : `Put ${todo.text} on the desk`} title={todo.id === pinnedId ? "Take it off the desk" : "Put it on the desk"} className="task-pin shrink-0">
            <DotPattern rows={todo.id === pinnedId ? PINNED : UNPINNED} dot={1} morph />
          </button>}
          <button type="button" disabled={pending.has(todo.id)} onClick={() => removeTask(todo.id)} aria-label={`Remove ${todo.text} from this list`} title="Remove from this list" className="task-remove shrink-0 opacity-30 transition-opacity hover:opacity-100 hover:text-[var(--bad)]"><DotGlyph name="cross" dot={1} /></button>
        </div>
        {todo.id === pinnedId && <div className="task-on-desk" data-fresh={fresh === todo.id || undefined}>on the desk</div>}
        {todo.source && <div className="task-source"><ServiceIcon service={todo.source.provider} dot={0.6} /><span>{serviceName(todo.source.provider)}</span>
          {safeWebUrl(todo.source.url) && <a href={safeWebUrl(todo.source.url)} target="_blank" rel="noreferrer" aria-label={`Open ${todo.text} in ${serviceName(todo.source.provider)}`}>Open ↗</a>}
          {todo.source.sync ? <button type="button" disabled={pending.has(todo.id)} title="Stop updating the original task" onClick={() => stopSync(todo.id)}>{pending.has(todo.id) ? "Updating…" : "Sync on · turn off"}</button> : <span className="task-copy">Local copy</span>}
        </div>}
      </li>)}
    </ul>
    {done > 0 && <button type="button" onClick={clearDone} className="task-clear">clear {done} done</button>}
    </div></div>
  </div>
}

export default TodoList
