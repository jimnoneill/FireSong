//! FireSong noraebang background clips: a local pool of license-safe stock
//! videos that play behind the lyrics in noraebang mode.
//!
//! The pool is one flat directory, `FIRESONG_CLIP_DIR` or
//! `<data>/noraebang/clips` by default. Each clip is `<name>.mp4` or
//! `<name>.webm` next to a sidecar `<name>.json` that records its source and
//! licence (`scripts/firesong/fetch-clips.py` writes both). A clip is listed
//! only when its sidecar parses, its licence is on the allowlist
//! ([`ClipLicense`]) and its container signature matches the extension, so
//! the TV can only ever play footage whose licence was recorded as safe.
//!
//! The directory must resolve inside [`crate::local_media_roots`], because
//! the TV fetches clips through the same media routes as stems, and it must
//! not sit inside the background-videos cache, whose files Pixabay eviction
//! and "clear videos" delete.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Overrides the clip directory. Empty means unset.
pub const CLIP_DIR_ENV: &str = "FIRESONG_CLIP_DIR";

/// At most this many clips are listed (sorted by file name).
pub const MAX_CLIPS: usize = 500;

/// Larger files are skipped: clips are meant to be 20-60 s at 720p.
pub const MAX_CLIP_BYTES: u64 = 256 * 1024 * 1024;

/// Larger sidecars are skipped.
pub const MAX_SIDECAR_BYTES: u64 = 16 * 1024;

const MAX_TITLE_CHARS: usize = 200;
const MAX_SOURCE_CHARS: usize = 64;
const MAX_AUTHOR_CHARS: usize = 200;
const MAX_URL_CHARS: usize = 2048;
const MAX_TAGS: usize = 16;
const MAX_TAG_CHARS: usize = 32;

/// Licences a clip may carry. Anything else (including CC BY, which needs
/// visible attribution terms this pool does not track) is skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum ClipLicense {
    /// CC0 1.0 public-domain dedication.
    Cc0,
    /// Public domain (for example a Prelinger item marked public domain).
    PublicDomain,
    /// Pixabay Content License.
    Pixabay,
    /// Pexels License.
    Pexels,
    /// Made for FireSong (synthetic placeholders, own footage).
    Original,
}

/// Why the pool is empty, when it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum ClipDirStatus {
    Ok,
    Missing,
    NotADirectory,
    Symlink,
    OutsideMediaRoots,
    InsideVideosDir,
}

/// Sidecar `<name>.json` as written by `fetch-clips.py`.
#[derive(Debug, Clone, Deserialize)]
struct ClipSidecar {
    #[serde(default)]
    title: Option<String>,
    source: String,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    author: Option<String>,
    license: ClipLicense,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    duration_sec: Option<f64>,
}

/// One playable clip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct NoraebangClip {
    /// File name without extension; stable while the file keeps its name.
    pub id: String,
    /// Absolute server path, for the media routes (`/api/asset?path=`).
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// Where it came from: `pixabay`, `pexels`, `internet-archive`, `original`, ...
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub author: Option<String>,
    pub license: ClipLicense,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_sec: Option<f64>,
}

/// Result of `list_noraebang_clips`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct NoraebangClips {
    pub status: ClipDirStatus,
    /// Sorted by file name. Randomising is the client's job.
    pub clips: Vec<NoraebangClip>,
    /// Video files that were not listed (no or bad sidecar, licence, signature, size).
    pub skipped: u32,
}

impl NoraebangClips {
    fn empty(status: ClipDirStatus) -> Self {
        Self {
            status,
            clips: Vec::new(),
            skipped: 0,
        }
    }
}

/// The configured clip directory (not checked).
pub fn clip_dir() -> PathBuf {
    match std::env::var_os(CLIP_DIR_ENV) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => crate::cache::nightingale_dir()
            .join("noraebang")
            .join("clips"),
    }
}

/// Lists the clip pool for the TV. Never fails: problems give an empty list
/// with a [`ClipDirStatus`] or a `skipped` count.
pub fn list_noraebang_clips() -> NoraebangClips {
    scan_clip_dir(
        &clip_dir(),
        &crate::local_media_roots(),
        &crate::cache::videos_dir(),
    )
}

