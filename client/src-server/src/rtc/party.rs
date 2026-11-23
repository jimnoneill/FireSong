//! The party channel on `/rtc` (PROTOCOL.md §13, PHONE-V2.md): phone
//! requests checked against §13.7 and the §13.10 budgets, relays between the
//! phones and the TV, the stage the TV reports, tonight's scoreboard and the
//! coalesced `party` snapshots. The reservation book is app-api's [`Party`];
//! the hub calls it under its own lock (hub first, then book).

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use app_api::Party;
use app_core::party::{
    check_control, check_singer, protects_head, AnalysisPort, Edit, LibraryPort, NightBoard,
    PartnerChange, PartyBook, Reserve,
};
use app_core::remote_mic::{
    slot_color, CalibrationFailure, CalibrationState, MicPartyToServer, NightScore, NoticeCode,
    PartyAction, PartyErrorCode, PartySinger, PartySnapshot, PartyStage, RtcErrorCode,
    ServerToMicParty, ServerToTvParty, SlotResult, SlotState, StageKind, TvPartyToServer,
    CALIBRATION_COOLDOWN_SECS, DEFAULT_ECHO_PCT, DEFAULT_VOLUME_PCT, FX_BURST, FX_REFILL_MS,
    MAX_SHIFTS_PER_SONG, MIX_PER_SEC, PARTY_REQUEST_BURST, PARTY_REQUEST_REFILL_MS,
    PARTY_SNAPSHOT_MIN_INTERVAL_MS, SHIFT_CURRENT_COOLDOWN_SECS,
};

use super::hub::{slot_index, slot_number, ConnId, Entry, Hub, Inner, Link, Peer, SLOTS};
use super::{Bucket, Timings};

/// The hub's party state.
pub(super) struct Room {
    book: Option<Arc<Party>>,
    stage: Stage,
    board: NightBoard,
    calibration: Option<Calibration>,
    calibration_timeout: Duration,
    /// Grows with every snapshot built.
    rev: u32,
    tv_sent: Option<Instant>,
    tv_pending: bool,
    /// `shift-current` requests relayed for the song on stage.
    shifts: u32,
}

impl Default for Room {
    fn default() -> Self {
        Self {
            book: None,
            stage: Stage::lobby(),
            board: NightBoard::default(),
            calibration: None,
            calibration_timeout: Timings::default().calibration_timeout,
            rev: 0,
            tv_sent: None,
            tv_pending: false,
            shifts: 0,
        }
    }
}

impl Room {
    fn protects_head(&self) -> bool {
        protects_head(self.stage.state, self.stage.countdown_secs)
    }
}

/// What the TV last reported with `stage`.
struct Stage {
    state: StageKind,
    reservation_id: Option<String>,
    /// `None` when the song did not come from the queue.
    shiftable: Option<bool>,
    singers: Vec<u8>,
    title: Option<String>,
    artist: Option<String>,
    countdown_secs: Option<u32>,
}

impl Stage {
    fn lobby() -> Self {
        Self {
            state: StageKind::Lobby,
            reservation_id: None,
            shiftable: None,
            singers: Vec::new(),
            title: None,
            artist: None,
            countdown_secs: None,
        }
    }

    fn public(&self) -> PartyStage {
        PartyStage {
            state: self.state,
            reservation_id: self.reservation_id.clone(),
            title: self.title.clone(),
            artist: self.artist.clone(),
            singers: self.singers.clone(),
            countdown_secs: self.countdown_secs,
        }
    }
}

struct Calibration {
    slot: u8,
    deadline: Instant,
}

/// One phone's party state, kept with its slot.
#[derive(Clone)]
pub(super) struct Phone {
    volume_pct: u8,
    echo_pct: u8,
    requests: Bucket,
    fx: Bucket,
    mixes: Bucket,
    /// A `mix` over the relay budget waits; the newest values win.
    mix_held: bool,
    shift_after: Option<Instant>,
    calibrate_after: Option<Instant>,
    sent: Option<Instant>,
    pending: bool,
}

