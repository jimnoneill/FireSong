# Spike S1 results: the Fire TV Cube's WebView (2026-11-12)

**Verdict: the Amazon WebView is good enough.** It is Chromium 138 (at least 111), every S1 probe is true, and the network security config is honoured. GeckoView is not needed. Two results change other work packages:
- remote WebRTC audio is **silent in Web Audio unless the stream is also attached to a muted `<audio>` element** (affects WP4);
- the audio output reports **~0.26-0.32 s of `outputLatency`** (affects the S3 latency budget).

## How it was run

- **Device:** AFTGAZL (gazelle), Fire OS 7.7.1.7 (Android 9, build PS7717.5746N). HDMI mode 3840x2160 @ 59.94 Hz, UI 1920x1080 at 320 dpi. WebView `com.amazon.webview.chromium` `138.amazon-webview-v138-7204-tv.7204.244.304`.
- **APK:** a debug build of this app, made with `-Pfiresong.lanCa=probe/tls/ca.pem` (a throwaway test CA whose key was deleted after signing one `localhost` leaf).
- **Pages:**
  - `probe.html`, served from the host with `python3 -m http.server` on a loopback port;
  - two `serve_tls.py` servers: one with the test-CA leaf, one with a self-signed "stranger" leaf.
  - The Cube reached all three through `adb reverse` as `localhost:<port>`.
- **Driver:** `probe/run-s1.sh` through `tools/tvctl`. It ran only while the TV was idle. Afterwards it exited FireSong (HOME), and removed every reverse and forward and its servers. The app's settings were cleared, so they fall back to the build default.
- **Evidence:** `/mnt/fast/firesong/artifacts/s1/` on the host:
  - `run-20261112-175155/` is the final run: `logcat.txt`, `steps.txt`, `info-after-probe.txt`, `cdp-version.json`, and the screenshots `s1-probe-http-cdp.png` (CDP), `s1-stranger-nopin.png`, `s1-exit-prompt-final*.png`;
  - `run-20261112-174728/` gives the same results;
  - `run-20261112-174137/` ran while the Cube had gone to sleep, so it is used only for the "while hidden" notes.

## Probe results (final run, screen awake)

| Probe | Result |
|---|---|
| `navigator.userAgent` | `Mozilla/5.0 (Linux; Android 9; AFTGAZL Build/PS7717.5746N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.244 Mobile Safari/537.36 FireSongTV/0.1.0` |
| Chrome major | **138** (needs ≥ 111) |
| `isSecureContext` | **true**: on `http://localhost` (adb reverse), on `https://localhost` signed by the bundled CA, and on a pinned leaf |
| `typeof RTCPeerConnection` | **function**. A `createOffer` with a recvonly audio transceiver works, and the SDP has opus/48000. |
| AudioWorklet | `typeof AudioWorkletNode` = function. `audioWorklet.addModule()` **ok**. `process()` ran: 50 blocks of 128 frames at 48 kHz. |
| AudioContext (`latencyHint: 'interactive'`) | Running without a gesture. sampleRate 48000, `baseLatency` 0.0641 s, **`outputLatency` 0.320 s** after 0.5 s |
| AudioContext (`latencyHint: 0`) | `baseLatency` 0.0027 s, **`outputLatency` 0.256 s** |
| Muted mp4 autoplay | **plays** (`currentTime` +0.57 s in 0.7 s). The test clip is 2 s, 1280x720, H.264 + AAC, `+faststart`. |
| Unmuted mp4 `play()` without a gesture | **plays** (`mediaPlaybackRequiresUserGesture=false` works) |
| `Array.prototype.toSorted` | **function** |
| `CSS.supports('color','oklch(50% 0.1 120)')` | **true** |
| `RTCRtpReceiver.prototype.jitterBufferTarget` | **true**; setting 40 reads back 40. `playoutDelayHint` is also present. |
| `navigator.wakeLock` | **object**; `request('screen')` ok |
| WebRTC loopback (two peer connections on the Cube, 440 Hz) | ICE connected. Remote stream RMS in Web Audio: **0 without an `<audio>` element**, **0.706 with a muted `<audio>`** holding the stream. The same in all 7 page loads. |
| Viewport | **960x540 CSS px**, `devicePixelRatio` **4** while the screen is on (2 while asleep). `(min-width: 1280px)` is false. |
| Hardware | 8 cores, `deviceMemory` 2, JS heap limit 527 MB |
| `FSPROBE.info()` | `outputFramesPerBuffer` 480, `outputSampleRate` 48000, `FEATURE_AUDIO_LOW_LATENCY` **false**, `FEATURE_AUDIO_PRO` false. Memory: avail 627 MB of 1975 MB, threshold 222 MB, memoryClass 192 MB. |
| DevTools (CDP) | `Chrome/138.0.7204.244`. `[isSecureContext, typeof AudioWorkletNode, typeof RTCPeerConnection]` = **`[true, "function", "function"]`** (the WP6 acceptance triple) |

