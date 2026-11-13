#!/usr/bin/env bash
# FireSong Fire TV Cube helper: drive the Cube over adb from the server machine.
#
# Usage: cube.sh [--serial HOST:PORT] [--force] <command> [args]
#
#   connect                 adb connect, then report whether the Cube authorises this host
#   status                  device, Fire OS, foreground app, FireSong install, WebView,
#                           memory, display and adb reverses (read-only)
#   idle                    exit 0 if the TV is idle on the launcher, 1 if not
#   install <apk>           install or upgrade the FireSong app (org.firesong.tv only)
#   launch [--url URL] [--host-token-file FILE]
#                           start the FireSong app, optionally with its URL and host token
#   screencap <out.png>     save a screenshot of the TV
#   logcat [--follow] [FILTER]
#                           recent log; FILTER is a logcat spec ("FireSongJS:V *:S") or,
#                           without a colon, a case-insensitive grep pattern
#   reverse <port>          adb reverse tcp:PORT tcp:PORT (the Cube's localhost:PORT reaches
#                           the server machine's; a secure context with no certificate)
#   unreverse [port]        remove the reverses this script created (or just PORT)
#   home                    press HOME
#   self-test               check this script against a fake adb (no device needed)
#
# Safety rules (the Cube is a family TV and its owner is away):
#   - install and launch refuse unless the foreground activity is the Fire TV
#     launcher (the TV is idle); --force overrides that check only.
#   - install accepts only an APK whose package is org.firesong.tv. Nothing
#     else is ever installed, uninstalled, cleared or force-stopped.
#   - adb is never run if ~/.android/adbkey is missing: adb would make a new
#     key, which the Cube has not approved and nobody at home can approve.
#   - unreverse removes only reverses recorded by this script, never
#     `--remove-all` (other sessions may hold their own).
#   - After work, press HOME and remove your reverses: `cube.sh home; cube.sh unreverse`.
#
# Serial: --serial, else $FIRESONG_CUBE_SERIAL, else FIRESONG_CUBE_SERIAL in
# ~/.config/firesong/firesong.env. adb: $ADB, else $ANDROID_HOME/platform-tools/adb.
set -euo pipefail

PKG="${FIRESONG_TV_PACKAGE:-org.firesong.tv}"
ACTIVITY="${FIRESONG_TV_ACTIVITY:-.MainActivity}"
# Settings (url, host_token) are accepted only through this activity alias,
# which requires WRITE_SECURE_SETTINGS (adb shell has it); see
# android/firesong-tv/README.md. The launcher activity ignores setting extras.
CONFIGURE_ACTIVITY="${FIRESONG_TV_CONFIGURE_ACTIVITY:-.Configure}"
LAUNCHER="${FIRESONG_TV_LAUNCHER:-com.amazon.tv.launcher}"
ENV_FILE="${FIRESONG_ENV_FILE:-$HOME/.config/firesong/firesong.env}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

SERIAL="${FIRESONG_CUBE_SERIAL:-}"
FORCE=0

die() { echo "cube: $*" >&2; exit 1; }
note() { echo "cube: $*" >&2; }
usage() { sed -n '2,38p' "$SELF" | sed 's/^# \{0,1\}//'; }

# --- configuration ---------------------------------------------------------

env_value() {
  # Read KEY from the env file without sourcing it.
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//"
}

find_adb() {
  if [ -n "${ADB:-}" ]; then printf '%s\n' "$ADB"; return; fi
  local sdk="${ANDROID_HOME:-$HOME/Android/Sdk}"
  if [ -x "$sdk/platform-tools/adb" ]; then printf '%s\n' "$sdk/platform-tools/adb"; return; fi
  command -v adb || die "adb not found (set ADB or ANDROID_HOME)"
}

