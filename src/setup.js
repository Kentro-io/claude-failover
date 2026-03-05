'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER_START = '# claude-failover start';
const MARKER_END = '# claude-failover end';
const ENV_LINE_TEMPLATE = (port) =>
  `export ANTHROPIC_BASE_URL=http://localhost:${port}`;

function detectTools() {
  const home = os.homedir();
  const tools = {};

  // Shell
  const zshrc = path.join(home, '.zshrc');
  const bashrc = path.join(home, '.bashrc');
  tools.zsh = { installed: fs.existsSync(zshrc), path: zshrc, configured: false };
  tools.bash = { installed: fs.existsSync(bashrc), path: bashrc, configured: false };

  // Check if already configured
  for (const shell of ['zsh', 'bash']) {
    if (tools[shell].installed) {
      try {
        const content = fs.readFileSync(tools[shell].path, 'utf8');
        tools[shell].configured = content.includes(MARKER_START);
      } catch {}
    }
  }

  // Claude Code
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  tools['claude-code'] = {
    installed: fs.existsSync(path.join(home, '.claude')),
    path: claudeSettings,
    configured: false
  };
  try {
    const content = fs.readFileSync(claudeSettings, 'utf8');
    tools['claude-code'].configured = content.includes('ANTHROPIC_BASE_URL');
  } catch {}

  // Cursor
  const cursorSettings = path.join(home, '.cursor', 'settings.json');
  tools.cursor = {
    installed: fs.existsSync(path.join(home, '.cursor')),
    path: cursorSettings,
    configured: false
  };
  try {
    const content = fs.readFileSync(cursorSettings, 'utf8');
    tools.cursor.configured = content.includes('ANTHROPIC_BASE_URL');
  } catch {}

  return tools;
}

function setupShell(port, shell = 'zsh') {
  const home = os.homedir();
  const rcPath = shell === 'bash'
    ? path.join(home, '.bashrc')
    : path.join(home, '.zshrc');

  let content = '';
  try {
    content = fs.readFileSync(rcPath, 'utf8');
  } catch {}

  // Remove existing block
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + content.slice(endIdx + MARKER_END.length + 1);
  }

  const block = `${MARKER_START}\n${ENV_LINE_TEMPLATE(port)}\n${MARKER_END}\n`;
  content = content.trimEnd() + '\n\n' + block;

  fs.writeFileSync(rcPath, content);
  return { success: true, path: rcPath, shell };
}

function setupClaudeCode(port) {
  const home = os.homedir();
  const settingsDir = path.join(home, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {}

  if (!settings.env) settings.env = {};
  settings.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { success: true, path: settingsPath };
}

function setupCursor(port) {
  const home = os.homedir();
  const settingsDir = path.join(home, '.cursor');
  const settingsPath = path.join(settingsDir, 'settings.json');

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {}

  if (!settings['anthropic.baseUrl']) {
    settings['anthropic.baseUrl'] = `http://localhost:${port}`;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { success: true, path: settingsPath };
}

function removeSetup(shell = 'zsh') {
  const home = os.homedir();
  const rcPath = shell === 'bash'
    ? path.join(home, '.bashrc')
    : path.join(home, '.zshrc');

  let content = '';
  try {
    content = fs.readFileSync(rcPath, 'utf8');
  } catch {
    return { success: false, message: 'File not found' };
  }

  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1) {
    return { success: false, message: 'Not configured' };
  }

  content = content.slice(0, startIdx) + content.slice(endIdx + MARKER_END.length + 1);
  fs.writeFileSync(rcPath, content.trimEnd() + '\n');
  return { success: true, path: rcPath };
}

module.exports = {
  detectTools,
  setupShell,
  setupClaudeCode,
  setupCursor,
  removeSetup
};
