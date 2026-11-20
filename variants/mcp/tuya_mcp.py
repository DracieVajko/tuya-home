#!/usr/bin/env python3
"""Tuya Home — MCP server (stdio JSON-RPC, standard library only).

Control Tuya / Smart Life devices from any MCP-capable client: Claude Code,
Codex CLI, Gemini CLI, Cursor, Windsurf, Cline, Zed, Copilot, Cindy, ...

Environment:
  TUYA_API_KEY   required. Starts with "sk-". Create it at tuya.ai (international)
                 or tuyasmart.com (China mainland). It is only ever sent to Tuya.
  TUYA_REGION    optional. Pin a data centre (cn, us-w, eu-c, in, us-e, eu-w, sg)
                 instead of probing. Pin it when the account is region-locked.
  TUYA_BASE      optional. Full base URL override, e.g. http://127.0.0.1:8080 for
                 tests or a proxy. Implies a single centre; no probing.

Run:
  python3 tuya_mcp.py            # speaks MCP on stdin/stdout
  python3 tuya_mcp.py --version
  python3 tuya_mcp.py --selftest # local checks that need no key and no network

Design notes:
  * No third-party dependencies. Python 3.8+ and nothing else.
  * Reads are retried briefly; writes are retried only when the request never
    reached Tuya. A timeout after sending a write is ambiguous and is reported
    as such instead of being replayed.
  * A host or network failure is never reported as "the key was rejected" —
    that mistake sends people off to replace a perfectly good key.
"""

import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request

SERVER_NAME = "tuya-home"
SERVER_VERSION = "0.3.0"

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
DEFAULT_PROTOCOL = "2024-11-05"

DATA_CENTRES = [
    ("cn", "https://openapi.tuyacn.com"),
    ("us-w", "https://openapi.tuyaus.com"),
    ("eu-c", "https://openapi.tuyaeu.com"),
    ("in", "https://openapi.tuyain.com"),
    ("us-e", "https://openapi-ueaz.tuyaus.com"),
    ("eu-w", "https://openapi-weaz.tuyaeu.com"),
    ("sg", "https://openapi-sg.iotbing.com"),
]

PROBE_TIMEOUT = 8
CALL_TIMEOUT = 20
RETRY_DELAYS = (0.4, 1.0)

# Tuya rejects a burst of requests with a message rather than a code we can
# rely on. It says nothing about the key, so it must not be reported as one.
BURST_MARKERS = ("同时进行的网络请求", "upper limit", "concurrent", "too many request")

API_KEY = os.environ.get("TUYA_API_KEY", "").strip()
PINNED = os.environ.get("TUYA_REGION", "").strip() or None
BASE_OVERRIDE = (os.environ.get("TUYA_BASE", "").strip() or None)


def log(message):
    sys.stderr.write(str(message) + "\n")
    sys.stderr.flush()


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class TuyaFailure(Exception):
    """A failure with a machine-readable code, a message and an optional hint."""

    def __init__(self, code, message, hint="", transient=False, ambiguous=False):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.hint = hint
        self.transient = transient
        self.ambiguous = ambiguous

    def as_dict(self):
        out = {"ok": False, "errorCode": self.code, "message": self.message}
        if self.hint:
            out["hint"] = self.hint
        return out


def is_burst(message):
    text = (message or "").lower()
    for marker in BURST_MARKERS:
        if marker.lower() in text:
            return True
    return False


