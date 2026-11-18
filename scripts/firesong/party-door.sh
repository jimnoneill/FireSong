#!/usr/bin/env bash
# FireSong party door. Guests' phones join through Tailscale Funnel on the port of
# NIGHTINGALE_REMOTE_URL (the phone door), which should be open only during parties. This
# watcher opens it while the FireSong TV app is on screen and closes it once the TV app has been
# gone for FIRESONG_DOOR_IDLE_MIN minutes (default 20). The TV app holds connections to the TV
# door (FIRESONG_TV_PORT) while it is in front and tears its page down when it leaves the screen,
# so those connections are the signal; FIRESONG_CUBE_IP, when set, limits it to the Fire TV.
# With FIRESONG_CUBE_SERIAL set it also keeps the Fire TV's log (adb logcat, info and up) while
# FireSong is on screen, in <NIGHTINGALE_DATA_PATH>/firesong/sessions/cube-<UTC date>.log next to
# the server's flight record, so a crash or reboot of the Cube still leaves its log behind.
#
# It only ever touches its own Funnel port. It never runs `tailscale funnel reset` or
# `tailscale serve reset` (they would drop every other Funnel on the machine), and it refuses
# port 443. Without sudo, the user must be the Tailscale operator (`sudo tailscale set --operator=$USER`).
#
#   party-door.sh [--env FILE] run        watch and open/close the door (firesong-party-door.service)
#   party-door.sh [--env FILE] once       one check: open the door if the TV app is on screen,
#                                         close it if not and FIRESONG_DOOR_IDLE_MIN is 0
#   party-door.sh [--env FILE] status     print whether the TV app is on screen and the door is open
#   party-door.sh self-test               exercise the logic against stub `ss` and `tailscale`
set -euo pipefail

ENV_FILE="$HOME/.config/firesong/firesong.env"
POLL_S="${FIRESONG_DOOR_POLL_S:-15}"

say() { echo "party-door: $*"; }
die() { echo "party-door: $*" >&2; exit 1; }
usage() { sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

env_get() {  # env_get FILE KEY  (the value of KEY, unquoted; empty when unset)
  [ -r "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//"
}

load_config() {
  [ -r "$ENV_FILE" ] || die "no env file at $ENV_FILE"
  local origin
  origin="$(env_get "$ENV_FILE" NIGHTINGALE_REMOTE_URL)"
  REMOTE_BIND="$(env_get "$ENV_FILE" NIGHTINGALE_REMOTE_BIND)"
  TV_PORT="$(env_get "$ENV_FILE" FIRESONG_TV_PORT)"
  CUBE_IP="$(env_get "$ENV_FILE" FIRESONG_CUBE_IP)"
  CUBE_SERIAL="$(env_get "$ENV_FILE" FIRESONG_CUBE_SERIAL)"
  DATA_PATH="$(env_get "$ENV_FILE" NIGHTINGALE_DATA_PATH)"
  ADB="${ADB:-${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb}"
  IDLE_MIN="${FIRESONG_DOOR_IDLE_MIN:-$(env_get "$ENV_FILE" FIRESONG_DOOR_IDLE_MIN)}"
  IDLE_MIN="${IDLE_MIN:-20}"
  case "$origin" in https://*:[0-9]*) ;; *) die "NIGHTINGALE_REMOTE_URL must look like https://host.example:8443 (got '$origin')" ;; esac
  DOOR_PORT="${origin##*:}"
  DOOR_PORT="${DOOR_PORT%%/*}"
  [[ "$DOOR_PORT" =~ ^[0-9]+$ ]] || die "no port in NIGHTINGALE_REMOTE_URL ($origin)"
  [ "$DOOR_PORT" != 443 ] || die "refusing port 443: keep the phone door on its own Funnel port (8443)"
  [ -n "$REMOTE_BIND" ] || die "NIGHTINGALE_REMOTE_BIND is not set"
  [[ "$TV_PORT" =~ ^[0-9]+$ ]] || die "FIRESONG_TV_PORT is not set"
  [[ "$IDLE_MIN" =~ ^[0-9]+$ ]] || die "FIRESONG_DOOR_IDLE_MIN must be whole minutes"
  case "$CUBE_IP" in *"<"*) CUBE_IP="" ;; esac
  case "$CUBE_SERIAL" in *"<"*) CUBE_SERIAL="" ;; esac
}

