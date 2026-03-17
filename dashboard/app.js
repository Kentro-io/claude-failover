/* Claude Failover Dashboard — app.js */
'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let state = {
  status: null,
  keys: [],
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
  const data = await api('/api/keys');
  state.keys = data.keys || [];
  if (state.currentPage === 'keys') renderKeys();
}

async function loadProfiles() {
  const data = await api('/api/profiles');
  state.profiles = data.profiles || [];
  if (state.currentPage === 'profiles') renderProfiles();
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
    keys: () => { loadKeys(); renderKeys(); },
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
        <div class="metric-value amber">${m.retries}</div>
        <div class="metric-label">Retries</div>
      </div>
      <div class="metric-card">
        <div class="metric-value red">${m.failures}</div>
        <div class="metric-label">Failures</div>
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
                <th>Model</th>
                <th>Key</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Fallback</th>
              </tr>
            </thead>
            <tbody>
              ${s.recentRequests.slice().reverse().map(r => `
                <tr>
                  <td class="text-muted">${formatTime(r.timestamp)}</td>
                  <td>${escHtml(r.model)}</td>
                  <td>${escHtml(r.key)}</td>
                  <td>${statusBadge(r.status)}</td>
                  <td>${r.latency}ms</td>
                  <td>${r.fallback ? `<span class="badge badge-amber">${escHtml(r.fallback)}</span>` : '—'}</td>
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
          <div class="card-title">Key Priority Order</div>
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

  // Setup drag and drop
  setupDragDrop();
}

function renderKeyItem(k, index) {
  return `
    <div class="key-item" draggable="true" data-key-id="${escAttr(k.id)}" data-index="${index}">
      <span class="drag-handle">⠿</span>
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
  const list = document.getElementById('keyList');
  if (!list) return;

  let dragItem = null;

  list.querySelectorAll('.key-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.key-item').forEach(i => i.classList.remove('drag-over'));
      dragItem = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (item !== dragItem) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragItem && dragItem !== item) {
        const items = [...list.querySelectorAll('.key-item')];
        const fromIdx = items.indexOf(dragItem);
        const toIdx = items.indexOf(item);
        if (fromIdx < toIdx) {
          item.after(dragItem);
        } else {
          item.before(dragItem);
        }
        saveKeyOrder();
      }
    });
  });
}

async function saveKeyOrder() {
  const list = document.getElementById('keyList');
  if (!list) return;
  const items = list.querySelectorAll('.key-item');
  const keyOrder = [...items].map(i => i.dataset.keyId);
  const profileEl = document.getElementById('keyProfileSelect');
  const profile = profileEl ? profileEl.value : 'default';

  await api('/api/keys/reorder', {
    method: 'PUT',
    body: { profile, keyOrder }
  });
  toast('Key order updated', 'success');
}

function showAddKeyModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add API Key</div>
      <div class="form-group">
        <label class="form-label">API Key or OAuth Token</label>
        <input class="form-input" id="newKeyToken" placeholder="sk-ant-api03-... or sk-ant-oat01-..." autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Label</label>
        <input class="form-input" id="newKeyLabel" placeholder="e.g., Personal Account">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="addKey()">Add Key</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#newKeyToken').focus();
}

async function addKey() {
  const token = document.getElementById('newKeyToken').value.trim();
  const label = document.getElementById('newKeyLabel').value.trim();

  if (!token) {
    toast('Please enter an API key', 'error');
    return;
  }

  if (!token.startsWith('sk-ant-')) {
    toast('Invalid key format (expected sk-ant-...)', 'error');
    return;
  }

  const result = await api('/api/keys', {
    method: 'POST',
    body: { token, label: label || 'Unnamed Key' }
  });

  if (result.error) {
    toast(result.error, 'error');
    return;
  }

  document.querySelector('.modal-overlay')?.remove();
  toast(`Key added: ${result.id}`, 'success');
  loadKeys();
}

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

// ─── Render: Profiles ────────────────────────────────────────────────────────

