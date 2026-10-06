// The notebook's page, outside any component: putting the widget away
// unmounts it, and the pull's peek wants to know if there's anything written
// while it's in the drawer. Read once from lofai.notebook; each change is
// saved 400ms after the typing stops, and at once if the page is closing.
// Another tab's save comes over while this one has nothing waiting to save.
import { NOTEBOOK_BROKEN_KEY, NOTEBOOK_KEY, clampNote, fromOtherTab, openNote, serializeNote } from "@/lib/notebook"

export interface NotebookState {
  text: string
  // this browser couldn't keep the last change
  saveError: boolean
  // what was saved couldn't be read, so it was set aside this visit
  setAside: boolean
  // counts saves that whisper, so each one can whisper once
  parked: number
  // "make it a task" has been used this visit (touch stops explaining the key)
  taught: boolean
}

const SAVE_MS = 400
const EMPTY: NotebookState = { text: "", saveError: false, setAside: false, parked: 0, taught: false }

let state = EMPTY
let loaded = false
let dirty = false
// the change waiting to save came with its own toast: its save doesn't whisper
let quiet = false
let timer = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of Array.from(listeners)) listener()
}

function load() {
  if (loaded || typeof window === "undefined") return
  loaded = true
  let raw: string | null = null
  let asideTaken = false
  try {
    raw = localStorage.getItem(NOTEBOOK_KEY)
    asideTaken = localStorage.getItem(NOTEBOOK_BROKEN_KEY) !== null
  } catch { /* no storage: a page for this visit */ }
  const opened = openNote(raw, asideTaken)
  let setAside = false
  if (opened.keepAside && raw !== null) {
    try {
      localStorage.setItem(NOTEBOOK_BROKEN_KEY, raw)
      setAside = opened.notice
    } catch { /* then it's only ever read, never written, until someone writes */ }
  }
  state = { ...state, text: opened.text, setAside }
  // leaving: the last few words are kept rather than lost to the debounce
  window.addEventListener("pagehide", flush)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush() })
  window.addEventListener("storage", (event) => {
    if (event.key !== NOTEBOOK_KEY) return
    const text = fromOtherTab(event.newValue, dirty)
    if (text === null || text === state.text) return
    state = { ...state, text, setAside: false }
    emit()
  })
}

function save() {
  window.clearTimeout(timer)
  timer = 0
  if (!dirty) return
  try {
    localStorage.setItem(NOTEBOOK_KEY, serializeNote(state.text, Date.now()))
    dirty = false
    state = { ...state, saveError: false, parked: quiet ? state.parked : state.parked + 1 }
  } catch {
    // still dirty: the next change, or leaving, tries again
    state = { ...state, saveError: true }
  }
  quiet = false
  emit()
}

function flush() {
  if (dirty) save()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function notebook(): NotebookState {
  load()
  return state
}

export const serverNotebook = (): NotebookState => EMPTY

// the pull's peek: is there anything written on the page?
export const hasWords = () => notebook().text.trim().length > 0
export const serverHasWords = () => false

// quiet: a move to Tasks or its Undo, which say so in a toast
export function setNotebookText(next: string, o: { quiet?: boolean } = {}) {
  load()
  const text = clampNote(next)
  if (text === state.text) return
  state = { ...state, text, setAside: state.setAside && !text }
  dirty = true
  quiet = !!o.quiet
  window.clearTimeout(timer)
  timer = window.setTimeout(save, SAVE_MS)
  emit()
}

export function markTaught() {
  if (state.taught) return
  state = { ...state, taught: true }
  emit()
}
