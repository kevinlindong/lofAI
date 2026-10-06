// The cat on the desk (lib/cat-desk.ts): which widgets rest right against its
// card, how big its picture is in a box, and that picture.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const cache = new Map()
function load(name) {
  if (cache.has(name)) return cache.get(name)
  const source = readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (id) => load(id.replace(/^\.\//, "")) })
  cache.set(name, module.exports)
  return module.exports
}

const { CAT_BODY, CAT_REACH, besideCat, fitCat, stillArt } = load("cat-desk")
const board = load("board")
const scene = load("pet-scene")
const { PET_W, PET_H, SHADOW_ROW } = scene

// the box the art has dots in, for one pose
function bbox(grid) {
  let top = PET_H, bottom = -1, left = PET_W, right = -1
  for (let i = 0; i < PET_W * PET_H; i++) {
    if (grid[i] === scene.OFF) continue
    const r = Math.floor(i / PET_W), c = i % PET_W
    if (r < top) top = r
    if (r > bottom) bottom = r
    if (c < left) left = c
    if (c > right) right = c
  }
  return { top, bottom, left, right }
}

const at = (id, x, y, w, h) => ({ id, x, y, w, h })
const cat = (x, y, w, h) => at("cat", x, y, w, h)

// ---- beside it: boxes that share a whole edge, with no air between ----
{
  // the usual desk: the radio full on the left, the cat over Tasks on the right
  const desk = [at("radio", 0, 0, 4, 4), cat(4, 0, 2, 1), at("tasks", 4, 1, 2, 2), at("timer", 4, 3, 2, 1)]
  assert.equal(besideCat(desk, "cat", "tasks"), true, "Tasks is right under it")
  assert.equal(besideCat(desk, "cat", "radio"), true, "the radio is right beside it")
  assert.equal(besideCat(desk, "cat", "timer"), false, "the timer is two rows away")
  assert.equal(besideCat(desk, "cat", "cat"), false, "not itself")
  assert.equal(besideCat(desk, "cat", "clock"), false, "not a widget in the drawer")
  assert.equal(besideCat([at("tasks", 4, 1, 2, 2)], "cat", "tasks"), false, "no cat, no neighbour")
  // a column or a row of air between them is not beside
  assert.equal(besideCat([cat(0, 0, 2, 1), at("tasks", 3, 0, 2, 2)], "cat", "tasks"), false, "a column of air")
  assert.equal(besideCat([cat(0, 0, 2, 1), at("tasks", 0, 2, 2, 2)], "cat", "tasks"), false, "a row of air")
  // touching at a corner only: their edges don't overlap
  assert.equal(besideCat([cat(0, 0, 2, 1), at("tasks", 2, 1, 2, 2)], "cat", "tasks"), false, "corner to corner is not beside")
  // the least overlap there can be still counts, either way round
  assert.equal(besideCat([cat(2, 2, 2, 1), at("tasks", 0, 0, 2, 2)], "cat", "tasks"), false, "diagonally apart")
  assert.equal(besideCat([cat(2, 1, 2, 1), at("tasks", 0, 0, 2, 2)], "cat", "tasks"), true, "beside it, one row of overlap")
  assert.equal(besideCat([at("tasks", 0, 0, 2, 2), cat(0, 2, 2, 1)], "cat", "tasks"), true, "under it")
  assert.equal(besideCat([at("tasks", 0, 2, 2, 2), cat(0, 1, 2, 1)], "cat", "tasks"), true, "over it")
}

// ---- the picture in a box: the art fits, standing on its floor shadow ----
{
  // the drawn floor shadow is the lowest row with anything in it, and the
  // coat stands on the row above it
  const grid = scene.drawPet(scene.RESTING_FRAME)
  let lowest = -1, coatBottom = -1
  for (let i = 0; i < PET_W * PET_H; i++) {
    const r = Math.floor(i / PET_W)
    if (grid[i] > scene.OFF) lowest = Math.max(lowest, r)
    if (scene.COAT[i] > 0.5) coatBottom = Math.max(coatBottom, r)
  }
  assert.equal(lowest, SHADOW_ROW, "the floor shadow is the art's lowest row")
  assert.ok(coatBottom < SHADOW_ROW, "the coat stands above its shadow")

  // CAT_BODY is where the resting loaf and its shadow really are
  const rest = bbox(grid)
  for (const side of ["top", "bottom", "left", "right"]) {
    assert.equal(rest[side], CAT_BODY[side], `the body box's ${side} is the resting art's`)
  }
  assert.equal(CAT_BODY.bottom, SHADOW_ROW, "its floor is the shadow row")

  // and no pose reaches further past it than fitCat gives the padding to hold
  const seeded = (k) => { const x = Math.sin(k * 12.9898) * 43758.5453; return x - Math.floor(x) }
  const moods = ["idle", "bop", "focus", "purr", "happy", "cheer", "sleep"]
  let reach = { up: 0, down: 0, left: 0, right: 0 }
  for (const mood of moods) {
    for (let k = 0; k < 80; k++) {
      const b = bbox(scene.drawPet({
        ...scene.IDLE_FRAME, mood, blink: k % 7 === 0,
        bob: seeded(k + 1), pulse: seeded(k + 2), hop: seeded(k + 3), twitch: seeded(k + 4), pat: seeded(k + 5),
        phase: k * 0.37, swing: k * 0.61, breathe: k * 0.29, notes: k % 2 === 0, groove: seeded(k + 6),
        sparkle: seeded(k + 7), gazeX: seeded(k + 8) * 2 - 1, gazeY: seeded(k + 9) * 2 - 1, affection: seeded(k + 10),
      }))
      reach = {
        up: Math.max(reach.up, CAT_BODY.top - b.top), down: Math.max(reach.down, b.bottom - CAT_BODY.bottom),
        left: Math.max(reach.left, CAT_BODY.left - b.left), right: Math.max(reach.right, b.right - CAT_BODY.right),
      }
    }
  }
  assert.ok(reach.up <= CAT_REACH.up, `nothing reaches over ${CAT_REACH.up} rows above the body (${reach.up})`)
  assert.ok(reach.left <= CAT_REACH.side && reach.right <= CAT_REACH.side, `nor ${CAT_REACH.side} columns beside it (${reach.left}/${reach.right})`)
  assert.ok(reach.down <= PET_H - 1 - CAT_BODY.bottom, "nor off the art below it")

  // every card the cat can be, at every window: the body fits its content box
  // centred and on the floor, and nothing of it is clipped by the frame
  const PAD = (bucket, size) => (bucket === "phone" ? 12 : size === "s" ? 16 : 20) // app/desk.css + app/widgets/cat.css
  const WINDOWS = [[1920, 1080], [1512, 860], [1440, 900], [1440, 800], [1366, 768], [1280, 720], [1100, 800], [1024, 768], [820, 1180], [744, 900], [430, 932], [390, 844], [360, 780], [320, 640]]
  let smallest = Infinity
  for (const [vw, vh] of WINDOWS) {
    const m = board.metricsFor(vw, vh)
    for (const size of ["s", "m", "l"]) {
      const f = board.footprint(size, m.cols)
      const px = board.rectPx({ x: 0, y: 0, w: f.w, h: f.h }, m)
      const pad = PAD(m.bucket, size)
      const w = px.width - 2 * pad, h = px.height - 2 * pad
      const { pitch, dx, dy } = fitCat(w, h, pad)
      const where = `${size} at ${vw}×${vh}`
      // the canvas hangs from the content box's bottom centre, shifted by dx/dy
      const artLeft = w / 2 - (PET_W * pitch) / 2 + dx, artBottom = h + dy
      const body = {
        left: artLeft + CAT_BODY.left * pitch, right: artLeft + (CAT_BODY.right + 1) * pitch,
        top: artBottom - (PET_H - CAT_BODY.top) * pitch, bottom: artBottom - (PET_H - CAT_BODY.bottom - 1) * pitch,
      }
      assert.ok(pitch >= 1, `a dot is at least a pixel, ${where}`)
      assert.ok(body.left > -1e-6 && body.right < w + 1e-6, `the body fits across ${where}`)
      assert.ok(body.top > -1e-6 && body.bottom < h + 1e-6, `and down ${where}`)
      assert.ok(Math.abs(body.left - (w - body.right)) < 1e-6, `centred, ${where}`)
      assert.ok(Math.abs(body.bottom - h) < 1e-6, `on the floor, ${where}`)
      // the reaching poses stay inside the frame: the padding holds them
      assert.ok(body.left - CAT_REACH.side * pitch > -pad - 1e-6, `a lean stays on the card, ${where}`)
      assert.ok(body.right + CAT_REACH.side * pitch < w + pad + 1e-6, `either way, ${where}`)
      assert.ok(body.top - CAT_REACH.up * pitch > -pad - 1e-6, `a hop stays on it, ${where}`)
      // and it keeps a comfortable margin at rest
      smallest = Math.min(smallest, body.left + pad, w - body.right + pad, body.top + pad, h - body.bottom + pad)
    }
  }
  assert.ok(smallest >= 12, `the cat never comes within 12px of a card edge (${smallest.toFixed(1)})`)
  assert.equal(fitCat(20, 20).pitch, 1, "never under a pixel a dot")
  assert.equal(fitCat(400, 300, 20).dy, 2 * fitCat(400, 300, 20).pitch, "two rows of the art hang below the shadow")
}

// ---- the picture in the hand: the resting cat's silhouette ----
{
  const art = stillArt()
  assert.equal(stillArt(), art, "worked out once")
  for (const [name, l] of Object.entries(art)) {
    if (!l) continue
    assert.ok(l.rows.length > 0 && l.rows.every((row) => row.length === l.rows[0].length && /^[X.]+$/.test(row)), `${name} rows are even`)
    assert.ok(l.top >= 0 && l.left >= 0 && l.top + l.rows.length <= PET_H && l.left + l.rows[0].length <= PET_W, `${name} fits the art`)
    assert.ok(l.rows[0].includes("X") && l.rows[l.rows.length - 1].includes("X"), `${name} is cropped to its dots`)
  }
  assert.ok(art.shadow && art.shadow.top === SHADOW_ROW && art.shadow.rows.length === 1, "the floor shadow is its own row")
  assert.ok(art.coat.top + art.coat.rows.length <= SHADOW_ROW, "the coat stands on it")
  // most of the art is coat, and the eyes are open in it
  const lit = art.coat.rows.join("").split("").filter((c) => c === "X").length
  assert.ok(lit > 500, `a whole cat (${lit} dots)`)
  const holes = art.coat.rows.slice(4, 12).some((row) => /X\.+X/.test(row))
  assert.ok(holes, "its eyes are open")
  assert.ok(art.accent, "its collar")
}

console.log("cat-desk ok")
