# firesong-tv (FireSong for the Fire TV Cube)

A thin Kotlin WebView host, package `org.firesong.tv`, app name **FireSong** (WP6 in the design). It shows the FireSong server's TV page fullscreen and adds only what a web page cannot do on a Fire TV: settings from the host, the host-token cookie, the remote's keys, trust for the LAN certificate, recovery from crashes and network loss, and (on trial) the phones' voices on a low-latency output.

- No AndroidX, no autostart (a karaoke app should not start itself). `minSdk`/`targetSdk` 28 = Fire OS 7.
- **Voice output (trial, off by default).** With `voice=native` in the TV URL, the app receives the phones' voices with libwebrtc and plays them through AAudio, while the song stays in the page. See [Voice output](#voice-output).
- Build: AGP 8.5.2, Kotlin 1.9.24, Gradle 8.7 wrapper (checksum-pinned), JDK 17, compileSdk 34.
- Tested on the Cube (AFTGAZL, Fire OS 7.7.1.7, Amazon WebView Chromium 138.0.7204.244). Spike S1 results are in [`probe/S1-RESULTS.md`](probe/S1-RESULTS.md).

## Build

```sh
source scripts/firesong/devenv.sh            # JAVA_HOME (17), ANDROID_HOME, GRADLE_USER_HOME on staging1
cd android/firesong-tv
./gradlew assembleDebug testDebugUnitTest lintDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

The SDK needs `platforms;android-34`, `build-tools;34.0.0`, `ndk;27.3.13750724` and `cmake;3.22.1` (`$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`).

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

- **Renderer crash or kill** (`onRenderProcessGone`): the WebView is destroyed, recreated and reloaded. On the Cube, a `Page.crash` was back in 3-5 s. Three losses within 60 s switch to the backoff overlay. The voice door goes with the WebView: the old one closes first, which ends its voice session, and the new WebView gets a new door (new port and token).
- **Main-frame load error**, HTTP 401 (host token rejected) or HTTP 5xx: a native "Reconnecting to FireSong…" overlay, then retries after 1, 2, 4, 8, 16 and 30 s. Network-available events retry at once.
- **Server gone while the page is loaded**: a watchdog sends `HEAD /favicon.png` every 5 s (exempt from the host token). After 3 failures it shows the overlay; when the server answers again, it reloads. On the Cube: overlay after 12-13 s, page back 5-6 s after the server returned, with no input.
- Navigation is held to the configured origin. Mixed content is never allowed. There is no grey video poster.
- `FLAG_KEEP_SCREEN_ON`, audio focus `GAIN` while visible, and renderer priority `IMPORTANT`.

## Voice output

On the web path the page receives every phone over WebRTC and plays the voices with Web Audio. On the Cube that output alone adds about 256 ms (OpenSL ES on the normal HDMI mixer, `latencyHint: 0`), and its bursty pulls most likely inflate the phones' jitter buffers too. AAudio's low-latency output measured 27-34 ms on the Cube (2026-11-22). So the app can receive the phones itself and play their voices through AAudio. The page keeps the song, the TV seat, the roster, slot assignment and scoring. Mouth to speaker is estimated at about 145 ms, against about 410-470 ms on the web path; these are estimates from measured hops, and the in-room monitor beep measures the real loop.

This replaces an earlier trial (endpoint version 1) that streamed the page's voice mix to the app. It underran, because the page renders audio in bursts up to about 250 ms apart.

### The trial flag

The path is **off by default**. The page uses it only when the TV URL carries `voice=native`, for example `tools/tvctl configure --url 'https://<tv-host>:64443/?tv=1&voice=native' …`. The page keeps the flag across reloads of the same WebView. The test rigs restore the URL with the flags in `FIRESONG_TV_URL_FLAGS` ([`docs/firesong/DEPLOY.md`](../../docs/firesong/DEPLOY.md) §4).

With the flag set, the page picks the app's path only when all of these hold:
- `window.FireSongVoice.endpoint()` offers a version-2 door with the `mics` feature;
- the door answers `ready` with `ok` true and `mics` in its `features`, within 3 s.

Otherwise it uses its own Web Audio path, exactly as without the flag. An older app offers no door or a version-1 door, and an older page rejects version 2, so mixed versions fall back too.

Mid-session, the page falls back to its own path for the rest of that page load when any of these happens:
- the door closes;
- the app sends `fatal`;
- no message arrives for 5 s;
- the output stays closed for 20 s;
- the app stops reading.

The phones then reconnect to the page within seconds.

Whether the Amazon WebView lets the https release page open `ws://127.0.0.1` is not verified yet. If it refuses, the page stays on its own path.

