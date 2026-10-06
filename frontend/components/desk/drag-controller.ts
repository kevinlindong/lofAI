// Moving widgets around the desk (desk v3): pointer, touch, keyboard, resize
// and pinned-tug sessions, and the motion of every commit. A plain class with
// no React in it. Pointer events only store where the hand is; one animation
// frame runs the session's step and then the springs (lib/spring, rendered by
// ./motion). Geometry after a lift is slot arithmetic: no layout reads, no
// React renders and no DOM inserts until the drop, which commits once and
// FLIPs by arithmetic (every moved frame's spring is shifted by its old slot
// less its new one, so nothing jumps). Every preview is planned from the
// pickup layout, so sweeping across the desk never melts it.
import { DeskMotion } from "@/components/desk/motion"
import { showWhenPlaced } from "@/components/desk/show"
import { focusWidget } from "@/components/desk/toasts"
import type { DeskEvent } from "@/components/desk/types"
import {
  deepest, footprint, layoutOf, movedFrom, overlaps, own, planDrop, planInsert, planKey, planPin, planResize, readingOrder, rectPx,
  rippleDelays, sizeStep, slotAt,
  type Arrangement, type Bucket, type KeyMove, type Metrics, type Placed, type Plan, type Rect, type SizeId, type Slot,
} from "@/lib/board"
import { setRenderBusy } from "@/lib/render-budget"
import { MOTION, pointerVelocity, RELEASE_MAX, rubberBand, squashImpulse, tiltFor, type Sample } from "@/lib/spring"

// presses meant for the control under them, never the start of a drag
export const NO_LIFT = 'button:not([data-grip]), a, input, textarea, select, label, summary, [role="button"], [role="slider"], ' +
  '[role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [contenteditable], [data-no-lift], [data-pin]'

const PREFIX = "widget-"
// how far a press travels before it's a drag; touch counts from the grip
// (the body needs a long press instead)
const THRESHOLD: Record<string, number> = { mouse: 5, pen: 8, touch: 4 }
const LONG_PRESS_MS = 400
const LONG_PRESS_SLOP = 8
// out of the drawer a still touch lifts a tile sooner than a widget
const TILE_PRESS_MS = 250
// auto-scroll near the viewport's top and bottom
const EDGE = 56
const EDGE_SPEED = 18
// in the hand, a little bigger (touch arrives already swollen by the charge)
const LIFT_SCALE = 1.03
const CHARGED_SCALE = 1.012
// the neighbours make room once the footprint has held a slot this long, or
// at once if the hand is moving slowly
const DWELL_MS = 80
const SLOW_HAND = 400
// a tug on a pinned widget gives this much at most; past the board's side edges
// a carried one gives this much
const RESIST_PX = 24
const EDGE_PX = 32
// a tugged pin says how to unpin it once in this long
const TOLD_MS = 2400
// how long the ring of dots round a pinned or unpinned slot shows
const HELD_MS: Record<Held, number> = { pin: 900, unpin: 520, tug: 700 }
// how long the lattice may wait for everything to come to rest after a drop
const SETTLE_CAP_MS = 700
const SAMPLES = 6
// no word from the hand for this long and it's holding still (no lean, no fling)
const STILL_MS = 48
// put away: how long the frame stays mounted while it flies into the drawer
export const LEAVE_MS = 420
export const LEAVE_REDUCED_MS = 140
const FLASH_MS = 1200
const AFTERGLOW_MS = 400
const TAP_CLICK_MS = 400
// the keyboard's bump against the desk's edge or a pin (≈6px there and back)
const BUMP_SPEED = 260
// a resize: old content out, the shell morphs, new content in
const MORPH_OUT_MS = 90
const MORPH_IN_DELAY = 60

// the desk as rendered right now: the pickup snapshot
export interface Shot {
  bucket: Bucket
  cols: number
  m: Metrics
  // this bucket's arrangement (order, sizes, spots, pins) and its layout
  a: Arrangement
  items: Placed[]
}

export interface WidgetInfo {
  name: string
  // small to large
  sizes: SizeId[]
  label(size: SizeId): string
}

// what the desk lends the controller. the commits flush synchronously, so
// the frames are in their new slots when they return
export interface DragHost {
  shot(): Shot | null
  widget(id: string): WidgetInfo | null
  commit(a: Arrangement): void
  // a widget carried out of the drawer is set down: exactly as previewed.
  // `also` is said after where it went (who moved to make room)
  carryIn(id: string, size: SizeId, a: Arrangement, also: string): void
  putAway(id: string): void
  openMenu(id: string, grip: HTMLElement): void
  menuOpen(): boolean
  announce(text: string): void
  emit(event: DeskEvent): void
  setSession(active: boolean): void
}

// somewhere a carried widget can be dropped to put it away (the drawer pull).
// box() is asked once per lift, so it should come from known geometry rather
// than a layout read. the element gets data-drag during a drag and data-over
// while the pointer is over it
export interface DropZone {
  element: HTMLElement
  box(): { left: number; top: number; right: number; bottom: number }
}

// a widget carried out of the drawer. Until it's dropped the hand holds a
// ghost (the tile's picture, at the widget's size); the real thing mounts on
// the drop. The tile keeps the pointer.
export interface Carry {
  id: string
  size: SizeId
  tile: HTMLElement
  // the sheet folded to a strip: dropping there keeps it in the drawer
  strip: DropZone
  // at lift: fold the sheet and show a ghost this big, and hand it over
  lift(width: number, height: number): HTMLElement | null
  // on the desk (the drawer closes), or kept (the sheet opens again while
  // the ghost flies home)
  end(placed: boolean): void
}

type Kind = "pointer" | "key" | "resize" | "carry" | "resist"
type Held = "pin" | "unpin" | "tug"
type Ending = "commit" | "cancel" | "away"
type Box = { left: number; top: number; right: number; bottom: number }

interface Press {
  pointerId: number
  type: string
  id: string
  frame: HTMLElement
  grip: boolean
  resize: boolean
  pinned: boolean
  x0: number
  y0: number
  x: number
  y: number
  timer: number
  charged: boolean
  carry: Carry | null
}

interface Session {
  kind: Kind
  id: string
  info: WidgetInfo
  // what moves with the hand: the frame, or a carry's ghost
  el: HTMLElement
  // what holds the pointer: the frame, or the tile a carry came from
  captor: HTMLElement
  grip: HTMLElement | null
  shot: Shot
  pickup: Record<string, Placed>
  // where it was picked up (null: a carry, which isn't on the desk yet)
  me: Placed | null
  // the size in hand, its footprint, and the arrangement plans are made on
  size: SizeId
  fp: { w: number; h: number }
  a: Arrangement
  // the slot under the hand, the plan for it, and the plan the neighbours show
  T: Slot | null
  plan: Plan | null
  shown: Plan | null
  since: number
  // each neighbour's offset target now (px), and the pinned one nodding
  targets: Record<string, [number, number]>
  nodded: string | null
  maxY: number
  pointerId: number
  type: string
  x0: number
  y0: number
  x: number
  y: number
  samples: Sample[]
  scroll0: number
  scrollY: number
  viewH: number
  maxScroll: number
  // the board's origin: client left and document top
  left: number
  top: number
  grabX: number
  grabY: number
  zone: { el: HTMLElement; box: Box; over: boolean } | null
  carry: Carry | null
  home: DOMRect | null
  // P while lifted: pin (true) or unpin (false) on set-down
  pinOnDrop: boolean | null
  unhook: (() => void) | null
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
const pointerKind = (k: Kind) => k === "pointer" || k === "carry" || k === "resize" || k === "resist"
const inBox = (b: Box, x: number, y: number) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom
const find = (items: Placed[], id: string): Placed | null => {
  for (const it of items) if (it.id === id) return it
  return null
}
const indexOf = (items: Placed[]) => {
  const out: Record<string, Placed> = {}
  for (const it of items) out[it.id] = it
  return out
}
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const where = (it: Slot) => `column ${it.x + 1}, row ${it.y + 1}`

function modalOpen(): boolean {
  try { return !!document.querySelector("dialog:modal") } catch { return !!document.querySelector("dialog[open]") }
}

const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll"

// a press on a scroller's own scrollbar is for the scrollbar. only boxes that
// scroll have one: inline text (a label, a count) has no client box at all,
// which would otherwise read as nothing but scrollbar
function onScrollbar(el: Element, e: PointerEvent): boolean {
  if (!(el instanceof HTMLElement) || (!el.clientWidth && !el.clientHeight)) return false
  const style = getComputedStyle(el)
  if (!scrolls(style.overflowX) && !scrolls(style.overflowY)) return false
  const barX = el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
  const barY = el.offsetHeight - el.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)
  if (barX < 1 && barY < 1) return false
  const box = el.getBoundingClientRect()
  return (barY >= 1 && e.clientY >= box.top + el.clientTop + el.clientHeight) ||
    (barX >= 1 && e.clientX >= box.left + el.clientLeft + el.clientWidth)
}

// one slot each way; Home and End go to the ends of the row
function keyFor(e: KeyboardEvent, lifted: boolean): KeyMove | null {
  switch (e.key) {
    case "ArrowLeft": return "left"
    case "ArrowRight": return "right"
    case "ArrowUp": return "up"
    case "ArrowDown": return "down"
    case "Home": return lifted ? "first" : null
    case "End": return lifted ? "last" : null
    default: return null
  }
}
const sizeKey = (e: KeyboardEvent): 1 | -1 | 0 =>
  e.key === "+" || e.key === "=" ? 1 : e.key === "-" || e.key === "_" || e.key === "−" ? -1 : 0
// which way a key leans, for the bump
const LEAN: Record<string, [number, number]> = {
  left: [-1, 0], right: [1, 0], first: [-1, 0], last: [1, 0], up: [0, -1], down: [0, 1],
}

