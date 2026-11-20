#!/usr/bin/env python3
"""End-to-end checks for tuya_mcp.py against a local fake Tuya API.

No real Tuya key, no internet, no third-party packages:

    python3 tests/test_mcp.py

Every assertion here is something that bit us or nearly bit us: a burst cap
reported as a rejected key, a read-only property written by accident, a value
sent without scaling, a rename that silently does nothing.
"""

import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fake_tuya  # noqa: E402

SERVER = os.path.join(os.path.dirname(HERE), "tuya_mcp.py")
FAILURES = []


def check(condition, label):
    if condition:
        print("ok  " + label)
    else:
        print("FAIL " + label)
        FAILURES.append(label)


class Client:
    """Minimal MCP stdio client with a read timeout, so a hang fails the test."""

    def __init__(self, env, expect_failure=False):
        merged = dict(os.environ)
        merged.pop("TUYA_API_KEY", None)
        merged.pop("TUYA_REGION", None)
        merged.pop("TUYA_BASE", None)
        merged.update(env)
        self.proc = subprocess.Popen(
            [sys.executable, SERVER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, env=merged,
        )
        self.lines = queue.Queue()

        def pump():
            for line in self.proc.stdout:
                self.lines.put(line)
            self.lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        self.next_id = 0
        self.expect_failure = expect_failure

    def send(self, payload):
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def read(self, timeout=15):
        try:
            return self.lines.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError("no response within %ss" % timeout)

    def request(self, method, params=None):
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        line = self.read()
        return json.loads(line)

    def call(self, tool, arguments=None):
        reply = self.request("tools/call", {"name": tool, "arguments": arguments or {}})
        result = reply.get("result") or {}
        content = (result.get("content") or [{}])[0].get("text") or "{}"
        return json.loads(content), result

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def main():
    srv, port = fake_tuya.start(0)
    base = "http://127.0.0.1:%d" % port

    # 1. handshake and tool surface
    client = Client({"TUYA_API_KEY": "sk-test", "TUYA_BASE": base})
    init = client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                         "clientInfo": {"name": "test", "version": "0"}})
    result = init.get("result") or {}
    check(result.get("protocolVersion") == "2025-06-18", "protocol version is echoed when supported")
    check((result.get("serverInfo") or {}).get("name") == "tuya-home", "serverInfo names the server")
    check(bool(result.get("instructions")), "initialize carries usage instructions")

    listing = client.request("tools/list")
    tools = (listing.get("result") or {}).get("tools") or []
    check(len(tools) == 6, "six tools are listed, got %d" % len(tools))
    check(all(t.get("description") for t in tools), "every tool has a description")
    check(all(t.get("inputSchema") for t in tools), "every tool has an input schema")

    # 2. reads
    status, _ = client.call("tuya_status")
    check(status.get("ok") is True, "tuya_status connects through the override base")
    check(status.get("homes_visible") == 1, "one home is visible")

    homes, _ = client.call("list_homes")
    check(homes.get("ok") is True, "list_homes works")
    check([r["name"] for r in homes["homes"][0]["rooms"]] == ["Living Room", "Bedroom"], "rooms come back")

    devices, _ = client.call("list_devices")
    check(devices.get("count") == 2, "two devices are listed")
    check("Living Room" in devices.get("summary", ""), "the summary is grouped by room")
    check("[offline]" in devices.get("summary", ""), "offline devices are marked")

    filtered, _ = client.call("list_devices", {"room_id": "r2"})
    check(filtered.get("count") == 1 and filtered["devices"][0]["room_name"] == "Bedroom", "room filter works")

    # 3. model-aware validation, before any request is sent
    device, _ = client.call("get_device", {"device_id": fake_tuya.LIGHT})
    codes = [p["code"] for p in device["writable"]]
    check("status_only" not in codes, "read-only properties are not advertised as writable")
    check("switch_led" in codes, "writable properties are advertised")

    bad_code, _ = client.call("set_device", {"device_id": fake_tuya.LIGHT, "properties": {"switch_9": True}})
    check(bad_code.get("errorCode") == "INVALID_PROPERTY", "an unknown property is refused")
    check("switch_led" in bad_code.get("hint", ""), "the refusal lists what is writable")

    read_only, _ = client.call("set_device", {"device_id": fake_tuya.LIGHT, "properties": {"status_only": True}})
    check(read_only.get("errorCode") == "READ_ONLY", "a read-only property is refused")

    out_of_range, _ = client.call("set_device", {"device_id": fake_tuya.AC, "properties": {"temp_value": 99}})
    check(out_of_range.get("errorCode") == "OUT_OF_RANGE", "an out-of-range value is refused")
    check("16" in out_of_range.get("message", "") and "30" in out_of_range.get("message", ""),
          "the range is reported in real units, got: " + out_of_range.get("message", ""))

    bad_enum, _ = client.call("set_device", {"device_id": fake_tuya.LIGHT, "properties": {"work_mode": "banana"}})
    check(bad_enum.get("errorCode") == "INVALID_VALUE", "a bad enum is refused")
    check("white" in bad_enum.get("hint", ""), "the allowed enum values are listed")

    # 4. a valid write: scaled, retried through the burst cap, and actually sent
    fake_tuya.STATE.reset_burst()
    before = len(fake_tuya.STATE.issued)
    written, _ = client.call("set_device", {"device_id": fake_tuya.LIGHT, "properties": {"switch_led": False}})
    check(written.get("ok") is True, "a valid write succeeds through a burst-cap retry")
    check(len(fake_tuya.STATE.issued) == before + 1, "the write reached the API exactly once")
    sent = json.loads(fake_tuya.STATE.issued[-1]["properties"])
    check(sent.get("switch_led") is False, "the value was sent as a boolean")
    check(fake_tuya.STATE.light_switch is False, "the device state changed on the server side")

    before = len(fake_tuya.STATE.issued)
    scaled, _ = client.call("set_device", {"device_id": fake_tuya.AC, "properties": {"temp_value": 22.5}})
    check(scaled.get("ok") is True, "a scaled write succeeds")
    check(len(fake_tuya.STATE.issued) == before + 1, "the scaled write was sent once")
    raw_sent = json.loads(fake_tuya.STATE.issued[-1]["properties"])
    check(raw_sent.get("temp_value") == 225, "22.5 with scale 1 is sent as the raw integer 225, got %r"
          % (raw_sent.get("temp_value"),))
    check(scaled.get("applied", {}).get("temp_value") == 22.5, "the reply reports the human value, not the raw one")

    # 5. rename
    renamed, _ = client.call("rename_device", {"device_id": fake_tuya.LIGHT, "name": "Kitchen light"})
    check(renamed.get("ok") is True, "rename_device works")
    check(fake_tuya.STATE.renamed and fake_tuya.STATE.renamed[-1]["name"] == "Kitchen light",
          "the new name reached the API")

    empty_name, _ = client.call("rename_device", {"device_id": fake_tuya.LIGHT, "name": "   "})
    check(empty_name.get("errorCode") == "INVALID_VALUE", "an empty name is refused")

    unknown = client.request("tools/call", {"name": "no_such_tool", "arguments": {}})
    check((unknown.get("result") or {}).get("isError") is True,
          "an unknown tool is refused, not crashed on")

    client.close()

    # 6. a refused key is reported as auth, and names the data centre
    no_key = Client({"TUYA_BASE": base}, expect_failure=True)
    code = no_key.proc.wait(timeout=10)
    stderr = no_key.proc.stderr.read()
    check(code == 1, "the server exits when the key is missing")
    check("TUYA_API_KEY" in stderr, "it says which variable is missing")
    no_key.close()

    # 7. a dead endpoint is a network failure, never a rejected key
    dead = socket.socket()
    dead.bind(("127.0.0.1", 0))
    dead_port = dead.getsockname()[1]
    dead.close()

    offline = Client({"TUYA_API_KEY": "sk-test", "TUYA_BASE": "http://127.0.0.1:%d" % dead_port})
    offline_status, _ = offline.call("tuya_status")
    check(offline_status.get("errorCode") == "NETWORK", "a dead endpoint is NETWORK, got %s" % offline_status.get("errorCode"))
    check("key" not in offline_status.get("message", "").lower(), "the network message does not blame the key")
    offline.close()

    srv.shutdown()

    print("")
    if FAILURES:
        print("%d check(s) failed" % len(FAILURES))
        return 1
    print("all MCP checks passed")
    return 0


def test_end_to_end():
    """pytest entry point: the whole contract runs as one test."""
    assert main() == 0


if __name__ == "__main__":
    sys.exit(main())
