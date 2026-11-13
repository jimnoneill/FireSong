#!/usr/bin/env bash
# On-Cube check that FireSong's page and all of its audio stop when the app
# leaves the front (HOME), and that the page comes back when FireSong is
# opened again. Restores the Cube's starting state (puts it back to sleep if
# it was asleep).
#
# Usage: cube-lifecycle-check.sh [--out DIR]
#
# Needs: the FireSong server on 127.0.0.1:$PORT (default 64448) with the host
# token in $NIGHTINGALE_DATA_PATH/firesong/host-token, the Cube's serial in
# $FIRESONG_CUBE_SERIAL (or ~/.config/firesong/firesong.env), and the
# websocket-client Python package for android/firesong-tv/probe/cdp.py.
#
# Proving that audio stops: Chrome suspends the output of an AudioContext
# that renders only silence, so with no phone singing the OS lists no
# FireSong audio player even while the page is in front. The check plays a
# 15 kHz tone at -66 dBFS from the page (inaudible on TV speakers), requires
# the OS to list a started FireSong player, then requires that player to be
# gone after HOME.
#
# Only runs when the TV is idle: the launcher in front, or asleep with nothing
# playing. Waking the Cube switches the TV on over HDMI-CEC.
set -u

REPO=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE="${FIRESONG_ENV_FILE:-$HOME/.config/firesong/firesong.env}"
env_value() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
SERIAL=${FIRESONG_CUBE_SERIAL:-$(env_value FIRESONG_CUBE_SERIAL)}
[ -n "$SERIAL" ] || { echo "ABORT: FIRESONG_CUBE_SERIAL is not set"; exit 2; }
export FIRESONG_CUBE_SERIAL=$SERIAL
DATA=${NIGHTINGALE_DATA_PATH:-$(env_value NIGHTINGALE_DATA_PATH)}
DATA=${DATA:-/mnt/fast/firesong/data}
PORT=${FIRESONG_CHECK_PORT:-64448}
CDP=${FIRESONG_CHECK_CDP_PORT:-64465}
ADB=${ADB:-${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb}
TOKEN_FILE="$DATA/firesong/host-token"
OUT="${FIRESONG_RELEASE_ROOT:-/mnt/fast/firesong}/artifacts/cube-lifecycle-$(date -u +%Y%m%dT%H%M%SZ)"
if [ "${1:-}" = --out ]; then OUT=$2; fi
URL="http://localhost:$PORT/?tv=1&mode=noraebang&fsdiag=1"
TONE_HZ=15000
TONE_GAIN=0.0005   # -66 dBFS
mkdir -p "$OUT"

pass=0; fail=0
ok()  { echo "PASS  $*"; pass=$((pass + 1)); }
bad() { echo "FAIL  $*"; fail=$((fail + 1)); }
# check "pass text" "fail text" command...
check() {
  local good=$1 failed=$2
  shift 2
  if "$@"; then ok "$good"; else bad "$failed"; fi
}
adbs() { "$ADB" -s "$SERIAL" "$@"; }
tvctl() { "$REPO/tools/tvctl" "$@" >/dev/null 2>&1; }
cube() { bash "$REPO/scripts/firesong/cube.sh" "$@" >/dev/null 2>&1; }
wakefulness() { adbs shell dumpsys power | sed -n 's/.*mWakefulness=\([A-Za-z]*\).*/\1/p'; }
resumed() {
  adbs shell dumpsys activity activities |
    sed -n 's/.*mResumedActivity: ActivityRecord{[^ ]* [^ ]* \([^ ]*\) .*/\1/p' | head -1
}
on_launcher() { [[ "$(resumed)" == com.amazon.tv.launcher/* ]]; }
firesong_in_front() { [[ "$(resumed)" == org.firesong.tv/* ]]; }
playing_sessions() { adbs shell dumpsys media_session | grep -c 'state=3'; }
app_uid() { adbs shell dumpsys package org.firesong.tv | sed -n 's/.*userId=\([0-9]*\).*/\1/p' | head -1; }

# Started audio players owned by FireSong's uid, from the OS's playback list.
players() {
  adbs shell dumpsys audio > "$OUT/.audio" 2>/dev/null
  grep -E "u/pid:$UID_FS/" "$OUT/.audio" | grep -c 'state:started'
}

# IDs of those players in the last `players` snapshot, one per line.
player_ids() {
  grep -E "u/pid:$UID_FS/" "$OUT/.audio" | grep 'state:started' | sed -n 's/^ *ID:\([0-9]*\) .*/\1/p'
}

# Number of DevTools page targets (0 once the WebView is destroyed).
pages() {
  curl -s -m 3 "http://127.0.0.1:$CDP/json" | python3 -c '
import json, sys
try:
    print(sum(1 for t in json.load(sys.stdin) if t.get("type") == "page"))
except Exception:
    print(0)'
}

# Evaluates JS in the page; prints the value as compact JSON ("" on failure).
cdp_eval() {
  CDP_PORT=$CDP python3 "$REPO/android/firesong-tv/probe/cdp.py" eval "$1" 2>/dev/null | tail -1 |
    python3 -c '
import json, sys
try:
    print(json.dumps(json.loads(sys.stdin.read()), separators=(",", ":"), sort_keys=True))
except Exception:
    print("")'
}

# Reads one dotted field from a JSON document: jfield '<json>' engine.state
jfield() {
  python3 -c '
import json, sys
try:
    value = json.loads(sys.argv[1])
    for key in sys.argv[2].split("."):
        value = value[key]
    print(json.dumps(value))
except Exception:
    print("null")' "$1" "$2"
}

DIAG_JS='({vis: document.visibilityState,
  rtc: window.fireSongDiag ? window.fireSongDiag.snapshot().connected : null,
  engine: window.fireSongDiag ? window.fireSongDiag.engine() : null})'
TONE_JS="(async () => {
  const context = new AudioContext();
  const tone = context.createOscillator();
  const level = context.createGain();
  tone.frequency.value = $TONE_HZ;
  level.gain.value = $TONE_GAIN;
  tone.connect(level).connect(context.destination);
  tone.start();
  await context.resume();
  window.__fireSongCheckTone = context;
  return context.state;
})()"