export class DragController {
  readonly motion = new DeskMotion()
  private desk: HTMLElement | null = null
  private press: Press | null = null
  private s: Session | null = null
  private zone: DropZone | null = null
  private arranging: Record<string, true> = {}
  private committing = false
  // the footprint's slot as drawn (for its glide), and its timers
  private foot: Rect | null = null
  private afterglow = 0
  private flashing = 0
  private holding = 0
  private settleTimer = 0
  private settleOff: (() => void) | null = null
  // per widget: a pin or unpin sequence, a morph, a tug just told
  private timers: Record<string, number[]> = {}
  private told: Record<string, number> = {}
  private morphing: Record<string, () => void> = {}
  // a pointer session ended while the button was still down: swallow its click
  private pendingUp: number | null = null
  // the spare row's length, kept after a session ended with the page
  // scrolled into it, until the page is scrolled back up (px)
  private hold: { min: number; natural: number } | null = null

  constructor(private readonly host: DragHost) {}

  attach(desk: HTMLElement) {
    if (this.desk === desk) return
    this.detach()
    this.desk = desk
    this.motion.attach(desk)
    desk.addEventListener("pointerdown", this.onDown)
    desk.addEventListener("click", this.onClick)
    desk.addEventListener("keydown", this.onKey)
    desk.addEventListener("focusout", this.onFocusOut)
    desk.addEventListener("contextmenu", this.onContextMenu)
  }

  detach() {
    this.cancel()
    const desk = this.desk
    if (!desk) return
    desk.removeEventListener("pointerdown", this.onDown)
    desk.removeEventListener("click", this.onClick)
    desk.removeEventListener("keydown", this.onKey)
    desk.removeEventListener("focusout", this.onFocusOut)
    desk.removeEventListener("contextmenu", this.onContextMenu)
    for (const id of Object.keys(this.timers)) this.clearTimers(id)
    this.release()
    this.desk = null
    this.motion.attach(null)
  }

  // the desk unmounts for good
  dispose() {
    this.detach()
    this.motion.dispose()
  }

  // the drawer pull registers itself as a drop target
  setDropZone(zone: DropZone | null) {
    this.zone = zone
  }

  // .desk[data-arranging] shows the lattice; anything may ask for it (a drag,
  // the open drawer), and it stays while anyone still does. arranging is also
  // when the canvases slow down and the ink trail rests (the busy flag)
  setArranging(reason: string, on: boolean) {
    if (on) this.arranging[reason] = true
    else delete this.arranging[reason]
    const any = Object.keys(this.arranging).length > 0
    setRenderBusy(any)
    const desk = this.desk
    if (!desk || any === desk.hasAttribute("data-arranging")) return
    if (any) { this.release(); desk.setAttribute("data-arranging", ""); return }
    // the spare row goes, but never from under a page scrolled into it: that
    // would jump everything on screen. the page keeps its length (nothing
    // moves) and gives it back as it's scrolled up
    const y0 = window.scrollY, tall = desk.offsetHeight
    desk.removeAttribute("data-arranging")
    if (window.scrollY >= y0 - 0.5) return
    this.hold = { min: tall, natural: desk.offsetHeight }
    desk.style.minHeight = `${tall}px`
    window.scrollTo(window.scrollX, y0)
    window.addEventListener("scroll", this.onHoldScroll, { passive: true })
  }

  // scrolled up: the held length shrinks by whatever is below the window now
  private onHoldScroll = () => {
    const hold = this.hold, desk = this.desk
    if (!hold || !desk) { this.release(); return }
    const slack = document.documentElement.scrollHeight - window.scrollY - window.innerHeight
    if (slack < 1) return
    hold.min -= slack
    if (hold.min <= hold.natural + 0.5) this.release()
    else desk.style.minHeight = `${hold.min}px`
  }

  private release() {
    if (!this.hold) return
    this.hold = null
    window.removeEventListener("scroll", this.onHoldScroll)
    if (this.desk) this.desk.style.minHeight = ""
  }

  get active(): boolean {
    return this.s !== null
  }

  // a press or a carry in progress (a long press on a tile shouldn't open a context menu)
  get busy(): boolean {
    return this.s !== null || this.press !== null
  }

  // a bucket change, a dialog, the page menu: put back whatever is in hand
  cancel() {
    if (this.s) this.finish(this.s, "cancel")
    if (this.press) this.endPress()
  }

  // --- things the grip menu, the tack and keys ask for ---

  // pick it up with the keyboard, as if an arrow had been pressed with no step
  startMove(id: string) {
    if (this.s) return
    if (this.isPinned(id)) { this.resistKey(id, null); return }
    const s = this.begin(id, "key", null)
    if (s) this.host.announce(this.pickupWords(s))
  }

  // the menu's Move earlier / Move later: trade places with the widget before
  // or after it in reading order. the later of the two is dropped onto the
  // earlier one's spot, which then swaps back or takes the nearest room, so
  // the trade is clean even when the sizes differ (the tall radio stepping
  // after the cat would otherwise scatter the stack under it)
  step(id: string, dir: -1 | 1) {
    if (this.s) return
    const shot = this.host.shot(), info = this.host.widget(id)
    if (!shot || !info) return
    const order = readingOrder(shot.items)
    const at = order.findIndex((it) => it.id === id)
    const other = at < 0 ? null : order[at + dir] ?? null
    if (!other) { this.host.announce(`It's already at the ${dir < 0 ? "start" : "end"}.`); return }
    const first = dir < 0 ? other : order[at], later = dir < 0 ? order[at] : other
    const plan = other.pinned ? null : planDrop(shot.a, later.id, { x: first.x, y: first.y }, shot.cols, shot.m.visibleRows)
    const me = plan ? find(plan.items, id) : null
    // a pin can't trade, and nor can a widget too big to move over for this
    // one (the drop would slide somewhere else instead)
    if (!plan || !me || (plan.rule !== "exact" && plan.rule !== "push" && plan.rule !== "trade")) {
      this.host.announce(other.pinned ? `${info.name} can't go past a pinned widget.` : `${info.name} can't trade places with ${this.name(other.id)}.`)
      return
    }
    this.flip(() => this.host.commit(plan.arrangement), { origin: me })
    const others = plan.moved.filter((m) => m !== id)
    if (later.id !== id) others.unshift(later.id)
    this.host.announce(`${info.name} is at ${where(me)}.${this.movers(others)}`)
  }

  // a size, straight from the menu or a size key on the handle: the shell
  // morphs in place and the ones under it make room; grown past the fold (or
  // around a pin), the page follows it
  resize(id: string, size: SizeId) {
    if (this.s) return
    const shot = this.host.shot(), info = this.host.widget(id)
    if (!shot || !info || own(shot.a.sizes, id) === size || info.sizes.indexOf(size) < 0) return
    const plan = planResize(shot.a, id, size, shot.cols)
    if (!plan) return
    this.morph(id, () => { this.host.commit(plan.arrangement); showWhenPlaced(id) }, plan)
    this.host.announce(`${cap(info.label(size))}, ${plan.landing.w} by ${plan.landing.h}.${this.movers(plan.moved)}`)
  }

  // the tack, P on a grip, and the menu: pinned or unpinned right where it
  // sits. nobody else moves either way (SPEC3 §1: pins only ever come from here)
  togglePin(id: string) {
    if (this.s) return
    const shot = this.host.shot(), info = this.host.widget(id)
    const me = shot ? find(shot.items, id) : null
    if (!shot || !info || !me) return
    const on = !me.pinned
    const plan = planPin(shot.a, id, on, shot.cols)
    if (!plan) return
    // only the tack moves: the widget stays exactly as it is
    this.host.commit(plan.arrangement)
    if (on) {
      this.strike(id)
      this.host.announce(`${info.name} is pinned. It stays put while the others move.`)
    } else {
      this.popPin(id)
      this.held(id, "unpin")
      this.host.emit({ kind: "pin", id, on: false })
      this.host.announce(`${info.name} is unpinned. It can be moved again.`)
    }
  }

  // a press on a drawer tile: past the threshold (or a still touch) the
  // widget is carried out onto the desk
  pressTile(e: PointerEvent, carry: Carry) {
    if (this.pendingUp !== null && !this.s && !this.press) { this.pendingUp = null; this.unlisten() }
    if (this.s || this.press || !e.isPrimary || e.button !== 0 || !this.desk || modalOpen()) return
    const type = e.pointerType || "mouse"
    const press: Press = {
      pointerId: e.pointerId, type, id: carry.id, frame: carry.tile, grip: false, resize: false, pinned: false,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: 0, charged: false, carry,
    }
    this.press = press
    this.listen(type === "touch")
    if (type === "touch") {
      carry.tile.setAttribute("data-charging", "")
      press.timer = window.setTimeout(() => this.lift(), TILE_PRESS_MS)
    }
  }

  // Just out of the drawer by a click: it rises from its tile into its slot
  // (a shared-element move: the tile's centre and width to the slot's), fades
  // in, lands with a small squash, and its footprint's lattice flashes.
  rise(id: string, from: DOMRect | null) {
    const el = this.frameOf(id), shot = this.host.shot(), desk = this.desk
    const it = shot ? find(shot.items, id) : null
    if (!el || !shot || !it || !desk || this.s) return
    this.flash(it)
    const mode = this.motion.sync()
    const body = this.motion.body(`f:${id}`)
    if (mode === "reduced" || !from) {
      body.jump({ opacity: 0 })
      body.fade(1, 160)
      return
    }
    const box = desk.getBoundingClientRect()
    const r = rectPx(it, shot.m)
    const dx = from.left + from.width / 2 - (box.left + r.left + r.width / 2)
    const dy = from.top + from.height / 2 - (box.top + r.top + r.height / 2)
    el.style.transformOrigin = ""
    body.jump({ x: dx, y: dy, scale: clamp(from.width / Math.max(1, r.width), 0.15, 1), lift: 1, opacity: 0 })
    this.motion.flush()
    body.fade(1, 120)
    body.to({ x: 0, y: 0, scale: 1 }, MOTION.rise)
    // the words and controls come in once it's mostly there
    const content = this.motion.body(`c:${id}`)
    content.jump({ opacity: 0 })
    this.later(id, 160, () => content.fade(1, 160))
    this.contact(id, Math.hypot(dx, dy), false, () => body.to({ lift: 0 }, MOTION.shadow))
  }

