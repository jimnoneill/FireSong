#!/usr/bin/env bash
# FireSong server preflight: run by the systemd unit (ExecStartPre) and by hand.
#
#   preflight.sh                      # check the current environment (systemd case)
#   preflight.sh --env FILE           # load FILE first (manual run)
#   preflight.sh --env FILE --no-gpu  # skip the nvidia-smi checks
#
# Fails (exit 1) when starting the server would hurt something:
#   - an env value is still a <placeholder>, or NIGHTINGALE_LIBRARY_PATH is set;
#   - a listener is not loopback, or both listeners share an address;
#   - NIGHTINGALE_DATA_PATH is on a network filesystem (SQLite is unsafe there);
#   - config.json puts the songs cache inside FIRESONG_SONG_CACHE but that is
#     not a live NFS mount (the server would panic, or fill the empty mount
#     point on the local disk);
#   - CUDA_VISIBLE_DEVICES names no GPU, several GPUs, or a GPU whose CUDA
#     generation differs from the first nvidia-smi line (wrong torch wheels).
# Warnings do not stop the start.
#
# Test hooks: FIRESONG_MOUNTINFO (alternative mountinfo file), FIRESONG_NVIDIA_SMI.
set -uo pipefail

ENV_FILE=""
CHECK_GPU=1
QUIET=0

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="${2:-}"; shift 2 || { usage; exit 2; } ;;
    --env=*) ENV_FILE="${1#--env=}"; shift ;;
    --no-gpu) CHECK_GPU=0; shift ;;
    -q|--quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "preflight: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$ENV_FILE" ]; then
  if [ ! -r "$ENV_FILE" ]; then
    echo "preflight: cannot read env file $ENV_FILE" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

FAILS=0
fail() { echo "preflight: FAIL: $*" >&2; FAILS=$((FAILS + 1)); }
warn() { echo "preflight: warn: $*" >&2; }
ok() { [ "$QUIET" = 1 ] || echo "preflight: ok: $*"; }

NETWORK_FS_RE='^(nfs|nfs4|cifs|smb3|smbfs|9p|fuse\.sshfs|fuse\.rclone|afs|ceph|glusterfs|fuse\.glusterfs)$'

findmnt_k() {
  if [ -n "${FIRESONG_MOUNTINFO:-}" ]; then
    findmnt --kernel -F "$FIRESONG_MOUNTINFO" "$@"
  else
    findmnt --kernel "$@"
  fi
}

# Filesystem type of the mount that holds $1 (nearest existing ancestor).
fstype_of() {
  local p="$1"
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  findmnt_k -n -o FSTYPE --target "$p" 2>/dev/null | tail -n 1
}

# Filesystem type if $1 is itself a mount point, else empty.
mount_fstype() {
  findmnt_k -n -o FSTYPE --mountpoint "$1" 2>/dev/null | tail -n 1
}

is_loopback_bind() {
  case "$1" in
    127.*:*|localhost:*|\[::1\]:*) return 0 ;;
    *) return 1 ;;
  esac
}

# --- 1. placeholders and forbidden variables ---------------------------------
# Values the server or its analyzer read must be real; the rest (Cube, Caddy,
# owner steps) only matter to the tooling, so they just warn.
while IFS='=' read -r name value; do
  case "$value" in
    *"<"*">"*)
      case "$name" in
        NIGHTINGALE_*|CUDA_*|FIRESONG_SONG_*|FIRESONG_MODELS_DIR|FIRESONG_VENDOR_DIR|UV_CACHE_DIR)
          fail "$name still holds a placeholder ($value); fill in ~/.config/firesong/firesong.env" ;;
        *) warn "$name still holds a placeholder ($value)" ;;
      esac ;;
  esac
done < <(env | grep -E '^(NIGHTINGALE_|FIRESONG_|CUDA_|UV_CACHE_DIR)[A-Z0-9_]*=' | sort)

if [ -n "${NIGHTINGALE_LIBRARY_PATH:-}" ]; then
  fail "NIGHTINGALE_LIBRARY_PATH is set; it re-pins a folder library over Plex on every start. Unset it."
fi

# --- 2. listeners ---------------------------------------------------------
if [ -z "${NIGHTINGALE_BIND:-}" ]; then
  fail "NIGHTINGALE_BIND is not set (upstream default 0.0.0.0:8080 is taken on this host and not loopback)"
elif ! is_loopback_bind "$NIGHTINGALE_BIND"; then
  fail "NIGHTINGALE_BIND=$NIGHTINGALE_BIND is not loopback; only Caddy may expose the TV door"
else
  ok "TV listener $NIGHTINGALE_BIND"
fi
if [ -n "${NIGHTINGALE_REMOTE_BIND:-}" ]; then
  if ! is_loopback_bind "$NIGHTINGALE_REMOTE_BIND"; then
    fail "NIGHTINGALE_REMOTE_BIND=$NIGHTINGALE_REMOTE_BIND is not loopback; only Funnel may expose the phone door"
  elif [ "$NIGHTINGALE_REMOTE_BIND" = "${NIGHTINGALE_BIND:-}" ]; then
    fail "NIGHTINGALE_REMOTE_BIND must differ from NIGHTINGALE_BIND"
  else
    ok "phone listener $NIGHTINGALE_REMOTE_BIND"
  fi
else
  warn "NIGHTINGALE_REMOTE_BIND is not set: no phone listener"
fi

