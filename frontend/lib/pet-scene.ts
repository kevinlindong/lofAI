// the desk companion: a cat sitting in a loaf, drawn as metaballs on a dot
// matrix.
//
// a loaf is the pose to draw at this size. a standing cat needs legs, a chest,
// a neck and a back, and at forty dots across every one of those is two dots
// wide and reads as a smudge. a loaf is one wide rounded mound with a head on
// top of it, ears, a face, two front paws tucked under the front and a tail
// laid round the side - six things, all of them big, none of them ambiguous.
// it is also the pose that squashes best: a loaf pressed down on a beat is
// still a loaf, where a sitting cat pressed down is a puddle.
//
// it is built out of blobs rather than out of pixel spans because everything
// here has to move. a span table can blink and it can shift a rank; it cannot
// settle on a downbeat, lean towards a cursor, or lay a tail that flows. a
// field of metaballs supports all three - the parts merge where they
// overlap, so the head does not sit on the body so much as rise out of it,
// which is exactly what a loaf looks like.
//
// coordinates are dots, y down, and the pose is measured up from the surface
// the loaf is sitting on, so a hop or a squash moves everything that should
// move and nothing that should not. the numbers were tuned by looking at the
// output; if you change one, look again rather than reasoning about it.

import { BlobSet, limb, shadeSolid, smoothstep, surfaceDistance } from "./dot-field"

export const PET_W = 45
export const PET_H = 32

// the surface the loaf is sitting on. the field is cut off flat along it, so
// the bottom of the loaf is a straight line rather than the bottom of a
// circle - a cat in a loaf has no daylight under it, and the flat base is half
// of what makes the pose read.
const GROUND = 28
const MID = 22
// the floor shadow's row, just under the ground. it never moves - a hop lifts
// the cat off it - so it is the line the cat stands on (components/widgets/cat)
export const SHADOW_ROW = Math.round(GROUND) + 1

// the head sits well forward of the middle of the body, and the body reaches
// away behind it to a haunch and a tail.
//
// drawn symmetrically the loaf has no front and no back: it is a mound with a
// face on it, and a mound with a face on it reads as a mound. the same
// silhouette with the head over one end has an axis, and an axis is most of
// what tells you which animal you are looking at - it is the difference
// between a shape and a creature facing left.
const HEAD_X = MID - 6
const BODY_X = MID - 0.5
// squash and stretch pivot on the middle of the loaf rather than on the
// ground. pivoting on the ground sounds right and is not: the ear tips are
// nineteen dots up, so a one-tenth squash moves them two dots and the belly a
// tenth of one.
const PIVOT = 5.0

// palette ramp, least to most lit, resolved to --dot-0..6 at paint time. the
// two themes invert lightness but not this order, so HOT is the strongest mark
// in both and OFF is always the unlit panel.
export const OFF = 0
export const FAINT = 1
export const DIM = 2
export const MID_SHADE = 3
export const LIT = 4
export const HOT = 5
export const ACCENT = 6

// What the cat is doing, expressed through its pose and face.
export type PetMood = "idle" | "bop" | "focus" | "purr" | "happy" | "cheer" | "sleep"

export interface PetFrame {
  mood: PetMood
  // eyes shut this frame
  blink: boolean
  // 0..1, how hard the music is hitting right now
  bob: number
  // 0..1, how far the music is above its own running level right now: the
  // beat as a beat, rather than as loudness. `bob` rides a pedestal - its
  // release is slower than the gap between kicks, so it never returns to
  // zero in a busy mix - and anything meant to LAND on the rhythm needs the
  // pedestal subtracted, or the gesture shrinks to whatever sliver of range
  // the mix leaves over.
  pulse: number
  // 0..1, celebration hop - lifts the whole loaf off the ground
  hop: number
  // 0..1, ear flick when something lands. continuous, not a switch: an ear
  // that snaps between two positions three times reads as a fault in the
  // panel rather than as a twitch.
  twitch: number
  // 0..1, a hand on the cat. it presses the loaf down and flattens the ears,
  // which is what a cat does when you pat it - a hop would be what a cat does
  // when you drop something.
  pat: number
  // continuously rising phase in seconds, for the head rock, breath and floaters
  phase: number
  // the tail's own phase, in radians, integrated by the caller. the tail
  // swings faster the louder the music, and a swing speed that changes per
  // frame only stays continuous if the phase it feeds accumulates -
  // multiplying the running clock by this frame's tempo rewinds or fast-
  // forwards the sine by whole turns every time the tempo moves, and the tail
  // teleports. see the tail note in poseBody.
  swing: number
  // the breath, likewise integrated by the caller: sleep breathes slower, and
  // switching the rate on a raw clock would pop the ribs to a random point in
  // the cycle at the moment of dozing off
  breathe: number
  // the music is playing: notes, a busier tail, a head that keeps time
  notes: boolean
  // 0..1, how far into the music the cat is. `notes` is the switch, this is
  // the ramp behind it: the head's rock and nod ride it, so the cat eases
  // into keeping time instead of snapping to it on the first note.
  groove: number
  // 0..1, celebration sparkles fading out
  sparkle: number
  // where the cat is looking, -1..1 across its field of view. this is the
  // cursor, most of the time, and it leans as well as looks.
  gazeX: number
  gazeY: number
  // 0..1, the cursor is on the cat and it has noticed
  affection: number
}

