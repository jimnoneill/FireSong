#!/usr/bin/env python3
"""A party rig for exploratory tests: a headless TV and headless phones on this machine.

`up` starts a headless TV page (the real TV app, on the loopback TV door, so the party
door stays shut) and one headless phone per persona, each with a fake microphone that
plays its own tone. Everything that reaches the TV's speakers goes through a tap: an
analyser reads each persona's tone out of the mix ten times a second (tones sit between
the notes of the scale, so music does not fake them) and a recorder keeps the mix.
`up` keeps running and records the run until `down`.

Each persona then drives its phone with one command per step; every step is timed
(first change on the phone, settled, the server's answer on the phone's socket, the
TV's reaction), screenshotted and journaled, and `say` adds the persona's comment:

    party-rig.py up [--personas pride,greed,...] [--tv cube [--restore-flags F]] [--voice native]
    party-rig.py <persona> open [slot|bad]      scan a slot's code (none = any free slot)
    party-rig.py <persona> look                 what the phone shows, numbered controls
    party-rig.py <persona> tap <n|"text">       tap a control
    party-rig.py <persona> type <n|"text"> <text>   replace a field's text
    party-rig.py <persona> key <Key> [count]    keyboard keys on the phone
    party-rig.py <persona> set <n|"text"> <value>   a slider's value
    party-rig.py <persona> scroll [down|up|bottom|top]
    party-rig.py <persona> mash <n|"text"> <count> [gap_ms]
    party-rig.py <persona> sing tone|quiet|loud|off|vocal|deny|allow
    party-rig.py <persona> hear [secs]          what the TV's speakers carried
    party-rig.py <persona> tv                   the TV screen, its stage and text
    party-rig.py <persona> remote <Enter|Escape|ArrowUp|...> [count]
    party-rig.py <persona> wait <secs>          watch the TV and phone, report changes
    party-rig.py <persona> offline <secs> | freeze <secs> | reload | close | crash
    party-rig.py <persona> say "<comment>"      the persona's comment on the last step
    party-rig.py judge                          summary of the run
    party-rig.py down

By default the TV is headless and the Cube is never touched: if the real TV opens
FireSong (the newest TV takes the seat), the rig stops and does not reconnect.
`up --tv cube` uses the real Fire TV Cube instead, only when it is idle (as the release
gate decides), with the song quiet, and restores it (URL, HOME, sleep, volume) at `down`.
The URL gets back the flags of `--restore-flags` or FIRESONG_TV_URL_FLAGS (e.g.
&voice=native once that is rolled out), none by default. Times the Cube's page stamps
are moved to the host's clock, so a Cube clock that is off does not skew the judge.

`up --voice native` opens the TV page with &voice=native: in the FireSong TV app the app
itself receives and plays the phones (a headless TV has no app, so it stays on the page's
own voices). The rig then records the voice door between the page and the app and the
pitch each slot's scorer receives, and `judge` counts a voice as heard while its slot
sings when the slot is monitored, its output is at least -45 dBFS and the received pitch
is within 3 Hz of the persona's tone (the page's own mix carries no native voices). A poll
where the page was on its own voices (before the door opened, or after a fall back) is
judged on the mix as before, still with the pitch. It also reports the native path's
latency, underrun, headroom and tap-delivery checks.
"""
from __future__ import annotations

import argparse
import base64
import bisect
import http.server
import importlib.util
import json
import os
import pathlib
import re
import shutil
import signal
import socketserver
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import websocket

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("cube_load_test", HERE / "cube-load-test.py")
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)

STATE = pathlib.Path(os.environ.get("FIRESONG_RIG_STATE", pathlib.Path.home() / ".cache/firesong-rig/state.json"))
TV_PORT = 9700
STEM_PORT = 9799
CACHE = pathlib.Path(os.environ.get("FIRESONG_SONG_CACHE", "/mnt/firesong-cache/songs"))
# Quarter tones (between the notes of the scale), no tone twice or three times another.
PERSONAS = {
    "pride": {"hz": 226.6, "port": 9701, "ua": "iphone"},
    "greed": {"hz": 254.2, "port": 9702, "ua": "android"},
    "lust": {"hz": 285.3, "port": 9703, "ua": "iphone"},
    "envy": {"hz": 320.2, "port": 9704, "ua": "android"},
    "gluttony": {"hz": 359.5, "port": 9705, "ua": "android"},
    "wrath": {"hz": 403.5, "port": 9706, "ua": "android"},
    "sloth": {"hz": 479.8, "port": 9707, "ua": "iphone"},
}
UAS = {
    "iphone": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
              "Version/18.6 Mobile/15E148 Safari/604.1",
    "android": "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
               "Chrome/141.0.0.0 Mobile Safari/537.36",
}
GAINS = {"tone": 0.05, "quiet": 0.0015, "loud": 0.9, "off": 0.0}
# A voice "stands out" this far above the music at its pitch; four harmonic voices through the
# TV's voice compressor sit 10-15 dB above a loud song.
HEARD_DB = 10.0
# The capture ids a party song gives its players: one per slot, or `solo` for a lone singer.
CAPTURES = ["slot-1", "slot-2", "slot-3", "slot-4", "solo"]
POLL_S = 2.0

TAP_JS = r"""
(() => {
  if (window.__hear) return;
  const TONES = __TONES__;
  const hear = window.__hear = { timeline: [], audio: [], recStart: null, media: new Set(), sources: [], ctxs: [], errors: [] };
  const origConnect = AudioNode.prototype.connect;
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { hear.media.add(this); return origPlay.apply(this, a); };
  const kind = (node) => node instanceof DynamicsCompressorNode ? 'voice' : node instanceof GainNode ? 'music' : 'other';
  const tapFor = (ctx) => {
    let tap = hear.ctxs.find((c) => c.ctx === ctx);
    if (tap) return tap;
    const input = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
    origConnect.call(input, an);
    tap = { ctx, input, an, freq: new Float32Array(an.frequencyBinCount), time: new Float32Array(an.fftSize) };
    if (__RECORD__) try {
      const rec = ctx.createMediaStreamDestination();
      origConnect.call(input, rec);
      const mr = new MediaRecorder(rec.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 96000 });
      mr.ondataavailable = (e) => { if (e.data && e.data.size) hear.audio.push(e.data); };
      mr.start(5000);
      hear.recStart = Date.now();
    } catch (e) { hear.errors.push(String(e)); }
    hear.ctxs.push(tap);
    return tap;
  };
  // Nodes that feed the speakers, and what feeds them (the app may put a mix limiter last).
  const finals = new WeakSet();
  const watch = (node, label, output) => {
    const an = node.context.createAnalyser(); an.fftSize = 2048;
    origConnect.call(node, an, output);
    hear.sources.push({ kind: label, an, buf: new Float32Array(2048), node: new WeakRef(node) });
    if (hear.sources.length > 40) hear.sources.splice(0, hear.sources.length - 40);
  };
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = origConnect.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode && !(dest.context instanceof OfflineAudioContext)) {
        const tap = tapFor(dest.context);
        origConnect.call(this, tap.input, rest[0] || 0);
        finals.add(this);
        watch(this, 'out', rest[0] || 0);
      } else if (dest instanceof AudioNode && finals.has(dest)) {
        watch(this, kind(this), rest[0] || 0);
      }
    } catch (e) { hear.errors.push(String(e)); }
    return out;
  };
  const r1 = (v) => Math.round(v * 10) / 10;
  setInterval(() => {
    const now = Date.now();
    for (const tap of hear.ctxs) {
      if (tap.ctx.state !== 'running') { hear.timeline.push({ t: now, state: tap.ctx.state }); continue; }
      tap.an.getFloatTimeDomainData(tap.time);
      tap.an.getFloatFrequencyData(tap.freq);
      let e = 0, peak = 0;
      for (const v of tap.time) { e += v * v; peak = Math.max(peak, Math.abs(v)); }
      const binHz = tap.ctx.sampleRate / tap.an.fftSize;
      const tones = {};
      for (const [name, hz] of Object.entries(TONES)) {
        const b = Math.round(hz / binHz);
        const level = Math.max(tap.freq[b - 1], tap.freq[b], tap.freq[b + 1]);
        const around = [];
        for (let k = 3; k <= 12; k++) around.push(tap.freq[b - k], tap.freq[b + k]);
        around.sort((x, y) => x - y);
        tones[name] = [r1(level), r1(level - around[Math.floor(around.length / 2)])];
      }
      const kinds = {};
      for (const s of hear.sources) {
        if (!s.node.deref()) continue;
        s.an.getFloatTimeDomainData(s.buf);
        let se = 0; for (const v of s.buf) se += v * v;
        kinds[s.kind] = (kinds[s.kind] || 0) + se / s.buf.length;
      }
      for (const k of Object.keys(kinds)) kinds[k] = kinds[k] > 0 ? r1(10 * Math.log10(kinds[k])) : -120;
      const rms = e > 0 ? r1(10 * Math.log10(e / tap.time.length)) : -120;
      hear.timeline.push({ t: now, rms, peak: Math.round(peak * 1000) / 1000, tones, kinds });
    }
    if (hear.timeline.length > 30000) hear.timeline.splice(0, 10000);
  }, __EVERY__);
  hear.take = (since) => hear.timeline.filter((x) => x.t > since);
  hear.takeAudio = async () => {
    const parts = hear.audio.splice(0);
    if (!parts.length) return '';
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  hear.mediaState = () => [...hear.media].filter((m) => m.currentSrc || m.src)
    .map((m) => ({ src: m.currentSrc || m.src, t: m.currentTime, paused: m.paused, ended: m.ended, dur: m.duration }));
})();
"""