def http_call(base, path, method="GET", body=None, timeout=CALL_TIMEOUT):
    """One HTTPS request. Raises TuyaFailure on anything that is not a 2xx JSON."""
    url = base + path
    data = None
    headers = {"Authorization": "Bearer " + API_KEY, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        status = err.code
    except (socket.timeout, TimeoutError) as err:
        # The request was sent but no answer came back: a write may have landed,
        # so it is reported as ambiguous and never replayed.
        raise TuyaFailure(
            "NETWORK",
            "Timed out waiting for Tuya after %ss: %s" % (timeout, err),
            "Read the device before retrying; the command may have been applied.",
            transient=True,
            ambiguous=True,
        )
    except (urllib.error.URLError, OSError) as err:
        reason = getattr(err, "reason", err)
        raise TuyaFailure(
            "NETWORK",
            "The request did not reach Tuya: %s" % reason,
            "Check that this computer is online. This says nothing about the key.",
            transient=True,
        )

    try:
        payload = json.loads(raw)
    except ValueError:
        raise TuyaFailure(
            "BAD_RESPONSE",
            "Tuya answered with a non-JSON body (HTTP %s)." % status,
            "The request probably never reached the Tuya API. Retry once; if it repeats, "
            "pin the data centre with TUYA_REGION.",
            transient=True,
        )

    if payload.get("success") is True:
        return payload.get("result")

    code = payload.get("code")
    message = payload.get("msg") or "Tuya rejected the request"

    if is_burst(message) or code == 429 or status == 429:
        raise TuyaFailure(
            "RATE_LIMITED",
            "Tuya is refusing a burst of requests: %s" % message,
            "Wait a few seconds before trying again. This is a rate limit, not a key problem.",
            transient=True,
        )

    if isinstance(status, int) and status >= 500:
        raise TuyaFailure(
            "SERVER",
            "Tuya had a server-side failure (HTTP %s, code %s)." % (status, code),
            "Retry in a moment.",
            transient=True,
        )

    detail = "Tuya error %s: %s" % (code, message)

    if code in (1004, 1010, 1013, 1108):
        raise TuyaFailure(
            "AUTH",
            detail,
            "The key was not accepted. Most often it belongs to a different data centre than "
            "the account: set TUYA_REGION (e.g. eu-c) and try again. If every centre refuses it, "
            "the key is expired or revoked — create a new one.",
        )

    if code == 1106:
        raise TuyaFailure(
            "PERMISSION",
            detail,
            "This key is not allowed to do that. An end-user key (sk-) cannot change the "
            "structure of a home; that is done in the Tuya app.",
        )

    raise TuyaFailure("API_ERROR", detail)


def should_retry(failure, writing):
    """A write is only replayed when the request verifiably never reached Tuya."""
    if failure.ambiguous or not failure.transient:
        return False
    if writing and failure.code in ("SERVER", "BAD_RESPONSE"):
        return False
    return True


def with_retry(action, attempts, writing=False):
    last = None
    for index in range(attempts):
        try:
            return action()
        except TuyaFailure as failure:
            last = failure
            if index == attempts - 1 or not should_retry(failure, writing):
                raise
            time.sleep(RETRY_DELAYS[min(index, len(RETRY_DELAYS) - 1)])
    raise last


_verified = {"region": None, "base": None}


def centres():
    if BASE_OVERRIDE:
        return [("override", BASE_OVERRIDE.rstrip("/"))]
    if PINNED:
        for region, base in DATA_CENTRES:
            if region == PINNED:
                return [(region, base)]
        raise TuyaFailure(
            "INVALID_CONFIG",
            "TUYA_REGION=%s is not a known data centre." % PINNED,
            "Use one of: " + ", ".join(region for region, _ in DATA_CENTRES),
        )
    return list(DATA_CENTRES)


def resolve_base(refresh=False):
    """Find and remember the data centre that answers. Probing is not free."""
    if refresh:
        _verified["region"] = None
        _verified["base"] = None
    if _verified["base"]:
        return _verified["region"], _verified["base"]

    tried = []
    rejected = 0
    silent = 0
    last_transient = None
    for region, base in centres():
        try:
            with_retry(lambda b=base: http_call(b, "/v1.0/end-user/homes/all", timeout=PROBE_TIMEOUT), 2)
            _verified["region"] = region
            _verified["base"] = base
            return region, base
        except TuyaFailure as failure:
            tried.append("%s: %s" % (region, failure.message))
            if failure.code in ("NETWORK", "RATE_LIMITED", "SERVER", "BAD_RESPONSE"):
                silent += 1
                last_transient = failure
            else:
                rejected += 1

    if rejected == 0 and last_transient is not None:
        # Nothing answered: this says nothing about the key.
        raise last_transient

    hint = "Tried: " + " | ".join(tried)
    if silent:
        hint += "  Some centres never answered, so this is not proof the key is dead: run the test again."
    raise TuyaFailure(
        "NO_DATACENTRE",
        "No data centre accepted the key (%d rejected, %d silent)." % (rejected, silent),
        hint,
    )


def tuya(path, method="GET", body=None, timeout=CALL_TIMEOUT, refresh=False):
    _, base = resolve_base(refresh=refresh)
    attempts = 3 if method == "GET" else 2
    return with_retry(
        lambda: http_call(base, path, method=method, body=body, timeout=timeout),
        attempts,
        writing=method != "GET",
    )


def as_array(value, key):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for candidate in (key, "list", "data", "rooms", "devices", "homes"):
            if isinstance(value.get(candidate), list):
                return value[candidate]
    return []


def device_id_of(device):
    return device.get("device_id") or device.get("devId") or device.get("id")


def home_id_of(home):
    return home.get("home_id") or home.get("gid") or home.get("homeId") or home.get("id")


def room_id_of(room):
    return room.get("room_id") or room.get("roomId") or room.get("id")


def require_device_id(args):
    device_id = args.get("device_id")
    if not isinstance(device_id, str) or not device_id.strip():
        raise TuyaFailure("INVALID_DEVICE", "device_id is required.", "Call list_devices first and pass a device_id verbatim.")
    clean = device_id.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", clean):
        raise TuyaFailure(
            "INVALID_DEVICE",
            "device_id is missing or malformed.",
            "Call list_devices and pass one of the returned device_id values verbatim.",
        )
    return clean


def load_model(device_id):
    result = tuya("/v1.0/end-user/devices/%s/model" % device_id)
    raw = result.get("model") if isinstance(result, dict) and "model" in result else result
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            raise TuyaFailure(
                "BAD_MODEL",
                "Tuya returned an unreadable device model.",
                "Retry once. If it repeats, open the device in the Tuya app and check it still exists.",
                transient=True,
            )
    return raw or {}


def model_properties(model):
    properties = []
    for service in (model.get("services") or []):
        for prop in (service.get("properties") or []):
            properties.append(prop)
    return properties


def describe_property(prop):
    """Same shape the plugin returns, so a caller can read one contract."""
    spec = prop.get("typeSpec") or {}
    kind = spec.get("type")
    out = {
        "code": prop.get("code"),
        "name": prop.get("name") or prop.get("code"),
        "type": kind,
    }
    if kind == "bool":
        out["accepts"] = "true or false"
    elif kind == "enum":
        values = spec.get("range") or []
        out["range"] = values
        out["accepts"] = " | ".join(str(value) for value in values)
    elif kind == "value":
        scale = spec.get("scale") or 0
        minimum = spec.get("min")
        maximum = spec.get("max")
        if isinstance(minimum, (int, float)):
            out["min"] = minimum / (10 ** scale)
        if isinstance(maximum, (int, float)):
            out["max"] = maximum / (10 ** scale)
        if scale:
            out["scale"] = scale
        if spec.get("unit"):
            out["unit"] = spec.get("unit")
        if "min" in out and "max" in out:
            out["accepts"] = "number from %s to %s" % (out["min"], out["max"])
        elif "min" in out:
            out["accepts"] = "number from %s" % out["min"]
        elif "max" in out:
            out["accepts"] = "number up to %s" % out["max"]
        else:
            out["accepts"] = "number"
    elif kind == "string":
        out["max_length"] = spec.get("maxlen") or 255
        out["accepts"] = "text up to %s characters" % out["max_length"]
    else:
        out["accepts"] = "not supported by this server (%s)" % kind
        out["unsupported"] = True
    return out


def humanise(state):
    if isinstance(state, str):
        try:
            state = json.loads(state)
        except ValueError:
            return {}
    return state if isinstance(state, dict) else {}


# ------------------------------------------------------------------ tools ---


def tool_tuya_status(args):
    refresh = bool(args.get("refresh"))
    region, base = resolve_base(refresh=refresh)
    homes = as_array(tuya("/v1.0/end-user/homes/all", refresh=refresh), "homes")
    return {
        "ok": True,
        "region": region,
        "base": base,
        "homes_visible": len(homes),
        "summary": "Connected to Tuya %s (%s): %d home(s) visible to this key." % (region, base, len(homes)),
    }


def tool_list_homes(args):
    region, _ = resolve_base()
    homes = as_array(tuya("/v1.0/end-user/homes/all"), "homes")
    out = []
    for home in homes:
        home_id = home_id_of(home)
        if not home_id:
            continue
        rooms = as_array(tuya("/v1.0/end-user/homes/%s/rooms" % home_id), "rooms")
        out.append({
            "home_id": str(home_id),
            "name": home.get("name") or str(home_id),
            "rooms": [{"room_id": str(room_id_of(room)), "name": room.get("name") or str(room_id_of(room))}
                      for room in rooms if room_id_of(room)],
        })
    lines = []
    for home in out:
        rooms = ", ".join(room["name"] for room in home["rooms"]) or "no rooms"
        lines.append("%s (%s): %s" % (home["name"], home["home_id"], rooms))
    return {
        "ok": True,
        "region": region,
        "summary": "\n".join(lines) if lines else "This Tuya account has no homes.",
        "homes": out,
    }


def tool_list_devices(args):
    refresh = bool(args.get("refresh"))
    region, _ = resolve_base(refresh=refresh)
    homes = as_array(tuya("/v1.0/end-user/homes/all", refresh=refresh), "homes")

    devices = []
    seen = set()

    if not homes:
        for device in as_array(tuya("/v1.0/end-user/devices/all"), "devices"):
            device_id = device_id_of(device)
            if device_id and device_id not in seen:
                seen.add(device_id)
                devices.append(device)

    for home in homes:
        home_id = home_id_of(home)
        if not home_id:
            continue

        room_names = {}
        for room in as_array(tuya("/v1.0/end-user/homes/%s/rooms" % home_id), "rooms"):
            room_id = room_id_of(room)
            if room_id:
                room_names[str(room_id)] = room.get("name") or str(room_id)

        for device in as_array(tuya("/v1.0/end-user/homes/%s/devices" % home_id), "devices"):
            device_id = device_id_of(device)
            if not device_id or device_id in seen:
                continue
            seen.add(device_id)
            device["_home_id"] = str(home_id)
            device["_room_id"] = str(device.get("room_id") or device.get("roomId") or "") or None
            device["_room_name"] = room_names.get(device["_room_id"]) if device["_room_id"] else None
            devices.append(device)

    home_filter = args.get("home_id")
    room_filter = args.get("room_id")
    out = []
    for device in devices:
        if home_filter and device.get("_home_id") != str(home_filter):
            continue
        if room_filter and device.get("_room_id") != str(room_filter):
            continue
        out.append({
            "device_id": device_id_of(device),
            "name": device.get("name") or device_id_of(device),
            "category": device.get("category_name") or device.get("category") or "",
            "online": device.get("online") is True,
            "home_id": device.get("_home_id"),
            "room_id": device.get("_room_id"),
            "room_name": device.get("_room_name"),
        })

    lines = []
    current_room = object()
    for device in sorted(out, key=lambda d: (d["room_name"] or "", d["name"] or "")):
        room = device["room_name"] or "No room"
        if room != current_room:
            lines.append(room)
            current_room = room
        lines.append("  - %s%s (%s) — %s" % (
            device["name"],
            "" if device["online"] else " [offline]",
            device["category"] or "unknown",
            device["device_id"],
        ))

    return {
        "ok": True,
        "region": region,
        "count": len(out),
        "matched": len(out),
        "summary": "\n".join(lines) if lines else "No devices visible to this key.",
        "devices": out,
    }


def tool_get_device(args):
    device_id = require_device_id(args)
    detail = tuya("/v1.0/end-user/devices/%s/detail" % device_id)
    if not isinstance(detail, dict):
        raise TuyaFailure(
            "DEVICE_NOT_FOUND",
            "Tuya returned no detail for this device.",
            "The device may have been removed, or the key has no access to it. Call list_devices again.",
        )
    model = load_model(device_id)

    writable = []
    for prop in model_properties(model):
        if prop.get("accessMode") == "ro":
            continue
        described = describe_property(prop)
        if described.get("unsupported"):
            continue
        described.pop("read_only", None)
        writable.append(described)
    state = humanise(detail.get("properties") or {})

    category = detail.get("category") or ""
    category_name = detail.get("category_name") or category
    lines = [
        "%s — %s" % (detail.get("name") or device_id, "online" if detail.get("online") is True else "offline"),
        "Current state:",
    ]
    for code, value in list(state.items())[:24]:
        lines.append("  %s = %s" % (code, json.dumps(value)))
    lines.append("Writable:")
    for prop in writable[:24]:
        lines.append("  %s (%s) %s — %s" % (prop["code"], prop["type"], prop["accepts"], prop["name"]))

    return {
        "ok": True,
        "summary": "\n".join(lines),
        "device_id": device_id,
        "name": detail.get("name") or device_id,
        "online": detail.get("online") is True,
        "category": category,
        "category_name": category_name,
        "state": state,
        "writable": writable,
    }


def tool_set_device(args):
    device_id = require_device_id(args)
    requested = args.get("properties")
    if not isinstance(requested, dict) or not requested:
        raise TuyaFailure("INVALID_VALUE", "properties must be a non-empty object of code to value.",
                          'Example: {"switch_led": true}')

    model = load_model(device_id)
    specs = {prop.get("code"): prop for prop in model_properties(model)}

    raw = {}
    applied = {}
    for code, value in requested.items():
        spec = specs.get(code)
        if not spec:
            raise TuyaFailure(
                "INVALID_PROPERTY",
                'This device has no property "%s".' % code,
                "Writable properties: " + ", ".join(sorted(c for c, p in specs.items() if p.get("accessMode") != "ro")),
            )
        if spec.get("accessMode") == "ro":
            raise TuyaFailure("READ_ONLY", '"%s" is read-only.' % code, "Pick a writable property from get_device.")

        type_spec = spec.get("typeSpec") or {}
        kind = type_spec.get("type")
        scale = type_spec.get("scale") if isinstance(type_spec.get("scale"), int) else 0

        if kind == "bool":
            if isinstance(value, str) and value.lower() in ("true", "false"):
                value = value.lower() == "true"
            if not isinstance(value, bool):
                raise TuyaFailure("INVALID_VALUE", '"%s" needs true or false, got %r.' % (code, value))
            raw[code] = value
            applied[code] = value

        elif kind == "enum":
            allowed = type_spec.get("range") or []
            if value not in allowed:
                raise TuyaFailure(
                    "INVALID_VALUE",
                    '"%s" does not accept %r.' % (code, value),
                    "Allowed values: " + " | ".join(str(v) for v in allowed),
                )
            raw[code] = value
            applied[code] = value

        elif kind == "value":
            try:
                number = float(value)
            except (TypeError, ValueError):
                raise TuyaFailure("INVALID_VALUE", '"%s" needs a number, got %r.' % (code, value))
            minimum = type_spec.get("min")
            maximum = type_spec.get("max")
            if isinstance(minimum, (int, float)):
                minimum = minimum / (10 ** scale)
            else:
                minimum = None
            if isinstance(maximum, (int, float)):
                maximum = maximum / (10 ** scale)
            else:
                maximum = None
            if (minimum is not None and number < minimum) or (maximum is not None and number > maximum):
                raise TuyaFailure(
                    "OUT_OF_RANGE",
                    '"%s" must be between %s and %s%s, got %s.' % (
                        code, minimum, maximum, type_spec.get("unit") or "", number),
                    "Send a value inside that range.",
                )
            encoded = int(round(number * (10 ** scale)))
            raw[code] = encoded
            applied[code] = encoded / (10 ** scale)

        elif kind == "string":
            text = str(value)
            limit = type_spec.get("maxlen") or 255
            if not 1 <= len(text) <= limit:
                raise TuyaFailure("INVALID_VALUE", '"%s" must be 1 to %d characters.' % (code, limit))
            raw[code] = text
            applied[code] = text

        else:
            raise TuyaFailure("UNSUPPORTED_TYPE", '"%s" has type %r, which this server does not write.' % (code, kind),
                              "Use the Tuya app for that property.")

    try:
        tuya("/v1.0/end-user/devices/%s/shadow/properties/issue" % device_id,
             method="POST", body={"properties": json.dumps(raw)})
    except TuyaFailure as failure:
        if failure.code == "NETWORK" and failure.ambiguous:
            failure.hint = "The command may or may not have been applied. Read the device before retrying."
        raise failure

    return {
        "ok": True,
        "device_id": device_id,
        "applied": applied,
        "summary": "Sent to %s: %s. Tuya applies commands on the device; this is not an instant acknowledgement."
                   % (device_id, ", ".join("%s = %s" % (code, json.dumps(value)) for code, value in applied.items())),
    }


def tool_rename_device(args):
    device_id = require_device_id(args)
    name = args.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
        raise TuyaFailure("INVALID_VALUE", "name must be 1 to 40 characters.", "Pass the name verbatim.")
    name = name.strip()
    tuya("/v1.0/end-user/devices/%s/attribute" % device_id, method="POST", body={"name": name})
    return {"ok": True, "device_id": device_id, "name": name, "summary": 'Renamed %s to "%s".' % (device_id, name)}


TOOL_SPECS = {
    "tuya_status": {
        "fn": tool_tuya_status,
        "description": "Diagnostic: which Tuya data centre answers for the saved key, whether the key works, and how many homes it sees. Use it first when nothing connects.",
        "inputSchema": {
            "type": "object",
            "properties": {"refresh": {"type": "boolean", "description": "Forget the cached data centre and probe again."}},
            "required": [],
        },
    },
    "list_homes": {
        "fn": tool_list_homes,
        "description": "List the Tuya homes and their rooms. Use it before scoping devices by home or room.",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    "list_devices": {
        "fn": tool_list_devices,
        "description": "List devices with online state, home and room. This is almost always the first call: it gives the real names and device_id values.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "home_id": {"type": "string", "description": "Only devices in this home."},
                "room_id": {"type": "string", "description": "Only devices in this room."},
                "refresh": {"type": "boolean", "description": "Read Tuya again instead of the short-lived cache."},
            },
            "required": [],
        },
    },
    "get_device": {
        "fn": tool_get_device,
        "description": "Read one device: current values plus the properties it accepts, with types, ranges and units. Call before changing something you are unsure about.",
        "inputSchema": {
            "type": "object",
            "properties": {"device_id": {"type": "string", "description": "Device id from list_devices."}},
            "required": ["device_id"],
        },
    },
    "set_device": {
        "fn": tool_set_device,
        "description": "Change properties on one device. Values are validated against the device's own model before anything is sent: unknown codes, read-only codes, wrong types and out-of-range values fail locally with the allowed values.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "device_id": {"type": "string", "description": "Device id from list_devices."},
                "properties": {"type": "object", "additionalProperties": True,
                               "description": 'Property code to value, e.g. {"switch_led": true}.'},
            },
            "required": ["device_id", "properties"],
        },
    },
    "rename_device": {
        "fn": tool_rename_device,
        "description": "Rename a device. This changes what the user sees in the Tuya app too, so only do it when asked.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "device_id": {"type": "string", "description": "Device id from list_devices."},
                "name": {"type": "string", "description": "New display name, 1 to 40 characters."},
            },
            "required": ["device_id", "name"],
        },
    },
}

