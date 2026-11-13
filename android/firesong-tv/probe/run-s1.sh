#!/usr/bin/env bash
# Spike S1 (design §8) on the real Fire TV Cube, driven from the FireSong host.
#
#   android/firesong-tv/probe/run-s1.sh OUT_DIR [APK]
#
# APK should be a debug build made with the throwaway test CA, so step 5 can
# test whether the WebView honours network_security_config:
#   ./prepare.sh --tls
#   ../gradlew -p .. assembleDebug -Pfiresong.lanCa=$PWD/tls/ca.pem
#
# Needs FIRESONG_CUBE_SERIAL (or tvctl -s), python3 with websocket-client.
# Follows the owner's TV rules: runs only while the TV is idle, presses HOME
# (or exits FireSong) at the end, removes every adb reverse/forward it made and
# stops its servers, also on failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
TVCTL="$REPO/tools/tvctl"
OUT="${1:?usage: run-s1.sh OUT_DIR [APK]}"
APK="${2:-$REPO/android/firesong-tv/app/build/outputs/apk/debug/app-debug.apk}"
HTTP_PORT="${S1_HTTP_PORT:-64461}"
TLS_PORT="${S1_TLS_PORT:-64462}"
STRANGER_PORT="${S1_STRANGER_PORT:-64463}"
CDP_PORT="${S1_CDP_PORT:-64464}"
export CDP_PORT
PY="${PYTHON:-python3}"

mkdir -p "$OUT"
LOG="$OUT/logcat.txt"
NOTES="$OUT/steps.txt"
: > "$NOTES"
note() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$NOTES"; }
die() { note "ABORT: $*"; exit 1; }

for p in "$HTTP_PORT" "$TLS_PORT" "$STRANGER_PORT" "$CDP_PORT"; do
  if ss -ltn | awk '{print $4}' | grep -q ":$p\$"; then die "local port $p is busy"; fi
done
[ -f "$APK" ] || die "no APK at $APK"
"$HERE/prepare.sh" --tls > "$OUT/prepare.txt"
STRANGER_SHA="$(awk '/stranger leaf sha256/ {print $4}' "$OUT/prepare.txt")"

SERVERS=()
LOGCAT_PID=""
REVERSED=()
start_http() {
  "$PY" -I -m http.server "$HTTP_PORT" --bind 127.0.0.1 --directory "$HERE" >> "$OUT/http.log" 2>&1 &
  HTTP_PID=$!
  SERVERS+=("$HTTP_PID")
}
cleanup() {
  set +e
  note "cleanup"
  if "$TVCTL" status 2>/dev/null | grep -q 'resumed:  org.firesong.tv'; then "$TVCTL" home; fi
  for p in "${REVERSED[@]}"; do "$TVCTL" unreverse "$p" >/dev/null 2>&1; done
  "$TVCTL" undevtools "$CDP_PORT" >/dev/null 2>&1
  [ -n "$LOGCAT_PID" ] && kill "$LOGCAT_PID" 2>/dev/null
  for pid in "${SERVERS[@]}"; do kill "$pid" 2>/dev/null; done
  "$TVCTL" status | tee -a "$NOTES"
}
trap cleanup EXIT

# Wait until $2 lines matching regex $1 exist in the log (timeout $3 s).
wait_count() {
  local re="$1" want="$2" t="${3:-60}" n=0
  for _ in $(seq "$t"); do
    n="$(grep -c -E "$re" "$LOG" || true)"
    [ "$n" -ge "$want" ] && return 0
    sleep 1
  done
  note "timeout waiting for $want x /$re/ (have $n)"
  return 1
}
count() { grep -c -E "$1" "$LOG" || true; }

"$TVCTL" idle || die "TV is busy"
note "TV idle; starting servers"
start_http
"$PY" -I "$HERE/serve_tls.py" "$TLS_PORT" "$HERE/tls/leaf.pem" "$HERE/tls/leaf.key" "$HERE" > "$OUT/tls.log" 2>&1 &
SERVERS+=("$!")
"$PY" -I "$HERE/serve_tls.py" "$STRANGER_PORT" "$HERE/tls/stranger.pem" "$HERE/tls/stranger.key" "$HERE" > "$OUT/stranger.log" 2>&1 &
SERVERS+=("$!")
sleep 1

note "install $APK"
"$TVCTL" install "$APK" | tee -a "$NOTES"
for p in "$HTTP_PORT" "$TLS_PORT" "$STRANGER_PORT"; do "$TVCTL" reverse "$p" >/dev/null; REVERSED+=("$p"); done
"$TVCTL" logcat > "$LOG" 2>&1 &
LOGCAT_PID=$!
sleep 1

# 1. probe over http://localhost (adb reverse): a secure context, no certificates
note "step 1: probe over http://localhost:$HTTP_PORT"
"$TVCTL" configure --url "http://localhost:$HTTP_PORT/probe.html" --ui-density 0 --devtools on
wait_count 'FSPROBE-S1-DONE' 1 90 || true
sleep 1
"$TVCTL" screencap "$OUT/s1-probe-http.png" | tee -a "$NOTES"

