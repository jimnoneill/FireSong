#!/usr/bin/env bash
# Build a FireSong release on the server machine: the client bundle and the server binary.
#
#   scripts/firesong/build-release.sh [options]
#
#   --activate          point <release-root>/current at the new release (atomic);
#                       the running service keeps the old binary until restarted
#   --dry-run           print what would run and where it would go; build nothing
#   --allow-dirty       build even with uncommitted changes (the id gets "-dirty")
#   --skip-install      skip `pnpm install --frozen-lockfile`
#   --keep N            keep the newest N releases besides current (default 3)
#   --release-root DIR  default $FIRESONG_RELEASE_ROOT, else /mnt/fast/firesong
#   --key KEY           devenv key, which picks CARGO_TARGET_DIR (default: worktree name)
#
# Steps:
#   1. source scripts/firesong/devenv.sh: node 24, corepack pnpm, cargo, HUSKY=0,
#      CARGO_TARGET_DIR=/mnt/fast/firesong/target-<key>, caches on /mnt/staging1.
#   2. client (from client/, so corepack picks the pinned pnpm): pnpm install
#      --frozen-lockfile, then pnpm build -> client/dist.
#   3. server: cargo build --release --locked -p server. rust-embed bakes
#      client/dist into the binary, so the client must be built first.
#   4. assemble <release-root>/releases/<UTC-stamp>-<git-sha>/ with the server,
#      preflight.sh, party-prep.py + firesong_prep.py, cube.sh, party-door.sh, Caddyfile.tv,
#      a copy of client/dist (for inspection; the server serves its embedded
#      copy), release.json and SHA256SUMS.
#   5. prune old releases (never the current one).
#
# Never restarts, enables or installs a service. After --activate:
#   systemctl --user restart firesong
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

ACTIVATE=0
DRY=0
ALLOW_DIRTY=0
SKIP_INSTALL=0
KEEP=3
ROOT="${FIRESONG_RELEASE_ROOT:-}"
KEY=""

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { echo "build-release: $*" >&2; exit 1; }
say() { echo "build-release: $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --activate) ACTIVATE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --keep) KEEP="${2:-}"; shift 2 ;;
    --keep=*) KEEP="${1#--keep=}"; shift ;;
    --release-root) ROOT="${2:-}"; shift 2 ;;
    --release-root=*) ROOT="${1#--release-root=}"; shift ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --key=*) KEY="${1#--key=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep needs a number"

run() {
  # Print the command; run it unless --dry-run.
  printf '+ %s\n' "$*" >&2
  [ "$DRY" = 1 ] || "$@"
}

in_client() {
  # pnpm must run from client/: corepack picks the pnpm version from the
  # nearest package.json's packageManager, and the repo root has none
  # (`pnpm --dir client` from the root gets corepack's default pnpm instead).
  printf '+ (cd client && %s)\n' "$*" >&2
  [ "$DRY" = 1 ] || (cd "$REPO/client" && "$@")
}

# --- toolchain ---------------------------------------------------------------
FIRESONG_DEVENV_QUIET=1
export FIRESONG_DEVENV_QUIET
# shellcheck disable=SC1091
. "$REPO/scripts/firesong/devenv.sh" ${KEY:+"$KEY"}
ROOT="${ROOT:-${FIRESONG_FAST_ROOT:-/mnt/fast/firesong}}"
case "$ROOT" in
  /tmp/*|/var/tmp/*) die "release root $ROOT is on tmp space; use /mnt/fast" ;;
esac
for tool in node pnpm cargo git sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found after sourcing devenv.sh"
done

# --- source state ------------------------------------------------------------
SHA="$(git -C "$REPO" rev-parse --short=12 HEAD)"
DIRTY=""
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  [ "$ALLOW_DIRTY" = 1 ] || die "uncommitted changes in $REPO; commit them or pass --allow-dirty"
  DIRTY="-dirty"
fi
BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ID="$STAMP-$SHA$DIRTY"
DEST="$ROOT/releases/$ID"
BIN="$CARGO_TARGET_DIR/release/server"

say "release $ID from $BRANCH ($REPO)"
say "CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
say "destination $DEST"
[ "$DRY" = 1 ] && say "dry run: nothing is built or written"

# --- build ---------------------------------------------------------------------
if [ "$SKIP_INSTALL" = 0 ]; then
  in_client pnpm install --frozen-lockfile
fi
in_client pnpm build
[ "$DRY" = 1 ] || [ -f "$REPO/client/dist/index.html" ] || die "client build produced no client/dist/index.html"
run cargo build --manifest-path "$REPO/Cargo.toml" --release --locked -p server
[ "$DRY" = 1 ] || [ -x "$BIN" ] || die "cargo produced no $BIN"

# --- assemble ------------------------------------------------------------------
STAGE="$ROOT/releases/.staging-$ID"
run mkdir -p "$STAGE"
run install -m 755 "$BIN" "$STAGE/server"
for f in preflight.sh party-prep.py firesong_prep.py cube.sh party-door.sh; do
  run install -m 755 "$HERE/$f" "$STAGE/$f"
done
run install -m 644 "$REPO/deploy/server/Caddyfile.tv" "$STAGE/Caddyfile.tv"
run cp -a "$REPO/client/dist" "$STAGE/client-dist"
if [ "$DRY" = 0 ]; then
  (cd "$STAGE" && sha256sum server preflight.sh party-prep.py firesong_prep.py cube.sh party-door.sh Caddyfile.tv > SHA256SUMS)
  python3 -I - "$STAGE/release.json" "$ID" "$SHA" "$BRANCH" "${DIRTY:+true}" \
    "$(node -v)" "$(cd "$REPO/client" && pnpm -v)" "$(cargo -V)" <<'PY'
import json, sys
path, rid, sha, branch, dirty, node, pnpm, cargo = sys.argv[1:9]
with open(path, "w", encoding="utf-8") as f:
    json.dump({"id": rid, "git_sha": sha, "branch": branch, "dirty": dirty == "true",
               "node": node, "pnpm": pnpm, "cargo": cargo,
               "contents": ["server (client bundle embedded)", "client-dist/", "preflight.sh",
                            "party-prep.py", "firesong_prep.py", "cube.sh", "party-door.sh",
                            "Caddyfile.tv"]},
              f, indent=2)
    f.write("\n")
PY
fi
run mv "$STAGE" "$DEST"

# --- activate -----------------------------------------------------------------
if [ "$ACTIVATE" = 1 ]; then
  run ln -sfn "releases/$ID" "$ROOT/.current-$ID"
  run mv -T "$ROOT/.current-$ID" "$ROOT/current"
  say "current -> releases/$ID; restart to use it: systemctl --user restart firesong"
else
  say "built $DEST (not activated; pass --activate to switch current)"
fi

# --- prune ---------------------------------------------------------------------
if [ "$DRY" = 0 ] && [ -d "$ROOT/releases" ]; then
  current="$(readlink "$ROOT/current" 2>/dev/null || true)"
  current="${current#releases/}"
  mapfile -t old < <(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\n' \
    | sort -r | grep -vx -- "${current:-//none//}" | grep -vx -- "$ID" | tail -n +"$((KEEP + 1))")
  for r in "${old[@]}"; do
    say "pruning old release $r"
    rm -rf -- "${ROOT:?}/releases/$r"
  done
fi
echo "$DEST"
