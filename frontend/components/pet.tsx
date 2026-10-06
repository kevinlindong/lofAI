"use client"

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import { gridNeighbours, paintInk, type InkCells, type InkGeometry } from "@/lib/ink-render"
import { canvasLoop } from "@/lib/canvas-loop"
import { renderBusy } from "@/lib/render-budget"
import { LiquidInk } from "@/lib/liquid-ink"
import { smoothstep } from "@/lib/dot-field"
import {
  drawPet,
  COAT,
  RIM,
  HEAD_SHADOW,
  DETAILS,
  DETAIL_X,
  DETAIL_Y,
  LIT,
  HOT,
  DIM,
  INK,
  PET_H,
  PET_W,
  RESTING_FRAME,
  type PetFrame,
  type PetMood,
} from "@/lib/pet-scene"
import { fitCat } from "@/lib/cat-desk"

// "lift" and "land": the cat being picked up (an ear pricks) and set down
// again (the loaf squashes onto whatever it landed on)
export type PetEvent = "add" | "complete" | "clear" | "undo" | "lift" | "land"

// what the desk can tell the cat besides: something slid in under its paws,
// and being put away in the drawer
export type PetNudge = "pleased" | "nap"

// what the cat is reacting to. "pet" is not a PetEvent because nothing outside
// this component raises it - it is the cat noticing that you clicked on it.
type Reaction = PetEvent | PetNudge | "pet"

// the desk's handle on the cat. none of it renders anything: the loop reads it
export interface PetHandle {
  // react now, or after a moment (a landing waits for the frame to spring home)
  react(kind: PetEvent | PetNudge, delayMs?: number): void
  // carried: it purrs the whole way. `follows`: the canvas travels with the
  // pointer (a drag rather than the keyboard), so where it is needn't be read
  hold(on: boolean, follows?: boolean): void
  // the canvas has moved on the page; look where it is again
  moved(): void
}

export interface PetSignal {
  kind: PetEvent
  // bumped on every signal so the same event twice in a row still lands
  at: number
}

interface PetProps {
  signal: PetSignal | null
  // the pomodoro is running, so the cat is working too
  focus: boolean
  playing: boolean
  getLevel: () => number
  // no panel of unlit dots behind the cat: it sits on the desk itself, with
  // only its floor shadow under it
  bare?: boolean
  // "width" sizes the art from the wrapper's width at the art's proportions;
  // "contain" fits it inside a box something else sized (a desk frame),
  // standing at the bottom centre
  fit?: "width" | "contain"
}

const PALETTE_VARS = [
  "--dot-0",
  "--dot-1",
  "--dot-2",
  "--dot-3",
  "--dot-4",
  "--dot-5",
  "--dot-6",
  "--dot-7",
]

// The coat stays continuous underneath changes of shade. Face dots travel
// with the head by fractions of a pixel instead of snapping to a new column.
const INK_GEO: InkGeometry = {
  minRadius: 0.12, maxRadius: 0.54,
  spread: 0.5, handleSize: 2.4, reach: 2.5,
  dryRadius: 0, diagonals: true, swellIn: 0.2,
}

// how long each reaction holds the cat's face
const HOLD_MS: Record<Reaction, number> = {
  add: 750,
  complete: 1900,
  clear: 3200,
  undo: 700,
  pet: 1400,
  lift: 500,
  land: 600,
  pleased: 1100,
  nap: 2400,
}

// picked up, only an ear moves: it plays over whatever the body is doing (the
// pat of the press that picked it up), rather than cutting it off
const EAR_ONLY: Partial<Record<Reaction, true>> = { lift: true }

// with reduced motion nothing moves: a reaction is at most a face, held for
// its time and then let go
const STILL_MOOD: Partial<Record<Reaction, PetMood>> = {
  pet: "purr",
  pleased: "purr",
  complete: "happy",
  clear: "cheer",
  nap: "sleep",
}

// an ear flicking back and settling. a decaying wobble rather than a square
// wave - an ear that snaps between two positions three times reads as a fault
// in the panel.
const flick = (secs: number) => smoothstep(0, 0.08, secs) * Math.max(0, Math.exp(-secs * 4) * Math.cos(secs * 13))

// the canvas' place on the page is read at most this often, and never while
// the desk is being arranged: the loop draws thirty times a second, and a
// layout read per frame is a layout per frame
const LOOK_MS = 1000