check_adbkey() {
  local dir="${ANDROID_USER_HOME:-$HOME/.android}"
  if [ ! -s "$dir/adbkey" ]; then
    die "$dir/adbkey is missing or empty. Running adb now would create a NEW key that the Cube has not approved. Restore the original key first; do not let adb regenerate it."
  fi
}

setup() {
  [ -n "$SERIAL" ] || SERIAL="$(env_value FIRESONG_CUBE_SERIAL)"
  [ -n "$SERIAL" ] || die "no Cube serial: pass --serial HOST:5555 or set FIRESONG_CUBE_SERIAL"
  case "$SERIAL" in *"<"*">"*) die "FIRESONG_CUBE_SERIAL is still a placeholder ($SERIAL)" ;; esac
  ADB_BIN="$(find_adb)"
  check_adbkey
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/firesong"
  REVERSES="$STATE_DIR/cube-reverses-$(printf '%s' "$SERIAL" | tr -c 'A-Za-z0-9._-' '_')"
}

adb_() { "$ADB_BIN" -s "$SERIAL" "$@"; }

# Quote one argument for the Cube's shell (adb shell joins argv into one string).
rq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

ensure_device() {
  local state
  state="$(adb_ get-state 2>&1 || true)"
  case "$state" in
    device) return 0 ;;
    *unauthorized*)
      die "the Cube has not authorised this host's adb key (state: unauthorized). Someone at the TV must accept 'Allow USB debugging' for it; never regenerate the key." ;;
  esac
  "$ADB_BIN" connect "$SERIAL" >/dev/null 2>&1 || true
  state="$(adb_ get-state 2>&1 || true)"
  case "$state" in
    device) return 0 ;;
    *unauthorized*) die "connected, but the Cube has not authorised this host's adb key" ;;
    *) die "cannot reach the Cube at $SERIAL: $state" ;;
  esac
}

# Serialise mutating commands across sessions that share the Cube.
with_lock() {
  local dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
  exec 9>"$dir/firesong-cube.lock"
  if command -v flock >/dev/null 2>&1 && ! flock -w 60 9; then
    die "another cube.sh command holds $dir/firesong-cube.lock"
  fi
}

# --- TV state ------------------------------------------------------------

resumed_activity() {
  # Fire OS 7 prints `mResumedActivity:` per stack and `ResumedActivity:` in
  # the summary (the only one while the screensaver runs); either will do.
  adb_ shell dumpsys activity activities 2>/dev/null | tr -d '\r' \
    | grep -m1 -E '(^|[[:space:]])m?ResumedActivity:' | sed 's/^[[:space:]]*//' || true
}

is_idle() {
  local line
  line="$(resumed_activity)"
  case "$line" in
    *" $LAUNCHER/"*) return 0 ;;
    *) return 1 ;;
  esac
}

require_idle() {
  local what="$1" line
  line="$(resumed_activity)"
  case "$line" in
    *" $LAUNCHER/"*) return 0 ;;
  esac
  if [ "$FORCE" = 1 ]; then
    note "warning: TV is not idle ($line); --force given, going ahead with $what"
    return 0
  fi
  die "refusing to $what: the TV is not idle on the launcher (${line:-foreground unknown}). Someone may be watching. Retry later, or pass --force."
}

# --- commands --------------------------------------------------------------

cmd_connect() {
  local out state
  out="$("$ADB_BIN" connect "$SERIAL" 2>&1 || true)"
  echo "$out"
  state="$(adb_ get-state 2>&1 || true)"
  echo "state: $state"
  case "$state" in
    device) return 0 ;;
    *unauthorized*) die "the Cube has not authorised this host's adb key; someone at the TV must accept it" ;;
    *) return 1 ;;
  esac
}

