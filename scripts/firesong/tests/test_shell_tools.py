"""Runs the shell tools' own self-tests (fake adb, temporary files), the
build script in --dry-run mode, and shellcheck when it is installed."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parents[1]
SHELLCHECK = os.environ.get("SHELLCHECK") or shutil.which("shellcheck") or "/mnt/staging1/firesong/tools-venv/bin/shellcheck"


def run(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, timeout=300, **kw)


class ShellToolTests(unittest.TestCase):
    def test_cube_self_test(self):
        r = run(["bash", str(HERE / "cube.sh"), "self-test"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("0 failed", r.stdout)

    @unittest.skipUnless((REPO / "deploy" / "server" / "firesong.service").is_file(), "needs the repo checkout")
    def test_server_install_self_test(self):
        r = run(["bash", str(HERE / "server-install.sh"), "self-test"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("0 failed", r.stdout)

    @unittest.skipUnless((REPO / "scripts" / "firesong" / "devenv.sh").is_file() and shutil.which("git"),
                         "needs the repo checkout")
    def test_build_release_dry_run(self):
        with tempfile.TemporaryDirectory() as d:
            r = run(["bash", str(HERE / "build-release.sh"), "--dry-run", "--allow-dirty", "--activate",
                     "--release-root", str(Path(d) / "root")], cwd=str(REPO))
            # /tmp is refused as a release root; the dry run proves the guard and the plan.
            if d.startswith("/tmp/"):
                self.assertEqual(r.returncode, 1, r.stderr)
                self.assertIn("tmp space", r.stderr)
                r = run(["bash", str(HERE / "build-release.sh"), "--dry-run", "--allow-dirty", "--activate",
                         "--release-root", "/nonexistent/firesong-dry-run"], cwd=str(REPO))
            self.assertEqual(r.returncode, 0, r.stderr)
            err = r.stderr
            self.assertIn("(cd client && pnpm install --frozen-lockfile)", err)
            self.assertIn("(cd client && pnpm build)", err)
            self.assertIn("cargo build --manifest-path", err)
            self.assertIn("--release --locked -p server", err)
            self.assertIn("mv -T", err)
            self.assertLess(err.index("pnpm build"), err.index("cargo build"), "client before server")
            self.assertFalse(Path("/nonexistent/firesong-dry-run").exists())

    @unittest.skipUnless(os.access(SHELLCHECK, os.X_OK) if os.path.isabs(SHELLCHECK) else shutil.which(SHELLCHECK),
                         "shellcheck not installed")
    def test_shellcheck(self):
        scripts = [str(HERE / n) for n in ("cube.sh", "preflight.sh", "build-release.sh", "server-install.sh")]
        r = run([SHELLCHECK, "-x", *scripts])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
