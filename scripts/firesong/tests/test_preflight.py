"""Tests for preflight.sh, the server unit's ExecStartPre guard.

Each case runs the real script with a fake mountinfo (FIRESONG_MOUNTINFO) and
a fake nvidia-smi (FIRESONG_NVIDIA_SMI), so no real mount or GPU matters.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "preflight.sh"
ADA = "GPU-aaaaaaaa-1111-2222-3333-444444444444"
BLACKWELL = "GPU-bbbbbbbb-1111-2222-3333-444444444444"


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "local" / "data"
        self.data.mkdir(parents=True)
        self.cache = self.root / "cache"
        (self.cache / "songs").mkdir(parents=True)
        self.netdata = self.root / "netdata"
        self.netdata.mkdir()
        self.mountinfo = self.root / "mountinfo"
        self.write_mountinfo(cache_type="nfs4")
        smi = self.root / "nvidia-smi"
        smi.write_text("#!/bin/sh\n"
                       f"echo '0, {ADA}, NVIDIA GeForce RTX 4090, 8.9'\n"
                       f"echo '1, {BLACKWELL}, NVIDIA RTX PRO 6000 Blackwell Workstation Edition, 12.0'\n")
        smi.chmod(0o755)
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.root),
            "FIRESONG_MOUNTINFO": str(self.mountinfo),
            "FIRESONG_NVIDIA_SMI": str(smi),
            "NIGHTINGALE_BIND": "127.0.0.1:64448",
            "NIGHTINGALE_REMOTE_BIND": "127.0.0.1:64449",
            "NIGHTINGALE_DATA_PATH": str(self.data),
            "FIRESONG_SONG_CACHE": str(self.cache),
            "CUDA_VISIBLE_DEVICES": ADA,
            "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
        }
        self.configure(str(self.cache / "songs"))

    def tearDown(self):
        self.tmp.cleanup()

    def write_mountinfo(self, cache_type: str | None = "nfs4", data_type: str = "ext4"):
        lines = ["22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/root rw",
                 f"30 22 259:5 / {self.root}/local rw,relatime shared:4 - {data_type} /dev/sdz1 rw",
                 f"31 22 0:60 / {self.netdata} rw,relatime shared:5 - nfs4 10.0.0.9:/net rw"]
        if cache_type:
            lines.append(f"32 22 0:61 / {self.cache} rw,relatime shared:6 - {cache_type} 10.0.0.9:/cache rw")
        self.mountinfo.write_text("\n".join(lines) + "\n")

    def configure(self, songs: str | None):
        cfg = {"cache_paths": {"songs": songs}} if songs else {}
        (self.data / "config.json").write_text(json.dumps(cfg))

    def run_preflight(self, *args, **env):
        e = dict(self.env)
        for k, v in env.items():
            if v is None:
                e.pop(k, None)
            else:
                e[k] = v
        r = subprocess.run(["bash", str(SCRIPT), *args], env=e, capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def assertPasses(self, **env):
        rc, out = self.run_preflight(**env)
        self.assertEqual(rc, 0, out)
        return out

    def assertFails(self, needle, **env):
        rc, out = self.run_preflight(**env)
        self.assertEqual(rc, 1, out)
        self.assertIn(needle, out)
        return out

    def test_good_setup_passes(self):
        out = self.assertPasses()
        self.assertIn("song cache", out)
        self.assertIn("pinned to NVIDIA GeForce RTX 4090", out)

    def test_unmounted_cache_fails(self):
        self.write_mountinfo(cache_type=None)
        self.assertFails("is not mounted")

    def test_local_cache_mount_fails(self):
        self.write_mountinfo(cache_type="ext4")
        self.assertFails("expected nfs")

    def test_unconfigured_songs_only_warns(self):
        self.configure(None)
        out = self.assertPasses()
        self.assertIn("party-prep.py configure", out)

    def test_data_on_nfs_fails(self):
        self.assertFails("must be on a local disk", NIGHTINGALE_DATA_PATH=str(self.netdata / "data"))

    def test_bind_rules(self):
        self.assertFails("not loopback", NIGHTINGALE_BIND="0.0.0.0:64448")
        self.assertFails("not loopback", NIGHTINGALE_REMOTE_BIND="192.0.2.1:64449")
        self.assertFails("must differ", NIGHTINGALE_REMOTE_BIND="127.0.0.1:64448")
        self.assertFails("NIGHTINGALE_BIND is not set", NIGHTINGALE_BIND=None)

    def test_library_path_and_placeholders(self):
        self.assertFails("re-pins a folder", NIGHTINGALE_LIBRARY_PATH="/music")
        self.assertFails("placeholder", NIGHTINGALE_REMOTE_URL="https://<host>.<tailnet>.ts.net:8443")
        out = self.assertPasses(FIRESONG_CUBE_IP="<cube-lan-ip>")
        self.assertIn("warn: FIRESONG_CUBE_IP", out)

    def test_gpu_pin_rules(self):
        self.assertFails("CUDA generation", CUDA_VISIBLE_DEVICES=BLACKWELL)
        self.assertFails("several GPUs", CUDA_VISIBLE_DEVICES=f"{ADA},{BLACKWELL}")
        self.assertFails("matches no GPU", CUDA_VISIBLE_DEVICES="GPU-nope")
        out = self.assertPasses(CUDA_VISIBLE_DEVICES="0")
        self.assertIn("is an index", out)
        out = self.assertPasses(CUDA_VISIBLE_DEVICES=None)
        self.assertIn("may use any GPU", out)

    def test_env_file_option(self):
        env_file = self.root / "firesong.env"
        env_file.write_text("NIGHTINGALE_BIND=0.0.0.0:9\n")
        rc, out = self.run_preflight("--env", str(env_file), "--no-gpu")
        self.assertEqual(rc, 1)
        self.assertIn("NIGHTINGALE_BIND=0.0.0.0:9 is not loopback", out)


if __name__ == "__main__":
    unittest.main()