MIC_JS = r"""
(() => {
  if (window.__fakeMic) return;
  const mic = window.__fakeMic = { opened: 0, deny: false, hz: __HZ__, gain: __GAIN__, vocal: null, ctx: null, slot: null };
  const ensure = () => {
    if (mic.ctx) return;
    const ctx = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();
    // A sawtooth has a voice's harmonics; a pure sine looks like a howl to the TV's feedback guard.
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = mic.hz;
    const tone = ctx.createGain(); tone.gain.value = mic.gain;
    osc.connect(tone).connect(dest); osc.start();
    const vocalGain = ctx.createGain(); vocalGain.connect(dest);
    Object.assign(mic, { ctx, dest, osc, tone, vocalGain });
  };
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      if (c && c.audio) {
        if (mic.deny) throw new DOMException('Permission denied', 'NotAllowedError');
        ensure(); await mic.ctx.resume(); mic.opened += 1;
        return new MediaStream([mic.dest.stream.getAudioTracks()[0].clone()]);
      }
      return real(c);
    };
  }
  mic.setTone = (hz, gain) => {
    ensure(); mic.hz = hz; mic.gain = gain;
    mic.osc.frequency.setValueAtTime(hz, mic.ctx.currentTime);
    mic.tone.gain.setValueAtTime(gain, mic.ctx.currentTime);
    return mic.state();
  };
  mic.stopVocal = () => { if (mic.vocal) { try { mic.vocal.stop(); } catch (e) {} mic.vocal = null; } };
  mic.playVocal = async (url, at, gain) => {
    ensure(); mic.stopVocal();
    const data = await (await fetch(url)).arrayBuffer();
    const buf = await mic.ctx.decodeAudioData(data);
    const src = mic.ctx.createBufferSource(); src.buffer = buf; src.connect(mic.vocalGain);
    mic.vocalGain.gain.value = gain;
    const from = at.t + (Date.now() - at.wall) / 1000;
    src.start(0, Math.max(0, from)); mic.vocal = src;
    return { dur: buf.duration, from };
  };
  mic.state = () => ({ opened: mic.opened, hz: mic.hz, gain: mic.gain, vocal: !!mic.vocal, ctx: mic.ctx ? mic.ctx.state : null, deny: mic.deny, slot: mic.slot });
  const OrigWS = window.WebSocket;
  const ws = window.__ws = [];
  const note = (dir, data) => {
    if (typeof data !== 'string') return;
    try {
      const m = JSON.parse(data);
      if (dir === 'in' && m.type === 'assign' && typeof m.slot === 'number') mic.slot = m.slot;
      if (dir === 'in' && m.type === 'slot-lost') mic.slot = null;
      ws.push({ t: performance.now(), w: Date.now(), dir, type: m.type, code: m.code, ok: m.ok, cmd: m.cmd || m.action || m.kind });
      if (ws.length > 4000) ws.splice(0, 2000);
    } catch (e) {}
  };
  class RigSocket extends OrigWS {
    constructor(...a) { super(...a); this.addEventListener('message', (e) => note('in', e.data)); }
    send(d) { note('out', d); return super.send(d); }
  }
  window.WebSocket = RigSocket;
  window.addEventListener('error', (e) => { (window.__errs = window.__errs || []).push(String(e.message)); });
  window.addEventListener('unhandledrejection', (e) => { (window.__errs = window.__errs || []).push('rejection: ' + String(e.reason)); });
})();
"""

MUT_JS = r"""
(() => {
  if (!window.__pc) {
    const pc = window.__pc = { recent: [], noisy: new Set(), t0: 0 };
    new MutationObserver((list) => {
      const t = performance.now();
      for (const m of list) pc.recent.push([t, m.target]);
      if (pc.recent.length > 6000) pc.recent.splice(0, 3000);
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  const pc = window.__pc;
  pc.t0 = performance.now();
  pc.noisy = new Set(pc.recent.filter(([t]) => t > pc.t0 - 1500).map(([, n]) => n));
  pc.wsFrom = (window.__ws || []).length;
  return pc.t0;
})()
"""

SINCE_JS = r"""
(() => {
  const pc = window.__pc;
  if (!pc) return null;
  const after = pc.recent.filter(([t, n]) => t > pc.t0 && !pc.noisy.has(n));
  // A node that keeps changing (a level meter, a countdown) is animation, not the step's effect.
  const counts = new Map();
  for (const [, n] of after) counts.set(n, (counts.get(n) || 0) + 1);
  const real = after.filter(([, n]) => counts.get(n) <= 4);
  const ws = (window.__ws || []).slice(pc.wsFrom || 0).map((f) => ({ ...f, ms: Math.round(f.t - pc.t0) }));
  return { first: real.length ? real[0][0] - pc.t0 : null, last: real.length ? real[real.length - 1][0] - pc.t0 : null,
           n: real.length, now: performance.now() - pc.t0, ws };
})()
"""

LOOK_JS = r"""
(() => {
  const vis = (el) => el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
  const dlg = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog]')].filter(vis).pop();
  const root = dlg || document.body;
  const sel = 'button, a[href], input, select, textarea, [role=tab], [role=button], [role=slider], [role=switch], [role=checkbox], [role=radio], [role=option], [role=menuitem], summary';
  document.querySelectorAll('[data-pc]').forEach((e) => e.removeAttribute('data-pc'));
  const items = []; let i = 0;
  for (const el of root.querySelectorAll(sel)) {
    if (!vis(el) || el.closest('[aria-hidden=true]')) continue;
    i += 1; el.setAttribute('data-pc', String(i));
    const r = el.getBoundingClientRect();
    const role = el.getAttribute('role') || (el.tagName === 'INPUT' ? 'input[' + el.type + ']' : el.tagName.toLowerCase());
    const labelled = el.labels && el.labels.length ? el.labels[0].innerText : '';
    const text = (el.getAttribute('aria-label') || labelled || el.innerText || (el.type === 'checkbox' ? '' : el.value) || el.placeholder || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const bits = [];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || el.checked) bits.push('on');
    if (el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'range') bits.push('value=' + JSON.stringify(el.value.slice(0, 40)));
    if (role === 'slider' || el.type === 'range') bits.push('value=' + (el.getAttribute('aria-valuenow') ?? el.value) + ' [' + (el.getAttribute('aria-valuemin') ?? el.min) + '..' + (el.getAttribute('aria-valuemax') ?? el.max) + ']');
    if (r.bottom < 0 || r.top > innerHeight) bits.push('offscreen');
    else if (r.width < 40 || r.height < 40) bits.push('small ' + Math.round(r.width) + 'x' + Math.round(r.height));
    items.push({ i, role, text, bits });
  }
  const alerts = [...document.querySelectorAll('[role=alert], [role=status], [aria-live]')].filter(vis)
    .map((e) => e.innerText.trim()).filter(Boolean);
  const heading = dlg ? (dlg.getAttribute('aria-label') || (dlg.querySelector('h1,h2,h3') || {}).innerText || 'dialog') : null;
  return { url: location.pathname + location.search.replace(/t=[0-9a-f]+/, 't=...'), dialog: heading, items,
           text: (root.innerText || '').replace(/\n{2,}/g, '\n').trim().slice(0, 1400), alerts: alerts.slice(0, 6),
           errors: (window.__errs || []).slice(-5) };
})()
"""

FIND_JS = r"""
((key, text) => {
  const vis = (el) => el.checkVisibility ? el.checkVisibility() : true;
  let el = key ? document.querySelector('[data-pc="' + key + '"]') : null;
  if (!el && text) {
    const want = text.toLowerCase();
    const sel = 'button, a[href], input, select, textarea, [role=tab], [role=button], [role=slider], [role=switch], [role=checkbox], [role=radio], [role=option], [role=menuitem], summary';
    const all = [...document.querySelectorAll(sel)].filter(vis);
    const label = (e) => (e.getAttribute('aria-label') || (e.labels && e.labels.length ? e.labels[0].innerText : '') || e.innerText || e.value || e.placeholder || '').replace(/\s+/g, ' ').trim().toLowerCase();
    el = all.find((e) => label(e) === want) || all.find((e) => label(e).startsWith(want)) || all.find((e) => label(e).includes(want));
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  const covered = top && top !== el && !el.contains(top) && !top.contains(el)
    ? (top.getAttribute('aria-label') || top.innerText || top.tagName).replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  window.__target = el;
  return { x, y, covered, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
           label: (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 80),
           tag: el.tagName, type: el.type || null, role: el.getAttribute('role') };
})
"""


