# Tuya Home — multi-harness

Cloud-bridged control of Tuya / Smart Life devices. Contains:

- `plugin/` — Cindy plugin, the primary deliverable. The MCP and OpenClaw variants reimplement the same core for other harnesses, so a behaviour change belongs in all of them or in none.
- `variants/mcp/` — a **zero-dependency MCP server** (Python standard library
  only) for Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Cline, Zed,
  Copilot, Cindy and any other MCP client. See
  [variants/mcp/README.md](variants/mcp/README.md).
- `variants/openclaw-skill/` — OpenClaw skill variant.
- `docs/` — additional documentation.

## What it can do — including removal

Reads state, switches devices, sets values and renames them. With the
**off-by-default advanced setting** it can also create rooms, move a device into
a room, and **unbind a device** — which removes it from the Tuya account and app
permanently and requires pairing it again. Those three need a key allowed to
manage the home; an `sk-` end-user key is refused by Tuya. Details:
[plugin/README.md](plugin/README.md) and [docs/INSTALL.md](docs/INSTALL.md).

## Install

**Start here: [docs/INSTALL.md](docs/INSTALL.md)** — key, then the route that fits
your agent (Cindy plugin, MCP server, or Agent Skill), with a troubleshooting
table.

## Quick start (Cindy)
See `docs/PUBLISHING.md` and `docs/AGENTS-plugin.md`.

## Tests
```
cd plugin
node tests/smoke.mjs
python tests/check_manifest.py
node --check main.js && node --check panel.js && node --check settings.js
```

## Security
Never commit or share a Tuya API key. Rotate any key used during development.

Verified live behaviour (key families, per-device control surface, the 10-device
project quota): [docs/VERIFIED.md](docs/VERIFIED.md).

Release checklist for the Cindy marketplace: [docs/RELEASING.md](docs/RELEASING.md).