impl Default for Phone {
    fn default() -> Self {
        Self {
            volume_pct: DEFAULT_VOLUME_PCT,
            echo_pct: DEFAULT_ECHO_PCT,
            requests: Bucket::every(PARTY_REQUEST_BURST, PARTY_REQUEST_REFILL_MS),
            fx: Bucket::every(FX_BURST, FX_REFILL_MS),
            mixes: Bucket::new(MIX_PER_SEC, MIX_PER_SEC),
            mix_held: false,
            shift_after: None,
            calibrate_after: None,
            sent: None,
            pending: false,
        }
    }
}

fn unix_secs() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u32::try_from(since.as_secs()).unwrap_or(u32::MAX)
        })
}

fn ack(phone: &Peer, req_id: Option<u32>, result: Result<Option<String>, PartyErrorCode>) {
    let Some(req_id) = req_id else {
        return;
    };
    let (ok, code, reservation_id) = match result {
        Ok(reservation_id) => (true, None, reservation_id),
        Err(code) => (false, Some(code), None),
    };
    phone.send(&ServerToMicParty::Ack {
        req_id,
        ok,
        code,
        reservation_id,
    });
}

/// Logs party work on the hub that ran longer than the hub's slow-lock limit.
fn slow(what: &str, frame: &str, started: Instant) {
    let took = started.elapsed();
    if took >= super::hub::SLOW_LOCK {
        tracing::warn!(ms = super::millis(took), frame, "slow {what}");
    }
}

fn party_frame_name(frame: &MicPartyToServer) -> &'static str {
    match frame {
        MicPartyToServer::Reserve { .. } => "reserve",
        MicPartyToServer::Edit { .. } => "edit",
        MicPartyToServer::SingAlong { .. } => "sing-along",
        MicPartyToServer::Cancel { .. } => "cancel",
        MicPartyToServer::Control { .. } => "control",
        MicPartyToServer::ShiftCurrent { .. } => "shift-current",
        MicPartyToServer::Calibrate { .. } => "calibrate",
        MicPartyToServer::Fx { .. } => "fx",
        MicPartyToServer::Mix { .. } => "mix",
    }
}

fn req_id(frame: &MicPartyToServer) -> Option<u32> {
    match frame {
        MicPartyToServer::Reserve { req_id, .. }
        | MicPartyToServer::Edit { req_id, .. }
        | MicPartyToServer::SingAlong { req_id, .. }
        | MicPartyToServer::Cancel { req_id, .. }
        | MicPartyToServer::Control { req_id, .. }
        | MicPartyToServer::ShiftCurrent { req_id, .. }
        | MicPartyToServer::Calibrate { req_id } => *req_id,
        MicPartyToServer::Fx { .. } | MicPartyToServer::Mix { .. } => None,
    }
}

impl Hub {
    /// Connects the reservation book; `configure` calls it.
    pub(crate) fn attach_party(&self, party: Arc<Party>, timings: Timings) {
        let mut inner = self.lock();
        inner.room.book = Some(party);
        inner.room.calibration_timeout = timings.calibration_timeout;
    }

    pub(super) fn mic_party(&self, conn: ConnId, frame: MicPartyToServer) {
        let started = Instant::now();
        let what = party_frame_name(&frame);
        let mut inner = self.lock();
        let Some(index) = inner.index_of_conn(conn) else {
            return;
        };
        let now = Instant::now();
        inner.on_mic_party(index, frame, now);
        inner.flush_party(now);
        drop(inner);
        slow("phone party frame", what, started);
    }

