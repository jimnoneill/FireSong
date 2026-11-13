#!/usr/bin/env python3
"""FireSong song prep for the server machine: analyse Plex playlists ahead of a party.

Design section 7 / WP1. The command-line entry point is party-prep.py; this
module holds the logic so the tests can import it.

prep (default)
  1. Refuses to run unless FIRESONG_SONG_CACHE is a live NFS mount and
     config.json puts the songs cache inside it.
  2. Rescans the library, resolves each playlist name to its id
     (plex:<ratingKey>), and enqueues the unanalysed songs in small batches.
  3. GPU guard: while ~/.config/gpu-reservations/<gpu uuid> is in force, or
     the pinned GPU has less than FIRESONG_GPU_MIN_FREE_GB free (FireSong's own
     analyzer not counted), it cancels the batch, makes sure the analyzer's
     CUDA context is gone, waits, and re-enqueues. Finished stems and
     transcripts are kept, so nothing is lost.
  4. Keeps the cache under FIRESONG_SONG_CACHE_MAX_GB: before each batch it
     evicts the least recently used finished songs that are not in the
     playlists being prepped or in the play queue.
  5. When done, restarts the server once if its idle analyzer still holds
     VRAM (--keep-running skips that; WP1b makes it unnecessary).

Other subcommands: status, evict, gpu-check, configure, self-test.

Exit codes: 0 ok, 1 error, 2 mount/config guard refused, 3 GPU busy,
4 cache cap cannot be met, 5 server unreachable or analyzer not set up.

Standard library only; /usr/bin/python3 (3.10+).
"""
from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_GUARD = 2
EXIT_GPU = 3
EXIT_CACHE = 4
EXIT_SERVER = 5

GB = 1000**3
GIB = 1024**3
MIB = 1024**2

DEFAULT_ENV_FILE = Path.home() / ".config" / "firesong" / "firesong.env"
DEFAULT_RESERVATIONS = Path.home() / ".config" / "gpu-reservations"
NFS_TYPES = ("nfs", "nfs4")
PLACEHOLDER = re.compile(r"<[^<>]+>")


class GuardError(Exception):
    """A safety guard refused to let prep run."""

    def __init__(self, message: str, code: int = EXIT_GUARD):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------
# logging


class Log:
    def __init__(self, quiet: bool = False, stream=None):
        self.quiet = quiet
        self.stream = stream or sys.stderr

    def _emit(self, level: str, msg: str) -> None:
        stamp = dt.datetime.now().strftime("%H:%M:%S")
        print(f"{stamp} {level}{msg}", file=self.stream, flush=True)

    def info(self, msg: str) -> None:
        if not self.quiet:
            self._emit("", msg)

    def warn(self, msg: str) -> None:
        self._emit("warning: ", msg)

    def error(self, msg: str) -> None:
        self._emit("error: ", msg)


