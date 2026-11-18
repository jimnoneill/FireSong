//! FireSong party queue (PROTOCOL.md §13.9-§13.12, PHONE-V2.md features 2, 3
//! and 6): reservations kept beside the upstream playback queue, where new
//! ones go, preparation on demand with its estimates, the phone-remote rules
//! and tonight's scoreboard.
//!
//! Platform-neutral: the library and the playback queue come in through
//! [`LibraryPort`], the analyzer through [`AnalysisPort`], time as arguments.
//! Phones are named by `micId`; the caller maps them to slots.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use tracing::warn;

use crate::remote_mic::{
    DEFAULT_PREP_SECS, MAX_NIGHT_SCORES, MAX_PARTY_QUEUE_ITEMS, MAX_PREPARING_PER_SLOT,
    MAX_PREPARING_TOTAL, MAX_RESERVATIONS_PER_SLOT, MAX_SING_NEXT_PER_SLOT,
    NIGHT_SCORE_MAX_AGE_SECS, NightScore, PartyAction, PartyErrorCode, PartyItem, PrepStage,
    PrepState, StageKind,
};

/// Analysis times kept for the estimate ("tonight's last 5").
const PREP_SAMPLES: usize = 5;
/// Estimates are rounded up to a multiple of this.
const ETA_STEP_SECS: u32 = 10;
/// Polls in a row that may find a preparing song neither analysed nor known to
/// the analyzer before it counts as failed: a remote song's rekey can land
/// between two reads.
const MISSING_POLLS: u8 = 2;
/// A guest's song still analysing this long after it started is given up and
/// its singers are told; the analysis may still finish for the song book.
const STUCK_ANALYSIS: Duration = Duration::from_secs(180);
/// Items whose entry left the playback queue (the TV took it to play),
/// remembered so a `stage` naming that entry still finds its reservation.
const RECENT_ITEMS: usize = 8;

/// What the party needs to know about one library song.
#[derive(Debug, Clone, PartialEq)]
pub struct SongFacts {
    pub file_hash: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: f64,
    pub analyzed: bool,
    /// A detected key and not USDX: key and tempo can be changed.
    pub shiftable: bool,
}

/// One upstream playback-queue entry.
#[derive(Debug, Clone, PartialEq)]
pub struct QueuedSong {
    pub entry_id: String,
    pub key_offset: i8,
    pub tempo: f64,
    pub song: SongFacts,
}

/// The library and the upstream playback queue, in play order.
pub trait LibraryPort {
    fn songs(&self, file_hashes: &[String]) -> Vec<SongFacts>;
    fn entries(&self) -> Vec<QueuedSong>;
    /// Adds an analysed song at `index` and returns the new entry id.
    fn insert(
        &self,
        file_hash: &str,
        key_offset: i8,
        tempo: f64,
        index: usize,
    ) -> Result<String, String>;
    fn move_to(&self, entry_id: &str, index: usize) -> Result<(), String>;
    fn remove(&self, entry_id: &str);
    fn set_shift(&self, entry_id: &str, key_offset: i8, tempo: f64) -> Result<(), String>;
}

/// One analysis job as the analyzer reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Analyzing(u8),
    Failed,
}

/// The analyzer's queue at one moment.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnalysisView {
    pub jobs: HashMap<String, JobState>,
    /// The job the worker runs now.
    pub active: Option<String>,
    /// Jobs behind it, in the order the worker takes them.
    pub waiting: Vec<String>,
    /// The worker holds its next job because the GPU is reserved or short of
    /// memory.
    pub waiting_gpu: bool,
}

/// The analyzer, as the party uses it.
pub trait AnalysisPort: Send + Sync {
    fn view(&self) -> AnalysisView;
    fn enqueue(&self, file_hash: &str) -> Result<(), String>;
    fn cancel(&self, file_hash: &str);
    /// The hash a remote song moved to when it was downloaded, if it did.
    fn rekeyed(&self, file_hash: &str) -> Option<String>;
}

/// A `reserve` request, with the sender and partners already named by
/// `micId` and checked to be other occupied slots.
#[derive(Debug, Clone, PartialEq)]
pub struct Reserve {
    pub owner: String,
    pub partners: Vec<String>,
    pub file_hash: String,
    pub key_offset: i8,
    pub tempo: f64,
    pub sing_next: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reserved {
    pub reservation_id: String,
    pub title: String,
}

/// The fields of an `edit` request; at least one is set.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Edit {
    pub key_offset: Option<i8>,
    pub tempo: Option<f64>,
    pub sing_next: Option<bool>,
}

/// A preparation that failed or vanished: its item was dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepFailed {
    /// Owner first.
    pub singers: Vec<String>,
    pub title: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Poll {
    /// Anything a snapshot shows changed.
    pub changed: bool,
    pub failed: Vec<PrepFailed>,
}

/// The reservation behind a playback-queue entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageItem {
    pub reservation_id: String,
    pub shiftable: bool,
}

#[derive(Debug, Clone)]
struct Item {
    id: String,
    seq: u64,
    file_hash: String,
    /// `None` for songs the host queued.
    owner: Option<String>,
    partners: Vec<String>,
    key_offset: i8,
    tempo: f64,
    sing_next: bool,
    title: String,
    artist: String,
    duration_secs: f64,
    shiftable: bool,
    state: ItemState,
}

#[derive(Debug, Clone)]
enum ItemState {
    Ready { entry_id: String },
    Preparing(Prep),
}

#[derive(Debug, Clone, Default)]
struct Prep {
    /// This item queued the analysis (rather than joining one).
    started_analysis: bool,
    analyzing_since: Option<Instant>,
    missing_polls: u8,
}

impl Item {
    fn entry_id(&self) -> Option<&str> {
        match &self.state {
            ItemState::Ready { entry_id } => Some(entry_id),
            ItemState::Preparing(_) => None,
        }
    }

    fn prep(&self) -> Option<&Prep> {
        match &self.state {
            ItemState::Preparing(prep) => Some(prep),
            ItemState::Ready { .. } => None,
        }
    }

    fn key(&self) -> (u8, u64) {
        order_key(self.sing_next, self.seq)
    }

    fn sings(&self, mic_id: &str) -> bool {
        self.owner.as_deref() == Some(mic_id) || self.partners.iter().any(|mic| mic == mic_id)
    }

    fn singers(&self) -> Vec<String> {
        self.owner.iter().chain(&self.partners).cloned().collect()
    }
}

#[derive(Debug, Clone)]
struct Played {
    entry_id: String,
    stage: StageItem,
}

/// Reservations and host-queued songs, in memory. One per server.
#[derive(Debug, Default)]
pub struct PartyBook {
    items: Vec<Item>,
    recent: VecDeque<Played>,
    next_seq: u64,
    next_id: u64,
    durations: VecDeque<Duration>,
    view: AnalysisView,
}

/// Play-order key: "sing next" items first, then reservation order.
fn order_key(sing_next: bool, seq: u64) -> (u8, u64) {
    (u8::from(!sing_next), seq)
}

/// Where a new, edited or newly ready item goes: before the first entry whose
/// key is greater. While the TV counts down to the head entry or starts it,
/// index 0 is off limits.
fn placement(keys: &[(u8, u64)], key: (u8, u64), protect_head: bool) -> usize {
    let index = keys
        .iter()
        .position(|other| *other > key)
        .unwrap_or(keys.len());
    if protect_head && index == 0 && !keys.is_empty() {
        1
    } else {
        index
    }
}