tv_on_screen() {  # true while the TV app holds a connection to the TV door
  ss -Htn state established "( sport = :$TV_PORT )" 2>/dev/null |
    awk -v cube="$CUBE_IP" '{ peer = $4; sub(/^\[::ffff:/, "", peer); sub(/\]/, "", peer)
                              if (cube == "" || index(peer, cube ":") == 1) n++ } END { exit !(n > 0) }'
}

door_open() {  # true when Funnel serves the door port
  tailscale funnel status --json 2>/dev/null | grep -Eq "\"[^\"]*:$DOOR_PORT\": *true"
}

open_door() {
  if tailscale funnel --bg --https="$DOOR_PORT" "http://$REMOTE_BIND" >/dev/null 2>&1; then
    say "FireSong is on the TV: phone door open on :$DOOR_PORT"
  else
    say "could not open the phone door on :$DOOR_PORT (is this user the Tailscale operator?)"
  fi
}

close_door() {
  if tailscale funnel --https="$DOOR_PORT" off >/dev/null 2>&1; then
    say "$1: phone door closed on :$DOOR_PORT"
  else
    say "could not close the phone door on :$DOOR_PORT"
  fi
}

LOGCAT_PID=""
KEEP_LOG=0  # only the long-running watcher keeps the log; `once` would leave adb orphaned
cube_log_running() { [ -n "$LOGCAT_PID" ] && kill -0 "$LOGCAT_PID" 2>/dev/null; }

keep_cube_log() {  # (re)start the Fire TV log while FireSong is on screen
  [ "$KEEP_LOG" = 1 ] && [ -n "$CUBE_SERIAL" ] && [ -n "$DATA_PATH" ] && [ -x "$ADB" ] || return 0
  cube_log_running && return 0
  local dir="$DATA_PATH/firesong/sessions"
  mkdir -p "$dir" || return 0
  "$ADB" connect "$CUBE_SERIAL" >/dev/null 2>&1 || true
  "$ADB" -s "$CUBE_SERIAL" logcat -v threadtime -T 1 '*:I' >>"$dir/cube-$(date -u +%F).log" 2>/dev/null &
  LOGCAT_PID=$!
}

stop_cube_log() {
  if cube_log_running; then kill "$LOGCAT_PID" 2>/dev/null || true; fi
  LOGCAT_PID=""
}

LAST_SEEN=0
tick() {  # tick NOW
  if tv_on_screen; then
    LAST_SEEN="$1"
    door_open || open_door
    keep_cube_log
  elif [ $(($1 - LAST_SEEN)) -ge $((IDLE_MIN * 60)) ]; then
    stop_cube_log
    if door_open; then close_door "FireSong left the TV ${IDLE_MIN} min ago"; fi
  fi
}

cmd_run() {
  load_config
  KEEP_LOG=1
  say "watching the TV door :$TV_PORT${CUBE_IP:+ for $CUBE_IP}; door :$DOOR_PORT -> $REMOTE_BIND, closes after ${IDLE_MIN} min away"
  # A stopped watcher leaves a running party alone, but does not leave an idle door open.
  trap 'stop_cube_log; tv_on_screen || { door_open && close_door "watcher stopped while FireSong is off the TV"; }; exit 0' TERM INT
  LAST_SEEN="$(date +%s)"
  while true; do
    tick "$(date +%s)"
    sleep "$POLL_S" & wait $!
  done
}

cmd_once() {
  load_config
  local now
  now="$(date +%s)"
  LAST_SEEN="$now"
  [ "$IDLE_MIN" != 0 ] || LAST_SEEN=0
  tick "$now"
}

