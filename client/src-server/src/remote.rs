use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::Response,
};

use crate::state::AppState;

/// Cookie the phone receives after a valid `?t=` link, so assets, XHR, and the
/// WebSocket handshake are authorised without repeating the token in URLs.
pub(crate) const COOKIE: &str = "nightingale_remote";

/// Commands the phone surface may dispatch. Everything else in `app-api` stays
/// host-only: the desktop adapter mounts this router without `/api/cmd` for any
/// other command, and the self-hosted server rejects them outright here.
pub(crate) const REMOTE_COMMANDS: &[&str] = &[
    "load_playback_queue",
    "add_playback_queue_entry",
    "move_playback_queue_entry",
    "remove_playback_queue_entry",
    "clear_playback_queue",
    "load_songs",
    "load_profiles",
    "load_interface_language",
    "load_remote_microphones",
    "load_playback_status",
    "load_playback_progress",
    "load_playback_options",
    "request_playback_command",
    "request_playback_control",
    "request_queue_playback",
];

/// Branding the browser fetches on its own, often before the pairing cookie
/// exists (tab icon, iOS home-screen icon). They carry no data, so they stay
/// public instead of rendering the phone link iconless.
pub(crate) const PUBLIC_PATHS: &[&str] = &["/favicon.png", "/favicon.ico", "/apple-touch-icon.png"];

pub(crate) async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if PUBLIC_PATHS.contains(&request.uri().path()) {
        return next.run(request).await;
    }

    let token = state.remote_token();
    let matches = |value: &str| !token.is_empty() && constant_time_eq(value, &token);
    // Each credential is checked on its own: a cookie left from before a
    // token rotation must not shadow the fresh link the phone just scanned.
    let by_query = query_token(request.uri().query()).is_some_and(matches);
    let by_header_or_cookie = header_token(request.headers()).is_some_and(matches)
        || cookie_token(request.headers()).is_some_and(matches);

    if !by_query && !by_header_or_cookie {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body("remote link is not valid".into())
            .unwrap_or_default();
    }

    let secure = forwarded_https(request.headers());
    let mut response = next.run(request).await;

    if by_query {
        let suffix = if secure { "; Secure" } else { "" };
        if let Ok(value) = HeaderValue::from_str(&format!(
            "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax{suffix}"
        )) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }

    response
}

fn forwarded_https(headers: &header::HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

fn header_token(headers: &header::HeaderMap) -> Option<&str> {
    headers
        .get("x-nightingale-token")
        .and_then(|value| value.to_str().ok())
}

fn cookie_token(headers: &header::HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())?
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value)
}

fn query_token(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(name, _)| *name == "t")
        .map(|(_, value)| value)
}

pub(crate) fn constant_time_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }

    left.iter()
        .zip(right)
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}
