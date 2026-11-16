//! FireSong party state on the command state (PROTOCOL.md §13): the
//! reservation book the `/rtc` hub drives, its live library, playback-queue
//! and analyzer ports, and the phone's song book command (§13.11).

use std::cmp::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use app_core::party::{
    AnalysisPort, AnalysisView, JobState, LibraryPort, PartyBook, QueuedSong, SongFacts,
};
use app_core::remote_mic::{
    BookSong, MAX_KEY_OFFSET, MAX_TEMPO, MIN_KEY_OFFSET, MIN_TEMPO, PrepStage, PrepState,
    SongBookPage, SongBookQuery,
};
use app_core::{
    AnalysisQueue, LibraryMenuFilters, LoadSongsParams, PlaybackQueue, PlaybackQueueEntry,
    QueuedStatus, Song, SongSort, SongSortColumn, SongTarget, SongsStore, SortDirection,
};
use serde_json::Value;

use crate::{
    ApiError, CmdResult, CommandRuntime, CommandState, EventEmitter, blocking_task_err,
    deserialize, serde_err,
};

/// Rows read per query while collecting songs that sit in the analysis queue.
const QUEUE_ROWS_PAGE: usize = 500;

/// The party book with the ports it works through.
pub struct Party {
    book: Mutex<PartyBook>,
    analysis: Mutex<Arc<dyn AnalysisPort>>,
    library: LiveLibrary,
}

impl CommandState {
    pub fn party(&self) -> &Arc<Party> {
        &self.party
    }
}

impl Party {
    pub(crate) fn new(queue: Arc<PlaybackQueue>, runtime: Arc<dyn CommandRuntime>) -> Self {
        Self {
            book: Mutex::new(PartyBook::default()),
            analysis: Mutex::new(Arc::new(Analyzer)),
            library: LiveLibrary {
                queue,
                events: EventEmitter(runtime),
            },
        }
    }

    /// Replaces the analyzer port (tests drive preparation with a fake).
    pub fn set_analysis(&self, analysis: Arc<dyn AnalysisPort>) {
        *lock(&self.analysis) = analysis;
    }

    fn analysis(&self) -> Arc<dyn AnalysisPort> {
        lock(&self.analysis).clone()
    }

    /// Runs `work` on the book with the live library and the analyzer.
    pub fn with<T>(
        &self,
        work: impl FnOnce(&mut PartyBook, &dyn LibraryPort, &dyn AnalysisPort) -> T,
    ) -> T {
        let analysis = self.analysis();
        let mut book = lock(&self.book);
        work(&mut book, &self.library, analysis.as_ref())
    }

    /// One page of the song book: ready songs first, then the rest, each part
    /// by title (ASCII case folded, as SQLite's NOCASE) and then library order.
    fn song_book(&self, query: &SongBookQuery) -> SongBookPage {
        let skip = query.skip as usize;
        let take = query.take as usize;
        let search = query
            .search
            .as_deref()
            .map(str::trim)
            .filter(|search| !search.is_empty())
            .map(str::to_owned);
        let load = |filters: LibraryMenuFilters, skip: usize, take: usize| {
            SongsStore::load(&LoadSongsParams {
                search: search.clone(),
                filters,
                sort: Some(vec![SongSort {
                    column: SongSortColumn::Title,
                    direction: SortDirection::Ascending,
                }]),
                skip,
                take,
            })
        };
        let filters = |query: Option<&str>, status: Option<&str>| LibraryMenuFilters {
            query: query.map(str::to_owned),
            status: status.map(str::to_owned),
            ..LibraryMenuFilters::default()
        };

        let ready = load(filters(Some("analysed"), None), skip, take);
        let ready_total = ready.processed_count;
        let mut songs: Vec<Song> = if skip < ready_total {
            ready.processed
        } else {
            Vec::new()
        };

        // Not ready = never queued (paged in SQL, title order) plus the few
        // songs with an analysis-queue row, merged by the same order.
        let mut in_queue: Vec<Song> =
            [filters(Some("queued"), None), filters(None, Some("failed"))]
                .into_iter()
                .flat_map(|filters| {
                    let mut found = Vec::new();
                    loop {
                        let page = load(filters.clone(), found.len(), QUEUE_ROWS_PAGE).processed;
                        let done = page.len() < QUEUE_ROWS_PAGE;
                        found.extend(page);
                        if done {
                            break found;
                        }
                    }
                })
                .filter(|song| !song.is_analyzed)
                .collect();
        in_queue.sort_by(|left, right| {
            book_order(left, right).then_with(|| left.file_hash.cmp(&right.file_hash))
        });
        in_queue.dedup_by(|left, right| left.file_hash == right.file_hash);

        let unqueued = || filters(None, Some("not_analyzed"));
        let unqueued_total = load(unqueued(), 0, 1).processed_count;
        let missing = take.saturating_sub(songs.len());
        if missing > 0 {
            let rest_skip = skip.saturating_sub(ready_total);
            songs.extend(merged_page(rest_skip, missing, &in_queue, |skip, take| {
                load(unqueued(), skip, take).processed
            }));
        }

        let view = self.analysis().view();
        let book = lock(&self.book);
        let items = songs
            .iter()
            .map(|song| BookSong {
                file_hash: song.file_hash.clone(),
                title: song.title.clone(),
                artist: song.artist.clone(),
                duration_secs: song.duration_secs.max(0.0),
                shiftable: is_shiftable(song),
                prep: if song.is_analyzed {
                    PrepState {
                        state: PrepStage::Ready,
                        pct: None,
                        eta_secs: None,
                    }
                } else {
                    book.book_prep(&view, &song.file_hash)
                },
            })
            .collect();
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        SongBookPage {
            items,
            skip: query.skip,
            total: count(ready_total + unqueued_total + in_queue.len()),
            ready_total: count(ready_total),
        }
    }
}