export const IDLE_FRAME: PetFrame = {
  mood: "idle",
  blink: false,
  bob: 0,
  pulse: 0,
  hop: 0,
  twitch: 0,
  pat: 0,
  phase: 0,
  swing: 0,
  breathe: 0,
  notes: false,
  groove: 0,
  sparkle: 0,
  gazeX: 0,
  gazeY: 0,
  affection: 0,
}

// the cat at rest: the one frame there is with reduced motion, and the pose
// its picture takes where there's no canvas (lib/cat-desk)
export const RESTING_FRAME: PetFrame = { ...IDLE_FRAME, phase: 1, swing: 0.6, breathe: 1 }

type Grid = Uint8Array

// The coat is a continuous body underneath the markings. Keeping these
// layers separate avoids cracks wherever two palette shades meet.
export const COAT = new Float32Array(PET_W * PET_H)
export const RIM = new Float32Array(PET_W * PET_H)
export const HEAD_SHADOW = new Float32Array(PET_W * PET_H)
export const DETAILS = new Uint8Array(PET_W * PET_H)
export const DETAIL_X = new Float32Array(PET_W * PET_H)
export const DETAIL_Y = new Float32Array(PET_W * PET_H)
let markX = 0
let markY = 0

const mark = (g: Grid, r: number, c: number, v: number) => {
  const i = r * PET_W + c
  g[i] = v
  DETAILS[i] = v
  DETAIL_X[i] = markX
  DETAIL_Y[i] = markY
}

const at = (g: Grid, r: number, c: number, v: number) => {
  if (r >= 0 && r < PET_H && c >= 0 && c < PET_W) mark(g, r, c, v)
}

// paint only where the cat already is, for a marking that follows the body it
// is on rather than hanging in the air beside it
const over = (g: Grid, r: number, c: number, v: number) => {
  if (r >= 0 && r < PET_H && c >= 0 && c < PET_W && g[r * PET_W + c] !== OFF) {
    mark(g, r, c, v)
  }
}

// paint only on the fur inside the outline. a marking placed by measurement -
// an eye socket, the inner ear, the blush - lands on the rim as soon as the
// part it belongs to swings, and a rim dot replaced by a marking is a notch
// bitten out of the silhouette. the eyes in particular are drawn deliberately
// large for their head, so without this they would eat the sides of it.
const onFur = (g: Grid, r: number, c: number, v: number) => {
  if (r >= 0 && r < PET_H && c >= 0 && c < PET_W && g[r * PET_W + c] === LIT) {
    mark(g, r, c, v)
  }
}

const row = (g: Grid, r: number, c0: number, c1: number, v: number) => {
  for (let c = c0; c <= c1; c++) at(g, r, c, v)
}

const overRow = (g: Grid, r: number, c0: number, c1: number, v: number) => {
  for (let c = c0; c <= c1; c++) over(g, r, c, v)
}

const furRow = (g: Grid, r: number, c0: number, c1: number, v: number) => {
  for (let c = c0; c <= c1; c++) onFur(g, r, c, v)
}

const furBox = (g: Grid, r0: number, c0: number, r1: number, c1: number, v: number) => {
  for (let r = r0; r <= r1; r++) furRow(g, r, c0, c1, v)
}

// an eighth note, 3 wide and 4 tall, anchored at its top-left
const note = (g: Grid, r: number, c: number, v: number) => {
  at(g, r, c + 1, v)
  at(g, r, c + 2, v)
  at(g, r + 1, c + 1, v)
  at(g, r + 2, c + 1, v)
  at(g, r + 3, c, v)
  at(g, r + 3, c + 1, v)
}

const heart = (g: Grid, r: number, c: number, v: number) => {
  at(g, r, c - 1, v)
  at(g, r, c + 1, v)
  row(g, r + 1, c - 2, c + 2, v)
  row(g, r + 2, c - 1, c + 1, v)
  at(g, r + 3, c, v)
}

