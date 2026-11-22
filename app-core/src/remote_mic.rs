//! FireSong phone microphones: the `/rtc` signaling contract.
//!
//! Phones send their voice peer-to-peer to the TV over WebRTC; the server only
//! relays signaling and owns the slot registry. This module holds the wire
//! types, limits, and frame validation shared by the server adapter and (via
//! ts-rs) the web client. `docs/firesong/PROTOCOL.md` is the prose contract.
//!
//! Inbound frames are typed per role: a socket accepted on the phone listener
//! decodes [`MicToServer`] only, one on the TV listener [`TvToServer`] only,
//! so a phone cannot send TV frames. Fields that name the sender (`slot`,
//! `micId`) never appear in inbound phone frames; the server stamps them.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::playback_session::PlayerColor;

/// Bumped on any incompatible wire change. Both `hello` frames carry it.
pub const PROTOCOL_VERSION: u32 = 1;

/// WebSocket path on both listeners. The listener decides the role.
pub const RTC_PATH: &str = "/rtc";

/// Phone page path on the remote listener (`/m?t=<token>&slot=<n>`).
pub const MIC_PAGE_PATH: &str = "/m";

/// Device ids of phone microphones in the client's `MicrophoneAdapter`.
pub const REMOTE_MIC_DEVICE_PREFIX: &str = "remote:";

pub const SLOT_COUNT: u8 = 4;

/// How long a dropped phone keeps its slot for a reconnect with the same
/// `micId` and `resumeKey`.
pub const RESERVATION_SECS: u32 = 600;

/// While every slot is taken, a newcomer may take a dropped phone's slot only
/// after it has been gone this long, so a locked screen or a browser restart
/// does not cost a guest the mic and the songs they queued.
pub const EVICT_AFTER_SECS: u32 = 120;

/// The server sends a WebSocket ping this often on every `/rtc` socket.
pub const PING_INTERVAL_SECS: u32 = 5;

/// A socket with no inbound traffic (frames or pongs) for this long is closed.
pub const IDLE_TIMEOUT_SECS: u32 = 15;

/// A socket must send `hello` within this many seconds of the upgrade.
pub const HELLO_TIMEOUT_SECS: u32 = 5;

pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_SDP_BYTES: usize = 32_768;
pub const MAX_CANDIDATE_BYTES: usize = 1_024;
pub const MAX_DIAG_BYTES: usize = 8_192;
pub const MAX_NAME_CHARS: usize = 32;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MIC_ID_MIN_LEN: usize = 8;
pub const MIC_ID_MAX_LEN: usize = 64;
pub const RESUME_KEY_LEN: usize = 32;
pub const MAX_LATENCY_MS: u32 = 1_000;
pub const MAX_DISPLAY_SCORE: u8 = 100;
pub const MAX_RAW_SCORE: u32 = 1_000;

/// Per-socket token bucket: `RATE_BURST` frames, refilled at `RATE_PER_SEC`.
/// The TV socket answers for every slot, so its bucket is `SLOT_COUNT` times
/// larger.
pub const RATE_BURST: u32 = 40;
pub const RATE_PER_SEC: u32 = 20;

/// Offers relayed to the TV per slot: `OFFER_BURST`, refilled at
/// `OFFER_PER_SEC`. Offers beyond that are held, newest only, until the slot
/// has budget again, so no phone can keep the TV renegotiating.
pub const OFFER_BURST: u32 = 4;
pub const OFFER_PER_SEC: u32 = 1;

/// WebSocket close codes the server uses on `/rtc`.
pub mod close_code {
    /// `bad-hello`, `version`, or a fatal `bad-frame`.
    pub const BAD_REQUEST: u16 = 4400;
    /// `bad-resume`: the phone must drop its stored identity and rejoin.
    pub const BAD_RESUME: u16 = 4403;
    /// `no-hello` within [`super::HELLO_TIMEOUT_SECS`], or idle timeout.
    pub const TIMEOUT: u16 = 4408;
    /// Another socket took over this slot or the TV seat. Do not reconnect.
    pub const REPLACED: u16 = 4409;
    /// The TV removed this phone. Do not reconnect automatically.
    pub const KICKED: u16 = 4410;
    pub const TOO_LARGE: u16 = 4413;
    pub const RATE_LIMITED: u16 = 4429;
    /// All four slots are held by connected phones.
    pub const SLOTS_FULL: u16 = 4503;
}

/// Slot colour, fixed per slot so a printed QR and the TV badge always agree.
pub fn slot_color(slot: u8) -> Option<PlayerColor> {
    match slot {
        1 => Some(PlayerColor::Rose),
        2 => Some(PlayerColor::Fuchsia),
        3 => Some(PlayerColor::Amber),
        4 => Some(PlayerColor::Emerald),
        _ => None,
    }
}

pub fn is_valid_slot(slot: u8) -> bool {
    (1..=SLOT_COUNT).contains(&slot)
}

/// `micId` is chosen by the phone (a UUID in its localStorage) and is public:
/// it appears in device ids. 8-64 chars of `[A-Za-z0-9_-]`.
pub fn is_valid_mic_id(mic_id: &str) -> bool {
    (MIC_ID_MIN_LEN..=MIC_ID_MAX_LEN).contains(&mic_id.len())
        && mic_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// `resumeKey` is issued by the server (128 random bits, lowercase hex) and is
/// the secret that lets a phone reclaim its slot.
pub fn is_valid_resume_key(key: &str) -> bool {
    key.len() == RESUME_KEY_LEN
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn remote_mic_device_id(mic_id: &str) -> String {
    format!("{REMOTE_MIC_DEVICE_PREFIX}{mic_id}")
}

/// The `micId` inside a `remote:<micId>` device id, or `None` for any other id.
pub fn parse_remote_mic_device_id(device_id: &str) -> Option<&str> {
    device_id
        .strip_prefix(REMOTE_MIC_DEVICE_PREFIX)
        .filter(|mic_id| is_valid_mic_id(mic_id))
}

/// One ICE candidate, shaped like the browser's `RTCIceCandidateInit`.
/// `null` in place of the whole candidate means end-of-candidates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub sdp_mid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub sdp_m_line_index: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub username_fragment: Option<String>,
}

/// Shaped like the browser's `RTCIceServer`. Empty list = LAN host candidates only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum SlotState {
    /// No phone and no reservation.
    Empty,
    /// A phone holds the slot over a live socket.
    Connected,
    /// The phone dropped; the slot is kept for it until the reservation ends.
    Reserved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum MuteSource {
    Mic,
    Tv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum LatencyMethod {
    /// The beep/loopback calibration run through this slot.
    Beep,
    /// Running estimate from WebRTC receiver stats.
    Stats,
    /// Set by hand on the TV.
    Manual,
}

/// Why a slot's phone went away. To the TV: any value. To a phone: only
/// `replaced` or `kicked`, right before the server closes its socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum SlotLostReason {
    /// Socket dropped without `bye`; the slot is now `reserved`.
    Disconnected,
    /// The phone sent `bye`; the slot is free.
    Bye,
    /// The reservation ran out; the slot is free.
    Expired,
    /// A new phone took this reserved slot because no slot was empty.
    Evicted,
    /// The TV sent `kick`; the slot is free.
    Kicked,
    /// A newer socket with the same `micId` and `resumeKey` took the slot.
    Replaced,
}

/// Noraebang tier of a 0-100 display score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum ScoreTier {
    /// 100
    Perfect,
    /// 90-99
    Excellent,
    /// 80-89
    Great,
    /// 70-79
    Good,
    /// 0-69
    Retry,
}

