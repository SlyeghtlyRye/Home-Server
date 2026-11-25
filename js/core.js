// core.js -- application shell. Knows nothing about specific features;
// features register themselves via registerApp() so adding a new one
// never requires editing this file.

// Every /data/ and /api/ request goes to the network, never the browser's
// HTTP cache, unless the caller explicitly picks a cache mode. Live data
// should never be served from cache anyway, and a cached entry can be
// actively wrong: when an endpoint's nginx location wasn't loaded yet, the
// request fell through to the dashboard's HTML page, and a browser that
// cached that kept handing it back ("Unexpected token '<'") long after the
// server was fixed -- confirmed in Brave for /data/chore-buckets, which
// left Kanboard's Schedule with no buckets. Patched here, in the first
// module dashboard.html loads, so it's in place before any tab fetches.
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const path = url.startsWith('/') ? url : (() => {
    try { const u = new URL(url); return u.origin === location.origin ? u.pathname : ''; } catch { return ''; }
  })();
  if ((path.startsWith('/data/') || path.startsWith('/api/')) && !init.cache) {
    init = { ...init, cache: 'no-store' };
  }
  return nativeFetch(input, init);
};

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

// Non-blocking counterpart to showStatusModal: a small corner banner for
// work that runs in the background (a long save, a sync) where the point
// is specifically that the user can keep navigating the dashboard --
// status-overlay's full-screen backdrop is wrong for that on purpose.
// Lives in the persistent shell (dashboard.html), not a per-tab bodyHtml,
// so it survives switching tabs while the background work it's reporting
// on keeps running.
export function showProcessingBanner(message) {
  const el = document.getElementById('processing-banner');
  if (!el) return;
  document.getElementById('processing-banner-message').textContent = message;
  el.style.display = 'flex';
}

export function hideProcessingBanner() {
  const el = document.getElementById('processing-banner');
  if (!el) return;
  el.style.display = 'none';
}

export function showConfirmModal(message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('status-overlay');
    const modal = document.getElementById('status-modal');
    const spinner = document.getElementById('status-spinner');
    const dismiss = document.getElementById('status-dismiss');
    document.getElementById('status-message').textContent = message;
    modal.classList.remove('error', 'success');
    spinner.style.display = 'none';
    dismiss.style.display = 'none';

    let row = document.getElementById('status-confirm-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'status-confirm-row';
      row.style.marginTop = '18px';
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.justifyContent = 'center';
      modal.appendChild(row);
    }
    row.innerHTML = `
      <button class="btn small cancel" id="status-confirm-cancel">Cancel</button>
      <button class="btn small save" id="status-confirm-ok">Confirm</button>
    `;
    row.style.display = 'flex';
    overlay.style.display = 'flex';

    const finish = (result) => {
      row.style.display = 'none';
      overlay.style.display = 'none';
      resolve(result);
    };
    document.getElementById('status-confirm-ok').onclick = () => finish(true);
    document.getElementById('status-confirm-cancel').onclick = () => finish(false);
  });
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
  updateActiveNav('grid');
  setHeaderTitle('&#x1F3E0; Home Management');
}

