#!/usr/bin/env python3
"""Tiny Chrome DevTools Protocol client for the Cube's WebView (after
`tools/tvctl devtools PORT`; set CDP_PORT=PORT, default 9222).

    python3 cdp.py eval  'JS expression'     # prints the JSON value
    python3 cdp.py crash                     # Page.crash (renderer-loss test)
    python3 cdp.py version                   # Browser version string
    python3 cdp.py shot OUT.png              # Page.captureScreenshot (adb screencap
                                             # is all black while the WebView shows)

Needs the websocket-client package.
"""
import base64
import json
import os
import sys
import urllib.request

import websocket  # websocket-client

BASE = "http://127.0.0.1:" + os.environ.get("CDP_PORT", "9222")


def page_ws() -> str:
    with urllib.request.urlopen(BASE + "/json", timeout=5) as r:
        targets = json.load(r)
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target")
    return pages[0]["webSocketDebuggerUrl"]


def call(ws, method, params=None, _id=[0]):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            return msg


def main() -> None:
    cmd = sys.argv[1]
    if cmd == "version":
        with urllib.request.urlopen(BASE + "/json/version", timeout=5) as r:
            print(json.dumps(json.load(r)))
        return
    ws = websocket.create_connection(page_ws(), timeout=10, suppress_origin=True)
    try:
        if cmd == "eval":
            res = call(ws, "Runtime.evaluate", {"expression": sys.argv[2], "returnByValue": True, "awaitPromise": True})
            print(json.dumps(res.get("result", {}).get("result", {}).get("value", res)))
        elif cmd == "shot":
            res = call(ws, "Page.captureScreenshot", {"format": "png"})
            data = base64.b64decode(res["result"]["data"])
            with open(sys.argv[2], "wb") as f:
                f.write(data)
            print(f"wrote {sys.argv[2]} ({len(data)} bytes)")
        elif cmd == "crash":
            ws.send(json.dumps({"id": 1, "method": "Page.crash", "params": {}}))
            print("crash sent")
        else:
            raise SystemExit("unknown command " + cmd)
    finally:
        try:
            ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
