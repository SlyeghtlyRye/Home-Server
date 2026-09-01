// mealie.js -- meal planning: meal-of-the-day, calendar (plan/view), preview/
// reroll/commit flow, meals-of-the-week browser, and an editable shopping
// list. Uses event delegation on stable containers since their contents
// (calendar days, preview rows, dropdowns) re-render frequently.
import { registerApp, showStatusModal, hideStatusModal, showSuccessThenClose,
         showErrorBanner, clearErrorBanner, showConfirmModal, escapeHtml, isoOf } from './core.js';
import { HOST_IP } from './config.js';

let calendarMonth = new Date();
let plannedMap = {};
let weekSelection = null;
let previewPicks = null;
let previewConflicts = [];
let avoidRepeats = localStorage.getItem('mealie_avoidRepeats') !== 'false';
let allRecipes = [];

const CALENDAR_MODES = ['plan', 'view', 'edit'];
let calendarMode = CALENDAR_MODES.includes(localStorage.getItem('mealie_calendarMode')) ? localStorage.getItem('mealie_calendarMode') : 'plan';
let viewSelectedIso = null;

let editSelectedIso = null;
let editPick = null;

// Plan/View/Edit all share one floating panel docked to the bottom of the
// screen (renderModePanel below) -- which of these three is non-null/set
// decides what it shows. A user-dragged size (via the corner resize handle,
// width and/or height independently) persists across renders and modes
// until they drag it again.
let modePanelHeight = parseInt(localStorage.getItem('mealie_modePanelHeight'), 10) || null;
let modePanelWidth = parseInt(localStorage.getItem('mealie_modePanelWidth'), 10) || null;

// Clicking the mode badge inside the panel reveals the same Plan/View/Edit
// buttons as the toggle above the calendar, so modes can be switched
// without leaving the panel.
let modePanelShowModeSwitcher = false;

// View mode's "View details" link expands the recipe (ingredients/steps)
// inline in the same panel instead of opening the separate recipe modal --
// null = not shown, 'loading' while fetching, an error marker, or the
// fetched detail object.
let viewInlineRecipeState = null;

let availableWeeks = [];
let selectedWeekStart = null;
let weekMealsData = null;
const recipeDetailCache = {};

// ---------- Meal of the day ----------

function renderMealOfDay() {
  const el = document.getElementById('meal-of-day-panel');
  if (!el) return;
  const todayIso = isoOf(new Date());
  const meal = plannedMap[todayIso];
  const todayLabel = new Date().toLocaleDateString('default', { weekday: 'long', month: 'short', day: 'numeric' });
  if (!meal) {
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
      <div class="meal-name">${escapeHtml(meal.name)}</div>
      ${meal.id ? `<span class="meal-link" data-action="view-recipe" data-recipe-id="${meal.id}">See recipe &amp; details &rarr;</span>` : ''}
    </div>`;
}

// ---------- Calendar (plan / view) ----------

function changeMonth(delta) {
  calendarMonth.setMonth(calendarMonth.getMonth() + delta);
  document.getElementById('calendar-container').innerHTML = '<div class="cal-loading">Loading calendar...</div>';
  loadMonthMealplan();
}

async function loadMonthMealplan() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startWeekday);
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridEnd.getDate() + 41);

  try {
    const res = await fetch(`/data/range-mealplan?start=${isoOf(gridStart)}&end=${isoOf(gridEnd)}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    plannedMap = {};
    (data.entries || []).forEach(e => { plannedMap[e.date] = { name: e.recipe, id: e.recipeId }; });
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load month mealplan', err);
    plannedMap = {};
    showErrorBanner("Couldn't reach the server to load the calendar. Check that it's running and try again.");
  }
  renderCalendar();
  renderMealOfDay();
  renderModePanel();
  refreshShoppingPanel();
}

function renderModeToggle() {
  const el = document.getElementById('calendar-mode-toggle');
  if (!el) return;
  el.innerHTML = `
    <button data-mode="plan" class="${calendarMode === 'plan' ? 'active' : ''}">Plan</button>
    <button data-mode="view" class="${calendarMode === 'view' ? 'active' : ''}">View</button>
    <button data-mode="edit" class="${calendarMode === 'edit' ? 'active' : ''}">Edit</button>
  `;
}

function setCalendarMode(mode) {
  if (calendarMode === mode) return;
  calendarMode = mode;
  localStorage.setItem('mealie_calendarMode', mode);
  weekSelection = null;
  previewPicks = null;
  previewConflicts = [];
  viewSelectedIso = null;
  viewInlineRecipeState = null;
  editSelectedIso = null;
  editPick = null;
  modePanelShowModeSwitcher = false;
  renderModeToggle();
  renderCalendar();
  renderModePanel();
}

function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startWeekday);
  const todayIso = isoOf(new Date());

  let html = `
    <div class="cal-header">
      <div class="cal-header-left">
        <button class="btn small" data-action="prev-month">&larr;</button>
        <h3>${firstOfMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</h3>
        <button class="btn small" data-action="next-month">&rarr;</button>
      </div>
      ${weekSelection ? `<button class="btn small clear" data-action="clear-selection">Clear Selection (${Object.keys(weekSelection.days).length} days)</button>` : ''}
    </div>
    <div class="cal-grid">
      ${['S','M','T','W','T','F','S'].map(d => `<div class="cal-weekday">${d}</div>`).join('')}
  `;

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    const iso = isoOf(d);
    const inMonth = d.getMonth() === month;
    const meal = plannedMap[iso];
    let cls = 'cal-day';
    if (!inMonth) cls += ' other-month';
    if (iso === todayIso) cls += ' today';
    if (meal) cls += ' planned';
    if (weekSelection && iso in weekSelection.days) {
      cls += weekSelection.days[iso] ? ' included' : ' excluded';
    }
    if (calendarMode === 'view' && iso === viewSelectedIso) cls += ' view-selected';
    if (calendarMode === 'edit' && iso === editSelectedIso) cls += ' edit-selected';
    html += `
      <div class="${cls}" data-iso="${iso}">
        <div class="cal-daynum">${d.getDate()}</div>
        ${meal ? `<div class="cal-meal">${escapeHtml(meal.name)}</div>` : ''}
      </div>
    `;
  }
  html += `</div>`;
  document.getElementById('calendar-container').innerHTML = html;
}

