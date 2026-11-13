"""Tests for fetch-clips.py. Run: python3 -m unittest scripts/firesong/test_fetch_clips.py"""

from __future__ import annotations

import importlib.util
import io
import json
import random
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

_SPEC = importlib.util.spec_from_file_location(
    "fetch_clips", Path(__file__).with_name("fetch-clips.py")
)
assert _SPEC is not None and _SPEC.loader is not None
fetch_clips = importlib.util.module_from_spec(_SPEC)
# dataclasses look the module up in sys.modules while the class is created.
sys.modules[_SPEC.name] = fetch_clips
_SPEC.loader.exec_module(fetch_clips)

MP4_HEADER = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00"


def fake_get(responses: dict[str, object]):
    """A getter answering by URL prefix; records every URL asked for."""
    calls: list[str] = []

    def get(url: str, headers: dict[str, str]):
        calls.append(url)
        for prefix, response in responses.items():
            if url.startswith(prefix):
                return response
        raise fetch_clips.FetchError(f"unexpected {url}")

    get.calls = calls  # type: ignore[attr-defined]
    return get


ARCHIVE_SEARCH = {
    "response": {
        "docs": [
            {
                "identifier": "Beach1950",
                "title": "Beach Holiday",
                "creator": "Studio",
                "licenseurl": "http://creativecommons.org/licenses/publicdomain/",
            },
            {
                "identifier": "Dance1955",
                "title": ["Dance Party"],
                "licenseurl": "https://creativecommons.org/publicdomain/zero/1.0/",
            },
            {
                "identifier": "Attrib1960",
                "licenseurl": "https://creativecommons.org/licenses/by/4.0/",
            },
            {"identifier": "NoLicence1961"},
            {
                "identifier": "NonCommercial",
                "licenseurl": "https://creativecommons.org/licenses/by-nc/3.0/",
            },
        ]
    }
}


class ClipDirTest(unittest.TestCase):
    def test_precedence(self):
        env = {"FIRESONG_CLIP_DIR": "/clips", "NIGHTINGALE_DATA_PATH": "/data"}
        self.assertEqual(fetch_clips.resolve_clip_dir("/explicit", env), Path("/explicit"))
        self.assertEqual(fetch_clips.resolve_clip_dir(None, env), Path("/clips"))
        self.assertEqual(
            fetch_clips.resolve_clip_dir(None, {"NIGHTINGALE_DATA_PATH": "/data"}),
            Path("/data/noraebang/clips"),
        )
        self.assertEqual(
            fetch_clips.resolve_clip_dir(None, {}),
            Path.home() / ".nightingale" / "noraebang" / "clips",
        )


