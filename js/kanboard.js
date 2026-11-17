// kanboard.js -- task board: calendar (plan/view/edit) over real tasks
// on the self-hosted Kanboard instance's "Tasks" project. Pre-alpha
// foundation, deliberately modeled on js/mealie.js's calendar/mode-panel
// shell -- including the same floating, drag-resizable panel (not a
// simplified inline one), so the two tabs genuinely look and behave the
// same -- but simpler where Kanboard's shape allows it:
//   - A day can have zero, several, or many tasks (plannedMap[iso] is a
//     LIST), unlike Mealie's one-meal-per-day assumption.
//   - All three modes center on "the one day you clicked" -- there's no
//     Mealie-style multi-day week selection in Plan mode here, so a
//     single shared `selectedIso` works for all three modes with no
//     carry-over logic needed when switching modes.
//   - Recurrence is pre-materialized as independent real Kanboard tasks
//     at Plan time (no native Kanboard recurrence, no series linkage) --
//     see docs/kanboard.md for why.
// DOM ids are all prefixed kb- (distinct from Mealie's) so a stray
// render call from one tab's module can never land in the other tab's
// now-absent (or coincidentally same-id) markup. The two tabs' floating
// panels (#mode-panel / #kb-mode-panel) share their CSS by selector
// (css/dashboard.css), not by sharing one element, for the same reason.
import { registerApp, showStatusModal, hideStatusModal, showSuccessThenClose,
         showConfirmModal, escapeHtml, isoOf } from './core.js';
import { shouldShowHolidays, loadCalendarSettingsData, renderSettingsGearHtml, getChoreBuckets,
         handleClick as handleCalSettingsClick, handleChange as handleCalSettingsChange } from './calendar-settings.js';
// Read as a global, not a static `import` from config.js -- see the
// matching comment in mealie.js for why (gitignored/per-device file, so
// a failed import would take this whole module's calendar logic down
// over one cosmetic external link).
const HOST_IP = window.HOST_IP || location.hostname;

let calendarMonth = new Date();
let plannedMap = {}; // iso -> [{id, title, done, assignee}, ...]
let holidaysByDate = {}; // iso -> holiday name, only populated when shouldShowHolidays('kanboard')
let allPeople = []; // [{id, name}, ...] -- the "assigned to" combo's suggestions

const CALENDAR_MODES = ['plan', 'view', 'edit'];
let calendarMode = CALENDAR_MODES.includes(localStorage.getItem('kanboard_calendarMode'))
  ? localStorage.getItem('kanboard_calendarMode')
  : 'plan';
let selectedIso = null;

// ---------- Schedule (Plan mode's "from buckets" sub-flow) ----------
// A toggle inside Plan mode, not a separate mode tab -- Quick Add (the
// existing single-day form above) is unchanged; Schedule is a second
// way to use Plan mode, for dropping reusable buckets (Sweeping, Date
// Night) onto one or more days at once. Direct multi-select, not
// Mealie's "click adds a whole week block" mechanic -- chores/events
// are just as often "add one specific day" as "fill the week", and
// having to exclude six days to add one date night would be backwards.
const PLAN_SUBMODES = ['quick', 'schedule'];
let planSubMode = PLAN_SUBMODES.includes(localStorage.getItem('kanboard_planSubMode'))
  ? localStorage.getItem('kanboard_planSubMode')
  : 'quick';
let scheduleSelectedDates = new Set(); // ISO strings, only meaningful mid-selection
let schedulePicks = null; // null until "Schedule N Days" clicked, then {iso: emptyPick()-shaped row state}

// Mirrors mealie.js's modePanelHeight/Width/ShowModeSwitcher exactly (own
// localStorage keys so the two tabs' panel sizes don't fight each other).
let modePanelHeight = parseInt(localStorage.getItem('kanboard_modePanelHeight'), 10) || null;
let modePanelWidth = parseInt(localStorage.getItem('kanboard_modePanelWidth'), 10) || null;
let modePanelShowModeSwitcher = false;

function setCalendarMode(mode) {
  if (calendarMode === mode) return;
  calendarMode = mode;
  localStorage.setItem('kanboard_calendarMode', mode);
  modePanelShowModeSwitcher = false;
  renderModeToggle();
  renderCalendar();
  renderModePanel();
}

function onDayClick(iso) {
  modePanelShowModeSwitcher = false;
  if (calendarMode === 'plan' && planSubMode === 'schedule') {
    if (schedulePicks) return; // already past day-selection -- Clear/Back first
    if (scheduleSelectedDates.has(iso)) scheduleSelectedDates.delete(iso);
    else scheduleSelectedDates.add(iso);
    renderCalendar();
    renderModePanel();
    return;
  }
  selectedIso = selectedIso === iso ? null : iso;
  renderCalendar();
  renderModePanel();
}

function setPlanSubMode(mode) {
  if (planSubMode === mode) return;
  planSubMode = mode;
  localStorage.setItem('kanboard_planSubMode', mode);
  scheduleSelectedDates = new Set();
  schedulePicks = null;
  selectedIso = null;
  renderCalendar();
  renderModePanel();
}

// Resets whichever submode's in-progress state exists, but -- unlike an
// earlier version of this -- never forces a submode switch: both Quick
// Add and Schedule now keep their panel open (idle) when there's nothing
// selected, same as Mealie's equivalent, so closing one no longer needs
// to borrow the other's "nothing to show" state just to disappear.
function closePanel() {
  selectedIso = null;
  scheduleSelectedDates = new Set();
  schedulePicks = null;
  modePanelShowModeSwitcher = false;
  renderCalendar();
  renderModePanel();
}

// Shown in Plan's panel (Quick Add sub-mode) before a day's clicked --
// it still has to render something, since the panel stays visible the
// whole time Plan mode is active now.
function planIdleBodyHtml() {
  return `<p style="color:var(--color-text-dim); font-size:14px; margin:0;">Click a day to add a task or event.</p>`;
}

// ---------- Today's tasks ----------

