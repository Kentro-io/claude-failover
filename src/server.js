'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getConfig, saveConfig, startConfigWatcher, ensureConfig, generateKeyId, detectKeyType, generateOpenAIKeyId, detectOpenAIKeyType } = require('./config');
const { log, getRecentLogs, addLogListener, removeLogListener } = require('./logger');
const { handleProxyRequest } = require('./proxy');
const cooldown = require('./cooldown');
const metrics = require('./metrics');
const { detectTools, setupShell, setupClaudeCode, setupCursor } = require('./setup');
const { installLaunchAgent, uninstallLaunchAgent, writePid, getAutostartStatus } = require('./daemon');
const { buildPriorityOrder, splitPriorityOrder, toPriorityItems, encodePriorityItem } = require('./profile-order');
const { testCodexOAuthToken } = require('./adapter-codex');

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const servers = [];
const sseClients = new Set();

// SSE broadcaster
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

// Log listener for SSE
addLogListener((entry) => {
  broadcast('log', entry);
});

// Periodic status broadcast
let statusInterval;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}

function maskToken(token) {
  if (!token || token.length < 12) return '***';
  return token.slice(0, 10) + '...' + token.slice(-4);
}

function applyProfilePriority(profile, priorityOrder) {
  const next = splitPriorityOrder(priorityOrder);
  profile.priorityOrder = next.priorityOrder;
  profile.keyOrder = next.keyOrder;
  profile.openaiKeyOrder = next.openaiKeyOrder;
  return profile;
}

function ensureProfilePriority(profile, config) {
  return applyProfilePriority(profile, buildPriorityOrder(profile, config)).priorityOrder;
}

function serveDashboard(req, res) {
  let filePath = req.url.replace('/dashboard', '') || '/';
  if (filePath === '/' || filePath === '') filePath = '/index.html';

  let fullPath = path.join(DASHBOARD_DIR, filePath);
  const ext = path.extname(fullPath);

  // Prevent directory traversal
  if (!fullPath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Support routed SPA pages like /dashboard/status or /dashboard/profiles
  if (!ext && !fs.existsSync(fullPath)) {
    fullPath = path.join(DASHBOARD_DIR, 'index.html');
  }

  try {
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(fullPath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function testApiKey(token) {
  return new Promise((resolve) => {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    };

    if (token.includes('sk-ant-oat')) {
      headers['authorization'] = `Bearer ${token}`;
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
    } else {
      headers['x-api-key'] = token;
    }

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Hi' }]
    });

    headers['content-length'] = Buffer.byteLength(body);

    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers,
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve({ valid: true, status: res.statusCode });
        } else if (res.statusCode === 429) {
          resolve({ valid: true, status: res.statusCode, note: 'Rate limited but key is valid' });
        } else {
          resolve({ valid: false, status: res.statusCode, error: data });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ valid: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: 'Timeout' });
    });

    req.write(body);
    req.end();
  });
}

function testOpenAIKey(token, model = 'gpt-5.4-mini') {
  if (typeof token === 'string' && token.startsWith('eyJ')) {
    return testCodexOAuthToken(token, model);
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_completion_tokens: 8
    });

    const req = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        const err = parsed?.error || {};

        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve({ valid: true, status: res.statusCode, model });
        } else if (res.statusCode === 429) {
          resolve({ valid: true, status: res.statusCode, model, note: 'Rate limited but token is valid' });
        } else {
          resolve({
            valid: false,
            status: res.statusCode,
            model,
            error: err.message || data,
            code: err.code || null,
            type: err.type || null
          });
        }
      });
    });

    req.on('error', (err) => resolve({ valid: false, error: err.message, model }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: 'Timeout', model });
    });

    req.write(body);
    req.end();
  });
}