# --------------------------------------------------------------------------
# environment


ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def parse_env_file(text: str) -> dict[str, str]:
    """Parse KEY=VALUE lines the way systemd's EnvironmentFile does (no
    expansion, no inline comments; one level of matching quotes removed)."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        m = ENV_LINE.match(line)
        if not m:
            continue
        value = m.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[m.group(1)] = value
    return out


def load_env(env_file: Path | None, environ: Mapping[str, str]) -> tuple[dict[str, str], Path | None]:
    """Env file values first, then the process environment on top."""
    merged: dict[str, str] = {}
    used: Path | None = None
    path = env_file if env_file is not None else DEFAULT_ENV_FILE
    if path.is_file():
        merged.update(parse_env_file(path.read_text(encoding="utf-8")))
        used = path
    elif env_file is not None:
        raise GuardError(f"env file {env_file} not found", EXIT_ERROR)
    merged.update({k: v for k, v in environ.items() if v != ""})
    return merged, used


@dataclasses.dataclass
class Settings:
    data_path: Path
    song_cache: Path | None
    song_dir: Path | None
    cap_bytes: int
    server_url: str
    host_token_file: Path
    gpu: str
    min_free_bytes: int
    reservations_dir: Path
    unit: str
    models_dir: Path | None
    vendor_dir: Path | None
    env_file: Path | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str], env_file: Path | None = None) -> "Settings":
        def need(key: str) -> str:
            value = env.get(key, "")
            if not value:
                raise GuardError(f"{key} is not set (see deploy/server/firesong.env.example)", EXIT_ERROR)
            if PLACEHOLDER.search(value):
                raise GuardError(f"{key} still holds a placeholder: {value}", EXIT_ERROR)
            return value

        def opt_path(key: str) -> Path | None:
            value = env.get(key, "")
            if not value or PLACEHOLDER.search(value):
                return None
            return Path(value)

        data = Path(need("NIGHTINGALE_DATA_PATH"))
        cache = opt_path("FIRESONG_SONG_CACHE")
        song_dir = opt_path("FIRESONG_SONG_DIR") or (cache / "songs" if cache else None)
        bind = env.get("NIGHTINGALE_BIND", "127.0.0.1:64448")
        host, _, port = bind.rpartition(":")
        if host in ("0.0.0.0", "", "[::]"):
            host = "127.0.0.1"
        server = env.get("FIRESONG_SERVER_URL") or f"http://{host}:{port}"
        gpu = env.get("FIRESONG_GPU_UUID") or env.get("CUDA_VISIBLE_DEVICES", "")
        gpu = gpu.split(",")[0].strip()
        if PLACEHOLDER.search(gpu):
            gpu = ""
        return cls(
            data_path=data,
            song_cache=cache,
            song_dir=song_dir,
            cap_bytes=int(float(env.get("FIRESONG_SONG_CACHE_MAX_GB", "36")) * GB),
            server_url=server.rstrip("/"),
            host_token_file=Path(env.get("FIRESONG_HOST_TOKEN_FILE") or data / "firesong" / "host-token"),
            gpu=gpu,
            min_free_bytes=int(float(env.get("FIRESONG_GPU_MIN_FREE_GB", "6")) * GIB),
            reservations_dir=Path(env.get("FIRESONG_GPU_RESERVATIONS_DIR") or DEFAULT_RESERVATIONS),
            unit=env.get("FIRESONG_UNIT", "firesong.service"),
            models_dir=opt_path("FIRESONG_MODELS_DIR"),
            vendor_dir=opt_path("FIRESONG_VENDOR_DIR"),
            env_file=env_file,
        )


# --------------------------------------------------------------------------
# mounts


def _unescape_mount(field: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), field)


def read_mountinfo(path: str | Path = "/proc/self/mountinfo") -> list[tuple[str, str, str]]:
    """(mount point, fstype, source) for every mount, in mount order."""
    entries = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        left, sep, right = line.partition(" - ")
        if not sep:
            continue
        lf = left.split()
        rf = right.split()
        if len(lf) < 5 or len(rf) < 2:
            continue
        entries.append((_unescape_mount(lf[4]), rf[0], _unescape_mount(rf[1])))
    return entries


def mount_at(path: Path, mountinfo: str | Path = "/proc/self/mountinfo") -> tuple[str, str] | None:
    """(fstype, source) of the mount whose mount point is exactly `path`.
    Uses only /proc, never stats the path, so a dead NFS server cannot hang it."""
    want = os.path.normpath(str(path))
    found = None
    for point, fstype, source in read_mountinfo(mountinfo):
        if point == want:
            found = (fstype, source)  # later mounts shadow earlier ones
    return found


def probe_alive(path: Path, timeout: float = 10.0) -> bool:
    try:
        r = subprocess.run(["stat", "-f", str(path)], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        return r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def check_song_cache_mount(settings: Settings, mountinfo: str | Path = "/proc/self/mountinfo",
                           alive: Callable[[Path], bool] = probe_alive) -> str:
    """Raise GuardError unless the song cache is a live NFS mount."""
    cache = settings.song_cache
    if cache is None:
        raise GuardError("FIRESONG_SONG_CACHE is not set; song prep needs the NFS song cache")
    entry = mount_at(cache, mountinfo)
    if entry is None:
        raise GuardError(f"{cache} is not mounted; refusing to prep songs onto the local disk "
                         "(owner step: docs/firesong/DEPLOY.md, NFS mount)")
    fstype, source = entry
    if fstype not in NFS_TYPES:
        raise GuardError(f"{cache} is a {fstype} mount ({source}), not NFS; refusing")
    if not alive(cache):
        raise GuardError(f"{cache} ({source}) is mounted but not answering; is the NFS server up?")
    return f"{cache} is {fstype} from {source}"


def resolve_config_path(value: str | None, base: Path) -> Path | None:
    if not value:
        return None
    p = Path(value)
    return p if p.is_absolute() else base / p


def check_config_points_into_cache(settings: Settings) -> Path:
    """Return the configured songs dir, or raise if it is not inside the cache mount."""
    cfg_path = settings.data_path / "config.json"
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise GuardError(f"{cfg_path} does not exist; run `party-prep.py configure` first") from None
    except (OSError, ValueError) as e:
        raise GuardError(f"cannot read {cfg_path}: {e}") from None
    songs = resolve_config_path(((cfg or {}).get("cache_paths") or {}).get("songs"), Path.cwd())
    assert settings.song_cache is not None
    cache = Path(os.path.normpath(str(settings.song_cache)))
    if songs is None:
        raise GuardError("config.json has no cache_paths.songs, so songs would land on the local "
                         f"disk; run `party-prep.py configure` to point it at {settings.song_dir}")
    songs = Path(os.path.normpath(str(songs)))
    if songs != cache and cache not in songs.parents:
        raise GuardError(f"config.json cache_paths.songs={songs} is outside {cache}; "
                         "run `party-prep.py configure`")
    return songs


# --------------------------------------------------------------------------
# GPU guard


LEASE_LINE = re.compile(r"from\s+(\S+)\s+until\s+(\S+)(?:\s+by\s+(.+))?")


def _local_naive(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


@dataclasses.dataclass
class Reservation:
    active: bool
    holder: str
    start: dt.datetime | None = None
    until: dt.datetime | None = None


def read_reservation(path: Path, now: dt.datetime, lookahead: dt.timedelta) -> Reservation | None:
    """Honour the server machine GPU reservation convention.

    A file named after the GPU UUID holds lines
    `from <ISO> until <ISO> by <holder>`. Inside a window the GPU is reserved;
    a window starting within `lookahead` is reported as upcoming
    (active=False). A file with no usable window (for example one made with
    `touch`) reserves the GPU until it is removed.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None
    except OSError as e:
        return Reservation(True, f"unreadable reservation file ({e})")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    if not lines:
        return Reservation(True, f"{path.name} exists (no time window)")
    upcoming: Reservation | None = None
    for line in lines:
        m = LEASE_LINE.search(line)
        if not m:
            return Reservation(True, f"unparsed reservation line: {line[:80]}")
        try:
            start, until = _local_naive(m.group(1)), _local_naive(m.group(2))
        except ValueError:
            return Reservation(True, f"unparsed reservation line: {line[:80]}")
        holder = (m.group(3) or "another job").strip()
        if start <= now < until:
            return Reservation(True, holder, start, until)
        if now < start <= now + lookahead and (upcoming is None or start < (upcoming.start or start)):
            upcoming = Reservation(False, holder, start, until)
    return upcoming


@dataclasses.dataclass
class GpuStatus:
    uuid: str = ""
    name: str = ""
    free: int = 0
    total: int = 0
    own: int = 0
    own_pids: tuple[int, ...] = ()
    reservation: Reservation | None = None
    error: str = ""

    @property
    def effective_free(self) -> int:
        return self.free + self.own


def run_cmd(argv: list[str], timeout: float = 20.0) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)


def _proc_children() -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            stat = Path(entry.path, "stat").read_text()
        except OSError:
            continue
        rest = stat.rpartition(")")[2].split()
        if len(rest) > 1:
            children.setdefault(int(rest[1]), []).append(int(entry.name))
    return children


