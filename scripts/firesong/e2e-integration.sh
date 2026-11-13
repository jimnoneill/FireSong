#!/usr/bin/env bash
# Integration e2e on one host, headless, no ML and no Plex: builds the client
# and the server, then runs tools/firesong-tests/e2e (real server on loopback
# ports 64480/64481, a generated UltraStar song, the TV page and two phones in
# headless Chrome with fake microphones at 440 and 330 Hz).
#
# Artifacts (logs, screenshots, report.json): $FIRESONG_E2E_ARTIFACTS or
# /mnt/fast/firesong/artifacts/e2e/<time>/. Data: $FIRESONG_E2E_DATA or
# /mnt/fast/firesong/e2e-data/run-<time>/, removed after a passing run.
#
# Usage: scripts/firesong/e2e-integration.sh [--no-build]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
FIRESONG_DEVENV_QUIET=1 . "$repo/scripts/firesong/devenv.sh"
if [ "${1:-}" != "--no-build" ]; then
  # From client/, so corepack picks the pnpm pinned in client/package.json.
  (cd "$repo/client" && pnpm build >/dev/null)
  # The debug server reads client/dist at run time.
  (cd "$repo" && cargo build -p server --locked)
fi
export FIRESONG_SERVER_BIN="${FIRESONG_SERVER_BIN:-$CARGO_TARGET_DIR/debug/server}"
cd "$repo/tools/firesong-tests"
pnpm install --frozen-lockfile >/dev/null
exec pnpm e2e
