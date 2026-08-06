# Home Dashboard System

A self-hosted home dashboard combining network ad-blocking, meal planning,
task management, and a custom media player — designed to run on genuinely
low-resource hardware (built and tested on a 1GB RAM ARM SBC).

New here? Start with [SETUP.md](./SETUP.md) instead — this document assumes
setup is already done and is meant as a reference for understanding and
extending the system afterward.

## Design principles

Every piece of this system was built around a few non-negotiable priorities:
- **Simple** over clever
- **Low process/resource intensive** — no build tooling running on-device,
  no heavy frameworks, no unnecessary background jobs
- **No bundler, no build step** on the frontend — plain ES modules loaded
  directly by the browser
- **stdlib Python** on the backend wherever reasonably possible — `requests`
  and `yt-dlp` are the only real third-party dependencies

## Architecture overview

Browser
│
▼
nginx (Docker, port 80)
│
├──► Pi-hole (Docker) — DNS / ad-blocking admin UI
├──► Mealie (Docker) — meal planning UI + API
├──► Kanboard (Docker) — task board UI
└──► trigger_server.py (host, port 9001)
│
├──► mealie_weekly_plan.py — Mealie automation logic
└──► audiobook_lib.py — Streams backend logic
**Why `trigger_server.py` runs on the host, not in Docker:** it needs to do
things (YouTube metadata fetching via `yt-dlp`, filesystem access for
uploaded local media) that are simpler to manage directly on the host than
through container volume/network plumbing, given the low-resource
constraint of avoiding extra containers.

**Why nginx talks to it via `172.17.0.1` instead of a hostname:** nginx's
`proxy_pass` resolver doesn't read `/etc/hosts`, and using a variable in
`proxy_pass` forces per-request DNS lookups that silently fail on hostnames.
The literal Docker bridge gateway IP sidesteps this entirely. This is a
deliberate choice, not a placeholder.

## What each piece does

### nginx (`nginx.conf` + `nginx/templates/default.conf.template`)
Reverse proxy and static file server. Serves `dashboard.html` directly and
proxies every `/data/*` and `/api/*` request to `trigger_server.py`, with
`${TRIGGER_SECRET}` injected via `envsubst` at container startup — the
secret exists only in `.env`, never hardcoded in the config itself. Also
proxies three separate `server_name` blocks (`home.pihole.local`,
`home.meals.local`, `home.chores.local`) straight through to their
respective containers for direct access outside the dashboard.

### `scripts/trigger_server.py`
The main backend API server. Plain stdlib `http.server.ThreadingHTTPServer`
— no framework. Every request must include a `?key=` query parameter
matching `TRIGGER_SECRET` from `config.py`. Routes requests to either
`mealie_weekly_plan.py` or `audiobook_lib.py` depending on the endpoint.

### `scripts/mealie_weekly_plan.py`
All Mealie automation logic: previewing a week of randomly-picked recipes,
committing picks to Mealie's meal plan API, generating/reusing shopping
lists per Sunday-start week, and a no-repeat memory (won't reuse a recipe
planned in the last 7 days) tracked in `scripts/meal_history.json`.

### `audiobooks/audiobook_lib.py`
Streams backend: multi-profile management, YouTube metadata via `yt-dlp`
(no download, no API key), local file upload handling with Range-request
support for seeking, and resume-position tracking with a 3-entry checkpoint
history.

### `scripts/config.py`
Single source of truth for runtime configuration. Reads `/root/.env` with
plain stdlib parsing — no third-party config library. Every script that
needs a machine-specific value (`HOST_IP`, `TRIGGER_SECRET`,
`MEALIE_TOKEN_FILE`, etc.) imports from here rather than hardcoding it.

### `scripts/reset_manager.py`
Shared logic for both first-time setup and factory reset. A single list of
actions (write `.env`, remove personal data, bring up the Docker stack,
restart the trigger service) runs for real or in `--dry-run` mode — dry-run
walks the exact same code path but only prints what it would do, so the
simulator can never drift out of sync with what a real run actually does.

### `dashboard.html`
The frontend. Currently one file containing all CSS and JS for every
feature (this is actively being split into ES modules — see
`docs/` once that lands).

## How the dashboard talks to the backend

1. Browser makes a request to a path like `/data/status`
2. nginx matches a `location` block, proxies to
   `http://172.17.0.1:9001/status?key=<secret>`
3. `trigger_server.py` checks the key, routes to the right handler
4. Handler calls into `mealie_weekly_plan.py` or `audiobook_lib.py`,
   returns JSON
5. nginx passes the response straight back to the browser

No request ever reaches the trigger server without the correct
`TRIGGER_SECRET` — this is the only auth mechanism in the system, so it
relies entirely on the secret being kept out of version control (`.gitignore`
covers `.env`) and out of shell history (avoid typing it directly at a
prompt where possible; prefer scripts/config that read it programmatically).

## Adding a new integration

Following the existing pattern for e.g. a hypothetical new "Notes" feature:

1. **Backend logic** — new file, e.g. `scripts/notes_lib.py`, following the
   same shape as `audiobook_lib.py`: plain functions, no framework,
   `config.py` for any machine-specific values.
2. **Wire it into `trigger_server.py`** — add new endpoint handlers that call
   into `notes_lib.py`, following the existing `?key=` auth pattern.
3. **Add nginx routes** — new `location` blocks in
   `nginx/templates/default.conf.template` proxying to the new endpoints,
   same `${TRIGGER_SECRET}` pattern as everything else.
4. **Frontend module** — a new `notes.js` ES module (once the dashboard
   modularization lands), following the shared player/status-modal patterns
   established by the existing modules rather than introducing a new UI
   pattern.
5. **Document it** — add a tagged markdown file under `docs/` (see the
   self-documentation system) describing what it does and why.
6. **Add any new personal-data files to `.gitignore`** and to
   `reset_manager.py`'s `RESET_TARGETS` list, so factory reset and the
   shareable repo stay accurate.

## Repository structure
/root
├── .env (gitignored — real secrets)
├── .env.example (committed — placeholder template)
├── .gitignore
├── setup.sh (installer / factory reset / dry-run)
├── docker-compose.yml
├── nginx.conf
├── nginx/templates/default.conf.template
├── dashboard.html
├── scripts/
│ ├── config.py
│ ├── reset_manager.py
│ ├── trigger_server.py
│ └── mealie_weekly_plan.py
├── audiobooks/
│ ├── audiobook_lib.py
│ └── add_book.py
├── status.py
├── SETUP.md
└── README.md
Personal/generated data (Mealie token, meal history, Streams library and
profiles, uploaded local media) lives alongside the code but is excluded
from git via `.gitignore` — see `scripts/reset_manager.py`'s
`RESET_TARGETS` for the authoritative list.
