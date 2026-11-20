---
name: tuya-home
description: Read and control the user's Tuya / Smart Life smart home devices via Tuya's cloud end-user API. Use for lights, plugs, air conditioners, sensors, curtains, EV chargers, cameras and robot vacuums.
---

# Tuya Home (OpenClaw variant)

Cloud-bridged control of the user's Tuya account. Requires `TUYA_API_KEY` (starts with `sk-`) in the environment.

## Setup
- Create a key at https://tuya.ai/developer (international) or https://tuyasmart.com/ (China).
- Export it: `export TUYA_API_KEY=sk-...` (or set in your agent env).

## Commands (CLI)
```
python scripts/tuya.py homes
python scripts/tuya.py devices
python scripts/tuya.py device <device_id>
python scripts/tuya.py set <device_id> <code> <value>
```

## Agent workflow
1. `devices` to discover names and ids.
2. `device <id>` to read state and writable properties with ranges.
3. `set <id> <code> <value>` to control (confirm with user first for destructive actions).
4. Values must stay inside the reported range; booleans are true/false; enums are exact strings.

## Limits
- Cloud only, no live push, no WebSocket.
- No locks, no live camera streams, no firmware, no pairing/removal.
- Trial rate limits apply.
- Rotate the key if it is ever exposed.
