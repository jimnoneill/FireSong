#!/usr/bin/env python3
"""Fill the FireSong noraebang clip pool with license-safe stock footage.

Every clip lands in the clip directory as ``<name>.mp4`` plus a sidecar
``<name>.json`` recording its source and licence. The server
(``app-core/src/noraebang_clips.rs``) lists a clip only when that sidecar
carries an allowed licence, so this script records exactly what it checked.

Sources:
  archive   Internet Archive, Prelinger collection. No key needed. Each item's
            own ``licenseurl`` must be a public-domain mark or CC0; anything
            else (including items with no licence URL) is skipped.
  pixabay   Pixabay video API, only when PIXABAY_API_KEY is set (Pixabay
            Content License).
  pexels    Pexels video API, only when PEXELS_API_KEY is set (Pexels License).

Nothing is downloaded unless ``--apply`` is given: by default ``search``
only lists the candidates it would fetch. Clips are cut to 20-60 s,
re-encoded to silent H.264 720p with +faststart, and never committed to git.

Commands:
  search        list candidates (dry run) or, with --apply, fetch them
  placeholders  make synthetic test clips with ffmpeg (licence "original")
  verify        check the pool the way the server does and report its size

The clip directory is --clip-dir, else FIRESONG_CLIP_DIR, else
NIGHTINGALE_DATA_PATH/noraebang/clips, else ~/.nightingale/noraebang/clips.
It must be a real directory inside the server's data path (the server only
serves files under its media roots).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ALLOWED_LICENSES = ("cc0", "public-domain", "pixabay", "pexels", "original")
VIDEO_EXTENSIONS = (".mp4", ".webm")
MAX_SIDECAR_BYTES = 16 * 1024
MAX_CLIP_BYTES = 256 * 1024 * 1024
USER_AGENT = "clip-fetcher/1.0 (python-urllib)"
HTTP_TIMEOUT_SEC = 30

DEFAULT_KEYWORDS = (
    "beach couple running",
    "sunset romance",
    "fireworks",
    "waterfall",
    "cherry blossom",
    "hot air balloon",
    "neon city night",
    "retro aerobics",
    "dolphins",
    "horse on a beach",
    "flower field",
)
# Prelinger films are mid-century industrials; these terms find scenery that
# fits the genre (dancing, travel, nature) rather than the literal keywords.
ARCHIVE_KEYWORDS = (
    "beach",
    "dance",
    "fireworks",
    "waterfall",
    "flowers",
    "travel",
    "ocean",
    "city night",
)

MIN_CLIP_SEC = 20
MAX_CLIP_SEC = 60
DEFAULT_CLIP_SEC = 30
TARGET_KBPS = 3500
DEFAULT_MAX_TOTAL_MB = 4000


class FetchError(Exception):
    """A source answered with something this script cannot use."""


# --------------------------------------------------------------------------
# Paths and pool bookkeeping
# --------------------------------------------------------------------------


def resolve_clip_dir(explicit: str | None, env: dict[str, str] | None = None) -> Path:
    env = dict(os.environ) if env is None else env
    if explicit:
        return Path(explicit).expanduser()
    if env.get("FIRESONG_CLIP_DIR"):
        return Path(env["FIRESONG_CLIP_DIR"]).expanduser()
    data = env.get("NIGHTINGALE_DATA_PATH") or str(Path.home() / ".nightingale")
    return Path(data).expanduser() / "noraebang" / "clips"


def ensure_clip_dir(clip_dir: Path, create: bool) -> None:
    if clip_dir.is_symlink():
        raise SystemExit(f"{clip_dir} is a symlink; the server refuses symlinked clip directories")
    if clip_dir.exists() and not clip_dir.is_dir():
        raise SystemExit(f"{clip_dir} exists and is not a directory")
    if not clip_dir.exists():
        if not create:
            raise SystemExit(f"{clip_dir} does not exist (it is created with --apply)")
        clip_dir.mkdir(parents=True)


def warn_if_unserved(clip_dir: Path, env: dict[str, str]) -> None:
    data = env.get("NIGHTINGALE_DATA_PATH")
    if not data:
        return
    try:
        clip_dir.resolve().relative_to(Path(data).expanduser().resolve())
    except ValueError:
        print(
            f"warning: {clip_dir} is outside NIGHTINGALE_DATA_PATH; the server will not serve it",
            file=sys.stderr,
        )


def pool_bytes(clip_dir: Path) -> int:
    if not clip_dir.is_dir():
        return 0
    return sum(
        path.stat().st_size
        for path in clip_dir.iterdir()
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    )


def slug(text: str, limit: int = 48) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (cleaned or "clip")[:limit].rstrip("-")


def write_atomic(path: Path, data: bytes) -> None:
    partial = path.with_name(f".{path.name}.partial")
    partial.write_bytes(data)
    partial.replace(path)


def sidecar_for(candidate: Candidate, duration_sec: float) -> dict[str, Any]:
    sidecar: dict[str, Any] = {
        "source": candidate.source,
        "license": candidate.license,
        "tags": candidate.tags[:16],
        "duration_sec": round(duration_sec, 2),
    }
    optional = {
        "title": candidate.title,
        "author": candidate.author,
        "source_url": candidate.source_url,
        "license_url": candidate.license_url,
    }
    sidecar.update({key: value for key, value in optional.items() if value})
    return sidecar


# --------------------------------------------------------------------------
# Candidates
# --------------------------------------------------------------------------


@dataclass
class Candidate:
    source: str
    source_id: str
    license: str
    title: str = ""
    author: str = ""
    source_url: str = ""
    license_url: str = ""
    tags: list[str] = field(default_factory=list)
    duration_sec: float | None = None
    # Resolved lazily for archive items (needs one more request).
    media_url: str | None = None

    @property
    def name(self) -> str:
        return f"{self.source}-{slug(self.source_id)}"


def archive_license(license_url: str | None) -> str | None:
    """Maps an Internet Archive item ``licenseurl`` to an allowed licence, or None."""
    if not license_url:
        return None
    url = license_url.lower()
    if "creativecommons.org/publicdomain/zero/" in url:
        return "cc0"
    if "creativecommons.org/publicdomain/mark/" in url or url.rstrip("/").endswith(
        "creativecommons.org/licenses/publicdomain"
    ):
        return "public-domain"
    return None


HttpGet = Callable[[str, dict[str, str]], Any]


def http_get_json(url: str, headers: dict[str, str]) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SEC) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as error:
        # The URL may carry an API key (Pixabay), so only the host is reported.
        host = urllib.parse.urlsplit(url).netloc
        raise FetchError(f"request to {host} failed: {error}") from None


def search_archive(keyword: str, rows: int, get: HttpGet | None = None) -> list[Candidate]:
    get = get or http_get_json
    # Narrow to public-domain licence URLs server side; each one is still checked below.
    query = (
        f"collection:(prelinger) AND mediatype:(movies) AND ({keyword})"
        " AND licenseurl:(*publicdomain*)"
    )
    params = [("q", query), ("rows", str(rows)), ("output", "json"), ("page", "1")]
    params += [
        ("fl[]", name) for name in ("identifier", "title", "creator", "licenseurl", "subject")
    ]
    url = "https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(params)
    docs = get(url, {}).get("response", {}).get("docs", [])
    candidates = []
    for doc in docs:
        license_name = archive_license(_first(doc.get("licenseurl")))
        identifier = _first(doc.get("identifier"))
        if license_name is None or not identifier:
            continue
        candidates.append(
            Candidate(
                source="archive",
                source_id=identifier,
                license=license_name,
                title=_first(doc.get("title")) or identifier,
                author=_first(doc.get("creator")) or "",
                source_url=f"https://archive.org/details/{urllib.parse.quote(identifier)}",
                license_url=_first(doc.get("licenseurl")) or "",
                tags=[keyword],
            )
        )
    return candidates


def resolve_archive_media(candidate: Candidate, get: HttpGet | None = None) -> None:
    """Picks the item's MP4 derivative and its duration."""
    get = get or http_get_json
    identifier = urllib.parse.quote(candidate.source_id)
    metadata = get(f"https://archive.org/metadata/{identifier}", {})
    license_name = archive_license(_first(metadata.get("metadata", {}).get("licenseurl")))
    if license_name != candidate.license:
        raise FetchError(f"{candidate.source_id}: licence changed since the search")
    mp4s = [
        entry
        for entry in metadata.get("files", [])
        if str(entry.get("name", "")).lower().endswith(".mp4")
    ]
    if not mp4s:
        raise FetchError(f"{candidate.source_id}: no MP4 derivative")
    best = max(mp4s, key=lambda entry: float(entry.get("size") or 0))
    candidate.media_url = (
        f"https://archive.org/download/{identifier}/{urllib.parse.quote(str(best['name']))}"
    )
    length = best.get("length")
    candidate.duration_sec = _parse_duration(length) if length is not None else None


