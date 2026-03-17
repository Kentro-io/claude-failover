'use strict';

const https = require('https');
const { URL } = require('url');
const { getConfig } = require('./config');
const { log } = require('./logger');
const cooldown = require('./cooldown');
const metrics = require('./metrics');

const UPSTREAM = 'https://api.anthropic.com';

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
    const url = new URL(reqPath, UPSTREAM);

    const proxyHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (
        lk === 'host' ||
        lk === 'connection' ||
        lk === 'x-api-key' ||
        lk === 'authorization' ||
        lk.startsWith('x-proxy-')
      ) continue;
      proxyHeaders[k] = v;
    }

    // OAuth tokens use Bearer auth + beta headers
    if (keyToken.includes('sk-ant-oat')) {
      delete proxyHeaders['x-api-key'];
      proxyHeaders['authorization'] = `Bearer ${keyToken}`;
      const existingBeta = proxyHeaders['anthropic-beta'] || '';
      const requiredBetas = ['claude-code-20250219', 'oauth-2025-04-20'];
      const allBetas = [...new Set([
        ...existingBeta.split(',').filter(Boolean),
        ...requiredBetas
      ])];
      proxyHeaders['anthropic-beta'] = allBetas.join(',');
    } else {
      proxyHeaders['x-api-key'] = keyToken;
    }

    if (body && body.length > 0) {
      proxyHeaders['content-length'] = Buffer.byteLength(body);
    }

    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: proxyHeaders
    };

    const proxyReq = https.request(opts, resolve);
    proxyReq.on('error', reject);
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

async function handleProxyRequest(req, res, profileName) {
  const config = getConfig();
  const profile = config.profiles[profileName] || config.profiles.default;
  const keyOrder = profile.keyOrder || [];

  metrics.recordRequest();

  const body = await readBody(req);
  let parsedBody;
  try {
    parsedBody = JSON.parse(body.toString());
  } catch {
    parsedBody = null;
  }

  const originalModel = parsedBody?.model;
  const startTime = Date.now();

  // Build model chain: requested → fallback
  const modelChain = [originalModel];
  if (originalModel && config.modelFallback && config.modelFallback[originalModel]) {
    modelChain.push(config.modelFallback[originalModel]);
  }

  let lastError = null;
  let attempted = 0;

  for (const model of modelChain) {
    const isModelFallback = model !== originalModel;

    for (const keyId of keyOrder) {
      if (cooldown.isInCooldown(keyId, model)) {
        log('debug', `Skipping ${keyId} for ${model} (in cooldown)`);
        continue;
      }

      const keyEntry = config.keys[keyId];
      if (!keyEntry?.token) continue;

      attempted++;

      let requestBody = body;
      if (isModelFallback && parsedBody) {
        requestBody = Buffer.from(JSON.stringify({ ...parsedBody, model }));
      }

      try {
        const proxyRes = await proxyRequest(
          req.url, req.method, req.headers, requestBody, keyEntry.token
        );

        if (proxyRes.statusCode === 429) {
          const retryAfter = parseInt(proxyRes.headers['retry-after'], 10) || null;
          // Set per-model cooldown
          const cd = cooldown.setCooldown(keyId, model, retryAfter, config.cooldownMs);
          // Also set blanket key-level cooldown (rate limits are usually account-wide)
          cooldown.setCooldown(keyId, null, retryAfter, config.cooldownMs);
          metrics.recordRetry();
          await consumeResponse(proxyRes);
          log('warn', '429 rate limited', {
            key: keyId, model, retryAfter, profile: profileName,
            cooldownUntil: cd.until
          });
          continue;
        }

        if (proxyRes.statusCode === 529) {
          cooldown.setCooldown(keyId, model, 60, config.cooldownMs);
          metrics.recordRetry();
          await consumeResponse(proxyRes);
          log('warn', '529 overloaded', { key: keyId, model });
          continue;
        }

        if (proxyRes.statusCode === 404) {
          // 404 = key doesn't have access to this model/endpoint, try next key
          await consumeResponse(proxyRes);
          log('warn', '404 not found — key may lack model access', {
            key: keyId, model, path: req.url
          });
          continue;
        }

        if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
          // Auth failure — skip this key entirely (blanket cooldown)
          cooldown.setCooldown(keyId, null, 300, config.cooldownMs);
          await consumeResponse(proxyRes);
          log('warn', `${proxyRes.statusCode} auth error — blanket cooldown`, {
            key: keyId, model
          });
          continue;
        }

        // Success (or non-retryable error) — pipe through
        const latency = Date.now() - startTime;
        metrics.recordSuccess(keyId, model);

        if (isModelFallback) {
          metrics.recordModelFallback();
          log('info', `Model fallback: ${originalModel} → ${model}`, {
            key: keyId, profile: profileName
          });
        }

        metrics.addRecentRequest({
          method: req.method,
          path: req.url,
          model: model || 'unknown',
          key: keyId,
          status: proxyRes.statusCode,
          latency,
          fallback: isModelFallback ? `${originalModel} → ${model}` : null
        });

        // Build response headers
        const responseHeaders = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          responseHeaders[k] = v;
        }
        responseHeaders['x-proxy-key'] = keyId;
        responseHeaders['x-proxy-model'] = model || 'unknown';
        if (isModelFallback) {
          responseHeaders['x-proxy-fallback'] = `${originalModel} → ${model}`;
        }

        res.writeHead(proxyRes.statusCode, responseHeaders);
        proxyRes.pipe(res);
        return;

      } catch (err) {
        lastError = err;
        log('error', 'Proxy request failed', {
          key: keyId, model, error: err.message
        });
        continue;
      }
    }
  }

  // All keys exhausted
  metrics.recordFailure();
  const latency = Date.now() - startTime;

  metrics.addRecentRequest({
    method: req.method,
    path: req.url,
    model: originalModel || 'unknown',
    key: 'none',
    status: 429,
    latency,
    fallback: null,
    error: 'all_keys_exhausted'
  });

  log('error', 'ALL KEYS AND MODELS EXHAUSTED', {
    profile: profileName,
    originalModel,
    attempted,
    cooldownCount: Object.keys(cooldown.getActiveCooldowns()).length
  });

  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `Proxy: all ${Object.keys(config.keys).length} keys exhausted across models [${modelChain.join(', ')}]. Cooldowns active for ~${Math.round((config.cooldownMs || 3600000) / 60000)}min. Last error: ${lastError?.message || 'rate_limit'}`
    }
  }));
}

module.exports = { handleProxyRequest };
