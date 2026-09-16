tags: system, infra, backend, frontend

# System Panel (status & factory reset)

A dashboard section for managing the device itself: live container/service
health, and Factory Reset / Fake Factory Reset, without needing SSH access
for routine checks.

## Status reporting

`scripts/system_status.py` is the source of truth the dashboard's endpoints
call into (`status.py`, the CLI report, is a separate standalone script
with its own copy of this logic -- predates this module and hasn't been
consolidated onto it).

**Split into three independently-fetchable pieces, not one bundle.**
`collect_basics()` (uptime/memory/disk/temp -- a handful of near-instant
reads), `collect_containers()` (`docker ps` + `docker stats --no-stream`,
which has to sample CPU over a brief interval and commonly takes 1-2+
seconds on its own), and `collect_services()` (three systemd services, two
`systemctl` calls each) are exposed as their own endpoints
(`/data/system-status-basics`, `-containers`, `-services`), each rendering
its own `week-block` card in `js/system.js` (`loadBasicsCard()`,
`loadContainersCard()`, `loadServicesCard()`) as soon as ITS fetch
resolves. `collect_status()` still exists and combines all three for a
caller that wants everything in one call, and the original
`/data/system-status` endpoint still works too -- nothing that depended on
the bundled shape broke, the dashboard just stopped using it.

