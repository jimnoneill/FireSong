//! Remote songs get their content hash when the analyzer downloads them, so
//! the library row moves from a placeholder hash to the real one. FireSong's
//! party queue holds songs by hash while they prepare; this record lets it
//! follow the move.

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};

use super::lock_unpoisoned;

/// Moves remembered, oldest dropped first.
const KEPT: usize = 256;

static REKEYS: LazyLock<Mutex<VecDeque<(String, String)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

pub(super) fn record(old_hash: &str, new_hash: &str) {
    let mut rekeys = lock_unpoisoned(&REKEYS);
    rekeys.retain(|(old, _)| old != old_hash);
    rekeys.push_back((old_hash.to_string(), new_hash.to_string()));
    while rekeys.len() > KEPT {
        rekeys.pop_front();
    }
}

/// The hash a song moved to since it was known as `file_hash`, if it moved.
pub fn rekeyed_hash(file_hash: &str) -> Option<String> {
    let rekeys = lock_unpoisoned(&REKEYS);
    let mut current = file_hash;
    for _ in 0..KEPT {
        let Some((_, next)) = rekeys.iter().rev().find(|(old, _)| old == current) else {
            break;
        };
        current = next;
    }
    (current != file_hash).then(|| current.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_are_followed_to_the_latest_hash() {
        record("party-old-0001", "party-mid-0001");
        record("party-mid-0001", "party-new-0001");
        assert_eq!(
            rekeyed_hash("party-old-0001").as_deref(),
            Some("party-new-0001")
        );
        assert_eq!(rekeyed_hash("party-new-0001"), None);
        assert_eq!(rekeyed_hash("party-unknown"), None);
    }
}
