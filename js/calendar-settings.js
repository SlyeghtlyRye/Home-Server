// calendar-settings.js -- shared settings gear popover for Mealie's and
// Kanboard's calendars: show/hide holidays (per-browser, per-calendar),
// which country's holidays to show (one global setting shared by both
// calendars -- a household has one location), and a subscribable .ics
// feed URL. Built once, shared, rather than duplicated in both
// mealie.js and kanboard.js -- unlike the floating mode-panel (which
// stayed duplicated because Mealie's was already mature/risky to touch),
// neither calendar had this feature yet, so there's no existing code at
// risk by sharing it.
//
// Deliberately exports plain render/handler functions rather than
// managing its own DOM event listeners: each calendar's own
// renderCalendar() rebuilds its header's innerHTML wholesale on every
// render (month navigation, day clicks, etc.), which would wipe out any
// listener attached directly to this popover's own elements. Instead,
// each calendar's *existing* delegated click/change listener (already
// attached to its own stable container) calls into
// handleClick()/handleChange() here, the same "one delegated listener,
// dispatch by data-action" pattern used everywhere else in this codebase.
import { escapeHtml } from './core.js';

let openPopoverKey = null; // which calendar's popover is open ('mealie'/'kanboard'), or null
let countriesCache = null; // [{code, name}], loaded once, shared by both calendars
let currentCountryCache = null; // the one global country code, or "" if unset
let bucketsCache = null; // [{id, name, type, startTime, dueTime, perWeek?}], Kanboard-only
let autoSettingsOpen = false; // Kanboard gear: Auto Schedule settings list expanded
let savedListOpen = false; // Kanboard gear: Saved tasks & events editor expanded

function showHolidaysStorageKey(calendarKey) {
  return `${calendarKey}_showHolidays`;
}

export function shouldShowHolidays(calendarKey) {
  return localStorage.getItem(showHolidaysStorageKey(calendarKey)) === 'true';
}

// Call once per calendar's onRender -- populates the shared caches so
// renderSettingsGearHtml() can stay synchronous (consistent with every
// other render function in this codebase; the async fetch happens once,
// up front, same pattern as mealie.js's allRecipes/kanboard.js's allPeople).
export async function loadCalendarSettingsData() {
  try {
    const [countriesRes, settingsRes, bucketsRes] = await Promise.all([
      fetch('/data/holiday-countries'),
      fetch('/data/holiday-settings'),
      fetch('/data/chore-buckets'),
    ]);
    const countriesData = await countriesRes.json();
    const settingsData = await settingsRes.json();
    const bucketsData = await bucketsRes.json();
    countriesCache = countriesData.countries || [];
    currentCountryCache = settingsData.country || '';
    bucketsCache = bucketsData.buckets || [];
  } catch (err) {
    console.error('Failed to load calendar settings', err);
    countriesCache = countriesCache || [];
    currentCountryCache = currentCountryCache || '';
    bucketsCache = bucketsCache || [];
  }
}

// The shared bucket list (null until loadCalendarSettingsData() has run)
// -- Kanboard's Schedule panel reads this rather than keeping its own copy.
export function getChoreBuckets() {
  return bucketsCache;
}

function icalUrl(calendarKey) {
  const path = calendarKey === 'mealie' ? '/data/mealie-ical' : '/data/kanboard-ical';
  const holidaysParam = shouldShowHolidays(calendarKey) ? '1' : '0';
  return `${location.origin}${path}?holidays=${holidaysParam}`;
}

export function renderSettingsGearHtml(calendarKey) {
  const isOpen = openPopoverKey === calendarKey;
  return `
    <div class="cal-settings-wrap">
      <button class="cal-settings-gear" data-action="toggle-cal-settings" data-calendar="${calendarKey}" title="Calendar settings">&#x2699;&#xFE0F;</button>
      ${isOpen ? `<div class="cal-settings-popover">${popoverBodyHtml(calendarKey)}</div>` : ''}
    </div>
  `;
}

