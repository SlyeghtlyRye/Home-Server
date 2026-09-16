// system.js -- system status panel, Fake Factory Reset (dry-run preview,
// safe to run anytime) and real Factory Reset (destructive, requires
// typed confirmation, does not restart services itself -- see the log
// message it returns for the manual follow-up step).
import { registerApp, showStatusModal, hideStatusModal, showErrorBanner,
         clearErrorBanner, showConfirmModal, escapeHtml } from './core.js';

// Three independent cards (Device, Containers, Host Services) instead of
// one combined /data/system-status fetch the whole panel used to wait on
// -- `docker stats` alone (part of the Containers card) commonly takes
// 1-2+ seconds to sample CPU usage, which meant Device's near-instant
// uptime/memory/disk sat behind a blank "Loading..." for exactly as long
// as the slowest card, every time. Each card fetches, renders, and fails
// independently now: a slow or broken container/service lookup no longer
// blocks the others. Software Update and Factory Reset need no fetch at
// all, so they render immediately as part of the static shell.
function loadSystemStatus() {
  const root = document.getElementById('system-root');
  root.innerHTML = renderShellHtml();
  clearErrorBanner();
  loadBasicsCard();
  loadContainersCard();
  loadServicesCard();
}

function renderShellHtml() {
  return `
    <div class="week-block" id="sys-basics-card">
      <h3>Device</h3>
      <p style="color:var(--color-text-muted); font-size:13px;">Loading...</p>
    </div>
    <div class="week-block" id="sys-containers-card">
      <h3>Containers</h3>
      <p style="color:var(--color-text-muted); font-size:13px;">Loading...</p>
    </div>
    <div class="week-block" id="sys-services-card">
      <h3>Host Services</h3>
      <p style="color:var(--color-text-muted); font-size:13px;">Loading...</p>
    </div>
    <div class="week-block">
      <h3>Software Update</h3>
      <p style="color:var(--color-text-dim); font-size:14px;">
        Check for the latest version of this project on GitHub. Installing
        pulls the update and restarts only what's needed automatically in
        the background -- no SSH needed, and no need to guess when it's
        done; the page refreshes itself once everything's confirmed back up.
      </p>
      <div id="update-status"></div>
      <div class="btn-grid">
        <button class="btn small" data-action="check-update">Check for Update</button>
      </div>
      <ul class="commit-list" id="past-updates-list"></ul>
      <div class="btn-grid" id="past-updates-controls">
        <button class="btn small" data-action="load-past-updates">Show Past Updates</button>
      </div>
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

// Each card follows the same shape: fetch() throwing means our own
// backend is unreachable (the shared page banner, same as every other
// module), a non-OK response is scoped to just this card's own text --
// same fetch-error split used throughout this codebase (see syncthing.js)
// so one card's problem never reads as "the whole page is broken".

async function loadBasicsCard() {
  const card = document.getElementById('sys-basics-card');
  let res;
  try {
    res = await fetch('/data/system-status-basics');
  } catch (err) {
    showErrorBanner("Couldn't reach the server to load system status. Check that it's running and try again.");
    return;
  }
  if (!res.ok) {
    card.innerHTML = `<h3>Device</h3><p style="color:var(--color-warning); font-size:13px;">Couldn't load device info.</p>`;
    return;
  }
  const data = await res.json();
  card.innerHTML = `
    <h3>Device</h3>
    <p style="color:var(--color-text-dim); font-size:14px;">
      Uptime: ${escapeHtml(data.uptime)} &middot;
      Memory: ${escapeHtml(data.memory)} &middot;
      Disk: ${escapeHtml(data.disk)}
      ${data.cpu_temp ? ` &middot; CPU Temp: ${escapeHtml(data.cpu_temp)}&deg;C` : ''}
    </p>
  `;
}

async function loadContainersCard() {
  const card = document.getElementById('sys-containers-card');
  let res;
  try {
    res = await fetch('/data/system-status-containers');
  } catch (err) {
    return; // loadBasicsCard() already surfaces the page banner for this
  }
  if (!res.ok) {
    card.innerHTML = `<h3>Containers</h3><p style="color:var(--color-warning); font-size:13px;">Couldn't load container status.</p>`;
    return;
  }
  const data = await res.json();
  card.innerHTML = `
    <h3>Containers</h3>
    ${data.containers.map(c => renderContainerRowHtml(c)).join('')}
  `;
}

