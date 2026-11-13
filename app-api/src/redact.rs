//! Keeps library credentials out of command results (FireSong WP2).
//!
//! The web client never needs a Plex/Jellyfin token or a Navidrome password in
//! plaintext: it only hands them back to `set_library_source` or `save_config`.
//! So every command result has those fields replaced by [`REDACTED_SECRET`],
//! and the two commands that write a source turn the marker back into the real
//! secret on the way in:
//!
//! - `save_config` keeps the stored secret when the incoming source is the
//!   stored one (same kind and identity). A marker for any other source keeps
//!   the stored source unchanged, because the client cannot have meant to
//!   switch servers through the settings form.
//! - `set_library_source` resolves the marker from the credentials a login
//!   command (`plex_poll_pin`, `plex_manual_login`, `jellyfin_login`,
//!   `navidrome_login`) returned moments before, kept in [`SecretStash`] on the
//!   command state, or from the stored source with the same identity.
//!
//! The field stays in the JSON (with the marker as its value) because the
//! client's schemas require it.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use app_core::{
    AppConfig, JellyfinLoginResult, LibrarySource, NavidromeLoginResult, PlexPinPollResult,
    PlexServer,
};
use serde_json::Value;

use crate::CommandError;

/// Stands in for a secret in every command result. Sending it back means
/// "keep the secret the server already has".
pub const REDACTED_SECRET: &str = "__redacted__";

/// JSON keys whose string values are credentials, wherever they appear.
const SECRET_KEYS: &[&str] = &["access_token", "password"];

/// Login results waiting for `set_library_source`. A sign-in flow takes
/// seconds; half an hour covers a user who wanders off mid-dialog.
const STASH_TTL: Duration = Duration::from_secs(30 * 60);
const STASH_CAPACITY: usize = 32;

struct Pending {
    identity: Identity,
    secret: String,
    at: Instant,
}

/// Login secrets waiting for `set_library_source`, owned by `CommandState`.
#[derive(Default)]
pub(crate) struct SecretStash {
    pending: Mutex<Vec<Pending>>,
}

/// The non-secret fields that name one credential: same server, same user,
/// same client registration.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Identity {
    Jellyfin {
        base_url: String,
        user_id: String,
        device_id: String,
    },
    Navidrome {
        base_url: String,
        username: String,
    },
    Plex {
        base_url: String,
        machine_id: String,
        client_id: String,
    },
}

fn identity(source: &LibrarySource) -> Option<Identity> {
    match source {
        LibrarySource::Folder { .. } => None,
        LibrarySource::Jellyfin {
            base_url,
            user_id,
            device_id,
            ..
        } => Some(Identity::Jellyfin {
            base_url: base_url.clone(),
            user_id: user_id.clone(),
            device_id: device_id.clone(),
        }),
        LibrarySource::Navidrome {
            base_url, username, ..
        } => Some(Identity::Navidrome {
            base_url: base_url.clone(),
            username: username.clone(),
        }),
        LibrarySource::Plex {
            base_url,
            machine_id,
            client_id,
            ..
        } => Some(Identity::Plex {
            base_url: base_url.clone(),
            machine_id: machine_id.clone(),
            client_id: client_id.clone(),
        }),
    }
}

fn secret(source: &LibrarySource) -> Option<&str> {
    match source {
        LibrarySource::Folder { .. } => None,
        LibrarySource::Jellyfin { access_token, .. } | LibrarySource::Plex { access_token, .. } => {
            Some(access_token)
        }
        LibrarySource::Navidrome { password, .. } => Some(password),
    }
}

fn secret_mut(source: &mut LibrarySource) -> Option<&mut String> {
    match source {
        LibrarySource::Folder { .. } => None,
        LibrarySource::Jellyfin { access_token, .. } | LibrarySource::Plex { access_token, .. } => {
            Some(access_token)
        }
        LibrarySource::Navidrome { password, .. } => Some(password),
    }
}

fn is_marker(source: &LibrarySource) -> bool {
    secret(source) == Some(REDACTED_SECRET)
}

/// Replaces the library secret in `config` with [`REDACTED_SECRET`]. An empty
/// secret stays empty, so the client can still tell "no credential" apart.
pub fn redact_config(mut config: AppConfig) -> AppConfig {
    if let Some(secret) = config.library_source.as_mut().and_then(secret_mut)
        && !secret.is_empty()
    {
        *secret = REDACTED_SECRET.to_string();
    }
    config
}

