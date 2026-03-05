#!/usr/bin/env node
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');

// Resolve src modules
const srcDir = path.join(__dirname, '..', 'src');
const { ensureConfig, getConfig, saveConfig, CONFIG_PATH, CONFIG_DIR, generateKeyId, detectKeyType } = require(path.join(srcDir, 'config'));
const { getDaemonStatus, startDaemon, stopDaemon, installLaunchAgent, uninstallLaunchAgent } = require(path.join(srcDir, 'daemon'));
const { detectTools, setupShell, setupClaudeCode, setupCursor } = require(path.join(srcDir, 'setup'));
const { getLogPath } = require(path.join(srcDir, 'logger'));

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function print(msg = '') { process.stdout.write(msg + '\n'); }
function error(msg) { process.stderr.write(`${c.red}Error: ${msg}${c.reset}\n`); }
function success(msg) { print(`${c.green}✓${c.reset} ${msg}`); }
function info(msg) { print(`${c.blue}ℹ${c.reset} ${msg}`); }
function warn(msg) { print(`${c.yellow}⚠${c.reset} ${msg}`); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskToken(token) {
  if (!token || token.length < 12) return '***';
  return token.slice(0, 10) + '...' + token.slice(-4);
}

function fetchJSON(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function readStdin(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      data = chunk.toString().trim();
      resolve(data);
    });
    process.stdin.resume();
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdStart(args) {
  ensureConfig();
  const config = getConfig();
  const defaultPort = config.profiles.default?.port || 4080;

  if (args.includes('-d') || args.includes('--daemon')) {
    const result = startDaemon();
    if (result.success) {
      success(`Daemon started (PID ${result.pid})`);
      info(`Dashboard: http://localhost:${defaultPort}/dashboard`);
      info(`Log: ${result.logPath}`);
    } else {
      error(result.message);
      process.exit(1);
    }
    return;
  }

  // Foreground mode
  print(`${c.bold}${c.blue}Claude Failover${c.reset} v${getVersion()}`);
  print();

  for (const [name, profile] of Object.entries(config.profiles)) {
    info(`Profile [${c.cyan}${name}${c.reset}] on port ${c.bold}${profile.port}${c.reset}`);
  }

  info(`Dashboard: ${c.cyan}http://localhost:${defaultPort}/dashboard${c.reset}`);
  info(`Keys configured: ${Object.keys(config.keys).length}`);
  print();

  if (Object.keys(config.keys).length === 0) {
    warn('No API keys configured. Add one:');
    print(`  ${c.dim}claude-failover add-key${c.reset}`);
    print(`  ${c.dim}Or visit http://localhost:${defaultPort}/dashboard${c.reset}`);
    print();
  }

  // Start servers (this blocks)
  require(path.join(srcDir, 'server')).startServers();
}

function cmdStop() {
  const result = stopDaemon();
  if (result.success) {
    success(`Daemon stopped (was PID ${result.pid})`);
  } else {
    error(result.message);
    process.exit(1);
  }
}

async function cmdStatus() {
  const config = ensureConfig();
  const defaultPort = config.profiles.default?.port || 4080;
  const daemonStatus = getDaemonStatus();

  print(`${c.bold}Claude Failover Status${c.reset}`);
  print();

  if (daemonStatus.running) {
    print(`  Status: ${c.green}● running${c.reset} (PID ${daemonStatus.pid})`);
  } else {
    print(`  Status: ${c.red}● stopped${c.reset}`);
  }

  // Try to get live status from health endpoint
  try {
    const health = await fetchJSON(defaultPort, '/health');
    print(`  Uptime: ${formatUptime(health.uptime)}`);
    print();

    print(`${c.bold}  Metrics${c.reset}`);
    print(`  Total requests:  ${health.metrics.total}`);
    print(`  Success:         ${c.green}${health.metrics.success}${c.reset}`);
    print(`  Retries:         ${c.yellow}${health.metrics.retries}${c.reset}`);
    print(`  Failures:        ${c.red}${health.metrics.failures}${c.reset}`);
    print(`  Model fallbacks: ${health.metrics.modelFallbacks}`);
    print(`  Success rate:    ${health.metrics.successRate}%`);
    print();

    if (Object.keys(health.cooldowns).length > 0) {
      print(`${c.bold}  Active Cooldowns${c.reset}`);
      for (const [key, cd] of Object.entries(health.cooldowns)) {
        print(`  ${c.yellow}⏳${c.reset} ${key}: ${cd.remainingMin}min remaining`);
      }
      print();
    }

    print(`${c.bold}  Keys${c.reset}`);
    for (const key of health.keys) {
      const status = key.inCooldown
        ? `${c.yellow}cooldown${c.reset}`
        : `${c.green}ready${c.reset}`;
      print(`  ${key.id} (${key.label}): ${status}`);
    }
  } catch {
    if (!daemonStatus.running) {
      info('Proxy is not running. Start with: claude-failover start');
    } else {
      warn('Could not connect to proxy health endpoint');
    }
  }
}

async function cmdAddKey(args) {
  ensureConfig();

  let token, label;

  if (args.length >= 1 && args[0].startsWith('sk-')) {
    token = args[0];
    label = args.slice(1).join(' ') || undefined;
  } else {
    token = await readStdin(`${c.blue}API key or OAuth token: ${c.reset}`);
    if (!token) {
      error('No token provided');
      process.exit(1);
    }
  }

  if (!label) {
    label = await readStdin(`${c.blue}Label (optional): ${c.reset}`);
  }

  if (!token.startsWith('sk-ant-')) {
    error('Invalid token format. Expected sk-ant-api03-* or sk-ant-oat01-*');
    process.exit(1);
  }

  const config = getConfig();
  const type = detectKeyType(token);
  const id = generateKeyId(label || 'key');

  config.keys[id] = {
    token,
    label: label || 'Unnamed Key',
    type,
    addedAt: new Date().toISOString()
  };

  for (const prof of Object.values(config.profiles)) {
    prof.keyOrder.push(id);
  }

  saveConfig(config);
  success(`Key added: ${c.cyan}${id}${c.reset} (${type})`);
  info(`Masked: ${maskToken(token)}`);
}

function cmdRemoveKey(args) {
  if (!args[0]) {
    error('Usage: claude-failover remove-key <key-id>');
    process.exit(1);
  }

  ensureConfig();
  const config = getConfig();
  const id = args[0];

  if (!config.keys[id]) {
    error(`Key not found: ${id}`);
    print('Available keys:');
    for (const [kid, k] of Object.entries(config.keys)) {
      print(`  ${kid} (${k.label})`);
    }
    process.exit(1);
  }

  delete config.keys[id];
  for (const prof of Object.values(config.profiles)) {
    prof.keyOrder = prof.keyOrder.filter(k => k !== id);
  }

  saveConfig(config);
  success(`Key removed: ${id}`);
}

function cmdListKeys() {
  ensureConfig();
  const config = getConfig();

  if (Object.keys(config.keys).length === 0) {
    info('No keys configured');
    print(`Add one: ${c.dim}claude-failover add-key${c.reset}`);
    return;
  }

  print(`${c.bold}API Keys${c.reset}`);
  print();

  for (const [id, k] of Object.entries(config.keys)) {
    print(`  ${c.cyan}${id}${c.reset}`);
    print(`    Label: ${k.label}`);
    print(`    Type:  ${k.type}`);
    print(`    Token: ${c.dim}${maskToken(k.token)}${c.reset}`);
    print(`    Added: ${k.addedAt || 'unknown'}`);
    print();
  }

  print(`${c.bold}Profile Key Orders${c.reset}`);
  for (const [name, prof] of Object.entries(config.profiles)) {
    print(`  ${c.cyan}${name}${c.reset} (port ${prof.port}): ${prof.keyOrder.join(' → ') || '(empty)'}`);
  }
}

async function cmdSetup(args) {
  ensureConfig();
  const config = getConfig();
  const port = config.profiles.default?.port || 4080;

  if (args.includes('--autostart')) {
    const result = installLaunchAgent();
    if (result.success) {
      success(`LaunchAgent installed: ${result.path}`);
      success('Proxy is now running and will stay running (auto-restarts on crash/login)');
      info(`Dashboard: http://localhost:${port}/dashboard`);
    } else {
      error(result.message);
    }
    return;
  }

  if (args.includes('--remove-autostart')) {
    const result = uninstallLaunchAgent();
    if (result.success) {
      success('LaunchAgent removed');
    } else {
      error(result.message);
    }
    return;
  }

  const tools = detectTools();

  print(`${c.bold}Auto-Setup${c.reset}`);
  print(`Setting ANTHROPIC_BASE_URL=http://localhost:${port}`);
  print();

  let setupCount = 0;

  if (tools.zsh.installed && !args.includes('--skip-shell')) {
    const result = setupShell(port, 'zsh');
    if (result.success) {
      success(`Configured: ${result.path}`);
      setupCount++;
    }
  }

  if (tools.bash.installed && !args.includes('--skip-shell')) {
    const result = setupShell(port, 'bash');
    if (result.success) {
      success(`Configured: ${result.path}`);
      setupCount++;
    }
  }

  if (tools['claude-code'].installed) {
    const result = setupClaudeCode(port);
    if (result.success) {
      success(`Configured: ${result.path}`);
      setupCount++;
    }
  }

  if (tools.cursor.installed) {
    const result = setupCursor(port);
    if (result.success) {
      success(`Configured: ${result.path}`);
      setupCount++;
    }
  }

  if (setupCount === 0) {
    info('Nothing to configure');
  } else {
    print();
    success(`${setupCount} tool(s) configured`);
    warn('Restart your shell for changes to take effect');
  }
}

function cmdLogs(args) {
  ensureConfig();
  const logPath = getLogPath();

  if (!fs.existsSync(logPath)) {
    info('No logs yet');
    return;
  }

  const lines = args.includes('-f') ? 50 : 20;
  const { execSync, spawn } = require('child_process');

  if (args.includes('-f')) {
    // Follow mode
    info(`Tailing ${logPath}...`);
    const tail = spawn('tail', ['-f', '-n', String(lines), logPath], {
      stdio: 'inherit'
    });
    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
  } else {
    try {
      const output = execSync(`tail -n ${lines} "${logPath}"`, { encoding: 'utf8' });
      print(output.trim());
    } catch {
      error('Failed to read logs');
    }
  }
}

async function cmdHealth() {
  const config = ensureConfig();
  const port = config.profiles.default?.port || 4080;

  try {
    const health = await fetchJSON(port, '/health');
    print(JSON.stringify(health, null, 2));
  } catch (err) {
    error(`Could not connect to proxy on port ${port}: ${err.message}`);
    process.exit(1);
  }
}

function cmdConfig() {
  const config = ensureConfig();
  const port = config.profiles.default?.port || 4080;

  info(`Config file: ${CONFIG_PATH}`);
  info(`Dashboard: http://localhost:${port}/dashboard`);

  // Try to open in browser
  try {
    const { execSync } = require('child_process');
    execSync(`open http://localhost:${port}/dashboard`, { stdio: 'ignore' });
    success('Opened dashboard in browser');
  } catch {
    info('Open the dashboard URL in your browser');
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function showHelp() {
  print(`
${c.bold}${c.blue}Claude Failover${c.reset} v${getVersion()}
Anthropic API proxy with automatic key rotation and model fallback

${c.bold}USAGE${c.reset}
  claude-failover <command> [options]

${c.bold}COMMANDS${c.reset}
  ${c.cyan}start${c.reset}              Start proxy (foreground)
  ${c.cyan}start -d${c.reset}           Start as background daemon
  ${c.cyan}stop${c.reset}               Stop the daemon
  ${c.cyan}status${c.reset}             Show proxy status and metrics
  ${c.cyan}add-key${c.reset} [token]    Add an API key
  ${c.cyan}remove-key${c.reset} <id>    Remove an API key
  ${c.cyan}list-keys${c.reset}          List configured keys
  ${c.cyan}setup${c.reset}              Auto-configure tools (shell, Claude Code, Cursor)
  ${c.cyan}setup --autostart${c.reset}  Install macOS LaunchAgent
  ${c.cyan}config${c.reset}             Open web dashboard
  ${c.cyan}logs${c.reset}               Show recent logs
  ${c.cyan}logs -f${c.reset}            Follow logs in real-time
  ${c.cyan}health${c.reset}             Show health endpoint JSON

${c.bold}EXAMPLES${c.reset}
  ${c.dim}# Quick start${c.reset}
  claude-failover start
  ${c.dim}# Add a key${c.reset}
  claude-failover add-key sk-ant-api03-... "Personal Account"
  ${c.dim}# Auto-configure everything${c.reset}
  claude-failover setup
  ${c.dim}# Autostart on login${c.reset}
  claude-failover setup --autostart

${c.bold}DASHBOARD${c.reset}
  http://localhost:4080/dashboard
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  print(getVersion());
  process.exit(0);
}

const commands = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  'add-key': cmdAddKey,
  'remove-key': cmdRemoveKey,
  'list-keys': cmdListKeys,
  setup: cmdSetup,
  logs: cmdLogs,
  health: cmdHealth,
  config: cmdConfig
};

const handler = commands[command];
if (!handler) {
  error(`Unknown command: ${command}`);
  showHelp();
  process.exit(1);
}

Promise.resolve(handler(args)).catch((err) => {
  error(err.message);
  process.exit(1);
});