  // put it away; focus goes on to the next grip in reading order, or the pull
  putAway(id: string) {
    if (this.s) this.finish(this.s, "cancel")
    this.stow(id)
  }

  // A commit that may take the focused widget off the desk (a put-away, an
  // undo or redo): if it does, focus goes on to the next grip still there in
  // reading order (else the one before), or the pull when the desk is empty.
  // `leaving` is the one going for sure; otherwise it's whichever holds focus.
  keepFocus(commit: () => void, leaving?: string) {
    const shot = this.host.shot()
    const held = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(".wf") : null
    const id = leaving ?? (held && held.id.startsWith(PREFIX) ? held.id.slice(PREFIX.length) : undefined)
    const order = shot ? readingOrder(shot.items).map((it) => it.id) : []
    commit()
    const still = id !== undefined ? this.frameOf(id) : null
    // still on the desk (the commits flush at once): focus is fine where it is
    if (id === undefined || (leaving === undefined && still && still.isConnected && !still.hasAttribute("data-leaving"))) return
    const at = order.indexOf(id)
    const after = at >= 0 ? order.slice(at + 1).concat(order.slice(0, at).reverse()) : order
    for (const other of after) {
      const frame = this.frameOf(other)
      const grip = frame && !frame.hasAttribute("data-leaving") ? frame.querySelector<HTMLElement>("[data-grip]") : null
      if (grip) { grip.focus({ preventScroll: true }); return }
    }
    document.querySelector<HTMLElement>('[aria-controls="desk-drawer"]')?.focus({ preventScroll: true })
  }

  // Any commit that isn't a drag (a menu step, a pin, undo): frames whose
  // slot changed glide from where they were, rippling out from `origin`.
  // Arithmetic: two shots, no layout reads.
  flip(commit: () => void, o: { origin?: Rect | null; delay?: number } = {}) {
    const before = this.host.shot()
    commit()
    this.reflow(before, this.host.shot(), o.origin ?? null, o.delay ?? 0)
  }

  // --- motion helpers ---

  // every frame whose committed slot changed: its spring is rebased by the
  // difference (so it's drawn where it was) and then heads for its new slot
  private reflow(before: Shot | null, after: Shot | null, origin: Rect | null, delay: number, skip?: string, spring = MOTION.reflow) {
    if (!before || !after || before.bucket !== after.bucket) return
    const mode = this.motion.sync()
    const was = indexOf(before.items)
    const { pitchX, pitchY } = after.m
    const moved: string[] = []
    for (const it of after.items) {
      const old = own(was, it.id)
      const body = this.motion.has(`f:${it.id}`) ? this.motion.body(`f:${it.id}`) : null
      if (!old) {
        // back before it was gone (an undo mid-stow): home it comes
        if (body && !body.resting() && it.id !== skip) body.to({ x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, lift: 0 }, MOTION.rise)
        continue
      }
      if (it.id === skip || (old.x === it.x && old.y === it.y)) continue
      moved.push(it.id)
      if (mode === "reduced") continue
      this.motion.body(`f:${it.id}`).shift({ x: (old.x - it.x) * pitchX, y: (old.y - it.y) * pitchY })
    }
    if (!moved.length) return
    if (mode === "reduced") {
      // no travel: a short dip in opacity says it moved
      for (const id of moved) {
        const body = this.motion.body(`f:${id}`)
        body.jump({ opacity: 0.6 })
        body.fade(1, 120)
      }
      return
    }
    this.motion.flush()
    const delays = origin ? rippleDelays(after.items, origin, moved) : {}
    for (const id of moved) this.motion.body(`f:${id}`).to({ x: 0, y: 0 }, spring, { delay: delay + (own(delays, id) ?? 0) })
  }

  // The first frame the dropped widget is nearly home (within 12% of the way
  // it had to go, or at 90ms for a short trip): the contact squash, and what
  // comes after it (the pin strike, the shadow tucking in).
  private contact(id: string, distance: number, pin: boolean, then?: () => void) {
    const body = this.motion.body(`f:${id}`)
    const start = this.motion.anim.clock()
    const off = this.motion.anim.beforeFrame((now) => {
      const p = body.pose()
      const d = Math.hypot(p.x, p.y)
      const near = distance < 8 ? now - start >= 90 : d <= 0.12 * distance
      // never waits long: a drop interrupted by a new lift still lands
      if (!near && now - start < 420) return
      off()
      const v = body.velocity()
      const kick = squashImpulse(Math.hypot(v.x, v.y))
      body.kick({ sx: kick.sx, sy: kick.sy }, MOTION.squash)
      if (pin) this.strike(id)
      then?.()
    })
  }

  // Pinning: anticipation (the tack rises and swells), the strike (it drives
  // in, the side view turning into the round head), and the press (a ring of
  // dots goes out round the tack and another draws in round the slot, the
  // cat's ear flicks). The widget itself never moves.
  private strike(id: string) {
    const frame = this.frameOf(id)
    if (!frame) return
    this.clearTimers(id)
    const mode = this.motion.sync()
    if (mode === "reduced") {
      frame.removeAttribute("data-pinning")
      this.held(id, "pin")
      this.host.emit({ kind: "pin", id, on: true })
      return
    }
    const tack = this.motion.body(`t:${id}`)
    frame.setAttribute("data-pinning", "up")
    tack.jump({ x: 0, rotate: 0, opacity: 1 })
    tack.to({ y: -6, scale: 1.15 }, MOTION.pinUp)
    this.later(id, 90, () => {
      frame.setAttribute("data-pinning", "strike")
      tack.to({ y: 2, scale: 0.92 }, MOTION.strike)
    })
    this.later(id, 150, () => {
      frame.removeAttribute("data-pinning")
      this.held(id, "pin")
      if (mode === "full") this.restart(frame, "data-burst", 360)
      tack.to({ y: 0, scale: 1 }, MOTION.strike)
      this.host.emit({ kind: "pin", id, on: true })
    })
  }

  // Unpinning: the head pops, turns back into the side view and tips away
  // as it fades. The widget stays still.
  private popPin(id: string) {
    const frame = this.frameOf(id)
    if (!frame) return
    this.clearTimers(id)
    const mode = this.motion.sync()
    if (mode === "reduced") return
    const tack = this.motion.body(`t:${id}`)
    frame.setAttribute("data-unpinning", "pop")
    tack.to({ scale: 1.25, y: -4 }, MOTION.pop)
    this.later(id, 80, () => {
      frame.setAttribute("data-unpinning", "tip")
      tack.to(mode === "full" ? { rotate: 28, x: 6, y: -10 } : { x: 6, y: -10 }, MOTION.pop)
      tack.fade(0, 160)
    })
    // gone: back to rest out of sight, and (hovered) the faint offer fades in again
    this.later(id, 240, () => {
      frame.setAttribute("data-unpinning", "gone")
      tack.jump({ x: 0, y: 0, rotate: 0, scale: 1, opacity: 0 })
      tack.fade(1, 160)
    })
    this.later(id, 440, () => frame.removeAttribute("data-unpinning"))
  }

  // a tug on a pinned widget: the tack wobbles, its ring pulses once, the
  // slot it's held to shows, and it says (once in a while) how to move it
  private tugged(id: string, keys: boolean) {
    const frame = this.frameOf(id), info = this.host.widget(id)
    if (!frame || !info) return
    this.motion.sync()
    this.motion.body(`t:${id}`).kick({ rotate: 480 }, MOTION.wiggle)
    this.restart(frame, "data-pulse", 480)
    this.held(id, "tug")
    this.host.emit({ kind: "resist", id })
    if (keys) { this.host.announce(`${info.name} is pinned. Press P to unpin it.`); return }
    if (own(this.told, id)) return
    this.host.announce(`${info.name} is pinned. Unpin it to move it.`)
    this.told[id] = window.setTimeout(() => { delete this.told[id] }, TOLD_MS)
  }

  // a ring of dots round the widget's slot, on the desk (so a tugged widget
  // strains out of it and springs back in): drawn in as it's pinned, let go
  // as it's unpinned
  private held(id: string, how: Held) {
    const el = this.desk?.querySelector<HTMLElement>(":scope > .desk-held")
    const shot = this.host.shot()
    const it = shot ? find(shot.items, id) : null
    if (!el || !it) return
    el.style.setProperty("--x", String(it.x))
    el.style.setProperty("--y", String(it.y))
    el.style.setProperty("--w", String(it.w))
    el.style.setProperty("--h", String(it.h))
    window.clearTimeout(this.holding)
    el.removeAttribute("data-held")
    void el.offsetWidth
    el.setAttribute("data-held", how)
    this.holding = window.setTimeout(() => el.removeAttribute("data-held"), HELD_MS[how])
  }

  // arrows on a pinned grip: the same wobble, and a 6px nudge that way and back
  private resistKey(id: string, k: KeyMove | null) {
    const lean = k ? own(LEAN, k) : null
    if (lean) this.motion.body(`f:${id}`).kick({ x: lean[0] * BUMP_SPEED, y: lean[1] * BUMP_SPEED }, MOTION.resist)
    this.tugged(id, true)
  }