# What the TV screen shows: the open overlay (the party lobby is a dialog over the library), else the page.
TV_TEXT_JS = ("(() => { const d = [...document.querySelectorAll('dialog[open]')].pop();"
              " return ((d || document.body || {}).innerText || ''); })()")


class CdpError(RuntimeError):
    pass


class Cdp:
    def __init__(self, port: int, timeout: float = 30):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5) as r:
            pages = [t for t in json.load(r) if t.get("type") == "page"]
        if not pages:
            raise CdpError(f"no page on port {port}")
        self.ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=timeout, suppress_origin=True)
        self.n = 0
        self.events: list[dict] = []

    def call(self, method: str, params: dict | None = None):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise CdpError(f"{method}: {msg['error'].get('message')}")
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)

    def eval(self, expr: str, gesture: bool = True):
        res = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True,
                                             "userGesture": gesture})
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            raise CdpError((d.get("exception") or {}).get("description") or d.get("text") or "exception")
        return res.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def now_ms() -> int:
    return int(time.time() * 1000)


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        raise SystemExit("the rig is not up (party-rig.py up)")


def journal(run: pathlib.Path, name: str, row: dict) -> None:
    with open(run / f"{name}.jsonl", "a") as f:
        f.write(json.dumps(row) + "\n")


def last_step(run: pathlib.Path, name: str) -> int:
    path = run / f"{name}.jsonl"
    if not path.exists():
        return 0
    n = 0
    for line in path.read_text().splitlines():
        try:
            n = max(n, json.loads(line).get("step", 0))
        except ValueError:
            pass
    return n


def chrome(port: int, profile: str, size: str) -> subprocess.Popen:
    return subprocess.Popen([L.CHROME, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
                             "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
                             # A fake audio output with its own clock: the host has no sound server, and a
                             # browser left on a raw device can stall its AudioContext (time stops, songs freeze).
                             "--disable-audio-output", f"--window-size={size}", "--no-first-run",
                             "--no-default-browser-check",
                             "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_cdp(port: int, timeout: float = 40) -> Cdp:
    deadline = time.time() + timeout
    while True:
        try:
            return Cdp(port)
        except Exception:
            if time.time() > deadline:
                raise
            time.sleep(0.5)


class StemHandler(http.server.BaseHTTPRequestHandler):
    """Serves vocal stems from the song cache to the rig's phones (loopback only, read only)."""

    def do_GET(self):
        name = self.path.lstrip("/")
        path = CACHE / name
        if not re.fullmatch(r"[0-9a-f]{32}_vocals_[A-Za-z#0-9]+_[0-9.]+\.mp3", name) or not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("content-type", "audio/mpeg")
        self.send_header("content-length", str(len(data)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


def cube_has_firesong() -> bool:
    serial = L.env_value("FIRESONG_CUBE_SERIAL")
    if not serial:
        return False
    try:
        cube = L.Cube(serial)
        return cube.wakefulness() == "Awake" and cube.resumed().startswith("org.firesong.tv")
    except Exception:
        return False


class CubeTv:
    """The real Fire TV Cube as the party's TV, opened and restored like the release gate does."""

    def __init__(self, quiet: float, keep_flags: str = ""):
        spec = importlib.util.spec_from_file_location("party_gate", HERE / "party-gate.py")
        self.gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.gate)
        self.serial = L.env_value("FIRESONG_CUBE_SERIAL")
        os.environ["FIRESONG_CUBE_SERIAL"] = self.serial or ""
        self.cube = L.Cube(self.serial)
        self.quiet = quiet
        self.tvctl = str(L.REPO / "tools/tvctl")
        self.lan_url = (f"https://{L.env_value('FIRESONG_LAN_IP')}:{L.env_value('FIRESONG_TV_PORT') or 64443}"
                        "/?tv=1&mode=noraebang")
        self.token_file = self.gate.data_path() / "firesong/host-token"
        self.config = self.gate.data_path() / "config.json"
        self.saved: dict = {}
        self.keep_flags = keep_flags
        self.start_state = self.cube.wakefulness()

    def busy(self) -> str | None:
        return self.gate.idle_problem(self.cube)

    def open(self, flags: str) -> Cdp:
        self.gate.set_master(self.config, self.quiet, self.saved)
        L.cmd("clear_playback_queue")
        self.gate.open_firesong(self.cube, self.tvctl, self.lan_url + flags, self.token_file)
        return Cdp(L.TV_CDP)

    def restore(self) -> None:
        for step in (["home"], ["undevtools", str(L.TV_CDP)]):
            subprocess.run([self.tvctl, *step], capture_output=True, timeout=30)
        time.sleep(2)
        subprocess.run([self.tvctl, "configure", "--url", self.lan_url + self.keep_flags, "--token-file",
                        str(self.token_file)], capture_output=True, timeout=60)
        time.sleep(3)
        for step in (["home"], ["stop"]):
            subprocess.run([self.tvctl, *step], capture_output=True, timeout=30)
        if self.saved:
            self.gate.set_master(self.config, None, self.saved)
        if self.start_state in ("Asleep", "Dozing"):
            for _ in range(3):
                self.cube.sh("input keyevent KEYCODE_SLEEP")
                time.sleep(6)
                if self.cube.wakefulness() == "Asleep":
                    break


def up(args) -> int:
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text())
            os.kill(st["pid"], 0)
            print(f"already up (pid {st['pid']}, run {st['run']})")
            return 1
        except (OSError, ValueError, KeyError):
            pass
    names = [n for n in args.personas.split(",") if n]
    run = pathlib.Path(args.run or f"/mnt/fast/firesong/artifacts/sins-party-{time.strftime('%Y%m%dT%H%M%S')}")
    (run / "shots").mkdir(parents=True, exist_ok=True)
    native = args.voice == "native"
    flags = L.NATIVE_FLAG if native else ""
    keep_flags = L.restore_flags(args.restore_flags) if args.tv == "cube" else ""
    # Kept across `down`/`up` with the same --run, so phones keep their mic identity.
    profiles = run / "profiles"
    profiles.mkdir(exist_ok=True)
    procs: dict[str, subprocess.Popen] = {}
    token = (pathlib.Path(L.env_value("NIGHTINGALE_DATA_PATH") or "/mnt/fast/firesong/data")
             / "firesong/host-token").read_text().strip()
    tones = {n: PERSONAS[n]["hz"] for n in names}
    (run / "rig.json").write_text(json.dumps({"voice": args.voice, "tv": args.tv, "personas": names, "tones": tones}))

    stems = socketserver.ThreadingTCPServer(("127.0.0.1", STEM_PORT), StemHandler)
    stems.daemon_threads = True
    threading.Thread(target=stems.serve_forever, daemon=True).start()

    cube = CubeTv(args.quiet, keep_flags) if args.tv == "cube" else None
    tv_port = L.TV_CDP if cube else TV_PORT
    tap = TAP_JS.replace("__TONES__", json.dumps(tones))
    # The Cube's CPU is small: a slower tap and no recorder there.
    tap = tap.replace("__EVERY__", "250" if cube else "100").replace("__RECORD__", "false" if cube else "true")
    if cube:
        busy = cube.busy()
        if busy:
            print(f"ABORT: TV busy ({busy})")
            stems.shutdown()
            return 2
    else:
        procs["tv"] = chrome(TV_PORT, str(profiles / "tv"), "1920,1080")
    for n in names:
        procs[n] = chrome(PERSONAS[n]["port"], str(profiles / n), "390,844")
    if cube:
        try:
            tv = cube.open(flags)
        except Exception as error:
            print(f"could not get FireSong onto the Cube: {error}", flush=True)
            cube.restore()
            for proc in procs.values():
                proc.terminate()
            stems.shutdown()
            return 3
    else:
        tv = wait_cdp(TV_PORT)
    tv.call("Page.enable")
    tv.call("Runtime.enable")
    if not cube:
        # The Fire TV Cube's WebView: 960x540 CSS pixels at 2x.
        tv.call("Emulation.setDeviceMetricsOverride", {"width": 960, "height": 540, "deviceScaleFactor": 2, "mobile": False})
    page_scripts = [tap] + ([L.DOOR_JS] if native else [])
    for source in page_scripts:
        tv.call("Page.addScriptToEvaluateOnNewDocument", {"source": source})
    phones: dict[str, Cdp] = {}
    for n in names:
        p = wait_cdp(PERSONAS[n]["port"])
        p.call("Runtime.enable")
        p.call("Page.enable")
        p.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        p.call("Emulation.setUserAgentOverride", {"userAgent": UAS[PERSONAS[n]["ua"]]})
        p.call("Page.addScriptToEvaluateOnNewDocument",
               {"source": MIC_JS.replace("__HZ__", str(PERSONAS[n]["hz"])).replace("__GAIN__", str(GAINS["tone"]))})
        phones[n] = p
    since = now_ms()
    if cube:
        tv.call("Page.reload")
    else:
        tv.call("Page.navigate", {"url": f"http://127.0.0.1:64448/?tv=1&mode=noraebang&fsdiag=1&host={token}{flags}"})
    L.wait_for("TV seat", lambda: tv.eval("!!(window.fireSongDiag && fireSongDiag.snapshot().connected)"), 60)
    # Host clock minus the TV page's: the Cube keeps its own clock; the headless TV shares the host's.
    clock = L.PageClock()
    if cube:
        for _ in range(5):
            clock.sample(lambda: tv.eval("Date.now()", gesture=False))
    offset = round(clock.offset())
    state = {"pid": os.getpid(), "run": str(run), "since_ms": since, "personas": names, "tones": tones,
             "tv_port": tv_port, "tv": "cube" if cube else "headless", "ports": {n: PERSONAS[n]["port"] for n in names},
             "clock_offset_ms": offset}
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state))
    print(f"up: TV + {len(names)} phones, run {run}", flush=True)

    stop = {"why": None}
    signal.signal(signal.SIGTERM, lambda *a: stop.update(why="down"))
    signal.signal(signal.SIGINT, lambda *a: stop.update(why="down"))
    last_hear, last_audio, last_cube, last_phone = since - offset, 0.0, 0.0, 0.0
    tv_down_since = None
    pitch = L.PitchTracker()
    audio_file = open(run / "tv-audio.webm", "ab")
    try:
        while stop["why"] is None:
            t = time.time()
            try:
                if cube:
                    clock.sample(lambda: tv.eval("Date.now()", gesture=False))
                    offset = round(clock.offset())
                rows = tv.eval(f"window.__hear ? __hear.take({last_hear}) : []", gesture=False) or []
                if rows:
                    last_hear = rows[-1]["t"]
                    with open(run / "hear.jsonl", "a") as f:
                        for r in rows:
                            # Journaled on the host's clock (the cursor above stays on the page's).
                            f.write(json.dumps({**r, "t": r["t"] + offset} if offset else r) + "\n")
                snap = tv.eval("window.fireSongDiag ? {snap: fireSongDiag.snapshot(), stage: fireSongDiag.stage(),"
                               " media: window.__hear ? __hear.mediaState() : []} : null", gesture=False)
                if native:
                    try:
                        probe = tv.eval(f"({L.TICK_JS})({json.dumps(CAPTURES)})", gesture=False)
                    except CdpError as error:
                        probe = None
                        journal(run, "rig", {"t": now_ms(), "error": f"native probe: {str(error)[:200]}"})
                    if probe:
                        record_native(run, probe, pitch, offset)
                if snap is not None:
                    journal(run, "tv", {"t": now_ms(), **snap, **({"clock_offset_ms": offset} if cube else {})})
                    if snap["snap"].get("connected"):
                        tv_down_since = None
                    elif tv_down_since is None:
                        tv_down_since = t
                if t - last_audio > 10:
                    last_audio = t
                    b64 = tv.eval("window.__hear ? __hear.takeAudio() : ''", gesture=False)
                    if b64:
                        audio_file.write(base64.b64decode(b64))
                        audio_file.flush()
                for ev in tv.events:
                    if ev["method"] in ("Runtime.exceptionThrown", "Runtime.consoleAPICalled"):
                        p = ev["params"]
                        if ev["method"] == "Runtime.consoleAPICalled" and p.get("type") not in ("error", "warning"):
                            continue
                        journal(run, "console", {"t": now_ms(), "who": "tv", "ev": ev["method"],
                                                 "text": json.dumps(p)[:600]})
                tv.events.clear()
            except Exception as error:
                journal(run, "rig", {"t": now_ms(), "error": f"tv poll: {error}"})
                try:
                    tv.close()
                    tv = Cdp(tv_port)
                    tv.call("Runtime.enable")
                    # Scripts for new documents belong to the DevTools session that added them: add them
                    # again so the next page load is recorded too. Not run on the current page: a door
                    # recorder installed after the door opened would see no door and read as web.
                    tv.call("Page.enable")
                    for source in page_scripts:
                        tv.call("Page.addScriptToEvaluateOnNewDocument", {"source": source})
                except Exception:
                    pass
            if t - last_phone > 5:
                last_phone = t
                for n, p in phones.items():
                    try:
                        st = p.eval("({mic: window.__fakeMic ? __fakeMic.state() : null,"
                                    " live: document.body ? document.body.innerText.includes('Live on the TV') : false,"
                                    " full: document.body ? document.body.innerText.includes('mics are in use') : false,"
                                    " url: location.pathname})", gesture=False)
                        journal(run, "phones", {"t": now_ms(), "who": n, **(st or {})})
                        for ev in p.events:
                            if ev["method"] in ("Runtime.exceptionThrown", "Runtime.consoleAPICalled"):
                                prm = ev["params"]
                                if ev["method"] == "Runtime.consoleAPICalled" and prm.get("type") not in ("error", "warning"):
                                    continue
                                journal(run, "console", {"t": now_ms(), "who": n, "ev": ev["method"],
                                                         "text": json.dumps(prm)[:600]})
                        p.events.clear()
                    except Exception as error:
                        journal(run, "phones", {"t": now_ms(), "who": n, "error": str(error)[:200]})
            if cube and t - last_cube > 20:
                last_cube = t
                try:
                    journal(run, "cube", {"t": now_ms(), **cube.cube.cpu_and_mem()})
                except Exception as error:
                    journal(run, "rig", {"t": now_ms(), "error": f"cube sample: {error}"})
            if not cube and t - last_cube > 30:
                last_cube = t
                if cube_has_firesong():
                    stop["why"] = "the real TV opened FireSong"
                    break
            if tv_down_since is not None and t - tv_down_since > 20:
                journal(run, "rig", {"t": now_ms(), "note": "TV seat lost for 20 s"})
                tv_down_since = t
            time.sleep(max(0.0, POLL_S - (time.time() - t)))
    finally:
        why = stop["why"] or "ended"
        journal(run, "rig", {"t": now_ms(), "stopped": why})
        try:
            b64 = tv.eval("window.__hear ? __hear.takeAudio() : ''", gesture=False)
            if b64:
                audio_file.write(base64.b64decode(b64))
        except Exception:
            pass
        audio_file.close()
        for proc in procs.values():
            proc.terminate()
        for proc in procs.values():
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        stems.shutdown()
        if cube:
            cube.restore()
        try:
            STATE.unlink()
        except OSError:
            pass
        print(f"down: {why}", flush=True)
    return 0