function renderProfiles() {
  const profiles = state.profiles;

  content.innerHTML = `
    <div class="flex-between mb-16">
      <h1 class="page-title" style="margin-bottom:0">Profiles</h1>
      <button class="btn btn-primary" onclick="showAddProfileModal()">+ Add Profile</button>
    </div>

    ${profiles.map(p => `
      <div class="card" data-profile="${escAttr(p.name)}">
        <div class="flex-between">
          <div>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">${escHtml(p.name)}</div>
            <div class="text-muted text-sm">Port ${p.port} · ${p.keyOrder.length} key(s)</div>
          </div>
          <div class="flex gap-8">
            ${p.name !== 'default' ? `<button class="btn btn-sm btn-danger" onclick="deleteProfile('${escAttr(p.name)}')">Delete</button>` : ''}
          </div>
        </div>
        <div class="profile-key-list mt-8" data-profile-name="${escAttr(p.name)}">
          ${p.keyOrder.map((k, i) => `
            <div class="profile-key-item" draggable="true" data-key-id="${escAttr(k)}" data-index="${i}">
              <span class="drag-handle">⠿</span>
              <span class="key-label">${escHtml(state.keys.find(x => x.id === k)?.label || k)}</span>
              <span class="text-muted text-sm">${escHtml(k)}</span>
            </div>
          `).join('')}
          ${p.keyOrder.length === 0 ? '<div class="text-muted text-sm" style="padding:8px">(no keys)</div>' : ''}
        </div>
      </div>
    `).join('')}
  `;

  // Setup drag-and-drop for each profile's key list
  document.querySelectorAll('.profile-key-list').forEach(list => {
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
        // Reorder DOM
        const items = [...list.querySelectorAll('.profile-key-item')];
        const fromIdx = items.indexOf(dragItem);
        const toIdx = items.indexOf(item);
        if (fromIdx < toIdx) item.after(dragItem);
        else item.before(dragItem);
        // Save new order
        const newOrder = [...list.querySelectorAll('.profile-key-item')].map(i => i.dataset.keyId);
        await api('/api/keys/reorder', { method: 'PUT', body: { profile: profileName, keyOrder: newOrder } });
        toast('Key order updated', 'success');
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

  const fallbacks = Object.entries(cfg.modelFallback || {});
  const cooldownMin = Math.round((cfg.cooldownMs || 3600000) / 60000);

  content.innerHTML = `
    <h1 class="page-title">Fallback & Cooldown</h1>

    <div class="card">
      <div class="flex-between mb-16">
        <div class="card-title">Model Fallback Chain</div>
        <button class="btn btn-sm" onclick="showAddFallbackModal()">+ Add Rule</button>
      </div>
      ${fallbacks.length > 0 ? fallbacks.map(([from, to]) => `
        <div class="fallback-row">
          <span class="badge badge-blue">${escHtml(from)}</span>
          <span class="fallback-arrow">→</span>
          <span class="badge badge-green">${escHtml(to)}</span>
          <button class="btn btn-sm btn-danger" onclick="removeFallback('${escAttr(from)}')" style="margin-left:auto">✕</button>
        </div>
      `).join('') : '<div class="text-muted text-sm">No fallback rules configured</div>'}
      <p class="text-muted text-sm mt-16">
        When all keys are exhausted for a model, the proxy tries the fallback model with the same keys.
      </p>
    </div>

    <div class="card">
      <div class="card-title">Cooldown Settings</div>
      <div class="form-group mt-8">
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
  `;
}

function showAddFallbackModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">Add Fallback Rule</div>
      <div class="form-group">
        <label class="form-label">From Model</label>
        <input class="form-input" id="fallbackFrom" placeholder="e.g., claude-opus-4-6">
      </div>
      <div class="form-group">
        <label class="form-label">To Model (fallback)</label>
        <input class="form-input" id="fallbackTo" placeholder="e.g., claude-sonnet-4-6">
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" onclick="addFallback()">Add</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#fallbackFrom').focus();
}

async function addFallback() {
  const from = document.getElementById('fallbackFrom').value.trim();
  const to = document.getElementById('fallbackTo').value.trim();
  if (!from || !to) { toast('Both fields required', 'error'); return; }

  const cfg = state.config;
  cfg.modelFallback[from] = to;
  await api('/api/config', { method: 'PUT', body: { modelFallback: cfg.modelFallback } });
  document.querySelector('.modal-overlay')?.remove();
  toast('Fallback rule added', 'success');
  loadConfig();
}

async function removeFallback(from) {
  const cfg = state.config;
  delete cfg.modelFallback[from];
  await api('/api/config', { method: 'PUT', body: { modelFallback: cfg.modelFallback } });
  toast('Fallback rule removed', 'success');
  loadConfig();
}

async function saveCooldownSettings() {
  const min = parseInt(document.getElementById('cooldownMin').value, 10);
  if (isNaN(min) || min < 1) { toast('Invalid duration', 'error'); return; }
  await api('/api/config', { method: 'PUT', body: { cooldownMs: min * 60000 } });
  toast('Cooldown settings saved', 'success');
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
  return `<div class="log-entry" data-level="${entry.l}">
    <span class="log-time">${formatTime(entry.t)}</span>
    <span class="log-level ${entry.l}">${entry.l}</span>
    <span class="log-msg">${escHtml(entry.m)}${entry.key ? ` [${escHtml(entry.key)}]` : ''}${entry.model ? ` ${escHtml(entry.model)}` : ''}</span>
  </div>`;
}

function appendLogEntry(entry) {
  const viewer = document.getElementById('logViewer');
  if (!viewer) return;

  const filter = document.getElementById('logFilter')?.value;
  if (filter && filter !== 'all' && entry.l !== filter) return;

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
    if (filter === 'all' || el.dataset.level === filter) {
      el.style.display = '';
    } else {
      el.style.display = 'none';
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

function statusBadge(code) {
  if (code >= 200 && code < 300) return `<span class="badge badge-green">${code}</span>`;
  if (code === 429) return '<span class="badge badge-amber">429</span>';
  if (code >= 400) return `<span class="badge badge-red">${code}</span>`;
  return `<span class="badge">${code}</span>`;
}

// ─── Init ────────────────────────────────────────────────────────────────────

connectSSE();
navigateTo('status');
