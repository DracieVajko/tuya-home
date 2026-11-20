# Publishing — Tuya Home

## Cindy (primary target)

Packaging runs **inside Cindy**, not in this repository.

1. Open this folder in a Cindy session with the plugin-authoring tools enabled.
2. Run `ghost_forge_pack` on `plugin/`.
   - The packer validates `ghost.json`, the skill frontmatter and all referenced assets.
   - It writes `plugin/tuya-home-<version>.cindy` next to the source. That file is
     gitignored and never packs itself; delete it when you are done if you do not
     want it on disk.
   - Fix any validator errors before proceeding.
3. Run `ghost_forge_install` to install the resulting package locally (same thing:
   it also leaves the `.cindy` next to the source).
4. Open the plugin settings:
   - paste the Tuya API key (`sk-...`),
   - press **Test connection** (uses `tuya_status`),
   - optionally pin the data centre.
5. Keep the icon: `assets/icon.png` is declared in `ghost.json`. Replace it only with a real 1024 px PNG; never ship a placeholder.
6. Publishing to the Cindy marketplace is a separate, opt-in step and requires an approved icon and a chosen `minCindyVersion`.

Before packing, run locally:

```
node tests/smoke.mjs
python tests/check_manifest.py
node --check main.js && node --check panel.js && node --check settings.js
```

## Other harnesses

- **OpenClaw / Claude Code / Codex**: this repo is Cindy-shaped. For those harnesses, either wrap the same REST calls as an MCP server (you handle the key via env/config, not a vault) or reuse the official `tuya/tuya-openclaw-skills` Python scripts. Do not copy the Cindy manifest as-is.
- **Martty**: it is a terminal UI only; it has no Tuya code. Skip it for device control.
- **Home Assistant**: for LAN/offline control use LocalTuya/tinytuya with extracted local keys; this plugin is cloud-only.
- **Matter-enabled devices**: can be driven locally by any Matter controller and do not need this plugin.

## Security checklist before publishing

- Key never appears in source, logs, `/kv`, or error messages.
- All seven hosts are the only declared `network.hosts`.
- `minCindyVersion` matches the Cindy version you tested against.
- No personal account data: the package ships a generic `COMMANDS.md`, never a
  dump of the author's devices, ids or states.
- Every user-facing page states the same thing about `remove_device`: off by
  default, needs a key allowed to manage the home, permanent, re-pairing needed.
- Rotate any key that was used during development/testing.