// ---------- Shared floating mode panel (Plan / View / Edit) ----------
//
// All three calendar modes show their day-level UI in the same
// bottom-docked floating panel rather than each having its own inline
// block or centered modal -- which body renders is decided purely by
// which piece of state is currently set (previewPicks/weekSelection for
// Plan, viewSelectedIso for View, editPick for Edit). Closing the panel
// (the X, or its own Cancel button) always clears exactly that state.

function renderModePanel() {
  const el = document.getElementById('mode-panel');
  if (!el) return;

  let contentHtml = '';
  let visible = false;

  if (calendarMode === 'plan') {
    if (previewPicks) {
      contentHtml = previewPanelBodyHtml();
      visible = true;
    } else if (weekSelection) {
      contentHtml = actionPanelBodyHtml();
      visible = true;
    }
  } else if (calendarMode === 'view') {
    if (viewSelectedIso) {
      contentHtml = viewDayDetailBodyHtml();
      visible = true;
    }
  } else if (calendarMode === 'edit') {
    if (editPick) {
      contentHtml = editPanelBodyHtml();
      visible = true;
    }
  }

  if (!visible) {
    el.classList.remove('show');
    el.innerHTML = '';
    modePanelShowModeSwitcher = false;
    return;
  }

  const badgeHtml = modePanelShowModeSwitcher
    ? `
      <div class="mode-toggle mode-panel-mode-switch">
        <button data-mode="plan" class="${calendarMode === 'plan' ? 'active' : ''}">Plan</button>
        <button data-mode="view" class="${calendarMode === 'view' ? 'active' : ''}">View</button>
        <button data-mode="edit" class="${calendarMode === 'edit' ? 'active' : ''}">Edit</button>
      </div>`
    : `<div class="mode-panel-badge mode-${calendarMode}" data-action="toggle-mode-switcher" title="Click to switch mode"><span class="mode-panel-dot"></span>${calendarMode} mode</div>`;

  el.innerHTML = `
    <div class="mode-panel-inner" ${modePanelHeight ? `style="height:${modePanelHeight}px;"` : ''}>
      <div class="mode-panel-handle" title="Drag to resize"><span class="mode-panel-handle-curve"></span></div>
      ${badgeHtml}
      <div class="mode-panel-body">${contentHtml}</div>
      <button class="vdf-close" data-action="close-mode-panel" title="Close">&#x2716;</button>
    </div>`;
  el.classList.add('show');
  el.style.width = modePanelWidth ? `${modePanelWidth}px` : '';
}

function closeModePanel() {
  if (calendarMode === 'view') {
    closeViewDayDetail();
  } else if (calendarMode === 'edit') {
    closeEditPanel();
  } else if (calendarMode === 'plan') {
    if (previewPicks) cancelPreview();
    else if (weekSelection) clearSelection();
  }
}