TOOL_LIST = [{"name": name, "description": spec["description"], "inputSchema": spec["inputSchema"]}
             for name, spec in TOOL_SPECS.items()]

INSTRUCTIONS = (
    "Tuya / Smart Life control. Start with list_devices to learn real names and device ids, "
    "then get_device before changing anything. The API key is end-user scoped: it can read, "
    "control and rename, but it cannot create rooms or unbind devices — that is done in the Tuya app."
)


def handle_request(request):
    method = request.get("method")
    request_id = request.get("id")

    if method == "initialize":
        asked = (request.get("params") or {}).get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else DEFAULT_PROTOCOL
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": INSTRUCTIONS,
        }})
        return

    if method in ("notifications/initialized", "initialized"):
        return

    if method == "ping":
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        return

    if method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOL_LIST}})
        return

    if method == "tools/call":
        params = request.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        spec = TOOL_SPECS.get(name)
        if not spec:
            send({"jsonrpc": "2.0", "id": request_id, "result": {
                "content": [{"type": "text", "text": "unknown tool: %s" % name}], "isError": True}})
            return
        try:
            payload = spec["fn"](args if isinstance(args, dict) else {})
            failed = False
        except TuyaFailure as failure:
            payload = failure.as_dict()
            failed = True
        except Exception as err:  # never kill the server for one bad call
            payload = {"ok": False, "errorCode": "INTERNAL", "message": str(err)}
            failed = True
        send({"jsonrpc": "2.0", "id": request_id, "result": {
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
            "structuredContent": payload,
            "isError": failed,
        }})
        return

    if request_id is None:
        return

    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method not found: %s" % method}})


