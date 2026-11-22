//! FireSong party channel (PROTOCOL.md §13, PHONE-V2.md) through the real hub:
//! WebSocket phones and a fake TV, a scanned folder library of generated WAV
//! files, and a fake analyzer in place of the GPU.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use app_core::party::{AnalysisPort, AnalysisView, JobState};
use app_core::{AppConfig, CacheDir, LibrarySource, RemoteControl, SongsStore};
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
const MIC_A: &str = "party-a-0000-0000-0000-000000000001";
const MIC_B: &str = "party-b-0000-0000-0000-000000000002";
const MIC_C: &str = "party-c-0000-0000-0000-000000000003";
const WAIT: Duration = Duration::from_secs(4);

/// The test library: title, analysed, detected key.
const SONGS: &[(&str, bool, bool)] = &[
    ("Book Alpha", true, false),
    ("Book Bravo", false, false),
    ("Book Charlie", true, true),
    ("Book Delta", false, false),
    ("Prep Host", true, false),
    ("Prep Late", false, false),
    ("Auth One", true, true),
    ("Auth Two", true, true),
    ("Lobby First", true, false),
    ("Edit Shift", true, true),
    ("Edit Next", true, false),
    ("Edit Other", true, false),
];

/// One data folder and one library per test binary (app-core keeps both
/// process-wide), under the cargo target dir rather than /tmp.
fn data_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("firesong-party-tests-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create test data root");
        app_core::set_default_data_path(root.clone()).expect("set data path once");
        root
    })
}

fn music_dir() -> PathBuf {
    data_root().join("music")
}

