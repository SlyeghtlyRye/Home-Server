// core.js -- application shell. Knows nothing about specific features;
// features register themselves via registerApp() so adding a new one
// never requires editing this file.

const apps = {};
const cleanupHandlers = [];

export function registerApp(key, appDef) {
  // appDef: { title, bodyHtml?: string, onRender?: (container) => void }
  apps[key] = appDef;
}

export function onViewLeave(fn) {
  // fn receives the key of the app being entered (or null for the grid),
  // so a feature can decide whether it's really being left.
  cleanupHandlers.push(fn);
}

function runCleanup(nextAppKey) {
  cleanupHandlers.forEach(fn => fn(nextAppKey));
}

export function showStatusModal(message, kind) {
  const overlay = document.getElementById('status-overlay');
  const modal = document.getElementById('status-modal');
  const spinner = document.getElementById('status-spinner');
  const dismiss = document.getElementById('status-dismiss');
  document.getElementById('status-message').textContent = message;
  modal.classList.remove('error', 'success');
  if (kind === 'loading') {
    spinner.style.display = 'block';
    dismiss.style.display = 'none';
  } else if (kind === 'success') {
    spinner.style.display = 'none';
    dismiss.style.display = 'none';
    modal.classList.add('success');
  } else if (kind === 'error') {
    spinner.style.display = 'none';
    dismiss.style.display = 'inline-block';
    modal.classList.add('error');
  }
  overlay.style.display = 'flex';
}

export function hideStatusModal() {
  document.getElementById('status-overlay').style.display = 'none';
}

export function showSuccessThenClose(message, delay) {
  showStatusModal(message, 'success');
  setTimeout(hideStatusModal, delay || 1500);
}

export function showErrorBanner(message) {
  const el = document.getElementById('conn-error-banner');
  if (!el) return;
  el.textContent = '\u26A0 ' + message;
  el.style.display = 'block';
}

export function clearErrorBanner() {
  const el = document.getElementById('conn-error-banner');
  if (!el) return;
  el.style.display = 'none';
  el.textContent = '';
}

export function showGrid() {
  runCleanup(null);
  document.getElementById('grid-view').style.display = 'block';
  document.getElementById('detail-view').style.display = 'none';
}

export function showDetail(appKey) {
  runCleanup(appKey);
  document.getElementById('grid-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
  const info = apps[appKey];
  const content = document.getElementById('detail-content');
  if (!info) {
    content.innerHTML = `<h1>Unknown app</h1>`;
    return;
  }
  content.innerHTML = `<h1>${info.title}</h1>${info.bodyHtml || ''}`;
  if (info.onRender) info.onRender(content);
}

export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function initShellListeners() {
  document.querySelectorAll('#grid-view .card').forEach(card => {
    const appKey = card.dataset.app;
    card.addEventListener('click', () => showDetail(appKey));
  });
  document.querySelector('#detail-view .back-btn').addEventListener('click', showGrid);
  document.getElementById('status-dismiss').addEventListener('click', hideStatusModal);
}

document.addEventListener('DOMContentLoaded', initShellListeners);