def record_native(run: pathlib.Path, probe: dict, pitch: L.PitchTracker, offset: int = 0) -> None:
    """Journals the voice door's traffic (on the host's clock) and the pitch each singing capture's scorer received.

    The summary row and the pitch row of one poll share their time, so the judge knows which
    backend each pitch row was heard on.
    """
    t = now_ms()
    door = probe.get("door") or {}
    with open(run / "native.jsonl", "a") as f:
        for e in L.on_host_clock(door.get("events") or [], offset):
            f.write(json.dumps(e) + "\n")
        f.write(json.dumps({"t": t, "tap": L.tap_summary(door.get("tap")), "long": door.get("long") or {},
                            "ice": door.get("ice"), "state": door.get("state"), "backend": L.backend_kind(probe),
                            "clock_offset_ms": offset, "errors": probe.get("errors") or []}) + "\n")
    captures = {cid: d for cid, d in pitch.update(probe.get("pitch")).items() if d["frames"] or d["voiced"]}
    if captures:
        stage = probe.get("stage") or {}
        journal(run, "pitch", {"t": t, "state": stage.get("state"), "singers": stage.get("singers"), "captures": captures})


def down(_args) -> int:
    st = load_state()
    os.kill(st["pid"], signal.SIGTERM)
    for _ in range(40):
        if not STATE.exists():
            print("down")
            return 0
        time.sleep(0.5)
    print("still stopping")
    return 1


def fmt_look(name: str, look: dict | None, shot: str | None) -> str:
    if look is None:
        return f"[{name}] (no page)"
    lines = [f"[{name}] {look['url']}" + (f"  DIALOG: {look['dialog']}" if look.get("dialog") else "")
             + (f"  screenshot: {shot}" if shot else "")]
    if look.get("alerts"):
        lines.append("status: " + " | ".join(a.replace("\n", " ")[:160] for a in look["alerts"]))
    if look.get("errors"):
        lines.append("PAGE ERRORS: " + " | ".join(look["errors"]))
    lines.append("text: " + look["text"].replace("\n", " / ")[:1200])
    items = look["items"]
    for it in items[:60]:
        lines.append(f"  {it['i']:>2} {it['role']} \"{it['text']}\"" + (f"  ({', '.join(it['bits'])})" if it["bits"] else ""))
    if len(items) > 60:
        lines.append(f"  ... {len(items) - 60} more")
    return "\n".join(lines)