impl ScoreTier {
    pub fn for_display_score(score: u8) -> Self {
        match score {
            100.. => Self::Perfect,
            90..=99 => Self::Excellent,
            80..=89 => Self::Great,
            70..=79 => Self::Good,
            _ => Self::Retry,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum RtcErrorCode {
    /// Not JSON, unknown `type` for this role, or a field out of range.
    BadFrame,
    /// `hello` with an invalid `micId`, `resumeKey`, `slot` or `name`, or a second `hello`.
    BadHello,
    /// Any frame before `hello`, or no `hello` in time.
    NoHello,
    /// `hello.v` is not [`PROTOCOL_VERSION`].
    Version,
    /// All slots are held by connected phones.
    SlotsFull,
    /// `micId` is registered and `resumeKey` is missing or wrong.
    BadResume,
    /// A phone sent `offer`/`ice` while no TV is connected.
    NoTv,
    /// The TV addressed a slot with no connected phone.
    UnknownSlot,
    /// Frame, SDP, candidate or diag over its limit.
    TooLarge,
    /// The socket exceeded the frame rate limit.
    RateLimited,
    /// A newer TV socket took the TV seat.
    TvReplaced,
}

impl RtcErrorCode {
    /// Fatal codes are followed by a close with [`RtcErrorCode::close_code`].
    pub fn is_fatal(self) -> bool {
        !matches!(self, Self::BadFrame | Self::NoTv | Self::UnknownSlot)
    }

    pub fn close_code(self) -> u16 {
        match self {
            Self::BadFrame | Self::BadHello | Self::Version => close_code::BAD_REQUEST,
            Self::NoHello => close_code::TIMEOUT,
            Self::SlotsFull => close_code::SLOTS_FULL,
            Self::BadResume => close_code::BAD_RESUME,
            Self::NoTv | Self::UnknownSlot => close_code::BAD_REQUEST,
            Self::TooLarge => close_code::TOO_LARGE,
            Self::RateLimited => close_code::RATE_LIMITED,
            Self::TvReplaced => close_code::REPLACED,
        }
    }
}

/// One slot as the TV sees it. `roster` always lists slots 1-4 in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct TvSlot {
    pub slot: u8,
    pub color: PlayerColor,
    pub state: SlotState,
    /// Absent only when `state` is `empty`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mic_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub muted: bool,
    /// Last calibrated mouth-to-speaker latency for this `micId` (persisted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latency_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latency_method: Option<LatencyMethod>,
    /// Seconds left on a `reserved` slot when this roster was sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reserved_for_secs: Option<u32>,
}

/// One singer's result in `song-result` from the TV.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct SlotResult {
    pub slot: u8,
    /// Noraebang 0-100 score shown on screen (display only, never stored).
    pub display_score: u8,
    /// Nightingale's stored 0-1000 score.
    pub raw_score: u32,
    pub tier: ScoreTier,
    /// 1-based rank among this song's singers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rank: Option<u8>,
}

/// One per-slot phone link for the TV idle screen (`GET /api/firesong/mic-links`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct MicLink {
    pub slot: u8,
    pub color: PlayerColor,
    /// `<NIGHTINGALE_REMOTE_URL>/m?t=<remote token>&slot=<n>`; `null` when no
    /// phone-reachable base is known.
    pub url: Option<String>,
    pub qr_svg: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct MicLinks {
    pub slots: Vec<MicLink>,
}

/// Phone -> server, on the remote listener's `/rtc`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum MicToServer {
    /// Must be the first frame. `slot` is a preference (the QR's slot, or the
    /// slot from the last `assign`); `resumeKey` comes from the last `assign`.
    Hello {
        v: u32,
        mic_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        resume_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        slot: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        name: Option<String>,
    },
    /// Full SDP offer (phone is always the offerer). `restart` marks an ICE
    /// restart of the current session rather than a new session.
    Offer {
        sdp: String,
        #[serde(default)]
        restart: bool,
    },
    /// Optional trickle candidate; `null` = end-of-candidates.
    Ice {
        candidate: Option<IceCandidate>,
    },
    Mute {
        muted: bool,
    },
    /// Free-form phone diagnostics (track settings, outbound stats). Relayed to the TV.
    Diag {
        #[ts(type = "Record<string, unknown>")]
        data: Map<String, Value>,
    },
    /// Leaving on purpose: frees the slot at once (no reservation).
    Bye,
    /// Application-level keepalive; `t` is echoed in `pong`.
    Ping {
        t: f64,
    },
}

/// Server -> phone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum ServerToMic {
    /// Reply to `hello`. Store `micId`, `resumeKey` and `slot` for reconnects.
    Assign {
        v: u32,
        slot: u8,
        color: PlayerColor,
        mic_id: String,
        resume_key: String,
        /// The phone got back the slot it held before (reconnect).
        reclaimed: bool,
        tv_connected: bool,
        ice_servers: Vec<IceServer>,
    },
    Answer {
        sdp: String,
    },
    Ice {
        candidate: Option<IceCandidate>,
    },
    /// The TV asks for a new offer with an ICE restart.
    Restart,
    /// Authoritative mute state of this phone's slot.
    Mute {
        muted: bool,
        by: MuteSource,
    },
    /// The TV seat changed. On `connected: true` the phone sends a fresh offer.
    TvState {
        connected: bool,
    },
    /// This phone's result for the song that just ended.
    SongResult {
        display_score: u8,
        raw_score: u32,
        tier: ScoreTier,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        rank: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        singers: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
    },
    /// `replaced` or `kicked`; the socket closes right after.
    SlotLost {
        reason: SlotLostReason,
    },
    Error {
        code: RtcErrorCode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        message: Option<String>,
    },
    Pong {
        t: f64,
    },
}

/// TV -> server, on the full (host-authenticated) listener's `/rtc`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum TvToServer {
    /// Must be the first frame. Takes the single TV seat.
    Hello {
        v: u32,
    },
    Answer {
        slot: u8,
        sdp: String,
    },
    Ice {
        slot: u8,
        candidate: Option<IceCandidate>,
    },
    /// Ask the slot's phone for a new offer with an ICE restart.
    Restart {
        slot: u8,
    },
    Mute {
        slot: u8,
        muted: bool,
    },
    /// Free the slot and disconnect its phone.
    Kick {
        slot: u8,
    },
    /// Store the slot's measured latency against its `micId` (persisted).
    Latency {
        slot: u8,
        latency_ms: u32,
        method: LatencyMethod,
    },
    /// Results of the song that just ended; each phone gets its own entry.
    SongResult {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        results: Vec<SlotResult>,
    },
    Ping {
        t: f64,
    },
}

/// Server -> TV. Frames about a phone carry the server-stamped `slot` and `micId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum ServerToTv {
    /// Reply to `hello`; a `roster` follows immediately.
    Ready {
        v: u32,
        ice_servers: Vec<IceServer>,
    },
    /// Full snapshot of slots 1-4, sent after `ready` and on every change.
    Roster {
        slots: Vec<TvSlot>,
    },
    /// `restart: false` = new session: drop any peer connection for this slot
    /// first. `restart: true` = ICE restart of the existing one.
    Offer {
        slot: u8,
        mic_id: String,
        sdp: String,
        restart: bool,
    },
    Ice {
        slot: u8,
        mic_id: String,
        candidate: Option<IceCandidate>,
    },
    Mute {
        slot: u8,
        muted: bool,
        by: MuteSource,
    },
    Diag {
        slot: u8,
        mic_id: String,
        #[ts(type = "Record<string, unknown>")]
        data: Map<String, Value>,
    },
    SlotLost {
        slot: u8,
        mic_id: String,
        reason: SlotLostReason,
    },
    Error {
        code: RtcErrorCode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        message: Option<String>,
    },
    Pong {
        t: f64,
    },
}

/// Size-checks, parses and validates one phone text frame.
pub fn decode_mic_frame(text: &str) -> Result<MicToServer, RtcErrorCode> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(RtcErrorCode::TooLarge);
    }
    let frame: MicToServer = serde_json::from_str(text).map_err(|_| bad_frame_or_hello(text))?;
    frame.validate()?;
    Ok(frame)
}

/// Size-checks, parses and validates one TV text frame.
pub fn decode_tv_frame(text: &str) -> Result<TvToServer, RtcErrorCode> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(RtcErrorCode::TooLarge);
    }
    let frame: TvToServer = serde_json::from_str(text).map_err(|_| RtcErrorCode::BadFrame)?;
    frame.validate()?;
    Ok(frame)
}

/// A malformed frame whose `type` is `hello` is a bad hello, so the phone
/// gets the fatal code instead of waiting for its hello timeout.
fn bad_frame_or_hello(text: &str) -> RtcErrorCode {
    let is_hello = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|kind| kind == "hello");

    if is_hello {
        RtcErrorCode::BadHello
    } else {
        RtcErrorCode::BadFrame
    }
}

impl MicToServer {
    pub fn validate(&self) -> Result<(), RtcErrorCode> {
        match self {
            Self::Hello {
                v,
                mic_id,
                resume_key,
                slot,
                name,
            } => {
                if *v != PROTOCOL_VERSION {
                    return Err(RtcErrorCode::Version);
                }
                let valid = is_valid_mic_id(mic_id)
                    && resume_key.as_deref().is_none_or(is_valid_resume_key)
                    && slot.is_none_or(is_valid_slot)
                    && name.as_deref().is_none_or(is_valid_name);
                valid.then_some(()).ok_or(RtcErrorCode::BadHello)
            }
            Self::Offer { sdp, .. } => check_sdp(sdp),
            Self::Ice { candidate } => check_candidate(candidate.as_ref()),
            Self::Diag { data } => {
                let size = serde_json::to_string(data).map_or(usize::MAX, |json| json.len());
                (size <= MAX_DIAG_BYTES)
                    .then_some(())
                    .ok_or(RtcErrorCode::TooLarge)
            }
            Self::Mute { .. } | Self::Bye | Self::Ping { .. } => Ok(()),
        }
    }
}

