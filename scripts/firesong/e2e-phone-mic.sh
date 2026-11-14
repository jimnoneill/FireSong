#!/usr/bin/env bash
# Phone-page e2e (WP5, phone app v2): builds the client, then runs
# tools/phone-mic-e2e/run.mjs (headless Chrome with iPhone- and Android-sized
# emulation, fake microphones, a mock /rtc relay with the party channel and a
# fake song book, and a mock TV, all on ephemeral loopback ports). Reports go
# to $FIRESONG_E2E_OUT or $FIRESONG_FAST_ROOT/logs/phone-page-e2e/<time>/;
# phone screenshots to $FIRESONG_SHOTS_DIR (default: the report dir).
#
# Usage: scripts/firesong/e2e-phone-mic.sh [--no-build]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "${1:-}" != "--no-build" ]; then
  # From client/, so corepack picks the pnpm pinned in client/package.json.
  (cd "$repo/client" && pnpm build >/dev/null)
fi
exec node "$repo/tools/phone-mic-e2e/run.mjs"
