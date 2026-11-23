#!/usr/bin/env python3
"""Four-singer load test on the real Fire TV Cube, with the voices played by the page or the app.

Starts N headless Chrome "phones" on the server machine, each running the real
/m page with a fake microphone (a sawtooth at its own pitch, between the notes of
the scale: a lone sine looks like a howl to the TV's feedback guard), joins them
to slots 1..N, plays an analysed song on the Cube with all N as players, and
samples the Cube while they sing: CPU of the FireSong app and of the WebView
renderer every tick (about 2 s), MemAvailable, the app's PSS, Native Heap and
.so mmap at every 30 s of song position, each slot's level, clip video frames
dropped, and whether playback keeps real time. It reads each player's detected
pitch on the TV throughout (the scoring sanity check: within 3 Hz of its tone in
90 % of voiced windows).

--voice native opens the TV page with &voice=native, so the FireSong TV app
receives and plays the phones itself. The rig then also records the voice door
between the page and the app (engine-stats, peer-stats, slot status, tap
delivery) and reports, per slot, the Cube-side electrical latency: network
transit (RTT/2) + jitter buffer (after a 60 s warm-up, with its target) +
push-to-present, as well as push intervals, callback times, underruns, xruns,
trims, headroom and tap steadiness, each against its pass limit.

--ab plays the same song with the same phones on web and then on native (or
native first with --native-first), each in a freshly started app process, and
compares per-process CPU medians, Native Heap and .so mmap PSS at matched song
positions, and the MemAvailable minimum. Every phase also checks that the app
process survived, and its trim-memory warnings, low-memory kills and crash log
lines. --fallback drops the native link (fireSongDiag.dropNativeLink) or reloads
the TV page mid-song and times how long until every phone is heard again with
its pitch reaching the scorer.

Tail limits (a p99 or p95 at most so much) are judged from the app's per-second
quantiles: PASS when the whole run provably keeps the limit, FAIL when it
provably does not or the median second breaks it, INCONCLUSIVE in between
(the last line then lists those checks as well as the failures).

    cube-load-test.py --song <file hash> [--phones 4] [--seconds 90] [--gain 0.05]
                      [--voice web|native | --ab [--native-first]] [--fallback drop|reload [--fallback-at SECS]]
                      [--warmup 60] [--restore-flags '&voice=native'] [--out DIR]
    cube-load-test.py --analyze <report.json> [--warmup 60]

Needs: firesong.service with the phone door on 127.0.0.1:64449, the Cube's
serial in FIRESONG_CUBE_SERIAL (or ~/.config/firesong/firesong.env), Google
Chrome, the websocket-client package, and the TV idle (launcher or asleep, with
nothing playing). The tones and the song come out of the TV speakers at the
normal volume (the headroom check needs the song's real level).
Restores the Cube: the app's URL (with the flags of --restore-flags or
FIRESONG_TV_URL_FLAGS, so a TV on the native voices stays on them), HOME, and
sleep if it was asleep. Times recorded on the TV page are moved to the host's
clock, so a Cube whose clock is off does not shift them against the song.
"""
from __future__ import annotations

import argparse
import base64
import bisect
import json
import math
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

REPO = pathlib.Path(__file__).resolve().parents[2]
ENV_FILE = pathlib.Path(os.environ.get("FIRESONG_ENV_FILE", pathlib.Path.home() / ".config/firesong/firesong.env"))
ADB = os.environ.get("ADB", str(pathlib.Path.home() / "Android/Sdk/platform-tools/adb"))
CHROME = os.environ.get("FIRESONG_CHROME", "/usr/bin/google-chrome")
TV_CDP = 64466
PHONE_CDP_BASE = 9611
# Quarter tones (between the notes of the scale), no tone twice or three times another.
PITCHES = (226.6, 254.2, 285.3, 320.2)
COLORS = ("rose", "fuchsia", "amber", "emerald")
NATIVE_FLAG = "&voice=native"
APP = "org.firesong.tv"

TICK_S = 2.0
MEM_EVERY_MS = 30_000
WARMUP_S = 60
PITCH_TOL_HZ = 3.0
PITCH_PASS_SHARE = 0.9
HEARD_OUT_DB = -45.0
RECOVERY_LIMIT_S = {"drop": 12.0, "reload": 10.0}
# A one-second trim this large is a ceiling jump, not drift (engine-stats has no jump counter).
JUMP_MS = 30.0
TAP_HIST_CAP_MS = 200
# Phone capture and Opus encode, and the TV's own processing: the hops the rig cannot see.
UNSEEN_MS = 32 + 20
# Underruns while a newly attached slot primes, and trims while its buffer settles, are expected.
UNDERRUN_GRACE_MS = 2000
JUMP_GRACE_MS = 10_000
# A slot unseen in the record for this long may have detached and attached again in between.
GAP_MS = 3000
# A check whose data can neither prove nor rule out its limit (see tail_check).
INCONCLUSIVE = "inconclusive"
URL_FLAGS = r"(&[A-Za-z0-9_]+=[A-Za-z0-9_.-]*)*"

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
# The load test's phones: a sawtooth has a voice's harmonics.
LOAD_MIC = FAKE_MIC.replace("osc.frequency.value =", "osc.type = 'sawtooth'; osc.frequency.value =")

# Installed on the TV page before its scripts run. It records the voice door
# (the loopback WebSocket to the TV app): every app message except ICE and the
# SDP, the page's own messages without SDP, candidates, ICE servers or mic ids,
# the slot status at 1 Hz (and at once when a slot attaches or detaches), and
# the binary tap messages' arrival intervals and per-slot sequence gaps. Every
# event names its socket, unique per page load (the page numbers its peers per
# load, so a reload reuses peer ids). It also counts the renderer's long tasks.
DOOR_JS = r"""
(() => {
  if (window.__door) return;
  const freshTap = () => ({ msgs: 0, blocks: 0, zero: 0, bad: 0, missing: {}, resets: {}, perSlot: {}, iv: [] });
  const load = Math.round(performance.timeOrigin || Date.now()).toString(36) + Math.random().toString(36).slice(2, 6);
  const door = window.__door = {
    events: [], sockets: 0, state: 'none', last: {}, tap: freshTap(), long: { n: 0, ms: 0, max: 0 }, ice: 0, load,
  };
  const seqs = {};
  const tapping = new Set();
  let lastArrival = null;
  let lastStatus = 0;
  let lastAttached = '';
  const keep = (sock, dir, m) => {
    door.events.push({ t: Date.now(), dir, sock, m });
    if (door.events.length > 20000) door.events.splice(0, 5000);
  };
  const HIDDEN = new Set(['sdp', 'candidate', 'iceServers', 'micId']);
  const slim = (m) => {
    const out = {};
    for (const [k, v] of Object.entries(m)) if (!HIDDEN.has(k)) out[k] = v;
    return out;
  };
  const onText = (sock, dir, data) => {
    let m;
    try { m = JSON.parse(data); } catch (e) { keep(sock, dir, { t: '?', bytes: String(data).length }); return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ice') { door.ice += 1; return; }
    // Arrivals are timed only while some slot is tapped; a release ends a slot's tap as tap off does.
    if (dir === 'out' && (m.t === 'tap' || m.t === 'release')) {
      const before = tapping.size;
      if (m.t === 'tap' && m.on) tapping.add(m.slot); else tapping.delete(m.slot);
      if (tapping.size === 0 || before === 0) lastArrival = null;
    }
    if (dir === 'in') {
      if (m.t === 'ready') door.state = m.ok ? 'ready' : 'refused';
      if (m.t === 'status') {
        const now = Date.now();
        door.last.status = { t: now, slots: m.slots };
        const attached = (Array.isArray(m.slots) ? m.slots : [])
          .map((x) => `${x && x.slot}:${x && x.attached ? 1 : 0}`).join(',');
        if (now - lastStatus < 950 && attached === lastAttached) return;
        lastStatus = now;
        lastAttached = attached;
      }
    }
    keep(sock, dir, slim(m));
  };
  const onBinary = (data) => {
    const tap = door.tap;
    const now = performance.now();
    if (lastArrival !== null) tap.iv.push(Math.round((now - lastArrival) * 10) / 10);
    lastArrival = now;
    tap.msgs += 1;
    if (tap.iv.length > 50000) tap.iv.splice(0, 10000);
    const v = new DataView(data);
    if (data.byteLength < 4 || v.getUint8(0) !== 1 || v.getUint8(1) !== 1) { tap.bad += 1; return; }
    const count = v.getUint16(2, true);
    if (data.byteLength !== 4 + count * 2056) { tap.bad += 1; return; }
    for (let i = 0; i < count; i += 1) {
      const o = 4 + i * 2056;
      const slot = v.getUint8(o), flags = v.getUint8(o + 1), seq = v.getUint32(o + 4, true);
      tap.blocks += 1;
      tap.perSlot[slot] = (tap.perSlot[slot] || 0) + 1;
      if (flags & 1) tap.zero += 1;
      const prev = seqs[slot];
      if (prev !== undefined) {
        if (seq > prev + 1) tap.missing[slot] = (tap.missing[slot] || 0) + (seq - prev - 1);
        else if (seq <= prev) tap.resets[slot] = (tap.resets[slot] || 0) + 1;
      }
      seqs[slot] = seq;
    }
  };
  const Native = window.WebSocket;
  class RigDoorSocket extends Native {
    constructor(...args) {
      super(...args);
      let url = null;
      try { url = new URL(String(args[0])); } catch (e) { url = null; }
      if (!url || url.hostname !== '127.0.0.1' || url.pathname !== '/voice') return;
      door.sockets += 1;
      const id = door.sockets;
      const sock = `${load}.${id}`;
      this.__rigDoor = sock;
      door.state = 'connecting';
      lastStatus = 0;
      lastAttached = '';
      keep(sock, 'sock', { ev: 'connect', id });
      this.addEventListener('open', () => { door.state = 'open'; keep(sock, 'sock', { ev: 'open', id }); });
      this.addEventListener('error', () => keep(sock, 'sock', { ev: 'error', id }));
      this.addEventListener('close', (e) => {
        if (door.sockets === id) door.state = 'closed';
        lastArrival = null;
        tapping.clear();
        keep(sock, 'sock', { ev: 'close', id, code: e.code, clean: e.wasClean });
      });
      this.addEventListener('message', (e) => {
        if (typeof e.data === 'string') onText(sock, 'in', e.data);
        else if (e.data instanceof ArrayBuffer) onBinary(e.data);
      });
    }
    send(data) {
      if (this.__rigDoor && typeof data === 'string') onText(this.__rigDoor, 'out', data);
      return super.send(data);
    }
  }
  window.WebSocket = RigDoorSocket;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        door.long.n += 1;
        door.long.ms += e.duration;
        door.long.max = Math.max(door.long.max, e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { door.long.unsupported = true; }
  door.take = () => {
    const out = { events: door.events.splice(0), tap: door.tap, long: door.long, ice: door.ice };
    door.tap = freshTap();
    door.long = { n: 0, ms: 0, max: 0 };
    door.ice = 0;
    return out;
  };
})();
"""