/// Replaces every non-empty string under a credential key, at any depth.
fn redact_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                match child {
                    Value::String(secret)
                        if SECRET_KEYS.contains(&key.as_str()) && !secret.is_empty() =>
                    {
                        *secret = REDACTED_SECRET.to_string();
                    }
                    _ => redact_value(child),
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_value),
        _ => {}
    }
}

/// Runs on every command result before it leaves `dispatch`.
pub(crate) fn redact_outbound(stash: &SecretStash, name: &str, mut result: Value) -> Value {
    stash.keep_login_result(name, &result);
    redact_value(&mut result);
    result
}

/// Runs on every command payload before `dispatch` handles it.
pub(crate) fn restore_inbound(
    stash: &SecretStash,
    name: &str,
    mut payload: Value,
) -> Result<Value, CommandError> {
    match name {
        "save_config" => {
            let Some(slot) = payload
                .get_mut("config")
                .and_then(|config| config.get_mut("library_source"))
            else {
                return Ok(payload);
            };
            let Some(incoming) = parse_source(slot) else {
                return Ok(payload);
            };
            if !is_marker(&incoming) {
                return Ok(payload);
            }
            let stored = AppConfig::load().library_source;
            let restored = match stored {
                Some(stored) if identity(&stored) == identity(&incoming) => {
                    with_secret_of(incoming, &stored)
                }
                // Not the stored source: keep whatever is stored.
                other => other,
            };
            *slot = serde_json::to_value(restored)
                .map_err(|error| CommandError::internal(format!("serialise: {error}")))?;
            Ok(payload)
        }
        "set_library_source" => {
            let Some(slot) = payload.get_mut("source") else {
                return Ok(payload);
            };
            let Some(incoming) = parse_source(slot) else {
                return Ok(payload);
            };
            if !is_marker(&incoming) {
                return Ok(payload);
            }
            let Some(key) = identity(&incoming) else {
                return Ok(payload);
            };
            let secret = stash.take(&key).or_else(|| {
                AppConfig::load()
                    .library_source
                    .filter(|stored| identity(stored).as_ref() == Some(&key))
                    .and_then(|stored| secret(&stored).map(str::to_owned))
            });
            let Some(secret) = secret else {
                return Err(CommandError::bad_request(
                    "the sign-in for this server has expired; sign in again",
                ));
            };
            let mut restored = incoming;
            if let Some(field) = secret_mut(&mut restored) {
                *field = secret;
            }
            *slot = serde_json::to_value(restored)
                .map_err(|error| CommandError::internal(format!("serialise: {error}")))?;
            Ok(payload)
        }
        _ => Ok(payload),
    }
}

fn parse_source(value: &Value) -> Option<LibrarySource> {
    serde_json::from_value::<LibrarySource>(value.clone()).ok()
}

fn with_secret_of(mut incoming: LibrarySource, stored: &LibrarySource) -> Option<LibrarySource> {
    let secret = secret(stored).unwrap_or_default().to_string();
    if let Some(field) = secret_mut(&mut incoming) {
        *field = secret;
    }
    Some(incoming)
}

impl SecretStash {
    fn keep_login_result(&self, name: &str, result: &Value) {
        let entries: Vec<(Identity, String)> = match name {
            "plex_poll_pin" => serde_json::from_value::<PlexPinPollResult>(result.clone())
                .map(|poll| poll.servers.iter().map(plex_entry).collect())
                .unwrap_or_default(),
            "plex_manual_login" => serde_json::from_value::<PlexServer>(result.clone())
                .map(|server| vec![plex_entry(&server)])
                .unwrap_or_default(),
            "jellyfin_login" => serde_json::from_value::<JellyfinLoginResult>(result.clone())
                .map(|login| {
                    vec![(
                        Identity::Jellyfin {
                            base_url: login.server_url,
                            user_id: login.user_id,
                            device_id: login.device_id,
                        },
                        login.access_token,
                    )]
                })
                .unwrap_or_default(),
            "navidrome_login" => serde_json::from_value::<NavidromeLoginResult>(result.clone())
                .map(|login| {
                    vec![(
                        Identity::Navidrome {
                            base_url: login.server_url,
                            username: login.username,
                        },
                        login.password,
                    )]
                })
                .unwrap_or_default(),
            _ => return,
        };
        entries
            .into_iter()
            .filter(|(_, secret)| !secret.is_empty() && secret != REDACTED_SECRET)
            .for_each(|(identity, secret)| self.keep(identity, secret));
    }

    fn keep(&self, identity: Identity, secret: String) {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        pending
            .retain(|entry| now.duration_since(entry.at) < STASH_TTL && entry.identity != identity);
        if pending.len() >= STASH_CAPACITY {
            pending.remove(0);
        }
        pending.push(Pending {
            identity,
            secret,
            at: now,
        });
    }

