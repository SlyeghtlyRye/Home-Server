// health-check.js -- the "!" button in the header: checks that this
// browser can actually reach the dashboard's data endpoints, and offers a
// one-click "refresh everything" that re-downloads the page's own files.
//
// Why it exists: a browser can fail on its own while the server is fine --
// Brave Shields or an ad-blocking extension silently blocking /data/...
// requests, or a stale cached copy of a script. Every tab swallows those
// fetch errors (e.g. calendar-settings.js falls back to an empty bucket
// list), so the page just looks empty with no hint why. This makes the
// difference between "server broken" and "this browser is blocking it"
// visible in one click.
//
// Deliberately standalone: no imports from core.js or any feature module,
// so it still works when those are the thing that's broken or stale.

// Cheap, parameter-free GETs -- one or two per tab. Nothing heavy (no
// recipe list, no container stats) since this also runs once on load on a
// 914Mi device.
const ENDPOINTS = [
  { path: '/data/chore-buckets', label: 'Kanboard buckets' },
  { path: '/data/holiday-settings', label: 'Calendar settings' },
  { path: '/data/holiday-countries', label: 'Holiday countries' },
  { path: '/data/kanboard-people', label: 'Kanboard people' },
  { path: '/data/available-weeks', label: 'Mealie weeks' },
  { path: '/data/audiobook-profiles', label: 'Streams profiles' },
  { path: '/data/syncthing-instances', label: 'Syncthing instances' },
  { path: '/data/docs-list', label: 'Docs list' },
  { path: '/data/setup-status', label: 'Setup status' },
];

// The page's own files -- re-fetched with cache:'reload' by "Refresh
// everything", which overwrites any stale copy in the browser's HTTP cache
// before the page reloads. Keep in sync with dashboard.html's <script> and
// <link> tags (plus modules they import, like calendar-settings.js).
const ASSETS = [
  '/', '/dashboard.html', '/css/dashboard.css',
  '/js/config.js', '/js/core.js', '/js/static-apps.js', '/js/mealie.js',
  '/js/kanboard.js', '/js/calendar-settings.js', '/js/streams.js',
  '/js/syncthing.js', '/js/docs.js', '/js/system.js', '/js/wizard.js',
  '/js/health-check.js',
];

const TIMEOUT_MS = 8000;

let lastResults = null;
let checking = false;

// One fetch, reporting whether it produced usable JSON.
async function tryJson(path, cache, signal) {
  const res = await fetch(path, { cache, signal });
  if (!res.ok) return { ok: false, status: res.status };
  try {
    await res.json();
    return { ok: true };
  } catch {
    return { ok: false, status: res.status, notJson: true };
  }
}

