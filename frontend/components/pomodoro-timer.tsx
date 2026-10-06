"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react"
import { useDesk } from "@/components/desk/desk-provider"
import { DotGlyph, DotPattern, GLYPHS } from "@/components/dot-glyph"
import { FineDial } from "@/components/fine-dial"
import { useFocus, useFocusClock, type Landing } from "@/components/focus-provider"
import { useTasks } from "@/components/tasks-provider"
import { serviceName, type Task } from "@/lib/integrations"
import {
  afterDone, anotherBit, blockStart, creditedTask, doneLabel, doneTarget, landedLine, landingCopy, minutesOf, stillOpenCopy,
} from "@/lib/land-softly"
import { landsInSheet, timerFit, type TimerFit } from "@/lib/timer-fit"

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.ceil(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}

// the only parts that follow the 200ms tick. how big it is and what colour
// belong to the CSS: the box decides (app/timer.css, --digits)
function TimerDigits({ running }: { running: boolean }) {
  const { timeLeft } = useFocusClock()
  return <span className="timer-digits tabular-nums leading-none" data-running={running || undefined}>{formatTime(timeLeft)}</span>
}

// what's left, to the minute, so a screen reader isn't handed every tick
const minutesLeft = (seconds: number) => {
  const m = Math.max(1, Math.ceil(seconds / 60))
  return `${m} minute${m === 1 ? "" : "s"} left`
}

// the S digits are a button named "Set durations"; this says the time beside it
function TimeLeftText({ id }: { id: string }) {
  const { timeLeft } = useFocusClock()
  return <span id={id} className="sr-only">{minutesLeft(timeLeft)}</span>
}

