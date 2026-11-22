//! The `/rtc` slot registry and relay. Every operation takes the lock, applies
//! the PROTOCOL.md rules, queues frames on the peers' channels and returns; no
//! lock is held across an await. Party frames (§13) are handled in
//! [`super::party`] on the same state.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use app_core::remote_mic::{
    close_code, slot_color, IceServer, LatencyMethod, MicToServer, MuteSource, RtcErrorCode,
    ServerToMic, ServerToTv, SlotLostReason, SlotResult, SlotState, TvSlot, TvToServer,
    OFFER_BURST, OFFER_PER_SEC, PROTOCOL_VERSION, SLOT_COUNT,
};
use serde::Serialize;
use tokio::sync::{mpsc, Notify};

use super::mic_store::MicStore;
use super::party::{Phone, Room};
use super::Bucket;
use crate::host_auth::new_token;
use crate::remote::constant_time_eq;

pub(crate) type ConnId = u64;

pub(super) const SLOTS: usize = SLOT_COUNT as usize;

/// Close code for a normal close after `bye`.
const CLOSE_NORMAL: u16 = 1000;
/// Waiting longer than this for the hub is logged with the caller.
pub(super) const SLOW_LOCK: Duration = Duration::from_millis(250);

#[derive(Debug)]
pub(crate) enum Outbound {
    Text(String),
    Close(u16),
}

/// One socket's outbound side. The socket task owns the receiver; a full
/// channel means the client stopped reading, and `overflow` tells the task to
/// drop it.
#[derive(Clone)]
pub(crate) struct Peer {
    conn: ConnId,
    tx: mpsc::Sender<Outbound>,
    overflow: Arc<Notify>,
}

impl Peer {
    pub(crate) fn new(
        conn: ConnId,
        capacity: usize,
    ) -> (Self, mpsc::Receiver<Outbound>, Arc<Notify>) {
        let (tx, rx) = mpsc::channel(capacity);
        let overflow = Arc::new(Notify::new());
        let peer = Self {
            conn,
            tx,
            overflow: overflow.clone(),
        };
        (peer, rx, overflow)
    }

    pub(crate) fn send<T: Serialize>(&self, frame: &T) {
        match serde_json::to_string(frame) {
            Ok(text) => self.push(Outbound::Text(text)),
            Err(error) => tracing::warn!("cannot serialise an rtc frame: {error}"),
        }
    }

    pub(crate) fn close(&self, code: u16) {
        self.push(Outbound::Close(code));
    }

    pub(super) fn conn(&self) -> ConnId {
        self.conn
    }

    fn push(&self, frame: Outbound) {
        if let Err(mpsc::error::TrySendError::Full(_)) = self.tx.try_send(frame) {
            self.overflow.notify_one();
        }
    }
}

#[derive(Clone)]
pub(super) enum Link {
    Connected(Peer),
    Reserved { until: Instant },
}

#[derive(Clone)]
pub(super) struct Entry {
    pub(super) mic_id: String,
    resume_key: String,
    pub(super) link: Link,
    pub(super) name: Option<String>,
    muted: bool,
    muted_by: MuteSource,
    latency_ms: Option<u32>,
    latency_method: Option<LatencyMethod>,
    /// Newest offer over the slot's offer budget, relayed once it refills.
    held_offer: Option<HeldOffer>,
    pub(super) party: Phone,
}

#[derive(Clone)]
struct HeldOffer {
    sdp: String,
    restart: bool,
}

impl Entry {
    pub(super) fn phone(&self) -> Option<&Peer> {
        match &self.link {
            Link::Connected(peer) => Some(peer),
            Link::Reserved { .. } => None,
        }
    }
}

/// What a phone sent in `hello`, already validated by `decode_mic_frame`.
pub(crate) struct MicHello {
    pub(crate) mic_id: String,
    pub(crate) resume_key: Option<String>,
    pub(crate) slot: Option<u8>,
    pub(crate) name: Option<String>,
}

pub(crate) struct Hub {
    inner: Mutex<Inner>,
}