function startModePanelResize(e) {
  e.preventDefault();
  const panelEl = document.getElementById('mode-panel');
  const inner = panelEl && panelEl.querySelector('.mode-panel-inner');
  if (!panelEl || !inner) return;

  const point = e.touches ? e.touches[0] : e;
  const startX = point.clientX;
  const startY = point.clientY;
  const startWidth = panelEl.getBoundingClientRect().width;
  const startHeight = inner.getBoundingClientRect().height;
  const minWidth = 320;
  const maxWidth = window.innerWidth - 32; // matches #mode-panel's CSS width cap: calc(100% - 32px)
  const minHeight = 160; // matches .mode-panel-inner's CSS min-height -- lower would be a no-op dead zone
  const maxHeight = window.innerHeight * 0.7; // matches .mode-panel-inner's CSS max-height: 70vh

  function onMove(ev) {
    const p = ev.touches ? ev.touches[0] : ev;
    const dx = p.clientX - startX;
    const dy = startY - p.clientY;
    // The panel stays horizontally centered (left:50% + transform), so
    // growing its width by 2*dx moves the right edge -- where the handle
    // sits -- by exactly dx, tracking the cursor while both sides expand
    // symmetrically. A pure vertical or horizontal drag only moves the
    // matching dimension, so the handle supports any direction fluidly.
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
    if (modePanelWidth) localStorage.setItem('mealie_modePanelWidth', String(modePanelWidth));
    if (modePanelHeight) localStorage.setItem('mealie_modePanelHeight', String(modePanelHeight));
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

// ---------- View mode body ----------

function viewDayDetailBodyHtml() {
  const meal = plannedMap[viewSelectedIso];
  if (!meal) {
    return `<div class="vd-date">${viewSelectedIso}</div><div class="meal-empty">No meal planned this day.</div>`;
  }
  let detailHtml = '';
  if (viewInlineRecipeState === 'loading') {
    detailHtml = '<div class="recipe-loading">Loading recipe...</div>';
  } else if (viewInlineRecipeState === 'error') {
    detailHtml = '<p class="meal-empty">Couldn\'t load recipe details.</p>';
  } else if (viewInlineRecipeState) {
    detailHtml = renderRecipeDetailHtml(viewInlineRecipeState);
  }
  return `
    <div class="vd-date">${viewSelectedIso}</div>
    <div class="vd-meal">${escapeHtml(meal.name)}</div>
    ${meal.id && !viewInlineRecipeState ? `<span class="meal-link" data-action="view-recipe-inline" data-recipe-id="${meal.id}">View details &rarr;</span>` : ''}
    ${detailHtml}
  `;
}

async function showViewRecipeDetailInline(recipeId) {
  viewInlineRecipeState = 'loading';
  renderModePanel();
  try {
    viewInlineRecipeState = await fetchRecipeDetail(recipeId);
  } catch (err) {
    viewInlineRecipeState = 'error';
  }
  renderModePanel();
}

function closeViewDayDetail() {
  viewSelectedIso = null;
  viewInlineRecipeState = null;
  renderCalendar();
  renderModePanel();
}

// ---------- Edit mode (single-day change / swap) ----------

function onEditDayClick(iso) {
  editSelectedIso = iso;
  const current = plannedMap[iso];
  editPick = current
    ? { date: iso, recipeId: current.id, recipeName: current.name, isNew: false }
    : { date: iso, recipeId: null, recipeName: '', isNew: false };
  renderCalendar();
  renderModePanel();
}

function closeEditPanel() {
  editSelectedIso = null;
  editPick = null;
  renderCalendar();
  renderModePanel();
}

function editPanelBodyHtml() {
  return `
    <h3 style="margin-top:0;">Edit ${editPick.date}</h3>
    <div class="preview-row">
      <div class="combo-wrap">
        <input
          id="edit-input"
          class="recipe-combo ${editPick.isNew ? 'is-new' : ''}"
          type="text"
          autocomplete="off"
          value="${escapeHtml(editPick.recipeName)}"
          placeholder="Search recipes..."
        >
        <div class="combo-dropdown" id="edit-dropdown" style="display:none;"></div>
        <div class="new-hint ${editPick.isNew ? 'show' : ''}" id="edit-hint">Will be created as a new recipe on save</div>
      </div>
      <button class="btn small" data-action="edit-reroll">Reroll</button>
    </div>
    <div class="btn-grid" style="margin-top:12px;">
      <button class="btn" data-action="edit-save">Save</button>
      <button class="btn clear" data-action="edit-cancel">Cancel</button>
    </div>
    <div class="edit-swap-row">
      <label for="edit-swap-target">Swap with another day:</label>
      <input type="date" id="edit-swap-target">
      <button class="btn small" data-action="edit-swap">Swap</button>
    </div>
  `;
}

async function doEditSwap() {
  const targetInput = document.getElementById('edit-swap-target');
  const targetDate = targetInput && targetInput.value;
  if (!targetDate) { showStatusModal('Pick a day to swap with first.', 'error'); return; }
  if (targetDate === editSelectedIso) { showStatusModal('Pick a different day to swap with.', 'error'); return; }
  const dateA = editSelectedIso;
  const mealA = plannedMap[dateA];
  const mealB = plannedMap[targetDate];
  if (!mealA && !mealB) {
    showStatusModal('Both days are empty -- nothing to swap.', 'error');
    return;
  }
  const labelA = mealA ? mealA.name : '(empty)';
  const labelB = mealB ? mealB.name : '(empty)';
  if (!(await showConfirmModal(`Swap meals between ${dateA} (${labelA}) and ${targetDate} (${labelB})?`))) return;
  showStatusModal('Swapping...', 'loading');
  try {
    const res = await fetch('/api/swap-days', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateA, dateB: targetDate })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Swap failed: ' + (data.error || res.status), 'error'); return; }
    closeEditPanel();
    await loadMonthMealplan();
    await loadAvailableWeeks();
    showSuccessThenClose('Swapped!');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function onEditComboFocus(inputEl) {
  const dropdown = document.getElementById('edit-dropdown');
  if (!dropdown) return;
  dropdown.innerHTML = renderComboDropdownHtml(inputEl.value);
  dropdown.style.display = 'block';
}

function onEditComboType(inputEl) {
  const typedValue = inputEl.value;
  const hint = document.getElementById('edit-hint');
  const match = allRecipes.find(r => r.name.toLowerCase() === typedValue.trim().toLowerCase());
  if (match) {
    editPick.recipeId = match.id;
    editPick.recipeName = match.name;
    editPick.isNew = false;
    inputEl.classList.remove('is-new');
    if (hint) hint.classList.remove('show');
  } else {
    editPick.recipeId = null;
    editPick.recipeName = typedValue.trim();
    editPick.isNew = true;
    inputEl.classList.add('is-new');
    if (hint) hint.classList.toggle('show', typedValue.trim().length > 0);
  }
  const dropdown = document.getElementById('edit-dropdown');
  if (dropdown) {
    dropdown.innerHTML = renderComboDropdownHtml(typedValue);
    dropdown.style.display = 'block';
  }
}

function selectEditComboItem(recipeId, dropdown) {
  const recipe = allRecipes.find(r => r.id === recipeId);
  if (!recipe || !editPick) return;
  editPick.recipeId = recipe.id;
  editPick.recipeName = recipe.name;
  editPick.isNew = false;
  const inputEl = document.getElementById('edit-input');
  if (inputEl) {
    inputEl.value = recipe.name;
    inputEl.classList.remove('is-new');
  }
  const hint = document.getElementById('edit-hint');
  if (hint) hint.classList.remove('show');
  dropdown.style.display = 'none';
}

function onEditComboBlur() {
  setTimeout(() => {
    const dropdown = document.getElementById('edit-dropdown');
    if (dropdown) dropdown.style.display = 'none';
  }, 150);
}

async function editReroll() {
  const excludeIds = editPick.recipeId ? [editPick.recipeId] : [];
  try {
    const res = await fetch('/api/reroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: editSelectedIso, avoidRepeats, excludeIds })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Reroll failed: ' + (data.error || res.status), 'error'); return; }
    editPick.recipeId = data.pick.recipeId;
    editPick.recipeName = data.pick.recipeName;
    editPick.isNew = false;
    renderModePanel();
  } catch (err) {
    showStatusModal('Reroll error: ' + err, 'error');
  }
}

async function saveEditPick() {
  if (!editPick.recipeId && !(editPick.isNew && editPick.recipeName.trim())) {
    showStatusModal('Pick a recipe first.', 'error');
    return;
  }
  if (!(await showConfirmModal(`Save "${editPick.recipeName}" for ${editSelectedIso}?`))) return;
  showStatusModal('Preparing recipe...', 'loading');
  try {
    await resolveNewRecipes([editPick]);
  } catch (err) {
    showStatusModal(err.message, 'error');
    return;
  }
  showStatusModal('Saving meal plan and updating shopping list...', 'loading');
  try {
    const res = await fetch('/api/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ picks: [editPick] })
    });
    if (!res.ok) { showStatusModal('Failed to start save.', 'error'); return; }
    await pollUntilDone();
    closeEditPanel();
    await loadMonthMealplan();
    await loadAvailableWeeks();
    showSuccessThenClose('Saved!');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function onDayClick(iso) {
  modePanelShowModeSwitcher = false;
  if (calendarMode === 'view') {
    viewSelectedIso = (viewSelectedIso === iso) ? null : iso;
    viewInlineRecipeState = null;
    renderCalendar();
    renderModePanel();
    return;
  }
  if (calendarMode === 'edit') {
    return onEditDayClick(iso);
  }
  if (!weekSelection) {
    const start = new Date(iso + 'T00:00:00');
    const days = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      days[isoOf(d)] = true;
    }
    weekSelection = { days };
  } else if (!(iso in weekSelection.days)) {
    const start = new Date(iso + 'T00:00:00');
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const key = isoOf(d);
      if (!(key in weekSelection.days)) {
        weekSelection.days[key] = true;
      }
    }
  } else {
    weekSelection.days[iso] = !weekSelection.days[iso];
  }
  previewPicks = null;
  renderCalendar();
  renderModePanel();
  refreshShoppingPanel();
}

function clearSelection() {
  weekSelection = null;
  previewPicks = null;
  renderCalendar();
  renderModePanel();
  refreshShoppingPanel();
}

function excludeAllFridays() {
  if (!weekSelection) return;
  Object.keys(weekSelection.days).forEach(iso => {
    const d = new Date(iso + 'T00:00:00');
    if (d.getDay() === 5) {
      weekSelection.days[iso] = false;
    }
  });
  previewPicks = null;
  renderCalendar();
  renderModePanel();
  refreshShoppingPanel();
}

function includedDates() {
  if (!weekSelection) return [];
  return Object.keys(weekSelection.days).filter(d => weekSelection.days[d]).sort();
}

function toggleAvoidRepeats(checked) {
  avoidRepeats = checked;
  localStorage.setItem('mealie_avoidRepeats', checked ? 'true' : 'false');
}

function actionPanelBodyHtml() {
  const included = includedDates();
  const totalSelected = Object.keys(weekSelection.days).length;
  return `
    <h3 style="margin-top:0;">Selected Days</h3>
    <p style="color:var(--color-text-dim); font-size:14px;">
      Click an empty day to add another 7-day block onto your selection. Click a selected day again to include/exclude it.
      ${included.length} of ${totalSelected} selected day(s) will be planned.
    </p>
    <label class="check-row">
      <input type="checkbox" id="avoid-repeats-check" ${avoidRepeats ? 'checked' : ''}>
      Avoid recipes used in the last week
    </label>
    <div class="btn-grid">
      <button class="btn small" data-action="exclude-fridays">Exclude All Fridays</button>
    </div>
    <div class="btn-grid">
      <button class="btn" data-action="plan-selected">Plan Selected Days</button>
      <button class="btn clear" data-action="clear-selected-days">Clear Selected Days</button>
      <button class="btn" data-action="cancel-selection">Cancel Selection</button>
    </div>
  `;
}

async function loadRecipes() {
  try {
    const res = await fetch('/data/recipes');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    allRecipes = data.recipes || [];
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load recipes', err);
    allRecipes = [];
    showErrorBanner("Couldn't load your recipe list from the server. Check that it's running and try again.");
  }
}

async function planSelected() {
  const dates = includedDates();
  if (dates.length === 0) { showStatusModal('Select at least one day first.', 'error'); return; }

  const conflicts = dates.filter(d => plannedMap[d]);
  if (conflicts.length > 0) {
    const list = conflicts.map(d => `${d} (${plannedMap[d].name})`).join('\n');
    const proceed = await showConfirmModal(
      `${conflicts.length} of your selected day(s) already have a meal planned:\n\n${list}\n\nContinuing will replace them. Proceed?`
    );
    if (!proceed) return;
  }

  showStatusModal('Building preview...', 'loading');
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dates, avoidRepeats })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Failed: ' + (data.error || res.status), 'error'); return; }
    previewPicks = data.picks;
    previewConflicts = conflicts;
    hideStatusModal();
    renderModePanel();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function removePreviewDay(dateStr) {
  if (!previewPicks) return;
  previewPicks = previewPicks.filter(p => p.date !== dateStr);
  if (previewPicks.length === 0) {
    previewPicks = null;
  }
  renderModePanel();
}