impl TvToServer {
    pub fn validate(&self) -> Result<(), RtcErrorCode> {
        match self {
            Self::Hello { v } => (*v == PROTOCOL_VERSION)
                .then_some(())
                .ok_or(RtcErrorCode::Version),
            Self::Answer { slot, sdp } => {
                check_slot(*slot)?;
                check_sdp(sdp)
            }
            Self::Ice { slot, candidate } => {
                check_slot(*slot)?;
                check_candidate(candidate.as_ref())
            }
            Self::Restart { slot } | Self::Mute { slot, .. } | Self::Kick { slot } => {
                check_slot(*slot)
            }
            Self::Latency {
                slot, latency_ms, ..
            } => {
                check_slot(*slot)?;
                (*latency_ms <= MAX_LATENCY_MS)
                    .then_some(())
                    .ok_or(RtcErrorCode::BadFrame)
            }
            Self::SongResult { title, results } => {
                let title_ok = title
                    .as_deref()
                    .is_none_or(|title| title.chars().count() <= MAX_TITLE_CHARS);
                let results_ok = results.len() <= usize::from(SLOT_COUNT)
                    && results.iter().all(|result| {
                        is_valid_slot(result.slot)
                            && result.display_score <= MAX_DISPLAY_SCORE
                            && result.raw_score <= MAX_RAW_SCORE
                            && result
                                .rank
                                .is_none_or(|rank| (1..=SLOT_COUNT).contains(&rank))
                    });
                (title_ok && results_ok)
                    .then_some(())
                    .ok_or(RtcErrorCode::BadFrame)
            }
            Self::Ping { .. } => Ok(()),
        }
    }
}

/// Display names: 1-32 chars after trimming, no control characters.
pub fn is_valid_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_NAME_CHARS
        && !trimmed.chars().any(char::is_control)
}

fn check_slot(slot: u8) -> Result<(), RtcErrorCode> {
    is_valid_slot(slot)
        .then_some(())
        .ok_or(RtcErrorCode::BadFrame)
}

fn check_sdp(sdp: &str) -> Result<(), RtcErrorCode> {
    if sdp.len() > MAX_SDP_BYTES {
        return Err(RtcErrorCode::TooLarge);
    }
    (!sdp.trim().is_empty())
        .then_some(())
        .ok_or(RtcErrorCode::BadFrame)
}

fn check_candidate(candidate: Option<&IceCandidate>) -> Result<(), RtcErrorCode> {
    let Some(candidate) = candidate else {
        return Ok(());
    };
    let size = candidate.candidate.len()
        + candidate.sdp_mid.as_ref().map_or(0, String::len)
        + candidate.username_fragment.as_ref().map_or(0, String::len);
    (size <= MAX_CANDIDATE_BYTES)
        .then_some(())
        .ok_or(RtcErrorCode::TooLarge)
}

// ─── Party channel (PROTOCOL.md §13, phone app v2) ──────────────────────
//
// Song book, reservations, the phone remote, fun sounds, mic tuning, lyric
// lines and tonight's scores. Party frames share the `/rtc` socket with the
// signaling frames above but live in their own enums, so the v1 decoders and
// v1 clients are unchanged: a v1 client drops frames it cannot parse.

/// App-api command behind the phone's song book (`POST /api/cmd/<name>`).
pub const SONG_BOOK_COMMAND: &str = "firesong_song_book";

/// Reservations one phone may own at a time, ready and preparing together.
pub const MAX_RESERVATIONS_PER_SLOT: usize = 3;
/// Of those, songs still being prepared (analysed).
pub const MAX_PREPARING_PER_SLOT: usize = 2;
/// Preparations started by phones, across the whole party.
pub const MAX_PREPARING_TOTAL: usize = 6;
/// "Sing next" reservations one phone may hold at a time.
pub const MAX_SING_NEXT_PER_SLOT: usize = 1;
/// Other phones one reservation may name as partners (four singers in all).
pub const MAX_PARTNERS: usize = 3;
/// Queue items a `party` snapshot lists before it cuts the rest. Items with
/// phone singers are always listed.
pub const MAX_PARTY_QUEUE_ITEMS: usize = 30;
pub const MAX_NIGHT_SCORES: usize = 10;
/// A night score older than this leaves the board.
pub const NIGHT_SCORE_MAX_AGE_SECS: u32 = 43_200;
pub const MAX_LYRIC_CHARS: usize = 200;
pub const MAX_LINE_MS: u32 = 60_000;
pub const MAX_COUNTDOWN_SECS: u32 = 120;
pub const FILE_HASH_MIN_LEN: usize = 16;
pub const FILE_HASH_MAX_LEN: usize = 64;
/// Reservation ids and playback-queue entry ids.
pub const MAX_PARTY_ID_LEN: usize = 32;
pub const MIN_KEY_OFFSET: i8 = -5;
pub const MAX_KEY_OFFSET: i8 = 5;
pub const MIN_TEMPO: f64 = 0.5;
pub const MAX_TEMPO: f64 = 2.0;
/// Tempo ratios are whole multiples of this; the stem cache rounds to it.
pub const TEMPO_STEP: f64 = 0.1;
pub const DEFAULT_VOLUME_PCT: u8 = 100;
pub const MAX_VOLUME_PCT: u8 = 150;
pub const DEFAULT_ECHO_PCT: u8 = 100;
pub const MAX_ECHO_PCT: u8 = 200;
pub const MAX_SEARCH_CHARS: usize = 100;
pub const MAX_BOOK_PAGE: u32 = 50;
pub const MAX_BOOK_SKIP: u32 = 1_000_000;

/// Party requests per phone (`reserve`, `edit`, `cancel`, `control`,
/// `shift-current`, `calibrate`): a burst of this many, then one more every
/// [`PARTY_REQUEST_REFILL_MS`]. Every frame still counts against the socket
/// bucket ([`RATE_BURST`]).
pub const PARTY_REQUEST_BURST: u32 = 6;
pub const PARTY_REQUEST_REFILL_MS: u32 = 3_000;
/// Fun sounds per phone; sounds over the budget are dropped without an error.
pub const FX_BURST: u32 = 3;
pub const FX_REFILL_MS: u32 = 2_000;
/// Fun sounds the TV plays at the same time; extra ones are dropped.
pub const MAX_FX_VOICES: u32 = 4;
/// `mix` frames the server relays per phone per second; it keeps the newest.
pub const MIX_PER_SEC: u32 = 5;
pub const CALIBRATION_COOLDOWN_SECS: u32 = 30;
/// The server gives up on a calibration the TV has not finished by then.
pub const CALIBRATION_TIMEOUT_SECS: u32 = 15;
pub const SHIFT_CURRENT_COOLDOWN_SECS: u32 = 15;
pub const MAX_SHIFTS_PER_SONG: u32 = 3;
/// `party` snapshots are coalesced to at most one per this interval.
pub const PARTY_SNAPSHOT_MIN_INTERVAL_MS: u32 = 500;
/// Preparation time assumed for an estimate before any song has finished.
pub const DEFAULT_PREP_SECS: u32 = 120;
/// Lobby countdown before the TV starts the next ready song.
pub const LOBBY_COUNTDOWN_SECS: u32 = 15;
/// How long the lobby waits for a reconnecting next singer before it moves
/// that song back by one place.
pub const ABSENT_SINGER_GRACE_SECS: u32 = 30;

/// `type` values of [`MicPartyToServer`].
pub const MIC_PARTY_TYPES: &[&str] = &[
    "reserve",
    "edit",
    "cancel",
    "control",
    "shift-current",
    "fx",
    "mix",
    "calibrate",
];

