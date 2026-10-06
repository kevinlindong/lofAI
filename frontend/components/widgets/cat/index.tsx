"use client"

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { DotPattern } from "@/components/dot-glyph"
import { Pet, type PetHandle } from "@/components/pet"
import { useRadio } from "@/components/radio-provider"
import { useDesk } from "@/components/desk/desk-provider"
import type { PreviewProps, ShownDesk, WidgetDefinition, WidgetProps } from "@/components/desk/types"
import { besideCat, fitCat, stillArt, type CatFit, type DotLayer } from "@/lib/cat-desk"
import { PET_H, PET_W } from "@/lib/pet-scene"
import { PEEKING, SLEEPING } from "./art"

const PREFIX = "widget-"
// set down, the frame springs into its cell; the squash waits until it's there
const LAND_DELAY_MS = 110
// out of the drawer it rises into place: an ear on the way up, a landing at the top
const WAKE_MS = 120
const RISE_LAND_MS = 330
// something set down or taken out counts as slid under its paws for this long
const EXPECT_MS = 1500

// whether another widget has come to rest right against the cat's card, from
// the frames as the desk last drew them (not the ones on their way into the drawer)
function nextTo(shown: ShownDesk | null, id: string, other: string): boolean {
  if (!shown) return false
  return besideCat(shown.frames.filter((f) => !f.leaving), id, other)
}

// On its own card, feet on the floor, centred. It perks an ear when it's
// picked up, purrs while it's carried, squashes when it's set down, and is
// pleased when something comes to rest right beside it.
function Cat({ id }: WidgetProps) {
  const { petSignal, focusMode, isLive, getLevel } = useRadio()
  const { loaded, on, shown } = useDesk()
  const pet = useRef<PetHandle>(null)
  // mounted after the desk loaded: it has just come out of the drawer
  const cameOut = useRef(loaded)

  useLayoutEffect(() => {
    const frame = document.getElementById(PREFIX + id)
    const desk = frame?.parentElement
    if (!frame || !desk) return
    // a session is on (a drag, a keyboard lift, a carry out of the drawer):
    // frames move every frame and nothing is committed, so only a commit counts
    let session = false
    let where: string | null = null
    let expect: { id: string; until: number } | null = null

    // committed: straight from the desk drawing a new arrangement, so right
    // even mid-session (a drop's commit, before its springs read where frames are)
    let leaving = false
    const update = (committed = false) => {
      // on its way into the drawer; or brought back (an Undo) before it was
      // gone, when it lands back on the desk
      if (frame.hasAttribute("data-leaving")) { leaving = true; return }
      if (leaving) {
        leaving = false
        pet.current?.react("lift")
        pet.current?.react("land")
      }
      if (session && !committed) return
      const me = shown()?.frames.find((f) => f.id === id)
      const spot = me ? `${me.x},${me.y},${me.w},${me.h}` : null
      if (spot !== where) {
        where = spot
        pet.current?.moved()
      }
      // something set down right against its card: it's pleased to have company
      if (expect && performance.now() < expect.until && nextTo(shown(), id, expect.id)) {
        expect = null
        pet.current?.react("pleased")
      }
    }

    update()

    const off = on((event) => {
      // the desk drew a new arrangement (a commit, a size, a frame on its
      // way into the drawer)
      if (event.kind === "layout") {
        update(true)
        return
      }
      if (event.kind === "lift") {
        session = true
        if (event.id === id) {
          pet.current?.hold(true, frame.getAttribute("data-lifted") === "pointer")
          pet.current?.react("lift")
        } else if (nextTo(shown(), id, event.id)) {
          // a neighbour right beside it is going somewhere: an ear goes up
          pet.current?.react("lift")
        }
        return
      }
      session = false
      if (event.id === id) {
        if (event.kind === "drop" || event.kind === "cancel") {
          pet.current?.hold(false)
          pet.current?.react("land", LAND_DELAY_MS)
        } else if (event.kind === "put-away") {
          pet.current?.hold(false)
          pet.current?.react("nap")
        }
      } else if (event.kind === "drop" || event.kind === "take-out") {
        expect = { id: event.id, until: performance.now() + EXPECT_MS }
      }
      update()
    })

    return () => { off() }
  }, [id, on, shown])

  // out of the drawer: it wakes on the way up and lands at the top
  useEffect(() => {
    if (!cameOut.current) return
    pet.current?.react("lift", WAKE_MS)
    pet.current?.react("land", RISE_LAND_MS)
  }, [])

  return <Pet ref={pet} bare fit="contain" signal={petSignal} focus={focusMode} playing={isLive} getLevel={getLevel} />
}