// how the head follows the beat, as time constants in seconds: drops fast,
// comes back up slowly. seconds rather than per-frame fractions so the bob
// feels the same however often we draw. the attack was slowed down for a
// while, back when the beat was rounded to whole dots and only ever put the
// cat in one of two poses - catching every transient just flickered it between
// them. the lift is continuous again, so the landing can be sharp again.
const BOB_ATTACK = 0.033
const BOB_RELEASE = 0.27

// the analyser's RMS wobbles a few percent from one frame to the next even
// inside a steady bar, and everything the bob touches - the squash, the tail
// speed, the sway - used to tremble with it. a short pre-filter takes the
// fizz off the measurement without dulling the beat: fifty milliseconds is
// well inside the attack of any lofi kick.
const LEVEL_SMOOTH = 0.05

// how long the cat takes to settle into the music, and to settle out of it
// again. the head's rock and nod ride this ramp, so the first note eases the
// cat into keeping time over a second or so instead of snapping its head
// sideways the instant the stream starts.
const GROOVE_FOLLOW = 0.45

// how fast the eyes catch up with the cursor. slow enough to be a head turning
// rather than a cursor with whiskers, fast enough not to feel broken.
const GAZE_FOLLOW = 0.13

// the cursor has to travel about this far from the cat's eye to pull the look
// all the way over. roughly the width of the picture, so anywhere on the panel
// gets a look and anywhere across the page gets the full one.
const GAZE_SPAN_X = 240
const GAZE_SPAN_Y = 170

// the cat gives up on a cursor that has not moved and goes back to its own
// business, which for a cat that is meant to be working is the page
const ATTENTION_MS = 4000

// where the eyes sit in the picture, in dots, for working out what the cursor
// is off to the side of
const EYE_C = 16
const EYE_R = 12