    pub(super) fn tv_party(
        &self,
        conn: ConnId,
        frame: TvPartyToServer,
    ) -> Result<(), RtcErrorCode> {
        let started = Instant::now();
        let mut inner = self.lock();
        if inner.tv.as_ref().is_none_or(|tv| tv.conn() != conn) {
            // A replaced TV socket is closing; its late frames go nowhere.
            return Ok(());
        }
        let result = inner.on_tv_party(frame);
        inner.flush_party(Instant::now());
        drop(inner);
        slow("TV party frame", "", started);
        result
    }

    /// Timers and coalesced sends; the party task calls it every 100 ms.
    pub(crate) fn party_tick(&self) {
        let started = Instant::now();
        let mut inner = self.lock();
        let now = Instant::now();
        if inner.forget_waiters(now) {
            inner.mark_party_dirty();
        }
        inner.expire_calibration(now);
        inner.flush_mixes();
        inner.flush_party(now);
        drop(inner);
        slow("party tick", "", started);
    }

    /// The playback queue changed (host, TV or party).
    pub(crate) fn party_changed(&self) {
        let mut inner = self.lock();
        inner.mark_party_dirty();
        inner.flush_party(Instant::now());
    }

    /// Follows preparing songs. It reads the library and the analyzer, so it
    /// runs on a blocking thread and holds only the book's lock meanwhile.
    pub(crate) fn prep_poll(&self) {
        let (book, protect) = {
            let inner = self.lock();
            (inner.room.book.clone(), inner.room.protects_head())
        };
        let Some(book) = book else {
            return;
        };
        let started = Instant::now();
        let poll = book
            .with(|book, library, analysis| book.poll(library, analysis, protect, Instant::now()));
        slow("preparation poll", "", started);
        if !poll.changed {
            return;
        }
        let mut inner = self.lock();
        for failed in &poll.failed {
            for mic_id in &failed.singers {
                if let Some(phone) = inner.phone_of_mic(mic_id) {
                    phone.send(&ServerToMicParty::Notice {
                        code: NoticeCode::PrepFailed,
                        title: Some(failed.title.clone()),
                        by_slot: None,
                    });
                }
            }
        }
        inner.mark_party_dirty();
        inner.flush_party(Instant::now());
    }
}

impl Inner {
    fn phone_of_mic(&self, mic_id: &str) -> Option<Peer> {
        let index = self.index_of_mic(mic_id)?;
        self.slots[index].as_ref()?.phone().cloned()
    }

    pub(super) fn mark_party_dirty(&mut self) {
        self.room.tv_pending = true;
        for entry in self.slots.iter_mut().flatten() {
            entry.party.pending = true;
        }
    }