async function handleAPI(req, res, profileName) {
  const url = new URL(req.url, 'http://localhost');
  const apiPath = url.pathname;
  const method = req.method;
  const config = getConfig();

  // SSE endpoint
  if (apiPath === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':\n\n'); // heartbeat
    sseClients.add(res);

    // Send initial status
    const statusData = buildStatus(config, profileName);
    res.write(`event: status\ndata: ${JSON.stringify(statusData)}\n\n`);

    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Status
  if (apiPath === '/api/status' && method === 'GET') {
    sendJSON(res, 200, buildStatus(config, profileName));
    return;
  }

  // Keys
  if (apiPath === '/api/keys' && method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const profileName = url.searchParams.get('profile') || 'default';
    const profile = config.profiles[profileName] || config.profiles.default;
    const keyOrder = profile?.keyOrder || Object.keys(config.keys);

    // Return keys sorted by the profile's keyOrder
    const keys = keyOrder
      .filter(id => config.keys[id])
      .map(id => {
        const k = config.keys[id];
        return {
          id,
          label: k.label,
          type: k.type,
          masked: maskToken(k.token),
          addedAt: k.addedAt,
          requests: metrics.getMetrics().byKey[id] || 0,
          inCooldown: cooldown.isInCooldown(id)
        };
      });
    sendJSON(res, 200, { keys });
    return;
  }

  if (apiPath === '/api/keys' && method === 'POST') {
    const body = await parseBody(req);
    if (!body?.token) {
      sendJSON(res, 400, { error: 'Missing token' });
      return;
    }

    const token = body.token.trim();

    // Guard: reject OpenAI keys on the Anthropic endpoint
    if (!token.startsWith('sk-ant-')) {
      sendJSON(res, 400, { error: 'This token does not look like an Anthropic key (expected sk-ant-...). Use the OpenAI keys endpoint for OpenAI tokens.' });
      return;
    }

    const label = body.label || 'Unnamed Key';
    const type = detectKeyType(token);
    const id = generateKeyId(label);

    config.keys[id] = {
      token,
      label,
      type,
      addedAt: new Date().toISOString()
    };

    // Add to all profiles and preserve unified priority ordering
    for (const prof of Object.values(config.profiles)) {
      const priorityOrder = buildPriorityOrder(prof, config);
      const encoded = encodePriorityItem('anthropic', id);
      if (!priorityOrder.includes(encoded)) {
        priorityOrder.push(encoded);
      }
      applyProfilePriority(prof, priorityOrder);
    }

    saveConfig(config);
    log('info', `Key added: ${id} (${label})`);
    sendJSON(res, 201, { id, label, type, masked: maskToken(token) });
    broadcast('config', { action: 'key-added', id });
    return;
  }

  // Delete key
  const deleteKeyMatch = apiPath.match(/^\/api\/keys\/([^/]+)$/);
  if (deleteKeyMatch && method === 'DELETE') {
    const id = decodeURIComponent(deleteKeyMatch[1]);
    if (!config.keys[id]) {
      sendJSON(res, 404, { error: 'Key not found' });
      return;
    }

    delete config.keys[id];
    for (const prof of Object.values(config.profiles)) {
      const priorityOrder = buildPriorityOrder(prof, config)
        .filter(encoded => encoded !== encodePriorityItem('anthropic', id));
      applyProfilePriority(prof, priorityOrder);
    }

    saveConfig(config);
    log('info', `Key removed: ${id}`);
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'key-removed', id });
    return;
  }

  // Test key
  const testKeyMatch = apiPath.match(/^\/api\/keys\/([^/]+)\/test$/);
  if (testKeyMatch && method === 'POST') {
    const id = decodeURIComponent(testKeyMatch[1]);
    const keyEntry = config.keys[id];
    if (!keyEntry) {
      sendJSON(res, 404, { error: 'Key not found' });
      return;
    }

    const result = await testApiKey(keyEntry.token);
    sendJSON(res, 200, { id, ...result });
    return;
  }

  // Reorder keys
  if (apiPath === '/api/keys/reorder' && method === 'PUT') {
    const body = await parseBody(req);
    if (!body?.profile || !Array.isArray(body?.keyOrder)) {
      sendJSON(res, 400, { error: 'Missing profile or keyOrder' });
      return;
    }

    const prof = config.profiles[body.profile];
    if (!prof) {
      sendJSON(res, 404, { error: 'Profile not found' });
      return;
    }

    const openaiPart = (prof.openaiKeyOrder || []).map(id => encodePriorityItem('openai', id));
    applyProfilePriority(prof, [
      ...body.keyOrder.map(id => encodePriorityItem('anthropic', id)),
      ...openaiPart
    ]);
    saveConfig(config);
    log('info', `Key order updated for profile ${body.profile}`);
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'keys-reordered', profile: body.profile });
    return;
  }

  // OpenAI Keys
  if (apiPath === '/api/openai-keys' && method === 'GET') {
    const openaiKeys = config.openaiKeys || {};
    const profileParam = url.searchParams.get('profile') || 'default';
    const prof = config.profiles[profileParam] || config.profiles.default;
    const openaiKeyOrder = (prof.openaiKeyOrder || []).length > 0
      ? prof.openaiKeyOrder
      : Object.keys(openaiKeys);

    const keys = openaiKeyOrder
      .filter(id => openaiKeys[id])
      .map(id => {
        const k = openaiKeys[id];
        return {
          id,
          label: k.label,
          type: k.type,
          masked: maskToken(k.token),
          addedAt: k.addedAt,
          requests: metrics.getMetrics().byKey[id] || 0,
          inCooldown: cooldown.isInCooldown(id, 'openai')
        };
      });
    sendJSON(res, 200, { keys });
    return;
  }

  if (apiPath === '/api/openai-keys' && method === 'POST') {
    const body = await parseBody(req);
    if (!body?.token) {
      sendJSON(res, 400, { error: 'Missing token' });
      return;
    }

    const token = body.token.trim();

    // Guard: reject Anthropic keys on the OpenAI endpoint
    if (token.startsWith('sk-ant-')) {
      sendJSON(res, 400, { error: 'This token looks like an Anthropic key (sk-ant-...). Use the Anthropic keys endpoint instead.' });
      return;
    }

    const label = body.label || 'Unnamed OpenAI Key';
    const type = detectOpenAIKeyType(token);
    const id = generateOpenAIKeyId(label);

    if (!config.openaiKeys) config.openaiKeys = {};
    config.openaiKeys[id] = {
      token,
      label,
      type,
      addedAt: new Date().toISOString()
    };

    // Add to all profiles and preserve unified priority ordering
    for (const prof of Object.values(config.profiles)) {
      const priorityOrder = buildPriorityOrder(prof, config);
      const encoded = encodePriorityItem('openai', id);
      if (!priorityOrder.includes(encoded)) {
        priorityOrder.push(encoded);
      }
      applyProfilePriority(prof, priorityOrder);
    }

    // Enable OpenAI fallback automatically when first key is added
    if (!config.openaiModelFallback) {
      config.openaiModelFallback = true;
    }

    saveConfig(config);
    log('info', `OpenAI key added: ${id} (${label})`);
    sendJSON(res, 201, { id, label, type, masked: maskToken(token) });
    broadcast('config', { action: 'openai-key-added', id });
    return;
  }

  // Test OpenAI key
  const testOpenAIKeyMatch = apiPath.match(/^\/api\/openai-keys\/([^/]+)\/test$/);
  if (testOpenAIKeyMatch && method === 'POST') {
    const id = decodeURIComponent(testOpenAIKeyMatch[1]);
    const keyEntry = config.openaiKeys?.[id];
    if (!keyEntry) {
      sendJSON(res, 404, { error: 'OpenAI key not found' });
      return;
    }

    const targetModel = config.openaiModelMapping?.['claude-sonnet-4-6']
      || config.openaiModelMapping?.['*']
      || 'gpt-5.4-mini';
    const result = await testOpenAIKey(keyEntry.token, targetModel);
    sendJSON(res, 200, { id, ...result });
    return;
  }

  // Delete OpenAI key
  const deleteOpenAIKeyMatch = apiPath.match(/^\/api\/openai-keys\/([^/]+)$/);
  if (deleteOpenAIKeyMatch && method === 'DELETE') {
    const id = decodeURIComponent(deleteOpenAIKeyMatch[1]);
    if (!config.openaiKeys || !config.openaiKeys[id]) {
      sendJSON(res, 404, { error: 'OpenAI key not found' });
      return;
    }

    delete config.openaiKeys[id];
    for (const prof of Object.values(config.profiles)) {
      const priorityOrder = buildPriorityOrder(prof, config)
        .filter(encoded => encoded !== encodePriorityItem('openai', id));
      applyProfilePriority(prof, priorityOrder);
    }

    saveConfig(config);
    log('info', `OpenAI key removed: ${id}`);
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'openai-key-removed', id });
    return;
  }

  // Reorder OpenAI keys
  if (apiPath === '/api/openai-keys/reorder' && method === 'PUT') {
    const body = await parseBody(req);
    if (!body?.profile || !Array.isArray(body?.openaiKeyOrder)) {
      sendJSON(res, 400, { error: 'Missing profile or openaiKeyOrder' });
      return;
    }

    const prof = config.profiles[body.profile];
    if (!prof) {
      sendJSON(res, 404, { error: 'Profile not found' });
      return;
    }

    const anthropicPart = (prof.keyOrder || []).map(id => encodePriorityItem('anthropic', id));
    applyProfilePriority(prof, [
      ...anthropicPart,
      ...body.openaiKeyOrder.map(id => encodePriorityItem('openai', id))
    ]);
    saveConfig(config);
    log('info', `OpenAI key order updated for profile ${body.profile}`);
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'openai-keys-reordered', profile: body.profile });
    return;
  }

  if (apiPath === '/api/profiles/priority' && method === 'PUT') {
    const body = await parseBody(req);
    if (!body?.profile || !Array.isArray(body?.priorityOrder)) {
      sendJSON(res, 400, { error: 'Missing profile or priorityOrder' });
      return;
    }

    const prof = config.profiles[body.profile];
    if (!prof) {
      sendJSON(res, 404, { error: 'Profile not found' });
      return;
    }

    applyProfilePriority(prof, body.priorityOrder);
    saveConfig(config);
    log('info', `Unified priority order updated for profile ${body.profile}`);
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'profile-priority-reordered', profile: body.profile });
    return;
  }

  // Profiles
  if (apiPath === '/api/profiles' && method === 'GET') {
    const profiles = Object.entries(config.profiles).map(([name, p]) => {
      const priorityOrder = ensureProfilePriority(p, config);
      return {
        name,
        port: p.port,
        keyOrder: p.keyOrder,
        openaiKeyOrder: p.openaiKeyOrder || [],
        priorityOrder,
        priorityItems: toPriorityItems(priorityOrder, config)
      };
    });
    saveConfig(config);
    sendJSON(res, 200, { profiles });
    return;
  }

  if (apiPath === '/api/profiles' && method === 'POST') {
    const body = await parseBody(req);
    if (!body?.name || !body?.port) {
      sendJSON(res, 400, { error: 'Missing name or port' });
      return;
    }

    const name = body.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (config.profiles[name]) {
      sendJSON(res, 409, { error: 'Profile already exists' });
      return;
    }

    config.profiles[name] = {
      port: parseInt(body.port, 10),
      keyOrder: body.keyOrder || Object.keys(config.keys),
      openaiKeyOrder: body.openaiKeyOrder || Object.keys(config.openaiKeys || {})
    };

    const priorityOrder = ensureProfilePriority(config.profiles[name], config);
    saveConfig(config);
    log('info', `Profile created: ${name}`);
    sendJSON(res, 201, { name, ...config.profiles[name], priorityOrder, priorityItems: toPriorityItems(priorityOrder, config) });
    broadcast('config', { action: 'profile-created', name });
    return;
  }

  // Update profile
  const updateProfileMatch = apiPath.match(/^\/api\/profiles\/([^/]+)$/);
  if (updateProfileMatch && method === 'PUT') {
    const name = decodeURIComponent(updateProfileMatch[1]);
    if (!config.profiles[name]) {
      sendJSON(res, 404, { error: 'Profile not found' });
      return;
    }

    const body = await parseBody(req);
    if (body.port) config.profiles[name].port = parseInt(body.port, 10);
    if (body.priorityOrder) {
      applyProfilePriority(config.profiles[name], body.priorityOrder);
    } else {
      if (body.keyOrder) config.profiles[name].keyOrder = body.keyOrder;
      if (body.openaiKeyOrder) config.profiles[name].openaiKeyOrder = body.openaiKeyOrder;
      ensureProfilePriority(config.profiles[name], config);
    }

    saveConfig(config);
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'profile-updated', name });
    return;
  }

  if (updateProfileMatch && method === 'DELETE') {
    const name = decodeURIComponent(updateProfileMatch[1]);
    if (name === 'default') {
      sendJSON(res, 400, { error: 'Cannot delete default profile' });
      return;
    }
    if (!config.profiles[name]) {
      sendJSON(res, 404, { error: 'Profile not found' });
      return;
    }

    delete config.profiles[name];
    saveConfig(config);
    log('info', `Profile deleted: ${name}`);
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'profile-deleted', name });
    return;
  }

  // Config
  if (apiPath === '/api/config' && method === 'GET') {
    const safeConfig = {
      profiles: config.profiles,
      modelFallback: config.modelFallback,
      cooldownMs: config.cooldownMs,
      queueWaitMs: config.queueWaitMs ?? 90000,
      logLevel: config.logLevel,
      maxLogSize: config.maxLogSize,
      openaiBaseUrl: config.openaiBaseUrl || 'https://api.openai.com',
      openaiModelMapping: config.openaiModelMapping || {},
      openaiModelFallback: config.openaiModelFallback || false
    };
    sendJSON(res, 200, safeConfig);
    return;
  }

  if (apiPath === '/api/config' && method === 'PUT') {
    const body = await parseBody(req);
    if (body.modelFallback) config.modelFallback = body.modelFallback;
    if (body.cooldownMs !== undefined) config.cooldownMs = parseInt(body.cooldownMs, 10);
    if (body.queueWaitMs !== undefined) config.queueWaitMs = parseInt(body.queueWaitMs, 10);
    if (body.logLevel) config.logLevel = body.logLevel;
    if (body.openaiBaseUrl !== undefined) config.openaiBaseUrl = body.openaiBaseUrl;
    if (body.openaiModelMapping !== undefined) config.openaiModelMapping = body.openaiModelMapping;
    if (body.openaiModelFallback !== undefined) config.openaiModelFallback = body.openaiModelFallback;

    saveConfig(config);
    log('info', 'Config updated via dashboard');
    sendJSON(res, 200, { success: true });
    broadcast('config', { action: 'config-updated' });
    return;
  }

  // Cooldowns
  if (apiPath === '/api/cooldowns/clear' && method === 'POST') {
    cooldown.clearAllCooldowns();
    log('info', 'All cooldowns cleared');
    sendJSON(res, 200, { success: true });
    broadcast('cooldowns', { action: 'cleared' });
    return;
  }

  // Logs
  if (apiPath === '/api/logs' && method === 'GET') {
    const count = parseInt(url.searchParams.get('count') || '50', 10);
    sendJSON(res, 200, { logs: getRecentLogs(count) });
    return;
  }

  // Setup
  if (apiPath === '/api/setup/status' && method === 'GET') {
    sendJSON(res, 200, {
      ...detectTools(),
      autostart: getAutostartStatus()
    });
    return;
  }

  const setupMatch = apiPath.match(/^\/api\/setup\/([^/]+)$/);
  if (setupMatch && method === 'POST') {
    const target = setupMatch[1];
    const port = config.profiles.default?.port || 4080;

    let result;
    switch (target) {
      case 'zsh':
        result = setupShell(port, 'zsh');
        break;
      case 'bash':
        result = setupShell(port, 'bash');
        break;
      case 'claude-code':
        result = setupClaudeCode(port);
        break;
      case 'cursor':
        result = setupCursor(port);
        break;
      case 'autostart':
        result = installLaunchAgent();
        break;
      case 'remove-autostart':
        result = uninstallLaunchAgent();
        break;
      case 'auto': {
        const status = detectTools();
        const actions = [];
        if (status.zsh?.installed && !status.zsh?.configured) actions.push({ target: 'zsh', ...setupShell(port, 'zsh') });
        if (status.bash?.installed && !status.bash?.configured) actions.push({ target: 'bash', ...setupShell(port, 'bash') });
        if (status['claude-code']?.installed && !status['claude-code']?.configured) actions.push({ target: 'claude-code', ...setupClaudeCode(port) });
        if (status.cursor?.installed && !status.cursor?.configured) actions.push({ target: 'cursor', ...setupCursor(port) });
        const autostart = getAutostartStatus();
        if (!autostart.installed || !autostart.loaded) actions.push({ target: 'autostart', ...installLaunchAgent() });
        result = { success: true, actions, changed: actions.length, message: actions.length ? `Configured ${actions.length} item(s)` : 'Everything already configured' };
        break;
      }
      default:
        sendJSON(res, 400, { error: `Unknown target: ${target}` });
        return;
    }

    log('info', `Setup completed: ${target}`);
    sendJSON(res, 200, result);
    return;
  }

  // Not found
  sendJSON(res, 404, { error: 'Not found' });
}