# Waits up to 40 s for the page's diagnostics to report a connected /rtc.
wait_diag() {
  local d=""
  for _ in $(seq 1 20); do
    d=$(cdp_eval "$DIAG_JS")
    [ "$(jfield "$d" rtc)" = true ] && break
    sleep 2
  done
  echo "$d"
}

# Polls until no started FireSong player is left; prints the seconds it took or "timeout".
wait_players_gone() {
  for i in $(seq 0 15); do
    [ "$(players)" = 0 ] && { echo "$i"; return; }
    sleep 1
  done
  echo timeout
}

# --- preflight ------------------------------------------------------------
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "x-firesong-host-token: $(cat "$TOKEN_FILE")" \
  "http://127.0.0.1:$PORT/")
[ "$code" = 200 ] || { echo "ABORT: the server does not serve the TV page (HTTP $code)"; exit 2; }
START=$(wakefulness)
echo "start: wakefulness=$START resumed=$(resumed)"
[ "$(playing_sessions)" = 0 ] || { echo "ABORT: something is playing"; exit 2; }
[ -z "$(resumed)" ] || on_launcher || { echo "ABORT: TV busy ($(resumed))"; exit 2; }
UID_FS=$(app_uid)
echo "org.firesong.tv uid=$UID_FS"
[ -n "$UID_FS" ] || { echo "ABORT: FireSong is not installed"; exit 2; }

restore() {
  tvctl home; sleep 3
  tvctl undevtools "$CDP"
  cube unreverse "$PORT"
  tvctl configure --clear; sleep 2
  tvctl home; tvctl stop; sleep 1
  echo "after cleanup: resumed=$(resumed) reverse=[$(adbs reverse --list | tr '\n' ' ')]"
  if [ "$START" = Asleep ] || [ "$START" = Dozing ]; then
    for _ in 1 2 3; do
      adbs shell input keyevent KEYCODE_SLEEP; sleep 6
      [ "$(wakefulness)" = Asleep ] && break
    done
    echo "restored: wakefulness=$(wakefulness)"
  fi
  rm -f "$OUT/.audio"
}
trap restore EXIT

