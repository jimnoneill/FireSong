#!/usr/bin/env bash
# FireSong host setup helpers for the server machine. Nothing here enables or starts a
# service, installs packages or touches Tailscale.
#
#   server-install.sh env [--dest FILE] [--force] [--lan-ip IP] [--cube-ip IP]
#                       [--nfs-server IP] [--phone-origin URL]
#       Write the host env file (default ~/.config/firesong/firesong.env, mode
#       600) from deploy/server/firesong.env.example. The RTX 4090's UUID is read
#       from nvidia-smi; the other values come from the flags, and any left out
#       stay <placeholders> for you to fill in. Refuses to overwrite without --force.
#
#   server-install.sh unit [--print] [--dest DIR] [--release-root DIR] [--caddy PATH]
#       Render deploy/server/firesong.service (and firesong-caddy.service when a
#       caddy binary is found) into DIR (default ~/.config/systemd/user).
#       --print writes the rendered units to stdout instead.
#
#   server-install.sh owner-steps [--env FILE]
#       Print the owner's one-time steps with this host's values filled in.
#
#   server-install.sh check [--env FILE]
#       Run preflight.sh against the env file and `systemd-analyze --user verify`
#       on the rendered units.
#
#   server-install.sh self-test
#       Exercise env/unit/owner-steps against temporary files.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TEMPLATE_DIR="$REPO/deploy/server"
ENV_DEFAULT="$HOME/.config/firesong/firesong.env"
GPU_NAME="${FIRESONG_GPU_NAME:-RTX 4090}"

die() { echo "server-install: $*" >&2; exit 1; }
say() { echo "server-install: $*" >&2; }
usage() { sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

env_get() {  # env_get FILE KEY
  [ -r "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//"
}

set_key() {  # set_key FILE KEY VALUE: replace KEY=... (first occurrence, commented or not)
  python3 -I - "$1" "$2" "$3" <<'PY'
import re, sys
path, key, value = sys.argv[1:4]
lines = open(path, encoding="utf-8").read().splitlines()
pat = re.compile(r"^\s*#?\s*" + re.escape(key) + "=")
for i, line in enumerate(lines):
    if pat.match(line):
        lines[i] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
}

detect_gpu_uuid() {
  local smi="${FIRESONG_NVIDIA_SMI:-nvidia-smi}" rows n
  command -v "$smi" >/dev/null 2>&1 || return 1
  rows="$("$smi" --query-gpu=uuid,name --format=csv,noheader 2>/dev/null | grep -F -- "$GPU_NAME" || true)"
  n="$(printf '%s' "$rows" | grep -c . || true)"
  [ "$n" = 1 ] || return 1
  printf '%s\n' "$rows" | cut -d, -f1 | tr -d ' '
}

valid_ip() { [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; }

cmd_env() {
  local dest="$ENV_DEFAULT" force=0 lan="" cube="" nfs="" origin="" uuid
  while [ $# -gt 0 ]; do
    case "$1" in
      --dest) dest="$2"; shift 2 ;;
      --force) force=1; shift ;;
      --lan-ip) lan="$2"; shift 2 ;;
      --cube-ip) cube="$2"; shift 2 ;;
      --nfs-server) nfs="$2"; shift 2 ;;
      --phone-origin) origin="$2"; shift 2 ;;
      *) die "env: unknown argument $1" ;;
    esac
  done
  for ip in "$lan" "$cube" "$nfs"; do
    [ -z "$ip" ] || valid_ip "$ip" || die "not an IPv4 address: $ip"
  done
  if [ -n "$origin" ] && ! [[ "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    die "--phone-origin must look like https://host.example:8443"
  fi
  if [ -e "$dest" ] && [ "$force" != 1 ]; then
    die "$dest exists; edit it, or pass --force to rewrite it from the template"
  fi
  mkdir -p "$(dirname "$dest")"
  chmod 700 "$(dirname "$dest")" 2>/dev/null || true
  local tmp="$dest.tmp.$$"
  ( umask 077; cp "$TEMPLATE_DIR/firesong.env.example" "$tmp" )
  if uuid="$(detect_gpu_uuid)"; then
    set_key "$tmp" CUDA_VISIBLE_DEVICES "$uuid"
    say "pinned the analyzer to the $GPU_NAME: $uuid"
  else
    say "warning: could not find exactly one '$GPU_NAME' in nvidia-smi; CUDA_VISIBLE_DEVICES left as a placeholder"
  fi
  [ -z "$lan" ] || set_key "$tmp" FIRESONG_LAN_IP "$lan"
  if [ -n "$cube" ]; then
    set_key "$tmp" FIRESONG_CUBE_IP "$cube"
    set_key "$tmp" FIRESONG_CUBE_SERIAL "$cube:5555"
  fi
  [ -z "$nfs" ] || set_key "$tmp" FIRESONG_NFS_SERVER "$nfs"
  [ -z "$origin" ] || set_key "$tmp" NIGHTINGALE_REMOTE_URL "$origin"
  chmod 600 "$tmp"
  mv -f "$tmp" "$dest"
  say "wrote $dest"
  local left
  left="$(grep -E '^[A-Z_]+=.*<[^>]+>' "$dest" | cut -d= -f1 | paste -sd ' ' - || true)"
  [ -z "$left" ] || say "still placeholders: $left"
}

render() {  # render TEMPLATE RELEASE_ROOT CADDY
  sed -e "s|@RELEASE_ROOT@|$2|g" -e "s|@CADDY@|$3|g" "$1"
}

find_caddy() {
  if [ -n "${CADDY:-}" ]; then printf '%s\n' "$CADDY"; return 0; fi
  local c
  for c in "$(command -v caddy 2>/dev/null || true)" /mnt/staging1/firesong/bin/caddy; do
    if [ -n "$c" ] && [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}

cmd_unit() {
  local print=0 dest="$HOME/.config/systemd/user" root="${FIRESONG_RELEASE_ROOT:-/mnt/fast/firesong}" caddy=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --print) print=1; shift ;;
      --dest) dest="$2"; shift 2 ;;
      --release-root) root="$2"; shift 2 ;;
      --caddy) caddy="$2"; shift 2 ;;
      *) die "unit: unknown argument $1" ;;
    esac
  done
  [ "${root#/}" != "$root" ] || die "--release-root must be absolute"
  [ -n "$caddy" ] || caddy="$(find_caddy || true)"
  if [ "$print" = 1 ]; then
    render "$TEMPLATE_DIR/firesong.service" "$root" "$caddy"
    if [ -n "$caddy" ]; then
      echo "### firesong-caddy.service"
      render "$TEMPLATE_DIR/firesong-caddy.service" "$root" "$caddy"
    fi
    return 0
  fi
  mkdir -p "$dest"
  render "$TEMPLATE_DIR/firesong.service" "$root" "$caddy" > "$dest/firesong.service"
  say "wrote $dest/firesong.service"
  if [ -n "$caddy" ]; then
    render "$TEMPLATE_DIR/firesong-caddy.service" "$root" "$caddy" > "$dest/firesong-caddy.service"
    say "wrote $dest/firesong-caddy.service"
  else
    say "no caddy binary found; firesong-caddy.service not written (set CADDY=/path/to/caddy)"
  fi
  say "next: systemctl --user daemon-reload && systemctl --user start firesong"
}