  // A resize: the old content fades out, the size commits, the surface
  // morphs from the old box to the new one on its own layer (so nothing
  // inside stretches), the frame travels if its slot moved, the neighbours
  // ripple out of the way, and the new content fades in.
  private morph(id: string, commit: () => void, plan: Plan | null) {
    const finishing = own(this.morphing, id)
    if (finishing) finishing()
    const mode = this.motion.sync()
    const content = this.motion.body(`c:${id}`)
    const run = () => {
      delete this.morphing[id]
      const before = this.host.shot()
      const was = before ? find(before.items, id) : null
      if (!plan && mode !== "reduced") content.jump({ opacity: 0 })
      commit()
      const after = this.host.shot()
      const now = after ? find(after.items, id) : null
      if (!before || !after || !was || !now) return
      if (mode === "reduced") {
        this.reflow(before, after, now, 0)
        content.jump({ opacity: 0.6 })
        content.fade(1, 120)
        return
      }
      const m = after.m
      const a = rectPx(was, m), b = rectPx(now, m)
      const surface = this.motion.body(`s:${id}`)
      surface.jump({ sx: a.width / Math.max(1, b.width), sy: a.height / Math.max(1, b.height) })
      const body = this.motion.body(`f:${id}`)
      if (was.x !== now.x || was.y !== now.y) body.shift({ x: (was.x - now.x) * m.pitchX, y: (was.y - now.y) * m.pitchY })
      this.reflow(before, after, now, 0, id)
      this.motion.flush()
      surface.to({ sx: 1, sy: 1 }, MOTION.morph)
      body.to({ x: 0, y: 0 }, MOTION.morph)
      this.later(id, MORPH_IN_DELAY, () => {
        content.jump({ scale: 0.985 })
        content.to({ scale: 1 }, MOTION.reflow)
        content.fade(1, 180)
      })
    }
    if (mode === "reduced" || !plan) { run(); return }
    content.fade(0, MORPH_OUT_MS)
    const timer = window.setTimeout(run, MORPH_OUT_MS)
    this.morphing[id] = () => { window.clearTimeout(timer); run() }
  }

  // Into the drawer: the frame flies to the pull's middle and shrinks to
  // almost nothing as it fades, the neighbours close the gap behind it, and
  // the pull catches it with a squash. From wherever it is now (a drop over
  // the pull starts from the hand).
  private stow(id: string) {
    const before = this.host.shot()
    const was = before ? find(before.items, id) : null
    const desk = this.desk
    if (!before || !was || !desk) {
      this.keepFocus(() => this.host.putAway(id), id)
      return
    }
    const mode = this.motion.sync()
    const body = this.motion.body(`f:${id}`)
    this.keepFocus(() => this.host.putAway(id), id)
    // reads, after the commit: a shorter page may have scrolled back, and the
    // leaving frame keeps its place on the board
    const box = desk.getBoundingClientRect()
    const pullEl = document.querySelector<HTMLElement>(".drawer-pull")
    const pull = pullEl ? pullEl.getBoundingClientRect() : null
    const after = this.host.shot()
    this.reflow(before, after, was, mode === "full" ? 60 : 0)
    this.clearTimers(id)
    if (mode === "reduced" || !pull) {
      body.fade(0, 120)
    } else {
      const r = rectPx(was, before.m)
      const p = body.pose()
      const cx = box.left + r.left + r.width / 2 + p.x, cy = box.top + r.top + r.height / 2 + p.y
      const frame = this.frameOf(id)
      if (frame) frame.style.transformOrigin = ""
      body.to({ x: p.x + pull.left + pull.width / 2 - cx, y: p.y + pull.top + pull.height / 2 - cy, scale: 0.18, rotate: 0, lift: 0.4 }, MOTION.stow)
      this.later(id, 100, () => body.fade(0, 240), true)
      this.later(id, 300, () => {
        const pullBody = this.motion.body("pull")
        pullBody.kick({ sx: 2.6, sy: -2.6 }, MOTION.squash)
      }, true)
    }
    // gone for good unless it came back (an undo): its springs are forgotten
    window.setTimeout(() => {
      const frame = this.frameOf(id)
      if (frame && !frame.hasAttribute("data-leaving")) return
      for (const k of ["f", "t", "s", "c"]) this.motion.forget(`${k}:${id}`)
    }, (mode === "reduced" ? LEAVE_REDUCED_MS : LEAVE_MS) + 40)
  }

  // the footprint: where the widget in hand will land, lit, gliding between
  // slots; with the tack's head at its corner when P has asked for a pin
  private footTo(rect: Rect | null, pin = false, glide = true) {
    const el = this.desk?.querySelector<HTMLElement>(":scope > .desk-landing")
    if (!el) return
    if (!rect) {
      el.removeAttribute("data-on")
      this.foot = null
      return
    }
    const was = this.foot
    const shot = this.s ? this.s.shot : this.host.shot()
    if (was && glide && shot && this.motion.mode !== "reduced" && (was.x !== rect.x || was.y !== rect.y)) {
      const body = this.motion.body("fp")
      body.shift({ x: (was.x - rect.x) * shot.m.pitchX, y: (was.y - rect.y) * shot.m.pitchY })
      body.to({ x: 0, y: 0 }, MOTION.footprint)
    } else if (!was) this.motion.body("fp").jump({ x: 0, y: 0 })
    if (!was || was.x !== rect.x) el.style.setProperty("--x", String(rect.x))
    if (!was || was.y !== rect.y) el.style.setProperty("--y", String(rect.y))
    if (!was || was.w !== rect.w) el.style.setProperty("--w", String(rect.w))
    if (!was || was.h !== rect.h) el.style.setProperty("--h", String(rect.h))
    if (pin !== el.hasAttribute("data-pin")) el.toggleAttribute("data-pin", pin)
    if (!el.hasAttribute("data-on")) el.setAttribute("data-on", "")
    this.foot = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  }

  // the resize handle's size name, over the footprint it snaps to
  private chipAt(rect: Rect | null, label: string | null) {
    const el = this.desk?.querySelector<HTMLElement>(":scope > .desk-chip")
    if (!el) return
    if (!rect) { el.removeAttribute("data-on"); return }
    if (label !== null && el.getAttribute("data-label") !== label) el.setAttribute("data-label", label)
    el.style.setProperty("--x", String(rect.x))
    el.style.setProperty("--y", String(rect.y))
    el.style.setProperty("--w", String(rect.w))
    el.style.setProperty("--h", String(rect.h))
    el.setAttribute("data-on", "")
  }

  // a widget just out of the drawer: its footprint's lattice lights up and fades
  private flash(r: Rect) {
    const el = this.desk?.querySelector<HTMLElement>(":scope > .desk-flash")
    if (!el) return
    el.style.setProperty("--x", String(r.x))
    el.style.setProperty("--y", String(r.y))
    el.style.setProperty("--w", String(r.w))
    el.style.setProperty("--h", String(r.h))
    window.clearTimeout(this.flashing)
    this.restart(el, "data-flash", FLASH_MS)
  }

  // an attribute that plays a CSS keyframe once: off, a reflow, on, off later
  private restart(el: HTMLElement, name: string, ms: number) {
    el.removeAttribute(name)
    void el.offsetWidth
    el.setAttribute(name, "")
    window.setTimeout(() => el.removeAttribute(name), ms)
  }

  // a sequence's steps, cleared if another starts on the same widget
  // (`loose`: a put-away's, which a new sequence on its return mustn't cut short)
  private later(id: string, ms: number, fn: () => void, loose = false) {
    const timer = window.setTimeout(() => {
      const list = own(this.timers, id)
      if (list) this.timers[id] = list.filter((t) => t !== timer)
      fn()
    }, ms)
    if (!loose) (this.timers[id] = own(this.timers, id) ?? []).push(timer)
  }

  private clearTimers(id: string) {
    const list = own(this.timers, id)
    if (!list) return
    for (const t of list) window.clearTimeout(t)
    delete this.timers[id]
    const frame = this.frameOf(id)
    frame?.removeAttribute("data-pinning")
    frame?.removeAttribute("data-unpinning")
  }

  // the lattice stays while the drop settles: until everything rests, at most SETTLE_CAP_MS
  private settleArranging() {
    this.settleOff?.()
    window.clearTimeout(this.settleTimer)
    const done = () => {
      this.settleOff?.()
      this.settleOff = null
      window.clearTimeout(this.settleTimer)
      if (!this.s) this.setArranging("session", false)
    }
    if (!this.motion.anim.running) { this.settleTimer = window.setTimeout(done, this.motion.mode === "reduced" ? AFTERGLOW_MS : 60); return }
    this.settleOff = this.motion.anim.onIdle(done)
    this.settleTimer = window.setTimeout(done, SETTLE_CAP_MS)
  }

  // --- presses ---

  private isPinned(id: string): boolean {
    const shot = this.host.shot()
    const me = shot ? find(shot.items, id) : null
    return !!me && me.pinned
  }

  private onDown = (e: PointerEvent) => {
    // a new press means the button held through the last cancel came up unseen
    if (this.pendingUp !== null && !this.s && !this.press) { this.pendingUp = null; this.unlisten() }
    if (this.s || this.press || !e.isPrimary || e.button !== 0) return
    const target = e.target instanceof Element ? e.target : null
    const frame = target?.closest<HTMLElement>(".wf")
    const desk = this.desk
    if (!target || !frame || !desk || !desk.contains(frame) || !frame.id.startsWith(PREFIX)) return
    // on its way into the drawer
    if (frame.hasAttribute("data-leaving")) return
    // an open tray or sheet: this press is for folding it away
    if (frame.hasAttribute("data-expanded")) return
    // a menu open anywhere: this press closes it first
    if (this.host.menuOpen() || modalOpen()) return
    const grip = !!target.closest("[data-grip]")
    const resize = !grip && !!target.closest("[data-resize]")
    if (resize && e.pointerType === "touch") return
    if (!grip && !resize && (target.closest(NO_LIFT) || onScrollbar(target, e))) return
    const id = frame.id.slice(PREFIX.length)
    const press: Press = {
      pointerId: e.pointerId, type: e.pointerType || "mouse", id, frame, grip, resize, pinned: this.isPinned(id),
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: 0, charged: false, carry: null,
    }
    this.press = press
    this.listen(press.type === "touch")
    if (press.type === "touch" && !grip) {
      // the body lifts after a still press; moving first means scrolling
      frame.setAttribute("data-charging", "")
      press.charged = !press.pinned
      press.timer = window.setTimeout(() => this.lift(), LONG_PRESS_MS)
    }
  }

