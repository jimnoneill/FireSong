# FireSong on the server machine: deploy runbook

This runbook covers how FireSong is built, installed and run on the server machine, how songs are prepared before a party, and how the Fire TV Cube is operated from the server machine. It is work package WP1 of the design. [`PROTOCOL.md`](PROTOCOL.md) has the listener, auth and env-var contract this builds on.

Host-specific values (LAN addresses, the GPU UUID, the tailnet name, tokens) never appear in the repository. They live in one git-ignored file, `~/.config/firesong/firesong.env`, made from [`deploy/server/firesong.env.example`](../../deploy/server/firesong.env.example). Below, `<lan-ip>`, `<cube-ip>`, `<nfs-server>` and `<phone-origin>` stand for those values; `server-install.sh owner-steps` prints the owner's steps with them filled in.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| FireSong server (`firesong.service`, user unit) | the server machine, `127.0.0.1:64448` (TV door) and `127.0.0.1:64449` (phone door) | Bare metal, not Docker. Loopback only; the proxies below are the only ways in. |
| TV door (`firesong-caddy.service`, user unit) | the server machine, `https://<lan-ip>:64443` | Caddy with its own internal CA. Only the Cube, the server machine and loopback get through. |
| Phone door | Tailscale Funnel `<phone-origin>` (port 8443) to `127.0.0.1:64449` | Only during parties. The existing Funnel on `:443` is never touched. |
| Data dir (`NIGHTINGALE_DATA_PATH`) | `/mnt/fast/firesong/data` (local NVMe) | `config.json`, the SQLite library, profiles, tokens. Never on NFS. |
| Song cache | `/mnt/firesong-cache/songs` (NFS, 40 GB hard-capped volume) | Stems, transcripts and downloaded originals. Kept under 36 GB by LRU eviction. |
| Models, analyzer vendor tree, uv cache | `/mnt/staging1/firesong/{models,vendor,uv-cache}` | About 10-15 GB once the analyzer is set up. |
| Releases | `/mnt/fast/firesong/releases/<id>/`, `current` symlink | Built by `build-release.sh`. |
| Analyzer GPU | RTX 4090, pinned by UUID | Never the RTX PRO 6000 (see "GPU pinning"). |

## Files

| File | What it is |
|---|---|
| `deploy/server/firesong.env.example` | Every variable the server and the tooling read, with placeholders. |
| `deploy/server/firesong.service` | Server user unit template (`@RELEASE_ROOT@`). |
| `deploy/server/firesong-caddy.service` | Caddy user unit template (`@CADDY@`, `@RELEASE_ROOT@`). |
| `deploy/server/Caddyfile.tv` | TV door config. Reads everything host-specific from the env file. |
| `scripts/firesong/server-install.sh` | `env`, `unit`, `owner-steps`, `check`, `self-test`. |
| `scripts/firesong/build-release.sh` | Builds the client bundle and the server binary into a release. |
| `scripts/firesong/preflight.sh` | The unit's `ExecStartPre` guard; also runs by hand. |
| `scripts/firesong/party-prep.py` (+ `firesong_prep.py`) | Song prep: `prep`, `status`, `evict`, `gpu-check`, `configure`, `self-test`. |
| `scripts/firesong/cube.sh` | Fire TV Cube helper over adb. |

None of the scripts installs packages, enables a service or touches Tailscale.

## 1. Owner one-time steps

These need sudo, the Plex account or the Tailscale admin console, so the owner does them. `scripts/firesong/server-install.sh owner-steps` prints them with this host's values.

### 1.1 Song-cache NFS mount

The export is a 40 GB hard-capped volume on the NFS server. On the server machine:

```sh
sudo mkdir -p /mnt/firesong-cache
echo '<nfs-server>:/var/lib/firesong-cache /mnt/firesong-cache nfs rw,soft,intr,_netdev,nofail,bg 0 0' | sudo tee -a /etc/fstab
sudo mount /mnt/firesong-cache
sudo chown "$USER": /mnt/firesong-cache
findmnt /mnt/firesong-cache          # FSTYPE nfs4
```