const zed = (g: Grid, r: number, c: number, v: number) => {
  row(g, r, c, c + 2, v)
  at(g, r + 1, c + 1, v)
  row(g, r + 2, c, c + 2, v)
}

const star = (g: Grid, r: number, c: number, v: number) => {
  at(g, r, c, v)
  at(g, r - 1, c, v)
  at(g, r + 1, c, v)
  at(g, r, c - 1, v)
  at(g, r, c + 1, v)
}

const SPARKLE_SPOTS: Array<[number, number]> = [
  [5, 4],
  [2, 10],
  [4, 26],
  [8, 34],
  [1, 17],
]

// hearts in flight: when each was born and which column it climbs. they used
// to be gated frame by frame on the affection level, which snuffed a heart
// mid-air the instant the cooling level dropped under its height - and the
// sawtooth respawned it at the bottom a moment later, so a cursor leaving
// the cat strobed hearts instead of letting them drift off. a heart now
// spawns only while the affection is warm, and once born it always finishes
// its flight, dimming as it climbs. the column is fixed at birth so a heart
// rises straight while the head sways under it.
interface HeartFlight {
  born: number
  col: number
  row: number
}
const HEARTS: HeartFlight[] = []
const HEART_FLIGHT_S = 1.3
const HEART_GAP_S = 0.55
let lastHeartBorn = -1
let heartSide = 0

// one grid and one field, re-struck every frame. the caller paints from the
// grid immediately and never keeps it, so handing out the same buffers saves
// two allocations a frame - a small thing thirty times a second is not a small
// thing.
const SCRATCH: Grid = new Uint8Array(PET_W * PET_H)
const FIELD = new Float32Array(PET_W * PET_H)
const BLOBS = new BlobSet()

// Coverage for crisp face details and floating notes, separate from the coat.
export const INK = new Float32Array(PET_W * PET_H)
// the head on its own, kept apart from the rest so its outline can be struck
// back over the body it is sunk into
const HEAD_BLOBS = new BlobSet()
const HEAD_FIELD = new Float32Array(PET_W * PET_H)

// where the parts ended up this frame, so the markings can be struck onto them
let headX = HEAD_X
let headY = 14
let headR = 4.7
let faceWide = 1
let baseRow = Math.round(GROUND)
let floorY = GROUND
let tailFlick = 0

export function drawPet(f: PetFrame): Grid {
  const g = SCRATCH
  DETAILS.fill(255)
  markX = markY = 0

  poseBody(f)
  BLOBS.scatter(FIELD, PET_W, PET_H)
  HEAD_BLOBS.scatter(HEAD_FIELD, PET_W, PET_H)

  // a solid cat with one dot of rim all round it and a breath of glow outside.
  // the rim is what keeps the silhouette legible at this pitch: a metaball
  // shaded by field value alone is a fog, and a fog is not an animal.
  shadeSolid(FIELD, g, PET_W, PET_H, {
    fill: LIT,
    rim: HOT,
    halo: FAINT,
    haloAt: 0.4,
  })

  // Distance-based coverage keeps the edge soft by one cell regardless of
  // blob size. Intersect with a continuous floor so a hop never drops an
  // entire row of belly at once.
  for (let i = 0; i < FIELD.length; i++) {
    const ground = floorY + 0.35 - Math.floor(i / PET_W)
    const d = Math.min(ground, surfaceDistance(FIELD, i, PET_W))
    const headD = surfaceDistance(HEAD_FIELD, i, PET_W)
    COAT[i] = smoothstep(-0.65, 0.8, d)
    const edge = smoothstep(-0.6, 0.2, d) * (1 - smoothstep(0.2, 1.15, d))
    const headEdge = smoothstep(-0.4, 0.3, headD) * (1 - smoothstep(0.3, 1.1, headD))
    RIM[i] = Math.max(edge, headEdge * smoothstep(0, 0.8, d) * 0.7)
    HEAD_SHADOW[i] = smoothstep(-1.3, -0.5, headD) *
      (1 - smoothstep(-0.5, 0.2, headD)) * smoothstep(0.5, 1.5, d)
    if (ground < 0) g[i] = OFF
  }

  drawShadow(g, f)
  markY = floorY - baseRow
  drawMarkings(g)
  markX = headX - Math.round(headX)
  markY = headY - Math.round(headY)
  drawFace(g, f)
  markX = markY = 0
  drawFloaters(g, f)
  for (let i = 0; i < INK.length; i++) {
    // Eye sockets are opaque cutouts in the coat. Other details keep a
    // little air between dots so small expressions remain legible.
    INK[i] = DETAILS[i] === 255 ? 0 : DETAILS[i] === OFF ? 1 : 0.65
  }

  return g
}