cmd_status() {
  ensure_device
  local props line ver webview mem wake size
  props="$(adb_ shell 'getprop ro.product.model; getprop ro.product.device; getprop ro.build.version.release; getprop ro.build.version.name' 2>/dev/null | tr -d '\r')"
  echo "serial:      $SERIAL"
  echo "model:       $(printf '%s\n' "$props" | sed -n 1p) ($(printf '%s\n' "$props" | sed -n 2p))"
  echo "android:     $(printf '%s\n' "$props" | sed -n 3p)"
  echo "build:       $(printf '%s\n' "$props" | sed -n 4p)"
  line="$(resumed_activity)"
  echo "foreground:  ${line:-unknown}"
  if is_idle; then echo "idle:        yes (launcher)"; else echo "idle:        NO"; fi
  wake="$(adb_ shell dumpsys power 2>/dev/null | tr -d '\r' | grep -m1 -o 'mWakefulness=[A-Za-z]*' || true)"
  echo "power:       ${wake#mWakefulness=}"
  ver="$(adb_ shell dumpsys package "$PKG" 2>/dev/null | tr -d '\r' | grep -m1 -o 'versionName=[^ ]*' || true)"
  echo "firesong:    ${ver:+installed, ${ver#versionName=}}${ver:-not installed}"
  webview="$(adb_ shell dumpsys webviewupdate 2>/dev/null | tr -d '\r' | grep -m1 'Current WebView package' | sed 's/^[[:space:]]*//' || true)"
  echo "webview:     ${webview:-unknown}"
  mem="$(adb_ shell cat /proc/meminfo 2>/dev/null | tr -d '\r' | awk '/^MemAvailable:/ {printf "%d MB", $2/1024}')"
  echo "mem avail:   ${mem:-unknown}"
  size="$(adb_ shell wm size 2>/dev/null | tr -d '\r' | sed -n 's/^Physical size: /panel /p; s/^Override size: /ui /p' | paste -sd ' ' -)"
  echo "display:     ${size:-unknown}"
  echo "reverses:    $(adb_ reverse --list 2>/dev/null | tr -d '\r' | awk 'NF >= 3 {print $2"->"$3}' | paste -sd ' ' - || true)"
  if [ -s "$REVERSES" ]; then
    echo "ours:        $(paste -sd ' ' "$REVERSES")"
  fi
}

apk_package() {
  local apk="$1" tool sdk="${ANDROID_HOME:-$HOME/Android/Sdk}"
  tool="${FIRESONG_AAPT:-}"
  if [ -z "$tool" ]; then
    tool="$(find "$sdk/build-tools" -mindepth 2 -maxdepth 2 -name aapt2 2>/dev/null | sort -V | tail -n 1 || true)"
  fi
  if [ -n "$tool" ] && [ -x "$tool" ]; then
    case "$tool" in
      *aapt2) "$tool" dump packagename "$apk" 2>/dev/null | head -n 1 | tr -d '\r' ;;
      *) "$tool" dump badging "$apk" 2>/dev/null | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -n 1 ;;
    esac
    return 0
  fi
  return 1
}

cmd_install() {
  local apk="${1:-}" pkg
  [ -n "$apk" ] || die "usage: cube.sh install <apk>"
  [ -f "$apk" ] || die "no such file: $apk"
  pkg="$(apk_package "$apk")" || die "cannot read the APK's package name (no aapt2 in \$ANDROID_HOME/build-tools); refusing to install an unverified APK"
  [ "$pkg" = "$PKG" ] || die "refusing: $apk is package '${pkg:-unknown}', and only $PKG may be installed"
  ensure_device
  with_lock
  require_idle "install $PKG"
  note "installing $apk ($PKG)"
  adb_ install -r "$apk"
}