This fixes a real reported problem: the panel used to show one blank
"Loading..." for the whole page, for as long as its slowest piece took --
in practice, `docker stats` gating uptime/memory/disk, which are otherwise
instant. Each card now fetches and fails independently (a broken
containers lookup doesn't block Device or Host Services from rendering),
following the same fetch-throws-vs-non-OK-response split used throughout
this codebase (see `docs/syncthing.md`'s "Error handling" section) --
`fetch()` throwing means our own backend is unreachable (shared page
banner), a non-OK response is scoped to just that one card's own text.

**This is meant as the reference pattern for other panels with more than
one independent data source going forward**, not a one-off fix scoped to
System -- extend it incrementally as a panel is touched anyway, rather
than rewriting every existing panel's loading logic in one pass.

## Host service actions: Restart and Details, deliberately not a shell

Each Host Services row has a **Restart** button and a **Details** toggle
(recent `journalctl -u <name>` output, lazy-fetched and cached the same
way as the update history's commit details -- see `toggleServiceLogs()`).

**This exists instead of a general "run any command" feature, on
purpose.** The request that led here was "let me manage the box from the
dashboard, like being SSH'd in" -- but every endpoint on this dashboard is
gated by the same shared secret (`TRIGGER_SECRET`, passed as a URL query
param), which is a reasonable bar for "only I can check my shopping
list" and a much lower bar than what "arbitrary remote code execution as
whatever user runs mealie-trigger" deserves. That secret can end up
somewhere unexpected (browser history, server access logs, a `Referer`
header) in ways nobody needs to worry about today because the worst case
is "someone pauses my Syncthing" -- a shell endpoint changes the worst
case to "full compromise of the machine." `restart_service()` and
`get_service_logs()` (`scripts/system_status.py`) instead validate `name`
against the exact same fixed `SYSTEMD_SERVICES` list already used for
status reporting -- there is no code path where a request body's string
reaches a shell verbatim, restart or logs.

**`mealie-trigger` restarts itself asynchronously, everything else
restarts synchronously.** `mealie-trigger` is the process serving the
restart request itself -- doing that synchronously would drop the
connection mid-restart, the exact self-referential problem
`_schedule_background_restart()` (see "Software updates" below) already
exists to avoid for the same reason. `restart_service()` special-cases
just that one name to a detached `setsid` + short delay; `icecast2` and
`tailscaled` restart directly, since neither is the process handling the
request.

**The frontend polls for the restart actually finishing, rather than
guessing a fixed wait time.** An earlier version said "give it about 10
seconds, then refresh" -- which is either too short (still down, the
person refreshes into a stale/broken page) or too long (long since done,
they wait pointlessly) depending on how long the restart actually takes,
which varies. `pollUntil()` instead re-checks every second (every 500ms
for `mealie-trigger`) until the thing being restarted actually reports
healthy again, or a generous timeout elapses, and drives the status
modal's message off of that real outcome. For `icecast2`/`tailscaled`
this means polling `/data/system-status-services` until that specific
service's `healthy` flag flips true. For `mealie-trigger` it's slightly
trickier: the very first poll would still see the *pre-restart* process
still running (the actual restart is a couple seconds delayed on the
backend), so `restartService()` requires observing it actually go down
at least once (a failed fetch) before a later successful fetch counts as
"back up" -- otherwise it would falsely report success immediately.

**A silent bug worth remembering:** `restartService()`'s confirm dialog
calls `showConfirmModal()`, which was never added to `system.js`'s import
list from `core.js` -- so every click threw `ReferenceError:
showConfirmModal is not defined` before the dialog could ever appear,
which looked exactly like "the button does nothing" from the outside (no
popup, no error visible anywhere except the browser console). Caught only
by actually opening DevTools and reading the real exception -- a reminder
that "no visible effect" and "no error" are not the same claim, and it's
worth checking the console specifically before assuming a click handler
never fired at all.

## Container actions: Restart and Details, same pattern as Host Services

Each Containers row also has a **Restart** button and a **Details**
toggle (`docker logs --tail 50 <name>`, via `toggleContainerLogs()`/
`get_container_logs()`) -- the exact same shape as Host Services'
actions, including the "why not a shell" reasoning above.

**The allow-list here is the live `docker ps` output, not a second
hardcoded name list.** `restart_container()` and `get_container_logs()`
(`scripts/system_status.py`) validate `name` against
`get_container_info()`'s current keys rather than `CONTAINER_INFO` (which
is metadata-only -- description/image/link for the dashboard cards -- and
deliberately doesn't cover every container Compose might run, `syncthing`
being a real example that's missing from it). Using the live container
list instead means the allow-list can never drift out of sync with
whatever `docker-compose.yml` actually defines, without a second list to
remember to update.

**`nginx` restarts itself detached, for the same reason `mealie-trigger`
does.** Every dashboard request -- this restart request included -- is
proxied through the `nginx` container on its way back to the browser, so
restarting it synchronously risks dropping that very response mid-flight.
`restart_container()` special-cases just that one name to the same
detached `setsid` + short delay pattern as `restart_service()`; every
other container isn't in the request's own path and restarts directly.
`restartContainer()` on the frontend mirrors this: `nginx` gets the same
down-then-up polling treatment (against `/data/system-status-basics`,
since that's what actually confirms the whole dashboard -- not just one
container's `healthy` flag -- is reachable again) that `mealie-trigger`
gets in `restartService()`.

## Factory Reset vs Fake Factory Reset

Both share the exact same code path in `scripts/reset_manager.py`
(`run_reset()`), the same one `setup.sh` uses. The only difference is a
`dry_run` flag -- dry-run mode logs what it *would* do instead of doing it,
so the preview can never fall out of sync with what a real reset actually
does.

- **Fake Factory Reset** (`/api/reset-preview`, GET) -- always safe, changes
  nothing, shown via "Preview" on the System panel.
- **Factory Reset** (`/api/reset-execute`, POST) -- deletes personal data
  (Mealie token, meal history, Streams library/profiles/uploads) and
  regenerates `.env` + `js/config.js` with fresh secrets. Requires typing
  `RESET` to confirm (a plain `prompt()`, not the shared confirm-modal,
  since it needs free-text input rather than a yes/no choice).

## Why Factory Reset doesn't restart services itself

Calling `docker compose up -d --force-recreate` on nginx *from* a request
being served *through* nginx is fragile -- the connection would likely drop
mid-restart on weak hardware. So `/api/reset-execute` deliberately skips
that step (`skip_service_restart=True`) and instead returns a clear message
telling the person to SSH in and run
`docker compose up -d --force-recreate` (or reboot) to finish. Given how
destructive a real reset is, staying conservative here is deliberate.

## Software updates (`scripts/updater.py`)

Same shared-logic pattern as reset: `update.sh` (CLI) and the dashboard
both drive their restart decision from the same `_classify_restart()` in
`updater.py`, so the two can't recommend different things for the same
diff -- they just act on that recommendation differently (see below).

- **Check for Update** (`/api/check-update`, GET) -- fetches from the git
  remote, reports whether the local commit differs and what changed.
  Always safe, changes nothing.
- **Install Update** (`/api/apply-update`, POST) -- refuses if there are
  uncommitted local changes (to avoid a merge conflict on a live device),
  otherwise does a fast-forward-only `git pull`, backfills any new `.env`
  keys with sensible defaults from `.env.example` (non-interactively,
  since a web request can't wait on terminal input), regenerates the docs
  index and architecture map, then **restarts only what the pulled diff
  actually touched, automatically, in the background** -- no SSH needed.

  **The frontend polls for the restart actually finishing, rather than
  guessing a fixed wait time.** An earlier version said "refresh in about
  15 seconds" -- but a pulled diff might restart nothing at all (js/docs-
  only changes), just `mealie-trigger`, or a full `docker compose`
  recreate, and there's no single fixed time that's right for all three
  (a full recreate can genuinely take longer than any short guess).
  `pollForBackendRecovery()` (`js/system.js`) instead re-fetches
  `/data/system-status-basics` every second -- which needs both nginx and
  `mealie-trigger` up, so it naturally covers whichever of those actually
  restarted -- until it's confirmed up, or a 60s timeout elapses. Unlike a
  single-service restart, "nothing needed restarting" is common and real
  here (nginx/trigger never even blip), so it also accepts several
  consecutive successful checks as "done" without requiring an observed
  down-then-up transition, which would otherwise wait out the full
  timeout for something that was never down. The page auto-reloads once
  confirmed up, rather than asking the person to remember to refresh.

**How the automatic restart avoids the same self-referential problem as
Factory Reset:** it doesn't restart synchronously inside the request.
`_schedule_background_restart()` spawns a fully detached background
process (`setsid` + a 5-second delay) that survives after the HTTP
response has already been sent back to the browser. By the time the
restart actually runs, the request that triggered it is long finished, so
there's no connection to drop mid-restart. This is a more capable, but
also more carefully engineered, version of the same idea Factory Reset
deliberately avoided -- worth understanding both before changing either.

**Restarts are scoped to the diff, not blanket.** `_classify_restart()`
looks at which files changed between the old and new commit (plus whether
any new `.env` key got backfilled) and decides the minimum needed:

| Changed paths | What restarts |
|---|---|
| `js/`, `css/`, `docs/` only | Nothing -- all three are DIRECTORY bind mounts, so nginx resolves files inside them fresh on every request, live on next browser refresh |
| `scripts/`, `audiobooks/` | `mealie-trigger.service` only (never Docker -- the containers run pinned images, not this repo's code) |
| `nginx.conf`, `nginx/templates/`, `dashboard.html` | Just the `nginx` container recreated |
| `docker-compose.yml`, a new `.env` key, or any path not listed above | Everything -- all containers force-recreated plus the trigger service, same as before this existed |

That last row is a deliberate fallback, not a gap: an unrecognized path
(a new top-level file, a renamed directory, etc.) can't be reasoned about
safely, so it degrades to the old always-restart-everything behavior
rather than guessing wrong and skipping a needed restart. This means the
scoped version can only ever be as safe as the blanket restart it
replaces, never less -- see `updater.py`'s module docstring for the exact
classification rules.

**`dashboard.html` is grouped with nginx.conf, not with js/docs, and this
was learned the hard way.** It's mounted as a *single-file* bind mount
(`./dashboard.html:/usr/share/nginx/html/index.html:ro`) rather than a
directory mount like `js/` and `docs/`. In production (2026-09-02),
`dashboard.html` on disk had a real change, but nginx's running container
kept serving the old version indefinitely -- `docker exec nginx grep ...`
on the file inside the container showed 0 matches for content confirmed
present on disk, and only recreating the container (`docker compose up -d
--force-recreate nginx`) fixed it. Single-file bind mounts can go stale
this way when the host file is replaced rather than edited in place;
directory mounts don't have this failure mode. If `dashboard.html` is ever
restructured to live inside a mounted directory instead of being mounted
as an individual file, this special-casing in `_classify_restart()` should
be revisited -- it would become safe to treat like js/docs again.

**The CLI (`update.sh`) shows the same plan and lets you override it,
instead of just running it.** After pulling, it runs
`python3 scripts/updater.py plan <local> <remote> [--env-added]`, a small
CLI entrypoint that calls the exact same `_classify_restart()` the
dashboard uses and prints the result as `NAME=0/1` lines that get
`eval`'d straight into bash variables -- no separate bash reimplementation
of the classification rules to drift out of sync. It then prints the
recommended plan and prompts:
- **accept** (default) -- runs exactly the recommended plan.
- **customize** -- lets you type any space-separated subset of
  `pihole kanboard nginx mealie` to recreate (or `all`), plus a separate
  yes/no for `mealie-trigger.service`, overriding the recommendation
  entirely.
- **skip** -- pulls the code but restarts nothing.

This is a deliberately different tradeoff from the dashboard's fully
automatic background restart: the CLI is already an interactive terminal
session (unlike a fire-and-forget HTTP request), so it's a better fit to
show the person the recommendation and let them decide, rather than just
acting on it unattended.

## Extending this feature

New system-level actions (e.g. viewing logs, a restart button that's safe
because it's *not* self-referential) should go through the same
`reset_manager.py`-style pattern: one function, called for real or in
dry-run, both text-logged, so a "preview" mode is never extra work to keep
in sync.
