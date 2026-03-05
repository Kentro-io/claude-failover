'use strict';

const fs = require('fs');
const path = require('path');
const { LOG_DIR, getConfig } = require('./config');

const MAX_RECENT = 200;
const recentLogs = [];
const listeners = new Set();

function getLogPath() {
  return path.join(LOG_DIR, 'proxy.log');
}

function log(level, msg, extra = {}) {
  const config = getConfig();
  const configLevel = config?.logLevel || 'info';
  if (level === 'debug' && configLevel !== 'debug') return;

  const entry = {
    t: new Date().toISOString(),
    l: level,
    m: msg,
    ...extra
  };

  const line = JSON.stringify(entry);

  // Console output
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }

  // File logging with rotation
  const logPath = getLogPath();
  try {
    const maxSize = config?.maxLogSize || 5242880;
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > maxSize) {
        try { fs.unlinkSync(logPath + '.old'); } catch {}
        fs.renameSync(logPath, logPath + '.old');
      }
    } catch {}
    fs.appendFileSync(logPath, line + '\n');
  } catch {}

  // In-memory recent buffer
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT) {
    recentLogs.shift();
  }

  // Notify SSE listeners
  for (const fn of listeners) {
    try { fn(entry); } catch {}
  }
}

function getRecentLogs(n = 50) {
  return recentLogs.slice(-n);
}

function addLogListener(fn) {
  listeners.add(fn);
}

function removeLogListener(fn) {
  listeners.delete(fn);
}

module.exports = {
  log,
  getRecentLogs,
  getLogPath,
  addLogListener,
  removeLogListener
};
