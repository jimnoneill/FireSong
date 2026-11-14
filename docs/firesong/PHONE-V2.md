# FireSong phone app v2: design and work packages

This page is the design for the ten features the owner approved for the party-ready phone app. It says what each feature does on the phone and on the TV, how the data flows, its limits, failure states and acceptance checks, then splits the work into three packages that run in parallel worktrees.

The wire contract is [`PROTOCOL.md`](PROTOCOL.md) §13 (frames, types, authorisation, limits, queue model). The frozen types are in `app-core/src/remote_mic.rs` and `client/src/features/remote-mic/protocol.ts`. This page does not repeat field lists; it refers to §13.

## Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| How `/m` talks to the server | Party frames on the `/rtc` socket the phone already holds; only the song book uses HTTP (`firesong_song_book` on the phone door). No `/ws`. | On `/rtc` the server knows which phone is asking (stamped `slot`/`micId`), so it can enforce per-phone rules; the socket already has a handshake, rate limit and reconnect, and state is pushed. The song book is bulk, read-only and identity-free, and HTTP keeps it off the socket's frame budget (§13.1). |
| The phone door's command allowlist | In a FireSong deployment the phone door keeps only read commands plus the song book; `/` opens `/m` (§13.2). | The pairing token is in every guest's QR, so today any guest can clear the queue or skip a song through `/q`. |
| Who may control a song | Its singers (pause, resume, stop, key/tempo); the next singer may start now; anyone joined may reserve and play fun sounds. The TV remote can do everything (§13.7). | Simple and party-friendly: the person on stage owns their song, nobody else can end it, and the host keeps the TV remote for problems. |
| Queue singer field | Not added to the upstream `PlaybackQueueEntry`. FireSong keeps reservations beside the queue, keyed by entry id (§13.9). | The upstream type, `/q`, the TV sidebar and Tauri stay unchanged; the queue is in memory only, so there is no persisted format to migrate. |
| Songs that are not ready | They wait outside the upstream queue (shown in the party queue as "getting ready") and enter it at their place when analysed. | The TV only ever starts ready songs with the existing start path, so it skips past preparing ones by construction. |
| Key/tempo of the current song | Restarts the song from the beginning in the new key. | `shift_key`/`shift_tempo` render both stems offline with rubberband and the upstream player can neither swap stems mid-song nor start at a position. |
| Lyric line on the phone | The TV sends the current and next line over `/rtc` on each line change. | The TV owns the one playback clock (tempo variants, pause, seek, restart); the phone needs no transcript, no clock sync and no extra bundle. |
| Tonight's best | A server-side board fed by the TV's existing `song-result`, in memory, top 10, reset by the host, by pairing-token rotation and by restart; entries expire after 12 h (§13.12). | One source for the TV lobby and every phone; nothing new is persisted. |
| GPU safety | A GPU gate in the analyzer worker with the same rules as `firesong_prep.py`, plus per-phone and party-wide preparation limits. | On-demand preparation starts GPU work from a guest's tap. |

## Features

Notation for acceptance checks: **[S]** Rust tests (app-core unit tests in FireSong modules, `client/src-server/tests/`), **[T]** TV tests in `tools/firesong-tests` (`pnpm test` unit, `pnpm harness` headless Chrome), **[P]** phone tests (`scripts/firesong/test-client.sh` unit, `scripts/firesong/e2e-phone-mic.sh` headless Chrome against the mock relay), **[I]** integration end to end (`scripts/firesong/e2e-integration.sh`: real server, TV page and phones in headless Chrome), **[C]** the real Cube and real phones (Phase 8e).

### 1. One phone page

**Phone.** `/m` stays one page with no route changes, so the mic never moves to a background tab (iOS can mute one). After joining, a bottom tab bar switches in-page panels:

- **Sing**: link state, level meter, mute, leave; while this phone sings: the lyric card, pause/resume/stop and key/tempo; always: my echo and my volume, "Tune my mic".
- **Songs**: the song book (feature 2).
- **Queue**: up next with singer names and colours, and my reservations (edit, sing next, cancel or leave).
- **Party**: the fun buttons and tonight's best.

