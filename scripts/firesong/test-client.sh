#!/usr/bin/env bash
# Runs FireSong's client unit tests (`client/src/**/*.test.ts`) with Node's
# built-in test runner: Node strips the TypeScript types and
# node-test/register.mjs resolves the `@/` alias. No extra dependencies.
#
# Usage: scripts/firesong/test-client.sh [test files or globs...]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo/client"

if [ "$#" -eq 0 ]; then
  set -- 'src/**/*.test.ts'
fi

exec node --import "$repo/scripts/firesong/node-test/register.mjs" --test "$@"
