#!/usr/bin/env python3
"""Release gate on the real Fire TV Cube: a short party, judged from its flight record.

Drives the Cube and one headless phone through what a party does, then reads
<data>/firesong/sessions (docs/firesong/FLIGHT.md) for the run and checks it:

  1. The TV opens FireSong; a phone joins with a fake microphone (a steady tone).
  2. The phone reserves a ready song; the lobby starts it; it plays 40 s.
  3. Back pauses, OK resumes (the pause box must open on Continue).
  4. The phone reserves a song that is not prepared; it must be ready within
     --prep-limit seconds while the party is on.
  5. On the TV, the remote picks a song from the song book and starts it.

Pass when: no page error or crash, no TV socket drop, no server stall of 1 s or
more, every song ready within 3 s of loading, the phone's voice is heard while
a song plays (voice output and gate open), its level during songs within 3 dB
of the lobby, and the TV page's memory does not keep growing.

    party-gate.py --ready-song <hash> --prep-song <hash> [--tone-gain 0.02]

Needs the TV idle: asleep, or awake on the launcher, with nothing playing or
paused (a screensaver may hide a paused app, so it counts as busy); exit 2
otherwise. A Cube that fell asleep keeps its last app on top; the run goes HOME
after waking it. Song playback is
turned almost silent for the run; the tone and voices come out of the TV
quietly. Restores the Cube (URL, HOME, sleep) and the volume. Exit 0 = PASS,
1 = FAIL, 2 = TV busy (nothing touched), 3 = could not get FireSong onto the TV.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import re
import pathlib
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("cube_load_test", HERE / "cube-load-test.py")
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)

PHONE_CDP = 9631
TONE_HZ = 330.0
SING_SECS = 40
QUIET_MASTER = 0.03


def data_path() -> pathlib.Path:
    return pathlib.Path(L.env_value("NIGHTINGALE_DATA_PATH") or "/mnt/fast/firesong/data")


def song(file_hash: str) -> dict:
    db = sqlite3.connect(f"file:{data_path() / 'songs.db'}?mode=ro", uri=True, timeout=30)
    try:
        row = db.execute("select title, is_analyzed from songs where file_hash = ?", (file_hash,)).fetchone()
    finally:
        db.close()
    if row is None:
        raise SystemExit(f"no song {file_hash}")
    return {"title": row[0], "is_analyzed": bool(row[1])}


def visible(sel: str) -> str:
    return f"[...document.querySelectorAll({json.dumps(sel)})].filter((el) => el.checkVisibility())"


def by_text(sel: str, text: str) -> str:
    return f"{visible(sel)}.find((b) => b.textContent.trim() === {json.dumps(text)})"


def reserve(phone, title: str) -> None:
    phone.tap(by_text("[role=tab]", "Songs"))
    L.wait_for("search box", lambda: phone.eval(f"{visible('#phone-panel-songs input[type=search]')}.length > 0"), 15)
    phone.eval("document.querySelector('#phone-panel-songs input[type=search]').focus()")
    phone.call("Input.insertText", {"text": title})
    row = (f"{visible('#phone-panel-songs li button')}"
           f".find((b) => b.querySelector('span span')?.textContent === {json.dumps(title)})")
    L.wait_for(f"'{title}' in the song book", lambda: phone.eval(f"{row} !== undefined"), 20)
    phone.tap(row)
    L.wait_for("reserve sheet", lambda: phone.eval(f"{by_text('dialog[open] button', 'Reserve')} !== undefined"), 10)
    phone.tap(by_text("dialog[open] button", "Reserve"))
    L.wait_for("sheet closed", lambda: phone.eval("document.querySelector('dialog[open]') === null"), 10)


class SetupError(Exception):
    """The run could not get FireSong onto the TV; nothing about FireSong was tested."""


def media_problem(cube) -> str | None:
    """A media session that is playing or paused, which someone may come back to."""
    sessions = cube.sh("dumpsys media_session")
    found = re.search(r"active=true[^\n]*\n(?:[^\n]*\n){0,6}?[^\n]*state=PlaybackState \{state=([23])", sessions)
    if found is None:
        return None
    return "a media session is playing" if found.group(1) == "3" else "a media session is paused"


def idle_problem(cube) -> str | None:
    """Why the Cube is not free for a test, or None. Free means asleep, or awake
    with the launcher in front, with no media session playing or paused. A
    screensaver can hide a paused app, so dreaming counts as busy."""
    state = cube.wakefulness()
    media = media_problem(cube)
    if media:
        return media
    if state == "Asleep":
        return None
    front = cube.resumed()
    if state == "Awake" and front.startswith("com.amazon.tv.launcher/"):
        return None
    return f"{state}, front={front or 'none'}"


def open_firesong(cube, tvctl: str, lan_url: str, token_file: pathlib.Path):
    """Wake the Cube, bring it to the launcher and open FireSong; the TV page's DevTools.

    A Cube that fell asleep keeps the last app (often Plex) on top, so after waking
    it goes HOME first, unless that app now has a media session playing or paused."""
    cube.sh("input keyevent KEYCODE_WAKEUP")
    time.sleep(3)
    if not cube.resumed().startswith("com.amazon.tv.launcher/"):
        media = media_problem(cube)
        if media:
            raise SetupError(f"after waking: {media}")
        cube.sh("input keyevent KEYCODE_HOME")
        time.sleep(4)
    launch = subprocess.run(["bash", str(L.REPO / "scripts/firesong/cube.sh"), "launch", "--url", lan_url + "&fsdiag=1",
                             "--host-token-file", str(token_file)], capture_output=True, text=True, timeout=60)
    if launch.returncode != 0:
        raise SetupError(f"launch failed: {(launch.stderr or launch.stdout).strip()[-300:]}")
    time.sleep(15)
    devtools = subprocess.run([tvctl, "devtools", str(L.TV_CDP)], capture_output=True, text=True, timeout=30)
    if devtools.returncode != 0:
        raise SetupError(f"no DevTools on the TV page: {devtools.stderr.strip()[-300:]}")
    try:
        tv = L.Cdp(L.TV_CDP)
        L.wait_for("TV seat", lambda: tv.eval("!!(window.fireSongDiag && fireSongDiag.snapshot().connected)"), 40)
    except Exception as error:
        raise SetupError(f"TV page not reachable: {error}") from error
    return tv


def playing() -> bool:
    return bool((L.cmd("load_playback_progress") or {}).get("playing"))


def set_master(config: pathlib.Path, value: float | None, saved: dict) -> None:
    c = json.loads(config.read_text())
    if value is None:
        c.update(saved)
    else:
        saved["master_volume"] = c.get("master_volume")
        c["master_volume"] = value
    tmp = config.with_suffix(".json.gate-tmp")
    tmp.write_text(json.dumps(c, indent=2) + "\n")
    tmp.chmod(config.stat().st_mode & 0o777)
    tmp.replace(config)


def records(since_ms: int) -> list[dict]:
    rows = []
    for path in sorted((data_path() / "firesong/sessions").glob("*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            row["t"] = int(row.get("wall", row.get("t", 0)))
            if row["t"] >= since_ms:
                rows.append(row)
    return sorted(rows, key=lambda r: r["t"])


def judge(rows: list[dict], prep_secs: float | None, prep_limit: float, run_end: int) -> dict:
    checks: dict[str, dict] = {}

    def check(name, ok, **detail):
        checks[name] = {"ok": bool(ok), **detail}

    errors = [r for r in rows if r["src"] == "tv" and r["ev"] in ("error", "rejection", "react-crash")]
    check("no page errors", not errors, events=[r.get("message") for r in errors][:5])
    drops = [r for r in rows if r["ev"] == "rtc-close" and r.get("role") == "Tv" and r["t"] < run_end]
    check("TV never dropped its seat", not drops, why=[r.get("why") for r in drops])
    stalls = [r.get("ms") for r in rows if r["ev"] == "stall"]
    check("no server stall >= 1 s", not stalls, stalls_ms=stalls)
    ready = [r.get("ms") for r in rows if r["ev"] == "song-ready"]
    check("songs ready within 3 s", ready and all(ms < 3000 for ms in ready), ready_ms=ready)
    check(f"unprepared song ready within {prep_limit:.0f} s", prep_secs is not None and prep_secs <= prep_limit,
          seconds=prep_secs)

    samples = [r for r in rows if r["src"] == "tv" and r["ev"] == "sample"]
    singing = [r for r in samples if (r.get("song") or {}).get("playing")]
    lobby = [r for r in samples if not r.get("song")]

    def slot_values(group, key):
        return [s.get(key) for r in group for s in ((r.get("mics") or {}).get("slots") or [])
                if isinstance(s.get(key), (int, float, bool))]

    out = [(r.get("voice") or {}).get("outputRms") or 0 for r in singing]
    check("voice heard while singing", out and statistics.median(out) > 0.001,
          voice_out_median=statistics.median(out) if out else None, samples=len(out))
    gate = slot_values(singing, "gateOpen")
    check("gate open while singing", gate and sum(gate) / len(gate) >= 0.8,
          open_share=round(sum(gate) / len(gate), 2) if gate else None)
    lvl_song, lvl_lobby = slot_values(singing, "levelRms"), slot_values(lobby, "levelRms")
    if lvl_song and lvl_lobby and statistics.median(lvl_lobby) > 0:
        diff_db = 20 * math.log10(max(statistics.median(lvl_song), 1e-9) / statistics.median(lvl_lobby))
    else:
        diff_db = None
    check("phone level in songs within 3 dB of the lobby", diff_db is not None and abs(diff_db) <= 3,
          diff_db=None if diff_db is None else round(diff_db, 2))
    heaps = [r["heapMib"] for r in samples if isinstance(r.get("heapMib"), (int, float))]
    growth = heaps[-1] - min(heaps[: max(1, len(heaps) // 3)]) if len(heaps) >= 3 else None
    check("TV memory steady", growth is not None and growth < 150, growth_mib=growth, max_mib=max(heaps) if heaps else None)
    return checks


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--ready-song", required=True, help="file hash of a prepared song")
    ap.add_argument("--prep-song", required=True, help="file hash of a song that is not prepared")
    ap.add_argument("--prep-limit", type=float, default=120.0)
    ap.add_argument("--tone-gain", type=float, default=0.02)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    serial = L.env_value("FIRESONG_CUBE_SERIAL")
    lan_url = f"https://{L.env_value('FIRESONG_LAN_IP')}:{L.env_value('FIRESONG_TV_PORT') or 64443}/?tv=1&mode=noraebang"
    token_file = data_path() / "firesong/host-token"
    config = data_path() / "config.json"
    out = pathlib.Path(args.out or f"/mnt/fast/firesong/artifacts/party-gate-{time.strftime('%Y%m%dT%H%M%S')}")
    out.mkdir(parents=True, exist_ok=True)
    ready, prep = song(args.ready_song), song(args.prep_song)
    if not ready.get("is_analyzed") or prep.get("is_analyzed"):
        print("ABORT: --ready-song must be prepared and --prep-song not")
        return 2
    os.environ["FIRESONG_CUBE_SERIAL"] = serial or ""
    cube = L.Cube(serial)
    start_state, busy = cube.wakefulness(), idle_problem(cube)
    if busy:
        print(f"ABORT: TV busy ({busy})")
        return 2

    tvctl = str(L.REPO / "tools/tvctl")
    saved: dict = {}
    chrome = None
    profile = tempfile.mkdtemp(prefix="fs-gate-phone-", dir=str(out))
    since = int(time.time() * 1000)
    prep_secs = None
    setup_failed = False
    try:
        set_master(config, QUIET_MASTER, saved)
        L.cmd("clear_playback_queue")
        tv = open_firesong(cube, tvctl, lan_url, token_file)

        chrome = subprocess.Popen([L.CHROME, "--headless=new", f"--remote-debugging-port={PHONE_CDP}",
                                   f"--user-data-dir={profile}", "--use-fake-ui-for-media-stream",
                                   "--autoplay-policy=no-user-gesture-required", "--mute-audio",
                                   "--window-size=390,844", "about:blank"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3)
        phone = L.Cdp(PHONE_CDP)
        phone.call("Page.navigate", {"url": f"http://127.0.0.1:64449/m?t={L.pairing_token()}&slot=1"})
        L.wait_for("join card", lambda: phone.eval("document.body.innerText.includes('Join as')"), 20)
        phone.eval(L.FAKE_MIC % {"hz": TONE_HZ, "gain": args.tone_gain})
        phone.tap('document.querySelector("#phone-panel-sing input")')
        phone.call("Input.insertText", {"text": "Gate"})
        phone.tap('document.querySelector("#phone-panel-sing button[type=submit]")')
        L.wait_for("phone on the TV", lambda: tv.eval("fireSongDiag.snapshot().devices.length >= 1"), 40)
        print("step: lobby with a phone", flush=True)
        time.sleep(25)

        print(f"step: phone reserves '{ready['title']}'", flush=True)
        reserve(phone, ready["title"])
        L.wait_for("the lobby starts the song", playing, 60)
        time.sleep(SING_SECS)
        print("step: Back pauses, OK resumes", flush=True)
        cube.sh("input keyevent KEYCODE_BACK")
        time.sleep(3)
        paused = not playing()
        cube.sh("input keyevent KEYCODE_DPAD_CENTER")
        L.wait_for("resumed", playing, 15)
        time.sleep(10)
        L.cmd("request_playback_command", {"command": "exit"})
        L.wait_for("back in the lobby", lambda: not playing(), 20)

        print(f"step: phone reserves unprepared '{prep['title']}'", flush=True)
        t_prep = time.time()
        reserve(phone, prep["title"])
        L.wait_for("song prepared", lambda: song(args.prep_song).get("is_analyzed"), args.prep_limit + 60, every=3)
        prep_secs = round(time.time() - t_prep, 1)
        L.wait_for("the lobby starts it", playing, 60)
        time.sleep(15)
        L.cmd("request_playback_command", {"command": "exit"})
        L.wait_for("back in the lobby", lambda: not playing(), 20)
        L.cmd("clear_playback_queue")

        print("step: the remote picks a song on the TV", flush=True)
        time.sleep(3)
        for key in ("DPAD_CENTER", "DPAD_CENTER"):
            cube.sh(f"input keyevent KEYCODE_{key}")
            time.sleep(4)
        cube.sh("input keyevent KEYCODE_DPAD_CENTER")
        L.wait_for("the TV's pick plays", playing, 30)
        time.sleep(20)
        L.cmd("request_playback_command", {"command": "exit"})
        time.sleep(8)
    except SetupError as error:
        print(f"could not run: {error}", flush=True)
        setup_failed = True
    except Exception as error:
        print(f"run error: {error}", flush=True)
        paused = None
    finally:
        run_end = int(time.time() * 1000)
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=10)
            except subprocess.TimeoutExpired:
                chrome.kill()
        shutil.rmtree(profile, ignore_errors=True)
        try:
            L.cmd("clear_playback_queue")
        except Exception:
            pass
        subprocess.run([tvctl, "home"], capture_output=True, timeout=30)
        subprocess.run([tvctl, "undevtools", str(L.TV_CDP)], capture_output=True, timeout=30)
        time.sleep(2)
        subprocess.run([tvctl, "configure", "--url", lan_url, "--token-file", str(token_file)],
                       capture_output=True, timeout=60)
        time.sleep(3)
        subprocess.run([tvctl, "home"], capture_output=True, timeout=30)
        subprocess.run([tvctl, "stop"], capture_output=True, timeout=30)
        if saved:
            set_master(config, None, saved)
        if start_state in ("Asleep", "Dozing"):
            for _ in range(3):
                cube.sh("input keyevent KEYCODE_SLEEP")
                time.sleep(6)
                if cube.wakefulness() == "Asleep":
                    break
    if setup_failed:
        print("RESULT COULD NOT RUN (the Cube is restored)")
        return 3
    time.sleep(6)  # the TV page's last flight batch
    checks = judge(records(since), prep_secs, args.prep_limit, run_end)
    checks["Back pauses"] = {"ok": paused is True}
    passed = all(c["ok"] for c in checks.values())
    report = {"passed": passed, "checks": checks, "since_ms": since, "cube_after": cube.wakefulness()}
    (out / "report.json").write_text(json.dumps(report, indent=1))
    for name, c in checks.items():
        print(("PASS " if c["ok"] else "FAIL ") + name + " " + json.dumps({k: v for k, v in c.items() if k != "ok"}))
    print("RESULT", "PASS" if passed else "FAIL", out / "report.json")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
