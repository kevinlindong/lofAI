"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react"
import { DotPattern } from "@/components/dot-glyph"
import { useDesk } from "@/components/desk/desk-provider"
import type { PreviewProps, WidgetDefinition, WidgetProps } from "@/components/desk/types"
import { useTasks } from "@/components/tasks-provider"
import { hasWords, markTaught, notebook, serverHasWords, serverNotebook, setNotebookText, subscribe } from "@/components/widgets/notebook/store"
import { NOTE_MAX_CHARS, lineAt, pageNotice, putBack, takeLine, taskText } from "@/lib/notebook"
import { TASK_MAX_CHARS } from "@/lib/tasks-store"

// the dog-ear: the corner turned down, the back of the page showing
const FOLD = [
  "X.....",
  "XX....",
  "X.X...",
  "XX.X..",
  "X.X.X.",
  "XXXXXX",
]
// "make it a task": a nudge into a task's little box
const TO_TASK = [
  "X...XXXXX",
  ".X..X...X",
  "..X.X...X",
  ".X..X...X",
  "X...XXXXX",
]
// on the pull: a sheet with its corner turned down, tucked in the drawer
const PEEK = [
  "XXXX..",
  "X..XX.",
  "X..XXX",
  "X....X",
  "XXXXXX",
]

// the ruled line (--nb-line)
const LINE = 28

// A scroll offset on whole lines: the page's end (its last line at the foot)
// or a whole number of lines above it. The top fade is tuned to that phase, so
// the first line in view is whole rather than half under it.
function restingAt(el: HTMLElement): number {
  const end = Math.max(0, el.scrollHeight - el.clientHeight - LINE)
  return Math.max(0, end - Math.max(0, Math.round((end - el.scrollTop) / LINE)) * LINE)
}

