#!/usr/bin/env bash
# WP5 phone-page e2e: builds the client, then runs tools/phone-mic-e2e/run.mjs
# (headless Chrome, iPhone-sized emulation, fake microphone, mock /rtc relay
# and mock TV, all on ephemeral loopback ports). Reports go to
# $FIRESONG_E2E_OUT or $FIRESONG_FAST_ROOT/logs/phone-page-e2e/<time>/.
#
# Usage: scripts/firesong/e2e-phone-mic.sh [--no-build]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "${1:-}" != "--no-build" ]; then
  # From client/, so corepack picks the pnpm pinned in client/package.json.
  (cd "$repo/client" && pnpm build >/dev/null)
fi
exec node "$repo/tools/phone-mic-e2e/run.mjs"
