//! FireSong additions to the self-hosted server (docs/firesong/PROTOCOL.md):
//! the phone listener, the host token on the full listener, `/rtc` with its
//! party channel, the per-slot phone links, pairing-token rotation, and the
//! phone door's command list.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, PoisonError, RwLock};
use std::time::Duration;

use app_core::remote_mic::{
    slot_color, IceServer, MicLink, MicLinks, MIC_PAGE_PATH, RTC_PATH, SLOT_COUNT,
    SONG_BOOK_COMMAND,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::Redirect,
    routing::{any, get, post},
    Json, Router,
};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;

use crate::flight::{self, Flight};
use crate::remote::REMOTE_COMMANDS;
pub use crate::rtc::Timings;
use crate::rtc::{self, Hub, MicStore};
use crate::state::{AppState, RemoteAddress};

/// What the phone door answers in a FireSong deployment (PROTOCOL.md §13.2):
/// reads and the song book. Phones change the queue and playback only over
/// `/rtc`, where the server knows which phone asks.
const PHONE_COMMANDS: &[&str] = &[
    SONG_BOOK_COMMAND,
    "load_interface_language",
    "load_playback_queue",
    "load_playback_status",
    "load_playback_progress",
    "load_playback_options",
    "load_profiles",
    "load_remote_microphones",
    "load_songs",
];

/// The party task's beat: coalesced snapshots, mixer relays, timeouts.
const PARTY_TICK: Duration = Duration::from_millis(100);

/// How the server was started; everything [`start`] needs from `main`.
#[derive(Debug, Clone)]
pub struct Options {
    /// `NIGHTINGALE_BIND`: the full listener.
    pub bind: SocketAddr,
    /// `NIGHTINGALE_REMOTE_BIND`: the phone listener, if any.
    pub remote_bind: Option<SocketAddr>,
    /// `NIGHTINGALE_REMOTE_URL`: the origin phones load `/m` and `/q` from.
    pub remote_url: Option<String>,
}

/// Runtime settings for the FireSong routes. [`start`] builds one from the
/// environment; tests build their own.
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// The value the full listener requires; `None` refuses every request.
    pub host_token: Option<String>,
    /// Where `firesong/remote-mics.json` lives; `None` keeps it in memory.
    pub data_dir: Option<PathBuf>,
    /// `FIRESONG_ICE_SERVERS`, handed to both ends in `assign` and `ready`.
    pub ice_servers: Vec<IceServer>,
    /// Origins besides the request's own host that may open `/rtc`: the
    /// pinned phone origin and `FIRESONG_RTC_ORIGINS`.
    pub allowed_origins: Vec<String>,
    pub timings: Timings,
}

/// The one FireSong field on `AppState`.
#[derive(Clone, Default)]
pub(crate) struct FireSong {
    settings: Arc<RwLock<Settings>>,
    hub: Arc<Hub>,
    party_task: Arc<OnceLock<()>>,
    flight: Flight,
}

#[derive(Default)]
struct Settings {
    host_token: Option<String>,
    allowed_origins: Vec<String>,
    timings: Timings,
}

impl FireSong {
    pub(crate) fn host_token(&self) -> Option<String> {
        self.settings
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .host_token
            .clone()
    }

    pub(crate) fn flight(&self) -> &Flight {
        &self.flight
    }

    pub(crate) fn hub(&self) -> Arc<Hub> {
        self.hub.clone()
    }

    pub(crate) fn timings(&self) -> Timings {
        self.settings
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .timings
    }

    pub(crate) fn origin_allowed(&self, headers: &HeaderMap) -> bool {
        let settings = self.settings.read().unwrap_or_else(PoisonError::into_inner);
        rtc::origin_matches(headers, &settings.allowed_origins)
    }
}