function FlowMeter({ isBreak }: { isBreak: boolean }) {
  const { elapsed, timeLeft } = useFocusClock()
  return (
    <div
      className="flow-meter"
      style={{ "--progress": `${elapsed * 100}%` } as CSSProperties}
      role="progressbar"
      aria-label={`${isBreak ? "Break" : "Focus"} progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(elapsed * 100)}
      aria-valuetext={minutesLeft(timeLeft)}
    >
      <span />
    </div>
  )
}

// a key pressed from the keyboard keeps focus nearby when its row goes
const byKey = (event: MouseEvent<HTMLElement>) => event.currentTarget.matches(":focus-visible")
// the check on [done] before it's earned: the same grid, every dot off
const NO_CHECK = GLYPHS.check.map((row) => row.replace(/X/g, "."))
// how long a finished task's check stays before the note goes
const FINISHED_MS = 640

type NoteState = "idle" | "busy" | "failed" | "finished"

// Land softly: a focus block ran out, and here's what could come next. The
// block ending never finishes a task; [done] does, through the list's own
// toggle (PomodoroTimer below), and then the task leaves the desk. It lives
// in the timer only while the On the desk widget is away; in a sheet (just
// the time) the line that opened it already says the words.
function LandSoftly({ landing, task, state, more, restMin, onDone, onMore, onRest, inSheet = false }: {
  landing: Landing; task: Task | null; state: NoteState; more: number; restMin: number
  onDone(byKey: boolean): void; onMore(byKey: boolean): void; onRest(byKey: boolean): void; inSheet?: boolean
}) {
  const copyId = useId()
  const finished = state === "finished"
  // waiting on a service (or on the check), the keys hold still but keep
  // focus: aria-disabled, since a disabled key would drop it
  const busy = state === "busy" || finished
  const failed = state === "failed" && task?.source ? stillOpenCopy(serviceName(task.source.provider)) : ""
  const copy = !inSheet || failed !== ""
  const key = (choose: (byKey: boolean) => void) => (event: MouseEvent<HTMLButtonElement>) => { if (!busy) choose(byKey(event)) }
  // with a task still open, [done] is the note's one accent key
  const done = (
    <button type="button" className="landing-key is-done" data-accent={doneTarget(task) !== null || finished || undefined} data-finished={finished || undefined}
      aria-disabled={busy || undefined} aria-busy={state === "busy" || undefined} aria-label={finished && task ? `Done with ${task.text}` : doneLabel(task)} onClick={key(onDone)}>
      <span className="landing-word">done</span>
      {/* once it's finished the check draws itself in, stroke by stroke */}
      <DotPattern rows={finished ? GLYPHS.check : NO_CHECK} dot={2} morph className="landing-check" />
    </button>
  )

  // the first line (the task, or the copy without one) shares its row with [done]
  return (
    <div className="timer-landing" role={inSheet ? undefined : "group"} aria-labelledby={inSheet ? undefined : copyId}>
      {task && <p className="timer-landing-task" data-finished={finished || undefined} title={task.text}>{task.text}</p>}
      {copy && <p className="timer-landing-copy" id={copyId}>{failed || landingCopy(landing.minutes, !!task)}</p>}
      {(task || copy) && done}
      <div className="timer-landing-keys">
        {!(task || copy) && done}
        <button type="button" className="landing-key" aria-disabled={busy || undefined} aria-label={`Another little bit, ${minutesOf(more)} more`} onClick={key(onMore)}>another little bit</button>
        <button type="button" className="landing-key" aria-disabled={busy || undefined} aria-label={`Take a breather, ${minutesOf(restMin)} of rest`} onClick={key(onRest)}>take a breather</button>
      </div>
    </div>
  )
}

// presentational: the clock, the end sound and focus mode live in FocusProvider.
// "s" is just the time: its digits open a sheet with the dials, which unfolds
// over whatever is below (onExpandedChange) and folds away on Esc or a press
// anywhere else. A block that ran out lands softly here: with dials, its note
// takes the place of the meter and dials, in the same rows (the digits open
// the dials meanwhile); just the time shows one line that opens it in a
// sheet. The label names the task on the desk while it's focus time.
export function PomodoroTimer({ size = "m", onExpandedChange }: { size?: "s" | "m"; onExpandedChange?: (open: boolean) => void } = {}) {
  const {
    phase, running: isRunning, workMin: workDuration, restMin: breakDuration, landing, sessions,
    toggle, start, rewind: rewindTimer, setDuration, dismissLanding,
  } = useFocus()
  const { tasks, pending, toggle: toggleTask, activeTask, activeTaskId, setActiveTask, clearActiveTask } = useTasks()
  const { isOnDesk, announce } = useDesk()
  const isBreak = phase === "rest"
  // focus time names what it's for; a finished task still pinned says nothing
  const forTask = !isBreak && activeTask && !activeTask.done ? activeTask : null
  // the On the desk widget has its own landing; the timer only fills in for it.
  // either way it's said aloud once, by LandingNews
  const landed = isOnDesk("desk-task") ? null : landing
  // the task those minutes went to: open, or checked off while they ran
  const credited = landed ? creditedTask(tasks, landed, blockStart(sessions, landed)) : null
  // counts presses only to replay the reset key's whoosh
  const [rewinds, setRewinds] = useState(0)
  // a pointer that has just arrived on the play key. only it gets the tug, so
  // a cursor left resting there after a pause isn't nagged to start again
  const [eager, setEager] = useState(false)
  const [sheet, setSheet] = useState<"dials" | "landing" | null>(null)
  // the meter and dials fade back in after a note, rather than snapping
  const [back, setBack] = useState(false)
  const small = size === "s"
  // which box this is: rows aren't square, so "with dials" is anything from
  // 428×184 down to 320×88 and the four parts arrange themselves to suit
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const fit: TimerFit = timerFit(box.w, box.h)
  // the note only fits under the time in a tall box; everywhere else the
  // landed line opens it in a sheet, as just the time has always done
  const sheetMode = landsInSheet(box.h, small ? "s" : "m")
  const inline = landed !== null && !sheetMode
  // the digits are the key to the dials: always in just the time, and with
  // dials while the note has their place
  const keyed = small || inline
  const open = sheet === "dials" ? keyed : sheet === "landing" && sheetMode && landed !== null
  const sheetId = useId()
  const leftId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const digitsRef = useRef<HTMLButtonElement>(null)
  const landedRef = useRef<HTMLButtonElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const landingAt = useRef<number | null>(null)
  landingAt.current = landing?.at ?? null

  // [done] waits on the list's own toggle, so a synced task asks its service
  // first. that's kept here, not in the note, so a start, reset or resize
  // meanwhile still takes a finished task off the desk
  const [finishing, setFinishing] = useState<{ id: string; at: number; byKey: boolean; settled: boolean } | null>(null)
  // how that went, for the note of that landing: its service said no, or the check is in
  const [outcome, setOutcome] = useState<{ at: number; kind: "failed" | "finished"; byKey: boolean } | null>(null)

  // the box, measured once and then whenever the frame resizes. one number
  // decides both the arrangement (data-fit, read by the CSS) and where the
  // landing note goes, so the two can't disagree about which box this is
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(() => {
      const w = root.clientWidth, h = root.clientHeight
      setBox((was) => (was.w === w && was.h === h ? was : { w, h }))
    })
    watch.observe(root)
    return () => watch.disconnect()
  }, [])

  // a sheet whose reason went (the note was answered, the size changed)
  // doesn't come back by itself
  useEffect(() => {
    if (sheet && !open) setSheet(null)
  }, [sheet, open])

  // the note goes with whatever was chosen. from the keyboard, focus stays on
  // the play key; after a click it lets go
  const leave = useCallback((key: boolean) => {
    setSheet(null)
    setBack(true)
    if (key) toggleRef.current?.focus({ preventScroll: true })
    else if (document.activeElement instanceof HTMLElement && rootRef.current?.contains(document.activeElement)) document.activeElement.blur()
  }, [])

  // after the toggle: finished (or gone) takes it off the desk right away,
  // and the note shows its check a moment before it goes. still open means
  // its service said no, and the note stays for another try
  useEffect(() => {
    if (!finishing?.settled) return
    setFinishing(null)
    const task = tasks.find((t) => t.id === finishing.id)
    if (afterDone(tasks, finishing.id) === "still-open") {
      setOutcome({ at: finishing.at, kind: "failed", byKey: finishing.byKey })
      if (task?.source) announce(stillOpenCopy(serviceName(task.source.provider)))
      return
    }
    if (activeTaskId === finishing.id) setActiveTask(null)
    if (task) announce(`${task.text} is done.`)
    setOutcome({ at: finishing.at, kind: "finished", byKey: finishing.byKey })
  }, [finishing, tasks, activeTaskId, setActiveTask, announce])

  useEffect(() => {
    if (outcome?.kind !== "finished") return
    const { at, byKey: key } = outcome
    const wait = window.setTimeout(() => {
      setOutcome(null)
      if (landingAt.current !== at) return
      dismissLanding()
      leave(key)
    }, FINISHED_MS)
    return () => clearTimeout(wait)
  }, [outcome, dismissLanding, leave])

  const finish = async (key: boolean) => {
    if (!landed) return
    const id = doneTarget(credited)
    // nothing left to finish (no task, or it was checked off already): just done for now
    if (!id) { dismissLanding(); leave(key); return }
    const at = landed.at
    setOutcome(null)
    setFinishing({ id, at, byKey: key, settled: false })
    // finished, it leaves the desk even if the timer was put away meanwhile
    if (await toggleTask(id)) clearActiveTask(id)
    setFinishing({ id, at, byKey: key, settled: true })
  }

  const noteState: NoteState = !landed ? "idle"
    : outcome?.at === landed.at && outcome.kind === "finished" ? "finished"
    : finishing?.at === landed.at || (credited !== null && pending.has(credited.id)) ? "busy"
    : outcome?.at === landed.at ? "failed" : "idle"
  const note = (inSheet: boolean) => landed && (
    <LandSoftly
      landing={landed}
      task={credited}
      state={noteState}
      more={anotherBit(workDuration)}
      restMin={breakDuration}
      onDone={(key) => void finish(key)}
      onMore={(key) => { start({ minutes: anotherBit(workDuration), phase: "focus" }); leave(key) }}
      onRest={(key) => { start({ phase: "rest" }); leave(key) }}
      inSheet={inSheet}
    />
  )

  const expandedChange = useRef(onExpandedChange)
  expandedChange.current = onExpandedChange
  useLayoutEffect(() => {
    if (!open) return
    const report = expandedChange.current
    report?.(true)
    return () => report?.(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setSheet(null)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [open])

  const rewind = () => {
    rewindTimer()
    setRewinds((n) => n + 1)
  }

  const dials = (
    <div className="timer-dials">
      <FineDial
        label="Work"
        formatValue={(minutes) => `${minutes} min`}
        value={workDuration}
        min={1}
        max={60}
        neutral={25}
        disabled={isRunning}
        disabledReason="Pause the timer to adjust"
        onChange={(v) => setDuration("focus", v)}
      />
      <FineDial
        label="Rest"
        formatValue={(minutes) => `${minutes} min`}
        value={breakDuration}
        min={1}
        max={30}
        neutral={5}
        disabled={isRunning}
        disabledReason="Pause the timer to adjust"
        onChange={(v) => setDuration("rest", v)}
      />
    </div>
  )

  return (
    <div
      ref={rootRef}
      className="timer-widget"
      data-size={size}
      data-fit={fit}
      data-landed={landed ? "" : undefined}
      data-note={landed ? (inline ? "inline" : "line") : undefined}
      data-back={back || undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault()
          const back = sheet === "landing" ? landedRef : digitsRef
          setSheet(null)
          back.current?.focus({ preventScroll: true })
        }
      }}
    >
      <div className="timer-label-row">
        <span className="label timer-label" title={forTask?.text}>
          {isBreak ? "Break" : "Focus"}
          {forTask && <span className="timer-task"> · {forTask.text}</span>}
        </span>
        <span className="label timer-state">{isRunning ? "running" : "held"}</span>
      </div>

      <div className="timer-clock">
        {keyed ? (
          <button
            ref={digitsRef}
            type="button"
            className="timer-digits-key"
            aria-label="Set durations"
            aria-describedby={leftId}
            aria-expanded={sheet === "dials"}
            aria-controls={sheet === "dials" ? sheetId : undefined}
            onClick={() => setSheet(sheet === "dials" ? null : "dials")}
          >
            <TimerDigits running={isRunning} />
          </button>
        ) : <TimerDigits running={isRunning} />}
        {keyed && <TimeLeftText id={leftId} />}

        <div className="timer-keys">
          <button
            ref={toggleRef}
            type="button"
            onClick={() => {
              setEager(false)
              toggle()
            }}
            onPointerEnter={(event) => setEager(event.pointerType !== "touch" && !landed)}
            onPointerDown={() => setEager(false)}
            onPointerLeave={() => setEager(false)}
            className="key timer-key timer-toggle"
            data-running={isRunning || undefined}
            data-eager={eager || undefined}
            aria-label={isRunning ? "Pause timer" : "Start timer"}
          >
            <span className="timer-face">
              <DotGlyph name={isRunning ? "pauseSmall" : "playSmall"} dot={2} morph className="timer-glyph" />
            </span>
          </button>
          <button type="button" onClick={rewind} className="key timer-key timer-reset" aria-label="Reset timer">
            {/* remounted per press, so the whoosh replays every time */}
            <span key={rewinds} className="timer-face" data-rewinding={rewinds > 0 || undefined}>
              <DotGlyph name="rewind" dot={2} className="timer-glyph" />
            </span>
          </button>
        </div>
      </div>

      {/* while a block has just landed, the note (or, in just the time, its
          line) takes the place of the meter, which is empty on a rest that
          hasn't started, and of the dials. both are back once it's answered */}
      {landed && sheetMode ? (
        <button
          ref={landedRef}
          type="button"
          className="timer-landed"
          aria-expanded={sheet === "landing"}
          aria-controls={sheet === "landing" ? sheetId : undefined}
          onClick={() => setSheet(sheet === "landing" ? null : "landing")}
        >
          <DotGlyph name="check" dot={1.5} />
          <span className="timer-landed-text">{landedLine(landed.minutes)}</span>
          <DotGlyph name="chevron" dot={1} className="timer-landed-more" />
        </button>
      ) : !inline && <FlowMeter isBreak={isBreak} />}
      {inline && note(false)}
      {!keyed && dials}
      {open && (
        <div id={sheetId} className="timer-sheet" role="group" aria-label={sheet === "landing" ? "Nicely done" : "Durations"} data-no-lift>
          {sheet === "landing" ? note(true) : dials}
        </div>
      )}
    </div>
  )
}

export default PomodoroTimer