class Persona:
    def __init__(self, name: str):
        self.st = load_state()
        if name not in self.st["personas"]:
            raise SystemExit(f"unknown persona {name}; up with {self.st['personas']}")
        self.name = name
        self.run = pathlib.Path(self.st["run"])
        self.phone = Cdp(self.st["ports"][name])
        self._tv = None

    @property
    def tv(self) -> Cdp:
        if self._tv is None:
            self._tv = Cdp(self.st["tv_port"])
        return self._tv

    def tv_key(self):
        try:
            stage = self.tv.eval("window.fireSongDiag ? fireSongDiag.stage() : null", gesture=False) or {}
        except Exception:
            return None
        stage = {k: v for k, v in stage.items() if k != "countdownSecs"}
        text = ""
        if stage.get("state") in (None, "lobby", "reveal", "starting"):
            text = re.sub(r"\d+", "#", self.tv.eval(TV_TEXT_JS, gesture=False) or "")
        return json.dumps(stage, sort_keys=True) + "|" + text

    def shot(self, label: str) -> str | None:
        try:
            data = self.phone.call("Page.captureScreenshot", {"format": "jpeg", "quality": 60})["data"]
        except Exception:
            return None
        path = self.run / "shots" / f"{self.name}-{label}.jpg"
        path.write_bytes(base64.b64decode(data))
        return str(path)

    def tv_shot(self, label: str) -> str | None:
        try:
            data = self.tv.call("Page.captureScreenshot", {"format": "jpeg", "quality": 55,
                                                           "clip": {"x": 0, "y": 0, "width": 960, "height": 540, "scale": 0.5}})["data"]
        except Exception:
            return None
        path = self.run / "shots" / f"tv-{self.name}-{label}.jpg"
        path.write_bytes(base64.b64decode(data))
        return str(path)

    def look(self):
        try:
            return self.phone.eval(LOOK_JS, gesture=False)
        except Exception as error:
            return {"url": "?", "dialog": None, "items": [], "text": f"(page not readable: {error})", "alerts": [], "errors": []}

    def find(self, target: str):
        key = target if target.isdigit() else None
        text = None if key else target
        if key:
            saved = self.saved_items().get(key)
            text = saved
        return self.phone.eval(f"({FIND_JS})({json.dumps(key)}, {json.dumps(text)})")

    def saved_items(self) -> dict:
        try:
            return json.loads((self.run / f".{self.name}-items.json").read_text())
        except (OSError, ValueError):
            return {}

    def save_items(self, look) -> None:
        if look:
            (self.run / f".{self.name}-items.json").write_text(json.dumps({str(i["i"]): i["text"] for i in look["items"]}))

    def click(self, x: float, y: float) -> None:
        for kind in ("mousePressed", "mouseReleased"):
            self.phone.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})

    def act(self, action: str, args: list, fn, watch_tv: bool = True, settle_cap: float = 10.0) -> int:
        step = last_step(self.run, self.name) + 1
        try:
            self.phone.eval(MUT_JS, gesture=False)
        except Exception:
            pass
        before = self.tv_key() if watch_tv else None
        t_wall = now_ms()
        t0 = time.time()
        detail = fn() or {}
        self.tv_ms = None
        timing = self.settle(settle_cap, t0, before)
        if before is not None and self.tv_ms is None:
            deadline = time.time() + 3.0
            while time.time() < deadline and self.tv_ms is None:
                self.poll_tv(t0, before)
                time.sleep(0.1)
        tv_ms = self.tv_ms
        look = self.look()
        self.save_items(look)
        shot = self.shot(f"{step:03d}")
        row = {"step": step, "t": t_wall, "persona": self.name, "action": action, "args": args, **detail, **timing,
               "tv_ms": tv_ms, "shot": shot, "url": look.get("url"), "dialog": look.get("dialog"),
               "alerts": look.get("alerts"), "errors": look.get("errors")}
        journal(self.run, self.name, row)
        print(self.report(row))
        print(fmt_look(self.name, look, shot))
        return 0

    def poll_tv(self, t0: float, before) -> None:
        if before is not None and self.tv_ms is None and self.tv_key() != before:
            self.tv_ms = int((time.time() - t0) * 1000)

    def settle(self, cap: float, t0: float = 0.0, before=None) -> dict:
        deadline = time.time() + cap
        res = None
        while time.time() < deadline:
            self.poll_tv(t0, before)
            try:
                res = self.phone.eval(SINCE_JS, gesture=False)
            except Exception:
                time.sleep(0.2)
                continue
            if res is None:
                break
            if res["last"] is not None and res["now"] - res["last"] > 400:
                break
            if res["first"] is None and res["now"] > 1500:
                break
            time.sleep(0.05)
        if not res:
            return {"first_ms": None, "settled_ms": None, "ws": []}
        ws = [f for f in res.get("ws", []) if f.get("type") not in ("ping", "pong", "signal", "ice", "offer", "answer", "candidate")]
        return {"first_ms": None if res["first"] is None else int(res["first"]),
                "settled_ms": None if res["last"] is None else int(res["last"]),
                "ws": [{"ms": f["ms"], "dir": f["dir"], "type": f.get("type"), "code": f.get("code"), "ok": f.get("ok")}
                       for f in ws][:20]}

    def report(self, row: dict) -> str:
        bits = [f"step {row['step']} {row['action']} {' '.join(map(str, row['args']))}".strip()]
        if row.get("label"):
            bits.append(f"on \"{row['label']}\"")
        if row.get("covered"):
            bits.append(f"COVERED BY \"{row['covered']}\"")
        if row.get("disabled"):
            bits.append("(control was disabled)")
        if row.get("first_ms") is None:
            bits.append("phone: no visible change")
        else:
            bits.append(f"phone: first change {row['first_ms']} ms, settled {row['settled_ms']} ms")
        frames = [f"{f['dir']} {f['type']}{'(' + str(f['code']) + ')' if f.get('code') else ''}"
                  f"{'' if f.get('ok') is None else (' ok' if f['ok'] else ' REFUSED')} {f['ms']} ms" for f in row.get("ws") or []]
        if frames:
            bits.append("socket: " + ", ".join(frames[:8]))
        if row.get("tv_ms") is not None:
            bits.append(f"TV reacted {row['tv_ms']} ms")
        if row.get("load_ms") is not None:
            bits.append(f"page shown after {row['load_ms']} ms")
        for k in ("result", "note"):
            if row.get(k):
                bits.append(f"{k}: {row[k]}")
        return " | ".join(bits)


