#!/usr/bin/env python3
"""Reads the party flight record (docs/firesong/FLIGHT.md) and prints what happened.

  flight-report.py [--data DIR] [--date YYYY-MM-DD] [--from HH:MM] [--to HH:MM] [--all]

Times are local. Without --date it reads today's and yesterday's UTC files. It prints the
timeline (everything except periodic samples, unless --all), then a summary: server stalls,
TV socket drops, page loads and errors, songs (load -> ready time), the TV page's heap, and for
each phone slot its level, gate and monitor state while a song played versus in the lobby, with
the voice output level next to it. That last table is the silent-mic check: a voice that arrives
(level) but never leaves (voice out) points at the gate or the monitor.

When the TV app played the voices (the native voice backend), it also prints which backend each
sample used and why it changed, the app engine's statistics (output open, xruns, underruns per
slot, push intervals, callback times, push-to-present, tap drain), the headroom of the song and the
voices, the page-side tap arrival, and the in-room monitor-beep loop results. Engine figures come
from the sample taken every 10 s, so they show 1 s in every 10.
"""
import argparse
import datetime as dt
import json
import os
import statistics
import sys

QUIET = {"sample"}
NATIVE_EVENTS = ("mic-backend", "native-mics", "monitor-latency", "song-peak")
STATS_KEY = "pushIntervalP99Us"


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


def median(xs):
    xs = [x for x in xs if isinstance(x, (int, float)) and not isinstance(x, bool)]
    return round(statistics.median(xs), 4) if xs else None


def top(xs):
    xs = [x for x in xs if isinstance(x, (int, float)) and not isinstance(x, bool)]
    return max(xs) if xs else None


def rise(xs):
    """How much a cumulative counter rose over the samples; a drop is a reset to zero."""
    total, prev = 0, None
    for x in xs:
        if not isinstance(x, (int, float)):
            continue
        if prev is not None:
            total += x - prev if x >= prev else x
        prev = x
    return total


def find(obj, key, depth=0):
    """Every value stored under `key` in nested dicts and lists."""
    if depth > 6:
        return []
    if isinstance(obj, dict):
        return [v for k, v in obj.items() if k == key] + [x for k, v in obj.items() if k != key for x in find(v, key, depth + 1)]
    if isinstance(obj, list):
        return [x for v in obj for x in find(v, key, depth + 1)]
    return []


def holder(obj, key, depth=0):
    """The first dict in obj that has `key`."""
    if depth > 6:
        return None
    if isinstance(obj, dict):
        if key in obj:
            return obj
        children = obj.values()
    elif isinstance(obj, list):
        children = obj
    else:
        return None
    for v in children:
        found = holder(v, key, depth + 1)
        if found is not None:
            return found
    return None


def backend(sample):
    """The voice backend of a TV sample ('web', 'native' or None before WP12) and the app engine's statistics."""
    mics = sample.get("mics") or {}
    b = mics.get("backend")
    if isinstance(b, str):
        kind = b
    elif isinstance(b, dict):
        kind = b.get("kind")
    else:
        kind = mics.get("kind")
    return kind, holder(sample, STATS_KEY)


def native_slots(sample):
    """Per slot, the app's own slot figures (output level, ring fill, monitor loop) when the sample has them."""
    out = {}
    for d in find(sample, "slots"):
        for s in d if isinstance(d, list) else []:
            if isinstance(s, dict) and "outRms" in s:
                out[s.get("slot")] = s
    return out


