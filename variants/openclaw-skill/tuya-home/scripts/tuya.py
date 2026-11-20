#!/usr/bin/env python3
"""Local Tuya account smoke tester (outside Cindy).

Usage:
  set TUYA_API_KEY=sk-...            (Windows PowerShell: $env:TUYA_API_KEY="sk-...")
  python tuya.py               # discover DC + list homes/devices
  python tuya.py homes
  python tuya.py devices
  python tuya.py device <device_id>
  python tuya.py set <device_id> <code> <value>   # asks for confirmation

The key is read from the environment only. It is never written to disk or printed.
"""

import os
import re
import sys
import json
import time

DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{4,64}$")


def require_id(value, label):
    """Never interpolate an unchecked id into a URL path."""
    if not isinstance(value, str) or not DEVICE_ID.fullmatch(value.strip()):
        raise SystemExit("%s is missing or malformed; pass an id from `tuya.py devices`." % label)
    return value.strip()

try:
    import requests
except Exception:
    print("Missing dependency: pip install requests")
    sys.exit(1)

DATA_CENTRES = [
    ("cn", "https://openapi.tuyacn.com"),
    ("us-w", "https://openapi.tuyaus.com"),
    ("eu-c", "https://openapi.tuyaeu.com"),
    ("in", "https://openapi.tuyain.com"),
    ("us-e", "https://openapi-ueaz.tuyaus.com"),
    ("eu-w", "https://openapi-weaz.tuyaeu.com"),
    ("sg", "https://openapi-sg.iotbing.com"),
]

API_KEY = os.environ.get("TUYA_API_KEY", "").strip()
PINNED = os.environ.get("TUYA_REGION", "").strip() or None


def headers():
    return {"Authorization": "Bearer " + API_KEY, "Accept": "application/json"}


def call(base, path, method="GET", body=None, timeout=15):
    url = base + path
    try:
        r = requests.request(method, url, headers=headers(), json=body, timeout=timeout)
    except Exception as e:
        return None, "NETWORK: " + str(e)
    try:
        data = r.json()
    except Exception:
        return None, "BAD_RESPONSE HTTP %s: %s" % (r.status_code, r.text[:200])
    if data.get("success") is True:
        return data.get("result"), None
    code = data.get("code")
    msg = data.get("msg") or "rejected"
    return None, "Tuya %s: %s" % (code, msg)


def discover():
    centres = DATA_CENTRES
    if PINNED:
        centres = [dc for dc in DATA_CENTRES if dc[0] == PINNED]
        if not centres:
            print("Pinned region not found:", PINNED)
            sys.exit(1)
    tried = []
    for region, base in centres:
        res, err = call(base, "/v1.0/end-user/homes/all")
        if err is None:
            return region, base, res, tried
        tried.append((region, err))
        # stop on network-level failure
        if err.startswith("NETWORK"):
            break
    return None, None, None, tried


def as_array(v, key):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        for k in (key, "list", "data"):
            if isinstance(v.get(k), list):
                return v[k]
    return []


def main():
    global API_KEY
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    if not API_KEY:
        print("Set TUYA_API_KEY first. Example (PowerShell):")
        print('  $env:TUYA_API_KEY = "sk-..."')
        print("  python tuya.py")
        sys.exit(1)
    if not API_KEY.startswith("sk-"):
        print("Warning: key does not start with sk-; continuing anyway.")

    region, base, homes_raw, tried = discover()
    if region is None:
        print("No data centre accepted the key.")
        for r, e in tried:
            print("  ", r, "->", e)
        print("Tip: set TUYA_REGION to one of: " + ", ".join(r for r, _ in DATA_CENTRES))
        sys.exit(1)

    print("Connected: region=%s base=%s" % (region, base))
    homes = as_array(homes_raw, "homes")

    cmd = (sys.argv[1] if len(sys.argv) > 1 else "devices").lower()

    if cmd == "homes":
        print("Homes: %d" % len(homes))
        for h in homes:
            hid = h.get("home_id") or h.get("gid") or h.get("id")
            print("  - %s (%s)" % (h.get("name") or hid, hid))
        return

    # list devices across homes
    devices = []
    seen = set()
    if not homes:
        res, err = call(base, "/v1.0/end-user/devices/all")
        if err:
            print("devices/all failed:", err)
        else:
            for d in as_array(res, "devices"):
                did = d.get("device_id") or d.get("devId") or d.get("id")
                if did and did not in seen:
                    seen.add(did); devices.append(d)
    for h in homes:
        hid = h.get("home_id") or h.get("gid") or h.get("id")
        if not hid:
            continue
        res, err = call(base, "/v1.0/end-user/homes/%s/rooms" % hid)
        rooms = {}
        if not err:
            for r in as_array(res, "rooms"):
                rid = r.get("room_id") or r.get("roomId") or r.get("id")
                if rid:
                    rooms[rid] = r.get("name") or rid
        res, err = call(base, "/v1.0/end-user/homes/%s/devices" % hid)
        if err:
            print("  home %s devices failed: %s" % (hid, err))
            continue
        for d in as_array(res, "devices"):
            did = d.get("device_id") or d.get("devId") or d.get("id")
            if not did or did in seen:
                continue
            seen.add(did)
            d["_home"] = h.get("name") or hid
            d["_room"] = rooms.get(d.get("room_id") or d.get("roomId"))
            devices.append(d)

    if cmd == "devices":
        print("Devices: %d" % len(devices))
        for d in devices:
            did = d.get("device_id") or d.get("devId") or d.get("id")
            print("  - %s | %s | %s | %s" % (
                d.get("name") or did,
                d.get("category_name") or d.get("category") or "?",
                "online" if d.get("online") is True else "offline",
                did))
        return

    if cmd == "device":
        if len(sys.argv) < 3:
            print("Usage: tuya.py device <device_id>")
            sys.exit(1)
        did = require_id(sys.argv[2], "device_id")
        res, err = call(base, "/v1.0/end-user/devices/%s/detail" % did)
        if err:
            print("detail failed:", err); sys.exit(1)
        print(json.dumps(res, indent=2, ensure_ascii=False))
        mres, merr = call(base, "/v1.0/end-user/devices/%s/model" % did)
        if merr:
            print("model failed:", merr)
        else:
            print("\nMODEL:")
            print(json.dumps(mres, indent=2, ensure_ascii=False))
        return

    if cmd == "set":
        if len(sys.argv) < 5:
            print("Usage: tuya.py set <device_id> <code> <value>")
            sys.exit(1)
        did = require_id(sys.argv[2], "device_id")
        code = sys.argv[3]
        raw_val = sys.argv[4]
        try:
            if raw_val.lower() in ("true", "false"):
                value = raw_val.lower() == "true"
            else:
                value = json.loads(raw_val)
        except Exception:
            value = raw_val
        print("About to set %s.%s = %r" % (did, code, value))
        confirm = input("Confirm? (yes/no): ").strip().lower()
        if confirm not in ("y", "yes"):
            print("Aborted.")
            return
        body = {"properties": json.dumps({code: value})}
        res, err = call(base, "/v1.0/end-user/devices/%s/shadow/properties/issue" % did, method="POST", body=body)
        if err:
            print("set failed:", err); sys.exit(1)
        print("Accepted:", json.dumps(res, ensure_ascii=False))
        return

    print("Unknown command:", cmd)
    print("Use: homes | devices | device <id> | set <id> <code> <value>")


if __name__ == "__main__":
    main()
