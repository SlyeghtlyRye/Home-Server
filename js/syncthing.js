// syncthing.js -- devices panel for an existing Syncthing instance
// (Syncthing itself is not part of this stack; it's assumed to already be
// running elsewhere on the network). Connect once with a URL + API key,
// then view connection/sync status and pause/resume/add/rename/remove
// devices. Uses the same event-delegation / status-modal patterns as the
// other modules rather than introducing a new UI pattern.
import { registerApp, showStatusModal, hideStatusModal,
         showErrorBanner, clearErrorBanner, showConfirmModal, escapeHtml } from './core.js';

let configured = null; // null = not checked yet, otherwise boolean
let devices = [];
let showAddForm = false;
let stBaseUrl = null; // this Syncthing instance's own URL, for the self device's GUI link

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

async function checkConfigured() {
  try {
    const res = await fetch('/data/syncthing-status');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    configured = data.configured;
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to check Syncthing status', err);
    configured = false;
    showErrorBanner("Couldn't reach the server to check Syncthing status. Check that it's running and try again.");
  }
  if (configured) {
    loadDevices();
  } else {
    renderSyncthingPanel();
  }
}

async function loadDevices() {
  try {
    const res = await fetch('/data/syncthing-devices');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    configured = data.configured;
    devices = data.devices || [];
    stBaseUrl = data.baseUrl || null;
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load Syncthing devices', err);
    showErrorBanner("Couldn't reach the server to load Syncthing devices. Check that it's running and try again.");
  }
  renderSyncthingPanel();
}

function renderConfigFormHtml() {
  return `
    <div class="week-block">
      <h3>Connect to Syncthing</h3>
      <p style="color:var(--color-text-dim); font-size:14px;">
        Enter your existing Syncthing instance's address and API key (found in its
        web GUI under Actions &rarr; Settings &rarr; GUI).
      </p>
      <div class="preview-row">
        <span class="date">URL</span>
        <input type="text" id="st-config-url" placeholder="http://192.168.1.50:8384" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
      </div>
      <div class="preview-row">
        <span class="date">API key</span>
        <input type="password" id="st-config-key" placeholder="Paste your API key" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
      </div>
      <div class="btn-grid">
        <button class="btn" data-action="save-config">Connect</button>
      </div>
    </div>
  `;
}

