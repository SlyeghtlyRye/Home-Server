tags: system, infra, backend, frontend

# System Panel (status & factory reset)

A dashboard section for managing the device itself: live container/service
health, and Factory Reset / Fake Factory Reset, without needing SSH access
for routine checks.

## Status reporting

`scripts/system_status.py` is the single source of truth for system health
-- used by both the CLI (`status.py`) and the dashboard's
`/data/system-status` endpoint, so there's one place that logic lives, not
two copies that can drift apart.

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
| `js/`, `docs/` only | Nothing -- both are DIRECTORY bind mounts, so nginx resolves files inside them fresh on every request, live on next browser refresh |
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