// ---------------------------------------------------------------------------
// the pose: every blob the loaf is made of, placed for this frame
// ---------------------------------------------------------------------------
function poseBody(f: PetFrame) {
  BLOBS.reset()
  HEAD_BLOBS.reset()

  // squash and stretch. a hop pulls the loaf in and up; a hand presses it
  // down and out. blobs are round, so the widening has to come from where they
  // sit rather than from scaling any one of them - spreading a row of them
  // sideways widens a silhouette in a way a single circle cannot.
  //
  // the beat is deliberately not in here. it was, for a while, and a body
  // that squashes twice a second is a cat on a trampoline: the whole
  // silhouette churned and the thing read as bouncing rather than listening.
  // the music now moves the head and the tail and nothing else - the loaf
  // sits still, which is what a loafed cat does, and the stillness is what
  // makes the parts that do move read.
  //
  // only the squash shortens the cat. letting a hop lengthen it as well is
  // correct animation and wrong here: it stacks with the lift and puts the ear
  // tips through the top of the panel.
  const springy = f.hop * 0.9 - f.pat * 0.6
  const spread = f.hop * 0.9 - f.pat * 0.6
  const wide = 1 - spread * (spread > 0 ? 0.18 : 0.34)
  const tall = 1 + (springy < 0 ? springy * 0.17 : 0)
  const rScale = 1 + springy * 0.05
  // Markings carry the fractional translation of their body part when
  // painted, so the pose can move freely without leaving the face behind.
  const lift = f.hop * 2.4 - f.pat * 0.7
  // the breath deepens a touch when the music is on - ribs working under a
  // still coat is most of what keeps a motionless body from reading as a
  // statue of itself
  const breath = Math.sin(f.breathe) * (0.2 + f.groove * 0.12)
  // the tail rides its own accumulated phase. it used to ride the clock times
  // a beat-dependent rate, and the clock is minutes long: every flicker of the
  // beat envelope spun the sine by whole turns and the tail teleported. the
  // caller integrates the rate instead, so however hard the rate moves, the
  // phase only ever advances - the swish speeds up and slows down without a
  // single discontinuity.
  //
  // two waves off the same phase, one at half speed: a single sine is a
  // metronome, and a cat's tail is not. the slow wave wanders the curl's
  // resting height while the fast one swishes about it, and because both are
  // scalings of one accumulated phase they stay as continuous as it is.
  tailFlick =
    Math.sin(f.swing) * (0.8 + f.bob * 1.3) + Math.sin(f.swing * 0.53 + 1.1) * 0.5

  faceWide = wide
  const floor = GROUND - lift
  floorY = floor
  baseRow = Math.round(floor)
  const up = (d: number) => floor - (PIVOT + (d - PIVOT) * tall)
  const out = (d: number) => BODY_X + d * wide

  // the lean. this is most of what makes the cat feel like it is watching you:
  // pupils sliding about inside a head that never moves read as a glitch, a
  // whole head carried two dots towards the cursor reads as attention.
  const lean = f.gazeX * 2.0
  const nod = f.gazeY * 1.1
  // keeping time. the head rocks side to side and dips on the kick, and that
  // is the whole of the cat's dancing - the body under it holds nearly still,
  // and the stillness is what lets a one-dot nod read from across the room.
  //
  // ridden on `groove` rather than switched on `notes`: the ramp carries the
  // rock in over a second or so, which is a cat picking the rhythm up, where
  // the switch was a head teleporting a dot sideways on the first note. the
  // beat leans on the amplitude only gently - the rock is the tempo of the
  // whole animal and should barely notice one loud bar.
  //
  // and the rock is shorter to the right than to the left. the mound is on
  // the head's right, so a full swing that way buries the cheek in the
  // shoulder - a head that reaches into the open air and comes back reads as
  // swaying; one that reaches into its own body reads as burrowing.
  const rock = Math.sin(f.phase * 2.4)
  const sway = rock * (rock > 0 ? 0.7 : 1.0) * (1.2 + f.bob * 0.6) * f.groove
  // the nod: each kick presses the head down and the release lets it back
  // up - this is the part of the dance that is actually on the music's
  // rhythm, where the side-to-side rock is the cat's own slower tempo. it
  // rides `pulse`, not `bob`: bob never returns to zero between kicks in a
  // busy mix, and a nod driven by it sat pressed instead of nodding. the
  // pulse is the beat with the mix subtracted: a full dip on every real
  // kick, back up between.
  const dip = f.pulse * f.groove * 1.7
  // the rest of the fluid motion, all of it slow and all of it continuous:
  // the loaf leans a fraction of a dot with the music on a lazier period
  // than the head, and the ears trail the head's rock like they have a
  // little mass of their own. nothing here is driven by the beat envelope,
  // so nothing here can tremble with it - the fluidity is layered fixed-rate
  // waves, not louder reactions.
  const drift = Math.sin(f.phase * 1.2) * 0.5 * f.groove
  const earTrail = Math.sin(f.phase * 2.4 - 0.7) * 0.55 * f.groove

  // ---- the tail. only the last third of it: the rest is behind the loaf,
  // which is where a cat sitting like this keeps it. it sweeps out along the
  // ground past the flank and then curls up, and the curl is the part that
  // moves - faster and further the louder the music. the curl stands a clear
  // column of unlit panel off the flank: metaballs fuse across small gaps,
  // and a tail fused to the rump is not a tail, it is a wide cat.
  limb(
    BLOBS,
    out(12.4) + drift,
    up(1.5),
    out(22.0),
    up(1.0),
    out(20.3),
    up(8.8 + tailFlick),
    2.2 * rScale,
    0.85,
    8,
  )

  // ---- the loaf and the head, which are one mass.
  //
  // three goes at this drew a head sitting on a body, with a carve at the join
  // to keep the two apart, and every one of them came out a pyramid with ears
  // or a cat behind a box. a cat in a loaf has no neck and no shoulders to
  // speak of: it is a single rounded trapezoid, narrower where the face is and
  // wider where it meets the ground, and the only thing that says which part
  // is the head is the face drawn on it. so the ranks below run continuously
  // from skull to base, and the one job of the geometry is that the widening
  // happens over two rows rather than over eight - a slope that gradual is a
  // tent, and a tent is not an animal.
  const sag = lean * 0.25
  headR = 5.0 * rScale
  // The shoulder limits the inward turn; pupils carry the rest of the look.
  headX = Math.min(HEAD_X + 1.35, HEAD_X + lean + sway)
  // the beat lands here, and only here: the body is still, so the head
  // keeping time has to carry the beat itself. it is small on purpose - a
  // small dip on a strong kick, back up between kicks - because a head
  // that ploughs into the chest is a cat being pressed, not a cat nodding.
  headY = up(15.2) + nod + dip
  const skull = 2.2 * wide + (f.mood === "happy" || f.mood === "cheer" ? 0.4 : 0)
  head(headX - skull, headY, headR)
  head(headX, headY, headR * 1.02)
  head(headX + skull, headY, headR)
  // jowls: a lower, wider pair. a cat's head is broadest at the cheek, and
  // these are also what the body's shoulders come up to meet.
  const jowl = 4.0 * wide
  head(headX - jowl, headY + 2.5, 4.0 * rScale)
  head(headX + jowl, headY + 2.5, 4.0 * rScale)

  // the body: three ranks, each a shade wider than the one above it, the top
  // one set high enough to catch the jowls so there is no waist between them
  // the back, walked front to rear: low at the shoulder where the head sits on
  // it, rising to the haunch, dropping away again at the tail end. a level
  // back is a bench; this one is the line that says which end the cat keeps
  // its legs under.
  //
  // the mound is deliberately big. the head is drawn large so the face can
  // carry the expression, and on a low, narrow loaf it read as a mascot
  // head on a beanbag - the body needs real mass under it before the two
  // look like one animal.
  const back: Array<[number, number]> = [
    [-12.0, 8.6],
    [-8.0, 9.9],
    [-4.0, 10.6],
    [0.0, 10.9],
    [4.0, 10.9],
    [8.5, 10.4],
    [13.0, 9.2],
  ]
  for (const [d, h] of back) BLOBS.add(out(d) + sag + drift, up(h), (3.8 + breath) * rScale)
  // flanks and base stay square to the ground: a cat settled like this is
  // level underneath whatever its back is doing
  for (const d of [-13.0, -8.7, -4.3, 0, 4.3, 8.7, 13.0]) {
    BLOBS.add(out(d) + sag + drift, up(5.0), 3.9 * rScale)
  }
  for (const d of [-12.8, -8.6, -4.3, 0, 4.3, 8.6, 12.8]) {
    BLOBS.add(out(d) + sag + drift, up(1.0), 3.9 * rScale)
  }

  // ---- ears. how far they are pricked is more of the cat's mood at a glance
  // than the face is: up when pleased, folded out flat when asleep, and one of
  // them flicking whenever something happens.
  const mooded =
    f.mood === "cheer"
      ? 1
      : f.mood === "happy" || f.mood === "purr"
        ? 0.7
        : f.mood === "sleep"
          ? -1
          : f.mood === "focus"
            ? 0.5
            : f.affection * 0.5
  // a hand on the head folds them back whatever the mood says
  const perk = mooded - f.pat * 1.0
  ear(-1, perk, skull, wide, tall, rScale, f.twitch * 0.5, earTrail)
  ear(1, perk, skull, wide, tall, rScale, f.twitch, earTrail)
}

