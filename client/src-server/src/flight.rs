//! The party flight recorder (docs/firesong/FLIGHT.md). Every party leaves a
//! record of what the TV page, the server and the host did, so a white screen,
//! a silent microphone or a hang can be explained afterwards from evidence.
//!
//! Lines go to `<data>/firesong/sessions/<UTC date>.jsonl`, one JSON object per
//! line with `t` (Unix ms), `src` (`tv`, `server`, `host`) and `ev`. A writer
//! thread owns the file, so a stalled async runtime still gets its stall
//! written down; a full queue drops lines instead of blocking a caller, and
//! the writer notes how many once it catches up. Files untouched for
//! [`KEEP_DAYS`] are removed when the day changes.
//!
//! Two watchdogs report stalls: an OS thread that measures how late its own
//! sleeps wake (the whole process stalled: swapping, CPU starvation), and a
//! runtime task that measures how late its ticks run (the async runtime was
//! blocked). The OS thread also samples the host every [`HOST_EVERY`].

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::state::AppState;

/// Days a session file is kept after its last line.
const KEEP_DAYS: u64 = 14;
/// Queue length between callers and the writer thread.
const QUEUE: usize = 4096;
/// Watchdog beat, and how late a beat must be to count as a stall.
const BEAT: Duration = Duration::from_millis(250);
const STALL: Duration = Duration::from_millis(1000);
/// Host sample interval.
const HOST_EVERY: Duration = Duration::from_secs(10);
/// Events one TV request may carry, and the largest event kept.
const MAX_EVENTS: usize = 200;
const MAX_EVENT_BYTES: usize = 4096;
/// Request body limit for `/api/firesong/flight`.
pub(crate) const MAX_BODY_BYTES: usize = 256 * 1024;

/// The recorder handle on `AppState`. Until [`Flight::start`] runs (tests, the
/// desktop app) [`Flight::record`] does nothing.
#[derive(Clone, Default)]
pub(crate) struct Flight {
    sender: Arc<OnceLock<SyncSender<String>>>,
    /// Lines dropped on a full queue since the writer last noted it.
    dropped: Arc<AtomicU64>,
}

impl Flight {
    /// Opens `<data_dir>/firesong/sessions` and starts the writer thread and
    /// the process watchdog. Blocking; returns whether the recorder is on, in
    /// which case the caller spawns [`Flight::runtime_watchdog`].
    pub(crate) fn start(&self, data_dir: &Path) -> bool {
        let dir = data_dir.join("firesong").join("sessions");
        if let Err(error) = fs::create_dir_all(&dir) {
            tracing::warn!(dir = %dir.display(), "flight recorder off: {error}");
            return false;
        }
        let (sender, receiver) = mpsc::sync_channel(QUEUE);
        if self.sender.set(sender).is_err() {
            return false;
        }
        let writer_dir = dir.clone();
        let dropped = self.dropped.clone();
        let watchdog = self.clone();
        let spawned = std::thread::Builder::new()
            .name("flight-writer".into())
            .spawn(move || write_lines(&writer_dir, &receiver, &dropped))
            .and_then(|_| {
                std::thread::Builder::new()
                    .name("flight-watchdog".into())
                    .spawn(move || watchdog.process_watchdog())
            });
        if let Err(error) = spawned {
            tracing::warn!("flight recorder threads: {error}");
            return false;
        }
        tracing::info!(dir = %dir.display(), "flight recorder on");
        self.record(
            "server",
            "start",
            json!({ "version": env!("CARGO_PKG_VERSION") }),
        );
        true
    }

    /// Queues one line. `fields` should be a JSON object; anything else is
    /// kept as `{"value": ...}`.
    pub(crate) fn record(&self, src: &str, ev: &str, fields: Value) {
        let Some(sender) = self.sender.get() else {
            return;
        };
        if let Err(TrySendError::Full(_)) = sender.try_send(line(src, ev, fields)) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn process_watchdog(self) {
        let mut host = HostSampler::default();
        let mut next_sample = Instant::now();
        loop {
            let before = Instant::now();
            std::thread::sleep(BEAT);
            let late = before.elapsed().saturating_sub(BEAT);
            if late >= STALL {
                self.record(
                    "server",
                    "stall",
                    json!({ "kind": "process", "ms": late.as_millis() }),
                );
            }
            if Instant::now() >= next_sample {
                next_sample = Instant::now() + HOST_EVERY;
                if let Some(sample) = host.sample() {
                    self.record("host", "sample", sample);
                }
            }
        }
    }

    /// Reports ticks of the async runtime that ran late.
    pub(crate) async fn runtime_watchdog(self) {
        let mut ticker = tokio::time::interval(BEAT);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            let before = Instant::now();
            ticker.tick().await;
            let late = before.elapsed().saturating_sub(BEAT);
            if late >= STALL {
                self.record(
                    "server",
                    "stall",
                    json!({ "kind": "runtime", "ms": late.as_millis() }),
                );
            }
        }
    }
}

fn line(src: &str, ev: &str, fields: Value) -> String {
    let mut object = match fields {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => Map::from_iter([("value".to_owned(), other)]),
    };
    object.insert("t".into(), json!(unix_millis()));
    object.insert("src".into(), json!(src));
    object.insert("ev".into(), json!(ev));
    Value::Object(object).to_string()
}