  private onMove = (e: PointerEvent) => {
    const p = this.press
    if (p && !this.s && e.pointerId === p.pointerId) {
      p.x = e.clientX
      p.y = e.clientY
      const d = Math.hypot(p.x - p.x0, p.y - p.y0)
      if (p.type === "touch" && !p.grip) {
        if (d > LONG_PRESS_SLOP) this.endPress()
        return
      }
      if (d >= (THRESHOLD[p.type] ?? THRESHOLD.mouse)) this.lift()
      return
    }
    const s = this.s
    if (s && s.kind !== "key" && e.pointerId === s.pointerId) {
      s.x = e.clientX
      s.y = e.clientY
      const list = s.samples
      list.push({ x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now() })
      if (list.length > SAMPLES) list.shift()
    }
  }

  private onUp = (e: PointerEvent) => {
    const s = this.s
    if (s && s.kind !== "key" && e.pointerId === s.pointerId) {
      s.x = e.clientX
      s.y = e.clientY
      // the hand's last word: let go after holding still, it's not a fling
      s.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now() })
      if (s.samples.length > SAMPLES) s.samples.shift()
      this.finish(s, "commit")
      return
    }
    if (this.press && !s && e.pointerId === this.press.pointerId) { this.endPress(); return }
    if (this.pendingUp === e.pointerId) {
      this.pendingUp = null
      this.unlisten()
      this.swallowClick(e.pointerType)
    }
  }

  private onCancel = (e: PointerEvent) => {
    const s = this.s
    if (s && s.kind !== "key" && e.pointerId === s.pointerId) { this.finish(s, "cancel", true); return }
    if (this.press && e.pointerId === this.press.pointerId) this.endPress()
    if (this.pendingUp === e.pointerId) { this.pendingUp = null; this.unlisten() }
  }

  // capture lost without a pointerup (the frame left the page, say): a drop.
  // a child losing a touch's implicit capture to the frame bubbles here too
  private onLost = (e: PointerEvent) => {
    const s = this.s
    if (s && s.kind !== "key" && e.target === s.captor && e.pointerId === s.pointerId && !this.committing) this.finish(s, "commit")
  }

  private onContextMenu = (e: Event) => {
    // a long press is a lift, not a context menu
    if (this.s || (this.press && this.press.type === "touch")) e.preventDefault()
  }

  private endPress() {
    const p = this.press
    if (!p) return
    window.clearTimeout(p.timer)
    p.frame.removeAttribute("data-charging")
    this.press = null
    if (!this.s && this.pendingUp === null) this.unlisten()
  }

  private listen(touch: boolean) {
    window.addEventListener("pointermove", this.onMove, { passive: true })
    window.addEventListener("pointerup", this.onUp)
    window.addEventListener("pointercancel", this.onCancel)
    // not passive: once it's lifted the browser must never take the gesture
    if (touch) window.addEventListener("touchmove", this.onTouchMove, { passive: false })
  }

  private unlisten() {
    window.removeEventListener("pointermove", this.onMove)
    window.removeEventListener("pointerup", this.onUp)
    window.removeEventListener("pointercancel", this.onCancel)
    window.removeEventListener("touchmove", this.onTouchMove)
  }

  private onTouchMove = (e: TouchEvent) => {
    if (this.s && pointerKind(this.s.kind) && e.cancelable) e.preventDefault()
  }

  private lift() {
    const p = this.press
    if (!p) return
    window.clearTimeout(p.timer)
    p.frame.removeAttribute("data-charging")
    const s = p.carry ? this.beginCarry(p) : this.begin(p.id, p.resize ? "resize" : p.pinned ? "resist" : "pointer", p)
    this.press = null
    if (!s) { this.unlisten(); return }
    if (p.type === "touch" && !p.grip && typeof navigator !== "undefined" && navigator.vibrate &&
      (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) navigator.vibrate(8)
  }

  // --- sessions ---

  private begin(id: string, kind: Kind, p: Press | null): Session | null {
    const desk = this.desk, shot = this.host.shot(), info = this.host.widget(id)
    if (!desk || !shot || !info) return null
    const me = find(shot.items, id)
    const el = this.frameOf(id)
    if (!me || !el) return null
    const mode = this.motion.sync()
    this.settleOff?.()
    window.clearTimeout(this.settleTimer)
    // --- reads: all of them now, none again until the drop ---
    const box = desk.getBoundingClientRect()
    const scroll = window.scrollY
    const m = shot.m
    const body = this.motion.body(`f:${id}`)
    // a widget still springing is picked up exactly where it is (reduced
    // motion draws no offset, so none is counted)
    const pose = mode === "reduced" ? { x: 0, y: 0 } : body.pose()
    const x0 = p ? p.x0 : 0, y0 = p ? p.y0 : 0
    const s: Session = {
      kind, id, info, el, captor: el, grip: el.querySelector<HTMLElement>("[data-grip]"), shot, pickup: indexOf(shot.items), me,
      size: own(shot.a.sizes, id) ?? info.sizes[0], fp: { w: me.w, h: me.h }, a: shot.a,
      T: { x: me.x, y: me.y }, plan: null, shown: null, since: 0, targets: {}, nodded: null,
      maxY: deepest(layoutOf({ ...shot.a, order: shot.a.order.filter((other) => other !== id) }, shot.cols)),
      pointerId: p ? p.pointerId : -1, type: p ? p.type : "key", x0, y0, x: p ? p.x : 0, y: p ? p.y : 0, samples: [],
      scroll0: scroll, scrollY: scroll, viewH: window.innerHeight, maxScroll: 0,
      left: box.left, top: box.top + scroll,
      grabX: x0 - (box.left + me.x * m.pitchX + pose.x), grabY: y0 - (box.top + me.y * m.pitchY + pose.y),
      zone: null, carry: null, home: null, pinOnDrop: null, unhook: null,
    }
    if (p) s.samples.push({ x: p.x, y: p.y, t: performance.now() })
    if (kind === "pointer" && this.zone) s.zone = { el: this.zone.element, box: this.zone.box(), over: false }
    // --- writes ---
    this.s = s
    if (kind === "resist") {
      el.setAttribute("data-resisting", "")
      this.tugged(id, false)
      this.started(s)
      return s
    }
    el.setAttribute(kind === "resize" ? "data-resizing" : "data-lifted", kind)
    el.removeAttribute("data-settling")
    if (kind === "pointer") {
      // the grab point stays under the hand as it swells and leans
      el.style.transformOrigin = `${s.grabX.toFixed(1)}px ${s.grabY.toFixed(1)}px`
      if (p && p.charged && mode === "full") body.jump({ scale: CHARGED_SCALE })
    } else if (kind === "key") el.style.transformOrigin = ""
    if (kind !== "resize") body.to({ scale: LIFT_SCALE, lift: 1 }, MOTION.lift)
    this.setArranging("session", true)
    if (kind === "resize") desk.setAttribute("data-resizing", "")
    this.footTo(me, false, false)
    if (kind === "resize") this.chipAt(me, info.label(s.size))
    this.started(s)
    return s
  }

  // the rest of a lift, once the session holds what it read
  private started(s: Session) {
    if (s.zone) s.zone.el.setAttribute("data-drag", "")
    this.host.setSession(true)
    if (s.kind !== "resist") this.host.emit({ kind: "lift", id: s.id })
    // with the spare row in, the page may scroll further: the one read after a write
    s.maxScroll = Math.max(0, document.documentElement.scrollHeight - s.viewH)
    window.addEventListener("scroll", this.onScroll, { passive: true })
    window.addEventListener("blur", this.onBlur)
    document.addEventListener("focusin", this.onFocusIn)
    if (s.kind !== "key") {
      window.addEventListener("keydown", this.onSessionKey, true)
      s.captor.addEventListener("lostpointercapture", this.onLost)
      try { s.captor.setPointerCapture(s.pointerId) } catch { /* the window listeners still follow it */ }
      s.unhook = this.motion.anim.beforeFrame((now) => this.frame(s, now))
    }
  }

  // Out of the drawer: everything read now, then the sheet folds and the
  // ghost appears under the hand at the size the widget will be.
  private beginCarry(p: Press): Session | null {
    const desk = this.desk, shot = this.host.shot(), carry = p.carry, info = carry ? this.host.widget(carry.id) : null
    if (!desk || !shot || !carry || !info) return null
    this.motion.sync()
    this.settleOff?.()
    window.clearTimeout(this.settleTimer)
    // --- reads ---
    const box = desk.getBoundingClientRect()
    const scroll = window.scrollY
    const home = (carry.tile.querySelector(".tile-preview") ?? carry.tile).getBoundingClientRect()
    const strip = carry.strip.box()
    const fp = footprint(carry.size, shot.cols)
    const r = rectPx({ x: 0, y: 0, w: fp.w, h: fp.h }, shot.m)
    // held where it was held on the tile, scaled up
    const fx = clamp((p.x0 - home.left) / Math.max(1, home.width), 0.1, 0.9)
    const fy = clamp((p.y0 - home.top) / Math.max(1, home.height), 0.1, 0.9)
    // --- writes ---
    this.motion.forget("ghost")
    const ghost = carry.lift(r.width, r.height)
    if (!ghost) return null
    const s: Session = {
      kind: "carry", id: carry.id, info, el: ghost, captor: carry.tile, grip: null, shot, pickup: indexOf(shot.items), me: null,
      size: carry.size, fp: { w: fp.w, h: fp.h }, a: shot.a,
      T: null, plan: null, shown: null, since: 0, targets: {}, nodded: null,
      maxY: deepest(shot.items),
      pointerId: p.pointerId, type: p.type, x0: p.x, y0: p.y, x: p.x, y: p.y, samples: [{ x: p.x, y: p.y, t: performance.now() }],
      scroll0: scroll, scrollY: scroll, viewH: window.innerHeight, maxScroll: 0,
      left: box.left, top: box.top + scroll, grabX: fx * r.width, grabY: fy * r.height,
      zone: { el: carry.strip.element, box: strip, over: false }, carry, home, pinOnDrop: null, unhook: null,
    }
    this.s = s
    ghost.setAttribute("data-lifted", "pointer")
    const g = this.motion.body("ghost")
    g.jump({ x: p.x - s.grabX, y: p.y - s.grabY, scale: 1 })
    g.to({ scale: LIFT_SCALE }, MOTION.lift)
    this.motion.flush()
    this.setArranging("session", true)
    this.started(s)
    return s
  }

  private onScroll = () => {
    if (this.s) this.s.scrollY = window.scrollY
  }

  private onBlur = () => {
    const s = this.s
    if (s && s.kind !== "key") this.finish(s, "cancel")
  }

  // a dialog or menu taking focus takes the lift with it
  private onFocusIn = (e: FocusEvent) => {
    const s = this.s
    const target = e.target instanceof Element ? e.target : null
    if (s && target && !s.el.contains(target) && target.closest('dialog, [role="menu"], .page-menu')) this.finish(s, "cancel")
  }

  private onSessionKey = (e: KeyboardEvent) => {
    const s = this.s
    if (!s || s.kind === "key") return
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      this.finish(s, "cancel")
    }
  }

  // One animation frame of a pointer session (before the springs advance):
  // scroll, follow the hand, and plan the slot under it.
  private frame(s: Session, now: number) {
    if (this.s !== s) return
    this.autoScroll(s)
    const m = s.shot.m
    if (s.kind === "resist") {
      this.motion.body(`f:${s.id}`).to({
        x: rubberBand(s.x - s.x0, RESIST_PX), y: rubberBand(s.y - s.y0 + s.scrollY - s.scroll0, RESIST_PX),
      }, MOTION.follow)
      return
    }
    if (s.kind === "resize") { this.resizeFrame(s, now); return }
    const v = this.handSpeed(s, performance.now())
    // the carried box's top-left, in board px
    const left = s.x - s.left - s.grabX
    const top = s.y + s.scrollY - s.top - s.grabY
    const width = s.fp.w * m.pitchX - m.gap
    const maxLeft = m.boardWidth - width
    // past the board's sides it gives, less and less
    const shownLeft = left < 0 ? -rubberBand(-left, EDGE_PX) : left > maxLeft ? maxLeft + rubberBand(left - maxLeft, EDGE_PX) : left
    // the lean is full motion's alone: low power and reduced motion stay upright
    const tilt = this.motion.mode === "full" ? tiltFor(v.vx) : 0
    if (s.kind === "carry") {
      const g = this.motion.body("ghost")
      g.to({ x: s.left + shownLeft, y: s.top + top - s.scrollY }, MOTION.follow)
      g.to({ rotate: tilt }, MOTION.tilt)
    } else {
      const body = this.motion.body(`f:${s.id}`)
      body.to({ x: shownLeft - s.me!.x * m.pitchX, y: top - s.me!.y * m.pitchY }, MOTION.follow)
      body.to({ rotate: tilt }, MOTION.tilt)
    }
    if (s.zone) {
      const over = inBox(s.zone.box, s.x, s.y)
      if (over !== s.zone.over) {
        s.zone.over = over
        s.zone.el.toggleAttribute("data-over", over)
        if (over) {
          // over the drawer everyone goes home, and nothing would land
          s.T = null
          s.plan = null
          this.footTo(null)
          this.homeAll(s)
          return
        }
      }
      if (over) return
    }
    const T = slotAt(left, top, s.fp, m, s.maxY, s.T, this.hand(s))
    if (!s.T || T.x !== s.T.x || T.y !== s.T.y) {
      s.T = T
      s.since = now
      s.plan = this.planFor(s, T)
      if (s.plan) this.footTo(s.plan.landing, s.pinOnDrop === true)
      this.nod(s, T)
    }
    // the neighbours wait for the hand to settle on a slot, unless it's slow
    if (s.plan && s.plan !== s.shown && (now - s.since >= DWELL_MS || Math.hypot(v.vx, v.vy) < SLOW_HAND)) this.show(s, s.plan)
  }

  // the hand in board px: the cell it's over is one the widget lands on
  private hand(s: Session): Slot {
    return { x: s.x - s.left, y: s.y + s.scrollY - s.top }
  }

  // the hand's velocity (px/s) from its recent samples; nothing new from it
  // lately means it's holding still, so the lean sways back
  private handSpeed(s: Session, now: number): { vx: number; vy: number } {
    const last = s.samples[s.samples.length - 1]
    if (!last || now - last.t > STILL_MS) return { vx: 0, vy: 0 }
    return pointerVelocity(s.samples)
  }

  private planFor(s: Session, T: Slot): Plan | null {
    const cols = s.shot.cols
    const view = s.shot.m.visibleRows
    return s.kind === "carry" ? planInsert(s.a, s.id, s.size, T, cols, view) : planDrop(s.a, s.id, T, cols, view)
  }

  // the neighbours glide to where the plan puts them, nearest the footprint
  // first, so the room opens up as a ripple; one already moving keeps its speed
  private show(s: Session, plan: Plan) {
    s.shown = plan
    const { pitchX, pitchY } = s.shot.m
    const changed: string[] = []
    const next: Record<string, [number, number]> = {}
    for (const it of plan.items) {
      if (it.id === s.id) continue
      const was = own(s.pickup, it.id)
      if (!was) continue
      const tx = (it.x - was.x) * pitchX, ty = (it.y - was.y) * pitchY
      next[it.id] = [tx, ty]
      const cur = own(s.targets, it.id)
      if ((cur ? cur[0] : 0) !== tx || (cur ? cur[1] : 0) !== ty) changed.push(it.id)
    }
    s.targets = next
    if (!changed.length) return
    // reduced motion draws no translate, so nobody is sent anywhere it can't be seen
    if (this.motion.mode === "reduced") return
    const delays = rippleDelays(plan.items, plan.landing, changed)
    for (const id of changed) {
      const t = next[id]
      this.motion.body(`f:${id}`).to({ x: t[0], y: t[1] }, MOTION.reflow, { delay: own(delays, id) ?? 0 })
    }
  }

  private homeAll(s: Session) {
    for (const id of Object.keys(s.targets)) {
      const t = s.targets[id]
      if (t[0] || t[1]) this.motion.body(`f:${id}`).to({ x: 0, y: 0 }, MOTION.reflow)
    }
    s.targets = {}
    s.shown = null
  }

  // hovering over a pinned widget, that one nods once and stays
  private nod(s: Session, T: Slot) {
    const rect: Rect = { x: T.x, y: T.y, w: s.fp.w, h: s.fp.h }
    let pinned: string | null = null
    for (const it of s.shot.items) if (it.pinned && it.id !== s.id && overlaps(it, rect)) { pinned = it.id; break }
    if (pinned && pinned !== s.nodded) this.motion.body(`f:${pinned}`).kick({ rotate: 27 }, MOTION.wiggle)
    s.nodded = pinned
  }

  private autoScroll(s: Session) {
    // not while it hovers the drawer, where it's about to be let go
    if (!pointerKind(s.kind) || (s.zone && s.zone.over)) return
    const fromTop = s.y, fromBottom = s.viewH - s.y
    let dy = 0
    if (fromTop < EDGE && s.scrollY > 0) dy = -(((EDGE - Math.max(0, fromTop)) / EDGE) ** 2) * EDGE_SPEED
    else if (fromBottom < EDGE && s.scrollY < s.maxScroll) dy = (((EDGE - Math.max(0, fromBottom)) / EDGE) ** 2) * EDGE_SPEED
    if (!dy) return
    window.scrollBy(0, dy)
    // the scroll event confirms it; until then assume it went through
    s.scrollY = clamp(s.scrollY + dy, 0, s.maxScroll)
  }

  // the handle: the nearest of the widget's sizes to where the corner is
  // pulled, by width first, then height; the neighbours preview it live
  private resizeFrame(s: Session, now: number) {
    const m = s.shot.m, me = s.me!
    const wantW = rectPx(me, m).width + s.x - s.x0
    const wantH = rectPx(me, m).height + s.y - s.y0 + s.scrollY - s.scroll0
    let best: SizeId | null = null, bestW = Infinity, bestH = Infinity
    for (const size of s.info.sizes) {
      const fp = footprint(size, s.shot.cols)
      const r = rectPx({ x: 0, y: 0, w: fp.w, h: fp.h }, m)
      const dw = Math.abs(r.width - wantW), dh = Math.abs(r.height - wantH)
      if (dw < bestW - 0.5 || (Math.abs(dw - bestW) <= 0.5 && dh < bestH)) { best = size; bestW = dw; bestH = dh }
    }
    if (!best || (best === s.size && s.plan)) return
    s.size = best
    const plan = planResize(s.a, s.id, best, s.shot.cols)
    if (!plan) return
    s.plan = plan
    s.since = now
    this.footTo(plan.landing, s.pinOnDrop === true)
    this.chipAt(plan.landing, s.info.label(best))
    this.show(s, plan)
  }

  // --- the end of a session ---

  private finish(s: Session, how: Ending, gone = false) {
    if (this.s !== s) return
    const host = this.host
    const pointer = s.kind !== "key"
    const carry = s.kind === "carry" ? s.carry : null
    // a commit ends with the button up; a cancel may leave it down
    const released = how === "commit"
    // stop listening before anything else can start another step
    this.s = null
    s.unhook?.()
    window.removeEventListener("scroll", this.onScroll)
    window.removeEventListener("blur", this.onBlur)
    document.removeEventListener("focusin", this.onFocusIn)
    if (pointer) {
      window.removeEventListener("keydown", this.onSessionKey, true)
      s.captor.removeEventListener("lostpointercapture", this.onLost)
      try { if (s.captor.hasPointerCapture(s.pointerId)) s.captor.releasePointerCapture(s.pointerId) } catch { /* already gone */ }
    }
    const mode = this.motion.sync()
    // the hand's last word: its speed, and (a drag) the slot it ended on
    const v = this.handSpeed(s, performance.now())
    const speed = Math.hypot(v.vx, v.vy)
    const k = speed > RELEASE_MAX ? RELEASE_MAX / speed : 1
    const release = { x: v.vx * k, y: v.vy * k }
    if (how === "commit" && (s.kind === "pointer" || s.kind === "carry") && !(s.zone && s.zone.over)) {
      const m = s.shot.m
      const T = slotAt(s.x - s.left - s.grabX, s.y + s.scrollY - s.top - s.grabY, s.fp, m, s.maxY, s.T, this.hand(s))
      if (!s.T || T.x !== s.T.x || T.y !== s.T.y || !s.plan) { s.T = T; s.plan = this.planFor(s, T) }
    }
    // let go over the drawer: put away, or (out of it) kept in it
    if (how === "commit" && s.zone && s.zone.over) how = carry ? "cancel" : "away"
    s.el.removeAttribute("data-lifted")
    s.el.removeAttribute("data-resizing")
    s.el.removeAttribute("data-resisting")
    this.desk?.removeAttribute("data-resizing")
    this.chipAt(null, null)
    if (s.zone) { s.zone.el.removeAttribute("data-drag"); s.zone.el.removeAttribute("data-over") }
    this.committing = true
    try {
      if (s.kind === "resist") this.endResist(s, release)
      else if (carry) this.endCarry(s, how, release)
      else if (how === "away") this.endAway(s)
      else if (how === "commit") this.endDrop(s, release, mode)
      else this.endCancel(s)
    } finally {
      this.committing = false
    }
    host.setSession(false)
    if (s.kind !== "resist") this.settleArranging()
    // no click after a drag: now, or (Esc, a bucket change) when the button
    // that's still down comes up
    if (pointer && !gone) {
      if (!released) this.pendingUp = s.pointerId
      else this.swallowClick(s.type)
    }
    if (pointer && this.pendingUp === null) this.unlisten()
  }

  // the footprint goes, or (reduced motion, where nothing travels) stays lit a moment
  private footDone(landing: Rect | null) {
    if (this.motion.mode === "reduced" && landing) {
      this.footTo(landing, false, false)
      const el = this.desk?.querySelector<HTMLElement>(":scope > .desk-landing")
      el?.setAttribute("data-afterglow", "")
      window.clearTimeout(this.afterglow)
      this.afterglow = window.setTimeout(() => {
        el?.removeAttribute("data-afterglow")
        if (!this.s) this.footTo(null)
      }, AFTERGLOW_MS)
      return
    }
    this.footTo(null)
  }

  // everyone back where they were picked up
  private endCancel(s: Session, say = true) {
    const body = this.motion.body(`f:${s.id}`)
    this.homeAll(s)
    body.to({ x: 0, y: 0, scale: 1 }, MOTION.drop)
    body.to({ rotate: 0 }, MOTION.tilt)
    body.to({ lift: 0 }, MOTION.shadow)
    this.settling(s.el, body)
    this.footTo(null)
    this.host.emit({ kind: "cancel", id: s.id })
    if (say) this.host.announce(`${s.info.name} is back where it was.`)
  }

  // over the pull: into the drawer, from right where it was let go
  private endAway(s: Session) {
    this.footTo(null)
    this.homeAll(s)
    this.stow(s.id)
  }

  // the dropped frame stays over the neighbours it passes until it's home
  private settling(el: HTMLElement, body: ReturnType<DeskMotion["body"]>) {
    el.setAttribute("data-settling", "")
    const off = body.onRest(() => {
      off()
      el.removeAttribute("data-settling")
      if (!el.hasAttribute("data-lifted")) el.style.transformOrigin = ""
    })
  }

  // A drop: the plan commits once; every frame whose slot changed is rebased
  // by arithmetic, so nothing moves on screen; then the carried one lands
  // with the hand's speed, a squash on contact and its shadow tucking in,
  // and the neighbours carry on to their new slots.
  private endDrop(s: Session, release: { x: number; y: number }, mode: string) {
    const host = this.host
    let plan = s.plan
    // P while lifted: the tack goes in where it's set down (a widget already
    // pinned can't be dragged, so only "pin" is ever asked for here)
    const pinning = s.pinOnDrop === true
    if (pinning) {
      const tacked = planPin(plan ? plan.arrangement : s.a, s.id, true, s.shot.cols)
      if (tacked) plan = plan ? { ...tacked, kind: plan.kind, rule: plan.rule, moved: plan.moved } : tacked
    }
    const sized = s.size !== own(s.shot.a.sizes, s.id)
    if (!plan || (plan.kind === "home" && !sized && !pinning)) {
      this.endCancel(s, false)
      host.emit({ kind: "drop", id: s.id, rect: s.me })
      host.announce(`${s.info.name} is back where it was.`)
      return
    }
    const final = plan
    const body = this.motion.body(`f:${s.id}`)
    // the neighbours that made room for a preview this drop doesn't keep head home
    const previewed = Object.keys(s.targets)
    const homeRest = () => { for (const id of previewed) this.motion.body(`f:${id}`).to({ x: 0, y: 0 }, MOTION.reflow) }
    const { pitchX, pitchY } = s.shot.m
    const me = s.me!
    const commit = () => host.commit(final.arrangement)
    const landing = final.landing
    if (s.kind === "resize" || (s.kind === "key" && sized)) {
      // a new size: the shell morphs (the frame goes home on the morph)
      this.footDone(null)
      s.targets = {}
      body.to({ scale: 1, rotate: 0 }, MOTION.drop)
      body.to({ lift: 0 }, MOTION.shadow)
      this.morph(s.id, () => { commit(); homeRest() }, null)
    } else {
      commit()
      const after = host.shot()
      // rebase: the carried one from its pickup slot, everyone else from theirs
      const dx = (me.x - landing.x) * pitchX, dy = (me.y - landing.y) * pitchY
      if (mode !== "reduced") body.shift({ x: dx, y: dy })
      this.reflow(s.shot, after, null, 0, s.id)
      // every mode: no neighbour keeps a preview offset into the next pickup
      homeRest()
      if (mode === "reduced") {
        body.jump({ x: 0, y: 0, scale: 1, rotate: 0, lift: 0, opacity: 0.6 })
        body.fade(1, 120)
      } else {
        this.motion.flush()
        const pose = body.pose()
        const distance = Math.hypot(pose.x, pose.y)
        const flung = s.kind === "pointer"
        body.to({ x: 0, y: 0 }, MOTION.drop, flung ? { velocity: { x: release.x, y: release.y } } : undefined)
        body.to({ scale: 1 }, MOTION.drop)
        body.to({ rotate: 0 }, MOTION.tilt)
        this.contact(s.id, distance, pinning, () => body.to({ lift: 0 }, MOTION.shadow))
        if (pinning) this.frameOf(s.id)?.setAttribute("data-pinning", "wait")
      }
      this.settling(s.el, body)
      this.footDone(landing)
    }
    host.emit({ kind: "drop", id: s.id, rect: { x: landing.x, y: landing.y, w: landing.w, h: landing.h } })
    if (mode === "reduced" && pinning) host.emit({ kind: "pin", id: s.id, on: true })
    host.announce(this.dropWords(s, final, pinning))
  }

  // a pinned widget let go: it springs home with the hand's speed
  private endResist(s: Session, release: { x: number; y: number }) {
    const body = this.motion.body(`f:${s.id}`)
    body.to({ x: 0, y: 0 }, MOTION.resist, { velocity: { x: release.x * 0.3, y: release.y * 0.3 } })
  }

  // A carry set down: the widget mounts at its slot where the ghost was, and
  // lands from there like any drop. Over the strip (or nowhere to go) it
  // stays in the drawer, and the ghost flies back into its tile.
  private endCarry(s: Session, how: Ending, release: { x: number; y: number }) {
    const carry = s.carry!
    const host = this.host
    const g = this.motion.body("ghost")
    const plan = how === "commit" ? s.plan : null
    this.footTo(null)
    if (!plan) {
      this.homeAll(s)
      const home = s.home
      if (home && this.motion.mode !== "reduced") {
        const ghostW = s.fp.w * s.shot.m.pitchX - s.shot.m.gap
        g.to({ x: home.left, y: home.top, scale: clamp(home.width / Math.max(1, ghostW), 0.1, 1), rotate: 0 }, MOTION.stow)
        g.fade(0, 240)
      }
      s.el.removeAttribute("data-lifted")
      carry.end(false)
      host.emit({ kind: "cancel", id: s.id })
      host.announce(`${s.info.name} is back in the drawer.`)
      return
    }
    const mode = this.motion.mode
    const ghost = g.pose()
    const moved = plan.moved
    const previewed = Object.keys(s.targets)
    host.carryIn(s.id, s.size, plan.arrangement, this.movers(moved))
    const after = host.shot()
    const at = after ? find(after.items, s.id) : null
    this.reflow(s.shot, after, plan.landing, 0, s.id)
    for (const id of previewed) this.motion.body(`f:${id}`).to({ x: 0, y: 0 }, MOTION.reflow)
    carry.end(true)
    this.motion.forget("ghost")
    const frame = this.frameOf(s.id)
    if (frame && at && after) {
      const body = this.motion.body(`f:${s.id}`)
      if (mode === "reduced") {
        body.jump({ opacity: 0 })
        body.fade(1, 160)
        this.footDone(at)
      } else {
        const r = rectPx(at, after.m)
        const dx = ghost.x - (s.left + r.left), dy = ghost.y - (s.top - s.scrollY + r.top)
        frame.style.transformOrigin = `${s.grabX.toFixed(1)}px ${s.grabY.toFixed(1)}px`
        body.jump({ x: dx, y: dy, scale: ghost.scale, rotate: ghost.rotate, lift: 1 })
        this.motion.flush()
        body.to({ x: 0, y: 0 }, MOTION.drop, { velocity: { x: release.x, y: release.y } })
        body.to({ scale: 1 }, MOTION.drop)
        body.to({ rotate: 0 }, MOTION.tilt)
        this.contact(s.id, Math.hypot(dx, dy), false, () => body.to({ lift: 0 }, MOTION.shadow))
        this.settling(frame, body)
      }
    }
    host.emit({ kind: "drop", id: s.id, rect: at ? { x: at.x, y: at.y, w: at.w, h: at.h } : null })
    // its grip is next, and it comes into view if it landed past the fold
    focusWidget(s.id)
    showWhenPlaced(s.id)
  }

  // --- words ---

  private name(id: string): string {
    return this.host.widget(id)?.name ?? id
  }

  // who else a plan moves: "Tasks moves", "Tasks and Cat move", "Tasks, Cat and 2 more move"
  private movers(ids: string[]): string {
    if (!ids.length) return ""
    const names = ids.map((id) => this.name(id))
    const list = names.length === 1 ? names[0]
      : names.length === 2 ? `${names[0]} and ${names[1]}`
      : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}`
      : `${names[0]}, ${names[1]} and ${names.length - 2} more`
    return ` ${list} ${names.length === 1 ? "moves" : "move"} to make room.`
  }

  private dropWords(s: Session, plan: Plan, pinned = false): string {
    const name = s.info.name
    const size = s.size !== own(s.shot.a.sizes, s.id) ? ` ${cap(s.info.label(s.size))}, ${plan.landing.w} by ${plan.landing.h}.` : ""
    // the corner handle: what it is now, as a size from the menu says it
    if (s.kind === "resize") return `${size.trim()}${this.movers(this.moved(s, plan))}`
    const tack = pinned ? " It's pinned there." : ""
    return `${name} set down at ${where(plan.landing)}.${tack}${size}${this.movers(this.moved(s, plan))}`
  }

  // who a plan moves, against the desk as it was at pickup: + or − while
  // lifted re-plans from the resized desk, which mustn't hide who made room
  private moved(s: Session, plan: Plan): string[] {
    return movedFrom(s.pickup, plan.items, s.id, plan.landing)
  }

  private pickupWords(s: Session): string {
    return `Picked up ${s.info.name}. Arrow keys move it one space, Home and End to the ends of its row, P pins it, ` +
      "plus and minus change its size, Enter sets it down, Escape puts it back."
  }

  // --- the keyboard ---

  private frameOf(id: string): HTMLElement | null {
    return document.getElementById(PREFIX + id)
  }

  private onClick = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const tack = target?.closest<HTMLElement>("[data-pin]")
    const grip = tack ? null : target?.closest<HTMLElement>("[data-grip]")
    const frame = (tack ?? grip)?.closest<HTMLElement>(".wf")
    if (!frame || this.s || !frame.id.startsWith(PREFIX) || frame.hasAttribute("data-leaving")) return
    const id = frame.id.slice(PREFIX.length)
    if (tack) { this.togglePin(id); return }
    if (grip) this.host.openMenu(id, grip)
  }

  private onKey = (e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : null
    const grip = target?.closest<HTMLElement>("[data-grip]")
    const frame = grip?.closest<HTMLElement>(".wf")
    if (!grip || !frame || e.metaKey || e.ctrlKey || frame.hasAttribute("data-leaving")) return
    const id = frame.id.slice(PREFIX.length)
    const s = this.s
    if (s) {
      if (s.kind === "key" && s.id === id) this.liftedKey(s, e)
      return
    }
    if (this.press) return
    const k = keyFor(e, false)
    const dir = sizeKey(e)
    if (k) {
      e.preventDefault()
      if (this.isPinned(id)) { this.resistKey(id, k); return }
      const next = this.begin(id, "key", null)
      if (next) this.keyMove(next, k, true)
    } else if (e.key === "p" || e.key === "P") {
      e.preventDefault()
      this.togglePin(id)
    } else if (dir && !e.altKey) {
      e.preventDefault()
      const info = this.host.widget(id), shot = this.host.shot()
      const size = shot ? own(shot.a.sizes, id) : undefined
      if (!info || !size) return
      const next = sizeStep(info.sizes, size, dir)
      if (next === size) { this.host.announce(this.sizeLimit(info, dir)); return }
      this.resize(id, next)
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault()
      this.putAway(id)
    }
  }

  private liftedKey(s: Session, e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      this.finish(s, "cancel")
      return
    }
    if (e.key === "Enter" || e.key === " ") {
      // the grip is a button: this press sets it down, it doesn't open the menu
      e.preventDefault()
      if (e.key === " ") this.swallowSpace(s.grip)
      this.finish(s, "commit")
      return
    }
    // set down, then let Tab move on
    if (e.key === "Tab") { this.finish(s, "commit"); return }
    const k = keyFor(e, true)
    if (k) {
      e.preventDefault()
      this.keyMove(s, k, false)
      return
    }
    if (e.key === "p" || e.key === "P") {
      e.preventDefault()
      const pinning = s.pinOnDrop !== true
      s.pinOnDrop = pinning
      this.footTo(s.plan ? s.plan.landing : s.me, pinning, false)
      this.host.announce(pinning ? "It will be pinned where you set it down." : "It won't be pinned.")
      return
    }
    const dir = sizeKey(e)
    if (dir) {
      e.preventDefault()
      this.keySize(s, dir)
    }
  }

  // one step that way: the widget travels a slot and the others make room. It
  // resists at the board's edge and at a pin, rather than sliding somewhere odd
  private keyMove(s: Session, k: KeyMove, first: boolean) {
    const { plan, resist, by } = planKey(s.a, s.id, s.plan, k, s.shot.cols, s.shot.m.visibleRows)
    if (!plan) {
      const lean = own(LEAN, k)
      if (lean && this.motion.mode !== "reduced") this.motion.body(`f:${s.id}`).kick({ x: lean[0] * BUMP_SPEED, y: lean[1] * BUMP_SPEED }, MOTION.resist)
      this.say(s, first, resist === "pin" ? `${s.info.name} can't go past a pinned widget.`
        : resist === "blocked" && by ? `${this.name(by)} is in the way.` : "That's the edge of the desk.")
      return
    }
    this.preview(s, plan)
    this.say(s, first, `${cap(where(plan.landing))}.${this.movers(this.moved(s, plan))}`)
  }

  // a keyboard preview: the widget travels to its landing, the neighbours make room
  private preview(s: Session, plan: Plan) {
    s.plan = plan
    const m = s.shot.m, me = s.me!
    this.footTo(plan.landing, s.pinOnDrop === true)
    this.motion.body(`f:${s.id}`).to({ x: (plan.landing.x - me.x) * m.pitchX, y: (plan.landing.y - me.y) * m.pitchY }, MOTION.footprint)
    this.show(s, plan)
    this.keepInView(s, plan.landing)
  }

  private sizeLimit(info: WidgetInfo, dir: 1 | -1): string {
    if (info.sizes.length < 2) return `${info.name} has one size.`
    return dir > 0 ? "That's its biggest size." : "That's its smallest size."
  }

  // + and − while lifted: the footprint shows the new size and the
  // neighbours make room; set down, the shell morphs to it
  private keySize(s: Session, dir: 1 | -1) {
    const next = sizeStep(s.info.sizes, s.size, dir)
    if (next === s.size) { this.host.announce(this.sizeLimit(s.info, dir)); return }
    const base = s.plan ? s.plan.arrangement : s.a
    const plan = planResize(base, s.id, next, s.shot.cols)
    if (!plan) return
    s.size = next
    const fp = footprint(next, s.shot.cols)
    s.fp = { w: fp.w, h: fp.h }
    // later steps plan from the desk with it grown in place where it was
    // picked up, so the room it takes there is made the way a resize makes it
    const grown = planResize(s.shot.a, s.id, next, s.shot.cols)
    if (grown) s.a = grown.arrangement
    else {
      const sizes: Record<string, SizeId> = {}
      for (const id of Object.keys(s.a.sizes)) sizes[id] = s.a.sizes[id]
      sizes[s.id] = next
      s.a = { order: s.a.order, sizes, at: s.a.at, pins: s.a.pins }
    }
    this.preview(s, plan)
    this.host.announce(`${cap(s.info.label(next))}, ${plan.landing.w} by ${plan.landing.h}.${this.movers(this.moved(s, plan))}`)
  }

  private say(s: Session, first: boolean, text: string) {
    this.host.announce(first ? `${this.pickupWords(s)} ${text}` : text)
  }

  // a keyboard move off the edge of the window brings the page along
  private keepInView(s: Session, r: Rect) {
    const m = s.shot.m
    const px = rectPx(r, m)
    const top = s.top + px.top, bottom = top + px.height
    const scroll = window.scrollY
    const viewTop = scroll + 8, viewBottom = scroll + s.viewH - m.bottom
    let dy = 0
    if (bottom > viewBottom) dy = Math.min(bottom - viewBottom, top - viewTop)
    else if (top < viewTop) dy = top - viewTop
    if (!dy) return
    window.scrollBy({ top: dy, behavior: this.motion.mode === "reduced" ? "auto" : "smooth" })
  }

  // a mouse's click follows its pointerup in the same task; a tap's comes a
  // little later, from the gesture
  private swallowClick(type: string) {
    const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() }
    window.addEventListener("click", swallow, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), type === "mouse" ? 0 : TAP_CLICK_MS)
  }

  // Space activates a button on keyup; after a set-down that must not open the menu
  private swallowSpace(grip: HTMLElement | null) {
    const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() }
    const done = () => {
      window.clearTimeout(timer)
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0)
    }
    window.addEventListener("click", swallow, { capture: true })
    const timer = window.setTimeout(done, 1500)
    grip?.addEventListener("keyup", (e: KeyboardEvent) => { if (e.key === " ") e.preventDefault(); done() }, { once: true })
  }

  private onFocusOut = (e: FocusEvent) => {
    const s = this.s
    if (!s || s.kind !== "key" || this.committing || !(e.target instanceof Node) || !s.el.contains(e.target)) return
    const next = e.relatedTarget instanceof Element ? e.relatedTarget : null
    if (next && s.grip && next === s.grip) return
    // a menu or dialog opening takes the lift with it; anything else sets it down
    this.finish(s, next && next.closest('dialog, [role="menu"], .page-menu') ? "cancel" : "commit")
  }
}