function clearPreviewDay(dateStr) {
  if (!previewPicks) return;
  const entry = previewPicks.find(p => p.date === dateStr);
  if (!entry) return;
  entry.recipeId = null;
  entry.recipeName = '';
  entry.isNew = false;
  renderModePanel();
}

function getFilteredRecipes(term) {
  const t = (term || '').trim().toLowerCase();
  if (!t) return allRecipes;
  return allRecipes.filter(r => r.name.toLowerCase().includes(t));
}

function renderComboDropdownHtml(term) {
  const filtered = getFilteredRecipes(term);
  const t = (term || '').trim();
  if (filtered.length === 0) {
    if (!t) return `<div class="combo-item info">No recipes yet</div>`;
    return `<div class="combo-item info">No match &mdash; "${escapeHtml(t)}" will be created as new on save</div>`;
  }
  return filtered.map(r =>
    `<div class="combo-item" data-recipe-id="${r.id}">${escapeHtml(r.name)}</div>`
  ).join('');
}

function onComboFocus(dateStr, inputEl) {
  const dropdown = document.getElementById('dropdown-' + dateStr);
  if (!dropdown) return;
  dropdown.innerHTML = renderComboDropdownHtml(inputEl.value);
  dropdown.style.display = 'block';
}

function onComboType(dateStr, inputEl) {
  const typedValue = inputEl.value;
  const entry = previewPicks.find(p => p.date === dateStr);
  const hint = document.getElementById('hint-' + dateStr);
  if (entry) {
    const match = allRecipes.find(r => r.name.toLowerCase() === typedValue.trim().toLowerCase());
    if (match) {
      entry.recipeId = match.id;
      entry.recipeName = match.name;
      entry.isNew = false;
      inputEl.classList.remove('is-new');
      if (hint) hint.classList.remove('show');
    } else {
      entry.recipeId = null;
      entry.recipeName = typedValue.trim();
      entry.isNew = true;
      inputEl.classList.add('is-new');
      if (hint) hint.classList.toggle('show', typedValue.trim().length > 0);
    }
  }
  const dropdown = document.getElementById('dropdown-' + dateStr);
  if (dropdown) {
    dropdown.innerHTML = renderComboDropdownHtml(typedValue);
    dropdown.style.display = 'block';
  }
}

function selectComboItem(recipeId, dropdown) {
  const dateStr = dropdown.id.replace('dropdown-', '');
  const recipe = allRecipes.find(r => r.id === recipeId);
  const entry = previewPicks.find(p => p.date === dateStr);
  if (!recipe || !entry) return;
  entry.recipeId = recipe.id;
  entry.recipeName = recipe.name;
  entry.isNew = false;
  const inputEl = document.getElementById('input-' + dateStr);
  if (inputEl) {
    inputEl.value = recipe.name;
    inputEl.classList.remove('is-new');
  }
  const hint = document.getElementById('hint-' + dateStr);
  if (hint) hint.classList.remove('show');
  dropdown.style.display = 'none';
}

