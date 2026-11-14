#!/usr/bin/env python3
"""Four-singer load test on the real Fire TV Cube.

Starts N headless Chrome "phones" on the server machine, each running the real
/m page with a fake microphone (a WebAudio tone at its own pitch), joins them
to slots 1..N, plays an analysed song on the Cube with all N as players, and
samples the Cube while they sing: CPU and memory of the FireSong app, each
slot's level, clip video frames dropped, and whether playback keeps real time.
At the end it reads each player's detected pitch on the TV.

    cube-load-test.py --song <file hash> [--phones 4] [--seconds 90] [--gain 0.05]

Needs: firesong.service with the phone door on 127.0.0.1:64449, the Cube's
serial in FIRESONG_CUBE_SERIAL (or ~/.config/firesong/firesong.env), Google
Chrome, the websocket-client package, and the TV idle (launcher or asleep, with
nothing playing). The tones and the song come out of the TV speakers.
Restores the Cube: the app's URL, HOME, and sleep if it was asleep.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import websocket

REPO = pathlib.Path(__file__).resolve().parents[2]
ENV_FILE = pathlib.Path(os.environ.get("FIRESONG_ENV_FILE", pathlib.Path.home() / ".config/firesong/firesong.env"))
ADB = os.environ.get("ADB", str(pathlib.Path.home() / "Android/Sdk/platform-tools/adb"))
CHROME = os.environ.get("FIRESONG_CHROME", "/usr/bin/google-chrome")
TV_CDP = 64466
PHONE_CDP_BASE = 9611
PITCHES = (220.0, 330.0, 440.0, 550.0)
COLORS = ("rose", "fuchsia", "amber", "emerald")

FAKE_MIC = r"""
(() => {
  if (window.__loadMic) return 'already';
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator(), level = ctx.createGain();
  osc.frequency.value = %(hz)s; level.gain.value = %(gain)s;
  osc.connect(level).connect(dest); osc.start();
  const media = navigator.mediaDevices, real = media.getUserMedia.bind(media);
  media.getUserMedia = async (c) => c && c.audio
    ? (await ctx.resume(), new MediaStream([dest.stream.getAudioTracks()[0].clone()]))
    : real(c);
  window.__loadMic = { ctx, osc };
  return 'installed';
})()
"""


def env_value(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    try:
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1]
    except OSError:
        pass
    return None


class Cdp:
    def __init__(self, port: int):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5) as r:
            pages = [t for t in json.load(r) if t.get("type") == "page"]
        self.ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
        self.n = 0

    def call(self, method: str, params: dict | None = None) -> dict:
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                return msg.get("result", {})

    def eval(self, expr: str):
        res = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                             "awaitPromise": True, "userGesture": True})
        if "exceptionDetails" in res:
            raise RuntimeError(str(res["exceptionDetails"])[:300])
        return res.get("result", {}).get("value")

    def tap(self, element_expr: str) -> None:
        rect = self.eval(f"(() => {{ const el = {element_expr}; if (!el) return null;"
                         " const r = el.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()")
        if not rect:
            raise RuntimeError(f"nothing to tap: {element_expr}")
        for kind in ("mousePressed", "mouseReleased"):
            self.call("Input.dispatchMouseEvent", {"type": kind, "x": rect["x"], "y": rect["y"], "button": "left", "clickCount": 1})


class Cube:
    def __init__(self, serial: str):
        self.serial = serial

    def sh(self, command: str, timeout: int = 30) -> str:
        return subprocess.run([ADB, "-s", self.serial, "shell", command], capture_output=True, text=True, timeout=timeout).stdout

    def wakefulness(self) -> str:
        m = re.search(r"mWakefulness=(\w+)", self.sh("dumpsys power"))
        return m.group(1) if m else "?"

    def resumed(self) -> str:
        m = re.search(r"mResumedActivity: ActivityRecord\{\S+ \S+ (\S+) ", self.sh("dumpsys activity activities"))
        return m.group(1) if m else ""

    def playing(self) -> int:
        return self.sh("dumpsys media_session").count("state=3")

    def cpu_and_mem(self) -> dict:
        top = self.sh("top -b -n 1 -o PID,USER,%CPU,RES,ARGS 2>/dev/null")
        cpu = {"app": 0.0, "webview": 0.0}
        for line in top.splitlines():
            parts = line.split(None, 4)
            if len(parts) < 5:
                continue
            try:
                pct = float(parts[2])
            except ValueError:
                continue
            if parts[4].startswith("org.firesong.tv"):
                cpu["app"] += pct
            elif "sandboxed_process" in parts[4] or "webview" in parts[4]:
                cpu["webview"] += pct
        mem = self.sh("dumpsys meminfo org.firesong.tv")
        m = re.search(r"TOTAL(?: PSS)?:?\s+(\d+)", mem)
        avail = re.search(r"MemAvailable:\s+(\d+)", self.sh("cat /proc/meminfo"))
        return {"cpu": cpu, "pss_mb": int(m.group(1)) // 1024 if m else None,
                "mem_available_mb": int(avail.group(1)) // 1024 if avail else None}


def cmd(name: str, body: dict | None = None):
    token = (pathlib.Path(env_value("NIGHTINGALE_DATA_PATH") or "/mnt/fast/firesong/data") / "firesong/host-token").read_text().strip()
    req = urllib.request.Request(f"http://127.0.0.1:64448/api/cmd/{name}", data=json.dumps(body or {}).encode(),
                                 headers={"x-firesong-host-token": token, "content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def pairing_token() -> str:
    data = json.loads((pathlib.Path(env_value("NIGHTINGALE_DATA_PATH") or "/mnt/fast/firesong/data") / "remote-control.json").read_text())
    if isinstance(data.get("token"), str):
        return data["token"]
    return next(v for v in data.values() if isinstance(v, str) and re.fullmatch(r"[0-9a-f]{32}", v))


def wait_for(what: str, fn, timeout: float, every: float = 1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(every)
    raise RuntimeError(f"timed out waiting for {what}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--song", required=True, help="file hash of an analysed song")
    ap.add_argument("--phones", type=int, default=4, choices=range(1, 5))
    ap.add_argument("--seconds", type=int, default=90)
    ap.add_argument("--gain", type=float, default=0.05, help="tone amplitude (0.05 is about -26 dBFS)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    serial = env_value("FIRESONG_CUBE_SERIAL")
    os.environ["FIRESONG_CUBE_SERIAL"] = serial or ""
    lan_url = f"https://{env_value('FIRESONG_LAN_IP')}:{env_value('FIRESONG_TV_PORT') or 64443}/?tv=1&mode=noraebang"
    out = pathlib.Path(args.out or f"/mnt/fast/firesong/artifacts/cube-load-{time.strftime('%Y%m%dT%H%M%S')}")
    out.mkdir(parents=True, exist_ok=True)
    cube = Cube(serial)
    report: dict = {"song": args.song, "phones": args.phones, "seconds": args.seconds, "samples": []}

    start = cube.wakefulness()
    front = cube.resumed()
    if cube.playing() or (front and not front.startswith("com.amazon.tv.launcher/")):
        print(f"ABORT: TV busy ({front}, playing={cube.playing()})")
        return 2
    chromes: list[subprocess.Popen] = []
    profiles: list[str] = []
    try:
        cube.sh("input keyevent KEYCODE_WAKEUP")
        time.sleep(3)
        subprocess.run(["bash", str(REPO / "scripts/firesong/cube.sh"), "launch", "--url", lan_url + "&fsdiag=1",
                        "--host-token-file", str(pathlib.Path(env_value("NIGHTINGALE_DATA_PATH") or "/mnt/fast/firesong/data") / "firesong/host-token")],
                       capture_output=True, timeout=60)
        time.sleep(15)
        subprocess.run([str(REPO / "tools/tvctl"), "devtools", str(TV_CDP)], capture_output=True, timeout=30)
        tv = Cdp(TV_CDP)
        wait_for("TV diagnostics", lambda: tv.eval("!!(window.fireSongDiag && fireSongDiag.snapshot().connected)"), 40)

        token = pairing_token()
        phones: list[Cdp] = []
        for i in range(args.phones):
            profile = tempfile.mkdtemp(prefix=f"fs-load-phone{i + 1}-", dir=str(out))
            profiles.append(profile)
            chromes.append(subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PHONE_CDP_BASE + i}",
                                             f"--user-data-dir={profile}", "--use-fake-ui-for-media-stream",
                                             "--autoplay-policy=no-user-gesture-required", "--mute-audio",
                                             "--window-size=390,844", "about:blank"],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(3)
        for i in range(args.phones):
            phone = Cdp(PHONE_CDP_BASE + i)
            phone.call("Page.navigate", {"url": f"http://127.0.0.1:64449/m?t={token}&slot={i + 1}"})
            time.sleep(4)
            phone.eval(FAKE_MIC % {"hz": PITCHES[i], "gain": args.gain})
            phone.tap('document.querySelector("input")')
            phone.call("Input.insertText", {"text": f"Load {i + 1}"})
            phone.tap('document.querySelector("button[type=submit]")')
            phones.append(phone)
        devices = wait_for(f"{args.phones} phones on the TV",
                           lambda: (lambda d: d if len(d) >= args.phones and not any(x["reconnecting"] for x in d) else None)(
                               tv.eval("fireSongDiag.snapshot().devices")), 40)
        report["devices"] = devices
        by_slot = {d["slot"]: d["id"] for d in devices}
        for i in range(args.phones):
            tv.eval(f"fireSongDiag.watchPitch('p{i + 1}')")
        cmd("add_playback_queue_entry", {"fileHash": args.song, "tempo": 1.0, "keyOffset": 0})
        cmd("request_queue_playback", {"players": [
            {"id": f"p{i + 1}", "profile": None, "microphoneId": by_slot[i + 1], "color": COLORS[i]}
            for i in range(args.phones)]})
        wait_for("playback", lambda: cmd("load_playback_progress").get("playing"), 40)
        t0, p0 = time.time(), cmd("load_playback_progress")["positionMs"]
        while time.time() - t0 < args.seconds:
            time.sleep(5)
            sample = {"t": round(time.time() - t0, 1), "position_ms": cmd("load_playback_progress")["positionMs"]}
            sample.update(cube.cpu_and_mem())
            sample["slots"] = tv.eval("[1,2,3,4].map(s => { const x = fireSongDiag.slotStatus(s); return x ? {attached: x.attached, rms: +x.levelRms.toFixed(3)} : null; })")
            sample["video"] = tv.eval("[...document.querySelectorAll('video')].filter(v => !v.paused).map(v => { const q = v.getVideoPlaybackQuality(); return {decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames}; })")
            sample["engine"] = tv.eval("fireSongDiag.engine().state")
            report["samples"].append(sample)
            print(json.dumps(sample), flush=True)
        elapsed = time.time() - t0
        played = (report["samples"][-1]["position_ms"] - p0) / 1000 if report["samples"] else 0
        report["realtime_ratio"] = round(played / elapsed, 3) if elapsed else None
        report["pitch"] = {}
        for i in range(args.phones):
            got = tv.eval(f"fireSongDiag.pitches('p{i + 1}')") or {}
            values = got.get("pitches") or []
            near = [v for v in values if abs(v - PITCHES[i]) <= 3]
            report["pitch"][f"p{i + 1}"] = {"want_hz": PITCHES[i], "frames": got.get("frames"), "voiced": got.get("voiced"),
                                            "median": statistics.median(values) if values else None,
                                            "within_3hz": round(len(near) / len(values), 3) if values else 0}
        shot = tv.call("Page.captureScreenshot", {"format": "png"}).get("data")
        if shot:
            (out / "tv-during-song.png").write_bytes(base64.b64decode(shot))
        cmd("request_playback_command", {"command": "exit"})
        time.sleep(3)
    finally:
        for proc in chromes:
            proc.terminate()
        for proc in chromes:
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        for profile in profiles:
            shutil.rmtree(profile, ignore_errors=True)
        subprocess.run([str(REPO / "tools/tvctl"), "home"], capture_output=True, timeout=30)
        subprocess.run([str(REPO / "tools/tvctl"), "undevtools", str(TV_CDP)], capture_output=True, timeout=30)
        time.sleep(2)
        subprocess.run([str(REPO / "tools/tvctl"), "configure", "--url", lan_url, "--token-file",
                        str(pathlib.Path(env_value("NIGHTINGALE_DATA_PATH") or "/mnt/fast/firesong/data") / "firesong/host-token")],
                       capture_output=True, timeout=60)
        time.sleep(3)
        subprocess.run([str(REPO / "tools/tvctl"), "home"], capture_output=True, timeout=30)
        subprocess.run([str(REPO / "tools/tvctl"), "stop"], capture_output=True, timeout=30)
        if start in ("Asleep", "Dozing"):
            for _ in range(3):
                cube.sh("input keyevent KEYCODE_SLEEP")
                time.sleep(6)
                if cube.wakefulness() == "Asleep":
                    break
        report["cube_after"] = cube.wakefulness()
        (out / "report.json").write_text(json.dumps(report, indent=1))
        print(f"report: {out / 'report.json'}")
    ok = report.get("realtime_ratio", 0) and report["realtime_ratio"] > 0.97 and all(
        p["within_3hz"] >= 0.9 for p in report.get("pitch", {}).values())
    print("RESULT", "PASS" if ok else "CHECK", json.dumps({"realtime_ratio": report.get("realtime_ratio"),
                                                           "pitch": report.get("pitch")}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