cmd_status() {
  load_config
  if tv_on_screen; then echo "TV app: on screen"; else echo "TV app: not on screen"; fi
  if door_open; then echo "phone door :$DOOR_PORT: open"; else echo "phone door :$DOOR_PORT: closed"; fi
}

cmd_self_test() {
  local t pass=0 failn=0
  t="$(mktemp -d "${TMPDIR:-/tmp}/party-door-test.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$t'" EXIT
  mkdir -p "$t/bin"
  # Stubs: `ss` prints $t/conns; `tailscale` logs its arguments and reports $t/funnel as status.
  printf '#!/bin/sh\ncat "%s/conns"\n' "$t" > "$t/bin/ss"
  cat > "$t/bin/tailscale" <<STUB
#!/bin/sh
echo "\$*" >> "$t/calls"
case "\$*" in
  "funnel status --json") cat "$t/funnel" ;;
esac
STUB
  chmod +x "$t/bin/ss" "$t/bin/tailscale"
  cat > "$t/env" <<'ENV'
NIGHTINGALE_REMOTE_BIND=127.0.0.1:64449
NIGHTINGALE_REMOTE_URL=https://box.example.ts.net:8443
FIRESONG_TV_PORT=64443
FIRESONG_CUBE_IP=10.0.0.6
ENV
  expect() {  # expect NAME COMMAND...: pass when COMMAND succeeds
    local name="$1"
    shift
    if "$@"; then pass=$((pass + 1)); echo "ok   $name"; else failn=$((failn + 1)); echo "FAIL $name"; fi
  }
  fails() { ! "$@"; }
  state() {  # state CONNS FUNNEL
    printf '%b' "$1" > "$t/conns"
    printf '%s\n' "$2" > "$t/funnel"
    : > "$t/calls"
  }
  once() { PATH="$t/bin:$PATH" "${BASH_SOURCE[0]}" --env "$t/env" once >/dev/null 2>&1; }
  local tv='0 0 10.0.0.5:64443 10.0.0.6:43540\n' other='0 0 10.0.0.5:64443 10.0.0.9:51000\n'
  local closed='{"AllowFunnel":{"box.example.ts.net:443":true}}'
  local open='{"AllowFunnel":{"box.example.ts.net:443":true,"box.example.ts.net:8443":true}}'

  state "$tv" "$closed"; once
  expect "TV on screen opens the door" grep -qx "funnel --bg --https=8443 http://127.0.0.1:64449" "$t/calls"
  state "$tv" "$open"; once
  expect "an open door is left alone" fails grep -q -- "--https" "$t/calls"
  state "$other" "$closed"; once
  expect "another device does not open it" fails grep -q -- "--https" "$t/calls"
  state "" "$open"; once
  expect "a fresh watcher waits out the idle time" fails grep -q -- "off" "$t/calls"
  state "" "$open"; FIRESONG_DOOR_IDLE_MIN=0 once
  expect "TV gone past the idle time closes it" grep -qx "funnel --https=8443 off" "$t/calls"
  state "" "$closed"; FIRESONG_DOOR_IDLE_MIN=0 once
  expect "a closed door is left alone" fails grep -q -- "--https" "$t/calls"
  state "" "$open"; FIRESONG_DOOR_IDLE_MIN=0 once
  expect "the :443 Funnel is never touched" fails grep -Eq -- "reset|https=443" "$t/calls"
  sed -i 's/:8443$/:443/' "$t/env"; state "$tv" "$closed"
  expect "port 443 is refused" fails once
  expect "nothing ran for port 443" fails grep -q -- "--https" "$t/calls"
  echo "self-test: $pass passed, $failn failed"
  [ "$failn" = 0 ]
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    run) cmd_run; exit ;;
    once) cmd_once; exit ;;
    status) cmd_status; exit ;;
    self-test) cmd_self_test; exit ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
usage >&2
exit 2