Why these options: `soft` makes a dead NFS server return errors instead of hanging the server; `nofail,bg` let the server machine boot without it. Song prep and the server's preflight both refuse to run when the mount is missing, so songs never land on the empty mount point on the local disk.

### 1.2 Plex sign-in (PIN flow)

With the server running (section 2), open FireSong with the host token once, from a browser on the server machine itself or through an SSH tunnel to the server machine's loopback (other LAN machines are not on the Caddy allowlist):

```text
http://127.0.0.1:64448/?host=<contents of /mnt/fast/firesong/data/firesong/host-token>
```

Then **Connect Plex → Sign in with Plex**, approve the code at plex.tv/link, pick the server and the music library. The PIN flow makes FireSong a separate Plex device, which can be revoked on its own. Leave auto-analyze off: prep decides what to analyse.

### 1.3 Phone door on Tailscale Funnel (parties only)

```sh
tailscale funnel --bg --https=8443 http://127.0.0.1:64449     # on
tailscale funnel status                                       # the existing :443 entry must still be listed
tailscale funnel --https=8443 off                             # off, after the party
```

- Never run `tailscale funnel reset` or `tailscale serve reset`: they also drop the existing `:443` Funnel.
- Funnel maps only the phone listener. The TV listener is never published.
- Without `sudo`, these commands need the user to be the Tailscale operator (`sudo tailscale set --operator=$USER`, once).

### 1.4 Disable Tailscale key expiry

The server machine's node key expires on 2026-11-29 (21:16 UTC). Funnel and all remote access stop when it does. In the admin console, open **Machines → the server machine → ⋯ → Disable key expiry**.

## 2. First deploy (no sudo)

```sh
cd ~/FireSong                                   # or a worktree of the branch to deploy
scripts/firesong/server-install.sh env \
    --lan-ip <lan-ip> --cube-ip <cube-ip> \
    --nfs-server <nfs-server> --phone-origin <phone-origin>
#   -> ~/.config/firesong/firesong.env (mode 600); the 4090's UUID is read from nvidia-smi

scripts/firesong/build-release.sh --activate    # client bundle + server binary -> /mnt/fast/firesong/current
/mnt/fast/firesong/current/party-prep.py configure
#   -> config.json: cache_paths.songs=/mnt/firesong-cache/songs, models/vendor on staging1, auto_analyze=false
scripts/firesong/server-install.sh check          # preflight + systemd-analyze verify
scripts/firesong/server-install.sh unit           # -> ~/.config/systemd/user/firesong{,-caddy}.service
systemctl --user daemon-reload
systemctl --user start firesong                 # `enable` only if it should start at login
```

Check it:

```sh
ss -ltn | grep -E ':6444[89] '                  # both on 127.0.0.1 only
T=$(cat /mnt/fast/firesong/data/firesong/host-token)
curl -s -o /dev/null -w '%{http_code}\n' -H "x-firesong-host-token: $T" http://127.0.0.1:64448/api/bootstrap   # 200
journalctl --user -u firesong -n 50
```

(The host token exists once the WP2 server code is deployed. Before that, `/api/bootstrap` answers without it.)

**Analyzer setup.** On first use the UI offers to set up the analyzer: it downloads Python, PyTorch (cu126 wheels, chosen from the 4090) and the models, about 10-15 GB, into `/mnt/staging1/firesong/{vendor,models}`. That is a deliberate step for the owner or the operator. `party-prep.py` refuses to run until it is done and never starts it.

**Upgrades.** `build-release.sh --activate`, then `systemctl --user restart firesong`. The last 3 releases are kept; roll back by pointing `current` at an older one (`ln -sfn releases/<id> /mnt/fast/firesong/current`) and restarting.