fn scan_clip_dir(dir: &Path, media_roots: &[PathBuf], videos_dir: &Path) -> NoraebangClips {
    let dir = match check_clip_dir(dir, media_roots, videos_dir) {
        Ok(dir) => dir,
        Err(status) => {
            tracing::debug!(?status, "noraebang clip directory unusable");
            return NoraebangClips::empty(status);
        }
    };

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return NoraebangClips::empty(ClipDirStatus::Missing);
    };
    let mut videos: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| video_extension(path).is_some())
        .collect();
    videos.sort();

    let mut result = NoraebangClips::empty(ClipDirStatus::Ok);
    for video in videos {
        if result.clips.len() >= MAX_CLIPS {
            result.skipped = result.skipped.saturating_add(1);
            continue;
        }
        match read_clip(&video) {
            Ok(clip) => result.clips.push(clip),
            Err(reason) => {
                tracing::debug!(file = ?video.file_name(), reason, "skipping noraebang clip");
                result.skipped = result.skipped.saturating_add(1);
            }
        }
    }
    result
}

fn check_clip_dir(
    dir: &Path,
    media_roots: &[PathBuf],
    videos_dir: &Path,
) -> Result<PathBuf, ClipDirStatus> {
    let metadata = std::fs::symlink_metadata(dir).map_err(|_| ClipDirStatus::Missing)?;
    if metadata.file_type().is_symlink() {
        return Err(ClipDirStatus::Symlink);
    }
    if !metadata.is_dir() {
        return Err(ClipDirStatus::NotADirectory);
    }
    let canonical = std::fs::canonicalize(dir).map_err(|_| ClipDirStatus::Missing)?;

    if std::fs::canonicalize(videos_dir).is_ok_and(|videos| canonical.starts_with(videos)) {
        return Err(ClipDirStatus::InsideVideosDir);
    }
    let inside_roots = media_roots
        .iter()
        .any(|root| std::fs::canonicalize(root).is_ok_and(|root| canonical.starts_with(root)));
    if !inside_roots {
        return Err(ClipDirStatus::OutsideMediaRoots);
    }
    Ok(canonical)
}

fn video_extension(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "mp4" => Some("mp4"),
        "webm" => Some("webm"),
        _ => None,
    }
}

fn read_clip(video: &Path) -> Result<NoraebangClip, &'static str> {
    let extension = video_extension(video).ok_or("not a video")?;
    let metadata = std::fs::symlink_metadata(video).map_err(|_| "unreadable")?;
    if !metadata.file_type().is_file() {
        return Err("not a regular file");
    }
    if metadata.len() == 0 || metadata.len() > MAX_CLIP_BYTES {
        return Err("size out of range");
    }
    let prefix = read_prefix(video, 12)?;
    if !video_signature_matches(extension, &prefix) {
        return Err("container signature does not match the extension");
    }

    let sidecar_path = video.with_extension("json");
    let sidecar_metadata = std::fs::symlink_metadata(&sidecar_path).map_err(|_| "no sidecar")?;
    if !sidecar_metadata.file_type().is_file() || sidecar_metadata.len() > MAX_SIDECAR_BYTES {
        return Err("sidecar is not a small regular file");
    }
    let sidecar_bytes = read_prefix(&sidecar_path, MAX_SIDECAR_BYTES)?;
    let sidecar: ClipSidecar =
        serde_json::from_slice(&sidecar_bytes).map_err(|_| "sidecar is not valid")?;

    let id = video
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("file name is not UTF-8")?
        .to_string();
    let path = video.to_str().ok_or("path is not UTF-8")?.to_string();
    clip_from_sidecar(id, path, sidecar)
}

fn clip_from_sidecar(
    id: String,
    path: String,
    sidecar: ClipSidecar,
) -> Result<NoraebangClip, &'static str> {
    let source = sidecar.source.trim().to_string();
    if source.is_empty() || !plain_text_within(&source, MAX_SOURCE_CHARS) {
        return Err("bad source");
    }
    let title = optional_text(sidecar.title, MAX_TITLE_CHARS).ok_or("bad title")?;
    let author = optional_text(sidecar.author, MAX_AUTHOR_CHARS).ok_or("bad author")?;
    let source_url = match sidecar.source_url {
        None => None,
        Some(url) if is_web_url(&url) => Some(url),
        Some(_) => return Err("bad source_url"),
    };
    if sidecar.tags.len() > MAX_TAGS
        || sidecar
            .tags
            .iter()
            .any(|tag| tag.is_empty() || !plain_text_within(tag, MAX_TAG_CHARS))
    {
        return Err("bad tags");
    }
    let duration_sec = match sidecar.duration_sec {
        None => None,
        Some(duration) if duration.is_finite() && duration > 0.0 => Some(duration),
        Some(_) => return Err("bad duration_sec"),
    };

    Ok(NoraebangClip {
        id,
        path,
        title,
        source,
        source_url,
        author,
        license: sidecar.license,
        tags: sidecar.tags,
        duration_sec,
    })
}

