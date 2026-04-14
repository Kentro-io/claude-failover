/* Claude Failover Dashboard — app.js */
'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let state = {
  status: null,
  keys: [],
  openaiKeys: [],
  profiles: [],
  config: null,
  setupStatus: null,
  logs: [],
  currentPage: 'status',
  sseConnected: false
};

const content = document.getElementById('content');
const toastContainer = document.createElement('div');
toastContainer.className = 'toast-container';
document.body.appendChild(toastContainer);

// ─── SSE Connection ──────────────────────────────────────────────────────────

let eventSource = null;

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    state.sseConnected = true;
    updateConnectionStatus(true);
  };

  eventSource.addEventListener('status', (e) => {
    state.status = JSON.parse(e.data);
    if (state.currentPage === 'status') renderStatus();
  });

  eventSource.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    state.logs.push(entry);
    if (state.logs.length > 500) state.logs = state.logs.slice(-300);
    if (state.currentPage === 'logs') appendLogEntry(entry);
  });

  eventSource.addEventListener('config', () => {
    // Refresh data on config changes
    loadKeys();
    loadProfiles();
    loadConfig();
  });

  eventSource.addEventListener('cooldowns', () => {
    if (state.currentPage === 'status') loadStatus();
  });

  eventSource.onerror = () => {
    state.sseConnected = false;
    updateConnectionStatus(false);
    setTimeout(connectSSE, 3000);
  };
}

function updateConnectionStatus(connected) {
  const el = document.getElementById('connectionStatus');
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('.status-text');
  if (connected) {
    dot.className = 'status-dot connected';
    text.textContent = 'Connected';
  } else {
    dot.className = 'status-dot error';
    text.textContent = 'Reconnecting...';
  }
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  return res.json();
}

async function loadStatus() {
  state.status = await api('/api/status');
  if (state.currentPage === 'status') renderStatus();
}

async function loadKeys() {
  const profileEl = document.getElementById('keyProfileSelect');
  const profile = profileEl ? profileEl.value : 'default';
  const data = await api(`/api/keys?profile=${encodeURIComponent(profile)}`);
  state.keys = data.keys || [];
  if (state.currentPage === 'keys') renderKeys();
}

async function loadProfiles() {
  const data = await api('/api/profiles');
  state.profiles = data.profiles || [];
  if (state.currentPage === 'profiles') renderProfiles();
}

async function loadOpenAIKeys() {
  const data = await api('/api/openai-keys');
  state.openaiKeys = data.keys || [];
  if (state.currentPage === 'keys') renderKeys();
}

async function loadConfig() {
  state.config = await api('/api/config');
  if (state.currentPage === 'fallback') renderFallback();
}

async function loadSetupStatus() {
  state.setupStatus = await api('/api/setup/status');
  if (state.currentPage === 'setup') renderSetup();
}

async function loadLogs() {
  const data = await api('/api/logs?count=100');
  state.logs = data.logs || [];
  if (state.currentPage === 'logs') renderLogs();
}

// ─── Toast Notifications ─────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── Navigation ──────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    navigateTo(page);
  });
});

function navigateTo(page) {
  state.currentPage = page;
  document.querySelectorAll('.nav-item').forEach(i => {
    i.classList.toggle('active', i.dataset.page === page);
  });

  const renderers = {
    status: () => { loadStatus(); renderStatus(); },
    keys: () => { loadKeys(); loadOpenAIKeys(); renderKeys(); },
    profiles: () => { loadProfiles(); renderProfiles(); },
    fallback: () => { loadConfig(); renderFallback(); },
    setup: () => { loadSetupStatus(); renderSetup(); },
    logs: () => { loadLogs(); renderLogs(); }
  };

  (renderers[page] || renderers.status)();
}

// ─── Render: Status ──────────────────────────────────────────────────────────