def cmd_persona(name: str, argv: list[str]) -> int:
    if not argv:
        raise SystemExit("command missing")
    p = Persona(name)
    c, rest = argv[0], argv[1:]

    if c == "say":
        text = " ".join(rest).strip()
        step = last_step(p.run, name)
        journal(p.run, name, {"step": step, "t": now_ms(), "persona": name, "say": text})
        print(f"[{name}] noted on step {step}")
        return 0

    if c == "look":
        return p.act("look", [], lambda: None, watch_tv=False, settle_cap=0.1)

    if c == "open":
        token = L.pairing_token()
        if rest and rest[0] == "bad":
            url = "http://127.0.0.1:64449/m?t=" + "0" * 32
        else:
            url = f"http://127.0.0.1:64449/m?t={token}" + (f"&slot={rest[0]}" if rest else "")

        def go():
            t0 = time.time()
            p.phone.call("Page.navigate", {"url": url})
            shown = page_shown(p, t0)
            return {"note": "opened the join link" + (f" for slot {rest[0]}" if rest else ""), "load_ms": shown}
        return p.act("open", rest, go)

    if c in ("tap", "mash"):
        target = rest[0]
        count = int(rest[1]) if c == "mash" and len(rest) > 1 else 1
        gap = int(rest[2]) if c == "mash" and len(rest) > 2 else 60

        def go():
            found = p.find(target)
            if not found:
                return {"result": f"nothing to tap matching {target!r}"}
            for i in range(count):
                p.click(found["x"], found["y"])
                if i + 1 < count:
                    time.sleep(gap / 1000)
            return {"label": found["label"], "covered": found["covered"], "disabled": found["disabled"]}
        return p.act(c, rest, go)

    if c == "type":
        target, text = rest[0], " ".join(rest[1:])

        def go():
            found = p.find(target)
            if not found:
                return {"result": f"no field matching {target!r}"}
            p.phone.eval("(() => { const el = window.__target; el.focus(); if (el.select) el.select(); })()")
            if text:
                p.phone.call("Input.insertText", {"text": text})
            else:
                p.phone.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Backspace", "code": "Backspace",
                                                       "windowsVirtualKeyCode": 8})
                p.phone.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Backspace", "code": "Backspace",
                                                       "windowsVirtualKeyCode": 8})
            return {"label": found["label"], "note": f"typed {len(text)} chars"}
        return p.act("type", rest, go)

    if c == "key":
        key = rest[0]
        count = int(rest[1]) if len(rest) > 1 else 1

        def go():
            send_keys(p.phone, key, count)
            return {"note": f"{key} x{count}"}
        return p.act("key", rest, go)

    if c == "set":
        target, value = rest[0], rest[1]

        def go():
            found = p.find(target)
            if not found:
                return {"result": f"no slider matching {target!r}"}
            out = p.phone.eval(
                "((v) => { const el = window.__target;"
                " if (el.tagName === 'INPUT') { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
                " set.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); return 'input'; }"
                " el.focus(); return 'aria'; })" + f"({json.dumps(value)})")
            if out == "aria":
                info = p.phone.eval("(() => { const el = window.__target; return {now: +el.getAttribute('aria-valuenow'),"
                                    " min: +el.getAttribute('aria-valuemin'), max: +el.getAttribute('aria-valuemax')}; })()")
                delta = float(value) - info["now"]
                send_keys(p.phone, "ArrowRight" if delta > 0 else "ArrowLeft", int(abs(delta)))
            return {"label": found["label"], "note": f"set to {value}"}
        return p.act("set", rest, go)

    if c == "scroll":
        where = rest[0] if rest else "down"

        def go():
            p.phone.eval(
                "((w) => { const els = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 20 &&"
                " ['auto', 'scroll'].includes(getComputedStyle(e).overflowY));"
                " const box = els.sort((a, b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement;"
                " const by = {down: box.clientHeight * 0.8, up: -box.clientHeight * 0.8, bottom: 1e9, top: -1e9}[w] || 600;"
                " box.scrollBy({top: by}); if (box !== document.scrollingElement) window.scrollBy({top: by}); })" + f"({json.dumps(where)})")
            time.sleep(0.4)
            return {"note": f"scrolled {where}"}
        return p.act("scroll", rest, go, watch_tv=False)

    if c == "sing":
        mode = rest[0] if rest else "tone"

        def go():
            if mode == "deny":
                p.phone.eval("window.__fakeMic && (__fakeMic.deny = true)")
                return {"note": "the next mic request will be refused (permission denied)"}
            if mode == "allow":
                p.phone.eval("window.__fakeMic && (__fakeMic.deny = false)")
                return {"note": "mic permission allowed again"}
            if mode == "vocal":
                media = p.tv.eval("window.__hear ? __hear.mediaState() : []", gesture=False) or []
                inst = next((m for m in media if "instrumental" in m["src"] and not m["ended"]), None)
                if inst is None:
                    return {"result": "no song is playing on the TV"}
                m = re.search(r"([0-9a-f]{32})_instrumental_([A-Za-z#0-9]+)_([0-9.]+)\.mp3", urllib.parse.unquote(inst["src"]))
                if m is None:
                    return {"result": f"cannot tell the song from {inst['src'][-80:]}"}
                name_ = f"{m.group(1)}_vocals_{m.group(2)}_{m.group(3)}.mp3"
                at = {"t": inst["t"], "wall": now_ms()}
                p.phone.eval("window.__fakeMic.setTone(window.__fakeMic.hz, 0)")
                out = p.phone.eval(f"window.__fakeMic.playVocal({json.dumps(f'http://127.0.0.1:{STEM_PORT}/{name_}')}, "
                                   f"{json.dumps(at)}, 0.6)")
                return {"note": f"singing the real vocal from {out['from']:.1f} s of {out['dur']:.0f} s"}
            gain = GAINS.get(mode)
            if gain is None:
                return {"result": f"unknown sing mode {mode}"}
            p.phone.eval("window.__fakeMic && window.__fakeMic.stopVocal()")
            st = p.phone.eval(f"window.__fakeMic ? __fakeMic.setTone({PERSONAS[name]['hz']}, {gain}) : null")
            return {"note": f"mic {mode} (tone {PERSONAS[name]['hz']} Hz, gain {gain})", "mic": st}
        return p.act("sing", rest, go, watch_tv=False, settle_cap=0.5)

    if c == "hear":
        secs = float(rest[0]) if rest else 3.0
        time.sleep(min(secs, 1.0))
        print(hear_report(p, secs))
        step = last_step(p.run, name) + 1
        journal(p.run, name, {"step": step, "t": now_ms(), "persona": name, "action": "hear", "args": rest,
                              "result": hear_report(p, secs, compact=True)})
        return 0

    if c == "tv":
        step = last_step(p.run, name) + 1
        info = p.tv.eval("({stage: window.fireSongDiag ? fireSongDiag.stage() : null,"
                         " devices: window.fireSongDiag ? fireSongDiag.snapshot().devices : [],"
                         " text: " + TV_TEXT_JS + ".replace(/\\n{2,}/g, '\\n').slice(0, 1500)})",
                         gesture=False) or {}
        shot = p.tv_shot(f"{step:03d}")
        print(f"[TV] stage={json.dumps(info.get('stage'))} screenshot: {shot}")
        print("phones on the TV: " + ", ".join(f"slot {d['slot']} {d['label']}"
                                               for d in info.get("devices") or []))
        print("TV text: " + (info.get("text") or "").replace("\n", " / "))
        journal(p.run, name, {"step": step, "t": now_ms(), "persona": name, "action": "tv", "args": [],
                              "result": {"stage": info.get("stage")}, "shot": shot})
        return 0

    if c == "remote":
        key = rest[0]
        count = int(rest[1]) if len(rest) > 1 else 1

        def go():
            send_keys(p.tv, key, count, gap=0.15)
            return {"note": f"TV remote {key} x{count}"}
        return p.act("remote", rest, go)

    if c == "wait":
        secs = min(float(rest[0]) if rest else 10.0, 540)
        step = last_step(p.run, name) + 1
        events, last = [], None
        t0 = time.time()
        while time.time() - t0 < secs:
            try:
                stage = p.tv.eval("window.fireSongDiag ? fireSongDiag.stage() : null", gesture=False) or {}
            except Exception:
                stage = {}
            key = (stage.get("state"), stage.get("title"), tuple(stage.get("singers") or []))
            if key != last:
                events.append(f"+{time.time() - t0:.1f}s TV {stage.get('state')}"
                              + (f" '{stage.get('title')}' singers {stage.get('singers')}" if stage.get("title") else ""))
                last = key
            time.sleep(0.25)
        look = p.look()
        p.save_items(look)
        shot = p.shot(f"{step:03d}")
        print(f"step {step} wait {secs:.0f}s | " + "; ".join(events))
        print(fmt_look(name, look, shot))
        journal(p.run, name, {"step": step, "t": now_ms(), "persona": name, "action": "wait", "args": rest,
                              "result": events, "shot": shot, "alerts": look.get("alerts")})
        return 0

    if c in ("offline", "freeze"):
        secs = min(float(rest[0]) if rest else 10.0, 540)

        def go():
            if c == "offline":
                p.phone.call("Network.enable")
                p.phone.call("Network.emulateNetworkConditions", {"offline": True, "latency": 0,
                                                                  "downloadThroughput": 0, "uploadThroughput": 0})
            else:
                p.phone.call("Page.setWebLifecycleState", {"state": "frozen"})
            seen = []
            t0 = time.time()
            while time.time() - t0 < secs:
                try:
                    devs = p.tv.eval("window.fireSongDiag ? fireSongDiag.snapshot().devices : []", gesture=False) or []
                    seen.append((round(time.time() - t0), [(d["slot"], d["label"], d["reconnecting"]) for d in devs]))
                except Exception:
                    pass
                time.sleep(min(5.0, secs / 4))
            if c == "offline":
                p.phone.call("Network.emulateNetworkConditions", {"offline": False, "latency": 0,
                                                                  "downloadThroughput": -1, "uploadThroughput": -1})
            else:
                p.phone.call("Page.setWebLifecycleState", {"state": "active"})
            t1 = time.time()
            back = None
            while time.time() - t1 < 30:
                try:
                    if p.phone.eval("document.body.innerText.includes('Live on the TV')", gesture=False):
                        back = round(time.time() - t1, 1)
                        break
                except Exception:
                    pass
                time.sleep(0.25)
            return {"note": f"{c} {secs:.0f}s; TV saw: {seen[-1][1] if seen else '?'}",
                    "result": f"live again after {back} s" if back is not None else "not live 30 s after coming back"}
        return p.act(c, rest, go, settle_cap=1.0)

    if c in ("reload", "close", "crash", "back"):
        def go():
            if c == "reload":
                t0 = time.time()
                p.phone.call("Page.reload")
                return {"note": c, "load_ms": page_shown(p, t0)}
            elif c == "close":
                p.phone.call("Page.navigate", {"url": "about:blank"})
                time.sleep(0.5)
            elif c == "back":
                p.phone.eval("history.back()")
                time.sleep(1.0)
            else:
                try:
                    p.phone.call("Page.crash")
                except Exception:
                    pass
                time.sleep(1.0)
            return {"note": c}
        return p.act(c, rest, go)

    raise SystemExit(f"unknown command {c}")


def page_shown(p: "Persona", t0: float) -> int | None:
    """Milliseconds until the page has loaded and shows a button."""
    time.sleep(0.2)
    while time.time() - t0 < 20:
        try:
            if p.phone.eval("document.readyState === 'complete' && !!document.querySelector('button')", gesture=False):
                return int((time.time() - t0) * 1000)
        except Exception:
            pass
        time.sleep(0.05)
    return None