/// `None` = invalid; `Some(None)` = absent or blank.
fn optional_text(value: Option<String>, max_chars: usize) -> Option<Option<String>> {
    match value.map(|text| text.trim().to_string()) {
        None => Some(None),
        Some(text) if text.is_empty() => Some(None),
        Some(text) if plain_text_within(&text, max_chars) => Some(Some(text)),
        Some(_) => None,
    }
}

fn plain_text_within(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars && !text.chars().any(char::is_control)
}

fn is_web_url(url: &str) -> bool {
    url.len() <= MAX_URL_CHARS
        && url::Url::parse(url).is_ok_and(|parsed| matches!(parsed.scheme(), "https" | "http"))
}

fn read_prefix(path: &Path, limit: u64) -> Result<Vec<u8>, &'static str> {
    let file = File::open(path).map_err(|_| "unreadable")?;
    let mut bytes = Vec::new();
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable")?;
    Ok(bytes)
}

fn video_signature_matches(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "mp4" => bytes.get(4..8) == Some(b"ftyp"),
        "webm" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use serde_json::json;

    use super::*;

    const MP4_HEADER: &[u8] = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00";
    const WEBM_HEADER: &[u8] = &[0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00];

    /// A scratch tree `<tmp>/<unique>/{data,videos}` removed on drop.
    struct Scratch {
        root: PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let root = std::env::temp_dir().join(format!(
                "firesong-clips-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(root.join("data/noraebang/clips")).expect("scratch dir");
            std::fs::create_dir_all(root.join("data/videos")).expect("scratch videos");
            Self { root }
        }

        fn data(&self) -> PathBuf {
            self.root.join("data")
        }

        fn clips(&self) -> PathBuf {
            self.root.join("data/noraebang/clips")
        }

        fn videos(&self) -> PathBuf {
            self.root.join("data/videos")
        }

        fn scan(&self) -> NoraebangClips {
            scan_clip_dir(&self.clips(), &[self.data()], &self.videos())
        }

        fn write(&self, name: &str, bytes: &[u8]) {
            std::fs::write(self.clips().join(name), bytes).expect("write scratch file");
        }

        fn write_sidecar(&self, name: &str, value: &serde_json::Value) {
            self.write(name, value.to_string().as_bytes());
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn sidecar(license: &str) -> serde_json::Value {
        json!({
            "title": "Sunset beach run",
            "source": "pixabay",
            "source_url": "https://pixabay.com/videos/id-1/",
            "author": "someone",
            "license": license,
            "tags": ["beach", "sunset"],
            "duration_sec": 31.5,
        })
    }

    #[test]
    fn lists_clips_with_allowed_licences_sorted_by_name() {
        let scratch = Scratch::new();
        scratch.write("b-beach.mp4", MP4_HEADER);
        scratch.write_sidecar("b-beach.json", &sidecar("pixabay"));
        scratch.write("a-waves.webm", WEBM_HEADER);
        scratch.write_sidecar("a-waves.json", &sidecar("cc0"));
        scratch.write("c-placeholder.mp4", MP4_HEADER);
        scratch.write_sidecar(
            "c-placeholder.json",
            &json!({"source": "original", "license": "original"}),
        );

        let listed = scratch.scan();
        assert_eq!(listed.status, ClipDirStatus::Ok);
        assert_eq!(listed.skipped, 0);
        let ids: Vec<_> = listed.clips.iter().map(|clip| clip.id.as_str()).collect();
        assert_eq!(ids, ["a-waves", "b-beach", "c-placeholder"]);

        let beach = &listed.clips[1];
        assert_eq!(beach.license, ClipLicense::Pixabay);
        assert_eq!(beach.duration_sec, Some(31.5));
        assert_eq!(beach.tags, ["beach", "sunset"]);
        assert!(beach.path.ends_with("b-beach.mp4"));
        assert_eq!(listed.clips[2].title, None);
    }

    #[test]
    fn skips_clips_without_a_safe_sidecar() {
        let scratch = Scratch::new();
        // No sidecar.
        scratch.write("no-sidecar.mp4", MP4_HEADER);
        // Licence outside the allowlist.
        scratch.write("cc-by.mp4", MP4_HEADER);
        scratch.write_sidecar("cc-by.json", &sidecar("cc-by-4.0"));
        // Sidecar is not JSON.
        scratch.write("garbled.mp4", MP4_HEADER);
        scratch.write("garbled.json", b"{not json");
        // Bad URL scheme.
        scratch.write("bad-url.mp4", MP4_HEADER);
        let mut bad_url = sidecar("cc0");
        bad_url["source_url"] = json!("javascript:alert(1)");
        scratch.write_sidecar("bad-url.json", &bad_url);
        // Control characters in a tag.
        scratch.write("bad-tag.mp4", MP4_HEADER);
        let mut bad_tag = sidecar("cc0");
        bad_tag["tags"] = json!(["ok", "line\nbreak"]);
        scratch.write_sidecar("bad-tag.json", &bad_tag);
        // Oversized sidecar.
        scratch.write("huge.mp4", MP4_HEADER);
        let mut huge = sidecar("cc0");
        huge["title"] = json!("x".repeat(MAX_SIDECAR_BYTES as usize));
        scratch.write_sidecar("huge.json", &huge);

        let listed = scratch.scan();
        assert_eq!(listed.status, ClipDirStatus::Ok);
        assert!(listed.clips.is_empty(), "{:?}", listed.clips);
        assert_eq!(listed.skipped, 6);
    }

    #[test]
    fn skips_files_whose_signature_does_not_match() {
        let scratch = Scratch::new();
        scratch.write("fake.mp4", b"<html>not a video</html>");
        scratch.write_sidecar("fake.json", &sidecar("cc0"));
        scratch.write("swapped.webm", MP4_HEADER);
        scratch.write_sidecar("swapped.json", &sidecar("cc0"));
        scratch.write("empty.mp4", b"");
        scratch.write_sidecar("empty.json", &sidecar("cc0"));
        // Not a video at all: ignored, not counted.
        scratch.write("notes.txt", b"hello");

        let listed = scratch.scan();
        assert!(listed.clips.is_empty());
        assert_eq!(listed.skipped, 3);
    }

    #[test]
    fn missing_directory_is_reported_not_fatal() {
        let scratch = Scratch::new();
        let listed = scan_clip_dir(
            &scratch.root.join("nope"),
            &[scratch.data()],
            &scratch.videos(),
        );
        assert_eq!(listed, NoraebangClips::empty(ClipDirStatus::Missing));

        scratch.write("file-not-dir", b"x");
        let listed = scan_clip_dir(
            &scratch.clips().join("file-not-dir"),
            &[scratch.data()],
            &scratch.videos(),
        );
        assert_eq!(listed.status, ClipDirStatus::NotADirectory);
    }

    #[test]
    fn directory_must_be_served_and_outside_the_videos_cache() {
        let scratch = Scratch::new();
        scratch.write("a.mp4", MP4_HEADER);
        scratch.write_sidecar("a.json", &sidecar("cc0"));

        let outside = scan_clip_dir(
            &scratch.clips(),
            &[scratch.root.join("elsewhere")],
            &scratch.videos(),
        );
        assert_eq!(outside.status, ClipDirStatus::OutsideMediaRoots);
        assert!(outside.clips.is_empty());

        let in_videos = scratch.videos().join("clips");
        std::fs::create_dir_all(&in_videos).expect("videos/clips");
        let listed = scan_clip_dir(&in_videos, &[scratch.data()], &scratch.videos());
        assert_eq!(listed.status, ClipDirStatus::InsideVideosDir);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_and_clips_are_refused() {
        let scratch = Scratch::new();
        let real = scratch.data().join("real-clips");
        std::fs::create_dir_all(&real).expect("real clips");
        let link = scratch.data().join("linked-clips");
        std::os::unix::fs::symlink(&real, &link).expect("symlink dir");
        let listed = scan_clip_dir(&link, &[scratch.data()], &scratch.videos());
        assert_eq!(listed.status, ClipDirStatus::Symlink);

        std::fs::write(real.join("target.mp4"), MP4_HEADER).expect("target clip");
        std::os::unix::fs::symlink(real.join("target.mp4"), scratch.clips().join("linked.mp4"))
            .expect("symlink clip");
        scratch.write_sidecar("linked.json", &sidecar("cc0"));
        let listed = scratch.scan();
        assert!(listed.clips.is_empty());
        assert_eq!(listed.skipped, 1);
    }

    #[test]
    fn clip_dir_defaults_under_the_data_dir() {
        // The env override is process-global, so only the default shape is
        // checked here, and only when no override is set.
        if std::env::var_os(CLIP_DIR_ENV).is_none() {
            assert!(clip_dir().ends_with("noraebang/clips"));
        }
    }

    #[test]
    fn licence_names_are_kebab_case_on_the_wire() {
        let names: Vec<_> = [
            ClipLicense::Cc0,
            ClipLicense::PublicDomain,
            ClipLicense::Pixabay,
            ClipLicense::Pexels,
            ClipLicense::Original,
        ]
        .iter()
        .map(|license| serde_json::to_value(license).unwrap_or_default())
        .collect();
        assert_eq!(
            names,
            [
                json!("cc0"),
                json!("public-domain"),
                json!("pixabay"),
                json!("pexels"),
                json!("original")
            ]
        );
    }
}
