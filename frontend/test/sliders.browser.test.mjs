/**
 * Browser regression checks for the shared music / Pomodoro sliders.
 * Serve a production export before running; this never starts the music backend.
 *
 * SLIDER_TEST_BASE_URL=http://127.0.0.1:3013 node test/sliders.browser.test.mjs
 * Optional: PLAYWRIGHT_MODULE_PATH (an existing Playwright installation),
 * CHROME_EXECUTABLE (otherwise Playwright's Chromium), SLIDER_TEST_FILTER.
 * No Playwright dependency is required by the application itself.
 */
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const baseURL = process.env.SLIDER_TEST_BASE_URL
assert.ok(baseURL, "Serve frontend/out and set SLIDER_TEST_BASE_URL before running this browser test.")
const baseOrigin = new URL(baseURL).origin
const { chromium } = process.env.PLAYWRIGHT_MODULE_PATH
  ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH)
  : await import("playwright")
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || undefined })
const names = ["style match", "variation", "volume", "Work", "Rest"]
const neutrals = { "style match": 50, variation: 50, Work: 25, Rest: 5 }
const tests = []
const failures = []
const test = (name, run) => tests.push({ name, run })

async function makePage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options })
  // Every external request is blocked: no account, model, or service is needed.
  await context.route("**/*", route => new URL(route.request().url()).origin === baseOrigin ? route.continue() : route.abort())
  const page = await context.newPage()
  await page.goto(baseURL, { waitUntil: "networkidle" })
  await page.getByRole("slider", { name: "volume", exact: true }).waitFor()
  return page
}

function rail(page, name) { return page.getByRole("slider", { name, exact: true }) }

async function samples(slider, count = 1) {
  return slider.evaluate(async (element, count) => {
    const frames = []
    for (let i = 0; i < count; i++) {
      await new Promise(requestAnimationFrame)
      const rect = element.getBoundingClientRect()
      const thumb = element.querySelector(".fine-dial-thumb").getBoundingClientRect()
      const fill = element.querySelector(".fine-dial-fill").getBoundingClientRect()
      const notch = element.querySelector(".fine-dial-notch")
      const value = Number(element.getAttribute("aria-valuenow"))
      const min = Number(element.getAttribute("aria-valuemin"))
      const max = Number(element.getAttribute("aria-valuemax"))
      frames.push({
        time: performance.now(), value, min, max, width: rect.width,
        target: (value - min) / (max - min) * rect.width,
        thumb: (thumb.left + thumb.right) / 2 - rect.left,
        fillStart: fill.left - rect.left, fillEnd: fill.right - rect.left,
        anchor: notch ? parseFloat(getComputedStyle(notch).left) : 0,
        held: element.parentElement.classList.contains("is-held"),
      })
    }
    return frames
  }, count)
}

function coherent(frames, label) {
  for (const frame of frames) {
    const expectedStart = Math.min(frame.anchor, frame.thumb)
    const expectedEnd = Math.max(frame.anchor, frame.thumb)
    assert.ok(Math.abs(frame.fillStart - expectedStart) < 1.5,
      `${label}: fill start ${frame.fillStart.toFixed(2)} disconnected from ${expectedStart.toFixed(2)}`)
    assert.ok(Math.abs(frame.fillEnd - expectedEnd) < 1.5,
      `${label}: fill end ${frame.fillEnd.toFixed(2)} disconnected from ${expectedEnd.toFixed(2)}`)
  }
}

async function settle(slider) {
  await slider.evaluate(async element => {
    const deadline = performance.now() + 1600
    let stable = 0
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame)
      const thumb = element.querySelector(".fine-dial-thumb")
      const value = Number(element.getAttribute("aria-valuenow"))
      const min = Number(element.getAttribute("aria-valuemin"))
      const max = Number(element.getAttribute("aria-valuemax"))
      const target = (value - min) / (max - min) * element.getBoundingClientRect().width
      const thumbRect = thumb.getBoundingClientRect()
      const position = (thumbRect.left + thumbRect.right) / 2 - element.getBoundingClientRect().left
      if (Math.abs(position - target) < 0.08) stable++
      else stable = 0
      if (stable >= 5) return
    }
    throw new Error("Slider did not settle at its accessible value")
  })
  coherent(await samples(slider), "settled slider")
}