### 2.1 The TV door (Caddy)

Caddy is not installed on the server machine. Either the owner installs the distro package (`sudo apt install caddy`; then stop and disable the system `caddy.service` it enables, because FireSong runs its own user instance), or the operator puts a static `caddy` binary at `/mnt/staging1/firesong/bin/caddy`. Then:

```sh
scripts/firesong/server-install.sh unit           # also writes firesong-caddy.service once caddy is found
systemctl --user daemon-reload && systemctl --user start firesong-caddy
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:64443/        # 401 without the host token (WP2)
```

- Caddy's root certificate is `/mnt/fast/firesong/caddy/pki/authorities/local/root.crt`. The Fire TV app pins it (`res/raw/firesong_lan_ca`). Keep that directory: a new CA means rebuilding the app.
- `Caddyfile.tv` has no access log on purpose: it would record `?host=` tokens and the token header.
- The allowlist (`remote_ip`) checks the TCP peer, so a forged `X-Forwarded-For` does not get through.

## 3. Song prep before a party

```sh
P=/mnt/fast/firesong/current/party-prep.py      # or scripts/firesong/party-prep.py
$P status                                        # mount, cache, GPU guard, server, queue
$P prep "Party Mix" --dry-run                    # what would be analysed and evicted
$P prep "Party Mix" "Ballads"                    # names (case-insensitive) or ids such as plex:12345
```

What `prep` does, in order:

1. **Mount guard.** It refuses (exit 2) unless `FIRESONG_SONG_CACHE` is an NFS mount that answers, and `config.json` puts `cache_paths.songs` inside it. The check reads `/proc/self/mountinfo` and never stats a dead mount.
2. **Server and analyzer.** It refuses (exit 5) if the server does not answer or the analyzer is not set up.
3. **Library.** It rescans the library (`--no-scan` skips that), waits until the playlist appears and the library stops changing, resolves each name to its id, and lists the songs that are not analysed yet.
4. **Batches.** It enqueues `--batch` songs at a time (default 3) and follows them until each is analysed or failed. A failed song is retried once (`--retries`). Songs are tracked by their Plex id, because the analyzer re-keys a Plex song's hash to its content hash once it has downloaded it.
5. **GPU guard** (below), checked every `--poll` seconds (default 5).
6. **Cache cap** (below), checked before every batch and once at the end.
7. **Release the GPU.** With `NIGHTINGALE_ANALYZER_IDLE_EXIT_SECS` above 0 (the env example sets 300), prep never restarts the server: it waits up to that long plus 30 s for the analyzer's idle exit and reports the result. Without it, prep restarts `firesong.service` once when the queue has drained and the idle analyzer still holds a CUDA context. Either way it never restarts while a song is playing or the play queue has songs, because the queue and every phone-mic slot live only in the server's memory; it logs a warning instead. `--keep-running` skips all of this.

Exit codes: 0 done; 1 some songs failed; 2 mount or config guard refused; 3 GPU busy with `--no-wait`; 4 the cache cap cannot be met; 5 server unreachable or analyzer not set up.

Go easy on the Plex server: it sits on a slow SMR pool. The analyzer downloads one original at a time anyway; `--pause-between SECONDS` adds a gap between batches.

### 3.1 GPU guard

