//! FireSong server checks: listener auth, secret redaction, and the `/rtc`
//! relay and slot registry driven by real WebSocket clients.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use app_core::{AppConfig, LibrarySource, RemoteControl};
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use server::firesong::{self, Config, Timings};
use server::{AppState, EventBus, RemoteAddress};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tower::ServiceExt;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const HOST_TOKEN: &str = "0123456789abcdef0123456789abcdef";
const PAIRING_TOKEN: &str = "fedcba9876543210fedcba9876543210";
const PHONE_ORIGIN: &str = "https://phones.example.test:8443";
const PLEX_SECRET: &str = "plex-secret-token-value";
const MIC_A: &str = "phone-a-0000-0000-0000-000000000001";
const MIC_B: &str = "phone-b-0000-0000-0000-000000000002";
const MIC_C: &str = "phone-c-0000-0000-0000-000000000003";
const MIC_D: &str = "phone-d-0000-0000-0000-000000000004";
const MIC_E: &str = "phone-e-0000-0000-0000-000000000005";
const WAIT: Duration = Duration::from_secs(3);

/// One data folder per test binary (app-core keeps it process-wide), under the
/// cargo target dir rather than /tmp.
fn data_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("firesong-server-tests-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create test data root");
        app_core::set_default_data_path(root.clone()).expect("set data path once");
        root
    })
}

/// `config.json` is process-wide too; tests that read or write it take turns.
static CONFIG: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn fresh_dir(label: &str) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = data_root().join(format!("{label}-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).expect("create test dir");
    dir
}

fn fast_timings() -> Timings {
    Timings {
        hello_timeout: Duration::from_millis(400),
        ping_interval: Duration::from_millis(50),
        idle_timeout: Duration::from_secs(10),
        reservation: Duration::from_secs(600),
    }
}

struct Server {
    state: AppState,
    full: SocketAddr,
    phone: SocketAddr,
    data_dir: PathBuf,
}

fn new_state(data_dir: &Path, timings: Timings) -> AppState {
    data_root();
    let events = Arc::new(EventBus::new());
    let commands = app_api::CommandState::new(events.clone());
    let state = AppState::new(
        commands,
        events,
        RemoteControl {
            token: PAIRING_TOKEN.into(),
        },
        RemoteAddress::separate(
            SocketAddr::from(([127, 0, 0, 1], 9)),
            Some(PHONE_ORIGIN.into()),
        ),
        true,
        false,
    );
    firesong::configure(
        &state,
        Config {
            host_token: Some(HOST_TOKEN.into()),
            data_dir: Some(data_dir.to_path_buf()),
            ice_servers: Vec::new(),
            allowed_origins: vec![PHONE_ORIGIN.into()],
            timings,
        },
    );
    state
}

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test listener");
    let address = listener.local_addr().expect("listener address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router.into_make_service()).await;
    });
    address
}

async fn start(timings: Timings) -> Server {
    let data_dir = fresh_dir("rtc");
    start_in(data_dir, timings).await
}

async fn start_in(data_dir: PathBuf, timings: Timings) -> Server {
    let state = new_state(&data_dir, timings);
    let full = serve(server::router(state.clone())).await;
    let phone = serve(server::remote_router(state.clone())).await;
    Server {
        state,
        full,
        phone,
        data_dir,
    }
}

async fn connect(address: SocketAddr, header: (&'static str, &str)) -> Socket {
    let mut request = format!("ws://{address}/rtc")
        .into_client_request()
        .expect("ws request");
    request.headers_mut().insert(
        header.0,
        HeaderValue::from_str(header.1).expect("header value"),
    );
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ws connect");
    socket
}

async fn tv(server: &Server) -> Socket {
    let mut socket = connect(server.full, ("x-firesong-host-token", HOST_TOKEN)).await;
    send(&mut socket, json!({"type": "hello", "v": 1})).await;
    assert_eq!(recv(&mut socket).await["type"], "ready");
    assert_eq!(recv(&mut socket).await["type"], "roster");
    socket
}

async fn phone_socket(server: &Server) -> Socket {
    connect(server.phone, ("x-nightingale-token", PAIRING_TOKEN)).await
}

/// Joins as a phone and returns the socket plus its `assign` frame.
async fn phone(server: &Server, hello: Value) -> (Socket, Value) {
    let mut socket = phone_socket(server).await;
    send(&mut socket, hello).await;
    let assign = recv(&mut socket).await;
    assert_eq!(assign["type"], "assign", "{assign}");
    (socket, assign)
}

async fn send(socket: &mut Socket, frame: Value) {
    socket
        .send(Message::Text(frame.to_string()))
        .await
        .expect("ws send");
}

/// Next JSON frame, skipping transport pings.
async fn recv(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("frame in time")
            .expect("socket open")
            .expect("ws frame");
        match message {
            Message::Text(text) => return serde_json::from_str(&text).expect("json frame"),
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("expected a text frame, got {other:?}"),
        }
    }
}