cmd_launch() {
  local url="" token_file="" extras=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --url) url="${2:-}"; shift 2 ;;
      --url=*) url="${1#--url=}"; shift ;;
      --host-token-file) token_file="${2:-}"; shift 2 ;;
      --host-token-file=*) token_file="${1#--host-token-file=}"; shift ;;
      *) die "launch: unknown argument $1" ;;
    esac
  done
  ensure_device
  adb_ shell pm path "$PKG" 2>/dev/null | grep -q '^package:' || die "$PKG is not installed on the Cube"
  with_lock
  require_idle "launch $PKG"
  if [ -n "$url" ]; then extras="$extras --es url $(rq "$url")"; fi
  if [ -n "$token_file" ]; then
    local token
    token="$(tr -d '[:space:]' < "$token_file")" || die "cannot read $token_file"
    [[ "$token" =~ ^[0-9a-f]{32}$ ]] || die "$token_file does not hold a 32-hex host token"
    extras="$extras --es host_token $(rq "$token")"
  fi
  note "launching $PKG${url:+ at $url}${token_file:+ (with host token)}"
  local target="$ACTIVITY"
  [ -z "$extras" ] || target="$CONFIGURE_ACTIVITY"
  # shellcheck disable=SC2086 # extras is pre-quoted for the device shell
  adb_ shell "am start -n $PKG/$target$extras" | tr -d '\r' | grep -v -i 'host_token' || true
}

cmd_screencap() {
  local out="${1:-}" tmp
  [ -n "$out" ] || die "usage: cube.sh screencap <out.png>"
  ensure_device
  tmp="$out.part.$$"
  if ! adb_ exec-out screencap -p > "$tmp"; then rm -f "$tmp"; die "screencap failed"; fi
  if [ "$(head -c 4 "$tmp" | od -An -tx1 | tr -d ' \n')" != "89504e47" ]; then
    rm -f "$tmp"
    die "screencap did not return a PNG"
  fi
  mv -f "$tmp" "$out"
  echo "$out ($(wc -c < "$out") bytes)"
}

cmd_logcat() {
  local follow=0 filter=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --follow|-f) follow=1; shift ;;
      *) filter="${filter:+$filter }$1"; shift ;;
    esac
  done
  ensure_device
  local args=(logcat -v time)
  [ "$follow" = 1 ] || args+=(-d -t 2000)
  if [ -n "$filter" ] && [ "${filter#*:}" != "$filter" ]; then
    # shellcheck disable=SC2206 # a logcat filterspec is a space-separated list
    args+=($filter)
    adb_ "${args[@]}"
  elif [ -n "$filter" ]; then
    adb_ "${args[@]}" | grep -i -E -- "$filter" || true
  else
    adb_ "${args[@]}"
  fi
}

