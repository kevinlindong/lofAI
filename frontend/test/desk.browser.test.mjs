/**
 * Browser checks for the desk: widgets on a grid, moved by pointer and keys,
 * put away in the drawer and taken out again. Serve a production export
 * before running; this never starts the music backend.
 *
 * DESK_TEST_BASE_URL=http://127.0.0.1:3013 node test/desk.browser.test.mjs
 * Optional: PLAYWRIGHT_MODULE_PATH (an existing Playwright installation),
 * CHROME_EXECUTABLE (otherwise Playwright's Chromium), DESK_TEST_FILTER.
 * No Playwright dependency is required by the application itself.
 */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"

const baseURL = process.env.DESK_TEST_BASE_URL
assert.ok(baseURL, "Serve frontend/out and set DESK_TEST_BASE_URL before running this browser test.")
const baseOrigin = new URL(baseURL).origin
const { chromium } = process.env.PLAYWRIGHT_MODULE_PATH
  ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH)
  : await import("playwright")
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || undefined })
const sliders = ["style match", "variation", "volume", "Work", "Rest"]
// the four that start on the desk (v2: Sound is part of Radio); built drawer-only widgets (Today, Clock…)
// may be listed alongside them in the drawer
const CORE = ["Radio", "Tasks", "Focus timer", "Cat"]
const coreTiles = async drawer => (await drawer.locator(".tile .tile-name").allTextContents()).filter(name => CORE.includes(name))
const TASKS = [
  { id: "t1", text: "Draft the intro paragraph", done: false },
  { id: "t2", text: "Reply to Maya about Thursday", done: false },
  { id: "t3", text: "Water the plants", done: true },
]
const tests = []
const failures = []
const test = (name, run) => tests.push({ name, run })
const wait = (page, ms) => page.waitForTimeout(ms)

// A fresh browser profile per check. `seed` is written to localStorage before
// the first load only, so reloads see what the page itself saved.
async function makePage({ width = 1440, height = 780, seed = { todos: JSON.stringify(TASKS), "lofai.theme": "light" }, touch = false, reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, ...(touch ? { hasTouch: true, isMobile: true } : {}) })
  // Every external request is blocked: no account, model, or service is needed.
  await context.route("**/*", route => new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort())
  await context.addInitScript(seed => {
    try {
      if (sessionStorage.getItem("desk-test-seeded")) return
      sessionStorage.setItem("desk-test-seeded", "1")
      for (const key of Object.keys(seed)) localStorage.setItem(key, seed[key])
    } catch {}
  }, seed)
  const page = await context.newPage()
  page.errors = []
  page.on("pageerror", error => page.errors.push(String(error)))
  await page.goto(baseURL, { waitUntil: "networkidle" })
  await page.locator(".desk[data-ready]").waitFor()
  await wait(page, 400)
  return page
}

// every frame's committed cell and its rect on the page
const frames = page => page.evaluate(() => {
  const out = {}
  for (const frame of document.querySelectorAll("section[aria-roledescription=widget]")) {
    const r = frame.getBoundingClientRect(), style = getComputedStyle(frame)
    out[frame.id.replace("widget-", "")] = {
      name: frame.getAttribute("aria-label"), x: +style.getPropertyValue("--x"), y: +style.getPropertyValue("--y"),
      left: r.left, top: r.top + scrollY, right: r.right, bottom: r.bottom + scrollY, width: r.width, height: r.height,
    }
  }
  return out
})
const cells = all => Object.fromEntries(Object.entries(all).map(([id, f]) => [id, `${f.x},${f.y}`]))
function overlapping(all) {
  const ids = Object.keys(all), bad = []
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = all[ids[i]], b = all[ids[j]]
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) bad.push(`${ids[i]}/${ids[j]}`)
  }
  return bad
}
const stored = (page, key) => page.evaluate(key => localStorage.getItem(key), key)
const live = page => page.evaluate(() => document.getElementById("desk-live").textContent.trim())
const lifted = page => page.evaluate(() => document.querySelector("[data-lifted]")?.id ?? null)
const center = async locator => { const b = await locator.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const timerLabel = page => page.locator("#widget-timer .timer-widget .label").first()
const digits = page => page.locator("#widget-timer .tabular-nums").first().textContent()
const stackOrder = page => page.evaluate(() => [...document.querySelectorAll(".desk .wf")].map(f => f.id.replace("widget-", "")).join(","))
// where the lit footprint says the widget in hand will land
const landingCell = page => page.evaluate(() => {
  const el = document.querySelector(".desk-landing")
  return el && el.hasAttribute("data-on") ? { x: +el.style.getPropertyValue("--x"), y: +el.style.getPropertyValue("--y") } : null
})
const translateOf = (page, id) => page.evaluate(id => document.getElementById(`widget-${id}`).style.translate || "none", id)
// frames that end past the fold: at 1440×780 the board's last row in view ends at 720
const outOfView = (all, fold = 720) => Object.entries(all).filter(([, f]) => f.bottom > fold + 0.5).map(([id]) => id)
// a returning visitor who has seen the desk before: no welcome note in the way
const SEEN = { todos: JSON.stringify(TASKS), "lofai.theme": "light", "lofai.seen": "1" }

// a mouse drag in small steps, a frame apart, with an optional pause before letting go
async function drag(page, from, to, { steps = 20, hold } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps)
    await wait(page, 16)
  }
  if (hold) await hold()
  await page.mouse.up()
}

async function putAwayFromMenu(page, id, name) {
  await page.locator(`#widget-${id}`).hover()
  await page.getByRole("button", { name: `Move ${name}`, exact: true }).click()
  await page.getByRole("menuitem", { name: "Put in the drawer" }).click()
  // v2 stows it into the pull on a spring (LEAVE_MS 420) before it's gone
  await wait(page, 600)
}

// SPEC2 §13.2 (v3 rule, SPEC3 §1 with the freed-room rule): every pairwise and
// open-slot drop on the usual desk, by the grip, checked against the plan the engine promises for this bucket
// (test/fixtures/pairwise-default.json). A fresh desk for each drop.
const PAIRWISE = JSON.parse(readFileSync(new URL("./fixtures/pairwise-default.json", import.meta.url), "utf8"))
async function pairwise(width, height, { touch = false, long = false } = {}) {
  const page = await makePage({ width, height, touch, seed: SEEN })
  const cdp = touch ? await page.context().newCDPSession(page) : null
  const point = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] })
  const press = async (x, y) => { if (cdp) await point("touchStart", x, y); else { await page.mouse.move(x, y); await page.mouse.down() } }
  const move = (x, y) => (cdp ? point("touchMove", x, y) : page.mouse.move(x, y))
  const release = (x, y) => (cdp ? point("touchEnd", x, y) : page.mouse.up())
  const cols = await page.evaluate(() => +getComputedStyle(document.querySelector(".desk")).getPropertyValue("--cols"))
  const cases = PAIRWISE[cols], bad = []
  let landed = 0
  for (const c of cases) {
    await page.evaluate(seen => { localStorage.removeItem("lofai.board"); for (const k of Object.keys(seen)) localStorage.setItem(k, seen[k]) }, SEEN)
    await page.reload({ waitUntil: "load" })
    await page.locator(`.desk[data-ready] #widget-${c.id}`).waitFor()
    await wait(page, 300)
    const geo = () => page.evaluate(id => {
      const d = document.querySelector(".desk"), r = d.getBoundingClientRect(), g = document.querySelector(`#widget-${id} [data-grip]`).getBoundingClientRect()
      const at = {}
      for (const f of d.querySelectorAll(":scope > .wf")) { const b = f.getBoundingClientRect(); at[f.id.slice(7)] = { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height, pinned: f.hasAttribute("data-pinned") } }
      const cs = getComputedStyle(d)
      return { px: parseFloat(cs.getPropertyValue("--pitch-x")), py: parseFloat(cs.getPropertyValue("--pitch-y")), at, gx: g.left + g.width / 2, gy: g.top + g.height / 2, scroll: scrollY, vh: innerHeight }
    }, c.id)
    let g = await geo()
    // a reload may keep the last drop's scroll: bring the grip to a calm part of the window
    if (g.gy > g.vh - 100 || (g.gy < 100 && g.scroll > 0)) { await page.evaluate(y => scrollTo(0, Math.max(0, y)), g.gy + g.scroll - 200); await wait(page, 100); g = await geo() }
    // by the grip, or a long press on a quiet spot of the body just below it:
    // the header band every card has (Tasks' field starts about 50px down)
    const A = g.at[c.id], sx = g.gx, sy = g.gy + (long ? 24 : 0)
    await press(sx, sy)
    if (long) await wait(page, 470)
    await move(sx + 3, sy + 3); await wait(page, 20); await move(sx + 6, sy + 6); await wait(page, 40)
    const held = await lifted(page)
    // a target past the fold: the page scrolls under the widget in hand
    let ty = sy + c.target.y * g.py + 0.1 * g.py - A.y
    if (ty > g.vh - 100 || ty < 100) {
      await page.evaluate(y => scrollTo(0, y), Math.max(0, g.scroll + ty - g.vh / 2)); await wait(page, 80)
      ty -= (await page.evaluate(() => scrollY)) - g.scroll
    }
    const tx = sx + c.target.x * g.px + 0.1 * g.px - A.x
    for (let k = 1; k <= 24; k++) { await move(sx + (tx - sx) * k / 24, sy + (ty - sy) * k / 24); await wait(page, 16) }
    await wait(page, 120)
    await release(tx, ty)
    await wait(page, 700)
    const after = await geo(), said = await live(page), problems = []
    if (held !== `widget-${c.id}`) problems.push("never lifted")
    for (const id of Object.keys(c.after)) {
      const f = after.at[id], [x, y] = c.after[id]
      if (!f || Math.abs(f.x - x * after.px) > 2 || Math.abs(f.y - y * after.py) > 2) problems.push(`${id} at ${f ? `${(f.x / after.px).toFixed(2)},${(f.y / after.py).toFixed(2)}` : "nowhere"}, not ${x},${y}`)
    }
    if (after.at[c.id]?.pinned !== c.pinned) problems.push(`pinned ${after.at[c.id]?.pinned}, not ${c.pinned}`)
    const rects = Object.values(after.at)
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const P = rects[i], Q = rects[j]
      if (P.x < Q.x + Q.w - 2 && Q.x < P.x + P.w - 2 && P.y < Q.y + Q.h - 2 && Q.y < P.y + P.h - 2) problems.push("an overlap")
    }
    if (!(c.how === "home" ? /is back where it was/ : /set down/).test(said)) problems.push(`said "${said}"`)
    if (await page.evaluate(() => document.body.innerText.includes("No room"))) problems.push("No room")
    if (!(Math.abs(after.at[c.id].x - A.x) < 2 && Math.abs(after.at[c.id].y - A.y) < 2)) landed++
    if (problems.length) bad.push(`${c.id} ${c.what} → ${c.target.x},${c.target.y}: ${problems.join("; ")}`)
  }
  console.log(`      ${width}×${height}${touch ? (long ? " long-press" : " touch") : ""}: ${cases.length} drops, ${landed} landed, ${cases.length - landed} refused`)
  assert.deepEqual(bad, [], "every drop lands as planned")
  // a drop goes home only when nothing takes it (none do on the usual desk)
  assert.equal(landed, cases.filter(c => c.how !== "home").length, "nothing else is refused")
  assert.deepEqual(page.errors, [])
  await page.context().close()
}