function buildStatus(config, profileName) {
  const m = metrics.getMetrics();
  const recent = metrics.getRecentRequests(100);
  const anthropicCount = recent.filter(r => r.provider !== 'openai').length;
  const openaiCount = recent.filter(r => r.provider === 'openai').length;
  return {
    status: 'ok',
    uptime: m.uptime,
    profile: profileName,
    metrics: {
      total: m.totalRequests,
      success: m.totalSuccess,
      retries: m.totalRetries,
      failures: m.totalFailures,
      modelFallbacks: m.modelFallbacks,
      queued: m.totalQueued,
      byKey: m.byKey,
      byModel: m.byModel,
      successRate: m.totalRequests > 0
        ? Math.round((m.totalSuccess / m.totalRequests) * 100)
        : 100,
      anthropicRequests: anthropicCount,
      openaiRequests: openaiCount
    },
    cooldowns: cooldown.getActiveCooldowns(),
    recentRequests: metrics.getRecentRequests(10),
    keys: Object.entries(config.keys).map(([id, k]) => ({
      id,
      label: k.label,
      type: k.type,
      inCooldown: cooldown.isInCooldown(id)
    })),
    openaiKeys: Object.entries(config.openaiKeys || {}).map(([id, k]) => ({
      id,
      label: k.label,
      type: k.type,
      inCooldown: cooldown.isInCooldown(id, 'openai')
    })),
    openaiModelFallback: config.openaiModelFallback || false,
    openaiModelMapping: config.openaiModelMapping || {},
    profiles: Object.entries(config.profiles).map(([name, p]) => ({
      name, port: p.port, keyCount: p.keyOrder.length,
      openaiKeyCount: (p.openaiKeyOrder || []).length
    }))
  };
}