# One sample of the TV page: reads the diagnostics (pitch of each watched
# capture, rack status, backend, stage), each call guarded so one failing
# reader costs only its own field, then drains the door recorder last, so
# nothing drained is lost to an exception. Called with the capture ids to
# watch; watching is idempotent and survives a page reload.
TICK_JS = r"""
((ids) => {
  const d = window.fireSongDiag;
  if (!d) return null;
  const errors = [];
  const read = (name, f, fallback) => {
    try { const v = f(); return v === undefined ? fallback : v; }
    catch (e) { errors.push(`${name}: ${String(e).slice(0, 120)}`); return fallback; }
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
  const pitch = {};
  for (const id of ids) {
    const p = read('pitches', () => { d.watchPitch(id); return d.pitches(id); }, null);
    if (p) pitch[id] = { frames: p.frames, voiced: p.voiced, tail: Array.isArray(p.pitches) ? p.pitches.slice(-120) : [] };
  }
  const slots = [1, 2, 3, 4].map((s) => {
    const x = read('slotStatus', () => d.slotStatus(s), null);
    return x ? { slot: s, attached: !!x.attached, monitored: !!x.monitored, muted: !!x.muted,
                 gateOpen: !!x.gateOpen, levelRms: num(x.levelRms) } : null;
  });
  const backend = read('voiceBackend', () => (typeof d.voiceBackend === 'function' ? d.voiceBackend() : null), null);
  const stage = read('stage', () => d.stage(), null);
  const snap = read('snapshot', () => d.snapshot(), null);
  const engine = read('engine', () => d.engine(), null);
  const video = read('video', () => [...document.querySelectorAll('video')].filter((v) => !v.paused).map((v) => {
    const q = v.getVideoPlaybackQuality();
    return { decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames };
  }), []);
  const door = window.__door;
  return {
    pitch, slots, backend, stage, connected: snap ? !!snap.connected : null, engine: engine ? engine.state : null,
    video, errors, door: door ? { ...door.take(), state: door.state, last: door.last, load: door.load } : null,
  };
})
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


def data_path() -> pathlib.Path:
    return pathlib.Path(env_value("NIGHTINGALE_DATA_PATH") or "/mnt/fast/firesong/data")


def restore_flags(given: str | None = None) -> str:
    """The URL flags FireSong on the Cube runs with outside the rig, put back on restore.

    From --restore-flags, else FIRESONG_TV_URL_FLAGS (environment or firesong.env), e.g.
    `&voice=native` once the native voices are rolled out; none by default.
    """
    flags = given if given is not None else (env_value("FIRESONG_TV_URL_FLAGS") or "")
    if not re.fullmatch(URL_FLAGS, flags):
        raise SystemExit(f"URL flags must be &name=value pairs, not {flags!r}")
    return flags


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

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass


def parse_top(text: str) -> dict:
    """Percent of one core per process group from `top -b -o PID,USER,%CPU,RES,ARGS`; None without a process table."""
    if "PID" not in text:
        return {"app": None, "webview": None}
    cpu = {"app": 0.0, "webview": 0.0}
    for line in text.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            pct = float(parts[2])
        except ValueError:
            continue
        if "sandboxed_process" in parts[4] or "webview" in parts[4]:
            cpu["webview"] += pct
        elif parts[4].startswith(APP):
            cpu["app"] += pct
    return cpu


def parse_meminfo(text: str) -> dict:
    """PSS of `dumpsys meminfo <package>`: the TOTAL in whole MB, Native Heap and .so mmap in MB."""
    def row(name: str) -> float | None:
        m = re.search(rf"^\s*{re.escape(name)}\s+(\d+)\s", text, re.M)
        return round(int(m.group(1)) / 1024, 1) if m else None

    total = re.search(r"TOTAL(?: PSS)?:?\s+(\d+)", text)
    return {"pss_mb": int(total.group(1)) // 1024 if total else None,
            "native_heap_mb": row("Native Heap"), "so_mmap_mb": row(".so mmap")}


def mem_available_mb(text: str) -> int | None:
    m = re.search(r"MemAvailable:\s+(\d+)", text)
    return int(m.group(1)) // 1024 if m else None


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

    def load(self) -> dict:
        """CPU per process group and MemAvailable, in one adb call."""
        text = self.sh("top -b -n 1 -o PID,USER,%CPU,RES,ARGS 2>/dev/null; echo @@meminfo@@; cat /proc/meminfo")
        top, _, meminfo = text.partition("@@meminfo@@")
        return {"cpu": parse_top(top), "mem_available_mb": mem_available_mb(meminfo)}

    def meminfo(self) -> dict:
        return parse_meminfo(self.sh(f"dumpsys meminfo {APP}"))

    def cpu_and_mem(self) -> dict:
        return {**self.load(), **self.meminfo()}

    def clock(self) -> str:
        """The Cube's time in logcat's -t format."""
        return self.sh("date +'%m-%d %H:%M:%S.000'").strip()

    def pids(self) -> set[str]:
        return set(self.sh(f"pidof {APP}").split())

    def logs(self, since: str) -> tuple[str, str]:
        """The crash buffer, and the main, system and events buffers without the page's console, since `since`."""
        crash = self.sh(f"logcat -d -v threadtime -b crash -t '{since}'", timeout=60)
        main = self.sh(f"logcat -d -v threadtime -b main,system,events -t '{since}'"
                       " | grep -v -E ' (FireSongJS|chromium|cr_[A-Za-z_]+) *:'", timeout=120)
        return main, crash


