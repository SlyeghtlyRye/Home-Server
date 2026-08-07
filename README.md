# Home Dashboard System

A self-hosted home dashboard combining network ad-blocking, meal planning,
task management, and a custom media player — designed to run on genuinely
low-resource hardware (built and tested on a device with 1GB RAM).

New here? Start with [SETUP.md](./SETUP.md) for the full step-by-step
install guide. Quick summary of what that involves:

## Quick start

1. **Get the device on your network and find its IP** -- flash the OS,
   set up Wi-Fi credentials before first boot if there's no Ethernet
   port, then locate it (SETUP.md covers this in detail, including the
   no-Ethernet Wi-Fi case).
2. **One short SSH session** to install Docker, clone this repo, and run
   `./setup.sh` -- it asks two questions (your device's IP, your timezone)
   and handles everything else automatically: secrets, config files, the
   background service, and bringing up all containers.
3. **Everything after that happens in a browser.** Open
   `http://<your-device-ip>/` and you'll land on a working dashboard. A
   banner walks you through the two things that can't be automated --
   pasting a Mealie API token and creating your first Streams profile --
   right there in the browser, with live verification, no more SSH needed.
4. **What you end up with:** ad-blocking (Pi-hole), automated meal
   planning with shopping lists (Mealie), a task board (Kanboard), a
   multi-profile media player (Streams), self-updating documentation, and
   a System panel for live status checks and factory reset -- all on one
   dashboard, all running locally, no cloud dependency.

This document (README.md) is the reference for *after* setup --
architecture, what each piece does, and how to extend it. SETUP.md has
the full walkthrough with troubleshooting for known rough edges.

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

```
Browser
|
v
nginx (Docker, port 80)
|
+--> Pi-hole (Docker) -- DNS / ad-blocking admin UI
+--> Mealie (Docker) -- meal planning UI + API
+--> Kanboard (Docker) -- task board UI
+--> trigger_server.py (host, port 9001)
|
+--> mealie_weekly_plan.py -- Mealie automation logic
+--> audiobook_lib.py -- Streams backend logic
+--> system_status.py -- container/service health
+--> reset_manager.py -- setup wizard, factory reset
```

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
Shared logic for first-time setup, factory reset, and the in-browser setup
wizard. A single list of actions (write `.env`, generate `js/config.js`,
install the systemd service, remove personal data, bring up the Docker
stack) runs for real or in `--dry-run` mode — dry-run walks the exact same
code path but only prints what it would do, so the preview can never drift
out of sync with what a real run actually does. `setup.sh` calls this
directly over SSH; the dashboard's System panel calls it indirectly via
`trigger_server.py`.

### `scripts/system_status.py`
Single source of truth for system/container health (uptime, memory, disk,
Docker container status, host systemd services). Used by both the CLI
report (`status.py`) and the dashboard's `/data/system-status` endpoint.

### `dashboard.html`
The frontend shell — HTML structure, CSS (with a `:root` custom-properties
design system), and the `<script type="module">` tags that load each
feature module below. No feature-specific logic lives here directly
anymore; each feature is its own ES module.

### `js/core.js`
Application shell: the app registry (`registerApp`), view switching,
the shared status/confirm modal, error banner helpers, and the persistent
header/nav. Feature modules register themselves here rather than this file
knowing about any specific feature — adding a new integration never
requires editing `core.js`.

### `js/mealie.js`, `js/streams.js`, `js/docs.js`, `js/system.js`
One ES module per feature (meal planning, media player, documentation
browser, system status/reset), each following the same pattern: register
with `core.js`, render into its own container, use event delegation for
anything that re-renders (calendar days, book cards, etc.) rather than
rebinding listeners on every update.

### `js/wizard.js`
First-time setup wizard. Runs once on page load, checks
`/data/setup-status`; if incomplete, injects a dismissible banner above the
grid guiding the person through pasting a Mealie API token (verified live
against Mealie's API before being accepted) and creating their first
Streams profile. Deliberately self-contained — doesn't modify `core.js`.

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
4. **Frontend module** — a new `notes.js` ES module, following the
   `registerApp()` pattern in `core.js` and the shared status-modal/
   error-banner/event-delegation patterns established by the existing
   modules rather than introducing a new UI pattern.
5. **Document it** — add a tagged markdown file under `docs/` (see the
   self-documentation system) describing what it does and why.
6. **Add it to the architecture map** — one entry in
   `docs/architecture-map.py` (what it is, its layer, what it connects
   to), then run `python3 scripts/generate_architecture_map.py`. If you
   forget, the completeness check will flag it the next time anyone runs
   that script.
7. **Add any new personal-data files to `.gitignore`** and to
   `reset_manager.py`'s `RESET_TARGETS` list, so factory reset and the
   shareable repo stay accurate.

## Repository structure
```
/root
├── .env (gitignored — real secrets)
├── .env.example (committed — placeholder template)
├── .gitignore
├── setup.sh (installer / factory reset / dry-run)
├── docker-compose.yml
├── nginx.conf
├── nginx/templates/default.conf.template
├── dashboard.html
├── js/
│ ├── core.js (shell, registry, modals, nav)
│ ├── config.js (generated — browser-side HOST_IP)
│ ├── static-apps.js (Pi-hole, Kanboard)
│ ├── mealie.js
│ ├── streams.js
│ ├── docs.js
│ ├── system.js (status + factory reset)
│ └── wizard.js (first-time setup banner)
├── scripts/
│ ├── config.py
│ ├── reset_manager.py
│ ├── system_status.py
│ ├── generate_docs_index.py
│ ├── generate_architecture_map.py
│ ├── trigger_server.py
│ └── mealie_weekly_plan.py
├── audiobooks/
│ ├── audiobook_lib.py
│ └── add_book.py
├── docs/
│ ├── mealie.md
│ ├── streams.md
│ ├── config-and-setup.md
│ ├── nginx-and-networking.md
│ ├── system-panel.md
│ ├── architecture-map.py (data — edit this, not the .svg)
│ ├── architecture-map.svg (generated — do not hand-edit)
│ ├── architecture-map.md
│ ├── security.md
│ └── index.md (generated — do not hand-edit)
├── status.py
├── SETUP.md
└── README.md
```

Personal/generated data (Mealie token, meal history, Streams library and
profiles, uploaded local media) lives alongside the code but is excluded
from git via `.gitignore` — see `scripts/reset_manager.py`'s
`RESET_TARGETS` for the authoritative list.