/// Applies `config` to `state`. Call before serving: slots already taken stay,
/// but the persisted mic data is reloaded from `data_dir`.
pub fn configure(state: &AppState, config: Config) {
    let Config {
        host_token,
        data_dir,
        ice_servers,
        allowed_origins,
        timings,
    } = config;
    let store = data_dir.map_or_else(MicStore::in_memory, |dir| {
        MicStore::load(dir.join("firesong").join("remote-mics.json"))
    });
    state
        .firesong
        .hub
        .configure(ice_servers, timings.reservation, store);
    state
        .firesong
        .hub
        .attach_party(state.commands.party().clone(), timings);
    start_party_task(state, timings.party_poll, timings.tv_gone_reset);
    *state
        .firesong
        .settings
        .write()
        .unwrap_or_else(PoisonError::into_inner) = Settings {
        host_token,
        allowed_origins,
        timings,
    };
}

/// Runs the party channel's timers and follows the playback queue and
/// preparing songs. Needs a Tokio runtime; started once per state.
fn start_party_task(state: &AppState, poll_every: Duration, tv_gone_reset: Duration) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        tracing::warn!("no async runtime: the party channel runs without timers");
        return;
    };
    let hub = Arc::downgrade(&state.firesong.hub);
    let events = state.events.clone();
    let commands = state.commands.clone();
    state.firesong.party_task.get_or_init(|| {
        let mut events = events.subscribe();
        runtime.spawn(async move {
            let mut tick = tokio::time::interval(PARTY_TICK);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut polled = tokio::time::Instant::now();
            let mut reset_for = None;
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let Some(hub) = hub.upgrade() else { return };
                        hub.party_tick();
                        if let Some((left, away)) = hub.tv_absence() {
                            if away >= tv_gone_reset && reset_for != Some(left) {
                                reset_for = Some(left);
                                tokio::spawn(stop_stale_playback(commands.clone()));
                            }
                        }
                        if polled.elapsed() >= poll_every {
                            polled = tokio::time::Instant::now();
                            if tokio::task::spawn_blocking(move || hub.prep_poll()).await.is_err() {
                                tracing::warn!("party preparation check failed");
                            }
                        }
                    }
                    event = events.recv() => {
                        let queue_changed = match event {
                            Ok(event) => event.r#type == "playback-queue-changed",
                            Err(RecvError::Lagged(_)) => true,
                            Err(RecvError::Closed) => return,
                        };
                        if queue_changed {
                            let Some(hub) = hub.upgrade() else { return };
                            hub.party_changed();
                        }
                    }
                }
            }
        });
    });
}

/// The TV published "playing" and then went away (HOME, switched off), so
/// nothing will ever publish "stopped": do it for the TV, through the same
/// commands, so phones, `/q` pages and song prep stop waiting for a song.
async fn stop_stale_playback(commands: app_api::CommandState) {
    let active = app_api::dispatch(commands.clone(), "load_playback_status", Value::Null)
        .await
        .ok()
        .and_then(|status| status.get("active").and_then(Value::as_bool))
        .unwrap_or(false);
    if !active {
        return;
    }
    let reset = [
        (
            "set_playback_status",
            serde_json::to_value(app_api::PlaybackStatus::default()),
        ),
        (
            "set_playback_progress",
            serde_json::to_value(app_api::PlaybackProgress::default()),
        ),
    ];
    for (name, payload) in reset {
        let Ok(payload) = payload else { continue };
        if let Err(error) = app_api::dispatch(commands.clone(), name, payload).await {
            tracing::warn!(
                command = name,
                "could not clear the stale playback state: {error}"
            );
            return;
        }
    }
    tracing::info!("the TV left during a song: playback marked stopped");
}

/// The commands the phone door answers: upstream's queue-page list, or in a
/// FireSong deployment (a separate phone listener) [`PHONE_COMMANDS`].
pub(crate) fn phone_commands(state: &AppState) -> &'static [&'static str] {
    if state.separate_phone_listener() {
        PHONE_COMMANDS
    } else {
        REMOTE_COMMANDS
    }
}