async function key(page, slider, name, wait = true) {
  await slider.scrollIntoViewIfNeeded()
  await slider.focus()
  await page.keyboard.press(name)
  if (wait) await settle(slider)
}

async function point(slider, fraction) {
  await slider.scrollIntoViewIfNeeded()
  const rect = await slider.boundingBox()
  return { x: rect.x + rect.width * fraction, y: rect.y + rect.height / 2 }
}

async function click(page, slider, fraction) {
  const { x, y } = await point(slider, fraction)
  await page.mouse.click(x, y)
}

let page

for (const name of names) {
  test(`${name}: track click with 1px pointer jitter keeps gliding`, async () => {
    const slider = rail(page, name)
    await key(page, slider, "Home")
    const { x, y } = await point(slider, 0.85)
    await page.mouse.move(x, y)
    await page.mouse.down()
    try {
      const initial = await samples(slider, 2)
      const before = initial.at(-1)
      assert.ok(Math.abs(before.thumb - before.target) > before.width * 0.25,
        "The click should still be visibly in flight before jitter")
      await page.mouse.move(x + 1, y)
      const after = await samples(slider, 2)
      coherent([...initial, ...after], `${name} click/jitter`)
      assert.equal(after[0].value, before.value, "Sub-threshold jitter must not alter the clicked value")
      assert.ok(Math.abs(after[0].thumb - after[0].target) > 2,
        "A 1px pointer move must not finish an in-flight click animation instantly")
    } finally { await page.mouse.up() }
    await settle(slider)
  })
}

test("click after dragging and rapid alternating clicks remain continuous", async () => {
  const slider = rail(page, "volume")
  await key(page, slider, "Home")
  const start = await point(slider, 0.1), end = await point(slider, 0.9)
  await page.mouse.move(start.x, start.y); await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 }); await page.mouse.up()
  await settle(slider)
  for (const fraction of [0.1, 0.9, 0.15, 0.85]) {
    await click(page, slider, fraction)
    const frames = await samples(slider, 3)
    coherent(frames, "repeated click")
    assert.ok(Math.abs(frames[0].thumb - frames[0].target) > 2, "Clicking after a drag must still animate")
  }
  await settle(slider)
})

test("crossing neutral keeps the fill attached to both the mark and thumb", async () => {
  for (const name of ["style match", "Work", "Rest"]) {
    const slider = rail(page, name)
    await key(page, slider, "End")
    await key(page, slider, "Home", false)
    coherent(await samples(slider, 24), `${name} crossing neutral`)
    await settle(slider)
  }
})

test("keyboard arrows, shifted steps, Page keys, Home and End honor each range", async () => {
  for (const name of names) {
    const slider = rail(page, name)
    await key(page, slider, "Home")
    const [initial] = await samples(slider)
    assert.equal(initial.value, initial.min)
    await key(page, slider, "End", false)
    const inFlight = await samples(slider, 2)
    assert.equal(inFlight[0].value, initial.max)
    assert.ok(Math.abs(inFlight[0].thumb - inFlight[0].target) > 2, "Keyboard endpoints should animate")
    coherent(inFlight, `${name} keyboard End`)
    await settle(slider)
    await key(page, slider, "Home")
    for (const step of ["PageUp", "Shift+ArrowRight", "ArrowDown", "PageDown", "ArrowLeft"]) await key(page, slider, step, false)
    const [value] = await samples(slider)
    assert.equal(value.value, Math.min(initial.max, initial.min + 8))
    await settle(slider)
  }
})

test("double-click resets neutral and leaves no held gesture behind", async () => {
  for (const [name, expected] of Object.entries(neutrals)) {
    const slider = rail(page, name)
    await key(page, slider, "End")
    const { x, y } = await point(slider, 0.1)
    await page.mouse.dblclick(x, y)
    const frames = await samples(slider, 3)
    assert.equal(frames[0].value, expected)
    assert.equal(frames[0].held, false)
    coherent(frames, `${name} reset`)
    await settle(slider)
  }
})

