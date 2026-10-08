tags: kanboard, backend, frontend

# Kanboard Task Board

Pre-alpha foundation for a task board: a calendar with Plan/View/Edit
modes over real tasks on the self-hosted Kanboard instance's "Tasks"
project -- the same philosophy as Mealie's meal planner (talk to the real
service's API directly, no separate local data store), deliberately kept
much simpler since this is a first pass.

(Called "Chores" in earlier builds of this feature -- `TASKS_PROJECT_NAME`
in `scripts/kanboard_client.py` is "Tasks" now, but
`get_or_create_tasks_project()` also checks `LEGACY_PROJECT_NAMES` for a
pre-existing "Chores" project so nothing created before the rename gets
silently orphaned in favor of a brand new, empty "Tasks" project.)

## How it works

- `scripts/kanboard_client.py` talks to Kanboard's JSON-RPC API
  (`POST {KANBOARD_URL}/jsonrpc.php`, HTTP Basic auth as user `jsonrpc`
  with the API token) the same way `scripts/mealie_weekly_plan.py` talks
  to Mealie's REST API -- plain `requests` calls, no SDK, token re-read
  from disk on every call (`get_auth()`) so a freshly-pasted token works
  without a restart.
- `scripts/trigger_server.py` exposes this over HTTP for the dashboard,
  same `TRIGGER_SECRET`-gated `/api/*`/`/data/*` pattern as every other
  integration in this repo.
- `js/kanboard.js` is the frontend: calendar (plan/view/edit), task
  create/done/edit/delete, a "Today's tasks" panel mirroring Mealie's
  meal-of-the-day, and an "assigned to" field per task.

A dedicated **"Tasks" Kanboard project** is auto-created
(`get_or_create_tasks_project()`) if one by that name (or the legacy
"Chores" name) doesn't already exist -- no project-picker UI, matching
how Mealie needs no household/mealplan picker either.

## Where this diverges from Mealie's calendar, and why

Mealie's calendar assumes one meal per day. A day of tasks can have
zero, one, or several, so:

- `plannedMap[iso]` is a **list** of `{id, title, done, assignee,
  startTime, dueTime}`, not a single object.
- Plan mode is NOT Mealie's multi-day "select a week, then preview" flow
  (that shape exists in Mealie because one meal gets chosen per day
  across a week). Here it's a single-step form on the one day you
  clicked: task name, optional from/until time, recurrence, submit, done.
- View and Edit both show a **list** of that day's tasks (each with its
  own done-toggle in View, its own edit/delete in Edit), not a single
  item.
- All three modes center on "the one day you clicked," so unlike Mealie
  (which needs `viewSelectedIso`/`editSelectedIso`/`lastPlanClickedIso`
  plus carry-over logic to hand a day across mode switches), Kanboard
  uses one shared `selectedIso` that's simply never cleared on mode
  switch -- no carry-over logic needed at all. Deliberately simpler, not
  an oversight.
- The day panel (`#kb-mode-panel`) IS Mealie's fixed/floating,
  drag-resizable `#mode-panel` shell, byte-for-byte -- same badge, same
  resize handle, same persisted height/width, same mode-switcher-on-
  badge-click behavior (`renderModePanel()`/`startModePanelResize()` in
  `js/kanboard.js` are near-verbatim copies of their `js/mealie.js`
  counterparts, just targeting `#kb-mode-panel` and their own
  `kanboard_modePanelHeight`/`Width` localStorage keys). The two panels
  are deliberately two separate elements/copies of the logic rather than
  one shared element or a shared core.js component: a shared *element*
  would risk one tab's stray render call landing in the other tab's
  panel (see the DOM-id-prefixing note above), and a shared *component*
  was more refactor/retest risk than this pass needed given there are
  only two consumers so far -- `css/dashboard.css`'s `#mode-panel,
  #kb-mode-panel { ... }` selector groups are what actually keep the two
  *looking* identical without duplicating that CSS.

## Recurrence: pre-materialized real tasks, not Kanboard's recurrence plugin

Kanboard's own recurring-task fields (`recurrence_status`/`trigger`/
`factor`/`timeframe`) only generate the *next* task when the current one
is closed in a specific column -- there's never more than one live task
for a series, which makes it impossible to show future occurrences on a
month calendar. Instead, planning a recurring task creates **N
independent real tasks up front**, each its own `createTask` call with
its own due date (`create_recurring_tasks()`) -- the same philosophy
Mealie uses for a "week" (N individual real mealplan entries; Mealie
itself has no concept of a week).

