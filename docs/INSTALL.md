# Install guide

Three ways to run Tuya Home. Pick one; they all speak to the same Tuya API with
the same `sk-` key.

| You use… | Install this | Where the key lives |
|---|---|---|
| **Cindy** | the Cindy plugin (`plugin/`) | Cindy's credential vault — never in a file |
| **Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, Cline, Zed, Copilot, any MCP client** | `variants/mcp/tuya_mcp.py` | client config / environment variable, in plain text |
| **Claude-family agents and other skill-aware harnesses** | `variants/openclaw-skill/` | environment variable |

If you want the safest setup *and* you use Cindy, use the plugin. The MCP server
is the portable option and is the only one that works outside Cindy.

---

## 1. Get a key

1. Create an API key at [tuya.ai/developer](https://tuya.ai/developer)
   (international accounts) or [tuyasmart.com](https://tuyasmart.com)
   (China mainland accounts).
2. The key starts with `sk-`. The two characters after `sk-` identify the data
   centre, so you normally do not need to choose one.
3. The key carries your account's region. A key created for the wrong data
   centre will fail with `AUTH` — fix it with `TUYA_REGION`, do not create a
   second key.

What the key **can** do: read homes, rooms and devices, read device state,
change properties, rename devices.
What a plain end-user key **cannot** do: create rooms, move a device into a room,
unbind a device — Tuya refuses those calls (`1010` / `1108`) because they belong
to a different permission family. The Cindy plugin still ships those three tools
(advanced, off by default, see [the plugin README](../plugin/README.md#advanced--home-structure-off-by-default));
they only work with a key allowed to manage the home. The MCP server does not
expose them at all. Details: [VERIFIED.md](VERIFIED.md).

---

## 2. Cindy plugin

### From the marketplace
Search for "Tuya Home" in Cindy's plugin marketplace once the release is
published, install, then open the plugin settings and paste the key.

### From a `.cindy` file (before the marketplace listing exists)
1. Build the package: `ghost_forge_pack({ dir: ".../tuya-home/plugin" })`, or ask
   Cindy to build it.
2. In Cindy, import the `.cindy` file and enable the plugin.
3. Open the plugin's settings, paste the key, press **Test connection**.

Notes:
- The key goes to Cindy's vault. The plugin never sees its value and it is never
  written into the plugin's files.
- **Advanced — home structure** is off by default. Leave it off unless you are
  experimenting with project credentials; a normal `sk-` key cannot use those
  three tools.
- Verify with: "what's on in my flat" or `tuya_status`.

---

## 3. MCP server (any client)

Requirements: **Python 3.8+**, nothing else. No `pip install`, no build step.

### Put the file somewhere permanent

```bash
mkdir -p ~/tools/tuya-mcp
cp variants/mcp/tuya_mcp.py ~/tools/tuya-mcp/
```

On Windows that is `%USERPROFILE%\tools\tuya-mcp\`.

### Add it to your client

Most clients read a JSON file with an `mcpServers` object:

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

Windows: `"command": "python"` (or the full path to `python.exe`). Always use an
absolute path in `args` — clients launch servers from an unknown working
directory.

Typical locations (they move between versions, check your client's docs):

| Client | File |
|---|---|
| Claude Desktop | `claude_desktop_config.json` |
| Claude Code | `.mcp.json` in the project, or `claude mcp add` |
| Codex CLI | `~/.codex/config.toml`, TOML form below |
| Gemini CLI | `settings.json` (`mcpServers`) |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | `cline_mcp_settings.json` |
| Cindy | MCP servers in settings |

Codex CLI uses TOML:

```toml
[mcp_servers.tuya]
command = "python3"
args = ["/absolute/path/to/tuya_mcp.py"]
env = { TUYA_API_KEY = "sk-your-key-here", TUYA_REGION = "eu-c" }
```

CLI registration where available:

```bash
claude mcp add tuya --env TUYA_API_KEY=sk-your-key-here -- python3 /absolute/path/tuya_mcp.py
codex  mcp add tuya --env TUYA_API_KEY=sk-your-key-here -- python3 /absolute/path/tuya_mcp.py
```

### Environment

| Variable | Required | Meaning |
|---|---|---|
| `TUYA_API_KEY` | yes | Your `sk-` key |
| `TUYA_REGION` | no | `cn`, `us-w`, `eu-c`, `in`, `us-e`, `eu-w`, `sg`. Without it the server asks each centre in turn (retrying a blocked request once) and remembers the winner. |
| `TUYA_BASE` | no | Full base URL override (tests, proxies). No probing. |

### Verify before trusting it

```bash
python3 tuya_mcp.py --version     # prints tuya-home 0.3.0
python3 tuya_mcp.py --selftest    # local checks, no key, no network
python3 tests/test_mcp.py         # end-to-end against a fake Tuya API
```

Then, in your agent, ask for `tuya_status`. A healthy answer names your data
centre and the number of homes it can see.

---

## 4. Agent Skill

```bash
cp -r variants/openclaw-skill/tuya-home ~/.claude/skills/   # Claude Code
```

Set `TUYA_API_KEY` in the environment the agent runs in. See
`variants/openclaw-skill/tuya-home/SKILL.md`.

---

## Security

- **Cindy plugin:** the key is in the host's vault. It is injected into requests
  and cannot be read back by the plugin.
- **MCP / skill:** the key is in a config file or environment variable, in plain
  text. That is the trade-off for portability.
  - `chmod 600` the config file on Linux/macOS.
  - Prefer an environment variable where the client supports one.
  - Never commit a filled-in config. This repository contains no keys; the
    examples use `sk-your-key-here`.
  - The key controls your home. Revoke it at the provider if it leaks.

## Troubleshooting

Errors come back as `{"ok": false, "errorCode": ..., "message": ..., "hint": ...}`.
The table lists the codes of the MCP server. The Cindy plugin uses the same shape
and the same codes, with these differences: it has no `PERMISSION` (a
home-structure refusal arrives as `AUTH` or `API_ERROR` with a hint naming the
call family), `AUTH` in the plugin is fixed in the plugin settings instead of
`TUYA_REGION`, and `INVALID_CONFIG` and `BAD_MODEL` are MCP-only.

| `errorCode` | Meaning | Fix |
|---|---|---|
| `NETWORK` | The request never reached Tuya | Connection problem. Not a key problem — do not replace the key. |
| `RATE_LIMITED` | Tuya refused a burst | Wait a few seconds. Reads retry automatically. |
| `AUTH` | Key not accepted | Usually the wrong data centre: set `TUYA_REGION` (plugin: the data centre selector). If every centre refuses, the key is expired. |
| `PERMISSION` | Key may not do that | MCP only. Structure changes belong in the Tuya app. |
| `NO_DATACENTRE` | No centre accepted the key | The message lists each centre's answer; the `hint` says whether a silent centre makes the result inconclusive. |
| `INVALID_PROPERTY` | No such property | The `hint` lists writable codes; call `get_device` first. |
| `READ_ONLY` / `OUT_OF_RANGE` / `INVALID_VALUE` | Bad input | Refused locally, nothing was sent. |
| `DEVICE_OFFLINE` | Device is not connected | Power/network; the last state is still readable. |
| `DEVICE_NOT_FOUND` | The id is not in this account | Call `list_devices` again and use a returned id. |
| `NO_HOME` / `HOME_REQUIRED` / `HOME_NOT_FOUND` | Home lookup failed | Pass `home_id` from `list_homes` when the account has several homes. |
| `ROOM_NOT_FOUND` | The room id is not in that home | Pass `room_id` from `list_homes`. |
| `INVALID_DEVICE` | `device_id` missing or malformed | Pass a returned `device_id` verbatim. |
| `NO_SWITCH` | The device has no on/off property | Use `set_device`, or the Tuya app. |
| `UNSUPPORTED_TYPE` | Raw/bitmap/struct/array property | Not writable here; use the Tuya app. |
| `ADVANCED_REQUIRED` | Home-structure tools are off | Turn them on in the plugin settings only if the user asks; otherwise use the Tuya app. |
| `CONFIRMATION_REQUIRED` | `remove_device` without a matching `confirm_device_id` | Repeat the exact `device_id` in `confirm_device_id`. |
| `CREATE_ROOM_FAILED` | Neither room endpoint accepted the key | Create the room in the Tuya app. |
| `BAD_RESPONSE` / `BAD_MODEL` | Tuya answered with a body that could not be parsed | The request is retried once (reads and the model read); if it repeats, pin the data centre and check the device still exists. |
| `INVALID_CONFIG` | An override is unusable (for example an unknown `TUYA_REGION`) | Fix the value; the `hint` lists the valid ones. |
| `SERVER` | Tuya-side failure | Retried automatically; try again in a moment. |
| `API_ERROR` | Any other Tuya rejection | The message carries the vendor code and text. |
| `UNKNOWN_TOOL` / `INTERNAL` | Caller mistake or unexpected failure | Check the tool name; the message says what failed. |

Server exits immediately with `TUYA_API_KEY is required`: the client did not pass
the variable. Check the `env` block, restart the client, and remember most
clients only read the config at startup.

## Uninstall

- Cindy plugin: disable or remove it in Cindy's plugin list.
- MCP: delete the `mcpServers.tuya` entry, restart the client, and remove
  `~/tools/tuya-mcp`.
- Skill: delete the skill folder.
- Revoke the key at the provider if you are done with it entirely.