/// Next frame of `kind`, skipping others (rosters arrive on every change).
async fn recv_type(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let frame = recv(socket).await;
        if frame["type"] == kind {
            return frame;
        }
    }
}

async fn expect_close(socket: &mut Socket, code: u16) {
    loop {
        let message = tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("close in time");
        match message {
            Some(Ok(Message::Close(Some(CloseFrame { code: got, .. })))) => {
                assert_eq!(u16::from(got), code);
                return;
            }
            Some(Ok(Message::Close(None))) | None => panic!("closed without code {code}"),
            Some(Ok(_)) => {}
            Some(Err(error)) => panic!("socket error before close {code}: {error}"),
        }
    }
}

/// Asserts nothing but rosters/pings arrives for a short while.
async fn expect_quiet(socket: &mut Socket) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, socket.next()).await {
        if let Message::Text(text) = message {
            let frame: Value = serde_json::from_str(&text).expect("json frame");
            assert_eq!(frame["type"], "roster", "unexpected frame {frame}");
        }
    }
}

fn mic_hello(mic_id: &str, slot: Option<u8>) -> Value {
    let mut hello = json!({"type": "hello", "v": 1, "micId": mic_id});
    if let Some(slot) = slot {
        hello["slot"] = json!(slot);
    }
    hello
}

