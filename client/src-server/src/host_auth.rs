//! FireSong host token: the full listener only answers the TV app and the
//! operator. Phones use the pairing token on the remote listener instead.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::remote::{constant_time_eq, PUBLIC_PATHS};
use crate::state::AppState;

pub(crate) const COOKIE: &str = "firesong_host";
pub(crate) const HEADER: &str = "x-firesong-host-token";
const QUERY: &str = "host";
const TOKEN_BYTES: usize = 16;

/// `<data>/firesong/host-token`.
pub(crate) fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("firesong").join("host-token")
}

/// Reads the host token, creating it (0600, temp file + rename) when missing.
/// A file that is present but malformed is an operator error, not something to
/// overwrite silently.
pub(crate) fn load_or_create(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let token = raw.trim();
            if is_valid_token(token) {
                Ok(token.to_string())
            } else {
                Err(format!(
                    "{} is not 32 lowercase hex characters; delete it to generate a new one",
                    path.display()
                ))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create(path),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

fn create(path: &Path) -> Result<String, String> {
    let token = new_token();
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;

    let temporary = path.with_extension("part");
    let written = open_private(&temporary)
        .and_then(|mut file| file.write_all(format!("{token}\n").as_bytes()))
        .and_then(|()| std::fs::rename(&temporary, path));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("cannot write {}: {error}", path.display()));
    }
    Ok(token)
}

#[cfg(unix)]
fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;

    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::create(path)
}

pub(crate) fn new_token() -> String {
    rand::random::<[u8; TOKEN_BYTES]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn is_valid_token(token: &str) -> bool {
    token.len() == TOKEN_BYTES * 2
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Middleware for every route of the full router. Loopback requests are not
/// exempt: behind Caddy every request comes from loopback.
pub(crate) async fn require_host(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if PUBLIC_PATHS.contains(&request.uri().path()) {
        return next.run(request).await;
    }

    let Some(token) = state.firesong.host_token() else {
        return unauthorized();
    };
    let from_query = query_value(request.uri().query(), QUERY).map(str::to_owned);
    let matches = |value: &str| constant_time_eq(value, &token);
    let by_header_or_cookie = request
        .headers()
        .get(HEADER)
        .and_then(|value| value.to_str().ok())
        .or_else(|| cookie_value(request.headers(), COOKIE))
        .is_some_and(matches);
    let by_query = request.method() == Method::GET && from_query.as_deref().is_some_and(matches);

    if !by_header_or_cookie && !by_query {
        return unauthorized();
    }
    if !by_query {
        return next.run(request).await;
    }

    let cookie = set_cookie(&token, request.headers());
    if accepts_html(request.headers()) {
        // Top-level navigation: drop the token from the address bar and history.
        let location = without_query_param(request.uri(), QUERY);
        let mut response = (StatusCode::SEE_OTHER, [(header::LOCATION, location)]).into_response();
        if let Some(cookie) = cookie {
            response.headers_mut().append(header::SET_COOKIE, cookie);
        }
        return response;
    }

    let mut response = next.run(request).await;
    if let Some(cookie) = cookie {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "host token required").into_response()
}

fn set_cookie(token: &str, headers: &HeaderMap) -> Option<HeaderValue> {
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"));
    let suffix = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict{suffix}"
    ))
    .ok()
}

fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"))
}

pub(crate) fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

fn query_value<'a>(query: Option<&'a str>, name: &str) -> Option<&'a str> {
    query?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

fn without_query_param(uri: &axum::http::Uri, name: &str) -> String {
    let rest: Vec<&str> = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty() && pair.split('=').next() != Some(name))
        .collect();
    if rest.is_empty() {
        uri.path().to_string()
    } else {
        format!("{}?{}", uri.path(), rest.join("&"))
    }
}
