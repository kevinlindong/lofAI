# Productivity direction

LofAI should feel like settling into a favorite little room: a soundtrack,
a companion, and enough structure to make the next small thing easier.
The product direction is calm, playful, quirky, and alive. Character should
come from how tools respond as well as how they look.

The shared timer sliders, compact cat widget, dot-matrix new-take die,
station dial, and service connections are implemented. See [connection setup](INTEGRATIONS.md)
for the exact capabilities and account requirements. The richer workflows and
additional tools below remain product direction: for example, imported calendar
events are available today, while suggested focus windows are still proposed.

## What is here today

| Tool | Current behavior | Opportunity |
| --- | --- | --- |
| Tasks | Browser-local list; add, complete, undo, remove, clear completed; import preview, source links, optional remote completion, portable transfers; task actions animate the cat | Edit tasks, pick a task for a session, background reconciliation |
| Pomodoro | Manual focus/rest cycles, pause/reset, end sound, wall-clock deadline; focus 1–60 minutes and rest 1–30 | Remember preferences, associate sessions with tasks, acknowledge finished sessions |
| Radio | Eight-station dial (four tuned backend stations, four mixed recipes), custom sound recipe or prompt, variation, volume, keyboard shortcuts | Save personal sound-and-focus rituals |
| Companion | Compact widget; cat follows the cursor, responds to petting/tasks/music/focus, and dozes | React to session milestones, welcome people back gently |
| Atmosphere | Six saved themes, dot artwork, flowing visualizer, ambient marks, reduced-motion and low-power modes | Keep new tools consistent with this existing identity |

Tasks use localStorage's `todos` key and retain existing lists on upgrade.
Imported items also carry provider/source/item IDs, a source URL when available,
and an explicit completion-sync choice. Credentials live on the local backend.
Refresh and re-import apply provider changes; this is not automatic background
or cross-device task sync. Timer durations and session state reset on reload.
The timer and task list share the cat but do not share an active task yet.

Implementation references: [tasks](../frontend/components/todo-list.tsx),
[timer](../frontend/components/pomodoro-timer.tsx),
[radio state](../frontend/components/radio-provider.tsx), and
[companion](../frontend/components/pet.tsx).

## The main loop to strengthen

1. **Arrive.** Restore the person's atmosphere and offer their last unfinished
   task. A return after a week should be as welcome as a return tomorrow.
2. **Put one thing on the desk.** Pick a local or connected task. Keep its
   source link nearby and leave the rest of the queue easy to reach.
3. **Settle in.** Choose a duration and start the music and focus session with
   clear individual controls. Support a session without a task too.
4. **Park a thought.** Jot something down without leaving the current task.
5. **Land softly.** Acknowledge the time spent, then offer “done,” “another
   little bit,” or “take a breather.” A timer ending never completes a task
   automatically.

## Integration direction

The connection drawer now supports the services below. The table captures
priorities for deepening each experience; [connection setup](INTEGRATIONS.md)
is the source of truth for what is currently available. The best first
connection for a person is whichever already holds their real work.

