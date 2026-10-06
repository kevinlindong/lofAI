"use client"

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { DotPattern } from "@/components/dot-glyph"
import { useDesk } from "@/components/desk/desk-provider"
import { useWidgetFrame } from "@/components/desk/widget-frame"
import type { WidgetDefinition } from "@/components/desk/types"
import { useFocus } from "@/components/focus-provider"
import { useTasks } from "@/components/tasks-provider"
import {
  TODAY_KEY, beadSize, beadsThatFit, dayBounds, dayMarkdown, dayStamp, keepFinished, landedToday, parseKept, serializeKept, summarize,
  withKept, type KeptThing,
} from "@/lib/day-summary"
import type { Task } from "@/lib/integrations"
import { downloadFile } from "@/lib/task-files"

// the stamp: the cat asleep, outlined, eyes shut, over a pale fill of
// itself (app/widgets/today.css draws the fill: one dot-screened shape, not
// 160 more cells), with a small z drifting off its back
const CAT_RIM = [
  "X.......X.......",
  "XX.....XX.......",
  "X.XXXXX.X.......",
  "X.......X.......",
  "X.XX.XX.X.......",
  "X...X...XXXXX..X",
  "X............X.X",
  "X............X.X",
  "X............XX.",
  "XXXXXXXXXXXXXX..",
]
const Z = ["XXXX", "..X.", ".X..", "XXXX"]

// static: the postcard re-renders with the desk, the stamp never needs to
const StampCat = memo(function StampCat({ dot, z }: { dot: number; z?: boolean }) {
  return (
    <span className="today-cat" style={{ "--dot": `${dot}px` } as CSSProperties}>
      <span className="today-cat-fill" />
      <DotPattern rows={CAT_RIM} dot={dot} />
      {z && <DotPattern rows={Z} dot={1} className="today-cat-z" />}
    </span>
  )
})

const SAVED_MS = 1600

// What was finished today stays counted after "clear done": the list lets
// go of it, the day doesn't (lofai.today). The visit keeps its own copy,
// shared by the postcard and its drawer peek, so it holds when storage
// doesn't; storage is re-read first so another tab is never written over.
let visitKept: KeptThing[] = []

function syncKept(tasks: Task[]): KeptThing[] {
  const now = Date.now()
  let raw: string | null = null
  try { raw = localStorage.getItem(TODAY_KEY) } catch { /* the visit's copy */ }
  const next = keepFinished(parseKept(raw, now).concat(visitKept), tasks, now)
  visitKept = next
  const text = serializeKept(next)
  try {
    // nothing to keep, no key
    if (!next.length) { if (raw !== null) localStorage.removeItem(TODAY_KEY) }
    else if (text !== raw) localStorage.setItem(TODAY_KEY, text)
  } catch { /* it lasts this visit */ }
  return next
}

// the local day, turned over at midnight by one timeout: no ticking. a
// laptop that slept through midnight catches up when it's looked at again
function useDayStart(): number {
  const [start, setStart] = useState(() => dayBounds(Date.now()).start)
  useEffect(() => {
    let timer = 0
    const check = () => {
      const day = dayBounds(Date.now())
      setStart(day.start)
      window.clearTimeout(timer)
      timer = window.setTimeout(check, day.end - Date.now() + 250)
    }
    check()
    const onShow = () => { if (document.visibilityState === "visible") check() }
    document.addEventListener("visibilitychange", onShow)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onShow)
    }
  }, [])
  return start
}