valid_port() { [[ "${1:-}" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

cmd_reverse() {
  local port="${1:-}"
  valid_port "$port" || die "usage: cube.sh reverse <port>"
  ensure_device
  with_lock
  adb_ reverse "tcp:$port" "tcp:$port" >/dev/null
  mkdir -p "$STATE_DIR"
  { cat "$REVERSES" 2>/dev/null || true; echo "$port"; } | sort -un > "$REVERSES.tmp"
  mv -f "$REVERSES.tmp" "$REVERSES"
  echo "reverse tcp:$port -> the server machine tcp:$port (remove with: cube.sh unreverse $port)"
}

cmd_unreverse() {
  local port="${1:-}" ports
  ensure_device
  with_lock
  if [ -n "$port" ]; then
    valid_port "$port" || die "usage: cube.sh unreverse [port]"
    if ! grep -qx "$port" "$REVERSES" 2>/dev/null && [ "$FORCE" != 1 ]; then
      die "tcp:$port was not reversed by cube.sh (another session may own it); pass --force to remove it anyway"
    fi
    ports="$port"
  else
    ports="$(cat "$REVERSES" 2>/dev/null || true)"
  fi
  if [ -z "$ports" ]; then
    echo "no reverses recorded by cube.sh"
    return 0
  fi
  local p
  for p in $ports; do
    adb_ reverse --remove "tcp:$p" >/dev/null 2>&1 || note "tcp:$p was already gone"
    echo "removed reverse tcp:$p"
    if [ -f "$REVERSES" ]; then
      grep -vx "$p" "$REVERSES" > "$REVERSES.tmp" || true
      mv -f "$REVERSES.tmp" "$REVERSES"
    fi
  done
  [ -s "$REVERSES" ] || rm -f "$REVERSES"
}

cmd_home() {
  ensure_device
  with_lock
  adb_ shell input keyevent KEYCODE_HOME
  echo "pressed HOME"
}

cmd_idle() {
  ensure_device
  if is_idle; then echo "idle"; return 0; fi
  echo "busy: $(resumed_activity)"
  return 1
}

# --- self-test -------------------------------------------------------------

cmd_self_test() {
  local t pass=0 failn=0
  t="$(mktemp -d "${TMPDIR:-/tmp}/cube-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$t'" EXIT
  mkdir -p "$t/home/.android" "$t/bin" "$t/state"
  echo "fake-key" > "$t/home/.android/adbkey"
  echo "launcher" > "$t/foreground"
  cat > "$t/bin/adb" <<'FAKE'
#!/usr/bin/env bash
# Fake adb for cube.sh self-test: logs calls, answers from files in $FAKE_DIR.
echo "$*" >> "$FAKE_DIR/calls"
[ "$1" = "-s" ] && shift 2
case "$1" in
  connect) echo "already connected to $2" ;;
  get-state) cat "$FAKE_DIR/adbstate" 2>/dev/null || echo device ;;
  exec-out) printf '\211PNG\r\n\032\nfakepng' ;;
  install) echo "Success" ;;
  reverse)
    case "$2" in
      --list) echo "host-19 tcp:64448 tcp:64448" ;;
      *) : ;;
    esac ;;
  logcat) printf 'I/FireSongJS( 1): hello\nI/other( 2): noise\n' ;;
  shell)
    shift
    case "$*" in
      *"dumpsys activity activities"*)
        if [ "$(cat "$FAKE_DIR/foreground")" = launcher ]; then
          echo "  ResumedActivity: ActivityRecord{1 u0 com.amazon.tv.launcher/.ui.HomeActivity_vNext t1}"
        else
          echo "    mResumedActivity: ActivityRecord{2 u0 com.plexapp.android/.Player t9}"
        fi ;;
      *"pm path"*) echo "package:/data/app/org.firesong.tv-1/base.apk" ;;
      *"am start"*) echo "Starting: Intent { cmp=org.firesong.tv/.MainActivity }" ;;
      *getprop*) printf 'AFTGAZL\ngazelle\n9\nFake 7.7\n' ;;
      *) : ;;
    esac ;;
esac
FAKE
  cat > "$t/bin/aapt2" <<'FAKE'