# 2. remote keys -> DOM keys (Back must become Escape, Play/Pause a space)
note "step 2: keys 19 20 21 22 23 85 126 127 90 89 82 4"
before="$(count 'FSPROBE-KEY')"
"$TVCTL" key 19 20 21 22 23 85 126 127 90 89 82 4
sleep 2
note "key events logged: $(( $(count 'FSPROBE-KEY') - before ))"
"$TVCTL" screencap "$OUT/s1-keys.png" >/dev/null

# 3. long-press Back -> native exit prompt; Back dismisses it
note "step 3: long-press Back"
before_esc="$(count '"key":"Escape"')"
"$TVCTL" longkey 4
sleep 2
"$TVCTL" screencap "$OUT/s1-exit-prompt.png" >/dev/null
note "exit prompt logged: $(count 'exit prompt shown'); Escape events during long press: $(( $(count '"key":"Escape"') - before_esc ))"
"$TVCTL" key 4
sleep 1

# 4. DevTools: the WP6 acceptance triple, the browser version, then a renderer crash
note "step 4: DevTools + renderer crash"
if "$TVCTL" devtools "$CDP_PORT" >> "$NOTES" 2>&1; then
  "$PY" "$HERE/cdp.py" version | tee "$OUT/cdp-version.json" | tee -a "$NOTES" || true
  "$PY" "$HERE/cdp.py" eval '[isSecureContext, typeof AudioWorkletNode, typeof RTCPeerConnection]' | tee -a "$NOTES" || true
  gone_before="$(count 'renderer gone')"; ready_before="$(count 'page ready')"
  t0=$(date +%s)
  "$PY" "$HERE/cdp.py" crash | tee -a "$NOTES" || true
  if wait_count 'page ready' $(( ready_before + 1 )) 30; then
    note "renderer crash -> page ready again in $(( $(date +%s) - t0 )) s (renderer gone lines: $(( $(count 'renderer gone') - gone_before )))"
  fi
  "$TVCTL" undevtools "$CDP_PORT" >/dev/null 2>&1 || true
fi
wait_count 'FSPROBE-S1-DONE' 2 60 || true

# 5. network_security_config: https://localhost signed by the bundled test CA
note "step 5: https via bundled test CA (port $TLS_PORT)"
done_before="$(count 'FSPROBE-S1-DONE')"
"$TVCTL" configure --url "https://localhost:$TLS_PORT/probe.html"
wait_count 'FSPROBE-S1-DONE' $(( done_before + 1 )) 60 || true
note "TLS errors so far: $(count 'TLS error')"
"$TVCTL" screencap "$OUT/s1-probe-https-testca.png" >/dev/null

# 6. untrusted leaf: cancelled without a pin, proceeds with the leaf pin
note "step 6: stranger leaf without pin, then with pin"
tls_before="$(count 'TLS error')"
"$TVCTL" configure --url "https://localhost:$STRANGER_PORT/probe.html"
wait_count 'TLS error' $(( tls_before + 1 )) 20 || true
sleep 2
"$TVCTL" screencap "$OUT/s1-stranger-nopin.png" >/dev/null
done_before="$(count 'FSPROBE-S1-DONE')"
"$TVCTL" configure --url "https://localhost:$STRANGER_PORT/probe.html" --leaf-pin "$STRANGER_SHA"
wait_count 'FSPROBE-S1-DONE' $(( done_before + 1 )) 60 || true
note "pin proceed lines: $(count 'leaf pin matched')"

# 7. server outage while the page is loaded: overlay, then automatic recovery
note "step 7: server outage + recovery"
"$TVCTL" configure --url "http://localhost:$HTTP_PORT/probe.html" --reload
wait_count 'FSPROBE-S1-DONE' $(( $(count 'FSPROBE-S1-DONE') + 1 )) 60 || true
kill "$HTTP_PID"
t0=$(date +%s)
if wait_count 'server unreachable' $(( $(count 'server unreachable') + 1 )) 40; then
  note "overlay after $(( $(date +%s) - t0 )) s"
  "$TVCTL" screencap "$OUT/s1-outage-overlay.png" >/dev/null
fi
ready_before="$(count 'page ready')"
start_http
t0=$(date +%s)
if wait_count 'page ready' $(( ready_before + 1 )) 40; then note "recovered without input in $(( $(date +%s) - t0 )) s"; fi
wait_count 'FSPROBE-S1-DONE' $(( $(count 'FSPROBE-S1-DONE') + 1 )) 60 || true

# 8. density override (CSS viewport experiment)
note "step 8: ui_density 240"
done_before="$(count 'FSPROBE-S1-DONE')"
"$TVCTL" configure --ui-density 240
wait_count 'FSPROBE-S1-DONE' $(( done_before + 1 )) 60 || true
"$TVCTL" screencap "$OUT/s1-density240.png" >/dev/null

# 9. reset to the build default, then leave through the exit prompt
note "step 9: clear settings and exit"
"$TVCTL" configure --clear
sleep 3
"$TVCTL" longkey 4
sleep 2
"$TVCTL" key 22 23 2>/dev/null || true
sleep 2
note "resumed after exit: $("$TVCTL" status | awk '/resumed:/ {print $2}')"
note "done"