def search_pixabay(
    keyword: str, rows: int, key: str, get: HttpGet | None = None
) -> list[Candidate]:
    get = get or http_get_json
    params = {
        "key": key,
        "q": keyword,
        "per_page": str(max(3, min(rows, 200))),
        "safesearch": "true",
        "video_type": "film",
    }
    data = get("https://pixabay.com/api/videos/?" + urllib.parse.urlencode(params), {})
    candidates = []
    for hit in data.get("hits", []):
        videos = hit.get("videos", {})
        rendition = videos.get("medium") or videos.get("large") or {}
        if not rendition.get("url"):
            continue
        candidates.append(
            Candidate(
                source="pixabay",
                source_id=str(hit.get("id")),
                license="pixabay",
                title=keyword,
                author=str(hit.get("user") or ""),
                source_url=str(hit.get("pageURL") or ""),
                license_url="https://pixabay.com/service/license-summary/",
                tags=[tag.strip() for tag in str(hit.get("tags", "")).split(",") if tag.strip()],
                duration_sec=float(hit.get("duration") or 0) or None,
                media_url=str(rendition["url"]),
            )
        )
    return candidates[:rows]


def search_pexels(keyword: str, rows: int, key: str, get: HttpGet | None = None) -> list[Candidate]:
    get = get or http_get_json
    params = {"query": keyword, "per_page": str(max(1, min(rows, 80))), "orientation": "landscape"}
    data = get(
        "https://api.pexels.com/videos/search?" + urllib.parse.urlencode(params),
        {"Authorization": key},
    )
    candidates = []
    for video in data.get("videos", []):
        files = [
            entry
            for entry in video.get("video_files", [])
            if entry.get("file_type") == "video/mp4" and entry.get("link") and entry.get("width")
        ]
        if not files:
            continue
        rendition = min(files, key=lambda entry: abs(int(entry["width"]) - 1280))
        candidates.append(
            Candidate(
                source="pexels",
                source_id=str(video.get("id")),
                license="pexels",
                title=keyword,
                author=str((video.get("user") or {}).get("name") or ""),
                source_url=str(video.get("url") or ""),
                license_url="https://www.pexels.com/license/",
                tags=[keyword],
                duration_sec=float(video.get("duration") or 0) or None,
                media_url=str(rendition["link"]),
            )
        )
    return candidates