tvctl wake || { echo "ABORT: could not wake the Cube"; exit 2; }
sleep 3
on_launcher || { echo "ABORT: launcher not in front after wake ($(resumed))"; exit 2; }

# --- 1. the native overlay (unreachable URL keeps it up) -------------------
cube launch --url "http://localhost:1/?tv=1"
sleep 8
check "overlay screenshot saved" "overlay screenshot" cube screencap "$OUT/overlay.png"
tvctl home; sleep 3
check "HOME from the error overlay returns to the launcher" "launcher not in front after HOME ($(resumed))" on_launcher

# --- 2. the real page, a tone, then HOME -------------------------------------
cube reverse "$PORT"
cube launch --url "$URL" --host-token-file "$TOKEN_FILE"
sleep 14
tvctl devtools "$CDP"
p1=$(pages)
check "WebView page alive while in front (pages=$p1)" "no WebView page while in front" [ "$p1" -ge 1 ]
d1=$(wait_diag); echo "$d1" > "$OUT/page-before-home.json"; echo "page: $d1"
check "TV page connected to /rtc" "TV page not connected to /rtc" [ "$(jfield "$d1" rtc)" = true ]
check "voice engine running" "voice engine not running" [ "$(jfield "$d1" engine.state)" = '"running"' ]
a0=$(players); echo "started FireSong players before the tone (silent page): $a0"
tone=$(cdp_eval "$TONE_JS"); echo "tone context: $tone"
sleep 2
a1=$(players); cp "$OUT/.audio" "$OUT/audio-with-tone.txt"; ids_before=$(player_ids | tr '\n' ' ')
check "tone playing: OS lists $a1 started FireSong player(s)" "tone: no started FireSong player ($tone)" [ "$a1" -ge 1 ]
CDP_PORT=$CDP python3 "$REPO/android/firesong-tv/probe/cdp.py" shot "$OUT/page-in-front.png" >/dev/null 2>&1

tvctl home
gone=$(wait_players_gone); cp "$OUT/.audio" "$OUT/audio-after-home.txt"
check "HOME: FireSong audio player gone after ${gone} s" "HOME: FireSong audio still playing 15 s after HOME" [ "$gone" != timeout ]
sleep 2
check "HOME: launcher in front" "HOME: launcher not in front ($(resumed))" on_launcher
p2=$(pages)
check "HOME: WebView page torn down (pages=0)" "HOME: page still alive (pages=$p2)" [ "$p2" = 0 ]
adbs logcat -d -v time -s FireSong:I | tail -20 > "$OUT/logcat-after-home.txt"
check "HOME: app logged 'page closed'" "HOME: no 'page closed' log line" grep -q "page closed" "$OUT/logcat-after-home.txt"

# --- 3. open FireSong again: a fresh page that reconnects -------------------
adbs shell monkey -p org.firesong.tv -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1
sleep 14
check "reopen: FireSong in front" "reopen: FireSong not in front ($(resumed))" firesong_in_front
tvctl undevtools "$CDP"; tvctl devtools "$CDP"
p3=$(pages)
check "reopen: WebView page rebuilt (pages=$p3)" "reopen: no WebView page" [ "$p3" -ge 1 ]
d3=$(wait_diag); echo "$d3" > "$OUT/page-after-reopen.json"; echo "page: $d3"
check "reopen: page reloaded and reconnected to /rtc" "reopen: page not connected to /rtc" [ "$(jfield "$d3" rtc)" = true ]
a3=$(players); ids_after=$(player_ids | tr '\n' ' ')
echo "started FireSong players: before HOME [$ids_before] after reopen [$ids_after]"
survivors=$(comm -12 <(tr ' ' '\n' <<<"$ids_before" | sed '/^$/d' | sort) <(tr ' ' '\n' <<<"$ids_after" | sed '/^$/d' | sort) | tr '\n' ' ')
check "reopen: none of the players from before HOME came back ($a3 new)" "reopen: players from before HOME still started: $survivors" [ -z "$survivors" ]

echo "RESULT pass=$pass fail=$fail artifacts=$OUT"
[ "$fail" = 0 ]