test("1. the default desk fits 1440×780 with nothing overlapping and the grid hidden", async () => {
  const page = await makePage()
  const all = await frames(page)
  assert.deepEqual(Object.values(all).map(f => f.name).sort(), ["Cat", "Focus timer", "Radio", "Tasks"])
  assert.deepEqual(overlapping(all), [], "no two frames overlap")
  for (const [id, f] of Object.entries(all)) assert.ok(f.bottom <= 720.5, `${id} ends at ${f.bottom}, past 720`)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow")
  assert.equal(await page.evaluate(() => +getComputedStyle(document.querySelector(".desk-grid")).opacity), 0)
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("2. a body drag of the timer onto Tasks takes its slot, Tasks moves down into the room it left, and it persists", async () => {
  const page = await makePage()
  const before = await frames(page)
  const from = await center(timerLabel(page))
  let during = null
  await drag(page, from, { x: from.x + (before.tasks.left - before.timer.left) + 20, y: from.y + (before.tasks.top - before.timer.top) + 20 }, { steps: 24, hold: async () => {
    await wait(page, 250)
    during = { landing: await landingCell(page), tasks: await translateOf(page, "tasks") }
  } })
  await wait(page, 800)
  const after = await frames(page)
  assert.deepEqual(during.landing, { x: 4, y: 1 }, "the footprint shows where it will land")
  assert.ok(!/^(none|0px 0px)$/.test(during.tasks), `Tasks makes room while it's carried (${during.tasks})`)
  // it lands on the spot it was dropped on, and Tasks moves over into the
  // room the timer left: no hole, nothing past the fold
  assert.deepEqual(cells(after), { radio: "0,0", cat: "4,0", timer: "4,1", tasks: "4,2" })
  assert.deepEqual(outOfView(after), [], "nobody is pushed out of view")
  assert.deepEqual(overlapping(after), [])
  assert.match(await live(page), /^Focus timer set down at column 5, row 2\. Tasks moves to make room\.$/)
  assert.equal(await page.locator("#widget-timer").getAttribute("data-pinned"), null, "a move, never a pin")
  await page.reload({ waitUntil: "networkidle" })
  await page.locator(".desk[data-ready]").waitFor()
  await wait(page, 400)
  assert.deepEqual(cells(await frames(page)), cells(after), "the arrangement survives a reload")
  await page.context().close()
})

test("3. clicks stay clicks: Start timer starts it, and a drag on volume moves the volume", async () => {
  // a returning visitor's welcome note sits over the radio's dials until it's answered
  const page = await makePage({ seed: SEEN })
  const before = cells(await frames(page))
  await page.getByRole("button", { name: "Start timer" }).click()
  await wait(page, 300)
  assert.equal(await page.getByRole("button", { name: "Pause timer" }).count(), 1, "the timer is running")
  assert.deepEqual(cells(await frames(page)), before, "nothing moved")
  const volume = page.getByRole("slider", { name: "volume", exact: true })
  const was = Number(await volume.getAttribute("aria-valuenow"))
  const box = await volume.boundingBox()
  let during = null
  await drag(page, { x: box.x + box.width - 4, y: box.y + box.height / 2 }, { x: box.x + box.width * 0.4, y: box.y + box.height / 2 },
    { steps: 16, hold: async () => { during = await lifted(page) } })
  await wait(page, 500)
  assert.equal(during, null, "the slider never lifts its widget")
  assert.ok(Number(await volume.getAttribute("aria-valuenow")) < was, "the volume went down")
  assert.deepEqual(cells(await frames(page)), before, "the layout didn't change")
  await page.context().close()
})

test("4. the keyboard lifts and moves it a slot at a time, resists at the edge, goes to the row's ends, sets down, and Escape puts it back", async () => {
  const page = await makePage()
  const before = await frames(page)
  await page.getByRole("button", { name: "Move Focus timer" }).focus()
  const said = []
  const press = async key => { await page.keyboard.press(key); await wait(page, 120); said.push(await live(page)) }
  // one slot up is Tasks' bottom half, with no room for Tasks to move over
  // into, so the step goes on past it: Tasks moves down into the timer's room
  await press("ArrowUp")
  assert.match(said[0], /^Picked up Focus timer\. Arrow keys move it one space, Home and End to the ends of its row, .* Escape puts it back\. Column 5, row 2\. Tasks moves to make room\.$/)
  assert.equal(await lifted(page), "widget-timer")
  assert.deepEqual(await landingCell(page), { x: 4, y: 1 })
  await press("ArrowUp")
  assert.match(said[1], /^Column 5, row 1\. Cat moves to make room\.$/)
  assert.deepEqual(await landingCell(page), { x: 4, y: 0 }, "the steps add up")
  await press("ArrowRight")
  assert.equal(said[2], "That's the edge of the desk.")
  // the radio is never shoved for it: Home resists
  await press("Home")
  assert.equal(said[3], "Radio is in the way.", "Home: the radio won't budge")
  assert.deepEqual(await landingCell(page), { x: 4, y: 0 })
  await press("ArrowDown")
  assert.match(said[4], /^Column 5, row 2\. Tasks moves to make room\.$/)
  await page.keyboard.press("Enter")
  await wait(page, 800)
  const moved = await frames(page)
  assert.deepEqual(cells(moved), { radio: "0,0", cat: "4,0", timer: "4,1", tasks: "4,2" }, "Enter commits where the last press put it")
  assert.deepEqual(outOfView(moved), [], "and everyone is still in view")
  assert.deepEqual(overlapping(moved), [])
  assert.equal(await lifted(page), null)
  assert.equal(await page.locator("#widget-timer").getAttribute("data-pinned"), null, "and it isn't pinned")
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".wf")?.id), "widget-timer", "focus stays on its grip")
  for (let i = 0; i < 2; i++) { await page.keyboard.press("ArrowDown"); await wait(page, 60) }
  await page.keyboard.press("Escape")
  await wait(page, 800)
  assert.deepEqual(cells(await frames(page)), cells(moved), "Escape restores where it was")
  assert.match(await live(page), /Focus timer is back where it was\./)
  assert.notDeepEqual(cells(moved), cells(before))
  await page.context().close()
})

