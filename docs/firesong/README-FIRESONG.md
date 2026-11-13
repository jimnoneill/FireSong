# FireSong

FireSong is a Korean noraebang-style karaoke setup for an Amazon Fire TV Cube. It is a GPL-3.0 fork of [Nightingale](https://github.com/rzru/nightingale), whose `master` tracks upstream.

**What Nightingale already does,** and FireSong reuses unchanged:
- reads songs from a Plex library;
- splits stems and makes word-timed lyrics;
- scores pitch for up to four players;
- serves a React client from a self-hosted Axum server.

**What FireSong adds:**

- **Phones as wireless mics.** Guests scan a per-slot QR code. Their phone opens a page and sends its voice peer-to-peer over the home Wi-Fi (WebRTC Opus) to the TV. Up to 4 slots, each with a fixed colour.
- **A TV voice engine.** On the Cube, a long-lived MicRack owns the phone streams: gate, compressor, a latency-locked noraebang echo, reverb and a limiter, out to the TV speakers. It also feeds each slot into Nightingale's existing pitch and scoring pipeline as an ordinary microphone (`remote:<micId>`).
- **A Fire TV app.** A thin Kotlin WebView host that loads the unchanged React client over LAN HTTPS. It pins the LAN CA, maps the remote's keys, and recovers from crashes and network loss.
- **Noraebang mode.** Random cheesy background clips (original or license-safe only), a two-line wipe lyric bar, the live score hidden during songs, and a 0-100 score reveal with a synthesised drum roll and fanfare and Korean tier captions. Nightingale's raw 0-1000 score is still what profiles store.
- **Deployment on the server machine.**
  - A bare-metal systemd user service with two loopback listeners: TV and phones.
  - Analysis pinned to one GPU, with a GPU-reservation guard.
  - A size-capped song cache on a mounted volume, with LRU eviction.
  - The phone page reaches guests over Tailscale Funnel, switched on only for parties.

Audio never goes through the server machine or the internet. Only page loads and signaling do.

## Where to read

| Document | What it covers |
|---|---|
| Design (owner's plan, not in the repo) | Architecture, latency budget, HTTPS strategy, spikes S0-S8 and work packages WP0-WP12 |
| [`PROTOCOL.md`](PROTOCOL.md) | The shared contract: listeners, auth, env vars, `/rtc` messages, slot registry, WebRTC rules, remote mics in the `MicrophoneAdapter` |
| [`BASELINE.md`](BASELINE.md) | Check results at upstream HEAD, and the failures that already existed (the Tauri crate cannot build on the server machine) |

## Working on FireSong (agents and humans on the server machine)

```sh
git -C ~/FireSong worktree add ~/wt-firesong-<key> -b fs/<key> <base-branch>
cd ~/wt-firesong-<key>
source scripts/firesong/devenv.sh          # node 24, pnpm (corepack), cargo, adb, HUSKY=0,
                                            # CARGO_TARGET_DIR=/mnt/fast/firesong/target-<key>
pnpm --dir client install --frozen-lockfile
```

Checks:
- `pnpm --dir client typecheck`, `lint`, `format:check` and `rules:check`;
- `cargo test --workspace --exclude Nightingale --locked`, then restore `client/src/types` (see `BASELINE.md`);
- `cargo clippy --workspace --exclude Nightingale --all-targets --all-features --locked -- -D warnings`.

Host-specific values (Cube address, Funnel origin, GPU UUID, tokens) go in git-ignored files: `scripts/firesong/devenv.local.sh`, `deploy/server/*.env`. Commit only the `*.example` files.

## Fork rules

- **Rebase-friendly.** FireSong code goes in new files. Upstream files get only thin hooks, such as one route line, one `AppState` field or one adapter wrapper. The allowed hooks are listed in design §9.
- **Upstreamable fixes stay separate.** Fixes that make sense for Nightingale too (secret redaction, WS reconnect, `context.resume()`, analyzer idle exit) go in their own commits, so they can be offered upstream.
- **Tests.** Upstream's agent rules (`.rulesync/rules`) say not to add automated tests. FireSong-only modules, such as `app-core/src/remote_mic.rs`, carry their own tests anyway, because parallel work packages depend on their contracts. Tests never go into upstream files. This is a fork-level choice and the owner can reverse it.
- **Content.** Every audio and visual asset must be original or license-safe: CC0, public domain, or the Pixabay/Pexels licenses. No imitation of any real karaoke brand's jingles, logos or trade dress. Background clips are never committed.

## Code map by work package

The work packages are those of design §9. "Key" is the worktree/branch key used by the build workflow.

| WP | Key | What | FireSong code (new unless marked *hook*) |
|---|---|---|---|
| — | `base` | Toolchain, baseline, shared contract | `scripts/firesong/devenv.sh`, `docs/firesong/*`, `app-core/src/remote_mic.rs` (+ *hook* `pub mod remote_mic;` in `app-core/src/lib.rs`), generated `client/src/types/firesong/*`, `client/src/features/remote-mic/protocol.ts` |
| WP0 | — | Cube access and facts | none (facts are in the owner's plan) |
| WP1 | `deploy` | Bare-metal service, env, GPU pin, song prep, cache guard and LRU, Caddy/Funnel config | `deploy/server/firesong.service`, `deploy/server/env.example`, `deploy/server/Caddyfile.firesong`, `deploy/server/funnel.sh`, `scripts/firesong_prep.py` |
| WP1b | `server` | Analyzer idle exit (`NIGHTINGALE_ANALYZER_IDLE_EXIT_SECS`) | `app-core/src/analyzer/idle.rs`; *hook* `app-core/src/analyzer.rs` (`mod idle;` + 2 calls) |
| WP2 | `server` | Phone listener (`NIGHTINGALE_REMOTE_BIND`), host token, secret redaction, pairing-token rotation | `client/src-server/src/host_auth.rs`, `client/src-server/src/firesong.rs`, `app-api/src/redact.rs`; *hooks* `main.rs`, `bootstrap.rs`, `app-api/src/lib.rs` (dispatch wrapper, one `CommandState` field), `remote.rs` (two `pub(crate)`), `app-core/src/remote_control.rs` (persist the first token) |
| WP3 | `server` | `/rtc` signaling, slot registry, mic links, `remote-mics.json` | `client/src-server/src/rtc.rs`, `rtc/hub.rs`, `rtc/mic_store.rs`, tests in `client/src-server/tests/firesong.rs`; *hooks* `lib.rs` (module and route lines, host-token layer), `state.rs` (one field, `RemoteAddress::separate`) |
| WP4 | `tv-voice` | TV socket, remote-mic adapter, MicRack, voice engine, test tools | `client/src/bridge/rtc-socket.ts`, `client/src/bridge/remote-mics.ts`, `client/src/audio/voice-engine.ts`, `client/src/audio/mic-rack.ts`, `tools/fakephone`, `tools/busrec`; *hooks* `microphone.ts`, `playback-mic-context.tsx`, `lib/pitch/constants.ts`, `use-pitch-scoring.ts`, `app.tsx` |
| WP5 | `phone-page` | Phone `/m` page | `client/src/features/phone-mic/*`; *hook* `app.tsx` (route) |
| WP6 | `firetv-apk` | Fire TV WebView app, `tvctl` | `firetv/`, `tools/tvctl`; *hook* `nav-input-context.tsx` (media keys) |
| WP7 | integration | Cube run of the WP4 harness | none new |
| WP8 | `noraebang` | Clip pool, lyric bar, score curve, reveal and fanfare, `song-result` | `app-core/src/noraebang_clips.rs`, `client/src/features/noraebang/*`, `scripts/noraebang-clips/`; *hooks* `backgrounds.rs`, `schemas.ts`, `theme.ts`, `use-pixabay-slots.ts`, `playback-inner.tsx`, `result.tsx`, `state.ts` |
| WP9, WP10 | later | Travel rig, home dress rehearsal | `deploy/server/travel-rig.sh`, `docs/party-runbook.md` |
| WP11, WP12 | gated by spikes | Phone-side pitch; native voice engine | see design §9 |