/// `/` on the phone door: the phone page in a FireSong deployment, the queue
/// page otherwise.
pub(crate) async fn phone_root(State(state): State<AppState>) -> Redirect {
    if state.separate_phone_listener() {
        Redirect::to(MIC_PAGE_PATH)
    } else {
        Redirect::to("/q")
    }
}

/// Phone links point at the phone listener. With a separate one, the request
/// that asked (the TV door) says nothing about where phones connect.
pub fn phone_address(options: &Options) -> RemoteAddress {
    match options.remote_bind {
        Some(remote_bind) => RemoteAddress::separate(remote_bind, options.remote_url.clone()),
        None => RemoteAddress::new(options.bind, options.remote_url.clone()),
    }
}

/// Loads the host token, reads the FireSong environment, configures `state`
/// and starts the phone listener when `NIGHTINGALE_REMOTE_BIND` is set.
pub async fn start(state: &AppState, options: &Options) -> Result<(), String> {
    if options.remote_bind == Some(options.bind) {
        return Err("NIGHTINGALE_REMOTE_BIND must differ from NIGHTINGALE_BIND".into());
    }
    check_phone_origin(options);

    let data_dir = app_core::default_nightingale_dir();
    let token_path = crate::host_auth::token_path(&data_dir);
    let host_token = {
        let path = token_path.clone();
        tokio::task::spawn_blocking(move || crate::host_auth::load_or_create(&path))
            .await
            .map_err(|error| format!("host token: {error}"))??
    };
    tracing::info!(path = %token_path.display(), "full listener requires the FireSong host token");

    let data_dir_for_flight = data_dir.clone();
    let config = Config {
        host_token: Some(host_token),
        data_dir: Some(data_dir),
        ice_servers: ice_servers_from_env()?,
        allowed_origins: allowed_origins(options),
        timings: Timings {
            party_hold: party_hold_from_env(),
            ..Timings::default()
        },
    };
    let state_for_load = state.clone();
    tokio::task::spawn_blocking(move || configure(&state_for_load, config))
        .await
        .map_err(|error| format!("FireSong setup: {error}"))?;

    let flight = state.firesong.flight().clone();
    let recorder = flight.clone();
    let recorder_dir = data_dir_for_flight;
    let on = tokio::task::spawn_blocking(move || recorder.start(&recorder_dir))
        .await
        .map_err(|error| format!("flight recorder: {error}"))?;
    if on {
        tokio::spawn(flight.runtime_watchdog());
    }

    if let Some(remote_bind) = options.remote_bind {
        serve_phones(state.clone(), remote_bind).await?;
    }
    Ok(())
}

async fn serve_phones(state: AppState, bind: SocketAddr) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|error| format!("failed to bind phone listener {bind}: {error}"))?;
    tracing::info!(addr = %bind, "FireSong phone listener (remote router + /rtc)");
    tokio::spawn(async move {
        let app = crate::remote_router(state).into_make_service();
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!("phone listener error: {error}");
        }
    });
    Ok(())
}

/// Phones need a secure context for the microphone, so `/m` links should be
/// https (or localhost during development).
fn check_phone_origin(options: &Options) {
    if options.remote_bind.is_none() {
        return;
    }
    match options.remote_url.as_deref() {
        None => tracing::warn!(
            "NIGHTINGALE_REMOTE_URL is unset; phone links fall back to the LAN address over http"
        ),
        Some(url) if !is_secure_origin(url) => tracing::warn!(
            url,
            "NIGHTINGALE_REMOTE_URL is not https; phones cannot use the microphone from it"
        ),
        Some(_) => {}
    }
}

fn is_secure_origin(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") {
        return true;
    }
    rtc::origin_authority(&lower).is_some_and(|authority| {
        let host = authority
            .rsplit_once(':')
            .map_or(authority.as_str(), |(host, _)| host);
        matches!(host, "localhost" | "127.0.0.1" | "[::1]")
    })
}