The analyzer child inherits `CUDA_VISIBLE_DEVICES` (the 4090's UUID) and `CUDA_DEVICE_ORDER=PCI_BUS_ID` from the unit. Prep yields the GPU when either of these holds:

- **A reservation is in force.** The file `~/.config/gpu-reservations/<4090 uuid>` follows the server machine's convention: lines of the form `from <ISO time> until <ISO time> by <holder>`. Inside a window the GPU is reserved. A file with no usable window, for example one made with `touch`, reserves it until the file is removed. Prep also does not start a new batch within `--lookahead` minutes (default 10) of a window.
- **Free VRAM drops below `FIRESONG_GPU_MIN_FREE_GB`** (default 6 GiB). Memory held by FireSong's own analyzer counts as free, so the analyzer never trips its own guard.

When it yields, prep cancels the batch (`cancel_analysis`). Cancelling a song in flight kills the analyzer process, which frees its VRAM within seconds. If the analyzer was idle and still holds its CUDA context, prep restarts the service. It then waits until the GPU has been clear for `--resume-after` seconds (default 60) with 2 GiB of headroom, and re-enqueues. Finished stems and transcripts are kept, so cancelled work resumes where it stopped.

Check it by hand:

```sh
$P gpu-check                                    # "clear: …" (exit 0) or "busy: …" (exit 3)
touch ~/.config/gpu-reservations/<4090 uuid>    # only for a test, and only if no such file exists
$P gpu-check; rm ~/.config/gpu-reservations/<4090 uuid>
```

Never delete or edit another job's reservation file.

### 3.2 Cache cap and LRU eviction

- **Usage.** The cache counts as the larger of the volume's `statvfs` usage and the sum of the files under the mount. The cap is the smaller of `FIRESONG_SONG_CACHE_MAX_GB` (36 GB, decimal) and 90% of the volume.
- **Room before each batch.** Before each batch, prep needs room for the new songs. It estimates each song at the median size of the cached songs, or 60 MiB while the cache is empty; `--song-estimate-mb` overrides that.
- **What can be evicted.** Only finished songs (with a transcript) that are not in the playlists being prepped, not in the play queue, not queued for analysis and not sung (scored) in the last 3 hours. The least recently used go first.
- **Never while a song plays.** A song leaves the play queue when it starts, and the server does not say which song is on screen, so nothing is evicted while one is playing: prep waits up to 15 minutes for it to end, then stops with exit 4; `evict` refuses at once. Run it again between songs.
- **"Last used"** is the latest of three times: when prep last touched the song (`<data>/firesong/song-cache-lru.json`), when it was last scored (`profiles.json`), and when its files last changed.
- **How eviction works.** It goes through the server's `delete_song_cache`, so the library marks the song unanalysed. Prep then removes the downloaded original (`songs/sources/<hash>.*`), which the server keeps and Plex can serve again. Covers stay.
- **Partial songs** (stems with no transcript) are the analyzer's resume state and are never evicted.
- **When it cannot fit.** If the protected songs alone exceed the cap, prep stops with exit 4. Analyse fewer songs, or raise the cap if the volume allows.

`$P evict [--dry-run] [--target-gb N] [--keep-playlist NAME]` runs the same eviction on its own. It refuses while a song is playing and when the server is down, because deleting files behind the server's back would leave the library pointing at missing stems.

## 4. The Fire TV Cube from the server machine

`scripts/firesong/cube.sh` takes the Cube's address from `FIRESONG_CUBE_SERIAL` (env file) or `--serial <cube-ip>:5555`.

```sh
C=scripts/firesong/cube.sh
$C status                      # model, Fire OS, foreground app, idle?, FireSong version, WebView, memory, display, reverses
$C idle                        # exit 0 only when the launcher is in front
$C screencap shot.png
$C logcat FireSongJS           # grep pattern; or a logcat spec such as 'FireSongJS:V chromium:W *:S'; --follow streams
$C install firetv/app/build/outputs/apk/debug/app-debug.apk
$C launch --url 'https://<lan-ip>:64443/?tv=1&mode=noraebang' --host-token-file /mnt/fast/firesong/data/firesong/host-token
$C reverse 64448               # the Cube's http://localhost:64448 reaches the server machine (a secure context, no certificate)
$C unreverse                   # removes only the reverses cube.sh created
$C home
```

Rules it enforces, because the Cube is the family TV and its owner is away:

- `install` and `launch` refuse unless the foreground activity is the Fire TV launcher (`com.amazon.tv.launcher`). `--force` overrides only that check. The screensaver counts as idle: the launcher stays resumed underneath it.
- `install` accepts only an APK whose package is `org.firesong.tv` (checked with `aapt2`). Nothing else is installed, uninstalled, cleared or force-stopped.
- adb never runs when `~/.android/adbkey` is missing, because adb would generate a new key that the Cube has not approved. **Never delete or regenerate that key**: nobody at home can approve a new one.
- `unreverse` never uses `--remove-all`; other sessions may hold their own reverses.
- Mutating commands take a lock (`$XDG_RUNTIME_DIR/firesong-cube.lock`), so two sessions do not drive the TV at once.
- When you are done: `cube.sh home` and `cube.sh unreverse`.

## 5. Party checklist

Before:

1. `party-prep.py prep "<playlist>"` well ahead of time (it yields to GPU reservations, so start early).
2. Rotate the phone pairing token: `curl -fsS -X POST -H "x-firesong-host-token: $(cat /mnt/fast/firesong/data/firesong/host-token)" http://127.0.0.1:64448/api/firesong/rotate-pairing-token -o /dev/null`. It writes a new token, disconnects every phone, and old QR codes and cookies get 401 from then on (PROTOCOL.md §2.1). With the service stopped, deleting `/mnt/fast/firesong/data/remote-control.json` does the same on the next start.
3. Funnel on (1.3). Check that `tailscale funnel status` still lists `:443`.
4. Check key expiry is disabled (1.4).
5. At the TV: the Cube on Ethernet, Fire TV audio set to PCM/Stereo, the TV in Game Mode.
6. `cube.sh status`, then `cube.sh launch --url … --host-token-file …` when the TV is idle.

After:

1. Funnel off: `tailscale funnel --https=8443 off`.
2. `cube.sh home`; `cube.sh unreverse` if any reverses were made.
3. Optionally `party-prep.py evict` to bring the cache back under the cap.

## 6. Tests

```sh
scripts/firesong/party-prep.py self-test        # all of the below, with unittest
/usr/bin/python3 -m unittest discover -s scripts/firesong/tests -t scripts/firesong
scripts/firesong/cube.sh self-test              # fake adb: idle guard, package check, quoting, reverses, adbkey guard
scripts/firesong/server-install.sh self-test      # env, unit rendering, owner steps
scripts/firesong/server-install.sh check          # preflight with the real env file + systemd-analyze verify
scripts/firesong/build-release.sh --dry-run --allow-dirty
```

The prep tests run the real prep loop against a fake Nightingale server on an ephemeral loopback port. It simulates analysis, the hash re-key, cancellation and the idle analyzer's CUDA context. No GPU, NFS mount, unit or real server is touched. `shellcheck` runs when it is installed. It is not a system package on the server machine; `pip install shellcheck-py` into `/mnt/staging1/firesong/tools-venv` provides it.

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `firesong.service` fails at start, journal shows `preflight: FAIL` | The message names the problem: song cache not mounted, a placeholder in the env file, a non-loopback bind, the wrong GPU. Fix it, then run `systemctl --user reset-failed firesong` and start again. |
| `party-prep.py` exit 2 "not mounted" | The NFS mount is missing (1.1), or the NFS server is down. |
| `party-prep.py` exit 5 "not set up" | The analyzer setup has not been done in the UI (section 2). |
| Prep waits forever on "GPU reserved by …" | A reservation window or a `touch`ed file is in force. Wait, or ask its holder. Never delete someone else's reservation. |
| Prep exit 4 | The protected songs exceed the cap. Prep fewer songs, or evict other playlists' songs with `evict`. |
| `cube.sh` "unauthorized" | The Cube no longer trusts this host's key. Only someone at the TV can accept it again. Do not regenerate the key. |
| `cube.sh install/launch` "not idle" | Someone is using the TV. Retry later. |
