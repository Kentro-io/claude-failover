#!/usr/bin/env node
// Anthropic API Proxy with Key Rotation & Model Fallback
// Sits between OpenClaw/Claude Code and api.anthropic.com
// Transparently rotates keys on 429, falls back models on exhaustion
//
// Port 18800: default key order  (main → key2 → key3) for OpenClaw
// Port 18801: claude-code order  (key2 → key3 → main) for Claude Code
//
// Zero external dependencies — pure Node.js

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = loadConfig();
let lastConfigMtime = 0;

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  // Validate required fields
  if (!parsed.keys || !parsed.keyOrder || !parsed.upstream) {
    throw new Error('Invalid config: missing keys, keyOrder, or upstream');
  }
  return parsed;
}

// Hot-reload config (check every 5s)
setInterval(() => {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs !== lastConfigMtime) {
      lastConfigMtime = stat.mtimeMs;
      config = loadConfig();
      log('info', 'Config hot-reloaded');
    }
  } catch (e) {
    log('error', `Config reload failed: ${e.message}`);
  }
}, 5000);

// ─── Logging ──────────────────────────────────────────────────────────────────

const LOG_PATH = '/tmp/openclaw/anthropic-proxy.log';

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB max log size

function log(level, msg, extra = {}) {
  if (level === 'debug') return; // skip debug in production
  const entry = JSON.stringify({
    t: new Date().toISOString(),
    l: level,
    m: msg,
    ...extra
  });
  // Stdout for LaunchAgent capture
  console.log(entry);
  // Append to log file with rotation
  try {
    const stat = fs.statSync(LOG_PATH).size;
    if (stat > MAX_LOG_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.old');
    }
  } catch {}
  try {
    fs.appendFileSync(LOG_PATH, entry + '\n');
  } catch {}
}

// ─── Cooldown Tracking ───────────────────────────────────────────────────────

// keyId -> { until: timestamp, model: string (optional, for per-model cooldown) }
const cooldowns = new Map();

function cooldownKey(keyId, model) {
  return model ? `${keyId}:${model}` : keyId;
}

function isInCooldown(keyId, model) {
  // Check key-level cooldown
  const keyCD = cooldowns.get(keyId);
  if (keyCD && Date.now() < keyCD) return true;
  if (keyCD && Date.now() >= keyCD) cooldowns.delete(keyId);

  // Check key+model cooldown
  if (model) {
    const modelCD = cooldowns.get(cooldownKey(keyId, model));
    if (modelCD && Date.now() < modelCD) return true;
    if (modelCD && Date.now() >= modelCD) cooldowns.delete(cooldownKey(keyId, model));
  }

  return false;
}

function setCooldown(keyId, model, retryAfterSec) {
  const durationMs = retryAfterSec
    ? Math.min(retryAfterSec * 1000, config.cooldownMs)
    : config.cooldownMs;
  const until = Date.now() + durationMs;

  // Set per key+model cooldown (not blanket key cooldown)
  // This way if opus is limited but sonnet isn't, we can still use the key for sonnet
  const ck = cooldownKey(keyId, model);
  cooldowns.set(ck, until);
  log('warn', `Cooldown set: ${ck}`, {
    untilISO: new Date(until).toISOString(),
    durationMin: Math.round(durationMs / 60000)
  });
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

const metrics = {
  totalRequests: 0,
  totalRetries: 0,
  totalFailures: 0,
  totalSuccess: 0,
  byKey: {},
  byModel: {},
  modelFallbacks: 0,
  startedAt: Date.now()
};

function recordSuccess(keyId, model) {
  metrics.totalSuccess++;
  metrics.byKey[keyId] = (metrics.byKey[keyId] || 0) + 1;
  metrics.byModel[model] = (metrics.byModel[model] || 0) + 1;
}

// ─── Request Helpers ─────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function proxyRequest(reqPath, method, headers, body, keyToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, config.upstream);

    const proxyHeaders = {};
    // Copy safe headers
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      // Strip hop-by-hop + auth + proxy-internal debug headers
      if (
        lk === 'host' ||
        lk === 'connection' ||
        lk === 'x-api-key' ||
        lk === 'authorization' ||
        lk.startsWith('x-proxy-')
      ) continue;
      proxyHeaders[k] = v;
    }
    // Set our auth — setup-tokens (sk-ant-oat01-*) use Bearer auth with
    // special beta headers; API keys (sk-ant-api03-*) use x-api-key header
    if (keyToken.includes('sk-ant-oat')) {
      delete proxyHeaders['x-api-key'];
      proxyHeaders['authorization'] = `Bearer ${keyToken}`;
      // Required beta flags for OAuth tokens (from Anthropic SDK)
      const existingBeta = proxyHeaders['anthropic-beta'] || '';
      const requiredBetas = ['claude-code-20250219', 'oauth-2025-04-20'];
      const allBetas = [...new Set([...existingBeta.split(',').filter(Boolean), ...requiredBetas])];
      proxyHeaders['anthropic-beta'] = allBetas.join(',');
    } else {
      proxyHeaders['x-api-key'] = keyToken;
    }
    // Update content-length
    if (body) proxyHeaders['content-length'] = Buffer.byteLength(body);

    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: proxyHeaders
    };

    const proxyReq = https.request(opts, resolve);
    proxyReq.on('error', reject);
    // Timeout for the connection itself
    proxyReq.setTimeout(120000, () => {
      proxyReq.destroy(new Error('Upstream timeout (120s)'));
    });
    if (body && body.length > 0) proxyReq.write(body);
    proxyReq.end();
  });
}

