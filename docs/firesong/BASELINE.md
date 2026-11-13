# FireSong baseline (upstream Nightingale `ab1e8d7`, before any FireSong change)

These are the check results on the server machine at upstream HEAD `ab1e8d7` ("chore: bump to 1.4.1"), measured on 2026-11-12 in `~/wt-firesong-base` before any FireSong commit. Use them to tell problems that already existed from new ones.

Environment: `source scripts/firesong/devenv.sh` gives node v24.19.0, pnpm 11.2.2 (via corepack), rustc/cargo 1.94.1 (pinned by `rust-toolchain.toml`), tsc 5.8.3, oxlint 1.79.0, and `CARGO_TARGET_DIR=/mnt/fast/firesong/target-<key>`. Logs are in `/mnt/fast/firesong/logs/base-*.log`.

## Results

| # | Command (from the repo root unless noted) | Result | Time |
|---|---|---|---|
| 1 | `cd client && pnpm install --frozen-lockfile` | **pass** (postinstall runs `rulesync generate`; with `HUSKY=0`, the `prepare` step prints "HUSKY=0 skip install") | 25 s |
| 2 | `cd client && pnpm typecheck` | **pass** | 9 s |
| 3 | `cd client && pnpm lint` (oxlint + stylelint) | **pass**, 0 findings | 7 s |
| 4 | `cd client && pnpm format:check` (oxfmt) | **pass**, 327 files | 3 s |
| 5 | `cd client && pnpm rules:check` | **pass** | 3 s |
| 6 | `cd client && pnpm build` (`tsc && vite build`) | **pass**. Vite warns about a chunk over 500 kB; that is upstream and not an error. | 10 s |
| 7 | client unit tests | **none exist**. `client/package.json` has no test script, and upstream rules forbid automated TS tests. | — |
| 8 | `cargo test --workspace --locked` | **FAIL (pre-existing, environment)**: build scripts of `gdk-sys`, `gdk-pixbuf-sys`, `cairo-sys-rs`, `pango-sys` and `atk-sys` fail because GTK/WebKit dev packages are missing. Exit 101. | 27 s |
| 9 | `cargo test --workspace --exclude Nightingale --locked` | **pass**: app-core 49 passed (all are ts-rs `export_bindings_*`), app-api 0, server 0, xtask 0, doc-tests 0. Exit 0. | 34 s |
| 10 | `cargo fmt --all --check` | **pass** | 1 s |
| 11 | `cargo clippy --workspace --exclude Nightingale --all-targets --all-features --locked -- -D warnings` | **pass** | 26 s |
| 12 | `cd client && pnpm quality` (format, lint, typecheck, then `cargo check --workspace …`, clippy, rules) | **FAIL (pre-existing, environment)**: the web half passes; `quality:rust` fails in `cargo check --workspace` on the same GTK crates as row 8. Exit 101. | 31 s |

## Pre-existing failures and quirks

1. **The Tauri desktop crate (`client/src-tauri`, package `Nightingale`) cannot build on the server machine.**
   - It needs `gtk+-3.0`, `webkit2gtk-4.1`, `javascriptcoregtk-4.1`, `libsoup-3.0`, `cairo`, `pango`, `gdk-pixbuf-2.0` and `atk` `-dev` packages. `pkg-config` finds none of them; only `glib-2.0` 2.80, `openssl` 3.0.13 and `alsa` 1.2.11 are present.
   - Installing them needs sudo, which agents do not have.
   - FireSong runs only the self-hosted server, so **every Rust check excludes it: `--exclude Nightingale`**. A failure in that crate is never caused by a FireSong change.
   - `pnpm quality` will keep failing at `quality:rust` for this reason. Run its parts instead: `pnpm quality:web`, rows 10-11 above, and `pnpm rules:check`.
2. **`cargo test` dirties `client/src/types/`.**
   - ts-rs regenerates the 46 committed upstream files in its own unformatted style (double quotes, one line). oxfmt ignores `src/types/**`, so `pnpm format` does not undo it.
   - After every `cargo test`, restore them with `git checkout -- $(git diff --name-only -- client/src/types | grep -v /firesong/)`, or plain `git checkout -- client/src/types` when you have not changed exported Rust types.
   - FireSong's own generated files, `client/src/types/firesong/*.ts`, are committed in ts-rs style and regenerate identically.
3. **Husky.** The client's `prepare` script runs `husky client/.husky`. That would repoint git's hooks directory and bypass the server machine's commit-msg and pre-push guards. `devenv.sh` exports `HUSKY=0`, so install skips it. Do not run `pnpm install` without sourcing `devenv.sh`.
4. **Generated agent files.** `pnpm install` (postinstall `rules:generate`) writes `AGENTS.md`, `CLAUDE.md`, `.claude/` and other agent files into the worktree root. All of them are git-ignored; never commit them.
5. **Node on PATH.** Without `devenv.sh`, `node` is `~/.local/bin/node` v22.23.1. That meets `>=22.12`, but corepack/pnpm live in `~/.node24/bin`. `devenv.sh` puts node 24 first.