    fn snapshot(&mut self) -> PartySnapshot {
        self.room.rev = self.room.rev.wrapping_add(1);
        let protect = self.room.protects_head();
        let (queue, queue_total) = match self.room.book.clone() {
            Some(book) => {
                let slots = &self.slots;
                let slot_of = |mic_id: &str| {
                    slots
                        .iter()
                        .position(|entry| {
                            entry.as_ref().is_some_and(|entry| entry.mic_id == mic_id)
                        })
                        .map(slot_number)
                };
                book.with(|book, library, _| book.snapshot(library, protect, &slot_of))
            }
            None => (Vec::new(), 0),
        };
        let singers = self
            .slots
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let entry = entry.as_ref()?;
                let slot = slot_number(index);
                Some(PartySinger {
                    slot,
                    color: slot_color(slot)?,
                    name: entry.name.clone(),
                    state: match entry.link {
                        Link::Connected(_) => SlotState::Connected,
                        Link::Reserved { .. } => SlotState::Reserved,
                    },
                    volume_pct: entry.party.volume_pct,
                    echo_pct: entry.party.echo_pct,
                })
            })
            .collect();
        PartySnapshot {
            rev: self.room.rev,
            tv_connected: self.tv.is_some(),
            stage: self.room.stage.public(),
            queue,
            queue_total,
            singers,
            scores: self.room.board.scores(unix_secs()),
            waiting: u32::try_from(self.waiting.len()).unwrap_or(u32::MAX),
        }
    }

    /// Sends the snapshot to every socket that is waiting for one and has not
    /// had one in the last 500 ms.
    pub(super) fn flush_party(&mut self, now: Instant) {
        let gap = Duration::from_millis(u64::from(PARTY_SNAPSHOT_MIN_INTERVAL_MS));
        let due = |sent: Option<Instant>| {
            sent.is_none_or(|sent| now.saturating_duration_since(sent) >= gap)
        };
        let tv_due = self.tv.is_some() && self.room.tv_pending && due(self.room.tv_sent);
        let phones: Vec<usize> = (0..SLOTS)
            .filter(|index| {
                self.slots[*index].as_ref().is_some_and(|entry| {
                    entry.phone().is_some() && entry.party.pending && due(entry.party.sent)
                })
            })
            .collect();
        if !tv_due && phones.is_empty() {
            return;
        }
        let party = self.snapshot();
        if tv_due {
            if let Some(tv) = &self.tv {
                tv.send(&ServerToTvParty::Party {
                    party: party.clone(),
                });
            }
            self.room.tv_sent = Some(now);
            self.room.tv_pending = false;
        }
        for index in phones {
            if let Some(entry) = self.slots[index].as_mut() {
                if let Some(phone) = entry.phone() {
                    phone.send(&ServerToMicParty::Party {
                        party: party.clone(),
                    });
                }
                entry.party.sent = Some(now);
                entry.party.pending = false;
            }
        }
    }

    /// The first snapshot goes right after `assign`.
    pub(super) fn party_after_assign(&mut self, index: usize) {
        let party = self.snapshot();
        if let Some(entry) = self.slots[index].as_mut() {
            if let Some(phone) = entry.phone() {
                phone.send(&ServerToMicParty::Party { party });
            }
            entry.party.sent = Some(Instant::now());
            entry.party.pending = false;
        }
    }

    /// After `ready` and `roster`: the snapshot and every occupied slot's mix.
    pub(super) fn party_tv_ready(&mut self) {
        self.room.stage = Stage::lobby();
        self.room.shifts = 0;
        self.mark_party_dirty();
        let party = self.snapshot();
        if let Some(tv) = &self.tv {
            tv.send(&ServerToTvParty::Party { party });
            for (index, entry) in self.slots.iter().enumerate() {
                if let Some(entry) = entry {
                    tv.send(&ServerToTvParty::Mix {
                        slot: slot_number(index),
                        volume_pct: entry.party.volume_pct,
                        echo_pct: entry.party.echo_pct,
                    });
                }
            }
        }
        self.room.tv_sent = Some(Instant::now());
        self.room.tv_pending = false;
    }

    pub(super) fn party_tv_gone(&mut self) {
        self.room.stage = Stage::lobby();
        self.room.shifts = 0;
        if let Some(calibration) = self.room.calibration.take() {
            if let Some(phone) = self.phone(calibration.slot) {
                phone.send(&ServerToMicParty::Calibration {
                    state: CalibrationState::Failed,
                    latency_ms: None,
                    reason: Some(CalibrationFailure::NoTv),
                });
            }
        }
        self.mark_party_dirty();
    }

    /// A slot was freed: its songs go to partners or leave the queue, and
    /// its mixer settings go back to the defaults.
    pub(super) fn party_slot_freed(&mut self, slot: u8, entry: &Entry) {
        if let Some(book) = self.room.book.clone() {
            let left =
                book.with(|book, library, analysis| book.release(library, analysis, &entry.mic_id));
            for change in &left {
                self.tell_owner(change, NoticeCode::PartnerLeft, slot);
            }
        }
        let mixed = (entry.party.volume_pct, entry.party.echo_pct)
            != (DEFAULT_VOLUME_PCT, DEFAULT_ECHO_PCT);
        if let (true, Some(tv)) = (mixed, &self.tv) {
            tv.send(&ServerToTvParty::Mix {
                slot,
                volume_pct: DEFAULT_VOLUME_PCT,
                echo_pct: DEFAULT_ECHO_PCT,
            });
        }
        if self
            .room
            .calibration
            .as_ref()
            .is_some_and(|calibration| calibration.slot == slot)
        {
            self.room.calibration = None;
        }
        self.mark_party_dirty();
    }

    /// §13.12: each result of an occupied slot goes on tonight's board, and
    /// each phone hears where its result placed.
    pub(super) fn record_scores(&mut self, title: Option<&str>, results: &[SlotResult]) {
        let now = unix_secs();
        let (slots, scores): (Vec<u8>, Vec<NightScore>) = results
            .iter()
            .filter_map(|result| {
                let entry = self.slots[slot_index(result.slot)?].as_ref()?;
                let score = NightScore {
                    slot: result.slot,
                    color: slot_color(result.slot)?,
                    name: entry.name.clone(),
                    title: title.map(str::to_owned),
                    display_score: result.display_score,
                    raw_score: result.raw_score,
                    tier: result.tier,
                    at_secs: now,
                };
                Some((result.slot, score))
            })
            .unzip();
        if scores.is_empty() {
            return;
        }
        let ranks = self.room.board.record(scores, now);
        let entries = self.room.board.made(now);
        for (slot, rank) in slots.into_iter().zip(ranks) {
            if let Some(phone) = self.phone(slot) {
                phone.send(&ServerToMicParty::NightRank { rank, entries });
            }
        }
        self.mark_party_dirty();
    }

    /// The host's `reset-scores`, and pairing-token rotation.
    pub(super) fn reset_scores(&mut self) {
        self.room.board.reset();
        self.mark_party_dirty();
    }

    fn expire_calibration(&mut self, now: Instant) {
        let expired = self
            .room
            .calibration
            .as_ref()
            .is_some_and(|calibration| calibration.deadline <= now);
        if !expired {
            return;
        }
        if let Some(calibration) = self.room.calibration.take() {
            if let Some(phone) = self.phone(calibration.slot) {
                phone.send(&ServerToMicParty::Calibration {
                    state: CalibrationState::Failed,
                    latency_ms: None,
                    reason: Some(CalibrationFailure::Timeout),
                });
            }
        }
    }

    fn flush_mixes(&mut self) {
        for index in 0..SLOTS {
            let Some(entry) = self.slots[index].as_mut() else {
                continue;
            };
            if !entry.party.mix_held || !entry.party.mixes.take() {
                continue;
            }
            entry.party.mix_held = false;
            let mix = ServerToTvParty::Mix {
                slot: slot_number(index),
                volume_pct: entry.party.volume_pct,
                echo_pct: entry.party.echo_pct,
            };
            if let Some(tv) = &self.tv {
                tv.send(&mix);
            }
        }
    }

    fn on_mic_party(&mut self, index: usize, frame: MicPartyToServer, now: Instant) {
        let slot = slot_number(index);
        let tv = self.tv.clone();
        let Some(entry) = self.slots[index].as_mut() else {
            return;
        };
        let Some(phone) = entry.phone().cloned() else {
            return;
        };
        let mic_id = entry.mic_id.clone();
        match frame {
            MicPartyToServer::Fx { sound } => {
                if entry.party.fx.take() {
                    if let Some(tv) = tv {
                        tv.send(&ServerToTvParty::Fx { slot, sound });
                    }
                }
            }
            MicPartyToServer::Mix {
                volume_pct,
                echo_pct,
            } => {
                let before = (entry.party.volume_pct, entry.party.echo_pct);
                entry.party.volume_pct = volume_pct.unwrap_or(entry.party.volume_pct);
                entry.party.echo_pct = echo_pct.unwrap_or(entry.party.echo_pct);
                let changed = before != (entry.party.volume_pct, entry.party.echo_pct);
                entry.party.mix_held = true;
                self.flush_mixes();
                if changed {
                    self.mark_party_dirty();
                }
            }
            request => {
                let req_id = req_id(&request);
                if !entry.party.requests.take() {
                    ack(&phone, req_id, Err(PartyErrorCode::RateLimited));
                    return;
                }
                self.on_request(index, &mic_id, &phone, request, now);
            }
        }
    }

    fn on_request(
        &mut self,
        index: usize,
        mic_id: &str,
        phone: &Peer,
        request: MicPartyToServer,
        now: Instant,
    ) {
        let slot = slot_number(index);
        let protect = self.room.protects_head();
        match request {
            MicPartyToServer::Reserve {
                req_id,
                file_hash,
                key_offset,
                tempo,
                sing_next,
                partners,
            } => {
                let partners = partners.unwrap_or_default();
                let mut partner_mics = Vec::with_capacity(partners.len());
                for partner in &partners {
                    let other = slot_index(*partner).and_then(|other| self.slots[other].as_ref());
                    match other {
                        Some(other) if *partner != slot => partner_mics.push(other.mic_id.clone()),
                        _ => return ack(phone, req_id, Err(PartyErrorCode::Invalid)),
                    }
                }
                let request = Reserve {
                    owner: mic_id.to_string(),
                    partners: partner_mics,
                    file_hash,
                    key_offset: key_offset.unwrap_or(0),
                    tempo: tempo.unwrap_or(1.0),
                    sing_next: sing_next.unwrap_or(false),
                };
                let reserved = self.with_book(|book, library, analysis| {
                    book.reserve(library, analysis, request, protect)
                });
                match reserved {
                    Ok(reserved) => {
                        ack(phone, req_id, Ok(Some(reserved.reservation_id)));
                        for partner in partners {
                            if let Some(partner) = self.phone(partner) {
                                partner.send(&ServerToMicParty::Notice {
                                    code: NoticeCode::DuetAdded,
                                    title: Some(reserved.title.clone()),
                                    by_slot: Some(slot),
                                });
                            }
                        }
                        self.mark_party_dirty();
                    }
                    Err(code) => ack(phone, req_id, Err(code)),
                }
            }
            MicPartyToServer::Edit {
                req_id,
                reservation_id,
                key_offset,
                tempo,
                sing_next,
            } => {
                let edit = Edit {
                    key_offset,
                    tempo,
                    sing_next,
                };
                let result = self.with_book(|book, library, _| {
                    book.edit(library, mic_id, &reservation_id, edit, protect)
                });
                self.answer(phone, req_id, result);
            }
            MicPartyToServer::SingAlong {
                req_id,
                reservation_id,
            } => {
                let result = self.with_book(|book, library, _| {
                    book.sing_along(library, mic_id, &reservation_id)
                });
                if let Ok(change) = &result {
                    self.tell_owner(change, NoticeCode::PartnerJoined, slot);
                }
                self.answer(phone, req_id, result.map(|_| ()));
            }
            MicPartyToServer::Cancel {
                req_id,
                reservation_id,
            } => {
                let result = self.with_book(|book, library, analysis| {
                    book.cancel(library, analysis, mic_id, &reservation_id)
                });
                if let Ok(Some(change)) = &result {
                    self.tell_owner(change, NoticeCode::PartnerLeft, slot);
                }
                self.answer(phone, req_id, result.map(|_| ()));
            }
            MicPartyToServer::Control { req_id, action } => {
                let result = self.control(slot, mic_id, action);
                ack(phone, req_id, result.map(|()| None));
            }
            MicPartyToServer::ShiftCurrent {
                req_id,
                key_offset,
                tempo,
            } => {
                let result = self.shift_current(index, mic_id, key_offset, tempo, now);
                ack(phone, req_id, result.map(|()| None));
            }
            MicPartyToServer::Calibrate { req_id } => match self.calibrate(index, mic_id, now) {
                Ok(()) => ack(phone, req_id, Ok(None)),
                Err((code, reason)) => {
                    ack(phone, req_id, Err(code));
                    if let Some(reason) = reason {
                        phone.send(&ServerToMicParty::Calibration {
                            state: CalibrationState::Failed,
                            latency_ms: None,
                            reason: Some(reason),
                        });
                    }
                }
            },
            MicPartyToServer::Fx { .. } | MicPartyToServer::Mix { .. } => {}
        }
    }

    fn with_book<T>(
        &self,
        work: impl FnOnce(
            &mut PartyBook,
            &dyn LibraryPort,
            &dyn AnalysisPort,
        ) -> Result<T, PartyErrorCode>,
    ) -> Result<T, PartyErrorCode> {
        match &self.room.book {
            Some(book) => book.with(work),
            None => Err(PartyErrorCode::Unavailable),
        }
    }

    /// Tells a song's owner that a partner joined or left it.
    fn tell_owner(&self, change: &PartnerChange, code: NoticeCode, by_slot: u8) {
        if let Some(owner) = self.phone_of_mic(&change.owner) {
            owner.send(&ServerToMicParty::Notice {
                code,
                title: Some(change.title.clone()),
                by_slot: Some(by_slot),
            });
        }
    }

    fn answer(&mut self, phone: &Peer, req_id: Option<u32>, result: Result<(), PartyErrorCode>) {
        if result.is_ok() {
            self.mark_party_dirty();
        }
        ack(phone, req_id, result.map(|()| None));
    }

    fn control(
        &mut self,
        slot: u8,
        mic_id: &str,
        action: PartyAction,
    ) -> Result<(), PartyErrorCode> {
        let Some(tv) = self.tv.clone() else {
            return Err(PartyErrorCode::NoTv);
        };
        let first_ready = match action {
            PartyAction::StartNow => self.first_ready_slots(),
            PartyAction::Pause | PartyAction::Resume | PartyAction::Stop => None,
        };
        check_control(
            action,
            slot,
            self.room.stage.state,
            &self.room.stage.singers,
            first_ready.as_deref(),
        )?;
        tv.send(&ServerToTvParty::Control {
            slot,
            mic_id: mic_id.to_string(),
            action,
        });
        Ok(())
    }

    /// The slots of the playback queue's first entry, `None` when it is empty.
    fn first_ready_slots(&self) -> Option<Vec<u8>> {
        let book = self.room.book.clone()?;
        let mics = book.with(|book, library, _| book.first_ready(library))?;
        Some(
            mics.iter()
                .filter_map(|mic| self.index_of_mic(mic).map(slot_number))
                .collect(),
        )
    }

    fn shift_current(
        &mut self,
        index: usize,
        mic_id: &str,
        key_offset: i8,
        tempo: f64,
        now: Instant,
    ) -> Result<(), PartyErrorCode> {
        let slot = slot_number(index);
        let Some(tv) = self.tv.clone() else {
            return Err(PartyErrorCode::NoTv);
        };
        check_singer(slot, self.room.stage.state, &self.room.stage.singers)?;
        if self.room.stage.shiftable == Some(false) {
            return Err(PartyErrorCode::Unavailable);
        }
        let shifts = self.room.shifts;
        let entry = self.slots[index]
            .as_mut()
            .ok_or(PartyErrorCode::NotAllowed)?;
        let cooling = entry.party.shift_after.is_some_and(|after| now < after);
        if cooling || shifts >= MAX_SHIFTS_PER_SONG {
            return Err(PartyErrorCode::RateLimited);
        }
        entry.party.shift_after =
            Some(now + Duration::from_secs(u64::from(SHIFT_CURRENT_COOLDOWN_SECS)));
        self.room.shifts += 1;
        tv.send(&ServerToTvParty::ShiftCurrent {
            slot,
            mic_id: mic_id.to_string(),
            key_offset,
            tempo,
        });
        Ok(())
    }

    /// One calibration at a time, in the lobby, every 30 s per slot. A
    /// refusal the tune-my-mic card shows also comes as `calibration`.
    fn calibrate(
        &mut self,
        index: usize,
        mic_id: &str,
        now: Instant,
    ) -> Result<(), (PartyErrorCode, Option<CalibrationFailure>)> {
        let slot = slot_number(index);
        let Some(tv) = self.tv.clone() else {
            return Err((PartyErrorCode::NoTv, Some(CalibrationFailure::NoTv)));
        };
        if self.room.stage.state != StageKind::Lobby || self.room.calibration.is_some() {
            return Err((PartyErrorCode::Busy, Some(CalibrationFailure::Busy)));
        }
        let deadline = now + self.room.calibration_timeout;
        let entry = self.slots[index]
            .as_mut()
            .ok_or((PartyErrorCode::NotAllowed, None))?;
        if entry.party.calibrate_after.is_some_and(|after| now < after) {
            return Err((PartyErrorCode::RateLimited, None));
        }
        entry.party.calibrate_after =
            Some(now + Duration::from_secs(u64::from(CALIBRATION_COOLDOWN_SECS)));
        self.room.calibration = Some(Calibration { slot, deadline });
        tv.send(&ServerToTvParty::Calibrate {
            slot,
            mic_id: mic_id.to_string(),
        });
        Ok(())
    }

    fn on_tv_party(&mut self, frame: TvPartyToServer) -> Result<(), RtcErrorCode> {
        match frame {
            TvPartyToServer::Stage {
                state,
                entry_id,
                singers,
                title,
                artist,
                countdown_secs,
            } => {
                let item = match (&self.room.book, entry_id.as_deref()) {
                    (Some(book), Some(entry_id)) => {
                        book.with(|book, _, _| book.stage_item(entry_id))
                    }
                    _ => None,
                };
                if state == StageKind::Lobby {
                    self.room.shifts = 0;
                }
                self.room.stage = Stage {
                    state,
                    reservation_id: item.as_ref().map(|item| item.reservation_id.clone()),
                    shiftable: item.map(|item| item.shiftable),
                    singers,
                    title,
                    artist,
                    countdown_secs,
                };
                self.mark_party_dirty();
            }
            TvPartyToServer::Lyric {
                line,
                next,
                line_ms,
                elapsed_ms,
                paused,
            } => {
                let lyric = ServerToMicParty::Lyric {
                    line,
                    next,
                    line_ms,
                    elapsed_ms,
                    paused,
                };
                for slot in &self.room.stage.singers {
                    if let Some(phone) = self.phone(*slot) {
                        phone.send(&lyric);
                    }
                }
            }
            TvPartyToServer::Calibration {
                slot,
                state,
                latency_ms,
                reason,
            } => {
                if let Some(phone) = self.phone(slot) {
                    phone.send(&ServerToMicParty::Calibration {
                        state,
                        latency_ms,
                        reason,
                    });
                }
                let finished = state != CalibrationState::Started;
                if finished
                    && self
                        .room
                        .calibration
                        .as_ref()
                        .is_some_and(|calibration| calibration.slot == slot)
                {
                    self.room.calibration = None;
                }
            }
            TvPartyToServer::Notify { slot, code, title } => {
                let entry = slot_index(slot)
                    .and_then(|index| self.slots[index].as_ref())
                    .ok_or(RtcErrorCode::UnknownSlot)?;
                if let Some(phone) = entry.phone() {
                    phone.send(&ServerToMicParty::Notice {
                        code,
                        title,
                        by_slot: None,
                    });
                }
            }
            TvPartyToServer::ResetScores => self.reset_scores(),
        }
        Ok(())
    }
}
