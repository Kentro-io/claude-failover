'use strict';

const MAX_RECENT_REQUESTS = 100;

const state = {
  totalRequests: 0,
  totalRetries: 0,
  totalFailures: 0,
  totalSuccess: 0,
  modelFallbacks: 0,
  byKey: {},
  byModel: {},
  startedAt: Date.now()
};

const recentRequests = [];

function recordRequest() {
  state.totalRequests++;
}

function recordSuccess(keyId, model) {
  state.totalSuccess++;
  state.byKey[keyId] = (state.byKey[keyId] || 0) + 1;
  if (model) {
    state.byModel[model] = (state.byModel[model] || 0) + 1;
  }
}

function recordRetry() {
  state.totalRetries++;
}

function recordFailure() {
  state.totalFailures++;
}

function recordModelFallback() {
  state.modelFallbacks++;
}

function addRecentRequest(entry) {
  recentRequests.push({
    ...entry,
    timestamp: new Date().toISOString()
  });
  if (recentRequests.length > MAX_RECENT_REQUESTS) {
    recentRequests.shift();
  }
}

function getMetrics() {
  return {
    ...state,
    uptime: Math.floor((Date.now() - state.startedAt) / 1000)
  };
}

function getRecentRequests(n = 10) {
  return recentRequests.slice(-n);
}

module.exports = {
  recordRequest,
  recordSuccess,
  recordRetry,
  recordFailure,
  recordModelFallback,
  addRecentRequest,
  getMetrics,
  getRecentRequests
};