def send_keys(cdp: Cdp, key: str, count: int, gap: float = 0.05) -> None:
    codes = {"Enter": 13, "Escape": 27, "ArrowUp": 38, "ArrowDown": 40, "ArrowLeft": 37, "ArrowRight": 39,
             " ": 32, "space": 32, "Tab": 9, "Backspace": 8, "Home": 36, "End": 35}
    k = " " if key == "space" else key
    code = {" ": "Space"}.get(k, k)
    for i in range(count):
        for kind in ("keyDown", "keyUp"):
            cdp.call("Input.dispatchKeyEvent", {"type": kind, "key": k, "code": code,
                                                "windowsVirtualKeyCode": codes.get(key, 0),
                                                **({"text": "\r"} if k == "Enter" and kind == "keyDown" else {})})
        if i + 1 < count:
            time.sleep(gap)


def tone_db(row: dict, name: str, index: int) -> float:
    """A persona's tone level (index 0) or its lift over the music (1) in a hear sample.

    A silent mix makes the analyser read -Infinity, which arrives as null: that is -120 dB.
    A persona missing from the sample reads 0 dB, as before.
    """
    pair = (row.get("tones") or {}).get(name, [0, 0])
    value = pair[index] if isinstance(pair, list) and len(pair) > index else None
    return value if isinstance(value, (int, float)) else -120.0


def hear_report(p: Persona, secs: float, compact: bool = False):
    # The page stamps its own clock: host time minus the host-minus-page offset.
    since = now_ms() - int(secs * 1000) - int(p.st.get("clock_offset_ms") or 0)
    rows = p.tv.eval(f"window.__hear ? __hear.take({since}) : []", gesture=False) or []
    rows = [r for r in rows if "tones" in r]
    if not rows:
        return "the TV's speakers carried nothing (no audio running)" if not compact else {"samples": 0}
    tones = p.st["tones"]
    out = {"samples": len(rows), "total_db": round(statistics.median(r["rms"] for r in rows), 1),
           "peak": max(r["peak"] for r in rows)}
    kinds: dict[str, list] = {}
    for r in rows:
        for k, v in (r.get("kinds") or {}).items():
            kinds.setdefault(k, []).append(v)
    out["by_source_db"] = {k: round(statistics.median(v), 1) for k, v in kinds.items()}
    heard = {}
    for n in tones:
        lift = [tone_db(r, n, 1) for r in rows if n in r["tones"]]
        level = [tone_db(r, n, 0) for r in rows if n in r["tones"]]
        share = sum(1 for v in lift if v >= HEARD_DB) / len(lift) if lift else 0
        heard[n] = {"heard_share": round(share, 2), "level_db": round(statistics.median(level), 1),
                    "stands_out_db": round(statistics.median(lift), 1)}
    out["voices"] = heard
    mine = None
    try:
        mine = p.tv.eval("(() => { if (!window.fireSongDiag) return null; const out = {};"
                         " for (const s of [1,2,3,4]) out[s] = fireSongDiag.slotStatus(s); return out; })()", gesture=False)
    except Exception:
        pass
    if compact:
        return out
    lines = [f"TV speakers over the last {secs:.0f} s ({len(rows)} samples): mix {out['total_db']} dBFS, peak {out['peak']}"
             + (" (CLIPPING)" if out["peak"] >= 0.99 else ""),
             "by source: " + ", ".join(f"{k} {v} dB" for k, v in out["by_source_db"].items())]
    for n, h in heard.items():
        tag = " <- you" if n == p.name else ""
        verdict = "HEARD" if h["heard_share"] >= 0.5 else ("faint/partly" if h["heard_share"] > 0 else "not heard")
        lines.append(f"  {n:<9} {tones[n]:>6} Hz: {verdict} ({int(h['heard_share'] * 100)}% of samples, "
                     f"{h['level_db']} dB, {h['stands_out_db']} dB above the music){tag}")
    if mine:
        lines.append("mic slots on the TV: " + json.dumps(mine)[:900])
    return "\n".join(lines)


def rows_of(run: pathlib.Path, name: str) -> list[dict]:
    path = run / f"{name}.jsonl"
    rows = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def native_voices(phones: list[dict], events: list[dict], pitch_rows: list[dict], summaries=(), hear=()) -> dict:
    """Per persona, while its phone was live with its tone on and its slot was singing: was it heard?

    Each pitch row is judged on the backend the page used in that poll (the summary row of the
    same poll). Native: the slot is monitored, the app's output for the slot is at least
    L.HEARD_OUT_DB dBFS, and the pitch the slot's scorer received is within L.PITCH_TOL_HZ of the
    persona's tone. Web (before the door opened, or after a fall back): the persona's tone stands
    HEARD_DB out of the TV's mix over that poll, and the pitch matches. `out_share_live` is the share
    of the persona's live time (lobby too) its voice left the TV natively.
    """
    statuses = sorted(((e["t"], {s.get("slot"): s for s in e["m"].get("slots") or []}) for e in events
                       if e.get("dir") == "in" and (e.get("m") or {}).get("t") == "status"), key=lambda x: x[0])
    status_t = [t for t, _ in statuses]
    kinds = sorted(((r["t"], r.get("backend")) for r in summaries if L.number(r.get("t"))), key=lambda x: x[0])
    kind_t = [t for t, _ in kinds]
    hears = sorted((h for h in hear if L.number(h.get("t"))), key=lambda h: h["t"])
    hear_t = [h["t"] for h in hears]

    def status_at(t: int, slot: int) -> dict | None:
        i = bisect.bisect_left(status_t, t)
        near = [j for j in (i - 1, i) if 0 <= j < len(statuses) and abs(statuses[j][0] - t) <= 3000]
        return statuses[min(near, key=lambda j: abs(statuses[j][0] - t))][1].get(slot) if near else None

    def backend_at(t: int) -> str | None:
        i = bisect.bisect_right(kind_t, t)
        return kinds[i - 1][1] if i and t - kinds[i - 1][0] <= 3000 else None

    def mix_heard(t: int, name: str) -> bool:
        rows = hears[bisect.bisect_right(hear_t, t - POLL_S * 1000):bisect.bisect_right(hear_t, t)]
        return bool(rows) and statistics.median(tone_db(h, name, 1) for h in rows) >= HEARD_DB

    def out_ok(st: dict | None) -> bool:
        return bool(st and st.get("monitored") and L.db(st.get("outRms")) >= L.HEARD_OUT_DB)

    voices = {}
    for name in sorted({p["who"] for p in phones}):
        hz = PERSONAS[name]["hz"]
        mine = sorted((p for p in phones if p["who"] == name), key=lambda p: p["t"])
        windows = []
        for a, b in zip(mine, mine[1:]):
            mic = a.get("mic") or {}
            if a.get("live") and (mic.get("gain") or 0) >= 0.01 and not mic.get("vocal") and mic.get("slot"):
                windows.append((a["t"] + 1000, b["t"], mic["slot"]))
        live = [by_slot.get(slot) for a, b, slot in windows
                for _, by_slot in statuses[bisect.bisect_left(status_t, a):bisect.bisect_right(status_t, b)]]
        why = {"not_monitored": 0, "quiet": 0, "mix_quiet": 0, "pitch_off": 0}
        on: dict[str, int] = {}
        sung, heard, got, gaps, run_start, last_sung = 0, 0, [], [], None, None
        for r in pitch_rows:
            slot = next((s for a, b, s in windows if a <= r["t"] <= b), None)
            if slot is None:
                continue
            caps = r.get("captures") or {}
            cap = caps.get(f"slot-{slot}") or (caps.get("solo") if r.get("singers") == [slot] else None)
            if not cap or not cap.get("frames"):
                continue
            sung += 1
            last_sung = r["t"]
            st = status_at(r["t"], slot)
            kind = backend_at(r["t"])
            on[kind or "?"] = on.get(kind or "?", 0) + 1
            new = cap.get("new") or []
            got.extend(new)
            tuned = bool(new) and abs(statistics.median(new) - hz) <= L.PITCH_TOL_HZ
            if kind == "native" or (kind is None and st is not None):
                ok = out_ok(st) and tuned
                if not (st and st.get("monitored")):
                    why["not_monitored"] += 1
                elif not out_ok(st):
                    why["quiet"] += 1
                elif not tuned:
                    why["pitch_off"] += 1
            else:
                loud = mix_heard(r["t"], name)
                ok = loud and tuned
                if not loud:
                    why["mix_quiet"] += 1
                elif not tuned:
                    why["pitch_off"] += 1
            heard += 1 if ok else 0
            if not ok and run_start is None:
                run_start = r["t"]
            if ok and run_start is not None:
                if r["t"] - run_start > 2000:
                    gaps.append((run_start, r["t"] - run_start))
                run_start = None
        # A voice lost for good (say after a fall back) is a gap that never closes: report it too.
        if run_start is not None and last_sung - run_start > 2000:
            gaps.append((run_start, last_sung - run_start))
        voices[name] = {"live_secs": round(sum(b - a for a, b, _ in windows) / 1000),
                        "slots": sorted({s for _, _, s in windows}),
                        "singing_secs": round(sung * POLL_S),
                        "singing_polls_by_backend": on,
                        "heard_share": round(heard / sung, 3) if sung else None,
                        "not_heard_because": why,
                        "pitch_median_hz": round(statistics.median(got), 1) if got else None,
                        "out_share_live": round(sum(1 for st in live if out_ok(st)) / len(live), 3) if live else None,
                        "silent_gaps_over_2s": [{"at": time.strftime('%H:%M:%S', time.localtime(s / 1000)), "ms": d}
                                                for s, d in gaps][:12]}
    return voices