test("5. put away shows an Undo toast; Undo and Control+Z bring it back; the timer keeps running", async () => {
  const page = await makePage()
  const before = cells(await frames(page))
  await putAwayFromMenu(page, "timer", "Focus timer")
  assert.equal(await page.locator("#widget-timer").count(), 0, "the timer is off the desk")
  const toast = page.locator(".desk-toast")
  assert.match(await toast.textContent(), /is in the drawer/)
  await toast.getByRole("button", { name: "Undo" }).click()
  await wait(page, 600)
  assert.equal(await page.locator("#widget-timer").count(), 1, "Undo brings it back")
  assert.deepEqual(cells(await frames(page)), before)
  await putAwayFromMenu(page, "timer", "Focus timer")
  await page.locator("body").press("Control+z")
  await wait(page, 600)
  assert.equal(await page.locator("#widget-timer").count(), 1, "Control+Z brings it back")
  assert.deepEqual(cells(await frames(page)), before)
  // still counting in the drawer
  await page.getByRole("button", { name: "Start timer" }).click()
  await wait(page, 250)
  const started = await digits(page)
  await putAwayFromMenu(page, "timer", "Focus timer")
  await wait(page, 1500)
  await page.getByRole("button", { name: "Menu" }).click()
  await page.getByRole("menuitem", { name: "Focus timer" }).click()
  await wait(page, 500)
  const later = await digits(page)
  const seconds = text => { const [m, s] = text.split(":").map(Number); return m * 60 + s }
  assert.ok(seconds(later) <= seconds(started) - 1, `the digits dropped while it was away (${started} -> ${later})`)
  assert.equal(await page.getByRole("button", { name: "Pause timer" }).count(), 1, "it is still running")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("6. D opens the drawer with only what's away; a tile takes it back to its spot; Escape returns to the pull", async () => {
  const page = await makePage()
  const before = cells(await frames(page))
  await putAwayFromMenu(page, "timer", "Focus timer")
  await page.locator("body").press("d")
  await wait(page, 600)
  const drawer = page.locator("#desk-drawer")
  assert.notEqual(await drawer.getAttribute("data-open"), null, "the drawer is open")
  assert.equal(await drawer.getAttribute("role"), "dialog")
  assert.equal(await drawer.getAttribute("aria-modal"), "false")
  assert.deepEqual(await coreTiles(drawer), ["Focus timer"], "only the away widget is listed")
  // v3: a put-away widget remembers its spot here, and the tile says so while it's free
  assert.match(await drawer.locator(".tile", { hasText: "Focus timer" }).textContent(), /goes back to its spot/)
  assert.equal(await page.evaluate(() => document.querySelector(".desk").hasAttribute("data-arranging")), true, "the lattice shows")
  await drawer.getByRole("button", { name: "Focus timer" }).click()
  await wait(page, 800)
  assert.deepEqual(cells(await frames(page)), before, "the timer is back in its remembered spot")
  assert.equal(await drawer.getAttribute("data-open"), null, "taking it out closes the drawer")
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Move Focus timer", "focus goes to its grip")
  await page.keyboard.press("d")
  await wait(page, 500)
  assert.deepEqual(await coreTiles(drawer), [])
  // anything built that starts in the drawer comes out too, to see it empty
  // taking one out closes the drawer and may focus a field, so the pull reopens it
  while (await drawer.locator(".tile").count()) {
    await drawer.locator(".tile").first().click()
    await wait(page, 800)
    await page.locator(".drawer-pull").click()
    await wait(page, 500)
  }
  assert.equal(await drawer.locator(".tile").count(), 0)
  assert.match(await drawer.textContent(), /Everything's out on the desk\./)
  await page.keyboard.press("Escape")
  await wait(page, 400)
  assert.equal(await drawer.getAttribute("data-open"), null, "Escape closes it")
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-controls")), "desk-drawer", "focus is back on the pull")
  await page.context().close()
})

test("7. an unreadable board shows the usual desk, is stashed once, and leaves todos alone", async () => {
  const todos = JSON.stringify(TASKS)
  const page = await makePage({ seed: { todos, "lofai.board": "{", "lofai.theme": "light" } })
  assert.deepEqual(Object.values(await frames(page)).map(f => f.name).sort(), ["Cat", "Focus timer", "Radio", "Tasks"])
  assert.equal(await stored(page, "lofai.board.broken"), "{")
  assert.equal(await stored(page, "todos"), todos)
  // opening the drawer tells, once, and still writes nothing over it
  await page.getByRole("button", { name: /widgets/ }).click()
  await wait(page, 500)
  assert.match(await page.locator("#desk-drawer").textContent(), /couldn't be read, so the desk is back to the usual/)
  await wait(page, 500)
  assert.equal(await stored(page, "lofai.board"), "{", "the unreadable board isn't overwritten by looking")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("8. a legacy todo list renders and normalizes as before", async () => {
  const page = await makePage({ seed: { todos: JSON.stringify([{ text: "a", completed: true }]), todoScore: "3", "lofai.theme": "light" } })
  assert.equal(await page.locator("#widget-tasks button.task-check[aria-pressed=true]").count(), 1, "it renders as done")
  const saved = JSON.parse(await stored(page, "todos"))
  assert.equal(saved.length, 1)
  assert.deepEqual(Object.keys(saved[0]), ["id", "text", "done"])
  assert.equal(typeof saved[0].id, "string")
  assert.ok(saved[0].id.length > 0)
  assert.equal(saved[0].text, "a")
  assert.equal(saved[0].done, true)
  assert.equal(await stored(page, "todoScore"), null)
  await page.context().close()
})

test("9. the phone desk is two columns with every slider, and Move later trades places for good", async () => {
  const page = await makePage({ width: 390, height: 844, touch: true, seed: { todos: JSON.stringify(TASKS), "lofai.theme": "ocean" } })
  const all = await frames(page)
  assert.equal(await page.evaluate(() => document.querySelector(".desk").dataset.bucket), "phone")
  // SPEC3 §3: the radio's tall form, then the cat, Tasks and the timer under it
  assert.deepEqual(cells(all), { radio: "0,0", cat: "0,4", tasks: "0,5", timer: "0,7" }, "the phone's usual desk")
  assert.equal(await page.locator("#widget-radio").getAttribute("data-form"), "tall")
  assert.deepEqual(overlapping(all), [])
  for (const name of sliders) assert.equal(await page.getByRole("slider", { name, exact: true }).count(), 1, `${name} is there once`)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow")
  const pull = await page.locator(".drawer-pull").boundingBox()
  assert.ok(pull && pull.y + pull.height <= 844, "the pull is in view")
  await page.locator("#widget-radio [data-grip]").tap()
  assert.equal(await page.getByRole("menuitem", { name: "Move earlier" }).isDisabled(), true, "first on the desk: nowhere earlier")
  await page.getByRole("menuitem", { name: "Move later" }).tap()
  await wait(page, 700)
  await page.keyboard.press("Escape")
  const moved = cells(await frames(page))
  // a clean trade: the cat takes the top, the radio comes in right under it, nothing else stirs
  assert.deepEqual(moved, { cat: "0,0", radio: "0,1", tasks: "0,5", timer: "0,7" }, "the radio and the cat traded places")
  assert.match(await live(page), /^Radio is at column 1, row 2\. Cat moves to make room\.$/)
  assert.deepEqual(overlapping(await frames(page)), [])
  await page.reload({ waitUntil: "networkidle" })
  await page.locator(".desk[data-ready]").waitFor()
  await wait(page, 400)
  assert.deepEqual(cells(await frames(page)), moved, "the trade persists")
  await page.context().close()
})

test("10. changing bucket never remounts a widget", async () => {
  const page = await makePage()
  await page.evaluate(() => { document.querySelector("#widget-cat canvas").__mark = 1 })
  await page.setViewportSize({ width: 1024, height: 768 })
  await wait(page, 500)
  assert.equal(await page.evaluate(() => document.querySelector(".desk").dataset.bucket), "compact")
  await page.setViewportSize({ width: 1440, height: 780 })
  await wait(page, 500)
  assert.equal(await page.evaluate(() => document.querySelector("#widget-cat canvas").__mark), 1, "the cat's canvas is the same element")
  await page.context().close()
})

test("11. reduced motion: a drag commits and nothing is left in transition", async () => {
  const page = await makePage({ reducedMotion: "reduce" })
  const before = await frames(page)
  const from = await center(timerLabel(page))
  await drag(page, from, { x: from.x - (before.timer.left - before.tasks.left), y: from.y }, { steps: 12 })
  await wait(page, 100)
  const duration = await page.evaluate(() => getComputedStyle(document.getElementById("widget-timer")).transitionDuration)
  assert.ok(duration.split(",").every(d => parseFloat(d) <= 0.00001), `transition-duration ${duration}`)
  const after = await frames(page)
  assert.equal(after.timer.x, before.tasks.x, "the drop committed")
  await page.context().close()
})

test("12. a 60-step drag changes no DOM structure, has no long tasks, and only moves what moves", async () => {
  const page = await makePage()
  await page.evaluate(() => {
    window.__desk = { child: 0, attrs: new Set(), props: new Set(), long: 0 }
    const parse = s => Object.fromEntries((s || "").split(";").map(d => d.split(":").map(v => v.trim())).filter(([k]) => k))
    new MutationObserver(list => {
      for (const m of list) {
        if (m.type === "childList") { window.__desk.child++; continue }
        if (m.attributeName !== "style") continue
        const was = parse(m.oldValue), now = parse(m.target.getAttribute("style"))
        for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (was[k] !== now[k]) window.__desk.props.add(k)
        window.__desk.attrs.add(m.target.id || m.target.className)
      }
    }).observe(document.querySelector(".desk"), { subtree: true, childList: true, attributes: true, attributeOldValue: true })
    new PerformanceObserver(list => { window.__desk.long += list.getEntries().length }).observe({ type: "longtask" })
  })
  const from = await center(timerLabel(page))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x - 8, from.y)
  await wait(page, 60)
  await page.evaluate(() => { window.__desk.child = 0; window.__desk.attrs = new Set(); window.__desk.props = new Set(); window.__desk.long = 0 })
  for (let i = 1; i <= 60; i++) {
    const a = i / 60 * Math.PI * 2
    await page.mouse.move(from.x - 8 + 380 * Math.sin(a / 2), from.y - 200 * Math.sin(a))
    await wait(page, 16)
  }
  const seen = await page.evaluate(() => ({ child: window.__desk.child, attrs: [...window.__desk.attrs], props: [...window.__desk.props], long: window.__desk.long }))
  await page.mouse.up()
  await wait(page, 900)
  assert.equal(seen.child, 0, "no childList changes while carrying")
  assert.equal(seen.long, 0, "no long tasks while carrying")
  const allowed = /^(widget-(timer|tasks|cat|radio)|desk-landing|wf-shadow wf-(cast|contact))$/
  assert.deepEqual(seen.attrs.filter(a => !allowed.test(a)), [], `styles only on moving frames and the footprint (${seen.attrs.join(", ")})`)
  assert.deepEqual(seen.props.filter(p => !/^(translate|scale|rotate|opacity|transform-origin|--[xywh])$/.test(p)), [], `only transforms and opacity (${seen.props.join(", ")})`)
  // at rest again: the springs leave nothing inline
  const inline = await page.evaluate(() => [...document.querySelectorAll(".desk .wf")].filter(f => f.style.translate || f.style.scale || f.style.rotate || f.style.opacity).map(f => f.id))
  assert.deepEqual(inline, [], "every body rested and cleared its styles within 900ms")
  await page.context().close()
})

test("13. a tile carried out of the drawer makes room and lands where it was dropped; dropped back on the strip it stays in", async () => {
  const page = await makePage()
  await putAwayFromMenu(page, "timer", "Focus timer")
  await page.locator("body").press("d")
  await wait(page, 600)
  // over the strip it stays in the drawer, and nothing moves
  const tile = await center(page.locator("#desk-drawer .tile").first())
  let over = null
  await drag(page, tile, { x: tile.x, y: 300 }, { steps: 10, hold: async () => {
    over = await page.evaluate(() => ({ carrying: document.querySelector("#desk-drawer").hasAttribute("data-carrying"), ghost: !!document.querySelector(".drawer-ghost") }))
    await page.mouse.move(tile.x, 770, { steps: 6 })
    await wait(page, 150)
    over.strip = await page.evaluate(() => document.querySelector("#desk-drawer").hasAttribute("data-over"))
  } })
  await wait(page, 600)
  assert.deepEqual(over, { carrying: true, ghost: true, strip: true }, "the sheet folds to its strip and a ghost is in hand")
  assert.equal(await page.locator("#widget-timer").count(), 0, "let go on the strip, it stays in the drawer")
  assert.match(await live(page), /Focus timer is back in the drawer\./)
  // carried onto the cat: the cat makes room (in view), and the timer is on the desk
  const before = await frames(page)
  const tile2 = await center(page.locator("#desk-drawer .tile").first())
  let shifted = null
  // the ghost is held by its middle, as the tile was. the tile sits over the
  // cat's slot, so the hand lifts it up out of the sheet first, then comes back
  const onto = { x: (before.cat.left + before.cat.right) / 2, y: (before.cat.top + before.cat.bottom) / 2 }
  await page.mouse.move(tile2.x, tile2.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) { await page.mouse.move(tile2.x, tile2.y - 18 * i); await wait(page, 16) }
  for (let i = 1; i <= 14; i++) { await page.mouse.move(tile2.x + (onto.x - tile2.x) * i / 14, tile2.y - 180 + (onto.y - tile2.y + 180) * i / 14); await wait(page, 16) }
  await wait(page, 250)
  shifted = await page.evaluate(() => document.getElementById("widget-cat").style.translate)
  await page.mouse.up()
  await wait(page, 800)
  const after = await frames(page)
  assert.ok(shifted && shifted !== "0px 0px", `the cat made room while it was carried (${shifted})`)
  assert.ok(after.timer, "the timer is on the desk")
  assert.deepEqual(overlapping(after), [])
  assert.deepEqual(outOfView(after), [], "nobody was pushed out of view for it")
  assert.equal(await page.locator("#desk-drawer").getAttribute("data-open"), null, "the drawer closed")
  assert.equal(await page.locator(".drawer-ghost").count(), 0, "the ghost is gone")
  // where it went, and who moved for it: it takes the cat's slot, and the
  // column under it goes down a row into the gap the timer left
  assert.deepEqual({ timer: cells(after).timer, cat: cells(after).cat, tasks: cells(after).tasks }, { timer: `${before.cat.x},${before.cat.y}`, cat: "4,1", tasks: "4,2" }, "it takes the cat's slot; the column goes down")
  assert.match(await live(page), /^Focus timer is on the desk at column \d+, row \d+\. Cat and Tasks move to make room\.$/)
  assert.equal(JSON.parse(await stored(page, "lofai.board")).instances.timer.onDesk, true, "the drop is saved")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("14. during a drag the pull becomes the strip that puts a widget away", async () => {
  const page = await makePage()
  const from = await center(timerLabel(page))
  const pull = await center(page.locator(".drawer-pull"))
  let during = null
  await drag(page, from, pull, { steps: 20, hold: async () => {
    await wait(page, 150)
    during = await page.evaluate(() => { const p = document.querySelector(".drawer-pull"); return { drag: p.hasAttribute("data-drag"), over: p.hasAttribute("data-over") } })
  } })
  await wait(page, 500)
  assert.deepEqual(during, { drag: true, over: true })
  assert.equal(await page.locator("#widget-timer").count(), 0, "dropped on the pull, it's in the drawer")
  assert.match(await page.locator(".desk-toast").textContent(), /Focus timer is in the drawer\./)
  assert.equal(await page.evaluate(() => document.querySelector(".drawer-pull").hasAttribute("data-drag")), false)
  await page.context().close()
})

test("15. an empty desk is a real choice, and Put the usual back asks first", async () => {
  const page = await makePage()
  for (const name of ["Radio", "Cat", "Tasks", "Focus timer"]) {
    await page.getByRole("button", { name: `Move ${name}`, exact: true }).focus()
    await page.keyboard.press("Delete")
    await wait(page, 250)
  }
  await wait(page, 400)
  assert.equal(await page.locator(".desk .wf").count(), 0)
  assert.match(await page.locator(".desk-empty").textContent(), /An empty desk\. Nice\./)
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-controls")), "desk-drawer", "focus is on the pull")
  await wait(page, 400)
  assert.equal(JSON.parse(await stored(page, "lofai.board")).emptyByChoice, true)
  await page.getByRole("button", { name: "Open the drawer" }).click()
  await wait(page, 500)
  assert.deepEqual(await coreTiles(page.locator("#desk-drawer")), CORE)
  await page.locator("#desk-drawer").getByRole("button", { name: "Put the usual back" }).click()
  assert.match(await page.locator(".drawer-confirm").textContent(), /Put the usual back\? Everything keeps its contents\./)
  await page.getByRole("button", { name: "Keep mine" }).click()
  assert.equal(await page.locator(".desk .wf").count(), 0, "keeping mine changes nothing")
  await page.locator("#desk-drawer").getByRole("button", { name: "Put the usual back" }).click()
  await page.getByRole("button", { name: "Put it back" }).click()
  await wait(page, 700)
  assert.deepEqual(Object.values(await frames(page)).map(f => f.name).sort(), ["Cat", "Focus timer", "Radio", "Tasks"])
  assert.match(await page.locator(".desk-toast").textContent(), /The usual desk is back\./)
  await page.context().close()
})

test("16. someone returning sees one note, gone with the first drag; the pull says widgets until opened", async () => {
  const page = await makePage()
  const note = page.locator(".desk-toast.is-welcome")
  assert.match(await note.textContent(), /Everything on the desk can move now\./)
  assert.ok(await page.getByRole("button", { name: /widgets/ }).isVisible())
  const from = await center(timerLabel(page))
  await drag(page, from, { x: from.x, y: from.y + 30 }, { steps: 8 })
  await wait(page, 500)
  assert.equal(await note.count(), 0, "the first drag dismisses it")
  await wait(page, 400)
  assert.equal(JSON.parse(await stored(page, "lofai.board")).hints.welcomed, true)
  await page.getByRole("button", { name: /widgets/ }).click()
  await wait(page, 300)
  await page.keyboard.press("Escape")
  await wait(page, 300)
  // off the pull, neither hovered nor focused
  await page.mouse.move(10, 10)
  await page.evaluate(() => document.activeElement?.blur())
  await wait(page, 200)
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".drawer-pull-label")).position), "absolute", "after one open the word goes quiet")
  assert.match(await page.locator(".drawer-pull").getAttribute("aria-controls"), /desk-drawer/)
  // a first visit, with nothing from before, has no note
  const fresh = await makePage({ seed: {} })
  assert.equal(await fresh.locator(".desk-toast.is-welcome").count(), 0)
  await fresh.context().close()
  await page.context().close()
})

test("17. the Menu finds widgets, opens the drawer, and opens Connections", async () => {
  const page = await makePage()
  await page.getByRole("button", { name: "Menu" }).click()
  const items = await page.locator("#page-menu-options [role=menuitem]").allTextContents()
  assert.deepEqual(items, ["Radio", "Tasks", "Focus timer", "Widget drawerD", "Connections…", "Settings"])
  await page.getByRole("menuitem", { name: /Widget drawer/ }).click()
  await wait(page, 500)
  assert.notEqual(await page.locator("#desk-drawer").getAttribute("data-open"), null, "the drawer is open")
  await page.keyboard.press("Escape")
  await wait(page, 300)
  await page.getByRole("button", { name: "Menu" }).click()
  await page.getByRole("menuitem", { name: "Connections…" }).click()
  await wait(page, 400)
  assert.equal(await page.locator("dialog[open]").count(), 1, "the Connections dialog is open")
  await page.context().close()
})

test("18. a card lifts from its plain text too: Tasks by its TASKS label, the ring by its caption", async () => {
  const page = await makePage({ seed: { todos: JSON.stringify(TASKS), "lofai.theme": "light", "lofai.seen": "1" } })
  const before = cells(await frames(page))
  for (const [id, selector] of [["tasks", "#widget-tasks .task-heading .label"], ["radio", "#widget-radio .radio-caption b"]]) {
    const from = await center(page.locator(selector))
    let during = null
    await drag(page, from, { x: from.x + 40, y: from.y + 30 }, { steps: 10, hold: async () => {
      during = await lifted(page)
      await page.keyboard.press("Escape")
    } })
    await wait(page, 700)
    assert.equal(during, `widget-${id}`, `pressing ${selector} lifts its widget`)
  }
  assert.deepEqual(cells(await frames(page)), before, "Escape put both back")
  assert.match(await live(page), /Radio is back where it was\./)
  await page.context().close()
})

test("19. Control+Z retires the put-away toast and says what came back; a tidy desk offers no Undo", async () => {
  const page = await makePage({ seed: { todos: JSON.stringify(TASKS), "lofai.theme": "light", "lofai.seen": "1" } })
  const before = cells(await frames(page))
  await page.getByRole("button", { name: "Move Focus timer" }).focus()
  await page.keyboard.press("Delete")
  await wait(page, 400)
  assert.match(await page.locator(".desk-toast").textContent(), /Focus timer is in the drawer\./)
  await page.keyboard.press("Control+z")
  await wait(page, 600)
  assert.equal(await page.locator(".desk-toast").count(), 0, "the toast's step is undone, so the toast goes")
  assert.match(await live(page), /Focus timer is back on the desk\./)
  assert.deepEqual(cells(await frames(page)), before)
  await page.locator("body").press("d")
  await wait(page, 500)
  // v3: Tidy up is gravity, and on the usual desk nothing would rise
  const tidy = page.locator("#desk-drawer").getByRole("button", { name: "Tidy up" })
  assert.ok(await tidy.isDisabled(), "the usual desk has nothing to tidy")
  assert.match(await page.locator("#desk-drawer-tidy").textContent(), /Already tidy\./)
  assert.equal(await page.locator(".desk-toast").count(), 0, "and nothing to undo")
  assert.deepEqual(cells(await frames(page)), before)
  await page.keyboard.press("Escape")
  await wait(page, 400)
  // with the cat away there's a hole at the top of the stack: Tidy up lifts
  // Tasks and the timer into it, keeping their column, as one undoable step
  await page.getByRole("button", { name: "Move Cat" }).focus()
  await page.keyboard.press("Delete")
  await wait(page, 600)
  await page.locator("body").press("d")
  await wait(page, 500)
  assert.equal(await tidy.isDisabled(), false, "now there's something to tidy")
  await tidy.click()
  await wait(page, 800)
  assert.deepEqual(cells(await frames(page)), { radio: "0,0", tasks: "4,0", timer: "4,2" }, "they rise and keep their column")
  assert.match(await page.locator(".desk-toast").textContent(), /Tidied up\./)
  await page.keyboard.press("Escape")
  await wait(page, 300)
  await page.locator("body").press("Control+z")
  await wait(page, 700)
  assert.deepEqual(cells(await frames(page)), { radio: "0,0", tasks: "4,1", timer: "4,3" }, "⌘Z puts them back")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("20. pins: the tack, P and the menu; pinned per bucket; Unpin from the menu; ⌘Z brings a pin back", async () => {
  const page = await makePage({ seed: SEEN })
  const pinned = id => page.evaluate(id => document.getElementById(`widget-${id}`).hasAttribute("data-pinned"), id)
  // v3 keeps each bucket's pins with its layout
  const pins = async () => Object.fromEntries(Object.entries(JSON.parse(await stored(page, "lofai.board") ?? "{}").layouts ?? {}).map(([b, l]) => [b, l.pins]))
  const before = cells(await frames(page))
  await page.locator("#widget-timer").hover()
  await page.getByRole("button", { name: "Pin Focus timer" }).click()
  await wait(page, 500)
  assert.equal(await pinned("timer"), true)
  assert.equal(await page.getByRole("button", { name: "Pin Focus timer" }).getAttribute("aria-pressed"), "true")
  assert.equal(await page.locator("#timer-state").textContent(), "Pinned in place.")
  assert.equal(await live(page), "Focus timer is pinned. It stays put while the others move.")
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Pin Focus timer", "focus stays on the tack")
  assert.deepEqual(cells(await frames(page)), before, "pinning moves nobody")
  // SPEC3 §5: a 24px circle set about 10px inside the card's top-right corner, with a 32px hit ring
  const tack = await page.evaluate(() => {
    const f = document.getElementById("widget-timer").getBoundingClientRect(), pin = document.querySelector("#widget-timer .wf-pin")
    const r = pin.getBoundingClientRect(), style = getComputedStyle(pin), hit = getComputedStyle(pin, "::before")
    return { w: r.width, h: r.height, top: Math.round(r.top - f.top), right: Math.round(f.right - r.right), round: style.borderRadius, hit: hit.width, fill: style.backgroundColor }
  })
  assert.deepEqual([tack.w, tack.h, tack.top, tack.right, tack.round, tack.hit], [24, 24, 10, 10, "50%", "32px"], `the tack's circle (${JSON.stringify(tack)})`)
  await wait(page, 400)
  assert.deepEqual((await pins()).desk, ["timer"])
  // another bucket has its own pins
  await page.setViewportSize({ width: 1024, height: 768 })
  await wait(page, 600)
  assert.equal(await pinned("timer"), false, "not pinned on the compact desk")
  await page.getByRole("button", { name: "Move Cat" }).focus()
  await page.keyboard.press("p")
  await wait(page, 600)
  assert.equal(await pinned("cat"), true, "P on a grip pins it")
  assert.equal(await live(page), "Cat is pinned. It stays put while the others move.")
  await page.setViewportSize({ width: 1440, height: 780 })
  await wait(page, 600)
  assert.equal(await pinned("timer"), true, "still pinned on the desk")
  assert.equal(await pinned("cat"), false)
  // the menu says it and can take the pin out
  await page.locator("#widget-timer").hover()
  await page.getByRole("button", { name: "Move Focus timer" }).click()
  assert.equal(await page.getByRole("menuitem", { name: /^Move/ }).first().isDisabled(), true, "Move is off while pinned")
  await page.getByRole("menuitem", { name: "Unpin" }).click()
  await wait(page, 600)
  assert.equal(await pinned("timer"), false, "Unpin took it out")
  assert.equal(await live(page), "Focus timer is unpinned. It can be moved again.")
  assert.deepEqual(cells(await frames(page)), before, "unpinning moves nobody either")
  await wait(page, 400)
  const after = await pins()
  assert.deepEqual([after.desk, after.compact], [[], ["cat"]], "the compact pin stays")
  await page.locator("body").press("Control+z")
  await wait(page, 600)
  assert.equal(await pinned("timer"), true, "⌘Z brings the pin back")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("21. on the phone a widget taken out goes back to its remembered spot", async () => {
  const page = await makePage({ width: 390, height: 844, touch: true, seed: { todos: JSON.stringify(TASKS), "lofai.theme": "ocean", "lofai.seen": "1" } })
  await page.getByRole("button", { name: "Move Radio" }).focus()
  // one slot down: the radio covers the cat, which swaps up into the radio's old top
  await page.keyboard.press("ArrowDown")
  await wait(page, 150)
  await page.keyboard.press("Enter")
  await wait(page, 800)
  const arranged = cells(await frames(page))
  assert.deepEqual(arranged, { cat: "0,0", radio: "0,1", tasks: "0,5", timer: "0,7" }, "the radio is under the cat")
  await page.getByRole("button", { name: "Move Radio" }).focus()
  await page.keyboard.press("Delete")
  await wait(page, 600)
  const away = cells(await frames(page))
  assert.deepEqual(away, { cat: "0,0", tasks: "0,5", timer: "0,7" }, "nobody closes up behind it")
  await page.keyboard.press("d")
  await wait(page, 600)
  assert.match(await page.locator("#desk-drawer .tile", { hasText: "Radio" }).textContent(), /goes back to its spot/)
  await page.locator("#desk-drawer").getByRole("button", { name: "Radio" }).click()
  await wait(page, 900)
  assert.deepEqual(cells(await frames(page)), arranged, "back where it was, not at the end")
  assert.match(await live(page), /^Radio is on the desk at column 1, row 2\./)
  assert.deepEqual(overlapping(await frames(page)), [])
  await page.context().close()
})

test("22. the cat sits on its own card, and petting it leaves nothing lifted once the pointer goes", async () => {
  const page = await makePage({ seed: { todos: JSON.stringify(TASKS), "lofai.theme": "light", "lofai.seen": "1" } })
  const surface = () => page.evaluate(() => {
    const body = document.querySelector("#widget-cat .wf-body"), style = getComputedStyle(body)
    return { background: style.backgroundColor, ring: style.boxShadow, grip: getComputedStyle(document.querySelector("#widget-cat .wf-grip")).opacity }
  })
  const rest = await surface()
  // SPEC3 §4: the quiet card surface and hairline ring every card has
  const card = await page.evaluate(() => {
    const frame = document.getElementById("widget-cat"), style = getComputedStyle(frame.querySelector(".wf-surface"))
    return { surface: frame.dataset.surface, fill: style.backgroundImage, ring: style.boxShadow }
  })
  assert.equal(card.surface, "card", "the cat has a card under it")
  assert.notEqual(card.fill, "none", "a filled card")
  assert.notEqual(card.ring, "none", "with the hairline ring")
  await page.locator("#widget-cat canvas").click()
  await page.mouse.move(700, 20)
  await wait(page, 400)
  assert.deepEqual(await surface(), rest, "after the click the cat is as it was at rest")
  await page.getByRole("button", { name: "Move Cat" }).focus()
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.press("Tab")
  await wait(page, 300)
  assert.notDeepEqual(await surface(), rest, "keyboard focus on its grip shows what you'd pick up")
  await page.context().close()
})

test("23. pairwise at 1440×800: every widget onto every other and into every open slot lands as planned", async () => {
  await pairwise(1440, 800)
})

test("24. pairwise at 1512×860: every drop lands as planned", async () => {
  await pairwise(1512, 860)
})

test("25. pairwise at 1280×720: every drop lands as planned", async () => {
  await pairwise(1280, 720)
})

test("26. pairwise at 1024×768 (compact, scrolled under the hand): every drop lands as planned", async () => {
  await pairwise(1024, 768)
})

test("27. pairwise at 390×844 by touch, from the grip and by a long press on the body: every drop lands as planned", async () => {
  await pairwise(390, 844, { touch: true })
  await pairwise(390, 844, { touch: true, long: true })
})

test("28. moved off on its own it stays there unpinned; a pinned grip resists; P while lifted pins where it's set down", async () => {
  const page = await makePage({ seed: SEEN })
  const pinned = id => page.evaluate(id => document.getElementById(`widget-${id}`).hasAttribute("data-pinned"), id)
  const tackShown = () => page.evaluate(() => document.querySelector(".desk-landing").hasAttribute("data-pin"))
  // SPEC3 §1: one slot down from the timer is open space under the stack
  await page.getByRole("button", { name: "Move Focus timer" }).focus()
  await page.keyboard.press("ArrowDown")
  await wait(page, 150)
  assert.match(await live(page), /^Picked up Focus timer\. Arrow keys move it one space, .* Escape puts it back\. Column 5, row 5\.$/)
  assert.deepEqual(await landingCell(page), { x: 4, y: 4 })
  assert.equal(await tackShown(), false, "no tack on the footprint in open space")
  await page.keyboard.press("ArrowRight")
  await wait(page, 120)
  assert.equal(await live(page), "That's the edge of the desk.")
  await page.keyboard.press("Enter")
  await wait(page, 800)
  assert.equal(cells(await frames(page)).timer, "4,4")
  assert.equal(await pinned("timer"), false, "set down apart from the rest, it is not pinned")
  assert.equal(await live(page), "Focus timer set down at column 5, row 5.")
  assert.equal(await page.locator(".desk-toast").count(), 0, "and no toast about a pin")
  // by the pointer too: the cat carried off into open space, a row clear of everyone
  await page.evaluate(() => scrollTo(0, 0))
  await wait(page, 200)
  const pitch = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector(".desk")); return { x: parseFloat(cs.getPropertyValue("--pitch-x")), y: parseFloat(cs.getPropertyValue("--pitch-y")) } })
  const grip = await center(page.locator("#widget-cat [data-grip]"))
  await drag(page, grip, { x: grip.x - 4 * pitch.x + 10, y: grip.y + 5 * pitch.y + 10 }, { steps: 30 })
  await wait(page, 900)
  const apart = await frames(page)
  assert.deepEqual(cells(apart), { radio: "0,0", tasks: "4,1", timer: "4,4", cat: "0,5" }, "it lands where it was dropped and nobody else moves")
  assert.equal(await pinned("cat"), false, "separated, still not pinned")
  assert.match(await live(page), /^Cat set down at column 1, row 6\.$/)
  assert.deepEqual(overlapping(apart), [])
  // a pinned grip: the arrows give a little and say how to move it
  await page.getByRole("button", { name: "Move Focus timer" }).focus()
  await page.keyboard.press("p")
  await wait(page, 600)
  assert.equal(await pinned("timer"), true, "P on its grip pins it")
  await page.keyboard.press("ArrowLeft")
  await wait(page, 150)
  assert.equal(await live(page), "Focus timer is pinned. Press P to unpin it.")
  assert.equal(await lifted(page), null, "a pinned widget isn't picked up")
  await page.keyboard.press("p")
  await wait(page, 600)
  assert.equal(await pinned("timer"), false)
  assert.equal(await live(page), "Focus timer is unpinned. It can be moved again.")
  // P while lifted: pinned wherever it's set down, and only then
  await page.getByRole("button", { name: "Move Tasks" }).focus()
  await page.keyboard.press("ArrowUp")
  await wait(page, 100)
  await page.keyboard.press("p")
  await wait(page, 100)
  assert.equal(await live(page), "It will be pinned where you set it down.")
  assert.equal(await tackShown(), true, "the footprint shows the tack")
  const at = await landingCell(page)
  await page.keyboard.press("Enter")
  await wait(page, 800)
  assert.equal(cells(await frames(page)).tasks, `${at.x},${at.y}`)
  assert.equal(await pinned("tasks"), true)
  assert.match(await live(page), /^Tasks set down at column \d, row \d\. It's pinned there\./)
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("29. resizing by the menu, by + and −, and by the corner handle morphs it to a standard size and says who moved", async () => {
  const page = await makePage({ seed: SEEN })
  const size = id => page.evaluate(id => document.getElementById(`widget-${id}`).dataset.size, id)
  await page.locator("#widget-tasks").hover()
  await page.getByRole("button", { name: "Move Tasks", exact: true }).click()
  await page.getByRole("menuitemradio", { name: /short/ }).click()
  await wait(page, 800)
  let all = await frames(page)
  assert.equal(await size("tasks"), "m")
  // v3: it changes size where it sits; nobody closes up under it
  assert.deepEqual(cells(all), { radio: "0,0", cat: "4,0", tasks: "4,1", timer: "4,3" })
  assert.equal(await live(page), "Short, 2 by 1.")
  assert.deepEqual(overlapping(all), [])
  // + on the grip: one size up
  await page.getByRole("button", { name: "Move Tasks", exact: true }).focus()
  await page.keyboard.press("+")
  await wait(page, 800)
  assert.equal(await size("tasks"), "l")
  assert.match(await live(page), /^List, 2 by 2\./)
  assert.deepEqual(cells(await frames(page)), { radio: "0,0", cat: "4,0", tasks: "4,1", timer: "4,3" }, "back as it was")
  await page.keyboard.press("+")
  await wait(page, 200)
  assert.equal(await live(page), "That's its biggest size.")
  // the corner handle: pulled in to half the width, the radio snaps to its ring
  await page.locator("#widget-radio").hover()
  const corner = await center(page.locator("#widget-radio [data-resize]"))
  let chip = null
  const pitch = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".desk")).getPropertyValue("--pitch-x")))
  await drag(page, corner, { x: corner.x - 2 * pitch, y: corner.y }, { steps: 16, hold: async () => {
    await wait(page, 200)
    chip = await page.evaluate(() => { const c = document.querySelector(".desk-chip"); return c.hasAttribute("data-on") ? c.dataset.label : null })
  } })
  await wait(page, 900)
  assert.equal(chip, "ring", "the size's name shows while it snaps")
  assert.equal(await size("radio"), "l")
  assert.match(await live(page), /^Ring, 2 by 2\./)
  all = await frames(page)
  assert.deepEqual(overlapping(all), [])
  const inline = await page.evaluate(() => [...document.querySelectorAll(".desk .wf, .desk .wf-surface, .desk .wf-content")].filter(e => e.style.scale || e.style.translate || e.style.opacity).length)
  assert.equal(inline, 0, "the morph comes to rest and clears its styles")
  await page.context().close()
})

test("30. the pocket notebook: taking it out focuses its page; typing never moves a widget; the page never lifts", async () => {
  const page = await makePage({ seed: { todos: JSON.stringify(TASKS), "lofai.theme": "light", "lofai.seen": "1" } })
  await page.locator("body").press("d")
  await wait(page, 600)
  await page.locator("#desk-drawer").getByRole("button", { name: /Pocket notebook/ }).click()
  await wait(page, 900)
  const area = page.locator("#widget-notebook textarea")
  assert.equal(await page.evaluate(() => document.activeElement?.matches("#widget-notebook textarea")), true, "focus is on the page")
  const before = await frames(page)
  for (let i = 1; i <= 8; i++) {
    await page.keyboard.type(`thought ${i}`)
    await page.keyboard.press("Enter")
  }
  await wait(page, 500)
  const after = await frames(page)
  for (const id of Object.keys(before)) {
    assert.equal(after[id].left, before[id].left, `${id} kept its column`)
    assert.equal(after[id].top, before[id].top, `${id} kept its row`)
  }
  assert.ok(after.notebook.height >= before.notebook.height, "it grew (or held) while focused, never shrank")
  // the page has scrolled: press on what's in view
  const box = await page.locator("#widget-notebook .notebook-scroll").boundingBox()
  let during = null
  await drag(page, { x: box.x + 10, y: box.y + box.height - 20 }, { x: box.x + 150, y: box.y + 20 }, { steps: 12, hold: async () => { during = await lifted(page) } })
  assert.equal(during, null, "a drag on the page selects words, it doesn't lift")
  assert.ok(await area.evaluate(el => el.selectionEnd > el.selectionStart), "words got selected")
  assert.equal(JSON.parse(await stored(page, "lofai.notebook")).text.split("\n")[0], "thought 1", "saved")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("31. make it a task moves the caret's line to Tasks; Undo brings back both", async () => {
  const page = await makePage({ seed: { todos: JSON.stringify(TASKS), "lofai.theme": "light", "lofai.seen": "1",
    "lofai.notebook": JSON.stringify({ v: 1, text: "keep this\n- buy oats\nand this", updatedAt: 1 }) } })
  await page.locator("body").press("d")
  await wait(page, 600)
  await page.locator("#desk-drawer").getByRole("button", { name: /Pocket notebook/ }).click()
  await wait(page, 900)
  const area = page.locator("#widget-notebook textarea")
  await area.evaluate(el => el.setSelectionRange(12, 12))
  await page.keyboard.press("Control+Enter")
  await wait(page, 600)
  assert.equal(await area.inputValue(), "keep this\nand this")
  assert.equal(JSON.parse(await stored(page, "todos")).at(-1).text, "buy oats")
  const toast = page.locator(".desk-toast")
  assert.match(await toast.textContent(), /Thought moved to tasks\./)
  await toast.getByRole("button", { name: "Undo" }).click()
  await wait(page, 600)
  assert.equal(await area.inputValue(), "keep this\n- buy oats\nand this")
  assert.deepEqual(JSON.parse(await stored(page, "todos")).map(t => t.text), TASKS.map(t => t.text))
  assert.equal(JSON.parse(await stored(page, "lofai.notebook")).text, "keep this\n- buy oats\nand this")
  await page.context().close()
})

// every widget out, from the drawer's order
const ALL_OUT = JSON.stringify({ v: 1, instances: Object.fromEntries(["radio", "sound", "tasks", "timer", "cat", "desk-task", "notebook", "clock", "today"].map(t => [t, { type: t, onDesk: true }])), layouts: {}, savedAt: 1 })
const focusedName = page => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null)

test("32. the drawer always opens at its first tile, with focus on a tile in view", async () => {
  for (const [width, height, touch] of [[1024, 768, false], [390, 844, true]]) {
    const page = await makePage({ width, height, touch, seed: SEEN })
    if (touch) {
      await page.locator("#widget-timer .wf-grip").tap()
      await wait(page, 300)
      await page.getByRole("menuitem", { name: "Put in the drawer" }).tap()
    } else {
      await page.getByRole("button", { name: "Move Focus timer" }).focus()
      await page.keyboard.press("Delete")
    }
    await wait(page, 600)
    if (touch) await page.locator(".drawer-pull").tap()
    else await page.keyboard.press("d")
    await wait(page, 700)
    const row = await page.evaluate(() => {
      const row = document.querySelector(".drawer-tiles"), a = document.activeElement.getBoundingClientRect(), r = row.getBoundingClientRect()
      return { scroll: row.scrollLeft, inside: a.left >= r.left && a.right <= r.right, name: document.activeElement.querySelector(".tile-name")?.textContent }
    })
    assert.deepEqual(row, { scroll: 0, inside: true, name: "Focus timer" }, `${width}: the widget just put away is first, in view, with focus`)
    await page.context().close()
  }
})

test("33. carried out of the drawer onto the Radio, a notebook comes in beside it and the radio isn't shoved; it's brought into view", async () => {
  const page = await makePage({ seed: SEEN })
  const before = await frames(page)
  await page.locator("body").press("d")
  await wait(page, 600)
  const item = page.locator("#desk-drawer .drawer-item", { hasText: "Pocket notebook" })
  await item.getByRole("radio", { name: "page" }).click()
  const tile = await center(item.locator(".tile"))
  await drag(page, tile, { x: before.radio.left + 120, y: before.radio.top + 120 }, { steps: 24, hold: () => wait(page, 300) })
  await wait(page, 1200)
  const after = await frames(page)
  assert.ok(after.notebook, "the notebook is on the desk")
  assert.equal(await page.locator("#widget-notebook").getAttribute("data-size"), "l")
  // a widget never shoves a bigger one: the full desk has no room in view, so
  // it comes in at the nearest spot that takes it, under the radio
  assert.deepEqual(cells(after), { ...cells(before), notebook: "0,4" }, "the radio and the rest stay put")
  assert.deepEqual(overlapping(after), [])
  assert.match(await live(page), /^Pocket notebook is on the desk at column 1, row 5\.$/)
  assert.ok(after.notebook.bottom - await page.evaluate(() => scrollY) <= 780, "brought into view")
  await page.context().close()
})

test("34. taken out by click, widgets settle among the desk in view, not in a tower down its left edge", async () => {
  for (const [width, height, fold] of [[1440, 780, 720], [1280, 720, 660]]) {
    const page = await makePage({ width, height, seed: SEEN })
    const start = await frames(page)
    const left = Math.min(...Object.values(start).map(f => f.x))
    const xs = []
    for (const [name, id] of [["On the desk", "desk-task"], ["Pocket notebook", "notebook"], ["Clock", "clock"], ["Today", "today"]]) {
      await page.evaluate(() => scrollTo(0, 0))
      await page.locator(".drawer-pull").click()
      await wait(page, 600)
      await page.locator("#desk-drawer .tile", { hasText: name }).click()
      await wait(page, 1200)
      const f = (await frames(page))[id]
      xs.push(f.x)
      assert.ok(f.x >= left, `${width}: ${id} at column ${f.x}, inside the desk's columns (from ${left})`)
      // it's in view, clear of the pull, once it has settled
      assert.ok(f.bottom - await page.evaluate(() => scrollY) <= fold + 0.5, `${width}: ${id} ends at ${f.bottom - await page.evaluate(() => scrollY)}, past ${fold}`)
    }
    assert.ok(new Set(xs).size >= 3, `${width}: spread across the desk (${xs})`)
    assert.deepEqual(overlapping(await frames(page)), [])
    await page.context().close()
  }
})

test("35. the first task put on the desk: on a phone On the desk comes in after the timer and the list stays under the finger; it's called Task card when said", async () => {
  const page = await makePage({ width: 390, height: 844, touch: true, seed: SEEN })
  await page.locator(".task-row", { hasText: "Draft the intro" }).scrollIntoViewIfNeeded()
  const listTop = (await page.locator("#widget-tasks").boundingBox()).y
  await page.getByRole("button", { name: "Put Draft the intro paragraph on the desk" }).tap()
  await wait(page, 900)
  // v3: the phone's desk is radio (tall), cat, tasks, timer; it comes in at the
  // free spot nearest the timer, just under it
  assert.equal(await stackOrder(page), "radio,cat,tasks,timer,desk-task")
  assert.equal(cells(await frames(page))["desk-task"], "0,8")
  assert.equal(await live(page), "Task card is on the desk at column 1, row 9.")
  assert.equal(Math.round((await page.locator("#widget-tasks").boundingBox()).y), Math.round(listTop), "the list stays under the finger")
  // it lands two rows below the list (row 9). the page doesn't leave the list the finger is on to show it; the words
  // say where it is, and the key in the row now takes it off again
  assert.equal(await page.getByRole("button", { name: "Take Draft the intro paragraph off the desk" }).count(), 1)
  assert.deepEqual(overlapping(await frames(page)), [])
  // on the desk at 1280×720, the first task card ends in view once it has grown to fit
  const grid = await makePage({ width: 1280, height: 720, seed: SEEN })
  await grid.locator(".task-row", { hasText: "Draft the intro" }).hover()
  await grid.getByRole("button", { name: "Put Draft the intro paragraph on the desk" }).click()
  await wait(grid, 1400)
  const f = (await frames(grid))["desk-task"]
  assert.ok(f.bottom - await grid.evaluate(() => scrollY) <= 660.5, `it ends clear of the pull (${f.bottom - await grid.evaluate(() => scrollY)})`)
  assert.equal(await focusedName(grid), "Take Draft the intro paragraph off the desk", "focus stays on the key")
  assert.doesNotMatch(await live(grid), /On the desk is/)
  await page.context().close()
  await grid.context().close()
})

test("36. a block landing with the timer and On the desk both out is said once; ⌘Z after its [done] takes the done back", async () => {
  const page = await makePage({ seed: SEEN })
  await page.evaluate(() => {
    const real = Date.now.bind(Date)
    window.__skew = 0
    Date.now = () => real() + window.__skew
    window.__said = []
    new MutationObserver(() => window.__said.push(document.getElementById("desk-live").textContent.trim()))
      .observe(document.getElementById("desk-live"), { childList: true, characterData: true, subtree: true })
  })
  await page.locator(".task-row", { hasText: "Draft the intro" }).hover()
  await page.getByRole("button", { name: "Put Draft the intro paragraph on the desk" }).click()
  await wait(page, 900)
  await page.getByRole("button", { name: "Start timer" }).click()
  await wait(page, 300)
  await page.evaluate(() => { window.__skew = 26 * 60 * 1000 })
  await wait(page, 1200)
  const said = await page.evaluate(() => window.__said.filter(t => /nicely done/.test(t)))
  assert.deepEqual(said, ["25 minutes with Draft the intro paragraph. nicely done."], "said once, by name")
  assert.equal(JSON.parse(await stored(page, "todos")).find(t => t.id === "t1").done, false, "a landing completes nothing")
  await page.evaluate(() => { window.__skew = 0 })
  await page.locator('#widget-desk-task [data-dt="done"]').click()
  await wait(page, 1500)
  assert.match(await page.locator(".desk-toast").textContent(), /Nicely done\./)
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+z`)
  await wait(page, 800)
  assert.equal(JSON.parse(await stored(page, "todos")).find(t => t.id === "t1").done, false, "the task is open again")
  assert.equal(await page.locator("#widget-desk-task").count(), 1, "On the desk stays on the desk")
  assert.equal(await page.locator("#widget-desk-task .dt-text").textContent(), "Draft the intro paragraph", "and holds it again")
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY", "focus has somewhere to be")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("37. focus is never lost: reduced motion opens the drawer onto its first tile; Esc from the desk stays put; ⌘Z sending a widget away moves on", async () => {
  const page = await makePage({ seed: SEEN, reducedMotion: "reduce" })
  await page.getByRole("button", { name: "Move Focus timer" }).focus()
  await page.keyboard.press("d")
  await wait(page, 300)
  assert.equal(await page.evaluate(() => document.activeElement?.className), "tile", "D from a grip")
  await page.keyboard.press("Escape")
  await wait(page, 200)
  await page.getByRole("button", { name: "Menu" }).click()
  await page.getByRole("menuitem", { name: /Widget drawer/ }).click()
  await wait(page, 300)
  assert.equal(await page.evaluate(() => document.activeElement?.className), "tile", "the Menu")
  // working in the desk with the drawer open: Esc closes it and leaves focus there
  await page.getByRole("textbox", { name: "New task" }).focus()
  await page.keyboard.type("half a thought")
  await page.keyboard.press("Escape")
  await wait(page, 200)
  assert.equal(await page.locator("#desk-drawer").getAttribute("data-open"), null)
  assert.equal(await focusedName(page), "New task")
  assert.equal(await page.getByRole("textbox", { name: "New task" }).inputValue(), "half a thought")
  // taken out, then undone: focus goes on to the next grip, not the page
  await page.locator("body").click({ position: { x: 5, y: 5 } })
  await page.keyboard.press("d")
  await wait(page, 300)
  await page.locator("#desk-drawer .tile", { hasText: "Clock" }).press("Enter")
  await wait(page, 600)
  assert.equal(await focusedName(page), "Move Clock")
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+z`)
  await wait(page, 400)
  assert.equal(await live(page), "Clock is in the drawer.")
  assert.match(await focusedName(page), /^Move /, "focus is on another grip")
  await page.context().close()
})

test("38. make it a task keeps the line when Tasks can't save it, even when this add is the first to fail", async () => {
  const page = await makePage({ seed: { ...SEEN, "lofai.notebook": JSON.stringify({ v: 1, text: "call the dentist\nbuy stamps", updatedAt: 1 }) } })
  await page.locator("body").press("d")
  await wait(page, 600)
  await page.locator("#desk-drawer").getByRole("button", { name: /Pocket notebook/ }).click()
  await wait(page, 900)
  // the next write of the list fails, as a full browser's would
  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) { if (key === "todos") throw new DOMException("full", "QuotaExceededError"); return set.call(this, key, value) }
  })
  await page.locator("#widget-notebook textarea").evaluate(el => el.setSelectionRange(20, 20))
  await page.keyboard.press("Control+Enter")
  await wait(page, 900)
  assert.equal(await page.locator("#widget-notebook textarea").inputValue(), "call the dentist\nbuy stamps", "the line stays on the page")
  assert.match(await page.locator(".desk-toast").textContent(), /Copied to tasks/)
  assert.equal(JSON.parse(await stored(page, "lofai.notebook")).text, "call the dentist\nbuy stamps")
  await page.context().close()
})

