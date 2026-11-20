# Tuya Home — MCP server

Control Tuya / Smart Life devices from **any MCP-capable client**: Claude Code,
Codex CLI, Gemini CLI, Cursor, Windsurf, Cline, Zed, GitHub Copilot, Cindy, or
your own agent.

One file, **no dependencies** — Python standard library only. No `pip
install`, no virtualenv, nothing to build. Written without syntax newer
than 3.8 and tested on 3.14; if you need an older interpreter, run
`python3 tuya_mcp.py --selftest` first, it needs no network.

## What it gives you

| Tool | What it does |
|---|---|
| `tuya_status` | Which data centre answers for your key, whether the key works, how many homes |
| `list_homes` | Homes and their rooms |
| `list_devices` | Devices with online state, home and room (filter by `home_id` / `room_id`) |
| `get_device` | Current values plus the properties the device accepts, with ranges and units |
| `set_device` | Change properties, validated against the device's own model before anything is sent |
| `rename_device` | Rename a device (this changes the Tuya app too) |

## Install

1. Get an API key at [tuya.ai/developer](https://tuya.ai/developer) (international)
   or [tuyasmart.com](https://tuyasmart.com) (China mainland). It starts with `sk-`.
2. Put this folder somewhere permanent, e.g. `~/tools/tuya-mcp/`.
3. Add the server to your client.

### The config block every client uses

Most clients read a JSON file with an `mcpServers` object. This is the block:

```json
{
  "mcpServers": {
    "tuya": {
      "command": "python3",
      "args": ["/absolute/path/to/tuya_mcp.py"],
      "env": {
        "TUYA_API_KEY": "sk-your-key-here",
        "TUYA_REGION": "eu-c"
      }
    }
  }
}
```

On Windows use `"command": "python"` (or the full path to `python.exe`). Use an
absolute path in `args` — clients launch the server from an unknown directory.

Typical file locations (check your client's docs, they move between versions):

| Client | File |
|---|---|
| Claude Desktop | `claude_desktop_config.json` |
| Claude Code | `.mcp.json` in the project, or `claude mcp add` |
| Codex CLI | `~/.codex/config.toml` (`[mcp_servers.tuya]`, TOML form) |
| Gemini CLI | `settings.json` (`mcpServers`) |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | `cline_mcp_settings.json` |
| Cindy | MCP servers in settings |

Codex CLI's TOML form, since it is not JSON:

```toml
[mcp_servers.tuya]
command = "python3"
args = ["/absolute/path/to/tuya_mcp.py"]
env = { TUYA_API_KEY = "sk-your-key-here", TUYA_REGION = "eu-c" }
```

CLI registration, where the client has one:

```bash
# Claude Code
claude mcp add tuya --env TUYA_API_KEY=sk-your-key-here -- python3 /absolute/path/tuya_mcp.py

# Codex CLI
codex mcp add tuya --env TUYA_API_KEY=sk-your-key-here -- python3 /absolute/path/tuya_mcp.py
```

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `TUYA_API_KEY` | yes | Your `sk-` key. Only ever sent to Tuya. |
| `TUYA_REGION` | no | Pin a data centre: `cn`, `us-w`, `eu-c`, `in`, `us-e`, `eu-w`, `sg`. Without it the server probes all seven once and remembers the one that answers. |
| `TUYA_BASE` | no | Full base URL override (tests, proxies). Implies one centre, no probing. |

## Security — read this

**The key lives in the client's config file, in plain text.** That is the price
of running outside a host with a credential vault (Cindy's own plugin variant
keeps it in the vault instead; this one cannot).

- Never commit the config file. On Linux/macOS: `chmod 600` it.
- Prefer passing the key through an environment variable where your client
  supports it, so it is not stored in a file at all.
- The key grants control of your home. Revoke it at the provider if it leaks.
- This repository contains **no** keys. `TUYA_API_KEY` appears only as a
  placeholder.

## What the key cannot do

An end-user key (`sk-`) can read, control and rename. It **cannot** change the
structure of a home: creating rooms, moving a device into a room, or unbinding a
device will fail. Do those in the Tuya app. The server does not pretend
otherwise — it reports `PERMISSION` or `AUTH` with an explanation rather than
retrying.

## Troubleshooting

Every failure comes back as `{"ok": false, "errorCode": ..., "message": ...}` and
a short `hint`.

| `errorCode` | What it means | What to do |
|---|---|---|
| `NETWORK` | The request never reached Tuya | Check the connection. This is **not** a key problem. |
| `RATE_LIMITED` | Tuya refused a burst of requests | Wait a few seconds. Reads are retried automatically. |
| `AUTH` | The key was not accepted | Usually the wrong data centre — set `TUYA_REGION`. If all centres refuse, the key is expired. |
| `PERMISSION` | The key may not do that | Structure changes belong in the Tuya app. |
| `NO_DATACENTRE` | No centre accepted the key | See the `hint`: it lists each centre's answer. |
| `INVALID_PROPERTY` | No such property on this device | The `hint` lists the writable ones. |
| `READ_ONLY` / `OUT_OF_RANGE` / `INVALID_VALUE` | Bad input | Refused locally; nothing was sent to the device. |

Values are converted for you: ask for `22.5` on a device that declares 16–30
with one decimal and the raw integer `225` is sent. Percentages are not
converted — read the range from `get_device` and compute inside it.

## Verify it locally

No key and no internet needed:

```bash
python3 tuya_mcp.py --selftest          # 20 local sanity checks
python3 tests/test_mcp.py               # end-to-end against a fake Tuya API
python3 tuya_mcp.py --version
```

`tests/fake_tuya.py` is a fake Tuya cloud: it serves the real response shapes,
answers the first write with Tuya's burst-cap message (so the retry is
exercised), and rejects a wrong bearer token with code `1010`.

## Compatibility

Handshake and `tools/list` were checked over stdio against:

| Client | Version |
|---|---|
| Codex CLI | `codex-cli 0.166.0` |
| Claude Code | `2.1.321` |

The server speaks MCP `2024-11-05`, `2025-03-26` and `2025-06-18` (it echoes
whichever of those the client asks for) and implements `initialize`,
`tools/list`, `tools/call` and `ping`.

## Also in this repository

- `../../plugin/` — the Cindy plugin, same features plus a settings panel and a
  credential vault
- `../openclaw-skill/` — an Agent Skill variant (`SKILL.md` + script)
