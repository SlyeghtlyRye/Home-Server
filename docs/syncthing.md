tags: syncthing, backend, frontend, external

# Syncthing Devices

A dashboard panel for managing devices on an existing Syncthing instance.
Syncthing itself is **not** part of this repo's docker-compose stack -- it's
assumed to already be running elsewhere on the network (this host or
another device). The panel talks to that instance's REST API to show
connection status and let you pause/resume, add, rename, and remove
devices, without needing Syncthing's own web GUI for routine management.

## How it works

- `scripts/syncthing_client.py` talks to Syncthing's REST API directly
  (`/rest/config/devices`, `/rest/system/connections`,
  `/rest/system/status`, `/rest/stats/device`, `/rest/db/completion`,
  `/rest/config/folders`, plus pause/resume/add/rename/remove calls)
- `scripts/trigger_server.py` exposes this over HTTP for the dashboard,
  same `?key=` auth pattern as every other integration
- `js/syncthing.js` is the frontend: a connect-once form, then a device
  list with status/completion/last-seen and pause/resume/add/rename/remove

## Connecting

Syncthing's REST API needs a base URL and an API key (found in its web GUI
under Actions -> Settings -> GUI). The Syncthing tab shows a small form for
these on first use; **Connect** validates them with a real API call
(`/rest/system/status`) before saving, so a bad URL or key fails loudly
right away instead of silently breaking every device call afterward.

Once saved, both values live in `scripts/syncthing_config.json`
(gitignored) -- **not** in `.env`. This matters: `.env` gets
wholesale-rewritten by `reset_manager.py`'s `write_env()` on every
setup/reset, which would silently wipe anything added to it that isn't in
that function's own hardcoded template. `scripts/mealie_token.txt` already
established the pattern of keeping a post-setup credential in its own
gitignored file instead, for exactly this reason -- `syncthing_config.json`
follows it. A "Settings" button in the panel re-opens the connect form to
change the URL/key later.

## Device list

Syncthing doesn't expose one endpoint with everything the panel shows, so
`get_devices()` joins several:

| Field | Source |
|---|---|
| Name, paused state | `/rest/config/devices` |
| Connected, address | `/rest/system/connections` |
| Sync completion % | `/rest/db/completion?device=<id>` (only queried for currently-connected devices) |
| Last seen | `/rest/stats/device` |
| Shared folders | `/rest/config/folders`, filtered to folders listing that device |
| "This device" marker | `/rest/system/status`'s `myID`, compared against each device's ID |

The self device (this Syncthing instance's own identity) is always sorted
first and shown without pause/resume/remove actions, since those don't
apply to itself.

## Actions

- **Pause / Resume** -- `POST /rest/system/pause` or `/resume?device=<id>`.
- **Rename** -- a `window.prompt()` for the new name, same free-text
  exception `reset_manager.py`'s Factory Reset confirmation uses (a plain
  yes/no confirm-modal can't take arbitrary text). Fetches the device's
  current config, updates `name`, `PUT`s it back to
  `/rest/config/devices/{id}`.
- **Add** -- a small inline form (device ID + name) `PUT`s a new device to
  `/rest/config/devices/{id}`.
- **Remove** -- `DELETE /rest/config/devices/{id}`, behind the shared
  confirm-modal. Only removes it from this Syncthing instance's known
  devices -- the device itself, and any data on it, is unaffected.

## Extending this feature

See the "Adding a new integration" section in README.md -- this feature
follows the reference pattern from `docs/mealie.md`, adapted for a
service that lives outside this repo's own docker-compose stack (see the
architecture map's `external` layer).