fn allowed_origins(options: &Options) -> Vec<String> {
    let extra = std::env::var("FIRESONG_RTC_ORIGINS").unwrap_or_default();
    options
        .remote_url
        .iter()
        .cloned()
        .chain(
            extra
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(str::to_owned),
        )
        .collect()
}

/// `FIRESONG_PARTY_HOLD_MIN`: whole minutes party mode outlasts the TV.
fn party_hold_from_env() -> Duration {
    std::env::var("FIRESONG_PARTY_HOLD_MIN")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map_or(Duration::from_secs(rtc::PARTY_HOLD_SECS), |minutes| {
            Duration::from_secs(minutes * 60)
        })
}

fn ice_servers_from_env() -> Result<Vec<IceServer>, String> {
    match std::env::var("FIRESONG_ICE_SERVERS") {
        Ok(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).map_err(|error| {
            format!("FIRESONG_ICE_SERVERS is not a JSON IceServer array: {error}")
        }),
        _ => Ok(Vec::new()),
    }
}

/// `/rtc` (TV role), the phone links, token rotation, party mode and the
/// flight recorder; host token required.
pub(crate) fn tv_routes() -> Router<AppState> {
    Router::new()
        .route(RTC_PATH, any(rtc::tv_upgrade))
        .route("/api/firesong/mic-links", get(handle_mic_links))
        .route(
            "/api/firesong/rotate-pairing-token",
            post(handle_rotate_pairing_token),
        )
        .route("/api/firesong/party", get(handle_party))
        .route(
            "/api/firesong/flight",
            post(flight::handle_tv).layer(DefaultBodyLimit::max(flight::MAX_BODY_BYTES)),
        )
}

/// `/rtc` (phone role); pairing token required.
pub(crate) fn phone_routes() -> Router<AppState> {
    Router::new().route(RTC_PATH, any(rtc::mic_upgrade))
}

/// Party mode (docs/firesong/FLIGHT.md): background prep waits while it is on.
async fn handle_party() -> Json<Value> {
    Json(serde_json::json!({ "active": app_core::party_active() }))
}

async fn handle_mic_links(State(state): State<AppState>, headers: HeaderMap) -> Json<MicLinks> {
    Json(mic_links(&state, &headers))
}

/// New pairing token: every printed or shown link stops working and every
/// phone is disconnected (`slot-lost {kicked}`). Returns the new links. The
/// token is saved first; if that fails nothing changes, or a restart would
/// bring the revoked token back.
async fn handle_rotate_pairing_token(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MicLinks>, (StatusCode, &'static str)> {
    const FAILED: (StatusCode, &str) = (
        StatusCode::INTERNAL_SERVER_ERROR,
        "token rotation failed: the new token could not be saved",
    );
    let fresh = app_core::RemoteControl::default();
    let to_save = fresh.clone();
    tokio::task::spawn_blocking(move || to_save.try_save())
        .await
        .map_err(|_| FAILED)?
        .map_err(|error| {
            tracing::warn!("pairing token rotation not saved: {error}");
            FAILED
        })?;
    *state.remote.write().unwrap_or_else(PoisonError::into_inner) = fresh;
    let kicked = state.firesong.hub().kick_all();
    tracing::info!(kicked, "pairing token rotated");
    Ok(Json(mic_links(&state, &headers)))
}

fn mic_links(state: &AppState, headers: &HeaderMap) -> MicLinks {
    let base = state.remote_base(headers);
    let control = state.remote.read().unwrap_or_else(PoisonError::into_inner);
    let slots = (1..=SLOT_COUNT)
        .filter_map(|slot| {
            let color = slot_color(slot)?;
            let url = base
                .as_deref()
                .map(|base| format!("{base}{MIC_PAGE_PATH}?t={}&slot={slot}", control.token));
            let qr_svg = control.info_with_url(url.clone()).qr_svg;
            Some(MicLink {
                slot,
                color,
                url,
                qr_svg,
            })
        })
        .collect();
    MicLinks { slots }
}