/// `type` values of [`TvPartyToServer`].
pub const TV_PARTY_TYPES: &[&str] = &["stage", "lyric", "calibration", "notify", "reset-scores"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum PartyAction {
    /// Pause the current song.
    Pause,
    Resume,
    /// End the current song now; the TV returns to the lobby.
    Stop,
    /// In the lobby: start the next song without waiting for the countdown.
    StartNow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum FxSound {
    Applause,
    Tambourine,
    Cheer,
    AirHorn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum StageKind {
    /// Between songs: the TV shows the party lobby.
    Lobby,
    /// A song is loading (key or tempo render, stems).
    Starting,
    Singing,
    Paused,
    /// The score reveal is on screen.
    Reveal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum PrepStage {
    /// Analysed: it can be sung now.
    Ready,
    /// Not analysed and not queued for analysis (song book only).
    NotReady,
    /// Waiting in the analysis queue.
    Queued,
    Analyzing,
    /// Queued, but the GPU is reserved or short of memory.
    WaitingGpu,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum CalibrationState {
    Started,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum CalibrationFailure {
    /// A song is on, or another calibration is running.
    Busy,
    /// The slot has no audio from the phone.
    NoAudio,
    /// The beep was not heard in the phone's audio.
    NoTone,
    Timeout,
    NoTv,
}

/// Why a party request was refused (`ack {ok: false}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum PartyErrorCode {
    /// Not this phone's reservation, or not a singer of the current song.
    NotAllowed,
    /// No such reservation or song.
    NotFound,
    /// A value that does not fit this song or this stage.
    Invalid,
    /// This phone already owns [`MAX_RESERVATIONS_PER_SLOT`] reservations.
    LimitReservations,
    /// This phone already has [`MAX_PREPARING_PER_SLOT`] songs preparing.
    LimitPreparing,
    /// The party already prepares [`MAX_PREPARING_TOTAL`] songs.
    PrepFull,
    /// This phone already holds a "sing next" reservation.
    LimitSingNext,
    /// The same song is already waiting for this phone.
    Duplicate,
    /// The TV is busy with something that blocks this request.
    Busy,
    NoTv,
    /// The song cannot do this: no detected key for a shift, a USDX song, or
    /// a source that cannot be reached.
    Unavailable,
    /// Over a party request budget or cooldown.
    RateLimited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "firesong/")]
pub enum NoticeCode {
    /// Another phone named this phone as a partner.
    DuetAdded,
    /// A song preparing for this phone failed and was dropped.
    PrepFailed,
    /// This phone's song came up while it was away and moved back one place.
    PassedOver,
    /// The key or tempo change failed; the song plays on unchanged.
    ShiftFailed,
    /// The TV could not start this phone's song; it was dropped.
    StartFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct PrepState {
    pub state: PrepStage,
    /// Analysis progress, 0-100, while `analyzing`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pct: Option<u8>,
    /// Estimated seconds until ready. For `not-ready`: if it were picked now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub eta_secs: Option<u32>,
}

/// One queued or preparing song in a `party` snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct PartyItem {
    /// Opaque and server-assigned; stable while the item waits, also when
    /// `fileHash` changes.
    pub reservation_id: String,
    /// The playback-queue entry, once the song is ready and in the queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub entry_id: Option<String>,
    /// The song's current hash; it can change once while a remote song is
    /// prepared.
    pub file_hash: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: f64,
    /// Slots that sing it, owner first. Empty for songs the host queued.
    pub singers: Vec<u8>,
    pub key_offset: i8,
    pub tempo: f64,
    pub sing_next: bool,
    /// Key and tempo can be changed: a detected key, not USDX.
    pub shiftable: bool,
    pub prep: PrepState,
}

/// One occupied slot in a `party` snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct PartySinger {
    pub slot: u8,
    pub color: PlayerColor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    /// `connected`, or `reserved` while the phone reconnects.
    pub state: SlotState,
    /// The slot's fader on the TV, 0-150, 100 = unity.
    pub volume_pct: u8,
    /// The slot's echo, 0-200, 100 = the echo preset as it is.
    pub echo_pct: u8,
}

/// One entry of tonight's best scores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct NightScore {
    pub slot: u8,
    pub color: PlayerColor,
    /// The singer's name when the score was made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    pub display_score: u8,
    pub raw_score: u32,
    pub tier: ScoreTier,
    /// Unix time of the reveal, in seconds.
    pub at_secs: u32,
}

/// What the TV shows, as it last reported with `stage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct PartyStage {
    pub state: StageKind,
    /// The reservation being sung, when the song came from the queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reservation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub artist: Option<String>,
    /// Slots the TV scores for the current song; empty in the lobby.
    pub singers: Vec<u8>,
    /// Lobby: seconds left before the TV starts the first ready item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub countdown_secs: Option<u32>,
}

/// The shared party state. Every phone and the TV get the same snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct PartySnapshot {
    /// Grows with every snapshot the server builds.
    pub rev: u32,
    pub tv_connected: bool,
    pub stage: PartyStage,
    /// Up next, in play order.
    pub queue: Vec<PartyItem>,
    /// Every queued and preparing item, including any cut from `queue`.
    pub queue_total: u32,
    /// Occupied slots, in slot order.
    pub singers: Vec<PartySinger>,
    /// Tonight's best, best first.
    pub scores: Vec<NightScore>,
}

/// Payload of [`SONG_BOOK_COMMAND`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct SongBookQuery {
    /// Words to match in title or artist; none lists the whole library.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub search: Option<String>,
    #[serde(default)]
    pub skip: u32,
    pub take: u32,
}

impl SongBookQuery {
    pub fn validate(&self) -> Result<(), &'static str> {
        let search_ok = self
            .search
            .as_deref()
            .is_none_or(|search| is_short_text(search, MAX_SEARCH_CHARS));
        if !search_ok {
            return Err("search is too long");
        }
        if !(1..=MAX_BOOK_PAGE).contains(&self.take) || self.skip > MAX_BOOK_SKIP {
            return Err("page is out of range");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct BookSong {
    pub file_hash: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: f64,
    /// Key and tempo can be changed: a detected key, not USDX.
    pub shiftable: bool,
    pub prep: PrepState,
}

/// One page of the song book: ready songs first, each part in title order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "firesong/")]
pub struct SongBookPage {
    pub items: Vec<BookSong>,
    pub skip: u32,
    /// Songs that match the search.
    pub total: u32,
    /// Of `total`, the ready ones; they fill positions `0..readyTotal`.
    pub ready_total: u32,
}

/// Phone -> server party requests on the phone's `/rtc`. The server stamps
/// the sender's slot and `micId`; a request with `reqId` gets an `ack`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum MicPartyToServer {
    /// Reserve a song for this phone and its partners. A song that is not
    /// ready starts preparing.
    Reserve {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        req_id: Option<u32>,
        file_hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        key_offset: Option<i8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tempo: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sing_next: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        partners: Option<Vec<u8>>,
    },
    /// Change one of this phone's own reservations.
    Edit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        req_id: Option<u32>,
        reservation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        key_offset: Option<i8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tempo: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sing_next: Option<bool>,
    },
    /// The owner removes the reservation; a partner leaves it.
    Cancel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        req_id: Option<u32>,
        reservation_id: String,
    },
    Control {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        req_id: Option<u32>,
        action: PartyAction,
    },
    /// New key and tempo for the current song; the TV restarts it with them.
    ShiftCurrent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        req_id: Option<u32>,
        key_offset: i8,
        tempo: f64,
    },
    Fx {
        sound: FxSound,
    },
    /// This phone's slot on the TV mixer.
    Mix {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        volume_pct: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        echo_pct: Option<u8>,
    },
    /// Run the beep calibration for this phone's slot.
    Calibrate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        req_id: Option<u32>,
    },
}

/// Server -> phone party frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum ServerToMicParty {
    /// The shared party state, after `assign` and on every change.
    Party { party: PartySnapshot },
    /// The answer to a request that carried `reqId`.
    Ack {
        req_id: u32,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        code: Option<PartyErrorCode>,
        /// The new reservation, for `reserve`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reservation_id: Option<String>,
    },
    /// The current and next lyric line of the song this phone sings.
    Lyric {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        line: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        next: Option<String>,
        /// How long `line` lasts at the current tempo.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        line_ms: Option<u32>,
        /// How much of `line` had passed when the TV sent this.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        elapsed_ms: Option<u32>,
        paused: bool,
    },
    /// Progress of this phone's calibration.
    Calibration {
        state: CalibrationState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        latency_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<CalibrationFailure>,
    },
    Notice {
        code: NoticeCode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        /// For `duet-added`: who named this phone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        by_slot: Option<u8>,
    },
    /// Where this phone's last result placed tonight; follows `song-result`.
    NightRank {
        /// 1-based place on the board, when it made the board.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        rank: Option<u8>,
        /// Scores made tonight, on the board or not.
        entries: u32,
    },
}

/// TV -> server party frames, on the full listener's `/rtc`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum TvPartyToServer {
    /// What the TV shows; sent on every change and after `ready`.
    Stage {
        state: StageKind,
        /// The playback-queue entry being played, when it came from the queue.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        entry_id: Option<String>,
        /// Slots the TV scores for this song.
        singers: Vec<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        artist: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        countdown_secs: Option<u32>,
    },
    /// A lyric line change, pause, resume or seek of the current song.
    Lyric {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        line: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        next: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        line_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        elapsed_ms: Option<u32>,
        paused: bool,
    },
    Calibration {
        slot: u8,
        state: CalibrationState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        latency_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<CalibrationFailure>,
    },
    /// Tell one phone what happened to its song.
    Notify {
        slot: u8,
        code: NoticeCode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
    },
    /// The host clears tonight's scores.
    ResetScores,
}

/// Server -> TV party frames. Frames about a phone carry the stamped `slot`
/// and `micId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "firesong/")]
pub enum ServerToTvParty {
    Party {
        party: PartySnapshot,
    },
    /// A phone remote action the server has authorised.
    Control {
        slot: u8,
        mic_id: String,
        action: PartyAction,
    },
    /// Restart the current song with this key and tempo.
    ShiftCurrent {
        slot: u8,
        mic_id: String,
        key_offset: i8,
        tempo: f64,
    },
    Fx {
        slot: u8,
        sound: FxSound,
    },
    /// One slot's mixer settings; sent on change and, after `ready`, for
    /// every occupied slot.
    Mix {
        slot: u8,
        volume_pct: u8,
        echo_pct: u8,
    },
    /// Run the beep calibration for this slot now.
    Calibrate {
        slot: u8,
        mic_id: String,
    },
}

/// Any phone text frame: signaling (§5.1) or party (§13).
#[derive(Debug, Clone, PartialEq)]
pub enum MicInbound {
    Rtc(MicToServer),
    Party(MicPartyToServer),
}

/// Any TV text frame: signaling (§5.3) or party (§13).
#[derive(Debug, Clone, PartialEq)]
pub enum TvInbound {
    Rtc(TvToServer),
    Party(TvPartyToServer),
}

