"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { DotGlyph, DotPattern } from "@/components/dot-glyph"
import { useDesk } from "@/components/desk/desk-provider"
import { useWidgetFrame } from "@/components/desk/widget-frame"
import type { PreviewProps, WidgetDefinition, WidgetProps } from "@/components/desk/types"
import { useFocus, useFocusClock } from "@/components/focus-provider"
import type { PetEvent } from "@/components/pet"
import { useRadio } from "@/components/radio-provider"
import { ServiceIcon } from "@/components/service-icon"
import { useTasks } from "@/components/tasks-provider"
import type { Task } from "@/lib/integrations"
import { blockStart, creditedTask } from "@/lib/land-softly"
import { DESK_TASK_KEY, TASK_MAX_CHARS } from "@/lib/tasks-store"
import { clockText, focusKey, hereCopy, keyAfterLanding, landingParts, littleBit, minutesPhrase, pickNone, pickable, pinnedJustNow, sourceBadge, spokenLeft, type FocusMode } from "@/lib/desk-task"

// a little bookmark, notched and taller than wide so it never reads as a grip,
// for the [pick a task] key and the pull
const MARK = ["XXX", "XXX", "XXX", "X.X"]
// the ribbon: the two rows over the edge are where it folds, a shade deeper
const FOLD = ["XXXXX", "XXXXX"]
const TAIL = ["XXXXX", "XXXXX", "XXXXX", "XX.XX", "X...X"]
// how long the ribbon takes to lift away, and the check to be seen
const LIFT_MS = 420
const CHECK_MS = 900
const CHECK_MS_STILL = 400

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

// the cat's ear, without re-rendering the widget whenever the radio does.
// a layout effect, so it's there before the widget's own first look
function PetBridge({ to }: { to: MutableRefObject<((kind: PetEvent) => void) | null> }) {
  const { handlePetEvent } = useRadio()
  useLayoutEffect(() => { to.current = handlePetEvent }, [to, handlePetEvent])
  return null
}

// The ribbon hangs over the frame's top edge, so it lives in the frame's
// .wf-deco (the card clips its body). It drops in when a task is put on the
// desk, and lifts away when the task leaves it (done, or back to the list).
function Ribbon({ host, taskId, drop }: { host: HTMLElement | null; taskId: string | null; drop: string | null }) {
  const [leaving, setLeaving] = useState<string | null>(null)
  const last = useRef(taskId)
  // before paint, so it never blinks out before it lifts
  useLayoutEffect(() => {
    const prev = last.current
    last.current = taskId
    if (taskId) { setLeaving(null); return }
    if (!prev) return
    setLeaving(prev)
    const timer = window.setTimeout(() => setLeaving(null), LIFT_MS)
    return () => window.clearTimeout(timer)
  }, [taskId])
  const id = taskId ?? leaving
  if (!host || !id) return null
  return createPortal(
    <span key={id} className="dt-ribbon" data-drop={(!!taskId && drop === id) || undefined} data-lift={!taskId || undefined}>
      <DotPattern rows={FOLD} dot={3} className="dt-ribbon-fold" />
      <DotPattern rows={TAIL} dot={3} />
    </span>,
    host,
  )
}

// the one focus key, and the only part of the widget that follows the tick
function FocusKey({ withTask, onSay }: { withTask: boolean; onSay(mode: FocusMode, minutes: number): void }) {
  const { phase, running, totalSec, workMin, start, pause } = useFocus()
  const { timeLeft } = useFocusClock()
  const key = focusKey({ phase, running, timeLeft, totalSec, workMin }, withTask)
  return (
    <button
      type="button"
      className="dt-key dt-focus"
      data-dt="focus"
      data-mode={key.mode}
      // running, the name changes by the minute rather than every second
      aria-label={key.label}
      onClick={() => {
        if (key.mode === "pause") pause()
        else if (key.mode === "resume") start()
        else start({ phase: "focus" })
        onSay(key.mode, key.mode === "start" ? workMin : Math.ceil(timeLeft / 60))
      }}
    >
      <DotGlyph name={key.mode === "pause" ? "pauseSmall" : "playSmall"} dot={1.4} />
      <span>{key.text}</span>
    </button>
  )
}