/// Index 0 of the playback queue is protected while the lobby counts down to
/// it or the TV is starting it.
pub fn protects_head(stage: StageKind, countdown_secs: Option<u32>) -> bool {
    match stage {
        StageKind::Starting => true,
        StageKind::Lobby => countdown_secs.is_some(),
        StageKind::Singing | StageKind::Paused | StageKind::Reveal => false,
    }
}

fn is_default_shift(key_offset: i8, tempo: f64) -> bool {
    key_offset == 0 && (tempo - 1.0).abs() < 1e-6
}

fn round_eta(secs: f64) -> u32 {
    let secs = secs.max(0.0).ceil() as u32;
    secs.div_ceil(ETA_STEP_SECS) * ETA_STEP_SECS
}

/// §13.7: pause, resume and stop belong to the current song's singers; in the
/// lobby, "start now" belongs to the first ready item's singers, or to anyone
/// when it has none. `first_ready` lists that item's slots.
pub fn check_control(
    action: PartyAction,
    slot: u8,
    stage: StageKind,
    stage_singers: &[u8],
    first_ready: Option<&[u8]>,
) -> Result<(), PartyErrorCode> {
    match action {
        PartyAction::Pause | PartyAction::Resume | PartyAction::Stop => {
            check_singer(slot, stage, stage_singers)
        }
        PartyAction::StartNow => {
            if stage != StageKind::Lobby {
                return Err(PartyErrorCode::Busy);
            }
            let singers = first_ready.ok_or(PartyErrorCode::NotFound)?;
            if singers.is_empty() || singers.contains(&slot) {
                Ok(())
            } else {
                Err(PartyErrorCode::NotAllowed)
            }
        }
    }
}

/// Remote control of the current song (pause, resume, stop, key and tempo):
/// only its singers, only while it is on.
pub fn check_singer(
    slot: u8,
    stage: StageKind,
    stage_singers: &[u8],
) -> Result<(), PartyErrorCode> {
    if !matches!(
        stage,
        StageKind::Starting | StageKind::Singing | StageKind::Paused
    ) {
        return Err(PartyErrorCode::Busy);
    }
    if stage_singers.contains(&slot) {
        Ok(())
    } else {
        Err(PartyErrorCode::NotAllowed)
    }
}

impl PartyBook {
    fn take_id(&mut self) -> String {
        self.next_id += 1;
        format!("r{}", self.next_id)
    }