function onComboBlur(dateStr) {
  setTimeout(() => {
    const dropdown = document.getElementById('dropdown-' + dateStr);
    if (dropdown) dropdown.style.display = 'none';
  }, 150);
}

function previewPanelBodyHtml() {
  const conflicts = previewConflicts || [];
  return `
    <h3 style="margin-top:0;">Preview</h3>
    <p style="color:var(--color-text-muted); font-size:13px;">Tap a field to see your recipes, type to filter. If nothing matches, it'll be created as new automatically on save.</p>
    ${conflicts.length > 0 ? `<div class="warning-box">&#x26A0; ${conflicts.length} day(s) will overwrite an existing planned meal.</div>` : ''}
    ${previewPicks.map(p => `
      <div class="preview-row">
        <span class="date">${p.date}${conflicts.includes(p.date) ? ' &#x26A0;' : ''}</span>
        <div class="combo-wrap">
          <input
            id="input-${p.date}"
            class="recipe-combo ${p.isNew ? 'is-new' : ''}"
            type="text"
            autocomplete="off"
            value="${escapeHtml(p.recipeName)}"
            data-date="${p.date}"
          >
          <div class="combo-dropdown" id="dropdown-${p.date}" style="display:none;"></div>
          <div class="new-hint ${p.isNew ? 'show' : ''}" id="hint-${p.date}">Will be created as a new recipe on save</div>
        </div>
        <button class="btn small" data-action="reroll" data-date="${p.date}">Reroll</button>
        <button class="icon-btn-erase" data-action="clear-day" data-date="${p.date}" title="Clear this day's recipe">&#x2716;</button>
        <button class="icon-btn-delete" data-action="remove-day" data-date="${p.date}" title="Remove this day">&#x1F5D1;</button>
      </div>
    `).join('')}
    <div class="btn-grid" style="margin-top:15px;">
      <button class="btn" data-action="commit">Confirm & Save</button>
      <button class="btn clear" data-action="cancel-preview">Cancel</button>
    </div>
  `;
}

function cancelPreview() {
  previewPicks = null;
  previewConflicts = [];
  renderModePanel();
}

async function rerollDay(dateStr) {
  const excludeIds = previewPicks.filter(p => p.recipeId).map(p => p.recipeId);
  try {
    const res = await fetch('/api/reroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateStr, avoidRepeats, excludeIds })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Reroll failed: ' + (data.error || res.status), 'error'); return; }
    const entry = previewPicks.find(p => p.date === dateStr);
    if (entry) {
      entry.recipeId = data.pick.recipeId;
      entry.recipeName = data.pick.recipeName;
      entry.isNew = false;
    }
    renderModePanel();
  } catch (err) {
    showStatusModal('Reroll error: ' + err, 'error');
  }
}

async function pollUntilDone(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch('/data/status');
      const data = await res.json();
      if (!data.running) return;
    } catch (err) {
      return;
    }
  }
}

async function resolveNewRecipes(picks) {
  for (const p of picks) {
    if (p.isNew && !p.recipeId) {
      if (!p.recipeName || !p.recipeName.trim()) {
        throw new Error(`Day ${p.date} has an empty recipe name.`);
      }
      const res = await fetch('/api/create-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.recipeName.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Failed to create "${p.recipeName}": ` + (data.error || res.status));
      p.recipeId = data.id;
      p.recipeName = data.name;
      p.isNew = false;
      allRecipes.push({ id: data.id, name: data.name });
    }
  }
}

