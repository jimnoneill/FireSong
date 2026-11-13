#!/usr/bin/env python3
"""FireSong party prep: analyse Plex playlists ahead of a party on the server machine.

    party-prep.py prep "Party Mix" [--dry-run]   # enqueue analysis (GPU guard, cache cap)
    party-prep.py status                         # mount, cache, GPU and server state
    party-prep.py evict [--dry-run]              # LRU-evict finished songs down to the cap
    party-prep.py gpu-check                      # exit 0 clear / 3 busy
    party-prep.py configure                      # point config.json at the song cache
    party-prep.py self-test                      # unit tests

The logic lives in firesong_prep.py next to this file; docs/firesong/DEPLOY.md
is the runbook.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from firesong_prep import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