// a part of the head: into the whole cat, and again into the head on its own
const head = (x: number, y: number, r: number) => {
  BLOBS.add(x, y, r)
  HEAD_BLOBS.add(x, y, r)
}

// one ear, grown out of the skull as a tapering chain. side is -1 or 1.
// `trail` drags both tips the same way in panel space, a beat behind the
// head's rock - ears with a little inertia of their own are the difference
// between a swaying cat and a swaying cardboard cutout.
function ear(
  side: number,
  perk: number,
  skullHalf: number,
  wide: number,
  tall: number,
  rScale: number,
  flick: number,
  trail = 0,
) {
  // drooping swings the tip out and down; perking stands it up and draws it in
  // the tips splay out to about the width of the skull whatever the mood is
  // doing to them. pulled in much further than that they leave a step at the
  // crown, and the head reads as a dome with two small horns on it.
  const spread = 3.2 - perk * 0.5 + flick * 0.9
  // a touch shorter than they were: the head now rides a taller mound, and
  // the old height put the tips through the top of the panel on a full hop.
  // shorter ears also read younger, which suits the thing.
  const height = (6.4 + perk * 0.8 - flick * 1.4) * tall
  const baseX = headX + side * (skullHalf + headR * 0.48)
  const baseY = headY - headR * 0.55
  // into both sets: the ears are part of the head, and an outline taken from a
  // head without them would draw a line straight across their base
  for (const set of [BLOBS, HEAD_BLOBS]) {
    limb(
      set,
      baseX,
      baseY,
      // the control point bows the outer edge, which is the difference between
      // a cat's ear and a traffic cone
      baseX + side * spread * 0.3 + trail * 0.5,
      baseY - height * 0.6,
      baseX + side * spread * wide + trail,
      baseY - height,
      2.7 * rScale,
      0.55,
      5,
    )
  }
}