### How it works

- **`VoiceDoor.kt`** is a WebSocket server on `127.0.0.1`:
  - random port, a 128-bit per-WebView token in the path, and the configured TV origin checked;
  - one page connection at a time: a new one replaces the old, and the replaced session's teardown runs before the new `hello`. A connection that ended on its own, as on a page reload, has its teardown posted as it ends; if that ever lands after the next `hello`, the new engine session has already replaced the old one and the old `stop` does nothing.
  - at most 8 sockets are served at once (the page's connection, one replacing it, and a few ending or in their handshake); more are closed unread.

  The door lives as long as the WebView. It opens with the WebView, and it closes as the app destroys the WebView: FireSong leaving the screen, the renderer dying or the app ending. It closes the page connection with 1001 (going away), which the page takes as its own end, so a dying page never falls back to the web path and asks every phone to reconnect. Closing ends the voice session, which closes every phone's connection and the AAudio stream.
- **`MicEngine.kt` and `MicPeer.kt`** run one receive-only libwebrtc `PeerConnection` per phone.
  - Playout and recording are off (`setAudioPlayout(false)`, `setAudioRecording(false)`), so libwebrtc's own 10 ms poller hands each phone's decoded 48 kHz mono frames to an `AudioTrackSink`.
  - Every WebRTC call and every engine control runs in order on one thread, `fs-mics`.
  - The `PeerConnectionFactory` is built once per process, right after the first `ready`, and never disposed.
- **`libfiresongvoice.so`** (`src/main/cpp/`) holds the voice chain ported from the page:
  - per phone, as its audio arrives: high-pass, gate and auto level, into a ring;
  - per phone, in the AAudio callback: compressor, feedback notch, fader, monitor, a 120 ms echo and a reverb send;
  - for the mix: an FDN reverb, the bus compressor and the limiter, into one AAudio low-latency output.

  A failed or lost output is retried every 2 s, backing off to 10 s (HDMI may still be waking), and is never fatal. A started output whose callbacks stop for 1 s counts as lost and is reopened. Xruns in an output's first 0.5 s are counted but do not grow its buffer.
- **Headroom.** Song and voices now sum in Android, with no limiter over the sum. So the app trims the voices by 4 dB and clamps them at ±0.5 (−6 dBFS), and while this path is on the page trims the song by 8 dB (the page's own path trims it by 10 dB, so singers sit on top of the song). Their sum stays below full scale. The song is quieter at HDMI than its master; turn the TV up to match.
- **Scoring.** The app sends each phone's input back to the page, after high-pass, gate and auto level, as 512-sample float blocks. Pitch and scoring run on them unchanged.
- **Calibration.** A phone's "Tune my mic" runs two beeps:
  1. the scoring beep, played on the song's path; its result is persisted, as before;
  2. the app's monitor beep, a 1 kHz tone for 160 ms. It measures the singer's own loop, which is not persisted.

### Protocol

The code is the reference: `DoorMessages.kt`, `DoorCodec.kt` and `client/src/bridge/native-mic-protocol.ts`.

- **Discovery.** `window.FireSongVoice.endpoint()` returns `""` or `{"version":2,"url":"ws://127.0.0.1:<port>/voice?t=<32 hex>","features":["mics"]}`.
- **Page → app.** Text frames, one JSON object each, typed by `t`, at most 64 KiB. Every message is checked for shape, size and range.

  | `t` | Purpose |
  |---|---|
  | `hello` | First message, within 5 s |
  | `offer`, `ice`, `close` | A phone's peer connection: offer, candidates, close |
  | `detach`, `release` | A slot's phone left; a slot back to defaults |
  | `monitor`, `mute`, `mix`, `tap` | Per-slot controls |
  | `echo-mix` | The global echo and reverb mix |
  | `measure-monitor` | Run the monitor beep |

  An unknown `t` or field is ignored and counted. A broken rule closes the socket:

  | Close code | Cause |
  |---|---|
  | 1008 | A broken message rule |
  | 1009 | A message over 64 KiB |
  | 1003 | A binary frame from the page |
  | 1002 / 1007 | Bad framing / bad UTF-8 |
  | 1011 | An internal error, or more than 512 queued messages |
- **App → page.**

  | `t` | When |
  |---|---|
  | `ready` | Reply to `hello`: `ok`, `features`, `audio: open\|pending` |
  | `answer`, `peer-error`, `restart-needed` | A phone's negotiation and health |
  | `status` | Every 250 ms |
  | `engine-stats` | Every 1 s |
  | `peer-stats` | Every 2 s per phone |
  | `monitor-result` | Reply to `measure-monitor` |
  | `fatal` | `webrtc` or `internal`; then a 1011 close |
- **Tap.** Binary frames, little-endian, sent as soon as blocks are ready (about 94 blocks/s per phone):
  - header: `u8 version = 1`, `u8 kind = 1`, `u16 count`;
  - then `count` blocks of 2056 bytes: `u8 slot`, `u8 flags` (bit 0: zero fill after a detach), `u16 frames = 512`, `u32 seq` (a gap means dropped blocks), `f32[512]` samples.
- **Threads:**
  - `fs-voice-door` accepts connections.
  - `fs-voice-in` reads frames.
  - `fs-voice-out` is the socket's only writer, for text and taps.
  - `fs-voice-close` ends a connection whose close has not gone through within 3 s.
  - `fs-mics` makes every WebRTC API call and runs the engine's controls, in order.
  - libwebrtc's own worker thread, its 10 ms poller, calls each phone's `SlotSink`, which pushes the decoded frames into the C engine (`NativeMics.push`: high-pass, gate and auto level) and wakes `fs-voice-out` for the tap.
  - `fsv-guard` runs the feedback guard.
  - `fsv-clock` reads the AAudio timestamps, sets the buffer size and reopens the output.
  - The AAudio callback takes no locks, allocates nothing, never logs and makes no JNI or AAudio calls.

### Security

- No new permission: still `INTERNET`, `ACCESS_NETWORK_STATE` and `MODIFY_AUDIO_SETTINGS`. There is no `RECORD_AUDIO`, no service and no autostart.
- The phones' SDP, RTP, DTLS and STUN traffic is now parsed by libwebrtc inside the app process, which also holds the host token, instead of in the sandboxed WebView renderer. To narrow that surface:
  - `SdpFilter.kt` checks every offer before libwebrtc sees it: exactly one `m=audio` over `UDP/TLS/RTP/SAVPF`, no video or data channel, at most 300 lines of 1024 characters, and Opus present. It then strips every codec but Opus.
  - Only candidates whose address is a unicast IP literal are kept: a name, `.local` included, would make libwebrtc look it up on a new thread, and loopback, unspecified, multicast, broadcast and link-local addresses (IPv4-mapped forms included) would aim the app's connectivity checks at itself or the LAN. An offer keeps at most 16 candidates, and at most 32 trickled ones are taken per offer; the rest are dropped (trickled ones counted in `ignored`). A phone whose host candidates are all `.local` names, as Firefox's are, connects through the peer-reflexive candidate its checks to the TV create.
  - The factory has no video codecs, and any data channel is closed at once.
  - Answers carry no IPv6 candidates: the app gathers on no IPv6 network (`maxIPv6Networks = 0`).
  - SDP and candidates are never logged.
- A libwebrtc native crash ends the whole app, page included.

### The libwebrtc build

| Item | Value |
|---|---|
| Artifact | `io.github.webrtc-sdk:android:150.7871.04`, LiveKit's libwebrtc fork (M150), BSD-3, published 2026-10-23. Chosen because it is the only maintained prebuilt AAR found with a Java PCM tap per remote track (`AudioTrack.addSink`). |
| AAR sha256 | `1872dda4e3bf7d6ea6f7c6e11861332081c57081a1e62fc82fab72415c69c84c` (the same as Maven Central's `.sha256`) |
| Verification | [`gradle/verification-metadata.xml`](gradle/verification-metadata.xml) and [`gradle/verification-keyring.keys`](gradle/verification-keyring.keys): PGP signatures and sha256 for every dependency |
| ABIs | release `armeabi-v7a` only, the Cube's userland: `libjingle_peerconnection_so.so` (6.8 MB, stored uncompressed) and `libfiresongvoice.so`. Debug adds `x86_64` for the host emulator. |
| Source revision | Not published: Central's `-sources.jar` is a placeholder, and the `.so` carries only upstream's `WebRTC source stamp 2026-06-01T04:07:44`. **Probably `a545de4`** of `webrtc-sdk/webrtc` branch `m150_release`: it was the branch head when the AAR was published, and it is the revision of LiveKit's `webrtc-a545de4` prebuilt release. |

**Update cadence.** The WebView updates itself; this library does not. Check monthly for a newer webrtc-sdk build, and also whenever a Chrome stable release lists security fixes in WebRTC, Opus, libsrtp, BoringSSL or SCTP. Take a build that contains such fixes within two weeks:
1. Change the version in `app/build.gradle.kts`.
2. Regenerate the dependency metadata with all four tasks: `./gradlew --write-verification-metadata pgp,sha256 --export-keys assembleDebug assembleRelease testDebugUnitTest lintDebug`. A plain `help` run cannot discover detached configurations such as aapt2 and lint.
3. Check that the metadata's entry for the AAR carries a PGP key or a sha256 that matches Central's `.asc` or `.sha256`.
4. Run the same four tasks with an empty scratch `GRADLE_USER_HOME`, so every artifact is downloaded and verified again.
5. Build both APKs and check what changed outside the code: `aapt2 dump permissions` still lists only the three permissions above (a new AAR can add some), and the release APK still holds only `lib/armeabi-v7a/`.
6. On the Cube, while it is idle, install the release APK and configure the https TV URL with `voice=native` (the release route: it also checks that the page may open `ws://127.0.0.1`). With no phones, check:
   - the flight record: `mic-backend` with `kind: native, why: ready`, and in the TV samples `mics.backend` with `kind` `native`, `open` true, `burstFrames` 384, `outputLatencyMs` 25-40 and `apm` present. Any other `mic-backend` means the page could not use the door: stop there. It is `kind: web` with a `why` of `no-endpoint` (the app offered no door, for example because `libfiresongvoice.so` did not load) or one starting `native mic link` (`error`, `closed <code>`, `timeout`, `cannot open (…)`, `refused lib|webrtc`, `fatal <reason>`, `no-mics`);
   - `dumpsys media.audio_flinger`: besides the WebView's own player, the app's only output is the AAudio stream; there is no AudioTrack opened by WebRTC's Java audio device module, and no AudioRecord.
7. With phones (the rig's are enough), check:
   - the engine log's `first push: 48000 Hz, 1 ch`;
   - the first answer to each phone carries `a=candidate` lines. The app sends its candidates only in the answer, and a phone whose host candidates are `.local` names can connect only through them.
8. Soak and compare with the rig: `scripts/firesong/cube-load-test.py --voice native --phones 4 --seconds 240 --song <hash>`, then `--ab --song <hash>` for web against native on the same song (a song of at least 4:45: the native phase ends with a 30 s stall control). Every check must pass, among them no silence after the first 2 s, no resyncs after 10 s, at most 3 concealments per slot per minute, no xruns, the app process alive at the end, and an empty crash log (`logcat -b crash`). During one more run, unplug HDMI and power the TV off and on: the `FireSongVoice` log shows `stream lost` and a new `open`, and the voices come back without the page falling back to web.

## Logs and debugging

- `tools/tvctl logcat` shows tags `FireSong` (native) and `FireSongJS` (every page `console.*` message, with its source and line).
- The voice door and engine log under `FireSong`: the door's port, connects and disconnects, `mics session <n> ready` / `closed`, the factory and its audio processing, and rejected offers (never SDP or addresses). The C engine logs under `FireSongVoice`: the first push's rate and channels, output opens, buffer resizes and session starts and stops. `tools/tvctl logcat` leaves that tag out; add it as an extra filter, `tools/tvctl logcat FireSongVoice:V` (logcat moves filter arguments behind its options).
- `window.FSPROBE.info()` returns JSON with the app, WebView, device, audio (`PROPERTY_OUTPUT_FRAMES_PER_BUFFER`, sample rate, low-latency/pro features), display (including the HDMI mode) and memory.
- `tools/tvctl devtools <port>` (a free loopback port; 9222 is taken on the server machine), then `CDP_PORT=<port> python3 probe/cdp.py eval|shot|crash` (needs `websocket-client`). **`adb screencap` is all black while the WebView is on screen** (native views capture fine), so take page screenshots through CDP (`cdp.py shot`).

## Files

| Path | What |
|---|---|
| `app/src/main/java/org/firesong/tv/MainActivity.kt` | WebView host: settings, cookie, keys, overlay, recovery, watchdog, clients; builds and closes the voice door with the WebView |
| `TvConfig.kt`, `KeyBridge.kt`, `CertPin.kt`, `Backoff.kt`, `ServerProbe.kt`, `PageLifecycle.kt` | Pure rules, unit-tested on the JVM (`app/src/test`) |
| `FsProbe.kt`, `Prefs.kt` | `FSPROBE` bridge, SharedPreferences |
| `VoiceDoor.kt`, `DoorCodec.kt`, `DoorMessages.kt` | Voice door: WebSocket server, frame and message codec, message types (`DoorCodecTest`) |
| `MicEngine.kt`, `MicPeer.kt`, `SdpFilter.kt` | Phone voices over libwebrtc: sessions, peer connections, the offer filter (`RestartRuleTest`, `NegotiationQueueTest`, `SdpFilterTest`) |
| `NativeMics.kt`, `app/src/main/cpp/` | JNI and the C voice engine `libfiresongvoice.so`: `engine.c`, `aaudio_out.c`, `jni_mics.c`, the DSP blocks in `dsp/` |
| `gradle/verification-metadata.xml`, `gradle/verification-keyring.keys` | Gradle dependency verification (signatures and checksums) |
| `app/src/main/res/xml/network_security_config.xml`, `app/src/debug/res/xml/…` | Trust (release, debug) |
| `app/src/main/res/raw/firesong_lan_ca.pem` | Placeholder CA. Its key was destroyed at creation; replace it before use. |
| `../../branding/make_assets.py` | Builds the launcher banner, adaptive-icon layers, overlay mark and the full-screen overlay art (connecting screen, stage backdrop) from `branding/source/` |
| `probe/` | Spike S1: probe page, worklet, `prepare.sh`, `serve_tls.py`, `cdp.py`, `run-s1.sh`, results |
| `../../tools/tvctl` | Host-side adb helper |

## Third-party notices

**libwebrtc**, in `libjingle_peerconnection_so.so` and the `org.webrtc` classes, from `io.github.webrtc-sdk:android`:

```
Copyright (c) 2011, The WebRTC project authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

libwebrtc also builds in third-party code under its own licenses, among them Opus, BoringSSL, libsrtp, abseil-cpp, libc++, libvpx, libyuv, libaom and dav1d. For this source revision, their license texts are collected in `android-arm-release/LICENSE.md` inside `webrtc-android-arm-release.zip` of LiveKit's [`webrtc-a545de4`](https://github.com/livekit/rust-sdks/releases/tag/webrtc-a545de4) prebuilt release.

**Chromium's `DynamicsCompressor`**, ported to C in `app/src/main/cpp/dsp/compressor.c` (from `third_party/blink/renderer/platform/audio/dynamics_compressor.cc`, Chrome 138):

```
Copyright (C) 2011 Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

1.  Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
2.  Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
    its contributors may be used to endorse or promote products derived
    from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

These notices are in this README only; the APK does not carry them yet.
