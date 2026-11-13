//! `/rtc`: the FireSong phone-mic signaling socket (PROTOCOL.md §4-§6).
//!
//! The listener decides the role: the remote router mounts [`mic_upgrade`],
//! the full router [`tv_upgrade`]. Each socket runs one task that reads
//! frames, enforces the handshake, size and rate limits, and writes whatever
//! the [`Hub`] queued for it.

mod hub;
mod mic_store;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use app_core::remote_mic::{
    close_code, decode_mic_frame, decode_tv_frame, MicToServer, RtcErrorCode, ServerToMic,
    ServerToTv, TvToServer, MAX_FRAME_BYTES, RATE_BURST, RATE_PER_SEC,
};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

pub(crate) use hub::Hub;
pub(crate) use mic_store::MicStore;

use crate::state::AppState;
use hub::{ConnId, MicHello, Outbound, Peer};

/// Frames queued for one socket before it counts as not reading.
const OUTBOUND_CAPACITY: usize = 256;

/// Frames this much over [`MAX_FRAME_BYTES`] still reach the decoder, so the
/// client gets a `too-large` error instead of a bare protocol close.
const TRANSPORT_LIMIT: usize = MAX_FRAME_BYTES * 4;

/// Close code when a client stops draining its queue.
const CLOSE_OVERLOADED: u16 = 1011;

static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

/// Socket timing. Defaults follow `remote_mic`; tests shorten them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timings {
    pub hello_timeout: Duration,
    pub ping_interval: Duration,
    pub idle_timeout: Duration,
    pub reservation: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        use app_core::remote_mic::{
            HELLO_TIMEOUT_SECS, IDLE_TIMEOUT_SECS, PING_INTERVAL_SECS, RESERVATION_SECS,
        };

        Self {
            hello_timeout: Duration::from_secs(u64::from(HELLO_TIMEOUT_SECS)),
            ping_interval: Duration::from_secs(u64::from(PING_INTERVAL_SECS)),
            idle_timeout: Duration::from_secs(u64::from(IDLE_TIMEOUT_SECS)),
            reservation: Duration::from_secs(u64::from(RESERVATION_SECS)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Tv,
    Mic,
}

pub(crate) async fn tv_upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    accept(state, &headers, upgrade, Role::Tv)
}

pub(crate) async fn mic_upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    accept(state, &headers, upgrade, Role::Mic)
}

fn accept(state: AppState, headers: &HeaderMap, upgrade: WebSocketUpgrade, role: Role) -> Response {
    if !state.firesong.origin_allowed(headers) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let hub = state.firesong.hub();
    let timings = state.firesong.timings();
    upgrade
        .max_message_size(TRANSPORT_LIMIT)
        .max_frame_size(TRANSPORT_LIMIT)
        .on_upgrade(move |socket| run(hub, timings, role, socket))
}

/// The browser's `Origin` must name this server (`Host`, `X-Forwarded-Host`)
/// or a configured phone/TV origin, so another site cannot open `/rtc` with
/// the visitor's cookies. Clients that send no `Origin` are not browsers.
pub(crate) fn origin_matches(headers: &HeaderMap, allowed: &[String]) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Some(origin) = origin.to_str().ok().and_then(origin_authority) else {
        return false;
    };
    let forwarded = headers
        .get("x-forwarded-host")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim);
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());

    host.into_iter()
        .chain(forwarded)
        .map(strip_default_port)
        .chain(
            allowed
                .iter()
                .filter_map(|allowed| origin_authority(allowed)),
        )
        .any(|candidate| candidate.eq_ignore_ascii_case(&origin))
}

/// `https://host:port/anything` -> `host:port`, default ports dropped.
pub(crate) fn origin_authority(origin: &str) -> Option<String> {
    let (scheme, rest) = origin.trim().split_once("://")?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    (!authority.is_empty()).then(|| strip_default_port(authority))
}

fn strip_default_port(authority: &str) -> String {
    authority
        .strip_suffix(":443")
        .or_else(|| authority.strip_suffix(":80"))
        .unwrap_or(authority)
        .to_string()
}

