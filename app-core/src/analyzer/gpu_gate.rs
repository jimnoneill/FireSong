//! FireSong GPU gate for the analyzer worker (PHONE-V2.md, feature 2). Before
//! the worker starts any job it applies the rules of
//! `scripts/firesong/firesong_prep.py` (`gpu_verdict`); while they say no, the
//! job stays queued and the worker looks again every 30 seconds.
//!
//! The gate is closed while the pinned GPU's reservation file is in force or
//! starts within 10 minutes, or while the GPU has less than
//! `FIRESONG_GPU_MIN_FREE_GB` free, not counting this server's own analyzer.
//! Without a pinned GPU or without `nvidia-smi` it is open.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tracing::info;

use super::{ANALYZER, lock_unpoisoned};

const RECHECK: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
/// A reservation starting this soon already keeps new work off the GPU.
const LOOKAHEAD_SECS: i64 = 600;
const DEFAULT_MIN_FREE_GB: f64 = 6.0;
const MIB: f64 = 1024.0 * 1024.0;
const GIB: f64 = 1024.0 * MIB;

const NVIDIA_SMI: &str = "nvidia-smi";
const QUERY_GPU: [&str; 2] = [
    "--query-gpu=index,uuid,name,memory.free,memory.total",
    "--format=csv,noheader,nounits",
];
const QUERY_APPS: [&str; 2] = [
    "--query-compute-apps=pid,gpu_uuid,used_memory",
    "--format=csv,noheader,nounits",
];

static WAITING: AtomicBool = AtomicBool::new(false);

/// The analyzer worker's queue as the party queue sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnalyzerView {
    /// The job the worker runs now.
    pub active: Option<String>,
    /// Jobs behind it, in the order the worker takes them.
    pub waiting: Vec<String>,
    /// The worker holds its next job because the GPU gate is closed.
    pub waiting_gpu: bool,
}

/// During a party the worker takes only songs someone is waiting for, so the
/// background songs it holds back are not part of the line.
pub fn analyzer_view() -> AnalyzerView {
    let party = super::party_gate::party_active();
    let state = lock_unpoisoned(&ANALYZER);
    AnalyzerView {
        active: state.active_hash.clone(),
        waiting: state
            .queue
            .iter()
            .filter(|hash| !party || state.urgent.contains(*hash))
            .cloned()
            .collect(),
        waiting_gpu: WAITING.load(Ordering::SeqCst),
    }
}

/// Blocks the worker thread until the gate opens or there is no work left.
pub(super) fn wait_for_gpu(has_work: impl Fn() -> bool) {
    let config = GateConfig::from_env(|key| std::env::var(key).ok());
    if config.gpu.is_none() {
        return;
    }
    let mut closed_for: Option<String> = None;
    while has_work() {
        match verdict(&config, &SystemProbe) {
            Ok(()) => break,
            Err(reason) => {
                WAITING.store(true, Ordering::SeqCst);
                if closed_for.as_ref() != Some(&reason) {
                    info!("[analyzer] GPU gate closed: {reason}; checking again every 30 s");
                    closed_for = Some(reason);
                }
                std::thread::sleep(RECHECK);
            }
        }
    }
    if closed_for.is_some() {
        info!("[analyzer] GPU gate open");
    }
    WAITING.store(false, Ordering::SeqCst);
}

#[derive(Debug, Clone, PartialEq)]
struct GateConfig {
    /// UUID or index of the pinned GPU.
    gpu: Option<String>,
    min_free_bytes: f64,
    reservations_dir: PathBuf,
}