async fn http(
    router: Router,
    request: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, String) {
    let response = router.oneshot(request).await.expect("router response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .expect("body");
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

fn get(uri: &str) -> axum::http::request::Builder {
    Request::builder().method("GET").uri(uri)
}

fn cmd(name: &str, payload: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/api/cmd/{name}"))
        .header("x-firesong-host-token", HOST_TOKEN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(payload.to_string()))
        .expect("request")
}

// ── Listener auth ────────────────────────────────────────────────────────

#[tokio::test]
async fn full_listener_requires_the_host_token() {
    let _config = CONFIG.lock().await;
    let state = new_state(&fresh_dir("auth"), Timings::default());
    let full = server::router(state.clone());

    for uri in [
        "/api/bootstrap",
        "/",
        "/assets/missing.js",
        "/rtc",
        "/api/firesong/mic-links",
    ] {
        let (status, _, body) =
            http(full.clone(), get(uri).body(Body::empty()).expect("req")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
        assert_eq!(body, "host token required");
    }

    let wrong = get("/api/bootstrap")
        .header("x-firesong-host-token", "ffffffffffffffffffffffffffffffff")
        .body(Body::empty())
        .expect("req");
    assert_eq!(http(full.clone(), wrong).await.0, StatusCode::UNAUTHORIZED);

    // Phones' pairing token is not a host token.
    let pairing = get("/api/bootstrap")
        .header("x-nightingale-token", PAIRING_TOKEN)
        .header(
            header::COOKIE,
            format!("nightingale_remote={PAIRING_TOKEN}"),
        )
        .body(Body::empty())
        .expect("req");
    assert_eq!(
        http(full.clone(), pairing).await.0,
        StatusCode::UNAUTHORIZED
    );

    let by_header = get("/api/bootstrap")
        .header("x-firesong-host-token", HOST_TOKEN)
        .body(Body::empty())
        .expect("req");
    assert_eq!(http(full.clone(), by_header).await.0, StatusCode::OK);

    let by_cookie = get("/api/bootstrap")
        .header(
            header::COOKIE,
            format!("other=1; firesong_host={HOST_TOKEN}"),
        )
        .body(Body::empty())
        .expect("req");
    assert_eq!(http(full.clone(), by_cookie).await.0, StatusCode::OK);

    let favicon = get("/favicon.png").body(Body::empty()).expect("req");
    assert_ne!(
        http(full.clone(), favicon).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn host_query_sets_the_cookie_and_strips_itself() {
    let _config = CONFIG.lock().await;
    let state = new_state(&fresh_dir("auth"), Timings::default());
    let full = server::router(state);

    let navigation = get(&format!("/?tv=1&host={HOST_TOKEN}&mode=noraebang"))
        .header(header::ACCEPT, "text/html,application/xhtml+xml")
        .header("x-forwarded-proto", "https")
        .body(Body::empty())
        .expect("req");
    let (status, headers, _) = http(full.clone(), navigation).await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(headers[header::LOCATION], "/?tv=1&mode=noraebang");
    let cookie = headers[header::SET_COOKIE].to_str().expect("cookie");
    assert_eq!(
        cookie,
        format!("firesong_host={HOST_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Secure")
    );

    let fetch = get(&format!("/api/bootstrap?host={HOST_TOKEN}"))
        .body(Body::empty())
        .expect("req");
    let (status, headers, _) = http(full.clone(), fetch).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers[header::SET_COOKIE]
        .to_str()
        .expect("cookie")
        .ends_with("SameSite=Strict"));

    let wrong = get("/?host=00000000000000000000000000000000")
        .header(header::ACCEPT, "text/html")
        .body(Body::empty())
        .expect("req");
    assert_eq!(http(full, wrong).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn phone_listener_keeps_the_pairing_token_and_command_allowlist() {
    let state = new_state(&fresh_dir("auth"), Timings::default());
    let phone = server::remote_router(state);

    let (status, _, _) = http(phone.clone(), get("/q").body(Body::empty()).expect("req")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = http(phone.clone(), get("/rtc").body(Body::empty()).expect("req")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // The host token opens nothing on the phone door.
    let host = get("/q")
        .header("x-firesong-host-token", HOST_TOKEN)
        .body(Body::empty())
        .expect("req");
    assert_eq!(http(phone.clone(), host).await.0, StatusCode::UNAUTHORIZED);

    let link = get(&format!("/m?t={PAIRING_TOKEN}&slot=2"))
        .body(Body::empty())
        .expect("req");
    let (status, headers, _) = http(phone.clone(), link).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers[header::SET_COOKIE]
        .to_str()
        .expect("cookie")
        .starts_with(&format!("nightingale_remote={PAIRING_TOKEN}")));

    let load_config = Request::builder()
        .method("POST")
        .uri("/api/cmd/load_config")
        .header("x-nightingale-token", PAIRING_TOKEN)
        .body(Body::empty())
        .expect("req");
    assert_eq!(http(phone, load_config).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn rtc_rejects_foreign_origins() {
    let server = start(fast_timings()).await;
    for (address, header, origin, allowed) in [
        (
            server.phone,
            ("x-nightingale-token", PAIRING_TOKEN),
            PHONE_ORIGIN,
            true,
        ),
        (
            server.phone,
            ("x-nightingale-token", PAIRING_TOKEN),
            "https://evil.example",
            false,
        ),
        (
            server.full,
            ("x-firesong-host-token", HOST_TOKEN),
            "https://evil.example",
            false,
        ),
        (
            server.full,
            ("x-firesong-host-token", HOST_TOKEN),
            "null",
            false,
        ),
    ] {
        let mut request = format!("ws://{address}/rtc")
            .into_client_request()
            .expect("ws request");
        request
            .headers_mut()
            .insert(header.0, HeaderValue::from_str(header.1).expect("header"));
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_str(origin).expect("origin"));
        let result = tokio_tungstenite::connect_async(request).await;
        assert_eq!(result.is_ok(), allowed, "{origin} on {address}");
    }

    // Same-origin pages (the TV app, the operator's browser) are fine.
    let mut request = format!("ws://{}/rtc", server.full)
        .into_client_request()
        .expect("ws request");
    request.headers_mut().insert(
        "x-firesong-host-token",
        HeaderValue::from_static(HOST_TOKEN),
    );
    let origin = format!("http://{}", server.full);
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(&origin).expect("origin"));
    assert!(tokio_tungstenite::connect_async(request).await.is_ok());
}

// ── Redaction ────────────────────────────────────────────────────────────

#[tokio::test]
async fn library_secrets_are_redacted_and_survive_a_save() {
    let _config = CONFIG.lock().await;
    let state = new_state(&fresh_dir("redact"), Timings::default());
    let full = server::router(state);

    let source = LibrarySource::Plex {
        base_url: "http://plex.invalid:32400".into(),
        server_name: "Plex".into(),
        machine_id: "machine-1".into(),
        username: "owner".into(),
        access_token: PLEX_SECRET.into(),
        client_id: "client-1".into(),
        section_ids: vec!["3".into()],
    };
    let mut config = AppConfig::load();
    config.library_source = Some(source.clone());
    config.dark_mode = Some(false);
    config.save();

    let bootstrap = get("/api/bootstrap")
        .header("x-firesong-host-token", HOST_TOKEN)
        .body(Body::empty())
        .expect("req");
    let (status, _, body) = http(full.clone(), bootstrap).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains(PLEX_SECRET), "bootstrap leaked the token");
    assert!(body.contains(app_api::REDACTED_SECRET));

    let (status, _, body) = http(full.clone(), cmd("load_config", &Value::Null)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains(PLEX_SECRET), "load_config leaked the token");
    let mut loaded: Value = serde_json::from_str(&body).expect("config json");
    assert_eq!(
        loaded["library_source"]["access_token"],
        app_api::REDACTED_SECRET
    );

    // The settings form saves back exactly what it loaded, plus a change.
    loaded["dark_mode"] = json!(true);
    let (status, _, body) =
        http(full.clone(), cmd("save_config", &json!({"config": loaded}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.contains(PLEX_SECRET), "save_config leaked the token");

    let stored = AppConfig::load();
    assert_eq!(stored.dark_mode, Some(true));
    assert_eq!(stored.library_source, Some(source.clone()));
    let on_disk = std::fs::read_to_string(data_root().join("config.json")).expect("config.json");
    assert!(!on_disk.contains(app_api::REDACTED_SECRET));

    // A marker for some other server keeps the stored source untouched.
    let mut other = loaded.clone();
    other["library_source"]["machine_id"] = json!("machine-2");
    let (status, _, _) = http(full.clone(), cmd("save_config", &json!({"config": other}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(AppConfig::load().library_source, Some(source.clone()));

    // set_library_source cannot turn a marker into a secret it never issued.
    let mut foreign = serde_json::to_value(&source).expect("source json");
    foreign["machine_id"] = json!("machine-3");
    foreign["access_token"] = json!(app_api::REDACTED_SECRET);
    let (status, _, _) = http(
        full.clone(),
        cmd("set_library_source", &json!({"source": foreign})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(AppConfig::load().library_source, Some(source));
}

// ── /rtc relay and slot registry ─────────────────────────────────────────

#[tokio::test]
async fn signaling_is_unicast_and_stamped_by_the_server() {
    let server = start(fast_timings()).await;
    let mut tv = tv(&server).await;

    let (mut alice, assign) = phone(&server, mic_hello(MIC_A, Some(2))).await;
    assert_eq!(assign["slot"], 2);
    assert_eq!(assign["color"], "fuchsia");
    assert_eq!(assign["reclaimed"], false);
    assert_eq!(assign["tvConnected"], true);
    let roster = recv_type(&mut tv, "roster").await;
    assert_eq!(roster["slots"][1]["state"], "connected");
    assert_eq!(roster["slots"][1]["micId"], MIC_A);

    let (mut bob, assign) = phone(&server, mic_hello(MIC_B, None)).await;
    assert_eq!(assign["slot"], 1);
    assert_eq!(assign["color"], "rose");

    // Sender fields a phone tries to set are ignored: the server stamps them.
    send(
        &mut alice,
        json!({"type": "offer", "sdp": "v=0 alice", "restart": false, "slot": 1, "micId": MIC_B}),
    )
    .await;
    let offer = recv_type(&mut tv, "offer").await;
    assert_eq!(
        offer,
        json!({"type": "offer", "slot": 2, "micId": MIC_A, "sdp": "v=0 alice", "restart": false})
    );

    send(
        &mut tv,
        json!({"type": "answer", "slot": 2, "sdp": "v=0 tv"}),
    )
    .await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "answer", "sdp": "v=0 tv"})
    );
    expect_quiet(&mut bob).await;

    send(&mut bob, json!({"type": "ice", "candidate": {"candidate": "candidate:1 1 udp 1 192.0.2.1 5000 typ host", "sdpMid": "0"}})).await;
    let ice = recv_type(&mut tv, "ice").await;
    assert_eq!(ice["slot"], 1);
    assert_eq!(ice["micId"], MIC_B);
    assert_eq!(ice["candidate"]["sdpMid"], "0");

    send(&mut tv, json!({"type": "answer", "slot": 3, "sdp": "v=0"})).await;
    assert_eq!(
        recv_type(&mut tv, "error").await,
        json!({"type": "error", "code": "unknown-slot"})
    );

    send(
        &mut tv,
        json!({"type": "song-result", "title": "Song", "results": [
            {"slot": 2, "displayScore": 97, "rawScore": 812, "tier": "excellent", "rank": 1},
            {"slot": 4, "displayScore": 10, "rawScore": 5, "tier": "retry", "rank": 2}
        ]}),
    )
    .await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "song-result", "displayScore": 97, "rawScore": 812, "tier": "excellent",
               "rank": 1, "singers": 2, "title": "Song"})
    );
    expect_quiet(&mut bob).await;

    send(&mut alice, json!({"type": "ping", "t": 42.5})).await;
    assert_eq!(recv(&mut alice).await, json!({"type": "pong", "t": 42.5}));
}

#[tokio::test]
async fn offers_without_a_tv_get_no_tv_and_tv_reloads_reach_phones() {
    let server = start(fast_timings()).await;
    let (mut alice, assign) = phone(&server, mic_hello(MIC_A, Some(3))).await;
    assert_eq!(assign["tvConnected"], false);

    send(
        &mut alice,
        json!({"type": "offer", "sdp": "v=0", "restart": false}),
    )
    .await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "error", "code": "no-tv"})
    );

    let mut first_tv = tv(&server).await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "tv-state", "connected": true})
    );

    // A reloaded TV takes the seat; the old socket is told and closed.
    let mut second_tv = tv(&server).await;
    assert_eq!(
        recv_type(&mut first_tv, "error").await,
        json!({"type": "error", "code": "tv-replaced"})
    );
    expect_close(&mut first_tv, 4409).await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "tv-state", "connected": true})
    );

    second_tv.close(None).await.expect("close tv");
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "tv-state", "connected": false})
    );
}

