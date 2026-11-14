# firesong-tv (FireSong for the Fire TV Cube)

A thin Kotlin WebView host, package `org.firesong.tv`, app name **FireSong** (WP6 in the design). It shows the FireSong server's TV page fullscreen and adds only what a web page cannot do on a Fire TV: settings from the host, the host-token cookie, the remote's keys, trust for the LAN certificate, and recovery from crashes and network loss.

- No NDK, no AndroidX, no autostart (a karaoke app should not start itself). `minSdk`/`targetSdk` 28 = Fire OS 7.
- Build: AGP 8.5.2, Kotlin 1.9.24, Gradle 8.7 wrapper (checksum-pinned), JDK 17, compileSdk 34.
- Tested on the Cube (AFTGAZL, Fire OS 7.7.1.7, Amazon WebView Chromium 138.0.7204.244). Spike S1 results are in [`probe/S1-RESULTS.md`](probe/S1-RESULTS.md).

## Build

```sh
source scripts/firesong/devenv.sh            # JAVA_HOME (17), ANDROID_HOME, GRADLE_USER_HOME on staging1
cd android/firesong-tv
./gradlew assembleDebug testDebugUnitTest lintDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

The SDK needs `platforms;android-34` and `build-tools;34.0.0` (`$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`).

Build values come from `-P<name>=<value>` or the git-ignored `firesong.local.properties` (copy [`firesong.local.properties.example`](firesong.local.properties.example)):

| Property | Default | Meaning |
|---|---|---|
| `firesong.debugTvUrl` | `http://localhost:64448/?tv=1` | Debug default URL. With `adb reverse tcp:64448 tcp:64448`, the Cube reaches the host's TV listener; `http://localhost` is a secure context, so AudioWorklet and WebRTC work without certificates. |
| `firesong.tvUrl` | empty | Release default URL (https only). Empty means "configure after install". |
| `firesong.lanCa` | the committed placeholder | Path of the LAN CA root (PEM) to bundle as `@raw/firesong_lan_ca`. See [`certs/README.md`](certs/README.md). |
| `firesong.leafPins` | empty | Comma-separated pins for the `onReceivedSslError` fallback. |

Release builds are signed with the debug key, as FirePlay does: the app is sideloaded, and `adb install -r` can replace a debug build. Both build types use the same package.

## Install and configure (from the host)

`tools/tvctl` wraps adb with the owner's TV rules: it installs, configures and launches only while the TV is idle on the Amazon launcher (not while FireSong is in front, which would kill or reload a running party), sends keys only while FireSong is in front and awake, never touches other apps, and refuses to run adb when `~/.android/adbkey` is missing (adb would create a new key the Cube has not approved).

```sh
export FIRESONG_CUBE_SERIAL=<cube-lan-ip>:5555        # or scripts/firesong/devenv.local.sh
tools/tvctl status
tools/tvctl install android/firesong-tv/app/build/outputs/apk/debug/app-debug.apk
tools/tvctl configure --url https://<tv-host>:64443/?tv=1 --token-file <data>/firesong/host-token
tools/tvctl home
```

Settings are accepted **only** by the activity alias `org.firesong.tv/.Configure`. It requires `WRITE_SECURE_SETTINGS`, which `adb shell` holds and ordinary apps cannot. The launcher activity ignores setting extras, so no other app on the TV can point FireSong at another origin or obtain the host token as a cookie.

| Extra | Type | Effect |
|---|---|---|
| `url` | string | TV page URL. Release: https only. Debug: http too. |
| `host_token` | string | Host token, cookie-safe characters, 16-256. Bound to the origin of the current URL; an empty string removes it. |
| `leaf_pin` | string | Comma-separated pins for the TLS fallback: 64 hex chars (certificate SHA-256) or `sha256/<base64>` (SPKI). Bound to the URL's origin; empty removes. |
| `devtools` | boolean | WebView remote debugging. Default: on in debug builds, off in release. |
| `clear` | boolean | Forget all stored settings first. |
| `reload` | boolean | Reload the page even if nothing changed. |
| `issued_ms` | long | When the sender issued the intent (ms since the epoch). An intent issued no later than the newest one applied is ignored, because Android can recreate the activity with the intent that first started it. `cube.sh launch` and `tvctl configure` add it. Intents without it still apply, except when the activity is being recreated. |

FireSong keeps its page only while it is on screen. HOME, another app or the Cube going to sleep closes the page, which stops the song, every phone voice and the TV seat; opening FireSong again reloads it. A renderer the system kills in the background is not replaced until then.

The token and pins never cross origins: when the URL moves to another origin without a new token, both are dropped. The cookie set before `loadUrl` is `firesong_host=<t>; Path=/; HttpOnly; SameSite=Strict`, plus `; Secure` on https, as in `docs/firesong/PROTOCOL.md` §2.2. The token is never logged.

