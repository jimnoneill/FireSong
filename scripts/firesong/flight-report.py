#!/usr/bin/env python3
"""Reads the party flight record (docs/firesong/FLIGHT.md) and prints what happened.

  flight-report.py [--data DIR] [--date YYYY-MM-DD] [--from HH:MM] [--to HH:MM] [--all]

Times are local. Without --date it reads today's and yesterday's UTC files. It prints the
timeline (everything except periodic samples, unless --all), then a summary: server stalls,
TV socket drops, page loads and errors, songs (load -> ready time), the TV page's heap, and for
each phone slot its level, gate and monitor state while a song played versus in the lobby, with
the voice output level next to it. That last table is the silent-mic check: a voice that arrives
(level) but never leaves (voice out) points at the gate or the monitor.
"""
import argparse
import datetime as dt
import json
import os
import statistics
import sys

QUIET = {"sample"}


def env_data_path():
    path = os.path.expanduser("~/.config/firesong/firesong.env")
    try:
        for line in open(path):
            if line.startswith("NIGHTINGALE_DATA_PATH="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return None


def load(data, dates):
    rows = []
    for date in dates:
        path = os.path.join(data, "firesong", "sessions", f"{date}.jsonl")
        if not os.path.exists(path):
            continue
        for line in open(path):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    for r in rows:
        if isinstance(r.get("wall"), (int, float)):
            r["t"] = int(r["wall"])  # the TV's own clock; the server's t is when the batch arrived
    rows.sort(key=lambda r: r.get("t", 0))
    return rows


def local(t):
    return dt.datetime.fromtimestamp(t / 1000)


def short(row):
    skip = {"t", "src", "ev", "wall"}
    return " ".join(f"{k}={json.dumps(v)}" for k, v in row.items() if k not in skip)


def summarize(rows):
    stalls = [r for r in rows if r["ev"] == "stall"]
    print("\n== server stalls (>= 1 s)")
    if stalls:
        worst = max(stalls, key=lambda r: r.get("ms", 0))
        print(f"{len(stalls)} stalls; worst {worst['ms']} ms ({worst.get('kind')}) at {local(worst['t']):%H:%M:%S}")
    else:
        print("none")

    print("\n== connections")
    for r in rows:
        if r["ev"] in ("rtc-close", "page-load", "page-hide", "error", "rejection", "voice-context", "song-context"):
            print(f"{local(r['t']):%H:%M:%S} {r['src']:6} {r['ev']:14} {short(r)[:160]}")

    print("\n== songs")
    loads = {}
    for r in rows:
        if r["ev"] == "song-load":
            loads[r.get("hash")] = r["t"]
        elif r["ev"] in ("song-ready", "song-error"):
            print(f"{local(r['t']):%H:%M:%S} {r['ev']:10} {r.get('hash', '')[:12]} {r.get('ms')} ms {r.get('message', '')}")

    samples = [r for r in rows if r["ev"] == "sample" and r["src"] == "tv"]
    heaps = [r["heapMib"] for r in samples if isinstance(r.get("heapMib"), (int, float))]
    print("\n== TV page heap (MiB)")
    print(f"min {min(heaps)} max {max(heaps)} last {heaps[-1]}" if heaps else "no samples")

    print("\n== voices: singing vs lobby (median of 10 s samples)")
    table = {}
    for r in samples:
        singing = bool((r.get("song") or {}).get("playing"))
        out = (r.get("voice") or {}).get("outputRms")
        for slot in (r.get("mics") or {}).get("slots", []):
            key = (slot.get("slot"), "song" if singing else "lobby")
            cell = table.setdefault(key, {"level": [], "gate": [], "monitored": [], "muted": [], "out": []})
            cell["level"].append(slot.get("levelRms") or 0)
            cell["gate"].append(1 if slot.get("gateOpen") else 0)
            cell["monitored"].append(1 if slot.get("monitored") else 0)
            cell["muted"].append(1 if slot.get("muted") else 0)
            if isinstance(out, (int, float)):
                cell["out"].append(out)
    if not table:
        print("no phone samples")
    for (slot, when), cell in sorted(table.items()):
        med = lambda xs: round(statistics.median(xs), 4) if xs else None
        share = lambda xs: f"{round(100 * sum(xs) / len(xs))}%" if xs else "-"
        print(f"slot {slot} {when:5} n={len(cell['level']):3} level {med(cell['level'])} "
              f"gate open {share(cell['gate'])} monitored {share(cell['monitored'])} "
              f"muted {share(cell['muted'])} voice out {med(cell['out'])}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default=env_data_path())
    ap.add_argument("--date")
    ap.add_argument("--from", dest="start")
    ap.add_argument("--to", dest="end")
    ap.add_argument("--all", action="store_true", help="also print every periodic sample")
    a = ap.parse_args()
    if not a.data:
        sys.exit("no --data and no NIGHTINGALE_DATA_PATH in ~/.config/firesong/firesong.env")
    today = dt.datetime.now(dt.timezone.utc).date()
    dates = [a.date] if a.date else [str(today - dt.timedelta(days=1)), str(today)]
    rows = load(a.data, dates)
    day = dt.date.fromisoformat(a.date) if a.date else dt.date.today()

    def bound(hhmm, default):
        if not hhmm:
            return default
        h, m = map(int, hhmm.split(":"))
        return dt.datetime.combine(day, dt.time(h, m)).timestamp() * 1000

    lo, hi = bound(a.start, 0), bound(a.end, float("inf"))
    rows = [r for r in rows if lo <= r.get("t", 0) <= hi and "ev" in r]
    print(f"{len(rows)} records")
    for r in rows:
        if a.all or r["ev"] not in QUIET:
            print(f"{local(r['t']):%H:%M:%S}.{r['t'] % 1000:03d} {r.get('src', '?'):6} {r['ev']:18} {short(r)[:200]}")
    summarize(rows)


if __name__ == "__main__":
    main()
