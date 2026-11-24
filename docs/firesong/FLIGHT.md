# Party flight recorder

Every party leaves a record, so a white screen, a silent microphone or a hang can be explained
from evidence instead of memory.

## Where it goes

`<NIGHTINGALE_DATA_PATH>/firesong/sessions/`:

| File | Written by | What |
| --- | --- | --- |
| `YYYY-MM-DD.jsonl` (UTC date) | the server | one JSON object per line: `t` (Unix ms), `src` (`tv`, `server`, `host`), `ev`, fields |
| `cube-YYYY-MM-DD.log` | `party-door.sh` | the Fire TV's own log (`adb logcat`, info and up) while FireSong is on screen; needs `FIRESONG_CUBE_SERIAL` |

Files are removed 14 days after their last line. Nothing in them is a secret: no tokens, links,
lyrics or audio. Song identity is the file hash.

## What is recorded

| `src` | `ev` | When |
| --- | --- | --- |
| `server` | `start` | the server started |
| `server` | `stall` | the process (`kind: process`) or its async runtime (`kind: runtime`) ran `ms` late, 1 s or more |
| `server` | `rtc-open`, `rtc-close` | a TV or phone `/rtc` socket opened or closed, with `why` |
| `server` | `dropped` | the recorder fell behind the disk and dropped `lines` lines; written when it catches up |
| `host` | `sample` | every 10 s: load, available memory, swap pages in/out per second, server RSS |
| `tv` | `page-load`, `page-hide`, `visibility` | the TV page's life |
| `tv` | `error`, `rejection` | uncaught errors in the TV page |
| `tv` | `tv-socket` | the TV's `/rtc` socket state |
| `tv` | `slot-joined`, `slot-left` | a phone joined or left a slot |
| `tv` | `song-load`, `song-fetched`, `song-ready`, `song-error`, `song-play`, `song-pause`, `song-resume`, `song-unload` | the song player, with timings |
| `tv` | `voice-context`, `song-context` | an audio context changed state |
| `tv` | `mic-backend` | who plays the phones' voices: `kind` `web` (the page) or `native` (the TV app's voice engine, with `?voice=native`), and `why`. Once when the TV seat is first taken: `ready` for native; for web `not-requested`, `no-endpoint` (no voice engine in this app) or why the link to the app failed (`native mic link …`). Again on a fall back to web, with why the app's engine was lost: `closed <code>`, `error`, `fatal <reason>`, `silent` (nothing from the app for 5 s), `no-audio` (its output shut for 20 s), `stalled` (it stopped reading the page) or `dropped` (`fireSongDiag.dropNativeLink()`). `kind` `none` when the page's own voices could not be set up after the loss (`why` the error): the TV then gives up its seat for the rest of the page load |
| `tv` | `native-mics` | a problem on the link to the app's voice engine, each kind once per link: `why` `bad-message` (a message that fails the schema; `type` is its `t` or `null`), `bad-tap` (a malformed tap message), `too-large` (a page message over 64 KiB; `type` is its `t`) or `listener-error` (a page listener threw; `type` is `message`, `tap` or `lost`) |
| `tv` | `monitor-latency` | after a phone's "Tune my mic" on the native voices: the app's monitor beep for `slot`, `monitorMs` the singer's own loop (TV out, air, phone, network, jitter buffer), or `null` when it failed, with `reason`: the app's (`busy`, `no-audio`, `no-tone`, `stopped`) or the page's (`timeout`, no answer in 6 s; `lost`, the link to the app was lost; `closed`, the page closed it, as `dropNativeLink()` does; `unsent`, the request could not be sent) |
| `tv` | `song-peak` | `why: error`: the song's peak meter could not start; `error` says why |
| `tv` | `party-start`, `party-start-failed`, `party-notice` | the lobby conductor |
| `tv` | `sample` | every 10 s: heap, voice context state and output level, the song player, and `mics`: the TV seat, each slot's level, gate, monitor, mute and automatic boost (with `calBackend`, the backend its saved calibration was measured on, `assumed-web` when this TV has no record), and `backend` (below) |

`mics.backend` in a TV sample: `kind`, `why` and `songPeak`, the largest song sample since the
previous sample (after the song trim: under native the song plays 6 dB lower so the song and the
voices together stay under full scale). Under native it also holds the app engine's latest
statistics (the `engine-stats` message): output `open`, `outputLatencyMs`, `burstFrames`,
`bufferFrames`, `apm`; over about the last second `pushIntervalP50Us`, `pushIntervalP99Us`,
`pushIntervalMaxUs`, `callbackP99Us`, `callbackMaxUs`, `pushToPresentP50Ms`, `pushToPresentP95Ms`,
`tapDrainP99Us`, `tapDrainMaxUs`, `ratioMinPpm` and `ratioMaxPpm` (the ring's resampling ratio),
`longestConcealUs`, `callbackBusyPermille`, `callbackGapMaxUs` and `peak` (the voices' output
peak); the counters `xruns`, `restarts`, `openAttempts`, `tapDropped`, `conceals`, `resyncs`,
`concealedFrames`, `silentFrames`, `clampHits`, `outputStalls`, `pushGaps20` of `pushIntervals`,
`callbacksOver2ms`, `tapDrainsOver25ms` of `tapDrains` and `ignored`, which count up from the start
of the link, and `sinkErrors`, from the app's start; `slots`, with each slot's `underruns`,
`droppedFrames` and `lowWaterMs` and its ring `fillMs`, output `outRms` and last `monitorMs`; and
`tapArrival` (`p99Ms`, `maxMs`, `count`), the intervals between tap messages reaching the page
since the previous sample, while any slot is tapped. Records from an app before the resampling ring
carry `trims`, `jumps`, `inserts`, `insertedFrames` and per slot `trimmedFrames` and `marginMs`
instead. A newer app sends those keys too, for pages from before it: `trims`, `inserts` and
`insertedFrames` 0, `jumps` equal to `resyncs`, and `trimmedFrames` and `marginMs` equal to
`droppedFrames` and `lowWaterMs`.

The TV page posts its events to `POST /api/firesong/flight` on the TV door (host token) every
5 s; the server adds `t` (arrival) and `src`. TV events also carry `wall`, the TV's own clock when
the event happened, which the report uses for ordering.

## Reading it

```sh
scripts/firesong/flight-report.py --from 19:30 --to 23:00
```

prints the timeline and a summary: stalls, socket drops, page reloads and errors, song load
times, the TV page's heap, and each phone slot's voice level while singing versus in the lobby
next to the voice output level.