/// Size-checks, parses and validates one phone text frame of either kind.
/// Signaling frames decode exactly as [`decode_mic_frame`] does.
pub fn decode_mic_inbound(text: &str) -> Result<MicInbound, RtcErrorCode> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(RtcErrorCode::TooLarge);
    }
    let Some(value) = party_frame_value(text, MIC_PARTY_TYPES) else {
        return decode_mic_frame(text).map(MicInbound::Rtc);
    };
    let frame: MicPartyToServer =
        serde_json::from_value(value).map_err(|_| RtcErrorCode::BadFrame)?;
    frame.validate()?;
    Ok(MicInbound::Party(frame))
}

/// Size-checks, parses and validates one TV text frame of either kind.
/// Signaling frames decode exactly as [`decode_tv_frame`] does.
pub fn decode_tv_inbound(text: &str) -> Result<TvInbound, RtcErrorCode> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(RtcErrorCode::TooLarge);
    }
    let Some(value) = party_frame_value(text, TV_PARTY_TYPES) else {
        return decode_tv_frame(text).map(TvInbound::Rtc);
    };
    let frame: TvPartyToServer =
        serde_json::from_value(value).map_err(|_| RtcErrorCode::BadFrame)?;
    frame.validate()?;
    Ok(TvInbound::Party(frame))
}

fn party_frame_value(text: &str, types: &[&str]) -> Option<Value> {
    let value: Value = serde_json::from_str(text).ok()?;
    let is_party = value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| types.contains(&kind));
    is_party.then_some(value)
}

