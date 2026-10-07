// kanboard.js -- chores board: calendar (plan/view/edit) over real tasks
// on the self-hosted Kanboard instance's "Chores" project. Pre-alpha
// foundation, deliberately modeled on js/mealie.js's calendar/mode-panel
// shell -- including the same floating, drag-resizable panel (not a
// simplified inline one), so the two tabs genuinely look and behave the
// same -- but simpler where Kanboard's shape allows it:
//   - A day can have zero, several, or many chores (plannedMap[iso] is a
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
import { HOST_IP } from './config.js';

let calendarMonth = new Date();
let plannedMap = {}; // iso -> [{id, title, done, assignee}, ...]
let allPeople = []; // [{id, name}, ...] -- the "assigned to" combo's suggestions

const CALENDAR_MODES = ['plan', 'view', 'edit'];
let calendarMode = CALENDAR_MODES.includes(localStorage.getItem('kanboard_calendarMode'))
  ? localStorage.getItem('kanboard_calendarMode')
  : 'plan';
let selectedIso = null;

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
  selectedIso = selectedIso === iso ? null : iso;
  renderCalendar();
  renderModePanel();
}

function closePanel() {
  selectedIso = null;
  modePanelShowModeSwitcher = false;
  renderCalendar();
  renderModePanel();
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
    console.error('Failed to load chores', err);
    plannedMap = {};
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
    let cls = 'cal-day';
    if (!inMonth) cls += ' other-month';
    if (iso === todayIso) cls += ' today';
    if (tasks.length > 0) cls += ' planned';
    if (iso === selectedIso) cls += ' kb-selected';
    html += `
      <div class="${cls}" data-iso="${iso}">
        <div class="cal-daynum">${d.getDate()}</div>
        ${tasks.length > 0 ? `<div class="cal-meal">${escapeHtml(tasks[0].title)}</div>` : ''}
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

  if (!selectedIso) {
    el.classList.remove('show');
    el.innerHTML = '';
    modePanelShowModeSwitcher = false;
    return;
  }

  const contentHtml = calendarMode === 'plan' ? planFormHtml(selectedIso)
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

  el.innerHTML = `
    <div class="mode-panel-inner" ${modePanelHeight ? `style="height:${modePanelHeight}px;"` : ''}>
      <div class="mode-panel-handle" title="Drag to resize"><span class="mode-panel-handle-curve"></span></div>
      ${badgeHtml}
      <div class="mode-panel-body">${contentHtml}</div>
      <button class="vdf-close" data-action="kb-panel-close" title="Close">&#x2716;</button>
    </div>`;
  el.classList.add('show');
  el.style.width = modePanelWidth ? `${modePanelWidth}px` : '';
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

function planFormHtml(iso) {
  const existing = plannedMap[iso] || [];
  return `
    <h3 style="margin-top:0;">Plan ${iso}</h3>
    ${existing.length > 0 ? `
      <p style="color:var(--color-text-muted); font-size:13px;">Already on this day:</p>
      <ul style="margin:0 0 12px; padding-left:18px; font-size:13px; color:var(--color-text-dim);">
        ${existing.map(t => `<li>${t.done ? `<s>${escapeHtml(t.title)}</s>` : escapeHtml(t.title)}${t.assignee ? ` -- ${escapeHtml(t.assignee)}` : ''}</li>`).join('')}
      </ul>
    ` : ''}
    <input
      type="text"
      id="kb-plan-title"
      placeholder="Chore name"
      style="width:100%; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px; margin-bottom:10px; box-sizing:border-box;"
    >
    <div style="margin-bottom:10px;">${assigneeComboHtml('plan', '')}</div>
    <div class="preview-row" style="flex-wrap:wrap;">
      <label><input type="radio" name="kb-recurrence" value="single" checked> Single day</label>
      <label><input type="radio" name="kb-recurrence" value="interval"> Every <input type="number" id="kb-interval-days" min="1" value="3" style="width:50px;" disabled> days</label>
    </div>
    <div class="preview-row" style="flex-wrap:wrap;">
      <label><input type="radio" name="kb-recurrence" value="weekly"> Weekly, same day</label>
      <label><input type="radio" name="kb-recurrence" value="biweekly"> Every other week</label>
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

function viewListHtml(iso) {
  const tasks = plannedMap[iso] || [];
  return `
    <h3 style="margin-top:0;">${iso}</h3>
    ${tasks.length === 0 ? `<p class="meal-empty">No chores this day.</p>` : tasks.map(t => `
      <div class="preview-row">
        <span class="date" style="${t.done ? 'text-decoration:line-through; color:var(--color-text-muted);' : ''}">
          ${escapeHtml(t.title)}${t.assignee ? ` <span style="color:var(--color-text-muted); font-size:12px;">(${escapeHtml(t.assignee)})</span>` : ''}
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
  return `
    <h3 style="margin-top:0;">Edit ${iso}</h3>
    ${tasks.length === 0 ? `<p class="meal-empty">No chores to edit this day.</p>` : tasks.map(t => `
      <div class="preview-row" style="flex-wrap:wrap;">
        <input type="text" id="kb-edit-title-${t.id}" value="${escapeHtml(t.title)}" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        <input type="date" id="kb-edit-date-${t.id}" value="${iso}" style="background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        ${assigneeComboHtml(`edit-${t.id}`, t.assignee)}
        <button class="btn small save" data-action="kb-edit-save" data-id="${t.id}">Save</button>
        <button class="icon-btn-delete" data-action="kb-delete-task" data-id="${t.id}" title="Delete this chore">&#x1F5D1;</button>
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
  const titleInput = document.getElementById('kb-plan-title');
  const title = titleInput ? titleInput.value.trim() : '';
  if (!title) { showStatusModal('Enter a chore name first.', 'error'); return; }
  const assigneeInput = document.getElementById('kb-assignee-input-plan');
  const assignee = assigneeInput ? assigneeInput.value.trim() : '';
  const typeInput = document.querySelector('input[name="kb-recurrence"]:checked');
  const type = typeInput ? typeInput.value : 'single';
  const recurrence = { type };
  if (type === 'interval') {
    recurrence.days = parseInt(document.getElementById('kb-interval-days').value, 10) || 1;
    recurrence.count = parseInt(document.getElementById('kb-occurrence-count').value, 10) || 8;
  } else if (type === 'weekly' || type === 'biweekly') {
    recurrence.count = parseInt(document.getElementById('kb-occurrence-count').value, 10) || 8;
  }
  showStatusModal('Creating...', 'loading');
  try {
    const res = await fetch('/api/kanboard-create-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, date: selectedIso, assignee, recurrence })
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
  const assigneeInput = document.getElementById(`kb-assignee-input-edit-${taskId}`);
  const title = titleInput ? titleInput.value.trim() : '';
  const dateVal = dateInput ? dateInput.value : '';
  const assignee = assigneeInput ? assigneeInput.value.trim() : '';
  if (!title) { showStatusModal('Chore name cannot be empty.', 'error'); return; }
  showStatusModal('Saving...', 'loading');
  try {
    const res = await fetch('/api/kanboard-update-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, title, date: dateVal, assignee })
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
  if (!(await showConfirmModal('Delete this chore? This cannot be undone.'))) return;
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
    if (e.target.closest('[data-action="kb-prev-month"]')) return changeMonth(-1);
    if (e.target.closest('[data-action="kb-next-month"]')) return changeMonth(1);
    const dayEl = e.target.closest('.cal-day');
    if (dayEl) return onDayClick(dayEl.dataset.iso);
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

    const item = e.target.closest('.combo-item');
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
    }
  });
  // Recurrence radios: enable the "every N days" input only for that
  // option, and only show the occurrence-count field for a recurring pick.
  panel.addEventListener('change', (e) => {
    if (e.target.name !== 'kb-recurrence') return;
    const type = e.target.value;
    const intervalInput = document.getElementById('kb-interval-days');
    const countRow = document.getElementById('kb-count-row');
    if (intervalInput) intervalInput.disabled = type !== 'interval';
    if (countRow) countRow.style.display = type === 'single' ? 'none' : 'flex';
  });
  panel.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('person-combo')) onAssigneeComboFocus(e.target.dataset.comboKey, e.target);
  });
  panel.addEventListener('input', (e) => {
    if (e.target.classList.contains('person-combo')) onAssigneeComboType(e.target.dataset.comboKey, e.target);
  });
  panel.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('person-combo')) onAssigneeComboBlur(e.target.dataset.comboKey);
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
  },
});