test("39. a v2 save comes in as v3: who's out and their sizes kept, its flow layout and auto-pins dropped, the old save backed up", async () => {
  // a v2 desk whose drags had auto-pinned the cat and Today (the pins the user didn't ask for)
  const v2 = JSON.stringify({ v: 2, instances: { radio: { type: "radio", onDesk: true }, cat: { type: "cat", onDesk: true }, tasks: { type: "tasks", onDesk: true },
    timer: { type: "timer", onDesk: true }, today: { type: "today", onDesk: true }, clock: { type: "clock", onDesk: false } },
    order: ["radio", "cat", "tasks", "timer", "today", "clock"], sizes: { radio: "xl", cat: "s", tasks: "m", timer: "m", today: "m", clock: "s" },
    pins: { desk: { cat: { x: 0, y: 2 }, today: { x: 1, y: 3 } } }, savedAt: 1 })
  const page = await makePage({ seed: { ...SEEN, "lofai.board": v2 } })
  const all = await frames(page)
  assert.deepEqual(Object.keys(all).sort(), ["cat", "radio", "tasks", "timer", "today"], "the same widgets are out")
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".desk > .wf")].map(f => `${f.dataset.type}:${f.dataset.size}`).sort()),
    ["cat:s", "radio:xl", "tasks:m", "timer:m", "today:m"], "their sizes kept, the radio full")
  assert.equal(await page.locator(".desk [data-pinned]").count(), 0, "no pin survives")
  assert.equal(await page.locator(".desk [data-perched]").count(), 0, "and the perch is gone")
  assert.equal(cells(all).radio, "0,0", "the usual desk's radio, top left")
  assert.deepEqual(overlapping(all), [])
  // the first change writes v3, and keeps the raw v2 save beside it
  await page.locator("#widget-timer").hover()
  await page.getByRole("button", { name: "Pin Focus timer" }).click()
  await wait(page, 1200)
  const saved = JSON.parse(await stored(page, "lofai.board"))
  assert.equal(saved.v, 3)
  assert.deepEqual(saved.layouts.desk.pins, ["timer"])
  assert.equal(await stored(page, "lofai.board.v2"), v2, "the v2 save is backed up as it was")
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("40. the cat grows in place and the column goes down, said by name; lifted, + then a step names who moved; the radio is never shoved by a step", async () => {
  const page = await makePage({ seed: SEEN })
  await page.getByRole("button", { name: "Move Cat", exact: true }).focus()
  await page.keyboard.press("+")
  await wait(page, 800)
  let all = await frames(page)
  // it stays under the hand: its top-left kept, Tasks and the timer go down in order
  assert.deepEqual(cells(all), { radio: "0,0", cat: "4,0", tasks: "4,2", timer: "4,4" }, "it grows where it is")
  assert.equal(await page.evaluate(() => document.getElementById("widget-cat").dataset.size), "l")
  assert.match(await live(page), /^Big, 2 by 2\. Tasks and Focus timer move to make room\.$/)
  assert.deepEqual(overlapping(all), [])
  // and back down: it stays put, nobody closes up under it
  await page.keyboard.press("-")
  await wait(page, 800)
  assert.deepEqual(cells(await frames(page)), { radio: "0,0", cat: "4,0", tasks: "4,2", timer: "4,4" }, "smaller, in place")
  await page.context().close()
  // lifted: down past Tasks, +, back up, set down. who moved is counted from pickup
  const lift = await makePage({ seed: SEEN })
  await lift.getByRole("button", { name: "Move Cat", exact: true }).focus()
  for (const key of ["ArrowDown", "+", "ArrowUp"]) { await lift.keyboard.press(key); await wait(lift, 150) }
  assert.match(await live(lift), /^Column 5, row 1\. Tasks and Focus timer move to make room\.$/)
  await lift.keyboard.press("Enter")
  await wait(lift, 800)
  all = await frames(lift)
  assert.deepEqual(cells(all), { radio: "0,0", cat: "4,0", tasks: "4,2", timer: "4,4" }, "the same as + where it sat")
  assert.match(await live(lift), /^Cat set down at column 5, row 1\. Big, 2 by 2\. Tasks and Focus timer move to make room\.$/)
  await lift.context().close()
  // the timer's first arrow left is the radio: it resists rather than shoving it below the fold
  const fresh = await makePage({ seed: SEEN })
  await fresh.getByRole("button", { name: "Move Focus timer" }).focus()
  await fresh.keyboard.press("ArrowLeft")
  await wait(fresh, 150)
  assert.match(await live(fresh), /Radio is in the way\.$/)
  await fresh.keyboard.press("Enter")
  await wait(fresh, 800)
  assert.deepEqual(cells(await frames(fresh)), { radio: "0,0", cat: "4,0", tasks: "4,1", timer: "4,3" })
  assert.equal(await fresh.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, "nothing past the fold")
  await fresh.context().close()
})