def _first(value: Any) -> str | None:
    if isinstance(value, list):
        value = value[0] if value else None
    return None if value is None else str(value)


def _parse_duration(value: Any) -> float | None:
    text = str(value)
    try:
        if ":" in text:
            seconds = 0.0
            for part in text.split(":"):
                seconds = seconds * 60 + float(part)
            return seconds
        return float(text)
    except ValueError:
        return None


def gather_candidates(
    args: argparse.Namespace, env: dict[str, str], get: HttpGet | None = None
) -> list[Candidate]:
    sources = ("archive", "pixabay", "pexels") if args.source == "all" else (args.source,)
    found: dict[str, Candidate] = {}
    for source in sources:
        keywords = args.keywords or (ARCHIVE_KEYWORDS if source == "archive" else DEFAULT_KEYWORDS)
        if source == "pixabay" and not env.get("PIXABAY_API_KEY"):
            print("pixabay: skipped (PIXABAY_API_KEY is not set)")
            continue
        if source == "pexels" and not env.get("PEXELS_API_KEY"):
            print("pexels: skipped (PEXELS_API_KEY is not set)")
            continue
        for keyword in keywords:
            try:
                if source == "archive":
                    batch = search_archive(keyword, args.per_keyword, get)
                elif source == "pixabay":
                    batch = search_pixabay(keyword, args.per_keyword, env["PIXABAY_API_KEY"], get)
                else:
                    batch = search_pexels(keyword, args.per_keyword, env["PEXELS_API_KEY"], get)
            except FetchError as error:
                print(f"{source} '{keyword}': {error}", file=sys.stderr)
                continue
            for candidate in batch:
                found.setdefault(candidate.name, candidate)
    return list(found.values())


# --------------------------------------------------------------------------
# Encoding
# --------------------------------------------------------------------------


def clip_window(
    duration_sec: float | None, clip_sec: float, rng: random.Random
) -> tuple[float, float]:
    """Start and length of the cut: a random stretch of a long film, all of a short clip."""
    clip_sec = max(MIN_CLIP_SEC, min(MAX_CLIP_SEC, clip_sec))
    if duration_sec is None or duration_sec <= 0:
        return 60.0, clip_sec
    if duration_sec <= clip_sec + 2:
        return 0.0, max(1.0, duration_sec)
    earliest = min(duration_sec * 0.1, duration_sec - clip_sec)
    latest = max(earliest, duration_sec * 0.85 - clip_sec)
    return round(rng.uniform(earliest, latest), 2), clip_sec