cmd_owner_steps() {
  local env="$ENV_DEFAULT"
  while [ $# -gt 0 ]; do
    case "$1" in
      --env) env="$2"; shift 2 ;;
      *) die "owner-steps: unknown argument $1" ;;
    esac
  done
  [ -r "$env" ] || die "cannot read $env (run: server-install.sh env)"
  local nfs nfs_export cache remote_bind origin data port
  nfs="$(env_get "$env" FIRESONG_NFS_SERVER)"
  nfs_export="$(env_get "$env" FIRESONG_NFS_EXPORT)"
  cache="$(env_get "$env" FIRESONG_SONG_CACHE)"
  remote_bind="$(env_get "$env" NIGHTINGALE_REMOTE_BIND)"
  origin="$(env_get "$env" NIGHTINGALE_REMOTE_URL)"
  data="$(env_get "$env" NIGHTINGALE_DATA_PATH)"
  NIGHTINGALE_BIND_SHOWN="$(env_get "$env" NIGHTINGALE_BIND)"
  port="${origin##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || port=8443
  cat <<EOF
FireSong owner one-time steps (values from $env)

1. Song cache NFS mount (sudo on the server machine; the export lives on the NFS server):
     sudo mkdir -p ${cache:-/mnt/firesong-cache}
     echo '${nfs:-<nfs-server>}:${nfs_export:-/var/lib/firesong-cache} ${cache:-/mnt/firesong-cache} nfs rw,soft,intr,_netdev,nofail,bg 0 0' | sudo tee -a /etc/fstab
     sudo mount ${cache:-/mnt/firesong-cache} && sudo chown $(id -un): ${cache:-/mnt/firesong-cache}
   Check: findmnt ${cache:-/mnt/firesong-cache}   (FSTYPE nfs4)

2. Plex sign-in (PIN flow, creates a separately revocable device):
     on the server machine (or through an SSH tunnel to it) open
       http://${NIGHTINGALE_BIND_SHOWN:-127.0.0.1:64448}/?host=\$(cat ${data:-<data>}/firesong/host-token)
     then Connect Plex -> Sign in with Plex, approve the code at plex.tv/link,
     pick the server and the music library.

3. Phone door on Tailscale Funnel, only during parties:
     on:     tailscale funnel --bg --https=$port http://${remote_bind:-127.0.0.1:64449}
     check:  tailscale funnel status      (the existing :443 entry must still be there)
     off:    tailscale funnel --https=$port off
   Never run 'tailscale funnel reset' or 'tailscale serve reset': they drop the existing :443 Funnel.

4. Disable Tailscale key expiry for this machine (admin console -> Machines ->
   $(hostname -s) -> ... -> Disable key expiry), or Funnel and remote access stop
   when the node key expires.
EOF
}

