// streams.js -- multi-profile media player: YouTube links + local uploads,
// unified player abstraction, resume tracking, checkpoints, sleep timer.
import { registerApp, onViewLeave, showStatusModal, hideStatusModal,
         showConfirmModal, showErrorBanner, clearErrorBanner, escapeHtml } from './core.js';

let audiobookProfiles = [];
let activeProfile = localStorage.getItem('audiobook_profile') || null;
let audiobookLibrary = [];
let ytApiReady = false;
let ytPendingInit = null;
let ytPlayers = {};
let ytIntervals = {};
let sleepTimerCountdowns = {};

window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
  if (ytPendingInit) {
    const fn = ytPendingInit;
    ytPendingInit = null;
    fn();
  }
};

function formatSeconds(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function parseTimeToSeconds(text) {
  const parts = text.trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function getYouTubeId(url) {
  if (!url) return null;
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function stopAudiobookPlayer() {
  Object.keys(ytPlayers).forEach(id => stopBookPlayer(id));
}

async function loadAudiobookProfiles() {
  try {
    const res = await fetch('/data/audiobook-profiles');
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    audiobookProfiles = data.profiles || [];
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load profiles', err);
    audiobookProfiles = [];
    showErrorBanner("Couldn't reach the server to load profiles. Check that it's running and try again.");
  }

  if (activeProfile && !audiobookProfiles.includes(activeProfile)) {
    activeProfile = null;
    localStorage.removeItem('audiobook_profile');
  }

  if (activeProfile) {
    renderAudiobooksMain();
  } else {
    renderProfilePicker();
  }
}

function renderProfilePicker() {
  const root = document.getElementById('audiobooks-root');
  root.innerHTML = `
    <div class="week-block">
      <h3>Who's watching?</h3>
      <div class="profile-picker-grid">
        ${audiobookProfiles.map(p => `
          <div class="profile-card" data-action="select-profile" data-profile="${escapeHtml(p)}">
            <div class="profile-card-actions">
              <span class="profile-card-icon" data-action="rename-profile" data-profile="${escapeHtml(p)}" title="Rename">&#x270E;</span>
              <span class="profile-card-icon del" data-action="delete-profile" data-profile="${escapeHtml(p)}" title="Delete">&#x1F5D1;</span>
            </div>
            ${escapeHtml(p)}
          </div>
        `).join('')}
        <div class="profile-card add-card" data-action="add-profile" title="Add profile">+</div>
      </div>
    </div>
  `;
}

async function addAudiobookProfilePrompt() {
  const name = prompt('New profile name:');
  if (!name || !name.trim()) return;
  try {
    const res = await fetch('/api/audiobook-add-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal(data.error || 'Failed to add profile.', 'error'); return; }
    await loadAudiobookProfiles();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function renameAudiobookProfile(oldName) {
  const newName = prompt('New name for "' + oldName + '":', oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;
  try {
    const res = await fetch('/api/audiobook-rename-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old: oldName, new: newName.trim() })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal(data.error || 'Failed to rename.', 'error'); return; }
    if (activeProfile === oldName) {
      activeProfile = newName.trim();
      localStorage.setItem('audiobook_profile', activeProfile);
    }
    await loadAudiobookProfiles();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function deleteAudiobookProfile(name) {
  if (!(await showConfirmModal(`Delete "${name}" and all of their streaming history? This cannot be undone.`))) return;
  try {
    const res = await fetch('/api/audiobook-delete-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal(data.error || 'Failed to delete.', 'error'); return; }
    if (activeProfile === name) {
      activeProfile = null;
      localStorage.removeItem('audiobook_profile');
    }
    await loadAudiobookProfiles();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function selectProfile(name) {
  activeProfile = name;
  localStorage.setItem('audiobook_profile', name);
  renderAudiobooksMain();
}

function switchProfile() {
  stopAudiobookPlayer();
  activeProfile = null;
  localStorage.removeItem('audiobook_profile');
  loadAudiobookProfiles();
}

function renderAudiobooksMain() {
  const root = document.getElementById('audiobooks-root');
  root.innerHTML = `
    <div class="profile-bar">
      <div class="who">Watching as <b>${escapeHtml(activeProfile)}</b></div>
      <button class="btn small" data-action="switch-profile">Switch Profile</button>
    </div>
    <div class="week-block">
      <h3>Add a Stream</h3>
      <div class="book-input-row">
        <input type="text" id="new-book-url" placeholder="Paste YouTube link...">
        <button class="btn" data-action="add-stream">Add</button>
      </div>
      <div class="dropzone" id="dropzone">
        &#x1F4C1; Drag & drop a local audio or video file here, or click to browse
        <input type="file" id="local-file-input" accept="audio/*,video/*">
      </div>
      <p style="color:var(--color-warning); font-size:12px; margin-top:6px;">&#x26A0; Local uploads are shared with everyone — every profile can see and play them, but each person's watch progress is tracked separately.</p>
      <div class="upload-progress" id="upload-progress"></div>
    </div>
    <div id="recent-panel"></div>
    <div id="history-panel"></div>
    <div id="local-panel"></div>
  `;
  setupDropzone();
  loadAudiobookLibrary();
}

function setupDropzone() {
  const zone = document.getElementById('dropzone');
  const input = document.getElementById('local-file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleLocalFileSelected(e.dataTransfer.files[0]);
    }
  });
  input.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleLocalFileSelected(e.target.files[0]);
    }
    input.value = '';
  });
}

function handleLocalFileSelected(file) {
  const defaultTitle = file.name.replace(/\.[^/.]+$/, '');
  const title = prompt('Title for this stream:', defaultTitle);
  if (!title || !title.trim()) return;
  uploadLocalFile(file, title.trim());
}

function uploadLocalFile(file, title) {
  const ext = (file.name.split('.').pop() || 'mp3').toLowerCase();
  const url = `/api/audiobook-upload-local?profile=${encodeURIComponent(activeProfile)}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent(ext)}`;

  const progressEl = document.getElementById('upload-progress');
  progressEl.style.display = 'block';
  progressEl.textContent = 'Uploading... 0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', url);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressEl.textContent = `Uploading... ${pct}%`;
    }
  };

  xhr.onload = () => {
    progressEl.style.display = 'none';
    if (xhr.status >= 200 && xhr.status < 300) {
      loadAudiobookLibrary();
    } else {
      let msg = 'Upload failed.';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
      showStatusModal(msg, 'error');
    }
  };

  xhr.onerror = () => {
    progressEl.style.display = 'none';
    showStatusModal('Upload failed due to a network error.', 'error');
  };

  xhr.send(file);
}

async function loadAudiobookLibrary() {
  try {
    const res = await fetch(`/data/audiobook-library?profile=${encodeURIComponent(activeProfile)}`);
    if (!res.ok) throw new Error('server responded ' + res.status);
    const data = await res.json();
    const youtubeLibrary = data.library || [];
    const localLibrary = data.local || [];
    audiobookLibrary = [...youtubeLibrary, ...localLibrary];
    const recent = data.recent || [];
    renderBookSection('recent-panel', 'Recently Played', recent, true);
    renderBookSection('local-panel', 'Local Files', localLibrary, false, 'No local files uploaded yet. Drop one above to share it with everyone.');
    renderBookSection('history-panel', 'History', [...youtubeLibrary].reverse(), false, 'No streams added yet.');
    clearErrorBanner();
  } catch (err) {
    console.error('Failed to load audiobook library', err);
    showErrorBanner("Couldn't reach the server to load your streams. Check that it's running and try again.");
  }
}

function renderBookSection(elementId, title, books, hideWhenEmpty, emptyMsg) {
  const el = document.getElementById(elementId);
  if (books.length === 0) {
    if (hideWhenEmpty) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="week-block"><h3>${title}</h3><p class="no-book-msg">${emptyMsg || 'No streams added yet.'}</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="week-block">
      <h3>${title}</h3>
      ${books.map(b => renderBookCard(b)).join('')}
    </div>
  `;
}

function renderBookCard(b) {
  const isLocal = b.source === 'local';
  const videoId = isLocal ? null : getYouTubeId(b.url);
  const thumb = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : '';
  const posLabel = b.resume_seconds > 0 ? `Resumes at ${formatSeconds(b.resume_seconds)}` : 'Not started';
  const stopLabel = b.stop_seconds ? ` &middot; Stops at ${formatSeconds(b.stop_seconds)}` : '';
  const history = b.resume_history || [];
  return `
    <div class="book-card" id="card-${b.id}">
      <div class="book-card-header" data-book-id="${b.id}">
        ${isLocal
          ? `<div class="book-thumb-local">${b.media_type === 'video' ? '&#x1F3AC;' : '&#x1F3A7;'}</div>`
          : (thumb ? `<img class="book-thumb" src="${thumb}">` : `<div class="book-thumb"></div>`)}
        <div class="book-card-info">
          <div class="btitle">${escapeHtml(b.title)}${isLocal ? ' <span style="color:var(--color-text-muted); font-weight:normal; font-size:11px;">(Local)</span>' : ''}</div>
          <div class="bmeta" id="bmeta-${b.id}">${posLabel}${stopLabel}</div>
        </div>
        <div class="book-card-expand-icon" id="expand-icon-${b.id}">&#x25BC;</div>
      </div>
      <div class="book-card-body" id="body-${b.id}">
        <div id="player-wrap-${b.id}"></div>
        <p class="autosave-note">Your spot is saved automatically while this plays.</p>
        ${b.description ? `
          <div>
            <div class="book-description" id="desc-${b.id}">${escapeHtml(b.description)}</div>
            <span class="desc-toggle" data-action="toggle-description" data-book-id="${b.id}" id="desc-toggle-${b.id}">Show more</span>
          </div>
        ` : ''}
        <details class="stream-details-toggle">
          <summary>Stream Details</summary>
          <div class="stream-details-body">
            <div class="details-section">
              <div class="last-saved-note" id="last-saved-${b.id}">Last saved: not yet this session</div>
              <div class="resume-position-note" id="resume-position-${b.id}">${b.resume_seconds > 0 ? `Resuming from ${formatSeconds(b.resume_seconds)}` : ''}</div>
              <div class="manual-save-row">
                <button class="btn small" data-action="manual-save-now" data-book-id="${b.id}">Save current position</button>
                <span class="lbl">or type a time:</span>
                <input type="text" id="manual-save-input-${b.id}" placeholder="h:mm:ss">
                <button class="btn small" data-action="manual-save-typed" data-book-id="${b.id}">Save this</button>
              </div>
            </div>
            ${history.length > 0 ? `
              <div class="details-section">
                <span class="lbl" style="margin-bottom:6px; display:block;">Previous spots (revert if needed):</span>
                ${history.map(h => `
                  <div class="checkpoint-row">
                    <button class="btn small" data-action="revert-checkpoint" data-book-id="${b.id}" data-seconds="${h.seconds}">Revert to ${formatSeconds(h.seconds)}</button>
                    <span class="checkpoint-time">${escapeHtml(h.time)}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            <div class="details-section">
              <div class="sleep-timer-row" id="timer-row-${b.id}">
                <span class="lbl">Sleep timer:</span>
                <button class="btn small" data-action="set-sleep-timer" data-book-id="${b.id}" data-minutes="15">15m</button>
                <button class="btn small" data-action="set-sleep-timer" data-book-id="${b.id}" data-minutes="30">30m</button>
                <button class="btn small" data-action="set-sleep-timer" data-book-id="${b.id}" data-minutes="45">45m</button>
                <button class="btn small" data-action="set-sleep-timer" data-book-id="${b.id}" data-minutes="60">60m</button>
                <input type="number" class="custom-timer-input" id="custom-timer-${b.id}" placeholder="min" min="1">
                <button class="btn small" data-action="set-custom-sleep-timer" data-book-id="${b.id}">Set</button>
                <button class="btn small clear" data-action="cancel-sleep-timer" data-book-id="${b.id}">Cancel</button>
              </div>
              <div class="sleep-timer-active" id="timer-active-${b.id}"></div>
            </div>
            ${b.chapters && b.chapters.length > 0 ? `
              <div class="details-section">
                <span class="lbl" style="margin-bottom:6px; display:block;">Chapters:</span>
                ${b.chapters.map(c => `
                  <div class="btn small" style="text-align:left; margin-bottom:4px;" data-action="seek-chapter" data-book-id="${b.id}" data-seconds="${c.start_seconds}">
                    ${formatSeconds(c.start_seconds)} — ${escapeHtml(c.title)}
                  </div>
                `).join('')}
              </div>
            ` : ''}
            ${b.comments && b.comments.length > 0 ? `
              <div class="details-section">
                <span class="lbl" style="margin-bottom:6px; display:block;">Top Comments:</span>
                ${b.comments.map(c => `
                  <div class="book-comment">
                    <div class="comment-author">${escapeHtml(c.author)}</div>
                    <div>${escapeHtml(c.text)}</div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
            <div class="details-section">
              <div class="book-controls-row">
                ${!isLocal ? `<a class="btn small" href="${b.url}" target="_blank">Open in YouTube</a>` : ''}
                <button class="icon-btn-delete" data-action="delete-audiobook" data-book-id="${b.id}" title="Delete">&#x1F5D1;</button>
              </div>
            </div>
          </div>
        </details>
      </div>
    </div>
  `;
}

function toggleDescription(bookId) {
  const el = document.getElementById('desc-' + bookId);
  const toggle = document.getElementById('desc-toggle-' + bookId);
  if (!el) return;
  const isExpanded = el.classList.toggle('expanded');
  toggle.textContent = isExpanded ? 'Show less' : 'Show more';
}

async function toggleBookCard(bookId) {
  const body = document.getElementById('body-' + bookId);
  const icon = document.getElementById('expand-icon-' + bookId);
  const isOpen = body.classList.contains('open');

  Object.keys(ytPlayers).forEach(id => {
    if (id !== bookId) collapseBookCard(id);
  });

  if (isOpen) {
    collapseBookCard(bookId);
    return;
  }

  body.classList.add('open');
  icon.innerHTML = '&#x25B2;';

  try {
    await fetch('/api/audiobook-record-checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookId })
    });
  } catch (err) {
    console.error('Failed to record checkpoint', err);
  }

  const book = audiobookLibrary.find(x => x.id === bookId);
  if (!book) return;
  const startSeconds = book.resume_seconds || 0;

  if (book.source === 'local') {
    startLocalPlayer(bookId, startSeconds);
  } else {
    const videoId = getYouTubeId(book.url);
    if (videoId) startYouTubePlayer(bookId, videoId, startSeconds);
  }
}

function collapseBookCard(bookId) {
  const body = document.getElementById('body-' + bookId);
  const icon = document.getElementById('expand-icon-' + bookId);
  if (body) body.classList.remove('open');
  if (icon) icon.innerHTML = '&#x25BC;';
  stopBookPlayer(bookId);
}

function stopBookPlayer(bookId) {
  if (ytIntervals[bookId]) {
    clearInterval(ytIntervals[bookId]);
    delete ytIntervals[bookId];
  }
  if (sleepTimerCountdowns[bookId]) {
    clearInterval(sleepTimerCountdowns[bookId]);
    delete sleepTimerCountdowns[bookId];
  }
  const player = ytPlayers[bookId];
  if (player) {
    if (player.getCurrentTime) {
      autosaveBookPosition(bookId);
    }
    try { player.destroy(); } catch (e) {}
    delete ytPlayers[bookId];
  }
}

function startYouTubePlayer(bookId, videoId, startSeconds) {
  const wrap = document.getElementById('player-wrap-' + bookId);
  wrap.innerHTML = `<div class="yt-player-wrap"><div id="yt-player-${bookId}"></div></div>`;

  const createPlayer = () => {
    ytPlayers[bookId] = new YT.Player('yt-player-' + bookId, {
      videoId: videoId,
      playerVars: { start: Math.floor(startSeconds), rel: 0 },
      events: {
        onReady: () => {
          ytIntervals[bookId] = setInterval(() => autosaveBookPosition(bookId), 15000);
        },
        onStateChange: (event) => {
          if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
            autosaveBookPosition(bookId);
          }
        }
      }
    });
  };
  if (ytApiReady && window.YT && window.YT.Player) {
    createPlayer();
  } else {
    ytPendingInit = createPlayer;
  }
}

// --- LOCAL STREAMS: wraps a native <audio> element to match the YT.Player
// interface (getCurrentTime/seekTo/pauseVideo/destroy) so every existing
// resume/sleep-timer/checkpoint function works unchanged for either source. ---

function startLocalPlayer(bookId, startSeconds) {
  const book = audiobookLibrary.find(x => x.id === bookId);
  const isVideo = book && book.media_type === 'video';
  const wrap = document.getElementById('player-wrap-' + bookId);

  wrap.innerHTML = isVideo
    ? `<div class="yt-player-wrap"><video id="local-audio-${bookId}" controls preload="metadata" style="position:absolute; top:0; left:0; width:100%; height:100%;"></video></div>`
    : `<div class="local-player-wrap"><audio id="local-audio-${bookId}" controls preload="metadata"></audio></div>`;

  const mediaEl = document.getElementById('local-audio-' + bookId);
  mediaEl.src = `/data/local-audio?id=${bookId}`;

  const wrapper = {
    el: mediaEl,
    getCurrentTime: () => mediaEl.currentTime,
    seekTo: (seconds) => { mediaEl.currentTime = seconds; },
    pauseVideo: () => mediaEl.pause(),
    destroy: () => {
      mediaEl.pause();
      mediaEl.src = '';
    }
  };
  ytPlayers[bookId] = wrapper;

  mediaEl.addEventListener('loadedmetadata', () => {
    if (startSeconds > 0) mediaEl.currentTime = startSeconds;
  });
  mediaEl.addEventListener('pause', () => autosaveBookPosition(bookId));
  mediaEl.addEventListener('ended', () => autosaveBookPosition(bookId));

  ytIntervals[bookId] = setInterval(() => autosaveBookPosition(bookId), 15000);
}

// --- end LOCAL STREAMS ---

function updateSaveUI(bookId, seconds) {
  const book = audiobookLibrary.find(x => x.id === bookId);
  if (book) book.resume_seconds = seconds;

  const savedEl = document.getElementById('last-saved-' + bookId);
  if (savedEl) savedEl.textContent = 'Last saved: ' + new Date().toLocaleTimeString();

  const resumeEl = document.getElementById('resume-position-' + bookId);
  if (resumeEl) resumeEl.textContent = `Resuming from ${formatSeconds(seconds)}`;

  const metaEl = document.getElementById('bmeta-' + bookId);
  if (metaEl) {
    const stopLabel = book && book.stop_seconds ? ` \u00b7 Stops at ${formatSeconds(book.stop_seconds)}` : '';
    metaEl.textContent = `Resumes at ${formatSeconds(seconds)}${stopLabel}`;
  }
}

async function autosaveBookPosition(bookId) {
  const player = ytPlayers[bookId];
  if (!player || !player.getCurrentTime) return;
  const seconds = Math.floor(player.getCurrentTime());
  if (!seconds || seconds < 1) return;

  const book = audiobookLibrary.find(x => x.id === bookId);
  if (book && book.stop_seconds && seconds >= book.stop_seconds) {
    player.pauseVideo();
    stopBookPlayer(bookId);
  }

  try {
    await fetch('/api/audiobook-update-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookId, resume_seconds: seconds })
    });
    updateSaveUI(bookId, seconds);
  } catch (err) {
    console.error('Autosave failed', err);
  }
}

async function manualSaveNow(bookId) {
  const player = ytPlayers[bookId];
  if (!player || !player.getCurrentTime) {
    showStatusModal('Start playing this stream first, then you can save your position.', 'error');
    return;
  }
  const seconds = Math.floor(player.getCurrentTime());
  try {
    const res = await fetch('/api/audiobook-update-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookId, resume_seconds: seconds })
    });
    if (!res.ok) { showStatusModal('Failed to save.', 'error'); return; }
    updateSaveUI(bookId, seconds);
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function manualSaveTyped(bookId) {
  const input = document.getElementById('manual-save-input-' + bookId);
  const seconds = parseTimeToSeconds(input.value);
  if (seconds === null) {
    showStatusModal('Enter a time like 45, 12:30, or 1:23:45', 'error');
    return;
  }
  try {
    const res = await fetch('/api/audiobook-update-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookId, resume_seconds: seconds, profile: activeProfile })
    });
    if (!res.ok) { showStatusModal('Failed to save.', 'error'); return; }
    updateSaveUI(bookId, seconds);
    const player = ytPlayers[bookId];
    if (player && player.seekTo) {
      player.seekTo(seconds, true);
    }
    input.value = '';
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function seekToChapter(bookId, startSeconds) {
  const player = ytPlayers[bookId];
  if (player && player.seekTo) {
    player.seekTo(startSeconds, true);
  }
}

async function revertCheckpoint(bookId, seconds) {
  if (!(await showConfirmModal(`Revert to ${formatSeconds(seconds)}? This will replace your current saved spot.`))) return;
  try {
    const res = await fetch('/api/audiobook-revert-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookId, seconds, profile: activeProfile })
    });
    if (!res.ok) { showStatusModal('Failed to revert.', 'error'); return; }
    const player = ytPlayers[bookId];
    if (player && player.seekTo) {
      player.seekTo(seconds, true);
    }
    await loadAudiobookLibrary();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function setCustomSleepTimer(bookId) {
  const input = document.getElementById('custom-timer-' + bookId);
  const minutes = parseInt(input.value, 10);
  if (!minutes || minutes <= 0) {
    showStatusModal('Enter a number of minutes greater than 0.', 'error');
    return;
  }
  setSleepTimer(bookId, minutes);
}

function setSleepTimer(bookId, minutes) {
  const player = ytPlayers[bookId];
  if (!player || !player.getCurrentTime) {
    showStatusModal('Start playing first, then set a sleep timer.', 'error');
    return;
  }
  const currentSeconds = Math.floor(player.getCurrentTime());
  const stopAt = currentSeconds + minutes * 60;

  fetch('/api/audiobook-set-stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: bookId, stop_seconds: stopAt, profile: activeProfile })
  }).catch(err => console.error('Failed to set sleep timer', err));

  const book = audiobookLibrary.find(x => x.id === bookId);
  if (book) book.stop_seconds = stopAt;

  if (sleepTimerCountdowns[bookId]) clearInterval(sleepTimerCountdowns[bookId]);

  const updateDisplay = () => {
    const p = ytPlayers[bookId];
    const el = document.getElementById('timer-active-' + bookId);
    if (!p || !el) { clearInterval(sleepTimerCountdowns[bookId]); return; }
    const remaining = stopAt - Math.floor(p.getCurrentTime());
    if (remaining <= 0) {
      el.textContent = 'Stopping...';
      clearInterval(sleepTimerCountdowns[bookId]);
      delete sleepTimerCountdowns[bookId];
      return;
    }
    el.textContent = `Sleep timer: stops in ${formatSeconds(remaining)}`;
  };
  updateDisplay();
  sleepTimerCountdowns[bookId] = setInterval(updateDisplay, 1000);
}

async function cancelSleepTimer(bookId) {
  if (sleepTimerCountdowns[bookId]) {
    clearInterval(sleepTimerCountdowns[bookId]);
    delete sleepTimerCountdowns[bookId];
  }
  const el = document.getElementById('timer-active-' + bookId);
  if (el) el.textContent = '';

  const book = audiobookLibrary.find(x => x.id === bookId);
  if (book) book.stop_seconds = null;

  try {
    await fetch('/api/audiobook-set-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookId, stop_seconds: null, profile: activeProfile })
    });
  } catch (err) {
    console.error('Failed to cancel sleep timer', err);
  }
}

async function addAudiobook() {
  const input = document.getElementById('new-book-url');
  const url = input.value.trim();
  if (!url) { showStatusModal('Paste a YouTube link first.', 'error'); return; }
  showStatusModal('Fetching video info (title, chapters, comments)...', 'loading');
  try {
    const res = await fetch('/api/audiobook-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, profile: activeProfile })
    });
    const data = await res.json();
    if (!res.ok) { showStatusModal('Failed: ' + (data.error || res.status), 'error'); return; }
    input.value = '';
    hideStatusModal();
    await loadAudiobookLibrary();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

async function deleteAudiobook(bookId) {
  if (!(await showConfirmModal('Remove this stream from your history?'))) return;
  stopBookPlayer(bookId);
  try {
    const res = await fetch('/api/audiobook-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bookId, profile: activeProfile })
    });
    if (!res.ok) { showStatusModal('Failed to delete.', 'error'); return; }
    await loadAudiobookLibrary();
  } catch (err) {
    showStatusModal('Error: ' + err, 'error');
  }
}

function wireDelegatedListeners() {
  const root = document.getElementById('audiobooks-root');
  root.addEventListener('click', (e) => {
    const renameIcon = e.target.closest('[data-action="rename-profile"]');
    if (renameIcon) { e.stopPropagation(); renameAudiobookProfile(renameIcon.dataset.profile); return; }

    const deleteIcon = e.target.closest('[data-action="delete-profile"]');
    if (deleteIcon) { e.stopPropagation(); deleteAudiobookProfile(deleteIcon.dataset.profile); return; }

    const addProfileCard = e.target.closest('[data-action="add-profile"]');
    if (addProfileCard) { addAudiobookProfilePrompt(); return; }

    const profileCard = e.target.closest('[data-action="select-profile"]');
    if (profileCard) { selectProfile(profileCard.dataset.profile); return; }

    const switchBtn = e.target.closest('[data-action="switch-profile"]');
    if (switchBtn) { switchProfile(); return; }

    const addStreamBtn = e.target.closest('[data-action="add-stream"]');
    if (addStreamBtn) { addAudiobook(); return; }

    const header = e.target.closest('.book-card-header');
    if (header) { toggleBookCard(header.dataset.bookId); return; }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const bookId = btn.dataset.bookId;
    switch (btn.dataset.action) {
      case 'toggle-description': toggleDescription(bookId); break;
      case 'manual-save-now': manualSaveNow(bookId); break;
      case 'manual-save-typed': manualSaveTyped(bookId); break;
      case 'revert-checkpoint': revertCheckpoint(bookId, parseInt(btn.dataset.seconds, 10)); break;
      case 'set-sleep-timer': setSleepTimer(bookId, parseInt(btn.dataset.minutes, 10)); break;
      case 'set-custom-sleep-timer': setCustomSleepTimer(bookId); break;
      case 'cancel-sleep-timer': cancelSleepTimer(bookId); break;
      case 'seek-chapter': seekToChapter(bookId, parseInt(btn.dataset.seconds, 10)); break;
      case 'delete-audiobook': deleteAudiobook(bookId); break;
    }
  });
}

let listenersWired = false;

registerApp('audiobooks', {
  title: '&#x1F3A7; Streams',
  bodyHtml: `<div id="conn-error-banner" class="error-banner"></div><div id="audiobooks-root"></div>`,
  onRender: () => {
    if (!listenersWired) {
      wireDelegatedListeners();
      listenersWired = true;
    }
    loadAudiobookProfiles();
  },
});

onViewLeave((nextAppKey) => {
  if (nextAppKey !== 'audiobooks') stopAudiobookPlayer();
});