// just the task (S) has no focus key, so the label row says what's left
function LeftWhisper() {
  const { phase, running } = useFocus()
  const { timeLeft } = useFocusClock()
  if (!running || phase !== "focus") return null
  return (
    <span className="dt-whisper">
      <span aria-hidden>{clockText(timeLeft)} left</span>
      <span className="sr-only">, {spokenLeft(timeLeft)}</span>
    </span>
  )
}

// where it came from. just the task (S) keeps it on the keys' row, with the
// service's name as the link, so a two-line task still fits; with actions (M)
// it has room for "back to the list" at its far end
function Source({ task, inline = false, head = false, children }: { task: Task; inline?: boolean; head?: boolean; children?: ReactNode }) {
  const badge = sourceBadge(task)
  if (!badge) return null
  const label = `Open ${task.text} in ${badge.name}`
  if (inline) {
    return (
      <span className={`dt-source is-inline${head ? " is-head" : ""}`}>
        <ServiceIcon service={badge.provider} dot={0.6} />
        {badge.url ? <a href={badge.url} target="_blank" rel="noreferrer" aria-label={label}>{badge.name} ↗</a> : <span>{badge.name}</span>}
      </span>
    )
  }
  return (
    <p className="dt-source">
      <ServiceIcon service={badge.provider} dot={0.7} />
      <span>{badge.name}</span>
      {badge.url && <a href={badge.url} target="_blank" rel="noreferrer" aria-label={label}>Open ↗</a>}
      {children}
    </p>
  )
}

type View = "empty" | "task" | "landing" | "finishing"
// [done] pressed: the task is on its way to done (a synced one asks its
// service first). it keeps the view it was pressed in, landing line and all
interface Finishing { task: Task; settled: boolean; from: "task" | "landing"; minutes: number }