function consumeResponse(res) {
  return new Promise(resolve => {
    res.resume();
    res.on('end', resolve);
    res.on('error', resolve);
  });
}

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handleRequest(req, res, profile) {
  // Health endpoint
  if (req.url === '/health') {
    const activeCooldowns = {};
    for (const [k, until] of cooldowns.entries()) {
      if (Date.now() < until) {
        activeCooldowns[k] = {
          until: new Date(until).toISOString(),
          remainingMin: Math.round((until - Date.now()) / 60000)
        };
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor((Date.now() - metrics.startedAt) / 1000),
      profile,
      metrics: {
        total: metrics.totalRequests,
        success: metrics.totalSuccess,
        retries: metrics.totalRetries,
        failures: metrics.totalFailures,
        modelFallbacks: metrics.modelFallbacks,
        byKey: metrics.byKey,
        byModel: metrics.byModel
      },
      cooldowns: activeCooldowns,
      keys: Object.entries(config.keys).map(([id, k]) => ({
        id,
        label: k.label,
        inCooldown: isInCooldown(id)
      }))
    }, null, 2));
    return;
  }

  // Cooldown clear endpoint (manual override)
  if (req.url === '/clear-cooldowns' && req.method === 'POST') {
    cooldowns.clear();
    log('info', 'All cooldowns cleared manually');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cleared' }));
    return;
  }

  metrics.totalRequests++;

  const body = await readBody(req);
  let parsedBody;
  try {
    parsedBody = JSON.parse(body.toString());
  } catch {
    parsedBody = null;
  }

  const originalModel = parsedBody?.model;

  // Build model chain: requested model → fallback model
  const modelChain = [originalModel];
  if (originalModel && config.modelFallback[originalModel]) {
    modelChain.push(config.modelFallback[originalModel]);
  }

  const keyOrder = config.keyOrder[profile] || config.keyOrder.default;
  let lastError = null;
  let attempted = 0;

  for (const model of modelChain) {
    const isModelFallback = model !== originalModel;

    for (const keyId of keyOrder) {
      if (isInCooldown(keyId, model)) {
        log('debug', `Skipping ${keyId} for ${model} (in cooldown)`);
        continue;
      }

      const keyToken = config.keys[keyId]?.token;
      if (!keyToken) continue;

      attempted++;

      // Build request body (swap model if falling back)
      let requestBody = body;
      if (isModelFallback && parsedBody) {
        requestBody = Buffer.from(JSON.stringify({ ...parsedBody, model }));
      }

      try {
        const proxyRes = await proxyRequest(req.url, req.method, req.headers, requestBody, keyToken);

        if (proxyRes.statusCode === 429) {
          // Parse retry-after if available
          const retryAfter = parseInt(proxyRes.headers['retry-after'], 10) || null;
          setCooldown(keyId, model, retryAfter);
          metrics.totalRetries++;
          await consumeResponse(proxyRes);

          log('warn', '429 rate limited', {
            key: keyId,
            model,
            retryAfter,
            profile
          });
          continue;
        }

        if (proxyRes.statusCode === 529) {
          // Anthropic overloaded — retry next key, short cooldown
          setCooldown(keyId, model, 60);
          metrics.totalRetries++;
          await consumeResponse(proxyRes);
          log('warn', '529 overloaded', { key: keyId, model });
          continue;
        }

        // Success (or non-retryable error) — pipe through
        recordSuccess(keyId, model);

        if (isModelFallback) {
          metrics.modelFallbacks++;
          log('info', `Model fallback used: ${originalModel} → ${model}`, { key: keyId, profile });
        }

        // Build response headers
        const responseHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          responseHeaders[k] = v;
        }
        // Debug headers (safe — only visible to local clients)
        responseHeaders['x-proxy-key'] = keyId;
        responseHeaders['x-proxy-model'] = model;
        if (isModelFallback) {
          responseHeaders['x-proxy-fallback'] = `${originalModel} → ${model}`;
        }

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
        return;

      } catch (err) {
        lastError = err;
        log('error', `Proxy request failed`, { key: keyId, model, error: err.message });
        continue;
      }
    }
  }

  // All keys exhausted across all models
  metrics.totalFailures++;
  log('error', 'ALL KEYS AND MODELS EXHAUSTED', {
    profile,
    originalModel,
    attempted,
    cooldownCount: cooldowns.size
  });

  // Notify on total failure
  if (config.notifyOnFailure && config.notifyContact) {
    try {
      const { execSync } = require('child_process');
      const msg = `🚨 Anthropic Proxy FAILURE: All ${Object.keys(config.keys).length} keys exhausted across all models (${modelChain.join(' → ')}). ${cooldowns.size} cooldowns active. Check /health on port ${config.port}.`;
      execSync(
        `/opt/homebrew/bin/imsg send "${config.notifyContact}" "${msg.replace(/"/g, '\\"')}"`,
        { timeout: 10000, stdio: 'ignore' }
      );
    } catch (notifyErr) {
      log('error', 'Failed to send notification', { error: notifyErr.message });
    }
  }

  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `Proxy: all ${Object.keys(config.keys).length} keys exhausted across models [${modelChain.join(', ')}]. Cooldowns active for ~${Math.round(config.cooldownMs / 60000)}min. Last error: ${lastError?.message || 'rate_limit'}`
    }
  }));
}

