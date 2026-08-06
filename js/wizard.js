// wizard.js -- first-time setup wizard. Self-contained: checks
// /data/setup-status on page load and, if incomplete, injects a banner
// above the grid with a 2-step flow (Mealie token, Streams profile).
// Deliberately does not modify core.js -- adding this feature only
// required this one new file plus its own <script> tag.

async function checkSetupStatus() {
  try {
    const res = await fetch('/data/setup-status');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.setup_complete) {
      showWizardBanner(data);
    }
  } catch (err) {
    console.error('Failed to check setup status', err);
  }
}

function showWizardBanner(status) {
  const gridView = document.getElementById('grid-view');
  const banner = document.createElement('div');
  banner.id = 'wizard-banner';
  banner.className = 'week-block';
  banner.style.borderLeft = '4px solid var(--color-warning-border)';
  banner.innerHTML = `
    <h3>&#x1F527; Finish setup</h3>
    <p style="color:var(--color-text-dim); font-size:14px;">
      A couple of things need to be set up before Mealie and Streams are fully ready.
    </p>
    <div id="wizard-steps"></div>
  `;
  gridView.insertBefore(banner, gridView.firstChild.nextSibling);
  renderWizardSteps(status);
}

function renderWizardSteps(status) {
  const el = document.getElementById('wizard-steps');
  const mealieDone = status.mealie_token_valid;
  const profileDone = status.has_streams_profile;

  el.innerHTML = `
    <div class="preview-row">
      <span class="date">${mealieDone ? '&#x2705;' : '&#x2B1C;'} Mealie API token</span>
      ${!mealieDone ? `
        <input type="text" id="wizard-mealie-token" placeholder="Paste your Mealie API token" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        <button class="btn small" data-action="save-token">Save</button>
      ` : `<span style="color:var(--color-text-muted); font-size:13px;">Connected</span>`}
    </div>
    <div class="preview-row">
      <span class="date">${profileDone ? '&#x2705;' : '&#x2B1C;'} First Streams profile</span>
      ${!profileDone ? `
        <input type="text" id="wizard-profile-name" placeholder="e.g. your name" style="flex:1; background:var(--color-bg); color:white; border:1px solid var(--color-border); padding:8px; border-radius:4px;">
        <button class="btn small" data-action="create-profile">Create</button>
      ` : `<span style="color:var(--color-text-muted); font-size:13px;">Created</span>`}
    </div>
    ${mealieDone && profileDone ? `
      <p style="color:var(--color-text-dim); font-size:13px; margin-top:10px;">
        All set! This banner will disappear on your next visit.
      </p>
    ` : ''}
  `;
}

async function saveMealieToken() {
  const input = document.getElementById('wizard-mealie-token');
  const token = input.value.trim();
  if (!token) return;
  input.disabled = true;
  try {
    const res = await fetch('/api/save-mealie-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if (data.valid) {
      const statusRes = await fetch('/data/setup-status');
      const status = await statusRes.json();
      renderWizardSteps(status);
    } else {
      alert('That token did not work -- double check it in Mealie under Settings -> API Tokens and try again.');
      input.disabled = false;
    }
  } catch (err) {
    alert('Error: ' + err);
    input.disabled = false;
  }
}

async function createFirstProfile() {
  const input = document.getElementById('wizard-profile-name');
  const name = input.value.trim();
  if (!name) return;
  input.disabled = true;
  try {
    const res = await fetch('/api/audiobook-add-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to create profile.');
      input.disabled = false;
      return;
    }
    const statusRes = await fetch('/data/setup-status');
    const status = await statusRes.json();
    renderWizardSteps(status);
  } catch (err) {
    alert('Error: ' + err);
    input.disabled = false;
  }
}

function wireDelegatedListeners() {
  document.getElementById('grid-view').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="save-token"]')) { saveMealieToken(); return; }
    if (e.target.closest('[data-action="create-profile"]')) { createFirstProfile(); return; }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireDelegatedListeners();
  checkSetupStatus();
});
