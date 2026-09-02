// syncthing.js -- devices/folders panel for one or more Syncthing
// instances. A permanent "Host" tab represents the Syncthing container in
// this stack's own docker-compose (always listed, even before it's ever
// been connected); any number of externally-connected instances (e.g. a
// phone/handheld running Syncthing elsewhere) show up as additional
// tabs, added via "+ Connect Instance" -- deliberately not called "Add
// Device", since it's a different operation: it points OUR DASHBOARD at
// another Syncthing's own REST API, rather than pairing two Syncthing
// instances with each other (that's what "Add Device" does, and it's the
// same form everywhere, always with an instance picker, rather than
// looking like a different control depending on which tab you're on).
// "All Devices" merges every connected instance's devices into one list
// so there's a single place to see everything without switching tabs.
// Uses the same event-delegation / status-modal patterns as the other
// modules rather than introducing a new UI pattern.
import { registerApp, showStatusModal, hideStatusModal,
         showErrorBanner, clearErrorBanner, showConfirmModal, escapeHtml } from './core.js';
import { HOST_IP } from './config.js';

const ALL_DEVICES_TAB = '__all__';
const ADD_INSTANCE_TAB = '__add__';

let instances = []; // [{id, label, isHost, configured, url}], "host" always present
let activeInstanceId = ALL_DEVICES_TAB;
let showConnectForm = false; // show connect/edit form for the active instance
let showAddDeviceForm = false; // the (unified, instance-picking) add-device form

let devices = [];
let folders = [];
let devicesError = null; // set when OUR backend responded but Syncthing itself didn't
let foldersError = null;
let stBaseUrl = null; // active instance's own URL, for the self device's GUI link

let allDevicesList = []; // merged devices across every configured instance, for the overview tab
let allDevicesError = null;

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

// ---------- Instance list + tab selection ----------

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
  const isPseudoTab = activeInstanceId === ADD_INSTANCE_TAB || activeInstanceId === ALL_DEVICES_TAB;
  if (!isPseudoTab && !instances.find(i => i.id === activeInstanceId)) {
    activeInstanceId = ALL_DEVICES_TAB;
  }
  await selectInstanceTab(activeInstanceId);
}

async function selectInstanceTab(id) {
  activeInstanceId = id;
  showAddDeviceForm = false;

  if (id === ADD_INSTANCE_TAB) {
    renderSyncthingPanel();
    return;
  }
  if (id === ALL_DEVICES_TAB) {
    await refreshAllDevicesOverview();
    return;
  }

  const inst = instances.find(i => i.id === id);
  showConnectForm = !inst || !inst.configured;
  if (showConnectForm) {
    renderSyncthingPanel();
    return;
  }
  await refreshAll();
}

function showAddInstanceTab() {
  activeInstanceId = ADD_INSTANCE_TAB;
  renderSyncthingPanel();
}

function cancelAddInstance() {
  selectInstanceTab(ALL_DEVICES_TAB);
}

function refreshCurrentView() {
  return activeInstanceId === ALL_DEVICES_TAB ? refreshAllDevicesOverview() : refreshAll();
}

// ---------- Devices / folders data (single active instance) ----------

async function fetchDevicesData() {
  devicesError = null;
  let res;
  try {
    res = await fetch(`/data/syncthing-devices?instance=${encodeURIComponent(activeInstanceId)}`);
  } catch (err) {
    // fetch() itself threw -- our own backend (nginx/trigger_server) is
    // unreachable. That's a real "check that it's running" situation,
    // same shared page banner every other module uses for it.
    console.error("Couldn't reach the server for Syncthing devices", err);
    showErrorBanner("Couldn't reach the server to load Syncthing devices. Check that it's running and try again.");
    return;
  }
  clearErrorBanner();
  if (!res.ok) {
    // Our backend responded, so it's fine -- this is Syncthing itself
    // (at the configured URL) not answering. Scoped to the panel, not
    // the page banner, so it isn't mistaken for a dashboard outage.
    const data = await res.json().catch(() => ({}));
    devicesError = data.error || `Server responded ${res.status}`;
    devices = [];
    console.error('Syncthing devices request failed', devicesError);
    return;
  }
  const data = await res.json();
  devices = data.devices || [];
  stBaseUrl = data.baseUrl || null;
}

