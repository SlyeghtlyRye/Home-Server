tags: syncthing, backend, frontend, container

# Syncthing Devices

A dashboard panel for managing devices and folders across one or more
Syncthing instances. Each instance is its own tab; the panel talks to
that instance's REST API to show connection/sync status and let you
pause/resume (per-device or all at once), add, rename, and remove
devices, and pause/resume/rescan folders, without needing Syncthing's own
web GUI for routine management. An "All Devices" tab merges every
connected instance's devices into one list, so there's a single place to
see (and act on) everything without switching tabs.

## Multiple instances: Host, plus any number of connected ones

This isn't one connection you point at whichever Syncthing you care about
-- it's a tab per instance, because that's what the data actually is:

- **Host** -- a permanent tab representing the Syncthing container in
  this stack's own `docker-compose.yml`. It's always listed, even before
  it's ever been connected (shown as a not-yet-connected placeholder with
  its own Connect form) -- `stc.list_instances()` synthesizes it
  regardless of whether `syncthing_config.json` has an entry for it yet.
  It can never be fully removed from the tab bar, only "Clear"ed back to
  that placeholder state.
- **Connected instances** -- any number of externally-added ones (e.g. a
  phone or handheld running its own Syncthing), added via
  **"+ Connect Instance"**. Each gets its own permanent tab, labeled with
  whatever name you gave it, and *can* be fully removed ("Remove
  instance" instead of "Clear connection" -- same underlying
  `clear_instance_config()` call, the tab just doesn't get synthesized
  back afterward the way Host's does).
- **All Devices** -- not a real instance, a merged read-only-ish view:
  fetches `/data/syncthing-devices` for every *configured* instance in
  parallel, tags each device with which instance it came from, and lets
  you pause/resume/rename/remove right from the merged list (each action
  carries the device's own `instanceId`, read from the row that triggered
  it, rather than assuming "whichever tab is active" the way single-
  instance actions do). Every device here renders as its own bordered
  card (`.st-card-style`, only applied on this view -- the single-
  instance tabs keep the plain divided-list look), since it's the one
  place rows from different instances sit next to each other and
  benefit from a clearer visual boundary. If an instance fails to load
  entirely (offline, connection refused, etc.), it shows as its own
  collapsed, amber `<details>` card (`.st-instance-error-card`) --
  `⚠ <label> — Couldn't connect`, expandable to the raw error text --
  rather than a page-level banner. That distinction matters: a banner at
  the top would read as "something's wrong with the whole page," when
  it's really just one instance (commonly one that's asleep/offline)
  failing to answer, unrelated to the others.

**"+ Connect Instance" is deliberately not called "Add Device",** and
this distinction is the whole reason the multi-instance design exists:
connecting an instance points *our dashboard* at another Syncthing's own
REST API (so we can manage it too); adding a device pairs *two Syncthing
instances* with each other (so they can sync folders directly, over
Syncthing's own protocol, independent of whether either side is even
managed by this dashboard). An earlier single-instance version conflated
these because there was only one "Add" button in the whole panel, and
it wasn't obvious which of the two very different things it did.

**Why "Add Device" shows up once per instance, and why that's correct:**
Syncthing has no shared/global device registry -- each installation keeps
its own private list of peers it's configured to sync with. Pairing Host
with a10mini genuinely requires both sides to separately know about the
other; there's no single place to "add a device" once that covers both.
This is Syncthing's own architecture, not a quirk of how the panel is
built. Each instance tab's "Devices" header is labeled `<Label>'s
Devices` (not just "Devices") specifically to make that ownership
explicit, and carries an info tooltip (`infoTipHtml()`, a small
&#x24D8; using the same native `title`-attribute pattern as every other
hint in this codebase) spelling out that it's a separate list and that
pairing needs the same device added on the other side too. There's
deliberately no invented "device group" terminology here -- Syncthing's
own docs and GUI don't use that term, so the tooltip describes the real
mechanism (a separate per-instance list) rather than a name that would
mean nothing if someone went looking for it in Syncthing itself.

## Running Syncthing: in this stack, or fully external

The Host tab covers one case, "+ Connect Instance" covers the other, and
both use the exact same underlying save/edit/clear machinery:

- **In this stack (Host)** -- `docker-compose.yml` has a `syncthing`
  service (official `syncthing/syncthing` image, `syncthing_data` named
  volume, GUI on port 8384, sync protocol on 22000/tcp+udp, local
  discovery on 21027/udp). This makes the server itself an always-on sync
  hub: push a folder there once, and any future device just needs
  Syncthing installed and paired to pull it down, without depending on
  any particular other device (a phone, say) being powered on and
  connected.
- **Fully external (connected instances)** -- any Syncthing running
  elsewhere on the network, added via "+ Connect Instance". Not part of
  this repo's docker-compose at all; the panel doesn't know or care,
  since every instance (Host included) is stored and driven the same way
  once configured -- a URL + API key in `syncthing_config.json`.

## How it works

- `scripts/syncthing_client.py` talks to Syncthing's REST API directly
  (`/rest/config/devices`, `/rest/config/folders`,
  `/rest/system/connections`, `/rest/system/status`,
  `/rest/stats/device`, `/rest/db/completion`, `/rest/db/status`,
  `/rest/db/scan`, plus pause/resume/add/rename/remove calls), against
  whichever instance's config is passed to it -- every function takes an
  `instance_id` first
- `scripts/trigger_server.py` exposes this over HTTP for the dashboard,
  same `?key=` auth pattern as every other integration; devices/folders
  GETs take `?instance=<id>`, action POSTs take `instanceId` in the body
- `js/syncthing.js` is the frontend: a tab per instance (plus the merged
  "All Devices" tab and the "+ Connect Instance" form), each with its own
  connect/edit form, device list (status/completion/last-seen/GUI-link,
  pause/resume/rename/remove, plus a global pause/resume all), and folder
  list (status/completion, pause/resume/rescan)

## Connecting an instance

Syncthing's REST API needs a base URL and an API key. For the **Host**
tab specifically, the URL field defaults to `http://<HOST_IP>:8384` --
the in-stack container -- since that's already known the same way
Mealie's URL is (`js/config.js`'s `HOST_IP`, imported into
`js/syncthing.js` just for this default); it's still a plain editable
text field. The API key can't be defaulted the same way (Syncthing
generates a unique one per instance) -- it's in Syncthing under
Actions -> Settings -> General. **Connect** validates both with a real
API call (`/rest/system/status`) before saving, so a bad URL or key fails
loudly right away instead of silently breaking every device call
afterward.