// Restart/Details for containers mirror renderServiceRowHtml()'s pattern
// exactly, just against /api/restart-container and /data/container-logs
// -- see restart_container()'s docstring in system_status.py for why the
// allow-list there is the live `docker ps` output rather than a second
// hardcoded name list.
function renderContainerRowHtml(c) {
  const detailId = `container-log-${c.name}`;
  return `
    <div class="preview-row">
      <span class="date">${c.healthy ? '&#x2705;' : '&#x26A0;'} ${escapeHtml(c.name)}</span>
      <span style="color:var(--color-text-muted); font-size:13px; flex:1;">${escapeHtml(c.status)}</span>
      ${c.cpu_percent ? `<span style="color:var(--color-text-muted); font-size:12px;">${escapeHtml(c.cpu_percent)}% CPU</span>` : ''}
      <span class="st-link-action" data-action="toggle-container-logs" data-container="${escapeHtml(c.name)}" data-target="${detailId}">Details</span>
      <button class="btn small" data-action="restart-container" data-container="${escapeHtml(c.name)}">Restart</button>
    </div>
    <div class="expandable-detail" id="${detailId}" hidden></div>
  `;
}

async function toggleContainerLogs(containerName, targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (el.dataset.loaded === '1') {
    el.hidden = !el.hidden;
    return;
  }
  el.hidden = false;
  el.innerHTML = '<p style="color:var(--color-text-muted); font-size:12px; margin:4px 0 0;">Loading...</p>';
  try {
    const res = await fetch(`/data/container-logs?name=${encodeURIComponent(containerName)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
    const lines = data.lines || [];
    el.innerHTML = lines.length
      ? `<pre>${escapeHtml(lines.join('\n'))}</pre>`
      : '<p style="font-size:12px; color:var(--color-text-muted); margin:0;">No recent log lines.</p>';
    el.dataset.loaded = '1';
  } catch (err) {
    el.innerHTML = `<p style="color:var(--color-warning); font-size:12px; margin:4px 0 0;">Couldn't load logs.</p>`;
  }
}

async function restartContainer(containerName) {
  if (!(await showConfirmModal(`Restart the "${containerName}" container?`))) return;
  showStatusModal('Restarting...', 'loading');
  try {
    const res = await fetch('/api/restart-container', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: containerName })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Failed: ' + (data.error || res.status), 'error'); return; }

    if (containerName === 'nginx') {
      // nginx is what's proxying this very request back to the browser
      // (and every other dashboard request) -- same down-then-up
      // requirement as restartService()'s mealie-trigger case, for the
      // same reason: the first poll would otherwise still see the
      // pre-restart container still up and falsely report done at once.
      showStatusModal('Restarting nginx -- the dashboard itself will blip...', 'loading');
      let sawDown = false;
      const backUp = await pollUntil(async () => {
        try {
          const r = await fetch('/data/system-status-basics');
          if (r.ok) return sawDown;
          sawDown = true;
          return false;
        } catch (e) {
          sawDown = true;
          return false;
        }
      }, { intervalMs: 500, timeoutMs: 25000 });
      if (backUp) {
        showStatusModal('nginx is back up.', 'success');
        loadBasicsCard();
        loadContainersCard();
        loadServicesCard();
      } else {
        showStatusModal("nginx hasn't come back up after 25s -- something may have gone wrong restarting it.", 'error');
      }
      return;
    }

    showStatusModal(`Waiting for "${containerName}" to come back up...`, 'loading');
    const backUp = await pollUntil(async () => {
      try {
        const r = await fetch('/data/system-status-containers');
        if (!r.ok) return false;
        const d = await r.json();
        const cont = (d.containers || []).find(c => c.name === containerName);
        return !!(cont && cont.healthy);
      } catch (e) {
        return false;
      }
    }, { intervalMs: 1000, timeoutMs: 30000 });
    showStatusModal(
      backUp ? `"${containerName}" is back up.` : `"${containerName}" hasn't come back up after 30s -- check Details for why.`,
      backUp ? 'success' : 'error'
    );
    loadContainersCard();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function loadServicesCard() {
  const card = document.getElementById('sys-services-card');
  let res;
  try {
    res = await fetch('/data/system-status-services');
  } catch (err) {
    return; // loadBasicsCard() already surfaces the page banner for this
  }
  if (!res.ok) {
    card.innerHTML = `<h3>Host Services</h3><p style="color:var(--color-warning); font-size:13px;">Couldn't load host services.</p>`;
    return;
  }
  const data = await res.json();
  card.innerHTML = `
    <h3>Host Services</h3>
    ${data.host_services.map(s => renderServiceRowHtml(s)).join('')}
  `;
}

// Restart/Details are deliberately only offered for the fixed three names
// system_status.py already knows about (SYSTEMD_SERVICES) -- the backend
// re-validates against that same list regardless, but there's no reason
// to even render controls implying a broader command surface than exists.
function renderServiceRowHtml(s) {
  const detailId = `svc-log-${s.name}`;
  return `
    <div class="preview-row">
      <span class="date">${s.healthy ? '&#x2705;' : '&#x26A0;'} ${escapeHtml(s.name)}</span>
      <span style="color:var(--color-text-muted); font-size:13px; flex:1;">${escapeHtml(s.active)}</span>
      <span class="st-link-action" data-action="toggle-service-logs" data-service="${escapeHtml(s.name)}" data-target="${detailId}">Details</span>
      <button class="btn small" data-action="restart-service" data-service="${escapeHtml(s.name)}">Restart</button>
    </div>
    <div class="expandable-detail" id="${detailId}" hidden></div>
  `;
}

async function toggleServiceLogs(serviceName, targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (el.dataset.loaded === '1') {
    el.hidden = !el.hidden;
    return;
  }
  el.hidden = false;
  el.innerHTML = '<p style="color:var(--color-text-muted); font-size:12px; margin:4px 0 0;">Loading...</p>';
  try {
    const res = await fetch(`/data/service-logs?name=${encodeURIComponent(serviceName)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
    const lines = data.lines || [];
    el.innerHTML = lines.length
      ? `<pre>${escapeHtml(lines.join('\n'))}</pre>`
      : '<p style="font-size:12px; color:var(--color-text-muted); margin:0;">No recent log lines.</p>';
    el.dataset.loaded = '1';
  } catch (err) {
    el.innerHTML = `<p style="color:var(--color-warning); font-size:12px; margin:4px 0 0;">Couldn't load logs.</p>`;
  }
}

// Polls `checkFn` (should return true/false, never throw) every
// `intervalMs` until it returns true or `timeoutMs` elapses -- used
// instead of guessing a fixed "wait N seconds" delay, which is either
// too short (still down, user refreshes into a stale page) or too long
// (long done, user waits pointlessly). Returns whether it came up.
async function pollUntil(checkFn, { intervalMs = 1000, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function restartService(serviceName) {
  if (!(await showConfirmModal(`Restart "${serviceName}"?`))) return;
  showStatusModal('Restarting...', 'loading');
  try {
    const res = await fetch('/api/restart-service', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: serviceName })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Failed: ' + (data.error || res.status), 'error'); return; }

    if (serviceName === 'mealie-trigger') {
      // mealie-trigger is the process serving THIS request, restarting
      // itself a couple seconds after the response (see
      // system_status.py's restart_service()) -- so the very first poll
      // would still see the pre-restart process still up and falsely
      // report "done" immediately. Require seeing it actually go down at
      // least once before counting a later success as "back up".
      showStatusModal('Restarting the dashboard backend...', 'loading');
      let sawDown = false;
      const backUp = await pollUntil(async () => {
        try {
          const r = await fetch('/data/system-status-basics');
          if (r.ok) return sawDown;
          sawDown = true;
          return false;
        } catch (e) {
          sawDown = true;
          return false;
        }
      }, { intervalMs: 500, timeoutMs: 25000 });
      if (backUp) {
        showStatusModal('Backend is back up.', 'success');
        loadBasicsCard();
        loadContainersCard();
        loadServicesCard();
      } else {
        showStatusModal("Backend hasn't come back up after 25s -- something may have gone wrong restarting it.", 'error');
      }
      return;
    }

    showStatusModal(`Waiting for "${serviceName}" to come back up...`, 'loading');
    const backUp = await pollUntil(async () => {
      try {
        const r = await fetch('/data/system-status-services');
        if (!r.ok) return false;
        const d = await r.json();
        const svc = (d.host_services || []).find(s => s.name === serviceName);
        return !!(svc && svc.healthy);
      } catch (e) {
        return false;
      }
    }, { intervalMs: 1000, timeoutMs: 15000 });
    showStatusModal(
      backUp ? `"${serviceName}" is back up.` : `"${serviceName}" hasn't come back up after 15s -- check Details for why.`,
      backUp ? 'success' : 'error'
    );
    loadServicesCard();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function previewReset() {
  showStatusModal('Running dry-run preview...', 'loading');
  try {
    const res = await fetch('/api/reset-preview');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
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
    <div id="reset-log-footer" style="font-weight:bold; ${wasReal ? 'color:var(--color-warning);' : ''}">${escapeHtml(footerNote)}</div>
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

// One `git log --oneline` line ("abc1234 Fix thing") rendered as its own
// <li> with a "Details" toggle -- shared by the pending-update list and
// the past-updates history, so both go through the same lazy-fetch-on-
// first-expand behavior instead of two separate implementations.
let commitDetailSeq = 0;
function renderCommitLineHtml(line, idPrefix) {
  const spaceIdx = line.indexOf(' ');
  const hash = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
  const subject = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
  const detailId = `${idPrefix}-${commitDetailSeq++}`;
  return `
    <li>
      <code>${escapeHtml(hash)}</code> ${escapeHtml(subject)}
      <span class="st-link-action" data-action="toggle-commit-detail" data-hash="${escapeHtml(hash)}" data-target="${detailId}">Details</span>
      <div class="expandable-detail" id="${detailId}" hidden></div>
    </li>
  `;
}

async function toggleCommitDetail(hash, targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (el.dataset.loaded === '1') {
    el.hidden = !el.hidden;
    return;
  }
  el.hidden = false;
  el.innerHTML = '<p style="color:var(--color-text-muted); font-size:12px; margin:4px 0 0;">Loading...</p>';
  try {
    const res = await fetch(`/data/commit-detail?hash=${encodeURIComponent(hash)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
    el.innerHTML = `
      <p style="font-size:12px; color:var(--color-text-muted); margin:4px 0;">${escapeHtml(data.author)} &middot; ${escapeHtml(data.date)}</p>
      ${data.body ? `<pre>${escapeHtml(data.body)}</pre>` : '<p style="font-size:12px; color:var(--color-text-muted); margin:0;">No additional details.</p>'}
    `;
    el.dataset.loaded = '1';
  } catch (err) {
    el.innerHTML = `<p style="color:var(--color-warning); font-size:12px; margin:4px 0 0;">Couldn't load details.</p>`;
  }
}

async function checkUpdate() {
  const statusEl = document.getElementById('update-status');
  statusEl.innerHTML = '<p style="color:var(--color-text-muted); font-size:13px;">Checking...</p>';
  try {
    const res = await fetch('/api/check-update');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
    if (data.update_available) {
      statusEl.innerHTML = `
        <div class="warning-box">
          Update available (${data.current_commit} &rarr; ${data.remote_commit}):
          <ul class="commit-list">
            ${data.commits.map(c => renderCommitLineHtml(c, 'pending')).join('')}
          </ul>
        </div>
        <div class="btn-grid" style="margin-top:10px;">
          <button class="btn small" data-action="install-update">Install Update</button>
        </div>
      `;
    } else {
      statusEl.innerHTML = `<p style="color:var(--color-text-muted); font-size:13px;">Up to date (${data.current_commit}).</p>`;
    }
  } catch (err) {
    statusEl.innerHTML = `<p style="color:var(--color-warning); font-size:13px;">Couldn't check for updates: ${escapeHtml(String(err))}</p>`;
  }
}

// Past updates are paged, not loaded all at once -- each click pulls
// exactly PAST_UPDATES_PAGE_SIZE more commits (`git log --skip`/`-n` on
// the backend), appended to what's already shown, so opening this list
// never means fetching the whole repo history.
const PAST_UPDATES_PAGE_SIZE = 10;
let pastUpdatesSkip = 0;

async function loadPastUpdates() {
  const list = document.getElementById('past-updates-list');
  const controls = document.getElementById('past-updates-controls');
  controls.innerHTML = '<p style="color:var(--color-text-muted); font-size:13px;">Loading...</p>';
  try {
    const res = await fetch(`/data/past-updates?skip=${pastUpdatesSkip}&limit=${PAST_UPDATES_PAGE_SIZE}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
    const commits = data.commits || [];
    list.insertAdjacentHTML('beforeend', commits.map(c => renderCommitLineHtml(c, 'past')).join(''));
    pastUpdatesSkip += commits.length;
    const hasMore = commits.length === PAST_UPDATES_PAGE_SIZE;
    if (hasMore) {
      controls.innerHTML = '<button class="btn small" data-action="load-past-updates">Load Older</button>';
    } else if (pastUpdatesSkip > 0) {
      controls.innerHTML = '<p style="color:var(--color-text-muted); font-size:13px;">No more history.</p>';
    } else {
      controls.innerHTML = '<p style="color:var(--color-text-muted); font-size:13px;">No update history found.</p>';
    }
  } catch (err) {
    controls.innerHTML = `<p style="color:var(--color-warning); font-size:13px;">Couldn't load update history.</p>`;
  }
}

// Same "poll instead of guess" reasoning as restartService()'s
// mealie-trigger case, generalized: a software update might restart
// nothing at all (js/docs-only changes), just the trigger service, or a
// full `docker compose` recreate -- there's no single fixed wait time
// that's right for all three, and a full recreate can genuinely take
// longer than any short guess. Every one of those restart shapes sits
// between the browser and trigger_server.py behind nginx, so polling
// system-status-basics (which needs both nginx and trigger_server.py up)
// covers all three cases through one check. Unlike the single-service
// restart case, "nothing needed restarting" is a real, common outcome
// here (nginx/trigger never even blip) -- requiring several consecutive
// successful checks before declaring done (instead of requiring an
// observed down-then-up transition) handles that case correctly too,
// without waiting out the full timeout for something that was never down.
async function pollForBackendRecovery({ timeoutMs = 60000 } = {}) {
  let sawDown = false;
  let consecutiveUp = 0;
  const REQUIRED_CONSECUTIVE_UP_IF_NEVER_DOWN = 3;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let up;
    try {
      const r = await fetch('/data/system-status-basics');
      up = r.ok;
    } catch (e) {
      up = false;
    }
    if (up) {
      consecutiveUp++;
      if (sawDown || consecutiveUp >= REQUIRED_CONSECUTIVE_UP_IF_NEVER_DOWN) return true;
    } else {
      sawDown = true;
      consecutiveUp = 0;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function installUpdate() {
  showStatusModal('Installing update...', 'loading');
  try {
    const res = await fetch('/api/apply-update', { method: 'POST' });
    const data = await res.json();
    if (data.status !== 'ok') {
      showStatusModal(data.message || 'Update failed.', 'error');
      return;
    }
    showResetLog(data.log || [data.message], 'Applying -- waiting for services to come back up...', false);
    const backUp = await pollForBackendRecovery();
    const footer = document.getElementById('reset-log-footer');
    if (backUp) {
      if (footer) footer.textContent = 'Back up. Reloading...';
      setTimeout(() => window.location.reload(), 1200);
    } else if (footer) {
      footer.textContent = "Still not responding after 60s -- something may have gone wrong. Check via SSH (docker compose ps).";
      footer.style.color = 'var(--color-warning)';
    }
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
    const checkBtn = e.target.closest('[data-action="check-update"]');
    if (checkBtn) { checkUpdate(); return; }
    const installBtn = e.target.closest('[data-action="install-update"]');
    if (installBtn) { installUpdate(); return; }
    const pastBtn = e.target.closest('[data-action="load-past-updates"]');
    if (pastBtn) { loadPastUpdates(); return; }
    const detailBtn = e.target.closest('[data-action="toggle-commit-detail"]');
    if (detailBtn) { toggleCommitDetail(detailBtn.dataset.hash, detailBtn.dataset.target); return; }
    const svcLogBtn = e.target.closest('[data-action="toggle-service-logs"]');
    if (svcLogBtn) { toggleServiceLogs(svcLogBtn.dataset.service, svcLogBtn.dataset.target); return; }
    const svcRestartBtn = e.target.closest('[data-action="restart-service"]');
    if (svcRestartBtn) { restartService(svcRestartBtn.dataset.service); return; }
    const containerLogBtn = e.target.closest('[data-action="toggle-container-logs"]');
    if (containerLogBtn) { toggleContainerLogs(containerLogBtn.dataset.container, containerLogBtn.dataset.target); return; }
    const containerRestartBtn = e.target.closest('[data-action="restart-container"]');
    if (containerRestartBtn) { restartContainer(containerRestartBtn.dataset.container); return; }
  });
}

registerApp('system', {
  title: '&#x2699;&#xFE0F; System',
  bodyHtml: `<div id="conn-error-banner" class="error-banner"></div><div id="system-root"></div>`,
  onRender: () => {
    wireDelegatedListeners();
    pastUpdatesSkip = 0;
    commitDetailSeq = 0;
    loadSystemStatus();
  },
});