async function commitPreview() {
  if (!previewPicks || previewPicks.length === 0) return;
  const emptyDays = previewPicks.filter(p => !p.recipeId && !(p.isNew && p.recipeName && p.recipeName.trim()));
  if (emptyDays.length > 0) {
    showStatusModal(`These days still need a recipe before saving: ${emptyDays.map(p => p.date).join(', ')}`, 'error');
    return;
  }
  if (!(await showConfirmModal(`Save these ${previewPicks.length} meal(s) to your calendar?`))) return;
  showStatusModal('Preparing recipes...', 'loading');
  try {
    await resolveNewRecipes(previewPicks);
  } catch (err) {
    showStatusModal(err.message, 'error');
    return;
  }
  showStatusModal('Saving meal plan...', 'loading');
  try {
    const res = await fetch('/api/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ picks: previewPicks })
    });
    if (!res.ok) { showStatusModal('Failed to start save.', 'error'); return; }
    showStatusModal('Saving meal plan and updating shopping list...', 'loading');
    await pollUntilDone();
    weekSelection = null;
    previewPicks = null;
    previewConflicts = [];
    await loadMonthMealplan();
    await loadAvailableWeeks();
    renderModePanel();
    showSuccessThenClose('Saved!');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function clearSelectedDays() {
  const dates = includedDates();
  if (dates.length === 0) { showStatusModal('Select at least one day first.', 'error'); return; }
  if (!(await showConfirmModal(`Clear meals for ${dates.length} day(s)? This cannot be undone.`))) return;
  showStatusModal('Clearing meals...', 'loading');
  try {
    const res = await fetch('/api/clear-dates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dates })
    });
    if (!res.ok) { showStatusModal('Failed to start clear.', 'error'); return; }
    await pollUntilDone();
    weekSelection = null;
    previewPicks = null;
    previewConflicts = [];
    await loadMonthMealplan();
    await loadAvailableWeeks();
    renderModePanel();
    showSuccessThenClose('Cleared!');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

// ---------- Meals of the week ----------

async function loadAvailableWeeks() {
  try {
    const res = await fetch('/data/available-weeks');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    availableWeeks = data.weeks || [];
    if (!selectedWeekStart || !availableWeeks.find(w => w.start === selectedWeekStart)) {
      const current = availableWeeks.find(w => w.isCurrent);
      selectedWeekStart = current ? current.start : (availableWeeks[0] && availableWeeks[0].start) || null;
    }
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load available weeks', err);
    availableWeeks = [];
  }
  await loadWeekMeals();
}

async function loadWeekMeals() {
  if (!selectedWeekStart) {
    weekMealsData = null;
    renderWeekMealsPanel();
    return;
  }
  renderWeekMealsPanel(null, true);
  try {
    const res = await fetch(`/data/week-mealplan?start=${selectedWeekStart}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    weekMealsData = data.days || [];
    renderWeekMealsPanel();
  } catch (err) {
    console.error('Failed to load week meals', err);
    weekMealsData = null;
    renderWeekMealsPanel(err);
  }
}

function formatDayLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderWeekMealsPanel(err, loading) {
  const el = document.getElementById('week-meals-panel');
  if (!el) return;

  const options = availableWeeks.map(w =>
    `<option value="${w.start}" ${w.start === selectedWeekStart ? 'selected' : ''}>${w.label}${w.isCurrent ? ' (current)' : ''}</option>`
  ).join('');

  let body;
  if (loading) {
    body = '<p style="color:var(--color-text-muted);">Loading...</p>';
  } else if (err) {
    body = '<p style="color:var(--color-text-muted);">Couldn\'t load meals for this week.</p>';
  } else if (!weekMealsData) {
    body = '<p style="color:var(--color-text-muted);">No weeks available yet.</p>';
  } else {
    body = weekMealsData.map(day => `
      <div class="day-row ${day.recipeId ? 'clickable' : ''}" ${day.recipeId ? `data-action="view-recipe" data-recipe-id="${day.recipeId}"` : ''}>
        <span class="dd-date">${formatDayLabel(day.date)}</span>
        <span class="dd-meal ${day.recipeName ? '' : 'dd-empty'}">${day.recipeName ? escapeHtml(day.recipeName) : 'No meal planned'}</span>
      </div>
    `).join('');
  }

  el.innerHTML = `
    <div class="week-block">
      <h3>Meals This Week</h3>
      ${availableWeeks.length > 0 ? `
        <div class="week-select-row">
          <label for="week-select" style="font-size:13px; color:var(--color-text-dim);">Week:</label>
          <select id="week-select">${options}</select>
        </div>
      ` : ''}
      ${body}
    </div>
  `;
}

async function fetchRecipeDetail(recipeId) {
  if (recipeDetailCache[recipeId]) return recipeDetailCache[recipeId];
  const res = await fetch(`/data/recipe-detail?id=${encodeURIComponent(recipeId)}`);
  if (!res.ok) throw new Error('server responded ' + res.status);
  const data = await res.json();
  recipeDetailCache[recipeId] = data;
  return data;
}

function renderRecipeDetailHtml(detail) {
  const hasIngredients = detail.ingredients && detail.ingredients.length > 0;
  const hasInstructions = detail.instructions && detail.instructions.length > 0;
  return `
    ${hasIngredients ? `
      <div class="recipe-section-label">Ingredients</div>
      <ul class="recipe-ingredients">${detail.ingredients.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
    ` : ''}
    ${hasInstructions ? `
      <div class="recipe-section-label">Steps</div>
      <ol class="recipe-instructions">${detail.instructions.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    ` : ''}
    ${(!hasIngredients && !hasInstructions) ? '<p class="meal-empty">No ingredients or steps recorded for this recipe.</p>' : ''}
  `;
}

// ---------- Recipe detail modal ----------

async function openRecipeModal(recipeId) {
  const overlay = document.getElementById('recipe-modal-overlay');
  const body = document.getElementById('recipe-modal-body');
  body.innerHTML = '<div class="recipe-loading">Loading recipe...</div>';
  overlay.style.display = 'flex';
  try {
    const detail = await fetchRecipeDetail(recipeId);
    body.innerHTML = `<h2>${escapeHtml(detail.name || 'Recipe')}</h2>${renderRecipeDetailHtml(detail)}`;
  } catch (err) {
    body.innerHTML = '<p class="meal-empty">Couldn\'t load recipe details.</p>';
  }
}

function closeRecipeModal() {
  document.getElementById('recipe-modal-overlay').style.display = 'none';
}

// ---------- Shopping list ----------

const SHOPPING_FILTER_MODES = ['meal', 'all'];
let shoppingFilterMode = SHOPPING_FILTER_MODES.includes(localStorage.getItem('mealie_shoppingFilterMode'))
  ? localStorage.getItem('mealie_shoppingFilterMode') : 'meal';
let shoppingListsCache = [];

async function loadShoppingListsForRange(startIso, endIso) {
  const el = document.getElementById('shopping-list-panel');
  el.innerHTML = '<div class="week-block"><h3>Shopping Lists</h3><p>Loading...</p></div>';
  try {
    const res = await fetch(`/data/shopping-lists-for-range?start=${startIso}&end=${endIso}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    shoppingListsCache = data.lists || [];
    clearErrorBanner();
    renderShoppingListsPanel();
  } catch (err) {
    el.innerHTML = `<div class="week-block"><h3>Shopping Lists</h3><p style="color:var(--color-text-muted);">Couldn't load shopping lists.</p></div>`;
    showErrorBanner("Couldn't reach the server to load shopping lists. Check that it's running and try again.");
  }
}

function renderShoppingFilterToggleHtml() {
  return `
    <div class="mode-toggle" id="shopping-filter-toggle">
      <button data-filter="meal" class="${shoppingFilterMode === 'meal' ? 'active' : ''}">By Meal</button>
      <button data-filter="all" class="${shoppingFilterMode === 'all' ? 'active' : ''}">All Items</button>
    </div>
  `;
}

function renderShoppingListsPanel() {
  const el = document.getElementById('shopping-list-panel');
  const lists = shoppingListsCache;
  if (lists.length === 0) {
    el.innerHTML = `
      <div class="week-block">
        <div class="shopping-panel-header"><h3>Shopping Lists</h3>${renderShoppingFilterToggleHtml()}</div>
        <p style="color:var(--color-text-muted);">No shopping lists for this range.</p>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="week-block">
      <div class="shopping-panel-header"><h3>Shopping Lists</h3>${renderShoppingFilterToggleHtml()}</div>
      ${lists.map(l => renderShoppingListDetailsHtml(l)).join('')}
    </div>
  `;
}

function renderShoppingListDetailsHtml(l) {
  const body = shoppingFilterMode === 'meal'
    ? renderGroupedItemsHtml(l)
    : `<ul class="shopping-items" data-list-id="${l.id}">${l.items.map(i => renderShoppingItemHtml(i)).join('')}</ul>`;
  return `
    <details class="list-dropdown" data-label="${escapeHtml(l.week_label || l.name)}" data-list-id="${l.id}">
      <summary>${escapeHtml(l.week_label || l.name)} &mdash; ${l.items.length} item${l.items.length === 1 ? '' : 's'}</summary>
      ${body}
      <div class="shopping-add-row">
        <input type="text" class="add-item-input" data-list-id="${l.id}" placeholder="Add item...">
        <button class="btn small" data-action="add-item" data-list-id="${l.id}">Add</button>
      </div>
    </details>
  `;
}

function renderGroupedItemsHtml(l) {
  const groups = l.groups || [];
  const otherItems = l.otherItems || [];
  const groupsHtml = groups.map(g => `
    <div class="shopping-group" data-group="${g.recipeId}">
      <h4 class="shopping-group-title">${escapeHtml(g.recipeName)}</h4>
      <ul class="shopping-items" data-list-id="${l.id}">${g.items.map(i => renderShoppingItemHtml(i)).join('')}</ul>
    </div>
  `).join('');
  const otherHtml = otherItems.length > 0 ? `
    <div class="shopping-group" data-group="other">
      <h4 class="shopping-group-title">Other</h4>
      <ul class="shopping-items" data-list-id="${l.id}">${otherItems.map(i => renderShoppingItemHtml(i)).join('')}</ul>
    </div>
  ` : '';
  if (!groupsHtml && !otherHtml) {
    return '<p style="color:var(--color-text-muted); font-size:13px;">No items yet.</p>';
  }
  return groupsHtml + otherHtml;
}

function setShoppingFilterMode(mode) {
  if (mode === shoppingFilterMode) return;
  shoppingFilterMode = mode;
  localStorage.setItem('mealie_shoppingFilterMode', mode);
  renderShoppingListsPanel();
}

function renderShoppingItemHtml(item) {
  return `
    <li data-item-id="${item.id}">
      <input type="checkbox" class="shopping-item-check" data-item-id="${item.id}" ${item.checked ? 'checked' : ''}>
      <span class="shopping-item-text ${item.checked ? 'checked' : ''}">${escapeHtml(item.display)}</span>
      <button class="shopping-item-del" data-action="delete-item" data-item-id="${item.id}" title="Remove item">&#x2716;</button>
    </li>
  `;
}

function updateListItemCount(listId) {
  const details = document.querySelector(`.list-dropdown[data-list-id="${CSS.escape(listId)}"]`);
  if (!details) return;
  const summary = details.querySelector('summary');
  if (!summary) return;
  const label = details.dataset.label || '';
  const uniqueIds = new Set();
  details.querySelectorAll('.shopping-items li[data-item-id]').forEach(li => uniqueIds.add(li.dataset.itemId));
  const count = uniqueIds.size;
  summary.textContent = `${label} — ${count} item${count === 1 ? '' : 's'}`;
}

function appendItemToList(listId, itemData) {
  const details = document.querySelector(`.list-dropdown[data-list-id="${CSS.escape(listId)}"]`);
  if (!details) return;
  let ul;
  if (shoppingFilterMode === 'meal') {
    let group = details.querySelector('.shopping-group[data-group="other"]');
    if (!group) {
      const addRow = details.querySelector('.shopping-add-row');
      addRow.insertAdjacentHTML('beforebegin', `
        <div class="shopping-group" data-group="other">
          <h4 class="shopping-group-title">Other</h4>
          <ul class="shopping-items" data-list-id="${listId}"></ul>
        </div>
      `);
      group = details.querySelector('.shopping-group[data-group="other"]');
    }
    ul = group.querySelector('.shopping-items');
  } else {
    ul = details.querySelector('.shopping-items');
  }
  if (ul) ul.insertAdjacentHTML('beforeend', renderShoppingItemHtml(itemData));
  updateListItemCount(listId);
}

async function addShoppingItem(listId, text) {
  text = (text || '').trim();
  if (!text) return;
  try {
    const res = await fetch('/api/shopping-item-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listId, text })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Failed to add item: ' + (data.error || res.status), 'error'); return; }
    appendItemToList(listId, data);
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function deleteShoppingItem(itemId, listId) {
  try {
    const res = await fetch('/api/shopping-item-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showStatusModal('Failed to remove item: ' + (data.error || res.status), 'error');
      return;
    }
    document.querySelectorAll(`li[data-item-id="${CSS.escape(itemId)}"]`).forEach(li => li.remove());
    updateListItemCount(listId);
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function toggleShoppingItemChecked(itemId, checked) {
  try {
    const res = await fetch('/api/shopping-item-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, checked })
    });
    if (!res.ok) {
      document.querySelectorAll(`li[data-item-id="${CSS.escape(itemId)}"]`).forEach(li => {
        const checkbox = li.querySelector('.shopping-item-check');
        const textEl = li.querySelector('.shopping-item-text');
        if (checkbox) checkbox.checked = !checked;
        if (textEl) textEl.classList.toggle('checked', !checked);
      });
    }
  } catch (err) {
    document.querySelectorAll(`li[data-item-id="${CSS.escape(itemId)}"]`).forEach(li => {
      const checkbox = li.querySelector('.shopping-item-check');
      const textEl = li.querySelector('.shopping-item-text');
      if (checkbox) checkbox.checked = !checked;
      if (textEl) textEl.classList.toggle('checked', !checked);
    });
  }
}

function refreshShoppingPanel() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const gridStart = new Date(year, month, 1 - startWeekday);
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridEnd.getDate() + 41);
  loadShoppingListsForRange(isoOf(gridStart), isoOf(gridEnd));
}

// ---------- Wiring ----------

function wireDelegatedListeners() {
  const root = document.getElementById('mealie-root');
  root.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('#calendar-mode-toggle button');
    if (modeBtn) return setCalendarMode(modeBtn.dataset.mode);
    const viewLink = e.target.closest('[data-action="view-recipe"]');
    if (viewLink) return openRecipeModal(viewLink.dataset.recipeId);
    if (e.target.id === 'recipe-modal-close') return closeRecipeModal();
    if (e.target.id === 'recipe-modal-overlay') return closeRecipeModal();
  });

  const calendarContainer = document.getElementById('calendar-container');
  calendarContainer.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="prev-month"]')) return changeMonth(-1);
    if (e.target.closest('[data-action="next-month"]')) return changeMonth(1);
    if (e.target.closest('[data-action="clear-selection"]')) return clearSelection();
    const dayEl = e.target.closest('.cal-day');
    if (dayEl && dayEl.dataset.iso) return onDayClick(dayEl.dataset.iso);
  });

  // Plan's selection summary / preview, View's day detail, and Edit's form
  // all render into the same #mode-panel (see renderModePanel), so one set
  // of listeners here covers every data-action any of them can produce --
  // only the mode currently rendered will actually have matching markup.
  const modePanel = document.getElementById('mode-panel');
  modePanel.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.combo-item[data-recipe-id]');
    if (item) {
      e.preventDefault();
      const dropdown = item.closest('.combo-dropdown');
      if (dropdown && dropdown.id === 'edit-dropdown') {
        selectEditComboItem(item.dataset.recipeId, dropdown);
      } else {
        selectComboItem(item.dataset.recipeId, dropdown);
      }
      return;
    }
    if (e.target.closest('.mode-panel-handle')) startModePanelResize(e);
  });
  modePanel.addEventListener('touchstart', (e) => {
    if (e.target.closest('.mode-panel-handle')) startModePanelResize(e);
  }, { passive: false });
  modePanel.addEventListener('change', (e) => {
    if (e.target.id === 'avoid-repeats-check') toggleAvoidRepeats(e.target.checked);
  });
  modePanel.addEventListener('click', (e) => {
    const modeSwitchBtn = e.target.closest('.mode-panel-mode-switch button');
    if (modeSwitchBtn) return setCalendarMode(modeSwitchBtn.dataset.mode);

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const date = btn.dataset.date;
    switch (btn.dataset.action) {
      case 'close-mode-panel': return closeModePanel();
      case 'toggle-mode-switcher':
        modePanelShowModeSwitcher = !modePanelShowModeSwitcher;
        return renderModePanel();
      case 'exclude-fridays': return excludeAllFridays();
      case 'plan-selected': return planSelected();
      case 'clear-selected-days': return clearSelectedDays();
      case 'cancel-selection': return clearSelection();
      case 'reroll': return rerollDay(date);
      case 'clear-day': return clearPreviewDay(date);
      case 'remove-day': return removePreviewDay(date);
      case 'commit': return commitPreview();
      case 'cancel-preview': return cancelPreview();
      case 'edit-reroll': return editReroll();
      case 'edit-save': return saveEditPick();
      case 'edit-cancel': return closeEditPanel();
      case 'edit-swap': return doEditSwap();
      case 'view-recipe-inline': return showViewRecipeDetailInline(btn.dataset.recipeId);
    }
  });
  modePanel.addEventListener('focusin', (e) => {
    if (e.target.id === 'edit-input') return onEditComboFocus(e.target);
    if (e.target.classList.contains('recipe-combo')) onComboFocus(e.target.dataset.date, e.target);
  });
  modePanel.addEventListener('input', (e) => {
    if (e.target.id === 'edit-input') return onEditComboType(e.target);
    if (e.target.classList.contains('recipe-combo')) onComboType(e.target.dataset.date, e.target);
  });
  modePanel.addEventListener('focusout', (e) => {
    if (e.target.id === 'edit-input') return onEditComboBlur();
    if (e.target.classList.contains('recipe-combo')) onComboBlur(e.target.dataset.date);
  });

  const weekMealsPanel = document.getElementById('week-meals-panel');
  weekMealsPanel.addEventListener('change', (e) => {
    if (e.target.id === 'week-select') {
      selectedWeekStart = e.target.value;
      loadWeekMeals();
    }
  });

  const shoppingPanel = document.getElementById('shopping-list-panel');
  shoppingPanel.addEventListener('click', (e) => {
    const filterBtn = e.target.closest('#shopping-filter-toggle button');
    if (filterBtn) return setShoppingFilterMode(filterBtn.dataset.filter);
    const addBtn = e.target.closest('[data-action="add-item"]');
    if (addBtn) {
      const listId = addBtn.dataset.listId;
      const input = shoppingPanel.querySelector(`.add-item-input[data-list-id="${CSS.escape(listId)}"]`);
      if (input) {
        addShoppingItem(listId, input.value);
        input.value = '';
      }
      return;
    }
    const delBtn = e.target.closest('[data-action="delete-item"]');
    if (delBtn) {
      const li = delBtn.closest('li');
      const listId = li.closest('.shopping-items').dataset.listId;
      deleteShoppingItem(delBtn.dataset.itemId, listId);
    }
  });
  shoppingPanel.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('add-item-input') && e.key === 'Enter') {
      e.preventDefault();
      const listId = e.target.dataset.listId;
      addShoppingItem(listId, e.target.value);
      e.target.value = '';
    }
  });
  shoppingPanel.addEventListener('change', (e) => {
    if (!e.target.classList.contains('shopping-item-check')) return;
    const itemId = e.target.dataset.itemId;
    const checked = e.target.checked;
    document.querySelectorAll(`li[data-item-id="${CSS.escape(itemId)}"]`).forEach(li => {
      const checkbox = li.querySelector('.shopping-item-check');
      const textEl = li.querySelector('.shopping-item-text');
      if (checkbox) checkbox.checked = checked;
      if (textEl) textEl.classList.toggle('checked', checked);
    });
    toggleShoppingItemChecked(itemId, checked);
  });
}