## Remote keys

The web client reads only `KeyboardEvent.key`: `nav-input-context.tsx` uses Arrow keys, Enter (confirm) and Escape (back), and `use-playback-input.ts` uses space to pause or continue. Measured on the Cube, with every event trusted:

| Remote key | Android key code | The page receives |
|---|---|---|
| D-pad | 19-22 | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` (native) |
| Select | 23 `DPAD_CENTER` | `Enter` (native) |
| Back (short press) | 4 | `Escape`, sent on release (bridge) |
| Back (held 0.7 s or more) | 4 | nothing; a native "Exit FireSong?" prompt opens with focus on **Stay**. Fire OS lays the buttons out as [Exit] [Stay]. |
| Play/Pause | 85, 126, 127 | `" "` (space) (bridge) |
| Fast-forward, Rewind | 90, 89 | `MediaFastForward`, `MediaRewind` (native; the client ignores them today) |
| Menu | 82 | nothing |

When no page is shown (an error or "not set up" screen), Back opens the exit prompt.

## Trust (release)

- `res/xml/network_security_config.xml`: system CAs plus `@raw/firesong_lan_ca`; no cleartext. **S1 confirmed that the Amazon WebView honours it**: an https page signed by a bundled test CA loaded with no SSL error.
- Fallback, in case the trust anchor ever stops working: `onReceivedSslError` proceeds only for the configured TV host, over https, when the leaf matches a pin and is within its validity. Every other error is cancelled, and the rejected leaf's SHA-256 and SPKI pin are logged, so they can be pinned on purpose.
- Caddy `tls internal` leaf certificates live about 12 hours, with new keys. Pin the CA (bundle it) rather than the leaf; leaf pins only suit a long-lived static leaf.
- Debug builds also allow cleartext and user-installed CAs (`src/debug/res/xml/network_security_config.xml`).

## Resilience

- **Renderer crash or kill** (`onRenderProcessGone`): the WebView is destroyed, recreated and reloaded. On the Cube, a `Page.crash` was back in 3-5 s. Three losses within 60 s switch to the backoff overlay.
- **Main-frame load error**, HTTP 401 (host token rejected) or HTTP 5xx: a native "Reconnecting to FireSong…" overlay, then retries after 1, 2, 4, 8, 16 and 30 s. Network-available events retry at once.
- **Server gone while the page is loaded**: a watchdog sends `HEAD /favicon.png` every 5 s (exempt from the host token). After 3 failures it shows the overlay; when the server answers again, it reloads. On the Cube: overlay after 12-13 s, page back 5-6 s after the server returned, with no input.
- Navigation is held to the configured origin. Mixed content is never allowed. There is no grey video poster.
- `FLAG_KEEP_SCREEN_ON`, audio focus `GAIN` while visible, and renderer priority `IMPORTANT`.

## Logs and debugging

- `tools/tvctl logcat` shows tags `FireSong` (native) and `FireSongJS` (every page `console.*` message, with its source and line).
- `window.FSPROBE.info()` returns JSON with the app, WebView, device, audio (`PROPERTY_OUTPUT_FRAMES_PER_BUFFER`, sample rate, low-latency/pro features), display (including the HDMI mode) and memory.
- `tools/tvctl devtools <port>` (a free loopback port; 9222 is taken on the server machine), then `CDP_PORT=<port> python3 probe/cdp.py eval|shot|crash` (needs `websocket-client`). **`adb screencap` is all black while the WebView is on screen** (native views capture fine), so take page screenshots through CDP (`cdp.py shot`).

## Files

| Path | What |
|---|---|
| `app/src/main/java/org/firesong/tv/MainActivity.kt` | WebView host: settings, cookie, keys, overlay, recovery, watchdog, clients |
| `TvConfig.kt`, `KeyBridge.kt`, `CertPin.kt`, `Backoff.kt`, `ServerProbe.kt` | Pure rules, unit-tested on the JVM (`app/src/test`) |
| `FsProbe.kt`, `Prefs.kt` | `FSPROBE` bridge, SharedPreferences |
| `app/src/main/res/xml/network_security_config.xml`, `app/src/debug/res/xml/…` | Trust (release, debug) |
| `app/src/main/res/raw/firesong_lan_ca.pem` | Placeholder CA. Its key was destroyed at creation; replace it before use. |
| `../../branding/make_assets.py` | Builds the launcher banner, adaptive-icon layers, overlay mark and the full-screen overlay art (connecting screen, stage backdrop) from `branding/source/` |
| `probe/` | Spike S1: probe page, worklet, `prepare.sh`, `serve_tls.py`, `cdp.py`, `run-s1.sh`, results |
| `../../tools/tvctl` | Host-side adb helper |
