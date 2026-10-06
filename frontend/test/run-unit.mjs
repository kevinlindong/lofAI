// Runs every unit test (test/*.test.mjs, not the *.browser.test.mjs suites)
// one after another from the package root, the way `node test/x.test.mjs`
// did. New lib tests are picked up by name; any failure fails the run.
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(dir)
const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs") && !name.endsWith(".browser.test.mjs")).sort()

const failed = []
for (const name of files) {
  console.log(`\n# ${name}`)
  const started = Date.now()
  const run = spawnSync(process.execPath, [path.join("test", name)], { cwd: root, stdio: "inherit" })
  if (run.status !== 0) failed.push(`${name} (${run.error ? run.error.message : run.signal ?? `exit ${run.status}`})`)
  else console.log(`# ${name} ok in ${Date.now() - started}ms`)
}

console.log(`\n${files.length - failed.length} of ${files.length} test files passed`)
if (failed.length) {
  console.log(`failed:\n  ${failed.join("\n  ")}`)
  process.exit(1)
}