No series linkage is stored anywhere (no tags, no parent/child task
references) -- v1 treats every occurrence as fully independent the
moment it's created, so Edit and Delete only ever touch one occurrence,
the same as Mealie's Edit mode only ever touching one day. Editing or
deleting "the whole series" isn't a thing yet; re-running Plan later
creates more occurrences manually.

Default occurrence count for a recurring task is **8**, shown as an
editable field in the Plan form. "Every N days," "weekly," and "every N
weeks" are exposed as distinct radio options (matching how this was
asked for) but share one generator under the hood -- weekly is a fixed
interval of 7 days, "every N weeks" is `weeks * 7` with the count typed
in (this replaced an earlier fixed "every other week" option -- same
generator, just no longer hardcoded to N=2), both anchored to the day
you clicked.

Because creating up to ~8 tasks synchronously is fast, `/api/kanboard-
create-task` responds in the same request/response cycle -- no
background-job/poll infrastructure (`current_process`/`/data/status`)
like Mealie's commit flow needed for its slower recipe-creation +
shopping-list sync.

## Assigning a task to someone

The Plan form (and each row in Edit) has an "assigned to" combo box --
type to search existing people, or type a new name and it gets created,
the same "search existing, or create it on save" pattern as Mealie's
recipe combo box (`resolveNewRecipes()`), just for people instead of
recipes, and simpler: there's no separate `isNew` bookkeeping on the
frontend at all, since `get_or_create_person()` on the backend
(`scripts/kanboard_client.py`) handles the lookup-or-create itself from a
plain name string, nothing the frontend needs to pre-resolve.

"Person" means a real Kanboard user (`createUser`), so the task's real
`owner_id` reflects who it's assigned to if you open the real Kanboard
board -- not a tag or a note in the description. These users aren't
meant to ever log in: a random password and (assumed, unverified)
`disable_login_form: true` are the "don't actually function as a login"
signals. `js/kanboard.js` fetches the full list once per tab load
(`/data/kanboard-people` -> `loadPeople()`) for the combo's suggestions,
and refreshes it after any create/edit that included a name, in case it
was a new person.

## Setup

A Kanboard API token is required (`KANBOARD_TOKEN_FILE`, same read-fresh-
from-disk pattern as `MEALIE_TOKEN_FILE`), captured via the same
first-time setup wizard (`js/wizard.js`) as the Mealie token step --
`/data/setup-status` now also reports `kanboard_token_valid`, folded into
`setup_complete`.

## A real bug this already hit: trusting create*'s return value

`createProject` and `createUser`'s JSON-RPC results turned out not to
reliably be the new row's id -- on this install, `createTask` was
rejecting every task outright (`got False`) because `get_or_create_person()`
trusted `createUser`'s return value as the new user's id, and a wrong
`owner_id` fails Kanboard's own foreign-key check on create. Both
`get_or_create_tasks_project()` and `get_or_create_person()` now re-fetch
and look the row up by name/username afterward instead of trusting the
return value -- and `create_task()`'s error message, if `createTask`
still rejects something, now echoes back the exact params sent rather
than a bare "got False", so the next failure (whatever it turns out to
be) is diagnosable from the error popup alone.

That diagnostic immediately caught the next one: `createTask` still
rejected a well-formed request (`owner_id` now a confirmed-real user id)
with the same bare `False`. Kanboard's web UI only ever lets you assign a
task to a *member of that task's project* -- a brand new person created
by `get_or_create_person()` is a real user row, but was never added to
the one project this app creates tasks in, so assigning them likely fails
the same membership rule even though `owner_id` itself is valid.
`_ensure_project_member()` now calls `addProjectUser` before attaching a
new or existing person as `owner_id`, in both `create_task()` and
`update_task()`. Best-effort/silent on failure (wrong method name for
this Kanboard version, or already a member) -- this is a plausible fix
for a failure mode that's hard to fully confirm without the live
instance's exact version, not a verified-correct one yet.

**`date_due`'s format: confirmed against Kanboard v1.2.52's own source,
not assumed, after a first attempt that was actually wrong.** The real
story turned out to be more subtle than "pick the right format":

- `DateParser::getTimestamp()` (`app/Core/DateParser.php`) tries a list
  of format strings via PHP's `DateTime::createFromFormat()`, and plain
  ISO date (`'Y-m-d'`) is one of them -- so `_to_kb_date()`'s original
  `d.isoformat()` was correct all along. The apparent symptom (a newly
  created task's `date_due` coming back as "right now" instead of the
  requested day) wasn't Kanboard failing to parse the string -- it was
  `DateTime::createFromFormat('Y-m-d', ...)` only filling in the date
  fields the format mentions; since `'Y-m-d'` says nothing about time,
  hour/minute/second come out as whatever Kanboard's clock reads as
  "now". The actual calendar *day* was right the entire time -- this was
  misdiagnosed as broken because only the full timestamp was checked,
  not the date portion alone.