def own_analyzer_pids(unit: str, vendor_dir: Path | None, runner=run_cmd) -> set[int]:
    """PIDs of FireSong's analyzer: descendants of the unit's main process,
    plus any analyzer/server.py running from our vendor dir."""
    pids: set[int] = set()
    try:
        r = runner(["systemctl", "--user", "show", "-p", "MainPID", "--value", unit])
        main = int((r.stdout or "0").strip() or 0)
    except (ValueError, OSError, subprocess.TimeoutExpired):
        main = 0
    if main > 0:
        kids = _proc_children()
        todo = list(kids.get(main, []))
        while todo:
            pid = todo.pop()
            if pid not in pids:
                pids.add(pid)
                todo.extend(kids.get(pid, []))
    if vendor_dir is not None:
        needle = str(vendor_dir)
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid != os.getuid():
                    continue
                cmd = Path(entry.path, "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            except OSError:
                continue
            if "analyzer/server.py" in cmd and needle in cmd:
                pids.add(int(entry.name))
    return pids


class GpuProbe:
    """Reads nvidia-smi and the reservation file for the pinned GPU."""

    def __init__(self, settings: Settings, runner=run_cmd,
                 pid_finder: Callable[[], set[int]] | None = None,
                 nvidia_smi: str | None = None,
                 clock: Callable[[], dt.datetime] = dt.datetime.now):
        self.settings = settings
        self.runner = runner
        self.smi = nvidia_smi or os.environ.get("FIRESONG_NVIDIA_SMI", "nvidia-smi")
        self.pid_finder = pid_finder or (lambda: own_analyzer_pids(settings.unit, settings.vendor_dir, runner))
        self.clock = clock

    def query(self, lookahead: dt.timedelta = dt.timedelta(0)) -> GpuStatus:
        st = GpuStatus()
        want = self.settings.gpu
        try:
            r = self.runner([self.smi, "--query-gpu=index,uuid,name,memory.free,memory.total",
                             "--format=csv,noheader,nounits"])
        except (OSError, subprocess.TimeoutExpired) as e:
            st.error = f"nvidia-smi failed: {e}"
            return st
        if r.returncode != 0:
            st.error = f"nvidia-smi failed: {(r.stderr or r.stdout).strip()[:200]}"
            return st
        rows = [[c.strip() for c in ln.split(",")] for ln in r.stdout.splitlines() if ln.strip()]
        row = None
        for cols in rows:
            if len(cols) >= 5 and (cols[1] == want or cols[0] == want or (not want and cols[0] == "0")):
                row = cols
                break
        if row is None:
            st.error = f"GPU {want or '0'} not found in nvidia-smi"
            return st
        st.uuid, st.name = row[1], row[2]
        try:
            st.free, st.total = int(float(row[3]) * MIB), int(float(row[4]) * MIB)
        except ValueError:
            st.error = f"nvidia-smi returned no memory figures for {st.uuid}"
            return st
        st.reservation = read_reservation(self.settings.reservations_dir / st.uuid, self.clock(), lookahead)
        pids = self.pid_finder()
        if pids:
            try:
                r = self.runner([self.smi, "--query-compute-apps=pid,gpu_uuid,used_memory",
                                 "--format=csv,noheader,nounits"])
                for ln in (r.stdout or "").splitlines():
                    cols = [c.strip() for c in ln.split(",")]
                    if len(cols) >= 3 and cols[1] == st.uuid and cols[0].isdigit() and int(cols[0]) in pids:
                        try:
                            st.own += int(float(cols[2]) * MIB)
                        except ValueError:
                            pass
                        st.own_pids += (int(cols[0]),)
            except (OSError, subprocess.TimeoutExpired):
                pass
        return st


def gpu_verdict(st: GpuStatus, min_free: int) -> tuple[bool, str]:
    """(ok, reason). ok=False means FireSong must not use the GPU now."""
    if st.error:
        return False, st.error
    if st.reservation is not None and st.reservation.active:
        until = f" until {st.reservation.until:%Y-%m-%d %H:%M}" if st.reservation.until else ""
        return False, f"GPU reserved by {st.reservation.holder}{until}"
    if st.reservation is not None:
        return False, (f"GPU reservation by {st.reservation.holder} starts at "
                       f"{st.reservation.start:%H:%M}; not starting new work")
    if st.effective_free < min_free:
        return False, (f"{st.effective_free / GIB:.1f} GiB free on {st.name or st.uuid} "
                       f"(need {min_free / GIB:.0f} GiB)")
    return True, f"{st.effective_free / GIB:.1f} GiB free on {st.name}"


# --------------------------------------------------------------------------
# server API


class ApiError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


MUTATING = {"enqueue", "cancel_analysis", "delete_song_cache", "trigger_scan", "reconcile_cache"}


class Api:
    def __init__(self, base: str, token: str | None = None, timeout: float = 60.0,
                 dry_run: bool = False, log: Log | None = None):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.dry_run = dry_run
        self.log = log or Log()
        # Loopback only: never route through an http_proxy from the environment.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("x-firesong-host-token", self.token)
        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode("utf-8", "replace")
            raise ApiError(f"{method} {path}: HTTP {e.code} {detail}", e.code) from None
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise ApiError(f"{method} {path}: {getattr(e, 'reason', e)}") from None
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return raw.decode("utf-8", "replace")

    def cmd(self, name: str, payload: Any = None) -> Any:
        if self.dry_run and name in MUTATING:
            self.log.info(f"[dry-run] would call {name} {json.dumps(payload) if payload else ''}".rstrip())
            return 0
        return self._request("POST", f"/api/cmd/{name}", payload if payload is not None else {})

    def ping(self) -> bool:
        try:
            self._request("GET", "/api/bootstrap")
            return True
        except ApiError:
            return False


def read_host_token(path: Path) -> str | None:
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


# --------------------------------------------------------------------------
# library helpers


EMPTY_FILTERS = {"artist": None, "album": None, "playlist": None, "query": None, "status": None,
                 "transcript_source": None, "search": None, "folder": None}


@dataclasses.dataclass
class SongRef:
    key: str
    hash: str
    title: str
    artist: str
    analyzed: bool


def song_key(song: Mapping[str, Any]) -> str:
    """Identity that survives the analyzer's rekey of remote songs (their
    file_hash changes to the content hash once the original is downloaded)."""
    origin = song.get("origin") or {}
    if isinstance(origin, dict) and origin.get("kind") not in (None, "local_file") and origin.get("item_id"):
        return f"{origin['kind']}:{origin['item_id']}"
    return f"hash:{song.get('file_hash', '')}"


def resolve_playlists(menu: Mapping[str, Any], names: Iterable[str]) -> list[tuple[str, str]]:
    playlists = menu.get("playlists") or []
    out: list[tuple[str, str]] = []
    for name in names:
        exact = [p for p in playlists if p.get("value") == name]
        if not exact:
            exact = [p for p in playlists if str(p.get("label", "")).casefold() == name.casefold()]
        if len(exact) == 1:
            out.append((exact[0]["value"], exact[0].get("label", exact[0]["value"])))
            continue
        if len(exact) > 1:
            ids = ", ".join(f"{p['value']} ({p.get('label')})" for p in exact)
            raise GuardError(f"playlist name {name!r} is ambiguous: {ids}; pass the id instead", EXIT_ERROR)
        known = ", ".join(repr(p.get("label")) for p in playlists[:25]) or "none"
        raise GuardError(f"no playlist named {name!r}; the library has: {known}", EXIT_ERROR)
    return out


def list_playlist_songs(api: Api, playlist_ids: Iterable[str], page: int = 500) -> dict[str, SongRef]:
    songs: dict[str, SongRef] = {}
    for pid in playlist_ids:
        skip = 0
        while True:
            store = api.cmd("load_songs", {"params": {
                "search": None, "filters": dict(EMPTY_FILTERS, playlist=pid),
                "sort": None, "skip": skip, "take": page}}) or {}
            batch = store.get("processed") or []
            for s in batch:
                key = song_key(s)
                if key not in songs:
                    songs[key] = SongRef(key, s.get("file_hash", ""), s.get("title", ""),
                                         s.get("artist", ""), bool(s.get("is_analyzed")))
            skip += len(batch)
            if not batch or len(batch) < page or skip >= int(store.get("count") or 0):
                break
    return songs


def queue_entries(api: Api) -> dict[str, Any]:
    return (api.cmd("load_analysis_queue") or {}).get("entries") or {}


def entry_state(status: Any) -> tuple[str, str]:
    """('queued'|'analyzing'|'failed', detail) for a QueuedStatus value."""
    if status == "Queued":
        return "queued", ""
    if isinstance(status, dict):
        if "Analyzing" in status:
            return "analyzing", f"{status['Analyzing']}%"
        if "Failed" in status:
            return "failed", str(status["Failed"])
    return "queued", ""


def play_queue_hashes(api: Api) -> set[str]:
    try:
        entries = api.cmd("load_playback_queue") or []
    except ApiError:
        return set()
    out = set()
    for e in entries if isinstance(entries, list) else []:
        h = (e.get("song") or {}).get("file_hash")
        if h:
            out.add(h)
    return out


# --------------------------------------------------------------------------
# song cache and LRU


HASH_PREFIX = re.compile(r"^([0-9a-f]{32}(?:[0-9a-f]{32})?)(?=[._]|$)")


@dataclasses.dataclass
class SongGroup:
    hash: str
    files: list[Path] = dataclasses.field(default_factory=list)
    bytes: int = 0
    mtime: float = 0.0
    finished: bool = False
    cover_bytes: int = 0


@dataclasses.dataclass
class CacheUsage:
    groups: dict[str, SongGroup]
    walk_bytes: int
    statvfs_used: int
    statvfs_total: int
    other_bytes: int

    @property
    def used(self) -> int:
        return max(self.walk_bytes, self.statvfs_used)


def _alloc(st: os.stat_result) -> int:
    blocks = getattr(st, "st_blocks", None)
    return blocks * 512 if blocks is not None else st.st_size


def scan_cache(root: Path, song_dir: Path, statvfs: bool = True) -> CacheUsage:
    """Sizes of every song's files in the songs dir (top level, sources/,
    playable_videos/), plus the whole volume's usage (root is the mount point
    of the size-capped volume, so its statvfs is the honest measure against
    the hard cap; statvfs=False judges by the files alone)."""
    groups: dict[str, SongGroup] = {}
    walk = 0
    other = 0

    def add(path: Path, st: os.stat_result, name: str) -> None:
        nonlocal other
        m = HASH_PREFIX.match(name)
        size = _alloc(st)
        if not m:
            other += size
            return
        g = groups.setdefault(m.group(1), SongGroup(m.group(1)))
        if name.endswith("_cover.jpg"):
            g.cover_bytes += size  # kept on eviction; the library UI uses it
            return
        g.files.append(path)
        g.bytes += size
        g.mtime = max(g.mtime, st.st_mtime)
        if name == f"{g.hash}_transcript.json":
            g.finished = True

    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            p = Path(dirpath, name)
            try:
                st = p.lstat()
            except OSError:
                continue
            walk += _alloc(st)
            parent = Path(dirpath)
            if parent == song_dir or parent.parent == song_dir:
                add(p, st, name)
            else:
                other += _alloc(st)
    used, total = 0, 0
    if statvfs:
        try:
            vfs = os.statvfs(root)
            used = (vfs.f_blocks - vfs.f_bfree) * vfs.f_frsize
            total = vfs.f_blocks * vfs.f_frsize
        except OSError:
            pass
    # Partial groups (stems without a transcript) are resume state for the
    # analyzer: not finished, never evicted.
    return CacheUsage(groups, walk, used, total, other)


class Ledger:
    """Last-used times FireSong records for songs (prep marks its playlists)."""

    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, float] = {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            self.data = {k: float(v) for k, v in (raw.get("last_used") or {}).items()}
        except (OSError, ValueError, AttributeError):
            self.data = {}

    def mark(self, hashes: Iterable[str], when: float) -> None:
        for h in hashes:
            if h:
                self.data[h] = max(self.data.get(h, 0.0), when)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        atomic_write(self.path, json.dumps({"version": 1, "last_used": self.data}, indent=1, sort_keys=True))


def played_at(data_path: Path) -> dict[str, float]:
    """Latest played_at per song hash from profiles.json scores."""
    try:
        raw = json.loads((data_path / "profiles.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    out: dict[str, float] = {}
    for rec in raw.get("scores") or []:
        h, t = rec.get("song_hash"), rec.get("played_at")
        if h and isinstance(t, (int, float)):
            out[h] = max(out.get(h, 0.0), float(t))
    return out


def plan_eviction(usage: CacheUsage, cap: int, need: int, protected: set[str], busy: set[str],
                  last_used: Callable[[SongGroup], float]) -> tuple[list[SongGroup], int]:
    """Pick finished, unprotected, idle songs, least recently used first,
    until used + need <= cap. Returns (victims, projected usage)."""
    projected = usage.used
    victims: list[SongGroup] = []
    if projected + need <= cap:
        return victims, projected
    candidates = [g for g in usage.groups.values()
                  if g.finished and g.hash not in protected and g.hash not in busy and g.bytes > 0]
    candidates.sort(key=lambda g: (last_used(g), g.hash))
    for g in candidates:
        if projected + need <= cap:
            break
        victims.append(g)
        projected -= g.bytes
    return victims, projected


def atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------
# the prep run


@dataclasses.dataclass
class PrepOptions:
    batch: int = 3
    poll: float = 5.0
    resume_after: float = 60.0
    hysteresis: int = 2 * GIB
    lookahead: dt.timedelta = dt.timedelta(minutes=10)
    no_wait: bool = False
    limit: int = 0
    retries: int = 1
    song_timeout: float = 45 * 60
    pause_between: float = 0.0
    release: str = "restart"  # restart | none
    scan: bool = True
    scan_timeout: float = 900.0
    song_estimate: int = 0
    dry_run: bool = False
    use_statvfs: bool = True


class Prep:
    def __init__(self, settings: Settings, api: Api, probe: GpuProbe, log: Log, opts: PrepOptions,
                 sleep: Callable[[float], None] = time.sleep, monotonic: Callable[[], float] = time.monotonic,
                 runner=run_cmd):
        self.s = settings
        self.api = api
        self.probe = probe
        self.log = log
        self.o = opts
        self.sleep = sleep
        self.now = monotonic
        self.runner = runner
        self.paused = False
        self.restarts = 0

    # ---- GPU ---------------------------------------------------------------

    def gpu_ok(self, starting: bool) -> tuple[bool, GpuStatus, str]:
        st = self.probe.query(self.o.lookahead if starting else dt.timedelta(0))
        need = self.s.min_free_bytes + (self.o.hysteresis if self.paused else 0)
        ok, reason = gpu_verdict(st, need)
        return ok, st, reason

    def wait_for_gpu(self) -> bool:
        """Block until the GPU may be used for a new batch. False with --no-wait."""
        clear_since: float | None = None
        last_note = -1e9
        released = False
        while True:
            ok, st, reason = self.gpu_ok(starting=True)
            if ok:
                if not self.paused:
                    return True
                clear_since = clear_since if clear_since is not None else self.now()
                if self.now() - clear_since >= self.o.resume_after:
                    self.log.info(f"GPU guard: clear ({reason}); resuming")
                    self.paused = False
                    return True
            else:
                clear_since = None
                if st.own > 0 and not released:
                    self.release_gpu(st, reason)
                    released = True
                if self.o.no_wait:
                    self.log.warn(f"GPU guard: {reason}; --no-wait, stopping")
                    return False
                if not self.paused or self.now() - last_note >= 300:
                    self.log.info(f"GPU guard: {reason}; waiting")
                    last_note = self.now()
                self.paused = True
            self.sleep(self.o.poll)

    def release_gpu(self, st: GpuStatus, reason: str, mid_song: bool = False) -> None:
        """Make sure FireSong's analyzer holds no VRAM. A cancelled in-flight
        song already kills the analyzer; an idle one keeps its CUDA context
        until the server restarts (no idle exit before WP1b)."""
        if mid_song:
            deadline = self.now() + 10
            while self.now() < deadline:
                self.sleep(1)
                st = self.probe.query()
                if st.own == 0:
                    self.log.info("GPU guard: analyzer released the GPU")
                    return
        if st.own == 0:
            return
        if self.o.release != "restart":
            self.log.warn(f"GPU guard: idle analyzer still holds {st.own / GIB:.1f} GiB ({reason}); "
                          "--keep-running set, not restarting the server")
            return
        self.restart_server(f"idle analyzer holds {st.own / GIB:.1f} GiB ({reason})")

    def restart_server(self, why: str) -> bool:
        unit = self.s.unit
        if self.o.dry_run:
            self.log.info(f"[dry-run] would restart {unit}: {why}")
            return True
        active = self.runner(["systemctl", "--user", "is-active", unit])
        if (active.stdout or "").strip() != "active":
            self.log.warn(f"cannot free the analyzer's GPU memory: {unit} is not an active user unit; "
                          "restart the server by hand")
            return False
        self.log.info(f"restarting {unit}: {why}")
        r = self.runner(["systemctl", "--user", "restart", unit], timeout=90)
        if r.returncode != 0:
            self.log.error(f"systemctl restart failed: {(r.stderr or '').strip()[:200]}")
            return False
        self.restarts += 1
        deadline = self.now() + 120
        while self.now() < deadline:
            if self.api.ping():
                return True
            self.sleep(2)
        self.log.error(f"{unit} did not answer within 120 s after the restart")
        return False

    # ---- cache -------------------------------------------------------------

    def usage(self) -> CacheUsage:
        assert self.s.song_cache is not None and self.s.song_dir is not None
        return scan_cache(self.s.song_cache, self.s.song_dir, self.o.use_statvfs)

    def effective_cap(self, usage: CacheUsage) -> int:
        cap = self.s.cap_bytes
        if usage.statvfs_total:
            cap = min(cap, int(usage.statvfs_total * 0.9))
        return cap

    def last_used_fn(self) -> Callable[[SongGroup], float]:
        ledger = Ledger(self.s.data_path / "firesong" / "song-cache-lru.json").data
        played = played_at(self.s.data_path)
        return lambda g: max(ledger.get(g.hash, 0.0), played.get(g.hash, 0.0), g.mtime)

    def estimate(self, usage: CacheUsage) -> int:
        if self.o.song_estimate:
            return self.o.song_estimate
        sizes = [g.bytes for g in usage.groups.values() if g.finished]
        if len(sizes) >= 3:
            return max(int(statistics.median(sizes)), 40 * MIB)
        return 60 * MIB

    def evict(self, victims: list[SongGroup]) -> int:
        freed = 0
        for g in victims:
            if self.o.dry_run:
                self.log.info(f"[dry-run] would evict {g.hash} ({g.bytes / MIB:.0f} MiB)")
                freed += g.bytes
                continue
            # The server deletes the cache files and marks the song unanalysed.
            self.api.cmd("delete_song_cache", {"target": {"kind": "hashes", "hashes": [g.hash]}})
            # It keeps the downloaded original (re-downloadable from Plex).
            assert self.s.song_dir is not None
            for src in (self.s.song_dir / "sources").glob(f"{g.hash}.*"):
                try:
                    src.unlink()
                except OSError as e:
                    self.log.warn(f"could not remove {src}: {e}")
            freed += g.bytes
            self.log.info(f"evicted {g.hash} ({g.bytes / MIB:.0f} MiB)")
        return freed

    def make_room(self, n_songs: int, protected: set[str], busy: set[str]) -> bool:
        usage = self.usage()
        cap = self.effective_cap(usage)
        need = n_songs * self.estimate(usage)
        victims, projected = plan_eviction(usage, cap, need, protected, busy, self.last_used_fn())
        if victims:
            self.log.info(f"cache {usage.used / GB:.1f} GB of {cap / GB:.1f} GB cap; evicting "
                          f"{len(victims)} least recently used song(s) to fit {n_songs} more")
            self.evict(victims)
        if projected + need > cap:
            self.log.error(f"cache cap: {projected / GB:.1f} GB used + {need / GB:.2f} GB for the next "
                           f"songs would exceed {cap / GB:.1f} GB, and only protected or "
                           "unfinished songs are left to evict")
            return False
        return True

    # ---- library -----------------------------------------------------------

    def wait_for_library(self, names: list[str]) -> None:
        self.log.info("rescanning the library")
        self.api.cmd("trigger_scan")
        if self.o.dry_run:
            return
        last = None
        stable = 0
        deadline = self.now() + self.o.scan_timeout
        poll = max(self.o.poll, 0.01)
        while self.now() < deadline:
            menu = self.api.cmd("load_library_menu_items") or {}
            meta = self.api.cmd("load_songs_meta") or {}
            sig = (meta.get("count"), tuple(sorted((p.get("value"), p.get("count"))
                                                   for p in menu.get("playlists") or [])))
            try:
                resolve_playlists(menu, names)
                found = True
            except GuardError:
                found = False
            stable = stable + 1 if (sig == last and found) else 0
            if stable >= 3:
                return
            last = sig
            self.sleep(poll)
        self.log.warn(f"library still changing after {self.o.scan_timeout:.0f} s; continuing")

    # ---- main loop ---------------------------------------------------------

    def run(self, names: list[str]) -> int:
        if not self.api.ping():
            raise GuardError(f"server not reachable at {self.s.server_url} "
                             "(is firesong.service running? does it need the host token?)", EXIT_SERVER)
        if self.api.cmd("is_ready") is False:
            raise GuardError("the analyzer is not set up yet (python, models). Finish the setup in "
                             "the FireSong UI first; prep never downloads models.", EXIT_SERVER)
        if self.o.scan:
            self.wait_for_library(names)
        playlists = resolve_playlists(self.api.cmd("load_library_menu_items") or {}, names)
        ids = [p[0] for p in playlists]
        songs = list_playlist_songs(self.api, ids)
        order = list(songs)
        todo = [k for k in order if not songs[k].analyzed]
        if self.o.limit:
            todo = todo[: self.o.limit]
        labels = ", ".join(f"{label} ({pid})" for pid, label in playlists)
        self.log.info(f"{labels}: {len(songs)} songs, {len(songs) - sum(1 for s in songs.values() if not s.analyzed)} "
                      f"already analysed, {len(todo)} to prep")
        ledger = Ledger(self.s.data_path / "firesong" / "song-cache-lru.json")
        started = time.time()
        start_hashes = {s.hash for s in songs.values()}
        if self.o.dry_run:
            return self.dry_run_plan(songs, todo)

        pending = deque(todo)
        attempts: dict[str, int] = {}
        failed: dict[str, str] = {}
        done: list[str] = []
        rc = EXIT_OK
        while pending:
            if not self.wait_for_gpu():
                rc = EXIT_GPU
                break
            songs = list_playlist_songs(self.api, ids)
            batch: list[str] = []
            while pending and len(batch) < max(1, self.o.batch):
                k = pending.popleft()
                if k in songs and not songs[k].analyzed:
                    batch.append(k)
                elif k in songs:
                    done.append(k)
            if not batch:
                continue
            protected = {s.hash for s in songs.values()} | play_queue_hashes(self.api)
            busy = set(queue_entries(self.api))
            if not self.make_room(len(batch), protected, busy):
                pending.extendleft(reversed(batch))
                rc = EXIT_CACHE
                break
            initial = {k: songs[k].hash for k in batch}
            for k in batch:
                self.log.info(f"queue: {songs[k].artist} - {songs[k].title}")
            self.api.cmd("enqueue", {"target": {"kind": "hashes", "hashes": list(initial.values())}})
            outcome = self.monitor(batch, initial, ids)
            yielded = [k for k in batch if outcome.get(k) == "yielded"]
            for k in batch:
                res = outcome.get(k, "")
                if res == "done":
                    done.append(k)
                elif res.startswith("failed"):
                    attempts[k] = attempts.get(k, 0) + 1
                    if attempts[k] <= self.o.retries:
                        self.log.warn(f"{songs[k].title}: {res}; will retry")
                        pending.append(k)
                    else:
                        failed[k] = res
            pending.extendleft(reversed(yielded))
            if self.o.pause_between and pending:
                self.sleep(self.o.pause_between)

        final = list_playlist_songs(self.api, ids)
        ledger.mark({s.hash for s in final.values()} | start_hashes, started)
        ledger.save()
        # Estimates can be low: settle the cap now that the songs are on disk.
        if rc != EXIT_CACHE:
            self.make_room(0, {s.hash for s in final.values()} | play_queue_hashes(self.api),
                           set(queue_entries(self.api)))
        analysed = sum(1 for s in final.values() if s.analyzed)
        self.log.info(f"done: {analysed}/{len(final)} playlist songs analysed; "
                      f"{len(failed)} failed, {len(pending)} not attempted")
        for k, why in failed.items():
            s = final.get(k) or songs.get(k)
            self.log.warn(f"failed: {s.artist + ' - ' + s.title if s else k}: {why}")
        if rc == EXIT_OK and failed:
            rc = EXIT_ERROR
        self.finish()
        return rc

    def dry_run_plan(self, songs: dict[str, SongRef], todo: list[str]) -> int:
        """Report what a real run would do, without changing anything."""
        ok, _st, reason = self.gpu_ok(starting=True)
        self.log.info(f"[dry-run] GPU guard: {'clear' if ok else 'would wait'}: {reason}")
        protected = {s.hash for s in songs.values()} | play_queue_hashes(self.api)
        fits = self.make_room(len(todo), protected, set(queue_entries(self.api)))
        for i in range(0, len(todo), max(1, self.o.batch)):
            names = "; ".join(f"{songs[k].artist} - {songs[k].title}" for k in todo[i:i + max(1, self.o.batch)])
            self.log.info(f"[dry-run] batch {i // max(1, self.o.batch) + 1}: {names}")
        return EXIT_OK if fits else EXIT_CACHE

    def monitor(self, batch: list[str], initial: dict[str, str], ids: list[str]) -> dict[str, str]:
        result: dict[str, str] = {}
        missing: dict[str, int] = {}
        deadline = self.now() + self.o.song_timeout * len(batch)
        while True:
            ok, st, reason = self.gpu_ok(starting=False)
            entries = queue_entries(self.api)
            songs = list_playlist_songs(self.api, ids)
            unfinished = []
            for k in batch:
                if k in result:
                    continue
                s = songs.get(k)
                if s is None:
                    result[k] = "failed: song left the playlist"
                    continue
                if s.analyzed:
                    result[k] = "done"
                    self.log.info(f"analysed: {s.artist} - {s.title}")
                    continue
                status = entries.get(s.hash, entries.get(initial[k]))
                if status is None:
                    missing[k] = missing.get(k, 0) + 1
                    if missing[k] >= 3:
                        result[k] = "failed: dropped from the analysis queue"
                    else:
                        unfinished.append(k)
                    continue
                missing.pop(k, None)
                state, detail = entry_state(status)
                if state == "failed":
                    result[k] = f"failed: {detail}"
                else:
                    unfinished.append(k)
            if not unfinished:
                return result
            if not ok:
                was_busy = any(entry_state(v)[0] == "analyzing" for v in entries.values())
                self.log.info(f"GPU guard: {reason}; cancelling {len(unfinished)} song(s)")
                hashes = sorted({songs[k].hash for k in unfinished} | {initial[k] for k in unfinished})
                self.api.cmd("cancel_analysis", {"target": {"kind": "hashes", "hashes": hashes}})
                self.paused = True
                self.release_gpu(self.probe.query(), reason, mid_song=was_busy)
                for k in unfinished:
                    result[k] = "yielded"
                return result
            if self.now() > deadline:
                self.log.warn(f"batch took longer than {self.o.song_timeout / 60:.0f} min per song; cancelling")
                hashes = sorted({songs[k].hash for k in unfinished} | {initial[k] for k in unfinished})
                self.api.cmd("cancel_analysis", {"target": {"kind": "hashes", "hashes": hashes}})
                for k in unfinished:
                    result[k] = "failed: timed out"
                return result
            self.sleep(self.o.poll)

    def finish(self) -> None:
        """Free the idle analyzer's CUDA context before the party."""
        if self.o.release != "restart":
            return
        st = self.probe.query()
        if st.own > 0 and not any(entry_state(v)[0] in ("queued", "analyzing")
                                  for v in queue_entries(self.api).values()):
            self.restart_server(f"prep finished; idle analyzer holds {st.own / GIB:.1f} GiB")


# --------------------------------------------------------------------------
# configure


def configure(settings: Settings, log: Log, force: bool = False, dry_run: bool = False,
              server_active: Callable[[], bool] | None = None) -> int:
    """Point config.json cache_paths at the song cache, models and vendor dirs,
    and keep auto_analyze off. Leaves every other key (and secret) as is."""
    if settings.song_dir is None:
        raise GuardError("FIRESONG_SONG_CACHE (or FIRESONG_SONG_DIR) is not set", EXIT_ERROR)
    if server_active is not None and server_active() and not force:
        raise GuardError("the server is running and rewrites config.json itself; stop it "
                         "(systemctl --user stop firesong) or pass --force", EXIT_ERROR)
    cfg_path = settings.data_path / "config.json"
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        if not isinstance(cfg, dict):
            raise ValueError("not a JSON object")
    except FileNotFoundError:
        cfg = {}
    except (OSError, ValueError) as e:
        raise GuardError(f"cannot read {cfg_path}: {e}", EXIT_ERROR) from None
    paths = dict(cfg.get("cache_paths") or {})
    current = resolve_config_path(paths.get("songs"), Path.cwd()) or settings.data_path / "cache"
    want = {"songs": str(settings.song_dir)}
    if settings.models_dir:
        want["models"] = str(settings.models_dir)
    if settings.vendor_dir:
        want["vendor"] = str(settings.vendor_dir)
    if os.path.normpath(str(current)) != os.path.normpath(want["songs"]) and not force:
        try:
            stale = any(p.name.endswith("_transcript.json") for p in current.iterdir())
        except OSError:
            stale = False
        if stale:
            raise GuardError(f"{current} already holds analysed songs; moving the songs cache would "
                             "leave the library pointing at missing stems. Pass --force to accept "
                             "re-analysis.", EXIT_ERROR)
    changes = {k: v for k, v in want.items() if paths.get(k) != v}
    auto = cfg.get("auto_analyze")
    if not changes and auto is False:
        log.info(f"{cfg_path} already points at {want['songs']}; nothing to do")
        return EXIT_OK
    paths.update(want)
    cfg["cache_paths"] = paths
    cfg["auto_analyze"] = False
    for k, v in changes.items():
        log.info(f"cache_paths.{k}: {v}")
    if auto is not False:
        log.info("auto_analyze: false")
    if dry_run:
        log.info(f"[dry-run] would write {cfg_path}")
        return EXIT_OK
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    mode = cfg_path.stat().st_mode & 0o777 if cfg_path.exists() else 0o600
    atomic_write(cfg_path, json.dumps(cfg, indent=2, ensure_ascii=False), mode)
    log.info(f"wrote {cfg_path}")
    return EXIT_OK


# --------------------------------------------------------------------------
# CLI


def server_unit_active(unit: str, runner=run_cmd) -> bool:
    try:
        return (runner(["systemctl", "--user", "is-active", unit]).stdout or "").strip() == "active"
    except (OSError, subprocess.TimeoutExpired):
        return False


def cmd_status(settings: Settings, args, log: Log) -> int:
    report: dict[str, Any] = {"env_file": str(settings.env_file) if settings.env_file else None}
    rc = EXIT_OK
    try:
        report["mount"] = check_song_cache_mount(settings)
        usage = scan_cache(settings.song_cache, settings.song_dir)  # type: ignore[arg-type]
        cap = min(settings.cap_bytes, int(usage.statvfs_total * 0.9)) if usage.statvfs_total else settings.cap_bytes
        finished = [g for g in usage.groups.values() if g.finished]
        report["cache"] = {
            "used_gb": round(usage.used / GB, 2), "cap_gb": round(cap / GB, 2),
            "volume_gb": round(usage.statvfs_total / GB, 2), "files_gb": round(usage.walk_bytes / GB, 2),
            "finished_songs": len(finished),
            "partial_songs": sum(1 for g in usage.groups.values() if not g.finished and g.bytes),
            "covers_mb": round(sum(g.cover_bytes for g in usage.groups.values()) / MIB, 1),
        }
        if usage.used > cap:
            rc = EXIT_CACHE
    except GuardError as e:
        report["mount"] = f"REFUSED: {e}"
        rc = EXIT_GUARD
    st = GpuProbe(settings).query(dt.timedelta(minutes=10))
    ok, reason = gpu_verdict(st, settings.min_free_bytes)
    report["gpu"] = {"ok": ok, "reason": reason, "uuid": st.uuid, "name": st.name,
                     "free_gib": round(st.free / GIB, 1), "own_gib": round(st.own / GIB, 1),
                     "own_pids": list(st.own_pids)}
    token = read_host_token(settings.host_token_file)
    api = Api(settings.server_url, token, timeout=10)
    srv: dict[str, Any] = {"url": settings.server_url, "reachable": api.ping(),
                           "unit_active": server_unit_active(settings.unit)}
    if srv["reachable"]:
        try:
            srv["analyzer_ready"] = api.cmd("is_ready")
            counts: dict[str, int] = {}
            for v in queue_entries(api).values():
                counts[entry_state(v)[0]] = counts.get(entry_state(v)[0], 0) + 1
            srv["queue"] = counts
        except ApiError as e:
            srv["error"] = str(e)
    report["server"] = srv
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for k, v in report.items():
            print(f"{k}: {v if not isinstance(v, dict) else json.dumps(v)}")
    return rc


def cmd_evict(settings: Settings, args, log: Log) -> int:
    check_song_cache_mount(settings)
    songs_dir = check_config_points_into_cache(settings)
    settings.song_dir = songs_dir
    token = read_host_token(settings.host_token_file)
    api = Api(settings.server_url, token, dry_run=args.dry_run, log=log)
    if not api.ping():
        raise GuardError(f"server not reachable at {settings.server_url}; eviction goes through the "
                         "server so the library forgets the evicted songs", EXIT_SERVER)
    prep = Prep(settings, api, GpuProbe(settings), log, PrepOptions(dry_run=args.dry_run))
    if args.target_gb is not None:
        settings.cap_bytes = int(args.target_gb * GB)
    protected = play_queue_hashes(api)
    if args.keep_playlist:
        menu = api.cmd("load_library_menu_items") or {}
        ids = [p[0] for p in resolve_playlists(menu, args.keep_playlist)]
        protected |= {s.hash for s in list_playlist_songs(api, ids).values()}
    ok = prep.make_room(0, protected, set(queue_entries(api)))
    usage = prep.usage()
    log.info(f"cache now {usage.used / GB:.2f} GB (cap {prep.effective_cap(usage) / GB:.1f} GB)")
    return EXIT_OK if ok else EXIT_CACHE


def cmd_gpu_check(settings: Settings, args, log: Log) -> int:
    st = GpuProbe(settings).query(dt.timedelta(minutes=args.lookahead))
    ok, reason = gpu_verdict(st, settings.min_free_bytes)
    print(f"{'clear' if ok else 'busy'}: {reason}")
    if st.own:
        print(f"FireSong analyzer holds {st.own / GIB:.1f} GiB (pids {', '.join(map(str, st.own_pids))})")
    return EXIT_OK if ok else EXIT_GPU


def cmd_prep(settings: Settings, args, log: Log) -> int:
    log.info(check_song_cache_mount(settings))
    settings.song_dir = check_config_points_into_cache(settings)
    token = read_host_token(settings.host_token_file)
    api = Api(settings.server_url, token, dry_run=args.dry_run, log=log)
    opts = PrepOptions(
        batch=args.batch, poll=args.poll, resume_after=args.resume_after,
        lookahead=dt.timedelta(minutes=args.lookahead), no_wait=args.no_wait, limit=args.limit,
        retries=args.retries, song_timeout=args.song_timeout * 60, pause_between=args.pause_between,
        release="none" if args.keep_running else "restart", scan=not args.no_scan,
        song_estimate=int(args.song_estimate_mb * MIB) if args.song_estimate_mb else 0,
        dry_run=args.dry_run)
    return Prep(settings, api, GpuProbe(settings), log, opts).run(args.playlist)


def cmd_configure(settings: Settings, args, log: Log) -> int:
    return configure(settings, log, force=args.force, dry_run=args.dry_run,
                     server_active=lambda: server_unit_active(settings.unit))


def cmd_self_test(_settings, _args, _log) -> int:
    import unittest

    here = Path(__file__).resolve().parent
    tests = here / "tests"
    if not tests.is_dir():
        print(f"self-test: no tests directory at {tests}", file=sys.stderr)
        return EXIT_ERROR
    suite = unittest.defaultTestLoader.discover(str(tests), pattern="test_*.py", top_level_dir=str(here))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return EXIT_OK if result.wasSuccessful() else EXIT_ERROR


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="party-prep.py", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog="Run `party-prep.py <command> -h` for each command's options.")
    p.add_argument("--env", type=Path, help=f"env file (default {DEFAULT_ENV_FILE})")
    p.add_argument("-q", "--quiet", action="store_true")
    sub = p.add_subparsers(dest="command")

    sp = sub.add_parser("prep", help="analyse the songs of one or more playlists")
    sp.add_argument("playlist", nargs="+", help="playlist name (case-insensitive) or id such as plex:12345")
    sp.add_argument("--dry-run", action="store_true", help="read and plan only: no enqueue, cancel, evict or restart")
    sp.add_argument("--batch", type=int, default=3, help="songs enqueued at a time (default 3)")
    sp.add_argument("--limit", type=int, default=0, help="prep at most N songs")
    sp.add_argument("--poll", type=float, default=5.0, help="seconds between checks (default 5)")
    sp.add_argument("--resume-after", type=float, default=60.0,
                    help="seconds the GPU must stay clear before resuming (default 60)")
    sp.add_argument("--lookahead", type=float, default=10.0,
                    help="minutes: do not start a batch this close to a reservation (default 10)")
    sp.add_argument("--no-wait", action="store_true", help="exit 3 instead of waiting for the GPU")
    sp.add_argument("--retries", type=int, default=1, help="retries per failed song (default 1)")
    sp.add_argument("--song-timeout", type=float, default=45.0, help="minutes per song before giving up (default 45)")
    sp.add_argument("--pause-between", type=float, default=0.0,
                    help="seconds to wait between batches, to go easy on the Plex server (default 0)")
    sp.add_argument("--no-scan", action="store_true", help="skip the library rescan")
    sp.add_argument("--song-estimate-mb", type=float, default=0.0,
                    help="cache space to reserve per song (default: median of cached songs, 60 MiB when empty)")
    sp.add_argument("--keep-running", action="store_true",
                    help="never restart the server to free the idle analyzer's VRAM")
    sp.set_defaults(func=cmd_prep)

    ss = sub.add_parser("status", help="mount, cache, GPU and server state (read-only)")
    ss.add_argument("--json", action="store_true")
    ss.set_defaults(func=cmd_status)

    se = sub.add_parser("evict", help="evict least recently used finished songs down to the cap")
    se.add_argument("--dry-run", action="store_true")
    se.add_argument("--target-gb", type=float, help="evict down to this many GB instead of the cap")
    se.add_argument("--keep-playlist", action="append", default=[], help="never evict this playlist's songs")
    se.set_defaults(func=cmd_evict)

    sg = sub.add_parser("gpu-check", help="exit 0 if the GPU guard is clear, 3 if not")
    sg.add_argument("--lookahead", type=float, default=0.0, help="minutes of reservation lookahead")
    sg.set_defaults(func=cmd_gpu_check)

    sc = sub.add_parser("configure", help="point config.json at the song cache, models and vendor dirs")
    sc.add_argument("--dry-run", action="store_true")
    sc.add_argument("--force", action="store_true", help="even if the server runs or songs exist elsewhere")
    sc.set_defaults(func=cmd_configure)

    st = sub.add_parser("self-test", help="run the unit tests")
    st.set_defaults(func=cmd_self_test)
    return p


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    commands = {"prep", "status", "evict", "gpu-check", "configure", "self-test", "-h", "--help"}
    # `party-prep.py "Party Mix"` means `party-prep.py prep "Party Mix"`.
    first = next((i for i, a in enumerate(argv) if not a.startswith("-")
                  and (i == 0 or argv[i - 1] not in ("--env",))), None)
    if first is not None and argv[first] not in commands:
        argv.insert(first, "prep")
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return EXIT_ERROR
    log = Log(quiet=args.quiet)
    if args.command == "self-test":
        return cmd_self_test(None, args, log)
    try:
        env, used = load_env(args.env, os.environ)
        settings = Settings.from_env(env, used)
        return args.func(settings, args, log)
    except GuardError as e:
        log.error(str(e))
        return e.code
    except ApiError as e:
        log.error(str(e))
        return EXIT_SERVER
    except KeyboardInterrupt:
        log.warn("interrupted; songs already queued keep running in the server "
                 "(cancel them in the UI or run prep again)")
        return 130


if __name__ == "__main__":
    sys.exit(main())