fn lock<T: ?Sized>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The library's title order: SQLite NOCASE folds ASCII letters only.
fn book_order(left: &Song, right: &Song) -> Ordering {
    left.title
        .to_ascii_lowercase()
        .cmp(&right.title.to_ascii_lowercase())
}

/// Positions `skip..skip + take` of the merge of a SQL-paged list (`load`,
/// already in book order) with a short sorted list `extra`. Ties put the
/// paged list first. At most `extra.len()` extra songs can sit before any
/// position, so a window that many songs earlier is enough.
fn merged_page(
    skip: usize,
    take: usize,
    extra: &[Song],
    load: impl Fn(usize, usize) -> Vec<Song>,
) -> Vec<Song> {
    let start = skip.saturating_sub(extra.len());
    let window = load(start, take + extra.len());
    let before = match window.first() {
        _ if start == 0 => 0,
        Some(pivot) => extra
            .iter()
            .take_while(|song| book_order(song, pivot) == Ordering::Less)
            .count(),
        None => extra.len(),
    };
    let mut merged = Vec::with_capacity(window.len() + extra.len() - before);
    let mut extra = extra[before..].iter().peekable();
    for song in window {
        while let Some(next) = extra.next_if(|next| book_order(next, &song) == Ordering::Less) {
            merged.push(next.clone());
        }
        merged.push(song);
    }
    merged.extend(extra.cloned());
    merged
        .into_iter()
        .skip(skip - (start + before))
        .take(take)
        .collect()
}

fn is_shiftable(song: &Song) -> bool {
    song.key.is_some() && song.usdx.is_none()
}

fn facts(song: &Song) -> SongFacts {
    SongFacts {
        file_hash: song.file_hash.clone(),
        title: song.title.clone(),
        artist: song.artist.clone(),
        duration_secs: song.duration_secs.max(0.0),
        analyzed: song.is_analyzed,
        shiftable: is_shiftable(song),
    }
}

/// `firesong_song_book`: read-only, on either listener.
pub(crate) async fn song_book_cmd(state: &CommandState, payload: Value) -> CmdResult {
    let query: SongBookQuery = deserialize(payload)?;
    query.validate().map_err(ApiError::bad_request)?;
    let party = state.party.clone();
    let page = tokio::task::spawn_blocking(move || party.song_book(&query))
        .await
        .map_err(blocking_task_err)?;
    serde_json::to_value(page).map_err(serde_err)
}

/// The library and the shared playback queue. Every queue change is
/// announced like the queue commands do, so the TV and `/q` follow it.
struct LiveLibrary {
    queue: Arc<PlaybackQueue>,
    events: EventEmitter,
}

impl LiveLibrary {
    fn changed(&self, entries: &[PlaybackQueueEntry]) {
        self.events.emit("playback-queue-changed", &entries);
    }
}

impl LibraryPort for LiveLibrary {
    fn songs(&self, file_hashes: &[String]) -> Vec<SongFacts> {
        SongsStore::load_by_hashes(file_hashes)
            .iter()
            .map(facts)
            .collect()
    }

