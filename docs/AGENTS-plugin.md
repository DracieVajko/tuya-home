# AGENTS.md — Tuya Home (Cindy plugin)

Maintainer notes live here, outside `plugin/`, so they do not ship inside the
package the marketplace installs.

A Cindy plugin that reads and controls Tuya / Smart Life devices over Tuya's
end-user REST API. Plain ES2020 in a browser-style sandbox: **no Node APIs, no
bundler, no dependencies**. Files are shipped as-is.

## Run the tests first, before and after any change

```
node tests/smoke.mjs        # 22 behavioural checks against a fake Tuya cloud
python tests/check_manifest.py   # manifest and documentation assertions
node --check main.js && node --check panel.js && node --check settings.js
```

Both suites pass right now. If a change makes either fail, the change is wrong —
the suites encode the real API contract, not preferences.

## Hard invariants — breaking these ships a broken plugin

1. **The API key is never readable by this code.** `main.js`, the panel and the
   settings page must never receive, log, persist or echo it. The host injects it
   as `Authorization: Bearer <key>` for the seven declared hosts. Key entry goes
   through `PUT /secrets/tuya_api_key` only; `/kv` must never hold a credential.
2. **No WebSocket, no direct network.** `cindy.fetch` is the only egress and it
   cannot stream. Do not add a polling loop inside `main.js`; state is refreshed
   on demand. Any new host must be added to `network.hosts` in `ghost.json`
   (max 8 entries, seven are already used by Tuya's data centres).
3. **One device write costs one POST once the session is warm.** The data centre
   is discovered once, remembered in memory and in `/kv`, and thing models are
   cached for an hour, so no probe or model fetch rides along with a write. A
   cold first call may need one model fetch; that is the only extra request.
4. **Validate before writing.** `validateProperties()` must reject unknown codes,
   `accessMode: "ro"` codes, out-of-range numbers, bad enums and unsupported
   `typeSpec` types locally, before any network call. Silent clamping is banned:
   return the real limit instead.
5. **Never invent Tuya fields.** `properties` on the issue endpoint is a JSON
   *string* inside a JSON body (`{"properties": "{\"switch_led\":true}"}`). Homes
   are read defensively (`home_id` / `gid` / `id`) because the response shape is
   not pinned down by the docs. If you are unsure, say so — do not guess a field
   and pretend it works.
6. **`ghost.json` is a strict contract**, not a config file. Tools, panel, skill
   and secret declarations are validated by Cindy's packer. The SKILL.md
   frontmatter `name` / `description` must stay byte-identical to the
   `skill.items` entry (`check_manifest.py` compares them). Do not add a
   placeholder icon.

7. **The docs must describe what the code does, not what it used to do.** Two
   marketplace versions were rejected for a README that still said removal was
   unsupported while `remove_device` unbinds a device. `check_manifest.py` now
   fails on any "removal unsupported" claim, requires the unbind description in
   README, AGENTS.md, the skill and the settings page, and checks that every
   `errorCode` quoted in `docs/INSTALL.md` exists in the code.

## What this cannot do, and must not pretend to

Locks, live camera streaming, firmware, pairing a new device and `raw` /
`bitmap` / `struct` / `array` properties are out of reach. Unbinding an existing
device is available, but only through the advanced `remove_device` tool: it is
destructive, it removes the device from the account and the app, and the docs
(README, settings page, SKILL.md) must keep saying so in those words. Commands
are asynchronous: a successful write means Tuya accepted it, not that the
hardware obeyed.

## Packaging is not part of this repo

`ghost_forge_pack` / `ghost_forge_install` run inside Cindy, not here. Editing
this tree produces source only; a `.cindy` file requires a Cindy session with the
plugin-authoring tools enabled. `minCindyVersion` in `ghost.json` is pinned to the
host version this was built against and can be lowered after checking a changelog.

## Layout

| File | Role |
|---|---|
| `ghost.json` | manifest: 9 tools, 7 hosts, 1 vault secret, panel, settings, bundled skill |
| `main.js` | sandbox brain: REST calls, host discovery, model cache, validation, panel bridge |
| `panel.html/.js/.css` | left-sidebar device list; talks to `main.js` over `BroadcastChannel` only |
| `settings.html/.js` | key entry, data-centre pin, connection test |
| `skills/tuya-home/SKILL.md` | agent-facing workflow, bundled and projected by Cindy |

The panel and settings pages cannot call the network: they broadcast a request,
wake the brain with `fetch('cindy-ghost://tuya-home/wake')`, and retry by `reqId`
until it answers.