cmd_check() {
  local env="$ENV_DEFAULT" rc=0 t
  while [ $# -gt 0 ]; do
    case "$1" in
      --env) env="$2"; shift 2 ;;
      *) die "check: unknown argument $1" ;;
    esac
  done
  "$HERE/preflight.sh" --env "$env" || rc=1
  if command -v systemd-analyze >/dev/null 2>&1; then
    t="$(mktemp -d "${TMPDIR:-/tmp}/firesong-unit.XXXXXX")"
    mkdir -p "$t/root/current"
    cp "$HERE/preflight.sh" "$t/root/current/preflight.sh"
    printf '#!/bin/sh\n' > "$t/root/current/server"; chmod +x "$t/root/current/server"
    render "$TEMPLATE_DIR/firesong.service" "$t/root" "/bin/true" > "$t/firesong.service"
    render "$TEMPLATE_DIR/firesong-caddy.service" "$t/root" "/bin/true" > "$t/firesong-caddy.service"
    if systemd-analyze --user verify "$t/firesong.service" "$t/firesong-caddy.service"; then
      say "unit templates verify cleanly"
    else
      rc=1
    fi
    rm -rf "$t"
  fi
  return "$rc"
}

cmd_self_test() {
  local t pass=0 failn=0
  t="$(mktemp -d "${TMPDIR:-/tmp}/server-install-test.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$t'" EXIT
  cat > "$t/nvidia-smi" <<'FAKE'
#!/bin/sh
echo "GPU-aaaaaaaa-1111-2222-3333-444444444444, NVIDIA GeForce RTX 4090"
echo "GPU-bbbbbbbb-1111-2222-3333-444444444444, NVIDIA RTX PRO 6000 Blackwell Workstation Edition"
FAKE
  chmod +x "$t/nvidia-smi"
  expect() {  # expect NAME COMMAND...: pass when COMMAND succeeds
    local name="$1"
    shift
    if "$@"; then pass=$((pass + 1)); echo "ok   $name"; else failn=$((failn + 1)); echo "FAIL $name"; fi
  }
  no_placeholders() { ! grep -E '^[A-Z]' "$1" | grep -qE '<[^>]+>'; }
  no_markers() { ! grep -q '@[A-Z_]*@' "$@"; }
  fails() { ! "$@"; }

  FIRESONG_NVIDIA_SMI="$t/nvidia-smi" "${BASH_SOURCE[0]}" env --dest "$t/cfg/firesong.env" \
    --lan-ip 10.0.0.5 --cube-ip 10.0.0.6 --nfs-server 10.0.0.7 --phone-origin https://box.example.ts.net:8443 2>/dev/null
  local e="$t/cfg/firesong.env"
  expect "env pins the 4090 by UUID" [ "$(env_get "$e" CUDA_VISIBLE_DEVICES)" = "GPU-aaaaaaaa-1111-2222-3333-444444444444" ]
  expect "env fills the Cube serial" [ "$(env_get "$e" FIRESONG_CUBE_SERIAL)" = "10.0.0.6:5555" ]
  expect "env fills the phone origin" [ "$(env_get "$e" NIGHTINGALE_REMOTE_URL)" = "https://box.example.ts.net:8443" ]
  expect "env file is mode 600" [ "$(stat -c %a "$e")" = 600 ]
  expect "no placeholders left" no_placeholders "$e"
  expect "env refuses to overwrite" fails "${BASH_SOURCE[0]}" env --dest "$e"
  expect "env rejects a bad IP" fails env FIRESONG_NVIDIA_SMI="$t/nvidia-smi" "${BASH_SOURCE[0]}" env --dest "$t/x.env" --cube-ip 999.1

  CADDY=/opt/caddy "${BASH_SOURCE[0]}" unit --dest "$t/units" --release-root /srv/fs 2>/dev/null
  expect "unit renders the release root" grep -q '^ExecStart=/srv/fs/current/server$' "$t/units/firesong.service"
  expect "caddy unit renders" grep -q '^ExecStart=/opt/caddy run ' "$t/units/firesong-caddy.service"
  expect "no template markers left" no_markers "$t/units/firesong.service" "$t/units/firesong-caddy.service"

  "${BASH_SOURCE[0]}" owner-steps --env "$e" > "$t/steps" 2>/dev/null
  expect "owner steps carry the fstab line" grep -q "10.0.0.7:/var/lib/firesong-cache /mnt/firesong-cache nfs rw,soft,intr,_netdev,nofail,bg 0 0" "$t/steps"
  expect "owner steps carry the Funnel command" grep -q "tailscale funnel --bg --https=8443 http://127.0.0.1:64449" "$t/steps"
  expect "owner steps carry Funnel off" grep -q "funnel --https=8443 off" "$t/steps"
  echo "self-test: $pass passed, $failn failed"
  [ "$failn" = 0 ]
}

CMD="${1:-}"
[ -n "$CMD" ] || { usage; exit 2; }
shift
case "$CMD" in
  env) cmd_env "$@" ;;
  unit) cmd_unit "$@" ;;
  owner-steps) cmd_owner_steps "$@" ;;
  check) cmd_check "$@" ;;
  self-test) cmd_self_test ;;
  -h|--help|help) usage ;;
  *) usage >&2; die "unknown command: $CMD" ;;
esac