// the ground the loaf is sitting on, drawn as a shadow rather than as a line.
// it is here for the hop: without something staying put underneath, a cat that
// lifts two dots reads as a cat that has been nudged rather than as a cat that
// has jumped.
function drawShadow(g: Grid, f: PetFrame) {
  const r = SHADOW_ROW
  const half = Math.round(17 - f.hop * 6)
  const mid = Math.round(BODY_X)
  for (let c = mid - half; c <= mid + half; c++) {
    // thinned at the ends, so it reads as a pool rather than as a plank
    at(g, r, c, Math.abs(c - mid) > half - 2 ? FAINT : DIM)
  }
}

// ---------------------------------------------------------------------------
// markings struck onto the silhouette once it is shaded
// ---------------------------------------------------------------------------
function drawMarkings(g: Grid) {
  // inner ears, a shade back from the fur round them. `onFur` keeps them on
  // the ear even as it swings, and off the outline, which is the whole reason
  // they are struck late.
  for (const side of [-1, 1]) {
    const earX = headX + side * 4.8 * faceWide
    const earY = headY - headR * 0.5 - 3.2
    const ec = Math.round(earX)
    const er = Math.round(earY)
    markX = earX - ec
    markY = earY - er
    onFur(g, er, ec, MID_SHADE)
    onFur(g, er + 1, ec, MID_SHADE)
  }

  // the collar, sitting on the chest a clear rank below the jaw. it used to be
  // laid right along the jawline, where it was doing the separating; now that
  // the head carries its own outline the collar is free to be what it is, and
  // two bands stacked on the same three rows only read as one thick one.
  //
  // anchored to the body for its seat - a collar that slid around the chest
  // with every sway read as loose skin - but it yields downward under the
  // chin: the nod presses the head into the chest, and a band that stayed
  // put had the chin poking out underneath it on every strong kick. the max
  // is the deeper of its body seat and one rank clear of the jaw, so the
  // head can never pass through it, only push it.
  const chestX = Math.round(HEAD_X)
  const collarY = Math.max(floorY - 6, headY + 9)
  const collar = Math.round(collarY)
  markX = 0
  markY = collarY - collar
  overRow(g, collar, chestX - 6, chestX + 6, ACCENT)
  onFur(g, collar + 1, chestX, HOT)
  markY = floorY - baseRow

  // ---- the two front paws, tucked under the front of the loaf. they are the
  // detail that says loaf rather than lump: a cat sitting like this has its
  // paws folded away with just the toes out in front.
  // one clear of the base line: that bottom row is all rim, and a pale paw
  // struck onto the rim is a paw you cannot see. on the body's anchor for the
  // same reason as the collar: paws do not follow a nodding head.
  const pr = baseRow - 2
  const pawX = chestX + 1
  for (const side of [-1, 1]) {
    const near = pawX + side * 2
    const far = pawX + side * 6
    furRow(g, pr, Math.min(near, far), Math.max(near, far), HOT)
    furRow(g, pr + 1, Math.min(near, far), Math.max(near, far), HOT)
    // one toe split each. two would be truer and at four dots across it comes
    // out as a comb. struck with `at` rather than `onFur`, because by now the
    // paw it is splitting is no longer fur.
    at(g, pr, pawX + side * 4, MID_SHADE)
    at(g, pr + 1, pawX + side * 4, MID_SHADE)
  }

  // ---- the haunch: the curve of the hind leg folded up under the rear. it is
  // one line and it does more for the read than anything else on the body -
  // without it the back half is a featureless slab, and a cat is an animal
  // whose back half you can see the mechanics of even when it is asleep.
  const hx = Math.round(BODY_X) + 13
  const hy = baseRow + 1
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * (Math.PI / 2)
    onFur(g, Math.round(hy - Math.sin(a) * 8.8), Math.round(hx - Math.cos(a) * 10), MID_SHADE)
  }

  // the chest bib that used to run from the collar down to the paws is gone.
  // with the jaw line, its shadow, the collar and the paws all stacked on the
  // same six rows of chest there was no room left for it to be a marking - it
  // was two pale dots in a crowd, which is noise.
}