// Paper for stray thoughts. The textarea grows by rows into free space (a
// mirror behind it sizes it, so nothing measures in JS), then scrolls. The
// line the caret is on can become a task, and Undo brings it back.
function Notebook({ id }: WidgetProps) {
  const { add, remove, saveError: tasksUnsaved } = useTasks()
  const { toast, dismissToast, currentToast, announce } = useDesk()
  const { text, saveError, setAside, parked, taught } = useSyncExternalStore(subscribe, notebook, serverNotebook)
  const area = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const page = useRef<HTMLDivElement | null>(null)
  const key = useRef<HTMLButtonElement>(null)
  const [caret, setCaret] = useState<number | null>(null)
  // where the caret goes once the page has changed under it, and (after an
  // Undo, maybe on a scrolled page) the caret whose line comes into view
  const pendingCaret = useRef<number | null>(null)
  const reveal = useRef<number | null>(null)
  // the last line moved to tasks, while the page is still as it left it
  const moved = useRef<{ after: string; undo: () => void } | null>(null)
  // saves from before this mount don't whisper; each whisper goes when its fade ends
  const [seen, setSeen] = useState(parked)
  const [mod, setMod] = useState<"⌘" | "Ctrl">("Ctrl")
  useEffect(() => { if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘") }, [])


  // opened again: the caret waits at the end, where the next thought goes
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const end = el.value.length
    el.setSelectionRange(end, end)
    setCaret(end)
  }, [])

  // At rest the page keeps its last written line at its foot, not the spare
  // line under it, unless someone scrolled up to read. Settled on resize
  // (the reads come after layout) and on leaving; never while the caret is
  // mid-page, where the words under it must stay put.
  useEffect(() => {
    const el = scroller.current, inner = page.current
    if (!el || !inner || typeof ResizeObserver === "undefined") return
    let pinned = true
    const end = () => Math.max(0, el.scrollHeight - el.clientHeight - LINE)
    // within half a line of it: the browser shows a caret, not its whole line
    const near = () => el.scrollTop >= end() - LINE / 2
    const midPage = () => {
      const a = area.current
      return !!a && document.activeElement === a && a.selectionEnd < a.value.length
    }
    const settle = () => {
      // a page that doesn't scroll gets no edge fades: a scroll timeline with
      // nothing to scroll reads as scrolled to the end, fading the first line
      el.toggleAttribute("data-scrolls", el.scrollHeight > el.clientHeight)
      const writing = document.activeElement === area.current
      if (midPage()) pinned = near()
      // at rest with only a sliver hidden: it reads from the top, and the fade
      // at the foot says there's a little more. Half a line is the most that
      // can hide there - past that the last line reads as missing rather than
      // as cut, and the page is better pinned to its foot
      else if (!writing && end() < LINE / 2) el.scrollTop = 0
      else if (pinned) el.scrollTop = end()
      // scrolled up to read, and left: whole lines, where the top fade is tuned
      // for them (while writing, the caret decides)
      else if (!writing) el.scrollTop = restingAt(el)
    }
    const onScroll = () => { pinned = near() }
    const onLeave = (event: FocusEvent) => { if (!(event.relatedTarget instanceof Node && el.contains(event.relatedTarget))) settle() }
    const observer = new ResizeObserver(settle)
    observer.observe(el)
    observer.observe(inner)
    el.addEventListener("scroll", onScroll, { passive: true })
    el.addEventListener("focusout", onLeave)
    return () => {
      observer.disconnect()
      el.removeEventListener("scroll", onScroll)
      el.removeEventListener("focusout", onLeave)
    }
  }, [])

  // where the caret is, however it got there (keys, a click, a touch handle,
  // a script): the page says so through selectionchange
  useEffect(() => {
    const onChange = () => {
      const el = area.current
      if (el && document.activeElement === el) setCaret(el.selectionStart)
    }
    document.addEventListener("selectionchange", onChange)
    return () => document.removeEventListener("selectionchange", onChange)
  }, [])

  useLayoutEffect(() => {
    const el = area.current, at = pendingCaret.current
    if (!el || at === null) return
    pendingCaret.current = null
    el.setSelectionRange(at, at)
    setCaret(at)
  }, [text])
  // the key sits on the caret's line: once it's drawn there, bringing it into
  // view brings the line (a focus on the way can report the old caret first)
  useLayoutEffect(() => {
    if (reveal.current === null || caret !== reveal.current) return
    reveal.current = null
    key.current?.scrollIntoView({ block: "nearest" })
    // on a whole line, not between two half ones (at most half a line off)
    if (scroller.current) scroller.current.scrollTop = restingAt(scroller.current)
  }, [caret, text])

  const track = () => {
    const el = area.current
    if (el) setCaret(el.selectionStart)
  }

  const makeTask = useCallback(() => {
    const el = area.current
    if (!el) return
    const now = notebook().text
    const taken = takeLine(now, el.selectionStart, TASK_MAX_CHARS)
    if (!taken) return
    const added = add(taken.line)
    if (!added) return
    const { task, saved } = added
    markTaught()
    el.focus({ preventScroll: true })
    let undone = false
    // Tasks can't keep its list right now (already, or as of this very add):
    // the thought stays here as well, so it's never only in memory
    if (tasksUnsaved || !saved) {
      const undo = () => {
        if (undone) return
        undone = true
        moved.current = null
        remove(task.id)
        announce("Taken back off tasks.")
      }
      moved.current = { after: now, undo }
      toast("Copied to tasks. It stays here too, since tasks can't be saved right now.", { undo, widget: id })
      return
    }
    pendingCaret.current = taken.caret
    setCaret(taken.caret)
    setNotebookText(taken.text, { quiet: true })
    const undo = () => {
      if (undone) return
      undone = true
      moved.current = null
      const current = notebook().text
      const back = putBack(current, taken)
      // a full page with no room for all of it: the task stays, so nothing's lost
      if (back.whole) remove(task.id)
      if (back.text === current) {
        toast("The page is full, so it stays in tasks.")
        return
      }
      pendingCaret.current = back.caret
      reveal.current = back.caret
      setCaret(back.caret)
      setNotebookText(back.text, { quiet: true })
      if (back.whole) announce("Thought back on the page.")
      else toast("The page is nearly full, so it's in tasks too.")
    }
    moved.current = { after: taken.text, undo }
    // after the change, so it's this toast's Undo and no older one's
    toast("Thought moved to tasks.", { undo, widget: id })
  }, [add, remove, toast, announce, id, tasksUnsaved])

  // while its toast is up, ⌘Z outside a field is this Undo: that's the desk's
  // rule for every toast with its own Undo (desk.tsx), and focus comes back
  // to the page, which is what it marks for a take-out

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const cmd = event.metaKey || event.ctrlKey
    if (!cmd || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return
    if (event.key === "Enter") {
      event.preventDefault()
      // held down, it would take line after line
      if (!event.repeat) makeTask()
      return
    }
    // the page's own undo lost its history in the move; right after one, ⌘Z brings it back
    const last = moved.current
    if (event.key.toLowerCase() === "z" && last && notebook().text === last.after) {
      event.preventDefault()
      if (currentToast?.undo === last.undo) dismissToast()
      last.undo()
    }
  }

  // the empty paper under the last line is part of the page: pressing there
  // writes at the end (and never picks the notebook up)
  const onScrollbar = (event: MouseEvent<HTMLDivElement>) => event.nativeEvent.offsetX >= event.currentTarget.clientWidth
  const pressPaper = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !onScrollbar(event)) event.preventDefault()
  }
  const clickPaper = (event: MouseEvent<HTMLDivElement>) => {
    const el = area.current
    if (!el || event.target !== event.currentTarget || onScrollbar(event)) return
    const end = el.value.length
    el.focus({ preventScroll: true })
    el.setSelectionRange(end, end)
    setCaret(end)
  }

  const line = caret === null ? null : lineAt(text, caret)
  const ready = !!line && !!taskText(line.text)
  const notice = pageNotice({ saveError, full: text.length >= NOTE_MAX_CHARS, setAside })
  const hint = `notebook-${id}-hint`

  return (
    <div className="notebook">
      <span className="notebook-corner" aria-hidden><span className="notebook-corner-flap"><DotPattern rows={FOLD} dot={2} /></span></span>
      <div ref={scroller} className="notebook-scroll dot-scroll" data-no-lift onMouseDown={pressPaper} onClick={clickPaper}>
        <div ref={page} className="notebook-page">
          <textarea
            ref={area}
            className="notebook-text"
            value={text}
            rows={1}
            maxLength={NOTE_MAX_CHARS}
            placeholder="park a thought…"
            aria-label="Your notes"
            aria-describedby={hint}
            data-focus-on-take-out
            onChange={(event) => {
              moved.current = null
              reveal.current = null
              setNotebookText(event.target.value)
              setCaret(event.target.selectionStart)
            }}
            onFocus={track}
            onKeyDown={onKeyDown}
          />
          {/* the same words, unseen, give the page its height; the caret's
              line carries its key in the margin */}
          <div className="notebook-mirror">
            {ready && line ? (
              <>
                {text.slice(0, line.start)}
                <button
                  ref={key}
                  type="button"
                  className="notebook-to-task"
                  aria-label="Make this line a task"
                  aria-keyshortcuts="Meta+Enter Control+Enter"
                  // the caret stays in the page
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={makeTask}
                >
                  <DotPattern rows={TO_TASK} dot={1} />
                </button>
                {text.slice(line.start)}
              </>
            ) : text}
            {"\n "}
          </div>
        </div>
      </div>
      <p className="notebook-status sr-only" role="status">{notice?.full ?? ""}</p>
      <span id={hint} className="sr-only">{mod === "⌘" ? "Command" : "Control"} Enter turns the line you&apos;re on into a task.</span>
      {/* the foot of the page, in the card's margin: one short line at a time,
          so the page's rows stay for words */}
      <span className="notebook-foot" aria-hidden>
        {notice ? <span className="notebook-note" title={notice.full}>{notice.short}</span> : (
          <>
            <span className="notebook-hint">make it a task <kbd>{mod === "⌘" ? "⌘↵" : "Ctrl ↵"}</kbd></span>
            {!taught && <span className="notebook-hint-touch">tap <DotPattern rows={TO_TASK} dot={1} /> to make it a task</span>}
            {parked > seen && <span key={parked} className="notebook-whisper" onAnimationEnd={() => setSeen(parked)}>thought parked</span>}
          </>
        )}
      </span>
    </div>
  )
}