function popoverBodyHtml(calendarKey) {
  if (countriesCache === null) {
    return `<p style="font-size:12px; color:var(--color-text-muted); margin:0;">Loading...</p>`;
  }
  const showHolidays = shouldShowHolidays(calendarKey);
  return `
    <label class="cal-settings-row">
      <input type="checkbox" data-action="cal-settings-show-holidays" data-calendar="${calendarKey}" ${showHolidays ? 'checked' : ''}>
      Show holidays
    </label>
    <div style="margin-bottom:10px;">
      <div style="color:var(--color-text-muted); font-size:11px; margin-bottom:4px;">Location (holidays)</div>
      <select data-action="cal-settings-country" data-calendar="${calendarKey}" style="width:100%; background:var(--color-surface); color:white; border:1px solid var(--color-border); padding:6px; border-radius:4px; font-size:12px;">
        <option value="">Not set</option>
        ${countriesCache.map(c => `<option value="${c.code}" ${c.code === currentCountryCache ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
      </select>
    </div>
    <p class="cal-settings-hint">Subscribe from Apple Calendar/Outlook/etc. on your own devices, while on the same LAN/Tailscale network as this dashboard:</p>
    <div class="cal-settings-row" style="gap:4px;">
      <input type="text" class="cal-settings-feed-url" data-calendar="${calendarKey}" readonly value="${escapeHtml(icalUrl(calendarKey))}">
      <button class="btn small" data-action="copy-feed-url" data-calendar="${calendarKey}">Copy</button>
    </div>
    ${calendarKey === 'kanboard' ? bucketsSectionHtml() : ''}
  `;
}

// Kanboard-only -- "Saved tasks & events" (stored as chore buckets by
// scripts/chore_buckets.py; the people-facing name changed, the data
// didn't), suggested by Quick Add and Schedule's name boxes. Mealie has no
// equivalent concept, so this section only renders in Kanboard's
// popover, the same calendarKey-branch icalUrl() above already uses for
// its own Mealie-vs-Kanboard feed path.
function bucketsSectionHtml() {
  const n = bucketsCache.length;
  return `
    <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--color-border-soft);">
      <button class="auto-sched-toggle" data-action="toggle-saved-items" aria-expanded="${savedListOpen}">
        <span>&#x1F4CB;&#xFE0E; Saved tasks &amp; events</span>
        <span class="saved-summary">${n ? n : ''} ${savedListOpen ? '&#x25B4;' : '&#x25BE;'}</span>
      </button>
      ${savedListOpen ? savedItemsEditorHtml() : ''}
      ${n ? autoScheduleSettingsHtml() : ''}
    </div>
  `;
}

// Expanded "Saved tasks & events": rename, switch Task/Event, delete, add.
// Each field saves on change (blur/Enter for the name), same no-re-render
// approach as the Auto Schedule boxes so other rows keep their edits.
function savedItemsEditorHtml() {
  const fieldStyle = 'background:var(--color-surface); color:white; border:1px solid var(--color-border); padding:6px; border-radius:4px; font-size:12px;';
  return `
    <div class="auto-sched-list">
      <p class="auto-sched-hint">Edit a name or type and it saves right away. Tasks already on the calendar keep their old name.</p>
      ${bucketsCache.map(b => `
        <div class="auto-sched-row">
          <input type="text" class="saved-edit-name" data-action="saved-edit-name" data-id="${escapeHtml(b.id)}"
                 value="${escapeHtml(b.name)}" aria-label="Name" maxlength="80" style="${fieldStyle}">
          <select class="saved-edit-type" data-action="saved-edit-type" data-id="${escapeHtml(b.id)}" aria-label="${escapeHtml(b.name)}: type" style="${fieldStyle}">
            <option value="task" ${b.type !== 'event' ? 'selected' : ''}>Task</option>
            <option value="event" ${b.type === 'event' ? 'selected' : ''}>&#x1F389; Event</option>
          </select>
          <button class="icon-btn-delete" data-action="remove-chore-bucket" data-id="${escapeHtml(b.id)}" title="Remove from saved" aria-label="Remove ${escapeHtml(b.name)}">&#x1F5D1;</button>
        </div>
      `).join('') || `<p style="font-size:12px; color:var(--color-text-muted); margin:0 0 6px;">Nothing saved yet. Add one below, or type a new name while scheduling.</p>`}
      <div class="cal-settings-row" style="gap:4px; margin-top:6px;">
        <input type="text" id="new-bucket-name" placeholder="New, e.g. Sweeping" style="flex:1; min-width:0; ${fieldStyle}">
        <select id="new-bucket-type" style="${fieldStyle}">
          <option value="task">Task</option>
          <option value="event">Event</option>
        </select>
        <button class="btn small" data-action="add-chore-bucket">Add</button>
      </div>
    </div>
  `;
}

// Auto Schedule settings: how many times a week each saved item should
// happen (0 = not auto-scheduled). Settings only for now -- stored on
// each saved item as perWeek for a future Auto Schedule button to use.
function autoScheduleSettingsHtml() {
  return `
    <button class="auto-sched-toggle" data-action="toggle-auto-schedule-settings" aria-expanded="${autoSettingsOpen}">
      <span>&#x23F1;&#xFE0E; Auto Schedule settings</span>
      <span class="auto-sched-summary">${autoSettingsOpen ? '&#x25B4;' : '&#x25BE;'}</span>
    </button>
    ${autoSettingsOpen ? `
      <div class="auto-sched-list">
        <p class="auto-sched-hint">How many times a week should each one happen? Leave at 0 to skip it.</p>
        ${bucketsCache.map(b => `
          <label class="auto-sched-row">
            <span class="auto-sched-name">${escapeHtml(b.name)}</span>
            <span class="kb-type-tag ${b.type === 'event' ? 'event' : ''}">${b.type === 'event' ? '&#x1F389; Event' : 'Task'}</span>
            <input type="number" min="0" max="7" step="1" inputmode="numeric"
                   class="auto-sched-input" data-action="auto-schedule-per-week" data-id="${escapeHtml(b.id)}"
                   value="${b.perWeek || 0}" aria-label="${escapeHtml(b.name)}: times per week">
            <span class="auto-sched-unit">/ week</span>
          </label>
        `).join('')}
      </div>
    ` : ''}
  `;
}

// Saves one edited name or type from the Saved tasks & events editor.
// The server keeps names unique (case-insensitive) and non-empty; on a
// rejection the field goes back to its last saved value with the reason
// as a tooltip. Also patches the matching Auto Schedule row in place.
async function saveSavedField(el, field) {
  const id = el.dataset.id;
  const bucket = (bucketsCache || []).find(b => b.id === id);
  if (!bucket) return;
  const previous = field === 'name' ? bucket.name : (bucket.type === 'event' ? 'event' : 'task');
  const value = field === 'name' ? el.value.trim() : el.value;
  el.classList.remove('save-failed', 'saved');
  el.title = '';
  if (value === previous) { el.value = previous; return; }
  try {
    const res = await fetch('/api/update-chore-bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, [field]: value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    bucket.name = data.bucket?.name ?? bucket.name;
    bucket.type = data.bucket?.type ?? bucket.type;
    el.value = field === 'name' ? bucket.name : bucket.type;
    el.classList.add('saved');
    setTimeout(() => el.classList.remove('saved'), 1200);
    const autoRow = el.closest('.cal-settings-popover')
      ?.querySelector(`.auto-sched-input[data-id="${CSS.escape(id)}"]`)?.closest('.auto-sched-row');
    if (autoRow) {
      autoRow.querySelector('.auto-sched-name').textContent = bucket.name;
      const tag = autoRow.querySelector('.kb-type-tag');
      tag.className = `kb-type-tag ${bucket.type === 'event' ? 'event' : ''}`;
      tag.innerHTML = bucket.type === 'event' ? '&#x1F389; Event' : 'Task';
    }
  } catch (err) {
    el.value = previous;
    el.classList.add('save-failed');
    el.title = `Couldn't save: ${err.message}`;
  }
}