| Priority | Service | Experience in LofAI | First useful scope |
| --- | --- | --- | --- |
| First | Google Tasks | Bring a chosen list onto the desk; complete a task and reflect that back in its source | List selection, task retrieval, source identity, deliberate completion sync |
| First | Google Calendar | Show the next commitment and the available focus window; offer a focus block | Availability first, event details when wanted, event creation as a separate action |
| First | Todoist | Work through an existing project without rebuilding it in LofAI | One selected project, task links, completion and reopening |
| Next | Notion | Bring tasks from a chosen task database and keep the original notes one click away | Select shared content and map title/status fields; handle each database's structure explicitly |
| Next | [Microsoft To Do](https://learn.microsoft.com/en-us/graph/api/resources/todo-overview?view=graph-rest-1.0) + [Outlook Calendar](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0) | Bring a selected list and the next calendar commitment into the same flow | Calendar reads must include recurring instances and correct timezones; event creation is separate |
| Next | [Linear](https://linear.app/developers/graphql) + [GitHub](https://docs.github.com/en/rest/issues/issues) | Put an assigned issue on the desk with a link to its context | Read selected assigned issues; distinguish GitHub issues from pull requests; map team workflow states before writing |
| Next | [Trello](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) + [Asana](https://developers.asana.com/docs/overview) | Bring a small selection from an existing board or project | Choose a board/list/project, import or refresh selected items, retain original links |
| Later | [Gmail](https://developers.google.com/workspace/gmail/api/guides) + [Outlook Mail](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0) | Turn a selected message into a small task with a link back | User-triggered capture; keep message bodies out of the task list by default |
| Later | [Slack](https://docs.slack.dev/interactivity/implementing-shortcuts/) + [Discord](https://docs.discord.com/developers/interactions/application-commands) | A message action brings a task into LofAI | Deliberate capture with a preview; requires platform app setup and an interaction receiver |
| Foundation | [Calendar files](https://www.rfc-editor.org/info/rfc5545/), Markdown, task JSON/CSV | Carry tasks, session notes, and planned focus blocks between tools | Preview imports, preserve IDs where possible, offer downloads; label one-time transfers clearly |
| Later | [Obsidian](https://obsidian.md/help/uri) | Export session notes or a task checklist into a personal notebook | Markdown export first; optional URI handoff to an installed app and selected vault |
| Later | [Apple Calendar](https://support.apple.com/en-us/guide/calendar/icl1023/mac)/[Reminders](https://developer.apple.com/documentation/eventkit/retrieving-events-and-reminders) | Reach people using Apple's personal tools | Calendar-file handoff first; reminders access through EventKit needs a native bridge |
| Later | [n8n](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/) / [Zapier](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zaps-from-webhooks) | Send a chosen session-completion event into a personal workflow, or capture tasks from other tools | Explicitly configured actions; incoming events need a reachable service or pull bridge |

Platform-specific starting points checked against official documentation:

- [Google Tasks permissions](https://developers.google.com/workspace/tasks/auth)
  separate reading from editing. Completion sync requires write access.
- [Google Calendar permissions](https://developers.google.com/workspace/calendar/api/auth)
  distinguish availability, event details, and writes. Request only the
  capability the person enables; a focus block can be an ordinary event.
- [Todoist API v1](https://developer.todoist.com/api/v1/) is the starting point
  for tasks and OAuth. Use a real account connection for a distributed app.
- [Notion authorization](https://developers.notion.com/guides/get-started/authorization)
  limits a connection to accessible content. Plan for an explicit content
  picker and property mapping before promising arbitrary task sync.

For this local app, refresh or polling is a practical starting point:
[Linear webhooks](https://linear.app/developers/webhooks) require public
HTTPS and cannot target localhost. Message actions likewise need a receiver
that the provider can reach. A later optional
[Slack quiet-time action](https://docs.slack.dev/reference/methods/dnd.setSnooze/)
needs a user token with DND access and should be enabled separately.

## Other tools that fit the room

| Addition | Useful behavior | Small bit of character |
| --- | --- | --- |
| On the desk | One selected task tied to the current focus session | A little bookmark settles beside it; the cat looks ready |
| Pocket notebook | Persistent scratchpad; turn a line into a task | A folded note peeks out from a drawer |
| Day shelf | A small chosen set of tasks for today; remaining work stays available | Finishing one leaves a quiet checkmark rather than erasing the evidence |
| Break companion | Optional water, stretch, or look-outside suggestion at break time | The cat stretches too; the prompt can be skipped |
| Session postcard | A short daily recap of time spent and things finished | A warm “you made room for a few things” moment, without scores or penalties |
| Ritual presets | Save sound, theme, and timer preferences together | Personal names such as “rainy reading” or “tiny admin hour” |
| Open-ended focus | Count up when a countdown feels constraining | The same gentle controls and optional break invitation |

Build “on the desk” and the notebook first: they make the current tools work
together. Calendar context and session postcards come next. Shared coworking
rooms can be explored later, once the single-person routine feels complete.

## UX rules for new work

- Keep music, one active task, and the timer easy to find. Put connections in
  settings and imports in a task drawer instead of adding a permanent panel
  for every service.
- Use the existing palette, dot vocabulary, spring curves, and shared
  controls. Reactions should follow an action, then settle.
- Reserve larger cat reactions for meaningful moments. Give rest a relaxed
  state and make quiet or reduced-motion use feel equally complete.
- Keep copy short and useful: “what's one small thing?”, “thought parked,”
  “a little room to breathe.” Errors must still explain the problem and next
  action plainly.
- Show source badges, last refresh, pending writes, and reconnect/retry
  states only where they help someone understand their tasks.
- Completing, removing from the desk, and deleting in another service are
  distinct actions. An integration must make those consequences clear.
- Keep labels, keyboard operation, touch targets, and focus indicators
  usable across themes. Motion must never be the only feedback.

## Further build path

1. **Connect the local tools.** Extract task state from `TodoList`, migrate
   existing items without dropping them, add editing and an active task,
   persist timer preferences, and record actual completed focus sessions.
   Guard storage writes and explain when a browser cannot save.
2. **Deepen portability.** The import preview, exports, and source links now
   exist. Add richer notes and field mapping as real usage calls for them.
3. **Deepen provider workflows.** Connection setup, source selection,
   pagination, manual refresh, supported completion/reopening, and disconnect
   now exist. Next consider background reconciliation, per-account identities,
   saved source preferences, and explicit conflict resolution.
4. **Expand calendar actions.** Calendar reads and calendar-file creation now
   exist. Add availability suggestions and direct event creation with separate
   authorization for writes.

The frontend is a [static Next export](../frontend/next.config.mjs). Place
OAuth callbacks, credential storage, refresh, and provider requests in the
existing Python service or a dedicated integration service. Next route
handlers cannot run in the static deployment. Separate provider work from
the audio generation loop so a slow refresh does not interrupt music.

Keep provider credentials out of browser task storage. If this becomes a
hosted multi-user product, add authenticated sessions and per-user isolation
before accepting account connections. For local use, define a local user
boundary and a credential store explicitly.

Use stable local IDs plus provider/account/resource/external IDs. Preserve
source URLs, remote versions, timestamps, and pending operations as needed.
Deduplicate repeated imports, paginate remote lists, and make retries
idempotent. A remote item disappearing should trigger reconciliation, not
silent loss of local notes. Keep local tasks usable during outages and make
failed writes visible and retryable. A return visit should never require
reconnecting just to use the timer or a local task.