test("41. reduced motion: a widget just moved aside is picked up from where it is, and the footprint shows over whoever's there", async () => {
  const page = await makePage({ seed: SEEN, reducedMotion: "reduce" })
  const pitch = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector(".desk")); return { x: parseFloat(cs.getPropertyValue("--pitch-x")), y: parseFloat(cs.getPropertyValue("--pitch-y")) } })
  const footprint = () => page.evaluate(() => {
    const el = document.querySelector(".desk-landing"), r = el.getBoundingClientRect()
    return { z: getComputedStyle(el).zIndex, shown: getComputedStyle(el).opacity, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  })
  // the cat onto the timer: the two trade places
  const cat = await center(page.locator("#widget-cat [data-grip]"))
  // held a moment, so the timer's preview has shown before the drop
  await drag(page, cat, { x: cat.x, y: cat.y + 3 * pitch.y }, { steps: 16, hold: () => wait(page, 300) })
  await wait(page, 500)
  assert.deepEqual(cells(await frames(page)), { radio: "0,0", cat: "4,3", tasks: "4,1", timer: "4,0" })
  assert.equal(await translateOf(page, "timer"), "none", "nothing drawn off its slot")
  // the timer, just moved aside, carried back down: the footprint is under the hand, over the cat
  const timer = await center(page.locator("#widget-timer [data-grip]"))
  let seen = null
  await drag(page, timer, { x: timer.x, y: timer.y + 3 * pitch.y }, { steps: 16, hold: async () => {
    await wait(page, 120)
    seen = { cell: await landingCell(page), foot: await footprint(), under: await page.evaluate(() => document.getElementById("widget-cat").getBoundingClientRect().top) }
  } })
  assert.deepEqual(seen.cell, { x: 4, y: 3 }, "the footprint is where the hand is")
  assert.equal(seen.foot.z, "41", "lifted over the cat that's still sitting there")
  assert.equal(seen.foot.shown, "1")
  await wait(page, 600)
  assert.deepEqual(cells(await frames(page)), { radio: "0,0", cat: "4,0", tasks: "4,1", timer: "4,3" }, "the second drop lands too")
  assert.match(await live(page), /^Focus timer set down at column 5, row 4\. Cat moves to make room\.$/)
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

test("42. the bottom widget's menu opens above its grip, and a top-row pin's ring stays in the window", async () => {
  const page = await makePage({ width: 1440, height: 800, seed: SEEN })
  await page.locator("#widget-timer").hover()
  await page.getByRole("button", { name: "Move Focus timer", exact: true }).click()
  const fit = await page.evaluate(() => {
    const m = document.querySelector(".grip-menu").getBoundingClientRect(), g = document.querySelector("#widget-timer [data-grip]").getBoundingClientRect()
    return { top: m.top, bottom: m.bottom, grip: g.top, tall: document.documentElement.scrollHeight }
  })
  assert.ok(fit.bottom <= 800 - 8 && fit.top >= 8, `menu ${fit.top}-${fit.bottom}`)
  assert.ok(fit.bottom <= fit.grip, "it opens above the grip")
  assert.equal(fit.tall, 800, "the page doesn't grow to hold it")
  await page.keyboard.press("Escape")
  // the cat, pinned in the top row and tugged: the ring round its slot stays in the window
  await page.getByRole("button", { name: "Move Cat" }).focus()
  await page.keyboard.press("p")
  await wait(page, 400)
  const cat = await page.locator("#widget-cat").boundingBox()
  await drag(page, { x: cat.x + 60, y: cat.y + cat.height - 30 }, { x: cat.x + 200, y: cat.y + cat.height + 20 }, { steps: 10 })
  await wait(page, 100)
  const ring = await page.evaluate(() => {
    const el = document.querySelector(".desk-held"), r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return { top: r.top - parseFloat(s.outlineOffset) - parseFloat(s.outlineWidth), held: el.getAttribute("data-held") }
  })
  assert.equal(ring.held, "tug", "the ring is up")
  assert.ok(ring.top >= 4, `ring top ${ring.top}`)
  await page.context().close()
})

// the untouched desk is full: nothing can just slide into open space, so this
// is where drops used to slip back down their own column
test("43. on the usual desk as it first loads, a widget let go over the Radio lands there and they trade sides; over a neighbour's lower half it lands on that neighbour", async () => {
  for (const [width, height] of [[1440, 800], [1512, 860]]) {
    for (const [id, grab] of [["cat", "grip"], ["tasks", "grip"], ["timer", "body"], ["cat", "body"]]) {
      const page = await makePage({ width, height, seed: SEEN })
      const all = await frames(page), me = all[id], radio = all.radio
      const g = await page.locator(`#widget-${id} [data-grip]`).boundingBox()
      // by the grip, or by its header (the label every card has)
      const from = grab === "grip" ? { x: g.x + g.width / 2, y: g.y + g.height / 2 } : { x: me.left + 30, y: me.top + 20 }
      // over the radio's left half, a little below its middle: an ordinary, imprecise drop
      const to = { x: radio.left + radio.width * 0.3, y: radio.top + radio.height * 0.6 }
      await drag(page, from, to, { steps: 12 })
      await wait(page, 700)
      const after = await frames(page), mine = after[id]
      assert.ok(to.x >= mine.left && to.x <= mine.right, `${width}×${height} ${id} by its ${grab}: it lands on the side it was let go (${mine.left}-${mine.right} vs ${to.x})`)
      assert.ok(Math.abs(mine.top + mine.height / 2 - to.y) <= mine.height / 2 + all.cat.height, `${width}×${height} ${id}: near the row it was let go`)
      assert.equal(after.radio.x, 2, `${width}×${height} ${id}: the radio steps over to make room`)
      assert.deepEqual(overlapping(after), [], "nothing overlaps")
      assert.ok(/set down/.test(await live(page)), `said "${await live(page)}"`)
      assert.deepEqual(page.errors, [])
      await page.context().close()
    }
  }
  // Tasks held by its grip and let go low over the cat: it takes the cat's row
  const page = await makePage({ width: 1440, height: 800, seed: SEEN })
  const all = await frames(page), g = await page.locator("#widget-tasks [data-grip]").boundingBox()
  await drag(page, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, { x: all.cat.left + all.cat.width / 2, y: all.cat.bottom - 12 }, { steps: 12 })
  await wait(page, 700)
  const after = cells(await frames(page))
  assert.equal(after.tasks, "4,0", "Tasks over the cat's lower half: on the cat's row")
  assert.equal(after.cat, "4,2", "and the cat moves into the room it left")
  await page.context().close()
})

// how far the frame's box strays, every animation frame for `ms`, and where
// it ends up; and any transform left on it, its surface or its content
const stillness = (page, id, ms) => page.evaluate(([id, ms]) => new Promise(done => {
  const el = document.getElementById(`widget-${id}`), parts = [el, el.querySelector(".wf-surface"), el.querySelector(".wf-content")]
  const first = el.getBoundingClientRect()
  const off = r => Math.max(Math.abs(r.left - first.left), Math.abs(r.top - first.top), Math.abs(r.width - first.width), Math.abs(r.height - first.height))
  let most = 0, styled = ""
  const start = performance.now()
  const look = () => {
    most = Math.max(most, off(el.getBoundingClientRect()))
    for (const p of parts) if (p && (p.style.translate || p.style.scale || p.style.rotate)) styled = `${p.className}: ${p.style.translate} ${p.style.scale} ${p.style.rotate}`
    if (performance.now() - start < ms) requestAnimationFrame(look)
    else done({ most, styled, end: off(el.getBoundingClientRect()) })
  }
  requestAnimationFrame(look)
}), [id, ms])
// the ring of dots round a slot: how it's showing and where
const ringOf = page => page.evaluate(() => {
  const el = document.querySelector(".desk-held"), s = getComputedStyle(el)
  return { held: el.getAttribute("data-held"), x: +s.getPropertyValue("--x"), y: +s.getPropertyValue("--y") }
})

test("44. pinning or unpinning never moves the widget: only the tack taps in and a ring of dots draws in round its slot (or lets go); no words; tugged or nudged, it still gives and springs back", async () => {
  const page = await makePage({ width: 1440, height: 800, seed: SEEN })
  const pinned = id => page.evaluate(id => document.getElementById(`widget-${id}`).hasAttribute("data-pinned"), id)
  const still = async (what, id, act, ms = 900) => {
    const watching = stillness(page, id, ms)
    await act()
    const r = await watching
    assert.equal(r.most, 0, `${what}: ${id} moved ${r.most}px`)
    assert.equal(r.styled, "", `${what}: ${id} was transformed (${r.styled})`)
  }
  const gives = async (what, id, act, ms = 1400) => {
    const watching = stillness(page, id, ms)
    await act()
    const r = await watching
    assert.ok(r.most >= 3 && r.most <= 30, `${what}: ${id} gave ${r.most}px`)
    assert.ok(r.end < 0.5, `${what}: ${id} came back (${r.end}px off)`)
  }
  await page.locator("#widget-timer").hover()
  const tack = page.getByRole("button", { name: "Pin Focus timer" })
  const watchTack = page.evaluate(() => new Promise(done => {
    const t = document.querySelector("#widget-timer .wf-pin-glyphs"), ring = document.querySelector(".desk-held"), start = performance.now()
    let moved = false, held = false
    const look = () => {
      if (t.style.translate || t.style.scale) moved = true
      if (ring.getAttribute("data-held") === "pin" && +getComputedStyle(ring).opacity > 0.5) held = true
      performance.now() - start < 600 ? requestAnimationFrame(look) : done({ moved, held })
    }
    requestAnimationFrame(look)
  }))
  await still("pinned by the tack", "timer", () => tack.click())
  const seen = await watchTack
  assert.equal(await pinned("timer"), true)
  assert.ok(seen.moved, "the tack itself still taps in")
  assert.ok(seen.held, "a ring of dots draws in round it")
  assert.deepEqual(await ringOf(page), { held: "pin", x: 4, y: 3 }, "round the timer's slot")
  assert.equal(await page.evaluate(() => document.querySelector("#widget-timer .wf-chip")), null, "no words")
  await wait(page, 1000)
  const letGo = page.evaluate(() => new Promise(done => {
    const ring = document.querySelector(".desk-held"), start = performance.now(), seen = new Set()
    const look = () => { if (ring.hasAttribute("data-held")) seen.add(ring.getAttribute("data-held")); performance.now() - start < 400 ? requestAnimationFrame(look) : done([...seen]) }
    requestAnimationFrame(look)
  }))
  await still("unpinned by the tack", "timer", () => tack.click())
  assert.equal(await pinned("timer"), false)
  assert.deepEqual(await letGo, ["unpin"], "unpinned, a fainter ring lets go")
  await page.getByRole("button", { name: "Move Radio" }).focus()
  await still("pinned with P", "radio", () => page.keyboard.press("p"))
  assert.equal(await pinned("radio"), true)
  await wait(page, 2600)
  // trying to move it: it gives a little and springs back, and says how
  await gives("arrows on a pinned grip", "radio", () => page.keyboard.press("ArrowRight"))
  const r = (await frames(page)).radio
  let ring = null
  await gives("tugged", "radio", async () => {
    await drag(page, { x: r.left + 30, y: r.top + 20 }, { x: r.left + 150, y: r.top + 90 }, { steps: 10 })
    ring = await ringOf(page)
  })
  assert.deepEqual(ring, { held: "tug", x: 0, y: 0 }, "tugged, the slot it's held to shows")
  assert.equal(await live(page), "Radio is pinned. Unpin it to move it.", "the live region says how to move it")
  assert.deepEqual(cells(await frames(page)).radio, "0,0", "still where it was pinned")
  await page.getByRole("button", { name: "Move Radio" }).focus()
  await still("unpinned with P", "radio", () => page.keyboard.press("p"))
  assert.equal(await pinned("radio"), false)
  assert.deepEqual(page.errors, [])
  await page.context().close()
})

try {
  const filter = process.env.DESK_TEST_FILTER ? new RegExp(process.env.DESK_TEST_FILTER) : null
  assert.ok(tests.some(entry => !filter || filter.test(entry.name)), "No desk tests matched DESK_TEST_FILTER")
  for (const entry of tests) {
    if (filter && !filter.test(entry.name)) continue
    try { await entry.run(); console.log(`PASS  ${entry.name}`) }
    catch (error) { failures.push(entry.name); console.error(`FAIL  ${entry.name}\n${error.stack}`) }
  }
} finally { await browser.close() }

assert.equal(failures.length, 0, `${failures.length} desk browser check(s) failed`)
