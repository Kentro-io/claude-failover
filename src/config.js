'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-failover');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const PID_PATH = path.join(CONFIG_DIR, 'pid');

const DEFAULT_CONFIG = {
  profiles: {
    default: {
      port: 4080,
      keyOrder: []
    }
  },
  keys: {},
  modelFallback: {
    'claude-opus-4-6': 'claude-sonnet-4-6',
    'claude-opus-4-5-20250414': 'claude-sonnet-4-5-20250414'
  },
  cooldownMs: 3600000,
  logLevel: 'info',
  maxLogSize: 5242880
};

let currentConfig = null;
let lastConfigMtime = 0;
let watcherInterval = null;
const changeListeners = [];

function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    writeConfigFile(DEFAULT_CONFIG);
  }
  return loadConfig();
}

function writeConfigFile(cfg) {
  const data = JSON.stringify(cfg, null, 2);
  fs.writeFileSync(CONFIG_PATH, data, { mode: 0o600 });
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  // Merge with defaults for any missing fields
  currentConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    profiles: { ...DEFAULT_CONFIG.profiles, ...parsed.profiles },
    modelFallback: { ...DEFAULT_CONFIG.modelFallback, ...parsed.modelFallback }
  };
  return currentConfig;
}

function saveConfig(cfg) {
  currentConfig = cfg;
  writeConfigFile(cfg);
  lastConfigMtime = fs.statSync(CONFIG_PATH).mtimeMs;
}

function getConfig() {
  if (!currentConfig) {
    loadConfig();
  }
  return currentConfig;
}

function startConfigWatcher() {
  if (watcherInterval) return;
  try {
    lastConfigMtime = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {}
  watcherInterval = setInterval(() => {
    try {
      const stat = fs.statSync(CONFIG_PATH);
      if (stat.mtimeMs !== lastConfigMtime) {
        lastConfigMtime = stat.mtimeMs;
        loadConfig();
        for (const fn of changeListeners) {
          try { fn(currentConfig); } catch {}
        }
      }
    } catch {}
  }, 5000);
  watcherInterval.unref();
}

function stopConfigWatcher() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
}

function onConfigChange(fn) {
  changeListeners.push(fn);
}

function generateKeyId(label) {
  const base = (label || 'key').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const cfg = getConfig();
  let id = base;
  let i = 2;
  while (cfg.keys[id]) {
    id = `${base}-${i}`;
    i++;
  }
  return id;
}

function detectKeyType(token) {
  if (token.startsWith('sk-ant-oat')) return 'oauth';
  return 'api-key';
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  LOG_DIR,
  PID_PATH,
  DEFAULT_CONFIG,
  ensureConfig,
  loadConfig,
  saveConfig,
  getConfig,
  startConfigWatcher,
  stopConfigWatcher,
  onConfigChange,
  generateKeyId,
  detectKeyType
};