    fn take_seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }

    /// Mean of the last analysis times, or the default before the first one.
    fn mean_prep_secs(&self) -> f64 {
        if self.durations.is_empty() {
            return f64::from(DEFAULT_PREP_SECS);
        }
        let total: f64 = self.durations.iter().map(Duration::as_secs_f64).sum();
        total / self.durations.len() as f64
    }

    /// Ready items whose entry left the queue were played or removed; entries
    /// nobody reserved are the host's and get the next `seq`.
    fn sync(&mut self, entries: &[QueuedSong]) {
        let live: HashSet<&str> = entries
            .iter()
            .map(|entry| entry.entry_id.as_str())
            .collect();
        let (kept, gone): (Vec<Item>, Vec<Item>) = std::mem::take(&mut self.items)
            .into_iter()
            .partition(|item| item.entry_id().is_none_or(|id| live.contains(id)));
        self.items = kept;
        for item in gone {
            self.remember(&item);
        }
        for entry in entries {
            if self
                .items
                .iter()
                .any(|item| item.entry_id() == Some(entry.entry_id.as_str()))
            {
                continue;
            }
            let id = self.take_id();
            let seq = self.take_seq();
            self.items.push(Item {
                id,
                seq,
                file_hash: entry.song.file_hash.clone(),
                owner: None,
                partners: Vec::new(),
                key_offset: entry.key_offset,
                tempo: entry.tempo,
                sing_next: false,
                title: entry.song.title.clone(),
                artist: entry.song.artist.clone(),
                duration_secs: entry.song.duration_secs,
                shiftable: entry.song.shiftable,
                state: ItemState::Ready {
                    entry_id: entry.entry_id.clone(),
                },
            });
        }
    }

    fn remember(&mut self, item: &Item) {
        let Some(entry_id) = item.entry_id() else {
            return;
        };
        self.recent.retain(|played| played.entry_id != entry_id);
        self.recent.push_back(Played {
            entry_id: entry_id.to_string(),
            stage: StageItem {
                reservation_id: item.id.clone(),
                shiftable: item.shiftable,
            },
        });
        while self.recent.len() > RECENT_ITEMS {
            self.recent.pop_front();
        }
    }

    fn entry_keys(&self, entries: &[QueuedSong], except: Option<&str>) -> Vec<(u8, u64)> {
        entries
            .iter()
            .filter(|entry| Some(entry.entry_id.as_str()) != except)
            .filter_map(|entry| {
                self.items
                    .iter()
                    .find(|item| item.entry_id() == Some(entry.entry_id.as_str()))
                    .map(Item::key)
            })
            .collect()
    }

    /// Distinct songs whose analysis a phone queued.
    fn started_preparations(&self) -> usize {
        self.items
            .iter()
            .filter(|item| item.prep().is_some_and(|prep| prep.started_analysis))
            .map(|item| item.file_hash.as_str())
            .collect::<HashSet<_>>()
            .len()
    }

    pub fn preparing(&self) -> bool {
        self.items.iter().any(|item| item.prep().is_some())
    }

    /// A new reservation owned by `request.owner`. A ready song goes into the
    /// playback queue at its place; any other song starts preparing.
    pub fn reserve(
        &mut self,
        library: &dyn LibraryPort,
        analysis: &dyn AnalysisPort,
        request: Reserve,
        protect_head: bool,
    ) -> Result<Reserved, PartyErrorCode> {
        let entries = library.entries();
        self.sync(&entries);
        let file_hash = analysis
            .rekeyed(&request.file_hash)
            .unwrap_or(request.file_hash);
        let song = library
            .songs(std::slice::from_ref(&file_hash))
            .into_iter()
            .next()
            .ok_or(PartyErrorCode::NotFound)?;
        let owner = request.owner;
        if self
            .items
            .iter()
            .any(|item| item.file_hash == file_hash && item.sings(&owner))
        {
            return Err(PartyErrorCode::Duplicate);
        }
        let owned: Vec<&Item> = self
            .items
            .iter()
            .filter(|item| item.owner.as_deref() == Some(owner.as_str()))
            .collect();
        if owned.len() >= MAX_RESERVATIONS_PER_SLOT {
            return Err(PartyErrorCode::LimitReservations);
        }
        if request.sing_next
            && owned.iter().filter(|item| item.sing_next).count() >= MAX_SING_NEXT_PER_SLOT
        {
            return Err(PartyErrorCode::LimitSingNext);
        }
        let can_shift = song.analyzed && song.shiftable;
        if !can_shift && !is_default_shift(request.key_offset, request.tempo) {
            return Err(PartyErrorCode::Unavailable);
        }
        let preparing_owned = owned.iter().filter(|item| item.prep().is_some()).count();

        let seq = self.next_seq + 1;
        let state = if song.analyzed {
            let keys = self.entry_keys(&entries, None);
            let index = placement(&keys, order_key(request.sing_next, seq), protect_head);
            let entry_id = library
                .insert(&file_hash, request.key_offset, request.tempo, index)
                .map_err(|_| PartyErrorCode::Unavailable)?;
            ItemState::Ready { entry_id }
        } else {
            if preparing_owned >= MAX_PREPARING_PER_SLOT {
                return Err(PartyErrorCode::LimitPreparing);
            }
            let view = analysis.view();
            let joined = matches!(
                view.jobs.get(&file_hash),
                Some(JobState::Queued | JobState::Analyzing(_))
            ) || view.active.as_deref() == Some(file_hash.as_str())
                || view.waiting.contains(&file_hash);
            if !joined {
                if self.started_preparations() >= MAX_PREPARING_TOTAL {
                    return Err(PartyErrorCode::PrepFull);
                }
                analysis
                    .enqueue(&file_hash)
                    .map_err(|_| PartyErrorCode::Unavailable)?;
            }
            self.view = analysis.view();
            ItemState::Preparing(Prep {
                started_analysis: !joined,
                ..Prep::default()
            })
        };

        self.next_seq = seq;
        let id = self.take_id();
        self.items.push(Item {
            id: id.clone(),
            seq,
            file_hash,
            owner: Some(owner),
            partners: request.partners,
            key_offset: request.key_offset,
            tempo: request.tempo,
            sing_next: request.sing_next,
            title: song.title.clone(),
            artist: song.artist,
            duration_secs: song.duration_secs,
            shiftable: song.shiftable,
            state,
        });
        Ok(Reserved {
            reservation_id: id,
            title: song.title,
        })
    }

    /// The owner changes key, tempo (ready, shiftable songs) or "sing next".
    pub fn edit(
        &mut self,
        library: &dyn LibraryPort,
        mic_id: &str,
        reservation_id: &str,
        edit: Edit,
        protect_head: bool,
    ) -> Result<(), PartyErrorCode> {
        let entries = library.entries();
        self.sync(&entries);
        let index = self
            .items
            .iter()
            .position(|item| item.id == reservation_id)
            .ok_or(PartyErrorCode::NotFound)?;
        let item = &self.items[index];
        if item.owner.as_deref() != Some(mic_id) {
            return Err(PartyErrorCode::NotAllowed);
        }
        let key_offset = edit.key_offset.unwrap_or(item.key_offset);
        let tempo = edit.tempo.unwrap_or(item.tempo);
        let shift_changes = key_offset != item.key_offset || (tempo - item.tempo).abs() > 1e-6;
        let entry_id = item.entry_id().map(str::to_owned);
        let shiftable = entry_id
            .as_deref()
            .and_then(|id| entries.iter().find(|entry| entry.entry_id == id))
            .is_some_and(|entry| entry.song.shiftable);
        if shift_changes && !is_default_shift(key_offset, tempo) && !shiftable {
            return Err(PartyErrorCode::Unavailable);
        }
        let sing_next = edit.sing_next.unwrap_or(item.sing_next);
        let sing_next_changes = sing_next != item.sing_next;
        if sing_next_changes && sing_next {
            let held = self
                .items
                .iter()
                .filter(|other| other.owner.as_deref() == Some(mic_id) && other.sing_next)
                .count();
            if held >= MAX_SING_NEXT_PER_SLOT {
                return Err(PartyErrorCode::LimitSingNext);
            }
        }

        if shift_changes && let Some(entry_id) = &entry_id {
            library
                .set_shift(entry_id, key_offset, tempo)
                .map_err(|_| PartyErrorCode::NotFound)?;
        }
        let item = &mut self.items[index];
        item.key_offset = key_offset;
        item.tempo = tempo;
        item.sing_next = sing_next;
        let key = item.key();
        if sing_next_changes && let Some(entry_id) = &entry_id {
            let keys = self.entry_keys(&entries, Some(entry_id));
            let target = placement(&keys, key, protect_head);
            if let Err(error) = library.move_to(entry_id, target) {
                warn!("[party] could not move a queue entry: {error}");
            }
        }
        Ok(())
    }

    /// The owner removes a reservation; a partner leaves it.
    pub fn cancel(
        &mut self,
        library: &dyn LibraryPort,
        analysis: &dyn AnalysisPort,
        mic_id: &str,
        reservation_id: &str,
    ) -> Result<(), PartyErrorCode> {
        self.sync(&library.entries());
        let index = self
            .items
            .iter()
            .position(|item| item.id == reservation_id)
            .ok_or(PartyErrorCode::NotFound)?;
        let item = &mut self.items[index];
        if item.owner.as_deref() == Some(mic_id) {
            self.remove_item(library, analysis, index);
            Ok(())
        } else if item.partners.iter().any(|mic| mic == mic_id) {
            item.partners.retain(|mic| mic != mic_id);
            Ok(())
        } else {
            Err(PartyErrorCode::NotAllowed)
        }
    }

    /// A phone's slot was freed: the first partner takes over what it owned,
    /// songs without partners are dropped, and it leaves every duet.
    pub fn release(
        &mut self,
        library: &dyn LibraryPort,
        analysis: &dyn AnalysisPort,
        mic_id: &str,
    ) {
        self.sync(&library.entries());
        for index in (0..self.items.len()).rev() {
            let item = &mut self.items[index];
            if item.owner.as_deref() == Some(mic_id) {
                if item.partners.is_empty() {
                    self.remove_item(library, analysis, index);
                } else {
                    item.owner = Some(item.partners.remove(0));
                }
            } else {
                item.partners.retain(|mic| mic != mic_id);
            }
        }
    }

    /// Drops an item with its queue entry. A preparation is cancelled only
    /// when a phone queued it and no other item waits for the song.
    fn remove_item(
        &mut self,
        library: &dyn LibraryPort,
        analysis: &dyn AnalysisPort,
        index: usize,
    ) {
        let item = self.items.remove(index);
        match item.state {
            ItemState::Ready { entry_id } => library.remove(&entry_id),
            ItemState::Preparing(prep) => {
                let other = self
                    .items
                    .iter_mut()
                    .find(|other| other.file_hash == item.file_hash && other.prep().is_some());
                match other {
                    Some(other) => {
                        if let ItemState::Preparing(other_prep) = &mut other.state {
                            other_prep.started_analysis |= prep.started_analysis;
                        }
                    }
                    None if prep.started_analysis => analysis.cancel(&item.file_hash),
                    None => {}
                }
            }
        }
    }

    /// Follows preparing songs: rekeyed hashes, progress, failures, and songs
    /// that became ready, which go into the playback queue at their place.
    pub fn poll(
        &mut self,
        library: &dyn LibraryPort,
        analysis: &dyn AnalysisPort,
        protect_head: bool,
        now: Instant,
    ) -> Poll {
        let mut poll = Poll::default();
        if !self.preparing() {
            return poll;
        }
        let view = analysis.view();
        poll.changed = view != self.view;

        for item in self.items.iter_mut().filter(|item| item.prep().is_some()) {
            if let Some(next) = analysis.rekeyed(&item.file_hash)
                && next != item.file_hash
            {
                item.file_hash = next;
                poll.changed = true;
            }
        }
        let hashes: Vec<String> = self
            .items
            .iter()
            .filter(|item| item.prep().is_some())
            .map(|item| item.file_hash.clone())
            .collect();
        let songs: HashMap<String, SongFacts> = library
            .songs(&hashes)
            .into_iter()
            .map(|song| (song.file_hash.clone(), song))
            .collect();

        let preparing: Vec<String> = self
            .items
            .iter()
            .filter(|item| item.prep().is_some())
            .map(|item| item.id.clone())
            .collect();
        for id in preparing {
            let Some(index) = self.items.iter().position(|item| item.id == id) else {
                continue;
            };
            let hash = self.items[index].file_hash.clone();
            let song = songs.get(&hash);
            if let Some(song) = song.filter(|song| song.analyzed) {
                poll.changed |= self.make_ready(library, &id, song, protect_head, now);
                continue;
            }
            let known = view.jobs.get(&hash).copied();
            let in_worker =
                view.active.as_deref() == Some(hash.as_str()) || view.waiting.contains(&hash);
            let item = &mut self.items[index];
            if let Some(song) = song {
                item.title.clone_from(&song.title);
                item.artist.clone_from(&song.artist);
                item.duration_secs = song.duration_secs;
            }
            let ItemState::Preparing(prep) = &mut item.state else {
                continue;
            };
            let failed = match known {
                Some(JobState::Failed) => true,
                Some(JobState::Analyzing(_)) => {
                    prep.missing_polls = 0;
                    let since = *prep.analyzing_since.get_or_insert(now);
                    now.saturating_duration_since(since) >= STUCK_ANALYSIS
                }
                Some(JobState::Queued) => {
                    prep.missing_polls = 0;
                    false
                }
                None if in_worker => {
                    prep.missing_polls = 0;
                    false
                }
                None => {
                    prep.missing_polls += 1;
                    prep.missing_polls >= MISSING_POLLS
                }
            };
            if failed {
                let item = self.items.remove(index);
                poll.failed.push(PrepFailed {
                    singers: item.singers(),
                    title: item.title,
                });
                poll.changed = true;
            }
        }
        self.view = view;
        poll
    }

    fn make_ready(
        &mut self,
        library: &dyn LibraryPort,
        id: &str,
        song: &SongFacts,
        protect_head: bool,
        now: Instant,
    ) -> bool {
        let entries = library.entries();
        self.sync(&entries);
        let Some(index) = self.items.iter().position(|item| item.id == id) else {
            return false;
        };
        let keys = self.entry_keys(&entries, None);
        let item = &self.items[index];
        let target = placement(&keys, item.key(), protect_head);
        let entry_id = match library.insert(&song.file_hash, item.key_offset, item.tempo, target) {
            Ok(entry_id) => entry_id,
            Err(error) => {
                warn!("[party] a prepared song could not be queued yet: {error}");
                return false;
            }
        };
        let item = &mut self.items[index];
        if let ItemState::Preparing(prep) = &item.state
            && let Some(since) = prep.analyzing_since
        {
            self.durations
                .push_back(now.saturating_duration_since(since));
            while self.durations.len() > PREP_SAMPLES {
                self.durations.pop_front();
            }
        }
        item.title.clone_from(&song.title);
        item.artist.clone_from(&song.artist);
        item.duration_secs = song.duration_secs;
        item.shiftable = song.shiftable;
        item.state = ItemState::Ready { entry_id };
        true
    }

    /// The queue in play order: ready items in playback-queue order, each
    /// preparing item where it will go when ready. The first
    /// [`MAX_PARTY_QUEUE_ITEMS`], then later items with phone singers.
    /// Returns the listed items and the total.
    pub fn snapshot(
        &mut self,
        library: &dyn LibraryPort,
        protect_head: bool,
        slot_of: &dyn Fn(&str) -> Option<u8>,
    ) -> (Vec<PartyItem>, u32) {
        let entries = library.entries();
        self.sync(&entries);
        let keys = self.entry_keys(&entries, None);
        let mean = self.mean_prep_secs();

        let mut preparing: Vec<&Item> = self
            .items
            .iter()
            .filter(|item| item.prep().is_some())
            .collect();
        preparing.sort_by_key(|item| item.key());
        let mut slots: Vec<Vec<&Item>> = vec![Vec::new(); entries.len() + 1];
        for item in preparing {
            slots[placement(&keys, item.key(), protect_head)].push(item);
        }

        let singers = |item: &Item| -> Vec<u8> {
            item.singers()
                .iter()
                .filter_map(|mic| slot_of(mic))
                .collect()
        };
        let mut ordered = Vec::new();
        for (position, waiting) in slots.into_iter().enumerate() {
            for item in waiting {
                ordered.push(PartyItem {
                    reservation_id: item.id.clone(),
                    entry_id: None,
                    file_hash: item.file_hash.clone(),
                    title: item.title.clone(),
                    artist: item.artist.clone(),
                    duration_secs: item.duration_secs,
                    singers: singers(item),
                    key_offset: item.key_offset,
                    tempo: item.tempo,
                    sing_next: item.sing_next,
                    shiftable: item.shiftable,
                    prep: prep_state(&self.view, &item.file_hash, mean, PrepStage::Queued),
                });
            }
            let Some(entry) = entries.get(position) else {
                continue;
            };
            let Some(item) = self
                .items
                .iter()
                .find(|item| item.entry_id() == Some(entry.entry_id.as_str()))
            else {
                continue;
            };
            ordered.push(PartyItem {
                reservation_id: item.id.clone(),
                entry_id: Some(entry.entry_id.clone()),
                file_hash: entry.song.file_hash.clone(),
                title: entry.song.title.clone(),
                artist: entry.song.artist.clone(),
                duration_secs: entry.song.duration_secs,
                singers: singers(item),
                key_offset: entry.key_offset,
                tempo: entry.tempo,
                sing_next: item.sing_next,
                shiftable: entry.song.shiftable,
                prep: PrepState {
                    state: PrepStage::Ready,
                    pct: None,
                    eta_secs: None,
                },
            });
        }

        let total = u32::try_from(ordered.len()).unwrap_or(u32::MAX);
        let listed = ordered
            .into_iter()
            .enumerate()
            .filter(|(position, item)| {
                *position < MAX_PARTY_QUEUE_ITEMS || !item.singers.is_empty()
            })
            .map(|(_, item)| item)
            .collect();
        (listed, total)
    }

    /// The singers (owner first) of the first ready item, or `None` when the
    /// playback queue is empty.
    pub fn first_ready(&mut self, library: &dyn LibraryPort) -> Option<Vec<String>> {
        let entries = library.entries();
        self.sync(&entries);
        let first = entries.first()?;
        self.items
            .iter()
            .find(|item| item.entry_id() == Some(first.entry_id.as_str()))
            .map(Item::singers)
    }

    /// The reservation behind a playback-queue entry, also shortly after the
    /// TV took the entry out of the queue to play it.
    pub fn stage_item(&self, entry_id: &str) -> Option<StageItem> {
        self.items
            .iter()
            .find(|item| item.entry_id() == Some(entry_id))
            .map(|item| StageItem {
                reservation_id: item.id.clone(),
                shiftable: item.shiftable,
            })
            .or_else(|| {
                self.recent
                    .iter()
                    .rev()
                    .find(|played| played.entry_id == entry_id)
                    .map(|played| played.stage.clone())
            })
    }

    /// The song book's state for a song that is not analysed: its analysis
    /// when it has one, otherwise `not-ready` with the time it would take if
    /// picked now.
    pub fn book_prep(&self, view: &AnalysisView, file_hash: &str) -> PrepState {
        prep_state(view, file_hash, self.mean_prep_secs(), PrepStage::NotReady)
    }
}