def encode_command(source: str, output: Path, start: float, length: float) -> list[str]:
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start:.2f}", "-t", f"{length:.2f}", "-i", source,
        "-an", "-sn", "-dn",
        "-vf", "scale=-2:720:flags=lanczos,fps=30,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high",
        "-b:v", f"{TARGET_KBPS}k", "-maxrate", "4000k", "-bufsize", "8000k",
        "-movflags", "+faststart", "-f", "mp4", "-y", str(output),
    ]  # fmt: skip


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def fetch_one(candidate: Candidate, clip_dir: Path, clip_sec: float, rng: random.Random) -> Path:
    if candidate.media_url is None:
        resolve_archive_media(candidate)
    if candidate.media_url is None:
        raise FetchError(f"{candidate.name}: no media URL")
    start, length = clip_window(candidate.duration_sec, clip_sec, rng)
    video = clip_dir / f"{candidate.name}.mp4"
    partial = clip_dir / f".{candidate.name}.partial.mp4"
    try:
        subprocess.run(encode_command(candidate.media_url, partial, start, length), check=True)
        if partial.stat().st_size > MAX_CLIP_BYTES:
            raise FetchError(f"{candidate.name}: encoded clip is too large")
        duration = probe_duration(partial)
        partial.replace(video)
    except (subprocess.CalledProcessError, OSError, ValueError) as error:
        raise FetchError(f"{candidate.name}: encoding failed ({error})") from None
    finally:
        partial.unlink(missing_ok=True)
    # The sidecar goes last: the server lists a clip only once it exists.
    sidecar = sidecar_for(candidate, duration)
    write_atomic(video.with_suffix(".json"), (json.dumps(sidecar, indent=2) + "\n").encode())
    return video


def estimated_bytes(clip_sec: float) -> int:
    return int(clip_sec * TARGET_KBPS * 1000 / 8)


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------


def command_search(args: argparse.Namespace) -> int:
    clip_dir = resolve_clip_dir(args.clip_dir)
    if args.apply:
        ensure_clip_dir(clip_dir, create=True)
    print(f"clip dir: {clip_dir}")
    warn_if_unserved(clip_dir, dict(os.environ))
    candidates = gather_candidates(args, dict(os.environ))
    fresh = [
        candidate for candidate in candidates if not (clip_dir / f"{candidate.name}.json").exists()
    ]
    budget = args.max_total_mb * 1024 * 1024 - pool_bytes(clip_dir)
    planned: list[Candidate] = []
    for candidate in fresh:
        if len(planned) >= args.max_clips or budget < estimated_bytes(args.clip_seconds):
            break
        planned.append(candidate)
        budget -= estimated_bytes(args.clip_seconds)

    for candidate in planned:
        print(f"  {candidate.license:<13} {candidate.name:<56} {candidate.source_url}")
    print(
        f"{len(candidates)} candidates, {len(candidates) - len(fresh)} already in the pool, "
        f"{len(planned)} planned (max {args.max_clips}, pool cap {args.max_total_mb} MB)"
    )
    if not args.apply:
        print("dry run: nothing downloaded. Re-run with --apply to fetch the planned clips.")
        return 0

    rng = random.Random(args.seed)
    failures = 0
    for candidate in planned:
        try:
            path = fetch_one(candidate, clip_dir, args.clip_seconds, rng)
            print(f"fetched {path.name}")
        except FetchError as error:
            failures += 1
            print(f"skipped: {error}", file=sys.stderr)
    return 1 if failures and failures == len(planned) else 0


PLACEHOLDER_SOURCES = (
    ("testsrc2", "testsrc2=size=1280x720:rate=30,hue=H=2*PI*t/8"),
    ("mandelbrot", "mandelbrot=size=1280x720:rate=30"),
    ("gradients", "gradients=size=1280x720:rate=30:speed=0.03:n=4"),
)


def command_placeholders(args: argparse.Namespace) -> int:
    clip_dir = resolve_clip_dir(args.clip_dir)
    ensure_clip_dir(clip_dir, create=True)
    count = max(1, min(args.count, len(PLACEHOLDER_SOURCES)))
    for pattern, source in PLACEHOLDER_SOURCES[:count]:
        name = f"original-placeholder-{pattern}"
        video = clip_dir / f"{name}.mp4"
        command = [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", source, "-t", f"{args.seconds:.2f}",
            "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", "1500k", "-movflags", "+faststart", "-y", str(video),
        ]  # fmt: skip
        subprocess.run(command, check=True)
        sidecar = {
            "title": f"Placeholder ({pattern})",
            "source": "original",
            "author": "FireSong",
            "license": "original",
            "tags": ["placeholder", pattern],
            "duration_sec": round(probe_duration(video), 2),
        }
        write_atomic(video.with_suffix(".json"), (json.dumps(sidecar, indent=2) + "\n").encode())
        print(f"made {video}")
    return 0