const listOf = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`)

// The postcard: a sentence about the day, a bead for each focus block, and a
// cat asleep on the stamp. It never counts days or compares one with another.
function Today() {
  const { setMenuItems } = useWidgetFrame()
  const { announce } = useDesk()
  const { sessions } = useFocus()
  const { tasks, mounted } = useTasks()
  const day = useDayStart()
  const [kept, setKept] = useState<KeptThing[]>(() => visitKept)
  // blocks that land while it's open pop in; the ones already there don't
  const openedAt = useRef(Date.now())
  const [saved, setSaved] = useState(0)

  // before paint, so a cleared list never flashes a smaller day
  useLayoutEffect(() => {
    if (!mounted) return
    const next = syncKept(tasks)
    setKept((was) => (serializeKept(was) === serializeKept(next) ? was : next))
  }, [tasks, mounted, day])

  const all = useMemo(() => withKept(tasks, kept), [tasks, kept])
  const { summary, landed, sizes, shown } = useMemo(() => {
    const now = Date.now()
    const landed = landedToday(sessions, now)
    const sizes = landed.map((s) => beadSize(s.minutes))
    return { summary: summarize(sessions, all, now), landed, sizes, shown: beadsThatFit(sizes) }
    // and day: the same data reads differently after midnight
  }, [sessions, all, day])

  const latest = useRef({ sessions, all })
  latest.current = { sessions, all }
  useEffect(() => {
    setMenuItems([{
      id: "save-copy",
      label: "Save a copy",
      hint: "Markdown",
      onSelect: () => {
        const now = Date.now()
        downloadFile(`lofai-today-${dayStamp(now)}.md`, dayMarkdown(latest.current.sessions, latest.current.all, now), "text/markdown")
        announce("A copy of today is in your downloads.")
        setSaved(now)
      },
    }])
  }, [setMenuItems, announce])

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(0), SAVED_MS)
    return () => window.clearTimeout(timer)
  }, [saved])

  const quiet = summary.minutes === 0 && summary.finished === 0
  // each block's length, while that's still a short thing to hear
  const blocksSaid = `${landed.length} focus block${landed.length === 1 ? "" : "s"}`
  const mins = landed.map((s) => Math.max(1, Math.round(s.minutes)))
  const beadsLabel = landed.length <= 8
    ? `${blocksSaid}: ${listOf(mins.map(String))} minute${mins.length === 1 && mins[0] === 1 ? "" : "s"}`
    : blocksSaid

  return (
    <div className="today" data-quiet={quiet || undefined}>
      <span className="today-stamp" aria-hidden><StampCat dot={2} z /></span>
      <p className="label today-label">
        Today
        {saved > 0 && <span key={saved} className="today-whisper" aria-hidden>copy saved</span>}
      </p>
      <p className="today-line">
        {summary.parts.map((part, i) => part.strong
          ? <b key={i}>{part.spoken
            ? <><span aria-hidden>{part.text}</span><span className="sr-only">{part.spoken}</span></>
            : part.text}</b>
          : <span key={i}>{part.text}</span>)}
      </p>
      {landed.length > 0 && (
        <p className="today-beads" role="img" aria-label={beadsLabel}>
          {landed.slice(0, shown).map((s, i) => (
            <i
              key={`${s.start}:${s.end}`}
              data-fresh={s.end >= openedAt.current || undefined}
              style={{ "--d": `${sizes[i]}px` } as CSSProperties}
            />
          ))}
          {landed.length > shown && <span className="today-more">+{landed.length - shown}</span>}
        </p>
      )}
    </div>
  )
}

function Preview() {
  return (
    <span className="widget-preview preview-today" aria-hidden>
      <span className="today-stamp is-small"><StampCat dot={1} /></span>
      <span className="preview-line is-short" />
      <span className="preview-line" />
      <span className="preview-today-beads">{[9, 9, 7, 12].map((d, i) => <i key={i} style={{ "--d": `${d}px` } as CSSProperties} />)}</span>
    </span>
  )
}

// Nothing to show on the pull. It's here because the pull is what's mounted
// while the postcard is in the drawer, so the day still keeps what gets
// finished (and cleared) in the meantime.
function Peek() {
  const { tasks, mounted } = useTasks()
  useEffect(() => {
    if (mounted) syncKept(tasks)
  }, [tasks, mounted])
  return null
}

export const definition: WidgetDefinition = {
  type: "today",
  name: "Today",
  blurb: "A postcard of the day so far.",
  sizes: [{ id: "m", label: "postcard" }],
  defaultSize: "m",
  surface: "card",
  maxInstances: 1,
  Component: Today,
  Preview,
  Peek,
}
