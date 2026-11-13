# FireSong developer environment for the server machine.
#
# Usage (bash or zsh, from anywhere):
#   source scripts/firesong/devenv.sh            # key from the worktree name
#   source scripts/firesong/devenv.sh server     # explicit key
#
# What it sets (idempotent; safe to source more than once):
#   PATH          node >= 22.12 (~/.node24/bin), a corepack pnpm shim,
#                 cargo (~/.cargo/bin), Android platform-tools (adb)
#   HUSKY=0       the client's `prepare` script runs husky, which would point
#                 git at client/.husky and silently drop this host's
#                 commit-msg/pre-push guards. HUSKY=0 makes husky skip that.
#   FIRESONG_KEY  worktree key ("base" for ~/wt-firesong-base)
#   CARGO_TARGET_DIR=/mnt/fast/firesong/target-$FIRESONG_KEY (unless already set)
#   pnpm store, corepack cache and Gradle home on /mnt/staging1, never /tmp
#   ANDROID_HOME / ANDROID_SDK_ROOT, JAVA_HOME (JDK 17 for the firetv build)
#
# LAN-specific values (Cube adb serial, tokens) do NOT belong here. Put them in
# scripts/firesong/devenv.local.sh (git-ignored); see devenv.local.sh.example.

# Resolve this file's directory in bash and zsh.
if [ -n "${BASH_SOURCE:-}" ]; then
  _fs_self="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  # shellcheck disable=SC2296
  _fs_self="${(%):-%x}"
else
  _fs_self="$0"
fi
FIRESONG_DEVENV_DIR="$(cd "$(dirname "$_fs_self")" && pwd)"
FIRESONG_REPO="$(cd "$FIRESONG_DEVENV_DIR/../.." && pwd)"
export FIRESONG_REPO
unset _fs_self

_fs_path_prepend() {
  # Move $1 to the front of PATH (dropping any later copy), if it exists.
  [ -d "$1" ] || return 0
  PATH="$1:$(printf '%s' ":$PATH:" | sed -e ":l" -e "s#:$1:#:#" -e "tl" -e "s#^:##; s#:\$##")"
}

# --- worktree key ----------------------------------------------------------
if [ -n "${1:-}" ]; then
  FIRESONG_KEY="$1"
else
  case "$(basename "$FIRESONG_REPO")" in
    wt-firesong-*) FIRESONG_KEY="$(basename "$FIRESONG_REPO")"; FIRESONG_KEY="${FIRESONG_KEY#wt-firesong-}" ;;
    *) FIRESONG_KEY="$(git -C "$FIRESONG_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null | sed 's#^fs/##; s#[^A-Za-z0-9._-]#-#g')" ;;
  esac
  [ -n "$FIRESONG_KEY" ] && [ "$FIRESONG_KEY" != "HEAD" ] || FIRESONG_KEY="main"
fi
export FIRESONG_KEY

# --- heavy caches (fast/staging tiers, never /tmp or the boot disk) --------
FIRESONG_FAST_ROOT="${FIRESONG_FAST_ROOT:-/mnt/fast/firesong}"
FIRESONG_STAGING_ROOT="${FIRESONG_STAGING_ROOT:-/mnt/staging1/firesong}"
export FIRESONG_FAST_ROOT FIRESONG_STAGING_ROOT

# Default pattern: one target dir per worktree key. An explicit value wins.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$FIRESONG_FAST_ROOT/target-$FIRESONG_KEY}"

# --- Rust ------------------------------------------------------------------
# rust-toolchain.toml pins the channel; rustup picks it up per directory.
_fs_path_prepend "$HOME/.cargo/bin"

# --- Node + pnpm (via corepack) ------------------------------------------
# client/package.json: engines.node >=22.12, packageManager pnpm@<pinned>.
# ~/.node24/bin holds node 24 and corepack; it goes in front of the older
# node 22 in ~/.local/bin.
_fs_path_prepend "$HOME/.node24/bin"
export COREPACK_HOME="${COREPACK_HOME:-$FIRESONG_STAGING_ROOT/corepack}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_AUTO_PIN=0
FIRESONG_SHIM_DIR="$FIRESONG_STAGING_ROOT/bin"
if [ ! -x "$FIRESONG_SHIM_DIR/pnpm" ] && command -v corepack >/dev/null 2>&1; then
  mkdir -p "$FIRESONG_SHIM_DIR" "$COREPACK_HOME" 2>/dev/null &&
    corepack enable --install-directory "$FIRESONG_SHIM_DIR" pnpm >/dev/null 2>&1 ||
    echo "devenv: corepack could not install the pnpm shim in $FIRESONG_SHIM_DIR" >&2
fi
_fs_path_prepend "$FIRESONG_SHIM_DIR"
# pnpm 11 reads pnpm_config_*; older pnpm read npm_config_*. Set both.
export pnpm_config_store_dir="${pnpm_config_store_dir:-$FIRESONG_STAGING_ROOT/pnpm-store}"
export npm_config_store_dir="$pnpm_config_store_dir"
export HUSKY=0

# --- Android / Fire TV -----------------------------------------------------
export ANDROID_HOME="${ANDROID_HOME:-/home/joneill/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
_fs_path_prepend "$ANDROID_HOME/platform-tools"
if [ -d /usr/lib/jvm/java-17-openjdk-amd64 ]; then
  export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
fi
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/mnt/staging1/gradle}"

export PATH
unset -f _fs_path_prepend

# --- optional git-ignored local overrides ---------------------------------
if [ -f "$FIRESONG_DEVENV_DIR/devenv.local.sh" ]; then
  # shellcheck disable=SC1091
  . "$FIRESONG_DEVENV_DIR/devenv.local.sh"
fi

if [ -z "${FIRESONG_DEVENV_QUIET:-}" ]; then
  printf 'firesong devenv: key=%s node=%s pnpm=%s cargo=%s\n  CARGO_TARGET_DIR=%s\n' \
    "$FIRESONG_KEY" \
    "$(node -v 2>/dev/null || echo missing)" \
    "$(cd "$FIRESONG_REPO/client" 2>/dev/null && pnpm -v 2>/dev/null || echo missing)" \
    "$(cd "$FIRESONG_REPO" && cargo -V 2>/dev/null | awk '{print $2}')" \
    "$CARGO_TARGET_DIR"
fi