def native_summary(samples, rows):
    kinds = {}
    for r in samples:
        kind = backend(r)[0] or "-"
        kinds[kind] = kinds.get(kind, 0) + 1
    changes = [r for r in rows if r["ev"] in ("mic-backend", "native-mics")]
    if set(kinds) <= {"-"} and not changes:
        return
    print("\n== voice backend")
    print("samples by backend: " + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())))
    for r in changes:
        print(f"{local(r['t']):%H:%M:%S} {r['ev']:12} {short(r)[:160]}")

    stats = [st for st in (backend(r)[1] for r in samples) if st]
    if stats:
        opened = [st for st in stats if st.get("open")]
        print(f"\n== TV app voice engine ({len(stats)} samples, 1 s each)")
        print(f"output open in {round(100 * len(opened) / len(stats))}% of samples; output latency median "
              f"{median(st.get('outputLatencyMs') for st in opened)} ms; burst {stats[-1].get('burstFrames')}, "
              f"buffer {stats[-1].get('bufferFrames')} frames; apm {next((st['apm'] for st in reversed(stats) if st.get('apm')), None)}")
        print(f"xruns +{rise(st.get('xruns') for st in stats)}, output restarts +{rise(st.get('restarts') for st in stats)}, "
              f"open attempts {stats[-1].get('openAttempts')}, sink errors +{rise(st.get('sinkErrors') for st in stats)}, "
              f"ignored +{rise(st.get('ignored') for st in stats)}, tap blocks dropped +{rise(st.get('tapDropped') for st in stats)}")
        if any("conceals" in st for st in stats):
            print(f"ring: conceals +{rise(st.get('conceals') for st in stats)} ({round(rise(st.get('concealedFrames') for st in stats) / 48)} ms),"
                  f" silence +{round(rise(st.get('silentFrames') for st in stats) / 48)} ms, resyncs +{rise(st.get('resyncs') for st in stats)},"
                  f" output stalls +{rise(st.get('outputStalls') for st in stats)}, push gaps over 20 ms"
                  f" +{rise(st.get('pushGaps20') for st in stats)}; voice frames clamped +{rise(st.get('clampHits') for st in stats)}")
        else:
            print(f"splices: trims +{rise(st.get('trims') for st in stats)}, jumps +{rise(st.get('jumps') for st in stats)},"
                  f" inserts +{rise(st.get('inserts') for st in stats)}; voice frames clamped +{rise(st.get('clampHits') for st in stats)}")

        def us(key, pick=median):
            """A microsecond statistic over the samples that have it, in ms."""
            v = pick(st.get(key) for st in stats if st.get(key))
            return None if v is None else round(v / 1000, 2)

        print(f"push interval p50 {us('pushIntervalP50Us')} ms, p99 {us('pushIntervalP99Us')} ms (worst {us('pushIntervalP99Us', top)}),"
              f" max {us('pushIntervalMaxUs', top)} ms; callback p99 {us('callbackP99Us')} ms, max {us('callbackMaxUs', top)} ms")
        print(f"push to present p50 {median(st.get('pushToPresentP50Ms') for st in opened)} ms,"
              f" p95 {median(st.get('pushToPresentP95Ms') for st in opened)} ms;"
              f" tap drain p99 {us('tapDrainP99Us')} ms, max {us('tapDrainMaxUs', top)} ms")
        per_slot = {}
        for st in stats:
            for s in st.get("slots") or []:
                per_slot.setdefault(s.get("slot"), []).append(s)
        for slot, xs in sorted(per_slot.items(), key=lambda kv: str(kv[0])):
            if any("droppedFrames" in x for x in xs):
                print(f"slot {slot}: underruns +{rise(x.get('underruns') for x in xs)}, dropped "
                      f"+{round(rise(x.get('droppedFrames') for x in xs) / 48)} ms, low water median {median(x.get('lowWaterMs') for x in xs)} ms")
            else:
                print(f"slot {slot}: underruns +{rise(x.get('underruns') for x in xs)}, trimmed "
                      f"+{round(rise(x.get('trimmedFrames') for x in xs) / 48)} ms, margin median {median(x.get('marginMs') for x in xs)} ms")

    song = top(v for r in samples for v in find(r, "songPeak"))
    voice = top(st.get("peak") for st in stats)
    if song is not None or voice is not None:
        print("\n== headroom (song and voices each at most 0.5)")
        print(f"song peak max {song}; voice peak max {voice} (sampled 1 s in 10)")
    arrivals = [a for r in samples for a in find(r, "tapArrival") if isinstance(a, dict)]
    if arrivals:
        print("\n== tap delivery to the page (report only)")
        print(f"arrival p99 worst {top(a.get('p99Ms') for a in arrivals)} ms, max {top(a.get('maxMs') for a in arrivals)} ms,"
              f" {sum(a.get('count') or 0 for a in arrivals)} messages")
    loops = [r for r in rows if r["ev"] == "monitor-latency"]
    if loops:
        print("\n== monitor beep (singer's own loop: TV out, air, phone, network, jitter buffer)")
        for r in loops:
            print(f"{local(r['t']):%H:%M:%S} {short(r)[:160]}")
        print(f"median {median(v for r in loops for v in find(r, 'monitorMs'))} ms")


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
        if r["ev"] in ("rtc-close", "page-load", "page-hide", "error", "rejection", "voice-context", "song-context",
                       *NATIVE_EVENTS):
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
        own = native_slots(r)
        for slot in (r.get("mics") or {}).get("slots", []):
            key = (slot.get("slot"), "song" if singing else "lobby")
            cell = table.setdefault(key, {"level": [], "gate": [], "monitored": [], "muted": [], "out": [],
                                          "slot_out": [], "fill": [], "loop": []})
            cell["level"].append(slot.get("levelRms") or 0)
            cell["gate"].append(1 if slot.get("gateOpen") else 0)
            cell["monitored"].append(1 if slot.get("monitored") else 0)
            cell["muted"].append(1 if slot.get("muted") else 0)
            if isinstance(out, (int, float)):
                cell["out"].append(out)
            mine = own.get(slot.get("slot")) or {}
            for name, field in (("slot_out", "outRms"), ("fill", "fillMs"), ("loop", "monitorMs")):
                if isinstance(mine.get(field), (int, float)):
                    cell[name].append(mine[field])
    if not table:
        print("no phone samples")
    for (slot, when), cell in sorted(table.items()):
        med = lambda xs: round(statistics.median(xs), 4) if xs else None
        share = lambda xs: f"{round(100 * sum(xs) / len(xs))}%" if xs else "-"
        native = (f" | app: slot out {med(cell['slot_out'])} ring {med(cell['fill'])} ms"
                  f" own loop {med(cell['loop'])} ms") if cell["slot_out"] else ""
        print(f"slot {slot} {when:5} n={len(cell['level']):3} level {med(cell['level'])} "
              f"gate open {share(cell['gate'])} monitored {share(cell['monitored'])} "
              f"muted {share(cell['muted'])} voice out {med(cell['out'])}{native}")
    native_summary(samples, rows)


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
