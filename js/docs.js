// docs.js -- renders docs/*.md inline. Minimal hand-rolled markdown
// renderer (headings, lists, inline code, bold, paragraphs only) --
// deliberately not a full parser or a third-party library, since docs
// content only ever uses a small known subset of markdown.
import { registerApp, escapeHtml } from './core.js';

let docsList = [];

function renderMarkdown(text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  const inlineFormat = (line) => {
    let out = escapeHtml(line);
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/`(.+?)`/g, '<code>$1</code>');
    return out;
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith('tags:')) continue;
    if (/^# /.test(line)) {
      closeList();
      html += `<h1>${inlineFormat(line.slice(2))}</h1>`;
    } else if (/^## /.test(line)) {
      closeList();
      html += `<h2>${inlineFormat(line.slice(3))}</h2>`;
    } else if (/^- /.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineFormat(line.slice(2))}</li>`;
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inlineFormat(line)}</p>`;
    }
  }
  closeList();
  return html;
}

async function loadDocsList() {
  const root = document.getElementById('docs-root');
  root.innerHTML = '<p style="color:#888;">Loading docs...</p>';
  try {
    const res = await fetch('/data/docs-list');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    docsList = data.docs || [];
    renderDocsIndex();
  } catch (err) {
    console.error('Failed to load docs list', err);
    root.innerHTML = '<p style="color:#888;">Couldn\'t load documentation.</p>';
  }
}

function renderDocsIndex() {
  const root = document.getElementById('docs-root');
  if (docsList.length === 0) {
    root.innerHTML = '<p style="color:#888;">No documentation found.</p>';
    return;
  }
  root.innerHTML = `
    <div class="week-block">
      <h3>Documentation</h3>
      <div class="profile-picker-grid">
        ${docsList.map(d => `
          <div class="profile-card" data-action="open-doc" data-filename="${d.filename}" style="text-align:left; display:block; font-weight:normal;">
            <div style="font-weight:bold; margin-bottom:6px;">${escapeHtml(d.title)}</div>
            <div style="font-size:11px; color:#888;">${d.tags.map(t => escapeHtml(t)).join(', ')}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function openDoc(filename) {
  const root = document.getElementById('docs-root');
  root.innerHTML = '<p style="color:#888;">Loading...</p>';
  try {
    const res = await fetch(`/data/docs-content?filename=${encodeURIComponent(filename)}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    root.innerHTML = `
      <button class="btn small" data-action="back-to-index" style="margin-bottom:15px;">&larr; All docs</button>
      <div class="week-block">${renderMarkdown(data.content)}</div>
    `;
  } catch (err) {
    console.error('Failed to load doc', err);
    root.innerHTML = '<p style="color:#888;">Couldn\'t load this document.</p>';
  }
}

function wireDelegatedListeners() {
  const root = document.getElementById('docs-root');
  root.addEventListener('click', (e) => {
    const card = e.target.closest('[data-action="open-doc"]');
    if (card) { openDoc(card.dataset.filename); return; }
    const backBtn = e.target.closest('[data-action="back-to-index"]');
    if (backBtn) { renderDocsIndex(); return; }
  });
}

let listenersWired = false;

registerApp('docs', {
  title: '&#x1F4DA; Docs',
  bodyHtml: `<div id="docs-root"></div>`,
  onRender: () => {
    if (!listenersWired) {
      wireDelegatedListeners();
      listenersWired = true;
    }
    loadDocsList();
  },
});