registerApp('mealie', {
  title: '&#x1F374; Mealie',
  bodyHtml: `
    <div id="mealie-root">
      <div id="conn-error-banner" class="error-banner"></div>

      <div id="meal-of-day-panel"></div>

      <div class="week-block">
        <div class="mode-toggle" id="calendar-mode-toggle"></div>
        <div id="calendar-container" style="margin-top:12px;"><div class="cal-loading">Loading calendar...</div></div>
      </div>
      <div id="mode-panel"></div>

      <div id="week-meals-panel"></div>

      <div id="shopping-list-panel"></div>

      <div class="recipe-modal-overlay" id="recipe-modal-overlay">
        <div class="recipe-modal">
          <button class="recipe-modal-close" id="recipe-modal-close">&#x2716;</button>
          <div id="recipe-modal-body"></div>
        </div>
      </div>

      <a class="goto-btn" href="http://${HOST_IP}:9000" target="_blank">Open Mealie &rarr;</a>
    </div>
  `,
  onRender: () => {
    wireDelegatedListeners();
    calendarMonth = new Date();
    weekSelection = null;
    previewPicks = null;
    previewConflicts = [];
    viewSelectedIso = null;
    editSelectedIso = null;
    editPick = null;
    renderModeToggle();
    renderMealOfDay();
    loadRecipes();
    loadMonthMealplan();
    renderModePanel();
    loadAvailableWeeks();
  },
});
