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
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      closeList();
      const alt = imgMatch[1];
      const src = imgMatch[2];
      if (/^docs\/[\w.-]+\.svg$/.test(src)) {
        html += `<div class="svg-embed" data-svg-src="/${src}" data-svg-alt="${escapeHtml(alt)}" style="background:white; border-radius:6px; padding:10px; margin:10px 0; overflow:auto;"><p style="color:#888; margin:0;">Loading diagram...</p></div>`;
      }
    } else if (/^# /.test(line)) {
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
  root.innerHTML = '<p style="color:var(--color-text-muted);">Loading docs...</p>';
  try {
    const res = await fetch('/data/docs-list');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    docsList = data.docs || [];
    renderDocsIndex();
  } catch (err) {
    console.error('Failed to load docs list', err);
    root.innerHTML = '<p style="color:var(--color-text-muted);">Couldn\'t load documentation.</p>';
  }
}

function renderDocsIndex() {
  const root = document.getElementById('docs-root');
  if (docsList.length === 0) {
    root.innerHTML = '<p style="color:var(--color-text-muted);">No documentation found.</p>';
    return;
  }
  root.innerHTML = `
    <div class="week-block">
      <h3>Documentation</h3>
      <div class="profile-picker-grid">
        ${docsList.map(d => `
          <div class="profile-card" data-action="open-doc" data-filename="${d.filename}" style="text-align:left; display:block; font-weight:normal;">
            <div style="font-weight:bold; margin-bottom:6px;">${escapeHtml(d.title)}</div>
            <div style="font-size:11px; color:var(--color-text-muted);">${d.tags.map(t => escapeHtml(t)).join(', ')}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

async function openDoc(filename) {
  const root = document.getElementById('docs-root');
  root.innerHTML = '<p style="color:var(--color-text-muted);">Loading...</p>';
  try {
    const res = await fetch(`/data/docs-content?filename=${encodeURIComponent(filename)}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    root.innerHTML = `
      <button class="btn small" data-action="back-to-index" style="margin-bottom:15px;">&larr; All docs</button>
      <div class="week-block">${renderMarkdown(data.content)}</div>
    `;
    await inlineEmbeddedSvgs(root);
  } catch (err) {
    console.error('Failed to load doc', err);
    root.innerHTML = '<p style="color:var(--color-text-muted);">Couldn\'t load this document.</p>';
  }
}

async function inlineEmbeddedSvgs(container) {
  const placeholders = container.querySelectorAll('.svg-embed');
  for (const el of placeholders) {
    const src = el.dataset.svgSrc;
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error('server responded ' + res.status);
      const svgText = await res.text();
      el.innerHTML = svgText;
      const svgEl = el.querySelector('svg');
      if (svgEl) makeSvgDraggable(svgEl);
    } catch (err) {
      console.error('Failed to load diagram', err);
      el.innerHTML = '<p style="color:#888; margin:0;">Couldn\'t load the diagram.</p>';
    }
  }
}

function makeSvgDraggable(svgEl) {
  const nodes = svgEl.querySelectorAll('rect[data-node-id]');
  let dragTarget = null;
  let offsetX = 0, offsetY = 0;

  const toSvgPoint = (evt) => {
    const pt = svgEl.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svgEl.getScreenCTM();
    return ctm ? pt.matrixTransform(ctm.inverse()) : pt;
  };

  const updateEdgesFor = (nodeId, newX, newY, width, height) => {
    svgEl.querySelectorAll(`[data-src="${nodeId}"], [data-dst="${nodeId}"]`).forEach(edge => {
      const isSrc = edge.dataset.src === nodeId;
      const attrPrefix = isSrc ? '1' : '2';
      edge.dataset[isSrc ? 'srcCx' : 'dstCx'] = newX + width / 2;
      edge.dataset[isSrc ? 'srcCy' : 'dstCy'] = newY + height / 2;
    });
  };

  nodes.forEach(rect => {
    const nodeId = rect.dataset.nodeId;
    const group = rect.closest('g.node-group');
    if (!group) return;
    rect.style.cursor = 'grab';
    rect.addEventListener('pointerdown', (evt) => {
      dragTarget = group;
      const pt = toSvgPoint(evt);
      const currentTransform = group.getAttribute('data-x-y') || '0,0';
      const [gx, gy] = currentTransform.split(',').map(Number);
      offsetX = pt.x - gx;
      offsetY = pt.y - gy;
      rect.style.cursor = 'grabbing';
      evt.preventDefault();
    });
  });

  svgEl.addEventListener('pointermove', (evt) => {
    if (!dragTarget) return;
    const pt = toSvgPoint(evt);
    const newX = pt.x - offsetX;
    const newY = pt.y - offsetY;
    dragTarget.setAttribute('transform', `translate(${newX}, ${newY})`);
    dragTarget.setAttribute('data-x-y', `${newX},${newY}`);
    const nodeId = dragTarget.dataset.nodeId;
    const rect = dragTarget.querySelector('rect');
    const w = parseFloat(rect.getAttribute('width'));
    const h = parseFloat(rect.getAttribute('height'));
    const cx = newX + w / 2;
    const cy = newY + h / 2;
    svgEl.querySelectorAll(`path[data-src="${nodeId}"], line[data-src="${nodeId}"]`).forEach(edge => {
      edge.dataset.srcCx = cx; edge.dataset.srcCy = cy;
      redrawEdge(edge);
    });
    svgEl.querySelectorAll(`path[data-dst="${nodeId}"], line[data-dst="${nodeId}"]`).forEach(edge => {
      edge.dataset.dstCx = cx; edge.dataset.dstCy = cy;
      redrawEdge(edge);
    });
  });

  const endDrag = () => {
    if (dragTarget) {
      const rect = dragTarget.querySelector('rect');
      if (rect) rect.style.cursor = 'grab';
    }
    dragTarget = null;
  };
  svgEl.addEventListener('pointerup', endDrag);
  svgEl.addEventListener('pointerleave', endDrag);
}

function redrawEdge(edge) {
  const srcCx = parseFloat(edge.dataset.srcCx);
  const srcCy = parseFloat(edge.dataset.srcCy);
  const dstCx = parseFloat(edge.dataset.dstCx);
  const dstCy = parseFloat(edge.dataset.dstCy);
  if (edge.tagName === 'line') {
    edge.setAttribute('x1', srcCx);
    edge.setAttribute('y1', srcCy);
    edge.setAttribute('x2', dstCx);
    edge.setAttribute('y2', dstCy);
  } else if (edge.tagName === 'path') {
    const midX = (srcCx + dstCx) / 2;
    const midY = (srcCy + dstCy) / 2;
    edge.setAttribute('d', `M ${srcCx},${srcCy} Q ${midX},${midY} ${dstCx},${dstCy}`);
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

registerApp('docs', {
  title: '&#x1F4DA; Docs',
  bodyHtml: `<div id="docs-root"></div>`,
  onRender: () => {
    wireDelegatedListeners();
    loadDocsList();
  },
});
