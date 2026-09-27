# Connections for your little workspace

Open **Connections** beside the task list, connect a service, choose a source,
and bring a few items onto your desk. Connections use the existing LofAI Python
backend on port 8000. Local tasks continue working without that backend.

An imported item is a local copy with a link to its source. Completion only
changes the remote service when the item is explicitly brought in with sync
enabled. Refresh reads the service again; it is not background synchronization.
Messages and calendar events become local tasks, so checking them off does not
archive messages, change events, or send messages to other people.

## Available services

| Service | Connect with | What comes into the room | Completion sync |
| --- | --- | --- | --- |
| Google Tasks | Google sign-in after server setup, or an OAuth access token with `https://www.googleapis.com/auth/tasks` | Tasks from a selected list, including completed tasks | Complete and reopen |
| Google Calendar | Google sign-in or token with `https://www.googleapis.com/auth/calendar.readonly` | Selected calendar, today through the next 14 days, including recurring instances | Local reminder only |
| Todoist | Personal API token from Settings → Integrations → Developer | Active tasks from a selected project | Close and reopen |
| Microsoft To Do | Microsoft sign-in or delegated Graph token with `Tasks.ReadWrite` | Tasks from a selected list | Complete and reopen |
| Outlook Calendar | Microsoft sign-in or delegated Graph token with `Calendars.Read` | Selected calendar's next 14 days, including recurring instances | Local reminder only |
| Notion | Internal integration token; share the task data source with that integration | Pages from a shared data source; optional data source ID narrows the picker | A single checkbox property named `Done`, `Complete`, or `Completed`; other schemas import locally |
| Linear | Personal API key or OAuth access token | Issues from a selected team | Team's first `completed` state; reopening uses its first `unstarted` state |
| GitHub | Personal access token with repository Issues read/write permission | Issues from a selected repository; optional `owner/repository` narrows the picker; pull requests excluded | Close and reopen issues |
| Trello | API token plus developer API key | Open cards from a selected board | Toggle the card's due-complete flag; does not archive or move it |
| Asana | Personal access token | Tasks from a selected project | Complete and reopen |
| Gmail | Google sign-in or OAuth token with `https://www.googleapis.com/auth/gmail.readonly` | Message subjects from a chosen label; no email bodies imported | Local task only |
| Outlook Mail | Microsoft sign-in or delegated Graph token with `Mail.Read` | Message subjects from a selected folder | Local task only |
| Slack | Installed app's bot or user access token; channel read/history scopes | Recent messages from a selected channel; bot must be a member | Local task only |
| Discord | Bot token plus server ID; bot installed with View Channel and Read Message History, Message Content intent enabled | Messages from a selected text or announcement channel | Local task only |
| Apple Reminders | Native connection on the backend Mac | Reminders from a selected list, after macOS Automation permission | Complete and reopen |
| n8n | Public HTTPS Webhook node URL | Explicitly send a chosen task to your workflow | Outbound action only |
| Zapier | Webhooks by Zapier Catch Hook URL | Explicitly send a chosen task to your Zap | Outbound action only |

Slack typically needs `channels:read`, `channels:history`, `groups:read`, and
`groups:history` for the channels you choose. Workspace policies may require an
admin to install or approve an app. Discord uses a bot token, never a personal
user token. Apple Reminders works only when this backend runs on your Mac;
grant the app running LofAI permission in **System Settings → Privacy & Security
→ Automation** if macOS asks.

The picker follows the service's source pages, with an explicit error when a
project/chat account exceeds 1,000 sources; optional Notion/GitHub resource
fields let you connect a specific source directly. Item lists support loading additional pages.
Todoist's active-task endpoint omits completed tasks; completed copies already
on your local desk remain available for reopening. Completion of recurring
Todoist tasks follows Todoist's own rescheduling behavior.

Portable Markdown, JSON, CSV, and calendar-file transfers are separate from
account connections. Obsidian uses the Markdown handoff; Apple Calendar uses
calendar files. These files are one-time transfers, not continuous sync.

## Google and Microsoft sign-in

Access-token connection works without registering a LofAI OAuth client. Those
tokens expire according to their provider and must be replaced. For sign-in
with automatic refresh, register your own app and set these backend environment
variables before starting LofAI:

