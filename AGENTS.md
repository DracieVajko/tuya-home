# AGENTS.md — Tuya Home (repo root)

Plugin source lives in `plugin/`. Read `docs/AGENTS-plugin.md` for project rules and test commands.

Top-level layout:
- `plugin/` — Cindy plugin (manifest, main.js, panel, settings, skill, tests)
- `variants/` — MCP and OpenClaw skill variants
- `docs/` — extra documentation

Run tests:
```
cd plugin
node tests/smoke.mjs
python tests/check_manifest.py
node --check main.js && node --check panel.js && node --check settings.js
```