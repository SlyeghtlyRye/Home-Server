// mealie.js -- meal planning: calendar, preview/reroll/commit flow,
// shopping lists. Uses event delegation on stable containers since their
// contents (calendar days, preview rows) re-render frequently.
import { registerApp, showStatusModal, hideStatusModal, showSuccessThenClose,
         showErrorBanner, clearErrorBanner, showConfirmModal, escapeHtml, isoOf } from './core.js';
import { HOST_IP } from './config.js';

let calendarMonth = new Date();
let plannedMap = {};
let weekSelection = null;
let previewPicks = null;
let avoidRepeats = localStorage.getItem('mealie_avoidRepeats') !== 'false';
let allRecipes = [];

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
    (data.entries || []).forEach(e => { plannedMap[e.date] = e.recipe; });
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load month mealplan', err);
    plannedMap = {};
    showErrorBanner("Couldn't reach the server to load the calendar. Check that it's running and try again.");
  }
  renderCalendar();
  refreshShoppingPanel();
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
    html += `
      <div class="${cls}" data-iso="${iso}">
        <div class="cal-daynum">${d.getDate()}</div>
        ${meal ? `<div class="cal-meal">${escapeHtml(meal)}</div>` : ''}
      </div>
    `;
  }
  html += `</div>`;
  document.getElementById('calendar-container').innerHTML = html;
}

function onDayClick(iso) {
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
  renderActionPanel();
  refreshShoppingPanel();
}

function clearSelection() {
  weekSelection = null;
  previewPicks = null;
  renderCalendar();
  renderActionPanel();
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
  renderActionPanel();
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

function renderActionPanel() {
  const el = document.getElementById('action-panel');
  document.getElementById('preview-panel').innerHTML = '';
  if (!weekSelection) {
    el.innerHTML = '';
    return;
  }
  const included = includedDates();
  const totalSelected = Object.keys(weekSelection.days).length;
  el.innerHTML = `
    <div class="week-block">
      <h3>Selected Days</h3>
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
    const list = conflicts.map(d => `${d} (${plannedMap[d]})`).join('\n');
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
    hideStatusModal();
    renderPreviewPanel(conflicts);
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
  renderPreviewPanel();
}

function clearPreviewDay(dateStr) {
  if (!previewPicks) return;
  const entry = previewPicks.find(p => p.date === dateStr);
  if (!entry) return;
  entry.recipeId = null;
  entry.recipeName = '';
  entry.isNew = false;
  renderPreviewPanel();
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

function renderPreviewPanel(conflicts) {
  conflicts = conflicts || [];
  const el = document.getElementById('preview-panel');
  if (!previewPicks) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="week-block">
      <h3>Preview</h3>
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
    </div>
  `;
}

function cancelPreview() {
  previewPicks = null;
  renderPreviewPanel();
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
    renderPreviewPanel();
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

async function resolveNewRecipes() {
  for (const p of previewPicks) {
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
    await resolveNewRecipes();
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
    await loadMonthMealplan();
    renderActionPanel();
    refreshShoppingPanel();
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
    await loadMonthMealplan();
    renderActionPanel();
    refreshShoppingPanel();
    showSuccessThenClose('Cleared!');
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function loadShoppingListsForRange(startIso, endIso) {
  const el = document.getElementById('shopping-list-panel');
  el.innerHTML = '<div class="week-block"><h3>Shopping Lists</h3><p>Loading...</p></div>';
  try {
    const res = await fetch(`/data/shopping-lists-for-range?start=${startIso}&end=${endIso}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    const lists = data.lists || [];
    clearErrorBanner();
    if (lists.length === 0) {
      el.innerHTML = '<div class="week-block"><h3>Shopping Lists</h3><p style="color:var(--color-text-muted);">No shopping lists for this range.</p></div>';
      return;
    }
    el.innerHTML = `
      <div class="week-block">
        <h3>Shopping Lists</h3>
        ${lists.map(l => `
          <details class="list-dropdown">
            <summary>${escapeHtml(l.week_label || l.name)} &mdash; ${l.items.length} item${l.items.length === 1 ? '' : 's'}</summary>
            <ul class="shopping-items">
              ${l.items.map(i => `<li>${i.checked ? '&#x2611;' : '&#x2610;'} ${escapeHtml(i.display)}</li>`).join('')}
            </ul>
          </details>
        `).join('')}
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="week-block"><h3>Shopping Lists</h3><p style="color:var(--color-text-muted);">Couldn't load shopping lists.</p></div>`;
    showErrorBanner("Couldn't reach the server to load shopping lists. Check that it's running and try again.");
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

function wireDelegatedListeners() {
  const calendarContainer = document.getElementById('calendar-container');
  calendarContainer.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="prev-month"]')) return changeMonth(-1);
    if (e.target.closest('[data-action="next-month"]')) return changeMonth(1);
    if (e.target.closest('[data-action="clear-selection"]')) return clearSelection();
    const dayEl = e.target.closest('.cal-day');
    if (dayEl && dayEl.dataset.iso) return onDayClick(dayEl.dataset.iso);
  });

  const actionPanel = document.getElementById('action-panel');
  actionPanel.addEventListener('change', (e) => {
    if (e.target.id === 'avoid-repeats-check') toggleAvoidRepeats(e.target.checked);
  });
  actionPanel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'exclude-fridays') excludeAllFridays();
    else if (btn.dataset.action === 'plan-selected') planSelected();
    else if (btn.dataset.action === 'clear-selected-days') clearSelectedDays();
    else if (btn.dataset.action === 'cancel-selection') clearSelection();
  });

  const previewPanel = document.getElementById('preview-panel');
  previewPanel.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.combo-item[data-recipe-id]');
    if (!item) return;
    e.preventDefault();
    const dropdown = item.closest('.combo-dropdown');
    selectComboItem(item.dataset.recipeId, dropdown);
  });
  previewPanel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const date = btn.dataset.date;
    if (btn.dataset.action === 'reroll') rerollDay(date);
    else if (btn.dataset.action === 'clear-day') clearPreviewDay(date);
    else if (btn.dataset.action === 'remove-day') removePreviewDay(date);
    else if (btn.dataset.action === 'commit') commitPreview();
    else if (btn.dataset.action === 'cancel-preview') cancelPreview();
  });
  previewPanel.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('recipe-combo')) onComboFocus(e.target.dataset.date, e.target);
  });
  previewPanel.addEventListener('input', (e) => {
    if (e.target.classList.contains('recipe-combo')) onComboType(e.target.dataset.date, e.target);
  });
  previewPanel.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('recipe-combo')) onComboBlur(e.target.dataset.date);
  });
}

registerApp('mealie', {
  title: '&#x1F374; Mealie',
  bodyHtml: `
    <div id="conn-error-banner" class="error-banner"></div>
    <div class="week-block">
      <div id="calendar-container"><div class="cal-loading">Loading calendar...</div></div>
    </div>
    <div id="action-panel"></div>
    <div id="preview-panel"></div>
    <div id="shopping-list-panel"></div>
    <a class="goto-btn" href="http://${HOST_IP}:9000" target="_blank">Open Mealie &rarr;</a>
  `,
  onRender: () => {
    wireDelegatedListeners();
    calendarMonth = new Date();
    weekSelection = null;
    previewPicks = null;
    loadRecipes();
    loadMonthMealplan();
    renderActionPanel();
    refreshShoppingPanel();
  },
});