// a page of dotted rules with a line or two written, and the dog-ear
function Preview({ size }: PreviewProps) {
  return (
    <span className="widget-preview preview-notebook" data-size={size} aria-hidden>
      <span className="preview-notebook-corner"><span><DotPattern rows={FOLD} dot={1} /></span></span>
      <span className="preview-notebook-rule"><i style={{ width: "74%" }} /></span>
      <span className="preview-notebook-rule"><i style={{ width: "46%" }} /><b><DotPattern rows={TO_TASK} dot={1} /></b></span>
      <span className="preview-notebook-rule" />
      <span className="preview-notebook-rule" />
    </span>
  )
}

// a folded sheet on the pull while the page has words on it
function Peek() {
  const has = useSyncExternalStore(subscribe, hasWords, serverHasWords)
  if (!has) return null
  return (
    <span className="peek peek-notebook">
      <DotPattern rows={PEEK} dot={2} />
      <span className="sr-only">Your notebook is tucked away.</span>
    </span>
  )
}

export const definition: WidgetDefinition = {
  type: "notebook",
  name: "Pocket notebook",
  blurb: "Park a thought; turn a line into a task.",
  sizes: [
    { id: "m", label: "pocket" },
    { id: "l", label: "page" },
  ],
  defaultSize: "m",
  surface: "card",
  maxInstances: 1,
  Component: Notebook,
  Preview,
  Peek,
}
