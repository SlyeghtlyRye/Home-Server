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

## Why the dashboard-triggered reset doesn't restart services itself

Calling `docker compose up -d --force-recreate` on nginx *from* a request
being served *through* nginx is fragile -- the connection would likely drop
mid-restart on weak hardware. So `/api/reset-execute` deliberately skips
that step (`skip_service_restart=True`) and instead returns a clear message
telling the person to SSH in and run
`docker compose up -d --force-recreate` (or reboot) to finish. The CLI path
via `setup.sh` doesn't have this problem and restarts services automatically.

## Extending this feature

New system-level actions (e.g. viewing logs, a restart button that's safe
because it's *not* self-referential) should go through the same
`reset_manager.py`-style pattern: one function, called for real or in
dry-run, both text-logged, so a "preview" mode is never extra work to keep
in sync.