## App behaviour checked on the Cube

| Check | Result |
|---|---|
| Remote keys (`input keyevent`) | 19-22 → `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`; 23 → `Enter`; 85/126/127 → `" "`; 4 → `Escape`; 90/89 → `MediaFastForward`/`MediaRewind`; 82 → nothing. All are `isTrusted`, with `code` "". |
| Long-press Back (`--longpress 4`) | The native exit prompt opens, with **no** Escape sent. Back closes it. LEFT then Select on [Exit] leaves the app. |
| Renderer killed (CDP `Page.crash`) | `onRenderProcessGone` fired; the WebView was recreated and the page was ready again in **3-5 s** (WP6 asks for ≤ 10 s) |
| Network security config | https with the bundled test CA: **0 SSL errors**, page ready. **Honoured.** |
| Untrusted leaf, no pin | `onReceivedSslError` (`SSL_UNTRUSTED`) was cancelled. The overlay said "certificate is not trusted", with backoff. The leaf's SHA-256 and SPKI pin were logged. |
| Same leaf, pinned through `.Configure --es leaf_pin` | Proceeded; page ready |
| Server stopped while the page was loaded | Watchdog overlay after **12-13 s**; the page reloaded **5-6 s** after the server returned, with no input |
| Settings through `.Configure` | Applied once, logged without the token. Changing the URL to another origin dropped the token and pins. |

## Findings that matter elsewhere

1. **WP4 (voice engine): attach each remote stream to a muted `<audio>` element.** Without one, `createMediaStreamSource(remoteStream)` yields silence on this WebView. Keep the element alive for the life of the slot.
2. **S3 (latency budget):**
   - The WebView reports `outputLatency` 0.32 s (`interactive`) or 0.256 s (`latencyHint: 0`, with `baseLatency` 2.7 ms).
   - The device lacks `FEATURE_AUDIO_LOW_LATENCY`, and `audio_flinger` shows HAL buffers of 480 to 1536 frames.
   - If the reported figure is real, the Cube's output path alone uses most of the 150 ms p50 target. Measure it acoustically in S3 before tuning anything else. Prefer `latencyHint: 0` for the voice context.
3. **WP4/WP8 (TV profile): design for a 960x540 CSS viewport.** The page lays out at 960x540 CSS px. Overriding the activity density does not change it (tried at 240 dpi; reverted). The WebView reports dpr 4 with the HDMI mode at 3840x2160, so it rasterises at 4K. That costs GPU memory: app PSS was 178-217 MiB, of which Graphics was 128-139 MiB, after one probe page with two 720p clips. Keep layers and video sizes small (S5).
4. **Memory pressure is real.** During the first run:
   - the launcher, Alexa (`com.amazon.aria`) and the backgrounded Plex activity were killed by the low-memory killer (`proc died without state saved`);
   - FireSong received `onTrimMemory` RUNNING_MODERATE, LOW and CRITICAL.

   A party session will evict other apps. Plex restarts cold afterwards; no app data was touched.
5. **Screenshots:** `adb screencap` returns an all-black frame whenever the WebView is visible; native views capture normally. Use CDP `Page.captureScreenshot` (`probe/cdp.py shot`) for the page.
6. **Remote operation:**
   - Launching an activity does not wake a dreaming Cube. It fell asleep 1 s after launch, and the first keys only woke it. `tvctl wake` (`KEYCODE_WAKEUP`, only while idle) comes first.
   - Fire OS 7 prints `ResumedActivity:` and sometimes `mResumedActivity:`, so idle checks must match both.
7. **Audio focus:** about 3 s after each page load, FireSong's `AUDIOFOCUS_GAIN` request gets `LOSS_TRANSIENT_CAN_DUCK` (-3). That coincides with the page's own `<video>` playback taking focus inside the WebView. It is harmless for the probe; watch for ducking in S6.
8. **Not covered by S1:**
   - a real phone sending audio over the LAN (loopback only; that is S3/S7);
   - GeckoView, which was not needed;
   - the release build with the real Caddy root, which needs WP2's Caddy.
