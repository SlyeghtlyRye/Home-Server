// system.js -- system status panel, Fake Factory Reset (dry-run preview,
// safe to run anytime) and real Factory Reset (destructive, requires
// typed confirmation, does not restart services itself -- see the log
// message it returns for the manual follow-up step).
import { registerApp, showStatusModal, hideStatusModal, showErrorBanner,
         clearErrorBanner, escapeHtml } from './core.js';

async function loadSystemStatus() {
  const root = document.getElementById('system-root');
  root.innerHTML = '<p style="color:var(--color-text-muted);">Loading system status...</p>';
  try {
    const res = await fetch('/data/system-status');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    clearErrorBanner();
    renderSystemStatus(data);
  } catch (err) {
    console.error('Failed to load system status', err);
    showErrorBanner("Couldn't reach the server to load system status. Check that it's running and try again.");
  }
}

function renderSystemStatus(data) {
  const root = document.getElementById('system-root');
  root.innerHTML = `
    <div class="week-block">
      <h3>Device</h3>
      <p style="color:var(--color-text-dim); font-size:14px;">
        Uptime: ${escapeHtml(data.uptime)} &middot;
        Memory: ${escapeHtml(data.memory)} &middot;
        Disk: ${escapeHtml(data.disk)}
        ${data.cpu_temp ? ` &middot; CPU Temp: ${escapeHtml(data.cpu_temp)}&deg;C` : ''}
      </p>
    </div>
    <div class="week-block">
      <h3>Containers</h3>
      ${data.containers.map(c => `
        <div class="preview-row">
          <span class="date">${c.healthy ? '&#x2705;' : '&#x26A0;'} ${escapeHtml(c.name)}</span>
          <span style="color:var(--color-text-muted); font-size:13px; flex:1;">${escapeHtml(c.status)}</span>
          ${c.cpu_percent ? `<span style="color:var(--color-text-muted); font-size:12px;">${escapeHtml(c.cpu_percent)}% CPU</span>` : ''}
        </div>
      `).join('')}
    </div>
    <div class="week-block">
      <h3>Host Services</h3>
      ${data.host_services.map(s => `
        <div class="preview-row">
          <span class="date">${s.healthy ? '&#x2705;' : '&#x26A0;'} ${escapeHtml(s.name)}</span>
          <span style="color:var(--color-text-muted); font-size:13px;">${escapeHtml(s.active)}</span>
        </div>
      `).join('')}
    </div>
    <div class="week-block">
      <h3>Factory Reset</h3>
      <p style="color:var(--color-text-dim); font-size:14px;">
        Use this to wipe personal data (Mealie token, Streams library/profiles,
        meal history) and generate fresh secrets -- for example, before handing
        this device to someone else, or to test the setup flow.
      </p>
      <div class="btn-grid">
        <button class="btn small" data-action="preview-reset">Preview (Fake Factory Reset)</button>
        <button class="btn small clear" data-action="start-reset">Factory Reset</button>
      </div>
    </div>
  `;
}

async function previewReset() {
  showStatusModal('Running dry-run preview...', 'loading');
  try {
    const res = await fetch('/api/reset-preview');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    showResetLog(data.log, 'This is a preview only -- nothing was changed.', false);
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function showResetLog(logLines, footerNote, wasReal) {
  const overlay = document.getElementById('status-overlay');
  const modal = document.getElementById('status-modal');
  modal.classList.remove('error', 'success');
  document.getElementById('status-spinner').style.display = 'none';
  document.getElementById('status-dismiss').style.display = 'inline-block';
  document.getElementById('status-message').innerHTML = `
    <div style="text-align:left; max-height:300px; overflow-y:auto; font-family:monospace; font-size:12px; margin-bottom:10px;">
      ${logLines.map(l => `<div>${escapeHtml(l)}</div>`).join('')}
    </div>
    <div style="font-weight:bold; ${wasReal ? 'color:var(--color-warning);' : ''}">${escapeHtml(footerNote)}</div>
  `;
  overlay.style.display = 'flex';
}

async function startResetFlow() {
  const typed = prompt(
    'This will permanently delete your Mealie token, meal history, and ' +
    'Streams library/profiles, and generate new secrets. This cannot be undone.\\n\\n' +
    'Type RESET to confirm:'
  );
  if (typed !== 'RESET') {
    if (typed !== null) {
      showStatusModal('Confirmation text did not match -- nothing was changed.', 'error');
    }
    return;
  }

  showStatusModal('Running factory reset...', 'loading');
  try {
    const res = await fetch('/api/reset-execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESET' })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Failed: ' + (data.error || res.status), 'error'); return; }
    hideStatusModal();
    showStatusModal(data.message, 'error');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function wireDelegatedListeners() {
  const root = document.getElementById('system-root');
  root.addEventListener('click', (e) => {
    const previewBtn = e.target.closest('[data-action="preview-reset"]');
    if (previewBtn) { previewReset(); return; }
    const resetBtn = e.target.closest('[data-action="start-reset"]');
    if (resetBtn) { startResetFlow(); return; }
  });
}

registerApp('system', {
  title: '&#x2699;&#xFE0F; System',
  bodyHtml: `<div id="conn-error-banner" class="error-banner"></div><div id="system-root"></div>`,
  onRender: () => {
    wireDelegatedListeners();
    loadSystemStatus();
  },
});
