tags: syncthing, backend, frontend, container

# Syncthing Devices

A dashboard panel for managing devices and folders across one or more
Syncthing instances, presented as a single unified **"Your Devices"**
list rather than a tab per instance. For a home setup, "an instance you
manage via API key" and "a device paired via Syncthing ID" are almost
always the same physical machine (Host and a10mini are each both at
once) -- keeping them as two separate concepts (a tab bar for instances,
a separate merged view for devices) meant looking at the same 2 machines
through two different lenses and reconciling them yourself. One card per
physical device removes that: each shows connection/sync status, and (for
a device you manage) a **Manage** toggle that expands its Folders,
Bandwidth Limit, and connection details inline, without needing
Syncthing's own web GUI for routine management.

## One card per device, matched by its real Syncthing ID

- **Host** -- always present, even before it's ever been connected
  (shown as a not-yet-connected placeholder card with its own Connect
  form) -- `stc.list_instances()` synthesizes it regardless of whether
  `syncthing_config.json` has an entry for it yet. It can never be fully
  removed, only "Clear"ed back to that placeholder state.
- **Devices you've connected** -- any number of externally-added ones
  (e.g. a phone or handheld running its own Syncthing), added via
  **"+ Connect another of your devices"**. Each gets its own card, and
  *can* be fully removed ("Remove instance" instead of "Clear
  connection" -- same underlying `clear_instance_config()` call, the
  card just doesn't get synthesized back afterward the way Host's does).
- **The merge itself** -- `mergeDevicesById()` fetches
  `/data/syncthing-devices` for every *configured* instance in parallel,
  then groups the results by each device's real Syncthing ID rather than
  showing one row per (instance, device) pair. That ID is the one thing
  genuinely global here (unlike names, which each instance assigns
  independently) -- Host and a10mini paired with each other means Host's
  device list contains itself *and* a10mini, and a10mini's device list
  contains itself *and* Host, so a naive flat merge would show 2 physical
  devices as 4 rows. Each merged card keeps a row underneath per instance
  that knows about it (its own "(itself)" row, plus one per instance it's
  paired with), each with its own status and its own pause/resume/rename
  /remove actions -- those really are separate per-instance operations
  even though they're about "the same" device. Every device here renders
  as its own bordered card (`.st-card-style`), since it's the one place
  rows from different instances sit next to each other.
- **Connection failures** -- a configured instance that fails to connect
  never appears in the merged device list at all (nothing came back to
  group). It usually still gets folded into its existing merged card
  rather than rendered as a standalone one: `instanceSelfIds`
  (`localStorage`-persisted, not just in-memory -- a real Syncthing device
  ID never changes, so there's no staleness risk in remembering it
  indefinitely) remembers each instance's own real Syncthing ID the last
  time its fetch succeeded, and if that ID matches an already-built merged
  group (e.g. Host's device list still shows a10mini as a known, offline
  peer even while a10mini's own instance-management fetch is failing), the
  error is attached to that group instead (`renderMergedDeviceCardHtml`'s
  `erroredInstance` param) -- **"Manage"** becomes **"Fix connection"** and
  expands the connect form. Without this (and specifically without
  persisting it -- an earlier in-memory-only version still showed the
  duplicate whenever the page was freshly loaded while that instance was
  *already* unreachable, since nothing had populated the cache yet that
  session), the exact same physical device would render as two side-by-
  side cards: its own "couldn't connect" card, and a second one for "how
  Host sees it" -- reading as a duplicate rather than one device with a
  connection problem. If we've never learned that instance's own ID either
  (it's been unreachable since before it was ever successfully connected
  to in this browser), `renderYourDevicesHtml()` falls back to matching by
  name instead -- an instance's label and the name it reports for itself
  are normally the same string, since that's how you knew what to call it
  when connecting -- and only when that match is unambiguous (exactly one
  merged card with that name, not already claimed by another error). Only
  when neither match succeeds does it fall back to a genuinely standalone
  card with a **"Fix connection"** button (`editErroredConnection()`) --
  there's nothing to fold it into yet.
  Either way this stays scoped to that one card rather than a page-level
  banner, since a banner at the top would read as "something's wrong with
  the whole page," when it's really just one instance (commonly one
  that's asleep/offline) failing to answer, unrelated to the others.
- **Dismissing a connection error** -- once you've seen an error and know
  it's just "that device isn't around right now" rather than something
  worth fixing, **"Dismiss"** shrinks the standing `.warning-box` down to
  a one-line marker (a status dot + "Not reachable right now" +
  **"Show details"** to bring the full box back), via the shared
  `renderInstanceConnErrorHtml()` used by both the merged-card Manage
  panel and the standalone fallback card. The dismissal is per instance,
  `localStorage`-persisted (`dismissedInstanceErrors`), and clears itself
  automatically the next time that instance connects successfully
  (`refreshAllDevicesOverview()`) -- so a dismissal from today's "it's
  asleep" can't end up silently hiding a genuinely different problem after
  it reconnects tomorrow.

**"+ Connect another of your devices" is deliberately not the same
control as "+ Add Device",** and this distinction is the whole reason the
underlying multi-instance model exists even though the UI no longer
shows it as tabs: connecting a device points *our dashboard* at another
Syncthing's own REST API (so we can manage it too, and later auto-fill
its ID when pairing); adding a device pairs *two Syncthing instances*
with each other (so they can sync folders directly, over Syncthing's own
protocol, independent of whether either side is even managed by this
dashboard).

