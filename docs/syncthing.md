tags: syncthing, backend, frontend, container, external

# Syncthing Devices

A dashboard panel for managing devices and folders on a Syncthing
instance. The panel talks to a REST API to show connection/sync status
and let you pause/resume (per-device or all at once), add, rename, and
remove devices, and pause/resume/rescan folders, without needing
Syncthing's own web GUI for routine management.

## Running Syncthing: in this stack, or fully external

Unlike Mealie/Pi-hole/Kanboard, Syncthing has **two** valid setups, and
the panel's design (connect via URL + API key, saved separately, editable
later) works identically either way:

- **In this stack** -- `docker-compose.yml` has a `syncthing` service
  (official `syncthing/syncthing` image, `syncthing_data` named volume,
  GUI on port 8384, sync protocol on 22000/tcp+udp, local discovery on
  21027/udp). This makes the server itself an always-on sync hub: push a
  folder there once, and any future device just needs Syncthing installed
  and paired to pull it down, without depending on any particular other
  device (a phone, say) being powered on and connected. Point the panel
  at `http://<HOST_IP>:8384` and connect the same way as any instance.
- **Fully external** -- point the panel at a Syncthing instance running
  somewhere else on the network entirely (another device, not managed by
  this repo's docker-compose at all). This was the original design and
  still works unchanged -- the panel doesn't know or care which case it's
  in, since it's just a URL + API key either way.

Nothing about `scripts/syncthing_client.py`, `trigger_server.py`, or
`js/syncthing.js` differs between the two cases -- see "Edit connection"
below if you need to point the panel at a different instance later (e.g.
migrating from an external device to the in-stack one).

## How it works

- `scripts/syncthing_client.py` talks to Syncthing's REST API directly
  (`/rest/config/devices`, `/rest/config/folders`,
  `/rest/system/connections`, `/rest/system/status`,
  `/rest/stats/device`, `/rest/db/completion`, `/rest/db/status`,
  `/rest/db/scan`, plus pause/resume/add/rename/remove calls)
- `scripts/trigger_server.py` exposes this over HTTP for the dashboard,
  same `?key=` auth pattern as every other integration
- `js/syncthing.js` is the frontend: a connect form (with an editable,
  deletable saved connection), a device list with
  status/completion/last-seen/GUI-link and pause/resume/add/rename/remove
  (plus a global pause/resume all), and a folder list with
  status/completion and pause/resume/rescan

## Connecting

Syncthing's REST API needs a base URL and an API key. The URL field
defaults to `http://<HOST_IP>:8384` -- the in-stack container -- since
that's already known the same way Mealie's URL is (`js/config.js`'s
`HOST_IP`, imported into `js/syncthing.js` just for this default); it's
still a plain editable text field for anyone pointing at a fully external
instance instead. The API key can't be defaulted the same way (Syncthing
generates a unique one per instance) -- it's in Syncthing under
Actions -> Settings -> General. **Connect** validates both with a real
API call (`/rest/system/status`) before saving, so a bad URL or key fails
loudly right away instead of silently breaking every device call
afterward.

Once saved, both values live in `scripts/syncthing_config.json`
(gitignored) -- **not** in `.env`. This matters: `.env` gets
wholesale-rewritten by `reset_manager.py`'s `write_env()` on every
setup/reset, which would silently wipe anything added to it that isn't in
that function's own hardcoded template. `scripts/mealie_token.txt` already
established the pattern of keeping a post-setup credential in its own
gitignored file instead, for exactly this reason -- `syncthing_config.json`
follows it.

**Edit connection** re-opens the same form, clearly labeled "Editing
Syncthing Connection" (distinct from the first-time "Connect to
Syncthing" heading, so it can't be mistaken for a fresh setup) with the
URL prefilled from the already-saved value. The API key field is left
blank rather than prefilled -- it's never sent back to the browser in the
first place, for the same reason `mealie_token.txt`'s value never is.
Leaving it blank on save means "keep the key I already have": the
`/api/save-syncthing-config` handler in `trigger_server.py` falls back to
the existing stored key whenever `apiKey` arrives empty, re-validating
with `test_connection()` either way. **Delete connection** removes
`scripts/syncthing_config.json` entirely (behind the shared confirm
modal) and returns to the first-time connect form. An earlier version had
neither -- just a "Settings" button that reopened a blank form requiring
everything retyped, including a key you can't even see to copy -- which
added a click without adding value.

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

- **Pause / Resume** (per device) -- `POST /rest/system/pause` or
  `/resume?device=<id>`.
- **Pause All / Resume All** (global) -- the same two endpoints called
  *without* a `device` param, which is Syncthing's own documented
  behavior for "apply to every device at once." No loop over devices
  needed on our side.
- **Rename** -- a `window.prompt()` that names the device being renamed
  (`Rename "Living Room PC" to:`, not a bare "Rename device:" -- the
  crude first version left it ambiguous which device you were editing).
  Same free-text exception `reset_manager.py`'s Factory Reset confirmation
  uses (a plain yes/no confirm-modal can't take arbitrary text). Fetches
  the device's current config, updates `name`, `PUT`s it back to
  `/rest/config/devices/{id}`.
- **Add** -- a small inline form (device ID + name) `PUT`s a new device to
  `/rest/config/devices/{id}`.
- **Remove** -- `DELETE /rest/config/devices/{id}`, behind the shared
  confirm-modal. Only removes it from this Syncthing instance's known
  devices -- the device itself, and any data on it, is unaffected.

## Folders

A separate "Folders" section lists each shared folder from
`/rest/config/folders`, joined with live state from `/rest/db/status?
folder=<id>` (Syncthing doesn't include state/byte-counts in the config
response, same reasoning as the device list join). Each row shows a
status dot (green idle, blue syncing/scanning, amber paused, red error),
sync %, and error count if any, plus:

- **Pause / Resume** -- folders have no dedicated pause endpoint; it's a
  config field. `set_folder_paused()` fetches the folder's current config,
  flips `paused`, `PUT`s it back to `/rest/config/folders/{id}` -- same
  read-modify-write pattern as device rename.
- **Rescan** -- `POST /rest/db/scan?folder=<id>`.

## Error handling: our backend vs. Syncthing itself

`/data/syncthing-devices` and `/data/syncthing-folders` can fail two
different ways, and the frontend treats them differently on purpose:

- **`fetch()` itself throws** -- nginx or `trigger_server.py` is
  unreachable. A real "the dashboard's backend is down" situation, shown
  via the shared page-level error banner (`showErrorBanner()`), same as
  every other module uses for actual backend outages.
- **The response comes back but isn't OK (its body has `.error`)** --
  our backend is fine; it reached out to *Syncthing* (at the configured
  URL) and that failed -- most commonly because the configured instance
  itself is offline or unreachable on the network. This is scoped to the
  Devices/Folders panel itself as a `.warning-box` with the actual error
  text, specifically so it doesn't read as "the whole dashboard is
  broken" when it's really just "your Syncthing instance didn't answer."
  An earlier version conflated both cases into the same generic page
  banner, which was actively misleading.

## Extending this feature

See the "Adding a new integration" section in README.md -- this feature
follows the reference pattern from `docs/mealie.md`, adapted for a
service that lives outside this repo's own docker-compose stack (see the
architecture map's `external` layer).
