// syncthing.js -- a unified "Your Connections" panel for one or more
// Syncthing instances. Each Syncthing you manage (the Syncthing container
// in this stack's own docker-compose, always listed even before it's
// ever been connected, plus any number of externally-connected ones
// added via "+ Add another connection") gets one card. Clicking "Manage"
// on a card expands its Folders, Bandwidth Limit, and connection details
// inline -- no separate tab per connection, since for a home setup "a
// connection you manage via API key" and "a device paired via Syncthing
// ID" are almost always the same physical machine. "Connection" and
// "Device" are kept as two deliberately different words throughout this
// UI -- "Device" is reserved for Syncthing's own meaning (a paired peer
// in the sync mesh), "Connection" for the thing THIS dashboard manages
// via a URL + API key, so the two concepts (which frequently describe
// the same physical machine, just from different angles) don't collide
// under one overloaded word. Pairing two of your own connections
// auto-fills the Device ID (we already know it once both sides are
// connected) instead of manual copy-paste; pairing with someone else's
// device (no API access) still takes a manual ID.
// Uses the same event-delegation / status-modal patterns as the other
// modules rather than introducing a new UI pattern.
import { registerApp, showStatusModal, hideStatusModal,
         showErrorBanner, clearErrorBanner, showConfirmModal, escapeHtml } from './core.js';
import { HOST_IP } from './config.js';

const NEW_INSTANCE_OPTION = '__new_instance__'; // "Add this device to" picker's inline "+ New connection..." option
const MANUAL_DEVICE_OPTION = '__manual__'; // "Auto-fill from" picker's "Don't auto-fill" option

let instances = []; // [{id, label, isHost, configured, url}], "host" always present
let expandedInstanceId = null; // connection whose Manage panel (folders/bandwidth/connection) is open, if any
let showConnectForm = false; // show the connect/edit form inside the expanded connection's card
let showAddInstanceForm = false; // "+ Add another connection" inline form
let showAddDeviceForm = false; // the pairing ("+ Add Device") form

let folders = []; // expanded instance's folders
let foldersError = null;
let rateLimits = { maxSendKbps: 0, maxRecvKbps: 0 }; // 0 = unlimited, Syncthing's own convention
let rateLimitsError = null;
let savingRateLimits = false;

let allDevicesList = []; // merged devices across every configured instance
let allDevicesErrors = []; // [{instanceId, label, error}] -- one per instance that failed to load, shown as its own card
// Remembers each instance's own real Syncthing ID (instanceId -> deviceId)
// once we've seen it, so that if that instance later goes unreachable
// (asleep, offline) we can still recognize "the device other instances
// already show as a known peer IS this managed instance" and fold its
// error into that existing merged card instead of rendering a second,
// separate card for what's visibly the same device. Persisted (not just
// in-memory) specifically so this still works on a fresh page load where
// that instance was ALREADY unreachable before we ever got a chance to
// see its ID this session -- a real Syncthing device ID never changes,
// so there's no staleness risk in remembering it indefinitely.
let instanceSelfIds = {};
try {
  instanceSelfIds = JSON.parse(localStorage.getItem('mealie_syncthingSelfIds') || '{}');
} catch (err) {
  instanceSelfIds = {};
}

function rememberInstanceSelfId(instanceId, deviceId) {
  if (instanceSelfIds[instanceId] === deviceId) return;
  instanceSelfIds[instanceId] = deviceId;
  localStorage.setItem('mealie_syncthingSelfIds', JSON.stringify(instanceSelfIds));
}

// An instance's connection error, once you've seen it and know it's just
// "that device isn't around right now" rather than something to fix, can
// be collapsed to a small marker instead of a standing warning box.
// Persisted per instance; cleared automatically the next time that
// instance connects successfully, so a dismissal doesn't silently hide a
// FUTURE, different problem after it reconnects.
let dismissedInstanceErrors = {};
try {
  dismissedInstanceErrors = JSON.parse(localStorage.getItem('mealie_syncthingDismissedErrors') || '{}');
} catch (err) {
  dismissedInstanceErrors = {};
}

function setInstanceErrorDismissed(instanceId, dismissed) {
  if (dismissed) dismissedInstanceErrors[instanceId] = true;
  else delete dismissedInstanceErrors[instanceId];
  localStorage.setItem('mealie_syncthingDismissedErrors', JSON.stringify(dismissedInstanceErrors));
}

// Selective sync modal state -- scoped to whichever folder is currently open.
let selSyncInstanceId = null;
let selSyncFolderId = null;
let selSyncFolderLabel = '';
let selSyncTree = []; // top-level nodes from /rest/db/browse, each with nested .children
let selSyncNodesByPath = new Map(); // relative path -> node, built by indexSelSyncTree()
let selSyncIgnored = new Set(); // relative paths currently excluded (unchecked)
let selSyncOtherPatterns = []; // raw ignore-pattern lines we don't try to interpret as a simple path -- preserved as-is on save
let selSyncCollapsed = new Set(); // directory paths manually collapsed -- everything defaults open
let selSyncSearchQuery = ''; // lowercased filter text; empty = show everything

const DEFAULT_GUI_PORT = 8384;
let stDevicePorts = {}; // per-device GUI port overrides (device ID -> port), local to this browser
try {
  stDevicePorts = JSON.parse(localStorage.getItem('mealie_syncthingDevicePorts') || '{}');
} catch (err) {
  stDevicePorts = {};
}

function getDeviceGuiPort(deviceId) {
  return stDevicePorts[deviceId] || DEFAULT_GUI_PORT;
}

function setDeviceGuiPort(deviceId, port) {
  stDevicePorts[deviceId] = port;
  localStorage.setItem('mealie_syncthingDevicePorts', JSON.stringify(stDevicePorts));
}

// Syncthing's connection "address" is the sync-protocol address (e.g.
// tcp://192.0.2.42:22000), not the GUI address -- there's no API that
// exposes a remote device's GUI port. So this is a best-effort guess:
// same host, default GUI port 8384 unless overridden per-device.
function extractHostFromAddress(address) {
  if (!address) return null;
  const withoutScheme = address.replace(/^[a-z0-9.+-]+:\/\//i, '');
  const bracketed = withoutScheme.match(/^\[([^\]]+)\]:\d+$/);
  if (bracketed) return bracketed[1];
  const plain = withoutScheme.match(/^([^:]+):\d+$/);
  return plain ? plain[1] : null;
}

function buildGuiUrl(host, port) {
  if (!host) return null;
  const hostPart = host.includes(':') ? `[${host}]` : host; // bracket bare IPv6
  return `http://${hostPart}:${port}`;
}

// Syncthing has no official "group" concept for a device list -- each
// instance just keeps its own separate one. These tooltips spell that
// out inline (native title-attribute tooltip, same pattern as every
// other title="..." hint in this codebase) rather than inventing
// terminology Syncthing itself doesn't use.
function infoTipHtml(text) {
  return `<span class="st-info-tip" title="${escapeHtml(text)}">&#x24D8;</span>`;
}

function defaultAddInstanceId() {
  const host = instances.find(i => i.isHost && i.configured);
  if (host) return host.id;
  const anyConfigured = instances.find(i => i.configured);
  return anyConfigured ? anyConfigured.id : 'host';
}

// ---------- Instance list + data loading ----------

async function loadInstances() {
  try {
    const res = await fetch('/data/syncthing-instances');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    instances = data.instances || [];
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load Syncthing instances', err);
    instances = [];
    showErrorBanner("Couldn't reach the server to load Syncthing instances. Check that it's running and try again.");
    renderSyncthingPanel();
    return;
  }
  if (expandedInstanceId && !instances.find(i => i.id === expandedInstanceId)) {
    expandedInstanceId = null;
    showConnectForm = false;
  }
  await refreshAllDevicesOverview();
  if (expandedInstanceId && !showConnectForm) await refreshExpandedInstance();
}