test("fine dragging preserves precision and releasing capture ends the gesture", async () => {
  const slider = rail(page, "volume")
  await key(page, slider, "Home")
  for (let i = 0; i < 5; i++) await key(page, slider, "PageUp", false)
  await settle(slider)
  const { x, y } = await point(slider, 0.5)
  await slider.evaluate(element => element.addEventListener("pointerdown", event => { element.dataset.testPointer = String(event.pointerId) }, { once: true }))
  await page.mouse.move(x, y); await page.mouse.down(); await page.keyboard.down("Shift")
  try {
    await page.mouse.move(x + 30, y, { steps: 6 })
    const [fine] = await samples(slider)
    assert.ok(fine.value >= 51 && fine.value <= 57, "Shift must reduce a 30px drag to a few value steps")
    coherent(await samples(slider, 3), "fine dragging")
    await slider.evaluate(element => element.releasePointerCapture(Number(element.dataset.testPointer)))
    await page.mouse.move(x + 70, y)
    const [released] = await samples(slider)
    assert.equal(released.value, fine.value)
    assert.equal(released.held, false)
  } finally { await page.keyboard.up("Shift"); await page.mouse.up() }
  await settle(slider)
})

test("disabled Pomodoro dials ignore pointer, keyboard, and reset actions", async () => {
  await page.getByRole("button", { name: "Start timer", exact: true }).click()
  try {
    for (const name of ["Work", "Rest"]) {
      const slider = rail(page, name)
      assert.equal(await slider.getAttribute("aria-disabled"), "true")
      const before = await slider.getAttribute("aria-valuenow")
      await click(page, slider, 0.85)
      await slider.focus(); await page.keyboard.press("Home")
      const { x, y } = await point(slider, 0.1)
      await page.mouse.dblclick(x, y)
      assert.equal(await slider.getAttribute("aria-valuenow"), before)
      assert.equal((await samples(slider))[0].held, false)
    }
  } finally { await page.getByRole("button", { name: "Pause timer", exact: true }).click() }
})

test("endpoint positions stay aligned after responsive resizing without page overflow", async () => {
  for (const name of names) await key(page, rail(page, name), "End")
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const name of names) {
      const slider = rail(page, name)
      await settle(slider)
      const [frame] = await samples(slider)
      assert.ok(Math.abs(frame.thumb - frame.width) < 1, `${name} should end at the resized rail edge`)
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Endpoint thumbs must not cause horizontal page overflow")
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 })
    for (const name of names) await settle(rail(page, name))
  }
})

test("touch taps use the same gliding position and attached fill", async () => {
  const touchPage = await makePage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  try {
    for (const name of names) {
      const slider = rail(touchPage, name)
      await key(touchPage, slider, "Home")
      const { x, y } = await point(slider, 0.85)
      await touchPage.touchscreen.tap(x, y)
      const frames = await samples(slider, 3)
      assert.ok(Math.abs(frames[0].thumb - frames[0].target) > 2, "Touch taps should glide rather than jump")
      coherent(frames, `${name} touch tap`)
      assert.equal(frames[0].held, false)
      await settle(slider)
    }
  } finally { await touchPage.context().close() }
})

test("reduced motion updates directly while keeping thumb and fill aligned", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  try {
    for (const name of names) {
      const slider = rail(page, name)
      await key(page, slider, "Home")
      await click(page, slider, 0.85)
      const frames = await samples(slider, 3)
      assert.ok(Math.abs(frames.at(-1).thumb - frames.at(-1).target) < 1, "Reduced motion must not leave a spring running")
      coherent(frames, `${name} reduced motion`)
    }
  } finally { await page.emulateMedia({ reducedMotion: "no-preference" }) }
})

try {
  page = await makePage()
  const filter = process.env.SLIDER_TEST_FILTER ? new RegExp(process.env.SLIDER_TEST_FILTER) : null
  assert.ok(tests.some(entry => !filter || filter.test(entry.name)), "No slider tests matched SLIDER_TEST_FILTER")
  for (const entry of tests) {
    if (filter && !filter.test(entry.name)) continue
    try { await entry.run(); console.log(`PASS  ${entry.name}`) }
    catch (error) { failures.push(entry.name); console.error(`FAIL  ${entry.name}\n${error.stack}`) }
  }
} finally { await browser.close() }

assert.equal(failures.length, 0, `${failures.length} slider browser regression(s) failed`)