pub(super) struct Inner {
    ice_servers: Vec<IceServer>,
    reservation: Duration,
    pub(super) tv: Option<Peer>,
    /// When the last TV socket closed, while no TV is connected.
    tv_left_at: Option<Instant>,
    pub(super) slots: [Option<Entry>; SLOTS],
    /// Per slot number, not per phone, so rejoining cannot refill it.
    offer_budget: [Bucket; SLOTS],
    store: MicStore,
    pub(super) room: Room,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new(
            Vec::new(),
            Duration::from_secs(u64::from(app_core::remote_mic::RESERVATION_SECS)),
            MicStore::in_memory(),
        )
    }
}

impl Hub {
    pub(crate) fn new(ice_servers: Vec<IceServer>, reservation: Duration, store: MicStore) -> Self {
        Self {
            inner: Mutex::new(Inner {
                ice_servers,
                reservation,
                tv: None,
                tv_left_at: None,
                slots: Default::default(),
                offer_budget: std::array::from_fn(|_| Bucket::new(OFFER_BURST, OFFER_PER_SEC)),
                store,
                room: Room::default(),
            }),
        }
    }

    pub(crate) fn configure(
        &self,
        ice_servers: Vec<IceServer>,
        reservation: Duration,
        store: MicStore,
    ) {
        let mut inner = self.lock();
        inner.ice_servers = ice_servers;
        inner.reservation = reservation;
        inner.store = store;
    }