async function checkEndpoint({ path, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    // cache:'default' on purpose -- the same path through the browser's
    // HTTP cache that the tabs' own code took before core.js forced
    // no-store, so a stale cached copy shows up here instead of hiding
    // behind a fresh network fetch.
    const cached = await tryJson(path, 'default', controller.signal);
    const ms = Math.round(performance.now() - started);
    if (cached.ok) return { label, path, ok: true, detail: `OK (${ms} ms)`, ms };
    // Ask the server directly to tell "browser cache is wrong" apart from
    // "server is wrong".
    const live = await tryJson(path, 'no-store', controller.signal);
    if (live.ok) {
      return { label, path, ok: false, kind: 'stale', detail: 'Old copy stuck in browser cache' };
    }
    if (live.notJson) return { label, path, ok: false, kind: 'server', detail: 'Got a web page, not data' };
    return { label, path, ok: false, kind: 'server', detail: `Server error (HTTP ${live.status})` };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { label, path, ok: false, kind: 'timeout', detail: `No reply after ${TIMEOUT_MS / 1000}s` };
    }
    // fetch() only rejects like this when no HTTP response arrived at all:
    // the request was blocked inside the browser, or the network is down.
    return { label, path, ok: false, kind: 'blocked', detail: 'Blocked or unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function runChecks() {
  if (checking) return lastResults;
  checking = true;
  setButtonState('checking');
  renderPanel();
  try {
    lastResults = await Promise.all(ENDPOINTS.map(checkEndpoint));
  } finally {
    checking = false;
  }
  setButtonState(lastResults.every(r => r.ok) ? 'ok' : 'bad');
  renderPanel();
  return lastResults;
}

// Plain-language read of the results -- the point of the whole feature.
function diagnosis(results) {
  const failed = results.filter(r => !r.ok);
  if (!failed.length) {
    return 'Everything this browser needs is reachable. If a tab still looks wrong, try "Refresh everything".';
  }
  const blocked = failed.filter(r => r.kind === 'blocked');
  const someOk = results.some(r => r.ok);
  if (failed.every(r => r.kind === 'stale')) {
    return 'The server is fine, but this browser cached an old, wrong copy of some data. Click "Refresh everything" to replace it.';
  }
  if (blocked.length && someOk) {
    return 'The server is up, but this browser blocked some requests. Turn Brave Shields off for this site (lion icon in the address bar) or allow it in your ad blocker, then reload.';
  }
  if (blocked.length === results.length) {
    return "This browser can't reach the dashboard server at all. Check you're on the home network or Tailscale. If a private window works, a blocker extension or Shields is the likely cause.";
  }
  if (failed.every(r => r.kind === 'server' || r.kind === 'timeout')) {
    return 'The browser is fine, but the server reported errors for some items. Check the System tab or restart the affected service.';
  }
  return 'Some checks failed. See the list below for which ones.';
}

async function refreshEverything(btn) {
  btn.disabled = true;
  btn.textContent = 'Refreshing...';
  // Overwrite stale HTTP-cache copies of the page's own files, and of the
  // data endpoints (cache:'reload' replaces a cached entry with the fresh
  // reply -- a stale HTML copy of /data/... included).
  const urls = [...ASSETS, ...ENDPOINTS.map(e => e.path)];
  await Promise.all(urls.map(url => fetch(url, { cache: 'reload' }).catch(() => {})));
  // Nothing here registers a service worker or uses Cache Storage today,
  // but a leftover one from an old version would serve stale files forever.
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch { /* best effort */ }
  // localStorage is left alone on purpose: it holds per-browser
  // preferences (panel sizes, show-holidays), not cached data.
  location.reload();
}

function setButtonState(state) {
  const btn = document.getElementById('health-btn');
  if (!btn) return;
  btn.classList.remove('checking', 'ok', 'bad');
  btn.classList.add(state);
  btn.title = {
    checking: 'Checking connection...',
    ok: 'All data endpoints reachable. Click for details or to refresh.',
    bad: 'Some data could not be loaded. Click for details.',
  }[state];
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.forEach(c => node.append(c));
  return node;
}

function renderPanel() {
  const panel = document.getElementById('health-panel');
  if (!panel || panel.hidden) return;
  panel.replaceChildren();

  panel.append(el('div', { className: 'health-title', textContent: 'Connection check' }));

  if (checking || !lastResults) {
    panel.append(el('p', { className: 'health-diagnosis', textContent: 'Checking...' }));
  } else {
    const allOk = lastResults.every(r => r.ok);
    panel.append(el('p', {
      className: 'health-diagnosis ' + (allOk ? 'ok' : 'bad'),
      textContent: diagnosis(lastResults),
    }));
    const list = el('ul', { className: 'health-list' });
    lastResults.forEach(r => {
      list.append(el('li', { className: r.ok ? 'ok' : 'bad', title: r.path }, [
        el('span', { className: 'health-mark', textContent: r.ok ? '✓' : '✗' }),
        el('span', { className: 'health-label', textContent: r.label }),
        el('span', { className: 'health-detail', textContent: r.detail }),
      ]));
    });
    panel.append(list);
  }

  const recheck = el('button', { className: 'btn small', textContent: 'Check again', disabled: checking });
  recheck.addEventListener('click', () => runChecks());
  const refresh = el('button', { className: 'btn small save', textContent: 'Refresh everything' });
  refresh.addEventListener('click', () => refreshEverything(refresh));
  panel.append(el('div', { className: 'health-actions' }, [recheck, refresh]));
  panel.append(el('p', {
    className: 'health-note',
    textContent: '"Refresh everything" re-downloads the dashboard\'s files and reloads. Your settings are kept.',
  }));
}

function togglePanel(force) {
  const panel = document.getElementById('health-panel');
  const btn = document.getElementById('health-btn');
  if (!panel || !btn) return;
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) {
    renderPanel();
    runChecks();
  }
}

function init() {
  const btn = document.getElementById('health-btn');
  const panel = document.getElementById('health-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanel();
  });
  // Clicks inside the panel never count as "outside" -- stopped here
  // because renderPanel() swaps the clicked button out mid-click, so by the
  // time the document listener runs, e.target is no longer in the panel.
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (!panel.hidden && e.target !== btn) togglePanel(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) togglePanel(false);
  });
  // One quiet check shortly after load, so the button turns red on its own
  // when something's wrong -- you shouldn't have to know to click it.
  setTimeout(runChecks, 1500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
