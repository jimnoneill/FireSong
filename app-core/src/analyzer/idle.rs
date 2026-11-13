//! Optional idle exit for the analyzer server. A running `server.py` keeps its
//! GPU context and models loaded between jobs; with
//! `NIGHTINGALE_ANALYZER_IDLE_EXIT_SECS` set, the server is stopped once it has
//! been unused that long, and the next job starts it again.

use std::sync::{LazyLock, Mutex, Once};
use std::time::{Duration, Instant};

use tracing::info;

use super::{ANALYZER, ANALYZER_SERVER, lock_unpoisoned};

const ENV: &str = "NIGHTINGALE_ANALYZER_IDLE_EXIT_SECS";

static LAST_USE: LazyLock<Mutex<Instant>> = LazyLock::new(|| Mutex::new(Instant::now()));
static REAPER: Once = Once::new();

/// Marks the server as in use and, the first time, starts the idle check.
pub(super) fn touch() {
    *lock_unpoisoned(&LAST_USE) = Instant::now();
    let Some(idle) = parse(std::env::var(ENV).ok().as_deref()) else {
        return;
    };
    REAPER.call_once(|| {
        let tick = (idle / 4).clamp(Duration::from_secs(1), Duration::from_secs(30));
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(tick);
                stop_if_idle(idle);
            }
        });
    });
}

fn parse(raw: Option<&str>) -> Option<Duration> {
    raw?.trim()
        .parse::<u64>()
        .ok()
        .filter(|secs| *secs > 0)
        .map(Duration::from_secs)
}

fn stop_if_idle(idle: Duration) {
    if lock_unpoisoned(&LAST_USE).elapsed() < idle {
        return;
    }
    {
        let state = lock_unpoisoned(&ANALYZER);
        if state.worker_running || !state.queue.is_empty() {
            return;
        }
    }
    // A held lock means a job is using the server right now.
    let Ok(mut server) = ANALYZER_SERVER.try_lock() else {
        return;
    };
    if server.take().is_some() {
        info!(
            "[analyzer] idle for {}s; stopping the server to free GPU memory",
            idle.as_secs()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_exit_is_off_unless_a_positive_number_of_seconds_is_set() {
        assert_eq!(parse(None), None);
        assert_eq!(parse(Some("")), None);
        assert_eq!(parse(Some("0")), None);
        assert_eq!(parse(Some("-5")), None);
        assert_eq!(parse(Some("soon")), None);
        assert_eq!(parse(Some(" 300 ")), Some(Duration::from_secs(300)));
    }
}