@dataclass
class PoolReport:
    listed: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    total_bytes: int = 0


def video_signature_ok(path: Path) -> bool:
    with path.open("rb") as handle:
        head = handle.read(12)
    if path.suffix.lower() == ".mp4":
        return head[4:8] == b"ftyp"
    return head.startswith(b"\x1a\x45\xdf\xa3")


def check_sidecar(sidecar_path: Path) -> str | None:
    """Mirrors the server's sidecar rules; returns a problem or None."""
    if not sidecar_path.is_file() or sidecar_path.is_symlink():
        return "no sidecar"
    if sidecar_path.stat().st_size > MAX_SIDECAR_BYTES:
        return "sidecar too large"
    try:
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "sidecar is not JSON"
    if not isinstance(sidecar, dict):
        return "sidecar is not an object"
    if sidecar.get("license") not in ALLOWED_LICENSES:
        return f"licence {sidecar.get('license')!r} is not allowed"
    if not str(sidecar.get("source", "")).strip():
        return "no source"
    return None


def inspect_pool(clip_dir: Path) -> PoolReport:
    report = PoolReport()
    for path in sorted(clip_dir.iterdir()):
        if path.suffix.lower() == ".json" and not any(
            path.with_suffix(extension).exists() for extension in VIDEO_EXTENSIONS
        ):
            report.problems.append(f"{path.name}: sidecar without a video")
            continue
        if path.suffix.lower() not in VIDEO_EXTENSIONS or path.name.startswith("."):
            continue
        problem = None
        if path.is_symlink() or not path.is_file():
            problem = "not a regular file"
        elif not 0 < path.stat().st_size <= MAX_CLIP_BYTES:
            problem = "size out of range"
        elif not video_signature_ok(path):
            problem = "container signature does not match the extension"
        else:
            problem = check_sidecar(path.with_suffix(".json"))
        if problem is None:
            report.listed.append(path.name)
            report.total_bytes += path.stat().st_size
        else:
            report.problems.append(f"{path.name}: {problem}")
    return report


def command_verify(args: argparse.Namespace) -> int:
    clip_dir = resolve_clip_dir(args.clip_dir)
    ensure_clip_dir(clip_dir, create=False)
    report = inspect_pool(clip_dir)
    for problem in report.problems:
        print(f"  skipped by the server: {problem}")
    print(
        f"{clip_dir}: {len(report.listed)} playable clips, "
        f"{report.total_bytes / 1024 / 1024:.1f} MB, {len(report.problems)} problems"
    )
    return 1 if report.problems else 0


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--clip-dir", help="clip directory (default: see above)")
    commands = parser.add_subparsers(dest="command", required=True)

    search = commands.add_parser("search", help="list candidates; --apply fetches them")
    search.add_argument("--source", choices=("archive", "pixabay", "pexels", "all"), default="all")
    search.add_argument(
        "--keywords", nargs="+", help="search terms (default: genre list per source)"
    )
    search.add_argument("--per-keyword", type=int, default=5)
    search.add_argument("--max-clips", type=int, default=20)
    search.add_argument("--max-total-mb", type=int, default=DEFAULT_MAX_TOTAL_MB)
    search.add_argument("--clip-seconds", type=float, default=DEFAULT_CLIP_SEC)
    search.add_argument("--seed", type=int, default=None, help="seed for the cut positions")
    search.add_argument(
        "--apply", action="store_true", help="download and encode (default: dry run)"
    )
    search.set_defaults(handler=command_search)

    placeholders = commands.add_parser("placeholders", help="make synthetic test clips")
    placeholders.add_argument("--count", type=int, default=3)
    placeholders.add_argument("--seconds", type=float, default=8)
    placeholders.set_defaults(handler=command_placeholders)

    verify = commands.add_parser("verify", help="check the pool like the server does")
    verify.set_defaults(handler=command_verify)
    return parser.parse_args(list(argv) if argv is not None else None)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    if shutil.which("ffmpeg") is None and args.command != "verify":
        print("ffmpeg is required", file=sys.stderr)
        return 2
    return int(args.handler(args))


if __name__ == "__main__":
    sys.exit(main())