# --- 3. data dir: local disk only ----------------------------------------
DATA="${NIGHTINGALE_DATA_PATH:-}"
if [ -z "$DATA" ]; then
  fail "NIGHTINGALE_DATA_PATH is not set (the default ~/.nightingale is on the boot disk)"
elif [ "${DATA#/}" = "$DATA" ]; then
  fail "NIGHTINGALE_DATA_PATH=$DATA is not an absolute path"
else
  t="$(fstype_of "$DATA")"
  if [ -z "$t" ]; then
    fail "cannot tell which filesystem holds NIGHTINGALE_DATA_PATH=$DATA"
  elif [[ "$t" =~ $NETWORK_FS_RE ]]; then
    fail "NIGHTINGALE_DATA_PATH=$DATA is on $t; the SQLite library must be on a local disk"
  else
    ok "data dir $DATA ($t)"
  fi
fi

# --- 4. song cache --------------------------------------------------------
SONGS=""
if [ -n "$DATA" ] && [ -f "$DATA/config.json" ]; then
  SONGS="$(python3 -I -c '
import json, sys
try:
    cfg = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("!" + str(e)); sys.exit(0)
p = ((cfg or {}).get("cache_paths") or {}).get("songs") or ""
print(p)
' "$DATA/config.json")"
  case "$SONGS" in
    "!"*) fail "cannot parse $DATA/config.json: ${SONGS#!}"; SONGS="" ;;
  esac
fi
CACHE="${FIRESONG_SONG_CACHE:-}"
CACHE="${CACHE%/}"
if [ -z "$SONGS" ]; then
  if [ -n "$CACHE" ]; then
    warn "config.json sets no cache_paths.songs, so songs go to $DATA/cache on the local disk; run 'party-prep.py configure' to use $CACHE"
  fi
elif [ -n "$CACHE" ] && { [ "$SONGS" = "$CACHE" ] || [ "${SONGS#"$CACHE"/}" != "$SONGS" ]; }; then
  t="$(mount_fstype "$CACHE")"
  if [ -z "$t" ]; then
    fail "song cache $CACHE is not mounted (config.json cache_paths.songs=$SONGS); mount it first: see docs/firesong/DEPLOY.md"
  elif ! [[ "$t" =~ ^nfs4?$ ]]; then
    fail "song cache $CACHE is a $t mount, expected nfs"
  elif ! timeout 10 stat -f "$CACHE" >/dev/null 2>&1; then
    fail "song cache $CACHE is mounted but not answering (NFS server down?)"
  elif [ ! -w "$CACHE" ] && [ ! -w "$SONGS" ]; then
    fail "song cache $CACHE is not writable by $(id -un)"
  else
    ok "song cache $SONGS on $t mount $CACHE"
  fi
else
  warn "config.json cache_paths.songs=$SONGS is outside FIRESONG_SONG_CACHE=${CACHE:-<unset>}"
fi

# --- 5. GPU pin ----------------------------------------------------------
if [ "$CHECK_GPU" = 1 ]; then
  SMI="${FIRESONG_NVIDIA_SMI:-nvidia-smi}"
  PIN="${CUDA_VISIBLE_DEVICES:-}"
  if ! command -v "$SMI" >/dev/null 2>&1; then
    warn "nvidia-smi not found; GPU pin not checked"
  elif [ -z "$PIN" ]; then
    warn "CUDA_VISIBLE_DEVICES is not set: the analyzer may use any GPU"
  elif [ "${PIN#*,}" != "$PIN" ]; then
    fail "CUDA_VISIBLE_DEVICES=$PIN names several GPUs; pin exactly one (the RTX 4090) by UUID"
  else
    gpus="$("$SMI" --query-gpu=index,uuid,name,compute_cap --format=csv,noheader 2>/dev/null)"
    if [ -z "$gpus" ]; then
      fail "nvidia-smi listed no GPUs"
    else
      first_cc="$(printf '%s\n' "$gpus" | head -n 1 | awk -F', *' '{print $4}')"
      line="$(printf '%s\n' "$gpus" | awk -F', *' -v p="$PIN" '$1 == p || $2 == p')"
      if [ -z "$line" ]; then
        fail "CUDA_VISIBLE_DEVICES=$PIN matches no GPU (nvidia-smi -L lists the UUIDs)"
      else
        name="$(printf '%s' "$line" | awk -F', *' '{print $3}')"
        cc="$(printf '%s' "$line" | awk -F', *' '{print $4}')"
        if [ "${first_cc%%.*}" -ge 10 ] 2>/dev/null; then fgen=new; else fgen=old; fi
        if [ "${cc%%.*}" -ge 10 ] 2>/dev/null; then pgen=new; else pgen=old; fi
        if [ "$fgen" != "$pgen" ]; then
          fail "pinned GPU $name (sm ${cc}) differs in CUDA generation from the first nvidia-smi GPU (sm ${first_cc}); the vendor step would install torch wheels without kernels for it"
        else
          if [ "${PIN#GPU-}" = "$PIN" ]; then
            warn "CUDA_VISIBLE_DEVICES=$PIN is an index; pin by UUID so a reordered bus cannot move the analyzer"
          fi
          if [ "${CUDA_DEVICE_ORDER:-}" != "PCI_BUS_ID" ]; then
            warn "CUDA_DEVICE_ORDER is not PCI_BUS_ID"
          fi
          ok "analyzer pinned to $name"
        fi
      fi
    fi
  fi
fi

if [ "$FAILS" -gt 0 ]; then
  echo "preflight: $FAILS problem(s); not starting FireSong" >&2
  exit 1
fi
ok "all checks passed"
exit 0