#[tokio::test]
async fn a_reconnecting_phone_reclaims_its_slot() {
    let server = start(fast_timings()).await;
    let mut tv = tv(&server).await;

    let mut hello = mic_hello(MIC_A, Some(3));
    hello["name"] = json!("Jim");
    let (alice, assign) = phone(&server, hello).await;
    let resume_key = assign["resumeKey"]
        .as_str()
        .expect("resume key")
        .to_string();
    assert_eq!(resume_key.len(), 32);
    drop(alice);

    let lost = recv_type(&mut tv, "slot-lost").await;
    assert_eq!(
        lost,
        json!({"type": "slot-lost", "slot": 3, "micId": MIC_A, "reason": "disconnected"})
    );
    let roster = recv_type(&mut tv, "roster").await;
    assert_eq!(roster["slots"][2]["state"], "reserved");
    assert_eq!(roster["slots"][2]["name"], "Jim");
    assert!(roster["slots"][2]["reservedForSecs"]
        .as_u64()
        .is_some_and(|secs| secs > 590));

    // Someone else cannot take the slot with the public micId alone.
    let mut thief = phone_socket(&server).await;
    send(&mut thief, mic_hello(MIC_A, Some(3))).await;
    assert_eq!(
        recv(&mut thief).await,
        json!({"type": "error", "code": "bad-resume"})
    );
    expect_close(&mut thief, 4403).await;

    let mut hello = mic_hello(MIC_A, Some(1));
    hello["resumeKey"] = json!(resume_key);
    let (mut alice, assign) = phone(&server, hello.clone()).await;
    assert_eq!(assign["slot"], 3);
    assert_eq!(assign["reclaimed"], true);
    assert_eq!(assign["resumeKey"], resume_key);
    let roster = recv_type(&mut tv, "roster").await;
    assert_eq!(roster["slots"][2]["state"], "connected");

    // The same phone in a second tab replaces the first socket.
    let (_tab, assign) = phone(&server, hello).await;
    assert_eq!(assign["reclaimed"], true);
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "slot-lost", "reason": "replaced"})
    );
    expect_close(&mut alice, 4409).await;
    assert_eq!(
        recv_type(&mut tv, "slot-lost").await,
        json!({"type": "slot-lost", "slot": 3, "micId": MIC_A, "reason": "replaced"})
    );
}