function renderDailyTasks() {
  const el = document.getElementById('kb-daily-tasks-panel');
  if (!el) return;
  const todayIso = isoOf(new Date());
  const tasks = plannedMap[todayIso] || [];
  const todayLabel = new Date().toLocaleDateString('default', { weekday: 'long', month: 'short', day: 'numeric' });
  if (tasks.length === 0) {
    el.innerHTML = `
      <div class="meal-of-day">
        <h3>Today &mdash; ${todayLabel}</h3>
        <div class="meal-empty">Nothing planned for today.</div>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="meal-of-day">
      <h3>Today &mdash; ${todayLabel}</h3>
      ${tasks.map(t => `
        <div class="meal-name" style="font-size:16px; ${t.done ? 'text-decoration:line-through; color:var(--color-text-muted);' : ''}">
          ${escapeHtml(t.title)}${t.assignee ? ` <span style="font-size:12px; color:var(--color-text-muted); font-weight:normal;">(${escapeHtml(t.assignee)})</span>` : ''}
          ${timeRangeLabel(t) ? ` <span style="font-size:12px; color:var(--color-text-muted); font-weight:normal;">&middot; ${timeRangeLabel(t)}</span>` : ''}
        </div>
      `).join('')}
    </div>`;
}

// ---------- Calendar ----------

async function loadMonthTasks() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startWeekday);
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridEnd.getDate() + 41);

  try {
    const res = await fetch(`/data/kanboard-range-tasks?start=${isoOf(gridStart)}&end=${isoOf(gridEnd)}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    plannedMap = data.days || {};
  } catch (err) {
    console.error('Failed to load tasks', err);
    plannedMap = {};
  }

  holidaysByDate = {};
  if (shouldShowHolidays('kanboard')) {
    try {
      const res = await fetch(`/data/holidays?start=${isoOf(gridStart)}&end=${isoOf(gridEnd)}`);
      const data = await res.json();
      (data.holidays || []).forEach(h => { holidaysByDate[h.date] = h.name; });
    } catch (err) {
      console.error('Failed to load holidays', err);
    }
  }

  renderCalendar();
  renderDailyTasks();
  renderModePanel();
}

async function loadPeople() {
  try {
    const res = await fetch('/data/kanboard-people');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    allPeople = data.people || [];
  } catch (err) {
    console.error('Failed to load people', err);
    allPeople = [];
  }
}

function changeMonth(delta) {
  calendarMonth.setMonth(calendarMonth.getMonth() + delta);
  const container = document.getElementById('kb-calendar-container');
  if (container) container.innerHTML = '<div class="cal-loading">Loading calendar...</div>';
  loadMonthTasks();
}

function renderModeToggle() {
  const el = document.getElementById('kb-mode-toggle');
  if (!el) return;
  el.innerHTML = `
    <button data-kb-mode="plan" class="${calendarMode === 'plan' ? 'active' : ''}">Plan</button>
    <button data-kb-mode="view" class="${calendarMode === 'view' ? 'active' : ''}">View</button>
    <button data-kb-mode="edit" class="${calendarMode === 'edit' ? 'active' : ''}">Edit</button>
  `;
}

function renderCalendar() {
  const container = document.getElementById('kb-calendar-container');
  if (!container) return;
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startWeekday);
  const todayIso = isoOf(new Date());

  let html = `
    <div class="cal-header">
      <div class="cal-header-left">
        <button class="btn small" data-action="kb-prev-month">&larr;</button>
        <h3>${firstOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</h3>
        <button class="btn small" data-action="kb-next-month">&rarr;</button>
      </div>
      ${renderSettingsGearHtml('kanboard')}
    </div>
    <div class="cal-grid">
      ${['S','M','T','W','T','F','S'].map(d => `<div class="cal-weekday">${d}</div>`).join('')}
  `;

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    const iso = isoOf(d);
    const inMonth = d.getMonth() === month;
    const tasks = plannedMap[iso] || [];
    const holiday = holidaysByDate[iso];
    let cls = 'cal-day';
    if (!inMonth) cls += ' other-month';
    if (iso === todayIso) cls += ' today';
    if (tasks.length > 0) cls += ' planned';
    if (iso === selectedIso) cls += ' kb-selected';
    if (calendarMode === 'plan' && planSubMode === 'schedule' && scheduleSelectedDates.has(iso)) cls += ' kb-selected';
    html += `
      <div class="${cls}" data-iso="${iso}">
        <div class="cal-daynum">${d.getDate()}</div>
        ${holiday ? `<div class="cal-holiday" title="${escapeHtml(holiday)}">${escapeHtml(holiday)}</div>` : ''}
        ${tasks.length > 0 ? `<div class="cal-meal${tasks[0].type === 'event' ? ' cal-event' : ''}">${tasks[0].type === 'event' ? '&#x1F389; ' : ''}${escapeHtml(tasks[0].title)}</div>` : ''}
        ${tasks.length > 1 ? `<div class="cal-meal-extra">+${tasks.length - 1} more</div>` : ''}
      </div>
    `;
  }
  html += `</div>`;
  container.innerHTML = html;
}

// ---------- Floating mode panel (Plan / View / Edit) ----------
//
// Byte-for-byte the same shell shape as Mealie's #mode-panel (badge,
// drag-resize handle, close button, persisted size) -- see css/
// dashboard.css's "#mode-panel, #kb-mode-panel" rules -- so the two tabs'
// panels genuinely look and behave the same, not just similar.

function renderModePanel() {
  const el = document.getElementById('kb-mode-panel');
  if (!el) return;

  // Plan's panel stays visible even with nothing selected yet (unlike
  // View/Edit below), so the Quick Add/Schedule toggle in its header
  // row is always reachable -- it belongs here, not on the calendar
  // itself, since it only ever matters while planning. Mirrors mealie.js's
  // identical change to its own #mode-panel.
  const scheduling = calendarMode === 'plan' && planSubMode === 'schedule';
  if (scheduling) snapshotScheduleFromDom(); // keep what's typed across the redraw
  const visible = calendarMode === 'plan' || !!selectedIso;
  if (!visible) {
    el.classList.remove('show');
    el.innerHTML = '';
    modePanelShowModeSwitcher = false;
    reserveSpaceForModePanel();
    return;
  }

  const contentHtml = scheduling ? scheduleFormHtml()
    : calendarMode === 'plan' ? (selectedIso ? planFormHtml(selectedIso) : planIdleBodyHtml())
    : calendarMode === 'view' ? viewListHtml(selectedIso)
    : editListHtml(selectedIso);

  const badgeHtml = modePanelShowModeSwitcher
    ? `
      <div class="mode-toggle mode-panel-mode-switch">
        <button data-kb-mode="plan" class="${calendarMode === 'plan' ? 'active' : ''}">Plan</button>
        <button data-kb-mode="view" class="${calendarMode === 'view' ? 'active' : ''}">View</button>
        <button data-kb-mode="edit" class="${calendarMode === 'edit' ? 'active' : ''}">Edit</button>
      </div>`
    : `<div class="mode-panel-badge mode-${calendarMode}" data-action="kb-toggle-mode-switcher" title="Click to switch mode"><span class="mode-panel-dot"></span>${calendarMode} mode</div>`;

  const planSubmodeToggleHtml = calendarMode === 'plan' ? `
    <div class="mode-toggle mode-panel-submode-toggle">
      <button data-action="kb-plan-submode" data-submode="quick" class="${planSubMode === 'quick' ? 'active' : ''}">Quick Add</button>
      <button data-action="kb-plan-submode" data-submode="schedule" class="${planSubMode === 'schedule' ? 'active' : ''}">Schedule</button>
    </div>` : '';

  el.innerHTML = `
    <div class="mode-panel-inner" ${modePanelHeight ? `style="height:${modePanelHeight}px;"` : ''}>
      <div class="mode-panel-handle" title="Drag to resize"><span class="mode-panel-handle-curve"></span></div>
      <div class="mode-panel-top-row">${badgeHtml}${planSubmodeToggleHtml}</div>
      <div class="mode-panel-body">${contentHtml}</div>
      <button class="vdf-close" data-action="kb-panel-close" title="Close">&#x2716;</button>
    </div>`;
  el.classList.add('show');
  el.style.width = modePanelWidth ? `${modePanelWidth}px` : '';
  reserveSpaceForModePanel();
}

// The panel is position:fixed over the bottom of the screen, so without
// this it sat on top of the calendar's lower weeks with no way to scroll
// past it -- Schedule's day-picking couldn't reach the days it covered.
// Pads the calendar by the panel's live height (ResizeObserver also
// catches drag-resizes and content changes) so every day can be scrolled
// into view above it. The padding lives on the calendar container, so it
// disappears with the view itself when leaving Kanboard.
let modePanelSpacer = null;
function reserveSpaceForModePanel() {
  const el = document.getElementById('kb-mode-panel');
  const container = document.getElementById('kb-calendar-container');
  if (!el || !container) return;
  const apply = () => {
    container.style.paddingBottom = el.classList.contains('show') ? `${el.offsetHeight + 24}px` : '';
  };
  if (!modePanelSpacer || modePanelSpacer.el !== el) {
    modePanelSpacer?.observer.disconnect();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    modePanelSpacer = { el, observer };
  }
  apply();
}

function startModePanelResize(e) {
  e.preventDefault();
  const panelEl = document.getElementById('kb-mode-panel');
  const inner = panelEl && panelEl.querySelector('.mode-panel-inner');
  if (!panelEl || !inner) return;

  const point = e.touches ? e.touches[0] : e;
  const startX = point.clientX;
  const startY = point.clientY;
  const startWidth = panelEl.getBoundingClientRect().width;
  const startHeight = inner.getBoundingClientRect().height;
  const minWidth = 320;
  const maxWidth = window.innerWidth - 32;
  const minHeight = 160;
  const maxHeight = window.innerHeight * (window.innerWidth <= 600 ? 0.9 : 0.7);

  function onMove(ev) {
    const p = ev.touches ? ev.touches[0] : ev;
    const dx = p.clientX - startX;
    const dy = startY - p.clientY;
    const newWidth = Math.round(Math.max(minWidth, Math.min(maxWidth, startWidth + dx * 2)));
    const newHeight = Math.round(Math.max(minHeight, Math.min(maxHeight, startHeight + dy)));
    panelEl.style.width = newWidth + 'px';
    inner.style.height = newHeight + 'px';
    modePanelWidth = newWidth;
    modePanelHeight = newHeight;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    if (modePanelWidth) localStorage.setItem('kanboard_modePanelWidth', String(modePanelWidth));
    if (modePanelHeight) localStorage.setItem('kanboard_modePanelHeight', String(modePanelHeight));
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

function assigneeComboHtml(comboKey, value) {
  return `
    <div class="combo-wrap">
      <input
        type="text"
        id="kb-assignee-input-${comboKey}"
        class="recipe-combo person-combo"
        data-combo-key="${comboKey}"
        autocomplete="off"
        placeholder="Assigned to (optional)"
        value="${escapeHtml(value || '')}"
      >
      <div class="combo-dropdown" id="kb-assignee-dropdown-${comboKey}" style="display:none;"></div>
    </div>
  `;
}

// Mirrors mealie.js's dayLabel() exactly -- same local-time-safe
// parsing (Date(y, m-1, d), not new Date(iso) which parses as UTC
// midnight and can roll back a day in any timezone behind UTC), same
// "weekday, month day" shorthand, for the same reason: reading several
// selected days at once as bare ISO strings is harder than it needs
// to be, and the project's own precedent already solved this once.
function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' });
}

function scheduleFormHtml() {
  // One shared saved-items list, owned by calendar-settings.js (the gear
  // popover that manages them) -- a separate copy here used to go stale.
  const savedList = getChoreBuckets();
  if (savedList === null) {
    loadCalendarSettingsData().then(() => renderModePanel());
    return `<h3 style="margin-top:0;">Schedule</h3><p style="color:var(--color-text-muted); font-size:13px;">Loading...</p>`;
  }

  if (!schedulePicks) {
    const dates = [...scheduleSelectedDates].sort();
    return `
      <h3 style="margin-top:0;">Schedule</h3>
      <p style="color:var(--color-text-muted); font-size:13px;">Click days on the calendar to select them, then add a task or event to each.</p>
      ${dates.length > 0 ? `
        <ul style="margin:0 0 12px; padding-left:18px; font-size:13px; color:var(--color-text-dim);">
          ${dates.map(d => `<li>${dayLabel(d)}</li>`).join('')}
        </ul>
      ` : `<p class="meal-empty">No days selected yet.</p>`}
      <div class="btn-stack" style="margin-top:12px;">
        ${dates.length > 0 ? `<button class="btn save" data-action="kb-schedule-build">Schedule ${dates.length} Day${dates.length > 1 ? 's' : ''}</button>` : ''}
        ${dates.length > 0 ? `<button class="btn clear" data-action="kb-schedule-clear-selection">Clear Selection</button>` : ''}
      </div>
    `;
  }

  const dates = Object.keys(schedulePicks).sort();
  return `
    <h3 style="margin-top:0;">Schedule</h3>
    <p style="color:var(--color-text-muted); font-size:13px;">Type a name for each day, or pick one you've saved. Leave a day blank to skip it.</p>
    ${dates.map(d => scheduleRowHtml(d, schedulePicks[d])).join('')}
    <div class="btn-stack" style="margin-top:12px;">
      <button class="btn save" data-action="kb-schedule-confirm">Confirm &amp; Create</button>
      <button class="btn cancel" data-action="kb-schedule-back">Back</button>
    </div>
  `;
}

const timeInputStyle = 'background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:6px; border-radius:4px;';

// One day's row: name (typed, or picked from saved items), Task/Event,
// "Save for next time" (only shown for a name that isn't saved yet),
// assignee, and times. Rendered from schedulePicks[d], which
// snapshotScheduleFromDom() keeps current, so a full panel re-render
// (e.g. a saved item added from the gear mid-schedule) doesn't wipe what
// was already typed on other days.
function scheduleRowHtml(d, pick) {
  const isSaved = !!findSavedItemByName(pick.name);
  return `
    <div class="preview-row kb-sched-row" style="flex-wrap:wrap;">
      <span class="date">${dayLabel(d)}</span>
      ${savedComboHtml(`sched-${d}`, pick.name, {
        typeName: `kb-sched-type-${d}`, startId: `kb-schedule-start-${d}`,
        dueId: `kb-schedule-due-${d}`, saveId: `kb-sched-save-wrap-${d}`,
        placeholder: 'Task or event (blank = skip)',
      })}
      <span class="kb-type-pick">
        <label><input type="radio" name="kb-sched-type-${d}" value="task" ${pick.type !== 'event' ? 'checked' : ''}> Task</label>
        <label><input type="radio" name="kb-sched-type-${d}" value="event" ${pick.type === 'event' ? 'checked' : ''}> Event</label>
      </span>
      <label id="kb-sched-save-wrap-${d}" class="kb-save-next" ${!pick.name.trim() || isSaved ? 'hidden' : ''}>
        <input type="checkbox" id="kb-sched-save-${d}" ${pick.save ? 'checked' : ''}> Save for next time
      </label>
      ${assigneeComboHtml(`sched-${d}`, pick.assignee)}
      <label style="font-size:12px; color:var(--color-text-muted);">From <input type="time" id="kb-schedule-start-${d}" value="${escapeHtml(pick.startTime)}" style="${timeInputStyle}"></label>
      <label style="font-size:12px; color:var(--color-text-muted);">Until <input type="time" id="kb-schedule-due-${d}" value="${escapeHtml(pick.dueTime)}" style="${timeInputStyle}"></label>
    </div>
  `;
}

function emptyPick() {
  return { name: '', type: 'task', save: true, assignee: '', startTime: '', dueTime: '' };
}

// Copies whatever's typed in the schedule rows back into schedulePicks.
// Called before any re-render and before confirming.
function snapshotScheduleFromDom() {
  if (!schedulePicks) return;
  for (const d of Object.keys(schedulePicks)) {
    const nameEl = document.getElementById(`kb-saved-input-sched-${d}`);
    if (!nameEl) continue; // rows not on screen
    const typeEl = document.querySelector(`input[name="kb-sched-type-${d}"]:checked`);
    const saveEl = document.getElementById(`kb-sched-save-${d}`);
    schedulePicks[d] = {
      name: nameEl.value,
      type: typeEl ? typeEl.value : 'task',
      save: saveEl ? saveEl.checked : true,
      assignee: document.getElementById(`kb-assignee-input-sched-${d}`)?.value || '',
      startTime: document.getElementById(`kb-schedule-start-${d}`)?.value || '',
      dueTime: document.getElementById(`kb-schedule-due-${d}`)?.value || '',
    };
  }
}

function buildSchedule() {
  const picks = {};
  for (const d of scheduleSelectedDates) picks[d] = emptyPick();
  schedulePicks = picks;
  renderModePanel();
}

// ---------- Saved tasks & events combo (type a new name, or pick a saved
// one to fill in its type and times). Used by both Schedule's rows and
// Quick Add's name box. Saved items are the "chore buckets" stored by
// scripts/chore_buckets.py -- only the name shown to people changed. ----------

function savedItems() {
  return getChoreBuckets() || [];
}

function findSavedItemByName(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  return savedItems().find(b => b.name.trim().toLowerCase() === n) || null;
}

// opts: typeName (radio group to set), startId/dueId (time inputs to
// pre-fill), saveId (optional "Save for next time" element to show only
// for unsaved names), placeholder.
function savedComboHtml(comboKey, value, opts) {
  return `
    <div class="combo-wrap">
      <input
        type="text"
        id="kb-saved-input-${comboKey}"
        class="recipe-combo saved-combo"
        data-combo-key="${comboKey}"
        data-type-name="${opts.typeName}"
        data-start-id="${opts.startId}"
        data-due-id="${opts.dueId}"
        data-save-id="${opts.saveId || ''}"
        autocomplete="off"
        placeholder="${escapeHtml(opts.placeholder)}"
        value="${escapeHtml(value || '')}"
      >
      <div class="combo-dropdown" id="kb-saved-dropdown-${comboKey}" style="display:none;"></div>
    </div>
  `;
}

function typeTagHtml(type) {
  return type === 'event'
    ? `<span class="kb-type-tag event">&#x1F389; Event</span>`
    : `<span class="kb-type-tag">Task</span>`;
}

function renderSavedDropdownHtml(term) {
  const t = (term || '').trim();
  const tl = t.toLowerCase();
  const list = savedItems();
  const matches = tl ? list.filter(b => b.name.toLowerCase().includes(tl)) : list;
  const exact = findSavedItemByName(t);
  let html = matches.map(b =>
    `<div class="combo-item" data-saved-id="${escapeHtml(b.id)}"><span>${escapeHtml(b.name)}</span>${typeTagHtml(b.type)}</div>`
  ).join('');
  if (t && !exact) {
    html += `<div class="combo-item info">"${escapeHtml(t)}" is new -- pick Task or Event</div>`;
  } else if (!list.length) {
    html = `<div class="combo-item info">Nothing saved yet -- type a name</div>`;
  }
  return html;
}

function showSavedDropdown(inputEl) {
  const dropdown = document.getElementById(`kb-saved-dropdown-${inputEl.dataset.comboKey}`);
  if (!dropdown) return;
  dropdown.innerHTML = renderSavedDropdownHtml(inputEl.value);
  dropdown.style.display = 'block';
}

// Keeps the row in step with what's typed: an exact saved name sets its
// type and hides "Save for next time"; a new name shows it.
function syncSavedMatch(inputEl) {
  const match = findSavedItemByName(inputEl.value);
  if (match) {
    const radio = document.querySelector(`input[name="${inputEl.dataset.typeName}"][value="${match.type === 'event' ? 'event' : 'task'}"]`);
    if (radio) radio.checked = true;
  }
  const saveEl = inputEl.dataset.saveId && document.getElementById(inputEl.dataset.saveId);
  if (saveEl) saveEl.hidden = !inputEl.value.trim() || !!match;
}

function selectSavedItem(comboKey, savedId, dropdown) {
  const inputEl = document.getElementById(`kb-saved-input-${comboKey}`);
  const item = savedItems().find(b => b.id === savedId);
  dropdown.style.display = 'none';
  if (!inputEl || !item) return;
  inputEl.value = item.name;
  // Saved times only fill empty boxes -- never overwrite a time already typed.
  const startEl = document.getElementById(inputEl.dataset.startId);
  const dueEl = document.getElementById(inputEl.dataset.dueId);
  if (startEl && !startEl.value && item.startTime) startEl.value = item.startTime;
  if (dueEl && !dueEl.value && item.dueTime) dueEl.value = item.dueTime;
  syncSavedMatch(inputEl);
}

function onSavedComboBlur(comboKey) {
  setTimeout(() => {
    const dropdown = document.getElementById(`kb-saved-dropdown-${comboKey}`);
    if (dropdown) dropdown.style.display = 'none';
  }, 150);
}

function backToScheduleSelection() {
  schedulePicks = null;
  renderModePanel();
}

function clearScheduleSelection() {
  scheduleSelectedDates = new Set();
  schedulePicks = null;
  renderCalendar();
  renderModePanel();
}

async function confirmSchedule() {
  snapshotScheduleFromDom();
  const dates = Object.keys(schedulePicks || {}).filter(d => schedulePicks[d].name.trim());
  if (dates.length === 0) { showStatusModal('Type a task or event for at least one day first.', 'error'); return; }
  showStatusModal('Scheduling...', 'loading');
  try {
    const savedNow = new Set(); // a new name used on several days is saved once
    for (const d of dates) {
      const pick = schedulePicks[d];
      // Typed "brunch" for saved "Brunch"? Use the saved spelling.
      const title = findSavedItemByName(pick.name)?.name || pick.name.trim();
      const res = await fetch('/api/kanboard-create-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, date: d, startTime: pick.startTime, dueTime: pick.dueTime,
          assignee: pick.assignee.trim(), taskType: pick.type, recurrence: { type: 'single' },
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `server responded ${res.status}`);
      const key = title.toLowerCase();
      if (pick.save && !findSavedItemByName(title) && !savedNow.has(key)) {
        savedNow.add(key);
        // Saving is a convenience -- a failure here mustn't undo or block
        // the tasks that were already created.
        await fetch('/api/add-chore-bucket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: title, type: pick.type, startTime: pick.startTime, dueTime: pick.dueTime }),
        }).catch(() => {});
      }
    }
    if (savedNow.size) await loadCalendarSettingsData();
    hideStatusModal();
    scheduleSelectedDates = new Set();
    schedulePicks = null;
    await loadMonthTasks();
    await loadPeople();
    showSuccessThenClose(`Scheduled ${dates.length} day${dates.length > 1 ? 's' : ''}!`);
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function planFormHtml(iso) {
  const existing = plannedMap[iso] || [];
  const holiday = holidaysByDate[iso];
  return `
    <h3 style="margin-top:0;">Plan ${iso}</h3>
    ${holiday ? `<div class="day-holiday-badge">&#x1F389; ${escapeHtml(holiday)}</div>` : ''}
    ${existing.length > 0 ? `
      <p style="color:var(--color-text-muted); font-size:13px;">Already on this day:</p>
      <ul style="margin:0 0 12px; padding-left:18px; font-size:13px; color:var(--color-text-dim);">
        ${existing.map(t => `<li>${t.type === 'event' ? '&#x1F389; ' : ''}${t.done ? `<s>${escapeHtml(t.title)}</s>` : escapeHtml(t.title)}${t.assignee ? ` -- ${escapeHtml(t.assignee)}` : ''}</li>`).join('')}
      </ul>
    ` : ''}
    <div style="margin-bottom:10px;">
      ${savedComboHtml('plan', '', {
        typeName: 'kb-task-type', startId: 'kb-plan-start-time', dueId: 'kb-plan-due-time',
        placeholder: 'Task or event name -- or pick a saved one',
      })}
    </div>
    <div class="preview-row" style="flex-wrap:wrap;">
      <label><input type="radio" name="kb-task-type" value="task" checked> Task</label>
      <label><input type="radio" name="kb-task-type" value="event"> Event</label>
    </div>
    <div style="margin-bottom:10px;">${assigneeComboHtml('plan', '')}</div>
    <div class="preview-row" style="flex-wrap:wrap;">
      <label>From <input type="time" id="kb-plan-start-time" style="background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:6px; border-radius:4px;"></label>
      <label>Until <input type="time" id="kb-plan-due-time" style="background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:6px; border-radius:4px;"></label>
      <span style="color:var(--color-text-muted); font-size:12px;">(optional -- leave blank for no specific time)</span>
    </div>
    <div class="preview-row" style="flex-wrap:wrap;">
      <label><input type="radio" name="kb-recurrence" value="single" checked> Single day</label>
      <label><input type="radio" name="kb-recurrence" value="interval"> Every <input type="number" id="kb-interval-days" min="1" value="3" style="width:50px;" disabled> days</label>
    </div>
    <div class="preview-row" style="flex-wrap:wrap;">
      <label><input type="radio" name="kb-recurrence" value="weekly"> Weekly, same day</label>
      <label><input type="radio" name="kb-recurrence" value="weeks"> Every <input type="number" id="kb-weeks-count" min="1" max="52" value="2" style="width:50px;" disabled> weeks</label>
    </div>
    <div class="preview-row" id="kb-count-row" style="display:none;">
      <label>Create <input type="number" id="kb-occurrence-count" min="1" max="52" value="8" style="width:50px;"> occurrences</label>
    </div>
    <div class="btn-stack" style="margin-top:12px;">
      <button class="btn cancel" data-action="kb-panel-close">Cancel</button>
      <button class="btn save" data-action="kb-plan-submit">Create</button>
    </div>
  `;
}

// Renders "2:00 PM - 4:00 PM" / "From 2:00 PM" / "Until 4:00 PM" / '' from
// a task's optional startTime/dueTime ("HH:MM" 24h strings, or null/''
// when no specific time was chosen -- see docs/kanboard.md).
function timeRangeLabel(t) {
  const fmt = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const period = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  };
  if (t.startTime && t.dueTime) return `${fmt(t.startTime)} - ${fmt(t.dueTime)}`;
  if (t.startTime) return `From ${fmt(t.startTime)}`;
  if (t.dueTime) return `Until ${fmt(t.dueTime)}`;
  return '';
}

function viewListHtml(iso) {
  const tasks = plannedMap[iso] || [];
  const holiday = holidaysByDate[iso];
  return `
    <h3 style="margin-top:0;">${iso}</h3>
    ${holiday ? `<div class="day-holiday-badge">&#x1F389; ${escapeHtml(holiday)}</div>` : ''}
    ${tasks.length === 0 ? `<p class="meal-empty">No tasks this day.</p>` : tasks.map(t => `
      <div class="preview-row">
        <span class="date" style="${t.done ? 'text-decoration:line-through; color:var(--color-text-muted);' : (t.type === 'event' ? 'color:var(--color-event); font-weight:600;' : '')}">
          ${t.type === 'event' ? '&#x1F389; ' : ''}${escapeHtml(t.title)}${t.assignee ? ` <span style="color:var(--color-text-muted); font-size:12px;">(${escapeHtml(t.assignee)})</span>` : ''}
          ${timeRangeLabel(t) ? `<span style="color:var(--color-text-muted); font-size:12px;"> &middot; ${timeRangeLabel(t)}</span>` : ''}
        </span>
        <button class="btn small ${t.done ? '' : 'save'}" data-action="kb-toggle-done" data-id="${t.id}" data-done="${t.done ? '1' : '0'}">${t.done ? 'Reopen' : 'Mark Done'}</button>
      </div>
    `).join('')}
    <div class="btn-stack" style="margin-top:12px;">
      <button class="btn cancel" data-action="kb-panel-close">Close</button>
    </div>
  `;
}

function editListHtml(iso) {
  const tasks = plannedMap[iso] || [];
  const holiday = holidaysByDate[iso];
  return `
    <h3 style="margin-top:0;">Edit ${iso}</h3>
    ${holiday ? `<div class="day-holiday-badge">&#x1F389; ${escapeHtml(holiday)}</div>` : ''}
    ${tasks.length === 0 ? `<p class="meal-empty">No tasks to edit this day.</p>` : tasks.map(t => `
      <div class="preview-row" style="flex-wrap:wrap;">
        <input type="text" id="kb-edit-title-${t.id}" value="${escapeHtml(t.title)}" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        <input type="date" id="kb-edit-date-${t.id}" value="${iso}" style="background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        <label style="font-size:12px; color:var(--color-text-muted);"><input type="radio" name="kb-edit-type-${t.id}" value="task" ${t.type !== 'event' ? 'checked' : ''}> Task</label>
        <label style="font-size:12px; color:var(--color-text-muted);"><input type="radio" name="kb-edit-type-${t.id}" value="event" ${t.type === 'event' ? 'checked' : ''}> Event</label>
        <label style="font-size:12px; color:var(--color-text-muted);">From <input type="time" id="kb-edit-start-time-${t.id}" value="${t.startTime || ''}" style="background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:6px; border-radius:4px;"></label>
        <label style="font-size:12px; color:var(--color-text-muted);">Until <input type="time" id="kb-edit-due-time-${t.id}" value="${t.dueTime || ''}" style="background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:6px; border-radius:4px;"></label>
        ${assigneeComboHtml(`edit-${t.id}`, t.assignee)}
        <button class="btn small save" data-action="kb-edit-save" data-id="${t.id}">Save</button>
        <button class="icon-btn-delete" data-action="kb-delete-task" data-id="${t.id}" title="Delete this task">&#x1F5D1;</button>
      </div>
    `).join('')}
    <div class="btn-stack" style="margin-top:12px;">
      <button class="btn cancel" data-action="kb-panel-close">Close</button>
    </div>
  `;
}

// ---------- Assignee combo (type to search existing people, or type a
// new name -- the backend creates them the same way Mealie's recipe
// combo creates a new recipe on save, see get_or_create_person() in
// kanboard_client.py) ----------

function getFilteredPeople(term) {
  const t = (term || '').trim().toLowerCase();
  if (!t) return allPeople;
  return allPeople.filter(p => p.name.toLowerCase().includes(t));
}

function renderPersonDropdownHtml(term) {
  const filtered = getFilteredPeople(term);
  const t = (term || '').trim();
  if (filtered.length === 0) {
    if (!t) return `<div class="combo-item info">No one yet</div>`;
    return `<div class="combo-item info">No match &mdash; "${escapeHtml(t)}" will be added as new</div>`;
  }
  return filtered.map(p =>
    `<div class="combo-item" data-person-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`
  ).join('');
}

function onAssigneeComboFocus(comboKey, inputEl) {
  const dropdown = document.getElementById(`kb-assignee-dropdown-${comboKey}`);
  if (!dropdown) return;
  dropdown.innerHTML = renderPersonDropdownHtml(inputEl.value);
  dropdown.style.display = 'block';
}

function onAssigneeComboType(comboKey, inputEl) {
  const dropdown = document.getElementById(`kb-assignee-dropdown-${comboKey}`);
  if (!dropdown) return;
  dropdown.innerHTML = renderPersonDropdownHtml(inputEl.value);
  dropdown.style.display = 'block';
}

function selectAssigneeComboItem(comboKey, name, dropdown) {
  const inputEl = document.getElementById(`kb-assignee-input-${comboKey}`);
  if (inputEl) inputEl.value = name;
  dropdown.style.display = 'none';
}

function onAssigneeComboBlur(comboKey) {
  setTimeout(() => {
    const dropdown = document.getElementById(`kb-assignee-dropdown-${comboKey}`);
    if (dropdown) dropdown.style.display = 'none';
  }, 150);
}

// ---------- Actions ----------

async function submitPlan() {
  const titleInput = document.getElementById('kb-saved-input-plan');
  const title = titleInput ? titleInput.value.trim() : '';
  if (!title) { showStatusModal('Enter a task name first.', 'error'); return; }
  const assigneeInput = document.getElementById('kb-assignee-input-plan');
  const assignee = assigneeInput ? assigneeInput.value.trim() : '';
  const startTimeInput = document.getElementById('kb-plan-start-time');
  const dueTimeInput = document.getElementById('kb-plan-due-time');
  const startTime = startTimeInput ? startTimeInput.value : '';
  const dueTime = dueTimeInput ? dueTimeInput.value : '';
  const taskTypeInput = document.querySelector('input[name="kb-task-type"]:checked');
  const taskType = taskTypeInput ? taskTypeInput.value : 'task';
  const typeInput = document.querySelector('input[name="kb-recurrence"]:checked');
  const type = typeInput ? typeInput.value : 'single';
  const recurrence = { type };
  if (type === 'interval') {
    recurrence.days = parseInt(document.getElementById('kb-interval-days').value, 10) || 1;
    recurrence.count = parseInt(document.getElementById('kb-occurrence-count').value, 10) || 8;
  } else if (type === 'weekly') {
    recurrence.count = parseInt(document.getElementById('kb-occurrence-count').value, 10) || 8;
  } else if (type === 'weeks') {
    recurrence.weeks = parseInt(document.getElementById('kb-weeks-count').value, 10) || 2;
    recurrence.count = parseInt(document.getElementById('kb-occurrence-count').value, 10) || 8;
  }
  showStatusModal('Creating...', 'loading');
  try {
    const res = await fetch('/api/kanboard-create-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, date: selectedIso, startTime, dueTime, assignee, recurrence, taskType })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal(data.error || 'Failed to create.', 'error'); return; }
    hideStatusModal();
    closePanel();
    await loadMonthTasks();
    if (assignee) await loadPeople(); // may have just created a new person
    showSuccessThenClose('Created!');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function toggleTaskDone(taskId, currentlyDone) {
  const endpoint = currentlyDone ? '/api/kanboard-open-task' : '/api/kanboard-close-task';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal(data.error || 'Failed to update.', 'error'); return; }
    await loadMonthTasks();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function saveTaskEdit(taskId) {
  const titleInput = document.getElementById(`kb-edit-title-${taskId}`);
  const dateInput = document.getElementById(`kb-edit-date-${taskId}`);
  const startTimeInput = document.getElementById(`kb-edit-start-time-${taskId}`);
  const dueTimeInput = document.getElementById(`kb-edit-due-time-${taskId}`);
  const assigneeInput = document.getElementById(`kb-assignee-input-edit-${taskId}`);
  const taskTypeInput = document.querySelector(`input[name="kb-edit-type-${taskId}"]:checked`);
  const taskType = taskTypeInput ? taskTypeInput.value : 'task';
  const title = titleInput ? titleInput.value.trim() : '';
  const dateVal = dateInput ? dateInput.value : '';
  const startTime = startTimeInput ? startTimeInput.value : '';
  const dueTime = dueTimeInput ? dueTimeInput.value : '';
  const assignee = assigneeInput ? assigneeInput.value.trim() : '';
  if (!title) { showStatusModal('Task name cannot be empty.', 'error'); return; }
  showStatusModal('Saving...', 'loading');
  try {
    const res = await fetch('/api/kanboard-update-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, title, date: dateVal, startTime, dueTime, assignee, taskType })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal(data.error || 'Failed to save.', 'error'); return; }
    hideStatusModal();
    await loadMonthTasks();
    if (assignee) await loadPeople();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function deleteTask(taskId) {
  if (!(await showConfirmModal('Delete this task? This cannot be undone.'))) return;
  showStatusModal('Deleting...', 'loading');
  try {
    const res = await fetch('/api/kanboard-remove-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal(data.error || 'Failed to delete.', 'error'); return; }
    hideStatusModal();
    await loadMonthTasks();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

// ---------- Wiring ----------

function wireDelegatedListeners() {
  const toggle = document.getElementById('kb-mode-toggle');
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kb-mode]');
    if (btn) setCalendarMode(btn.dataset.kbMode);
  });

  const calendarContainer = document.getElementById('kb-calendar-container');
  calendarContainer.addEventListener('click', (e) => {
    if (handleCalSettingsClick(e, 'kanboard', renderCalendar, renderModePanel)) return;
    if (e.target.closest('[data-action="kb-prev-month"]')) return changeMonth(-1);
    if (e.target.closest('[data-action="kb-next-month"]')) return changeMonth(1);
    const dayEl = e.target.closest('.cal-day');
    if (dayEl) return onDayClick(dayEl.dataset.iso);
  });
  calendarContainer.addEventListener('change', (e) => {
    // loadMonthTasks(), not renderCalendar() -- both the holidays
    // checkbox and the country select change what /data/holidays should
    // return. renderCalendar() only redraws from the existing (now
    // stale) holidaysByDate, which is why toggling "Show holidays" on
    // used to show nothing until the next month change forced a refetch.
    if (handleCalSettingsChange(e, 'kanboard', loadMonthTasks)) return;
  });

  const panel = document.getElementById('kb-mode-panel');
  panel.addEventListener('mousedown', (e) => {
    if (e.target.closest('.mode-panel-handle')) startModePanelResize(e);
  });
  panel.addEventListener('touchstart', (e) => {
    if (e.target.closest('.mode-panel-handle')) startModePanelResize(e);
  }, { passive: false });
  panel.addEventListener('click', (e) => {
    const modeSwitchBtn = e.target.closest('.mode-panel-mode-switch button');
    if (modeSwitchBtn) return setCalendarMode(modeSwitchBtn.dataset.kbMode);
    const submodeBtn = e.target.closest('[data-action="kb-plan-submode"]');
    if (submodeBtn) return setPlanSubMode(submodeBtn.dataset.submode);

    const item = e.target.closest('.combo-item');
    if (item && item.dataset.savedId) {
      const dropdown = item.closest('.combo-dropdown');
      const comboKey = dropdown.id.replace('kb-saved-dropdown-', '');
      return selectSavedItem(comboKey, item.dataset.savedId, dropdown);
    }
    if (item && item.dataset.personName) {
      const dropdown = item.closest('.combo-dropdown');
      const comboKey = dropdown.id.replace('kb-assignee-dropdown-', '');
      return selectAssigneeComboItem(comboKey, item.dataset.personName, dropdown);
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case 'kb-panel-close': return closePanel();
      case 'kb-toggle-mode-switcher':
        modePanelShowModeSwitcher = !modePanelShowModeSwitcher;
        return renderModePanel();
      case 'kb-plan-submit': return submitPlan();
      case 'kb-toggle-done': return toggleTaskDone(id, btn.dataset.done === '1');
      case 'kb-edit-save': return saveTaskEdit(id);
      case 'kb-delete-task': return deleteTask(id);
      case 'kb-schedule-build': return buildSchedule();
      case 'kb-schedule-clear-selection': return clearScheduleSelection();
      case 'kb-schedule-back': return backToScheduleSelection();
      case 'kb-schedule-confirm': return confirmSchedule();
    }
  });
  // Recurrence radios: enable each option's own number input only while
  // it's selected, and only show the occurrence-count field for a
  // recurring pick.
  panel.addEventListener('change', (e) => {
    if (e.target.name !== 'kb-recurrence') return;
    const type = e.target.value;
    const intervalInput = document.getElementById('kb-interval-days');
    const weeksInput = document.getElementById('kb-weeks-count');
    const countRow = document.getElementById('kb-count-row');
    if (intervalInput) intervalInput.disabled = type !== 'interval';
    if (weeksInput) weeksInput.disabled = type !== 'weeks';
    if (countRow) countRow.style.display = type === 'single' ? 'none' : 'flex';
  });
  panel.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('person-combo')) onAssigneeComboFocus(e.target.dataset.comboKey, e.target);
    if (e.target.classList.contains('saved-combo')) showSavedDropdown(e.target);
  });
  panel.addEventListener('input', (e) => {
    if (e.target.classList.contains('person-combo')) onAssigneeComboType(e.target.dataset.comboKey, e.target);
    if (e.target.classList.contains('saved-combo')) {
      showSavedDropdown(e.target);
      syncSavedMatch(e.target);
    }
  });
  panel.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('person-combo')) onAssigneeComboBlur(e.target.dataset.comboKey);
    if (e.target.classList.contains('saved-combo')) onSavedComboBlur(e.target.dataset.comboKey);
  });
}

registerApp('kanboard', {
  title: '&#x2713; Kanboard',
  bodyHtml: `
    <div id="kanboard-root">
      <div id="kb-daily-tasks-panel"></div>

      <div class="week-block">
        <div class="mode-toggle" id="kb-mode-toggle"></div>
        <div id="kb-calendar-container" style="margin-top:12px;"><div class="cal-loading">Loading calendar...</div></div>
      </div>
      <div id="kb-mode-panel"></div>

      <a class="goto-btn" href="http://${HOST_IP}:3000" target="_blank">Open Kanboard &rarr;</a>
    </div>
  `,
  onRender: () => {
    wireDelegatedListeners();
    calendarMonth = new Date();
    selectedIso = null;
    modePanelShowModeSwitcher = false;
    renderModeToggle();
    loadPeople();
    loadMonthTasks();
    loadCalendarSettingsData();
  },
});
