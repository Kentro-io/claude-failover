# Claude Failover

Anthropic API proxy with automatic key rotation, model fallback, and a local web dashboard.

Hit rate limits? Claude Failover automatically rotates through your API keys and falls back to cheaper models — zero client changes needed.

## Quick Start

```bash
# Install globally from GitHub
sudo npm install -g Kentro-io/claude-failover

# Add your API keys
claude-failover add-key sk-ant-api03-... "Personal Account"

# Auto-configure your tools + install autostart (macOS LaunchAgent)
claude-failover setup --autostart

# Open the dashboard
open http://localhost:4080/dashboard
```

> **Auto-start:** Run `claude-failover setup --autostart` once to install a macOS LaunchAgent. The proxy will start automatically on login — no need to manually run `start` again. To run manually instead: `claude-failover start -d` (daemon) or `claude-failover start` (foreground).

## How It Works

```
┌──────────────────┐     ┌─────────────────────────┐     ┌───────────────┐
│  Claude Code     │     │  Claude Failover         │     │  Anthropic    │
│  Cursor          │────▶│  localhost:4080           │────▶│  API          │
│  Aider           │     │                          │     │               │
│  Any SDK Client  │◀────│  ● Key rotation on 429   │◀────│               │
│                  │     │  ● Model fallback         │     │               │
│                  │     │  ● Web dashboard          │     │               │
└──────────────────┘     └─────────────────────────┘     └───────────────┘
```

1. Point your tool at `http://localhost:4080` instead of `api.anthropic.com`
2. The proxy tries your keys in priority order
3. On rate limit (429), it instantly rotates to the next key
4. When all keys are exhausted for a model, it falls back (e.g., Opus → Sonnet)
5. Monitor everything from the web dashboard

## Features

### Automatic Key Rotation
Add multiple API keys. When one hits a rate limit, the proxy instantly tries the next — no request dropped, no client error.

### Model Fallback
Configure fallback chains (e.g., `claude-opus-4-6 → claude-sonnet-4-6`). When all keys are exhausted for Opus, the proxy automatically retries with Sonnet.

### Web Dashboard
Real-time dashboard at `localhost:4080/dashboard`:
- Live metrics and status
- Add/remove/reorder API keys
- Configure profiles and fallback chains
- One-click setup for Claude Code, Cursor, and shell
- Real-time log viewer

### Profiles
Create named profiles with different key orders, each on its own port:
- `default` on `:4080` — key1 → key2 → key3
- `claude-code` on `:4081` — key2 → key1 → key3

### OAuth Token Support
Supports both API keys (`sk-ant-api03-*`) and OAuth tokens (`sk-ant-oat01-*`) with proper Bearer auth and beta headers.

### Zero Dependencies
Pure Node.js — no npm packages, no supply chain risk, instant install.

## CLI Reference

| Command | Description |
|---------|-------------|
| `claude-failover start` | Start proxy (foreground) |
| `claude-failover start -d` | Start as background daemon |
| `claude-failover stop` | Stop the daemon |
| `claude-failover status` | Show status and metrics |
| `claude-failover add-key [token] [label]` | Add an API key |
| `claude-failover remove-key <id>` | Remove a key |
| `claude-failover list-keys` | List configured keys |
| `claude-failover setup` | Auto-configure tools |
| `claude-failover setup --autostart` | Install macOS LaunchAgent |
| `claude-failover config` | Open web dashboard |
| `claude-failover logs` | Show recent logs |
| `claude-failover logs -f` | Follow logs in real-time |
| `claude-failover health` | Show health JSON |

## Configuration

Config is stored at `~/.config/claude-failover/config.json`:

```json
{
  "profiles": {
    "default": {
      "port": 4080,
      "keyOrder": ["personal", "work"]
    }
  },
  "keys": {
    "personal": {
      "token": "sk-ant-api03-...",
      "label": "Personal Account",
      "type": "api-key"
    }
  },
  "modelFallback": {
    "claude-opus-4-6": "claude-sonnet-4-6"
  },
  "cooldownMs": 3600000
}
```

Config hot-reloads every 5 seconds — edit the file or use the dashboard.

## Supported Clients

Any tool that supports `ANTHROPIC_BASE_URL`:

| Tool | Setup |
|------|-------|
| **Claude Code** | `claude-failover setup` (auto) or set in `~/.claude/settings.json` |
| **Cursor** | `claude-failover setup` (auto) or set base URL in settings |
| **Aider** | `export ANTHROPIC_BASE_URL=http://localhost:4080` |
| **Python SDK** | `client = Anthropic(base_url="http://localhost:4080")` |
| **Node SDK** | `new Anthropic({ baseURL: "http://localhost:4080" })` |
| **curl** | `curl http://localhost:4080/v1/messages ...` |

## Architecture

```
claude-failover/
├── bin/cli.js           # CLI entry point
├── src/
│   ├── server.js        # HTTP server + routing
│   ├── proxy.js         # Proxy engine (key rotation + fallback)
│   ├── config.js        # Config management + hot-reload
│   ├── cooldown.js      # Per-key per-model cooldown tracking
│   ├── metrics.js       # Request metrics + recent history
│   ├── logger.js        # Structured JSON logging
│   ├── daemon.js        # Background process + LaunchAgent
│   └── setup.js         # Auto-setup for tools
├── dashboard/
│   ├── index.html       # Dashboard SPA
│   ├── style.css        # Dark theme
│   └── app.js           # Dashboard logic (SSE, drag-drop)
└── package.json         # Zero dependencies
```

## Security

- Keys never leave localhost — the proxy only binds to `127.0.0.1`
- Config file uses `0600` permissions (owner read/write only)
- No telemetry, no external calls except to `api.anthropic.com`
- No dependencies = no supply chain risk

## FAQ

**Q: Does this work with streaming?**
A: Yes. The proxy pipes SSE streams through transparently — no buffering.

**Q: What happens if all keys are exhausted?**
A: The proxy returns a 429 error with details about which keys and models were tried.

**Q: Does it support per-model cooldowns?**
A: Yes. If key1 is rate-limited on Opus, it can still serve Sonnet requests.

**Q: Can I use this in production?**
A: It's designed for local development use. For production, consider running behind a proper reverse proxy.

## Requirements

- Node.js 18+
- macOS, Linux (Windows: experimental)

## License

MIT