The mic session lives above the tabs; switching tabs never touches the peer connection or the socket. Before joining, the join card shows, and the Songs tab can already be browsed; its Reserve button asks the guest to join first. The page never opens a new tab or window.

**Data flow.** The song book goes through a small fetch helper in `features/phone-mic` (`POST /api/cmd/firesong_song_book`, same-origin cookie, result checked with `parseSongBookPage`). Everything else is §13 frames: a phone-side party store (a pure reducer over `party`, `ack`, `lyric`, `calibration`, `notice`, `night-rank`) feeds the panels. Requests carry a `reqId`; no `ack` within 5 s shows "That didn't reach the TV. Try again."

**Bundle.** The `/m` bundle may import only `features/phone-mic/**`, `features/remote-mic/protocol.ts`, `@/i18n`, `shared/player-colors`, `shared/firesong-score-pose`, `shared/components/ui/*`, `lib/utils` and `app/app.css`. It never imports `@/main`, `@/bridge/*`, other features or TanStack Query. Budget: the JS and CSS that `/m` loads stay at or under **800 KB uncompressed** (about 660 KB today: entry 76 KB, phone main 30 KB, shared chunk 400 KB, CSS 156 KB).

**Failure states.** Song book `401` (token rotated): "This link has expired. Scan the code on the TV again." Network error: an inline retry. Socket down: party controls disabled with "Reconnecting…", the existing reconnect runs.

**Acceptance.**
- [P] e2e: the bytes of JS and CSS loaded by `/m` (CDP network log) ≤ 800 KB; no request to `/ws`.
- [P] e2e: switching through all tabs while live sends no new `offer` (mock relay log) and keeps the link live.
- [P] e2e: before joining, a song book search works and Reserve asks to join.
- [I] a phone searches the real server's song book and reserves.

### 2. Song book: ready first, preparing on demand

**Phone.** A search box (250 ms debounce) over the whole library, in pages of 25 with infinite scroll. Ready songs come first; a divider marks the rest ("Takes about N min to get ready"). Each row shows title, artist, length and a state: ready, getting ready (~N min or N %), waiting, failed. Tapping a row opens the reserve sheet: key and tempo steppers (ready, `shiftable` songs only), "Sing next", "Duet with…" (the other joined phones by name and colour) and Reserve. For a song that is not ready the sheet says it joins the line when it is ready.

**TV.** The lobby's up-next list shows preparing items in their place with "getting ready… ~N min" (or the percentage). The TV only starts ready items, so a preparing item never holds up a ready one behind it. With nothing ready, the lobby shows what is getting ready and waits.

**Data flow.** Song book over HTTP (§13.11; the server queries the library twice, ready then the rest, and pages across both). `reserve` (§13.3) → the server checks limits, joins or queues the analysis (`app_core::enqueue`) → while any item prepares, the server reads the analysis queue and song rows every 2 s to update `prep`, follow a rekeyed hash, and insert ready items into the upstream queue at their place (§13.9) → `party` to everyone.

**GPU gate (WP-server, `app-core/src/analyzer/gpu_gate.rs`).** Before the analyzer worker starts any job, party or host, it applies the rules of `firesong_prep.py`'s `gpu_verdict`:
- the reservation file `<FIRESONG_GPU_RESERVATIONS_DIR, default ~/.config/gpu-reservations>/<gpu uuid>` is in force, or starts within the next 10 minutes (lines `from <ISO> until <ISO> by <holder>`; an empty file reserves until removed; an unreadable or unparsable file counts as reserved);
- or the pinned GPU (`FIRESONG_GPU_UUID`, else the first entry of `CUDA_VISIBLE_DEVICES`) has less than `FIRESONG_GPU_MIN_FREE_GB` (default 6) GiB free, not counting FireSong's own analyzer processes.

Then the job stays queued, the worker checks again every 30 s, and party items show `waiting-gpu`. Without `nvidia-smi` or a pinned GPU the gate is open (upstream behaviour). `nvidia-smi` runs on a blocking thread with a timeout and fixed arguments.