    fn take(&self, identity: &Identity) -> Option<String> {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        pending.retain(|entry| now.duration_since(entry.at) < STASH_TTL);
        let index = pending
            .iter()
            .position(|entry| &entry.identity == identity)?;
        Some(pending.remove(index).secret)
    }
}

fn plex_entry(server: &PlexServer) -> (Identity, String) {
    (
        Identity::Plex {
            base_url: server.server_url.clone(),
            machine_id: server.server_id.clone(),
            client_id: server.client_id.clone(),
        },
        server.access_token.clone(),
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const TOKEN: &str = "plex-account-token";

    fn server(server_id: &str, token: &str) -> Value {
        json!({
            "server_url": "http://plex.invalid:32400",
            "server_name": "Plex",
            "server_id": server_id,
            "username": "owner",
            "access_token": token,
            "client_id": "client-1",
            "sections": [],
            "owned": true,
        })
    }

    #[test]
    fn plex_login_results_are_redacted_and_restored_for_set_library_source() {
        let stash = SecretStash::default();
        let poll = json!({
            "authorized": true,
            "servers": [server("machine-1", TOKEN), server("machine-2", "other-token")],
        });

        let shown = redact_outbound(&stash, "plex_poll_pin", poll);
        assert!(!shown.to_string().contains(TOKEN));
        assert_eq!(shown["servers"][0]["access_token"], REDACTED_SECRET);

        let chosen = &shown["servers"][0];
        let payload = json!({"source": {
            "kind": "plex",
            "base_url": chosen["server_url"],
            "server_name": chosen["server_name"],
            "machine_id": chosen["server_id"],
            "username": chosen["username"],
            "access_token": chosen["access_token"],
            "client_id": chosen["client_id"],
            "section_ids": ["3"],
        }});
        let restored = restore_inbound(&stash, "set_library_source", payload.clone())
            .unwrap_or_else(|error| panic!("restore failed: {error}"));
        assert_eq!(restored["source"]["access_token"], TOKEN);

        // Each stashed secret is handed out once.
        assert_eq!(
            stash.take(&Identity::Plex {
                base_url: "http://plex.invalid:32400".into(),
                machine_id: "machine-1".into(),
                client_id: "client-1".into(),
            }),
            None
        );
    }

    #[test]
    fn manual_and_other_logins_are_redacted_too() {
        let stash = SecretStash::default();
        let manual = redact_outbound(&stash, "plex_manual_login", server("machine-9", TOKEN));
        assert_eq!(manual["access_token"], REDACTED_SECRET);

        let navidrome = redact_outbound(
            &stash,
            "navidrome_login",
            json!({"server_url": "http://nd.invalid", "server_name": null,
                   "server_version": null, "username": "me", "password": "hunter2"}),
        );
        assert_eq!(navidrome["password"], REDACTED_SECRET);
        let payload = json!({"source": {"kind": "navidrome", "base_url": "http://nd.invalid",
                                        "username": "me", "password": REDACTED_SECRET}});
        let restored = restore_inbound(&stash, "set_library_source", payload)
            .unwrap_or_else(|error| panic!("restore failed: {error}"));
        assert_eq!(restored["source"]["password"], "hunter2");
    }

    #[test]
    fn redaction_reaches_nested_values_and_keeps_empty_secrets() {
        let mut value = json!({
            "library_source": {"kind": "jellyfin", "access_token": "abc"},
            "list": [{"password": "p"}, {"password": ""}],
            "other": "access_token",
        });
        redact_value(&mut value);
        assert_eq!(value["library_source"]["access_token"], REDACTED_SECRET);
        assert_eq!(value["list"][0]["password"], REDACTED_SECRET);
        assert_eq!(value["list"][1]["password"], "");
        assert_eq!(value["other"], "access_token");
    }

    #[test]
    fn other_payloads_pass_through_untouched() {
        let stash = SecretStash::default();
        let payload = json!({"source": {"kind": "folder", "path": "/music"}});
        let restored = restore_inbound(&stash, "set_library_source", payload.clone())
            .unwrap_or_else(|error| panic!("restore failed: {error}"));
        assert_eq!(restored, payload);
        let restored = restore_inbound(&stash, "load_songs", json!({"x": REDACTED_SECRET}))
            .unwrap_or_else(|error| panic!("restore failed: {error}"));
        assert_eq!(restored, json!({"x": REDACTED_SECRET}));
    }
}