function drawFace(g: Grid, f: PetFrame) {
  const beaming = f.mood === "happy" || f.mood === "cheer" || f.mood === "purr"
  const hc = Math.round(headX)
  const hr = Math.round(headY)

  // how far the lids have come down. the eyes are the loudest thing on the
  // panel, so most of the difference between one mood and the next is here.
  // bopping keeps them all the way open: half-lidded eyes at four dots tall
  // read as a glower, and a cat enjoying the music should look delighted to
  // be here, not sceptical of it.
  const lid = f.mood === "focus" ? 2 : 0

  for (const side of [-1, 1]) {
    // the socket runs from three to six dots out. four across is the width
    // that still reads as an eye: at five the pupil has to grow with it and
    // the pair come out as two lit windows.
    const inner = hc + side * 3
    const outer = hc + side * 6
    const lo = Math.min(inner, outer)
    const hi = Math.max(inner, outer)
    const bottom = hr
    const top = hr - 3 + lid

    if (f.blink || f.mood === "sleep") {
      // shut: a struck line with a tick turned down at the outer end, which is
      // a cat asleep rather than a cat with its eyes merely switched off
      furRow(g, bottom - 1, lo, hi, OFF)
      onFur(g, bottom, outer, OFF)
    } else if (beaming) {
      // the delighted arc. two dots along the top and one dropped at each end
      // is the most a four-wide socket can say, and it says it clearly - a
      // single diagonal in the same space reads as a scowl.
      onFur(g, bottom, inner, OFF)
      onFur(g, bottom - 1, inner + side, OFF)
      onFur(g, bottom - 1, outer - side, OFF)
      onFur(g, bottom, outer, OFF)
    } else {
      // open. the socket is a hole cut clean out of the fur and the pupil is
      // the brightest mark on the panel, so the gaze reads the same on a black
      // LED panel and on warm paper - whichever way the theme runs, the thing
      // that moves is the thing you look at.
      furBox(g, top, lo, bottom, hi, OFF)
      // a two-by-two pupil floating in the middle of the socket, not a bar
      // filling it: the clear dark ring around the pupil is what makes the
      // eye look big and round, and big round eyes are most of what cute
      // means at this scale. it has a dot of travel each way - enough to
      // read as a look when the head is already leaning that way, and never
      // enough to fall out of the eye.
      const px = Math.round(f.gazeX * 1.1)
      const py = Math.max(-1, Math.min(bottom - top - 2, Math.round(f.gazeY * 0.9)))
      // narrowed lids leave a two-row socket, and the pupil fills it; open
      // eyes centre the pupil with a clear ring around it
      const pTop = lid < 2 ? top + 1 + py : top
      row(g, pTop, lo + 1 + px, lo + 2 + px, HOT)
      row(g, pTop + 1, lo + 1 + px, lo + 2 + px, HOT)
      // the catchlight, one dot diagonally off the pupil's upper inner
      // corner. inner on both sides, so the two eyes wear matching sparkles
      // toward the nose - the pair is what reads as glossy rather than as a
      // stray lit dot.
      if (lid < 2 && pTop - 1 >= top) {
        at(g, pTop - 1, side === -1 ? Math.min(hi, lo + 3 + px) : Math.max(lo, lo + px), HOT)
      }
    }
  }

  // ---- muzzle: a pale patch with the nose at the top of it. one dot of
  // colour on an otherwise monochrome face is worth more than any amount of
  // extra shading, and it is the dot that says which way the cat is facing.
  const my = hr + 1
  furRow(g, my, hc - 1, hc + 1, HOT)
  furRow(g, my + 1, hc - 2, hc + 2, HOT)
  at(g, my, hc, ACCENT)
  // the mouth, a small w under the nose
  at(g, my + 1, hc - 1, OFF)
  at(g, my + 1, hc + 1, OFF)
  at(g, my + 2, hc, OFF)

  // whiskers, struck onto the cheek. a loaf is as wide at the jaw as it is
  // anywhere, so there is no clear panel beside the muzzle to hang them in -
  // dashes floating out level with the widest part of the body read as fins.
  // two ranks below the fur, on the cheek where they grow, they read.
  for (const side of [-1, 1]) {
    const far = hc + side * 7
    const near = hc + side * 5
    furRow(g, my, Math.min(far, near), Math.max(far, near), DIM)
    furRow(g, my + 2, Math.min(far, near), Math.max(far, near), DIM)
  }

  // the flush of being noticed, warm on the cheeks under the eyes - and worn
  // whenever the music is playing too, which is what makes the bop read as a
  // cat enjoying itself rather than merely metronoming
  if (f.affection > 0.4 || beaming || f.mood === "bop") {
    for (const side of [-1, 1]) {
      onFur(g, hr, hc + side * 6, MID_SHADE)
      onFur(g, hr, hc + side * 7, MID_SHADE)
      onFur(g, hr + 1, hc + side * 6, MID_SHADE)
    }
  }
}