#[tokio::test]
async fn reservations_expire_and_full_rooms_evict_the_oldest_reservation() {
    let mut timings = fast_timings();
    timings.reservation = Duration::from_millis(300);
    let server = start(timings).await;
    let mut tv = tv(&server).await;

    let (alice, _) = phone(&server, mic_hello(MIC_A, Some(1))).await;
    drop(alice);
    assert_eq!(
        recv_type(&mut tv, "slot-lost").await["reason"],
        "disconnected"
    );
    assert_eq!(
        recv_type(&mut tv, "slot-lost").await,
        json!({"type": "slot-lost", "slot": 1, "micId": MIC_A, "reason": "expired"})
    );

    let mut timings = fast_timings();
    timings.reservation = Duration::from_secs(600);
    let server = start(timings).await;
    let mut tv = crate::tv(&server).await;
    let mut phones = Vec::new();
    for mic in [MIC_A, MIC_B, MIC_C, MIC_D] {
        phones.push(phone(&server, mic_hello(mic, None)).await.0);
    }
    let mut extra = phone_socket(&server).await;
    send(&mut extra, mic_hello(MIC_E, None)).await;
    assert_eq!(
        recv(&mut extra).await,
        json!({"type": "error", "code": "slots-full"})
    );
    expect_close(&mut extra, 4503).await;

    // Slot 2's phone drops; a newcomer may take its reserved slot.
    drop(phones.remove(1));
    assert_eq!(recv_type(&mut tv, "slot-lost").await["slot"], 2);
    let (_newcomer, assign) = phone(&server, mic_hello(MIC_E, Some(4))).await;
    assert_eq!(assign["slot"], 2);
    assert_eq!(
        recv_type(&mut tv, "slot-lost").await,
        json!({"type": "slot-lost", "slot": 2, "micId": MIC_B, "reason": "evicted"})
    );
}

