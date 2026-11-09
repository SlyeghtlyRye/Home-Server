// docs.js -- renders docs/*.md inline. Minimal hand-rolled markdown
// renderer -- deliberately not a full parser or a third-party library.
// Supports the subset the docs actually use: #/##/### headings,
// paragraphs (wrapped source lines are joined back into one paragraph),
// "- " and "1. " lists (indented lines continue the item above, indented
// "- " lines become sub-points), fenced code blocks (including ones
// indented inside a list item), pipe tables, **bold**, *italic*,
// `inline code`, and docs/*.svg image embeds.
import { registerApp, escapeHtml } from './core.js';

let docsList = [];

// Where this project's source lives. Shown in the "More info" section and
// as a per-doc "View on GitHub" link (file history, raw source).
const REPO_URL = 'https://github.com/SlyeghtlyRye/Home-Server';
const REPO_BRANCH = 'main';
// Featured in "More info" instead of the main grid.
const FINDINGS_DOC = 'dev-findings.md';

function inlineFormat(text) {
  // Pull code spans out first so ** and * inside them stay literal.
  const codes = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function renderMarkdown(text) {
  const lines = text.split(/\r?\n/);
  let html = '';
  let para = [];
  let list = null; // { tag: 'ul' | 'ol', start, items: [html] }

  const flushPara = () => {
    if (para.length) html += `<p>${inlineFormat(para.join(' '))}</p>`;
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const start = list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
    html += `<${list.tag}${start}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`;
    list = null;
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (line.startsWith('tags:')) continue;

    // Fenced code block. Inside a list item it's indented; it's rendered
    // inside that item so a numbered list keeps counting past it.
    if (trimmed.startsWith('```')) {
      const indent = line.length - line.trimStart().length;
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) {
        code.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)));
      }
      const block = `<pre class="doc-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`;
      if (list && indent > 0) {
        list.items[list.items.length - 1] += block;
      } else {
        flushAll();
        html += block;
      }
      continue;
    }

    // Pipe table: a "|" row followed by a |---| separator row.
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flushAll();
      const header = splitTableRow(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(splitTableRow(lines[i]));
      i--;
      html += '<div class="doc-table-wrap"><table class="doc-table"><thead><tr>'
        + header.map(h => `<th>${inlineFormat(h)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(r => `<tr>${r.map(c => `<td>${inlineFormat(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>';
      continue;
    }

    const img = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      flushAll();
      if (/^docs\/[\w.-]+\.svg$/.test(img[2])) {
        html += `<div class="svg-embed" data-svg-src="/${img[2]}" data-svg-alt="${escapeHtml(img[1])}"><p style="color:#888; margin:0;">Loading diagram...</p></div>`;
      }
      continue;
    }

    const heading = line.match(/^(#{1,3}) (.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html += `<h${level}>${inlineFormat(heading[2])}</h${level}>`;
      continue;
    }

    const bullet = line.match(/^[-*] (.*)$/);
    const numbered = line.match(/^(\d+)\. (.*)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, start: numbered ? parseInt(numbered[1], 10) : 1, items: [] };
      }
      list.items.push(inlineFormat(bullet ? bullet[1] : numbered[2]));
      continue;
    }

    if (trimmed === '') {
      flushPara();
      continue;
    }

    // Indented line right after a list item: continues that item.
    if (list && /^\s{2,}/.test(line)) {
      const sub = trimmed.match(/^[-*] (.*)$/);
      list.items[list.items.length - 1] += sub
        ? `<br>&bull; ${inlineFormat(sub[1])}`
        : ` ${inlineFormat(trimmed)}`;
      continue;
    }

    flushList();
    para.push(trimmed.replace(/^> ?/, ''));
  }
  flushAll();
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
  const findings = docsList.find(d => d.filename === FINDINGS_DOC);
  const cardStyle = 'text-align:left; display:block; font-weight:normal;';
  const docCard = d => `
          <div class="profile-card" data-action="open-doc" data-filename="${escapeHtml(d.filename)}" style="${cardStyle}">
            <div style="font-weight:bold; margin-bottom:6px;">${escapeHtml(d.title)}</div>
            <div style="font-size:11px; color:var(--color-text-muted);">${d.tags.map(t => escapeHtml(t)).join(', ')}</div>
          </div>`;
  root.innerHTML = `
    <div class="week-block">
      <h3>Documentation</h3>
      <div class="profile-picker-grid">
        ${docsList.filter(d => d !== findings).map(docCard).join('')}
      </div>
    </div>
    <div class="week-block">
      <h3>More info</h3>
      <div class="profile-picker-grid">
        ${findings ? `
          <div class="profile-card" data-action="open-doc" data-filename="${escapeHtml(findings.filename)}" style="${cardStyle}">
            <div style="font-weight:bold; margin-bottom:6px;">&#x1F50D; ${escapeHtml(findings.title)}</div>
            <div style="font-size:11px; color:var(--color-text-muted);">How real problems on this server were tracked down: the failing drive, hidden volumes, port clashes, and more.</div>
          </div>` : ''}
        <a class="profile-card" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" style="${cardStyle} text-decoration:none; color:inherit;">
          <div style="font-weight:bold; margin-bottom:6px;">&#x1F4BB; Source code on GitHub &#x2197;</div>
          <div style="font-size:11px; color:var(--color-text-muted);">${escapeHtml(REPO_URL.replace(/^https:\/\//, ''))}: code, change history, and every doc here.</div>
        </a>
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
    const sourceUrl = `${REPO_URL}/blob/${REPO_BRANCH}/docs/${encodeURIComponent(filename)}`;
    root.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:15px;">
        <button class="btn small" data-action="back-to-index">&larr; All docs</button>
        <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer" style="font-size:12px; color:var(--color-text-muted);">View on GitHub &#x2197;</a>
      </div>
      <div class="week-block doc-body">${renderMarkdown(data.content)}</div>
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
      if (svgEl) {
        makeSvgDraggable(svgEl);
        initSvgZoomControls(el, svgEl);
      }
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

// The generated SVG has a `viewBox` but no fixed width/height, so it
// already stretches to fill its container -- which is exactly why text
// goes tiny on a narrow phone: the whole diagram (built for a wide
// desktop view) gets scaled down to fit. Rather than fighting that with
// CSS, this zooms by shrinking/shifting the viewBox itself, so it stays
// perfectly coordinated with makeSvgDraggable()'s own coordinate math
// (getScreenCTM() already accounts for whatever viewBox is active) with
// zero changes needed there. Buttons are the primary, always-discoverable
// control; wheel (desktop) and pinch (mobile) are convenience shortcuts
// for the same underlying zoomBy()/panBy().
function initSvgZoomControls(container, svgEl) {
  const [origMinX, origMinY, origW, origH] = (svgEl.getAttribute('viewBox') || '0 0 800 600')
    .split(/\s+/).map(Number);
  let vb = { minX: origMinX, minY: origMinY, w: origW, h: origH };
  const MIN_SCALE = 1; // the original viewBox already shows the whole diagram -- no reason to zoom out past that
  const MAX_SCALE = 8;

  const currentScale = () => origW / vb.w;
  const applyViewBox = () => svgEl.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`);

  // Keeps the visible viewBox from panning past the diagram's own edges
  // -- past there is just the container's padding, nothing to see.
  const clampPan = () => {
    vb.minX = Math.max(origMinX, Math.min(origMinX + origW - vb.w, vb.minX));
    vb.minY = Math.max(origMinY, Math.min(origMinY + origH - vb.h, vb.minY));
  };

  // Screen pixels -> the SVG's own coordinate space, using whichever
  // viewBox is in effect right now -- needed so "zoom toward this point"
  // keeps that exact point stationary under the cursor/fingers.
  function screenToSvgPoint(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    return {
      x: vb.minX + ((clientX - rect.left) / rect.width) * vb.w,
      y: vb.minY + ((clientY - rect.top) / rect.height) * vb.h,
    };
  }

  function zoomBy(factor, clientX, clientY) {
    const focal = screenToSvgPoint(clientX, clientY);
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, currentScale() * factor));
    const newW = origW / newScale;
    const newH = origH / newScale;
    vb.minX = focal.x - (focal.x - vb.minX) * (newW / vb.w);
    vb.minY = focal.y - (focal.y - vb.minY) * (newH / vb.h);
    vb.w = newW;
    vb.h = newH;
    clampPan();
    applyViewBox();
  }

  function panBy(dxPixels, dyPixels) {
    const rect = container.getBoundingClientRect();
    vb.minX -= (dxPixels / rect.width) * vb.w;
    vb.minY -= (dyPixels / rect.height) * vb.h;
    clampPan();
    applyViewBox();
  }

  function resetZoom() {
    vb = { minX: origMinX, minY: origMinY, w: origW, h: origH };
    applyViewBox();
  }

  const controls = document.createElement('div');
  controls.className = 'svg-zoom-controls';
  controls.innerHTML = `
    <button type="button" data-zoom="in" title="Zoom in">+</button>
    <button type="button" data-zoom="out" title="Zoom out">&minus;</button>
    <button type="button" data-zoom="reset" title="Reset view">&#x21BA;</button>
  `;
  container.appendChild(controls);
  controls.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-zoom]');
    if (!btn) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (btn.dataset.zoom === 'in') zoomBy(1.4, cx, cy);
    else if (btn.dataset.zoom === 'out') zoomBy(1 / 1.4, cx, cy);
    else resetZoom();
  });

  // Desktop: wheel zooms toward the cursor.
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
  }, { passive: false });

  // Mobile: pinch (two fingers) zooms, drag (one finger, not on a node --
  // makeSvgDraggable() owns that case) pans. Both tracked through the
  // same pointer map so a second finger landing mid-drag hands off from
  // panning to pinching smoothly instead of the two features fighting.
  const pointers = new Map();
  let lastPinchDist = null;
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const pinchMidpoint = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  container.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-node-id]') || e.target.closest('.svg-zoom-controls')) return;
    container.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) lastPinchDist = pinchDistance();
  });

  container.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const dist = pinchDistance();
      const mid = pinchMidpoint();
      if (lastPinchDist) zoomBy(dist / lastPinchDist, mid.x, mid.y);
      lastPinchDist = dist;
    } else if (pointers.size === 1) {
      panBy(e.clientX - prev.x, e.clientY - prev.y);
    }
  });

  const releasePointer = (e) => {
    pointers.delete(e.pointerId);
    lastPinchDist = pointers.size === 2 ? pinchDistance() : null;
  };
  container.addEventListener('pointerup', releasePointer);
  container.addEventListener('pointercancel', releasePointer);
  container.addEventListener('pointerleave', releasePointer);
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