export function showDetail(appKey) {
  runCleanup(appKey);
  document.getElementById('grid-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
  const info = apps[appKey];
  const content = document.getElementById('detail-content');
  if (!info) {
    // Most likely cause: this app's own script threw while loading
    // (e.g. a missing file it imports) before it reached its
    // registerApp() call, rather than the key itself being wrong --
    // worth saying explicitly, since "Unknown app" alone reads like a
    // typo'd nav link and sends someone looking in the wrong place.
    content.innerHTML = `
      <p>This section failed to load.</p>
      <p style="color:var(--color-text-muted); font-size:13px;">
        Its script likely threw an error before it could register itself --
        check the browser console (F12) for the actual error.
      </p>`;
    setHeaderTitle('Unknown app');
    return;
  }
  content.innerHTML = info.bodyHtml || '';
  if (info.onRender) info.onRender(content);
  updateActiveNav(appKey);
  setHeaderTitle(info.title);
}

function setHeaderTitle(html) {
  const brand = document.querySelector('.app-header-brand');
  if (brand) brand.innerHTML = html;
}

export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// Round icon action buttons for the Mealie and Kanboard mode panels, side
// by side in a .round-actions row: green check = save/create, green play =
// next step, red X = cancel/back/close, red trash = delete. Icon-only, so
// the label goes in title (hover tooltip) and aria-label. extraAttrs is
// raw markup (e.g. 'disabled', 'data-date="..."').
// &#xFE0E; asks for the plain text glyph, not a colour emoji.
export const ICON_CONFIRM = '&#x2713;';
export const ICON_NEXT = '&#x25B6;&#xFE0E;';
export const ICON_CANCEL = '&#x2715;';
export const ICON_DELETE = '&#x1F5D1;&#xFE0E;';
export function roundBtn(kind, action, icon, label, extraAttrs = '') {
  return `<button type="button" class="round-btn ${kind}" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" ${extraAttrs}>${icon}</button>`;
}

export function isoOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function updateActiveNav(appKey) {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.nav === appKey);
  });
}

// ---------- Header height + mobile auto-hide ----------
//
// The floating mode panels (#mode-panel / #kb-mode-panel) are fixed to
// the bottom of the screen and drag-resized from their top-right corner.
// They used to cap at a flat 90vh on phones, which (with the sticky
// header wrapping to two rows, and mobile browser chrome eating into vh)
// let the panel's top -- and its resize handle -- end up underneath the
// header, so it couldn't be dragged back down. The cap is now "whatever's
// visible below the header": the header's live height is published as
// --app-header-h for the CSS max-height, and modePanelMaxHeight() gives
// the matching number for the JS drag clamp.

const PANEL_BOTTOM_OFFSET = 16; // #mode-panel's CSS bottom
const PANEL_TOP_GAP = 12;       // breathing room under the header

function headerHeight() {
  const header = document.getElementById('app-header');
  return header ? header.offsetHeight : 0;
}

export function modePanelMaxHeight() {
  const viewport = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const belowHeader = viewport - headerHeight() - PANEL_BOTTOM_OFFSET - PANEL_TOP_GAP;
  // Desktop keeps its 70vh cap so a good chunk of the calendar stays visible.
  const cap = window.innerWidth <= 600 ? belowHeader : Math.min(belowHeader, viewport * 0.7);
  return Math.max(160, Math.round(cap));
}

function publishHeaderHeight() {
  document.documentElement.style.setProperty('--app-header-h', headerHeight() + 'px');
}

// Phones only (matches the 600px breakpoint in dashboard.css): scrolling
// down slides the header away, scrolling up brings it back. Always shown
// near the top of the page.
function initHeaderAutoHide() {
  const header = document.getElementById('app-header');
  if (!header) return;
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const delta = y - lastY;
    if (Math.abs(delta) < 6) return; // ignore jitter / momentum noise
    const hide = window.innerWidth <= 600 && delta > 0 && y > header.offsetHeight;
    header.classList.toggle('header-hidden', hide);
    lastY = y;
  }, { passive: true });
}

function initShellListeners() {
  publishHeaderHeight();
  new ResizeObserver(publishHeaderHeight).observe(document.getElementById('app-header'));
  initHeaderAutoHide();

  document.querySelectorAll('#grid-view .card').forEach(card => {
    const appKey = card.dataset.app;
    card.addEventListener('click', () => showDetail(appKey));
  });
  document.querySelector('#detail-view .back-btn').addEventListener('click', showGrid);
  document.getElementById('status-dismiss').addEventListener('click', hideStatusModal);

  document.getElementById('app-header').addEventListener('click', (e) => {
    const navEl = e.target.closest('[data-nav]');
    if (!navEl) return;
    const target = navEl.dataset.nav;
    if (target === 'grid') {
      showGrid();
    } else {
      showDetail(target);
    }
  });
}

document.addEventListener('DOMContentLoaded', initShellListeners);
