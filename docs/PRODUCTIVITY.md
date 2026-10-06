# Productivity direction

LofAI should feel like settling into a favorite little room: a soundtrack,
a companion, and enough structure to make the next small thing easier.
The product direction is calm, playful, quirky, and alive. Character should
come from how tools respond as well as how they look.

The widget desk and its drawer, shared timer sliders, the cat, the drawer's
four extra widgets (On the desk, the pocket notebook, the clock and Today),
the dot-matrix new-take die, station dial, and service connections are
implemented. See [connection setup](INTEGRATIONS.md) for the exact
capabilities and account requirements. The richer workflows and additional
tools below remain product direction: for example, imported calendar events
are available today, while suggested focus windows are still proposed.

## What is here today

| Tool | Current behavior | Opportunity |
| --- | --- | --- |
| Desk | Every tool is a widget on a grid that fits the window, in five standard sizes (S, M, L, W, XL); out of the box it's the room as it was before widgets (the Radio on the left; the cat, Tasks and the timer on the right). Drag by any quiet spot (long-press on touch), arrow keys on its handle, sizes from the corner or the handle's menu; a widget stays exactly where it's set down and the ones it lands on make room, though it never shoves a bigger one out of view; pins only ever come from the tack, P or the menu; undo/redo; 6, 4 or 2 columns. See [the desk](#the-desk) | Ritual presets that save a whole arrangement |
| Tasks | Browser-local list; add, complete, undo, remove (with Undo), clear completed; put one task on the desk (the bookmark key); import preview, source links, optional remote completion, portable transfers; task actions animate the cat; keeps its list while put away; follows another tab's changes | Edit tasks, background reconciliation |
| Pomodoro | Manual focus/rest cycles, pause/reset, end sound, wall-clock deadline; focus 1–60 minutes and rest 1–30, remembered; "FOCUS · {task}" while a task is on the desk; a block that runs out lands softly ("25 minutes with this. nicely done." with [done], [another little bit], [take a breather]), is said aloud once, and never completes a task by itself; finished blocks are logged locally with their task; keeps running while resized or put away (a dot on the pull says so, a check once one has landed) | Open-ended focus, suggested focus windows |
| On the desk | The one task this session is for, with its source link; pick or write one, start a block from it, [done] (Undo in the toast or ⌘Z), swap, back to the list. It carries the landing note while it's out. Comes out beside the timer the first time a task is put on the desk. In the drawer by default | A break companion that knows what you were on |
| Pocket notebook | One persistent note on ruled paper that grows into free rows, then scrolls; saves as you pause; ⌘/Ctrl+Enter (or the key in the margin) turns the caret's line into a task, and Undo puts it back. Kept on the page, not moved, when Tasks can't save. In the drawer by default | Several pages, a session's notes in Today |
| Clock | Dot digits that change dot by dot, "time" or "with the day" (the date and the day's hours as dots); 12 or 24 hours; "nice to see you" for the first minute after a long time away, never how long. In the drawer by default | The next calendar commitment |
| Today | A postcard of the day so far: focus time and things finished, one bead per block, no streaks or scores; "Save a copy" downloads it as Markdown. In the drawer by default | A week's shelf, an end-of-day moment |
| Radio | Eight-station dial (four tuned backend stations, four mixed recipes), custom sound recipe or prompt, variation, volume, keyboard shortcuts that work even with the radio in the drawer; the full radio (ring on top, sound panel below), a wide card (ring beside the panel), the ring, or a mini player | Save personal sound-and-focus rituals |
| Companion | A cat on its own card in three sizes, sitting on the card's floor with room around it; perks an ear when it's picked up, is pleased when a widget comes to rest beside it, follows the cursor, responds to petting/tasks/music/focus, purrs while carried, naps in the drawer (its ears peek over the pull), and dozes | React to session milestones |
| Atmosphere | Six saved themes, dot artwork, flowing visualizer, ambient marks, reduced-motion and low-power modes (arranging the desk damps the canvases the same way) | Keep new tools consistent with this existing identity |

Tasks use localStorage's `todos` key and retain existing lists on upgrade.
Imported items also carry provider/source/item IDs, a source URL when available,
and an explicit completion-sync choice. Credentials live on the local backend.
Refresh and re-import apply provider changes; this is not automatic background
or cross-device task sync. Two open tabs share the list: the last change wins,
and each tab takes the other's rather than writing over it. A running session
and its phase reset on reload. The task on the desk is what a focus block is
for; finished blocks record it.

Everything is kept in this browser's localStorage:

| Key | Holds |
| --- | --- |
| `todos` | The task list (never overwritten while unreadable) |
| `lofai.desk-task` | The task on the desk: `{v, taskId, since}` |
| `lofai.timer` | Work and rest minutes |
| `lofai.sessions` | Finished focus blocks for the last 14 days: start, end, minutes, task |
| `lofai.board` | The desk (v3): every widget and whether it's out, a reading order, each widget's size, and for each layout that has been arranged (desk, compact, phone) where each widget sits and which ones are pinned, plus a few one-time hints. A put-away widget keeps its size and its spot, which is where it comes back to |
| `lofai.board.broken` | An unreadable arrangement, kept once, as it was |
| `lofai.board.future` | An arrangement saved by a newer lofAI, kept apart from unreadable ones so neither costs the other |
| `lofai.board.v1`, `lofai.board.v2` | An older arrangement, copied once when that desk is first changed after the update. Older layouts and pins aren't carried over: the usual desk comes back, with who's out and their sizes kept |
| `lofai.notebook` | The pocket notebook's page: `{v, text, updatedAt}` |
| `lofai.notebook.broken` | An unreadable or newer page, kept once |
| `lofai.clock` | The 12/24-hour choice, once made |
| `lofai.today` | Things finished today that the list has since cleared, so Today still counts them |
| `lofai.seen` | When the desk was last open, for the welcome back |
| `lofai.theme` | The color theme |

Implementation references: [the desk](../frontend/components/desk/desk.tsx),
[its drawer](../frontend/components/desk/drawer.tsx) and
[widget registry](../frontend/components/desk/registry.ts), the
[widgets](../frontend/components/widgets/), the
[board engine](../frontend/lib/board.ts), [tasks](../frontend/components/tasks-provider.tsx),
[timer](../frontend/components/focus-provider.tsx),
[radio state](../frontend/components/radio-provider.tsx), and
[companion](../frontend/components/pet.tsx).

## The desk

The page is a desk of widgets on a grid: 6 columns at 1280px and wider, 4
from 740px, 2 below. Columns are 150 to 224px wide (down to 136 on the
smallest phones). On a desk or a tablet the
rows shrink to fit the window (never shorter than 128px, never taller than a
column is wide), so the usual four rows fit without scrolling; on a phone the
slots are square. Every widget comes in some of five standard sizes, the same
for all of them: S (1×1), M (2×1), L (2×2), W (4×2, "wide") and XL (4×4,
"full"). On a phone, W shows its L content and XL is a tall 2×4 of the same
content. Boxes are fixed and lists scroll inside.

Out of the box the desk is the room as it was before it had widgets: the full
Radio on the left (the ring and play key on top, the sound panel below), and
on the right the cat, Tasks and the focus timer, top to bottom. On a narrower
window the Radio is the tall card on the left with the cat, Tasks and the
timer down the right; on a phone they stack. Nothing is pinned, and the grid only shows while something is
being arranged.

- **The layout.** Each widget has its own spot in each layout (desk, compact,
  phone). It stays exactly where it's set down: beside the others, or on its
  own with open space around it. Setting a widget down never pins it. Arranging
  one layout never changes another, and a layout that hasn't been touched yet
  is the usual desk.
- **Moving.** Press any quiet spot of a widget and drag (a long press on
  touch), or use its grip at the top edge: arrow keys pick it up and move it
  one space at a time, Home and End go to the ends of its row, Enter sets it
  down, Escape puts it back, Delete puts it away. Where it lands follows the
  pointer: the part of the widget being held lands on the cell under it, so
  letting go over a neighbour's lower half lands on that neighbour. The
  widgets it lands on make room: one of the same size trades places with it,
  others move over into the room it left, and failing that they're pushed
  down their columns, taking the ones under them along, as long as nobody is
  pushed past the rows the desk reaches. Let go over a bigger widget that
  can't make room that way (anything over the Radio on the usual, full desk),
  the two trade sides: the bigger one steps over and the dragged one is set
  down on its side, in the row it was let go, unless its own side is nearer.
  Only when nothing takes it does it land on the nearest spot that does (home
  at most); an arrow key steps on past a widget that won't budge or says
  "{Name} is in the way." Carrying it back to where it started in the same
  drag puts everything back.
  Move earlier / Move later in the grip's menu trade places with the neighbour
  in reading order.
- **Pins.** Only on purpose: the small tack in a circle inside a card's
  top-right corner (shown on hover or focus while it's free; filled with the
  accent and always shown once pinned), P on a focused grip (or while it's
  lifted, to pin it where it's set down), or Pin in place in the grip's menu.
  Pinning or unpinning never moves the widget: the tack taps in and a ring
  of the lattice's dots draws in round its slot and fades, or the tack pops
  out and a fainter ring lets go. Nothing is written on the desk; the live
  region says it. A pinned widget doesn't move when others make room and
  can't be dragged; tugged, or nudged with the arrow keys on its grip, it
  gives a little and springs back into the ring round its slot, and says how
  to unpin it. Dropped onto a pinned widget, another lands at the nearest
  spot clear of it; the arrow keys stop at it with "{Name} can't go past a
  pinned widget." Pins are kept per layout.
- **Sizes.** From the resize corner or the grip's menu (+ and − on the grip).
  It grows in place, keeping its top-left, and the widgets it grows over are
  pushed down their columns; only a pin in the way moves it instead. A layout
  nobody has arranged yet closes up the gaps a smaller or put-away widget
  leaves.
- **Motion.** Physical springs (`lib/spring.ts`, drawn by
  `components/desk/motion.ts`) that can change course mid-flight without a
  jump: a widget swells a little as it's picked up and leans with the hand,
  the others glide out of the way nearest first, and a drop keeps the hand's
  speed and lands with a small squash. A pin taps in; unpinned, it pops out.
  Reduced motion turns travel into short fades; low power keeps the moves but
  drops the bounce, the lean and the cast shadow. `?deskperf` in the URL
  records each frame's JS time at `window.__lofaiDeskFrames`.
- **The drawer.** The pull at the bottom centre (or `D`, or the Menu) opens a
  sheet of what isn't out, each tile a static picture of the widget with a
  chip for each of its sizes (the footprint's silhouette), the size it last
  had already chosen. Click a tile to take it out: it rises back onto the spot
  it had in this layout if that's still free (the tile says "goes back to its
  spot"), otherwise into the first free spot in view, otherwise just below
  everything, and the page scrolls to it. Or carry the tile to exactly where
  it should go; the widgets under it make room. Put one away by dropping it on
  the pull, from its menu, or with Delete; a toast offers Undo. Widgets in the
  drawer keep working: the timer keeps running, the radio keeps playing, and a
  few show a sign of life on the pull.
- **Undo.** ⌘Z / Ctrl+Z undoes the last arrangement step (⌘⇧Z or Ctrl+Y
  redoes). While a widget's own toast is up ("Nicely done.", "Thought moved to
  tasks.", "Task removed."), ⌘Z is that toast's Undo.
- **Tidy up** and **Put the usual back** live in the drawer's footer. Tidy up
  moves every unpinned widget up as far as it fits, keeping its column, in one
  step with Undo ("Already tidy." when nothing would move). Put the usual back
  asks first, then brings back the usual desk in every layout (with Undo). An empty desk
  is a real choice, with the music still playing.
- **New widgets** are a module in `frontend/components/widgets/<type>/`
  exporting a `definition` (sizes, a static `Preview`, an optional `Peek`),
  listed in [the registry](../frontend/components/desk/registry.ts); they
  appear in the drawer automatically.

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
| Day shelf | A small chosen set of tasks for today; remaining work stays available | Finishing one leaves a quiet checkmark rather than erasing the evidence |
| Break companion | Optional water, stretch, or look-outside suggestion at break time | The cat stretches too; the prompt can be skipped |
| Session postcard | A short recap at the end of a session or day (Today already shows the day so far) | A warm “you made room for a few things” moment, without scores or penalties |
| Ritual presets | Save sound, theme, and timer preferences together | Personal names such as “rainy reading” or “tiny admin hour” |
| Open-ended focus | Count up when a countdown feels constraining | The same gentle controls and optional break invitation |

On the desk, the notebook and Today now make the current tools work together.
Calendar context comes next. Shared coworking rooms can be explored later,
once the single-person routine feels complete.

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

1. **Connect the local tools.** Task and focus state now live in providers,
   with an active task, remembered timer preferences, a local log of finished
   blocks, and guarded storage writes. Task editing remains.
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
