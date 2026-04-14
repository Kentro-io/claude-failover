'use strict';

const https = require('https');
const { URL } = require('url');
const { getConfig } = require('./config');
const { log } = require('./logger');
const cooldown = require('./cooldown');
const metrics = require('./metrics');
const { handleViaOpenAI } = require('./adapter-openai');
const { buildPriorityOrder, decodePriorityItem } = require('./profile-order');

const UPSTREAM = 'https://api.anthropic.com';

// Server error status codes that are retryable
const RETRYABLE_SERVER_ERRORS = new Set([500, 502, 503]);
const MAX_SERVER_ERROR_RETRIES = 3;

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
  const priorityItems = buildPriorityOrder(profile, config)
    .map(decodePriorityItem)
    .filter(Boolean)
    .filter(item => item.provider === 'openai'
      ? Boolean(config.openaiKeys?.[item.id]?.token)
      : Boolean(config.keys?.[item.id]?.token));
  const anthropicKeyOrder = priorityItems.filter(item => item.provider === 'anthropic').map(item => item.id);
  const allPriorityKeyIds = priorityItems.map(item => item.id);

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

  // ── Non-model requests: passthrough with first available key, no fallback ──
  if (!originalModel) {
    const firstKeyId = anthropicKeyOrder.find(id => config.keys[id]?.token);
    if (!firstKeyId) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Anthropic keys configured for non-model request' }));
      return;
    }
    try {
      const proxyRes = await proxyRequest(
        req.url, req.method, req.headers, body, config.keys[firstKeyId].token
      );
      const responseHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        responseHeaders[k] = v;
      }
      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream connection failed' }));
      }
    }
    return;
  }

  // ── Build model chain: follow fallback links (multi-hop with cycle detection) ──
  const modelChain = [originalModel];
  if (config.modelFallback) {
    let current = originalModel;
    const seen = new Set([current]);
    while (config.modelFallback[current]) {
      const next = config.modelFallback[current];
      if (seen.has(next)) break; // cycle detection
      seen.add(next);
      modelChain.push(next);
      current = next;
      if (modelChain.length >= 5) break; // cap depth
    }
  }

  let lastError = null;
  let attempted = 0;
  let serverErrorRetries = 0;
  let lastServerErrorStatus = null;
  let queueAttempt = 0;
  const queueWaitMs = config.queueWaitMs ?? 90000;

  // ── Outer queue-retry loop: holds the request when all keys are rate-limited ──
  while (true) {
    // Reset per-attempt counters on queue retries
    if (queueAttempt > 0) {
      serverErrorRetries = 0;
      lastServerErrorStatus = null;
      lastError = null;
      attempted = 0;
    }

    for (const model of modelChain) {
      const isModelFallback = model !== originalModel;
      let advanceToNextModel = false;

      for (const item of priorityItems) {
        const keyId = item.id;
        const provider = item.provider;
        const openaiTargetModel = (config.openaiModelMapping || {})[model]
          || (config.openaiModelMapping || {})['*']
          || model;

        if (provider === 'anthropic') {
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
              const cooldownSec = retryAfter || 30;
              const cd = cooldown.setCooldown(keyId, model, cooldownSec, 60000);
              metrics.recordRetry();
              await consumeResponse(proxyRes);
              log('warn', '429 rate limited', {
                key: keyId, model, retryAfter, cooldownSec, profile: profileName,
                cooldownUntil: cd.until, rateLimit: true
              });
              continue;
            }

            if (proxyRes.statusCode === 529) {
              cooldown.setCooldown(keyId, model, 10, 30000);
              metrics.recordRetry();
              await consumeResponse(proxyRes);
              log('warn', '529 overloaded', { key: keyId, model, rateLimit: true });
              continue;
            }

            if (proxyRes.statusCode === 404) {
              await consumeResponse(proxyRes);
              log('warn', '404 not found — key may lack model access', {
                key: keyId, model, path: req.url
              });
              continue;
            }

            if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
              cooldown.setCooldown(keyId, null, 300, 300000);
              await consumeResponse(proxyRes);
              log('warn', `${proxyRes.statusCode} auth error — blanket cooldown`, {
                key: keyId, model
              });
              continue;
            }

            if (RETRYABLE_SERVER_ERRORS.has(proxyRes.statusCode)) {
              serverErrorRetries++;
              lastServerErrorStatus = proxyRes.statusCode;
              metrics.recordRetry();
              await consumeResponse(proxyRes);

              if (serverErrorRetries >= MAX_SERVER_ERROR_RETRIES) {
                log('warn', `${proxyRes.statusCode} server error — exhausted ${MAX_SERVER_ERROR_RETRIES} retries, trying model fallback`, {
                  key: keyId, model, retries: serverErrorRetries
                });
                advanceToNextModel = true;
                break;
              }

              log('warn', `${proxyRes.statusCode} server error (retry ${serverErrorRetries}/${MAX_SERVER_ERROR_RETRIES})`, {
                key: keyId, model
              });
              continue;
            }

            const latency = Date.now() - startTime;
            metrics.recordSuccess(keyId, model);

            if (isModelFallback) {
              metrics.recordModelFallback();
              log('info', `Model fallback: ${originalModel} -> ${model}`, {
                key: keyId, profile: profileName
              });
            }

            if (queueAttempt > 0) {
              log('info', `QUEUE SUCCESS — request delivered after ${queueAttempt} queue attempt(s), ${Math.ceil(latency / 1000)}s total wait`, {
                key: keyId, model, profile: profileName,
                queueAttempts: queueAttempt, queued: true
              });
            }

            metrics.addRecentRequest({
              method: req.method,
              path: req.url,
              model: model || 'unknown',
              key: keyId,
              status: proxyRes.statusCode,
              latency,
              fallback: isModelFallback ? `${originalModel} -> ${model}` : null,
              queued: queueAttempt > 0 ? queueAttempt : undefined,
              queueTime: queueAttempt > 0 ? latency : undefined,
              provider: 'anthropic'
            });

            const responseHeaders = {};
            for (const [k, v] of Object.entries(proxyRes.headers)) {
              responseHeaders[k] = v;
            }
            responseHeaders['x-proxy-key'] = keyId;
            responseHeaders['x-proxy-model'] = model || 'unknown';
            responseHeaders['x-proxy-provider'] = 'anthropic';
            if (isModelFallback) {
              responseHeaders['x-proxy-fallback'] = `${originalModel} -> ${model}`;
            }
            if (queueAttempt > 0) {
              responseHeaders['x-proxy-queued'] = String(queueAttempt);
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

        if (!config.openaiModelFallback) continue;
        if (cooldown.isInCooldown(keyId, 'openai')) continue;

        const keyEntry = config.openaiKeys[keyId];
        if (!keyEntry?.token) continue;

        attempted++;

        try {
          const openaiBody = isModelFallback && parsedBody
            ? { ...parsedBody, model }
            : parsedBody;

          const result = await handleViaOpenAI(
            openaiBody, openaiTargetModel, config.openaiBaseUrl || 'https://api.openai.com', keyEntry.token, res
          );

          if (result.success) {
            const latency = Date.now() - startTime;
            metrics.recordSuccess(keyId, openaiTargetModel);

            if (isModelFallback) {
              metrics.recordModelFallback();
              log('info', `Model fallback: ${originalModel} -> ${model} via OpenAI ${openaiTargetModel}`, {
                key: keyId, profile: profileName
              });
            }

            if (queueAttempt > 0) {
              log('info', `QUEUE SUCCESS — request delivered after ${queueAttempt} queue attempt(s), ${Math.ceil(latency / 1000)}s total wait`, {
                key: keyId, model: openaiTargetModel, profile: profileName,
                queueAttempts: queueAttempt, queued: true, provider: 'openai'
              });
            }

            metrics.addRecentRequest({
              method: req.method,
              path: req.url,
              model: openaiTargetModel,
              key: keyId,
              status: 200,
              latency,
              fallback: isModelFallback ? `${originalModel} -> ${model} -> ${openaiTargetModel}` : null,
              queued: queueAttempt > 0 ? queueAttempt : undefined,
              queueTime: queueAttempt > 0 ? latency : undefined,
              provider: 'openai'
            });
            return;
          }

          if (result.statusCode === 429) {
            cooldown.setCooldown(keyId, 'openai', result.retryAfter || 30, 60000);
            metrics.recordRetry();
            log('warn', 'OpenAI 429 rate limited', { key: keyId, model: openaiTargetModel, rateLimit: true });
            continue;
          }

          if (result.statusCode === 401 || result.statusCode === 403) {
            cooldown.setCooldown(keyId, null, 300, 300000);
            log('warn', `OpenAI ${result.statusCode} auth error`, { key: keyId, model: openaiTargetModel });
            continue;
          }

          if (result.statusCode === 404) {
            log('warn', 'OpenAI 404 — model not found', { key: keyId, model: openaiTargetModel });
            continue;
          }

          if (RETRYABLE_SERVER_ERRORS.has(result.statusCode)) {
            serverErrorRetries++;
            lastServerErrorStatus = result.statusCode;
            metrics.recordRetry();

            if (serverErrorRetries >= MAX_SERVER_ERROR_RETRIES) {
              log('warn', `OpenAI ${result.statusCode} server error — exhausted ${MAX_SERVER_ERROR_RETRIES} retries, trying model fallback`, {
                key: keyId, model: openaiTargetModel, retries: serverErrorRetries
              });
              advanceToNextModel = true;
              break;
            }

            log('warn', `OpenAI ${result.statusCode} server error (retry ${serverErrorRetries}/${MAX_SERVER_ERROR_RETRIES})`, {
              key: keyId, model: openaiTargetModel
            });
            continue;
          }

          log('warn', `OpenAI error ${result.statusCode}`, { key: keyId, model: openaiTargetModel });
        } catch (err) {
          lastError = err;
          log('error', 'OpenAI request failed', {
            key: keyId, model: openaiTargetModel, error: err.message
          });
          continue;
        }
      }

      if (advanceToNextModel) {
        continue;
      }
    }

    // ── All keys/models exhausted for this attempt — should we queue? ──

    // Don't queue server errors — they need different handling
    if (lastServerErrorStatus) break;

    // Check if queuing is enabled and we haven't timed out
    const elapsed = Date.now() - startTime;
    if (queueWaitMs <= 0 || elapsed >= queueWaitMs) break;

    // Safety cap on queue attempts
    if (queueAttempt >= 30) break;

    // Check client is still connected
    if (req.socket.destroyed || res.writableEnded) {
      log('debug', 'Client disconnected during queue wait, dropping request');
      return;
    }

    // Find the shortest cooldown expiry across all keys/models
    const waitMs = cooldown.getShortestWait(allPriorityKeyIds, [...modelChain, 'openai']);
    if (waitMs <= 0) break; // no active cooldowns — something else is wrong

    const maxRemaining = queueWaitMs - elapsed;
    const cappedWait = Math.min(waitMs + 1000, maxRemaining); // +1s buffer past cooldown
    if (cappedWait <= 0) break;

    queueAttempt++;
    metrics.recordQueuedRetry();

    log('info', `QUEUED — all keys rate-limited, holding request ${Math.ceil(cappedWait / 1000)}s`, {
      profile: profileName,
      model: originalModel,
      queueAttempt,
      elapsed: `${Math.ceil(elapsed / 1000)}s/${Math.ceil(queueWaitMs / 1000)}s`,
      nextRetryIn: `${Math.ceil(cappedWait / 1000)}s`,
      queued: true, rateLimit: true
    });

    await new Promise(r => setTimeout(r, cappedWait));
  }

  // ── All retries exhausted across the unified provider priority list ──
  metrics.recordFailure();
  const latency = Date.now() - startTime;

  metrics.addRecentRequest({
    method: req.method,
    path: req.url,
    model: originalModel || 'unknown',
    key: 'none',
    status: lastServerErrorStatus || 429,
    latency,
    fallback: null,
    error: lastServerErrorStatus ? 'server_error_retries_exhausted' : 'all_keys_exhausted',
    queued: queueAttempt > 0 ? queueAttempt : undefined,
    queueTime: queueAttempt > 0 ? latency : undefined,
    provider: 'mixed'
  });

  // If we exhausted retries due to server errors, return 502 (not 429)
  if (lastServerErrorStatus) {
    log('error', 'SERVER ERROR RETRIES EXHAUSTED', {
      profile: profileName,
      originalModel,
      attempted,
      serverErrorRetries,
      lastStatus: lastServerErrorStatus,
      modelChain: modelChain.join(' -> ')
    });

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'server_error',
        message: `Proxy: upstream returned ${lastServerErrorStatus} after ${serverErrorRetries} retries across ${modelChain.length} model(s) [${modelChain.join(', ')}].`
      }
    }));
    return;
  }

  log('error', 'ALL KEYS AND MODELS EXHAUSTED', {
    profile: profileName,
    originalModel,
    attempted,
    queueAttempts: queueAttempt,
    totalWait: `${Math.ceil(latency / 1000)}s`,
    cooldownCount: Object.keys(cooldown.getActiveCooldowns()).length,
    rateLimit: true
  });

  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: `Proxy: all ${priorityItems.length} provider slots exhausted across models [${modelChain.join(', ')}] after ${queueAttempt} queue attempt(s) over ${Math.ceil(latency / 1000)}s. Active cooldowns: ${Object.keys(cooldown.getActiveCooldowns()).length}.`
    }
  }));
}

module.exports = { handleProxyRequest };
