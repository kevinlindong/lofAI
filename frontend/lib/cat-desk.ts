// The cat on the desk (components/widgets/cat): which widgets sit right
// against its card, how big its picture is in a box, and that picture for
// where a canvas can't go. Pure, so it is tested without a page.
import { type Item } from "./board"
import { ACCENT, COAT, DETAILS, OFF, PET_H, PET_W, RESTING_FRAME, SHADOW_ROW, drawPet } from "./pet-scene"

// Whether another widget rests right against the cat's card: their boxes
// share a whole edge, with no slot of air between them. The cat perks an ear
// when such a neighbour is picked up, and is pleased when one is set down there.
export function besideCat(frames: Item[], id: string, other: string): boolean {
  let cat: Item | undefined, them: Item | undefined
  for (const f of frames) {
    if (f.id === id) cat = f
    else if (f.id === other) them = f
  }
  if (!cat || !them) return false
  const sideBySide = (cat.x + cat.w === them.x || them.x + them.w === cat.x) &&
    cat.y < them.y + them.h && them.y < cat.y + cat.h
  const stacked = (cat.y + cat.h === them.y || them.y + them.h === cat.y) &&
    cat.x < them.x + them.w && them.x < cat.x + cat.w
  return sideBySide || stacked
}

// Where the cat is on its 45×32 art: the loaf and the floor shadow under it
// fill rows 3 to 29 of columns 4 to 43. The art grid is bigger than that
// because some poses reach past the body - a lean or a hand on it spreads
// three columns to the left, a hop and the music notes go up a row, the
// sleeping z's two more, the celebration sparkles two below the shadow - and
// those are what the card's padding is for.
export const CAT_BODY = { left: 4, right: 43, top: 3, bottom: 29 }
// how many cells past the body the furthest pose reaches, up and to the side
// (down is the sparkles alone, which the padding holds without being asked)
export const CAT_REACH = { up: 3, side: 3 }
const BODY_W = CAT_BODY.right - CAT_BODY.left + 1
const BODY_H = CAT_BODY.bottom - CAT_BODY.top + 1

// the dot size for the art in a box, and where to shift the canvas from the
// box's bottom centre so that the body is the thing that is centred and on
// the floor
export interface CatFit { pitch: number; dx: number; dy: number }

// The cat as big as it goes inside a `w`×`h` box with `pad` of card padding
// around it: the body fits the box, and every pose that reaches past the body
// fits the padding, so nothing of it is ever clipped.
export function fitCat(w: number, h: number, pad = 0): CatFit {
  const pitch = Math.max(1, Math.min(
    w / BODY_W,
    h / BODY_H,
    // a lean needs the room left over beside the body plus the padding
    (w + 2 * pad) / (BODY_W + 2 * CAT_REACH.side),
    // standing on the floor, only the padding is spare above it
    (h + pad) / (BODY_H + CAT_REACH.up),
  ))
  return {
    pitch,
    // the art's own middle is a column and a half left of the body's
    dx: (PET_W / 2 - (CAT_BODY.left + CAT_BODY.right + 1) / 2) * pitch,
    // and two rows of it hang below the shadow
    dy: (PET_H - CAT_BODY.bottom - 1) * pitch,
  }
}

// one colour of the picture, cropped to where it has dots: rows of X and .,
// and the cell its first row and column sit at on the 45×32 art
export interface DotLayer { rows: string[]; top: number; left: number }
export interface StillArt { coat: DotLayer; accent: DotLayer | null; shadow: DotLayer | null }

function layer(lit: (i: number) => boolean): DotLayer | null {
  let top = PET_H, bottom = -1, left = PET_W, right = -1
  for (let i = 0; i < PET_W * PET_H; i++) {
    if (!lit(i)) continue
    const r = Math.floor(i / PET_W), c = i % PET_W
    if (r < top) top = r
    if (r > bottom) bottom = r
    if (c < left) left = c
    if (c > right) right = c
  }
  if (bottom < 0) return null
  const rows: string[] = []
  for (let r = top; r <= bottom; r++) {
    let row = ""
    for (let c = left; c <= right; c++) row += lit(r * PET_W + c) ? "X" : "."
    rows.push(row)
  }
  return { rows, top, left }
}

// The resting cat as static dot rows: the coat with its eyes left open, the
// accent (collar and nose) and the floor shadow. Worked out once; drawing
// overwrites the scene's shared buffers, which the live cat fills afresh
// every time it paints.
let still: StillArt | null = null
export function stillArt(): StillArt {
  if (still) return still
  const grid = drawPet(RESTING_FRAME)
  const coat = (i: number) => COAT[i] > 0.5
  still = {
    coat: layer((i) => coat(i) && DETAILS[i] !== OFF && DETAILS[i] !== ACCENT)!,
    accent: layer((i) => coat(i) && DETAILS[i] === ACCENT),
    shadow: layer((i) => Math.floor(i / PET_W) === SHADOW_ROW && grid[i] > OFF),
  }
  return still
}
