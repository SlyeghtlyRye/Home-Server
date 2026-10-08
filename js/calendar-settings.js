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
    const [countriesRes, settingsRes] = await Promise.all([
      fetch('/data/holiday-countries'),
      fetch('/data/holiday-settings'),
    ]);
    const countriesData = await countriesRes.json();
    const settingsData = await settingsRes.json();
    countriesCache = countriesData.countries || [];
    currentCountryCache = settingsData.country || '';
  } catch (err) {
    console.error('Failed to load calendar settings', err);
    countriesCache = countriesCache || [];
    currentCountryCache = currentCountryCache || '';
  }
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
  `;
}

// Returns true if it handled the click (caller should stop there),
// false otherwise -- matches this codebase's existing delegated-listener
// convention of a chain of `if (...) return ...;` checks.
export function handleClick(e, calendarKey, rerender) {
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