impl GateConfig {
    fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let pinned = |value: Option<String>| {
            value
                .and_then(|value| {
                    value
                        .split(',')
                        .next()
                        .map(|first| first.trim().to_string())
                })
                .filter(|value| !value.is_empty() && !value.contains(['<', '>']))
        };
        let gpu = pinned(get("FIRESONG_GPU_UUID")).or_else(|| pinned(get("CUDA_VISIBLE_DEVICES")));
        let min_free_gb = get("FIRESONG_GPU_MIN_FREE_GB")
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(DEFAULT_MIN_FREE_GB);
        let reservations_dir = get("FIRESONG_GPU_RESERVATIONS_DIR")
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".config")
                    .join("gpu-reservations")
            });
        Self {
            gpu,
            min_free_bytes: min_free_gb * GIB,
            reservations_dir,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RunError {
    /// The program is not installed.
    Missing,
    Failed(String),
}

/// The gate's view of the machine; tests replace it.
trait Probe {
    /// Runs a fixed command and returns its stdout.
    fn run(&self, program: &str, args: &[&str]) -> Result<String, RunError>;
    /// PIDs of this server's own analyzer processes.
    fn own_pids(&self) -> HashSet<u32>;
    fn now_unix_secs(&self) -> i64;
}

struct SystemProbe;

impl Probe for SystemProbe {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, RunError> {
        run_with_timeout(program, args, COMMAND_TIMEOUT)
    }

    fn own_pids(&self) -> HashSet<u32> {
        descendants(std::process::id())
    }

    fn now_unix_secs(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| {
                i64::try_from(since.as_secs()).unwrap_or(i64::MAX)
            })
    }
}

fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<String, RunError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => RunError::Missing,
            _ => RunError::Failed(format!("{program} did not start: {error}")),
        })?;
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Failed(format!("{program} timed out")));
            }
            Err(error) => return Err(RunError::Failed(format!("{program}: {error}"))),
        }
    };
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    if status.success() {
        Ok(stdout)
    } else {
        Err(RunError::Failed(format!("{program} exited with {status}")))
    }
}

/// Every process below `root`, read from `/proc`.
fn descendants(root: u32) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let parent = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1))
            .and_then(|ppid| ppid.parse::<u32>().ok());
        if let Some(parent) = parent {
            children.entry(parent).or_default().push(pid);
        }
    }
    let mut found = HashSet::new();
    let mut todo = children.get(&root).cloned().unwrap_or_default();
    while let Some(pid) = todo.pop() {
        if found.insert(pid) {
            todo.extend(children.get(&pid).into_iter().flatten().copied());
        }
    }
    found
}

/// `Ok` when the worker may start a job, otherwise why not.
fn verdict(config: &GateConfig, probe: &dyn Probe) -> Result<(), String> {
    let Some(want) = config.gpu.as_deref() else {
        return Ok(());
    };
    let gpus = match probe.run(NVIDIA_SMI, &QUERY_GPU) {
        Ok(stdout) => stdout,
        Err(RunError::Missing) => return Ok(()),
        Err(RunError::Failed(error)) => return Err(format!("nvidia-smi failed ({error})")),
    };
    let row = csv_rows(&gpus)
        .into_iter()
        .find(|cols| cols.len() >= 5 && (cols[1] == want || cols[0] == want))
        .ok_or_else(|| "the pinned GPU is not in nvidia-smi".to_string())?;
    let uuid = row[1].clone();
    let free = row[3]
        .parse::<f64>()
        .map_err(|_| "nvidia-smi gave no free memory".to_string())?
        * MIB;

    check_reservation(&config.reservations_dir.join(&uuid), probe)?;

    let own = own_usage(probe, &uuid);
    let effective = free + own;
    if effective < config.min_free_bytes {
        return Err(format!(
            "{:.1} GiB free on the pinned GPU (need {:.0} GiB)",
            effective / GIB,
            config.min_free_bytes / GIB
        ));
    }
    Ok(())
}

fn csv_rows(text: &str) -> Vec<Vec<String>> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split(',').map(|col| col.trim().to_string()).collect())
        .collect()
}

/// Memory this server's own analyzer holds on the GPU, in bytes.
fn own_usage(probe: &dyn Probe, uuid: &str) -> f64 {
    let pids = probe.own_pids();
    if pids.is_empty() {
        return 0.0;
    }
    let Ok(apps) = probe.run(NVIDIA_SMI, &QUERY_APPS) else {
        return 0.0;
    };
    csv_rows(&apps)
        .iter()
        .filter(|cols| cols.len() >= 3 && cols[1] == uuid)
        .filter(|cols| cols[0].parse::<u32>().is_ok_and(|pid| pids.contains(&pid)))
        .filter_map(|cols| cols[2].parse::<f64>().ok())
        .sum::<f64>()
        * MIB
}