#[tokio::test]
async fn phones_cannot_send_tv_frames() {
    let server = start(fast_timings()).await;
    let mut tv = tv(&server).await;

    let mut early = phone_socket(&server).await;
    send(&mut early, json!({"type": "kick", "slot": 1})).await;
    assert_eq!(
        recv(&mut early).await,
        json!({"type": "error", "code": "no-hello"})
    );
    expect_close(&mut early, 4408).await;

    let (mut alice, _) = phone(&server, mic_hello(MIC_A, Some(1))).await;
    let (mut bob, _) = phone(&server, mic_hello(MIC_B, Some(2))).await;
    for frame in [
        json!({"type": "kick", "slot": 2}),
        json!({"type": "answer", "slot": 2, "sdp": "v=0"}),
        json!({"type": "restart", "slot": 2}),
        json!({"type": "latency", "slot": 2, "latencyMs": 100, "method": "beep"}),
    ] {
        send(&mut alice, frame.clone()).await;
        assert_eq!(
            recv(&mut alice).await,
            json!({"type": "error", "code": "bad-frame"}),
            "{frame}"
        );
    }

    // `mute` is a phone frame too, but it only ever mutes the sender's slot.
    send(
        &mut alice,
        json!({"type": "mute", "slot": 2, "muted": true}),
    )
    .await;
    assert_eq!(
        recv_type(&mut tv, "mute").await,
        json!({"type": "mute", "slot": 1, "muted": true, "by": "mic"})
    );
    expect_quiet(&mut bob).await;

    send(&mut alice, json!({"type": "hello", "v": 1, "micId": MIC_A})).await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "error", "code": "bad-hello"})
    );
    expect_close(&mut alice, 4400).await;

    // A TV socket cannot send phone frames either.
    send(&mut tv, json!({"type": "offer", "sdp": "v=0"})).await;
    assert_eq!(
        recv_type(&mut tv, "error").await,
        json!({"type": "error", "code": "bad-frame"})
    );
}

#[tokio::test]
async fn host_controls_reach_only_their_phone() {
    let server = start(fast_timings()).await;
    let mut tv = tv(&server).await;
    let (mut alice, _) = phone(&server, mic_hello(MIC_A, Some(1))).await;
    let (mut bob, _) = phone(&server, mic_hello(MIC_B, Some(2))).await;

    send(&mut tv, json!({"type": "mute", "slot": 2, "muted": true})).await;
    assert_eq!(
        recv(&mut bob).await,
        json!({"type": "mute", "muted": true, "by": "tv"})
    );
    send(&mut tv, json!({"type": "restart", "slot": 2})).await;
    assert_eq!(recv(&mut bob).await, json!({"type": "restart"}));
    expect_quiet(&mut alice).await;

    send(&mut tv, json!({"type": "kick", "slot": 1})).await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "slot-lost", "reason": "kicked"})
    );
    expect_close(&mut alice, 4410).await;
    assert_eq!(
        recv_type(&mut tv, "slot-lost").await,
        json!({"type": "slot-lost", "slot": 1, "micId": MIC_A, "reason": "kicked"})
    );
    send(&mut tv, json!({"type": "kick", "slot": 1})).await;
    assert_eq!(
        recv_type(&mut tv, "error").await,
        json!({"type": "error", "code": "unknown-slot"})
    );

    send(&mut bob, json!({"type": "bye"})).await;
    expect_close(&mut bob, 1000).await;
    assert_eq!(recv_type(&mut tv, "slot-lost").await["reason"], "bye");
}