**Limits.** §13.10: 3 reservations and 2 preparing per phone, 6 preparing party-wide, request budget. Party preparations download Plex originals and write stems into the song cache; the cache cap is enforced by `party-prep.py evict` (deploy tooling), not by the server.

**Failure states.** Analysis fails: the item is dropped and its singers get `notice {prep-failed}` ("Couldn't get <title> ready"). The GPU stays reserved: `waiting-gpu` with no estimate, and the owner can cancel. Song gone from the library: `ack not-found`.

**Acceptance.**
- [S] party rules (app-core, injected analysis-state port, no analyzer): the limits, the order key and index-0 protection, ETA arithmetic, following a rekeyed hash, cancelling only analyses that a phone started and nobody else waits for.
- [S] GPU gate with a fake command runner and temp reservation files: active, starting within 10 min, past, empty file, unparsable, free memory below and above the threshold, own processes excluded, no `nvidia-smi`.
- [S] phone door: the song book returns ready songs first with `readyTotal`; its JSON has no `path` keys; `take: 51` gives `400`; `add_playback_queue_entry` and `request_playback_command` give `403`; `GET /` redirects to `/m`.
- [S] reserve a not-ready song with a fake analysis port: `prep` goes queued → analyzing → ready, the upstream queue gets the entry at the right index, the snapshot shows its `entryId`.
- [C] a phone reserves an unanalysed library song: the phone shows ~N min, the TV lobby shows it getting ready, and it plays after analysis. With a reservation file in force: `waiting-gpu`, and `nvidia-smi` shows no FireSong analyzer process.

### 3. Phone remote

**Phone.**
- **Sing tab, while this phone sings the current song:** Pause/Resume; Stop (confirm "End the song?"); key −/+ and tempo −/+ with the current values, applied with "Restart in this key?"; nothing for songs the phone does not sing.
- **In the lobby, when this phone sings the next song:** "Start now".
- **Queue tab, my reservations** (items whose `singers` contain my slot): key/tempo steppers for ready, `shiftable` items; the Sing next toggle; Cancel for the owner, Leave for a partner.
- **Always:** "My echo" slider 0-200 % and "My volume" 0-150 % (default 100 each).
- **Duet:** the reserve sheet's partner picker (feature 2). Partners are added without asking and get `notice {duet-added}`; a partner who does not want to sing taps Leave.

**TV.** `control`: pause/resume through the existing playback pause/resume; `stop` ends the song without a reveal or score and returns to the lobby; `start-now` starts the first ready item. `shift-current`: shows "Changing key…", renders through the existing `preparePlayback` path (`shift_key`/`shift_tempo`, then `shift-key-done`/`shift-tempo-done`), restarts the song from the start with the same singers; on failure `notify {shift-failed}` and plays on. `mix`: the slot's MicRack fader gain = `volumePct / 100` before the limiter; the slot's echo wet × `echoPct / 100`, still capped at the existing 0.6.

**Starting a song with its singers (TV).** An item with phone singers starts through the existing `request_queue_playback` path (`QueuePlaybackListener`), with players `{id: "slot-<n>", profile: null, microphoneId: "remote:<micId>", color: slotColor(n)}`, owner first. A one-singer item must score the owner's phone through the solo-mic seam (`features/remote-mic/solo-mic.ts`), never the lowest connected slot. An item with no phone singers starts as today.

**What key and tempo cost.** `shift_key`/`shift_tempo` (`app-core/src/playback.rs`) render both stems for the whole song with ffmpeg rubberband (CPU, seconds to tens of seconds), keep the variant pair in the song cache, and store the song's `override_key`/`tempo`/`key_offset` in the library database. The TV applies them only when a song starts (`preparePlayback`). So: queued items keep key/tempo on their upstream entry (WP-server changes it on `edit`), and a change to the current song restarts it.

**Failure states.** Refusals come back as `ack` codes: `not-allowed` (not your song), `busy` (the stage moved on), `no-tv`, `unavailable` (no detected key, USDX), `rate-limited`. The phone hides controls it cannot use and still handles these.

