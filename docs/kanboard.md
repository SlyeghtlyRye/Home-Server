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

- `plannedMap[iso]` is a **list** of `{id, title, done, assignee}`, not a
  single object.
- Plan mode is NOT Mealie's multi-day "select a week, then preview" flow
  (that shape exists in Mealie because one meal gets chosen per day
  across a week). Here it's a single-step form on the one day you
  clicked: task name + recurrence, submit, done.
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
editable field in the Plan form. "Every N days," "weekly," and "every
other week" are exposed as distinct radio options (matching how this was
asked for) but share one generator under the hood -- weekly is an
interval of 7 days, every-other-week an interval of 14, both anchored to
the day you clicked.

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

## Known gaps (intentional, for a later pass)

- No "edit the whole series," no skip-one-occurrence-without-deleting.
- No validation that the live instance's actual JSON-RPC auth convention
  (username `jsonrpc`), `date_due` format (assumed ISO `YYYY-MM-DD`), or
  `createUser`'s `disable_login_form` param match what's implemented --
  the first real create/update call against the live instance is the
  place to confirm all three.
- No visual distinction yet for "all tasks done" vs "something still
  open" on a calendar day beyond the task list itself.
