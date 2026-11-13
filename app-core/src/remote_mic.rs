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
pub const RATE_BURST: u32 = 40;
pub const RATE_PER_SEC: u32 = 20;

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
