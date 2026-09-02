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

Syncthing's REST API needs a base URL and an API key. The URL is just the
regular address you'd use to open Syncthing in a browser (e.g.
`http://192.168.1.50:8384`); the API key is in Syncthing under
Actions -> Settings -> General. The Syncthing tab shows a small form for
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
follows it.

There's deliberately no in-app way to change the URL/API key once
connected (an earlier "Settings" button that just re-opened the same
connect form added a click without adding value). To reconnect elsewhere,
delete `scripts/syncthing_config.json` over SSH and reload the tab -- the
connect form reappears automatically since `is_configured()` goes back to
`false`.

A connection failure worth knowing about: **403 Forbidden despite a
correct API key** is a documented Syncthing behavior (DNS-rebinding
protection, a.k.a. "host check") rejecting the request based on the `Host`
header, separate from authentication. It can come up when Syncthing's GUI
listens on `0.0.0.0` (all interfaces, needed for this dashboard to reach
it from another device at all) but doesn't recognize the specific
IP/hostname the request arrived on. The documented fix is enabling
"Insecure Skip Host-check" under Syncthing's own Settings -> GUI --
unconfirmed against a real 403 in this setup as of writing, so treat it as
the first thing to try, not a guaranteed fix.

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

## Per-device GUI links

Each device row has a "GUI" link to jump straight to that device's own
Syncthing web interface. Syncthing's REST API has no endpoint that exposes
a remote device's GUI address -- `/rest/system/connections` only reports
the *sync-protocol* address (e.g. `tcp://192.0.2.42:22000`), a different
port than the GUI. So the link is a best-effort guess: same host,
port 8384 (Syncthing's default GUI port) unless overridden.

- The **self** device links to the exact configured URL (`baseUrl` in the
  `/data/syncthing-devices` response) -- no guessing needed, since that's
  the instance the panel is already talking to.
- **Other** devices only get a link while connected (no address is known
  otherwise), built by `extractHostFromAddress()` + `buildGuiUrl()` in
  `js/syncthing.js`. A gear icon next to the link lets you override the
  port per device via a prompt; overrides live in `localStorage`
  (`mealie_syncthingDevicePorts`), not the backend -- this is purely a
  per-browser display convenience, not data worth round-tripping through
  the server.

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