// Saves one Auto Schedule "times per week" box. Deliberately no full
// re-render: other boxes may be mid-edit, and the input already shows the
// value.
async function savePerWeek(input) {
  const id = input.dataset.id;
  const bucket = (bucketsCache || []).find(b => b.id === id);
  const previous = bucket?.perWeek || 0;
  const n = Math.round(Number(input.value));
  const perWeek = Number.isFinite(n) ? Math.min(7, Math.max(0, n)) : 0;
  input.value = perWeek;
  input.classList.remove('save-failed', 'saved');
  try {
    const res = await fetch('/api/update-chore-bucket-per-week', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, perWeek }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (bucket) bucket.perWeek = perWeek;
    input.classList.add('saved');
    setTimeout(() => input.classList.remove('saved'), 1200);
  } catch {
    input.value = previous;
    input.classList.add('save-failed');
    input.title = "Couldn't save -- check the connection and try again";
  }
}

// Returns true if it handled the click (caller should stop there),
// false otherwise -- matches this codebase's existing delegated-listener
// convention of a chain of `if (...) return ...;` checks.
// onBucketsChanged (optional): called after a bucket add/remove lands, so
// Kanboard's Schedule panel can redraw its dropdowns with the new list.
export function handleClick(e, calendarKey, rerender, onBucketsChanged = () => {}) {
  const toggleBtn = e.target.closest('[data-action="toggle-cal-settings"]');
  if (toggleBtn && toggleBtn.dataset.calendar === calendarKey) {
    openPopoverKey = openPopoverKey === calendarKey ? null : calendarKey;
    rerender();
    return true;
  }
  const copyBtn = e.target.closest('[data-action="copy-feed-url"]');
  if (copyBtn && copyBtn.dataset.calendar === calendarKey) {
    const input = e.target.closest('.cal-settings-popover').querySelector('.cal-settings-feed-url');
    if (input) {
      input.select();
      navigator.clipboard?.writeText(input.value).catch(() => {
        // Clipboard API can be unavailable (e.g. non-HTTPS context) --
        // the text is still selected as a manual-copy fallback.
      });
    }
    return true;
  }
  const savedToggle = e.target.closest('[data-action="toggle-saved-items"]');
  if (savedToggle && calendarKey === 'kanboard') {
    savedListOpen = !savedListOpen;
    rerender();
    return true;
  }
  const autoToggle = e.target.closest('[data-action="toggle-auto-schedule-settings"]');
  if (autoToggle && calendarKey === 'kanboard') {
    autoSettingsOpen = !autoSettingsOpen;
    rerender();
    return true;
  }
  const removeBucketBtn = e.target.closest('[data-action="remove-chore-bucket"]');
  if (removeBucketBtn && calendarKey === 'kanboard') {
    const id = removeBucketBtn.dataset.id;
    fetch('/api/remove-chore-bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(() => loadCalendarSettingsData()).then(() => { rerender(); onBucketsChanged(); }).catch(() => {});
    return true;
  }
  const addBucketBtn = e.target.closest('[data-action="add-chore-bucket"]');
  if (addBucketBtn && calendarKey === 'kanboard') {
    const nameInput = e.target.closest('.cal-settings-popover')?.querySelector('#new-bucket-name');
    const typeSelect = e.target.closest('.cal-settings-popover')?.querySelector('#new-bucket-type');
    const name = nameInput ? nameInput.value.trim() : '';
    const type = typeSelect ? typeSelect.value : 'task';
    if (name) {
      fetch('/api/add-chore-bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type }),
      }).then(() => loadCalendarSettingsData()).then(() => { rerender(); onBucketsChanged(); }).catch(() => {});
    }
    return true;
  }
  // Clicking anywhere else while a popover is open closes it -- but not
  // when the click is inside the popover itself (the checkbox/select
  // handlers need their own click-to-focus to work normally first).
  if (openPopoverKey === calendarKey && !e.target.closest('.cal-settings-popover') && !e.target.closest('.cal-settings-gear')) {
    openPopoverKey = null;
    rerender();
  }
  return false;
}