async function saveConfig() {
  const urlInput = document.getElementById('st-config-url');
  const keyInput = document.getElementById('st-config-key');
  const url = urlInput.value.trim();
  const apiKey = keyInput.value.trim();
  if (!url || !apiKey) return;
  showStatusModal('Connecting...', 'loading');
  try {
    const res = await fetch('/api/save-syncthing-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, apiKey })
    });
    const data = await res.json();
    if (!data.valid) {
      showStatusModal('Could not connect: ' + (data.error || 'check the URL and API key.'), 'error');
      return;
    }
    hideStatusModal();
    configured = true;
    loadDevices();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function reconfigure() {
  configured = false;
  renderSyncthingPanel();
}

function formatLastSeen(iso) {
  if (!iso || iso.startsWith('0001-01-01')) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function deviceGuiLinkHtml(d) {
  if (d.isSelf) {
    return stBaseUrl
      ? `<a class="st-gui-link" href="${escapeHtml(stBaseUrl)}" target="_blank" rel="noopener" title="Open this Syncthing instance's GUI">&#x1F517; GUI</a>`
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

function renderDeviceRowHtml(d) {
  const statusLabel = d.paused ? 'Paused' : (d.connected ? 'Connected' : 'Offline');
  const statusClass = d.paused ? 'paused' : (d.connected ? 'connected' : 'offline');
  const completionText = d.connected && d.completion != null ? `${Math.round(d.completion)}% synced` : '';
  const lastSeenText = !d.connected ? formatLastSeen(d.lastSeen) : '';
  const metaParts = [statusLabel, completionText, lastSeenText ? `last seen ${lastSeenText}` : ''].filter(Boolean);
  return `
    <div class="st-device-row" data-device-id="${escapeHtml(d.id)}">
      <span class="st-status-dot ${statusClass}" title="${statusLabel}"></span>
      <div class="st-device-info">
        <div class="st-device-name">
          ${d.isSelf
            ? `${escapeHtml(d.name)} <span style="color:var(--color-text-muted); font-size:12px; font-weight:normal;">(this device)</span>`
            : `<span class="st-device-name-text" data-action="start-rename" data-device-id="${escapeHtml(d.id)}" title="Click to rename">${escapeHtml(d.name)}</span>`}
          <span class="st-gui-link-wrap">${deviceGuiLinkHtml(d)}</span>
        </div>
        <div class="st-device-meta">
          ${metaParts.join(' &middot; ')}
          ${d.folders.length ? `<br>${d.folders.map(escapeHtml).join(', ')}` : ''}
        </div>
      </div>
      ${!d.isSelf ? `
        <div class="st-device-actions">
          <button class="btn small" data-action="${d.paused ? 'resume-device' : 'pause-device'}" data-device-id="${escapeHtml(d.id)}">${d.paused ? 'Resume' : 'Pause'}</button>
          <button class="icon-btn-delete" data-action="remove-device" data-device-id="${escapeHtml(d.id)}" title="Remove device">&#x1F5D1;</button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderAddDeviceSectionHtml() {
  if (!showAddForm) {
    return `<div class="btn-grid"><button class="btn small" data-action="show-add-device">+ Add Device</button></div>`;
  }
  return `
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

function renderSyncthingPanel() {
  const el = document.getElementById('syncthing-panel');
  if (!el) return;
  if (configured === null) {
    el.innerHTML = '<div class="week-block"><p style="color:var(--color-text-muted);">Loading...</p></div>';
    return;
  }
  if (!configured) {
    el.innerHTML = renderConfigFormHtml();
    return;
  }
  el.innerHTML = `
    <div class="week-block">
      <div class="shopping-panel-header">
        <h3>Devices</h3>
        <button class="btn small" data-action="reconfigure" title="Change URL or API key">&#x2699; Settings</button>
      </div>
      ${devices.length === 0 ? '<p style="color:var(--color-text-muted);">No devices found.</p>' : devices.map(d => renderDeviceRowHtml(d)).join('')}
      ${renderAddDeviceSectionHtml()}
    </div>
  `;
}

async function pauseDevice(deviceId) {
  try {
    const res = await fetch('/api/syncthing-device-pause', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to pause: ' + (data.error || res.status), 'error'); return; }
    loadDevices();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function resumeDevice(deviceId) {
  try {
    const res = await fetch('/api/syncthing-device-resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to resume: ' + (data.error || res.status), 'error'); return; }
    loadDevices();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function removeDevice(deviceId, name) {
  if (!(await showConfirmModal(`Remove "${name}" from Syncthing? This only removes it here -- the device itself is unaffected and can be re-added later.`))) return;
  try {
    const res = await fetch('/api/syncthing-device-remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to remove: ' + (data.error || res.status), 'error'); return; }
    loadDevices();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function startRenameDevice(deviceId, currentName) {
  const name = window.prompt('Rename device:', currentName);
  if (!name || !name.trim() || name.trim() === currentName) return;
  try {
    const res = await fetch('/api/syncthing-device-rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, name: name.trim() })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Rename failed: ' + (data.error || res.status), 'error'); return; }
    loadDevices();
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
  const idInput = document.getElementById('st-add-device-id');
  const nameInput = document.getElementById('st-add-device-name');
  const deviceId = idInput.value.trim();
  const name = nameInput.value.trim();
  if (!deviceId) return;
  try {
    const res = await fetch('/api/syncthing-device-add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, name })
    });
    if (!res.ok) { const data = await res.json().catch(() => ({})); showStatusModal('Failed to add device: ' + (data.error || res.status), 'error'); return; }
    showAddForm = false;
    loadDevices();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function wireDelegatedListeners() {
  const panel = document.getElementById('syncthing-panel');
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const deviceId = btn.dataset.deviceId;
    switch (btn.dataset.action) {
      case 'save-config': return saveConfig();
      case 'reconfigure': return reconfigure();
      case 'pause-device': return pauseDevice(deviceId);
      case 'resume-device': return resumeDevice(deviceId);
      case 'remove-device': {
        const d = devices.find(x => x.id === deviceId);
        return removeDevice(deviceId, d ? d.name : deviceId);
      }
      case 'start-rename': {
        const d = devices.find(x => x.id === deviceId);
        return startRenameDevice(deviceId, d ? d.name : '');
      }
      case 'edit-gui-port': return editGuiPort(deviceId);
      case 'show-add-device':
        showAddForm = true;
        return renderSyncthingPanel();
      case 'cancel-add-device':
        showAddForm = false;
        return renderSyncthingPanel();
      case 'add-device': return addDevice();
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
    configured = null;
    devices = [];
    showAddForm = false;
    renderSyncthingPanel();
    checkConfigured();
  },
});