/// `etaSecs` = what is left of the running analysis + the analyses ahead of
/// this one and the song itself, each at the mean analysis time, rounded up
/// to 10 s. `waiting-gpu` has no estimate.
fn prep_state(view: &AnalysisView, file_hash: &str, mean: f64, unknown: PrepStage) -> PrepState {
    let left_of = |pct: u8| mean * f64::from(100 - pct.min(100)) / 100.0;
    let running = view
        .active
        .as_deref()
        .map_or(0.0, |active| match view.jobs.get(active) {
            Some(JobState::Analyzing(pct)) => left_of(*pct),
            _ => mean,
        });
    let state = |state: PrepStage, pct: Option<u8>, eta: Option<f64>| PrepState {
        state,
        pct,
        eta_secs: eta.map(round_eta),
    };
    match view.jobs.get(file_hash) {
        Some(JobState::Failed) => state(PrepStage::Failed, None, None),
        Some(JobState::Analyzing(pct)) => {
            let pct = (*pct).min(100);
            state(PrepStage::Analyzing, Some(pct), Some(left_of(pct)))
        }
        Some(JobState::Queued) if view.waiting_gpu => state(PrepStage::WaitingGpu, None, None),
        Some(JobState::Queued) => {
            let ahead = view
                .waiting
                .iter()
                .position(|hash| hash == file_hash)
                .unwrap_or(view.waiting.len());
            state(
                PrepStage::Queued,
                None,
                Some(running + (ahead as f64 + 1.0) * mean),
            )
        }
        None if view.waiting_gpu => state(
            if unknown == PrepStage::Queued {
                PrepStage::WaitingGpu
            } else {
                unknown
            },
            None,
            None,
        ),
        None => state(
            unknown,
            None,
            Some(running + (view.waiting.len() as f64 + 1.0) * mean),
        ),
    }
}