async function fetchFoldersData() {
  foldersError = null;
  let res;
  try {
    res = await fetch(`/data/syncthing-folders?instance=${encodeURIComponent(activeInstanceId)}`);
  } catch (err) {
    console.error("Couldn't reach the server for Syncthing folders", err);
    return; // fetchDevicesData already surfaces the page banner for this
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

async function refreshAll() {
  await Promise.all([fetchDevicesData(), fetchFoldersData()]);
  renderSyncthingPanel();
}

// ---------- All Devices overview (every configured instance, merged) ----------

async function refreshAllDevicesOverview() {
  allDevicesError = null;
  const configured = instances.filter(i => i.configured);
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
    const errors = [];
    for (const r of results) {
      if (r.error) { errors.push(`${r.inst.label}: ${r.error}`); continue; }
      for (const d of r.devices) {
        allDevicesList.push({ ...d, instanceId: r.inst.id, instanceLabel: r.inst.label });
      }
    }
    allDevicesError = errors.length ? errors.join(' | ') : null;
  } catch (err) {
    console.error('Failed to load combined device list', err);
    showErrorBanner("Couldn't reach the server to load Syncthing devices. Check that it's running and try again.");
  }
  renderSyncthingPanel();
}

// ---------- Connect / edit / add / clear instance ----------

function renderConnectFormHtml() {
  const inst = instances.find(i => i.id === activeInstanceId);
  if (!inst) return '';
  const editing = inst.configured;
  // First-time connect defaults to a sensible URL when we have one (the
  // Host tab already knows the in-stack container's address, same
  // reasoning as Mealie's known URL) -- still fully editable.
  const urlValue = editing
    ? (inst.url ? escapeHtml(inst.url) : '')
    : escapeHtml(inst.url || (inst.isHost ? `http://${HOST_IP}:8384` : ''));
  return `
    <div class="week-block">
      <h3>${editing ? `Editing ${escapeHtml(inst.label)} Connection` : `Connect ${escapeHtml(inst.label)}`}</h3>
      <p style="color:var(--color-text-dim); font-size:14px;">
        ${editing
          ? 'Update the URL and/or API key below. Leave the API key blank to keep the one already saved.'
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
        <button class="btn" data-action="save-instance-config">${editing ? 'Save' : 'Connect'}</button>
        ${editing ? '<button class="btn clear" data-action="cancel-edit-config">Cancel</button>' : ''}
      </div>
    </div>
  `;
}

async function saveInstanceConfig() {
  const urlInput = document.getElementById('st-config-url');
  const keyInput = document.getElementById('st-config-key');
  const url = urlInput.value.trim();
  const apiKey = keyInput.value.trim();
  const inst = instances.find(i => i.id === activeInstanceId);
  const editing = !!(inst && inst.configured);
  if (!url) return;
  if (!editing && !apiKey) return; // first-time connect always needs a key
  showStatusModal(editing ? 'Saving...' : 'Connecting...', 'loading');
  try {
    const res = await fetch('/api/save-syncthing-instance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: activeInstanceId, url, apiKey })
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
  showConnectForm = false;
  renderSyncthingPanel();
}

function renderAddInstanceFormHtml() {
  return `
    <div class="week-block">
      <h3>Connect a Syncthing Instance</h3>
      <p style="color:var(--color-text-dim); font-size:14px;">
        This points OUR DASHBOARD at another Syncthing's own REST API, so you can manage it here too --
        different from "Add Device" below, which pairs two Syncthing instances with each other.
        URL is the regular address you'd use to open its GUI in a browser; API key is under
        Actions &rarr; Settings &rarr; General on that instance.
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
    activeInstanceId = data.instanceId;
    await loadInstances();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function clearActiveInstance() {
  const inst = instances.find(i => i.id === activeInstanceId);
  if (!inst) return;
  const confirmMsg = inst.isHost
    ? "Clear the saved connection for Host? You'll need to reconnect (URL + API key) to manage it again -- this doesn't affect the Syncthing container itself."
    : `Remove "${inst.label}" from this dashboard? You'll need to re-add it (URL + API key) to manage it again -- this doesn't affect Syncthing itself.`;
  if (!(await showConfirmModal(confirmMsg))) return;
  try {
    const res = await fetch('/api/clear-syncthing-instance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: activeInstanceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed: ' + (data.error || res.status), 'error'); return; }
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

// instanceId/instanceLabel are the device's OWNING instance -- always
// passed explicitly (rather than assumed from a global "current tab")
// so the same row renderer works both on a single instance's tab and in
// the merged All Devices list, where every row can belong to a different
// instance. instanceLabel is only shown when set (the merged view).
function renderDeviceRowHtml(d, instanceId, instanceLabel, instanceBaseUrl) {
  const statusLabel = d.paused ? 'Paused' : (d.connected ? 'Connected' : 'Offline');
  const statusClass = d.paused ? 'paused' : (d.connected ? 'connected' : 'offline');
  const completionText = d.connected && d.completion != null ? `${Math.round(d.completion)}% synced` : '';
  const lastSeenText = !d.connected ? formatLastSeen(d.lastSeen) : '';
  const metaParts = [statusLabel, completionText, lastSeenText ? `last seen ${lastSeenText}` : ''].filter(Boolean);
  const tagHtml = instanceLabel ? `<span class="st-instance-tag">${escapeHtml(instanceLabel)}</span>` : '';
  return `
    <div class="st-device-row" data-instance-id="${escapeHtml(instanceId)}" data-device-id="${escapeHtml(d.id)}">
      <span class="st-status-dot ${statusClass}" title="${statusLabel}"></span>
      <div class="st-device-info">
        <div class="st-device-name">
          ${tagHtml}
          ${d.isSelf
            ? `${escapeHtml(d.name)} <span style="color:var(--color-text-muted); font-size:12px; font-weight:normal;">(itself)</span>`
            : `<span class="st-device-name-text" data-action="start-rename" data-instance-id="${escapeHtml(instanceId)}" data-device-id="${escapeHtml(d.id)}" title="Click to rename">${escapeHtml(d.name)}</span>`}
          <span class="st-gui-link-wrap">${deviceGuiLinkHtml(d, instanceBaseUrl)}</span>
        </div>
        <div class="st-device-meta">
          ${metaParts.join(' &middot; ')}
          ${d.folders.length ? `<br>${d.folders.map(escapeHtml).join(', ')}` : ''}
        </div>
      </div>
      ${!d.isSelf ? `
        <div class="st-device-actions">
          <button class="btn small" data-action="${d.paused ? 'resume-device' : 'pause-device'}" data-instance-id="${escapeHtml(instanceId)}" data-device-id="${escapeHtml(d.id)}">${d.paused ? 'Resume' : 'Pause'}</button>
          <button class="icon-btn-delete" data-action="remove-device" data-instance-id="${escapeHtml(instanceId)}" data-device-id="${escapeHtml(d.id)}" title="Remove device">&#x1F5D1;</button>
        </div>
      ` : ''}
    </div>
  `;
}

// One "Add Device" form, used identically on a single instance's tab and
// on the All Devices overview -- the only difference is which instance
// is pre-selected in the dropdown. This is deliberately the ONE place
// device-pairing happens, so it never looks like a different control
// depending on where you are.
function renderAddDeviceSectionHtml(defaultInstanceId) {
  if (!showAddDeviceForm) {
    return `<div class="btn-grid"><button class="btn small" data-action="show-add-device">+ Add Device</button></div>`;
  }
  const configuredInstances = instances.filter(i => i.configured);
  return `
    <div class="preview-row">
      <span class="date">To</span>
      <select id="st-add-device-instance" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        ${configuredInstances.map(i => `<option value="${escapeHtml(i.id)}" ${i.id === defaultInstanceId ? 'selected' : ''}>${escapeHtml(i.label)}</option>`).join('')}
      </select>
    </div>
    <div class="preview-row">
      <span class="date">Device ID</span>
      <input type="text" id="st-add-device-id" placeholder="XXXXXXX-XXXXXXX-XXXXXXX-..." style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
    </div>
    <div class="preview-row">
      <span class="date">Name</span>
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
      </div>
    </div>
  `;
}

function renderTabsHtml() {
  const allTab = `<button data-instance-tab="${ALL_DEVICES_TAB}" class="${activeInstanceId === ALL_DEVICES_TAB ? 'active' : ''}">All Devices</button>`;
  const tabs = instances.map(inst =>
    `<button data-instance-tab="${escapeHtml(inst.id)}" class="${inst.id === activeInstanceId ? 'active' : ''}">${escapeHtml(inst.label)}</button>`
  ).join('');
  const addTab = `<button data-instance-tab="${ADD_INSTANCE_TAB}" class="${activeInstanceId === ADD_INSTANCE_TAB ? 'active' : ''}">+ Connect Instance</button>`;
  return `<div class="mode-toggle" style="margin-bottom:12px; flex-wrap:wrap;">${allTab}${tabs}${addTab}</div>`;
}

function renderAllDevicesHtml() {
  const infoTip = infoTipHtml('Merges the separate device list from every connected instance into one view. Syncthing keeps no shared/global device list -- each instance has its own -- so the same physical device can appear more than once here if it\'s known to more than one of your instances.');
  const anyConfigured = instances.some(i => i.configured);
  if (!anyConfigured) {
    return `
      <div class="week-block">
        <h3>All Devices ${infoTip}</h3>
        <p style="color:var(--color-text-muted);">No Syncthing instances connected yet -- connect Host, or use "+ Connect Instance" to add another, to see devices here.</p>
      </div>
    `;
  }
  return `
    <div class="week-block">
      <h3>All Devices ${infoTip}</h3>
      ${allDevicesError ? `<div class="warning-box">&#x26A0; ${escapeHtml(allDevicesError)}</div>` : ''}
      ${allDevicesList.length === 0 ? '<p style="color:var(--color-text-muted);">No devices found.</p>' : allDevicesList.map(d => {
        const owningInstance = instances.find(i => i.id === d.instanceId);
        return renderDeviceRowHtml(d, d.instanceId, d.instanceLabel, owningInstance ? owningInstance.url : null);
      }).join('')}
      ${renderAddDeviceSectionHtml(defaultAddInstanceId())}
    </div>
  `;
}

function renderDevicesAndFoldersHtml() {
  const inst = instances.find(i => i.id === activeInstanceId);
  const clearLabel = inst && inst.isHost ? 'Clear connection' : 'Remove instance';
  const label = inst ? inst.label : activeInstanceId;
  const devicesInfoTip = infoTipHtml(`This is ${label}'s own separate list of known Syncthing devices -- Syncthing keeps no shared/global list, each instance has its own. Adding a device here only makes ${label} aware of it; the other side needs the same device added on its own tab (or to accept a connection request) before they'll actually sync with each other.`);
  return `
    <div class="week-block">
      <div class="shopping-panel-header">
        <h3>${escapeHtml(label)}'s Devices ${devicesInfoTip}</h3>
        ${!devicesError ? `
          <div class="st-global-actions">
            <button class="btn small" data-action="pause-all" title="Pause all devices">Pause All</button>
            <button class="btn small" data-action="resume-all" title="Resume all devices">Resume All</button>
          </div>
        ` : ''}
      </div>
      ${devicesError
        ? `<div class="warning-box">&#x26A0; Couldn't reach this Syncthing instance: ${escapeHtml(devicesError)}</div>`
        : (devices.length === 0 ? '<p style="color:var(--color-text-muted);">No devices found.</p>' : devices.map(d => renderDeviceRowHtml(d, activeInstanceId, null, stBaseUrl)).join(''))}
      ${!devicesError ? renderAddDeviceSectionHtml(activeInstanceId) : ''}
      <div class="st-connection-links">
        <span class="st-link-action" data-action="start-edit-config">Edit connection</span>
        <span class="st-link-action" data-action="clear-instance">${clearLabel}</span>
      </div>
    </div>
    <div class="week-block">
      <h3>Folders</h3>
      ${foldersError
        ? `<div class="warning-box">&#x26A0; Couldn't reach this Syncthing instance: ${escapeHtml(foldersError)}</div>`
        : (folders.length === 0 ? '<p style="color:var(--color-text-muted);">No folders found.</p>' : folders.map(f => renderFolderRowHtml(f)).join(''))}
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
  let bodyHtml;
  if (activeInstanceId === ADD_INSTANCE_TAB) {
    bodyHtml = renderAddInstanceFormHtml();
  } else if (activeInstanceId === ALL_DEVICES_TAB) {
    bodyHtml = renderAllDevicesHtml();
  } else if (showConnectForm) {
    bodyHtml = renderConnectFormHtml();
  } else {
    bodyHtml = renderDevicesAndFoldersHtml();
  }
  el.innerHTML = renderTabsHtml() + bodyHtml;
}

// ---------- Device / folder / global actions ----------
// Every action takes instanceId explicitly (read from the row/button
// that triggered it) rather than assuming "the current tab", since the
// All Devices overview mixes rows from several instances at once.

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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: activeInstanceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to pause all: ' + (data.error || res.status), 'error'); return; }
    refreshAll();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function resumeAllDevices() {
  try {
    const res = await fetch('/api/syncthing-resume-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: activeInstanceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to resume all: ' + (data.error || res.status), 'error'); return; }
    refreshAll();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function pauseFolder(folderId) {
  try {
    const res = await fetch('/api/syncthing-folder-pause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: activeInstanceId, folderId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to pause folder: ' + (data.error || res.status), 'error'); return; }
    refreshAll();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function resumeFolder(folderId) {
  try {
    const res = await fetch('/api/syncthing-folder-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: activeInstanceId, folderId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to resume folder: ' + (data.error || res.status), 'error'); return; }
    refreshAll();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function rescanFolder(folderId) {
  try {
    const res = await fetch('/api/syncthing-folder-rescan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: activeInstanceId, folderId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to rescan: ' + (data.error || res.status), 'error'); return; }
    refreshAll();
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
  const idInput = document.getElementById('st-add-device-id');
  const nameInput = document.getElementById('st-add-device-name');
  const instanceId = instanceSelect.value;
  const deviceId = idInput.value.trim();
  const name = nameInput.value.trim();
  if (!instanceId || !deviceId) return;
  try {
    const res = await fetch('/api/syncthing-device-add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId, deviceId, name })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to add device: ' + (data.error || res.status), 'error'); return; }
    showAddDeviceForm = false;
    refreshCurrentView();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

// ---------- Wiring ----------

function findDeviceRow(instanceId, deviceId) {
  const pool = activeInstanceId === ALL_DEVICES_TAB ? allDevicesList : devices;
  return pool.find(x => x.id === deviceId && (activeInstanceId !== ALL_DEVICES_TAB || x.instanceId === instanceId));
}

function wireDelegatedListeners() {
  const panel = document.getElementById('syncthing-panel');
  panel.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-instance-tab]');
    if (tabBtn) {
      const id = tabBtn.dataset.instanceTab;
      return id === ADD_INSTANCE_TAB ? showAddInstanceTab() : selectInstanceTab(id);
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const instanceId = btn.dataset.instanceId;
    const deviceId = btn.dataset.deviceId;
    const folderId = btn.dataset.folderId;
    switch (btn.dataset.action) {
      case 'save-instance-config': return saveInstanceConfig();
      case 'start-edit-config': return startEditConfig();
      case 'cancel-edit-config': return cancelEditConfig();
      case 'add-instance': return addInstance();
      case 'cancel-add-instance': return cancelAddInstance();
      case 'clear-instance': return clearActiveInstance();
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
    }
  });
}

registerApp('syncthing', {
  title: '&#x1F504; Syncthing',
  bodyHtml: `
    <div id="syncthing-root">
      <div id="conn-error-banner" class="error-banner"></div>
      <div id="syncthing-panel"></div>
    </div>
  `,
  onRender: () => {
    wireDelegatedListeners();
    instances = [];
    activeInstanceId = ALL_DEVICES_TAB;
    showConnectForm = false;
    showAddDeviceForm = false;
    devices = [];
    folders = [];
    devicesError = null;
    foldersError = null;
    stBaseUrl = null;
    allDevicesList = [];
    allDevicesError = null;
    renderSyncthingPanel();
    loadInstances();
  },
});