    #[track_caller]
    pub(super) fn lock(&self) -> MutexGuard<'_, Inner> {
        let asked = Instant::now();
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let waited = asked.elapsed();
        inner.expire(Instant::now());
        inner.flush_offers();
        let total = asked.elapsed();
        if total >= SLOW_LOCK {
            tracing::warn!(
                waited_ms = super::millis(waited),
                expire_ms = super::millis(total.saturating_sub(waited)),
                at = %std::panic::Location::caller(),
                "slow rtc hub lock"
            );
        }
        inner
    }

    /// Ends reservations that ran out and relays held offers whose slot has
    /// budget again. Socket ticks call it, so it runs at least once per ping
    /// interval while anyone is connected.
    pub(crate) fn sweep(&self) {
        drop(self.lock());
    }

    pub(crate) fn tv_hello(&self, peer: Peer) {
        let mut inner = self.lock();
        inner.drop_held_offers();
        inner.tv_left_at = None;
        if let Some(old) = inner.tv.replace(peer.clone()) {
            old.send(&ServerToTv::Error {
                code: RtcErrorCode::TvReplaced,
                message: None,
            });
            old.close(close_code::REPLACED);
        }
        peer.send(&ServerToTv::Ready {
            v: PROTOCOL_VERSION,
            ice_servers: inner.ice_servers.clone(),
        });
        peer.send(&ServerToTv::Roster {
            slots: inner.roster(Instant::now()),
        });
        inner.party_tv_ready();
        inner.tell_phones_tv_state(true);
    }

    /// Frees the TV seat if `conn` holds it; returns whether it did.
    pub(crate) fn tv_gone(&self, conn: ConnId) -> bool {
        let mut inner = self.lock();
        if inner.tv.as_ref().is_none_or(|tv| tv.conn != conn) {
            return false;
        }
        inner.tv = None;
        inner.tv_left_at = Some(Instant::now());
        inner.drop_held_offers();
        inner.tell_phones_tv_state(false);
        inner.party_tv_gone();
        true
    }

    /// When the TV left and for how long, while no TV is connected.
    pub(crate) fn tv_absence(&self) -> Option<(Instant, Duration)> {
        let inner = self.lock();
        match (&inner.tv, inner.tv_left_at) {
            (None, Some(left)) => Some((left, left.elapsed())),
            _ => None,
        }
    }

    pub(crate) fn tv_frame(&self, conn: ConnId, frame: TvToServer) -> Result<(), RtcErrorCode> {
        let mut inner = self.lock();
        let Some(tv) = inner.tv.clone().filter(|tv| tv.conn == conn) else {
            // A replaced TV socket is closing; its late frames go nowhere.
            return Ok(());
        };
        match frame {
            TvToServer::Hello { .. } => Err(RtcErrorCode::BadHello),
            TvToServer::Ping { t } => {
                tv.send(&ServerToTv::Pong { t });
                Ok(())
            }
            TvToServer::Answer { slot, sdp } => {
                tracing::trace!(slot, "rtc answer: {sdp}");
                let phone = inner.phone(slot).ok_or(RtcErrorCode::UnknownSlot)?;
                phone.send(&ServerToMic::Answer { sdp });
                Ok(())
            }
            TvToServer::Ice { slot, candidate } => {
                tracing::trace!(slot, "rtc tv candidate: {candidate:?}");
                if let Some(phone) = inner.phone(slot) {
                    phone.send(&ServerToMic::Ice { candidate });
                }
                Ok(())
            }
            TvToServer::Restart { slot } => {
                let phone = inner.phone(slot).ok_or(RtcErrorCode::UnknownSlot)?;
                phone.send(&ServerToMic::Restart);
                Ok(())
            }
            TvToServer::Mute { slot, muted } => {
                let entry = inner.entry_mut(slot).ok_or(RtcErrorCode::UnknownSlot)?;
                entry.muted = muted;
                entry.muted_by = MuteSource::Tv;
                if let Some(phone) = entry.phone() {
                    phone.send(&ServerToMic::Mute {
                        muted,
                        by: MuteSource::Tv,
                    });
                }
                inner.send_roster();
                Ok(())
            }
            TvToServer::Kick { slot } => {
                let entry = inner.take_entry(slot).ok_or(RtcErrorCode::UnknownSlot)?;
                inner.kick(slot, &entry);
                inner.party_slot_freed(slot, &entry);
                inner.send_roster();
                Ok(())
            }
            TvToServer::Latency {
                slot,
                latency_ms,
                method,
            } => {
                let entry = inner.entry_mut(slot).ok_or(RtcErrorCode::UnknownSlot)?;
                entry.latency_ms = Some(latency_ms);
                entry.latency_method = Some(method);
                let mic_id = entry.mic_id.clone();
                let name = entry.name.clone();
                if let Some(name) = name {
                    inner.store.set_name(&mic_id, &name);
                }
                inner.store.set_latency(&mic_id, latency_ms, method);
                inner.send_roster();
                Ok(())
            }
            TvToServer::SongResult { title, results } => {
                let singers = u8::try_from(results.len()).ok();
                for result in results.iter().cloned() {
                    let SlotResult {
                        slot,
                        display_score,
                        raw_score,
                        tier,
                        rank,
                    } = result;
                    if let Some(phone) = inner.phone(slot) {
                        phone.send(&ServerToMic::SongResult {
                            display_score,
                            raw_score,
                            tier,
                            rank,
                            singers,
                            title: title.clone(),
                        });
                    }
                }
                inner.record_scores(title.as_deref(), &results);
                Ok(())
            }
        }
    }

    /// PROTOCOL.md §6.1. `Err` is fatal for the calling socket.
    pub(crate) fn mic_hello(&self, peer: Peer, hello: MicHello) -> Result<(), RtcErrorCode> {
        let mut inner = self.lock();
        let MicHello {
            mic_id,
            resume_key,
            slot: wanted,
            name,
        } = hello;
        let name = name.map(|name| name.trim().to_string());

        if let Some(index) = inner.index_of_mic(&mic_id) {
            let slot = slot_number(index);
            let tv = inner.tv.clone();
            let Some(entry) = inner.slots[index].as_mut() else {
                return Err(RtcErrorCode::BadResume);
            };
            let key_matches = resume_key
                .as_deref()
                .is_some_and(|key| constant_time_eq(key, &entry.resume_key));
            if !key_matches {
                return Err(RtcErrorCode::BadResume);
            }
            if let Some(old) = entry.phone().filter(|old| old.conn != peer.conn) {
                old.send(&ServerToMic::SlotLost {
                    reason: SlotLostReason::Replaced,
                });
                old.close(close_code::REPLACED);
                if let Some(tv) = &tv {
                    tv.send(&ServerToTv::SlotLost {
                        slot,
                        mic_id: mic_id.clone(),
                        reason: SlotLostReason::Replaced,
                    });
                }
            }
            entry.link = Link::Connected(peer.clone());
            entry.held_offer = None;
            if name.is_some() {
                entry.name.clone_from(&name);
            }
            let entry = entry.clone();
            if let Some(name) = &name {
                inner.store.set_name(&mic_id, name);
            }
            inner.assign(slot, &entry, true);
            inner.party_after_assign(index);
            inner.send_roster();
            return Ok(());
        }

        let index = inner.pick_slot(wanted).ok_or(RtcErrorCode::SlotsFull)?;
        let slot = slot_number(index);
        if let Some(evicted) = inner.slots[index].take() {
            if let Some(tv) = &inner.tv {
                tv.send(&ServerToTv::SlotLost {
                    slot,
                    mic_id: evicted.mic_id.clone(),
                    reason: SlotLostReason::Evicted,
                });
            }
            inner.party_slot_freed(slot, &evicted);
        }
        let stored = inner.store.get(&mic_id).cloned().unwrap_or_default();
        let entry = Entry {
            mic_id: mic_id.clone(),
            resume_key: new_token(),
            link: Link::Connected(peer),
            name: name.clone().or(stored.name),
            muted: false,
            muted_by: MuteSource::Mic,
            latency_ms: stored.latency_ms,
            latency_method: stored.latency_method,
            held_offer: None,
            party: Phone::default(),
        };
        inner.slots[index] = Some(entry.clone());
        if let Some(name) = &name {
            inner.store.set_name(&mic_id, name);
        }
        inner.assign(slot, &entry, false);
        inner.party_after_assign(index);
        inner.send_roster();
        Ok(())
    }

    pub(crate) fn mic_frame(&self, conn: ConnId, frame: MicToServer) -> Result<(), RtcErrorCode> {
        let mut inner = self.lock();
        let Some(index) = inner.index_of_conn(conn) else {
            // Kicked, replaced or gone: the socket is closing.
            return Ok(());
        };
        let slot = slot_number(index);
        let tv = inner.tv.clone();
        let Some(entry) = inner.slots[index].as_mut() else {
            return Ok(());
        };
        let mic_id = entry.mic_id.clone();
        match frame {
            MicToServer::Hello { .. } => Err(RtcErrorCode::BadHello),
            MicToServer::Ping { t } => {
                if let Some(phone) = entry.phone() {
                    phone.send(&ServerToMic::Pong { t });
                }
                Ok(())
            }
            MicToServer::Offer { sdp, restart } => {
                tracing::trace!(slot, restart, "rtc offer: {sdp}");
                if tv.is_none() {
                    return Err(RtcErrorCode::NoTv);
                }
                inner.offer(index, HeldOffer { sdp, restart });
                Ok(())
            }
            MicToServer::Ice { candidate } => {
                tracing::trace!(slot, "rtc phone candidate: {candidate:?}");
                if let Some(tv) = tv {
                    tv.send(&ServerToTv::Ice {
                        slot,
                        mic_id,
                        candidate,
                    });
                }
                Ok(())
            }
            MicToServer::Diag { data } => {
                tracing::trace!(slot, "rtc diag: {data:?}");
                if let Some(tv) = tv {
                    tv.send(&ServerToTv::Diag { slot, mic_id, data });
                }
                Ok(())
            }
            MicToServer::Mute { muted } => {
                entry.muted = muted;
                entry.muted_by = MuteSource::Mic;
                if let Some(tv) = tv {
                    tv.send(&ServerToTv::Mute {
                        slot,
                        muted,
                        by: MuteSource::Mic,
                    });
                }
                inner.send_roster();
                Ok(())
            }
            MicToServer::Bye => {
                if let Some(phone) = entry.phone() {
                    phone.close(CLOSE_NORMAL);
                }
                if let Some(entry) = inner.slots[index].take() {
                    inner.party_slot_freed(slot, &entry);
                }
                inner.slot_lost(slot, mic_id, SlotLostReason::Bye);
                inner.send_roster();
                Ok(())
            }
        }
    }

    /// The phone socket closed without `bye`: keep its slot for a reconnect.
    pub(crate) fn mic_gone(&self, conn: ConnId) {
        let mut inner = self.lock();
        let Some(index) = inner.index_of_conn(conn) else {
            return;
        };
        let until = Instant::now() + inner.reservation;
        let Some(entry) = inner.slots[index].as_mut() else {
            return;
        };
        entry.link = Link::Reserved { until };
        entry.held_offer = None;
        let mic_id = entry.mic_id.clone();
        inner.slot_lost(slot_number(index), mic_id, SlotLostReason::Disconnected);
        inner.send_roster();
    }

    /// Frees every slot and disconnects every phone, and clears tonight's
    /// scores (pairing-token rotation).
    pub(crate) fn kick_all(&self) -> usize {
        let mut inner = self.lock();
        let mut kicked = 0;
        for index in 0..SLOTS {
            if let Some(entry) = inner.slots[index].take() {
                inner.kick(slot_number(index), &entry);
                inner.party_slot_freed(slot_number(index), &entry);
                kicked += 1;
            }
        }
        inner.reset_scores();
        if kicked > 0 {
            inner.send_roster();
        }
        kicked
    }
}