// ─── Servers ─────────────────────────────────────────────────────────────────

// Error handler wrapper
function withErrorHandler(profile) {
  return async (req, res) => {
    try {
      await handleRequest(req, res, profile);
    } catch (err) {
      log('error', 'Unhandled request error', { error: err.message, stack: err.stack });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal proxy error' }));
      }
    }
  };
}

// Default server (OpenClaw gateway) — port 18800
const defaultServer = http.createServer(withErrorHandler('default'));
defaultServer.keepAliveTimeout = 120000;
defaultServer.headersTimeout = 125000;

// Claude Code server — port 18801 (reverse key order)
const ccServer = http.createServer(withErrorHandler('claude-code'));
ccServer.keepAliveTimeout = 120000;
ccServer.headersTimeout = 125000;

const DEFAULT_PORT = config.port || 18800;
const CC_PORT = config.claudeCodePort || 18801;

defaultServer.listen(DEFAULT_PORT, '127.0.0.1', () => {
  log('info', `Anthropic proxy [default] listening on 127.0.0.1:${DEFAULT_PORT}`);
  log('info', `Key order: ${(config.keyOrder.default || []).join(' → ')}`);
});

ccServer.listen(CC_PORT, '127.0.0.1', () => {
  log('info', `Anthropic proxy [claude-code] listening on 127.0.0.1:${CC_PORT}`);
  log('info', `Key order: ${(config.keyOrder['claude-code'] || []).join(' → ')}`);
});

// Graceful shutdown
function shutdown(signal) {
  log('info', `Shutting down on ${signal}`);
  defaultServer.close();
  ccServer.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Periodic metrics log (every 5 min)
setInterval(() => {
  if (metrics.totalRequests > 0) {
    log('info', 'Periodic metrics', {
      total: metrics.totalRequests,
      success: metrics.totalSuccess,
      retries: metrics.totalRetries,
      failures: metrics.totalFailures,
      modelFallbacks: metrics.modelFallbacks,
      activeCooldowns: [...cooldowns.entries()]
        .filter(([, v]) => Date.now() < v)
        .map(([k]) => k)
    });
  }
}, 300000);

log('info', 'Anthropic proxy started', {
  keys: Object.keys(config.keys).length,
  models: Object.keys(config.modelFallback).length,
  cooldownMin: Math.round(config.cooldownMs / 60000)
});