#[tokio::test]
async fn latency_is_persisted_per_mic_without_secrets() {
    let server = start(fast_timings()).await;
    let mut tv = tv(&server).await;
    let mut hello = mic_hello(MIC_A, Some(2));
    hello["name"] = json!("Mina");
    let (_alice, assign) = phone(&server, hello).await;
    let resume_key = assign["resumeKey"]
        .as_str()
        .expect("resume key")
        .to_string();

    send(
        &mut tv,
        json!({"type": "latency", "slot": 2, "latencyMs": 180, "method": "beep"}),
    )
    .await;
    let mut roster = recv_type(&mut tv, "roster").await;
    while roster["slots"][1]["latencyMs"].is_null() {
        roster = recv_type(&mut tv, "roster").await;
    }
    assert_eq!(roster["slots"][1]["latencyMs"], 180);
    assert_eq!(roster["slots"][1]["latencyMethod"], "beep");

    let path = server.data_dir.join("firesong").join("remote-mics.json");
    let mut stored = Value::Null;
    for _ in 0..50 {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            stored = serde_json::from_str(&raw).expect("remote-mics json");
            if stored["mics"][MIC_A]["latencyMs"] == 180 {
                assert!(!raw.contains(&resume_key));
                assert!(!raw.contains(PAIRING_TOKEN));
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(stored["version"], 1);
    assert_eq!(stored["mics"][MIC_A]["name"], "Mina");
    assert_eq!(stored["mics"][MIC_A]["latencyMs"], 180);
    assert_eq!(stored["mics"][MIC_A]["latencyMethod"], "beep");

    // A restarted server (empty registry) still knows this phone's latency.
    let restarted = start_in(server.data_dir.clone(), fast_timings()).await;
    let mut tv = crate::tv(&restarted).await;
    let (_alice, assign) = phone(&restarted, mic_hello(MIC_A, Some(2))).await;
    assert_eq!(assign["reclaimed"], false);
    let roster = recv_type(&mut tv, "roster").await;
    assert_eq!(roster["slots"][1]["latencyMs"], 180);
    assert_eq!(roster["slots"][1]["name"], "Mina");
}

#[tokio::test]
async fn hello_timeout_and_rate_limit_close_the_socket() {
    let server = start(fast_timings()).await;

    let mut silent = phone_socket(&server).await;
    assert_eq!(
        recv(&mut silent).await,
        json!({"type": "error", "code": "no-hello"})
    );
    expect_close(&mut silent, 4408).await;

    let (mut chatty, _) = phone(&server, mic_hello(MIC_A, None)).await;
    for t in 0..80 {
        send(&mut chatty, json!({"type": "ping", "t": t})).await;
    }
    assert_eq!(
        recv_type(&mut chatty, "error").await,
        json!({"type": "error", "code": "rate-limited"})
    );
    expect_close(&mut chatty, 4429).await;
}

#[tokio::test]
async fn oversized_frames_get_too_large() {
    let server = start(fast_timings()).await;
    let (mut alice, _) = phone(&server, mic_hello(MIC_A, None)).await;
    let sdp = "v".repeat(app_core::remote_mic::MAX_FRAME_BYTES + 10);
    send(&mut alice, json!({"type": "offer", "sdp": sdp})).await;
    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "error", "code": "too-large"})
    );
    expect_close(&mut alice, 4413).await;
}

// ── Phone links and rotation ─────────────────────────────────────────────

