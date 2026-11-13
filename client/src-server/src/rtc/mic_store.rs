//! `<data>/firesong/remote-mics.json`: what the TV learned about each phone
//! (name, calibrated latency), keyed by its public `micId`. Never holds a
//! `resumeKey` or any token.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use app_core::remote_mic::{is_valid_mic_id, is_valid_name, LatencyMethod, MAX_LATENCY_MS};
use serde::{Deserialize, Serialize};

const FILE_VERSION: u32 = 1;
const MAX_MICS: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MicRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) latency_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) latency_method: Option<LatencyMethod>,
    #[serde(default)]
    pub(crate) updated_at_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default)]
    mics: BTreeMap<String, MicRecord>,
}

/// In-memory copy plus an ordered writer: every change bumps `revision`, and a
/// write only lands when it is newer than the last one written, so writes that
/// race on the blocking pool can never put an older snapshot back.
pub(crate) struct MicStore {
    path: Option<PathBuf>,
    mics: BTreeMap<String, MicRecord>,
    revision: u64,
    written: Arc<Mutex<u64>>,
}

impl MicStore {
    /// No path: memory only (the desktop adapter's phone surface).
    pub(crate) fn in_memory() -> Self {
        Self {
            path: None,
            mics: BTreeMap::new(),
            revision: 0,
            written: Arc::default(),
        }
    }

    /// An unreadable or malformed file is logged and treated as empty.
    pub(crate) fn load(path: PathBuf) -> Self {
        let mics = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<StoreFile>(&raw) {
                Ok(file) if file.version == FILE_VERSION => sanitize(file.mics),
                Ok(file) => {
                    tracing::warn!(
                        version = file.version,
                        "ignoring remote-mics.json with an unknown version"
                    );
                    BTreeMap::new()
                }
                Err(error) => {
                    tracing::warn!("ignoring unreadable remote-mics.json: {error}");
                    BTreeMap::new()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => {
                tracing::warn!("cannot read remote-mics.json: {error}");
                BTreeMap::new()
            }
        };
        Self {
            path: Some(path),
            mics,
            revision: 0,
            written: Arc::default(),
        }
    }

    pub(crate) fn get(&self, mic_id: &str) -> Option<&MicRecord> {
        self.mics.get(mic_id)
    }

    pub(crate) fn set_name(&mut self, mic_id: &str, name: &str) {
        if self.get(mic_id).and_then(|record| record.name.as_deref()) == Some(name) {
            return;
        }
        self.update(mic_id, |record| record.name = Some(name.to_string()));
    }

    pub(crate) fn set_latency(&mut self, mic_id: &str, latency_ms: u32, method: LatencyMethod) {
        self.update(mic_id, |record| {
            record.latency_ms = Some(latency_ms);
            record.latency_method = Some(method);
        });
    }

    fn update(&mut self, mic_id: &str, change: impl FnOnce(&mut MicRecord)) {
        let record = self.mics.entry(mic_id.to_string()).or_default();
        change(record);
        record.updated_at_ms = now_ms();
        prune(&mut self.mics);
        self.revision += 1;
        self.persist();
    }

    fn persist(&self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        let file = StoreFile {
            version: FILE_VERSION,
            mics: self.mics.clone(),
        };
        let revision = self.revision;
        let written = self.written.clone();
        let job = move || write_if_newer(&path, &file, revision, &written);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(job);
            }
            Err(_) => job(),
        }
    }
}

fn write_if_newer(path: &Path, file: &StoreFile, revision: u64, written: &Mutex<u64>) {
    let mut last = written.lock().unwrap_or_else(PoisonError::into_inner);
    if revision <= *last {
        return;
    }
    match write_atomic(path, file) {
        Ok(()) => *last = revision,
        Err(error) => tracing::warn!("cannot write remote-mics.json: {error}"),
    }
}

fn write_atomic(path: &Path, file: &StoreFile) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(file).map_err(std::io::Error::other)?;
    let temporary = path.with_extension("json.part");
    let result = std::fs::write(&temporary, json).and_then(|()| std::fs::rename(&temporary, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Drops entries a hand edit or an older build could have left invalid.
fn sanitize(mics: BTreeMap<String, MicRecord>) -> BTreeMap<String, MicRecord> {
    let mut mics: BTreeMap<String, MicRecord> = mics
        .into_iter()
        .filter(|(mic_id, _)| is_valid_mic_id(mic_id))
        .map(|(mic_id, mut record)| {
            record.name = record
                .name
                .filter(|name| is_valid_name(name))
                .map(|name| name.trim().to_string());
            if record
                .latency_ms
                .is_some_and(|latency| latency > MAX_LATENCY_MS)
            {
                record.latency_ms = None;
                record.latency_method = None;
            }
            (mic_id, record)
        })
        .collect();
    prune(&mut mics);
    mics
}

/// Keeps the [`MAX_MICS`] most recently updated phones.
fn prune(mics: &mut BTreeMap<String, MicRecord>) {
    while mics.len() > MAX_MICS {
        let Some(oldest) = mics
            .iter()
            .min_by_key(|(_, record)| record.updated_at_ms)
            .map(|(mic_id, _)| mic_id.clone())
        else {
            return;
        };
        mics.remove(&oldest);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