**Acceptance.**
- [S] authorisation matrix: every action × {singer, non-singer, owner, partner, other phone} either reaches the TV or gets `ack not-allowed`, and nothing refused reaches the TV.
- [S] `edit` of a ready item changes the upstream entry's `tempo`/`keyOffset` (`load_playback_queue`); one sing-next per phone; a partner's `cancel` only removes the partner.
- [T] the TV's `control`, `shift-current` and `mix` handlers drive fake playback and MicRack seams with the expected calls and gains.
- [I] phone A, the singer, pauses (TV playback status paused) and resumes; phone B, not a singer, gets `not-allowed` and the song plays on; A stops: the TV is in the lobby and no `song-result` is sent.
- [I] B reserves with `partners: [A]`: the TV starts it with both phones as players and both phones get `song-result`.

### 4. Fun buttons

**Phone.** Four large buttons in the Party tab: applause, tambourine, cheer, air horn. Each shows the same budget as the server (3, then one per 2 s) as a cooldown, vibrates where `navigator.vibrate` exists, and is disabled while `tvConnected` is false.

**TV.** Each sound is synthesised in WebAudio on the voice-engine context (`getVoiceEngine()`), with no sample files and nothing to license, and is original (no imitation of a brand's jingle):
- applause: many short band-passed noise bursts (random centre 2-6 kHz, about 20 per second, 2.5 s envelope);
- tambourine: 8-12 shakes of high-passed noise jingles with a few inharmonic partials;
- cheer: band-limited noise with slow vowel-like formant sweeps, swelling over about 2 s;
- air horn: three detuned sawtooths in a chord through soft clipping, 1.2 s, in short stabs.

They mix into the engine output before the master limiter, 8 dB under the voice bus, never into the pitch taps; at most 4 play at once and extra ones are dropped. A short flash in the slot's colour on the lobby or playback HUD shows who sent it (static under reduced motion).

**Acceptance.**
- [S] five quick `fx` from one phone: the TV gets 3; one more after 2 s.
- [T] harness: each sound rendered through the engine output has the specified length, a peak ≤ −1 dBFS after the limiter, RMS above −40 dBFS and no NaN; six at once play only four.
- [I] a phone's `fx` reaches the TV (a played-fx counter in `fireSongDiag`).

### 5. Tune my mic

**Phone.** "Tune my mic" in the Sing tab, enabled only in the lobby: "Hold your phone near the TV and keep quiet for 3 seconds", progress, then "Tuned: 212 ms" or the reason (`busy` "A song is on", `no-audio` "The TV can't hear your phone yet", `no-tone` "Couldn't hear the beep, try closer to the TV", `timeout`, `no-tv`).

**TV.** On `calibrate {slot}` the TV runs the existing beep measurement (`features/microphone/lib/latency-test.ts`) for that slot on the voice-engine context, not a new `AudioContext` (the TV has no user gesture to unlock one), and shows "Tuning <name>'s mic…" so the room goes quiet. It reports `calibration` frames and, on success, the v1 `latency {method: beep}`, which stores it per `micId` and updates the roster, the scoring offset and the echo delay as today.

**Acceptance.**
- [S] relay, `busy` during a song and while another calibration runs, the 30 s cooldown, and `failed {timeout}` when the TV stays silent for 15 s.
- [T] harness: a fake phone (`tools/fakephone`) that loops the TV output back with a known delay → `done` with `latencyMs` within ±20 ms of it; a silent phone → `no-tone`.
- [I] a phone's calibrate in the lobby gives `started`, then `failed {no-tone}` (headless phones cannot hear the TV), so the wiring is proven end to end.
- [C] a real phone next to the Cube gets `done` and the roster shows its latency.

### 6. Singer extras

**Lyric line.** While this phone sings, the Sing tab shows a lyric card: the current line large, with a colour wipe driven by `elapsedMs`/`lineMs` (frozen while `paused`), and the next line dimmed; nothing between lines. The TV sends `lyric` from its noraebang lyric layout on every line change, pause, resume and seek, never per animation frame. The wipe is cosmetic (the network adds 50-150 ms); the TV stays the reference.

**Tonight's best.** The Party tab lists the board (§13.12): score, tier caption, name in its slot colour, song. The TV lobby shows the top 5.

**Score card.** On `song-result` the phone shows a full-screen card made for screenshots: the mascot pose for the score, the big score, the Korean tier caption with its English line, title and artist, the singer's name in the slot colour, "#2 tonight" from `night-rank`, the date and the FireSong wordmark. It fits a 9:16 screen at 390×844 with the close button below the card. It never shows the join link, a QR code or the token.

**Acceptance.**
- [S] the board's order, its cap of 10, expiry with an injected clock, reset on `reset-scores` and on rotation, `night-rank` values, names taken when the score was made.
- [S] `lyric` reaches only the phones in `stage.singers`, and nobody when there are none.
- [T] the lyric sender emits on line changes, pause, resume and seek only: at most 2 frames per second over a synthetic transcript.
- [P] the lyric card's wipe follows the frames and hides in the lobby; a screenshot of the score card at 390×844 is saved, and the card's DOM contains no `t=`, `/m?` or token.
- [I] after the 440/330 Hz duet both phones get `night-rank`, and the snapshot's `scores` has both, best first.

### 7. TV party lobby

**TV.** In the TV noraebang profile, whenever no song is playing (and not in settings), the TV shows a full-screen lobby:
- the four slot QR codes from `GET /api/firesong/mic-links`, each in its colour, with "Slot N", the name once joined, and joined / reconnecting / free;
- up next: the first five items with singer names in their colours and preparation state;
- the countdown for the next song ("Jim, you're up in 12 s");
- tonight's best (top 5);
- "Scan a code to join, then pick a song on your phone" when the queue is empty.

D-pad: OK starts now, Back opens the library (the host can still pick songs on the TV). After a score reveal the TV comes back to the lobby by itself.

**Conductor (TV).** It starts a countdown of 15 s (`LOBBY_COUNTDOWN_SECS`) for the first ready item when that item has no phone singers or its owner is connected. If the owner is reconnecting, it waits 30 s (`ABSENT_SINGER_GRACE_SECS`), then moves the item behind the next ready item once (upstream `move_playback_queue_entry`) and sends `notify {passed-over}`. It sends `stage` on every change. A song that cannot start is removed from the queue and its owner gets `notify {start-failed}`.

**Acceptance.**
- [T] conductor with a fake clock and fixture snapshots: countdown, start with the right players, pass-over exactly once, waiting while items prepare.
- [T] harness: a screenshot of the lobby at 1920×1080 from a fixture snapshot, with four QR SVGs.
- [I] the lobby shows the phones' names and the queued item, and the countdown starts the song with no TV input.
- [C] on the Cube: readable from the couch; D-pad OK starts the song.

### 8. Can't-connect guidance

**Phone.** Signaling reaches the server over the internet (Funnel), but the voice needs the home Wi-Fi: there is no TURN server. The phone detects that the voice cannot reach the TV:
- **Hard signal:** after joining, two connection attempts in a row (the existing 8 s connect timeout, with an ICE restart in between) end without `connected`. The phone then shows "Can't reach the TV. Join the home Wi-Fi (the same one as the TV), then tap Try again."
- **Early hint:** while still trying, if `navigator.connection.type` is `cellular` (Android Chrome) or none of the phone's own host candidates in its local SDP is a private IPv4 address (10/8, 172.16/12, 192.168/16) or an IPv6 ULA (fc00::/7), the phone adds "Mobile data can't carry your voice to the TV." With mic permission granted, browsers put real host addresses in candidates instead of mDNS names; mDNS-only candidates count as "unknown" and give no hint.

The phone retries on the button, on `online`, and on `navigator.connection` `change`. Everything else on the page keeps working over the socket: on mobile data a guest can still browse, reserve and use the remote. `diag` reports `unreachable` and candidate counts by type and whether a private address was seen, never the addresses. iOS Safari has no Network Information API, so it uses the hard signal and the candidate check; Android Chrome uses all three. No wire change.

**Acceptance.**
- [P] unit: the candidate classifier over fixture SDPs (private host → fine; only CGNAT 100.64/10 or public host → mobile-like; mDNS only → unknown), and the state machine reaching `unreachable` after two timeouts with fake timers.
- [P] e2e: a phone Chrome started with `--webrtc-ip-handling-policy=disable_non_proxied_udp` (Chrome 156 ignores the `--force-` spelling) (no UDP, so ICE cannot connect) shows the guidance within 25 s; a normal phone never shows it.
- [C] a real Android phone (Chrome) and an iPhone (Safari) on mobile data show the guidance; after joining the Wi-Fi, Try again goes live.

### 9. Automatic lyric-timing repair

**Analyzer (WP-server, `app-core/src/analyzer/timing_repair.rs`, one call in `finalize_song`).** After an analysis whose lyrics came from LRCLIB, before the song is marked analysed:

1. A line is squeezed when its `end − start` is under 0.5 s. With at least 6 lines and at least 40 % of them squeezed, the alignment is squeezed. (Blur, "Song 2": 31 of 35.)
2. Then take LRCLIB's synced lyrics from the same pick as the plain lyrics (`lrclib_candidates`, first candidate). Use them only if they have at least 6 lines, strictly increasing starts, a first start ≥ 0, a last start before the song's end + 5 s, and a line count within ±25 % of the plain lyrics.
3. If they pass: rebuild the transcript through the existing LRC path (`build_lrc_transcript`, line timing, source `lrc`, base key and tempo, as `apply_timed_lyrics` does) and record `"timing_repair": {"method": "lrclib-lines", "reason": "squeezed-alignment", "squeezed": 31, "lines": 35}` in the transcript JSON. The song's `transcript_source` becomes `lrc`, so the library shows it as LRC. Log one info line with the hash and the counts, never lyric text.
4. If they do not pass: keep the aligned transcript and log a warning.

This runs for every full analysis, party or host, not for realign or manual lyric edits. Readers that do not know `timing_repair` ignore it.

**Acceptance.**
- [S] fixtures: a squeezed transcript with a matching LRC is repaired (line starts equal the LRC, the record is present, source `lrc`); a healthy transcript is unchanged; a bad LRC (out of order, too few lines, wrong count) leaves it unchanged.
- [C] a full re-analysis of "Song 2" gives `timing_repair` and a first line near 14.5 s; "The Final Countdown" (healthy) keeps its word timing.

### 10. Noraebang library opens on ready songs

**TV.** In the TV noraebang profile (`?tv=1` and noraebang mode), the library opens with the existing "Analysed" filter (`query: 'analysed'`). The host can pick all songs as before. Classic mode and other browsers are unchanged. This is a thin hook where the library filter atom gets its first value.

**Acceptance.**
- [T] or [I]: the TV page with `?tv=1&mode=noraebang` lists only analysed songs on first open; with `?mode=classic` it lists all.

## Work packages

Each package runs in its own worktree (see `README-FIRESONG.md`, "Working on FireSong"), branched from the contract commit on `master`:

| WP | Worktree, branch, devenv key | Scope |
|---|---|---|
| **WP-server** | `~/wt-firesong-server2`, `fs/server2`, `server2` | Party channel in the hub (decoding, authorisation, relays, budgets, snapshots), reservations and queue placement, preparation on demand with the GPU gate and rekey following, the night board, the song book command, the phone-door allowlist and `/` redirect, lyric-timing repair |
| **WP-tv** | `~/wt-firesong-tv2`, `fs/tv2`, `tv2` | TV party client (parse, send `stage`/`lyric`/`calibration`/`notify`/`reset-scores`), party lobby and conductor, starting items with their singers, fun-sound synth, per-slot mix, phone-started calibration, lyric-line sender, library default filter |
| **WP-phone** | `~/wt-firesong-phone2`, `fs/phone2`, `phone2` | The one-page `/m`: tabs, party store, song book, reservations, remote, mix, fun buttons, tune my mic, lyric card, score card, tonight's best, can't-connect guidance; bundle budget |

### File ownership

Every file has one owner. "Hook" means a thin hook in an upstream file (one field, one arm, one call, a visibility change), as the fork rules require; anything larger goes in a new FireSong file.

| Owner | Files |
|---|---|
| **Contract** (frozen; changed only by the integrator, see below) | `app-core/src/remote_mic.rs`, `client/src/types/firesong/**` (generated), `client/src/features/remote-mic/protocol.ts`, `docs/firesong/PROTOCOL.md`, `docs/firesong/PHONE-V2.md` |
| **WP-server** | New: `app-core/src/party.rs` (domain rules: limits, order key, ETA, board; pure, with tests), `app-core/src/analyzer/{gpu_gate,rekeys,timing_repair}.rs`, `app-api/src/firesong.rs` (party state on `CommandState`, song book command), `client/src-server/src/rtc/party.rs`, `client/src-server/tests/firesong_party.rs`.<br>Hooks: `app-core/src/lib.rs`, `app-core/src/analyzer.rs`, `app-core/src/lyrics.rs` (visibility of `build_lrc_transcript`/`write_transcript_json` if needed), `app-core/src/playback_queue.rs` (at most one method, to change an entry's key/tempo), `app-api/src/lib.rs`, `client/src-server/src/{lib,state,commands,remote}.rs`.<br>FireSong files it changes: `client/src-server/src/{rtc,firesong}.rs`, `client/src-server/src/rtc/{hub,mic_store}.rs`, `client/src-server/tests/firesong.rs` (the phone-door allowlist test), `deploy/server/firesong.env.example` and `docs/firesong/DEPLOY.md` (GPU gate variables) |
| **WP-tv** | New: `client/src/features/party-lobby/**`, `client/src/audio/fx-synth.ts` (and other new files under `client/src/audio/`).<br>FireSong files it changes: `client/src/bridge/{remote-mics,rtc-socket,remote-mic-peer,microphone.phone,firesong-launch}.ts`, `client/src/audio/**`, `client/src/features/remote-mic/**` except `protocol.ts`, `client/src/features/noraebang/**`, `tools/firesong-tests/{unit,harness}/**` and its `package.json`, `tools/fakephone/**`.<br>Hooks: `client/src/app/app.tsx` (mount the lobby), the library filter's first value (`client/src/features/menu/hooks/use-library-filter.ts` or the library page), and thin hooks in upstream playback or queue files if a seam is missing (list them in the merge report) |
| **WP-phone** | `client/src/features/phone-mic/**` (including `tests/`), `client/src/entry.ts`, `tools/phone-mic-e2e/**`, `scripts/firesong/{e2e-phone-mic.sh,test-client.sh}`, `scripts/firesong/node-test/**` |
| **Integration** (after the three merge) | `CHANGELOG.md`, `docs/firesong/README-FIRESONG.md` (code map), `docs/firesong/BASELINE.md` (new results), `tools/firesong-tests/e2e/**`, `scripts/firesong/e2e-integration.sh` |

**The one shared file set: the i18n catalogs** `client/src/i18n/translations/{en,de,zh-cn}.json`. Every key must exist in all three, so both client packages must add keys. They split them by prefix and position, so git merges them without conflict:
- WP-phone adds only `phoneMic.*` keys, inside the existing `phoneMic.` block;
- WP-tv adds only `firesong.party.*` and `firesong.fx.*` keys, after the last line of the file;
- nobody renames or removes existing keys; each key gets a real German and Simplified Chinese text, as the existing FireSong keys have.

**CHANGELOG.** Packages do not edit `CHANGELOG.md`. Each merge report proposes its user-facing lines; the integrator adds them.

**Contract changes.** A package that needs a contract change stops and reports it with the reason. The integrator changes the contract on `master` (PROTOCOL.md §11 steps, `cargo test -p app-core --locked remote_mic`, restore upstream generated files) and the packages rebase. Packages never edit contract files themselves.

**Generated types.** `cargo test` rewrites the upstream files under `client/src/types/` in ts-rs style. Restore them before committing (`BASELINE.md`, quirk 2); commit nothing under `client/src/types/`.

### Testing against each other before integration

Each package tests against fakes of the other two, built from §13 and its JSON example, so nobody waits:

- **WP-server** drives the real hub with fake clients: `tokio-tungstenite` phones and a fake TV that send and expect §13 frames (`client/src-server/tests/firesong_party.rs`, same helpers as `tests/firesong.rs`). Party rules, the board, the GPU gate and the timing repair are app-core unit tests in their FireSong modules, with injected clock, analysis state and command runner. No analyzer, GPU or Plex.
- **WP-tv** feeds `RemoteMics` a fake `TvSocketPort` that delivers `party`, `control`, `shift-current`, `fx`, `mix` and `calibrate`, and records what the TV sends. Playback, MicRack and the conductor's clock are fakes in the vitest unit tests; the harness renders the fx synth and the lobby in headless Chrome, and runs calibration against `tools/fakephone`.
- **WP-phone** extends `tools/phone-mic-e2e/mock-relay.mjs` into a fake party server: canned `party` snapshots, `ack` by the §13.7 rules, scripted `lyric`, `calibration`, `notice` and `night-rank` frames, and a fake `/api/cmd/firesong_song_book` with fixture pages. Reducer and classifier tests run in the node test runner.

Each package's checks before it reports done: in `client/`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm rules:check` and `pnpm build`; `cargo fmt --all --check`; `cargo clippy --workspace --exclude Nightingale --all-targets --all-features --locked -- -D warnings`; `cargo test --workspace --exclude Nightingale --locked` (build the client first, then restore `client/src/types`); plus its own suites above and the existing ones it touches (`e2e-phone-mic.sh` for WP-phone; `tools/firesong-tests` `pnpm test` and `pnpm harness` for WP-tv; `tests/firesong.rs` for WP-server).

### Integration order

1. **WP-server** merges first into `fs/integration2`. The server is the hub both clients talk to, and its tests already prove the wire with fake clients.
2. **WP-tv** merges next. Re-run `tools/firesong-tests` against the merged tree, then a manual TV page against the real server with one fake phone (`tools/fakephone`).
3. **WP-phone** merges last. Re-run `e2e-phone-mic.sh`, then the real server with the TV page and two phones.
4. The integrator extends `tools/firesong-tests/e2e` and runs `e2e-integration.sh` with the [I] checks above: song book, reserve with a partner, lobby countdown and start with players, singer-only remote, fun sound, lyric lines to singers only, score board and `night-rank`, phone-started calibration wiring, can't-connect guidance, phone-door `403`s and `/` → `/m`.
5. Phase 8e on the real box, Cube and phones: the [C] checks, a 4-singer load test, then release.

## Open points for the owner

These are reasonable defaults, but the owner should confirm them:

1. **`/q` becomes read-only for guests** in FireSong deployments, and `/` opens `/m`. Guests can no longer clear the queue or skip through `/q`; the host keeps the TV remote and the TV-door web UI.
2. **Only the singers control a song.** No vote-to-skip; a song with no phone singers has no phone remote.
3. **A key or tempo change mid-song restarts the song.** A seamless change would need upstream playback changes.
4. **Stop gives no score.** The reveal is skipped and nothing goes on the board.
5. **Tonight's best** shows guests' chosen names on the TV and every phone, lives in memory only, and resets on token rotation, restart, a host reset, or after 12 h.
6. **The GPU gate covers every analysis**, also the ones the host starts from the TV, not only party preparations.
7. **Guests may start Plex downloads and analysis** (3 reservations and 2 preparing per phone, 6 party-wide). This grows the song cache between `party-prep.py evict` runs; consider an evict timer after parties.
8. **Lyric repair replaces word timing with line timing** for songs whose alignment is squeezed (at least 40 % of lines under 0.5 s). Those songs lose the word-by-word wipe but get correct lines.
9. **Duets are opt-out:** a partner is added without asking and can leave.
10. **Lobby timing:** a 15 s countdown, and 30 s of grace for a reconnecting singer before their song moves back one place.