- A raw unix timestamp (int or numeric string) is **not** accepted --
  `createTask`/`updateTask` both reject it outright (bare `false`)
  before it reaches the date parser at all. `_to_kb_date()` briefly sent
  this (a regression introduced while chasing the misdiagnosis above)
  and has been reverted back to the plain ISO date string.
- The one thing that *was* a real bug: **Kanboard's container had no
  `TZ` set** (unlike Mealie's, which gets `TZ=${TIMEZONE}`), so it was
  almost certainly running in UTC while reading "now" to fill in that
  leftover time-of-day -- a real day-boundary mismatch risk right around
  local midnight. `docker-compose.yml`'s `kanboard` service now gets
  `TZ=${TIMEZONE}` too, matching Mealie.

All of this was confirmed empirically against the live instance (version
via `getVersion`, exact behavior via one-off `kanboard_client.rpc()`
calls over SSH) before landing the fix, rather than guessing another
format blind. A couple of real tasks got created with the wrong
date/time-of-day while diagnosing this -- worth deleting via Edit mode
if any are still sitting on the board (titles starting `diag-` are the
throwaway test ones from the SSH session, safe to delete outright).

**Final design: every write always sends an explicit date *and* time,
never a bare date.** The `TZ` fix above only helps once Kanboard's
container actually picks it up (unconfirmed -- PHP reads timezone from
`date.timezone` in `php.ini`, which doesn't automatically follow the OS
`TZ` env var the way Python does, see "Known gaps" below) -- and even
with it fixed, a date-only write's "merges with Kanboard's own current
time" behavior is still a real day-boundary risk right around local
midnight. Rather than depend on two separate clocks (this app's and
Kanboard's container) agreeing, `_to_kb_datetime()` is now the *only*
way any date field gets written -- `_to_kb_date()`/date-only writes are
gone entirely. A task with no explicitly chosen time gets midnight
(`NO_TIME = time(0, 0)`) as an explicit, unambiguous value instead of
an implicit "whatever time it happens to be" -- removing the ambiguity
is strictly better than hoping the two clocks match. On the read side,
`get_tasks_in_range()` treats a due time of exactly `NO_TIME` as "no
time was chosen" (shows nothing) rather than as a real midnight
deadline, so this convention stays invisible to someone who never picks
a time at all.

## Start/due times ("from" / "until")

The Plan form (and each row in Edit) has optional **From**/**Until**
`<input type="time">` fields, mapping onto Kanboard's real
`date_started`/`date_due` fields -- not a custom field, since Kanboard
already has two datetime fields per task that fit this naturally. Both
are optional and independent: a task can have neither (just a day, no
specific time), only a due time, only a start time, or both. For a
recurring task, the same from/until clock time applies to every
occurrence (`create_recurring_tasks()`'s `due_time`/`start_time`
params), only the date advances per occurrence.

`get_tasks_in_range()` returns `startTime`/`dueTime` as `"HH:MM"`
strings (or `null`) per task; `js/kanboard.js`'s `timeRangeLabel()`
renders that as "2:00 PM - 4:00 PM" / "From 2:00 PM" / "Until 4:00 PM" in
View, the daily "Today's tasks" panel, and next to each title in Plan's
"already on this day" preview list.

## Known gaps (intentional, for a later pass)

- No "edit the whole series," no skip-one-occurrence-without-deleting.
- `date_due`/`date_started`'s format is now confirmed (`'Y-m-d H:i'` --
  see "Final design" above); the `jsonrpc` auth username and
  `createUser`'s `disable_login_form` param are still unverified against
  the live instance's exact version.
- Whether Kanboard's container actually honors the `TZ` env var added to
  `docker-compose.yml` is unconfirmed -- PHP reads its timezone from
  `date.timezone` in `php.ini`, not automatically from the OS `TZ`
  variable the way Python does, so this may turn out to need a different
  fix (or none, if the image's entrypoint already bridges the two). Low
  priority now that every write is an explicit datetime rather than a
  bare date -- the day-boundary risk this was guarding against is gone
  either way.
- `_ensure_project_member()`'s `addProjectUser` call is a plausible fix,
  not yet confirmed -- if assigning someone still rejects the task, that
  rules this theory out rather than confirming it.
- No visual distinction yet for "all tasks done" vs "something still
  open" on a calendar day beyond the task list itself.