function renderStatus() {
  const s = state.status;
  if (!s) {
    content.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⏳</div><div class="empty-state-text">Loading...</div></div>';
    return;
  }

  const m = s.metrics;
  const cooldowns = Object.entries(s.cooldowns || {});

  // Provider breakdown from server metrics
  const anthropicReqs = m.anthropicRequests || 0;
  const openaiReqs = m.openaiRequests || 0;

  content.innerHTML = `
    <h1 class="page-title">Status Overview</h1>
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-value blue">${m.total}</div>
        <div class="metric-label">Total Requests</div>
      </div>
      <div class="metric-card">
        <div class="metric-value green">${m.successRate}%</div>
        <div class="metric-label">Success Rate</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" style="color:#fbbf24">${anthropicReqs}</div>
        <div class="metric-label">Claude (Recent)</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" style="color:#34d399">${openaiReqs}</div>
        <div class="metric-label">OpenAI (Recent)</div>
      </div>
      <div class="metric-card">
        <div class="metric-value amber">${m.retries}</div>
        <div class="metric-label">Retries</div>
      </div>
      <div class="metric-card">
        <div class="metric-value red">${m.failures}</div>
        <div class="metric-label">Failures</div>
      </div>
      <div class="metric-card">
        <div class="metric-value cyan">${m.queued || 0}</div>
        <div class="metric-label">Queued Retries</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${m.modelFallbacks}</div>
        <div class="metric-label">Model Fallbacks</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${formatUptime(s.uptime)}</div>
        <div class="metric-label">Uptime</div>
      </div>
    </div>

    ${cooldowns.length > 0 ? `
      <div class="card">
        <div class="flex-between mb-16">
          <div class="card-title">Active Cooldowns</div>
          <button class="btn btn-sm btn-danger" onclick="clearCooldowns()">Clear All</button>
        </div>
        ${cooldowns.map(([key, cd]) => `
          <div class="cooldown-item">
            <div>
              <span style="color:var(--text-primary)">${escHtml(key)}</span>
            </div>
            <div class="cooldown-timer">${cd.remainingMin}m remaining</div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="card">
      <div class="card-title">Recent Requests</div>
      ${(s.recentRequests && s.recentRequests.length > 0) ? `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Key</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Info</th>
              </tr>
            </thead>
            <tbody>
              ${s.recentRequests.slice().reverse().map(r => `
                <tr>
                  <td class="text-muted">${formatTime(r.timestamp)}</td>
                  <td>${r.provider === 'openai' ? '<span class="provider-badge openai">OpenAI</span>' : '<span class="provider-badge anthropic">Anthropic</span>'}</td>
                  <td>${escHtml(r.model)}</td>
                  <td>${escHtml(r.key)}</td>
                  <td>${statusBadge(r.status, r)}</td>
                  <td>${r.latency}ms</td>
                  <td>${requestInfoBadges(r)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-state"><div class="empty-state-text">No requests yet</div></div>'}
    </div>

    ${Object.keys(m.byModel || {}).length > 0 ? `
      <div class="card">
        <div class="card-title">Requests by Model</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Model</th><th>Requests</th></tr></thead>
            <tbody>
              ${Object.entries(m.byModel).sort((a,b) => b[1]-a[1]).map(([model, count]) => `
                <tr><td>${escHtml(model)}</td><td>${count}</td></tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `;
}

// ─── Render: Keys ────────────────────────────────────────────────────────────

function renderKeys() {
  const keys = state.keys;
  const profileSelect = (state.profiles || []).map(p => p.name);
  const currentProfile = profileSelect[0] || 'default';

  content.innerHTML = `
    <div class="flex-between mb-16">
      <h1 class="page-title" style="margin-bottom:0">API Keys</h1>
      <button class="btn btn-primary" onclick="showAddKeyModal()">+ Add Key</button>
    </div>

    ${keys.length === 0 ? `
      <div class="empty-state">
        <div class="empty-state-icon">🔑</div>
        <div class="empty-state-text">No API keys configured</div>
        <button class="btn btn-primary" onclick="showAddKeyModal()">Add Your First Key</button>
      </div>
    ` : `
      <div class="card">
        <div class="flex-between mb-16">
          <div class="card-title">Anthropic Key Priority Order</div>
          <div class="flex gap-8">
            <select class="form-select" id="keyProfileSelect" style="width:auto;padding:4px 8px;font-size:11px" onchange="loadKeys()">
              ${profileSelect.map(p => `<option value="${p}">${p}</option>`).join('')}
            </select>
          </div>
        </div>
        <div id="keyList">
          ${keys.map((k, i) => renderKeyItem(k, i)).join('')}
        </div>
      </div>
    `}

  `;

  // Append OpenAI keys section
  const openaiKeys = state.openaiKeys || [];
  let openaiHtml = `
    <div class="flex-between mb-16 mt-16">
      <h2 class="page-title" style="margin-bottom:0;font-size:16px">OpenAI Keys (Cross-Provider Fallback)</h2>
      <button class="btn btn-primary" onclick="showAddOpenAIKeyModal()">+ Add OpenAI Key</button>
    </div>
  `;
  if (openaiKeys.length === 0) {
    openaiHtml += '<div class="empty-state"><div class="empty-state-text">No OpenAI keys configured. Add one to enable cross-provider fallback.</div></div>';
  } else {
    openaiHtml += '<div class="card"><div id="openaiKeyList">' +
      openaiKeys.map((k, i) => renderOpenAIKeyItem(k, i)).join('') +
      '</div></div>';
  }
  content.innerHTML += openaiHtml;

  // Setup drag and drop
  setupDragDrop();
}

function renderKeyItem(k, index) {
  return `
    <div class="key-item" data-key-id="${escAttr(k.id)}" data-index="${index}">
      <span class="key-priority">${index + 1}</span>
      <span class="provider-badge anthropic">Anthropic</span>
      <div class="key-info">
        <div class="key-id">${escHtml(k.label)} <span class="text-muted text-sm">(${escHtml(k.id)})</span></div>
        <div class="key-meta">
          ${escHtml(k.masked)} · ${escHtml(k.type)} · ${k.requests} requests
          ${k.inCooldown ? '<span class="badge badge-amber">cooldown</span>' : '<span class="badge badge-green">ready</span>'}
        </div>
      </div>
      <div class="key-actions">
        <button class="btn btn-sm" onclick="testKey('${escAttr(k.id)}')" id="test-${escAttr(k.id)}">Test</button>
        <button class="btn btn-sm btn-danger" onclick="removeKey('${escAttr(k.id)}')">Remove</button>
      </div>
    </div>
  `;
}

function setupDragDrop() {
  // No drag on Keys page — reorder via Profiles page
}

function detectKeyProvider(token) {
  if (token.startsWith('sk-ant-')) return 'anthropic';
  if (token.startsWith('sk-proj-') || token.startsWith('sk-')) return 'openai';
  if (token.startsWith('eyJ')) return 'openai';
  return null;
}

function showAddKeyModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add API Key</div>
      <div class="form-group">
        <label class="form-label">Provider</label>
        <select class="form-select" id="newKeyProvider">
          <option value="">Auto-detect from key</option>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
        <div id="providerDetected" class="text-sm mt-8" style="display:none"></div>
      </div>
      <div class="form-group">
        <label class="form-label">API Key or OAuth Token</label>
        <input class="form-input" id="newKeyToken" placeholder="sk-ant-..., sk-proj-..., or eyJ..." autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Label</label>
        <input class="form-input" id="newKeyLabel" placeholder="e.g., Personal Account">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="addKeyUnified()">Add Key</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const tokenInput = overlay.querySelector('#newKeyToken');
  const providerSelect = overlay.querySelector('#newKeyProvider');
  const detectedEl = overlay.querySelector('#providerDetected');
  tokenInput.addEventListener('input', () => {
    const detected = detectKeyProvider(tokenInput.value.trim());
    if (detected && providerSelect.value === '') {
      detectedEl.style.display = '';
      detectedEl.innerHTML = 'Detected: <span class="provider-badge ' + detected + '">' + (detected === 'anthropic' ? 'Anthropic' : 'OpenAI') + '</span>';
    } else {
      detectedEl.style.display = 'none';
    }
  });
  tokenInput.focus();
}

async function addKeyUnified() {
  const token = document.getElementById('newKeyToken').value.trim();
  const label = document.getElementById('newKeyLabel').value.trim();
  const providerSelect = document.getElementById('newKeyProvider').value;

  if (!token) {
    toast('Please enter an API key', 'error');
    return;
  }

  const provider = providerSelect || detectKeyProvider(token);
  if (!provider) {
    toast('Cannot detect provider. Please select Anthropic or OpenAI.', 'error');
    return;
  }

  if (provider === 'anthropic') {
    if (!token.startsWith('sk-ant-')) {
      toast('Anthropic keys should start with sk-ant-...', 'error');
      return;
    }
    const result = await api('/api/keys', {
      method: 'POST',
      body: { token, label: label || 'Unnamed Key' }
    });
    if (result.error) { toast(result.error, 'error'); return; }
    document.querySelector('.modal-overlay')?.remove();
    toast(`Anthropic key added: ${result.id}`, 'success');
    loadKeys();
  } else {
    const result = await api('/api/openai-keys', {
      method: 'POST',
      body: { token, label: label || 'Unnamed OpenAI Key' }
    });
    if (result.error) { toast(result.error, 'error'); return; }
    document.querySelector('.modal-overlay')?.remove();
    toast(`OpenAI key added: ${result.id}`, 'success');
    loadKeys();
    loadOpenAIKeys();
  }
}

// Keep legacy addKey for backwards compatibility
async function addKey() { return addKeyUnified(); }

async function removeKey(id) {
  if (!confirm(`Remove key "${id}"?`)) return;
  await api(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  toast('Key removed', 'success');
  loadKeys();
}

async function testKey(id) {
  const btn = document.getElementById(`test-${id}`);
  if (btn) { btn.textContent = '...'; btn.disabled = true; }

  const result = await api(`/api/keys/${encodeURIComponent(id)}/test`, { method: 'POST' });

  if (result.valid) {
    toast(`Key "${id}" is valid`, 'success');
    if (btn) btn.textContent = '✓';
  } else {
    toast(`Key "${id}" failed: ${result.error || 'Invalid'}`, 'error');
    if (btn) btn.textContent = '✗';
  }

  setTimeout(() => {
    if (btn) { btn.textContent = 'Test'; btn.disabled = false; }
  }, 2000);
}

// ─── Render: OpenAI Keys ─────────────────────────────────────────────────────

function renderOpenAIKeyItem(k, index) {
  return `
    <div class="key-item" data-key-id="${escAttr(k.id)}" data-index="${index}">
      <span class="key-priority" style="background:var(--green)">${index + 1}</span>
      <span class="provider-badge openai">OpenAI</span>
      <div class="key-info">
        <div class="key-id">${escHtml(k.label)} <span class="text-muted text-sm">(${escHtml(k.id)})</span></div>
        <div class="key-meta">
          ${escHtml(k.masked)} · ${escHtml(k.type)} · ${k.requests} requests
          ${k.inCooldown ? '<span class="badge badge-amber">cooldown</span>' : '<span class="badge badge-green">ready</span>'}
        </div>
      </div>
      <div class="key-actions">
        <button class="btn btn-sm btn-danger" onclick="removeOpenAIKey('${escAttr(k.id)}')">Remove</button>
      </div>
    </div>
  `;
}

function showAddOpenAIKeyModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add OpenAI Key</div>
      <div class="form-group">
        <label class="form-label">API Key or OAuth Token</label>
        <input class="form-input" id="newOpenAIKeyToken" placeholder="sk-..." autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Label</label>
        <input class="form-input" id="newOpenAIKeyLabel" placeholder="e.g., OpenAI Account">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="addOpenAIKey()">Add Key</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#newOpenAIKeyToken').focus();
}

async function addOpenAIKey() {
  const token = document.getElementById('newOpenAIKeyToken').value.trim();
  const label = document.getElementById('newOpenAIKeyLabel').value.trim();

  if (!token) {
    toast('Please enter an API key', 'error');
    return;
  }

  const result = await api('/api/openai-keys', {
    method: 'POST',
    body: { token, label: label || 'Unnamed OpenAI Key' }
  });

  if (result.error) {
    toast(result.error, 'error');
    return;
  }

  document.querySelector('.modal-overlay')?.remove();
  toast(`OpenAI key added: ${result.id}`, 'success');
  loadOpenAIKeys();
}

async function removeOpenAIKey(id) {
  if (!confirm(`Remove OpenAI key "${id}"?`)) return;
  await api(`/api/openai-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  toast('OpenAI key removed', 'success');
  loadOpenAIKeys();
}

// ─── Render: Profiles ────────────────────────────────────────────────────────

function renderProfiles() {
  const profiles = state.profiles;

  content.innerHTML = `
    <div class="flex-between mb-16">
      <div>
        <h1 class="page-title" style="margin-bottom:4px">Profiles</h1>
        <div class="text-muted text-sm">One unified priority list per profile. Put OpenAI first if you want it used first.</div>
      </div>
      <button class="btn btn-primary" onclick="showAddProfileModal()">+ Add Profile</button>
    </div>

    ${profiles.map(p => `
      <div class="card" data-profile="${escAttr(p.name)}">
        <div class="flex-between">
          <div>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">${escHtml(p.name)}</div>
            <div class="text-muted text-sm">Port ${p.port} · ${(p.priorityItems || []).length} total provider slot(s)</div>
          </div>
          <div class="flex gap-8">
            ${p.name !== 'default' ? `<button class="btn btn-sm btn-danger" onclick="deleteProfile('${escAttr(p.name)}')">Delete</button>` : ''}
          </div>
        </div>

        <div style="margin-top:12px;margin-bottom:8px;font-size:13px;font-weight:600">Unified priority order</div>
        <div class="profile-priority-list" data-profile-name="${escAttr(p.name)}">
          ${(p.priorityItems || []).map((item, i) => `
            <div class="profile-key-item" draggable="true" data-priority-item="${escAttr(item.encoded)}" data-index="${i}">
              <span class="drag-handle">⠿</span>
              <span class="provider-badge ${escAttr(item.provider)}">${item.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
              <span class="key-label">${escHtml(item.label || item.id)}</span>
              <span class="text-muted text-sm">${escHtml(item.id)}</span>
            </div>
          `).join('')}
          ${(p.priorityItems || []).length === 0 ? '<div class="text-muted text-sm" style="padding:8px">(no keys in this profile yet)</div>' : ''}
        </div>
      </div>
    `).join('')}
  `;

  document.querySelectorAll('.profile-priority-list').forEach(list => {
    const profileName = list.dataset.profileName;
    let dragItem = null;

    list.querySelectorAll('.profile-key-item').forEach(item => {
      item.addEventListener('dragstart', () => {
        dragItem = item;
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        list.querySelectorAll('.profile-key-item').forEach(i => i.classList.remove('drag-over'));
        dragItem = null;
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (item !== dragItem) item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (!dragItem || dragItem === item) return;
        const items = [...list.querySelectorAll('.profile-key-item')];
        const fromIdx = items.indexOf(dragItem);
        const toIdx = items.indexOf(item);
        if (fromIdx < toIdx) item.after(dragItem);
        else item.before(dragItem);
        const priorityOrder = [...list.querySelectorAll('.profile-key-item')].map(i => i.dataset.priorityItem);
        await api('/api/profiles/priority', { method: 'PUT', body: { profile: profileName, priorityOrder } });
        toast('Priority updated', 'success');
        loadProfiles();
      });
    });
  });
}

function showAddProfileModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Create Profile</div>
      <div class="form-group">
        <label class="form-label">Name</label>
        <input class="form-input" id="newProfileName" placeholder="e.g., cursor">
      </div>
      <div class="form-group">
        <label class="form-label">Port</label>
        <input class="form-input" id="newProfilePort" type="number" placeholder="4081">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="addProfile()">Create</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#newProfileName').focus();
}

async function addProfile() {
  const name = document.getElementById('newProfileName').value.trim();
  const port = document.getElementById('newProfilePort').value.trim();

  if (!name || !port) {
    toast('Name and port are required', 'error');
    return;
  }

  const result = await api('/api/profiles', {
    method: 'POST',
    body: { name, port: parseInt(port, 10) }
  });

  if (result.error) {
    toast(result.error, 'error');
    return;
  }

  document.querySelector('.modal-overlay')?.remove();
  toast(`Profile "${name}" created`, 'success');
  loadProfiles();
}

async function deleteProfile(name) {
  if (!confirm(`Delete profile "${name}"?`)) return;
  await api(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
  toast('Profile deleted', 'success');
  loadProfiles();
}

// ─── Render: Fallback ────────────────────────────────────────────────────────

function renderFallback() {
  const cfg = state.config;
  if (!cfg) {
    content.innerHTML = '<div class="empty-state"><div class="empty-state-text">Loading...</div></div>';
    return;
  }

  // Build ordered chain from modelFallback map: A→B, B→C becomes [A, B, C]
  const fb = cfg.modelFallback || {};
  const chain = buildFallbackChain(fb);
  const cooldownMin = Math.round((cfg.cooldownMs || 3600000) / 60000);
  const queueWaitSec = Math.round((cfg.queueWaitMs ?? 90000) / 1000);

  content.innerHTML = `
    <h1 class="page-title">Fallback & Cooldown</h1>

    <div class="card">
      <div class="flex-between mb-16">
        <div class="card-title">Model Fallback Chain</div>
        <button class="btn btn-sm" onclick="showAddFallbackModel()">+ Add Model</button>
      </div>
      <div id="fallbackChain" class="fallback-chain">
        ${chain.length > 0 ? chain.map((model, i) => `
          <div class="fallback-chain-item" draggable="true" data-model="${escAttr(model)}" data-index="${i}">
            <span class="drag-handle">⠿</span>
            <span class="fallback-chain-label" ondblclick="editFallbackModel(this, '${escAttr(model)}')">${escHtml(model)}</span>
            <button class="btn btn-sm fallback-edit" onclick="editFallbackModel(this.previousElementSibling, '${escAttr(model)}')" title="Edit">✎</button>
            ${i < chain.length - 1 ? '<span class="fallback-chain-arrow">→</span>' : ''}
            <button class="btn btn-sm btn-danger fallback-remove" onclick="removeFallbackModel('${escAttr(model)}')">✕</button>
          </div>
        `).join('') : '<div class="text-muted text-sm" style="padding:8px">No models configured. Add models to build a fallback chain.</div>'}
      </div>
      <p class="text-muted text-sm mt-16">
        Drag to reorder. When all keys are rate-limited for the first model, the proxy tries the next model in the chain.
      </p>
    </div>

    <div class="card">
      <div class="card-title">Queue & Cooldown Settings</div>
      <div class="form-group mt-8">
        <label class="form-label">Queue Wait (seconds) — hold requests when all keys are rate-limited</label>
        <div class="flex gap-8">
          <input class="form-input" id="queueWaitSec" type="number" value="${queueWaitSec}" style="width:120px" min="0" max="300">
          <button class="btn" onclick="saveQueueSettings()">Save</button>
        </div>
      </div>
      <p class="text-muted text-sm mt-8">
        When all keys hit API rate limits, hold the request and retry when a cooldown expires. Set to 0 to disable (fail immediately). Default: 90s.
      </p>
      <div class="form-group mt-16">
        <label class="form-label">Cooldown Duration (minutes)</label>
        <div class="flex gap-8">
          <input class="form-input" id="cooldownMin" type="number" value="${cooldownMin}" style="width:120px">
          <button class="btn" onclick="saveCooldownSettings()">Save</button>
        </div>
      </div>
      <p class="text-muted text-sm mt-8">
        How long to wait before retrying a rate-limited key. The proxy respects retry-after headers when shorter.
      </p>
    </div>

    <div class="card">
      <div class="card-title">OpenAI Cross-Provider Fallback</div>
      <div class="form-group mt-8">
        <label class="form-label" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="openaiEnabled" ${cfg.openaiModelFallback ? 'checked' : ''} onchange="toggleOpenAIFallback(this.checked)">
          Enable OpenAI fallback when all Claude keys are exhausted
        </label>
      </div>
      <div class="form-group mt-16">
        <label class="form-label">OpenAI Base URL</label>
        <div class="flex gap-8">
          <input class="form-input" id="openaiBaseUrl" value="${escAttr(cfg.openaiBaseUrl || 'https://api.openai.com')}" style="flex:1">
          <button class="btn" onclick="saveOpenAIBaseUrl()">Save</button>
        </div>
      </div>
      <div class="form-group mt-16">
        <label class="form-label">Model Mapping (Claude → OpenAI)</label>
        <div id="modelMappingList">
          ${Object.entries(cfg.openaiModelMapping || {}).map(([from, to]) =>
            '<div class="mapping-row"><span class="provider-badge anthropic" style="flex-shrink:0">Claude</span><input class="form-input mapping-from" value="' + escAttr(from) + '" style="flex:1" readonly><span class="mapping-arrow">→</span><span class="provider-badge openai" style="flex-shrink:0">OpenAI</span><input class="form-input mapping-to" value="' + escAttr(to) + '" style="flex:1" data-from="' + escAttr(from) + '" onchange="updateModelMapping(this)"><button class="btn btn-sm btn-danger" onclick="removeModelMapping(\'' + escAttr(from) + '\')">✕</button></div>'
          ).join('')}
        </div>
        <button class="btn btn-sm mt-8" onclick="showAddMappingModal()">+ Add Mapping</button>
      </div>
      <p class="text-muted text-sm mt-8">
        Edit the OpenAI model name to change where Claude requests fall back to. When Claude keys are exhausted and OpenAI fallback is enabled, requests are translated and sent to the mapped OpenAI model.
      </p>
    </div>
  `;

  setupFallbackDragDrop();
}

function buildFallbackChain(fb) {
  // Convert {A:B, B:C} → [A, B, C]
  const targets = new Set(Object.values(fb));
  const starts = Object.keys(fb).filter(k => !targets.has(k) || !fb[Object.keys(fb).find(x => fb[x] === k)]);
  if (starts.length === 0 && Object.keys(fb).length > 0) starts.push(Object.keys(fb)[0]);

  const chain = [];
  const visited = new Set();
  for (const start of starts) {
    let cur = start;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      chain.push(cur);
      cur = fb[cur];
    }
  }
  // Add any orphan targets not in chain
  for (const t of targets) { if (!visited.has(t)) chain.push(t); }
  return chain;
}

function chainToFallbackMap(chain) {
  const fb = {};
  for (let i = 0; i < chain.length - 1; i++) {
    fb[chain[i]] = chain[i + 1];
  }
  return fb;
}

function setupFallbackDragDrop() {
  const list = document.getElementById('fallbackChain');
  if (!list) return;
  let dragItem = null;

  list.querySelectorAll('.fallback-chain-item').forEach(item => {
    item.addEventListener('dragstart', () => { dragItem = item; item.classList.add('dragging'); });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.fallback-chain-item').forEach(i => i.classList.remove('drag-over'));
      dragItem = null;
    });
    item.addEventListener('dragover', (e) => { e.preventDefault(); if (item !== dragItem) item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!dragItem || dragItem === item) return;
      const items = [...list.querySelectorAll('.fallback-chain-item')];
      const fromIdx = items.indexOf(dragItem);
      const toIdx = items.indexOf(item);
      if (fromIdx < toIdx) item.after(dragItem); else item.before(dragItem);
      // Save
      const newChain = [...list.querySelectorAll('.fallback-chain-item')].map(i => i.dataset.model);
      await api('/api/config', { method: 'PUT', body: { modelFallback: chainToFallbackMap(newChain) } });
      toast('Fallback order updated', 'success');
      loadConfig();
    });
  });
}

function showAddFallbackModel() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add Model to Fallback Chain</div>
      <div class="form-group">
        <label class="form-label">Model Name</label>
        <input class="form-input" id="fallbackModel" placeholder="e.g., claude-sonnet-4-20250514">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="addFallbackModel()">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#fallbackModel').focus();
}

async function addFallbackModel() {
  const model = document.getElementById('fallbackModel').value.trim();
  if (!model) { toast('Model name required', 'error'); return; }

  const cfg = state.config;
  const chain = buildFallbackChain(cfg.modelFallback || {});
  chain.push(model);
  await api('/api/config', { method: 'PUT', body: { modelFallback: chainToFallbackMap(chain) } });
  document.querySelector('.modal-overlay')?.remove();
  toast('Model added to chain', 'success');
  loadConfig();
}

async function removeFallbackModel(model) {
  const cfg = state.config;
  const chain = buildFallbackChain(cfg.modelFallback || {}).filter(m => m !== model);
  await api('/api/config', { method: 'PUT', body: { modelFallback: chainToFallbackMap(chain) } });
  toast('Model removed', 'success');
  loadConfig();
}

function editFallbackModel(labelEl, oldModel) {
  if (labelEl.querySelector('input')) return; // already editing
  const input = document.createElement('input');
  input.className = 'form-input';
  input.value = oldModel;
  input.style.cssText = 'font-size:13px;padding:2px 6px;margin:-2px 0;width:100%';
  labelEl.textContent = '';
  labelEl.appendChild(input);
  input.focus();
  input.select();

  const save = async () => {
    const newModel = input.value.trim();
    if (!newModel || newModel === oldModel) { loadConfig(); return; }
    const cfg = state.config;
    const chain = buildFallbackChain(cfg.modelFallback || {}).map(m => m === oldModel ? newModel : m);
    await api('/api/config', { method: 'PUT', body: { modelFallback: chainToFallbackMap(chain) } });
    toast('Model updated', 'success');
    loadConfig();
  };

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') loadConfig(); });
  input.addEventListener('blur', save);
}

async function saveQueueSettings() {
  const sec = parseInt(document.getElementById('queueWaitSec').value, 10);
  if (isNaN(sec) || sec < 0) { toast('Invalid duration', 'error'); return; }
  await api('/api/config', { method: 'PUT', body: { queueWaitMs: sec * 1000 } });
  toast(sec > 0 ? `Queue wait set to ${sec}s` : 'Request queuing disabled', 'success');
}

async function saveCooldownSettings() {
  const min = parseInt(document.getElementById('cooldownMin').value, 10);
  if (isNaN(min) || min < 1) { toast('Invalid duration', 'error'); return; }
  await api('/api/config', { method: 'PUT', body: { cooldownMs: min * 60000 } });
  toast('Cooldown settings saved', 'success');
}

async function toggleOpenAIFallback(enabled) {
  await api('/api/config', { method: 'PUT', body: { openaiModelFallback: enabled } });
  toast(enabled ? 'OpenAI fallback enabled' : 'OpenAI fallback disabled', 'success');
}

async function saveOpenAIBaseUrl() {
  const url = document.getElementById('openaiBaseUrl').value.trim();
  if (!url) { toast('URL required', 'error'); return; }
  await api('/api/config', { method: 'PUT', body: { openaiBaseUrl: url } });
  toast('OpenAI base URL saved', 'success');
}

async function removeModelMapping(from) {
  const cfg = state.config;
  const mapping = { ...(cfg.openaiModelMapping || {}) };
  delete mapping[from];
  await api('/api/config', { method: 'PUT', body: { openaiModelMapping: mapping } });
  toast('Mapping removed', 'success');
  loadConfig();
}

function showAddMappingModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add Model Mapping</div>
      <div class="form-group">
        <label class="form-label">Claude Model</label>
        <input class="form-input" id="mappingFrom" placeholder="e.g., claude-opus-4-6">
      </div>
      <div class="form-group">
        <label class="form-label">OpenAI Model</label>
        <input class="form-input" id="mappingTo" placeholder="e.g., gpt-4.1">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="addModelMapping()">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#mappingFrom').focus();
}

async function addModelMapping() {
  const from = document.getElementById('mappingFrom').value.trim();
  const to = document.getElementById('mappingTo').value.trim();
  if (!from || !to) { toast('Both models required', 'error'); return; }
  const cfg = state.config;
  const mapping = { ...(cfg.openaiModelMapping || {}), [from]: to };
  await api('/api/config', { method: 'PUT', body: { openaiModelMapping: mapping } });
  document.querySelector('.modal-overlay')?.remove();
  toast('Mapping added', 'success');
  loadConfig();
}

async function updateModelMapping(inputEl) {
  const from = inputEl.dataset.from;
  const to = inputEl.value.trim();
  if (!to) { toast('Model name required', 'error'); loadConfig(); return; }
  const cfg = state.config;
  const mapping = { ...(cfg.openaiModelMapping || {}), [from]: to };
  await api('/api/config', { method: 'PUT', body: { openaiModelMapping: mapping } });
  toast(`Mapping updated: ${from} → ${to}`, 'success');
}

// ─── Render: Setup ───────────────────────────────────────────────────────────

function renderSetup() {
  const tools = state.setupStatus;
  if (!tools) {
    content.innerHTML = '<div class="empty-state"><div class="empty-state-text">Loading...</div></div>';
    return;
  }

  const items = [
    { key: 'zsh', name: 'Zsh Shell', desc: 'Add ANTHROPIC_BASE_URL to ~/.zshrc' },
    { key: 'bash', name: 'Bash Shell', desc: 'Add ANTHROPIC_BASE_URL to ~/.bashrc' },
    { key: 'claude-code', name: 'Claude Code', desc: 'Configure Claude Code settings' },
    { key: 'cursor', name: 'Cursor', desc: 'Configure Cursor settings' }
  ];

  content.innerHTML = `
    <h1 class="page-title">Auto-Setup</h1>
    <p class="text-muted mb-16">Configure your tools to use the proxy automatically.</p>

    ${items.map(item => {
      const tool = tools[item.key];
      if (!tool) return '';
      const installed = tool.installed;
      const configured = tool.configured;

      return `
        <div class="setup-item">
          <div class="setup-info">
            <div>
              <div class="setup-name">${item.name}</div>
              <div class="setup-path">${item.desc}</div>
            </div>
          </div>
          <div class="flex gap-8">
            ${configured
              ? '<span class="badge badge-green">Configured</span>'
              : installed
                ? `<button class="btn btn-sm btn-primary" onclick="runSetup('${item.key}')">Configure</button>`
                : '<span class="badge badge-red">Not Installed</span>'
            }
          </div>
        </div>
      `;
    }).join('')}

    <div class="setup-item mt-16">
      <div class="setup-info">
        <div>
          <div class="setup-name">macOS Autostart</div>
          <div class="setup-path">Start proxy automatically on login (LaunchAgent)</div>
        </div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-sm btn-primary" onclick="runSetup('autostart')">Install</button>
        <button class="btn btn-sm btn-danger" onclick="runSetup('remove-autostart')">Remove</button>
      </div>
    </div>

    <div class="card mt-16">
      <div class="card-title">Manual Setup</div>
      <p class="text-muted text-sm" style="line-height:1.8">
        For other tools, set the environment variable:<br>
        <code style="color:var(--green)">export ANTHROPIC_BASE_URL=http://localhost:4080</code><br><br>
        Or configure the base URL in your tool's settings to point to <code style="color:var(--blue)">http://localhost:4080</code>
      </p>
    </div>
  `;
}

async function runSetup(target) {
  const result = await api(`/api/setup/${target}`, { method: 'POST' });
  if (result.success) {
    toast(`${target} configured successfully`, 'success');
    loadSetupStatus();
  } else {
    toast(result.message || result.error || 'Setup failed', 'error');
  }
}

// ─── Render: Logs ────────────────────────────────────────────────────────────

function renderLogs() {
  content.innerHTML = `
    <div class="flex-between mb-16">
      <h1 class="page-title" style="margin-bottom:0">Logs</h1>
      <div class="flex gap-8">
        <select class="form-select" id="logFilter" style="width:auto;padding:4px 8px;font-size:11px" onchange="filterLogs()">
          <option value="all">All Levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
          <option value="ratelimit">Rate Limits</option>
          <option value="queued">Queued</option>
        </select>
      </div>
    </div>
    <div class="log-viewer" id="logViewer">
      ${state.logs.map(renderLogEntry).join('')}
    </div>
  `;

  const viewer = document.getElementById('logViewer');
  if (viewer) viewer.scrollTop = viewer.scrollHeight;
}

function renderLogEntry(entry) {
  const tags = [];
  if (entry.rateLimit) tags.push('<span class="log-tag tag-ratelimit">RATE LIMIT</span>');
  if (entry.queued) tags.push('<span class="log-tag tag-queued">QUEUED</span>');
  const tagHtml = tags.length > 0 ? ' ' + tags.join(' ') : '';

  return `<div class="log-entry${entry.queued ? ' log-queued' : ''}${entry.rateLimit && !entry.queued ? ' log-ratelimit' : ''}" data-level="${entry.l}">
    <span class="log-time">${formatTime(entry.t)}</span>
    <span class="log-level ${entry.l}">${entry.l}</span>
    <span class="log-msg">${escHtml(entry.m)}${entry.key ? ` [${escHtml(entry.key)}]` : ''}${entry.model ? ` ${escHtml(entry.model)}` : ''}${tagHtml}</span>
  </div>`;
}

function appendLogEntry(entry) {
  const viewer = document.getElementById('logViewer');
  if (!viewer) return;

  const filter = document.getElementById('logFilter')?.value;
  if (filter && filter !== 'all') {
    if (filter === 'ratelimit' && !entry.rateLimit && !entry.queued) return;
    if (filter === 'queued' && !entry.queued) return;
    if (filter !== 'ratelimit' && filter !== 'queued' && entry.l !== filter) return;
  }

  viewer.insertAdjacentHTML('beforeend', renderLogEntry(entry));

  // Auto-scroll if near bottom
  if (viewer.scrollHeight - viewer.scrollTop < viewer.clientHeight + 100) {
    viewer.scrollTop = viewer.scrollHeight;
  }
}

function filterLogs() {
  const filter = document.getElementById('logFilter')?.value;
  const entries = document.querySelectorAll('.log-entry');
  entries.forEach(el => {
    if (filter === 'all') {
      el.style.display = '';
    } else if (filter === 'ratelimit') {
      el.style.display = el.classList.contains('log-ratelimit') || el.classList.contains('log-queued') ? '' : 'none';
    } else if (filter === 'queued') {
      el.style.display = el.classList.contains('log-queued') ? '' : 'none';
    } else {
      el.style.display = el.dataset.level === filter ? '' : 'none';
    }
  });
}

// ─── Global Actions ──────────────────────────────────────────────────────────

async function clearCooldowns() {
  await api('/api/cooldowns/clear', { method: 'POST' });
  toast('All cooldowns cleared', 'success');
  loadStatus();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return escHtml(s).replace(/'/g, '&#39;');
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

function statusBadge(code, req) {
  if (code >= 200 && code < 300) {
    if (req && req.queued) return `<span class="badge badge-green">${code}</span><span class="badge badge-cyan" title="Held ${req.queued} attempt(s)">QUEUED</span>`;
    return `<span class="badge badge-green">${code}</span>`;
  }
  if (code === 429) {
    if (req && req.queued) return `<span class="badge badge-red">429</span><span class="badge badge-amber" title="Queued ${req.queued}x but exhausted">QUEUE TIMEOUT</span>`;
    return '<span class="badge badge-red">429 RATE LIMIT</span>';
  }
  if (code >= 400) return `<span class="badge badge-red">${code}</span>`;
  return `<span class="badge">${code}</span>`;
}

function requestInfoBadges(r) {
  const parts = [];
  if (r.fallback) parts.push(`<span class="badge badge-amber">${escHtml(r.fallback)}</span>`);
  if (r.queued) parts.push(`<span class="badge badge-cyan" title="Request was held and retried">queued ${r.queued}x</span>`);
  if (r.provider === 'openai') parts.push('<span class="badge badge-green">OpenAI</span>');
  if (r.error === 'all_keys_exhausted') parts.push('<span class="badge badge-red">rate limit</span>');
  if (r.error === 'server_error_retries_exhausted') parts.push('<span class="badge badge-red">server error</span>');
  return parts.length > 0 ? parts.join(' ') : '—';
}

// ─── Init ────────────────────────────────────────────────────────────────────

connectSSE();
navigateTo('status');
