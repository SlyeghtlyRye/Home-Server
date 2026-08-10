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

Same shared-logic pattern as reset: one module both a CLI flow and the
dashboard call, so they can't drift apart.

- **Check for Update** (`/api/check-update`, GET) -- fetches from the git
  remote, reports whether the local commit differs and what changed.
  Always safe, changes nothing.
- **Install Update** (`/api/apply-update`, POST) -- refuses if there are
  uncommitted local changes (to avoid a merge conflict on a live device),
  otherwise does a fast-forward-only `git pull`, backfills any new `.env`
  keys with sensible defaults from `.env.example` (non-interactively,
  since a web request can't wait on terminal input), regenerates the docs
  index and architecture map, then **restarts services automatically in
  the background** -- no SSH needed.

**How the automatic restart avoids the same self-referential problem as
Factory Reset:** it doesn't restart synchronously inside the request.
`_schedule_background_restart()` spawns a fully detached background
process (`setsid` + a 5-second delay) that survives after the HTTP
response has already been sent back to the browser. By the time the
restart actually runs, the request that triggered it is long finished, so
there's no connection to drop mid-restart. This is a more capable, but
also more carefully engineered, version of the same idea Factory Reset
deliberately avoided -- worth understanding both before changing either.

## Extending this feature

New system-level actions (e.g. viewing logs, a restart button that's safe
because it's *not* self-referential) should go through the same
`reset_manager.py`-style pattern: one function, called for real or in
dry-run, both text-logged, so a "preview" mode is never extra work to keep
in sync.