function DeskTask({ size }: WidgetProps) {
  const { tasks, mounted, pending, actionError, add, toggle, activeTask, activeTaskId, setActiveTask, clearActiveTask } = useTasks()
  const { landing, sessions, workMin, start, dismissLanding } = useFocus()
  const { setExpanded, setMenuItems } = useWidgetFrame()
  const { announce, toast } = useDesk()
  const small = size === "s"
  const pickerId = useId()

  const rootRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const perk = useRef<((kind: PetEvent) => void) | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  // the one little sheet this card unfolds: the task picker, or the landing's
  // leftover choices. Only one at a time, and each belongs to one view
  const [sheet, setSheet] = useState<"pick" | "more" | null>(null)
  // where the content sat in the card when the picker opened, so it stays put
  const [keep, setKeep] = useState(0)
  const [draft, setDraft] = useState("")
  const [finishing, setFinishing] = useState<Finishing | null>(null)
  // a done that its service turned down: the task stays, and says why
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)
  const [drop, setDrop] = useState<string | null>(null)
  // the desk just cleared: the question waits for the card to settle
  const [settle, setSettle] = useState(false)

  // the task those minutes went to, the timer's way: open, or checked off
  // while they ran (one finished before the block began wasn't what it was for)
  const landed = landing ? creditedTask(tasks, landing, blockStart(sessions, landing)) : null
  const view: View = finishing ? "finishing" : landing ? "landing" : activeTask ? "task" : "empty"
  // what's drawn: while finishing, still the view [done] was pressed in
  const shown = finishing ? finishing.from : view
  const open = sheet === "pick" && (view === "task" || view === "empty")
  const moreOpen = sheet === "more" && (view === "landing" || view === "finishing")
  const unfolded = open || moreOpen
  const checked = !!finishing && tasks.some((task) => task.id === finishing.task.id && task.done)
  const pinned = !!activeTask && !activeTask.done
  if (settle && view !== "empty") setSettle(false)

  // the ribbon overhangs the frame, so it's drawn in the frame's deco layer
  useLayoutEffect(() => {
    setHost(rootRef.current?.closest(".wf")?.querySelector<HTMLElement>(":scope > .wf-deco") ?? null)
  }, [])

  // focus follows a key that's about to go to its counterpart in the next
  // view, when it came by keyboard. after a click it's let go, since a frame
  // holding focus never shrinks, and a click has no place to keep. the next
  // render always takes it, so it never lingers for a later one
  const focusAfter = useRef<string | null>(null)
  const refocus = useCallback((key: string) => {
    const active = document.activeElement
    if (active && rootRef.current?.contains(active) && active.matches(":focus-visible")) focusAfter.current = key
  }, [])
  useLayoutEffect(() => {
    const key = focusAfter.current
    if (!key) return
    focusAfter.current = null
    const root = rootRef.current
    const el = root?.querySelector<HTMLElement>(`[data-dt="${key}"]`) ?? root?.querySelector<HTMLElement>('[data-dt]:not([data-dt="done"])')
    el?.focus({ preventScroll: true })
  })
  // a block landing while focus is in here (on the focus key, say) swaps the
  // keys out from under it: it goes on to the note's next step rather than
  // falling to the page. read as the landing renders, while the old key still has it
  const landingAt = useRef(landing?.at ?? null)
  if ((landing?.at ?? null) !== landingAt.current) {
    landingAt.current = landing?.at ?? null
    const at = typeof document !== "undefined" ? document.activeElement : null
    // by keyboard only, as refocus does: after a click there's no place to keep
    if (landing && at && rootRef.current?.contains(at) && at.matches(":focus-visible")) focusAfter.current = "more"
  }

  // into the empty prompt: the desk holds a shrink for a moment, so the
  // question fades in once the card is its new height. not by keyboard: focus
  // in the card keeps its height, so there's nothing to wait for
  const settleIn = useCallback(() => setSettle(!focusAfter.current), [])

  // a new task on the desk: the ribbon drops in once and the cat looks up.
  // not on a reload; yes when a pin from the list has just brought this out.
  // before paint, so the new ribbon is never seen hanging before it drops
  const seen = useRef<string | null | undefined>(undefined)
  // the cat already heard about this one (a task written just now, an undo)
  const told = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!mounted) return
    const prev = seen.current
    seen.current = activeTaskId
    if (!activeTaskId || prev === activeTaskId) return
    let fresh = prev !== undefined
    if (!fresh) {
      try { fresh = pinnedJustNow(localStorage.getItem(DESK_TASK_KEY), activeTaskId, Date.now()) } catch { /* a reload, then */ }
    }
    if (!fresh) return
    setDrop(activeTaskId)
    if (told.current !== activeTaskId) perk.current?.("add")
    told.current = null
  }, [mounted, activeTaskId])

  // --- the sheet: a transient expansion over the neighbours ---
  useLayoutEffect(() => {
    if (!unfolded) return
    setExpanded(true)
    pickerRef.current?.querySelector<HTMLElement>("[data-pick]")?.focus({ preventScroll: true })
    return () => setExpanded(false)
  }, [unfolded, setExpanded])
  // the view moved on under it (a block landed): it folds away
  useEffect(() => { if (sheet && !unfolded) setSheet(null) }, [sheet, unfolded])

  const close = useCallback((toTrigger: boolean) => {
    setSheet(null)
    setDraft("")
    if (toTrigger) triggerRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (!unfolded) return
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (pickerRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [unfolded, close])
  // expanded, the card grows from its top and loses the centred slack; the
  // content keeps its place instead of hopping up by half of it
  const unfold = useCallback((which: "pick" | "more") => {
    const root = rootRef.current
    const content = root?.closest(".wf-content"), body = root?.closest(".wf-body")
    setKeep(content && body ? Math.max(0, content.getBoundingClientRect().top - body.getBoundingClientRect().top) : 0)
    setFailed(null)
    setSheet(which)
  }, [])
  const openPicker = useCallback(() => unfold("pick"), [unfold])

  const pin = (task: Task) => {
    refocus("swap")
    close(false)
    setFailed(null)
    setActiveTask(task.id)
    announce(`${task.text} is on the desk.`)
  }
  const write = (event: FormEvent) => {
    event.preventDefault()
    const added = add(draft)
    if (!added) return
    told.current = added.task.id
    pin(added.task)
  }
  const back = useCallback(() => {
    const task = activeTask
    if (!task) return
    refocus("pick")
    settleIn()
    close(false)
    setFailed(null)
    setActiveTask(null)
    announce(task.done ? "The desk is clear." : `${task.text} is back on the list.`)
  }, [activeTask, refocus, settleIn, close, setActiveTask, announce])

  // --- done: through toggle, so a synced task asks its service first ---
  const done = (task: Task) => {
    if (finishing || pending.has(task.id)) return
    close(false)
    setFailed(null)
    setFinishing({ task, settled: false, from: view === "landing" ? "landing" : "task", minutes: landing?.minutes ?? 0 })
    void toggle(task.id).then((changed) => {
      // finished, it leaves the desk even if this was put away while its service answered
      if (changed) clearActiveTask(task.id)
      setFinishing((f) => (f && f.task.id === task.id ? { ...f, settled: true } : f))
    })
  }
  // checked: the task leaves the desk at once (so the pull, the timer's label
  // and a put-away in the moment all see it go), while the widget keeps its
  // copy on screen for the check and the ribbon's lift; then the desk clears.
  // keyed on the task alone, so a list changing meanwhile doesn't restart it
  const finishingTask = finishing?.task ?? null
  const later = useRef({ toast, toggle, setActiveTask, dismissLanding, refocus, settleIn, activeTaskId, tasks, finishing })
  later.current = { toast, toggle, setActiveTask, dismissLanding, refocus, settleIn, activeTaskId, tasks, finishing }
  useEffect(() => {
    if (!finishingTask || !checked) return
    const now = later.current
    const id = finishingTask.id
    // the desk clears only if this was the task on it
    if (now.activeTaskId === id) now.setActiveTask(null)
    if (now.finishing?.from === "landing") now.dismissLanding()
    now.toast("Nicely done.", {
      undo: () => {
        const at = later.current
        const task = at.tasks.find((t) => t.id === id)
        if (!task) return
        // reopened from the list meanwhile, it stays open
        if (task.done) void at.toggle(id)
        // and back on the desk, unless the desk has taken another since
        if (!at.activeTaskId) {
          told.current = id
          at.setActiveTask(id)
        }
      },
      widget: "desk-task",
    })
    const timer = window.setTimeout(() => {
      const at = later.current
      at.refocus(at.activeTaskId ? "swap" : "pick")
      at.settleIn()
      setFinishing(null)
    }, reducedMotion() ? CHECK_MS_STILL : CHECK_MS)
    return () => window.clearTimeout(timer)
  }, [finishingTask, checked])
  // not done after all (the service said no): back where it was, with the
  // reason, kept as it was said then (a later toggle elsewhere rewrites it)
  useEffect(() => {
    if (!finishing || !finishing.settled || checked) return
    if (actionError) setFailed({ id: finishing.task.id, message: hereCopy(actionError) })
    setFinishing(null)
  }, [finishing, checked, actionError])

  const say = (mode: FocusMode, minutes: number) => {
    announce(mode === "pause" ? `Focus paused, ${minutesPhrase(minutes)} left.`
      : mode === "resume" ? `Back to it, ${minutesPhrase(minutes)} left.`
      : `Focus started: ${minutesPhrase(minutes)}.`)
  }
  const another = () => {
    const minutes = littleBit(workMin)
    refocus(keyAfterLanding(small, activeTask, true))
    settleIn()
    // after a landing the timer holds a rest, so the phase is said out loud
    start({ minutes, phase: "focus" })
    announce(`Another little bit: ${minutesPhrase(minutes)}.`)
  }
  const breather = () => {
    refocus(keyAfterLanding(small, activeTask, false))
    settleIn()
    start({ phase: "rest" })
    announce("Taking a breather.")
  }
  const notNow = () => {
    refocus(keyAfterLanding(small, activeTask, false))
    settleIn()
    dismissLanding()
  }

  // grip menu extras
  useEffect(() => {
    setMenuItems(view === "landing" || view === "finishing" ? [] : pinned
      ? [{ id: "swap", label: "Swap the task…", onSelect: openPicker }, { id: "back", label: "Back to the list", onSelect: back }]
      : [{ id: "pick", label: "Pick a task…", onSelect: openPicker }])
  }, [setMenuItems, view, pinned, openPicker, back])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!unfolded) return
    if (event.key === "Escape") {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const items = Array.from(pickerRef.current?.querySelectorAll<HTMLElement>("[data-pick]") ?? [])
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    event.preventDefault()
    items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus()
  }

  const trigger = (key: "pick" | "swap", text: string) => (
    <button
      ref={triggerRef}
      type="button"
      className="dt-key dt-trigger"
      data-dt={key}
      aria-expanded={open}
      aria-controls={open ? pickerId : undefined}
      onClick={() => (open ? close(true) : openPicker())}
    >
      {key === "pick" && <DotPattern rows={MARK} dot={2} className="dt-mark" />}
      <span className="dt-key-text">{text}</span>
      <DotGlyph name="chevron" dot={1.4} className="dt-chevron" />
    </button>
  )

  // the one filled key. pressed, it stays under the finger through the check
  const doneKey = (task: Task) => {
    const busy = pending.has(task.id)
    const mine = finishing?.task.id === task.id
    return (
      <button
        type="button"
        className="dt-key is-go"
        data-dt="done"
        data-checked={(mine && checked) || undefined}
        aria-disabled={!!finishing || undefined}
        aria-busy={busy || undefined}
        disabled={busy && !mine}
        onClick={() => done(task)}
      >
        <DotGlyph name="check" dot={1.4} className="dt-check" />
        <span>{busy ? "updating…" : "done"}</span>
      </button>
    )
  }

  // what the landing offers besides [done]: the key that opens the sheet, and
  // the sheet itself. In just the task it holds all three choices
  const moreTrigger = (
    <button
      ref={triggerRef}
      type="button"
      className="dt-key dt-trigger"
      data-dt={small ? "more" : "rest"}
      aria-expanded={moreOpen}
      aria-controls={moreOpen ? pickerId : undefined}
      aria-label={small ? "What now" : "Other ways to go on"}
      onClick={() => (moreOpen ? close(true) : unfold("more"))}
    >
      <span className="dt-key-text">{small ? "what now" : "or…"}</span>
      <DotGlyph name="chevron" dot={1.4} className="dt-chevron" />
    </button>
  )
  const moreSheet = moreOpen && (
    <div
      ref={pickerRef}
      id={pickerId}
      className="dt-picker is-more"
      role="group"
      aria-label="What now"
      tabIndex={-1}
      data-no-lift
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next && !event.currentTarget.contains(next) && !triggerRef.current?.contains(next)) close(false)
      }}
    >
      {small && <button type="button" className="dt-pick" data-pick onClick={another}>another little bit</button>}
      <button type="button" className="dt-pick" data-pick onClick={breather}>take a breather</button>
      <button type="button" className="dt-pick" data-pick onClick={notNow}>not now</button>
    </div>
  )

  // the task this card is about, whatever view it is in
  const held = finishing ? finishing.task : view === "landing" ? landed : activeTask
  const { shown: choices, more } = pickable(tasks, pinned ? activeTask!.id : null)
  const picker = open && (
    <div
      ref={pickerRef}
      id={pickerId}
      className="dt-picker"
      role="group"
      aria-label={pinned ? "Swap the task" : "Pick a task"}
      tabIndex={-1}
      data-no-lift
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        // tabbing on past it folds it away; a press is handled by the pointer
        if (next && !event.currentTarget.contains(next) && !triggerRef.current?.contains(next)) close(false)
      }}
    >
      {choices.length > 0 ? (
        <ul className="dt-pick-list">
          {choices.map((task) => (
            <li key={task.id}>
              <button type="button" className="dt-pick" data-pick onClick={() => pin(task)} aria-label={`Put ${task.text} on the desk`}>
                <span className="dt-pick-text">{task.text}</span>
                {task.source && <ServiceIcon service={task.source.provider} dot={0.5} className="dt-pick-source" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dt-pick-none">{pickNone(tasks.length, pinned)}</p>
      )}
      {more > 0 && <p className="dt-pick-none">and {more} more in Tasks</p>}
      <form className="dt-pick-new" onSubmit={write}>
        <input
          data-pick
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="write a new one"
          maxLength={TASK_MAX_CHARS}
          aria-label="Write a new task and put it on the desk"
          className="dt-input"
        />
        <button type="submit" className="dt-key dt-add" aria-label="Add it and put it on the desk" disabled={!draft.trim()}>
          <DotGlyph name="plus" dot={1.4} />
        </button>
      </form>
      {small && pinned && (
        <button type="button" className="dt-link" data-pick onClick={back}>back to the list</button>
      )}
    </div>
  )

  let body
  let about: string | null = null
  if (shown === "landing") {
    // pressed [done] here, the landing's copy stays until the desk clears
    const soft = finishing ? { task: finishing.task, minutes: finishing.minutes } : { task: landed, minutes: landing!.minutes }
    const line = landingParts(soft.minutes, !!soft.task)
    about = soft.task?.id ?? null
    // The box is one slot tall at either size, so the landing keeps to one row
    // of keys: [done], the one you usually want, and the rest in the sheet.
    // In just the task even that is too wide, so all three fold in.
    body = (
      <>
        {soft.task && <p className="dt-text" title={soft.task.text} data-done={soft.task.done || checked || undefined}>{soft.task.text}</p>}
        <p className="dt-line"><b>{line.time}</b>{line.rest}</p>
        <div className="dt-keys">
          {soft.task && !soft.task.done && doneKey(soft.task)}
          {!small && <button type="button" className="dt-key" data-dt="more" onClick={another}>another little bit</button>}
          {moreTrigger}
        </div>
      </>
    )
  } else if (shown === "task") {
    const task = finishing ? finishing.task : activeTask!
    const isDone = !finishing && task.done
    // a short box keeps it in the grip menu only (app/widgets/desk-task.css)
    const backKey = !small && !isDone && <button type="button" className="dt-link" data-dt="back" onClick={back}>back to the list</button>
    about = task.id
    body = (
      <>
        <p className="dt-text" title={task.text} data-done={isDone || checked || undefined}>
          {isDone && <DotGlyph name="check" dot={1.4} className="dt-text-check" />}
          {task.text}
        </p>
        {isDone ? (
          <div className="dt-keys">
            {trigger("swap", "pick the next")}
            <button type="button" className="dt-link" data-dt="clear" onClick={back}>clear the desk</button>
            {small && <Source task={task} inline />}
          </div>
        ) : (
          <div className="dt-keys">
            {doneKey(task)}
            {!small && <FocusKey withTask onSay={say} />}
            {trigger("swap", "swap")}
            {small && <Source task={task} inline />}
            {backKey}
          </div>
        )}
      </>
    )
  } else {
    body = (
      <>
        <p className="dt-ask">What&apos;s one small thing?</p>
        <div className="dt-keys">
          {trigger("pick", "pick a task")}
          {/* in just the task the focus key would take a second row: the
              timer's own widget (and the whisper above) have it covered */}
          {!small && <FocusKey withTask={false} onSay={say} />}
        </div>
      </>
    )
  }

  return (
    <div
      ref={rootRef}
      className="dt"
      data-view={shown}
      data-finishing={!!finishing || undefined}
      data-settling={(view === "empty" && settle) || undefined}
      data-size={size}
      style={open && keep ? { marginTop: keep } : undefined}
      onKeyDown={onKeyDown}
    >
      <PetBridge to={perk} />
      {/* the label row also carries where the task came from (with actions) and
          what is left of a block (just the task), both clear of the tack */}
      <div className="dt-head">
        <span className="label">On the desk</span>
        {small && shown !== "landing" && <LeftWhisper />}
        {!small && held && <Source task={held} inline head />}
      </div>
      {/* the body takes the slack, so it sits in the middle of a taller box */}
      <div className="dt-body">{body}</div>
      {/* always here, so a reason is read out when it arrives */}
      <p className="dt-message" role="status">{failed && failed.id === about ? failed.message : ""}</p>
      {picker}
      {moreSheet}
      <Ribbon host={host} taskId={pinned ? activeTask!.id : null} drop={drop} />
    </div>
  )
}

// the drawer's picture: a card with its ribbon, a task line and its keys
function Preview({ size }: PreviewProps) {
  return (
    <span className="widget-preview preview-desk-task" data-size={size} aria-hidden>
      <span className="preview-dt-ribbon"><DotGlyph name="bookmark" dot={2} /></span>
      <span className="preview-line is-short" />
      <i className="preview-dt-text" />
      <span className="preview-dt-keys"><i className="is-go" /><i />{size !== "s" && <i />}</span>
    </span>
  )
}

// a pinned task tucked away with the widget: a tiny bookmark on the pull
function Peek() {
  const { activeTask } = useTasks()
  if (!activeTask || activeTask.done) return null
  return (
    <span className="peek peek-desk-task">
      <DotPattern rows={MARK} dot={2} />
      <span className="sr-only">Your task is tucked in here.</span>
    </span>
  )
}

export const definition: WidgetDefinition = {
  type: "desk-task",
  name: "On the desk",
  // "On the desk is on the desk" says nothing; the card is the one task
  spokenName: "Task card",
  blurb: "One task for this session, its link close by.",
  sizes: [
    { id: "s", label: "just the task" },
    { id: "m", label: "with actions" },
  ],
  defaultSize: "m",
  surface: "card",
  maxInstances: 1,
  Component: DeskTask,
  Preview,
  Peek,
}
