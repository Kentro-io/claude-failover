# Claude Failover Proxy — PRD

## Overview

A standalone, installable proxy server that sits between any Anthropic API client (Claude Code, OpenClaw, Cursor, Aider, any SDK) and `api.anthropic.com`. It provides automatic key rotation, model fallback, and a local web dashboard for configuration — all without touching client code.

**One-liner:** `npx claude-failover` → local proxy with web UI at `http://localhost:4080` that auto-rotates your Anthropic API keys on rate limits.

## Problem

Power users of Claude (especially Claude Code, Cursor, etc.) hit rate limits constantly. If you have multiple Anthropic accounts or API keys, there's no easy way to:
1. Automatically failover between keys when one gets rate-limited
2. Fall back to a cheaper model (Opus → Sonnet) when all keys are exhausted for a model
3. Monitor which keys are in cooldown and when they'll recover
4. Configure different key priorities for different tools

## Target User

- Developers using Claude Code, Cursor, Aider, or any Anthropic API client
- Teams sharing multiple API keys/accounts
- Power users who hit rate limits regularly
- Anyone on Mac (primary), Linux, or Windows (stretch)

## Solution

### Installation

```bash
# Global install
npm install -g claude-failover

# Or run directly
npx claude-failover
```

### First Run

```bash
claude-failover start
# → Proxy running on http://localhost:4080 (API)
# → Dashboard at http://localhost:4080/dashboard
# → Add your first API key at http://localhost:4080/dashboard
```

### Architecture

```
┌──────────────────┐     ┌───────────────────────┐     ┌──────────────────┐
│  Claude Code     │     │  Claude Failover       │     │  Anthropic API   │
│  Cursor          │────▶│  Proxy (localhost:4080)│────▶│  api.anthropic   │
│  Any API Client  │     │                        │     │  .com            │
│                  │◀────│  Key rotation +        │◀────│                  │
│                  │     │  Model fallback +      │     │                  │
│                  │     │  Web Dashboard         │     │                  │
└──────────────────┘     └───────────────────────┘     └──────────────────┘
```

## Features

### 1. CLI (`claude-failover`)

| Command | Description |
|---------|-------------|
| `claude-failover start` | Start the proxy server (foreground) |
| `claude-failover start -d` | Start as background daemon |
| `claude-failover stop` | Stop the daemon |
| `claude-failover status` | Show proxy status, active cooldowns, metrics |
| `claude-failover add-key` | Interactive: add an API key |
| `claude-failover remove-key <id>` | Remove a key |
| `claude-failover list-keys` | List configured keys (masked) |
| `claude-failover config` | Open the web dashboard |
| `claude-failover setup` | Auto-configure ANTHROPIC_BASE_URL in shell profile + Claude Code config |
| `claude-failover logs` | Tail the proxy logs |
| `claude-failover health` | Hit the /health endpoint and pretty-print |

### 2. Web Dashboard (localhost:4080/dashboard)

A clean, modern local web UI served by the proxy itself. No external dependencies, no React build step — vanilla HTML/CSS/JS served as static files.

#### Pages/Sections:

**a) Status Overview (Home)**
- Proxy status (running/stopped)
- Total requests, success rate, retries, failures
- Uptime
- Active cooldowns with countdown timers
- Last 10 requests log (model, key used, latency, status)

**b) API Keys Management**
- Add new key (paste API key or OAuth token)
  - Auto-detects key type (API key `sk-ant-api03-*` vs OAuth `sk-ant-oat01-*`)
  - Label field (e.g., "Personal Account", "Work Account")
  - Test key button (hits Anthropic API to verify)
- List keys (masked display: `sk-ant-...XXXX`)
- Remove key
- Drag-to-reorder priority
- Per-key stats (requests served, last used, cooldown status)

**c) Profiles**
- Create named profiles with different key orders
  - e.g., "default" (key1 → key2 → key3), "claude-code" (key2 → key1 → key3)
- Each profile gets its own port
- Map profiles to tools (informational — the port is what matters)

**d) Failback Strategy**
- Model fallback chain configuration
  - Default: Opus → Sonnet (when all keys exhausted for Opus)
  - Customizable per-model chains
- Cooldown duration (default: 60 min, configurable)
- Per-model vs per-key cooldown toggle
- Retry behavior: immediate next key vs backoff

**e) Auto-Setup**
- One-click button to configure `ANTHROPIC_BASE_URL=http://localhost:4080` in:
  - `~/.zshrc` / `~/.bashrc`
  - `~/.claude/settings.json` (Claude Code)
  - `~/.cursor/settings.json` (Cursor)
- Shows manual instructions for other tools
- Detects which tools are installed

**f) Logs**
- Real-time log viewer (WebSocket or SSE)
- Filter by key, model, status code
- Export logs

### 3. Proxy Engine (Core)

The actual proxy logic — based on our battle-tested `anthropic-proxy/server.js`:

- **Transparent proxying** — forwards all requests to `api.anthropic.com`, swapping auth headers
- **Key rotation on 429** — tries next key in priority order
- **Key rotation on 529** — Anthropic overloaded, short cooldown + next key
- **Model fallback** — when all keys exhausted for a model, try fallback model
- **Per-model cooldown tracking** — Opus limited ≠ Sonnet limited on same key
- **OAuth token support** — handles both `sk-ant-api03-*` (x-api-key) and `sk-ant-oat01-*` (Bearer + beta headers)
- **Streaming support** — pipes SSE streams through transparently
- **Health endpoint** — `GET /health` returns full status JSON
- **Config hot-reload** — watches config file, applies changes without restart
- **Request logging** — structured JSON logs with rotation

### 4. Configuration

Stored at `~/.config/claude-failover/config.json`:

```json
{
  "port": 4080,
  "profiles": {
    "default": {
      "port": 4080,
      "keyOrder": ["main", "key2"]
    },
    "claude-code": {
      "port": 4081,
      "keyOrder": ["key2", "main"]
    }
  },
  "keys": {
    "main": {
      "token": "sk-ant-...",
      "label": "Personal",
      "type": "api-key"
    }
  },
  "modelFallback": {
    "claude-opus-4-6": "claude-sonnet-4-6"
  },
  "cooldownMs": 3600000,
  "logLevel": "info",
  "maxLogSize": 5242880,
  "notifications": {
    "enabled": false,
    "method": "terminal-notifier"
  }
}
```

### 5. Auto-Start (macOS)

`claude-failover setup --autostart` creates a LaunchAgent plist at `~/Library/LaunchAgents/com.claude-failover.plist` so the proxy starts on login.

## Technical Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Framework | None (pure Node.js) | Zero dependencies = no supply chain risk, fast install |
| Dashboard | Vanilla HTML/CSS/JS | No build step, served as static files by the proxy |
| Config | JSON file | Simple, human-editable, hot-reloadable |
| Daemon | Node process | Cross-platform, no native deps |
| Package | npm | Universal JS distribution |
| Ports | 4080 default | Avoids common ports, memorable |

## Design Principles

1. **Zero external dependencies** — pure Node.js, no npm packages needed at runtime
2. **Works in 60 seconds** — install, add key, point client, done
3. **Transparent** — clients don't know the proxy exists, just set ANTHROPIC_BASE_URL
4. **Secure** — keys never leave localhost, config file is 0600, no telemetry
5. **Observable** — real-time dashboard shows exactly what's happening

## Dashboard Design

Clean, dark theme (matches terminal aesthetic). Think: Grafana-lite for your API keys.

- **Color scheme:** Dark background (#0a0a0a), accent blue (#3b82f6), success green (#22c55e), warning amber (#f59e0b), error red (#ef4444)
- **Typography:** System mono font stack
- **Layout:** Single-page app with sidebar navigation
- **Responsive:** Works on desktop, looks decent on mobile (for checking from phone)
- **No frameworks:** Vanilla CSS Grid/Flexbox, vanilla JS with fetch API

## File Structure

```
claude-failover/
├── bin/
│   └── cli.js              # CLI entry point (#!/usr/bin/env node)
├── src/
│   ├── server.js            # HTTP server + proxy engine
│   ├── config.js            # Config loading, validation, hot-reload
│   ├── proxy.js             # Core proxy logic (key rotation, fallback)
│   ├── cooldown.js          # Cooldown tracking
│   ├── metrics.js           # Request metrics
│   ├── logger.js            # Structured logging with rotation
│   ├── setup.js             # Auto-setup (shell, Claude Code, Cursor)
│   └── daemon.js            # Daemonization + LaunchAgent
├── dashboard/
│   ├── index.html           # Single-page dashboard
│   ├── style.css            # Dark theme styles
│   └── app.js               # Dashboard JS (fetch API, SSE for live data)
├── package.json
├── README.md                # Full install + usage instructions
├── LICENSE                  # MIT
└── .gitignore
```

## README Structure

The README should be a selling point. Structure:
1. **Hero:** One-line description + demo GIF placeholder
2. **Quick Start:** 3 commands to get running
3. **How It Works:** Simple diagram
4. **Features:** Key rotation, model fallback, dashboard, auto-setup
5. **Configuration:** CLI and web dashboard
6. **Supported Clients:** Claude Code, Cursor, Aider, any SDK
7. **FAQ:** Common questions
8. **License:** MIT

## Success Criteria

- [ ] `npm install -g claude-failover && claude-failover start` works on fresh Mac
- [ ] Web dashboard loads at localhost:4080/dashboard
- [ ] Can add/remove API keys via dashboard
- [ ] Rate-limited requests automatically rotate to next key
- [ ] Model fallback works when all keys exhausted
- [ ] `claude-failover setup` configures ANTHROPIC_BASE_URL
- [ ] LaunchAgent autostart works
- [ ] All features work with zero npm dependencies

## Out of Scope (V1)

- Windows support (stretch goal)
- Multi-provider (OpenAI, Google) — future V2
- Team/shared proxy over network
- Key usage billing tracking
- Browser extension