```sh
export LOFAI_GOOGLE_CLIENT_ID='your-google-web-client-id'
export LOFAI_GOOGLE_CLIENT_SECRET='your-google-client-secret'
export LOFAI_MICROSOFT_CLIENT_ID='your-microsoft-application-id'
export LOFAI_MICROSOFT_CLIENT_SECRET='your-microsoft-client-secret'
export LOFAI_OAUTH_REDIRECT_URI='http://localhost:8000/integrations/oauth/callback'
./start.sh
```

Only configure the provider you want to use. These are backend variables; do
not put client secrets into `NEXT_PUBLIC_` variables or commit them to Git.
The start scripts inherit the environment; they do not automatically read a
new `.env` file.

For Google, create a **Web application** OAuth client and enable Tasks,
Calendar, and/or Gmail APIs as needed. Add your own account as a test user if
the consent screen is in testing. For Microsoft, register a **Web** platform
redirect and delegated permissions for the services you use; select an account
type that supports your intended personal and/or work accounts. The redirect
URI must match the variable above exactly.

Use the same hostname for frontend and backend (for example, `localhost:3000`
and `localhost:8000`), and use that hostname in the registered OAuth callback.
The app checks hostname consistency before opening sign-in. To use `127.0.0.1`,
set and register its matching callback URI too. The flow binds its one-time state to an HttpOnly cookie,
uses PKCE, and opens the provider's consent page. Each service requests only
its listed scope. Callback windows return only a connection event to the exact
frontend origin; provider access and refresh tokens stay on the backend.

Google OAuth testing mode and organization policies can limit token lifetime;
an expired or revoked connection asks you to reconnect. Disconnect removes
LofAI's saved credential. You can separately revoke the app at the provider.

## Automation postcards

Connecting n8n or Zapier validates its configuration without delivering a task.
The service is marked configured; it is only exercised when you explicitly
send a task. A successful send means the webhook accepted the request, not
that every downstream step finished. Sending again can create another run.

The webhook receives JSON containing `title`, `done`, and an optional HTTPS
`url`. It receives no provider tokens or full task list. n8n Cloud URLs under
`*.app.n8n.cloud` work directly. For a
public self-hosted n8n installation, add its exact hostname to the backend:

```sh
export LOFAI_WEBHOOK_HOSTS='n8n.example.com'
```

Zapier accepts its `https://hooks.zapier.com/hooks/catch/.../.../` Catch Hook
URLs. Webhooks must use HTTPS on port 443 and publicly routable DNS. Local,
private, metadata, and IP-literal destinations are rejected. Delivery pins the
validated public address, uses normal TLS certificate verification, and never
follows redirects.

## Storage and access

Provider credentials live in `~/.cache/lofai/integrations.sqlite3`, mode `0600`,
outside the repository. Override the directory with `LOFAI_INTEGRATIONS_DIR`.
Credentials are protected by local filesystem permissions, not encrypted at
rest by LofAI. The random browser workspace credential is a bearer secret in
localStorage and is hashed before indexing connections on the backend. Clearing
site data creates a new workspace identity; disconnect first if you want to
remove the old saved credentials.

Integration routes default to loopback clients and exact frontend origins
(`http://localhost:3000` and `http://127.0.0.1:3000`). Mutations require an
allowed Origin plus the workspace bearer header. Wildcard CORS does not grant
integration access. Requests and provider responses have size and time limits;
remote error bodies and tokens are never returned to the browser.

`LOFAI_ALLOWED_ORIGINS` can set an explicit comma-separated origin list. An
intentional remote deployment also needs `LOFAI_INTEGRATIONS_ALLOW_REMOTE=1`,
HTTPS, a matching OAuth redirect, and a deployment authentication policy.
The local native Reminders bridge belongs to the backend computer's account.
This implementation is intended for a personal workspace, not a shared public
server with multiple untrusted users.

## API and validation references

Implementation follows [Google Tasks](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list),
[Google Calendar event expansion](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[Todoist API v1](https://developer.todoist.com/api/v1/),
[Microsoft To Do](https://learn.microsoft.com/en-us/graph/api/todotasklist-list-tasks?view=graph-rest-1.0),
[Microsoft calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0),
[Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
and [Microsoft OAuth](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
Provider references for the project, inbox, chat, and portability services are
also collected in [the productivity direction](PRODUCTIVITY.md).

Automated tests mock network/native calls and cover connection isolation,
failed authentication, origin restrictions, token redaction, OAuth state and
cookie binding, provider pagination and writes, native command arguments, and
webhook destination restrictions. Live account connections require your
credentials and were not exercised by these tests.