function createRequestHandler(profileName) {
  return async (req, res) => {
    try {
      // Health endpoint
      if (req.url === '/health' && req.method === 'GET') {
        const config = getConfig();
        sendJSON(res, 200, buildStatus(config, profileName));
        return;
      }

      // Dashboard
      if (req.url.startsWith('/dashboard')) {
        serveDashboard(req, res);
        return;
      }

      // Redirect root to dashboard
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(302, { Location: '/dashboard/' });
        res.end();
        return;
      }

      // API routes
      if (req.url.startsWith('/api/')) {
        await handleAPI(req, res, profileName);
        return;
      }

      // Clear cooldowns (legacy)
      if (req.url === '/clear-cooldowns' && req.method === 'POST') {
        cooldown.clearAllCooldowns();
        sendJSON(res, 200, { status: 'cleared' });
        return;
      }

      // Block non-API paths (favicon, robots.txt, etc.) from reaching the proxy
      if (!req.url.startsWith('/v1/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not an API path' }));
        return;
      }

      // Everything else -> proxy to Anthropic
      await handleProxyRequest(req, res, profileName);
    } catch (err) {
      log('error', 'Unhandled request error', {
        error: err.message,
        stack: err.stack
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal proxy error' }));
      }
    }
  };
}

function startServers() {
  const config = ensureConfig();
  startConfigWatcher();

  for (const [name, profile] of Object.entries(config.profiles)) {
    const server = http.createServer(createRequestHandler(name));
    server.keepAliveTimeout = 120000;
    server.headersTimeout = 125000;

    server.listen(profile.port, '127.0.0.1', () => {
      log('info', `Proxy [${name}] listening on 127.0.0.1:${profile.port}`);
      const keyOrder = profile.keyOrder || [];
      if (keyOrder.length > 0) {
        log('info', `Key order [${name}]: ${keyOrder.join(' -> ')}`);
      }
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log('error', `Port ${profile.port} already in use for profile [${name}]`);
        process.exit(1);
      }
      log('error', `Server error [${name}]: ${err.message}`);
    });

    servers.push({ name, server, port: profile.port });
  }

  // Periodic status broadcast (every 2s)
  statusInterval = setInterval(() => {
    if (sseClients.size > 0) {
      const config = getConfig();
      broadcast('status', buildStatus(config, 'default'));
    }
  }, 2000);
  statusInterval.unref();

  // Write PID
  writePid(process.pid);

  // Graceful shutdown
  function shutdown(signal) {
    log('info', `Shutting down on ${signal}`);
    if (statusInterval) clearInterval(statusInterval);
    for (const { server } of servers) {
      server.close();
    }
    for (const client of sseClients) {
      try { client.end(); } catch {}
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const keyCount = Object.keys(config.keys).length;
  const profileCount = Object.keys(config.profiles).length;
  log('info', 'Claude Failover started', {
    keys: keyCount,
    profiles: profileCount,
    models: Object.keys(config.modelFallback).length,
    cooldownMin: Math.round(config.cooldownMs / 60000)
  });

  return servers;
}

function stopServers() {
  if (statusInterval) clearInterval(statusInterval);
  for (const { server } of servers) {
    server.close();
  }
  servers.length = 0;
}

// If run directly, start servers
if (require.main === module) {
  startServers();
}

module.exports = { startServers, stopServers };
