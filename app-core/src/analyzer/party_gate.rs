//! FireSong party gate for the analyzer worker (docs/firesong/FLIGHT.md,
//! party mode). While a party is on, the worker only takes songs someone is
//! waiting to sing (`enqueue_urgent`); background preparation stays queued and
//! the analyzer server is kept running between jobs. A party is on while a TV
//! holds its seat and for a hold time after the last TV leaves, so a TV that
//! drops and reconnects, or a short break, does not hand the GPU back.

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use tracing::info;

use super::lock_unpoisoned;

const RECHECK: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Party {
    Off,
    On,
    Until(Instant),
}

static PARTY: LazyLock<Mutex<Party>> = LazyLock::new(|| Mutex::new(Party::Off));

/// A TV took its seat: the party is on until [`party_paused`].
pub fn party_started() {
    let mut party = lock_unpoisoned(&PARTY);
    if *party != Party::On {
        info!("[analyzer] party mode on: only songs guests are waiting for are prepared");
    }
    *party = Party::On;
}

/// The last TV left its seat: the party stays on for `hold`.
pub fn party_paused(hold: Duration) {
    *lock_unpoisoned(&PARTY) = Party::Until(Instant::now() + hold);
}

/// Whether a party is on now.
pub fn party_active() -> bool {
    let mut party = lock_unpoisoned(&PARTY);
    match *party {
        Party::Off => false,
        Party::On => true,
        Party::Until(end) if Instant::now() < end => true,
        Party::Until(_) => {
            *party = Party::Off;
            info!("[analyzer] party mode off: background preparation resumes");
            false
        }
    }
}

/// Blocks the worker while a party is on and its next job is background work.
/// `next_is_background` answers for the job at the front of the queue, `None`
/// when the queue is empty.
pub(super) fn wait_for_turn(next_is_background: impl Fn() -> Option<bool>) {
    while party_active() && next_is_background() == Some(true) {
        std::thread::sleep(RECHECK);
    }
}