/// One second of 8 kHz mono PCM, different per song so the hashes differ.
fn wav(seed: usize) -> Vec<u8> {
    let rate: u32 = 8_000;
    let data: Vec<u8> = (0..rate as usize)
        .flat_map(|n| (((n * (seed + 3)) % 97) as i16).to_le_bytes())
        .collect();
    let mut out = Vec::with_capacity(44 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16_u32.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&1_u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2_u16.to_le_bytes());
    out.extend_from_slice(&16_u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out
}

/// Marks a library song analysed the way provided timed lyrics do.
fn make_ready(hash: &str, with_key: bool) {
    if with_key {
        let transcript = json!({"source": "lrc", "key": "C major", "tempo": 1.0,
                                "no_stems": false, "segments": []});
        std::fs::write(
            CacheDir::new().transcript_path(hash),
            transcript.to_string(),
        )
        .expect("transcript with a key");
    }
    app_core::apply_timed_lyrics(hash, "[00:00.10]la la\n[00:00.60]la").expect("timed lyrics");
}

/// Title -> hash of the scanned test library.
fn library() -> &'static HashMap<&'static str, String> {
    static LIBRARY: OnceLock<HashMap<&'static str, String>> = OnceLock::new();
    LIBRARY.get_or_init(|| {
        data_root();
        let music = music_dir();
        std::fs::create_dir_all(&music).expect("music dir");
        for (index, (title, _, _)) in SONGS.iter().enumerate() {
            std::fs::write(music.join(format!("{title}.wav")), wav(index)).expect("song file");
        }
        app_core::init_library().expect("library database");
        let mut config = AppConfig::load();
        config.library_source = Some(LibrarySource::Folder { path: music });
        config.save();
        app_core::start_scan();

        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        let songs = loop {
            let songs = SongsStore::load_all().processed;
            if songs.len() >= SONGS.len() {
                break songs;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "library scan did not finish"
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        let hashes: HashMap<&'static str, String> = SONGS
            .iter()
            .map(|(title, _, _)| {
                let song = songs
                    .iter()
                    .find(|song| song.title == *title)
                    .expect("scanned song");
                (*title, song.file_hash.clone())
            })
            .collect();
        for (title, ready, with_key) in SONGS {
            if *ready {
                make_ready(&hashes[title], *with_key);
            }
        }
        hashes
    })
}

fn hash(title: &str) -> String {
    library()[title].clone()
}

/// The analyzer, faked: preparation moves when a test says so.
#[derive(Default)]
struct FakeAnalysis {
    state: Mutex<FakeState>,
}

#[derive(Default)]
struct FakeState {
    view: AnalysisView,
    enqueued: Vec<String>,
}

impl FakeAnalysis {
    fn set(&self, file_hash: &str, job: Option<JobState>) {
        let mut state = self.state.lock().expect("fake analysis");
        state.view.waiting.retain(|hash| hash != file_hash);
        match job {
            Some(job) => {
                state.view.jobs.insert(file_hash.to_string(), job);
                state.view.active = Some(file_hash.to_string());
            }
            None => {
                state.view.jobs.remove(file_hash);
                state.view.active = None;
            }
        }
    }

    fn enqueued(&self) -> Vec<String> {
        self.state.lock().expect("fake analysis").enqueued.clone()
    }
}

impl AnalysisPort for FakeAnalysis {
    fn view(&self) -> AnalysisView {
        self.state.lock().expect("fake analysis").view.clone()
    }

    fn enqueue(&self, file_hash: &str) -> Result<(), String> {
        let mut state = self.state.lock().expect("fake analysis");
        state.enqueued.push(file_hash.to_string());
        state
            .view
            .jobs
            .insert(file_hash.to_string(), JobState::Queued);
        state.view.waiting.push(file_hash.to_string());
        Ok(())
    }

    fn cancel(&self, file_hash: &str) {
        self.set(file_hash, None);
    }

    fn rekeyed(&self, _file_hash: &str) -> Option<String> {
        None
    }
}

fn timings() -> Timings {
    Timings {
        hello_timeout: Duration::from_millis(400),
        ping_interval: Duration::from_millis(50),
        idle_timeout: Duration::from_secs(10),
        reservation: Duration::from_secs(600),
        evict_after: Duration::ZERO,
        party_poll: Duration::from_millis(100),
        calibration_timeout: Duration::from_secs(15),
        tv_gone_reset: Duration::from_millis(300),
        party_hold: Duration::from_millis(300),
    }
}

struct Server {
    state: AppState,
    full: SocketAddr,
    phone: SocketAddr,
    analysis: Arc<FakeAnalysis>,
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
    library();
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let data_dir = data_root().join(format!("rtc-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&data_dir).expect("create test dir");
    let events = Arc::new(EventBus::new());
    let state = AppState::new(
        app_api::CommandState::new(events.clone()),
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
            data_dir: Some(data_dir),
            ice_servers: Vec::new(),
            allowed_origins: vec![PHONE_ORIGIN.into()],
            timings,
        },
    );
    let analysis = Arc::new(FakeAnalysis::default());
    state.commands.party().set_analysis(analysis.clone());
    let full = serve(server::router(state.clone())).await;
    let phone = serve(server::remote_router(state.clone())).await;
    Server {
        state,
        full,
        phone,
        analysis,
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
    assert_eq!(recv(&mut socket).await["type"], "party");
    socket
}

async fn phone(server: &Server, mic_id: &str, slot: u8, name: &str) -> Socket {
    let mut socket = connect(server.phone, ("x-nightingale-token", PAIRING_TOKEN)).await;
    send(
        &mut socket,
        json!({"type": "hello", "v": 1, "micId": mic_id, "slot": slot, "name": name}),
    )
    .await;
    let assign = recv(&mut socket).await;
    assert_eq!(assign["type"], "assign", "{assign}");
    assert_eq!(assign["slot"], slot);
    let party = recv(&mut socket).await;
    assert_eq!(
        party["type"], "party",
        "the snapshot follows assign: {party}"
    );
    socket
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

async fn recv_type(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let frame = recv(socket).await;
        if frame["type"] == kind {
            return frame;
        }
    }
}

/// The next `party` snapshot that satisfies `wanted`.
async fn party_until(socket: &mut Socket, wanted: impl Fn(&Value) -> bool) -> Value {
    loop {
        let frame = recv_type(socket, "party").await;
        if wanted(&frame["party"]) {
            return frame["party"].clone();
        }
    }
}

/// Every frame of `kinds` that arrives within `window`.
async fn collect(socket: &mut Socket, kinds: &[&str], window: Duration) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + window;
    let mut found = Vec::new();
    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, socket.next()).await {
        if let Message::Text(text) = message {
            let frame: Value = serde_json::from_str(&text).expect("json frame");
            if kinds.contains(&frame["type"].as_str().unwrap_or_default()) {
                found.push(frame);
            }
        }
    }
    found
}

async fn expect_none(socket: &mut Socket, kinds: &[&str]) {
    let found = collect(socket, kinds, Duration::from_millis(300)).await;
    assert!(found.is_empty(), "unexpected frames {found:?}");
}

async fn ack(socket: &mut Socket, req_id: u32) -> Value {
    let frame = recv_type(socket, "ack").await;
    assert_eq!(frame["reqId"], req_id, "{frame}");
    frame
}

async fn request(socket: &mut Socket, frame: Value) -> Value {
    let req_id = frame["reqId"].as_u64().expect("reqId") as u32;
    send(socket, frame).await;
    ack(socket, req_id).await
}

fn refused(code: &str) -> impl Fn(&Value) {
    let code = code.to_string();
    move |ack: &Value| {
        assert_eq!(ack["ok"], false, "{ack}");
        assert_eq!(ack["code"], code.as_str(), "{ack}");
    }
}

fn accepted(ack: &Value) {
    assert_eq!(ack["ok"], true, "{ack}");
}

async fn http(router: Router, request: Request<Body>) -> (StatusCode, String) {
    let response = router.oneshot(request).await.expect("router response");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .expect("body");
    (status, String::from_utf8_lossy(&body).into_owned())
}

fn cmd_request(name: &str, payload: &Value, auth: (&str, &str)) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/api/cmd/{name}"))
        .header(auth.0, auth.1)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(payload.to_string()))
        .expect("request")
}

/// A command on the TV door.
async fn tv_cmd(server: &Server, name: &str, payload: Value) -> Value {
    let router = server::router(server.state.clone());
    let (status, body) = http(
        router,
        cmd_request(name, &payload, ("x-firesong-host-token", HOST_TOKEN)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{name}: {body}");
    serde_json::from_str(&body).expect("json result")
}

async fn song_book(server: &Server, query: Value) -> (StatusCode, String) {
    let router = server::remote_router(server.state.clone());
    http(
        router,
        cmd_request(
            "firesong_song_book",
            &query,
            ("x-nightingale-token", PAIRING_TOKEN),
        ),
    )
    .await
}

fn titles(items: &Value) -> Vec<String> {
    items
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["title"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn queue_titles(party: &Value) -> Vec<String> {
    titles(&party["queue"])
}

#[tokio::test]
async fn the_song_book_lists_ready_songs_first_and_no_paths() {
    let server = start(timings()).await;
    let (status, body) = song_book(&server, json!({"search": "book", "take": 25})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let page: Value = serde_json::from_str(&body).expect("page");
    assert_eq!(
        titles(&page["items"]),
        ["Book Alpha", "Book Charlie", "Book Bravo", "Book Delta"]
    );
    assert_eq!(
        (
            page["readyTotal"].clone(),
            page["total"].clone(),
            page["skip"].clone()
        ),
        (json!(2), json!(4), json!(0))
    );
    assert_eq!(page["items"][0]["prep"], json!({"state": "ready"}));
    assert_eq!(page["items"][0]["shiftable"], false);
    assert_eq!(page["items"][1]["shiftable"], true);
    assert_eq!(page["items"][1]["fileHash"], hash("Book Charlie"));
    assert_eq!(
        page["items"][2]["prep"],
        json!({"state": "not-ready", "etaSecs": 120})
    );
    let music = music_dir();
    assert!(!body.contains("\"path\""), "{body}");
    assert!(
        !body.contains("album_art") && !body.contains("albumArt"),
        "{body}"
    );
    assert!(
        !body.contains(music.to_str().expect("utf-8 path")),
        "{body}"
    );

    let (_, body) = song_book(&server, json!({"search": "book", "skip": 1, "take": 2})).await;
    let page: Value = serde_json::from_str(&body).expect("page");
    assert_eq!(titles(&page["items"]), ["Book Charlie", "Book Bravo"]);
    assert_eq!(page["skip"], 1);
    let (_, body) = song_book(&server, json!({"search": "book", "skip": 3, "take": 5})).await;
    let page: Value = serde_json::from_str(&body).expect("page");
    assert_eq!(titles(&page["items"]), ["Book Delta"]);

    for query in [
        json!({"take": 51}),
        json!({"take": 0}),
        json!({"take": 5, "search": "x".repeat(101)}),
        json!({"skip": 2}),
    ] {
        assert_eq!(
            song_book(&server, query.clone()).await.0,
            StatusCode::BAD_REQUEST,
            "{query}"
        );
    }
    let result = tv_cmd(
        &server,
        "firesong_song_book",
        json!({"search": "alpha", "take": 1}),
    )
    .await;
    assert_eq!(titles(&result["items"]), ["Book Alpha"]);
}

#[tokio::test]
async fn party_frames_count_only_after_hello() {
    let server = start(timings()).await;
    let mut early = connect(server.phone, ("x-nightingale-token", PAIRING_TOKEN)).await;
    send(&mut early, json!({"type": "fx", "sound": "cheer"})).await;
    assert_eq!(
        recv(&mut early).await,
        json!({"type": "error", "code": "no-hello"})
    );
    loop {
        match tokio::time::timeout(WAIT, early.next())
            .await
            .expect("close in time")
        {
            Some(Ok(Message::Close(Some(CloseFrame { code, .. })))) => {
                assert_eq!(u16::from(code), 4408);
                break;
            }
            Some(Ok(_)) => {}
            other => panic!("expected a close, got {other:?}"),
        }
    }

    // A TV party frame from a phone is a bad frame, and so is a bad value.
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    send(&mut alice, json!({"type": "reset-scores"})).await;
    assert_eq!(recv_type(&mut alice, "error").await["code"], "bad-frame");
    send(&mut alice, json!({"type": "mix", "volumePct": 151})).await;
    assert_eq!(recv_type(&mut alice, "error").await["code"], "bad-frame");
}

#[tokio::test]
async fn a_song_that_is_not_ready_prepares_and_joins_the_queue_at_its_place() {
    let server = start(timings()).await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Jim").await;
    tv_cmd(
        &server,
        "add_playback_queue_entry",
        json!({"fileHash": hash("Prep Host"), "tempo": 1.0, "keyOffset": 0}),
    )
    .await;

    let ack = request(
        &mut alice,
        json!({"type": "reserve", "reqId": 1, "fileHash": hash("Prep Late")}),
    )
    .await;
    accepted(&ack);
    let reservation = ack["reservationId"]
        .as_str()
        .expect("reservation id")
        .to_string();
    assert_eq!(server.analysis.enqueued(), [hash("Prep Late")]);

    let party = party_until(&mut alice, |party| {
        party["queue"][1]["prep"]["state"] == "queued"
    })
    .await;
    assert_eq!(queue_titles(&party), ["Prep Host", "Prep Late"]);
    assert_eq!(party["queue"][0]["singers"], json!([]));
    assert!(party["queue"][0]["entryId"].is_string());
    let late = &party["queue"][1];
    assert_eq!(late["reservationId"], reservation.as_str());
    assert_eq!(late["singers"], json!([1]));
    assert!(late.get("entryId").is_none());
    assert_eq!(late["prep"]["etaSecs"], 120);
    assert_eq!(party["queueTotal"], 2);

    server
        .analysis
        .set(&hash("Prep Late"), Some(JobState::Analyzing(40)));
    let party = party_until(&mut alice, |party| {
        party["queue"][1]["prep"]["state"] == "analyzing"
    })
    .await;
    assert_eq!(
        party["queue"][1]["prep"],
        json!({"state": "analyzing", "pct": 40, "etaSecs": 80})
    );

    make_ready(&hash("Prep Late"), false);
    server.analysis.set(&hash("Prep Late"), None);
    let party = party_until(&mut alice, |party| {
        party["queue"][1]["prep"]["state"] == "ready"
    })
    .await;
    let entry_id = party["queue"][1]["entryId"].clone();
    assert_eq!(party["queue"][1]["reservationId"], reservation.as_str());

    let queue = tv_cmd(&server, "load_playback_queue", Value::Null).await;
    assert_eq!(queue.as_array().map(Vec::len), Some(2));
    assert_eq!(queue[1]["song"]["file_hash"], hash("Prep Late"));
    assert_eq!(queue[1]["id"], entry_id);
    let seen = party_until(&mut tv, |party| party["queue"][1]["entryId"] == entry_id).await;
    assert_eq!(seen["queue"][1]["singers"], json!([1]));
}

#[tokio::test]
async fn only_the_singers_control_their_song() {
    let server = start(timings()).await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    let mut bob = phone(&server, MIC_B, 2, "Bo").await;
    let mut carol = phone(&server, MIC_C, 3, "Cy").await;

    let first = request(
        &mut alice,
        json!({"type": "reserve", "reqId": 1, "fileHash": hash("Auth One"), "partners": [2]}),
    )
    .await;
    accepted(&first);
    assert_eq!(
        recv_type(&mut bob, "notice").await,
        json!({"type": "notice", "code": "duet-added", "title": "Auth One", "bySlot": 1})
    );
    let second = request(
        &mut alice,
        json!({"type": "reserve", "reqId": 2, "fileHash": hash("Auth Two"), "partners": [2]}),
    )
    .await;
    accepted(&second);
    let duet = second["reservationId"].as_str().expect("id").to_string();
    let party = party_until(&mut tv, |party| party["queueTotal"] == 2).await;
    assert_eq!(party["queue"][0]["singers"], json!([1, 2]));
    let playing = party["queue"][0]["entryId"].clone();

    send(
        &mut tv,
        json!({"type": "stage", "state": "singing", "entryId": playing, "singers": [1, 2], "title": "Auth One"}),
    )
    .await;
    let party = party_until(&mut carol, |party| party["stage"]["state"] == "singing").await;
    assert_eq!(party["stage"]["reservationId"], first["reservationId"]);

    // The singers' remote reaches the TV, stamped with the sender.
    for (socket, slot, mic_id) in [(&mut alice, 1, MIC_A), (&mut bob, 2, MIC_B)] {
        accepted(
            &request(
                socket,
                json!({"type": "control", "reqId": 10, "action": "pause"}),
            )
            .await,
        );
        assert_eq!(
            recv_type(&mut tv, "control").await,
            json!({"type": "control", "slot": slot, "micId": mic_id, "action": "pause"})
        );
        accepted(
            &request(
                socket,
                json!({"type": "shift-current", "reqId": 11, "keyOffset": 1, "tempo": 1.0}),
            )
            .await,
        );
        assert_eq!(
            recv_type(&mut tv, "shift-current").await,
            json!({"type": "shift-current", "slot": slot, "micId": mic_id, "keyOffset": 1, "tempo": 1.0})
        );
    }
    // Nobody else's.
    refused("not-allowed")(
        &request(
            &mut carol,
            json!({"type": "control", "reqId": 12, "action": "pause"}),
        )
        .await,
    );
    refused("not-allowed")(
        &request(
            &mut carol,
            json!({"type": "shift-current", "reqId": 13, "keyOffset": 0, "tempo": 1.1}),
        )
        .await,
    );

    // The queued duet: the owner edits and cancels, the partner only leaves.
    refused("not-allowed")(
        &request(
            &mut bob,
            json!({"type": "edit", "reqId": 14, "reservationId": duet, "singNext": true}),
        )
        .await,
    );
    refused("not-allowed")(
        &request(
            &mut carol,
            json!({"type": "edit", "reqId": 15, "reservationId": duet, "keyOffset": 1}),
        )
        .await,
    );
    accepted(
        &request(
            &mut alice,
            json!({"type": "edit", "reqId": 16, "reservationId": duet, "keyOffset": -1}),
        )
        .await,
    );
    refused("not-allowed")(
        &request(
            &mut carol,
            json!({"type": "cancel", "reqId": 17, "reservationId": duet}),
        )
        .await,
    );
    accepted(
        &request(
            &mut bob,
            json!({"type": "cancel", "reqId": 18, "reservationId": duet}),
        )
        .await,
    );
    party_until(&mut tv, |party| {
        party["queue"].as_array().is_some_and(|queue| {
            queue
                .iter()
                .any(|item| item["reservationId"] == duet.as_str() && item["singers"] == json!([1]))
        })
    })
    .await;
    accepted(
        &request(
            &mut alice,
            json!({"type": "cancel", "reqId": 19, "reservationId": duet}),
        )
        .await,
    );

    // In the lobby, "start now" belongs to the first ready item's singers.
    tv_cmd(
        &server,
        "remove_playback_queue_entry",
        json!({"id": playing}),
    )
    .await;
    accepted(
        &request(
            &mut carol,
            json!({"type": "reserve", "reqId": 20, "fileHash": hash("Lobby First")}),
        )
        .await,
    );
    send(
        &mut tv,
        json!({"type": "stage", "state": "lobby", "singers": [], "countdownSecs": 15}),
    )
    .await;
    party_until(&mut bob, |party| {
        party["stage"]["state"] == "lobby" && queue_titles(party) == ["Lobby First"]
    })
    .await;
    refused("not-allowed")(
        &request(
            &mut bob,
            json!({"type": "control", "reqId": 21, "action": "start-now"}),
        )
        .await,
    );
    refused("busy")(
        &request(
            &mut bob,
            json!({"type": "control", "reqId": 22, "action": "pause"}),
        )
        .await,
    );
    accepted(
        &request(
            &mut carol,
            json!({"type": "control", "reqId": 23, "action": "start-now"}),
        )
        .await,
    );
    assert_eq!(
        recv_type(&mut tv, "control").await,
        json!({"type": "control", "slot": 3, "micId": MIC_C, "action": "start-now"})
    );
    expect_none(&mut tv, &["control", "shift-current"]).await;
}

#[tokio::test]
async fn shifts_and_requests_keep_to_their_budgets() {
    let server = start(timings()).await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    send(
        &mut tv,
        json!({"type": "stage", "state": "singing", "singers": [1]}),
    )
    .await;
    party_until(&mut alice, |party| party["stage"]["state"] == "singing").await;

    let shift = |req_id: u32| json!({"type": "shift-current", "reqId": req_id, "keyOffset": 2, "tempo": 1.0});
    accepted(&request(&mut alice, shift(1)).await);
    refused("rate-limited")(&request(&mut alice, shift(2)).await);
    assert_eq!(
        collect(&mut tv, &["shift-current"], Duration::from_millis(300))
            .await
            .len(),
        1
    );

    // Party requests: a burst of 6 (two used above), then one per 3 s.
    for req_id in 3..=6 {
        refused("not-found")(
            &request(
                &mut alice,
                json!({"type": "cancel", "reqId": req_id, "reservationId": "r999"}),
            )
            .await,
        );
    }
    refused("rate-limited")(
        &request(
            &mut alice,
            json!({"type": "cancel", "reqId": 7, "reservationId": "r999"}),
        )
        .await,
    );
}

#[tokio::test]
async fn edits_change_the_queue_entry_and_one_sing_next_per_phone() {
    let server = start(timings()).await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    let mut bob = phone(&server, MIC_B, 2, "Bo").await;

    let duet = request(
        &mut alice,
        json!({"type": "reserve", "reqId": 1, "fileHash": hash("Edit Shift"), "partners": [2]}),
    )
    .await;
    accepted(&duet);
    let duet = duet["reservationId"].as_str().expect("id").to_string();
    accepted(
        &request(&mut alice, json!({"type": "edit", "reqId": 2, "reservationId": duet, "keyOffset": -2, "tempo": 0.9})).await,
    );
    let queue = tv_cmd(&server, "load_playback_queue", Value::Null).await;
    assert_eq!(queue[0]["song"]["file_hash"], hash("Edit Shift"));
    assert_eq!(
        (queue[0]["keyOffset"].clone(), queue[0]["tempo"].clone()),
        (json!(-2), json!(0.9))
    );

    // Not shiftable: no detected key.
    refused("unavailable")(
        &request(
            &mut alice,
            json!({"type": "reserve", "reqId": 3, "fileHash": hash("Edit Other"), "tempo": 1.2}),
        )
        .await,
    );
    accepted(
        &request(
            &mut alice,
            json!({"type": "reserve", "reqId": 4, "fileHash": hash("Edit Next"), "singNext": true}),
        )
        .await,
    );
    refused("limit-sing-next")(
        &request(&mut alice, json!({"type": "reserve", "reqId": 5, "fileHash": hash("Edit Other"), "singNext": true})).await,
    );
    let queue = tv_cmd(&server, "load_playback_queue", Value::Null).await;
    let order: Vec<Value> = queue
        .as_array()
        .expect("queue")
        .iter()
        .map(|entry| entry["song"]["file_hash"].clone())
        .collect();
    assert_eq!(order, [json!(hash("Edit Next")), json!(hash("Edit Shift"))]);

    // A partner who leaves keeps the song for the owner; an owner who leaves
    // hands the duet to the partner and drops the solo songs.
    refused("invalid")(
        &request(
            &mut alice,
            json!({"type": "reserve", "reqId": 6, "fileHash": hash("Edit Other"), "partners": [1]}),
        )
        .await,
    );
    send(&mut alice, json!({"type": "bye"})).await;
    let party = party_until(&mut tv, |party| party["queueTotal"] == 1).await;
    assert_eq!(queue_titles(&party), ["Edit Shift"]);
    assert_eq!(party["queue"][0]["singers"], json!([2]));
    assert_eq!(party["singers"].as_array().map(Vec::len), Some(1));
    accepted(
        &request(
            &mut bob,
            json!({"type": "cancel", "reqId": 7, "reservationId": duet}),
        )
        .await,
    );
    party_until(&mut tv, |party| party["queueTotal"] == 0).await;
    assert_eq!(
        tv_cmd(&server, "load_playback_queue", Value::Null).await,
        json!([])
    );
}

#[tokio::test]
async fn fun_sounds_keep_to_their_budget() {
    let server = start(timings()).await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    for _ in 0..5 {
        send(&mut alice, json!({"type": "fx", "sound": "applause"})).await;
    }
    let played = collect(&mut tv, &["fx"], Duration::from_millis(500)).await;
    assert_eq!(played.len(), 3);
    assert_eq!(
        played[0],
        json!({"type": "fx", "slot": 1, "sound": "applause"})
    );
    tokio::time::sleep(Duration::from_millis(1_700)).await;
    send(&mut alice, json!({"type": "fx", "sound": "air-horn"})).await;
    send(&mut alice, json!({"type": "fx", "sound": "air-horn"})).await;
    let played = collect(&mut tv, &["fx"], Duration::from_millis(400)).await;
    assert_eq!(
        played,
        [json!({"type": "fx", "slot": 1, "sound": "air-horn"})]
    );
}

#[tokio::test]
async fn calibration_runs_one_at_a_time_in_the_lobby() {
    let server = start(Timings {
        calibration_timeout: Duration::from_millis(500),
        ..timings()
    })
    .await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    let mut bob = phone(&server, MIC_B, 2, "Bo").await;
    let mut carol = phone(&server, MIC_C, 3, "Cy").await;

    accepted(&request(&mut alice, json!({"type": "calibrate", "reqId": 1})).await);
    assert_eq!(
        recv_type(&mut tv, "calibrate").await,
        json!({"type": "calibrate", "slot": 1, "micId": MIC_A})
    );
    refused("busy")(&request(&mut bob, json!({"type": "calibrate", "reqId": 2})).await);
    assert_eq!(
        recv_type(&mut bob, "calibration").await,
        json!({"type": "calibration", "state": "failed", "reason": "busy"})
    );

    send(
        &mut tv,
        json!({"type": "calibration", "slot": 1, "state": "started"}),
    )
    .await;
    assert_eq!(
        recv_type(&mut alice, "calibration").await,
        json!({"type": "calibration", "state": "started"})
    );
    send(
        &mut tv,
        json!({"type": "latency", "slot": 1, "latencyMs": 212, "method": "beep"}),
    )
    .await;
    send(
        &mut tv,
        json!({"type": "calibration", "slot": 1, "state": "done", "latencyMs": 212}),
    )
    .await;
    assert_eq!(
        recv_type(&mut alice, "calibration").await,
        json!({"type": "calibration", "state": "done", "latencyMs": 212})
    );
    refused("rate-limited")(&request(&mut alice, json!({"type": "calibrate", "reqId": 3})).await);

    // A TV that never answers: the server gives up after the timeout.
    accepted(&request(&mut bob, json!({"type": "calibrate", "reqId": 4})).await);
    assert_eq!(recv_type(&mut tv, "calibrate").await["slot"], 2);
    assert_eq!(
        recv_type(&mut bob, "calibration").await,
        json!({"type": "calibration", "state": "failed", "reason": "timeout"})
    );

    send(
        &mut tv,
        json!({"type": "stage", "state": "singing", "singers": [1]}),
    )
    .await;
    party_until(&mut carol, |party| party["stage"]["state"] == "singing").await;
    refused("busy")(&request(&mut carol, json!({"type": "calibrate", "reqId": 5})).await);
    expect_none(&mut tv, &["calibrate"]).await;
}

#[tokio::test]
async fn results_make_tonights_board_and_each_phone_hears_its_rank() {
    let server = start(timings()).await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Jim").await;
    let mut bob = phone(&server, MIC_B, 2, "Bo").await;

    send(
        &mut tv,
        json!({"type": "song-result", "title": "Duet", "results": [
            {"slot": 2, "displayScore": 80, "rawScore": 500, "tier": "great", "rank": 2},
            {"slot": 1, "displayScore": 100, "rawScore": 995, "tier": "perfect", "rank": 1},
            {"slot": 4, "displayScore": 99, "rawScore": 990, "tier": "excellent", "rank": 3}
        ]}),
    )
    .await;
    assert_eq!(
        recv_type(&mut alice, "song-result").await["displayScore"],
        100
    );
    assert_eq!(
        recv_type(&mut alice, "night-rank").await,
        json!({"type": "night-rank", "rank": 1, "entries": 2})
    );
    assert_eq!(
        recv_type(&mut bob, "night-rank").await,
        json!({"type": "night-rank", "rank": 2, "entries": 2})
    );
    let party = party_until(&mut tv, |party| {
        party["scores"]
            .as_array()
            .is_some_and(|scores| scores.len() == 2)
    })
    .await;
    let scores = &party["scores"];
    assert_eq!(scores[0]["name"], "Jim");
    assert_eq!(scores[0]["color"], "rose");
    assert_eq!(scores[0]["title"], "Duet");
    assert_eq!(
        (scores[0]["displayScore"].clone(), scores[0]["tier"].clone()),
        (json!(100), json!("perfect"))
    );
    assert_eq!(scores[1]["name"], "Bo");
    assert!(scores[1]["atSecs"]
        .as_u64()
        .is_some_and(|at| at > 1_700_000_000));

    send(&mut tv, json!({"type": "reset-scores"})).await;
    party_until(&mut alice, |party| party["scores"] == json!([])).await;

    send(
        &mut tv,
        json!({"type": "song-result", "results": [
            {"slot": 1, "displayScore": 70, "rawScore": 400, "tier": "good"}
        ]}),
    )
    .await;
    assert_eq!(
        recv_type(&mut alice, "night-rank").await,
        json!({"type": "night-rank", "rank": 1, "entries": 1})
    );
    let rotate = Request::builder()
        .method("POST")
        .uri("/api/firesong/rotate-pairing-token")
        .header("x-firesong-host-token", HOST_TOKEN)
        .body(Body::empty())
        .expect("request");
    assert_eq!(
        http(server::router(server.state.clone()), rotate).await.0,
        StatusCode::OK
    );
    party_until(&mut tv, |party| {
        party["scores"] == json!([]) && party["singers"] == json!([])
    })
    .await;
}

#[tokio::test]
async fn lyric_lines_reach_only_the_singers() {
    let server = start(timings()).await;
    let mut tv = tv(&server).await;
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    let mut bob = phone(&server, MIC_B, 2, "Bo").await;

    send(
        &mut tv,
        json!({"type": "stage", "state": "singing", "singers": [1]}),
    )
    .await;
    let lyric = json!({"type": "lyric", "line": "Woo hoo", "next": "When I feel heavy metal", "lineMs": 2000, "elapsedMs": 0, "paused": false});
    send(&mut tv, lyric.clone()).await;
    assert_eq!(recv_type(&mut alice, "lyric").await, lyric);
    expect_none(&mut bob, &["lyric"]).await;

    send(
        &mut tv,
        json!({"type": "stage", "state": "lobby", "singers": []}),
    )
    .await;
    send(&mut tv, json!({"type": "lyric", "paused": false})).await;
    expect_none(&mut alice, &["lyric"]).await;
    expect_none(&mut bob, &["lyric"]).await;

    // `notify` goes to its slot only; an empty slot is unknown.
    send(
        &mut tv,
        json!({"type": "notify", "slot": 2, "code": "start-failed", "title": "Song 2"}),
    )
    .await;
    assert_eq!(
        recv_type(&mut bob, "notice").await,
        json!({"type": "notice", "code": "start-failed", "title": "Song 2"})
    );
    expect_none(&mut alice, &["notice"]).await;
    send(
        &mut tv,
        json!({"type": "notify", "slot": 4, "code": "passed-over"}),
    )
    .await;
    assert_eq!(recv_type(&mut tv, "error").await["code"], "unknown-slot");
}

#[tokio::test]
async fn the_mixer_is_per_slot_and_resets_when_the_phone_leaves() {
    let server = start(timings()).await;
    let mut alice = phone(&server, MIC_A, 1, "Al").await;
    send(&mut alice, json!({"type": "mix", "volumePct": 120})).await;
    let party = party_until(&mut alice, |party| party["singers"][0]["volumePct"] == 120).await;
    assert_eq!(party["tvConnected"], false);

    // A TV that connects later gets every occupied slot's mix after `ready`.
    let mut tv = connect(server.full, ("x-firesong-host-token", HOST_TOKEN)).await;
    send(&mut tv, json!({"type": "hello", "v": 1})).await;
    assert_eq!(recv(&mut tv).await["type"], "ready");
    assert_eq!(recv(&mut tv).await["type"], "roster");
    assert_eq!(recv(&mut tv).await["party"]["singers"][0]["volumePct"], 120);
    assert_eq!(
        recv(&mut tv).await,
        json!({"type": "mix", "slot": 1, "volumePct": 120, "echoPct": 100})
    );
    party_until(&mut alice, |party| party["tvConnected"] == true).await;

    // Relayed at most five per second; the newest values win.
    for echo in 1..=12 {
        send(&mut alice, json!({"type": "mix", "echoPct": echo * 10})).await;
    }
    let mixes = collect(&mut tv, &["mix"], Duration::from_millis(1_500)).await;
    assert!(mixes.len() <= 7, "{mixes:?}");
    assert_eq!(
        mixes.last().map(|mix| mix["echoPct"].clone()),
        Some(json!(120))
    );

    // Snapshots are coalesced to one per 500 ms per socket.
    let snapshots = collect(&mut alice, &["party"], Duration::from_millis(1_200)).await;
    assert!(snapshots.len() <= 4, "{snapshots:?}");

    send(&mut alice, json!({"type": "bye"})).await;
    assert_eq!(
        recv_type(&mut tv, "mix").await,
        json!({"type": "mix", "slot": 1, "volumePct": 100, "echoPct": 100})
    );
}

#[tokio::test]
async fn playback_is_marked_stopped_when_the_tv_leaves_for_good() {
    let server = start(timings()).await;
    let playing = json!({"active": true, "paused": false, "finished": false, "hasNext": false, "sessionPlayback": false});

    // A short absence (a network blip) keeps the published state.
    let tv_socket = tv(&server).await;
    tv_cmd(&server, "set_playback_status", playing.clone()).await;
    drop(tv_socket);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let back = tv(&server).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        tv_cmd(&server, "load_playback_status", Value::Null).await["active"],
        true
    );
    drop(back);

    // Gone for longer than the reset delay: nothing will say "stopped", so the server does.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let status = tv_cmd(&server, "load_playback_status", Value::Null).await;
    assert_eq!(status["active"], false, "{status}");
    assert_eq!(
        tv_cmd(&server, "load_playback_progress", Value::Null).await["playing"],
        false
    );
}