// Toggles a device card's inline Manage panel. Expanding a not-yet-connected
// instance shows the connect form instead of Folders/Bandwidth (nothing to
// manage there yet).
function toggleInstanceManage(id) {
  if (expandedInstanceId === id) {
    expandedInstanceId = null;
    showConnectForm = false;
    renderSyncthingPanel();
    return;
  }
  expandedInstanceId = id;
  showAddDeviceForm = false;
  const inst = instances.find(i => i.id === id);
  showConnectForm = !inst || !inst.configured;
  if (showConnectForm) {
    renderSyncthingPanel();
  } else {
    refreshExpandedInstance();
  }
}

// A configured-but-unreachable instance needs to jump straight to its
// connect form (to fix the URL/key) rather than trying (and failing) to
// also fetch folders the way a normal expand does.
function editErroredConnection(instanceId) {
  expandedInstanceId = instanceId;
  showConnectForm = true;
  showAddDeviceForm = false;
  renderSyncthingPanel();
}

function dismissConnectionError(instanceId) {
  setInstanceErrorDismissed(instanceId, true);
  renderSyncthingPanel();
}

function showConnectionError(instanceId) {
  setInstanceErrorDismissed(instanceId, false);
  renderSyncthingPanel();
}

function openAddInstanceForm() {
  showAddInstanceForm = true;
  renderSyncthingPanel();
}

function cancelAddInstance() {
  showAddInstanceForm = false;
  renderSyncthingPanel();
}

// After any device-level action (pause/resume/rename/remove/pair), refresh
// both the always-visible merged list and whichever instance's Manage
// panel is open -- the action could plausibly affect either.
async function refreshCurrentView() {
  await refreshAllDevicesOverview();
  if (expandedInstanceId && !showConnectForm) await refreshExpandedInstance();
}

// ---------- Folders / bandwidth data (expanded instance only) ----------

async function fetchFoldersData() {
  foldersError = null;
  let res;
  try {
    res = await fetch(`/data/syncthing-folders?instance=${encodeURIComponent(expandedInstanceId)}`);
  } catch (err) {
    console.error("Couldn't reach the server for Syncthing folders", err);
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    foldersError = data.error || `Server responded ${res.status}`;
    folders = [];
    console.error('Syncthing folders request failed', foldersError);
    return;
  }
  const data = await res.json();
  folders = data.folders || [];
}

async function fetchRateLimitsData() {
  rateLimitsError = null;
  let res;
  try {
    res = await fetch(`/data/syncthing-rate-limits?instance=${encodeURIComponent(expandedInstanceId)}`);
  } catch (err) {
    console.error("Couldn't reach the server for Syncthing rate limits", err);
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    rateLimitsError = data.error || `Server responded ${res.status}`;
    console.error('Syncthing rate limits request failed', rateLimitsError);
    return;
  }
  rateLimits = await res.json();
}

async function saveRateLimits() {
  const sendInput = document.getElementById('st-rate-send');
  const recvInput = document.getElementById('st-rate-recv');
  if (!sendInput || !recvInput) return;
  const maxSendKbps = Math.max(0, parseInt(sendInput.value, 10) || 0);
  const maxRecvKbps = Math.max(0, parseInt(recvInput.value, 10) || 0);
  savingRateLimits = true;
  renderSyncthingPanel();
  try {
    const res = await fetch('/api/syncthing-rate-limits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: expandedInstanceId, maxSendKbps, maxRecvKbps })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showStatusModal('Failed to save bandwidth limit: ' + (data.error || res.status), 'error');
      return;
    }
    rateLimits = { maxSendKbps, maxRecvKbps };
    showStatusModal('Bandwidth limit saved.', 'success');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  } finally {
    savingRateLimits = false;
    renderSyncthingPanel();
  }
}

async function refreshExpandedInstance() {
  if (!expandedInstanceId) return;
  await Promise.all([fetchFoldersData(), fetchRateLimitsData()]);
  renderSyncthingPanel();
}

// ---------- All configured instances, merged into "Your Connections" ----------