#!/usr/bin/env bash
case "$3" in *firesong*) echo org.firesong.tv ;; *) echo com.example.other ;; esac
FAKE
  chmod +x "$t/bin/adb" "$t/bin/aapt2"
  : > "$t/firesong.apk"; : > "$t/other.apk"
  printf '%s\n' "0123456789abcdef0123456789abcdef" > "$t/token"

  run() {
    env -i PATH="$PATH" HOME="$t/home" XDG_STATE_HOME="$t/state" XDG_RUNTIME_DIR="$t" \
      FAKE_DIR="$t" ADB="$t/bin/adb" FIRESONG_AAPT="$t/bin/aapt2" FIRESONG_ENV_FILE="$t/none" \
      bash "$SELF" --serial 10.0.0.2:5555 "$@" > "$t/out" 2>&1
  }
  check() {  # check <name> <expected rc> <grep pattern or -> -- command...
    local name="$1" want="$2" pat="$3" rc=0
    shift 3
    run "$@" || rc=$?
    if [ "$rc" = "$want" ] && { [ "$pat" = - ] || grep -q -E -- "$pat" "$t/out"; }; then
      pass=$((pass + 1)); echo "ok   $name"
    else
      failn=$((failn + 1)); echo "FAIL $name (rc=$rc want $want)"; sed 's/^/     /' "$t/out"
    fi
  }

  check "status reads the device" 0 "idle: +yes" status
  check "idle when on the launcher" 0 "^idle" idle
  check "install firesong when idle" 0 "Success" install "$t/firesong.apk"
  check "install refuses other packages" 1 "only org.firesong.tv" install "$t/other.apk"
  check "launch passes url and token" 0 "Starting" launch --url "https://h:1/?tv=1&mode=noraebang" --host-token-file "$t/token"
  if grep -q "org.firesong.tv/.Configure --es url 'https://h:1/?tv=1&mode=noraebang' --es host_token '0123456789abcdef0123456789abcdef'" "$t/calls"; then
    pass=$((pass + 1)); echo "ok   launch quotes extras for the device shell"
  else
    failn=$((failn + 1)); echo "FAIL launch quotes extras for the device shell"; tail -n 3 "$t/calls"
  fi
  echo other > "$t/foreground"
  check "install refused while someone watches" 1 "not idle" install "$t/firesong.apk"
  check "launch refused while someone watches" 1 "not idle" launch
  check "launch with --force" 0 "going ahead" --force launch
  if tail -n 1 "$t/calls" | grep -q "am start -n org.firesong.tv/.MainActivity\$\|am start -n org.firesong.tv/.MainActivity'\?$"; then
    pass=$((pass + 1)); echo "ok   launch without settings opens the launcher activity"
  else
    failn=$((failn + 1)); echo "FAIL launch without settings opens the launcher activity"; tail -n 3 "$t/calls"
  fi
  check "idle exits 1 when busy" 1 "busy" idle
  check "screencap writes a PNG" 0 "bytes" screencap "$t/shot.png"
  check "logcat grep filter" 0 "FireSongJS" logcat firesong
  check "reverse records the port" 0 "unreverse 64448" reverse 64448
  check "unreverse refuses foreign ports" 1 "not reversed by cube.sh" unreverse 5000
  check "unreverse removes ours" 0 "removed reverse tcp:64448" unreverse
  if grep -q -- "--remove-all" "$t/calls"; then
    failn=$((failn + 1)); echo "FAIL never uses reverse --remove-all"
  else
    pass=$((pass + 1)); echo "ok   never uses reverse --remove-all"
  fi
  check "home presses HOME" 0 "pressed HOME" home
  echo "unauthorized" > "$t/adbstate"
  check "unauthorized is reported, not re-keyed" 1 "not authorised" status
  rm -f "$t/adbstate"
  rm -f "$t/home/.android/adbkey"
  : > "$t/calls"
  check "missing adbkey stops before adb runs" 1 "adbkey is missing" status
  if [ -s "$t/calls" ]; then
    failn=$((failn + 1)); echo "FAIL adb ran without a key"
  else
    pass=$((pass + 1)); echo "ok   adb never ran without a key"
  fi
  echo "self-test: $pass passed, $failn failed"
  [ "$failn" = 0 ]
}

# --- main ------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="${2:-}"; shift 2 ;;
    --serial=*) SERIAL="${1#--serial=}"; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    --*) die "unknown option $1" ;;
    *) break ;;
  esac
done

CMD="${1:-}"
[ -n "$CMD" ] || { usage; exit 2; }
shift

if [ "$CMD" = "self-test" ]; then
  cmd_self_test
  exit $?
fi

setup
case "$CMD" in
  connect) cmd_connect ;;
  status) cmd_status ;;
  idle) cmd_idle ;;
  install) cmd_install "$@" ;;
  launch) cmd_launch "$@" ;;
  screencap) cmd_screencap "$@" ;;
  logcat) cmd_logcat "$@" ;;
  reverse) cmd_reverse "$@" ;;
  unreverse) cmd_unreverse "$@" ;;
  home) cmd_home ;;
  *) usage >&2; die "unknown command: $CMD" ;;
esac