def selftest():
    """Local checks that need no key and no network."""
    problems = []

    if len(TOOL_LIST) != 6:
        problems.append("expected 6 tools, got %d" % len(TOOL_LIST))

    for tool in TOOL_LIST:
        for field in ("name", "description", "inputSchema"):
            if not tool.get(field):
                problems.append("tool %s is missing %s" % (tool.get("name"), field))

    burst = TuyaFailure("RATE_LIMITED", "x", transient=True)
    if not is_burst("同时进行的网络请求已达上限(4),请等在途请求返回"):
        problems.append("burst message not recognised in Chinese")
    if not is_burst("concurrent requests upper limit"):
        problems.append("burst message not recognised in English")
    if is_burst("token invalid"):
        problems.append("an auth message was mistaken for a burst limit")

    if as_array({"rooms": [1, 2]}, "rooms") != [1, 2]:
        problems.append("as_array failed on a rooms payload")

    for bad in ({"code": "NETWORK"},):
        failure = TuyaFailure(bad["code"], "msg", "hint")
        if failure.as_dict()["ok"] is not False:
            problems.append("failure did not render as ok:false")

    log("tuya-home %s selftest" % SERVER_VERSION)
    log("tools: " + ", ".join(t["name"] for t in TOOL_LIST))
    if problems:
        for problem in problems:
            log("FAIL " + problem)
        return 1
    log("all local checks passed")
    return 0


def main(argv):
    if "--version" in argv:
        print("%s %s" % (SERVER_NAME, SERVER_VERSION))
        return 0
    if "--selftest" in argv:
        return selftest()

    if not API_KEY:
        log("TUYA_API_KEY is required (it starts with sk-). Set it in the MCP client config or the environment.")
        return 1
    if not API_KEY.startswith("sk-"):
        log("Warning: TUYA_API_KEY does not start with sk-. Continuing anyway.")

    log("%s %s ready (python %s)" % (SERVER_NAME, SERVER_VERSION, sys.version.split()[0]))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            log("ignoring a line that is not JSON")
            continue
        handle_request(request)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