async function refreshAllDevicesOverview() {
  allDevicesErrors = [];
  // Host sorts first no matter what order instances come back in --
  // explicit, rather than relying on the backend's list_instances()
  // already happening to put it first.
  const configured = instances.filter(i => i.configured)
    .sort((a, b) => Number(b.isHost) - Number(a.isHost));
  if (configured.length === 0) {
    allDevicesList = [];
    renderSyncthingPanel();
    return;
  }
  try {
    const results = await Promise.all(configured.map(async (inst) => {
      const res = await fetch(`/data/syncthing-devices?instance=${encodeURIComponent(inst.id)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { inst, error: data.error || `Server responded ${res.status}`, devices: [] };
      }
      const data = await res.json();
      return { inst, error: null, devices: data.devices || [] };
    }));
    clearErrorBanner();
    allDevicesList = [];
    for (const r of results) {
      if (r.error) {
        allDevicesErrors.push({ instanceId: r.inst.id, label: r.inst.label, error: r.error });
        continue;
      }
      // A dismissal only means "I know THIS is down" -- once it
      // reconnects, a future failure is a new thing worth surfacing
      // again, not something still covered by the old dismissal.
      if (dismissedInstanceErrors[r.inst.id]) setInstanceErrorDismissed(r.inst.id, false);
      for (const d of r.devices) {
        allDevicesList.push({ ...d, instanceId: r.inst.id, instanceLabel: r.inst.label });
        if (d.isSelf) rememberInstanceSelfId(r.inst.id, d.id);
      }
    }
  } catch (err) {
    console.error('Failed to load combined device list', err);
    showErrorBanner("Couldn't reach the server to load Syncthing devices. Check that it's running and try again.");
  }
  renderSyncthingPanel();
}

// ---------- Connect / edit / add / clear instance ----------

// No outer wrapper -- rendered inline inside a device card (either a
// not-yet-connected placeholder card, or the expanded Manage panel).
function renderConnectFormInlineHtml(inst) {
  const editing = inst.configured;
  // First-time connect defaults to a sensible URL when we have one (the
  // Host card already knows the in-stack container's address, same
  // reasoning as Mealie's known URL) -- still fully editable.
  const urlValue = editing
    ? (inst.url ? escapeHtml(inst.url) : '')
    : escapeHtml(inst.url || (inst.isHost ? `http://${HOST_IP}:8384` : ''));
  return `
    <div class="st-inline-form">
      <p style="color:var(--color-text-dim); font-size:13px;">
        ${editing
          ? 'Update the URL and/or API key. Leave the API key blank to keep the one already saved.'
          : (inst.isHost ? "We've pre-filled the address for the Syncthing running on this server -- change it if needed. " : '')
            + 'API key is in Syncthing under Actions &rarr; Settings &rarr; General.'}
      </p>
      <div class="preview-row">
        <span class="date">URL</span>
        <input type="text" id="st-config-url" value="${urlValue}" placeholder="http://192.168.1.50:8384" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
      </div>
      <div class="preview-row">
        <span class="date">API key</span>
        <input type="password" id="st-config-key" placeholder="${editing ? 'Leave blank to keep current key' : 'Paste your API key'}" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
      </div>
      <div class="btn-grid">
        <button class="btn small" data-action="save-instance-config">${editing ? 'Save' : 'Connect'}</button>
        <button class="btn small clear" data-action="cancel-edit-config">Cancel</button>
      </div>
    </div>
  `;
}

async function saveInstanceConfig() {
  const urlInput = document.getElementById('st-config-url');
  const keyInput = document.getElementById('st-config-key');
  const url = urlInput.value.trim();
  const apiKey = keyInput.value.trim();
  const inst = instances.find(i => i.id === expandedInstanceId);
  const editing = !!(inst && inst.configured);
  if (!url) return;
  if (!editing && !apiKey) return; // first-time connect always needs a key
  showStatusModal(editing ? 'Saving...' : 'Connecting...', 'loading');
  try {
    const res = await fetch('/api/save-syncthing-instance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: expandedInstanceId, url, apiKey })
    });
    const data = await res.json();
    if (!data.valid) {
      showStatusModal('Could not connect: ' + (data.error || 'check the URL and API key.'), 'error');
      return;
    }
    hideStatusModal();
    showConnectForm = false;
    await loadInstances();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function startEditConfig() {
  showConnectForm = true;
  renderSyncthingPanel();
}

function cancelEditConfig() {
  // Canceling out of "Edit connection" on an already-healthy instance
  // falls back to its Folders/Bandwidth view; canceling out of an
  // unconfigured or errored placeholder has no such view to fall back to,
  // so collapse the card entirely instead of leaving it stuck open.
  const inst = instances.find(i => i.id === expandedInstanceId);
  const hasError = allDevicesErrors.some(e => e.instanceId === expandedInstanceId);
  if (!inst || !inst.configured || hasError) {
    expandedInstanceId = null;
  }
  showConnectForm = false;
  renderSyncthingPanel();
}

function renderAddInstanceFormHtml() {
  return `
    <div class="week-block">
      <h3>Add Another Connection</h3>
      <p style="color:var(--color-text-dim); font-size:14px;">
        This points the dashboard at another Syncthing you run (e.g. a phone or
        handheld) so you can manage it here too, and pair it with your other
        connections without copying a Device ID by hand. URL is the regular
        address you'd use to open its GUI in a browser; API key is under
        Actions &rarr; Settings &rarr; General there.
      </p>
      <div class="preview-row">
        <span class="date">Name</span>
        <input type="text" id="st-new-instance-label" placeholder="e.g. a10mini" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
      </div>
      <div class="preview-row">
        <span class="date">URL</span>
        <input type="text" id="st-new-instance-url" placeholder="http://192.168.1.50:8384" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
      </div>
      <div class="preview-row">
        <span class="date">API key</span>
        <input type="password" id="st-new-instance-key" placeholder="Paste its API key" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
      </div>
      <div class="btn-grid">
        <button class="btn" data-action="add-instance">Connect</button>
        <button class="btn clear" data-action="cancel-add-instance">Cancel</button>
      </div>
    </div>
  `;
}

async function addInstance() {
  const labelInput = document.getElementById('st-new-instance-label');
  const urlInput = document.getElementById('st-new-instance-url');
  const keyInput = document.getElementById('st-new-instance-key');
  const label = labelInput.value.trim();
  const url = urlInput.value.trim();
  const apiKey = keyInput.value.trim();
  if (!label || !url || !apiKey) return;
  showStatusModal('Connecting...', 'loading');
  try {
    const res = await fetch('/api/add-syncthing-instance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, url, apiKey })
    });
    const data = await res.json();
    if (!data.valid) {
      showStatusModal('Could not connect: ' + (data.error || 'check the URL and API key.'), 'error');
      return;
    }
    hideStatusModal();
    showAddInstanceForm = false;
    await loadInstances();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function clearExpandedInstance() {
  const inst = instances.find(i => i.id === expandedInstanceId);
  if (!inst) return;
  const confirmMsg = inst.isHost
    ? "Clear the saved connection for Host? You'll need to reconnect (URL + API key) to manage it again -- this doesn't affect the Syncthing container itself."
    : `Remove "${inst.label}" from this dashboard? You'll need to re-add it (URL + API key) to manage it again -- this doesn't affect Syncthing itself.`;
  if (!(await showConfirmModal(confirmMsg))) return;
  try {
    const res = await fetch('/api/clear-syncthing-instance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: expandedInstanceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed: ' + (data.error || res.status), 'error'); return; }
    expandedInstanceId = null;
    showConnectForm = false;
    await loadInstances();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

// ---------- Rendering ----------

function formatLastSeen(iso) {
  if (!iso || iso.startsWith('0001-01-01')) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function deviceGuiLinkHtml(d, instanceBaseUrl) {
  if (d.isSelf) {
    return instanceBaseUrl
      ? `<a class="st-gui-link" href="${escapeHtml(instanceBaseUrl)}" target="_blank" rel="noopener" title="Open this Syncthing instance's GUI">&#x1F517; GUI</a>`
      : '';
  }
  const host = extractHostFromAddress(d.address);
  if (!host) return ''; // only known while connected
  const port = getDeviceGuiPort(d.id);
  const url = buildGuiUrl(host, port);
  return `
    <a class="st-gui-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Best-effort guess: ${escapeHtml(host)}:${port} -- click the gear to change the port">&#x1F517; GUI</a>
    <span class="st-gui-port-edit" data-action="edit-gui-port" data-device-id="${escapeHtml(d.id)}" title="Change GUI port (default ${DEFAULT_GUI_PORT})">&#x2699;</span>
  `;
}

// One "Add Device" form -- always the same control, only which connection
// is pre-selected changes. The "Add this device to" picker's "+ New
// connection..." option folds the connect flow into the same form, so
// pairing with a not-yet-connected connection doesn't require leaving to
// add it first. The "Auto-fill from" picker fills the Device ID/Name when
// you pick one of your other managed connections (we already know its
// real Syncthing ID once it's connected) -- manual entry is only needed
// for a device we don't have API access to.
function renderAddDeviceSectionHtml(defaultInstanceId) {
  if (!showAddDeviceForm) {
    return `<div class="btn-grid"><button class="btn small" data-action="show-add-device">+ Add Device</button></div>`;
  }
  const configuredInstances = instances.filter(i => i.configured);
  return `
    <div class="preview-row">
      <span class="date">Add this device to</span>
      <select id="st-add-device-instance" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        ${configuredInstances.map(i => `<option value="${escapeHtml(i.id)}" ${i.id === defaultInstanceId ? 'selected' : ''}>${escapeHtml(i.label)}</option>`).join('')}
        <option value="${NEW_INSTANCE_OPTION}">+ New connection...</option>
      </select>
    </div>
    <div class="preview-row" id="st-add-device-new-instance-row" style="display:none;">
      <span class="date">Connection Name</span>
      <input type="text" id="st-add-device-new-instance-label" placeholder="e.g. Laptop's Syncthing" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
    </div>
    <div class="preview-row" id="st-add-device-new-instance-url-row" style="display:none;">
      <span class="date">URL</span>
      <input type="text" id="st-add-device-new-instance-url" placeholder="http://192.168.1.60:8384" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
    </div>
    <div class="preview-row" id="st-add-device-new-instance-key-row" style="display:none;">
      <span class="date">API key</span>
      <input type="password" id="st-add-device-new-instance-key" placeholder="Paste its API key" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
    </div>
    <div class="preview-row">
      <span class="date">Auto-fill from</span>
      <select id="st-add-device-target" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        <option value="${MANUAL_DEVICE_OPTION}">Don't auto-fill (enter Device ID manually)</option>
        ${configuredInstances.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.label)}</option>`).join('')}
      </select>
    </div>
    <div class="preview-row">
      <span class="date">Device ID</span>
      <input type="text" id="st-add-device-id" placeholder="XXXXXXX-XXXXXXX-XXXXXXX-..." style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
    </div>
    <div class="preview-row">
      <span class="date">Device Name</span>
      <input type="text" id="st-add-device-name" placeholder="e.g. Laptop" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
    </div>
    <div class="btn-grid">
      <button class="btn" data-action="add-device">Add</button>
      <button class="btn clear" data-action="cancel-add-device">Cancel</button>
    </div>
  `;
}

function folderStatusClass(f) {
  if (f.paused) return 'paused';
  if (f.state === 'idle') return 'connected';
  if (f.state === 'scanning' || f.state === 'syncing') return 'syncing';
  if (f.state === 'error') return 'error';
  return 'offline';
}

function renderFolderRowHtml(f) {
  const stateLabel = f.paused ? 'Paused' : (f.state || 'idle');
  const metaParts = [stateLabel, `${f.completion}% synced`];
  if (f.errors) metaParts.push(`${f.errors} error${f.errors === 1 ? '' : 's'}`);
  return `
    <div class="st-device-row" data-folder-id="${escapeHtml(f.id)}">
      <span class="st-status-dot ${folderStatusClass(f)}" title="${escapeHtml(stateLabel)}"></span>
      <div class="st-device-info">
        <div class="st-device-name">${escapeHtml(f.label)}</div>
        <div class="st-device-meta">${metaParts.map(escapeHtml).join(' &middot; ')}</div>
      </div>
      <div class="st-device-actions">
        <button class="btn small" data-action="${f.paused ? 'resume-folder' : 'pause-folder'}" data-folder-id="${escapeHtml(f.id)}">${f.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn small" data-action="rescan-folder" data-folder-id="${escapeHtml(f.id)}">Rescan</button>
        <button class="btn small" data-action="open-selective-sync" data-folder-id="${escapeHtml(f.id)}" data-folder-label="${escapeHtml(f.label)}">Selective Sync</button>
      </div>
    </div>
  `;
}

// ---------- Selective sync (per-folder ignore patterns) ----------
//
// Syncthing calls this "Ignore Patterns" -- a .stignore file per folder,
// gitignore-style. We manage a simple subset directly (checkbox per file
// /directory, cascading when you uncheck a whole directory) rather than
// exposing raw pattern syntax. Any pre-existing pattern we can't
// confidently interpret as "one of ours" (a plain anchored path, with or
// without a trailing /** for a directory) is preserved as-is in
// selSyncOtherPatterns and written back unchanged on save, rather than
// silently dropped.

const GLOB_SPECIAL = /[*?[\]{}]/;

function classifySelSyncPattern(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed.startsWith('//') || !trimmed.startsWith('/')) {
    return { kind: 'other', raw: trimmed };
  }
  let inner = trimmed.slice(1);
  if (inner.endsWith('/**')) inner = inner.slice(0, -3);
  if (!inner || GLOB_SPECIAL.test(inner) || inner.startsWith('!') || inner.startsWith('(?')) {
    return { kind: 'other', raw: trimmed };
  }
  return { kind: 'simple', path: inner };
}

function parseSelSyncPatterns(rawPatterns) {
  const ignoredPaths = new Set();
  const otherPatterns = [];
  for (const raw of rawPatterns || []) {
    const c = classifySelSyncPattern(raw);
    if (c.kind === 'simple') ignoredPaths.add(c.path);
    else if (c.raw) otherPatterns.push(c.raw);
  }
  return { ignoredPaths, otherPatterns };
}

function indexSelSyncTree(nodes, parentPath) {
  for (const node of nodes || []) {
    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    selSyncNodesByPath.set(path, node);
    if (node.type === 'FILE_INFO_TYPE_DIRECTORY') {
      indexSelSyncTree(node.children, path);
    }
  }
}

function collectSelSyncDescendantPaths(node, basePath) {
  const paths = [];
  for (const child of (node.children || [])) {
    const childPath = `${basePath}/${child.name}`;
    paths.push(childPath);
    if (child.type === 'FILE_INFO_TYPE_DIRECTORY') {
      paths.push(...collectSelSyncDescendantPaths(child, childPath));
    }
  }
  return paths;
}

// Only emit a pattern for the top-most excluded ancestor of a subtree --
// a directory's own /** pattern already covers everything cascaded into
// it, so writing patterns for its children too would just be redundant.
function selSyncTopLevelIgnoredPaths() {
  return [...selSyncIgnored].filter(p => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (selSyncIgnored.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  });
}

function buildSelSyncIgnorePatterns() {
  const generated = selSyncTopLevelIgnoredPaths().map(path => {
    const node = selSyncNodesByPath.get(path);
    const isDir = node && node.type === 'FILE_INFO_TYPE_DIRECTORY';
    return isDir ? `/${path}/**` : `/${path}`;
  });
  return [...selSyncOtherPatterns, ...generated];
}

async function openSelectiveSync(instanceId, folderId, folderLabel) {
  selSyncInstanceId = instanceId;
  selSyncFolderId = folderId;
  selSyncFolderLabel = folderLabel;
  selSyncTree = [];
  selSyncNodesByPath = new Map();
  selSyncIgnored = new Set();
  selSyncOtherPatterns = [];
  selSyncCollapsed = new Set();
  selSyncSearchQuery = '';

  const overlay = document.getElementById('st-selsync-overlay');
  const body = document.getElementById('st-selsync-body');
  body.innerHTML = '<div class="recipe-loading">Loading files...</div>';
  overlay.style.display = 'flex';

  try {
    const [ignoresRes, treeRes] = await Promise.all([
      fetch(`/data/syncthing-folder-ignores?instance=${encodeURIComponent(instanceId)}&folder=${encodeURIComponent(folderId)}`),
      fetch(`/data/syncthing-folder-browse?instance=${encodeURIComponent(instanceId)}&folder=${encodeURIComponent(folderId)}`)
    ]);
    if (!ignoresRes.ok || !treeRes.ok) throw new Error('server error');
    const ignoresData = await ignoresRes.json();
    const treeData = await treeRes.json();
    const { ignoredPaths, otherPatterns } = parseSelSyncPatterns(ignoresData.ignore);
    selSyncIgnored = ignoredPaths;
    selSyncOtherPatterns = otherPatterns;
    selSyncTree = treeData.tree || [];
    indexSelSyncTree(selSyncTree, '');
    renderSelectiveSyncBody();
  } catch (err) {
    body.innerHTML = '<p class="meal-empty">Couldn\'t load this folder\'s files.</p>';
  }
}

function closeSelectiveSync() {
  const overlay = document.getElementById('st-selsync-overlay');
  if (overlay) overlay.style.display = 'none';
}

function onSelSyncCheckboxChange(path, checked) {
  // The root-files group's own checkbox isn't a real Syncthing path (it
  // has no path of its own to save an ignore pattern for) -- toggling it
  // cascades straight to every loose top-level file instead, the same
  // effect a real directory's checkbox has on its descendants.
  if (path === SELSYNC_ROOT_FILES_KEY) {
    for (const f of selSyncTree) {
      if (f.type === 'FILE_INFO_TYPE_DIRECTORY') continue;
      if (checked) selSyncIgnored.delete(f.name);
      else selSyncIgnored.add(f.name);
    }
    renderSelSyncTreeOnly();
    return;
  }

  const node = selSyncNodesByPath.get(path);
  if (checked) selSyncIgnored.delete(path);
  else selSyncIgnored.add(path);

  if (node && node.type === 'FILE_INFO_TYPE_DIRECTORY') {
    for (const descendant of collectSelSyncDescendantPaths(node, path)) {
      if (checked) selSyncIgnored.delete(descendant);
      else selSyncIgnored.add(descendant);
    }
  }
  renderSelSyncTreeOnly(); // not the whole body -- keeps the search input's focus/cursor intact
}

function onSelSyncDirToggle(path) {
  if (selSyncCollapsed.has(path)) selSyncCollapsed.delete(path);
  else selSyncCollapsed.add(path);
  renderSelSyncTreeOnly();
}

async function saveSelectiveSyncPatterns() {
  const patterns = buildSelSyncIgnorePatterns();
  const res = await fetch('/api/syncthing-folder-ignores', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: selSyncInstanceId, folderId: selSyncFolderId, ignore: patterns })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || String(res.status));
  }
}

async function saveSelectiveSync() {
  showStatusModal('Saving...', 'loading');
  try {
    await saveSelectiveSyncPatterns();
    hideStatusModal();
    closeSelectiveSync();
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Failed to save: ' + err.message, 'error');
  }
}

// Deletes the currently-unchecked items from disk, not just from sync.
// Only offered for Host, since that's the only Syncthing this server has
// direct filesystem access to (via `docker exec` into its own container --
// an externally-connected instance like a10mini has no such access from
// here). The ignore patterns are saved FIRST and awaited before deleting
// anything: on a Send & Receive folder, deleting a file Syncthing is still
// actively tracking looks to Syncthing like "this device deleted it," and
// it would propagate that deletion to every other device sharing the
// folder -- exactly what we don't want when the goal is just "stop Host
// from keeping a copy," not "delete this from a10mini too." Saving the
// ignore pattern first removes the file from Syncthing's tracking for
// this folder, so the local delete afterward is invisible to sync.
async function deleteSelectedSelSync() {
  const paths = selSyncTopLevelIgnoredPaths();
  if (paths.length === 0) {
    showStatusModal('Nothing is unchecked -- uncheck the files/folders you want deleted first.', 'error');
    return;
  }
  const preview = paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, and ${paths.length - 5} more` : '');
  const confirmed = await showConfirmModal(
    `Stop syncing AND permanently delete from Host's disk: ${preview}? This only affects Host's own copy -- it will not delete anything on other devices.`
  );
  if (!confirmed) return;
  showStatusModal('Saving and deleting...', 'loading');
  try {
    await saveSelectiveSyncPatterns();
    const res = await fetch('/api/syncthing-folder-delete-files', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: selSyncInstanceId, folderId: selSyncFolderId, paths })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Deleted from sync, but failed to delete from disk: ' + (data.error || res.status), 'error'); return; }
    hideStatusModal();
    closeSelectiveSync();
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Failed: ' + err.message, 'error');
  }
}

// True if this node's own name matches the search, or (for a directory)
// any descendant's does -- used to decide whether a node survives the
// filter at all.
function selSyncNodeMatches(node, query) {
  if (node.name.toLowerCase().includes(query)) return true;
  if (node.type === 'FILE_INFO_TYPE_DIRECTORY') {
    return (node.children || []).some(child => selSyncNodeMatches(child, query));
  }
  return false;
}

function renderSelSyncNode(node, parentPath, query) {
  const path = parentPath ? `${parentPath}/${node.name}` : node.name;
  const selfMatches = !!query && node.name.toLowerCase().includes(query);
  if (query && !selfMatches && !selSyncNodeMatches(node, query)) return '';
  const isDir = node.type === 'FILE_INFO_TYPE_DIRECTORY';
  const checked = !selSyncIgnored.has(path);
  if (isDir) {
    // Once an ancestor folder's own name has matched, show everything
    // inside it unfiltered -- searching for a folder means "show me that
    // folder", not "show me only the files inside it that also match".
    const childQuery = selfMatches ? '' : query;
    const isOpen = query ? true : !selSyncCollapsed.has(path);
    return `
      <details class="st-selsync-dir" data-selsync-dir="${escapeHtml(path)}" ${isOpen ? 'open' : ''}>
        <summary>
          <span class="st-selsync-disclosure">&#x25B6;</span>
          <input type="checkbox" data-selsync-path="${escapeHtml(path)}" ${checked ? 'checked' : ''}>
          <span>&#x1F4C1; ${escapeHtml(node.name)}</span>
        </summary>
        <div class="st-selsync-children">
          ${(node.children || []).map(child => renderSelSyncNode(child, path, childQuery)).join('')}
        </div>
      </details>
    `;
  }
  return `
    <div class="st-selsync-file">
      <label>
        <input type="checkbox" data-selsync-path="${escapeHtml(path)}" ${checked ? 'checked' : ''}>
        ${escapeHtml(node.name)}
      </label>
    </div>
  `;
}

// Synthetic path (not a real Syncthing path -- there's nothing to save an
// ignore pattern for) for grouping files that sit directly in the
// folder's root with no subfolder of their own to collapse under -- a
// ROM library dumped flat at the top level, say. Without this, that could
// be hundreds of individual checkbox rows with no way to collapse them as
// a unit, or to select/deselect them all at once, unlike a real subfolder
// (which already does both). Its own checkbox (checked only when every
// file inside is) cascades to all of them via onSelSyncCheckboxChange()'s
// special-case for this key, same effect a real directory's checkbox has
// on its descendants -- and it uses the same folder icon as a real one,
// since visually it's just "a group of files", not worth a separate icon.
const SELSYNC_ROOT_FILES_KEY = '__root_files__';

function renderSelSyncTreeHtml() {
  const query = selSyncSearchQuery.trim().toLowerCase();
  if (!selSyncTree.length) return '<p class="meal-empty">No files found.</p>';

  const dirs = selSyncTree.filter(n => n.type === 'FILE_INFO_TYPE_DIRECTORY');
  const rootFiles = selSyncTree.filter(n => n.type !== 'FILE_INFO_TYPE_DIRECTORY');
  const dirsHtml = dirs.map(n => renderSelSyncNode(n, '', query)).join('');
  const rootFilesHtml = rootFiles.map(n => renderSelSyncNode(n, '', query)).join('');

  let rootFilesBlock = '';
  if (rootFiles.length && !(query && !rootFilesHtml)) {
    const isOpen = query ? true : !selSyncCollapsed.has(SELSYNC_ROOT_FILES_KEY);
    const allChecked = rootFiles.every(f => !selSyncIgnored.has(f.name));
    rootFilesBlock = `
      <details class="st-selsync-dir" data-selsync-dir="${SELSYNC_ROOT_FILES_KEY}" ${isOpen ? 'open' : ''}>
        <summary>
          <span class="st-selsync-disclosure">&#x25B6;</span>
          <input type="checkbox" data-selsync-path="${SELSYNC_ROOT_FILES_KEY}" ${allChecked ? 'checked' : ''}>
          <span>&#x1F4C1; Files (${rootFiles.length})</span>
        </summary>
        <div class="st-selsync-children">
          ${rootFilesHtml}
        </div>
      </details>
    `;
  }

  const combined = rootFilesBlock + dirsHtml;
  if (query && !combined) return '<p class="meal-empty">No files match your search.</p>';
  return combined;
}

function renderSelSyncTreeOnly() {
  const container = document.getElementById('st-selsync-tree-container');
  if (container) container.innerHTML = renderSelSyncTreeHtml();
}

function renderSelectiveSyncBody() {
  const body = document.getElementById('st-selsync-body');
  if (!body) return;
  const inst = instances.find(i => i.id === selSyncInstanceId);
  const deleteButtonHtml = inst && inst.isHost
    ? `<button class="btn small clear" data-action="delete-selective-sync" title="Also delete the unchecked items from Host's disk">Delete Unchecked From Disk</button>`
    : '';
  body.innerHTML = `
    <h2>Selective Sync &mdash; ${escapeHtml(selSyncFolderLabel)}</h2>
    <p style="color:var(--color-text-muted); font-size:13px;">
      Uncheck a file or folder to stop syncing it. Unchecking a folder excludes everything inside it.
    </p>
    <input type="text" id="st-selsync-search" placeholder="Search files..." value="${escapeHtml(selSyncSearchQuery)}" style="width:100%; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px; margin-bottom:8px;">
    <div class="st-selsync-tree" id="st-selsync-tree-container">
      ${renderSelSyncTreeHtml()}
    </div>
    <div class="btn-grid" style="margin-top:15px;">
      <button class="btn" data-action="save-selective-sync">Save</button>
      ${deleteButtonHtml}
      <button class="btn clear" data-action="close-selective-sync">Cancel</button>
    </div>
  `;
}

// Groups the flat per-instance device list by the device's real Syncthing
// ID -- the one thing that's genuinely global (unlike names/labels, which
// each instance assigns independently). The same physical device commonly
// shows up once per instance that knows about it (as "itself" from its
// own instance, as a known remote from every other instance it's paired
// with) -- without this, the list would show N x M rows for what's really
// just N physical devices.
function mergeDevicesById(list) {
  const map = new Map();
  for (const d of list) {
    if (!map.has(d.id)) map.set(d.id, { id: d.id, name: d.name, folders: [], sources: [] });
    const group = map.get(d.id);
    if (d.isSelf) group.name = d.name; // an instance's name for itself is the authoritative one
    for (const f of d.folders) if (!group.folders.includes(f)) group.folders.push(f);
    group.sources.push(d);
  }
  return Array.from(map.values());
}

function mergedStatusClass(group) {
  if (group.sources.some(s => s.connected)) return 'connected';
  if (group.sources.some(s => s.paused)) return 'paused';
  return 'offline';
}

// A connection error you've already seen and know about (device asleep,
// off the network, whatever) can be shrunk to a small marker instead of
// standing as a permanent warning box -- "Dismiss" collapses it, "Show
// details" brings the full error back. Dismissal is per instance and
// clears itself automatically the next time that instance reconnects
// (see refreshAllDevicesOverview()), so it can't end up silently hiding a
// later, different problem.
function renderInstanceConnErrorHtml(instanceId, error) {
  if (dismissedInstanceErrors[instanceId]) {
    return `
      <div class="st-dismissed-error">
        <span class="st-status-dot offline"></span> Not reachable right now
        <span class="st-link-action" data-action="show-connection-error" data-instance-id="${escapeHtml(instanceId)}">Show details</span>
      </div>
    `;
  }
  return `
    <div class="warning-box">
      &#x26A0; Couldn't reach this Syncthing instance: ${escapeHtml(error)}
      <div style="margin-top:6px;">
        <span class="st-link-action" data-action="dismiss-connection-error" data-instance-id="${escapeHtml(instanceId)}">Dismiss -- I know this one isn't around</span>
      </div>
    </div>
  `;
}

// Folders + Bandwidth Limit + connection details for one managed instance,
// shown inline under its card when "Manage" is clicked -- replaces what
// used to be a whole separate tab.
function renderInstanceManagePanelHtml(inst) {
  if (showConnectForm) {
    return `<div class="st-manage-panel">${renderConnectFormInlineHtml(inst)}</div>`;
  }
  const connError = allDevicesErrors.find(e => e.instanceId === inst.id);
  if (connError) {
    return `
      <div class="st-manage-panel">
        ${renderInstanceConnErrorHtml(inst.id, connError.error)}
        <div class="st-connection-links">
          <span class="st-link-action" data-action="start-edit-config">Edit connection</span>
        </div>
      </div>
    `;
  }
  const clearLabel = inst.isHost ? 'Clear connection' : 'Remove connection';
  return `
    <div class="st-manage-panel">
      <div class="shopping-panel-header">
        <h4 style="margin:0;">Folders</h4>
        <div class="st-global-actions">
          <button class="btn small" data-action="pause-all" title="Pause all devices">Pause All</button>
          <button class="btn small" data-action="resume-all" title="Resume all devices">Resume All</button>
        </div>
      </div>
      ${foldersError
        ? `<div class="warning-box">&#x26A0; Couldn't reach this Syncthing instance: ${escapeHtml(foldersError)}</div>`
        : (folders.length === 0 ? '<p style="color:var(--color-text-muted); font-size:13px;">No folders found.</p>' : folders.map(f => renderFolderRowHtml(f)).join(''))}
      ${renderRateLimitHtml()}
      <div class="st-connection-links">
        <span class="st-link-action" data-action="start-edit-config">Edit connection</span>
        <span class="st-link-action" data-action="clear-instance">${clearLabel}</span>
      </div>
    </div>
  `;
}

function renderRateLimitHtml() {
  const tip = infoTipHtml('Caps how fast this Syncthing instance sends/receives data, globally across all devices and folders. 0 = unlimited. Lowering this trades sync speed for less CPU/disk/network load while a big transfer is happening.');
  if (rateLimitsError) {
    return `
      <div style="margin-top:14px;">
        <h4 style="margin:0 0 6px;">Bandwidth Limit ${tip}</h4>
        <div class="warning-box">&#x26A0; Couldn't reach this Syncthing instance: ${escapeHtml(rateLimitsError)}</div>
      </div>
    `;
  }
  return `
    <div style="margin-top:14px;">
      <h4 style="margin:0 0 6px;">Bandwidth Limit ${tip}</h4>
      <div class="st-rate-limit-row">
        <label>Send (KiB/s)
          <input type="number" id="st-rate-send" min="0" step="100" value="${rateLimits.maxSendKbps || 0}">
        </label>
        <label>Receive (KiB/s)
          <input type="number" id="st-rate-recv" min="0" step="100" value="${rateLimits.maxRecvKbps || 0}">
        </label>
        <button class="btn small" data-action="save-rate-limits" ${savingRateLimits ? 'disabled' : ''}>${savingRateLimits ? 'Saving...' : 'Save'}</button>
      </div>
      <p style="color:var(--color-text-muted); font-size:13px;">0 means unlimited. This is Syncthing's own global rate limit, applied here so you don't need to open its native GUI.</p>
    </div>
  `;
}

// One card per physical device (see mergeDevicesById), with a nested row
// per instance that knows about it -- each such row keeps its own status
// and its own actions, since pause/resume/rename/remove are genuinely
// separate per-instance operations even though they're about "the same"
// device. Cards for a device you manage (has an "itself" source with a
// configured instance) get a Manage toggle that expands Folders/Bandwidth
// /connection details inline.
function renderMergedDeviceCardHtml(group, erroredInstance) {
  const statusClass = erroredInstance ? 'offline' : mergedStatusClass(group);
  const statusLabel = erroredInstance ? "Couldn't connect" : (statusClass === 'connected' ? 'Connected' : (statusClass === 'paused' ? 'Paused' : 'Offline'));
  const selfSource = group.sources.find(s => s.isSelf);
  // A managed instance that's currently unreachable has no "itself" source
  // in this group (its own fetch failed) -- erroredInstance is how the
  // caller tells us "this group IS one of your managed instances anyway,
  // matched by its previously-seen self ID" so we still show one card
  // (with Manage -> Fix connection) instead of a second, duplicate one.
  const managedInstance = erroredInstance || (selfSource ? instances.find(i => i.id === selfSource.instanceId && i.configured) : null);
  const isExpanded = !!managedInstance && expandedInstanceId === managedInstance.id;

  const sourcesHtml = group.sources.map(d => {
    const owningInstance = instances.find(i => i.id === d.instanceId);
    const lastSeenText = !d.isSelf && !d.connected ? formatLastSeen(d.lastSeen) : '';
    const statusText = d.isSelf
      ? '(itself)'
      : (d.paused ? 'Paused' : (d.connected
          ? `Connected${d.completion != null ? ` &middot; ${Math.round(d.completion)}% synced` : ''}`
          : `Offline${lastSeenText ? ` &middot; last seen ${lastSeenText}` : ''}`));
    const nameHtml = !d.isSelf
      ? `<span class="st-device-name-text" data-action="start-rename" data-instance-id="${escapeHtml(d.instanceId)}" data-device-id="${escapeHtml(d.id)}" title="Click to rename">${escapeHtml(d.name)}</span> &mdash; `
      : '';
    const actionsHtml = !d.isSelf ? `
      <div class="st-device-actions">
        <button class="btn small" data-action="${d.paused ? 'resume-device' : 'pause-device'}" data-instance-id="${escapeHtml(d.instanceId)}" data-device-id="${escapeHtml(d.id)}">${d.paused ? 'Resume' : 'Pause'}</button>
        <button class="icon-btn-delete" data-action="remove-device" data-instance-id="${escapeHtml(d.instanceId)}" data-device-id="${escapeHtml(d.id)}" title="Remove device">&#x1F5D1;</button>
      </div>
    ` : '';
    return `
      <div class="st-merged-source-row">
        <span class="st-instance-tag">${escapeHtml(d.instanceLabel)}</span>
        <span class="st-merged-source-status">${nameHtml}${statusText}</span>
        ${deviceGuiLinkHtml(d, owningInstance ? owningInstance.url : null)}
        ${actionsHtml}
      </div>
    `;
  }).join('');

  const manageToggleHtml = managedInstance ? `
    <button class="btn small" data-action="toggle-manage" data-instance-id="${escapeHtml(managedInstance.id)}">${isExpanded ? 'Hide' : 'Manage'}</button>
  ` : '';

  return `
    <div class="st-device-row st-card-style st-merged-device-card">
      <span class="st-status-dot ${statusClass}" title="${statusLabel}"></span>
      <div class="st-device-info" style="flex:1;">
        <div class="st-device-name-row">
          <div class="st-device-name">${escapeHtml(group.name)}</div>
          ${manageToggleHtml}
        </div>
        ${group.folders.length ? `<div class="st-device-meta">${group.folders.map(escapeHtml).join(', ')}</div>` : ''}
        <div class="st-merged-sources">${sourcesHtml}</div>
        ${isExpanded ? renderInstanceManagePanelHtml(managedInstance) : ''}
      </div>
    </div>
  `;
}

// A managed instance that's never been connected yet (Host, before you've
// entered its URL/API key, or any instance you've cleared) doesn't appear
// in the merged device list at all -- it needs its own simple placeholder.
function renderUnconfiguredInstanceCardHtml(inst) {
  const isExpanded = expandedInstanceId === inst.id;
  return `
    <div class="st-device-row st-card-style">
      <span class="st-status-dot offline" title="Not connected"></span>
      <div class="st-device-info" style="flex:1;">
        <div class="st-device-name-row">
          <div class="st-device-name">${escapeHtml(inst.label)}</div>
          ${!isExpanded ? `<button class="btn small" data-action="toggle-manage" data-instance-id="${escapeHtml(inst.id)}">Connect</button>` : ''}
        </div>
        <div class="st-device-meta">Not connected yet</div>
        ${isExpanded ? renderConnectFormInlineHtml(inst) : ''}
      </div>
    </div>
  `;
}

// A configured instance that fails to connect never appears in
// allDevicesList (nothing to merge into a card), so it needs its own
// card -- same expand-to-fix-connection pattern as an unconfigured one,
// just starting from an error instead of a blank form.
function renderErroredInstanceCardHtml(inst, error) {
  const isExpanded = expandedInstanceId === inst.id;
  return `
    <div class="st-device-row st-card-style">
      <span class="st-status-dot offline" title="Couldn't connect"></span>
      <div class="st-device-info" style="flex:1;">
        <div class="st-device-name-row">
          <div class="st-device-name">${escapeHtml(inst.label)}</div>
          ${!isExpanded ? `<button class="btn small" data-action="edit-error-connection" data-instance-id="${escapeHtml(inst.id)}">Fix connection</button>` : ''}
        </div>
        <div style="margin-top:6px;">${renderInstanceConnErrorHtml(inst.id, error)}</div>
        ${isExpanded ? `
          ${renderConnectFormInlineHtml(inst)}
          <div class="st-connection-links">
            <span class="st-link-action" data-action="clear-instance">${inst.isHost ? 'Clear connection' : 'Remove connection'}</span>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderYourDevicesHtml() {
  const infoTip = infoTipHtml('Every connection you manage here (Host, plus any others you\'ve added) shown once, matched by its real Syncthing device ID -- Syncthing itself keeps no shared/global device list, each connection has its own, so a row underneath shows each connection that knows about this device. Click "Manage" on one of your own connections to see its folders, bandwidth limit, and connection details.');
  const anyConfigured = instances.some(i => i.configured);
  const unconfigured = instances.filter(i => !i.configured);
  const merged = mergeDevicesById(allDevicesList);
  // An erroring instance whose self ID we've seen before (instanceSelfIds)
  // and that matches an existing merged card gets folded into that card
  // (via renderMergedDeviceCardHtml's erroredInstance param) instead of
  // rendering as a second, separate card for what's visibly the same
  // device -- e.g. a10mini asleep still shows up in Host's own device
  // list as a known (offline) peer, so without this both that entry and
  // a10mini's own "can't connect" card would appear side by side.
  const erroredByGroupId = new Map();
  const standaloneErrored = [];
  for (const e of allDevicesErrors) {
    const inst = instances.find(i => i.id === e.instanceId);
    if (!inst) continue;
    const selfId = instanceSelfIds[inst.id];
    let group = selfId ? merged.find(g => g.id === selfId) : null;
    // Fall back to matching by name when we've never learned this
    // instance's real ID (it's been unreachable since before we ever
    // connected to it successfully) -- an instance's label and the name
    // it reports for itself are normally the same string (that's how you
    // knew what to call it when connecting), so this still catches the
    // common case immediately instead of only after a lucky reconnect.
    // Skipped once a group is already claimed by another error, and only
    // applied when the match is unambiguous (exactly one candidate).
    if (!group) {
      const nameMatches = merged.filter(g =>
        !erroredByGroupId.has(g.id) && g.name.trim().toLowerCase() === inst.label.trim().toLowerCase());
      if (nameMatches.length === 1) group = nameMatches[0];
    }
    if (group) erroredByGroupId.set(group.id, inst);
    else standaloneErrored.push({ inst, error: e.error });
  }
  const noneFound = !anyConfigured && unconfigured.length === 0;
  return `
    <div class="week-block">
      <h3>Your Connections ${infoTip}</h3>
      ${standaloneErrored.map(x => renderErroredInstanceCardHtml(x.inst, x.error)).join('')}
      ${unconfigured.map(inst => renderUnconfiguredInstanceCardHtml(inst)).join('')}
      ${noneFound ? '<p style="color:var(--color-text-muted);">No devices found.</p>' : merged.map(g => renderMergedDeviceCardHtml(g, erroredByGroupId.get(g.id))).join('')}
      <div class="btn-grid">
        <button class="btn small" data-action="show-add-instance">+ Add another connection</button>
      </div>
      ${renderAddDeviceSectionHtml(defaultAddInstanceId())}
    </div>
  `;
}

function renderSyncthingPanel() {
  const el = document.getElementById('syncthing-panel');
  if (!el) return;
  if (instances.length === 0) {
    el.innerHTML = '<div class="week-block"><p style="color:var(--color-text-muted);">Loading...</p></div>';
    return;
  }
  el.innerHTML = renderYourDevicesHtml() + (showAddInstanceForm ? renderAddInstanceFormHtml() : '');
}

// ---------- Device / folder / global actions ----------
// Device actions take instanceId explicitly (read from the row/button
// that triggered it) rather than assuming "the current instance", since
// the merged list mixes rows from several instances at once. Folder/
// bandwidth actions apply to whichever instance's Manage panel is open
// (expandedInstanceId), since those only ever render there.

async function pauseDevice(instanceId, deviceId) {
  try {
    const res = await fetch('/api/syncthing-device-pause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, deviceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to pause: ' + (data.error || res.status), 'error'); return; }
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function resumeDevice(instanceId, deviceId) {
  try {
    const res = await fetch('/api/syncthing-device-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, deviceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to resume: ' + (data.error || res.status), 'error'); return; }
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function removeDevice(instanceId, deviceId, name) {
  if (!(await showConfirmModal(`Remove "${name}" from Syncthing? This only removes it here -- the device itself is unaffected and can be re-added later.`))) return;
  try {
    const res = await fetch('/api/syncthing-device-remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, deviceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to remove: ' + (data.error || res.status), 'error'); return; }
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function startRenameDevice(instanceId, deviceId, currentName) {
  const name = window.prompt(`Rename "${currentName}" to:`, currentName);
  if (!name || !name.trim() || name.trim() === currentName) return;
  try {
    const res = await fetch('/api/syncthing-device-rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, deviceId, name: name.trim() })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Rename failed: ' + (data.error || res.status), 'error'); return; }
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function pauseAllDevices() {
  try {
    const res = await fetch('/api/syncthing-pause-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: expandedInstanceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to pause all: ' + (data.error || res.status), 'error'); return; }
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function resumeAllDevices() {
  try {
    const res = await fetch('/api/syncthing-resume-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: expandedInstanceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to resume all: ' + (data.error || res.status), 'error'); return; }
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function pauseFolder(folderId) {
  try {
    const res = await fetch('/api/syncthing-folder-pause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: expandedInstanceId, folderId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to pause folder: ' + (data.error || res.status), 'error'); return; }
    refreshExpandedInstance();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function resumeFolder(folderId) {
  try {
    const res = await fetch('/api/syncthing-folder-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: expandedInstanceId, folderId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to resume folder: ' + (data.error || res.status), 'error'); return; }
    refreshExpandedInstance();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function rescanFolder(folderId) {
  try {
    const res = await fetch('/api/syncthing-folder-rescan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: expandedInstanceId, folderId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to rescan: ' + (data.error || res.status), 'error'); return; }
    refreshExpandedInstance();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function editGuiPort(deviceId) {
  const current = getDeviceGuiPort(deviceId);
  const input = window.prompt(`GUI port for this device (default ${DEFAULT_GUI_PORT}):`, String(current));
  if (input === null) return;
  const port = parseInt(input.trim(), 10);
  if (!port || port < 1 || port > 65535) {
    showStatusModal('Enter a valid port number (1-65535).', 'error');
    return;
  }
  setDeviceGuiPort(deviceId, port);
  renderSyncthingPanel();
}

async function addDevice() {
  const instanceSelect = document.getElementById('st-add-device-instance');
  const targetSelect = document.getElementById('st-add-device-target');
  const idInput = document.getElementById('st-add-device-id');
  const nameInput = document.getElementById('st-add-device-name');
  const deviceId = idInput.value.trim();
  const name = nameInput.value.trim();
  if (!deviceId) return;

  let instanceId = instanceSelect.value;

  if (targetSelect && targetSelect.value !== MANUAL_DEVICE_OPTION && targetSelect.value === instanceId) {
    showStatusModal("Can't pair a device with itself -- pick a different device.", 'error');
    return;
  }

  if (instanceId === NEW_INSTANCE_OPTION) {
    const labelInput = document.getElementById('st-add-device-new-instance-label');
    const urlInput = document.getElementById('st-add-device-new-instance-url');
    const keyInput = document.getElementById('st-add-device-new-instance-key');
    const label = labelInput.value.trim();
    const url = urlInput.value.trim();
    const apiKey = keyInput.value.trim();
    if (!label || !url || !apiKey) return;
    showStatusModal('Connecting new instance...', 'loading');
    try {
      const res = await fetch('/api/add-syncthing-instance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, url, apiKey })
      });
      const data = await res.json();
      if (!data.valid) {
        showStatusModal('Could not connect new instance: ' + (data.error || 'check the URL and API key.'), 'error');
        return;
      }
      instanceId = data.instanceId;
      instances.push({ id: instanceId, label, isHost: false, configured: true, url });
    } catch (err) {
      showStatusModal('Error: ' + err, 'error');
      return;
    }
  }

  try {
    const res = await fetch('/api/syncthing-device-add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, deviceId, name })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to add device: ' + (data.error || res.status), 'error'); return; }
    hideStatusModal();
    showAddDeviceForm = false;
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

// ---------- Wiring ----------

function findDeviceRow(instanceId, deviceId) {
  return allDevicesList.find(x => x.id === deviceId && x.instanceId === instanceId);
}

function wireDelegatedListeners() {
  const panel = document.getElementById('syncthing-panel');
  panel.addEventListener('change', (e) => {
    if (e.target.id === 'st-add-device-instance') {
      const isNew = e.target.value === NEW_INSTANCE_OPTION;
      ['st-add-device-new-instance-row', 'st-add-device-new-instance-url-row', 'st-add-device-new-instance-key-row']
        .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = isNew ? '' : 'none'; });
      return;
    }
    if (e.target.id === 'st-add-device-target') {
      const idInput = document.getElementById('st-add-device-id');
      const nameInput = document.getElementById('st-add-device-name');
      if (!idInput || !nameInput) return;
      if (e.target.value === MANUAL_DEVICE_OPTION) {
        idInput.value = '';
        idInput.readOnly = false;
        nameInput.value = '';
      } else {
        const selfEntry = allDevicesList.find(d => d.instanceId === e.target.value && d.isSelf);
        const targetInst = instances.find(i => i.id === e.target.value);
        idInput.value = selfEntry ? selfEntry.id : '';
        idInput.readOnly = true;
        nameInput.value = targetInst ? targetInst.label : '';
        if (!selfEntry) {
          showStatusModal("Could not determine that device's ID -- try refreshing, or pick \"Don't auto-fill\" to enter it manually.", 'error');
        }
      }
      return;
    }
  });
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const instanceId = btn.dataset.instanceId;
    const deviceId = btn.dataset.deviceId;
    const folderId = btn.dataset.folderId;
    switch (btn.dataset.action) {
      case 'toggle-manage': return toggleInstanceManage(instanceId);
      case 'edit-error-connection': return editErroredConnection(instanceId);
      case 'dismiss-connection-error': return dismissConnectionError(instanceId);
      case 'show-connection-error': return showConnectionError(instanceId);
      case 'save-instance-config': return saveInstanceConfig();
      case 'start-edit-config': return startEditConfig();
      case 'cancel-edit-config': return cancelEditConfig();
      case 'show-add-instance': return openAddInstanceForm();
      case 'add-instance': return addInstance();
      case 'cancel-add-instance': return cancelAddInstance();
      case 'clear-instance': return clearExpandedInstance();
      case 'pause-all': return pauseAllDevices();
      case 'resume-all': return resumeAllDevices();
      case 'pause-device': return pauseDevice(instanceId, deviceId);
      case 'resume-device': return resumeDevice(instanceId, deviceId);
      case 'remove-device': {
        const d = findDeviceRow(instanceId, deviceId);
        return removeDevice(instanceId, deviceId, d ? d.name : deviceId);
      }
      case 'start-rename': {
        const d = findDeviceRow(instanceId, deviceId);
        return startRenameDevice(instanceId, deviceId, d ? d.name : '');
      }
      case 'edit-gui-port': return editGuiPort(deviceId);
      case 'show-add-device':
        showAddDeviceForm = true;
        return renderSyncthingPanel();
      case 'cancel-add-device':
        showAddDeviceForm = false;
        return renderSyncthingPanel();
      case 'add-device': return addDevice();
      case 'pause-folder': return pauseFolder(folderId);
      case 'resume-folder': return resumeFolder(folderId);
      case 'rescan-folder': return rescanFolder(folderId);
      case 'open-selective-sync': return openSelectiveSync(expandedInstanceId, folderId, btn.dataset.folderLabel || folderId);
      case 'save-rate-limits': return saveRateLimits();
    }
  });

  // The selective-sync modal lives outside #syncthing-panel (as a sibling
  // in #syncthing-root) specifically so renderSyncthingPanel()'s frequent
  // innerHTML replacement never destroys it mid-use -- same reasoning as
  // mealie.js's recipe-modal-overlay. Its own listeners are wired here,
  // once, rather than re-wired on every panel re-render.
  const root = document.getElementById('syncthing-root');
  root.addEventListener('click', (e) => {
    if (e.target.id === 'st-selsync-close' || e.target.id === 'st-selsync-overlay') closeSelectiveSync();
  });
  const selSyncOverlay = document.getElementById('st-selsync-overlay');
  selSyncOverlay.addEventListener('click', (e) => {
    // A directory's disclosure arrow/name (anything in its <summary>
    // except the checkbox) manually drives open/closed state instead of
    // the browser's native <details> toggle, so it survives the tree
    // re-rendering on every checkbox change or search keystroke.
    const summary = e.target.closest('.st-selsync-dir > summary');
    if (summary && !e.target.closest('input')) {
      e.preventDefault();
      return onSelSyncDirToggle(summary.parentElement.dataset.selsyncDir);
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'save-selective-sync') return saveSelectiveSync();
    if (btn.dataset.action === 'delete-selective-sync') return deleteSelectedSelSync();
    if (btn.dataset.action === 'close-selective-sync') return closeSelectiveSync();
  });
  selSyncOverlay.addEventListener('change', (e) => {
    const input = e.target.closest('[data-selsync-path]');
    if (!input) return;
    onSelSyncCheckboxChange(input.dataset.selsyncPath, input.checked);
  });
  selSyncOverlay.addEventListener('input', (e) => {
    if (e.target.id !== 'st-selsync-search') return;
    selSyncSearchQuery = e.target.value;
    renderSelSyncTreeOnly();
  });
}

registerApp('syncthing', {
  title: '&#x1F504; Syncthing',
  bodyHtml: `
    <div id="syncthing-root">
      <div id="conn-error-banner" class="error-banner"></div>
      <div id="syncthing-panel"></div>

      <div class="recipe-modal-overlay" id="st-selsync-overlay">
        <div class="recipe-modal">
          <button class="recipe-modal-close" id="st-selsync-close">&#x2716;</button>
          <div id="st-selsync-body"></div>
        </div>
      </div>
    </div>
  `,
  onRender: () => {
    wireDelegatedListeners();
    instances = [];
    expandedInstanceId = null;
    showConnectForm = false;
    showAddInstanceForm = false;
    showAddDeviceForm = false;
    folders = [];
    foldersError = null;
    rateLimits = { maxSendKbps: 0, maxRecvKbps: 0 };
    rateLimitsError = null;
    allDevicesList = [];
    allDevicesErrors = [];
    // instanceSelfIds and dismissedInstanceErrors are deliberately NOT
    // reset here -- both are persisted to localStorage precisely so they
    // survive re-opening this panel (a fresh onRender), not just re-renders
    // within one visit.
    selSyncInstanceId = null;
    selSyncFolderId = null;
    selSyncTree = [];
    selSyncNodesByPath = new Map();
    selSyncIgnored = new Set();
    selSyncOtherPatterns = [];
    renderSyncthingPanel();
    loadInstances();
  },
});