def judge(_args) -> int:
    st_path = STATE if STATE.exists() else None
    run = pathlib.Path(_args.run) if _args.run else (pathlib.Path(json.loads(st_path.read_text())["run"]) if st_path else None)
    if run is None:
        raise SystemExit("--run DIR")
    gate = importlib.util.spec_from_file_location("party_gate", HERE / "party-gate.py")
    G = importlib.util.module_from_spec(gate)
    gate.loader.exec_module(G)
    rows_t = [json.loads(line) for line in (run / "tv.jsonl").read_text().splitlines()] if (run / "tv.jsonl").exists() else []
    since = rows_t[0]["t"] - 5000 if rows_t else now_ms() - 3600_000
    until = rows_t[-1]["t"] + 5000 if rows_t else now_ms()
    # A TV row is placed by the TV's clock (`wall`); on the Cube that clock is moved to the host's.
    offsets = [r["clock_offset_ms"] for r in rows_t if L.number(r.get("clock_offset_ms"))]
    tv_offset = statistics.median(offsets) if offsets else 0
    flight = []
    for r in G.records(since - 600_000):
        if tv_offset and L.number(r.get("wall")):
            r["t"] = int(round(r["wall"] + tv_offset))
        if since <= r["t"] <= until:
            flight.append(r)
    flight.sort(key=lambda r: r["t"])
    out = {"run": str(run), "from": since, "to": until}
    if offsets:
        out["tv_clock_offset_ms"] = tv_offset
    out["server_stalls_ms"] = [r.get("ms") for r in flight if r["ev"] == "stall"]
    out["tv_errors"] = [r.get("message") for r in flight if r["src"] == "tv" and r["ev"] in ("error", "rejection", "react-crash")][:10]
    out["rtc_closes"] = [{k: r.get(k) for k in ("role", "slot", "why", "t")} for r in flight if r["ev"] == "rtc-close"][:40]
    out["songs_ready_ms"] = [r.get("ms") for r in flight if r["ev"] == "song-ready"]
    heaps = [r["heapMib"] for r in flight if r["src"] == "tv" and r["ev"] == "sample" and isinstance(r.get("heapMib"), (int, float))]
    out["tv_heap_mib"] = {"first": heaps[0] if heaps else None, "max": max(heaps) if heaps else None, "last": heaps[-1] if heaps else None}
    console = [json.loads(line) for line in (run / "console.jsonl").read_text().splitlines()] if (run / "console.jsonl").exists() else []
    out["console_errors"] = len(console)
    # Voices: while a persona's phone said "Live on the TV" with its tone on, was its tone heard?
    phones = [json.loads(line) for line in (run / "phones.jsonl").read_text().splitlines()] if (run / "phones.jsonl").exists() else []
    hear = [json.loads(line) for line in (run / "hear.jsonl").read_text().splitlines()] if (run / "hear.jsonl").exists() else []
    hear = [h for h in hear if "tones" in h]
    voices = {}
    for name in sorted({p["who"] for p in phones}):
        mine = sorted((p for p in phones if p["who"] == name), key=lambda p: p["t"])
        live_windows = []
        for a, b in zip(mine, mine[1:]):
            mic = a.get("mic") or {}
            if a.get("live") and (mic.get("gain") or 0) >= 0.01 and not mic.get("vocal"):
                live_windows.append((a["t"] + 1000, b["t"]))
        samples = [h for h in hear if any(s <= h["t"] <= e for s, e in live_windows)]
        heard = [h for h in samples if tone_db(h, name, 1) >= HEARD_DB]
        gaps, run_start = [], None
        for h in samples:
            ok = tone_db(h, name, 1) >= HEARD_DB
            if not ok and run_start is None:
                run_start = h["t"]
            if ok and run_start is not None:
                if h["t"] - run_start > 2000:
                    gaps.append((run_start, h["t"] - run_start))
                run_start = None
        voices[name] = {"live_secs": round(sum(e - s for s, e in live_windows) / 1000),
                        "heard_share": round(len(heard) / len(samples), 3) if samples else None,
                        "silent_gaps_over_2s": [{"at": time.strftime('%H:%M:%S', time.localtime(s / 1000)), "ms": d} for s, d in gaps][:12]}
    out["voices"] = voices
    peaks = [h["peak"] for h in hear]
    out["mix_peak_max"] = max(peaks) if peaks else None
    out["clipping_samples"] = sum(1 for v in peaks if v >= 0.99)
    steps = {}
    for name in sorted({p["who"] for p in phones}):
        rows = [json.loads(line) for line in (run / f"{name}.jsonl").read_text().splitlines()] if (run / f"{name}.jsonl").exists() else []
        acts = [r for r in rows if r.get("action")]
        firsts = [r["first_ms"] for r in acts if isinstance(r.get("first_ms"), int)]
        steps[name] = {"steps": len(acts), "comments": sum(1 for r in rows if r.get("say")),
                       "first_change_p50_ms": int(statistics.median(firsts)) if firsts else None,
                       "slow_steps": [(r["step"], r["action"], r.get("first_ms")) for r in acts if (r.get("first_ms") or 0) > 1000][:10],
                       "refused": [(r["step"], f.get("code")) for r in acts for f in (r.get("ws") or []) if f.get("ok") is False][:10]}
    out["personas"] = steps
    rig = json.loads((run / "rig.json").read_text()) if (run / "rig.json").exists() else {}
    if rig.get("voice") == "native":
        native_rows = rows_of(run, "native")
        events = [r for r in native_rows if "dir" in r]
        summaries = [r for r in native_rows if "tap" in r]
        seen: dict[str, int] = {}
        for r in summaries:
            seen[r.get("backend") or "?"] = seen.get(r.get("backend") or "?", 0) + 1
        ready = any(e["dir"] == "in" and (e.get("m") or {}).get("t") == "ready" and e["m"].get("ok") for e in events)
        out["backend"] = {"requested": "native", "seen": seen, "door_ready": ready}
        if ready:
            song_peaks = [(r["t"], v) for r in flight if r["src"] == "tv" and r["ev"] == "sample"
                          for v in L.find_values(r, "songPeak") if L.number(v)]
            rep = L.native_report(events, [{**r["tap"], "t": r["t"]} for r in summaries],
                                  [{**(r.get("long") or {}), "t": r["t"]} for r in summaries], song_peaks)
            if rig.get("tv") == "cube" and "H1" in rep:
                rep["H1"]["note"] = "the rig plays the song quietly; the song's real peak needs cube-load-test.py"
            out["native"] = rep
            out["voices_mix"] = out["voices"]
            out["voices"] = native_voices(phones, events, rows_of(run, "pitch"), summaries, hear)
            print(L.format_native(rep), file=sys.stderr)
    cube_rows = rows_of(run, "cube")
    if cube_rows:
        out["cube"] = {"samples": len(cube_rows),
                       "app_cpu_median": L.rnd(L.median((r.get("cpu") or {}).get("app") for r in cube_rows)),
                       "renderer_cpu_median": L.rnd(L.median((r.get("cpu") or {}).get("webview") for r in cube_rows)),
                       "mem_available_min_mb": min((r["mem_available_mb"] for r in cube_rows
                                                    if L.number(r.get("mem_available_mb"))), default=None),
                       "native_heap_mb_max": L.top_value(r.get("native_heap_mb") for r in cube_rows),
                       "so_mmap_mb_max": L.top_value(r.get("so_mmap_mb") for r in cube_rows)}
    (run / "judge.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in PERSONAS:
        return cmd_persona(sys.argv[1], sys.argv[2:])
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("up")
    u.add_argument("--personas", default=",".join(PERSONAS))
    u.add_argument("--run", default=None)
    u.add_argument("--tv", choices=("headless", "cube"), default="headless",
                   help="cube: the real Fire TV Cube (only when idle; quiet volume, restored after)")
    u.add_argument("--quiet", type=float, default=0.03, help="song volume on the Cube during the run")
    u.add_argument("--voice", choices=("web", "native"), default="web",
                   help="native: the TV page opens with &voice=native (in the TV app, the app plays the phones)")
    u.add_argument("--restore-flags", default=None,
                   help="with --tv cube: URL flags FireSong keeps after `down`, e.g. '&voice=native'"
                        " (default: FIRESONG_TV_URL_FLAGS, else none)")
    sub.add_parser("down")
    j = sub.add_parser("judge")
    j.add_argument("--run", default=None)
    args = ap.parse_args()
    return {"up": up, "down": down, "judge": judge}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
