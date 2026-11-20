#!/usr/bin/env python3
"""A tiny fake Tuya end-user API, for tests only.

It speaks just enough of the real shapes to exercise tuya_mcp.py: homes, rooms,
devices, detail, model, property issue and rename. Two behaviours are on
purpose: the first write of a session is answered with Tuya's burst-cap
message (to prove the retry works), and a wrong or missing bearer token gets
code 1010 (to prove auth failures are not mistaken for network ones).

Run standalone:  python3 fake_tuya.py [port]
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

LIGHT = "bf-light-0001"
AC = "bf-ac-000002"

LIGHT_MODEL = {
    "modelId": "light-model",
    "services": [{
        "properties": [
            {"code": "switch_led", "accessMode": "rw", "typeSpec": {"type": "bool"}},
            {"code": "bright_value", "accessMode": "rw", "typeSpec": {"type": "value", "min": 10, "max": 1000, "scale": 0, "step": 1}},
            {"code": "work_mode", "accessMode": "rw", "typeSpec": {"type": "enum", "range": ["white", "colour"]}},
            {"code": "status_only", "accessMode": "ro", "typeSpec": {"type": "bool"}},
        ]
    }],
}

AC_MODEL = {
    "modelId": "ac-model",
    "services": [{
        "properties": [
            {"code": "switch", "accessMode": "rw", "typeSpec": {"type": "bool"}},
            {"code": "temp_value", "accessMode": "rw", "typeSpec": {"type": "value", "min": 160, "max": 300, "scale": 1, "unit": "°C"}},
        ]
    }],
}

BURST = "同时进行的网络请求已达上限(4),请等在途请求返回"


class State:
    def __init__(self):
        self.requests = []
        self.issued = []
        self.renamed = []
        self.light_switch = True
        self.burst_used = False
        self.lock = threading.Lock()

    def reset_burst(self):
        """Make the next write hit the burst cap, whatever ran before it."""
        self.burst_used = False

    def note(self, method, path, body, auth):
        with self.lock:
            self.requests.append({"method": method, "path": path, "body": body, "auth": auth})


STATE = State()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _reply(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _ok(self, result):
        self._reply({"success": True, "result": result})

    def _fail(self, code, msg, status=200):
        self._reply({"success": False, "code": code, "msg": msg}, status)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return None
        raw = self.rfile.read(length).decode("utf-8")
        try:
            return json.loads(raw)
        except ValueError:
            return raw

    def _authorised(self):
        auth = self.headers.get("Authorization") or ""
        return auth.startswith("Bearer sk-")

    def _route(self, method):
        path = self.path.split("?")[0]
        body = self._body()
        STATE.note(method, path, body, self.headers.get("Authorization"))

        if not self._authorised():
            self._fail(1010, "token invalid")
            return

        base = "/v1.0/end-user"

        if path == base + "/homes/all":
            self._ok({"homes": [{"home_id": "h1", "name": "Test Home"}]})
        elif path == base + "/homes/h1/rooms":
            self._ok({"rooms": [{"room_id": "r1", "name": "Living Room"},
                                {"room_id": "r2", "name": "Bedroom"}]})
        elif path == base + "/homes/h1/devices":
            self._ok({"devices": [
                {"device_id": LIGHT, "name": "Ceiling Light", "category_name": "Light Source",
                 "online": True, "room_id": "r1"},
                {"device_id": AC, "name": "Bedroom AC", "category_name": "Air Conditioner",
                 "online": False, "room_id": "r2"},
            ]})
        elif path == base + "/devices/all":
            self._ok({"devices": []})
        elif path == base + "/devices/%s/detail" % LIGHT:
            self._ok({"device_id": LIGHT, "name": "Ceiling Light", "online": True,
                      "category_name": "Light Source",
                      "properties": {"switch_led": STATE.light_switch, "bright_value": 500, "work_mode": "white"}})
        elif path == base + "/devices/%s/detail" % AC:
            self._ok({"device_id": AC, "name": "Bedroom AC", "online": False,
                      "category_name": "Air Conditioner",
                      "properties": {"switch": True, "temp_value": 220}})
        elif path == base + "/devices/%s/model" % LIGHT:
            self._ok({"model": json.dumps(LIGHT_MODEL)})
        elif path == base + "/devices/%s/model" % AC:
            self._ok({"model": json.dumps(AC_MODEL)})
        elif path == base + "/devices/%s/shadow/properties/issue" % LIGHT:
            if not STATE.burst_used:
                STATE.burst_used = True
                self._fail(900, BURST)
                return
            STATE.issued.append(body)
            try:
                applied = json.loads((body or {}).get("properties") or "{}")
            except (ValueError, AttributeError):
                applied = {}
            if isinstance(applied, dict) and "switch_led" in applied:
                STATE.light_switch = bool(applied["switch_led"])
            self._ok({"accepted": applied})
        elif path == base + "/devices/%s/shadow/properties/issue" % AC:
            STATE.issued.append(body)
            try:
                applied = json.loads((body or {}).get("properties") or "{}")
            except (ValueError, AttributeError):
                applied = {}
            self._ok({"accepted": applied})
        elif path == base + "/devices/%s/attribute" % LIGHT:
            STATE.renamed.append(body)
            self._ok({"renamed": (body or {}).get("name")})
        else:
            self._fail(1108, "uri path invalid")

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")


def start(port=0):
    """Start the fake cloud in a background thread. Returns (server, port)."""
    server = HTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


if __name__ == "__main__":
    wanted = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srv, chosen = start(wanted)
    print("fake Tuya listening on http://127.0.0.1:%d" % chosen)
    print('try: TUYA_API_KEY=sk-test TUYA_BASE=http://127.0.0.1:%d python3 tuya_mcp.py' % chosen)
    try:
        while True:
            threading.Event().wait(1)
    except KeyboardInterrupt:
        srv.shutdown()