**Why each device's own row still says "known via `<instance>`", and why
that's correct:** Syncthing has no shared/global device registry -- each
installation keeps its own private list of peers it's configured to sync
with. Pairing Host with a10mini genuinely requires both sides to
separately know about the other; there's no single place to "add a
device" once that covers both. This is Syncthing's own architecture, not
a quirk of how the panel is built. The merged card's per-instance sub-rows
exist specifically to make that ownership visible even though the outer
card no longer says "`<Label>`'s Devices" the way a per-instance tab
used to. There's deliberately no invented "device group" terminology here
-- Syncthing's own docs and GUI don't use that term, so the info tooltip
(`infoTipHtml()`, a small &#x24D8; using the same native `title`-attribute
pattern as every other hint in this codebase) describes the real
mechanism (a separate per-instance list, merged here by real device ID)
rather than a name that would mean nothing if someone went looking for it
in Syncthing itself.

## Pairing your own devices without copy-pasting an ID

The **"+ Add Device"** form's **"Which device?"** picker lists every
device you manage (i.e. every configured instance) alongside a "not
managed here" option. Picking one of your own auto-fills the Device ID
field (read-only) from that instance's own known ID -- found by scanning
the already-loaded merged device list for that instance's `isSelf: true`
row -- and pre-fills the Device Name from its label, both wired via a
`change` listener on `#st-add-device-target` in `js/syncthing.js`. Only
picking **"A device not managed here"** falls back to a manual, editable
Device ID/Name, since that's the one case where we genuinely don't
already know the ID (a friend's Syncthing, no API access). A client-side
guard in `addDevice()` refuses to submit if "Add this device to" and
"Which device?" resolve to the same instance, since pairing a device with
itself is never a valid Syncthing operation.

## Running Syncthing: in this stack, or fully external

The Host card covers one case, "+ Connect another of your devices" covers
the other, and both use the exact same underlying save/edit/clear
machinery:

- **In this stack (Host)** -- `docker-compose.yml` has a `syncthing`
  service (official `syncthing/syncthing` image, `syncthing_data` named
  volume, GUI on port 8384, sync protocol on 22000/tcp+udp, local
  discovery on 21027/udp), with a Docker-level `deploy.resources.limits`
  CPU/memory cap (see "Bandwidth limit" below) so a big transfer can't
  starve the other containers sharing the host. This makes the server
  itself an always-on sync hub: push a folder there once, and any future
  device just needs Syncthing installed and paired to pull it down,
  without depending on any particular other device (a phone, say) being
  powered on and connected.
- **Fully external (connected devices)** -- any Syncthing running
  elsewhere on the network, added via "+ Connect another of your
  devices". Not part of this repo's docker-compose at all; the panel
  doesn't know or care, since every instance (Host included) is stored
  and driven the same way once configured -- a URL + API key in
  `syncthing_config.json`.

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
- `js/syncthing.js` is the frontend: one merged "Your Devices" list
  (`mergeDevicesById()` over every configured instance's device list),
  each managed device's card expandable into a Manage panel (connect/edit
  form, folder list with status/completion/pause/resume/rescan, and
  bandwidth limit), plus the "+ Connect another of your devices" and
  "+ Add Device" forms

## Connecting an instance

Syncthing's REST API needs a base URL and an API key. For **Host**
specifically, the URL field defaults to `http://<HOST_IP>:8384` --
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

Within a merged card's per-instance sub-rows, the self device (that
instance's own identity) is labeled "(itself)", not "(this device)" --
with more than one instance in play, "this device" reads as "the machine
I'm sitting at" (the browser, or the dashboard host), when it actually
means "this row is that instance's own identity," which is a different
device per sub-row. "(itself)" ties the label back to the row's own
instance instead. It's shown without pause/resume/remove actions, since
those don't apply to itself.

Every sub-row carries a small uppercase tag naming which instance it came
from, since a merged card commonly has more than one (its own "(itself)"
row, plus one per instance it's paired with).

Host always sorts first in the merged list -- enforced with an explicit
`.sort((a, b) => Number(b.isHost) - Number(a.isHost))` in
`js/syncthing.js` rather than assumed from `list_instances()`'s ordering,
so it stays true even if that backend ordering ever changes.

**"Add this device to"** (the Add Device form's first picker, renamed
from a bare "Instance") includes a **"+ New instance..."** option that
folds the connect flow into the same form -- pick it and Name/URL/API key
fields appear (toggled via a `change` listener on the select, not a full
re-render) so you can pair with a not-yet-connected device without
leaving to add it first. Choosing "Add" in that state calls
`/api/add-syncthing-instance` first, then `/api/syncthing-device-add`
with the resulting `instanceId` -- both the new instance and the paired
device get created in one submit. The newly-created instance is pushed
directly into the in-memory `instances` array (not re-fetched via
`loadInstances()`) purely to avoid a jarring re-render mid-flow -- it'll
naturally match the server's state on the next real refresh. See
"Pairing your own devices without copy-pasting an ID" above for the
second picker, **"Which device?"**.

## Per-device GUI links

Each device row has a "GUI" link to jump straight to that device's own
Syncthing web interface. Syncthing's REST API has no endpoint that exposes
a remote device's GUI address -- `/rest/system/connections` only reports
the *sync-protocol* address (e.g. `tcp://192.0.2.42:22000`), a different
port than the GUI. So the link is a best-effort guess: same host,
port 8384 (Syncthing's default GUI port) unless overridden.

- The **self** sub-row links to the exact URL of the instance it belongs
  to (passed into the per-source renderer as `instanceBaseUrl`, looked up
  from that row's own `instances[].url`) -- no guessing needed, since
  we're already talking to that instance directly.
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
- **Add** -- one form (`renderAddDeviceSectionHtml()`), always at the
  bottom of the "Your Devices" list rather than looking like a different
  control depending on which card you were just looking at. "Add this
  device to" defaults to Host (or whichever instance is configured) and
  includes a "+ New instance..." option that folds the connect flow into
  the same form. "Which device?" auto-fills Device ID/Name for one of
  your own managed devices, or falls back to manual entry for one you
  don't have API access to -- see "Pairing your own devices without
  copy-pasting an ID" above. Submitting `PUT`s the new device to the
  target instance's `/rest/config/devices/{id}`.
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

Unlike devices, folders only ever show in a single instance's own Manage
panel -- there's no merged "All Folders" view. A folder ID isn't a meaningfully
comparable identity across instances the way a device ID is (Syncthing
device IDs are per-installation certificates that mean the same thing
everywhere; folder IDs are just local labels), so merging them the same
way devices are merged would mostly just be confusing.

- **Pause / Resume** -- folders have no dedicated pause endpoint; it's a
  config field. `set_folder_paused()` fetches the folder's current config,
  flips `paused`, `PUT`s it back to `/rest/config/folders/{id}` -- same
  read-modify-write pattern as device rename.
- **Rescan** -- `POST /rest/db/scan?folder=<id>`.
- **Selective Sync** -- see below.

## Selective sync

Syncthing calls this "Ignore Patterns" -- a per-folder `.stignore` file,
gitignore-style, read/written via `/rest/db/ignores?folder=<id>` (GET
returns `{"ignore": [...]}`, POST replaces it wholesale with a new list).
Rather than exposing that raw pattern syntax, the panel shows a checkbox
file tree and translates checkbox state to/from a simple subset of it:

- **Browsing the tree** -- `browse_folder()` calls Syncthing's own
  `/rest/db/browse?folder=<id>`, which returns the *entire* file tree
  recursively in one response when no `levels` param is given. Fetched
  once per modal open, not lazily per directory -- simpler to implement
  (no incremental fetch-on-expand plumbing) at the cost of one bigger
  request; fine for ROM-library-sized folders, and Syncthing does support
  a `prefix` param for lazy per-level loading if this ever needs to scale
  to huge folders later.
- **Checked = synced, unchecked = excluded.** Unchecking a file writes an
  anchored exact-path pattern (`/relative/path/to/file`); unchecking a
  directory writes `/relative/path/to/dir/**` and cascades the unchecked
  state to every descendant in the UI (`onSelSyncCheckboxChange()` walks
  the subtree via `collectSelSyncDescendantPaths()`). This is a two-state
  model, not tri-state -- a directory checkbox doesn't show "partially
  excluded" if only some of its children are individually unchecked; it
  only reflects whether *the directory itself* was explicitly toggled.
- **Redundant patterns are collapsed on save** -- `selSyncTopLevelIgnoredPaths()`
  only emits a pattern for the top-most excluded ancestor of any subtree,
  since a directory's own `/**` pattern already covers everything
  cascaded into it from unchecking that directory.
- **Pre-existing patterns we don't generate ourselves are preserved, not
  discarded.** `classifySelSyncPattern()` only recognizes plain anchored
  paths (optionally with a trailing `/**`) as "ours" -- anything using
  wildcards (`*`, `?`, `[...]`, `{...}`), a `!` negation, or a `(?...)`
  flag prefix is left alone in `selSyncOtherPatterns` and written back
  unchanged on save. So if a folder already had hand-written ignore rules
  (from Syncthing's own GUI, say), opening and saving from our panel
  won't silently clobber them -- only the checkbox-driven ones round-trip
  through the UI.
- **Search** filters the tree as you type (`#st-selsync-search`, an
  `input` listener -- not `change`, so it reacts per keystroke). A node
  survives the filter if its own name matches, or (for a directory) any
  descendant's does (`selSyncNodeMatches()`); once an ancestor directory's
  own name has matched, everything inside it renders unfiltered --
  searching for a folder means "show me that folder," not "show me only
  the files inside it that also happen to match." Only the tree container
  (`#st-selsync-tree-container`) gets re-rendered on each keystroke
  (`renderSelSyncTreeOnly()`), not the whole modal body -- replacing the
  search `<input>` itself via `innerHTML` on every keystroke would reset
  its focus and cursor position mid-typing.
- **Collapsible directories** track their own open/closed state in
  `selSyncCollapsed` (a `Set` of paths), rather than relying on the
  `<details>` element's native state -- the tree gets rebuilt from scratch
  (`innerHTML`) on every checkbox change and every search keystroke, so
  without our own persisted state every directory would snap back open on
  the next re-render. A directory's `<summary>` click is intercepted
  (`e.preventDefault()`) and handled manually (`onSelSyncDirToggle()`)
  specifically to avoid relying on the browser's native toggle-on-summary-
  click behavior, which is inconsistent across browsers when the summary
  also contains an interactive child (the checkbox). While actively
  searching, matching directories are force-open regardless of
  `selSyncCollapsed`, without mutating it -- clearing the search returns
  to whatever you'd manually collapsed before.
- **"Delete Unchecked From Disk"** (Host only -- the button doesn't render
  for any other instance, checked via `instances.find(...).isHost`) goes
  further than excluding: it also deletes the currently-unchecked files
  from Host's actual storage. It always saves the ignore patterns FIRST
  and awaits that call before deleting anything (`deleteSelectedSelSync()`
  calls `saveSelectiveSyncPatterns()`, extracted out of `saveSelectiveSync()`
  so both paths share it). This ordering matters for safety, not just
  correctness: on a Send & Receive folder, deleting a file Syncthing is
  still actively tracking looks to Syncthing exactly like "this device
  deleted it," and it propagates that deletion to every other device
  sharing the folder -- which would delete the file on a10mini too, the
  opposite of the actual goal ("stop Host from keeping a copy," not
  "delete this everywhere"). Saving the ignore pattern first removes the
  file from Syncthing's tracking for that folder, so the local delete
  afterward is invisible to sync. The delete itself
  (`delete_folder_files()` in `syncthing_client.py`) runs
  `docker exec syncthing rm -rf -- <path>` rather than resolving the
  underlying named volume's real host-side path: Syncthing reports the
  folder's `path` (e.g. `/var/syncthing/gba`) as it appears *inside* that
  container's own filesystem, which is exactly where `docker exec` runs
  commands, so there's no need to guess the Compose-generated volume name
  or inspect its mountpoint. Every path is checked for `..` segments
  before being used, and the container name is hardcoded to `syncthing`
  (matching `docker-compose.yml`'s `container_name`) -- this is
  deliberately Host-only, since this process has no filesystem or
  container access to an externally-connected instance like a10mini.

## Bandwidth limit

A global send/receive rate limit (KiB/s, 0 = unlimited), shown at the
bottom of each managed device's Manage panel. This is Syncthing's own setting --
`maxSendKbps`/`maxRecvKbps` under `/rest/config/options`, alongside a lot
of unrelated global options we don't touch. `get_rate_limits()` reads
just those two fields out of the full options blob; `set_rate_limits()`
does a read-modify-write of the same blob (same pattern as
`set_folder_paused()`) so we never clobber other settings configured
outside our panel. Exposed here purely so you don't have to leave the
dashboard for Syncthing's native GUI to change it.

Lowering this doesn't stop a big transfer, it just spreads it out --
useful when a large initial sync (like a ROM library) is otherwise
saturating CPU/disk/network enough to make the rest of the dashboard feel
slow. The `syncthing` container also has a hard Docker-level cap
(`deploy.resources.limits` in `docker-compose.yml`, currently 1 CPU / 1G
memory) as a second line of defense -- that one guarantees Syncthing
can never starve the other containers on the same host no matter what
its own rate limit is set to.

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