/// Tonight's best (§13.12): best first, at most [`MAX_NIGHT_SCORES`], each for
/// [`NIGHT_SCORE_MAX_AGE_SECS`]. In memory only.
#[derive(Debug, Default)]
pub struct NightBoard {
    entries: Vec<(u64, NightScore)>,
    /// When each score tonight was made, on the board or not.
    made: VecDeque<u32>,
    next_token: u64,
}

impl NightBoard {
    fn prune(&mut self, now_secs: u32) {
        let fresh = |at: u32| now_secs.saturating_sub(at) < NIGHT_SCORE_MAX_AGE_SECS;
        self.entries.retain(|(_, score)| fresh(score.at_secs));
        self.made.retain(|at| fresh(*at));
    }

    /// Adds one song's scores and returns each one's 1-based place on the
    /// board, `None` when it did not make it.
    pub fn record(&mut self, scores: Vec<NightScore>, now_secs: u32) -> Vec<Option<u8>> {
        self.prune(now_secs);
        let mut tokens = Vec::with_capacity(scores.len());
        for score in scores {
            self.next_token += 1;
            tokens.push(self.next_token);
            self.made.push_back(score.at_secs);
            self.entries.push((self.next_token, score));
        }
        self.entries
            .sort_by(|(left_token, left), (right_token, right)| {
                right
                    .display_score
                    .cmp(&left.display_score)
                    .then(right.raw_score.cmp(&left.raw_score))
                    .then(left.at_secs.cmp(&right.at_secs))
                    .then(left_token.cmp(right_token))
            });
        self.entries.truncate(MAX_NIGHT_SCORES);
        tokens
            .iter()
            .map(|token| {
                self.entries
                    .iter()
                    .position(|(entry, _)| entry == token)
                    .and_then(|index| u8::try_from(index + 1).ok())
            })
            .collect()
    }

    pub fn scores(&mut self, now_secs: u32) -> Vec<NightScore> {
        self.prune(now_secs);
        self.entries
            .iter()
            .map(|(_, score)| score.clone())
            .collect()
    }

    /// Scores made tonight, on the board or not.
    pub fn made(&mut self, now_secs: u32) -> u32 {
        self.prune(now_secs);
        u32::try_from(self.made.len()).unwrap_or(u32::MAX)
    }