export function handleChange(e, calendarKey, rerender) {
  const nameInput = e.target.closest('[data-action="saved-edit-name"]');
  if (nameInput && calendarKey === 'kanboard') {
    saveSavedField(nameInput, 'name');
    return true;
  }
  const typeSelect = e.target.closest('[data-action="saved-edit-type"]');
  if (typeSelect && calendarKey === 'kanboard') {
    saveSavedField(typeSelect, 'type');
    return true;
  }
  const perWeekInput = e.target.closest('[data-action="auto-schedule-per-week"]');
  if (perWeekInput && calendarKey === 'kanboard') {
    savePerWeek(perWeekInput);
    return true;
  }
  const holidaysCheckbox = e.target.closest('[data-action="cal-settings-show-holidays"]');
  if (holidaysCheckbox && holidaysCheckbox.dataset.calendar === calendarKey) {
    localStorage.setItem(showHolidaysStorageKey(calendarKey), holidaysCheckbox.checked ? 'true' : 'false');
    rerender();
    return true;
  }
  const countrySelect = e.target.closest('[data-action="cal-settings-country"]');
  if (countrySelect && countrySelect.dataset.calendar === calendarKey) {
    const country = countrySelect.value;
    currentCountryCache = country;
    fetch('/api/save-holiday-country', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country }),
    }).catch(() => {
      // Best-effort -- the select already reflects the attempted value;
      // a failed save just means it reverts on next page load.
    });
    rerender();
    return true;
  }
  return false;
}
