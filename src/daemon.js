'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { PID_PATH, CONFIG_DIR } = require('./config');

function writePid(pid) {
  fs.writeFileSync(PID_PATH, String(pid), { mode: 0o600 });
}

function readPid() {
  try {
    return parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function removePid() {
  try { fs.unlinkSync(PID_PATH); } catch {}
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDaemonStatus() {
  const pid = readPid();
  if (!pid) return { running: false, pid: null };
  if (isProcessRunning(pid)) {
    return { running: true, pid };
  }
  // Stale PID file
  removePid();
  return { running: false, pid: null };
}

function startDaemon() {
  const status = getDaemonStatus();
  if (status.running) {
    return { success: false, message: `Already running (PID ${status.pid})`, pid: status.pid };
  }

  const serverPath = path.join(__dirname, 'server.js');
  const logPath = path.join(CONFIG_DIR, 'logs', 'daemon.log');

  // Ensure log directory exists
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');

  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, CLAUDE_FAILOVER_DAEMON: '1' }
  });

  child.unref();
  writePid(child.pid);

  return { success: true, pid: child.pid, logPath };
}

function stopDaemon() {
  const status = getDaemonStatus();
  if (!status.running) {
    return { success: false, message: 'Not running' };
  }

  try {
    process.kill(status.pid, 'SIGTERM');
    removePid();
    return { success: true, pid: status.pid };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function getLaunchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claude-failover.plist');
}

function installLaunchAgent() {
  const plistPath = getLaunchAgentPath();
  const cliPath = path.resolve(__dirname, '..', 'bin', 'cli.js');
  const logPath = path.join(CONFIG_DIR, 'logs', 'launchagent.log');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-failover</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>WorkingDirectory</key>
  <string>${path.resolve(__dirname, '..')}</string>
</dict>
</plist>`;

  const dir = path.dirname(plistPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(plistPath, plist);

  // Load immediately so the proxy starts right now (not just on next login)
  try {
    // Unload first in case an old version is loaded
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`); } catch {}
    execSync(`launchctl load "${plistPath}"`);
  } catch {
    // Non-fatal — user can load manually
  }

  return { success: true, path: plistPath };
}

function uninstallLaunchAgent() {
  const plistPath = getLaunchAgentPath();
  try {
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`); } catch {}
    fs.unlinkSync(plistPath);
    return { success: true };
  } catch {
    return { success: false, message: 'LaunchAgent not found' };
  }
}

module.exports = {
  writePid,
  readPid,
  removePid,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  installLaunchAgent,
  uninstallLaunchAgent,
  getLaunchAgentPath
};