pub(super) fn slot_number(index: usize) -> u8 {
    u8::try_from(index + 1).unwrap_or(SLOT_COUNT)
}

pub(super) fn slot_index(slot: u8) -> Option<usize> {
    let index = usize::from(slot).checked_sub(1)?;
    (index < SLOTS).then_some(index)
}

impl Inner {
    fn expire(&mut self, now: Instant) {
        let mut changed = false;
        for index in 0..SLOTS {
            let expired = self.slots[index].as_ref().is_some_and(
                |entry| matches!(entry.link, Link::Reserved { until } if until <= now),
            );
            if expired {
                if let Some(entry) = self.slots[index].take() {
                    self.party_slot_freed(slot_number(index), &entry);
                    self.slot_lost(slot_number(index), entry.mic_id, SlotLostReason::Expired);
                    changed = true;
                }
            }
        }
        if changed {
            self.send_roster();
        }
    }

    /// Relays a phone's offer while its slot has offer budget; otherwise holds
    /// it, newest wins, for [`Inner::flush_offers`].
    fn offer(&mut self, index: usize, offer: HeldOffer) {
        let Some(entry) = self.slots[index].as_mut() else {
            return;
        };
        if !self.offer_budget[index].take() {
            entry.held_offer = Some(offer);
            return;
        }
        entry.held_offer = None;
        if let Some(tv) = &self.tv {
            tv.send(&ServerToTv::Offer {
                slot: slot_number(index),
                mic_id: entry.mic_id.clone(),
                sdp: offer.sdp,
                restart: offer.restart,
            });
        }
    }

