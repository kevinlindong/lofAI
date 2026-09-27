import type { Task } from "./integrations"

const LIMIT = 1000
export function taskMarkdown(tasks: Task[]): string {
  return `# A little list from lofAI\n\n${tasks.map((t) => `- [${t.done ? "x" : " "}] ${t.text.replace(/[\r\n]+/g, " ")}`).join("\n")}\n`
}

export function downloadFile(name: string, content: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }))
  const link = document.createElement("a")
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function taskCsv(tasks: Task[]): string {
  const quote = (value: string) => `"${(/^[\s]*[=+@-]/.test(value) ? "'" + value : value).replace(/"/g, '""')}"`
  return "text,done\r\n" + tasks.map((t) => `${quote(t.text)},${t.done}`).join("\r\n")
}

function csvRows(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '"' && quoted && input[i + 1] === '"') { field += '"'; i++ }
    else if (char === '"') quoted = !quoted
    else if (char === "," && !quoted) { row.push(field); field = "" }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[i + 1] === "\n") i++
      row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ""
    } else field += char
  }
  if (quoted) throw new Error("That CSV has an unfinished quoted field.")
  row.push(field); if (row.some(Boolean)) rows.push(row)
  return rows
}

export function parseTaskFile(name: string, input: string): Task[] {
  if (input.length > 1_000_000) throw new Error("Try a smaller list (under 1 MB).")
  const text = input.replace(/^\uFEFF/, "")
  let values: Array<{ text?: unknown; title?: unknown; done?: unknown; completed?: unknown }> = []
  if (/\.json$/i.test(name)) {
    const parsed = JSON.parse(text)
    values = Array.isArray(parsed) ? parsed : parsed.tasks
    if (!Array.isArray(values)) throw new Error("Use a JSON task array or an object with a tasks array.")
  } else if (/\.csv$/i.test(name)) {
    const rows = csvRows(text)
    const header = rows.shift()?.map((field) => field.trim().toLowerCase()) ?? []
    const title = header.findIndex((field) => ["text", "title", "task", "content"].includes(field))
    const done = header.findIndex((field) => ["done", "completed"].includes(field))
    if (title < 0) throw new Error("Your CSV needs a text, title, task, or content column.")
    values = rows.map((row) => ({ text: row[title], done: /^(true|1|yes|x)$/i.test(row[done] ?? "") }))
  } else if (/\.(md|txt)$/i.test(name)) {
    values = text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/)
      return match ? [{ text: match[2], done: match[1].toLowerCase() === "x" }] : []
    })
  } else throw new Error("Choose a JSON, CSV, or Markdown checklist.")
  if (values.length > LIMIT) throw new Error(`Bring up to ${LIMIT} tasks at a time.`)
  const tasks = values.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const title = item.text ?? item.title
    return typeof title === "string" && title.trim() ? [{ id: crypto.randomUUID(), text: title.trim().slice(0, 500), done: item.done === true || item.completed === true }] : []
  })
  if (!tasks.length) throw new Error("No tasks found. Markdown lists use - [ ] task or - [x] finished task.")
  return tasks
}

export function calendarFile(title: string, start: Date, minutes: number): string {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error("Choose a start time and a duration between 1 and 1440 minutes.")
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, "\\$&")
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//lofAI//Focus time//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${crypto.randomUUID()}@lofai.local`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + minutes * 60000))}`, `SUMMARY:${escape(title.trim() || "A little focus time")}`, "DESCRIPTION:A little room to focus with lofAI.", "END:VEVENT", "END:VCALENDAR"]
  // Fold at UTF-8 octet boundaries without splitting a code point (RFC 5545).
  return lines.map((line) => {
    const chunks: string[] = []; let part = ""; let bytes = 0
    for (const char of line) {
      const size = new TextEncoder().encode(char).length
      if (bytes + size > 75) { chunks.push(part); part = " "; bytes = 1 }
      part += char; bytes += size
    }
    chunks.push(part); return chunks.join("\r\n")
  }).join("\r\n") + "\r\n"
}