/// The TV page's batch: `{"events": [{"ev": "...", ...}]}`.
#[derive(Debug, Deserialize)]
pub(crate) struct TvBatch {
    events: Vec<Value>,
}

/// `POST /api/firesong/flight` (TV door, host token).
pub(crate) async fn handle_tv(
    State(state): State<AppState>,
    Json(batch): Json<TvBatch>,
) -> StatusCode {
    let flight = state.firesong.flight();
    let dropped = batch.events.len().saturating_sub(MAX_EVENTS);
    for (ev, fields) in batch
        .events
        .into_iter()
        .take(MAX_EVENTS)
        .filter_map(tv_event)
    {
        flight.record("tv", &ev, fields);
    }
    if dropped > 0 {
        flight.record(
            "server",
            "tv-batch-truncated",
            json!({ "dropped": dropped }),
        );
    }
    StatusCode::NO_CONTENT
}

/// A TV event's name and fields. Nameless events are dropped and oversized ones
/// reduced to a note, so a runaway page can neither fill the disk nor hide;
/// `t` and `src` belong to the server.
fn tv_event(event: Value) -> Option<(String, Value)> {
    let Value::Object(mut map) = event else {
        return None;
    };
    let ev = match map.remove("ev") {
        Some(Value::String(name)) if !name.is_empty() && name.len() <= 64 => name,
        _ => return None,
    };
    map.remove("t");
    map.remove("src");
    let fields = Value::Object(map);
    if fields.to_string().len() > MAX_EVENT_BYTES {
        return Some((ev, json!({ "oversized": true })));
    }
    Some((ev, fields))
}

fn write_lines(dir: &Path, receiver: &Receiver<String>, dropped: &AtomicU64) {
    let mut open: Option<(u64, File)> = None;
    for queued in receiver {
        let day = unix_secs() / 86_400;
        if open.as_ref().is_none_or(|(current, _)| *current != day) {
            prune(dir);
            open = OpenOptions::new()
                .create(true)
                .append(true)
                .open(day_path(dir, day))
                .map(|file| (day, file))
                .inspect_err(|error| tracing::warn!("flight recorder: {error}"))
                .ok();
        }
        let Some((_, file)) = open.as_mut() else {
            continue;
        };
        let lost = dropped.swap(0, Ordering::Relaxed);
        let note = (lost > 0).then(|| {
            tracing::warn!(lines = lost, "flight recorder fell behind: lines dropped");
            line("server", "dropped", json!({ "lines": lost }))
        });
        for text in note.iter().chain([&queued]) {
            if let Err(error) = writeln!(file, "{text}") {
                tracing::warn!("flight recorder: {error}");
            }
        }
    }
}

fn day_path(dir: &Path, day: u64) -> PathBuf {
    dir.join(format!("{}.jsonl", civil_date(day)))
}

/// Removes session files untouched for [`KEEP_DAYS`].
fn prune(dir: &Path) {
    let keep = Duration::from_secs(KEEP_DAYS * 86_400);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let is_session = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.len() == 16 && name.ends_with(".jsonl"));
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > keep);
        if is_session && stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `YYYY-MM-DD` (UTC) for days since the Unix epoch (Howard Hinnant's
/// civil-from-days).
fn civil_date(days: u64) -> String {
    let z = i64::try_from(days).unwrap_or(0) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Load, memory and swap traffic from `/proc`; swap pages are per second since
/// the previous sample.
#[derive(Default)]
struct HostSampler {
    last: Option<(Instant, u64, u64)>,
}

impl HostSampler {
    fn sample(&mut self) -> Option<Value> {
        let load = fs::read_to_string("/proc/loadavg").ok()?;
        let load1: f64 = load.split_whitespace().next()?.parse().ok()?;
        let meminfo = fs::read_to_string("/proc/meminfo").ok()?;
        let vmstat = fs::read_to_string("/proc/vmstat").ok()?;
        let swap_in = field(&vmstat, "pswpin ")?;
        let swap_out = field(&vmstat, "pswpout ")?;
        let now = Instant::now();
        let rates = self.last.map(|(at, last_in, last_out)| {
            let secs = now.duration_since(at).as_secs_f64().max(0.001);
            let rate = |pages: u64| (pages as f64 / secs).round();
            (
                rate(swap_in.saturating_sub(last_in)),
                rate(swap_out.saturating_sub(last_out)),
            )
        });
        self.last = Some((now, swap_in, swap_out));
        let rss_kib = fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| field(&status, "VmRSS:"));
        Some(json!({
            "load1": load1,
            "mem_available_mib": field(&meminfo, "MemAvailable:").map(|kib| kib / 1024),
            "swap_in_per_s": rates.map(|(swap_in, _)| swap_in),
            "swap_out_per_s": rates.map(|(_, swap_out)| swap_out),
            "rss_mib": rss_kib.map(|kib| kib / 1024),
        }))
    }
}

/// The number after `name` on the line that starts with it.
fn field(text: &str, name: &str) -> Option<u64> {
    text.lines()
        .find_map(|line| line.strip_prefix(name))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|value| value.parse().ok())
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}