// ---- what the cat is feeling, floating in the space around it ----
function drawFloaters(g: Grid, f: PetFrame) {
  const hr = Math.round(headY)
  const hc = Math.round(headX)

  if (f.sparkle > 0) {
    const shown = Math.ceil(f.sparkle * SPARKLE_SPOTS.length)
    for (let i = 0; i < shown; i++) {
      const [r, c] = SPARKLE_SPOTS[i]
      // the twinkle is a change of brightness, not of existence: a star that
      // blinks off and on again reads as a fault in the panel, where one that
      // breathes between bright and dim reads as glitter
      star(g, r, c, Math.sin(f.phase * 6 + i * 1.9) > -0.2 ? HOT : DIM)
    }
  }

  if (f.notes && f.mood !== "sleep") {
    // launched from beside the resting head, then owned by the air: a floater
    // that keeps referring back to a nodding, swaying head gets carried a dot
    // sideways or down every time the head moves, and every floater on the
    // panel twitching in step with the nod reads as the panel glitching, not
    // as the cat enjoying itself.
    for (let i = 0; i < 2; i++) {
      const rise = (f.phase * 0.7 + i * 0.5) % 1
      const r = Math.round(8 - rise * 7)
      const c = HEAD_X + 10 + i * 4 + Math.round(Math.sin(rise * 4 + i) * 1.5)
      // three shades on the way up, so a note dissolves rather than snapping
      // from lit to gone at the top of its climb
      note(g, r, c, rise > 0.88 ? FAINT : rise > 0.68 ? DIM : LIT)
    }
  }

  // hearts: spawn while the affection is warm, then always finish the flight
  for (let i = HEARTS.length - 1; i >= 0; i--) {
    if (f.phase - HEARTS[i].born > HEART_FLIGHT_S) HEARTS.splice(i, 1)
  }
  if (f.affection > 0.5 && HEARTS.length < 2 && f.phase - lastHeartBorn > HEART_GAP_S) {
    HEARTS.push({
      born: f.phase,
      // two fixed lanes beside the resting head, far enough apart that two
      // hearts in flight never share a dot - overlapping flights repainting
      // each other's pixels was its own small flicker
      col: HEAD_X - (heartSide++ % 2 === 0 ? 13 : 8),
      row: hr - 6,
    })
    lastHeartBorn = f.phase
  }
  for (const h of HEARTS) {
    const rise = (f.phase - h.born) / HEART_FLIGHT_S
    heart(
      g,
      Math.round(h.row - rise * 6),
      h.col,
      rise > 0.8 ? FAINT : rise > 0.55 ? DIM : ACCENT,
    )
  }

  if (f.mood === "sleep") {
    for (let i = 0; i < 3; i++) {
      const t = (f.phase * 0.5 + i * 0.33) % 1
      zed(g, Math.round(hr - 6 - t * 4) - i * 2, hc + 9 + i * 3, t > 0.75 ? DIM : LIT)
    }
  }
}