/// The server machine's GPU reservation convention: lines
/// `from <ISO> until <ISO> by <holder>`; `#` starts a comment. A file without
/// lines reserves the GPU until it is removed, and so does a file that cannot
/// be read or parsed.
fn check_reservation(path: &Path, probe: &dyn Probe) -> Result<(), String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("the GPU reservation file cannot be read".into()),
    };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    if lines.is_empty() {
        return Err("the GPU is reserved until its reservation file is removed".into());
    }
    let now = probe.now_unix_secs();
    let mut local_offset: Option<Option<i64>> = None;
    for line in lines {
        let unparsed = || "the GPU reservation file has a line it cannot read".to_string();
        let lease = parse_lease(line).ok_or_else(unparsed)?;
        let mut to_unix = |stamp: Stamp| match stamp.offset_secs {
            Some(offset) => Some(stamp.civil_secs - offset),
            None => {
                let offset = *local_offset.get_or_insert_with(|| local_utc_offset(probe));
                offset.map(|offset| stamp.civil_secs - offset)
            }
        };
        let (Some(start), Some(until)) = (to_unix(lease.from), to_unix(lease.until)) else {
            return Err(unparsed());
        };
        if start <= now && now < until {
            return Err(format!("the GPU is reserved by {}", lease.holder));
        }
        if now < start && start <= now + LOOKAHEAD_SECS {
            return Err(format!(
                "a GPU reservation by {} starts within 10 minutes",
                lease.holder
            ));
        }
    }
    Ok(())
}

struct Lease {
    from: Stamp,
    until: Stamp,
    holder: String,
}

/// A timestamp as written: civil seconds since the epoch, and its UTC offset
/// when it names one (otherwise it is local time).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    civil_secs: i64,
    offset_secs: Option<i64>,
}

fn parse_lease(line: &str) -> Option<Lease> {
    let words: Vec<&str> = line.split_whitespace().collect();
    let at = (0..words.len()).find(|index| {
        words[*index] == "from" && words.get(index + 2).is_some_and(|word| *word == "until")
    })?;
    let from = parse_stamp(words.get(at + 1)?)?;
    let until = parse_stamp(words.get(at + 3)?)?;
    let holder = match words.get(at + 4) {
        Some(&"by") if words.len() > at + 5 => words[at + 5..].join(" "),
        _ => "another job".to_string(),
    };
    Some(Lease {
        from,
        until,
        holder,
    })
}

/// `YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH[:MM]|±HHMM]`, the forms Python's
/// `datetime.fromisoformat` writes.
fn parse_stamp(text: &str) -> Option<Stamp> {
    let (date, rest) = text.split_at_checked(10)?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (time, offset_secs) = match rest.find(['Z', '+']).or_else(|| rest.rfind('-')) {
        Some(at) => (&rest[..at], Some(parse_offset(&rest[at..])?)),
        None => (rest, None),
    };
    let mut seconds = 0;
    if !time.is_empty() {
        let time = time.strip_prefix(['T', ' '])?;
        let mut parts = time.split(':');
        let hour: i64 = parts.next()?.parse().ok()?;
        let minute: i64 = parts.next()?.parse().ok()?;
        let second: f64 = parts
            .next()
            .map_or(Some(0.0), |second| second.parse().ok())?;
        if parts.next().is_some() || hour > 23 || minute > 59 || !(0.0..61.0).contains(&second) {
            return None;
        }
        seconds = hour * 3600 + minute * 60 + second as i64;
    }
    Some(Stamp {
        civil_secs: days_from_civil(year, month, day) * 86_400 + seconds,
        offset_secs,
    })
}

