import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const modules = new Map()
function loadModule(name) {
  if (modules.has(name)) return modules.get(name)
  const source = readFileSync(new URL(`../lib/${name.replace("./", "")}.ts`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const context = { exports: {}, require: loadModule }
  vm.runInNewContext(compiled, context)
  modules.set(name, context.exports)
  return context.exports
}

const { DEFAULT_LISTENER_CONTROLS, MAX_CUSTOM_PROMPT_CHARS } = loadModule("./mrt-stream")
const {
  buildSoundPrompt, soundDraftFor, sameRecipe, describeSound, stationControls, stationFor, stationPreset,
  STATION_PRESETS, CUSTOM_STATION, INSTRUMENTS, VIBES, MOODS, EFFECTS, MAX_INSTRUMENTS, MAX_EFFECTS,
} = loadModule("./sound-recipe")

// The largest possible mix must reach the backend without losing its final
// effect to the transport's character cap, including after adding options.
const longest = (options) => [...options].sort((a, b) => b.prompt.length - a.prompt.length)
const fullest = {
  instruments: longest(INSTRUMENTS).slice(0, MAX_INSTRUMENTS).map((option) => option.id),
  effects: longest(EFFECTS).slice(0, MAX_EFFECTS).map((option) => option.id),
  vibe: longest(VIBES)[0].id,
  mood: longest(MOODS)[0].id,
}
const longestPrompt = buildSoundPrompt(fullest)
assert.ok(longestPrompt.length <= MAX_CUSTOM_PROMPT_CHARS, `${longestPrompt.length} characters exceeds the backend cap`)
assert.ok(longestPrompt.endsWith(longest(EFFECTS)[MAX_EFFECTS - 1].prompt))
console.log("PASS every available combination fits the backend prompt cap without dropping effects")

// The backend tunes these four by name (backend/styles.py STATIONS) and
// quietly plays dusty-beats for any other name, so every other preset has to
// go out as a custom mix.
const BACKEND_STATIONS = ["dusty-beats", "rainy-piano", "jazz-cafe", "sunlit-groove"]
assert.deepEqual([...STATION_PRESETS.filter((preset) => !preset.mixed).map((preset) => preset.id)].sort(), [...BACKEND_STATIONS].sort())
assert.equal(new Set(STATION_PRESETS.map((preset) => preset.id)).size, STATION_PRESETS.length)
assert.ok(STATION_PRESETS.every((preset) => preset.id !== CUSTOM_STATION))
for (const [i, a] of STATION_PRESETS.entries()) {
  for (const b of STATION_PRESETS.slice(i + 1)) assert.ok(!sameRecipe(a.recipe, b.recipe), `${a.id} and ${b.id} share a recipe`)
}
console.log("PASS only the backend's own stations go out by name, and every preset sounds like itself")

// words that make the backend hiss filter stand aside (backend/styles.py NOISE_TEXTURE_WORDS)
const NOISE_WORDS = ["vinyl", "crackle", "tape", "rain", "hiss", "static", "noise"]
for (const preset of STATION_PRESETS) {
  const controls = { ...DEFAULT_LISTENER_CONTROLS, ...stationControls(preset) }
  if (preset.mixed) {
    assert.equal(controls.station, CUSTOM_STATION)
    assert.equal(controls.customPrompt, buildSoundPrompt(preset.recipe))
    assert.ok(controls.customPrompt.length <= MAX_CUSTOM_PROMPT_CHARS)
    assert.ok(!NOISE_WORDS.some((word) => controls.customPrompt.includes(word)), `${preset.id} asks for noise`)
  } else {
    assert.equal(controls.station, preset.id)
    assert.equal(controls.customPrompt, "")
    assert.equal(controls.recipe, undefined)
  }
  // a saved copy comes back as the same preset, in the sentence, with its name
  const saved = JSON.parse(JSON.stringify(controls))
  assert.equal(stationFor(saved)?.id, preset.id)
  assert.equal(describeSound(saved).label, preset.label)
  const draft = soundDraftFor(saved)
  assert.equal(draft.mode, "builder")
  assert.ok(sameRecipe(draft.recipe, preset.recipe))
}
console.log("PASS mixed presets go out like the sentence's own mixes and come back as themselves")

const owl = stationPreset("night-owl")
const reordered = { ...owl.recipe, instruments: [...owl.recipe.instruments].reverse() }
assert.equal(stationFor({ ...DEFAULT_LISTENER_CONTROLS, station: CUSTOM_STATION, customPrompt: buildSoundPrompt(reordered), recipe: reordered })?.id, "night-owl")
const tweaked = { ...owl.recipe, mood: "cozy" }
assert.equal(stationFor({ ...DEFAULT_LISTENER_CONTROLS, station: CUSTOM_STATION, customPrompt: buildSoundPrompt(tweaked), recipe: tweaked }), undefined)
assert.equal(stationFor({ ...DEFAULT_LISTENER_CONTROLS, station: CUSTOM_STATION, customPrompt: buildSoundPrompt(owl.recipe) }), undefined)
// a named station's recipe sent as a custom prompt is not that station: the backend tunes it differently
const dusty = stationPreset("dusty-beats")
assert.equal(stationFor({ ...DEFAULT_LISTENER_CONTROLS, station: CUSTOM_STATION, customPrompt: buildSoundPrompt(dusty.recipe), recipe: dusty.recipe }), undefined)
assert.equal(stationFor({ ...DEFAULT_LISTENER_CONTROLS, station: "dusty-beats" })?.id, "dusty-beats")
// an unknown name plays the backend default, so the sentence shows its recipe
assert.ok(sameRecipe(soundDraftFor({ ...DEFAULT_LISTENER_CONTROLS, station: "retired-station" }).recipe, dusty.recipe))
console.log("PASS the picker finds a mixed preset in any order, and nothing else passes for one")

const saved = JSON.parse(JSON.stringify({ ...DEFAULT_LISTENER_CONTROLS, station: "custom", recipe: fullest, customPrompt: longestPrompt }))
assert.equal(soundDraftFor(saved).mode, "builder")
assert.ok(sameRecipe(soundDraftFor(saved).recipe, fullest))
assert.equal(describeSound(saved).label, "Your custom mix")
const legacy = { ...DEFAULT_LISTENER_CONTROLS, station: "custom", customPrompt: "night bus, warm piano" }
assert.equal(soundDraftFor(legacy).mode, "prompt")
assert.equal(soundDraftFor(legacy).prompt, legacy.customPrompt)
assert.equal(describeSound(legacy).label, "Your own prompt")
console.log("PASS presets, saved recipes, and older manual mixes restore the correct editor mode")

for (const recipe of [null, {}, { ...fullest, instruments: ["unknown"] }, { ...fullest, effects: ["rain", "rain"] }, { ...fullest, mood: "unknown" }]) {
  const draft = soundDraftFor({ ...saved, recipe })
  assert.equal(draft.mode, "prompt")
  assert.equal(draft.prompt, longestPrompt)
}
assert.equal(soundDraftFor({ ...saved, customPrompt: "a different sound" }).mode, "prompt")
// nor does a stale recipe put a preset on the dial over the prompt that is playing
const staleOwl = { ...DEFAULT_LISTENER_CONTROLS, station: CUSTOM_STATION, customPrompt: "a different sound", recipe: owl.recipe }
assert.equal(stationFor(staleOwl), undefined)
assert.equal(describeSound(staleOwl).description, "a different sound")
assert.equal(soundDraftFor(staleOwl).prompt, "a different sound")
console.log("PASS invalid or stale saved recipe metadata preserves the actual prompt")