// the loaf in the drawer tile grows with the chosen size
const NAP_DOT: Record<string, number> = { s: 3, m: 4, l: 5 }
// the picture in the hand is drawn on a 6px pitch, and scaled to the pitch
// the canvas will have in the frame it's about to be
const ART_DOT = 5
const ART_PITCH = ART_DOT + 1

// the card padding the frame it's about to be will have (app/desk.css, and
// cat.css for the phone): the ghost's cat stands on the same floor
function padFor(size: string): number {
  if (document.querySelector(".desk")?.getAttribute("data-bucket") === "phone") return 12
  return size === "s" ? 16 : 20
}

// in the drawer, asleep; carried out of it, the cat that's about to land
function Preview({ size }: PreviewProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState<CatFit | null>(null)
  useLayoutEffect(() => {
    // the ghost is the widget's size, written inline, so nothing is measured
    const ghost = ref.current?.closest<HTMLElement>(".drawer-ghost")
    const w = ghost ? parseFloat(ghost.style.width) : 0, h = ghost ? parseFloat(ghost.style.height) : 0
    const pad = w > 0 ? padFor(size) : 0
    if (w <= 2 * pad || h <= 2 * pad) return
    const box = fitCat(w - 2 * pad, h - 2 * pad, pad)
    // the ghost has no padding of its own, so the floor is a pad up from its own
    setFit({ ...box, dy: box.dy - pad })
  }, [size])
  return (
    <span ref={ref} className="widget-preview preview-cat" data-size={size} aria-hidden>
      {fit ? <Awake fit={fit} /> : (
        <span className="preview-cat-nap">
          <DotPattern rows={SLEEPING} dot={NAP_DOT[size] ?? 4} />
          <span className="preview-cat-note">napping in here</span>
        </span>
      )}
    </span>
  )
}

// the resting pose in static dots, standing at the bottom centre like the
// canvas: the same silhouette, size and place as what it becomes on landing
function Awake({ fit }: { fit: CatFit }) {
  const art = stillArt()
  const at = (l: DotLayer): CSSProperties => ({ left: l.left * ART_PITCH + 0.5, top: l.top * ART_PITCH + 0.5 })
  const style: CSSProperties = {
    width: PET_W * ART_PITCH,
    height: PET_H * ART_PITCH,
    scale: String(fit.pitch / ART_PITCH),
    translate: `calc(-50% + ${fit.dx.toFixed(2)}px) ${fit.dy.toFixed(2)}px`,
  }
  return (
    <span className="preview-cat-awake" style={style}>
      <span style={at(art.coat)}><DotPattern rows={art.coat.rows} dot={ART_DOT} /></span>
      {art.accent && <span style={at(art.accent)}><DotPattern rows={art.accent.rows} dot={ART_DOT} color="var(--dot-6)" /></span>}
      {art.shadow && <span style={at(art.shadow)}><DotPattern rows={art.shadow.rows} dot={ART_DOT} color="var(--dot-2)" /></span>}
    </span>
  )
}

// napping in the drawer: its ears show over the pull's edge
function Peek() {
  return (
    <span className="peek peek-cat">
      <span className="peek-cat-head" aria-hidden><DotPattern rows={PEEKING} dot={3} /></span>
      <span className="sr-only">The cat is napping in here.</span>
    </span>
  )
}

export const definition: WidgetDefinition = {
  type: "cat",
  name: "Cat",
  blurb: "Keeps you company.",
  sizes: [
    { id: "s", label: "small" },
    { id: "m", label: "comfy" },
    { id: "l", label: "big" },
  ],
  defaultSize: "m",
  surface: "card",
  anchor: "bottom",
  maxInstances: 1,
  Component: Cat,
  Preview,
  Peek,
}
