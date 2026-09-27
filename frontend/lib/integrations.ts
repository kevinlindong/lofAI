export type ServiceId =
  | "google-tasks" | "google-calendar" | "todoist" | "microsoft-todo" | "outlook-calendar"
  | "notion" | "linear" | "github" | "trello" | "asana" | "gmail" | "outlook-mail"
  | "slack" | "discord" | "obsidian" | "apple-calendar" | "apple-reminders" | "files" | "n8n" | "zapier"

export interface Service {
  id: ServiceId
  name: string
  group: "Tasks" | "Calendars" | "Messages" | "Notes & files" | "Automation"
  description: string
  docs: string
  tokenLabel?: string
  resourceLabel?: string
  resourceRequired?: boolean
  extraLabel?: string
  complete?: boolean
  portable?: boolean
}

export const SERVICES: Service[] = [
  { id: "google-tasks", name: "Google Tasks", group: "Tasks", description: "Your lists, a little closer.", docs: "https://developers.google.com/workspace/tasks/auth", tokenLabel: "Google access token", complete: true },
  { id: "todoist", name: "Todoist", group: "Tasks", description: "Bring a project onto the desk.", docs: "https://developer.todoist.com/api/v1/", tokenLabel: "API token", complete: true },
  { id: "microsoft-todo", name: "Microsoft To Do", group: "Tasks", description: "Make room for your next little thing.", docs: "https://learn.microsoft.com/en-us/graph/api/resources/todo-overview", tokenLabel: "Microsoft access token", complete: true },
  { id: "notion", name: "Notion", group: "Tasks", description: "A small window into your workspace.", docs: "https://developers.notion.com/guides/get-started/authorization", tokenLabel: "Integration secret", resourceLabel: "Data source ID (optional)", complete: true },
  { id: "linear", name: "Linear", group: "Tasks", description: "One issue. A little breathing room.", docs: "https://linear.app/developers/graphql", tokenLabel: "Personal API key", complete: true },
  { id: "github", name: "GitHub", group: "Tasks", description: "Give an issue your undivided attention.", docs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens", tokenLabel: "Personal access token", resourceLabel: "Repository: owner/name (optional)", complete: true },
  { id: "trello", name: "Trello", group: "Tasks", description: "Bring a card over for a visit.", docs: "https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/", tokenLabel: "User token", extraLabel: "API key", complete: true },
  { id: "asana", name: "Asana", group: "Tasks", description: "A quieter place for project tasks.", docs: "https://developers.asana.com/docs/personal-access-token", tokenLabel: "Personal access token", complete: true },
  { id: "apple-reminders", name: "Apple Reminders", group: "Tasks", description: "Your Mac's reminders, on the desk.", docs: "https://support.apple.com/guide/mac-help/allow-apps-to-control-other-apps-mchl108e1718/mac", complete: true },
  { id: "google-calendar", name: "Google Calendar", group: "Calendars", description: "See what's coming. Find a little space.", docs: "https://developers.google.com/workspace/calendar/api/auth", tokenLabel: "Google access token" },
  { id: "outlook-calendar", name: "Outlook Calendar", group: "Calendars", description: "Your next commitment, within reach.", docs: "https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview", tokenLabel: "Microsoft access token" },
  { id: "apple-calendar", name: "Apple Calendar", group: "Calendars", description: "Send a focus block to your calendar.", docs: "https://support.apple.com/guide/calendar/import-or-export-calendars-icl1023/mac", portable: true },
  { id: "gmail", name: "Gmail", group: "Messages", description: "Turn a message into a small next step.", docs: "https://developers.google.com/workspace/gmail/api/auth/scopes", tokenLabel: "Google access token" },
  { id: "outlook-mail", name: "Outlook Mail", group: "Messages", description: "Keep the next step, and a link back.", docs: "https://learn.microsoft.com/en-us/graph/api/user-list-messages", tokenLabel: "Microsoft access token" },
  { id: "slack", name: "Slack", group: "Messages", description: "Bring one message into a quieter room.", docs: "https://docs.slack.dev/authentication/tokens/", tokenLabel: "User or bot token" },
  { id: "discord", name: "Discord", group: "Messages", description: "A message worth coming back to.", docs: "https://docs.discord.com/developers/quick-start/getting-started", tokenLabel: "Bot token", resourceLabel: "Server ID", resourceRequired: true },
  { id: "obsidian", name: "Obsidian", group: "Notes & files", description: "Tuck your tasks into a notebook.", docs: "https://help.obsidian.md/Extending+Obsidian/Obsidian+URI", portable: true },
  { id: "files", name: "Files", group: "Notes & files", description: "Little lists that travel with you.", docs: "", portable: true },
  { id: "n8n", name: "n8n", group: "Automation", description: "Send a task into your own workflow.", docs: "https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/", tokenLabel: "Production webhook URL" },
  { id: "zapier", name: "Zapier", group: "Automation", description: "Let a small task start something useful.", docs: "https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zaps-from-webhooks", tokenLabel: "Catch Hook URL" },
]

export interface RemoteItem { id: string; title: string; done: boolean; kind: "task" | "event" | "message"; url?: string; due?: string; canComplete?: boolean }
export interface TaskSource { provider: ServiceId; source: string; id: string; url?: string; sync: boolean }
export interface Task { id: string; text: string; done: boolean; source?: TaskSource }
export interface Connection { id: ServiceId; connected: boolean; configured?: boolean; oauthConfigured?: boolean }
export interface Source { id: string; name: string }

let clientKey: string | undefined
function getClientKey(): string {
  if (clientKey) return clientKey
  try {
    const saved = localStorage.getItem("lofai.integration-client")
    if (saved && /^[a-f0-9]{64}$/.test(saved)) return (clientKey = saved)
  } catch { /* This tab can still connect when persistent storage is unavailable. */ }
  clientKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, "0")).join("")
  try { localStorage.setItem("lofai.integration-client", clientKey) } catch { /* Kept in memory for this visit. */ }
  return clientKey
}

export function backendOrigin(): string {
  const host = process.env.NEXT_PUBLIC_BACKEND_HOST ?? `${window.location.hostname}:8000`
  return `${window.location.protocol === "https:" ? "https:" : "http:"}//${host}`
}

export async function integrationRequest<T>(path = "", options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 65000)
  try {
    const response = await fetch(`${backendOrigin()}/integrations${path}`, {
      ...options, signal: controller.signal, credentials: "include",
      headers: { "Content-Type": "application/json", "X-Lofai-Client": getClientKey(), ...options.headers },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "That connection needs another look. Try again.")
    return data as T
  } catch (error) {
    if (error instanceof TypeError) throw new Error("Couldn't reach your local server. Start the backend, then try again.")
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("That service took too long. Try again in a moment.")
    throw error
  } finally { window.clearTimeout(timeout) }
}

export function safeWebUrl(value?: string): string | undefined {
  if (!value) return undefined
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined } catch { return undefined }
}

export function serviceName(id: ServiceId): string { return SERVICES.find((s) => s.id === id)?.name ?? id }
