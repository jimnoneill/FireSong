"""Tests for firesong_prep (party-prep.py). Standard library only.

    python3 -m unittest discover -s scripts/firesong/tests -t scripts/firesong
    scripts/firesong/party-prep.py self-test

The end-to-end cases run the real prep loop against a fake Nightingale server
(threaded http.server on an ephemeral loopback port) that simulates analysis,
the rekey of remote songs, cancellation and the idle analyzer's CUDA context.
No real GPU, NFS mount, systemd unit or server is touched.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import firesong_prep as fp  # noqa: E402

UUID = "GPU-00000000-1111-2222-3333-444444444444"


def h32(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()[:32]


def h64(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()


def quiet_log() -> fp.Log:
    return fp.Log(quiet=True, stream=io.StringIO())


def write_size(path: Path, size: int, mtime: float | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\0" * size)
    if mtime is not None:
        os.utime(path, (mtime, mtime))


# ---------------------------------------------------------------------------
# unit tests


class EnvTests(unittest.TestCase):
    def test_parse_env_file(self):
        env = fp.parse_env_file(
            "# comment\n\nA=1\nexport B=two\nC=\"quoted value\"\nD='x'\n; also comment\nE=a#b\nnot a line\n")
        self.assertEqual(env, {"A": "1", "B": "two", "C": "quoted value", "D": "x", "E": "a#b"})

    def test_settings_from_env(self):
        s = fp.Settings.from_env({
            "NIGHTINGALE_DATA_PATH": "/data", "NIGHTINGALE_BIND": "0.0.0.0:64448",
            "FIRESONG_SONG_CACHE": "/cache", "CUDA_VISIBLE_DEVICES": f"{UUID},1",
            "FIRESONG_SONG_CACHE_MAX_GB": "2.5", "FIRESONG_GPU_MIN_FREE_GB": "6"})
        self.assertEqual(s.server_url, "http://127.0.0.1:64448")
        self.assertEqual(s.song_dir, Path("/cache/songs"))
        self.assertEqual(s.gpu, UUID)
        self.assertEqual(s.cap_bytes, int(2.5 * fp.GB))
        self.assertEqual(s.min_free_bytes, 6 * fp.GIB)
        self.assertEqual(s.host_token_file, Path("/data/firesong/host-token"))

    def test_placeholders_rejected(self):
        with self.assertRaises(fp.GuardError):
            fp.Settings.from_env({"NIGHTINGALE_DATA_PATH": "<data-dir>"})
        s = fp.Settings.from_env({"NIGHTINGALE_DATA_PATH": "/d", "CUDA_VISIBLE_DEVICES": "<rtx4090-gpu-uuid>",
                                  "FIRESONG_SONG_CACHE": "<song-cache-mount>"})
        self.assertEqual(s.gpu, "")
        self.assertIsNone(s.song_cache)

    def test_environment_overrides_file(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d, "env")
            f.write_text("NIGHTINGALE_DATA_PATH=/from-file\nFIRESONG_SONG_CACHE=/c\n")
            env, used = fp.load_env(f, {"NIGHTINGALE_DATA_PATH": "/from-env", "EMPTY": ""})
            self.assertEqual(used, f)
            self.assertEqual(env["NIGHTINGALE_DATA_PATH"], "/from-env")
            self.assertEqual(env["FIRESONG_SONG_CACHE"], "/c")
            with self.assertRaises(fp.GuardError):
                fp.load_env(Path(d, "missing"), {})


class MountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.cache = self.dir / "song cache"
        self.cache.mkdir()
        esc = str(self.cache).replace(" ", "\\040")
        self.mountinfo = self.dir / "mountinfo"
        self.mountinfo.write_text(
            "22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n"
            f"90 22 0:51 / {esc} rw,relatime shared:2 - nfs4 10.0.0.9:/export/cache rw,vers=4.2\n"
            "91 22 259:3 / /mnt/fast rw,relatime shared:3 - ext4 /dev/nvme1n1p1 rw\n")
        self.settings = fp.Settings.from_env({"NIGHTINGALE_DATA_PATH": str(self.dir / "data"),
                                              "FIRESONG_SONG_CACHE": str(self.cache)})

    def tearDown(self):
        self.tmp.cleanup()

    def test_nfs_mount_accepted(self):
        msg = fp.check_song_cache_mount(self.settings, self.mountinfo, alive=lambda p: True)
        self.assertIn("nfs4", msg)

    def test_unmounted_refused(self):
        self.settings.song_cache = self.dir / "elsewhere"
        with self.assertRaisesRegex(fp.GuardError, "not mounted"):
            fp.check_song_cache_mount(self.settings, self.mountinfo, alive=lambda p: True)

    def test_local_mount_refused(self):
        self.settings.song_cache = Path("/mnt/fast")
        with self.assertRaisesRegex(fp.GuardError, "ext4 mount"):
            fp.check_song_cache_mount(self.settings, self.mountinfo, alive=lambda p: True)

    def test_dead_server_refused(self):
        with self.assertRaisesRegex(fp.GuardError, "not answering"):
            fp.check_song_cache_mount(self.settings, self.mountinfo, alive=lambda p: False)

    def test_unset_refused(self):
        self.settings.song_cache = None
        with self.assertRaises(fp.GuardError):
            fp.check_song_cache_mount(self.settings, self.mountinfo, alive=lambda p: True)

    def test_shadowed_mount_uses_last_entry(self):
        with open(self.mountinfo, "a") as f:
            f.write(f"95 90 0:60 / {str(self.cache).replace(' ', chr(92) + '040')} rw - tmpfs tmpfs rw\n")
        with self.assertRaisesRegex(fp.GuardError, "tmpfs"):
            fp.check_song_cache_mount(self.settings, self.mountinfo, alive=lambda p: True)

    def test_config_must_point_into_cache(self):
        data = self.dir / "data"
        data.mkdir()
        with self.assertRaisesRegex(fp.GuardError, "configure"):
            fp.check_config_points_into_cache(self.settings)
        (data / "config.json").write_text(json.dumps({"cache_paths": {"songs": "/somewhere/else"}}))
        with self.assertRaisesRegex(fp.GuardError, "outside"):
            fp.check_config_points_into_cache(self.settings)
        (data / "config.json").write_text(json.dumps({"cache_paths": {"songs": str(self.cache / "songs")}}))
        self.assertEqual(fp.check_config_points_into_cache(self.settings), self.cache / "songs")


class ReservationTests(unittest.TestCase):
    NOW = dt.datetime(2026, 11, 20, 12, 0)

    def check(self, text, lookahead_min=0):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, UUID)
            if text is not None:
                p.write_text(text)
            return fp.read_reservation(p, self.NOW, dt.timedelta(minutes=lookahead_min))

    def test_missing_file_is_clear(self):
        self.assertIsNone(self.check(None))

    def test_touched_file_reserves(self):
        r = self.check("")
        self.assertTrue(r.active)

    def test_window(self):
        r = self.check("from 2026-11-20T11:00 until 2026-11-20T13:30 by pubverse-brett\n")
        self.assertTrue(r.active)
        self.assertEqual(r.holder, "pubverse-brett")
        self.assertIsNone(self.check("from 2026-11-19T11:00 until 2026-11-19T13:30 by x\n"))

    def test_upcoming_window_within_lookahead(self):
        text = "# next replay\nfrom 2026-11-20T12:05 until 2026-11-20T14:00 by replay\n"
        r = self.check(text, lookahead_min=10)
        self.assertIsNotNone(r)
        self.assertFalse(r.active)
        self.assertIsNone(self.check(text, lookahead_min=0))

    def test_unparsed_line_reserves(self):
        self.assertTrue(self.check("DeepThought replay tonight\n").active)
        self.assertTrue(self.check("from yesterday until tomorrow\n").active)

    def test_timezone_aware(self):
        local = self.NOW.astimezone()
        start = (local - dt.timedelta(hours=1)).isoformat()
        until = (local + dt.timedelta(hours=1)).astimezone(dt.timezone.utc).isoformat()
        self.assertTrue(self.check(f"from {start} until {until}\n").active)


class FakeRunner:
    """Stands in for subprocess: nvidia-smi and systemctl."""

    def __init__(self, gpus, apps="", main_pid="0", active="active"):
        self.gpus, self.apps, self.main_pid, self.active = gpus, apps, main_pid, active
        self.calls = []

    def __call__(self, argv, timeout=20.0):
        self.calls.append(list(argv))
        out = ""
        if argv[0].endswith("nvidia-smi") and argv[1].startswith("--query-gpu"):
            out = self.gpus
        elif argv[0].endswith("nvidia-smi"):
            out = self.apps
        elif argv[:3] == ["systemctl", "--user", "show"]:
            out = self.main_pid
        elif argv[:3] == ["systemctl", "--user", "is-active"]:
            out = self.active
        return SimpleNamespace(returncode=0, stdout=out + "\n", stderr="")


class GpuTests(unittest.TestCase):
    GPUS = (f"0, {UUID}, NVIDIA GeForce RTX 4090, 4000, 24564\n"
            "1, GPU-ffffffff-1111-2222-3333-444444444444, NVIDIA RTX PRO 6000, 90000, 97887")

    def settings(self, d):
        return fp.Settings.from_env({"NIGHTINGALE_DATA_PATH": d, "CUDA_VISIBLE_DEVICES": UUID,
                                     "FIRESONG_GPU_RESERVATIONS_DIR": d, "FIRESONG_GPU_MIN_FREE_GB": "6"})

    def test_own_usage_counts_as_free(self):
        with tempfile.TemporaryDirectory() as d:
            runner = FakeRunner(self.GPUS, apps=f"4242, {UUID}, 9000\n77, {UUID}, 2000")
            st = fp.GpuProbe(self.settings(d), runner=runner, pid_finder=lambda: {4242}).query()
            self.assertEqual(st.name, "NVIDIA GeForce RTX 4090")
            self.assertEqual(st.own, 9000 * fp.MIB)
            self.assertEqual(st.own_pids, (4242,))
            ok, _ = fp.gpu_verdict(st, 6 * fp.GIB)
            self.assertTrue(ok, "4000 MiB free + 9000 MiB of our own analyzer is enough")

    def test_low_vram_from_others_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            st = fp.GpuProbe(self.settings(d), runner=FakeRunner(self.GPUS), pid_finder=set).query()
            ok, reason = fp.gpu_verdict(st, 6 * fp.GIB)
            self.assertFalse(ok)
            self.assertIn("need 6 GiB", reason)

    def test_reservation_blocks_even_with_free_vram(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, UUID).write_text("")
            gpus = self.GPUS.replace("4000", "20000")
            st = fp.GpuProbe(self.settings(d), runner=FakeRunner(gpus), pid_finder=set).query()
            ok, reason = fp.gpu_verdict(st, 6 * fp.GIB)
            self.assertFalse(ok)
            self.assertIn("reserved", reason)

    def test_missing_gpu_and_smi_failure(self):
        with tempfile.TemporaryDirectory() as d:
            s = self.settings(d)
            s.gpu = "GPU-nope"
            st = fp.GpuProbe(s, runner=FakeRunner(self.GPUS), pid_finder=set).query()
            self.assertFalse(fp.gpu_verdict(st, 0)[0])

            def boom(argv, timeout=20.0):
                raise OSError("no nvidia-smi")
            st = fp.GpuProbe(self.settings(d), runner=boom, pid_finder=set).query()
            self.assertIn("nvidia-smi failed", fp.gpu_verdict(st, 0)[1])


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.songs = self.root / "songs"

    def tearDown(self):
        self.tmp.cleanup()

    def song(self, h, mb, mtime, finished=True):
        write_size(self.songs / f"{h}_vocals.mp3", mb * fp.MIB // 2, mtime)
        write_size(self.songs / f"{h}_instrumental.mp3", mb * fp.MIB // 2, mtime)
        write_size(self.songs / f"{h}_cover.jpg", 1000, mtime)
        if finished:
            write_size(self.songs / f"{h}_transcript.json", 100, mtime)

    def test_scan_groups_sources_and_videos(self):
        a = h64("a")
        self.song(a, 4, 1000)
        write_size(self.songs / "sources" / f"{a}.flac", 3 * fp.MIB)
        write_size(self.songs / "playable_videos" / f"{a}.mp4", 2 * fp.MIB)
        write_size(self.songs / "notes.txt", 10)
        u = fp.scan_cache(self.root, self.songs, statvfs=False)
        g = u.groups[a]
        self.assertTrue(g.finished)
        self.assertGreaterEqual(g.bytes, 9 * fp.MIB)
        self.assertEqual(len(g.files), 5)  # 2 stems, transcript, source, video; not the cover
        self.assertGreater(g.cover_bytes, 0)
        self.assertGreater(u.other_bytes, 0)
        self.assertGreaterEqual(u.walk_bytes, g.bytes)

    def test_lru_eviction_plan(self):
        old, mid, new, prot, partial, busy = (h64(x) for x in "abcdef")
        self.song(old, 10, 1000)
        self.song(mid, 10, 2000)
        self.song(new, 10, 3000)
        self.song(prot, 10, 500)
        self.song(partial, 10, 100, finished=False)
        self.song(busy, 10, 50)
        u = fp.scan_cache(self.root, self.songs, statvfs=False)
        played = {mid: 5000.0}  # played recently: newer than `new`
        victims, projected = fp.plan_eviction(
            u, cap=u.walk_bytes - 15 * fp.MIB, need=0, protected={prot}, busy={busy},
            last_used=lambda g: max(played.get(g.hash, 0.0), g.mtime))
        self.assertEqual([v.hash for v in victims], [old, new])
        self.assertLessEqual(projected, u.walk_bytes - 15 * fp.MIB)

    def test_nothing_to_evict_when_under_cap(self):
        self.song(h64("a"), 1, 1)
        u = fp.scan_cache(self.root, self.songs, statvfs=False)
        victims, _ = fp.plan_eviction(u, cap=10 * fp.GB, need=fp.MIB, protected=set(), busy=set(),
                                      last_used=lambda g: g.mtime)
        self.assertEqual(victims, [])

    def test_ledger_round_trip_and_profiles(self):
        led = fp.Ledger(self.root / "data" / "firesong" / "lru.json")
        led.mark(["a", "b", ""], 10.0)
        led.mark(["a"], 5.0)
        led.save()
        self.assertEqual(fp.Ledger(led.path).data, {"a": 10.0, "b": 10.0})
        self.assertEqual(oct(led.path.stat().st_mode & 0o777), "0o600")
        (self.root / "profiles.json").write_text(json.dumps({"scores": [
            {"profile": "p", "song_hash": "a", "score": 500, "played_at": 7},
            {"profile": "q", "song_hash": "a", "score": 900, "played_at": 9}]}))
        self.assertEqual(fp.played_at(self.root), {"a": 9.0})


class ConfigureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.data = d / "data"
        self.data.mkdir()
        self.settings = fp.Settings.from_env({
            "NIGHTINGALE_DATA_PATH": str(self.data), "FIRESONG_SONG_CACHE": str(d / "cache"),
            "FIRESONG_MODELS_DIR": "/staging/models", "FIRESONG_VENDOR_DIR": "/staging/vendor"})

    def tearDown(self):
        self.tmp.cleanup()

    def test_writes_paths_and_keeps_other_keys(self):
        cfg = self.data / "config.json"
        cfg.write_text(json.dumps({"library_source": {"kind": "plex", "access_token": "enc:secret"},
                                   "cache_paths": {"videos": "/v"}, "auto_analyze": True}))
        os.chmod(cfg, 0o640)
        self.assertEqual(fp.configure(self.settings, quiet_log()), 0)
        out = json.loads(cfg.read_text())
        self.assertEqual(out["library_source"]["access_token"], "enc:secret")
        self.assertEqual(out["cache_paths"], {"videos": "/v", "songs": str(self.settings.song_dir),
                                              "models": "/staging/models", "vendor": "/staging/vendor"})
        self.assertIs(out["auto_analyze"], False)
        self.assertEqual(oct(cfg.stat().st_mode & 0o777), "0o640")
        before = cfg.read_text()
        self.assertEqual(fp.configure(self.settings, quiet_log()), 0)
        self.assertEqual(cfg.read_text(), before)

    def test_refuses_when_songs_exist_elsewhere(self):
        write_size(self.data / "cache" / f"{h64('x')}_transcript.json", 10)
        with self.assertRaisesRegex(fp.GuardError, "already holds analysed songs"):
            fp.configure(self.settings, quiet_log())
        self.assertEqual(fp.configure(self.settings, quiet_log(), force=True), 0)

    def test_refuses_while_server_runs_and_dry_run_writes_nothing(self):
        with self.assertRaisesRegex(fp.GuardError, "server is running"):
            fp.configure(self.settings, quiet_log(), server_active=lambda: True)
        self.assertEqual(fp.configure(self.settings, quiet_log(), dry_run=True), 0)
        self.assertFalse((self.data / "config.json").exists())


class CliTests(unittest.TestCase):
    def test_bare_playlist_means_prep(self):
        with tempfile.TemporaryDirectory() as d:
            env = Path(d, "env")
            env.write_text(f"NIGHTINGALE_DATA_PATH={d}/data\nFIRESONG_SONG_CACHE={d}/not-mounted\n")
            stderr = io.StringIO()
            old = sys.stderr
            sys.stderr = stderr
            try:
                rc = fp.main(["--env", str(env), "Party Mix"])
            finally:
                sys.stderr = old
            self.assertEqual(rc, fp.EXIT_GUARD)
            self.assertIn("not mounted", stderr.getvalue())


# ---------------------------------------------------------------------------
# end to end against a fake server


class FakeNightingale:
    """Enough of the Nightingale command API for prep, with simulated analysis."""

    def __init__(self, song_dir: Path, token: str | None = None, ticks_per_song: int = 2,
                 song_mb: int = 6):
        self.song_dir = song_dir
        self.token = token
        self.ticks = ticks_per_song
        self.song_mb = song_mb
        self.lock = threading.RLock()
        self.songs: list[dict] = []
        self.playlists: dict[str, tuple[str, list[int]]] = {}
        self.queue: dict[str, object] = {}
        self.order: list[str] = []
        self.progress: dict[str, int] = {}
        self.calls: list[tuple[str, object]] = []
        self.own_vram = 0  # MiB held by the simulated analyzer
        self.analyzing_seen = 0
        self.ready = True

    # ---- library
    def add_song(self, item_id: str, title: str, analyzed=False, playlists=()):
        song = {"file_hash": h32(f"plex:{item_id}"), "title": title, "artist": "Tester",
                "is_analyzed": analyzed, "origin": {"kind": "plex", "item_id": item_id,
                                                    "part_key": f"/library/parts/{item_id}",
                                                    "container": "flac", "cover_tag": None}}
        self.songs.append(song)
        for pl in playlists:
            self.playlists[pl][1].append(len(self.songs) - 1)
        return song

    def add_playlist(self, pid: str, label: str):
        self.playlists[pid] = (label, [])

    def by_hash(self, h):
        return next((s for s in self.songs if s["file_hash"] == h), None)

    # ---- analysis simulation (advances on every queue read)
    def tick(self):
        if not self.order:
            return
        h = self.order[0]
        song = self.by_hash(h)
        if song is None:
            self.order.pop(0)
            self.queue.pop(h, None)
            return
        n = self.progress.get(h, 0) + 1
        self.progress[h] = n
        if n == 1:
            # download + rekey to the content hash, as prepare_audio_for_analysis does
            new = h64("content:" + song["origin"]["item_id"])
            self.queue.pop(h, None)
            song["file_hash"] = new
            self.order[0] = new
            self.progress[new] = n
            self.queue[new] = {"Analyzing": 10}
            self.own_vram = 9000
            self.analyzing_seen += 1
            write_size(self.song_dir / "sources" / f"{new}.flac", self.song_mb * fp.MIB // 2)
        elif n > self.ticks:
            write_size(self.song_dir / f"{h}_vocals.mp3", self.song_mb * fp.MIB // 4)
            write_size(self.song_dir / f"{h}_instrumental.mp3", self.song_mb * fp.MIB // 4)
            write_size(self.song_dir / f"{h}_transcript.json", 2000)
            song["is_analyzed"] = True
            self.queue.pop(h, None)
            self.order.pop(0)
        else:
            self.queue[h] = {"Analyzing": 50}

    def restart(self):
        with self.lock:
            self.queue.clear()
            self.order.clear()
            self.own_vram = 0

    # ---- commands
    def handle(self, name: str, payload: dict):
        with self.lock:
            self.calls.append((name, payload))
            if name == "is_ready":
                return self.ready
            if name == "trigger_scan":
                return None
            if name == "load_songs_meta":
                return {"count": len(self.songs)}
            if name == "load_library_menu_items":
                return {"playlists": [{"value": pid, "label": label, "count": len(ix)}
                                      for pid, (label, ix) in self.playlists.items()]}
            if name == "load_songs":
                params = payload["params"]
                pid = params["filters"]["playlist"]
                rows = [self.songs[i] for i in self.playlists.get(pid, ("", []))[1]]
                page = rows[params["skip"]: params["skip"] + params["take"]]
                return {"count": len(rows), "processed": [dict(s) for s in page]}
            if name == "load_analysis_queue":
                self.tick()
                return {"entries": dict(self.queue)}
            if name == "load_playback_queue":
                return []
            if name == "enqueue":
                n = 0
                for h in payload["target"]["hashes"]:
                    if h not in self.queue and self.by_hash(h) is not None:
                        self.queue[h] = "Queued"
                        self.order.append(h)
                        self.progress.pop(h, None)
                        n += 1
                return n
            if name == "cancel_analysis":
                hashes = set(payload["target"]["hashes"])
                was_active = bool(self.order) and self.order[0] in hashes and \
                    isinstance(self.queue.get(self.order[0]), dict)
                for h in hashes:
                    self.queue.pop(h, None)
                self.order = [h for h in self.order if h not in hashes]
                if was_active:
                    self.own_vram = 0  # the in-flight cancel kills the analyzer process
                return len(hashes)
            if name == "delete_song_cache":
                for h in payload["target"]["hashes"]:
                    for p in self.song_dir.glob(f"{h}_*"):
                        if not p.name.endswith("_cover.jpg"):
                            p.unlink()
                    s = self.by_hash(h)
                    if s:
                        s["is_analyzed"] = False
                return 1
            raise KeyError(name)


def serve(fake: FakeNightingale):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def authorised(self):
            return fake.token is None or self.headers.get("x-firesong-host-token") == fake.token

        def reply(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self.authorised():
                return self.reply(401, "host token required")
            self.reply(200 if self.path == "/api/bootstrap" else 404, {})

        def do_POST(self):
            if not self.authorised():
                return self.reply(401, "host token required")
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            name = self.path.rsplit("/", 1)[-1]
            try:
                self.reply(200, fake.handle(name, json.loads(body or b"{}")))
            except KeyError:
                self.reply(400, f"unknown command {name}")

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class FakeGpu:
    """GpuProbe stand-in: 20 GiB free apart from what the fake analyzer holds."""

    def __init__(self, fake: FakeNightingale, reserve_on_first_song=False, reserve_for_queries=3):
        self.fake = fake
        self.reserve_on_first_song = reserve_on_first_song
        self.reserve_for = reserve_for_queries
        self.reserved = False
        self.triggered = False
        self.queries_while_reserved = 0
        self.max_own_while_reserved = 0

    def query(self, lookahead=dt.timedelta(0)):
        with self.fake.lock:
            own = self.fake.own_vram
            if self.reserve_on_first_song and not self.triggered and self.fake.analyzing_seen:
                self.reserved = self.triggered = True
            if self.reserved:
                self.queries_while_reserved += 1
                if self.queries_while_reserved > self.reserve_for:
                    self.reserved = False
        st = fp.GpuStatus(uuid=UUID, name="Fake 4090", free=20 * fp.GIB - own * fp.MIB,
                          total=24 * fp.GIB, own=own * fp.MIB, own_pids=(4242,) if own else ())
        if self.reserved:
            st.reservation = fp.Reservation(True, "test-holder")
        return st


class Clock:
    def __init__(self):
        self.t = 0.0

    def sleep(self, s):
        self.t += max(s, 0.001)

    def monotonic(self):
        return self.t


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cache = root / "cache"
        self.song_dir = self.cache / "songs"
        self.song_dir.mkdir(parents=True)
        self.data = root / "data"
        (self.data / "firesong").mkdir(parents=True)
        (self.data / "firesong" / "host-token").write_text("ab" * 16 + "\n")
        (self.data / "config.json").write_text(json.dumps({"cache_paths": {"songs": str(self.song_dir)}}))
        self.fake = FakeNightingale(self.song_dir, token="ab" * 16)
        self.httpd = serve(self.fake)
        self.settings = fp.Settings.from_env({
            "NIGHTINGALE_DATA_PATH": str(self.data), "FIRESONG_SONG_CACHE": str(self.cache),
            "FIRESONG_SERVER_URL": f"http://127.0.0.1:{self.httpd.server_address[1]}",
            "FIRESONG_SONG_CACHE_MAX_GB": "1", "CUDA_VISIBLE_DEVICES": UUID})
        self.fake.add_playlist("plex:900", "Party Mix")
        self.fake.add_playlist("plex:901", "Other")
        for i in range(5):
            self.fake.add_song(str(100 + i), f"Song {i}", analyzed=(i < 2), playlists=["plex:900"])
        self.fake.add_song("200", "Elsewhere", playlists=["plex:901"])
        self.runner = FakeRunner("", active="active")
        self.restarts = 0

        def runner(argv, timeout=20.0):
            if argv[:3] == ["systemctl", "--user", "restart"]:
                self.restarts += 1
                self.fake.restart()
            return self.runner(argv, timeout)
        self.run_cmd = runner

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def prep(self, gpu=None, **opts):
        clock = Clock()
        options = fp.PrepOptions(poll=1.0, resume_after=3.0, use_statvfs=False, **opts)
        api = fp.Api(self.settings.server_url, fp.read_host_token(self.settings.host_token_file), timeout=5,
                     log=quiet_log())
        prep = fp.Prep(self.settings, api, gpu or FakeGpu(self.fake), quiet_log(), options,
                       sleep=clock.sleep, monotonic=clock.monotonic, runner=self.run_cmd)
        return prep

    def names(self):
        return [c[0] for c in self.fake.calls]

    def test_preps_playlist_in_batches_and_frees_gpu(self):
        prep = self.prep(batch=2)
        self.assertEqual(prep.run(["party mix"]), fp.EXIT_OK)
        party = [self.fake.songs[i] for i in self.fake.playlists["plex:900"][1]]
        self.assertTrue(all(s["is_analyzed"] for s in party))
        self.assertFalse(self.fake.songs[-1]["is_analyzed"], "other playlists are left alone")
        enq = [c[1]["target"]["hashes"] for c in self.fake.calls if c[0] == "enqueue"]
        self.assertEqual([len(b) for b in enq], [2, 1])
        self.assertIn("trigger_scan", self.names())
        # idle analyzer kept its CUDA context: one restart at the end frees it
        self.assertEqual(self.restarts, 1)
        led = json.loads((self.data / "firesong" / "song-cache-lru.json").read_text())
        self.assertTrue(all(s["file_hash"] in led["last_used"] for s in party))

    def test_reservation_cancels_frees_and_requeues(self):
        gpu = FakeGpu(self.fake, reserve_on_first_song=True, reserve_for_queries=4)
        prep = self.prep(gpu=gpu, batch=3)
        self.assertEqual(prep.run(["plex:900"]), fp.EXIT_OK)
        names = self.names()
        self.assertIn("cancel_analysis", names)
        cancel = next(c[1] for c in self.fake.calls if c[0] == "cancel_analysis")
        # cancelled by both the pre-rekey and the post-rekey hash
        self.assertGreaterEqual(len(cancel["target"]["hashes"]), 3)
        enqueues = [c for c in self.fake.calls if c[0] == "enqueue"]
        self.assertGreaterEqual(len(enqueues), 2, "re-enqueued after the reservation cleared")
        party = [self.fake.songs[i] for i in self.fake.playlists["plex:900"][1]]
        self.assertTrue(all(s["is_analyzed"] for s in party))
        self.assertTrue(gpu.triggered)
        # the in-flight cancel killed the analyzer, so no restart was needed mid-run
        self.assertEqual(self.restarts, 1)  # only the end-of-prep release

    def test_idle_analyzer_restarted_when_reservation_appears_between_batches(self):
        self.fake.own_vram = 9000  # left over from an earlier run
        gpu = FakeGpu(self.fake)
        gpu.reserved = True
        gpu.triggered = True
        gpu.reserve_for = 2
        prep = self.prep(gpu=gpu, batch=5)
        self.assertEqual(prep.run(["Party Mix"]), fp.EXIT_OK)
        self.assertEqual(self.restarts, 2)  # once to release while reserved, once at the end
        self.assertNotIn("cancel_analysis", self.names())

    def test_no_wait_exits_3(self):
        gpu = FakeGpu(self.fake)
        gpu.reserved = gpu.triggered = True
        gpu.reserve_for = 10**6
        prep = self.prep(gpu=gpu, no_wait=True)
        self.assertEqual(prep.run(["Party Mix"]), fp.EXIT_GPU)
        self.assertNotIn("enqueue", self.names())

    def test_lru_eviction_makes_room_and_drops_sources(self):
        # 40 MiB cap, already full of 20 old finished songs (2 MiB each) from
        # outside the playlist; the playlist's 3 new songs need 3 x 4 MiB.
        self.settings.cap_bytes = 40 * fp.MIB
        self.fake.song_mb = 2
        old = []
        for i in range(20):
            h = h64(f"old{i}")
            write_size(self.song_dir / f"{h}_vocals.mp3", fp.MIB // 2, mtime=1000 + i)
            write_size(self.song_dir / f"{h}_instrumental.mp3", fp.MIB // 2, mtime=1000 + i)
            write_size(self.song_dir / f"{h}_transcript.json", 100, mtime=1000 + i)
            write_size(self.song_dir / "sources" / f"{h}.flac", fp.MIB, mtime=1000 + i)
            old.append(h)
        prep = self.prep(batch=3, song_estimate=4 * fp.MIB)
        self.assertEqual(prep.run(["Party Mix"]), fp.EXIT_OK)
        deleted = [c[1]["target"]["hashes"][0] for c in self.fake.calls if c[0] == "delete_song_cache"]
        self.assertTrue(deleted)
        self.assertEqual(deleted, old[: len(deleted)], "oldest first")
        for h in deleted:
            self.assertFalse(list((self.song_dir / "sources").glob(f"{h}.*")))
        for h in old[len(deleted):]:
            self.assertTrue(list((self.song_dir / "sources").glob(f"{h}.*")))
        usage = fp.scan_cache(self.cache, self.song_dir, statvfs=False)
        self.assertLessEqual(usage.walk_bytes, 40 * fp.MIB)
        party = [self.fake.songs[i] for i in self.fake.playlists["plex:900"][1]]
        self.assertTrue(all(s["is_analyzed"] for s in party))

    def test_cache_full_of_protected_songs_stops(self):
        self.settings.cap_bytes = 10 * fp.MIB
        party = [self.fake.songs[i] for i in self.fake.playlists["plex:900"][1]]
        for s in party[:2]:  # the analysed ones are on disk and protected
            write_size(self.song_dir / f"{s['file_hash']}_vocals.mp3", 8 * fp.MIB)
            write_size(self.song_dir / f"{s['file_hash']}_transcript.json", 100)
        prep = self.prep()
        self.assertEqual(prep.run(["Party Mix"]), fp.EXIT_CACHE)
        self.assertNotIn("enqueue", self.names())
        self.assertNotIn("delete_song_cache", self.names())

    def test_dry_run_changes_nothing(self):
        prep = self.prep(dry_run=True)
        prep.api.dry_run = True
        self.assertEqual(prep.run(["Party Mix"]), fp.EXIT_OK)
        self.assertFalse(set(self.names()) & fp.MUTATING)
        self.assertEqual(self.restarts, 0)
        self.assertFalse((self.data / "firesong" / "song-cache-lru.json").exists())

    def test_failed_song_is_retried_then_reported(self):
        orig = self.fake.tick

        def failing_tick():
            if self.fake.order and self.fake.by_hash(self.fake.order[0])["title"] == "Song 3":
                h = self.fake.order.pop(0)
                self.fake.queue[h] = {"Failed": "audio prep failed: boom"}
                return
            orig()
        self.fake.tick = failing_tick
        prep = self.prep(batch=1, retries=1)
        self.assertEqual(prep.run(["Party Mix"]), fp.EXIT_ERROR)
        enq = [c[1]["target"]["hashes"] for c in self.fake.calls if c[0] == "enqueue"]
        song3 = h32("plex:103")
        self.assertEqual(sum(1 for b in enq if song3 in b), 2, "tried twice")

    def test_unknown_playlist_and_missing_token(self):
        prep = self.prep()
        with self.assertRaisesRegex(fp.GuardError, "no playlist named"):
            prep.run(["Nope"])
        prep.api.token = None
        with self.assertRaisesRegex(fp.GuardError, "not reachable"):
            prep.run(["Party Mix"])

    def test_analyzer_not_set_up(self):
        self.fake.ready = False
        with self.assertRaisesRegex(fp.GuardError, "not set up"):
            self.prep().run(["Party Mix"])


if __name__ == "__main__":
    unittest.main()