def cmd(name: str, body: dict | None = None):
    token = (data_path() / "firesong/host-token").read_text().strip()
    req = urllib.request.Request(f"http://127.0.0.1:64448/api/cmd/{name}", data=json.dumps(body or {}).encode(),
                                 headers={"x-firesong-host-token": token, "content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def pairing_token() -> str:
    data = json.loads((data_path() / "remote-control.json").read_text())
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


def flight_rows(since_ms: int, until_ms: int, tv_offset_ms: float = 0.0) -> list[dict]:
    """Flight records between two host times.

    A TV row is placed by its own clock (`wall`, which stays right for rows the TV sent late),
    moved to the host's by `tv_offset_ms` (host minus TV, from PageClock).
    """
    rows = []
    for path in sorted((data_path() / "firesong/sessions").glob("*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            row["t"] = int(round(row["wall"] + tv_offset_ms)) if number(row.get("wall")) else int(row.get("t", 0))
            if since_ms <= row["t"] <= until_ms:
                rows.append(row)
    return sorted(rows, key=lambda r: r["t"])


def find_values(obj, key: str, depth: int = 0) -> list:
    """Every value stored under `key` in nested dicts and lists."""
    if depth > 6:
        return []
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                found.append(v)
            else:
                found.extend(find_values(v, key, depth + 1))
    elif isinstance(obj, list):
        for v in obj:
            found.extend(find_values(v, key, depth + 1))
    return found


# --- measurement --------------------------------------------------------------


def number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def quantile(values, q: float) -> float | None:
    xs = sorted(v for v in values if number(v))
    if not xs:
        return None
    pos = q * (len(xs) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def median(values) -> float | None:
    return quantile(values, 0.5)


def top_value(values) -> float | None:
    xs = [v for v in values if number(v)]
    return max(xs) if xs else None


def rnd(v, digits: int = 1):
    return None if v is None else round(v, digits)


class PageClock:
    """Host clock minus the TV page's clock (ms), to read the page's Date.now() stamps on the host's clock.

    Each sample reads the page's Date.now() over DevTools; the host time halfway through the round
    trip is the same instant to within half the round trip, so the shortest recent round trip wins.
    """

    def __init__(self) -> None:
        self.recent: list[tuple[float, float]] = []

    def sample(self, read_page_now) -> None:
        before = time.time() * 1000
        try:
            page = read_page_now()
        except (RuntimeError, OSError, websocket.WebSocketException):
            return
        after = time.time() * 1000
        if number(page):
            self.recent = (self.recent + [(after - before, (before + after) / 2 - page)])[-30:]

    def offset(self) -> float:
        return min(self.recent)[1] if self.recent else 0.0


def on_host_clock(events, offset: float) -> list[dict]:
    """The door recorder's events with their page-clock times moved to the host clock."""
    if not offset:
        return list(events)
    return [{**e, "t": int(round(e["t"] + offset))} if number(e.get("t")) else e for e in events]


def verdict_label(v) -> str:
    if v is True:
        return "PASS"
    if v is False:
        return "FAIL"
    return "n/a " if v is None else "INCONCLUSIVE"


def all_of(*verdicts):
    """One verdict over several limits: any FAIL fails; else an inconclusive or unjudged part leaves it so."""
    if any(v is False for v in verdicts):
        return False
    if any(v == INCONCLUSIVE for v in verdicts):
        return INCONCLUSIVE
    return None if any(v is None for v in verdicts) else True


def tail_check(windows: list[dict], limit: float, q: float) -> tuple:
    """Whether the whole run's q-quantile is within `limit`, from per-second quantiles.

    Each window is one engine-stats second, {quantile level: value} with 1.0 for its max; the app
    reports upper edges of 0.1 ms buckets. In a second whose q-quantile is within the limit at most
    1 - q of its samples exceed it (none when its max is within); in one whose q-quantile is above
    the limit about 1 - q or more do. Averaged over the seconds (about the same number of samples
    each) that bounds the run's share above the limit: PASS when even the upper bound is within
    1 - q, FAIL when the lower bound is above it or the median second's q-quantile is over the
    limit, inconclusive otherwise (a median of per-second tails alone would hide up to half the
    seconds breaching).
    """
    lo = hi = 0.0
    seen = over = 0
    for w in windows:
        known = {level: v for level, v in w.items() if number(v)}
        if not known:
            continue
        seen += 1
        above = [level for level, v in known.items() if v > limit]
        # Quantiles rise with their level; a level counts as within only below every level over it.
        within = [level for level, v in known.items() if v <= limit and all(level < a for a in above)]
        hi += 1 - max(within) if within else 1.0
        lo += 1 - min(above) if above else 0.0
        over += 1 if number(w.get(q)) and w[q] > limit else 0
    detail: dict = {"seconds": seen, "seconds_over": over}
    if not seen:
        return None, detail
    lo, hi = lo / seen, hi / seen
    typical = median(w.get(q) for w in windows)
    detail.update({"median_second": rnd(typical, 2), "worst_second": rnd(top_value(w.get(q) for w in windows), 2),
                   "share_over_pct": [rnd(lo * 100, 2), rnd(hi * 100, 2)]})
    allowed = 1 - q + 1e-9
    if hi <= allowed:
        return True, detail
    if lo > allowed or (typical is not None and typical > limit):
        return False, detail
    return INCONCLUSIVE, detail


def tail_text(label: str, d: dict, limit: float, q: float, unit: str = "ms") -> str:
    if not d.get("seconds"):
        return f"{label} no data"
    lo, hi = d["share_over_pct"]
    return (f"{label} median second {d['median_second']} {unit}, worst {d['worst_second']}, {d['seconds_over']} of"
            f" {d['seconds']} s over {limit}; {lo}-{hi} % of the run over {limit} (<= {rnd((1 - q) * 100, 2)} %)")


def rise(before: float, after: float) -> float:
    """How much a cumulative counter rose; a drop is a reset to zero."""
    return after - before if after >= before else after


def increase(values) -> float:
    total, prev = 0.0, None
    for v in values:
        if not number(v):
            continue
        if prev is not None:
            total += rise(prev, v)
        prev = v
    return total


def db(rms) -> float:
    return 20 * math.log10(rms) if number(rms) and rms > 0 else -120.0


class PitchTracker:
    """Turns the diagnostics' running pitch counters into what arrived since the last sample."""

    def __init__(self) -> None:
        self.prev: dict[str, tuple[int, int]] = {}

    def update(self, pitch: dict | None) -> dict:
        out = {}
        for cid, p in (pitch or {}).items():
            frames, voiced, tail = int(p.get("frames") or 0), int(p.get("voiced") or 0), list(p.get("tail") or [])
            seen_frames, seen_voiced = self.prev.get(cid, (0, 0))
            if frames < seen_frames or voiced < seen_voiced:
                seen_frames, seen_voiced = 0, 0
            new_voiced = voiced - seen_voiced
            out[cid] = {"frames": frames - seen_frames, "voiced": new_voiced,
                        "new": tail[-new_voiced:] if new_voiced > 0 else []}
            self.prev[cid] = (frames, voiced)
        return out


def tap_summary(tap: dict | None) -> dict:
    """The door recorder's tap counters, with the arrival intervals as a 1 ms histogram."""
    tap = tap or {}
    iv = [v for v in tap.get("iv") or [] if number(v)]
    hist: dict[str, int] = {}
    for v in iv:
        b = str(min(int(v), TAP_HIST_CAP_MS))
        hist[b] = hist.get(b, 0) + 1
    return {"msgs": tap.get("msgs", 0), "blocks": tap.get("blocks", 0), "zero": tap.get("zero", 0),
            "bad": tap.get("bad", 0), "missing": tap.get("missing") or {}, "resets": tap.get("resets") or {},
            "per_slot": tap.get("perSlot") or {}, "iv_n": len(iv), "iv_max": max(iv) if iv else None, "hist": hist}


def hist_quantile(hist: dict, q: float) -> float | None:
    """Upper edge (ms) of the 1 ms bucket holding quantile q."""
    total = sum(hist.values())
    if not total:
        return None
    need, seen = q * total, 0
    for b in sorted(hist, key=int):
        seen += hist[b]
        if seen >= need:
            return float(int(b) + 1)
    return None


def merge_taps(rows) -> dict:
    out = {"msgs": 0, "blocks": 0, "zero": 0, "bad": 0, "missing": {}, "resets": {}, "per_slot": {},
           "iv_n": 0, "iv_max": None, "hist": {}}
    for r in rows:
        for k in ("msgs", "blocks", "zero", "bad", "iv_n"):
            out[k] += r.get(k) or 0
        for k in ("missing", "resets", "per_slot", "hist"):
            for slot, n in (r.get(k) or {}).items():
                out[k][str(slot)] = out[k].get(str(slot), 0) + n
        if number(r.get("iv_max")):
            out["iv_max"] = max(out["iv_max"] or 0.0, r["iv_max"])
    return out


def counter(m: dict, key: str) -> float:
    v = m.get(key)
    return float(v) if number(v) else 0.0


def door_messages(events, kind: str, direction: str = "in") -> list[tuple[int, dict]]:
    return [(e["t"], e["m"]) for e in events
            if e.get("dir") == direction and isinstance(e.get("m"), dict) and e["m"].get("t") == kind]


def check(checks: list, ident: str, ok: bool | None, value: str) -> None:
    checks.append({"id": ident, "pass": ok, "value": value})


def connections(events) -> list:
    """Each event's door connection: the socket the recorder named, else (a recording without
    socket names) the latest connect before it."""
    out, current, count = [], None, 0
    for e in events:
        sock = e.get("sock")
        if sock is None:
            m = e.get("m") or {}
            if e.get("dir") == "sock" and m.get("ev") == "connect":
                count += 1
                current = f"#{count}"
            sock = current
        out.append(sock)
    return out


def attach_anchors(events, slot_of: dict, by_peer: dict) -> dict:
    """Per slot, the times it (re)attached: its status turning attached (or reappearing attached
    after a gap), or a new peer's audio starting on it with no such status within GAP_MS before."""
    anchors: dict = {}
    last: dict = {}
    for t, m in door_messages(events, "status"):
        listed = set()
        for s in m.get("slots") or []:
            if not isinstance(s, dict):
                continue
            slot = s.get("slot")
            listed.add(slot)
            prev = last.get(slot)
            if s.get("attached") and (prev is None or not prev[1] or t - prev[0] > GAP_MS):
                anchors.setdefault(slot, []).append(t)
            last[slot] = (t, bool(s.get("attached")))
        for slot in set(last) - listed:
            last[slot] = (t, False)
    for key, rows in by_peer.items():
        slot = slot_of.get(key)
        started = next((t for t, m in rows if (m.get("jitterBufferEmittedCount") or 0) > 0), None)
        if slot is None or started is None:
            continue
        if not any(started - GAP_MS <= a <= started for a in anchors.get(slot, [])):
            anchors.setdefault(slot, []).append(started)
    return {slot: sorted(ts) for slot, ts in anchors.items()}


def us_ms(v) -> float | None:
    return v / 1000 if number(v) else None


def native_report(events, tap_rows=(), long_rows=(), song_peaks=(), start_ms=None, end_ms=None,
                  warmup_s: float = WARMUP_S) -> dict:
    """The native voice path's figures and pass checks from recorded door traffic (host clock).

    Engine figures come per second from engine-stats; NetEQ, RTT and the electrical sum come per
    peer-stats interval (2 s), read once a peer has had `warmup_s` of audio. A peer is its page
    load's door socket plus its id (ids restart on a reload). `song_peaks` is [(t, peak)] from the
    flight record's song peak meter.
    """
    events = sorted((e for e in events if number(e.get("t"))), key=lambda e: e["t"])

    def win(t) -> bool:
        return (start_ms is None or t >= start_ms) and (end_ms is None or t <= end_ms)

    checks: list[dict] = []
    readies = door_messages(events, "ready")
    socks = [e["m"] for e in events if e.get("dir") == "sock" and isinstance(e.get("m"), dict)]
    eng_all = door_messages(events, "engine-stats")
    eng = [(t, m) for t, m in eng_all if win(t)]
    ready_ok = next((m for _, m in readies if m.get("ok")), None)
    out: dict = {
        "door": {"connected": any(s.get("ev") == "open" for s in socks),
                 "connections": sum(1 for s in socks if s.get("ev") == "connect"),
                 "closes": [s.get("code") for s in socks if s.get("ev") == "close"],
                 "ready": ready_ok or (readies[0][1] if readies else None),
                 "fatal": [m.get("reason") for t, m in door_messages(events, "fatal") if win(t)],
                 "restart_needed": sum(1 for t, _ in door_messages(events, "restart-needed") if win(t)),
                 "peer_errors": {}},
        "checks": checks,
    }
    for t, m in door_messages(events, "peer-error"):
        if win(t):
            out["door"]["peer_errors"][m.get("code")] = out["door"]["peer_errors"].get(m.get("code"), 0) + 1
    if not eng:
        check(checks, "door", False, "no engine-stats from the app (native path not running)")
        return out

    conns = connections(events)
    conn_no: dict = {}
    for c in conns:
        if c is not None and c not in conn_no:
            conn_no[c] = len(conn_no) + 1
    slot_of: dict = {}
    by_peer: dict = {}
    for e, c in zip(events, conns):
        m = e.get("m")
        if not isinstance(m, dict):
            continue
        key = (conn_no.get(c), m.get("peer"))
        if e.get("dir") == "out" and m.get("t") == "offer" and number(m.get("peer")) and number(m.get("slot")):
            slot_of[key] = m["slot"]
        elif e.get("dir") == "in" and m.get("t") == "peer-stats":
            by_peer.setdefault(key, []).append((e["t"], m))

    def peer_label(key) -> str:
        return f"c{key[0]}/p{key[1]}" if key[0] is not None else f"p{key[1]}"

    opened = [m for _, m in eng if m.get("open")]
    minutes = max((eng[-1][0] - eng[0][0]) / 60000, 1 / 60)
    out["engine"] = {
        "seconds": len(eng), "open_share": round(len(opened) / len(eng), 3),
        "burst_frames": eng[-1][1].get("burstFrames"), "buffer_frames": eng[-1][1].get("bufferFrames"),
        "apm": next((m.get("apm") for _, m in reversed(eng) if m.get("apm")), None),
        "xruns": increase(m.get("xruns") for _, m in eng), "restarts": increase(m.get("restarts") for _, m in eng),
        "open_attempts": eng[-1][1].get("openAttempts"),
        "sink_errors": increase(m.get("sinkErrors") for _, m in eng),
        "ignored": eng[-1][1].get("ignored"), "ignored_rise": increase(m.get("ignored") for _, m in eng),
        "tap_dropped": increase(m.get("tapDropped") for _, m in eng),
    }

    # M1: p50 is a typical value, the per-second median is enough; p99 is a tail (tail_check).
    pushes = [m for _, m in eng if (m.get("pushIntervalP50Us") or 0) > 0]
    w1 = [{0.5: us_ms(m["pushIntervalP50Us"]), 0.99: us_ms(m.get("pushIntervalP99Us")),
           1.0: us_ms(m.get("pushIntervalMaxUs"))} for m in pushes]
    v99, d99 = tail_check(w1, 20, 0.99)
    p50 = median(w[0.5] for w in w1)
    max1 = top_value(w[1.0] for w in w1)
    m1 = {"seconds": len(pushes), "p50_ms": rnd(p50, 2), "p99_ms": d99.get("median_second"),
          "p99_worst_ms": d99.get("worst_second"), "seconds_p99_over_20ms": d99["seconds_over"],
          "p99_share_over_20ms_pct": d99.get("share_over_pct"), "max_ms": rnd(max1, 2)}
    out["M1"] = m1
    check(checks, "M1 push interval", None if not pushes else
          all_of(8 <= p50 <= 12, v99, max1 is not None and max1 <= 40),
          f"p50 {m1['p50_ms']} ms (about 10); {tail_text('p99', d99, 20, 0.99)}; max {m1['max_ms']} ms (<= 40)")

    w2 = [{0.99: us_ms(m.get("callbackP99Us")), 1.0: us_ms(m.get("callbackMaxUs"))}
          for m in opened if (m.get("callbackP99Us") or 0) > 0]
    v2, d2 = tail_check(w2, 2, 0.99)
    cbmax = top_value(w[1.0] for w in w2)
    out["M2"] = {"p99_ms": d2.get("median_second"), "p99_worst_ms": d2.get("worst_second"),
                 "seconds_p99_over_2ms": d2["seconds_over"], "p99_share_over_2ms_pct": d2.get("share_over_pct"),
                 "max_ms": rnd(cbmax, 3)}
    check(checks, "M2 callback", None if not w2 else all_of(v2, cbmax is not None and cbmax <= 5),
          f"{tail_text('p99', d2, 2, 0.99)}; max {out['M2']['max_ms']} ms (<= 5)")

    # M3: an underrun counts when the whole second it was reported in lies UNDERRUN_GRACE_MS after the
    # slot's latest (re)attach; a jump when it lies JUMP_GRACE_MS after.
    anchors = attach_anchors(events, slot_of, by_peer)
    slots3: dict = {}
    present: dict = {}
    prev: dict = {}
    prev_t: dict = {}
    for t, m in eng_all:
        seen = set()
        for s in m.get("slots") or []:
            slot = s.get("slot")
            seen.add(slot)
            present.setdefault(slot, t)
            acc = slots3.setdefault(slot, {"underruns": 0, "underruns_in_grace": 0, "trim_seconds": 0, "trimmed_ms": 0.0,
                                           "largest_trim_ms": 0.0, "jumps": 0, "margins": [], "attaches": 0})
            before = prev.get(slot)
            if before is not None and win(t):
                xs = anchors.get(slot, [])
                i = bisect.bisect_right(xs, t)
                start = max(xs[i - 1], present[slot]) if i else present[slot]
                settled = prev_t[slot] - start
                grew = rise(before.get("underruns", 0), s.get("underruns", 0))
                acc["underruns" if settled >= UNDERRUN_GRACE_MS else "underruns_in_grace"] += grew
                trimmed = rise(before.get("trimmedFrames", 0), s.get("trimmedFrames", 0))
                if trimmed > 0:
                    ms = trimmed / 48
                    acc["trim_seconds"] += 1
                    acc["trimmed_ms"] += ms
                    acc["largest_trim_ms"] = max(acc["largest_trim_ms"], ms)
                    if ms >= JUMP_MS and settled >= JUMP_GRACE_MS:
                        acc["jumps"] += 1
            if win(t):
                acc["margins"].append(s.get("marginMs"))
            prev[slot] = s
            prev_t[slot] = t
        for slot in list(present):
            if slot not in seen:
                present.pop(slot)
                prev.pop(slot, None)
    m3 = {}
    for slot, acc in sorted(slots3.items(), key=lambda kv: str(kv[0])):
        m3[str(slot)] = {"underruns": acc["underruns"], "underruns_in_grace": acc["underruns_in_grace"],
                         "attaches": sum(1 for a in anchors.get(slot, []) if win(a)),
                         "trims_per_min": round(acc["trim_seconds"] / minutes, 2),
                         "trimmed_ms_per_min": round(acc["trimmed_ms"] / minutes, 1),
                         "largest_trim_ms": round(acc["largest_trim_ms"], 1), "jumps": acc["jumps"],
                         "margin_ms_median": rnd(median(acc["margins"])), "margin_ms_max": rnd(top_value(acc["margins"]))}
    out["M3"] = {"slots": m3, "xruns": out["engine"]["xruns"]}
    check(checks, "M3 underruns/xruns/trims", None if not m3 else not any(v["underruns"] for v in m3.values())
          and out["engine"]["xruns"] == 0 and all(v["trims_per_min"] <= 5 and v["jumps"] == 0 for v in m3.values()),
          "underruns " + ", ".join(f"slot {k}: {v['underruns']}" for k, v in m3.items())
          + f" ({UNDERRUN_GRACE_MS // 1000} s after each attach; in grace "
          + ", ".join(f"{k}: {v['underruns_in_grace']}" for k, v in m3.items())
          + f"); xruns {out['engine']['xruns']:.0f}; trims/min "
          + ", ".join(f"{k}: {v['trims_per_min']}" for k, v in m3.items()) + " (<= 5); jumps "
          + ", ".join(f"{k}: {v['jumps']}" for k, v in m3.items())
          + f" (one-second trims >= {JUMP_MS:.0f} ms, {JUMP_GRACE_MS // 1000} s after each attach)")

    latency = [m["outputLatencyMs"] for m in opened if number(m.get("outputLatencyMs"))]
    out["M5"] = {"p50_ms": rnd(median(latency)), "max_ms": rnd(top_value(latency))}
    check(checks, "M5 output latency", None if not latency else median(latency) <= 35,
          f"p50 {out['M5']['p50_ms']} ms (<= 35)")

    present_rows = [(t, m) for t, m in eng if m.get("open") and (m.get("pushToPresentP50Ms") or 0) > 0]
    w6 = [{0.5: m["pushToPresentP50Ms"], 0.95: m.get("pushToPresentP95Ms")} for _, m in present_rows]
    v6a, d6a = tail_check(w6, 50, 0.5)
    v6b, d6b = tail_check(w6, 60, 0.95)
    out["M6"] = {"p50_ms": d6a.get("median_second"), "p95_ms": d6b.get("median_second"),
                 "p95_worst_ms": d6b.get("worst_second"), "seconds_p95_over_60ms": d6b["seconds_over"],
                 "p95_share_over_60ms_pct": d6b.get("share_over_pct")}
    check(checks, "M6 push to present", None if not w6 else all_of(v6a, v6b),
          f"{tail_text('p50', d6a, 50, 0.5)}; {tail_text('p95', d6b, 60, 0.95)}")
    present_t = [t for t, _ in present_rows]

    def present_at(t: int) -> tuple[float, float] | None:
        i = bisect.bisect_left(present_t, t)
        near = [j for j in (i - 1, i) if 0 <= j < len(present_rows) and abs(present_rows[j][0] - t) <= 2000]
        if not near:
            return None
        m = present_rows[min(near, key=lambda j: abs(present_rows[j][0] - t))][1]
        return m["pushToPresentP50Ms"], m.get("pushToPresentP95Ms", m["pushToPresentP50Ms"])

    per_slot: dict = {}
    for key, rows in by_peer.items():
        started = next((t for t, m in rows if (m.get("jitterBufferEmittedCount") or 0) > 0), None)
        if started is None:
            continue
        read = [(t, m) for t, m in rows if t >= started + warmup_s * 1000 and win(t)]
        slot_key = str(slot_of.get(key, f"peer {peer_label(key)}"))
        acc = per_slot.setdefault(slot_key, {"peers": [], "emitted": 0.0, "delay": 0.0, "target": 0.0, "concealed": 0.0,
                                             "accel": 0.0, "decel": 0.0, "received": 0.0, "lost": 0.0, "intervals": [],
                                             "half_rtt": [], "jitter": [], "candidate": None})
        acc["peers"].append(peer_label(key))
        for (_, a), (t1, b) in zip(read, read[1:]):
            def grew(name: str) -> float:
                return counter(b, name) - counter(a, name)

            emitted = grew("jitterBufferEmittedCount")
            if emitted <= 0:
                continue
            delay = grew("jitterBufferDelay")
            acc["emitted"] += emitted
            acc["delay"] += delay
            acc["target"] += grew("jitterBufferTargetDelay")
            acc["concealed"] += max(0.0, grew("concealedSamples"))
            acc["accel"] += max(0.0, grew("removedSamplesForAcceleration"))
            acc["decel"] += max(0.0, grew("insertedSamplesForDeceleration"))
            acc["received"] += max(0.0, grew("packetsReceived"))
            acc["lost"] += max(0.0, grew("packetsLost"))
            rtt = b.get("roundTripTimeMs")
            acc["intervals"].append((t1, delay / emitted * 1000, rtt / 2 if number(rtt) else None))
        for _, m in read:
            if number(m.get("roundTripTimeMs")):
                acc["half_rtt"].append(m["roundTripTimeMs"] / 2)
            if number(m.get("jitter")):
                acc["jitter"].append(m["jitter"] * 1000)
            acc["candidate"] = m.get("candidateType") or acc["candidate"]

    m4, m7, sigma, pooled, pooled_hi = {}, {}, {}, [], []
    rtt_missing = 0
    for key, acc in sorted(per_slot.items()):
        e = acc["emitted"]
        m4[key] = {"peers": acc["peers"], "seconds": round(e / 48000, 1),
                   "mean_ms": rnd(acc["delay"] / e * 1000) if e else None,
                   "target_ms": rnd(acc["target"] / e * 1000) if e else None,
                   "target_step_ms": int(round(acc["target"] / e * 1000 / 20) * 20) if e else None,
                   "concealed_pct": rnd(acc["concealed"] / e * 100, 2) if e else None,
                   "accelerate_pct": rnd(acc["accel"] / e * 100, 2) if e else None,
                   "decelerate_pct": rnd(acc["decel"] / e * 100, 2) if e else None,
                   "packet_loss_pct": rnd(acc["lost"] / (acc["received"] + acc["lost"]) * 100, 2)
                   if acc["received"] + acc["lost"] else None}
        slot_half = median(acc["half_rtt"])
        m7[key] = {"rtt_half_ms": rnd(slot_half, 2), "jitter_ms": rnd(median(acc["jitter"]), 2),
                   "candidate": acc["candidate"]}
        sums, sums_hi = [], []
        for t, neteq, half in acc["intervals"]:
            present = present_at(t)
            if present is None:
                continue
            if half is None:
                half = slot_half
            if half is None:
                rtt_missing += 1
                half = 0.0
            sums.append(half + neteq + present[0])
            sums_hi.append(half + neteq + present[1])
        p50s = median(sums)
        sigma[key] = {"n": len(sums), "p50_ms": rnd(p50s), "p95_ms": rnd(quantile(sums, 0.95)),
                      "p95_with_m6_p95_ms": rnd(quantile(sums_hi, 0.95)),
                      "mouth_to_speaker_p50_ms": rnd(p50s + UNSEEN_MS) if p50s is not None else None}
        pooled.extend(sums)
        pooled_hi.extend(sums_hi)
    out["M4"] = m4
    out["M7"] = m7
    concealed = [v["concealed_pct"] for v in m4.values() if v["concealed_pct"] is not None]
    check(checks, "M4 jitter buffer", None if not concealed else all(v < 1 for v in concealed),
          "; ".join(f"slot {k}: mean {v['mean_ms']} ms, target {v['target_ms']} ms (step {v['target_step_ms']}),"
                    f" concealed {v['concealed_pct']} % (< 1)" for k, v in m4.items()) or "no peer-stats after warm-up")
    all_p50, all_p95 = median(pooled), quantile(pooled, 0.95)
    sigma["all"] = {"n": len(pooled), "p50_ms": rnd(all_p50), "p95_ms": rnd(all_p95),
                    "p95_with_m6_p95_ms": rnd(quantile(pooled_hi, 0.95)), "rtt_missing": rtt_missing,
                    "mouth_to_speaker_p50_ms": rnd(all_p50 + UNSEEN_MS) if all_p50 is not None else None}
    out["sigma"] = sigma
    # Σ is judged per slot (one slow slot must not hide in the pool) and pooled.
    judged = {k: v for k, v in sigma.items() if v["n"]}
    unjudged = [k for k, v in sigma.items() if k != "all" and not v["n"]]
    check(checks, "Σ electrical (RTT/2 + NetEQ + push-to-present)",
          None if not pooled else all(v["p50_ms"] <= 98 and v["p95_ms"] <= 168 for v in judged.values()),
          "; ".join(f"{'all slots' if k == 'all' else 'slot ' + k} p50 {v['p50_ms']} / p95 {v['p95_ms']} ms"
                    f" (mouth-to-speaker p50 {v['mouth_to_speaker_p50_ms']})" for k, v in judged.items())
          + " (p50 <= 98, p95 <= 168; mouth-to-speaker <= 150)"
          + (f"; no figures for slot {', '.join(unjudged)}" if unjudged else "")
          + (f"; RTT missing in {rtt_missing}" if rtt_missing else ""))

    w7 = [{0.99: us_ms(m.get("tapDrainP99Us")), 1.0: us_ms(m.get("tapDrainMaxUs"))}
          for _, m in eng if (m.get("tapDrainP99Us") or 0) > 0]
    vt, dt = tail_check(w7, 25, 0.99)
    taps = merge_taps(r for r in tap_rows if win(r.get("t", 0)))
    longs = [r for r in long_rows if win(r.get("t", 0))]
    out["T1"] = {"app_p99_ms": dt.get("median_second"), "app_p99_worst_ms": dt.get("worst_second"),
                 "app_seconds_p99_over_25ms": dt["seconds_over"], "app_p99_share_over_25ms_pct": dt.get("share_over_pct"),
                 "app_max_ms": rnd(top_value(w[1.0] for w in w7), 2),
                 "page_p99_ms": hist_quantile(taps["hist"], 0.99), "page_max_ms": taps["iv_max"],
                 "page_messages": taps["msgs"], "long_tasks": sum(r.get("n", 0) for r in longs),
                 "long_task_ms": round(sum(r.get("ms", 0) for r in longs)),
                 "long_task_max_ms": rnd(top_value(r.get("max") for r in longs))}
    check(checks, "T1 tap drain", vt,
          f"app {tail_text('p99', dt, 25, 0.99)}; page arrival p99 {out['T1']['page_p99_ms']} ms,"
          f" max {out['T1']['page_max_ms']} ms (report only), long tasks {out['T1']['long_tasks']}")
    out["tap"] = {"blocks_per_slot": taps["per_slot"], "missing_per_slot": taps["missing"],
                  "seq_resets": taps["resets"], "zero_blocks": taps["zero"], "bad_messages": taps["bad"],
                  "app_dropped": out["engine"]["tap_dropped"]}

    voice_peak = top_value(m.get("peak") for _, m in eng)
    song_peak = top_value(v for t, v in song_peaks if win(t))
    out["H1"] = {"voice_peak_max": rnd(voice_peak, 3), "song_peak_max": rnd(song_peak, 3)}
    check(checks, "H1 headroom", None if voice_peak is None or song_peak is None else voice_peak <= 0.5 and song_peak <= 0.5,
          f"voice peak {out['H1']['voice_peak_max']} (<= 0.5), song peak {out['H1']['song_peak_max']} (<= 0.5)")

    out["monitor"] = [m for t, m in door_messages(events, "monitor-result") if win(t)]
    smoke = {"ready_ok": bool(ready_ok), "audio": (ready_ok or {}).get("audio"),
             "burst_frames": out["engine"]["burst_frames"], "output_latency_ms": out["M5"]["p50_ms"],
             "open_share": out["engine"]["open_share"], "apm": out["engine"]["apm"]}
    out["smoke"] = smoke
    lat = smoke["output_latency_ms"]
    check(checks, "V1 smoke", all_of(smoke["ready_ok"], smoke["audio"] == "open", bool(opened), smoke["burst_frames"] == 384,
                                     None if lat is None else 25 <= lat <= 40, smoke["apm"] is not None),
          f"ready ok {smoke['ready_ok']}, audio {smoke['audio']} (open), output open {smoke['open_share'] * 100:.0f}% of"
          f" seconds, burst {smoke['burst_frames']} (384), output latency p50 {lat} ms (25-40), apm {smoke['apm']} (present)")
    return out


def format_checks(checks: list[dict]) -> str:
    return "\n".join(f"  {verdict_label(c['pass'])} {c['id']}: {c['value']}" for c in checks)


def format_native(rep: dict) -> str:
    door = rep.get("door") or {}
    lines = [f"door: connected {door.get('connected')}, connections {door.get('connections')}, closes {door.get('closes')},"
             f" restart-needed {door.get('restart_needed')}, peer errors {door.get('peer_errors')}, fatal {door.get('fatal')}"]
    if "engine" not in rep:
        return "\n".join(lines + [format_checks(rep.get("checks", []))])
    e = rep["engine"]
    lines.append(f"engine: open {e['open_share'] * 100:.0f}% of {e['seconds']} s, burst {e['burst_frames']},"
                 f" buffer {e['buffer_frames']}, xruns {e['xruns']:.0f}, restarts {e['restarts']:.0f},"
                 f" open attempts {e['open_attempts']}, sink errors {e['sink_errors']:.0f}, ignored {e['ignored']},"
                 f" apm {e['apm']}")
    lines.append("Cube-side electrical latency per slot (ms; NetEQ after warm-up)")
    lines.append("  slot      RTT/2   NetEQ mean (target)   push->present p50   Σ p50   Σ p95   mouth->speaker   n")
    for key, s in rep["sigma"].items():
        if key == "all":
            continue
        m4, m7 = rep["M4"].get(key, {}), rep["M7"].get(key, {})
        lines.append(f"  {key:<8} {m7.get('rtt_half_ms')!s:>6}   {m4.get('mean_ms')!s:>6} ({m4.get('target_ms')})"
                     f"          {rep['M6']['p50_ms']!s:>6}      {s['p50_ms']!s:>6}  {s['p95_ms']!s:>6}"
                     f"  {s.get('mouth_to_speaker_p50_ms')!s:>10}       {s['n']}")
    a = rep["sigma"]["all"]
    lines.append(f"  all slots Σ p50 {a['p50_ms']} / p95 {a['p95_ms']} ms (p95 with push->present p95:"
                 f" {a['p95_with_m6_p95_ms']}); estimated mouth-to-speaker p50 {a['mouth_to_speaker_p50_ms']} ms")
    lines.append(format_checks(rep["checks"]))
    lines.append(f"tap: {rep['tap']}")
    if rep.get("monitor"):
        lines.append(f"monitor beep: {rep['monitor']}")
    return "\n".join(lines)


def pitch_summary(values: dict, singers: list[dict], frames: dict) -> dict:
    out = {}
    for s in singers:
        got = [v for v in values.get(s["id"], []) if number(v)]
        near = [v for v in got if abs(v - s["want"]) <= PITCH_TOL_HZ]
        out[s["id"]] = {"slot": s["slot"], "want_hz": s["want"], "frames": frames.get(s["id"], 0), "voiced": len(got),
                        "median": statistics.median(got) if got else None,
                        "within_3hz": round(len(near) / len(got), 3) if got else 0}
    return out


def scan_logs(main: str, crash: str, app_pids: set[str]) -> dict:
    """Trim-memory levels, low-memory kills, deaths, crashes and GC pauses of the app; its own log lines.

    The crash buffer is the whole device's: a line counts for the app when one of its processes
    wrote it or it names the app (a native crash's tombstone header does, `>>> org.firesong.tv <<<`).
    """
    trims, kills, deaths, app_lines, pauses = [], [], [], [], []
    for line in main.splitlines():
        parts = line.split(None, 5)
        pid = parts[2] if len(parts) > 2 else ""
        level = re.search(r"onTrimMemory level=(\d+)", line)
        if level:
            trims.append(int(level.group(1)))
        if APP in line and re.search(r"am_kill|lowmemorykiller|lmkd|Kill(?:ing)? '", line):
            kills.append(line.strip()[:300])
        if re.search(rf"Process {re.escape(APP)} \(pid \d+\) has died", line):
            deaths.append(line.strip()[:300])
        if pid in app_pids:
            if "GC freed" in line:
                paused = re.search(r"paused ((?:[\d.]+(?:ms|us|s),?)+)", line)
                if paused:
                    total = 0.0
                    for value, unit in re.findall(r"([\d.]+)(ms|us|s)", paused.group(1)):
                        total += float(value) * {"ms": 1.0, "us": 0.001, "s": 1000.0}[unit]
                    pauses.append(total)
            else:
                app_lines.append(line)

    def ours(line: str) -> bool:
        parts = line.split(None, 5)
        return ((len(parts) > 2 and parts[2] in app_pids) or f">>> {APP} <<<" in line
                or re.search(rf"\b{re.escape(APP)}\b(?!:sandboxed)", line) is not None)

    crashes = [ln for ln in crash.splitlines() if ln.strip() and not ln.startswith("--------- beginning of")]
    mine = [ln for ln in crashes if ours(ln)]
    return {"trim_levels": sorted(set(trims)), "trim_critical": trims.count(15), "lmk_kills": kills,
            "app_deaths": deaths, "crash_lines": len(mine), "crash_head": mine[:20],
            "other_crash_lines": len(crashes) - len(mine),
            "renderer_crash_lines": sum(1 for ln in crashes if "sandboxed_process" in ln),
            "gc": {"count": len(pauses), "max_pause_ms": rnd(top_value(pauses), 2)}, "app_lines": app_lines[-5000:]}


def cpu_medians(samples: list[dict]) -> dict:
    return {k: rnd(median((s.get("cpu") or {}).get(k) for s in samples)) for k in ("app", "webview")}


def ab_compare(web: dict, native: dict) -> dict:
    """Native minus web on the same song: CPU medians, memory at matched song positions, minima and logs."""
    checks: list[dict] = []
    cw, cn = cpu_medians(web["samples"]), cpu_medians(native["samples"])
    app_d = None if cw["app"] is None or cn["app"] is None else round(cn["app"] - cw["app"], 1)
    rend_d = None if cw["webview"] is None or cn["webview"] is None else round(cn["webview"] - cw["webview"], 1)
    check(checks, "CPU app", None if app_d is None else app_d <= 25,
          f"median web {cw['app']} %, native {cn['app']} %, delta {app_d} (<= +25, percent of one core)")
    check(checks, "CPU renderer", None if rend_d is None else rend_d <= 0,
          f"median web {cw['webview']} %, native {cn['webview']} %, delta {rend_d} (<= 0)")

    def by_position(phase: dict) -> dict:
        return {round(m["position_ms"] / MEM_EVERY_MS): m for m in phase.get("mem", []) if number(m.get("position_ms"))}

    pw, pn = by_position(web), by_position(native)
    matched = []
    for k in sorted(set(pw) & set(pn)):
        row = {"position_s": k * MEM_EVERY_MS // 1000}
        for field in ("native_heap_mb", "so_mmap_mb", "pss_mb"):
            a, b = pw[k].get(field), pn[k].get(field)
            row[field] = None if a is None or b is None else round(b - a, 1)
        matched.append(row)
    nh = top_value(r["native_heap_mb"] for r in matched)
    so = top_value(r["so_mmap_mb"] for r in matched)
    check(checks, "Native Heap", None if nh is None else nh <= 25,
          f"largest delta {nh} MB at matched positions (<= +25); median {rnd(median(r['native_heap_mb'] for r in matched))}")
    check(checks, ".so mmap", None if so is None else so <= 10,
          f"largest delta {so} MB at matched positions (<= +10); median {rnd(median(r['so_mmap_mb'] for r in matched))}")
    mw = min((s["mem_available_mb"] for s in web["samples"] if number(s.get("mem_available_mb"))), default=None)
    mn = min((s["mem_available_mb"] for s in native["samples"] if number(s.get("mem_available_mb"))), default=None)
    check(checks, "MemAvailable minimum", None if mw is None or mn is None else mn >= mw - 20,
          f"web {mw} MB, native {mn} MB (native >= web - 20)")
    return {"cpu": {"web": cw, "native": cn, "app_delta": app_d, "renderer_delta": rend_d},
            "memory_matched": matched, "mem_available_min": {"web": mw, "native": mn}, "checks": checks}


def backend_named(ev: dict) -> tuple[str | None, str | None]:
    """A flight mic-backend event's backend and reason, whether flat or under `backend`."""
    b = ev.get("backend")
    kind = ev.get("kind") or (b if isinstance(b, str) else (b or {}).get("kind"))
    return kind, ev.get("why") or (b.get("why") if isinstance(b, dict) else None)


def phase_checks(phase: dict) -> list[dict]:
    checks: list[dict] = []
    ratio = phase.get("realtime_ratio")
    check(checks, "real time", None if ratio is None else ratio > 0.97, f"song played at {ratio} of real time (> 0.97)")
    for pid, p in (phase.get("pitch") or {}).items():
        check(checks, f"S1 pitch {pid}", p["within_3hz"] >= PITCH_PASS_SHARE,
              f"{p['within_3hz'] * 100:.0f}% of {p['voiced']} voiced windows within 3 Hz of {p['want_hz']} Hz (>= 90%)")
    fb = phase.get("fallback")
    if fb:
        check(checks, f"fallback {fb['action']}", fb.get("pass"),
              f"heard again after {fb.get('recovered_s')} s (<= {fb.get('limit_s')}), backend {fb.get('backend_after')}")
        if fb["action"] == "drop" and fb.get("at_ms"):
            events = phase.get("flight_events")
            said = [backend_named(e) for e in events or []
                    if e.get("ev") == "mic-backend" and number(e.get("t")) and e["t"] >= fb["at_ms"] - 2000]
            check(checks, "F2 flight mic-backend web (dropped)", None if events is None else ("web", "dropped") in said,
                  f"mic-backend events after the drop: {said}")
    pids = phase.get("pids") or {}
    logs = phase.get("logs")
    if pids.get("start") or logs:
        survived = bool(set(pids.get("start") or []) & set(pids.get("end") or [])) if pids.get("start") else None
        deaths = (logs or {}).get("app_deaths") or []
        check(checks, "app process survived", False if deaths else survived,
              f"pid {pids.get('start')} at the start, {pids.get('end')} at the end; {len(deaths)} 'has died' lines")
    if logs:
        check(checks, "no trim-memory critical", logs.get("trim_critical", 0) == 0, f"levels seen {logs.get('trim_levels')}")
        check(checks, "no low-memory kill", not logs.get("lmk_kills"), f"{len(logs.get('lmk_kills') or [])} kill lines")
        check(checks, "crash log empty", logs.get("crash_lines", 0) == 0,
              f"{logs.get('crash_lines', 0)} lines of the app (other apps {logs.get('other_crash_lines', 0)},"
              f" WebView renderers {logs.get('renderer_crash_lines', 0)})")
    return checks


def analyze(report: dict, warmup_s: float) -> list[dict]:
    """Recomputes the native figures and the A/B comparison of a saved report; prints them."""
    all_checks: list[dict] = []
    for phase in report.get("phases", []):
        print(f"\n== {phase['voice']} phase: {len(phase.get('samples', []))} samples,"
              f" app CPU median {cpu_medians(phase.get('samples', []))}, clock offset {phase.get('clock_offset_ms')} ms")
        if phase.get("backend_seen"):
            print(f"backend seen on the page: {phase['backend_seen']}")
        if phase.get("tick_errors"):
            print(f"diagnostics errors: {phase['tick_errors']}")
        checks = phase_checks(phase)
        if phase["voice"] == "native" or phase.get("door"):
            rep = native_report(phase.get("door", []), phase.get("tap", []), phase.get("long", []),
                                [tuple(p) for p in phase.get("song_peaks", [])], phase.get("song_start_ms"),
                                phase.get("end_ms"), warmup_s)
            phase["native"] = rep
            print(format_native(rep))
        print(format_checks(checks))
        for ev in phase.get("flight_events", []):
            print(f"  flight {ev.get('ev')}: {json.dumps({k: v for k, v in ev.items() if k not in ('ev', 'wall')})}")
        if phase.get("logs"):
            logs = phase["logs"]
            print(f"  logcat: trim levels {logs['trim_levels']}, low-memory kills {len(logs['lmk_kills'])},"
                  f" crash lines {logs['crash_lines']}, GC pauses {logs['gc']}")
        all_checks += checks + phase.get("native", {}).get("checks", [])
    by_voice = {p["voice"]: p for p in report.get("phases", [])}
    if len(report.get("phases", [])) == 2 and set(by_voice) == {"web", "native"}:
        report["ab_compare"] = ab_compare(by_voice["web"], by_voice["native"])
        order = " then ".join(p["voice"] for p in report["phases"])
        print(f"\n== A/B, native minus web, same song and phones ({order})")
        print(format_checks(report["ab_compare"]["checks"]))
        print("memory at matched positions: " + json.dumps(report["ab_compare"]["memory_matched"]))
        all_checks += report["ab_compare"]["checks"]
    return all_checks


def result_line(checks: list[dict]) -> tuple[str, int]:
    """The last line: PASS, or CHECK with the failed and the inconclusive checks; and the exit status."""
    bad = [c["id"] for c in checks if c["pass"] is False]
    unsure = [c["id"] for c in checks if c["pass"] == INCONCLUSIVE]
    if not bad and not unsure:
        return "RESULT PASS []", 0
    return ("RESULT CHECK " + json.dumps(bad, ensure_ascii=False)
            + (" inconclusive " + json.dumps(unsure, ensure_ascii=False) if unsure else "")), 1


# --- driving the Cube ------------------------------------------------------------


def tool(*argv: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(list(argv), capture_output=True, text=True, timeout=timeout)


def open_tv(lan_url: str, voice: str, token_file: pathlib.Path) -> Cdp:
    """Launches FireSong with the page's URL for this voice path, records its voice door from the start.

    FireSong is force-stopped first, so every phase runs in a new app process and the A/B memory
    figures compare processes of the same age.
    """
    tool(str(REPO / "tools/tvctl"), "stop", timeout=30)
    time.sleep(2)
    url = lan_url + (NATIVE_FLAG if voice == "native" else "") + "&fsdiag=1"
    launch = tool("bash", str(REPO / "scripts/firesong/cube.sh"), "launch", "--url", url,
                  "--host-token-file", str(token_file))
    if launch.returncode != 0:
        raise RuntimeError(f"launch failed: {(launch.stderr or launch.stdout).strip()[-300:]}")
    time.sleep(15)
    tool(str(REPO / "tools/tvctl"), "devtools", str(TV_CDP), timeout=30)
    tv = wait_for("the TV page's DevTools", lambda: _try_cdp(TV_CDP), 30)
    tv.call("Page.enable")
    tv.call("Page.addScriptToEvaluateOnNewDocument", {"source": DOOR_JS})
    tv.call("Page.reload")
    time.sleep(3)
    wait_for("TV diagnostics", lambda: _try_eval(tv, "!!(window.fireSongDiag && fireSongDiag.snapshot().connected)"), 60)
    return tv


def _try_cdp(port: int) -> Cdp | None:
    try:
        return Cdp(port)
    except (OSError, IndexError, ValueError, websocket.WebSocketException):
        return None


def _try_eval(tv: Cdp, expr: str):
    try:
        return tv.eval(expr)
    except (RuntimeError, websocket.WebSocketException):
        return None


def leave_tv(tv: Cdp | None) -> None:
    if tv is not None:
        tv.close()
    tool(str(REPO / "tools/tvctl"), "home", timeout=30)
    time.sleep(4)
    tool(str(REPO / "tools/tvctl"), "undevtools", str(TV_CDP), timeout=30)


def join_phones(phones: list[Cdp], gain: float) -> None:
    token = pairing_token()
    for i, phone in enumerate(phones):
        phone.call("Page.navigate", {"url": f"http://127.0.0.1:64449/m?t={token}&slot={i + 1}"})
        wait_for(f"phone {i + 1} join card", lambda: phone.eval("document.body.innerText.includes('Join as')"), 20)
        phone.eval(LOAD_MIC % {"hz": PITCHES[i], "gain": gain})
        phone.tap('document.querySelector("#phone-panel-sing input")')
        phone.call("Input.insertText", {"text": f"Load {i + 1}"})
        phone.tap('document.querySelector("#phone-panel-sing button[type=submit]")')


def phones_on_tv(tv: Cdp, count: int):
    devices = _try_eval(tv, "fireSongDiag.snapshot().devices") or []
    return devices if len(devices) >= count and not any(d["reconnecting"] for d in devices) else None


def singers_from(devices: list[dict]) -> list[dict]:
    # The server may give a phone another slot than the one its link asked
    # for (a slot can still be held for a phone that just left), so each
    # player's expected pitch comes from the phone's name, not its slot.
    singers = []
    for d in sorted(devices, key=lambda d: d["slot"]):
        m = re.search(r"Load (\d)", d["label"])
        if m:
            singers.append({"id": f"p{d['slot']}", "slot": d["slot"], "device": d["id"], "want": PITCHES[int(m.group(1)) - 1]})
    return singers


def backend_kind(probe: dict | None) -> str | None:
    """The page's voice backend: from its diagnostics, else from the voice door's state."""
    if not probe:
        return None
    b = probe.get("backend")
    if isinstance(b, str):
        return b
    if isinstance(b, dict) and isinstance(b.get("kind"), str):
        return b["kind"]
    door = probe.get("door")
    if not door:
        # No recorder on this page (a document loaded after DevTools reconnected): unknown, not web.
        return None
    return "native" if door.get("state") == "ready" else "web"


class PhaseRecorder:
    """Accumulates one phase's samples from the TV page."""

    def __init__(self, voice: str, singers: list[dict]):
        self.voice = voice
        self.singers = singers
        self.tracker = PitchTracker()
        self.data: dict = {"voice": voice, "samples": [], "mem": [], "door": [], "tap": [], "long": [],
                           "backend_seen": {}, "pitch_values": {s["id"]: [] for s in singers},
                           "pitch_frames": {s["id"]: 0 for s in singers}, "tick_errors": {}}
        self.last_delta: dict = {}
        self.clock = PageClock()

    def take(self, tv: Cdp) -> dict | None:
        self.clock.sample(lambda: tv.eval("Date.now()"))
        try:
            probe = tv.eval(f"({TICK_JS})({json.dumps([s['id'] for s in self.singers])})")
        except (RuntimeError, websocket.WebSocketException):
            return None
        if not probe:
            return None
        now = int(time.time() * 1000)
        offset = self.clock.offset()
        self.data["clock_offset_ms"] = round(offset)
        for err in probe.get("errors") or []:
            errors = self.data["tick_errors"]
            if err in errors or len(errors) < 20:
                errors[err] = errors.get(err, 0) + 1
        door = probe.get("door")
        if door:
            # The recorder stamps the TV's clock; everything else here is on the host's.
            self.data["door"].extend(on_host_clock(door.get("events") or [], offset))
            self.data["tap"].append({"t": now, **tap_summary(door.get("tap"))})
            self.data["long"].append({"t": now, **(door.get("long") or {})})
        # "unknown": no diagnostics backend and no door recorder on this page.
        kind = backend_kind(probe) or "unknown"
        self.data["backend_seen"][kind] = self.data["backend_seen"].get(kind, 0) + 1
        self.last_delta = self.tracker.update(probe.get("pitch"))
        for cid, d in self.last_delta.items():
            if cid in self.data["pitch_values"]:
                self.data["pitch_values"][cid].extend(d["new"])
                self.data["pitch_frames"][cid] += d["frames"]
        return probe


def native_slot(probe: dict, slot: int) -> dict | None:
    status = (((probe.get("door") or {}).get("last") or {}).get("status") or {}).get("slots") or []
    return next((s for s in status if s.get("slot") == slot), None)


def voice_out(voice: str, probe: dict, slot: int) -> bool:
    """The slot's voice leaves the TV: native by the app's slot output level, web by the rack's strip."""
    if voice == "native":
        st = native_slot(probe, slot)
        return bool(st and st.get("attached") and st.get("monitored") and db(st.get("outRms")) >= HEARD_OUT_DB)
    st = (probe.get("slots") or [None] * 4)[slot - 1]
    return bool(st and st.get("attached") and st.get("monitored") and not st.get("muted") and st.get("gateOpen"))


def fallback_action(tv: Cdp, rec: PhaseRecorder, action: str) -> dict:
    """Drops the native link or reloads the page mid-song; times until every singer is heard again."""
    want = "web" if action == "drop" else "native"
    started = time.time()
    if action == "drop":
        if not _try_eval(tv, "!!(window.fireSongDiag && fireSongDiag.dropNativeLink && (fireSongDiag.dropNativeLink(), true))"):
            return {"action": action, "pass": False, "note": "fireSongDiag.dropNativeLink is not available"}
    else:
        tv.call("Runtime.evaluate", {"expression": "location.reload()"})
    tuned_at: dict[str, float] = {}
    recovered = None
    kind = None
    singing = True
    while time.time() - started < 30:
        time.sleep(0.5)
        probe = rec.take(tv)
        if probe is None:
            continue
        kind = backend_kind(probe)
        # A dropped link leaves the song playing; a reload may end it, and then no frames reach a scorer.
        singing = action == "drop" or bool(cmd("load_playback_progress").get("playing"))
        now = time.time()
        ok = kind == want
        for s in rec.singers:
            delta = rec.last_delta.get(s["id"])
            if delta and delta["new"] and abs(statistics.median(delta["new"]) - s["want"]) <= PITCH_TOL_HZ:
                tuned_at[s["id"]] = now
            scored = bool(delta and delta["frames"] > 0) and now - tuned_at.get(s["id"], 0.0) <= 2.0
            ok = ok and voice_out(kind or want, probe, s["slot"]) and (scored or not singing)
        if ok:
            recovered = round(now - started, 1)
            break
    limit = RECOVERY_LIMIT_S[action]
    return {"action": action, "at_ms": int(started * 1000), "recovered_s": recovered, "backend_after": kind,
            "song_playing_after": singing, "limit_s": limit, "pass": recovered is not None and recovered <= limit}


def run_phase(cube: Cube, tv: Cdp, voice: str, singers: list[dict], args, out: pathlib.Path) -> dict:
    rec = PhaseRecorder(voice, singers)
    phase = rec.data
    phase["singers"] = singers
    phase["log_since"] = cube.clock()
    pids = cube.pids()
    phase["pids"] = {"start": sorted(pids)}
    rec.take(tv)
    cmd("add_playback_queue_entry", {"fileHash": args.song, "tempo": 1.0, "keyOffset": 0})
    cmd("request_queue_playback", {"players": [
        {"id": s["id"], "profile": None, "microphoneId": s["device"], "color": COLORS[s["slot"] - 1]}
        for s in singers]})
    wait_for("playback", lambda: cmd("load_playback_progress").get("playing"), 40)
    t0, p0 = time.time(), cmd("load_playback_progress")["positionMs"]
    phase["song_start_ms"] = int(t0 * 1000)
    next_mem = MEM_EVERY_MS
    fallback_at = args.fallback_at if args.fallback_at is not None else args.seconds / 2
    flinger_done = voice != "native"
    while time.time() - t0 < args.seconds:
        tick = time.time()
        sample = {"t": round(tick - t0, 1), "position_ms": cmd("load_playback_progress")["positionMs"]}
        sample.update(cube.load())
        probe = rec.take(tv)
        if probe:
            sample.update({"slots": probe.get("slots"), "video": probe.get("video"), "engine": probe.get("engine"),
                           "backend": backend_kind(probe)})
        if sample["position_ms"] >= next_mem:
            phase["mem"].append({"t": sample["t"], "position_ms": sample["position_ms"], **cube.meminfo()})
            next_mem = (sample["position_ms"] // MEM_EVERY_MS + 1) * MEM_EVERY_MS
        if not flinger_done and sample["position_ms"] >= 60_000:
            (out / "audio-flinger-native.txt").write_text(cube.sh("dumpsys media.audio_flinger", timeout=60))
            flinger_done = True
        phase["samples"].append(sample)
        print(json.dumps({k: sample.get(k) for k in ("t", "position_ms", "cpu", "mem_available_mb", "backend")}), flush=True)
        if args.fallback and voice == "native" and "fallback" not in phase and sample["t"] >= fallback_at:
            phase["fallback"] = fallback_action(tv, rec, args.fallback)
            print(f"fallback: {json.dumps(phase['fallback'])}", flush=True)
        time.sleep(max(0.0, TICK_S - (time.time() - tick)))
    elapsed = time.time() - t0
    played = (phase["samples"][-1]["position_ms"] - p0) / 1000 if phase["samples"] else 0
    phase["realtime_ratio"] = round(played / elapsed, 3) if elapsed else None
    phase["pitch"] = pitch_summary(phase["pitch_values"], singers, phase["pitch_frames"])
    shot = tv.call("Page.captureScreenshot", {"format": "png"}).get("data")
    if shot:
        (out / f"tv-during-song-{voice}.png").write_bytes(base64.b64decode(shot))
    phase["end_ms"] = int(time.time() * 1000)
    cmd("request_playback_command", {"command": "exit"})
    time.sleep(3)
    end_pids = cube.pids()
    phase["pids"]["end"] = sorted(end_pids)
    main_log, crash_log = cube.logs(phase["log_since"])
    logs = scan_logs(main_log, crash_log, pids | end_pids)
    (out / f"logcat-app-{voice}.txt").write_text("\n".join(logs.pop("app_lines")) + "\n")
    phase["logs"] = logs
    return phase


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--song", help="file hash of an analysed song")
    ap.add_argument("--phones", type=int, default=4, choices=range(1, 5))
    ap.add_argument("--seconds", type=int, default=90, help="song seconds sampled per phase")
    ap.add_argument("--gain", type=float, default=0.05, help="tone amplitude (0.05 is about -26 dBFS peak)")
    ap.add_argument("--voice", choices=("web", "native"), default="web",
                    help="native: the TV page opens with &voice=native (the app plays the phones)")
    ap.add_argument("--ab", action="store_true", help="the same song and phones on web, then on native")
    ap.add_argument("--native-first", action="store_true", help="with --ab: native first, then web (checks order bias)")
    ap.add_argument("--fallback", choices=("drop", "reload"),
                    help="with --voice native, mid-song: drop the native link, or reload the TV page")
    ap.add_argument("--fallback-at", type=float, help="seconds into the song (default: half of --seconds)")
    ap.add_argument("--warmup", type=float, default=WARMUP_S, help="seconds of audio before NetEQ is read")
    ap.add_argument("--analyze", metavar="REPORT", help="print the figures of a saved report.json; no Cube")
    ap.add_argument("--restore-flags", default=None,
                    help="URL flags FireSong keeps after the run, e.g. '&voice=native' (default: FIRESONG_TV_URL_FLAGS, else none)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.analyze:
        path = pathlib.Path(args.analyze)
        report = json.loads(path.read_text())
        if not report.get("phases"):
            print(f"{path} has no phases: it was written before --voice and --ab; nothing to analyze")
            return 2
        line, status = result_line(analyze(report, args.warmup))
        print(line)
        return status
    if not args.song:
        ap.error("--song is required (or --analyze REPORT)")
    if args.native_first and not args.ab:
        ap.error("--native-first goes with --ab")
    phases = (["native", "web"] if args.native_first else ["web", "native"]) if args.ab else [args.voice]
    if args.fallback and (args.ab or args.voice != "native"):
        ap.error("--fallback needs --voice native, in a run of its own (not --ab: it would skew the comparison)")
    keep_flags = restore_flags(args.restore_flags)

    serial = env_value("FIRESONG_CUBE_SERIAL")
    os.environ["FIRESONG_CUBE_SERIAL"] = serial or ""
    lan_url = f"https://{env_value('FIRESONG_LAN_IP')}:{env_value('FIRESONG_TV_PORT') or 64443}/?tv=1&mode=noraebang"
    token_file = data_path() / "firesong/host-token"
    out = pathlib.Path(args.out or f"/mnt/fast/firesong/artifacts/cube-load-{time.strftime('%Y%m%dT%H%M%S')}")
    out.mkdir(parents=True, exist_ok=True)
    cube = Cube(serial)
    report: dict = {"song": args.song, "phones": args.phones, "seconds": args.seconds, "voices": phases,
                    "fallback": args.fallback, "warmup_s": args.warmup, "restore_flags": keep_flags, "phases": []}

    start = cube.wakefulness()
    front = cube.resumed()
    if cube.playing() or (front and not front.startswith("com.amazon.tv.launcher/")):
        print(f"ABORT: TV busy ({front}, playing={cube.playing()})")
        return 2
    chromes: list[subprocess.Popen] = []
    profiles: list[str] = []
    tv: Cdp | None = None
    started_ms = int(time.time() * 1000)
    try:
        cube.sh("input keyevent KEYCODE_WAKEUP")
        time.sleep(3)
        for i in range(args.phones):
            profile = tempfile.mkdtemp(prefix=f"fs-load-phone{i + 1}-", dir=str(out))
            profiles.append(profile)
            chromes.append(subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PHONE_CDP_BASE + i}",
                                             f"--user-data-dir={profile}", "--use-fake-ui-for-media-stream",
                                             "--autoplay-policy=no-user-gesture-required", "--mute-audio",
                                             "--window-size=390,844", "about:blank"],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(3)
        phones = [wait_for(f"phone {i + 1} DevTools", lambda: _try_cdp(PHONE_CDP_BASE + i), 30) for i in range(args.phones)]
        for index, voice in enumerate(phases):
            if index:
                leave_tv(tv)
                tv = None
            tv = open_tv(lan_url, voice, token_file)
            if index == 0:
                join_phones(phones, args.gain)
            try:
                devices = wait_for(f"{args.phones} phones on the TV", lambda: phones_on_tv(tv, args.phones), 60)
            except RuntimeError:
                join_phones(phones, args.gain)
                devices = wait_for(f"{args.phones} phones on the TV", lambda: phones_on_tv(tv, args.phones), 40)
            singers = singers_from(devices)
            report.setdefault("devices", devices)
            print(f"== {voice} phase: singers {[(s['slot'], s['want']) for s in singers]}", flush=True)
            report["phases"].append(run_phase(cube, tv, voice, singers, args, out))
        time.sleep(6)
        offsets = [p["clock_offset_ms"] for p in report["phases"] if number(p.get("clock_offset_ms"))]
        report["tv_clock_offset_ms"] = round(median(offsets)) if offsets else 0
        flight = flight_rows(started_ms, int(time.time() * 1000), report["tv_clock_offset_ms"])
        for phase in report["phases"]:
            rows = [r for r in flight if phase["song_start_ms"] - 5000 <= r["t"] <= phase["end_ms"] + 5000]
            phase["song_peaks"] = [(r["t"], v) for r in rows if r.get("src") == "tv" and r.get("ev") == "sample"
                                   for v in find_values(r, "songPeak") if number(v)]
            phase["flight_events"] = [{k: v for k, v in r.items() if k != "src"} for r in rows
                                      if r.get("ev") in ("mic-backend", "native-mics", "monitor-latency", "song-peak")]
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
        if tv is not None:
            tv.close()
        tool(str(REPO / "tools/tvctl"), "home", timeout=30)
        tool(str(REPO / "tools/tvctl"), "undevtools", str(TV_CDP), timeout=30)
        time.sleep(2)
        tool(str(REPO / "tools/tvctl"), "configure", "--url", lan_url + keep_flags, "--token-file", str(token_file))
        time.sleep(3)
        tool(str(REPO / "tools/tvctl"), "home", timeout=30)
        tool(str(REPO / "tools/tvctl"), "stop", timeout=30)
        if start in ("Asleep", "Dozing"):
            for _ in range(3):
                cube.sh("input keyevent KEYCODE_SLEEP")
                time.sleep(6)
                if cube.wakefulness() == "Asleep":
                    break
        report["cube_after"] = cube.wakefulness()
        (out / "report.json").write_text(json.dumps(report, indent=1))
        print(f"report: {out / 'report.json'}")
    checks = analyze(report, args.warmup)
    (out / "report.json").write_text(json.dumps(report, indent=1))
    line, status = result_line(checks)
    print(line)
    return status


if __name__ == "__main__":
    sys.exit(main())