class LicenceTest(unittest.TestCase):
    def test_only_public_domain_and_cc0_pass(self):
        cases = {
            "http://creativecommons.org/licenses/publicdomain/": "public-domain",
            "https://creativecommons.org/publicdomain/mark/1.0/": "public-domain",
            "https://creativecommons.org/publicdomain/zero/1.0/": "cc0",
            "https://creativecommons.org/licenses/by/4.0/": None,
            "https://creativecommons.org/licenses/by-sa/3.0/": None,
            "https://creativecommons.org/licenses/by-nc/3.0/": None,
            "": None,
            None: None,
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(fetch_clips.archive_license(url), expected)


class SourcesTest(unittest.TestCase):
    def test_archive_search_keeps_only_safe_items(self):
        get = fake_get({"https://archive.org/advancedsearch.php": ARCHIVE_SEARCH})
        found = fetch_clips.search_archive("beach", 5, get)
        self.assertEqual([c.source_id for c in found], ["Beach1950", "Dance1955"])
        self.assertEqual([c.license for c in found], ["public-domain", "cc0"])
        self.assertEqual(found[1].title, "Dance Party")
        self.assertEqual(found[0].source_url, "https://archive.org/details/Beach1950")
        self.assertIn("collection%3A%28prelinger%29", get.calls[0])

    def test_archive_media_picks_largest_mp4_and_rechecks_licence(self):
        candidate = fetch_clips.search_archive(
            "beach", 5, fake_get({"https://archive.org/advancedsearch.php": ARCHIVE_SEARCH})
        )[0]
        metadata = {
            "metadata": {"licenseurl": "http://creativecommons.org/licenses/publicdomain/"},
            "files": [
                {"name": "Beach1950.ogv", "size": "900"},
                {"name": "Beach1950_512kb.mp4", "size": "100", "length": "00:10:05"},
                {"name": "Beach1950.mp4", "size": "500", "length": "605.5"},
            ],
        }
        fetch_clips.resolve_archive_media(
            candidate, fake_get({"https://archive.org/metadata/": metadata})
        )
        self.assertEqual(
            candidate.media_url, "https://archive.org/download/Beach1950/Beach1950.mp4"
        )
        self.assertEqual(candidate.duration_sec, 605.5)

        metadata["metadata"]["licenseurl"] = "https://creativecommons.org/licenses/by/4.0/"
        with self.assertRaises(fetch_clips.FetchError):
            fetch_clips.resolve_archive_media(
                candidate, fake_get({"https://archive.org/metadata/": metadata})
            )

    def test_pixabay_and_pexels_map_to_their_licences(self):
        pixabay = {
            "hits": [
                {
                    "id": 42,
                    "pageURL": "https://pixabay.com/videos/id-42/",
                    "tags": "beach, sunset ,",
                    "duration": 18,
                    "user": "maker",
                    "videos": {"medium": {"url": "https://cdn.pixabay.com/v/42.mp4"}},
                },
                {"id": 43, "videos": {}},
            ]
        }
        found = fetch_clips.search_pixabay(
            "beach", 5, "SECRET", fake_get({"https://pixabay.com/api/videos/": pixabay})
        )
        self.assertEqual(len(found), 1)
        self.assertEqual((found[0].license, found[0].tags), ("pixabay", ["beach", "sunset"]))
        self.assertEqual(found[0].media_url, "https://cdn.pixabay.com/v/42.mp4")

        pexels = {
            "videos": [
                {
                    "id": 7,
                    "url": "https://www.pexels.com/video/7/",
                    "duration": 25,
                    "user": {"name": "Shooter"},
                    "video_files": [
                        {"file_type": "video/mp4", "width": 3840, "link": "https://p/4k.mp4"},
                        {"file_type": "video/mp4", "width": 1280, "link": "https://p/720.mp4"},
                        {"file_type": "video/webm", "width": 1280, "link": "https://p/720.webm"},
                    ],
                }
            ]
        }
        found = fetch_clips.search_pexels(
            "beach", 5, "SECRET", fake_get({"https://api.pexels.com/videos/search": pexels})
        )
        self.assertEqual((found[0].license, found[0].author), ("pexels", "Shooter"))
        self.assertEqual(found[0].media_url, "https://p/720.mp4")

    def test_keyed_sources_need_their_keys(self):
        args = fetch_clips.parse_args(["search", "--source", "all", "--keywords", "beach"])
        get = fake_get({"https://archive.org/advancedsearch.php": ARCHIVE_SEARCH})
        with redirect_stdout(io.StringIO()) as out:
            found = fetch_clips.gather_candidates(args, {}, get)
        self.assertEqual({c.source for c in found}, {"archive"})
        self.assertIn("PIXABAY_API_KEY is not set", out.getvalue())
        self.assertIn("PEXELS_API_KEY is not set", out.getvalue())
        self.assertTrue(all("pixabay" not in url and "pexels" not in url for url in get.calls))

    def test_http_errors_never_echo_the_url(self):
        with mock.patch.object(
            fetch_clips.urllib.request,
            "urlopen",
            side_effect=fetch_clips.urllib.error.URLError("boom"),
        ):
            with self.assertRaises(fetch_clips.FetchError) as raised:
                fetch_clips.http_get_json("https://pixabay.com/api/videos/?key=SECRET&q=x", {})
        self.assertNotIn("SECRET", str(raised.exception))
        self.assertIn("pixabay.com", str(raised.exception))


class EncodingTest(unittest.TestCase):
    def test_clip_window(self):
        rng = random.Random(1)
        self.assertEqual(fetch_clips.clip_window(None, 30, rng), (60.0, 30))
        self.assertEqual(fetch_clips.clip_window(18, 30, rng), (0.0, 18))
        self.assertEqual(fetch_clips.clip_window(100, 5, rng)[1], fetch_clips.MIN_CLIP_SEC)
        self.assertEqual(fetch_clips.clip_window(100, 500, rng)[1], fetch_clips.MAX_CLIP_SEC)
        for _ in range(100):
            start, length = fetch_clips.clip_window(600, 30, rng)
            self.assertGreaterEqual(start, 60)
            self.assertLessEqual(start + length, 600 * 0.85 + 0.01)

    def test_encode_command_is_silent_720p_faststart(self):
        command = fetch_clips.encode_command("in.mp4", Path("out.mp4"), 12.5, 30)
        joined = " ".join(command)
        for part in ("-ss 12.50", "-t 30.00", "-an", "scale=-2:720", "libx264", "+faststart"):
            self.assertIn(part, joined)

    def test_sidecar_carries_licence_and_source(self):
        candidate = fetch_clips.Candidate(
            source="archive",
            source_id="Beach1950",
            license="public-domain",
            title="Beach Holiday",
            source_url="https://archive.org/details/Beach1950",
            tags=["beach"],
        )
        sidecar = fetch_clips.sidecar_for(candidate, 29.97)
        self.assertEqual(
            sidecar,
            {
                "source": "archive",
                "license": "public-domain",
                "tags": ["beach"],
                "duration_sec": 29.97,
                "title": "Beach Holiday",
                "source_url": "https://archive.org/details/Beach1950",
            },
        )


class PoolTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="fetch-clips-test-"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name: str, data: bytes | dict):
        payload = json.dumps(data).encode() if isinstance(data, dict) else data
        (self.dir / name).write_bytes(payload)

    def test_inspect_pool_matches_the_server_rules(self):
        self.write("good.mp4", MP4_HEADER)
        self.write("good.json", {"source": "pixabay", "license": "pixabay"})
        self.write("byline.mp4", MP4_HEADER)
        self.write("byline.json", {"source": "archive", "license": "cc-by-4.0"})
        self.write("bare.mp4", MP4_HEADER)
        self.write("fake.mp4", b"<html>")
        self.write("fake.json", {"source": "original", "license": "original"})
        self.write("orphan.json", {"source": "original", "license": "original"})

        report = fetch_clips.inspect_pool(self.dir)
        self.assertEqual(report.listed, ["good.mp4"])
        self.assertEqual(len(report.problems), 4)
        joined = "\n".join(report.problems)
        for expected in (
            "byline.mp4: licence",
            "bare.mp4: no sidecar",
            "fake.mp4: container",
            "orphan.json",
        ):
            self.assertIn(expected, joined)

    def test_search_is_a_dry_run_by_default(self):
        get = fake_get({"https://archive.org/advancedsearch.php": ARCHIVE_SEARCH})
        with (
            mock.patch.object(fetch_clips, "http_get_json", get),
            mock.patch.object(fetch_clips, "fetch_one", side_effect=AssertionError("downloaded")),
            redirect_stdout(io.StringIO()) as out,
        ):
            code = fetch_clips.main(
                [
                    "--clip-dir",
                    str(self.dir / "new"),
                    "search",
                    "--source",
                    "archive",
                    "--keywords",
                    "beach",
                ]
            )
        self.assertEqual(code, 0)
        self.assertIn("2 planned", out.getvalue())
        self.assertIn("dry run: nothing downloaded", out.getvalue())
        self.assertFalse((self.dir / "new").exists())

    def test_search_respects_the_pool_cap_and_skips_known_clips(self):
        self.write("archive-beach1950.json", {"source": "archive", "license": "public-domain"})
        self.write("big.mp4", MP4_HEADER + b"\0" * (1024 * 1024))
        get = fake_get({"https://archive.org/advancedsearch.php": ARCHIVE_SEARCH})
        with mock.patch.object(fetch_clips, "http_get_json", get), redirect_stdout(
            io.StringIO()
        ) as out:
            fetch_clips.main(
                [
                    "--clip-dir",
                    str(self.dir),
                    "search",
                    "--source",
                    "archive",
                    "--keywords",
                    "beach",
                    "--max-total-mb",
                    "20",
                ]
            )
        # One candidate is already in the pool; 1 MB used leaves room for one 30 s clip (~13 MB).
        self.assertIn("1 already in the pool, 1 planned", out.getvalue())

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_placeholders_are_playable_original_clips(self):
        with redirect_stdout(io.StringIO()):
            code = fetch_clips.main(
                ["--clip-dir", str(self.dir), "placeholders", "--count", "1", "--seconds", "1"]
            )
        self.assertEqual(code, 0)
        report = fetch_clips.inspect_pool(self.dir)
        self.assertEqual(report.listed, ["original-placeholder-testsrc2.mp4"])
        sidecar = json.loads((self.dir / "original-placeholder-testsrc2.json").read_text())
        self.assertEqual(sidecar["license"], "original")
        self.assertGreater(sidecar["duration_sec"], 0.5)


if __name__ == "__main__":
    unittest.main()