/// Song hashes: 16-64 lowercase hex characters.
pub fn is_valid_file_hash(hash: &str) -> bool {
    (FILE_HASH_MIN_LEN..=FILE_HASH_MAX_LEN).contains(&hash.len())
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Reservation and playback-queue entry ids: 1-32 chars of `[A-Za-z0-9_-]`.
pub fn is_valid_party_id(id: &str) -> bool {
    (1..=MAX_PARTY_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn is_valid_key_offset(key_offset: i8) -> bool {
    (MIN_KEY_OFFSET..=MAX_KEY_OFFSET).contains(&key_offset)
}

/// A tempo ratio from [`MIN_TEMPO`] to [`MAX_TEMPO`] in [`TEMPO_STEP`] steps.
pub fn is_valid_tempo(tempo: f64) -> bool {
    const EPSILON: f64 = 1e-6;
    let steps = tempo / TEMPO_STEP;
    (MIN_TEMPO - EPSILON..=MAX_TEMPO + EPSILON).contains(&tempo)
        && (steps - steps.round()).abs() < EPSILON
}

fn is_short_text(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars && !text.chars().any(char::is_control)
}

fn is_valid_slot_list(slots: &[u8], max: usize) -> bool {
    slots.len() <= max
        && slots.iter().all(|slot| is_valid_slot(*slot))
        && slots
            .iter()
            .enumerate()
            .all(|(index, slot)| !slots[..index].contains(slot))
}

fn check(valid: bool) -> Result<(), RtcErrorCode> {
    valid.then_some(()).ok_or(RtcErrorCode::BadFrame)
}

fn check_shift(key_offset: Option<i8>, tempo: Option<f64>) -> Result<(), RtcErrorCode> {
    check(key_offset.is_none_or(is_valid_key_offset) && tempo.is_none_or(is_valid_tempo))
}

fn check_lyric(
    line: Option<&str>,
    next: Option<&str>,
    line_ms: Option<u32>,
    elapsed_ms: Option<u32>,
) -> Result<(), RtcErrorCode> {
    let text_ok = |text: Option<&str>| text.is_none_or(|text| is_short_text(text, MAX_LYRIC_CHARS));
    let ms_ok = |ms: Option<u32>| ms.is_none_or(|ms| ms <= MAX_LINE_MS);
    check(text_ok(line) && text_ok(next) && ms_ok(line_ms) && ms_ok(elapsed_ms))
}

impl MicPartyToServer {
    pub fn validate(&self) -> Result<(), RtcErrorCode> {
        match self {
            Self::Reserve {
                file_hash,
                key_offset,
                tempo,
                partners,
                ..
            } => {
                check(is_valid_file_hash(file_hash))?;
                check_shift(*key_offset, *tempo)?;
                check(
                    partners
                        .as_deref()
                        .is_none_or(|partners| is_valid_slot_list(partners, MAX_PARTNERS)),
                )
            }
            Self::Edit {
                reservation_id,
                key_offset,
                tempo,
                sing_next,
                ..
            } => {
                check(is_valid_party_id(reservation_id))?;
                check(key_offset.is_some() || tempo.is_some() || sing_next.is_some())?;
                check_shift(*key_offset, *tempo)
            }
            Self::Cancel { reservation_id, .. } => check(is_valid_party_id(reservation_id)),
            Self::ShiftCurrent {
                key_offset, tempo, ..
            } => check_shift(Some(*key_offset), Some(*tempo)),
            Self::Mix {
                volume_pct,
                echo_pct,
            } => check(
                (volume_pct.is_some() || echo_pct.is_some())
                    && volume_pct.is_none_or(|pct| pct <= MAX_VOLUME_PCT)
                    && echo_pct.is_none_or(|pct| pct <= MAX_ECHO_PCT),
            ),
            Self::Control { .. } | Self::Fx { .. } | Self::Calibrate { .. } => Ok(()),
        }
    }
}

impl TvPartyToServer {
    pub fn validate(&self) -> Result<(), RtcErrorCode> {
        let title_ok = |title: Option<&str>| {
            title.is_none_or(|title| title.chars().count() <= MAX_TITLE_CHARS)
        };
        match self {
            Self::Stage {
                entry_id,
                singers,
                title,
                artist,
                countdown_secs,
                ..
            } => check(
                entry_id.as_deref().is_none_or(is_valid_party_id)
                    && is_valid_slot_list(singers, usize::from(SLOT_COUNT))
                    && title_ok(title.as_deref())
                    && title_ok(artist.as_deref())
                    && countdown_secs.is_none_or(|secs| secs <= MAX_COUNTDOWN_SECS),
            ),
            Self::Lyric {
                line,
                next,
                line_ms,
                elapsed_ms,
                ..
            } => check_lyric(line.as_deref(), next.as_deref(), *line_ms, *elapsed_ms),
            Self::Calibration {
                slot, latency_ms, ..
            } => check(is_valid_slot(*slot) && latency_ms.is_none_or(|ms| ms <= MAX_LATENCY_MS)),
            Self::Notify { slot, title, .. } => {
                check(is_valid_slot(*slot) && title_ok(title.as_deref()))
            }
            Self::ResetScores => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const MIC: &str = "6f1c2a9e-4b7d-4c1e-9a55-2d8f0e3b7c11";
    const KEY: &str = "0123456789abcdef0123456789abcdef";

    fn to_json<T: Serialize>(value: &T) -> Value {
        serde_json::to_value(value).unwrap_or(Value::Null)
    }

    #[test]
    fn slots_map_to_player_colors_in_order() {
        let colors: Vec<_> = (0..=5).map(slot_color).collect();
        assert_eq!(
            colors,
            vec![
                None,
                Some(PlayerColor::Rose),
                Some(PlayerColor::Fuchsia),
                Some(PlayerColor::Amber),
                Some(PlayerColor::Emerald),
                None,
            ]
        );
    }

    #[test]
    fn device_ids_round_trip_and_reject_foreign_ids() {
        let device = remote_mic_device_id(MIC);
        assert_eq!(device, format!("remote:{MIC}"));
        assert_eq!(parse_remote_mic_device_id(&device), Some(MIC));
        assert_eq!(parse_remote_mic_device_id("default"), None);
        assert_eq!(parse_remote_mic_device_id("remote:short"), None);
        assert_eq!(parse_remote_mic_device_id("remote:has space in it"), None);
    }

    #[test]
    fn mic_id_and_resume_key_formats() {
        assert!(is_valid_mic_id(MIC));
        assert!(!is_valid_mic_id("1234567"));
        assert!(!is_valid_mic_id(&"a".repeat(65)));
        assert!(!is_valid_mic_id("abc/../defgh"));
        assert!(is_valid_resume_key(KEY));
        assert!(!is_valid_resume_key(&KEY.to_uppercase()));
        assert!(!is_valid_resume_key(&KEY[1..]));
    }

    #[test]
    fn hello_decodes_with_optional_fields_absent_or_null() {
        let minimal = decode_mic_frame(&json!({"type": "hello", "v": 1, "micId": MIC}).to_string());
        assert_eq!(
            minimal,
            Ok(MicToServer::Hello {
                v: 1,
                mic_id: MIC.into(),
                resume_key: None,
                slot: None,
                name: None,
            })
        );

        let full = json!({"type": "hello", "v": 1, "micId": MIC, "resumeKey": KEY, "slot": 3, "name": "Jim"});
        assert!(decode_mic_frame(&full.to_string()).is_ok());

        let nulls = json!({"type": "hello", "v": 1, "micId": MIC, "resumeKey": null, "slot": null});
        assert!(decode_mic_frame(&nulls.to_string()).is_ok());
    }

    #[test]
    fn hello_rejections_use_the_documented_codes() {
        let cases = [
            (
                json!({"type": "hello", "v": 2, "micId": MIC}),
                RtcErrorCode::Version,
            ),
            (
                json!({"type": "hello", "v": 1, "micId": "x"}),
                RtcErrorCode::BadHello,
            ),
            (
                json!({"type": "hello", "v": 1, "micId": MIC, "slot": 0}),
                RtcErrorCode::BadHello,
            ),
            (
                json!({"type": "hello", "v": 1, "micId": MIC, "slot": 5}),
                RtcErrorCode::BadHello,
            ),
            (
                json!({"type": "hello", "v": 1, "micId": MIC, "resumeKey": "nope"}),
                RtcErrorCode::BadHello,
            ),
            (
                json!({"type": "hello", "v": 1, "micId": MIC, "name": "   "}),
                RtcErrorCode::BadHello,
            ),
            (
                json!({"type": "hello", "v": 1, "micId": MIC, "name": "a".repeat(33)}),
                RtcErrorCode::BadHello,
            ),
            (json!({"type": "hello", "v": 1}), RtcErrorCode::BadHello),
            (
                json!({"type": "hello", "v": 1, "micId": MIC, "slot": 300}),
                RtcErrorCode::BadHello,
            ),
        ];
        for (frame, code) in cases {
            assert_eq!(decode_mic_frame(&frame.to_string()), Err(code), "{frame}");
        }
    }

    #[test]
    fn phone_cannot_send_tv_frames_or_stamp_its_slot() {
        let kick = json!({"type": "kick", "slot": 1}).to_string();
        assert_eq!(decode_mic_frame(&kick), Err(RtcErrorCode::BadFrame));

        let answer = json!({"type": "answer", "slot": 1, "sdp": "v=0"}).to_string();
        assert_eq!(decode_mic_frame(&answer), Err(RtcErrorCode::BadFrame));

        // Sender fields in a phone offer are ignored: the server stamps them.
        let spoofed = json!({"type": "offer", "sdp": "v=0", "slot": 4, "micId": "someone-else"});
        let decoded = decode_mic_frame(&spoofed.to_string());
        assert_eq!(
            decoded,
            Ok(MicToServer::Offer {
                sdp: "v=0".into(),
                restart: false,
            })
        );
    }

    #[test]
    fn size_limits_are_enforced() {
        let huge = "x".repeat(MAX_FRAME_BYTES + 1);
        assert_eq!(decode_mic_frame(&huge), Err(RtcErrorCode::TooLarge));
        assert_eq!(decode_tv_frame(&huge), Err(RtcErrorCode::TooLarge));

        let sdp = "v".repeat(MAX_SDP_BYTES + 1);
        let offer = json!({"type": "offer", "sdp": sdp}).to_string();
        assert_eq!(decode_mic_frame(&offer), Err(RtcErrorCode::TooLarge));

        let candidate =
            json!({"type": "ice", "candidate": {"candidate": "c".repeat(MAX_CANDIDATE_BYTES + 1)}});
        assert_eq!(
            decode_mic_frame(&candidate.to_string()),
            Err(RtcErrorCode::TooLarge)
        );

        let diag = json!({"type": "diag", "data": {"blob": "d".repeat(MAX_DIAG_BYTES)}});
        assert_eq!(
            decode_mic_frame(&diag.to_string()),
            Err(RtcErrorCode::TooLarge)
        );

        let diag_not_object = json!({"type": "diag", "data": [1, 2]});
        assert_eq!(
            decode_mic_frame(&diag_not_object.to_string()),
            Err(RtcErrorCode::BadFrame)
        );
    }

    #[test]
    fn ice_candidate_uses_browser_field_names() {
        let frame = json!({
            "type": "ice",
            "candidate": {
                "candidate": "candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host",
                "sdpMid": "0",
                "sdpMLineIndex": 0,
                "usernameFragment": "abcd"
            }
        });
        let decoded = decode_mic_frame(&frame.to_string());
        let Ok(MicToServer::Ice {
            candidate: Some(candidate),
        }) = decoded
        else {
            panic!("ice frame did not decode: {decoded:?}");
        };
        assert_eq!(candidate.sdp_m_line_index, Some(0));
        assert_eq!(to_json(&candidate), frame["candidate"]);

        let end = json!({"type": "ice", "candidate": null}).to_string();
        assert_eq!(
            decode_mic_frame(&end),
            Ok(MicToServer::Ice { candidate: None })
        );
    }

    #[test]
    fn tv_frames_validate_slots_and_ranges() {
        let ok = [
            json!({"type": "hello", "v": 1}),
            json!({"type": "answer", "slot": 2, "sdp": "v=0"}),
            json!({"type": "ice", "slot": 4, "candidate": null}),
            json!({"type": "restart", "slot": 1}),
            json!({"type": "mute", "slot": 3, "muted": true}),
            json!({"type": "kick", "slot": 2}),
            json!({"type": "latency", "slot": 1, "latencyMs": 180, "method": "beep"}),
            json!({"type": "song-result", "title": "Song", "results": [
                {"slot": 1, "displayScore": 97, "rawScore": 812, "tier": "excellent", "rank": 1},
                {"slot": 2, "displayScore": 64, "rawScore": 301, "tier": "retry"}
            ]}),
            json!({"type": "ping", "t": 12.5}),
        ];
        for frame in ok {
            assert!(decode_tv_frame(&frame.to_string()).is_ok(), "{frame}");
        }

        let bad = [
            (json!({"type": "hello", "v": 9}), RtcErrorCode::Version),
            (
                json!({"type": "answer", "slot": 0, "sdp": "v=0"}),
                RtcErrorCode::BadFrame,
            ),
            (
                json!({"type": "answer", "slot": 1, "sdp": " "}),
                RtcErrorCode::BadFrame,
            ),
            (json!({"type": "kick", "slot": 5}), RtcErrorCode::BadFrame),
            (
                json!({"type": "latency", "slot": 1, "latencyMs": 1001, "method": "beep"}),
                RtcErrorCode::BadFrame,
            ),
            (
                json!({"type": "latency", "slot": 1, "latencyMs": 100, "method": "guess"}),
                RtcErrorCode::BadFrame,
            ),
            (
                json!({"type": "song-result", "results": [
                    {"slot": 1, "displayScore": 101, "rawScore": 0, "tier": "perfect"}
                ]}),
                RtcErrorCode::BadFrame,
            ),
            (
                json!({"type": "song-result", "results": [
                    {"slot": 1, "displayScore": 1, "rawScore": 1001, "tier": "retry"}
                ]}),
                RtcErrorCode::BadFrame,
            ),
            (
                json!({"type": "offer", "sdp": "v=0"}),
                RtcErrorCode::BadFrame,
            ),
            (json!({"type": "bye"}), RtcErrorCode::BadFrame),
        ];
        for (frame, code) in bad {
            assert_eq!(decode_tv_frame(&frame.to_string()), Err(code), "{frame}");
        }
    }

    #[test]
    fn server_frames_serialize_to_the_documented_shape() {
        let assign = ServerToMic::Assign {
            v: PROTOCOL_VERSION,
            slot: 2,
            color: PlayerColor::Fuchsia,
            mic_id: MIC.into(),
            resume_key: KEY.into(),
            reclaimed: true,
            tv_connected: false,
            ice_servers: vec![],
        };
        assert_eq!(
            to_json(&assign),
            json!({
                "type": "assign", "v": 1, "slot": 2, "color": "fuchsia", "micId": MIC,
                "resumeKey": KEY, "reclaimed": true, "tvConnected": false, "iceServers": []
            })
        );

        assert_eq!(
            to_json(&ServerToMic::TvState { connected: true }),
            json!({"type": "tv-state", "connected": true})
        );
        assert_eq!(to_json(&ServerToMic::Restart), json!({"type": "restart"}));
        assert_eq!(
            to_json(&ServerToMic::SlotLost {
                reason: SlotLostReason::Replaced
            }),
            json!({"type": "slot-lost", "reason": "replaced"})
        );
        assert_eq!(
            to_json(&ServerToMic::Error {
                code: RtcErrorCode::SlotsFull,
                message: None
            }),
            json!({"type": "error", "code": "slots-full"})
        );

        let roster = ServerToTv::Roster {
            slots: vec![
                TvSlot {
                    slot: 1,
                    color: PlayerColor::Rose,
                    state: SlotState::Reserved,
                    mic_id: Some(MIC.into()),
                    name: Some("Jim".into()),
                    muted: false,
                    latency_ms: Some(180),
                    latency_method: Some(LatencyMethod::Beep),
                    reserved_for_secs: Some(540),
                },
                TvSlot {
                    slot: 2,
                    color: PlayerColor::Fuchsia,
                    state: SlotState::Empty,
                    mic_id: None,
                    name: None,
                    muted: false,
                    latency_ms: None,
                    latency_method: None,
                    reserved_for_secs: None,
                },
            ],
        };
        assert_eq!(
            to_json(&roster),
            json!({"type": "roster", "slots": [
                {"slot": 1, "color": "rose", "state": "reserved", "micId": MIC, "name": "Jim",
                 "muted": false, "latencyMs": 180, "latencyMethod": "beep", "reservedForSecs": 540},
                {"slot": 2, "color": "fuchsia", "state": "empty", "muted": false}
            ]})
        );

        let offer = ServerToTv::Offer {
            slot: 3,
            mic_id: MIC.into(),
            sdp: "v=0".into(),
            restart: false,
        };
        assert_eq!(
            to_json(&offer),
            json!({"type": "offer", "slot": 3, "micId": MIC, "sdp": "v=0", "restart": false})
        );
        assert_eq!(
            to_json(&ServerToTv::SlotLost {
                slot: 3,
                mic_id: MIC.into(),
                reason: SlotLostReason::Disconnected
            }),
            json!({"type": "slot-lost", "slot": 3, "micId": MIC, "reason": "disconnected"})
        );
    }

    #[test]
    fn score_tiers_follow_the_noraebang_thresholds() {
        let tiers: Vec<_> = [100, 99, 90, 89, 80, 79, 70, 69, 0]
            .into_iter()
            .map(ScoreTier::for_display_score)
            .collect();
        assert_eq!(
            tiers,
            vec![
                ScoreTier::Perfect,
                ScoreTier::Excellent,
                ScoreTier::Excellent,
                ScoreTier::Great,
                ScoreTier::Great,
                ScoreTier::Good,
                ScoreTier::Good,
                ScoreTier::Retry,
                ScoreTier::Retry,
            ]
        );
    }

    const HASH: &str = "535b53bf0c2d4e6f8a9b1c2d3e4f5a6b";

    fn kind(value: &Value) -> &str {
        value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    #[test]
    fn party_type_lists_match_the_enums() {
        let mic = [
            MicPartyToServer::Reserve {
                req_id: None,
                file_hash: HASH.into(),
                key_offset: None,
                tempo: None,
                sing_next: None,
                partners: None,
            },
            MicPartyToServer::Edit {
                req_id: None,
                reservation_id: "r1".into(),
                key_offset: Some(1),
                tempo: None,
                sing_next: None,
            },
            MicPartyToServer::Cancel {
                req_id: None,
                reservation_id: "r1".into(),
            },
            MicPartyToServer::Control {
                req_id: None,
                action: PartyAction::Pause,
            },
            MicPartyToServer::ShiftCurrent {
                req_id: None,
                key_offset: 0,
                tempo: 1.0,
            },
            MicPartyToServer::Fx {
                sound: FxSound::AirHorn,
            },
            MicPartyToServer::Mix {
                volume_pct: Some(100),
                echo_pct: None,
            },
            MicPartyToServer::Calibrate { req_id: None },
        ];
        let mic_types: Vec<_> = mic.iter().map(to_json).collect();
        let mic_types: Vec<_> = mic_types.iter().map(kind).collect();
        assert_eq!(mic_types, MIC_PARTY_TYPES);

        let tv = [
            TvPartyToServer::Stage {
                state: StageKind::Lobby,
                entry_id: None,
                singers: vec![],
                title: None,
                artist: None,
                countdown_secs: None,
            },
            TvPartyToServer::Lyric {
                line: None,
                next: None,
                line_ms: None,
                elapsed_ms: None,
                paused: false,
            },
            TvPartyToServer::Calibration {
                slot: 1,
                state: CalibrationState::Started,
                latency_ms: None,
                reason: None,
            },
            TvPartyToServer::Notify {
                slot: 1,
                code: NoticeCode::PassedOver,
                title: None,
            },
            TvPartyToServer::ResetScores,
        ];
        let tv_types: Vec<_> = tv.iter().map(to_json).collect();
        let tv_types: Vec<_> = tv_types.iter().map(kind).collect();
        assert_eq!(tv_types, TV_PARTY_TYPES);

        let signaling = ["hello", "offer", "ice", "mute", "diag", "bye", "ping"];
        assert!(signaling.iter().all(|kind| !MIC_PARTY_TYPES.contains(kind)));
        let signaling = [
            "hello",
            "answer",
            "ice",
            "restart",
            "mute",
            "kick",
            "latency",
            "song-result",
            "ping",
        ];
        assert!(signaling.iter().all(|kind| !TV_PARTY_TYPES.contains(kind)));
    }

    #[test]
    fn inbound_decoders_route_signaling_and_party_frames() {
        let hello = json!({"type": "hello", "v": 1, "micId": MIC}).to_string();
        assert!(matches!(
            decode_mic_inbound(&hello),
            Ok(MicInbound::Rtc(MicToServer::Hello { .. }))
        ));

        let reserve = json!({
            "type": "reserve", "reqId": 7, "fileHash": HASH, "keyOffset": -2,
            "tempo": 1.1, "singNext": true, "partners": [2, 3]
        });
        assert_eq!(
            decode_mic_inbound(&reserve.to_string()),
            Ok(MicInbound::Party(MicPartyToServer::Reserve {
                req_id: Some(7),
                file_hash: HASH.into(),
                key_offset: Some(-2),
                tempo: Some(1.1),
                sing_next: Some(true),
                partners: Some(vec![2, 3]),
            }))
        );

        // Sender fields are stamped by the server, never read from the phone.
        let spoofed = json!({"type": "fx", "sound": "cheer", "slot": 4, "micId": "someone-else"});
        assert_eq!(
            decode_mic_inbound(&spoofed.to_string()),
            Ok(MicInbound::Party(MicPartyToServer::Fx {
                sound: FxSound::Cheer
            }))
        );

        let stage =
            json!({"type": "stage", "state": "singing", "entryId": "12", "singers": [1, 2]});
        assert!(matches!(
            decode_tv_inbound(&stage.to_string()),
            Ok(TvInbound::Party(TvPartyToServer::Stage { .. }))
        ));
        let kick = json!({"type": "kick", "slot": 2}).to_string();
        assert_eq!(
            decode_tv_inbound(&kick),
            Ok(TvInbound::Rtc(TvToServer::Kick { slot: 2 }))
        );

        // Each role keeps to its own party frames.
        let tv_frame_from_phone = json!({"type": "reset-scores"}).to_string();
        assert_eq!(
            decode_mic_inbound(&tv_frame_from_phone),
            Err(RtcErrorCode::BadFrame)
        );
        let phone_frame_from_tv = json!({"type": "fx", "sound": "cheer"}).to_string();
        assert_eq!(
            decode_tv_inbound(&phone_frame_from_tv),
            Err(RtcErrorCode::BadFrame)
        );

        let huge = "x".repeat(MAX_FRAME_BYTES + 1);
        assert_eq!(decode_mic_inbound(&huge), Err(RtcErrorCode::TooLarge));
        assert_eq!(decode_tv_inbound(&huge), Err(RtcErrorCode::TooLarge));
        let bad_hello = json!({"type": "hello", "v": 1, "micId": "x"}).to_string();
        assert_eq!(decode_mic_inbound(&bad_hello), Err(RtcErrorCode::BadHello));
    }

    #[test]
    fn party_requests_reject_out_of_range_values() {
        let bad = [
            json!({"type": "reserve", "fileHash": "../../etc"}),
            json!({"type": "reserve", "fileHash": HASH.to_uppercase()}),
            json!({"type": "reserve", "fileHash": HASH, "keyOffset": 6}),
            json!({"type": "reserve", "fileHash": HASH, "keyOffset": 1.5}),
            json!({"type": "reserve", "fileHash": HASH, "tempo": 2.1}),
            json!({"type": "reserve", "fileHash": HASH, "tempo": 1.05}),
            json!({"type": "reserve", "fileHash": HASH, "partners": [2, 2]}),
            json!({"type": "reserve", "fileHash": HASH, "partners": [1, 2, 3, 4]}),
            json!({"type": "reserve", "fileHash": HASH, "partners": [5]}),
            json!({"type": "edit", "reservationId": "r1"}),
            json!({"type": "edit", "reservationId": "r 1", "tempo": 1.0}),
            json!({"type": "cancel", "reservationId": "x".repeat(33)}),
            json!({"type": "control", "action": "kick"}),
            json!({"type": "shift-current", "keyOffset": 0}),
            json!({"type": "fx", "sound": "gunshot"}),
            json!({"type": "mix"}),
            json!({"type": "mix", "volumePct": 151}),
            json!({"type": "mix", "echoPct": 201}),
            json!({"type": "reserve", "reqId": -1, "fileHash": HASH}),
        ];
        for frame in bad {
            assert_eq!(
                decode_mic_inbound(&frame.to_string()),
                Err(RtcErrorCode::BadFrame),
                "{frame}"
            );
        }

        let ok = [
            json!({"type": "reserve", "fileHash": HASH, "tempo": 0.5, "keyOffset": -5}),
            json!({"type": "reserve", "fileHash": HASH, "tempo": 2.0, "partners": [], "reqId": null}),
            json!({"type": "edit", "reservationId": "r1", "singNext": false}),
            json!({"type": "shift-current", "keyOffset": 5, "tempo": 0.8}),
            json!({"type": "mix", "volumePct": 0, "echoPct": 200}),
            json!({"type": "control", "action": "start-now", "reqId": 3}),
            json!({"type": "calibrate"}),
        ];
        for frame in ok {
            assert!(decode_mic_inbound(&frame.to_string()).is_ok(), "{frame}");
        }
    }

    #[test]
    fn tv_party_frames_validate_slots_text_and_ranges() {
        let ok = [
            json!({"type": "stage", "state": "lobby", "singers": [], "countdownSecs": 15}),
            json!({"type": "lyric", "line": "I got my head checked", "next": "Woo-hoo",
                   "lineMs": 2400, "elapsedMs": 0, "paused": false}),
            json!({"type": "lyric", "paused": true}),
            json!({"type": "calibration", "slot": 3, "state": "done", "latencyMs": 212}),
            json!({"type": "calibration", "slot": 3, "state": "failed", "reason": "no-tone"}),
            json!({"type": "notify", "slot": 2, "code": "start-failed", "title": "Song 2"}),
            json!({"type": "reset-scores"}),
        ];
        for frame in ok {
            assert!(decode_tv_inbound(&frame.to_string()).is_ok(), "{frame}");
        }

        let bad = [
            json!({"type": "stage", "state": "dancing", "singers": []}),
            json!({"type": "stage", "state": "singing", "singers": [1, 1]}),
            json!({"type": "stage", "state": "singing", "singers": [0]}),
            json!({"type": "stage", "state": "lobby", "singers": [], "countdownSecs": 121}),
            json!({"type": "stage", "state": "singing", "singers": [], "entryId": "a/b"}),
            json!({"type": "lyric", "line": "x".repeat(MAX_LYRIC_CHARS + 1), "paused": false}),
            json!({"type": "lyric", "line": "two\nlines", "paused": false}),
            json!({"type": "lyric", "lineMs": 60_001, "paused": false}),
            json!({"type": "lyric"}),
            json!({"type": "calibration", "slot": 5, "state": "done"}),
            json!({"type": "calibration", "slot": 1, "state": "done", "latencyMs": 1001}),
            json!({"type": "notify", "slot": 1, "code": "hello"}),
        ];
        for frame in bad {
            assert_eq!(
                decode_tv_inbound(&frame.to_string()),
                Err(RtcErrorCode::BadFrame),
                "{frame}"
            );
        }
    }

    #[test]
    fn tempo_and_identifier_formats() {
        for tempo in [0.5, 0.8, 1.0, 1.1, 1.3, 2.0] {
            assert!(is_valid_tempo(tempo), "{tempo}");
        }
        for tempo in [0.4, 2.1, 1.05, 0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(!is_valid_tempo(tempo), "{tempo}");
        }
        assert!(is_valid_file_hash(HASH));
        assert!(!is_valid_file_hash(&HASH[..15]));
        assert!(!is_valid_file_hash(&"a".repeat(65)));
        assert!(is_valid_party_id("r42"));
        assert!(is_valid_party_id("17"));
        assert!(!is_valid_party_id(""));
        assert!(!is_valid_party_id("r/42"));
    }

    #[test]
    fn song_book_query_limits() {
        let query = |search: Option<&str>, skip: u32, take: u32| SongBookQuery {
            search: search.map(str::to_owned),
            skip,
            take,
        };
        assert!(query(None, 0, 25).validate().is_ok());
        assert!(query(Some("song 2"), 50, MAX_BOOK_PAGE).validate().is_ok());
        assert!(query(None, 0, 0).validate().is_err());
        assert!(query(None, 0, MAX_BOOK_PAGE + 1).validate().is_err());
        assert!(query(None, MAX_BOOK_SKIP + 1, 10).validate().is_err());
        let long = "a".repeat(MAX_SEARCH_CHARS + 1);
        assert!(query(Some(&long), 0, 10).validate().is_err());

        let decoded: Result<SongBookQuery, _> =
            serde_json::from_value(json!({"search": "blur", "take": 20}));
        assert_eq!(decoded.ok(), Some(query(Some("blur"), 0, 20)));
    }

    #[test]
    fn party_snapshot_serializes_to_the_documented_shape() {
        let snapshot = PartySnapshot {
            rev: 9,
            tv_connected: true,
            stage: PartyStage {
                state: StageKind::Singing,
                reservation_id: Some("r3".into()),
                title: Some("Song 2".into()),
                artist: Some("Blur".into()),
                singers: vec![1],
                countdown_secs: None,
            },
            queue: vec![
                PartyItem {
                    reservation_id: "r4".into(),
                    entry_id: Some("12".into()),
                    file_hash: HASH.into(),
                    title: "Wonderwall".into(),
                    artist: "Oasis".into(),
                    duration_secs: 258.5,
                    singers: vec![2, 1],
                    key_offset: -2,
                    tempo: 1.0,
                    sing_next: false,
                    shiftable: true,
                    prep: PrepState {
                        state: PrepStage::Ready,
                        pct: None,
                        eta_secs: None,
                    },
                },
                PartyItem {
                    reservation_id: "r5".into(),
                    entry_id: None,
                    file_hash: HASH.into(),
                    title: "Creep".into(),
                    artist: "Radiohead".into(),
                    duration_secs: 238.0,
                    singers: vec![3],
                    key_offset: 0,
                    tempo: 1.0,
                    sing_next: false,
                    shiftable: false,
                    prep: PrepState {
                        state: PrepStage::Analyzing,
                        pct: Some(40),
                        eta_secs: Some(75),
                    },
                },
            ],
            queue_total: 2,
            singers: vec![PartySinger {
                slot: 1,
                color: PlayerColor::Rose,
                name: Some("Jim".into()),
                state: SlotState::Connected,
                volume_pct: DEFAULT_VOLUME_PCT,
                echo_pct: DEFAULT_ECHO_PCT,
            }],
            scores: vec![NightScore {
                slot: 1,
                color: PlayerColor::Rose,
                name: Some("Jim".into()),
                title: Some("The Final Countdown".into()),
                display_score: 100,
                raw_score: 995,
                tier: ScoreTier::Perfect,
                at_secs: 1_763_100_000,
            }],
        };
        let frame = ServerToMicParty::Party {
            party: snapshot.clone(),
        };
        assert_eq!(
            to_json(&frame),
            json!({"type": "party", "party": {
                "rev": 9, "tvConnected": true,
                "stage": {"state": "singing", "reservationId": "r3", "title": "Song 2",
                          "artist": "Blur", "singers": [1]},
                "queue": [
                    {"reservationId": "r4", "entryId": "12", "fileHash": HASH, "title": "Wonderwall",
                     "artist": "Oasis", "durationSecs": 258.5, "singers": [2, 1], "keyOffset": -2,
                     "tempo": 1.0, "singNext": false, "shiftable": true, "prep": {"state": "ready"}},
                    {"reservationId": "r5", "fileHash": HASH, "title": "Creep", "artist": "Radiohead",
                     "durationSecs": 238.0, "singers": [3], "keyOffset": 0, "tempo": 1.0,
                     "singNext": false, "shiftable": false,
                     "prep": {"state": "analyzing", "pct": 40, "etaSecs": 75}}
                ],
                "queueTotal": 2,
                "singers": [{"slot": 1, "color": "rose", "name": "Jim", "state": "connected",
                             "volumePct": 100, "echoPct": 100}],
                "scores": [{"slot": 1, "color": "rose", "name": "Jim", "title": "The Final Countdown",
                            "displayScore": 100, "rawScore": 995, "tier": "perfect",
                            "atSecs": 1_763_100_000_u32}]
            }})
        );

        assert_eq!(
            to_json(&ServerToTvParty::Party { party: snapshot }),
            to_json(&frame)
        );
        assert_eq!(
            to_json(&ServerToMicParty::Ack {
                req_id: 7,
                ok: false,
                code: Some(PartyErrorCode::PrepFull),
                reservation_id: None
            }),
            json!({"type": "ack", "reqId": 7, "ok": false, "code": "prep-full"})
        );
        assert_eq!(
            to_json(&ServerToTvParty::ShiftCurrent {
                slot: 2,
                mic_id: MIC.into(),
                key_offset: -1,
                tempo: 0.9
            }),
            json!({"type": "shift-current", "slot": 2, "micId": MIC, "keyOffset": -1, "tempo": 0.9})
        );
        assert_eq!(
            to_json(&ServerToMicParty::NightRank {
                rank: Some(2),
                entries: 14
            }),
            json!({"type": "night-rank", "rank": 2, "entries": 14})
        );
    }

    #[test]
    fn error_codes_split_fatal_from_recoverable() {
        assert!(!RtcErrorCode::BadFrame.is_fatal());
        assert!(!RtcErrorCode::NoTv.is_fatal());
        assert!(!RtcErrorCode::UnknownSlot.is_fatal());
        assert!(RtcErrorCode::BadResume.is_fatal());
        assert_eq!(RtcErrorCode::BadResume.close_code(), close_code::BAD_RESUME);
        assert_eq!(RtcErrorCode::TvReplaced.close_code(), close_code::REPLACED);
        assert_eq!(RtcErrorCode::SlotsFull.close_code(), close_code::SLOTS_FULL);
    }
}