export const Pet = forwardRef<PetHandle, PetProps>(function Pet({ signal, focus, playing, getLevel, bare = false, fit = "width" }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // everything the animation loop reads lives in refs: the loop runs at frame
  // rate and must never be the reason react re-renders
  const reactionRef = useRef<{ kind: Reaction; start: number } | null>(null)
  // an ear's own reaction, over the body's
  const earRef = useRef<{ kind: Reaction; start: number } | null>(null)
  // in someone's hand, and where the pointer was when the canvas was last seen
  const heldRef = useRef<{ follows: boolean; x: number; y: number } | null>(null)
  // the loop's own hooks: forget where the canvas is, and re-strike the still
  // frame (reduced motion) now and once the face has been held for `ms`
  const loopRef = useRef<{ look(inMs?: number): void; still(ms: number): void } | null>(null)
  const focusRef = useRef(focus)
  const playingRef = useRef(playing)
  const levelRef = useRef(getLevel)
  const lastPokeRef = useRef(Date.now())
  // the cursor, in client coordinates, and when it last actually moved
  const pointerRef = useRef<{ x: number; y: number; at: number } | null>(null)

  focusRef.current = focus
  playingRef.current = playing
  levelRef.current = getLevel

  const begin = useRef((kind: Reaction, delayMs = 0) => {
    const r = { kind, start: performance.now() + delayMs }
    if (EAR_ONLY[kind]) earRef.current = r
    else {
      reactionRef.current = r
      loopRef.current?.still(delayMs + HOLD_MS[kind])
    }
    lastPokeRef.current = Date.now()
  }).current

  useImperativeHandle(ref, () => ({
    react: (kind, delayMs) => begin(kind, delayMs),
    hold: (on, follows = false) => {
      const p = pointerRef.current
      heldRef.current = on ? { follows: follows && p !== null, x: p ? p.x : 0, y: p ? p.y : 0 } : null
      lastPokeRef.current = Date.now()
      // set down, it springs into its cell: look again once it's there
      if (!on) loopRef.current?.look(600)
      loopRef.current?.still(0)
    },
    moved: () => loopRef.current?.look(),
  }), [begin])

  useEffect(() => {
    if (!signal) return
    begin(signal.kind)
  }, [signal, begin])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // set only when the animation loop is not running, so the single drawn
    // frame can be re-struck after a resize or a theme change
    let loop: ReturnType<typeof canvasLoop> | undefined
    let panelDirty = true

    let palette = PALETTE_VARS.map(() => "#000")
    const readPalette = () => {
      const style = getComputedStyle(document.documentElement)
      palette = PALETTE_VARS.map((v) => style.getPropertyValue(v).trim() || "#000")
    }
    readPalette()

    // the palette lives in css variables, so a theme flip has to be watched for
    const themeWatch = new MutationObserver(() => {
      readPalette()
      panelDirty = true
      loop?.redraw()
    })
    themeWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })

    let pitch = 0
    let dpr = 0
    // where the canvas is on the page, when that was read (-1: read it next
    // time), and the scroll it was read at
    const box = { left: 0, top: 0, width: 0, height: 0 }
    let look = -1
    let lookScroll = 0
    // assigning canvas.width wipes the canvas, so only assign when something
    // actually changed - otherwise the observer's first callback erases the
    // frame that has just been drawn
    const resize = (box?: { width: number; height: number }): boolean => {
      const nextDpr = Math.min(2, window.devicePixelRatio || 1)
      // Scale the artwork to the whole card, keeping its original proportions.
      // The layout box, not the drawn one: a frame rising out of the drawer is
      // scaled for a moment, and that must not shrink the cat for good
      const w = box ? box.width : wrap.clientWidth, h = box ? box.height : wrap.clientHeight
      // in a card the cat stands on the card's floor, its body centred, and
      // the poses that reach past the body use the card's own padding
      const pad = fit === "contain" ? parseFloat(getComputedStyle(wrap).getPropertyValue("--wf-pad")) || 0 : 0
      const sized = fit === "contain" ? fitCat(w, h, pad) : { pitch: Math.max(1, w / PET_W), dx: 0, dy: 0 }
      if (sized.pitch === pitch && nextDpr === dpr) return false
      pitch = sized.pitch
      dpr = nextDpr
      canvas.width = Math.round(PET_W * pitch * dpr)
      canvas.height = Math.round(PET_H * pitch * dpr)
      canvas.style.width = `${PET_W * pitch}px`
      canvas.style.height = `${PET_H * pitch}px`
      // the canvas hangs off the box's bottom centre (globals.css), so the
      // shift is the whole offset of the body inside the art
      if (fit === "contain") canvas.style.translate = `${(sized.dx - PET_W * pitch / 2).toFixed(2)}px ${sized.dy.toFixed(2)}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      look = -1
      return true
    }
    resize()
    const sizeWatch = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (resize(entry ? entry.contentRect : undefined)) {
        panelDirty = true
        loop?.redraw()
      }
    })
    sizeWatch.observe(wrap)

    const neighbours = gridNeighbours(PET_W, PET_H)
    const cells: InkCells = {
      count: PET_W * PET_H,
      x: new Float32Array(PET_W * PET_H),
      y: new Float32Array(PET_W * PET_H),
      fill: COAT,
      shade: new Uint8Array(PET_W * PET_H),
      ...neighbours,
    }
    const details: InkCells = {
      ...cells,
      x: new Float32Array(cells.count),
      y: new Float32Array(cells.count),
      fill: INK,
      shade: DETAILS,
    }
    const panel = document.createElement("canvas")
    const panelCtx = panel.getContext("2d")!
    let placedAt = -1
    let geo: InkGeometry
    let detailGeo: InkGeometry
    let coat: LiquidInk, shadow: LiquidInk, rim: LiquidInk

    const place = () => {
      if (placedAt !== pitch) {
        placedAt = pitch
        panelDirty = true
        for (let r = 0; r < PET_H; r++) {
          for (let c = 0; c < PET_W; c++) {
            const i = r * PET_W + c
            cells.x[i] = (c + 0.5) * pitch
            cells.y[i] = (r + 0.5) * pitch
          }
        }
        geo = { ...INK_GEO, minRadius: pitch * INK_GEO.minRadius, maxRadius: pitch * INK_GEO.maxRadius }
        detailGeo = { ...geo, minRadius: pitch * 0.18, maxRadius: pitch * 0.52 }
        coat = new LiquidInk(cells, pitch, { radius: 0.54, attack: 0.055, release: 0.08 })
        shadow = new LiquidInk(cells, pitch, { radius: 0.48, attack: 0.055, release: 0.08 })
        rim = new LiquidInk(cells, pitch, { radius: 0.46, attack: 0.055, release: 0.08 })
      }
      // Cache the 1,440 unlit dots until the theme or canvas size changes.
      if (panelDirty && !bare) {
        panelDirty = false
        panel.width = canvas.width
        panel.height = canvas.height
        panelCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
        panelCtx.beginPath()
        const r = Math.max(0.7, pitch * 0.17)
        for (let i = 0; i < cells.count; i++) {
          panelCtx.moveTo(cells.x[i] + r, cells.y[i])
          panelCtx.arc(cells.x[i], cells.y[i], r, 0, Math.PI * 2)
        }
        panelCtx.fillStyle = palette[0]
        panelCtx.fill()
      }
    }

    const paint = (frame: PetFrame, dt = 0) => {
      drawPet(frame)
      place()
      ctx.clearRect(0, 0, PET_W * pitch, PET_H * pitch)
      if (!bare) ctx.drawImage(panel, 0, 0, PET_W * pitch, PET_H * pitch)
      coat.paint(ctx, COAT, palette[LIT], dt)
      shadow.paint(ctx, HEAD_SHADOW, palette[DIM], dt)
      rim.paint(ctx, RIM, palette[HOT], dt)
      for (let i = 0; i < cells.count; i++) {
        details.x[i] = cells.x[i] + DETAIL_X[i] * pitch
        details.y[i] = cells.y[i] + DETAIL_Y[i] * pitch
      }
      paintInk(ctx, details, detailGeo, palette)
    }

    // where the canvas is, without asking the page every frame: read once,
    // then followed by the scroll, or by the hand that carries it. one
    // scratch box, re-filled each frame rather than a fresh one
    const seen = { left: 0, top: 0, width: 0, height: 0 }
    const where = (now: number, pointer: { x: number; y: number }) => {
      const held = heldRef.current
      if (look < 0 || (!renderBusy() && now - look > LOOK_MS)) {
        const r = canvas.getBoundingClientRect()
        box.left = r.left
        box.top = r.top
        box.width = r.width
        box.height = r.height
        look = now
        lookScroll = window.scrollY
        if (held) { held.x = pointer.x; held.y = pointer.y }
      }
      const hand = held && held.follows ? held : null
      seen.left = box.left + (hand ? pointer.x - hand.x : 0)
      seen.top = box.top + (hand ? pointer.y - hand.y : lookScroll - window.scrollY)
      seen.width = box.width
      seen.height = box.height
      return seen
    }

    let raw = 0
    let smoothed = 0
    let bobAvg = 0
    let groove = 0
    // the tail and the ribs each carry their own phase, advanced by a rate
    // rather than read off the clock. the rates change - the tail swishes
    // faster when the music hits, sleep breathes slower - and a sine fed
    // `clock × rate` jumps to a random point in its cycle every time the rate
    // moves, because the clock is minutes long. integrating keeps every
    // change of speed seamless.
    let swing = 0
    let breathe = 0
    let gazeX = 0
    let gazeY = 0
    let affection = 0
    let nextBlink = performance.now() + 2600
    let blinkUntil = 0

    const tick = (now: number, dt: number) => {
      // fast attack, slow release - the head drops on the beat and comes back
      // up between them, instead of vibrating at frame rate. the pre-filter
      // strips the frame-to-frame fizz off the measurement first, so the
      // envelope rides the music rather than the noise floor of the analyser.
      const level = playingRef.current ? Math.min(1, levelRef.current() * 4) : 0
      raw += (level - raw) * (1 - Math.exp(-dt / LEVEL_SMOOTH))
      smoothed +=
        (raw - smoothed) *
        (1 - Math.exp(-dt / (raw > smoothed ? BOB_ATTACK : BOB_RELEASE)))
      const wants = playingRef.current ? 1 : 0
      groove += (wants - groove) * (1 - Math.exp(-dt / GROOVE_FOLLOW))

      // ---- where the cat is looking ----
      const pointer = pointerRef.current
      const held = heldRef.current
      // carried, it's watching the hand that holds it
      const watching = pointer !== null && ((held !== null && held.follows) || Date.now() - pointer.at < ATTENTION_MS)
      let wantX: number
      let wantY: number
      let onCat = false

      if (watching && pointer) {
        const rect = where(now, pointer)
        // saturating, so the cursor two panels away and the cursor ten look the
        // same - past a certain point a head is simply turned as far as it goes
        const eyeX = rect.left + ((EYE_C + 0.5) / PET_W) * rect.width
        const eyeY = rect.top + ((EYE_R + 0.5) / PET_H) * rect.height
        wantX = Math.tanh((pointer.x - eyeX) / GAZE_SPAN_X)
        wantY = Math.tanh((pointer.y - eyeY) / GAZE_SPAN_Y)
        onCat =
          pointer.x >= rect.left &&
          pointer.x <= rect.left + rect.width &&
          pointer.y >= rect.top &&
          pointer.y <= rect.top + rect.height
      } else if (focusRef.current) {
        // eyes down and steady on whatever it is the two of you are doing
        wantX = -0.15
        wantY = 0.6
      } else {
        // nobody about: a slow, uneven wander, the two axes on different
        // periods so it never traces the same little circle twice
        wantX = Math.sin(now / 3100) * 0.4
        wantY = Math.sin(now / 4700) * 0.3 + 0.1
      }

      const follow = 1 - Math.exp(-dt / GAZE_FOLLOW)
      gazeX += (wantX - gazeX) * follow
      gazeY += (wantY - gazeY) * follow
      // warms quickly, cools slowly, so a cursor passing through does not
      // switch the cat on and off
      affection += ((onCat ? 1 : 0) - affection) * (1 - Math.exp(-dt / (onCat ? 0.2 : 0.7)))
      if (onCat) lastPokeRef.current = Date.now()

      if (now > nextBlink) {
        blinkUntil = now + 130
        nextBlink = now + 2600 + Math.random() * 4200
      }

      const reaction = reactionRef.current
      let mood: PetMood = "idle"
      let sparkle = 0
      let hop = 0
      let twitch = 0
      let pat = 0

      if (reaction) {
        // the frame's timestamp can precede a reaction that arrived during
        // the same frame, so elapsed time starts at zero rather than below it
        const elapsed = Math.max(0, now - reaction.start)
        const t = elapsed / HOLD_MS[reaction.kind]
        // reactions are shaped in seconds, not in fractions of their hold: a
        // twitch is a twitch whether the pose it interrupts lasts half a
        // second or three
        const secs = elapsed / 1000
        if (t >= 1) {
          reactionRef.current = null
        } else if (reaction.kind === "add" || reaction.kind === "undo") {
          // a task arriving is worth noticing but not celebrating: an ear goes
          // back and comes down again
          twitch = flick(secs)
        } else if (reaction.kind === "land") {
          // set down: the same press into the ground as a pat, arriving
          // quicker - this is the floor meeting it, not a hand - and gone
          // before the hold ends
          pat = smoothstep(0, 0.06, secs) * Math.max(-0.35, Math.exp(-secs * 5.5) * Math.cos(secs * 9))
        } else if (reaction.kind === "pleased") {
          // something slid in under its paws: a contented face and an ear
          // flick, no fuss
          if (elapsed > 0) mood = "purr"
          twitch = flick(secs)
        } else if (reaction.kind === "nap") {
          // into the drawer: curling up already
          mood = "sleep"
        } else if (reaction.kind === "pet") {
          // being fussed. this used to be a hop, which is what a cat does when
          // you drop something, not when you put your hand on it. a pat
          // presses the loaf down into the ground and it springs most of the
          // way back - the cosine going briefly negative is that rebound.
          mood = "purr"
          pat = smoothstep(0, 0.1, secs) * Math.max(-0.35, Math.exp(-secs * 4.5) * Math.cos(secs * 7.5))
        } else {
          mood = reaction.kind === "clear" ? "cheer" : "happy"
          sparkle = 1 - t
          // one hop for a task, three for clearing the board
          const hops = reaction.kind === "clear" ? 3 : 1
          hop = Math.sin(t * Math.PI * hops) ** 2
        }
      }

      const ear = earRef.current
      if (ear) {
        const secs = Math.max(0, now - ear.start) / 1000
        if (secs * 1000 >= HOLD_MS[ear.kind]) earRef.current = null
        // picked up: one clear prick of the ear, a fifth of a second long -
        // slow enough to read at the twenty frames a busy desk draws - and
        // settled well inside its half second, so it's never cut off mid-swing
        else twitch = Math.min(1, twitch + 1.5 * smoothstep(0, 0.07, secs) * Math.max(0, Math.exp(-secs * 5) * Math.cos(secs * 8)))
      }

      // the state it settles into when nothing has just happened to it. the
      // order is the priority: a hand on the cat beats the pomodoro, the
      // pomodoro beats the music, and going to sleep needs all three quiet.
      if (mood === "idle") {
        const idleFor = Date.now() - lastPokeRef.current
        // carried is being held, and being held is purring
        if (held || affection > 0.55) mood = "purr"
        else if (focusRef.current) mood = "focus"
        else if (playingRef.current) mood = "bop"
        else if (idleFor > 45_000) mood = "sleep"
      }

      const bob = playingRef.current ? Math.min(1, smoothed * 1.6) : 0
      // the beat as a beat: how far this instant stands above the mix's own
      // slowly-tracked level. bob's release never reaches zero between kicks
      // in a busy mix, so anything that should LAND on the rhythm - the nod,
      // the tail's flick - rides this instead of bob.
      bobAvg += (bob - bobAvg) * (1 - Math.exp(-dt / 0.8))
      const pulse = playingRef.current ? Math.min(1, Math.max(0, (bob - bobAvg) * 2.2)) : 0
      // advance the tail and the breath by this frame's rate. the tail's
      // rate leans hard on the pulse: each kick propels a visible sweep of
      // the curl and it coasts between kicks, which is what puts the tail on
      // the music's rhythm without any beat detector - and because the rate
      // feeds an accumulated phase, the hardest transient can only ever
      // speed the swish up, never tear it. sleep slows the ribs; both stay
      // continuous however hard the rates move.
      swing += dt * (0.9 + pulse * 3.6)
      breathe += dt * (mood === "sleep" ? 0.7 : 1.15)

      paint({
        mood,
        blink: now < blinkUntil,
        bob,
        pulse,
        hop,
        twitch,
        pat,
        phase: now / 1000,
        swing,
        breathe,
        notes: playingRef.current,
        groove,
        sparkle,
        gazeX,
        gazeY,
        affection,
      }, dt)
    }
    // with reduced motion the loop never runs, and this is all there is: the
    // resting cat, wearing the face of whatever just happened to it (a purr
    // while it's held, a grin for a finished task) and nothing that moves
    const still = () => {
      const r = reactionRef.current
      const mood = heldRef.current
        ? "purr"
        : r && performance.now() - r.start < HOLD_MS[r.kind] ? STILL_MOOD[r.kind] : undefined
      paint(mood ? { ...RESTING_FRAME, mood } : RESTING_FRAME)
    }
    // The cat's motion is eased and time-based, and it reads as smoothly at
    // 30fps on a dot matrix as at 60 - at half the painting.
    loop = canvasLoop(canvas, tick, still, { fps: 30, lowPowerFps: 20 })

    let stillTimer = 0
    loopRef.current = {
      look: (inMs) => { look = inMs ? performance.now() - LOOK_MS + inMs : -1 },
      still: (ms) => {
        loop?.redraw()
        if (!ms) return
        window.clearTimeout(stillTimer)
        stillTimer = window.setTimeout(() => loop?.redraw(), ms + 20)
      },
    }

    return () => {
      loopRef.current = null
      window.clearTimeout(stillTimer)
      loop?.dispose()
      themeWatch.disconnect()
      sizeWatch.disconnect()
    }
  }, [bare, fit])

  // any interaction anywhere counts as company, and wakes the cat
  useEffect(() => {
    const poke = () => {
      lastPokeRef.current = Date.now()
    }
    // a click on the cat itself, as opposed to a click anywhere on the page
    const press = (e: PointerEvent) => {
      poke()
      // where the hand is: a touch that lifts the cat with a still long press
      // never moves before it does, and the carry follows it from here
      pointerRef.current = { x: e.clientX, y: e.clientY, at: Date.now() }
      // the grip over its ears carries the cat off; that isn't a pat, so
      // only presses on the cat's own stage count
      const target = e.target instanceof Node ? e.target : null
      if (!target || !wrapRef.current?.contains(target) || (target instanceof Element && target.closest("[data-grip]"))) return
      const box = canvasRef.current?.getBoundingClientRect()
      if (!box) return
      if (
        e.clientX >= box.left &&
        e.clientX <= box.right &&
        e.clientY >= box.top &&
        e.clientY <= box.bottom
      ) {
        begin("pet")
      }
    }
    const track = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY, at: Date.now() }
      poke()
    }
    const forget = () => {
      pointerRef.current = null
    }
    window.addEventListener("pointermove", track, { passive: true })
    window.addEventListener("pointerdown", press)
    window.addEventListener("keydown", poke)
    // the cursor leaving the window is not the cursor sitting still somewhere
    document.addEventListener("pointerleave", forget)
    return () => {
      window.removeEventListener("pointermove", track)
      window.removeEventListener("pointerdown", press)
      window.removeEventListener("keydown", poke)
      document.removeEventListener("pointerleave", forget)
    }
  }, [begin])

  return (
    <div
      ref={wrapRef}
      className="pet-stage"
      data-bare={bare || undefined}
      data-fit={fit}
      style={fit === "width" ? { aspectRatio: `${PET_W} / ${PET_H}` } : undefined}
      role="img"
      aria-label="A relaxing animated cat"
    >
      <canvas ref={canvasRef} aria-hidden />
    </div>
  )
})

export default Pet
