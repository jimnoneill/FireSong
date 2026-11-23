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
| `host` | `sample` | every 10 s: load, available memory, swap pages in/out per second, server RSS |
| `tv` | `page-load`, `page-hide`, `visibility` | the TV page's life |
| `tv` | `error`, `rejection` | uncaught errors in the TV page |
| `tv` | `tv-socket` | the TV's `/rtc` socket state |
| `tv` | `slot-joined`, `slot-left` | a phone joined or left a slot |
| `tv` | `song-load`, `song-fetched`, `song-ready`, `song-error`, `song-play`, `song-pause`, `song-resume`, `song-unload` | the song player, with timings |
| `tv` | `voice-context`, `song-context` | an audio context changed state |
| `tv` | `native-voice` | in the TV app, the voices moved between the app's low-latency output (`route: native`) and the page's own (`speakers`), with `why` (`open`, `closed`, `stopped`, `stalled`, `unreachable`, `rate`, `error`) |
| `tv` | `party-start`, `party-start-failed`, `party-notice` | the lobby conductor |
| `tv` | `sample` | every 10 s: heap, voice context state and output level, the song player, each slot's level, gate, monitor, mute and automatic boost, and in the TV app `nativeVoice` (route, ring fill and margin, output latency, underruns, played peak over the last second) |

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