fn parse_offset(text: &str) -> Option<i64> {
    if text == "Z" {
        return Some(0);
    }
    let sign = match text.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits: String = text[1..].chars().filter(|char| *char != ':').collect();
    if !matches!(digits.len(), 2 | 4) || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let hours: i64 = digits[..2].parse().ok()?;
    let minutes: i64 = digits
        .get(2..)
        .map_or(Some(0), |minutes| minutes.parse().ok())?;
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The machine's current UTC offset (`date +%z`), for reservation times
/// written without one.
fn local_utc_offset(probe: &dyn Probe) -> Option<i64> {
    probe
        .run("date", &["+%z"])
        .ok()
        .and_then(|stdout| parse_offset(stdout.trim()))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const UUID: &str = "GPU-00000000-1111-2222-3333-444444444444";
    /// 2026-11-13T12:00:00Z
    const NOON_UTC: i64 = 1_794_571_200;

    struct FakeProbe {
        smi: Result<String, RunError>,
        apps: String,
        own: HashSet<u32>,
        offset: &'static str,
        calls: RefCell<Vec<String>>,
    }

    impl FakeProbe {
        fn free_mib(free: u32) -> Self {
            Self {
                smi: Ok(format!(
                    "0, GPU-ffffffff-0000-0000-0000-000000000000, Other, 90000, 97000\n\
                     1, {UUID}, Pinned, {free}, 24564\n"
                )),
                apps: String::new(),
                own: HashSet::new(),
                offset: "-0800",
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl Probe for FakeProbe {
        fn run(&self, program: &str, args: &[&str]) -> Result<String, RunError> {
            self.calls
                .borrow_mut()
                .push(format!("{program} {}", args.join(" ")));
            match (program, args.first().copied()) {
                ("nvidia-smi", Some(arg)) if arg == QUERY_GPU[0] => self.smi.clone(),
                ("nvidia-smi", Some(arg)) if arg == QUERY_APPS[0] => Ok(self.apps.clone()),
                ("date", _) => Ok(format!("{}\n", self.offset)),
                _ => Err(RunError::Failed("unexpected command".into())),
            }
        }

        fn own_pids(&self) -> HashSet<u32> {
            self.own.clone()
        }

        fn now_unix_secs(&self) -> i64 {
            NOON_UTC
        }
    }

    fn scratch(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("firesong-gpu-gate-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn config(dir: &Path, gpu: Option<&str>) -> GateConfig {
        GateConfig {
            gpu: gpu.map(str::to_owned),
            min_free_bytes: 6.0 * GIB,
            reservations_dir: dir.to_path_buf(),
        }
    }

    fn reserve(dir: &Path, text: &str) {
        std::fs::write(dir.join(UUID), text).expect("reservation file");
    }

    #[test]
    fn reservation_windows_close_the_gate() {
        let dir = scratch("windows");
        let probe = FakeProbe::free_mib(20_000);
        let gate = config(&dir, Some(UUID));
        assert_eq!(verdict(&gate, &probe), Ok(()));

        // Local times (UTC-8): 03:00-05:00 contains noon UTC.
        reserve(
            &dir,
            "# lease\nfrom 2026-11-13T03:00:00 until 2026-11-13T05:00:00 by deepthought\n",
        );
        assert_eq!(
            verdict(&gate, &probe),
            Err("the GPU is reserved by deepthought".into())
        );
        // Starting within 10 minutes counts; with an explicit offset.
        reserve(
            &dir,
            "from 2026-11-13T12:09:00Z until 2026-11-13T13:00:00Z by art\n",
        );
        assert!(verdict(&gate, &probe).is_err_and(|reason| reason.contains("within 10 minutes")));
        // In the past, or more than 10 minutes ahead: open.
        reserve(
            &dir,
            "from 2026-11-12T01:00:00-08:00 until 2026-11-12T02:00:00-08:00 by art\n\
             from 2026-11-13T12:11 until 2026-11-13T13:00 by art\n",
        );
        assert_eq!(
            verdict(
                &gate,
                &FakeProbe {
                    offset: "+0000",
                    ..FakeProbe::free_mib(20_000)
                }
            ),
            Ok(())
        );
        // No window at all, or a line nobody can read: reserved.
        reserve(&dir, "\n# touched\n");
        assert!(
            verdict(&gate, &probe)
                .is_err_and(|reason| reason.contains("until its reservation file is removed"))
        );
        reserve(&dir, "from tomorrow until later\n");
        assert!(verdict(&gate, &probe).is_err_and(|reason| reason.contains("cannot read")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn free_memory_counts_the_servers_own_analyzer() {
        let dir = scratch("memory");
        let gate = config(&dir, Some(UUID));
        let low = FakeProbe::free_mib(4_096);
        assert!(verdict(&gate, &low).is_err_and(|reason| reason.contains("4.0 GiB free")));

        let own = FakeProbe {
            apps: format!("4242, {UUID}, 3072\n777, {UUID}, 9000\n4242, GPU-other, 5000\n"),
            own: HashSet::from([4242]),
            ..FakeProbe::free_mib(4_096)
        };
        assert_eq!(verdict(&gate, &own), Ok(()));
        // By index as well as by UUID.
        assert_eq!(
            verdict(&config(&dir, Some("1")), &FakeProbe::free_mib(8_192)),
            Ok(())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_pinned_gpu_or_no_nvidia_smi_leaves_the_gate_open() {
        let dir = scratch("open");
        reserve(&dir, "");
        let probe = FakeProbe::free_mib(10);
        assert_eq!(verdict(&config(&dir, None), &probe), Ok(()));
        assert!(probe.calls.borrow().is_empty());

        let missing = FakeProbe {
            smi: Err(RunError::Missing),
            ..FakeProbe::free_mib(10)
        };
        assert_eq!(verdict(&config(&dir, Some(UUID)), &missing), Ok(()));
        let broken = FakeProbe {
            smi: Err(RunError::Failed("exit 9".into())),
            ..FakeProbe::free_mib(10)
        };
        assert!(verdict(&config(&dir, Some(UUID)), &broken).is_err());
        assert!(
            verdict(
                &config(&dir, Some("GPU-gone")),
                &FakeProbe::free_mib(20_000)
            )
            .is_err()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn configuration_comes_from_the_environment() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| (*value).to_string())
            }
        };
        let config = GateConfig::from_env(env(&[
            ("CUDA_VISIBLE_DEVICES", "GPU-abc, GPU-def"),
            ("FIRESONG_GPU_MIN_FREE_GB", "8"),
            ("FIRESONG_GPU_RESERVATIONS_DIR", "/srv/leases"),
        ]));
        assert_eq!(config.gpu.as_deref(), Some("GPU-abc"));
        assert!((config.min_free_bytes - 8.0 * GIB).abs() < 1.0);
        assert_eq!(config.reservations_dir, PathBuf::from("/srv/leases"));

        let pinned = GateConfig::from_env(env(&[
            ("FIRESONG_GPU_UUID", "GPU-pinned"),
            ("CUDA_VISIBLE_DEVICES", "0"),
        ]));
        assert_eq!(pinned.gpu.as_deref(), Some("GPU-pinned"));
        assert!((pinned.min_free_bytes - 6.0 * GIB).abs() < 1.0);
        assert_eq!(
            GateConfig::from_env(env(&[("CUDA_VISIBLE_DEVICES", "<gpu-uuid>")])).gpu,
            None
        );
        assert_eq!(GateConfig::from_env(env(&[])).gpu, None);
    }

    #[test]
    fn timestamps_parse_like_python_isoformat() {
        let noon = days_from_civil(2026, 11, 13) * 86_400 + 12 * 3600;
        assert_eq!(noon, NOON_UTC);
        assert_eq!(
            parse_stamp("2026-11-13T12:00:00Z"),
            Some(Stamp {
                civil_secs: noon,
                offset_secs: Some(0)
            })
        );
        assert_eq!(
            parse_stamp("2026-11-13T04:00:00-08:00")
                .map(|stamp| stamp.civil_secs - stamp.offset_secs.unwrap_or(0)),
            Some(noon)
        );
        assert_eq!(
            parse_stamp("2026-11-13T12:00:00.250+0000").map(|stamp| stamp.civil_secs),
            Some(noon)
        );
        assert_eq!(
            parse_stamp("2026-11-13T12:00"),
            Some(Stamp {
                civil_secs: noon,
                offset_secs: None
            })
        );
        assert_eq!(
            parse_stamp("2026-11-13").map(|stamp| stamp.civil_secs),
            Some(noon - 12 * 3600)
        );
        assert_eq!(parse_stamp("2026-13-01"), None);
        assert_eq!(parse_stamp("2026-11-13T25:00"), None);
        assert_eq!(parse_stamp("soon"), None);
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }
}