/// Token bucket: [`RATE_BURST`] frames, refilled at [`RATE_PER_SEC`].
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new() -> Self {
        Self {
            tokens: f64::from(RATE_BURST),
            at: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        let refill = now.duration_since(self.at).as_secs_f64() * f64::from(RATE_PER_SEC);
        self.tokens = (self.tokens + refill).min(f64::from(RATE_BURST));
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

struct Session {
    hub: Arc<Hub>,
    role: Role,
    peer: Peer,
    conn: ConnId,
    greeted: bool,
    closing: bool,
    bucket: Bucket,
}

impl Session {
    /// Sends `error` and, for fatal codes, the matching close. Everything goes
    /// through the peer queue so it stays ordered after frames the hub queued.
    fn fail(&mut self, code: RtcErrorCode) {
        match self.role {
            Role::Tv => self.peer.send(&ServerToTv::Error {
                code,
                message: None,
            }),
            Role::Mic => self.peer.send(&ServerToMic::Error {
                code,
                message: None,
            }),
        }
        if code.is_fatal() {
            self.closing = true;
            self.peer.close(code.close_code());
        }
    }

    fn on_frame(&mut self, text: Option<&str>) {
        if self.closing {
            return;
        }
        if !self.bucket.take() {
            self.fail(RtcErrorCode::RateLimited);
            return;
        }
        let Some(text) = text else {
            // Binary frames carry nothing in this protocol.
            let code = if self.greeted {
                RtcErrorCode::BadFrame
            } else {
                RtcErrorCode::NoHello
            };
            self.fail(code);
            return;
        };
        let result = match self.role {
            Role::Mic => self.on_mic_text(text),
            Role::Tv => self.on_tv_text(text),
        };
        if let Err(code) = result {
            self.fail(code);
        }
    }

    fn before_hello(&self, code: RtcErrorCode) -> RtcErrorCode {
        let keeps_code = matches!(
            code,
            RtcErrorCode::BadHello | RtcErrorCode::Version | RtcErrorCode::TooLarge
        );
        if self.greeted || keeps_code {
            code
        } else {
            RtcErrorCode::NoHello
        }
    }

    fn on_mic_text(&mut self, text: &str) -> Result<(), RtcErrorCode> {
        let frame = decode_mic_frame(text).map_err(|code| self.before_hello(code))?;
        match frame {
            MicToServer::Hello {
                mic_id,
                resume_key,
                slot,
                name,
                ..
            } => {
                if self.greeted {
                    return Err(RtcErrorCode::BadHello);
                }
                self.greeted = true;
                self.hub.mic_hello(
                    self.peer.clone(),
                    MicHello {
                        mic_id,
                        resume_key,
                        slot,
                        name,
                    },
                )
            }
            _ if !self.greeted => Err(RtcErrorCode::NoHello),
            frame => self.hub.mic_frame(self.conn, frame),
        }
    }

    fn on_tv_text(&mut self, text: &str) -> Result<(), RtcErrorCode> {
        let frame = decode_tv_frame(text).map_err(|code| self.before_hello(code))?;
        match frame {
            TvToServer::Hello { .. } => {
                if self.greeted || is_phone_hello(text) {
                    return Err(RtcErrorCode::BadHello);
                }
                self.greeted = true;
                self.hub.tv_hello(self.peer.clone());
                Ok(())
            }
            _ if !self.greeted => Err(RtcErrorCode::NoHello),
            frame => self.hub.tv_frame(self.conn, frame),
        }
    }

    fn gone(&self) {
        if !self.greeted {
            return;
        }
        match self.role {
            Role::Tv => self.hub.tv_gone(self.conn),
            Role::Mic => self.hub.mic_gone(self.conn),
        }
    }
}

async fn run(hub: Arc<Hub>, timings: Timings, role: Role, mut socket: WebSocket) {
    let conn = NEXT_CONN.fetch_add(1, Ordering::Relaxed);
    let (peer, mut outbound, overflow) = Peer::new(conn, OUTBOUND_CAPACITY);
    let mut session = Session {
        hub: hub.clone(),
        role,
        peer,
        conn,
        greeted: false,
        closing: false,
        bucket: Bucket::new(),
    };
    tracing::debug!(conn, ?role, "rtc connected");

    let hello_deadline = tokio::time::sleep(timings.hello_timeout);
    tokio::pin!(hello_deadline);
    let mut ping = tokio::time::interval_at(
        tokio::time::Instant::now() + timings.ping_interval,
        timings.ping_interval,
    );
    let mut last_heard = Instant::now();

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                let Some(Ok(message)) = inbound else { break };
                last_heard = Instant::now();
                match message {
                    Message::Text(text) => session.on_frame(Some(&text)),
                    Message::Binary(_) => session.on_frame(None),
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Close(_) => break,
                }
            }
            queued = outbound.recv() => match queued {
                Some(Outbound::Text(text)) => {
                    if socket.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                Some(Outbound::Close(code)) => {
                    close(&mut socket, code).await;
                    break;
                }
                None => break,
            },
            () = overflow.notified() => {
                tracing::warn!(conn, ?role, "rtc client stopped reading; closing");
                close(&mut socket, CLOSE_OVERLOADED).await;
                break;
            }
            () = &mut hello_deadline, if !session.greeted && !session.closing => {
                session.fail(RtcErrorCode::NoHello);
            }
            _ = ping.tick() => {
                if last_heard.elapsed() >= timings.idle_timeout {
                    close(&mut socket, close_code::TIMEOUT).await;
                    break;
                }
                hub.sweep();
                if socket.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    session.gone();
    tracing::debug!(conn, ?role, "rtc disconnected");
}

async fn close(socket: &mut WebSocket, code: u16) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: "".into(),
        })))
        .await;
}

/// A phone page opened on the TV door sends `hello {v, micId, ...}`. Unknown
/// fields are ignored when decoding, so it would otherwise take the TV seat
/// and close the real TV with 4409, which does not reconnect on its own.
fn is_phone_hello(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .is_some_and(|value| value.get("micId").is_some())
}