Once saved, every instance's URL + API key live together in
`scripts/syncthing_config.json` (gitignored) -- **not** in `.env`. This
matters: `.env` gets wholesale-rewritten by `reset_manager.py`'s
`write_env()` on every setup/reset, which would silently wipe anything
added to it that isn't in that function's own hardcoded template.
`scripts/mealie_token.txt` already established the pattern of keeping a
post-setup credential in its own gitignored file instead, for exactly
this reason -- `syncthing_config.json` follows it, just keyed by instance
ID instead of holding a single value.

**Edit connection** re-opens the same form, clearly labeled "Editing
`<label>` Connection" (distinct from "Connect `<label>`", so it can't be
mistaken for a fresh setup) with the URL prefilled from the already-saved
value. The API key field is left blank rather than prefilled -- it's
never sent back to the browser in the first place, for the same reason
`mealie_token.txt`'s value never is. Leaving it blank on save means "keep
the key I already have": the `/api/save-syncthing-instance` handler in
`trigger_server.py` falls back to the existing stored key whenever
`apiKey` arrives empty, re-validating with `test_connection()` either
way. **Clear connection** (Host) / **Remove instance** (everything else)
both call the same `clear_instance_config()`, deleting that instance's
entry from the config file -- the only difference is what happens next:
Host's tab persists (synthesized as a placeholder by `list_instances()`
regardless of whether it's configured), an externally-connected
instance's tab disappears entirely, since it only existed in the config
to begin with. An earlier single-instance version had neither action --
just a "Settings" button that reopened a blank form requiring everything
retyped, including a key you can't even see to copy -- which added a
click without adding value.

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
| Self marker | `/rest/system/status`'s `myID`, compared against each device's ID |

The self device (that Syncthing instance's own identity) is always
sorted first and shown without pause/resume/remove actions, since those
don't apply to itself. It's labeled "(itself)", not "(this device)" --
with multiple instances/tabs, "this device" reads as "the machine I'm
sitting at" (the browser, or the dashboard host), when it actually means
"this row is the instance-you're-viewing's own identity," which is a
different device depending on which tab is active. "(itself)" ties the
label back to the row's own instance instead.

On the **All Devices** overview specifically, every device row also
carries a small uppercase tag naming which instance it came from (since
rows from different instances are mixed together there) -- and a given
real-world device can legitimately appear more than once, if it's known
to more than one of your connected instances (Syncthing device IDs are
per-installation certificates, so the same physical device shows the
same ID everywhere it's paired).

## Per-device GUI links

Each device row has a "GUI" link to jump straight to that device's own
Syncthing web interface. Syncthing's REST API has no endpoint that exposes
a remote device's GUI address -- `/rest/system/connections` only reports
the *sync-protocol* address (e.g. `tcp://192.0.2.42:22000`), a different
port than the GUI. So the link is a best-effort guess: same host,
port 8384 (Syncthing's default GUI port) unless overridden.

- The **self** device links to the exact URL of the instance it belongs
  to (passed into `renderDeviceRowHtml()` as `instanceBaseUrl` -- the
  active tab's `baseUrl` on a single-instance tab, or that row's own
  `instances[].url` on the merged All Devices view) -- no guessing
  needed, since we're already talking to that instance directly.
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
- **Add** -- one form (`renderAddDeviceSectionHtml()`), used identically
  everywhere it appears -- a single instance's own tab, or the All
  Devices overview -- rather than looking like a different control
  depending on where you are. It always includes a "To" instance picker
  (defaulting to whichever instance/tab you opened it from, but able to
  target any configured instance), plus Device ID and Name, and
  `PUT`s the new device to that instance's `/rest/config/devices/{id}`.
- **Remove** -- `DELETE /rest/config/devices/{id}`, behind the shared
  confirm-modal. Only removes it from that Syncthing instance's known
  devices -- the device itself, and any data on it, is unaffected.

## Folders

A separate "Folders" section lists each shared folder from
`/rest/config/folders`, joined with live state from `/rest/db/status?
folder=<id>` (Syncthing doesn't include state/byte-counts in the config
response, same reasoning as the device list join). Each row shows a
status dot (green idle, blue syncing/scanning, amber paused, red error),
sync %, and error count if any, plus:

Unlike devices, folders only ever show on a single instance's own tab --
there's no merged "All Folders" view. A folder ID isn't a meaningfully
comparable identity across instances the way a device ID is (Syncthing
device IDs are per-installation certificates that mean the same thing
everywhere; folder IDs are just local labels), so merging them the same
way devices are merged would mostly just be confusing.

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
follows the reference pattern from `docs/mealie.md`, with one addition:
the multi-instance model (a permanent Host slot + any number of
user-added ones, each independently connected) if a future integration
ever needs to manage more than one instance of the same kind of external
service.