    fn flush_offers(&mut self) {
        let Some(tv) = &self.tv else {
            return;
        };
        for index in 0..SLOTS {
            let Some(entry) = self.slots[index].as_mut() else {
                continue;
            };
            if entry.held_offer.is_none() || !self.offer_budget[index].take() {
                continue;
            }
            if let Some(offer) = entry.held_offer.take() {
                tv.send(&ServerToTv::Offer {
                    slot: slot_number(index),
                    mic_id: entry.mic_id.clone(),
                    sdp: offer.sdp,
                    restart: offer.restart,
                });
            }
        }
    }

    /// Offers meant for a TV that is gone; phones offer again on `tv-state`.
    fn drop_held_offers(&mut self) {
        for entry in self.slots.iter_mut().flatten() {
            entry.held_offer = None;
        }
    }

    pub(super) fn index_of_mic(&self, mic_id: &str) -> Option<usize> {
        self.slots
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|entry| entry.mic_id == mic_id))
    }

    pub(super) fn index_of_conn(&self, conn: ConnId) -> Option<usize> {
        self.slots.iter().position(|entry| {
            entry
                .as_ref()
                .and_then(Entry::phone)
                .is_some_and(|phone| phone.conn == conn)
        })
    }

    fn entry_mut(&mut self, slot: u8) -> Option<&mut Entry> {
        self.slots[slot_index(slot)?].as_mut()
    }

    fn take_entry(&mut self, slot: u8) -> Option<Entry> {
        self.slots[slot_index(slot)?].take()
    }

    pub(super) fn phone(&self, slot: u8) -> Option<Peer> {
        self.slots[slot_index(slot)?]
            .as_ref()
            .and_then(Entry::phone)
            .cloned()
    }

    /// PROTOCOL.md §6.1 step 2: the wanted slot if empty, the lowest empty
    /// slot, the wanted slot if reserved, the reservation ending soonest.
    fn pick_slot(&self, wanted: Option<u8>) -> Option<usize> {
        let wanted = wanted.and_then(slot_index);
        let empty = |index: &usize| self.slots[*index].is_none();
        let reserved_until =
            |index: usize| match self.slots[index].as_ref().map(|entry| &entry.link) {
                Some(Link::Reserved { until }) => Some(*until),
                _ => None,
            };

        wanted
            .filter(empty)
            .or_else(|| (0..SLOTS).find(empty))
            .or_else(|| wanted.filter(|index| reserved_until(*index).is_some()))
            .or_else(|| {
                (0..SLOTS)
                    .filter_map(|index| reserved_until(index).map(|until| (until, index)))
                    .min()
                    .map(|(_, index)| index)
            })
    }

    fn assign(&self, slot: u8, entry: &Entry, reclaimed: bool) {
        let (Some(phone), Some(color)) = (entry.phone(), slot_color(slot)) else {
            return;
        };
        phone.send(&ServerToMic::Assign {
            v: PROTOCOL_VERSION,
            slot,
            color,
            mic_id: entry.mic_id.clone(),
            resume_key: entry.resume_key.clone(),
            reclaimed,
            tv_connected: self.tv.is_some(),
            ice_servers: self.ice_servers.clone(),
        });
        if entry.muted {
            phone.send(&ServerToMic::Mute {
                muted: true,
                by: entry.muted_by,
            });
        }
    }

    fn kick(&self, slot: u8, entry: &Entry) {
        if let Some(phone) = entry.phone() {
            phone.send(&ServerToMic::SlotLost {
                reason: SlotLostReason::Kicked,
            });
            phone.close(close_code::KICKED);
        }
        self.slot_lost(slot, entry.mic_id.clone(), SlotLostReason::Kicked);
    }

    fn slot_lost(&self, slot: u8, mic_id: String, reason: SlotLostReason) {
        if let Some(tv) = &self.tv {
            tv.send(&ServerToTv::SlotLost {
                slot,
                mic_id,
                reason,
            });
        }
    }

    /// Every registry change also changes the party snapshot's singers.
    fn send_roster(&mut self) {
        self.mark_party_dirty();
        if let Some(tv) = &self.tv {
            tv.send(&ServerToTv::Roster {
                slots: self.roster(Instant::now()),
            });
        }
    }

    fn tell_phones_tv_state(&self, connected: bool) {
        for phone in self.slots.iter().flatten().filter_map(Entry::phone) {
            phone.send(&ServerToMic::TvState { connected });
        }
    }

    fn roster(&self, now: Instant) -> Vec<TvSlot> {
        (0..SLOTS)
            .filter_map(|index| {
                let slot = slot_number(index);
                let color = slot_color(slot)?;
                let Some(entry) = &self.slots[index] else {
                    return Some(TvSlot {
                        slot,
                        color,
                        state: SlotState::Empty,
                        mic_id: None,
                        name: None,
                        muted: false,
                        latency_ms: None,
                        latency_method: None,
                        reserved_for_secs: None,
                    });
                };
                let (state, reserved_for_secs) = match &entry.link {
                    Link::Connected(_) => (SlotState::Connected, None),
                    Link::Reserved { until } => {
                        let left = until.saturating_duration_since(now);
                        let secs = left.as_secs() + u64::from(left.subsec_nanos() > 0);
                        (
                            SlotState::Reserved,
                            Some(u32::try_from(secs).unwrap_or(u32::MAX)),
                        )
                    }
                };
                Some(TvSlot {
                    slot,
                    color,
                    state,
                    mic_id: Some(entry.mic_id.clone()),
                    name: entry.name.clone(),
                    muted: entry.muted,
                    latency_ms: entry.latency_ms,
                    latency_method: entry.latency_method,
                    reserved_for_secs,
                })
            })
            .collect()
    }
}