## After the FireSong foundation commit (`fs/base`)

These are the same checks after `app-core/src/remote_mic.rs`, the generated `client/src/types/firesong/*` and `client/src/features/remote-mic/protocol.ts` were added:

| Command | Result |
|---|---|
| `cargo test --workspace --exclude Nightingale --locked` | **pass**: app-core 77 passed (49 upstream bindings, 16 new bindings, 12 new `remote_mic` tests) |
| `cargo test -p app-core --locked remote_mic` | **pass**: 28 (12 tests + 16 bindings) |
| `cargo fmt --all --check` | **pass** |
| `cargo clippy -p app-core -p server --all-targets --all-features --locked -- -D warnings` | **pass** |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm rules:check` (in `client/`) | **pass** |
| `ProtocolSchemasMatchRust` mutation check (7 deliberate schema/type drifts, each typechecked and reverted) | **7/7 caught** by `tsc` |

No new failures.

## After the server work packages (`fs/server`: WP2, WP3, WP1b)

| Command | Result |
|---|---|
| `cargo test --workspace --exclude Nightingale --locked` | **pass**: app-api 4 (new `redact` tests), app-core 78 (77 before + 1 analyzer idle-exit test), server 15 (new `tests/firesong.rs`), xtask 0 |
| `cargo test -p server --locked --test firesong`, 6 runs in a row | **pass** each time, 0.7-1.3 s |
| `cargo fmt --all --check` | **pass** |
| `cargo clippy --workspace --exclude Nightingale --all-targets --all-features --locked -- -D warnings` | **pass** |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm rules:check` (in `client/`) | **pass** (no client source changes) |
| `cargo test --workspace --locked` (Tauri crate included) | **FAIL, pre-existing**: the same GTK `-sys` build scripts as row 8. The Tauri crate's calls into `server` and `app-api` (`remote_router`, `AppState::new`, `RemoteAddress::new`, `dispatch`) keep their signatures. |

Mutation check of the new server tests: removing the host-token layer, disabling the `save_config` secret restore, skipping the `resumeKey` check, and stamping offers with the wrong slot each made at least one test fail.

## After integration (`fs/integration`: all work packages merged)

Measured on the server machine on 2026-11-12/13 at the integration head, after merging `fs/server`, `fs/deploy`, `fs/tv-voice`, `fs/phone-page`, `fs/firetv-apk` and `fs/noraebang` and wiring their seams. Logs are in `/mnt/fast/firesong/logs/int-*`.

| Command | Result |
|---|---|
| in `client/`: `pnpm typecheck`, `lint`, `format:check`, `rules:check`, `build` | **pass** (the Vite chunk-size warning is upstream) |
| `cargo test --workspace --exclude Nightingale --locked` | **pass**: app-api 4, app-core 90 (77 base + 1 idle exit + 12 noraebang clips), server 16 (`tests/firesong.rs`, one new: a phone hello on the TV door), xtask 0 |
| `cargo fmt --all --check`; `cargo clippy --workspace --exclude Nightingale --all-targets --all-features --locked -- -D warnings` | **pass** |
| `cargo test --workspace --locked` | **FAIL, pre-existing** (row 8, GTK `-sys` crates) |
| `cd tools/firesong-tests && pnpm test` | **pass**: 80 (74 from WP4 + 6 integration: noraebang seams, echo mix, diagnostics flag) |
| `cd tools/firesong-tests && pnpm harness` | **pass**: 3/3 |
| `cd tools/webtest && pnpm test`, `typecheck`, `lint`, `format:check` | **pass**: 47 |
| `scripts/firesong/test-client.sh` | **pass**: 48 |
| `scripts/firesong/e2e-phone-mic.sh` | **pass**: 21/21 |
| `scripts/firesong/e2e-integration.sh` (real server, TV and two phones, 440 vs 330 Hz) | **pass**: 15/15 checks, 5 passing runs. Display scores 100 vs 80, raw 995-999 vs 168-169 |
| `party-prep.py self-test`; `test_fetch_clips.py`; `cube.sh self-test`; `server-install.sh self-test`; shellcheck | **pass**: 53; 14; 21; 13; clean |
| `cd android/firesong-tv && ./gradlew assembleDebug testDebugUnitTest testReleaseUnitTest lintDebug` | **pass**: 30 + 30, lint clean |

Quirk found during integration: the server's integration tests open `/m` from the embedded `client/dist`, so run `pnpm build` in `client/` before `cargo test` in a fresh worktree; otherwise `phone_listener_keeps_the_pairing_token_and_command_allowlist` gets 404.