#[tokio::test]
async fn mic_links_use_the_pinned_https_origin_and_rotation_revokes_them() {
    let _turn = ROTATION.lock().await;
    let server = start(fast_timings()).await;
    let full = server::router(server.state.clone());
    let mut tv = tv(&server).await;
    let (mut alice, _) = phone(&server, mic_hello(MIC_A, Some(1))).await;

    let links = get("/api/firesong/mic-links")
        .header("x-firesong-host-token", HOST_TOKEN)
        .header(header::HOST, "192.0.2.5:64443")
        .body(Body::empty())
        .expect("req");
    let (status, _, body) = http(full.clone(), links).await;
    assert_eq!(status, StatusCode::OK);
    let links: Value = serde_json::from_str(&body).expect("links json");
    let slots = links["slots"].as_array().expect("slots");
    assert_eq!(slots.len(), 4);
    for (index, link) in slots.iter().enumerate() {
        let slot = index + 1;
        assert_eq!(link["slot"], slot);
        assert_eq!(
            link["url"],
            format!("{PHONE_ORIGIN}/m?t={PAIRING_TOKEN}&slot={slot}")
        );
        assert!(link["qrSvg"]
            .as_str()
            .is_some_and(|svg| svg.starts_with("<svg")));
    }
    assert_eq!(slots[3]["color"], "emerald");

    let rotate = Request::builder()
        .method("POST")
        .uri("/api/firesong/rotate-pairing-token")
        .header("x-firesong-host-token", HOST_TOKEN)
        .body(Body::empty())
        .expect("req");
    let (status, _, body) = http(full, rotate).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains(PAIRING_TOKEN));
    let links: Value = serde_json::from_str(&body).expect("links json");
    let url = links["slots"][0]["url"].as_str().expect("url");
    assert!(url.starts_with(&format!("{PHONE_ORIGIN}/m?t=")));

    assert_eq!(
        recv(&mut alice).await,
        json!({"type": "slot-lost", "reason": "kicked"})
    );
    expect_close(&mut alice, 4410).await;
    assert_eq!(recv_type(&mut tv, "slot-lost").await["reason"], "kicked");

    let old = get(&format!("/q?t={PAIRING_TOKEN}"))
        .body(Body::empty())
        .expect("req");
    let phone_router = server::remote_router(server.state.clone());
    assert_eq!(http(phone_router, old).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_phone_hello_on_the_tv_door_cannot_take_the_tv_seat() {
    let server = start(fast_timings()).await;
    let mut tv = tv(&server).await;

    let mut stray = connect(server.full, ("x-firesong-host-token", HOST_TOKEN)).await;
    send(&mut stray, mic_hello("phone-on-the-tv-door", Some(1))).await;
    assert_eq!(recv_type(&mut stray, "error").await["code"], "bad-hello");
    expect_close(&mut stray, 4400).await;

    // The real TV keeps its seat: no tv-replaced, and it still relays.
    expect_quiet(&mut tv).await;
    let (mut phone, _) = phone(&server, mic_hello("phone-on-the-phone-door", Some(2))).await;
    send(
        &mut phone,
        json!({"type": "offer", "sdp": "v=0", "restart": false}),
    )
    .await;
    let offer = recv_type(&mut tv, "offer").await;
    assert_eq!(offer["slot"], 2);
}

/// Rotation writes the process-wide `remote-control.json`; rotation tests take turns.
static ROTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn rotate_request() -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/firesong/rotate-pairing-token")
        .header("x-firesong-host-token", HOST_TOKEN)
        .body(Body::empty())
        .expect("req")
}

fn token_of(link: &str) -> String {
    let (_, query) = link.split_once("?t=").expect("token in link");
    query.split('&').next().expect("token").to_string()
}

#[tokio::test]
async fn a_new_link_wins_over_a_stale_pairing_cookie() {
    let _turn = ROTATION.lock().await;
    let state = new_state(&fresh_dir("auth"), Timings::default());
    let full = server::router(state.clone());
    let phone = server::remote_router(state);

    let (status, _, body) = http(full, rotate_request()).await;
    assert_eq!(status, StatusCode::OK);
    let links: Value = serde_json::from_str(&body).expect("links json");
    let fresh = token_of(links["slots"][0]["url"].as_str().expect("url"));
    assert_ne!(fresh, PAIRING_TOKEN);

    // A phone from an earlier party still holds the old cookie when it scans the new QR.
    let rejoin = get(&format!("/m?t={fresh}&slot=1"))
        .header(
            header::COOKIE,
            format!("nightingale_remote={PAIRING_TOKEN}"),
        )
        .header("x-forwarded-proto", "https")
        .body(Body::empty())
        .expect("req");
    let (status, headers, _) = http(phone.clone(), rejoin).await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers[header::SET_COOKIE].to_str().expect("cookie");
    assert!(
        cookie.starts_with(&format!("nightingale_remote={fresh};")),
        "{cookie}"
    );
    assert!(cookie.contains("; Secure"), "{cookie}");

    // Without a fresh link the old cookie alone opens nothing.
    let stale = get("/q")
        .header(
            header::COOKIE,
            format!("nightingale_remote={PAIRING_TOKEN}"),
        )
        .body(Body::empty())
        .expect("req");
    assert_eq!(http(phone.clone(), stale).await.0, StatusCode::UNAUTHORIZED);
    let stale_link = get(&format!("/q?t={PAIRING_TOKEN}"))
        .header(header::COOKIE, format!("nightingale_remote={fresh}"))
        .body(Body::empty())
        .expect("req");
    let (status, headers, _) = http(phone, stale_link).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.get(header::SET_COOKIE).is_none());
}