    pub fn reset(&mut self) {
        self.entries.clear();
        self.made.clear();
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::sync::Mutex;

    use super::*;
    use crate::playback_session::PlayerColor;
    use crate::remote_mic::ScoreTier;

    const A: &str = "mic-aaaa";
    const B: &str = "mic-bbbb";
    const C: &str = "mic-cccc";

    fn hash(n: u32) -> String {
        format!("{n:032x}")
    }

    fn song(n: u32, analyzed: bool) -> SongFacts {
        SongFacts {
            file_hash: hash(n),
            title: format!("Song {n}"),
            artist: "Artist".into(),
            duration_secs: 200.0,
            analyzed,
            shiftable: analyzed,
        }
    }

    #[derive(Default)]
    struct Library {
        songs: RefCell<HashMap<String, SongFacts>>,
        entries: RefCell<Vec<QueuedSong>>,
        next: Cell<u32>,
        shifts: RefCell<Vec<(String, i8, f64)>>,
    }

    impl Library {
        fn with(songs: impl IntoIterator<Item = SongFacts>) -> Self {
            let library = Self::default();
            for song in songs {
                library.add(song);
            }
            library
        }

        fn add(&self, song: SongFacts) {
            self.songs.borrow_mut().insert(song.file_hash.clone(), song);
        }

        fn host_queue(&self, n: u32) -> String {
            let song = self.songs.borrow()[&hash(n)].clone();
            let id = self.take_id();
            self.entries.borrow_mut().push(QueuedSong {
                entry_id: id.clone(),
                key_offset: 0,
                tempo: 1.0,
                song,
            });
            id
        }

        fn take_id(&self) -> String {
            self.next.set(self.next.get() + 1);
            format!("{}", self.next.get())
        }

        fn order(&self) -> Vec<String> {
            self.entries
                .borrow()
                .iter()
                .map(|entry| entry.song.title.clone())
                .collect()
        }
    }

    impl LibraryPort for Library {
        fn songs(&self, file_hashes: &[String]) -> Vec<SongFacts> {
            let songs = self.songs.borrow();
            file_hashes
                .iter()
                .filter_map(|hash| songs.get(hash).cloned())
                .collect()
        }

        fn entries(&self) -> Vec<QueuedSong> {
            self.entries.borrow().clone()
        }

        fn insert(
            &self,
            file_hash: &str,
            key_offset: i8,
            tempo: f64,
            index: usize,
        ) -> Result<String, String> {
            let song = self
                .songs
                .borrow()
                .get(file_hash)
                .filter(|song| song.analyzed)
                .cloned()
                .ok_or("not analysed")?;
            let id = self.take_id();
            let mut entries = self.entries.borrow_mut();
            let index = index.min(entries.len());
            entries.insert(
                index,
                QueuedSong {
                    entry_id: id.clone(),
                    key_offset,
                    tempo,
                    song,
                },
            );
            Ok(id)
        }

        fn move_to(&self, entry_id: &str, index: usize) -> Result<(), String> {
            let mut entries = self.entries.borrow_mut();
            let from = entries
                .iter()
                .position(|entry| entry.entry_id == entry_id)
                .ok_or("missing")?;
            let entry = entries.remove(from);
            let index = index.min(entries.len());
            entries.insert(index, entry);
            Ok(())
        }

        fn remove(&self, entry_id: &str) {
            self.entries
                .borrow_mut()
                .retain(|entry| entry.entry_id != entry_id);
        }

        fn set_shift(&self, entry_id: &str, key_offset: i8, tempo: f64) -> Result<(), String> {
            let mut entries = self.entries.borrow_mut();
            let entry = entries
                .iter_mut()
                .find(|entry| entry.entry_id == entry_id)
                .ok_or("missing")?;
            entry.key_offset = key_offset;
            entry.tempo = tempo;
            self.shifts
                .borrow_mut()
                .push((entry_id.to_string(), key_offset, tempo));
            Ok(())
        }
    }

    #[derive(Default)]
    struct Analysis {
        state: Mutex<AnalysisState>,
    }

    #[derive(Default)]
    struct AnalysisState {
        view: AnalysisView,
        enqueued: Vec<String>,
        cancelled: Vec<String>,
        rekeys: HashMap<String, String>,
    }

    impl Analysis {
        fn with<T>(&self, change: impl FnOnce(&mut AnalysisState) -> T) -> T {
            change(&mut self.state.lock().expect("fake analysis"))
        }

        fn set_job(&self, file_hash: &str, job: Option<JobState>) {
            self.with(|state| match job {
                Some(job) => {
                    state.view.jobs.insert(file_hash.to_string(), job);
                }
                None => {
                    state.view.jobs.remove(file_hash);
                    state.view.waiting.retain(|hash| hash != file_hash);
                    if state.view.active.as_deref() == Some(file_hash) {
                        state.view.active = None;
                    }
                }
            });
        }
    }

    impl AnalysisPort for Analysis {
        fn view(&self) -> AnalysisView {
            self.with(|state| state.view.clone())
        }

        fn enqueue(&self, file_hash: &str) -> Result<(), String> {
            self.with(|state| {
                state.enqueued.push(file_hash.to_string());
                state
                    .view
                    .jobs
                    .insert(file_hash.to_string(), JobState::Queued);
                state.view.waiting.push(file_hash.to_string());
            });
            Ok(())
        }

        fn cancel(&self, file_hash: &str) {
            self.with(|state| state.cancelled.push(file_hash.to_string()));
            self.set_job(file_hash, None);
        }

        fn rekeyed(&self, file_hash: &str) -> Option<String> {
            self.with(|state| state.rekeys.get(file_hash).cloned())
        }
    }

    fn reserve(owner: &str, n: u32) -> Reserve {
        Reserve {
            owner: owner.into(),
            partners: Vec::new(),
            file_hash: hash(n),
            key_offset: 0,
            tempo: 1.0,
            sing_next: false,
        }
    }

    fn listing(book: &mut PartyBook, library: &Library) -> Vec<PartyItem> {
        let slot_of = |mic: &str| match mic {
            A => Some(1),
            B => Some(2),
            C => Some(3),
            _ => None,
        };
        book.snapshot(library, false, &slot_of).0
    }

    #[test]
    fn placement_follows_the_order_key_and_protects_the_head() {
        let keys = [(1, 1), (1, 3), (1, 5)];
        assert_eq!(placement(&keys, (1, 4), false), 2);
        assert_eq!(placement(&keys, (1, 9), false), 3);
        assert_eq!(placement(&keys, (0, 9), false), 0);
        assert_eq!(placement(&keys, (0, 9), true), 1);
        assert_eq!(placement(&[], (0, 9), true), 0);
        // The host reordered: the first greater key wins, nothing is re-sorted.
        assert_eq!(placement(&[(1, 5), (1, 1)], (1, 3), false), 0);

        assert!(protects_head(StageKind::Starting, None));
        assert!(protects_head(StageKind::Lobby, Some(12)));
        assert!(!protects_head(StageKind::Lobby, None));
        assert!(!protects_head(StageKind::Singing, None));
    }

    #[test]
    fn reservations_go_into_the_queue_in_order_and_sing_next_jumps_ahead() {
        let library = Library::with((1..=4).map(|n| song(n, true)));
        let analysis = Analysis::default();
        let mut book = PartyBook::default();
        library.host_queue(1);

        book.reserve(&library, &analysis, reserve(A, 2), false)
            .expect("A reserves");
        book.reserve(&library, &analysis, reserve(B, 3), false)
            .expect("B reserves");
        assert_eq!(library.order(), ["Song 1", "Song 2", "Song 3"]);

        let mut next = reserve(C, 4);
        next.sing_next = true;
        book.reserve(&library, &analysis, next.clone(), true)
            .expect("C sings next");
        // Sing next goes first, but the head is being counted down.
        assert_eq!(library.order(), ["Song 1", "Song 4", "Song 2", "Song 3"]);

        let items = listing(&mut book, &library);
        assert_eq!(items[0].singers, Vec::<u8>::new());
        assert_eq!(items[1].singers, [3]);
        assert!(items[1].sing_next);
        assert!(items.iter().all(|item| item.entry_id.is_some()));
        assert_eq!(
            book.reserve(&library, &analysis, next, false),
            Err(PartyErrorCode::Duplicate)
        );
    }

    #[test]
    fn limits_per_phone_and_party_wide() {
        let library = Library::with(
            (1..=4)
                .map(|n| song(n, true))
                .chain((10..=20).map(|n| song(n, false))),
        );
        let analysis = Analysis::default();
        let mut book = PartyBook::default();

        let mut first = reserve(A, 1);
        first.sing_next = true;
        book.reserve(&library, &analysis, first, false).expect("1");
        let mut second = reserve(A, 2);
        second.sing_next = true;
        assert_eq!(
            book.reserve(&library, &analysis, second, false),
            Err(PartyErrorCode::LimitSingNext)
        );
        book.reserve(&library, &analysis, reserve(A, 10), false)
            .expect("prep 1");
        book.reserve(&library, &analysis, reserve(A, 11), false)
            .expect("prep 2");
        assert_eq!(
            book.reserve(&library, &analysis, reserve(A, 3), false),
            Err(PartyErrorCode::LimitReservations)
        );

        book.reserve(&library, &analysis, reserve(B, 12), false)
            .expect("B prep 1");
        book.reserve(&library, &analysis, reserve(B, 13), false)
            .expect("B prep 2");
        assert_eq!(
            book.reserve(&library, &analysis, reserve(B, 14), false),
            Err(PartyErrorCode::LimitPreparing)
        );
        book.reserve(&library, &analysis, reserve(C, 14), false)
            .expect("C prep 1");
        book.reserve(&library, &analysis, reserve(C, 15), false)
            .expect("C prep 2");
        // Six phone preparations are running.
        assert_eq!(
            book.reserve(&library, &analysis, reserve("mic-dddd", 16), false),
            Err(PartyErrorCode::PrepFull)
        );
        // Joining one the host queued does not start a new one.
        analysis.with(|state| {
            state.view.jobs.insert(hash(17), JobState::Queued);
        });
        book.reserve(&library, &analysis, reserve("mic-dddd", 17), false)
            .expect("joins the host's analysis");
        assert_eq!(analysis.with(|state| state.enqueued.len()), 6);

        assert_eq!(
            book.reserve(&library, &analysis, reserve(A, 99), false),
            Err(PartyErrorCode::NotFound)
        );
        let mut shifted = reserve("mic-eeee", 18);
        shifted.key_offset = 2;
        assert_eq!(
            book.reserve(&library, &analysis, shifted, false),
            Err(PartyErrorCode::Unavailable)
        );
    }

    #[test]
    fn preparing_songs_follow_their_rekeyed_hash_and_join_the_queue_when_ready() {
        let library = Library::with([song(1, true), song(2, true), song(3, false)]);
        let analysis = Analysis::default();
        let mut book = PartyBook::default();
        book.reserve(&library, &analysis, reserve(A, 3), false)
            .expect("prep");
        book.reserve(&library, &analysis, reserve(B, 1), false)
            .expect("ready");
        library.host_queue(2);
        assert_eq!(analysis.with(|state| state.enqueued.clone()), [hash(3)]);

        let items = listing(&mut book, &library);
        // The preparing song is listed where it will go: before B's later one.
        assert_eq!(items[0].prep.state, PrepStage::Queued);
        assert_eq!(items[0].prep.eta_secs, Some(120));
        assert_eq!(items[1].title, "Song 1");

        let start = Instant::now();
        analysis.with(|state| {
            state.view.jobs.remove(&hash(3));
            state.view.waiting.clear();
            state.view.active = Some(hash(30));
            state.view.jobs.insert(hash(30), JobState::Analyzing(40));
            state.rekeys.insert(hash(3), hash(30));
        });
        let mut downloaded = song(30, false);
        downloaded.title = "Song 3".into();
        library.add(downloaded.clone());
        let poll = book.poll(&library, &analysis, false, start);
        assert!(poll.changed && poll.failed.is_empty());
        let items = listing(&mut book, &library);
        assert_eq!(items[0].file_hash, hash(30));
        assert_eq!(items[0].prep.state, PrepStage::Analyzing);
        assert_eq!(items[0].prep.pct, Some(40));
        assert_eq!(items[0].prep.eta_secs, Some(80));

        downloaded.analyzed = true;
        library.add(downloaded);
        analysis.set_job(&hash(30), None);
        book.poll(&library, &analysis, false, start + Duration::from_secs(90));
        assert_eq!(library.order(), ["Song 3", "Song 1", "Song 2"]);
        let items = listing(&mut book, &library);
        assert_eq!(items[0].entry_id.as_deref(), Some("3"));
        assert_eq!(items[0].singers, [1]);
        assert!(!book.preparing());
        // Tonight's first measured analysis replaces the default estimate.
        assert!((book.mean_prep_secs() - 90.0).abs() < 1e-9);
    }

    #[test]
    fn eta_counts_the_running_job_the_queue_ahead_and_the_song() {
        let view = AnalysisView {
            jobs: HashMap::from([
                (hash(1), JobState::Analyzing(25)),
                (hash(2), JobState::Queued),
                (hash(3), JobState::Queued),
                (hash(4), JobState::Failed),
            ]),
            active: Some(hash(1)),
            waiting: vec![hash(2), hash(3)],
            waiting_gpu: false,
        };
        let mean = 100.0;
        assert_eq!(
            prep_state(&view, &hash(1), mean, PrepStage::Queued).eta_secs,
            Some(80)
        );
        assert_eq!(
            prep_state(&view, &hash(2), mean, PrepStage::Queued).eta_secs,
            Some(180)
        );
        assert_eq!(
            prep_state(&view, &hash(3), mean, PrepStage::Queued).eta_secs,
            Some(280)
        );
        assert_eq!(
            prep_state(&view, &hash(4), mean, PrepStage::Queued).state,
            PrepStage::Failed
        );
        let book = prep_state(&view, &hash(9), mean, PrepStage::NotReady);
        assert_eq!(
            (book.state, book.eta_secs),
            (PrepStage::NotReady, Some(380))
        );

        let held = AnalysisView {
            waiting_gpu: true,
            active: None,
            ..view
        };
        let waiting = prep_state(&held, &hash(2), mean, PrepStage::Queued);
        assert_eq!(
            (waiting.state, waiting.eta_secs),
            (PrepStage::WaitingGpu, None)
        );
        assert_eq!(
            prep_state(&held, &hash(9), mean, PrepStage::NotReady).eta_secs,
            None
        );
        assert_eq!(round_eta(0.4), 10);
        assert_eq!(round_eta(120.0), 120);
    }

    #[test]
    fn cancelling_stops_only_analyses_a_phone_started_and_nobody_else_waits_for() {
        let library = Library::with([song(1, false), song(2, false)]);
        let analysis = Analysis::default();
        let mut book = PartyBook::default();
        let a = book
            .reserve(&library, &analysis, reserve(A, 1), false)
            .expect("A");
        let b = book
            .reserve(&library, &analysis, reserve(B, 1), false)
            .expect("B joins");
        assert_eq!(analysis.with(|state| state.enqueued.len()), 1);

        assert_eq!(
            book.cancel(&library, &analysis, B, &a.reservation_id),
            Err(PartyErrorCode::NotAllowed)
        );
        book.cancel(&library, &analysis, A, &a.reservation_id)
            .expect("A cancels");
        assert!(analysis.with(|state| state.cancelled.is_empty()));
        book.cancel(&library, &analysis, B, &b.reservation_id)
            .expect("B cancels");
        assert_eq!(analysis.with(|state| state.cancelled.clone()), [hash(1)]);

        // An analysis the host queued is joined and never cancelled.
        analysis.set_job(&hash(2), Some(JobState::Analyzing(10)));
        let c = book
            .reserve(&library, &analysis, reserve(C, 2), false)
            .expect("C");
        book.cancel(&library, &analysis, C, &c.reservation_id)
            .expect("C cancels");
        assert_eq!(analysis.with(|state| state.cancelled.len()), 1);
        assert_eq!(
            book.cancel(&library, &analysis, C, "r99"),
            Err(PartyErrorCode::NotFound)
        );
    }

    #[test]
    fn partners_leave_and_inherit_when_the_owner_goes() {
        let library = Library::with([song(1, true), song(2, true)]);
        let analysis = Analysis::default();
        let mut book = PartyBook::default();
        let mut duet = reserve(A, 1);
        duet.partners = vec![B.into(), C.into()];
        let duet = book
            .reserve(&library, &analysis, duet, false)
            .expect("duet");
        book.reserve(&library, &analysis, reserve(A, 2), false)
            .expect("solo");

        book.cancel(&library, &analysis, C, &duet.reservation_id)
            .expect("C leaves");
        assert_eq!(listing(&mut book, &library)[0].singers, [1, 2]);

        book.release(&library, &analysis, A);
        let items = listing(&mut book, &library);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].singers, [2]);
        assert_eq!(library.order(), ["Song 1"]);
        assert_eq!(
            book.edit(
                &library,
                B,
                &duet.reservation_id,
                Edit {
                    sing_next: Some(true),
                    ..Edit::default()
                },
                false
            ),
            Ok(())
        );
    }

    #[test]
    fn edits_change_the_queue_entry_and_belong_to_the_owner() {
        let library = Library::with([song(1, true), song(2, true), song(3, false)]);
        let analysis = Analysis::default();
        let mut book = PartyBook::default();
        library.host_queue(1);
        let mut duet = reserve(A, 2);
        duet.partners = vec![B.into()];
        let duet = book
            .reserve(&library, &analysis, duet, false)
            .expect("duet");
        let shift = Edit {
            key_offset: Some(-2),
            tempo: Some(0.9),
            sing_next: None,
        };
        assert_eq!(
            book.edit(&library, B, &duet.reservation_id, shift, false),
            Err(PartyErrorCode::NotAllowed)
        );
        book.edit(&library, A, &duet.reservation_id, shift, false)
            .expect("owner edits");
        assert_eq!(
            library.shifts.borrow().clone(),
            [("2".to_string(), -2, 0.9)]
        );
        let entry = library.entries()[1].clone();
        assert_eq!((entry.key_offset, entry.tempo), (-2, 0.9));

        book.edit(
            &library,
            A,
            &duet.reservation_id,
            Edit {
                sing_next: Some(true),
                ..Edit::default()
            },
            false,
        )
        .expect("sing next");
        assert_eq!(library.order(), ["Song 2", "Song 1"]);

        let prep = book
            .reserve(&library, &analysis, reserve(A, 3), false)
            .expect("prep");
        assert_eq!(
            book.edit(&library, A, &prep.reservation_id, shift, false),
            Err(PartyErrorCode::Unavailable)
        );
    }

    #[test]
    fn failed_or_vanished_preparations_are_dropped_with_their_singers() {
        let library = Library::with([song(1, false), song(2, false)]);
        let analysis = Analysis::default();
        let mut book = PartyBook::default();
        let mut duet = reserve(A, 1);
        duet.partners = vec![B.into()];
        book.reserve(&library, &analysis, duet, false)
            .expect("duet");
        book.reserve(&library, &analysis, reserve(C, 2), false)
            .expect("solo");
        let now = Instant::now();

        analysis.set_job(&hash(1), Some(JobState::Failed));
        let poll = book.poll(&library, &analysis, false, now);
        assert_eq!(
            poll.failed,
            [PrepFailed {
                singers: vec![A.into(), B.into()],
                title: "Song 1".into(),
            }]
        );

        analysis.set_job(&hash(2), None);
        assert!(book.poll(&library, &analysis, false, now).failed.is_empty());
        assert_eq!(book.poll(&library, &analysis, false, now).failed.len(), 1);
        assert!(!book.preparing());
    }

    #[test]
    fn host_songs_get_items_and_the_listing_keeps_phone_songs_past_the_cut() {
        let library = Library::with((1..=40).map(|n| song(n, true)));
        let analysis = Analysis::default();
        let mut book = PartyBook::default();
        for n in 1..=35 {
            library.host_queue(n);
        }
        book.reserve(&library, &analysis, reserve(A, 36), false)
            .expect("late");
        let (items, total) = book.snapshot(&library, false, &|mic: &str| (mic == A).then_some(1));
        assert_eq!(total, 36);
        assert_eq!(items.len(), MAX_PARTY_QUEUE_ITEMS + 1);
        assert_eq!(items.last().map(|item| item.singers.clone()), Some(vec![1]));

        // The TV takes the head entry to play it; its reservation stays known.
        let head = library.entries()[0].entry_id.clone();
        let reservation = book.stage_item(&head).expect("known").reservation_id;
        library.remove(&head);
        listing(&mut book, &library);
        assert_eq!(
            book.stage_item(&head).map(|item| item.reservation_id),
            Some(reservation)
        );
        assert_eq!(book.first_ready(&library), Some(Vec::new()));
    }

    #[test]
    fn control_rules_follow_the_stage() {
        use PartyAction::{Pause, StartNow, Stop};
        assert_eq!(
            check_control(Pause, 1, StageKind::Singing, &[1, 2], None),
            Ok(())
        );
        assert_eq!(
            check_control(Stop, 3, StageKind::Paused, &[1, 2], None),
            Err(PartyErrorCode::NotAllowed)
        );
        assert_eq!(
            check_control(Pause, 1, StageKind::Lobby, &[], None),
            Err(PartyErrorCode::Busy)
        );
        assert_eq!(
            check_control(StartNow, 2, StageKind::Lobby, &[], Some(&[2])),
            Ok(())
        );
        assert_eq!(
            check_control(StartNow, 3, StageKind::Lobby, &[], Some(&[])),
            Ok(())
        );
        assert_eq!(
            check_control(StartNow, 3, StageKind::Lobby, &[], Some(&[2])),
            Err(PartyErrorCode::NotAllowed)
        );
        assert_eq!(
            check_control(StartNow, 3, StageKind::Lobby, &[], None),
            Err(PartyErrorCode::NotFound)
        );
        assert_eq!(
            check_control(StartNow, 1, StageKind::Singing, &[1], Some(&[1])),
            Err(PartyErrorCode::Busy)
        );
    }

    fn score(slot: u8, name: &str, display: u8, raw: u32, at: u32) -> NightScore {
        NightScore {
            slot,
            color: PlayerColor::Rose,
            name: Some(name.into()),
            title: Some("Song".into()),
            display_score: display,
            raw_score: raw,
            tier: ScoreTier::for_display_score(display),
            at_secs: at,
        }
    }

    #[test]
    fn the_night_board_keeps_the_best_ten_for_twelve_hours() {
        let mut board = NightBoard::default();
        let start = 1_763_100_000;
        assert_eq!(
            board.record(
                vec![
                    score(2, "Bo", 80, 500, start),
                    score(1, "Jim", 100, 995, start)
                ],
                start
            ),
            [Some(2), Some(1)]
        );
        // Ties: the higher raw score, then the older score.
        assert_eq!(
            board.record(vec![score(3, "Al", 80, 500, start + 5)], start + 5),
            [Some(3)]
        );
        assert_eq!(
            board.record(vec![score(4, "Di", 80, 600, start + 6)], start + 6),
            [Some(2)]
        );
        for n in 0..8 {
            board.record(vec![score(1, "Jim", 90, n, start + 10)], start + 10);
        }
        let scores = board.scores(start + 10);
        assert_eq!(scores.len(), MAX_NIGHT_SCORES);
        assert_eq!(scores[0].name.as_deref(), Some("Jim"));
        assert_eq!(scores[0].display_score, 100);
        assert_eq!(
            board.record(vec![score(2, "Bo", 10, 0, start + 20)], start + 20),
            [None]
        );
        assert_eq!(board.made(start + 20), 13);

        let later = start + 10 + NIGHT_SCORE_MAX_AGE_SECS;
        assert!(
            board
                .scores(later)
                .iter()
                .all(|score| score.at_secs >= start + 20)
        );
        assert_eq!(board.made(later), 1);
        board.reset();
        assert!(board.scores(later).is_empty());
        assert_eq!(board.made(later), 0);
    }
}