    fn entries(&self) -> Vec<QueuedSong> {
        self.queue
            .entries()
            .unwrap_or_default()
            .iter()
            .map(|entry| QueuedSong {
                entry_id: entry.id.clone(),
                // Host entries are not limited to the phone's ranges.
                key_offset: i8::try_from(
                    entry
                        .key_offset
                        .clamp(i32::from(MIN_KEY_OFFSET), i32::from(MAX_KEY_OFFSET)),
                )
                .unwrap_or(0),
                tempo: if entry.tempo.is_finite() {
                    entry.tempo.clamp(MIN_TEMPO, MAX_TEMPO)
                } else {
                    1.0
                },
                song: facts(&entry.song),
            })
            .collect()
    }

    fn insert(
        &self,
        file_hash: &str,
        key_offset: i8,
        tempo: f64,
        index: usize,
    ) -> Result<String, String> {
        let mut entries = self
            .queue
            .add(file_hash, tempo, i32::from(key_offset), false)?;
        let id = entries
            .last()
            .map(|entry| entry.id.clone())
            .ok_or_else(|| "queue entry not found".to_string())?;
        if index + 1 < entries.len() {
            entries = self.queue.move_entry(&id, index)?;
        }
        self.changed(&entries);
        Ok(id)
    }

    fn move_to(&self, entry_id: &str, index: usize) -> Result<(), String> {
        let entries = self.queue.move_entry(entry_id, index)?;
        self.changed(&entries);
        Ok(())
    }

    fn remove(&self, entry_id: &str) {
        if let Ok(entries) = self.queue.remove(entry_id) {
            self.changed(&entries);
        }
    }

    fn set_shift(&self, entry_id: &str, key_offset: i8, tempo: f64) -> Result<(), String> {
        let entries = self
            .queue
            .set_shift(entry_id, tempo, i32::from(key_offset))?;
        self.changed(&entries);
        Ok(())
    }
}

/// The real analyzer: its queue rows, its worker and the GPU gate.
struct Analyzer;

impl AnalysisPort for Analyzer {
    fn view(&self) -> AnalysisView {
        let worker = app_core::analyzer_view();
        let jobs = AnalysisQueue::load()
            .entries
            .into_iter()
            .map(|(hash, status)| {
                let job = match status {
                    QueuedStatus::Queued => JobState::Queued,
                    QueuedStatus::Analyzing(pct) => {
                        JobState::Analyzing(u8::try_from(pct.min(100)).unwrap_or(100))
                    }
                    QueuedStatus::Failed(_) => JobState::Failed,
                };
                (hash, job)
            })
            .collect();
        AnalysisView {
            jobs,
            active: worker.active,
            waiting: worker.waiting,
            waiting_gpu: worker.waiting_gpu,
        }
    }

    fn enqueue(&self, file_hash: &str) -> Result<(), String> {
        app_core::enqueue_urgent(file_hash);
        Ok(())
    }

    fn cancel(&self, file_hash: &str) {
        let _ = app_core::cancel_analysis(SongTarget::Hashes {
            hashes: vec![file_hash.to_string()],
        });
    }

    fn rekeyed(&self, file_hash: &str) -> Option<String> {
        app_core::rekeyed_hash(file_hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(title: &str, hash: u32) -> Song {
        serde_json::from_value(serde_json::json!({
            "path": format!("/music/{hash}.mp3"),
            "file_hash": format!("{hash:032x}"),
            "title": title,
            "artist": "Artist",
            "album": "Album",
            "duration_secs": 200.0,
            "album_art_path": null,
            "is_analyzed": false,
            "language": null,
            "is_video": false,
        }))
        .expect("song fixture")
    }

    fn titles(songs: &[Song]) -> Vec<String> {
        songs.iter().map(|song| song.title.clone()).collect()
    }

    #[test]
    fn queued_songs_merge_into_the_paged_list_in_title_order() {
        let paged: Vec<Song> = ["a", "C", "e", "g", "i", "k"]
            .iter()
            .zip(1..)
            .map(|(title, hash)| song(title, hash))
            .collect();
        let extra: Vec<Song> = ["b", "E", "z"]
            .iter()
            .zip(100..)
            .map(|(title, hash)| song(title, hash))
            .collect();
        let load = |skip: usize, take: usize| paged.iter().skip(skip).take(take).cloned().collect();
        let all = ["a", "b", "C", "e", "E", "g", "i", "k", "z"];

        for skip in 0..=all.len() {
            for take in 1..=4 {
                let expected: Vec<String> = all
                    .iter()
                    .skip(skip)
                    .take(take)
                    .map(|title| (*title).to_string())
                    .collect();
                assert_eq!(
                    titles(&merged_page(skip, take, &extra, load)),
                    expected,
                    "skip {skip} take {take}"
                );
            }
        }
        assert_eq!(titles(&merged_page(0, 3, &[], load)), ["a", "C", "e"]);
    }
}
