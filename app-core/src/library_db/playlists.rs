//! Read-only playlist storage shared by local and remote media sources.

use std::collections::{HashMap, HashSet};

use diesel::prelude::*;

use crate::error::NightingaleError;

use super::connection::with_conn_mut;
use super::schema::{playlist_songs, playlists, songs};
use super::sql_functions::json_extract_text;

#[derive(Debug, Clone)]
pub(crate) struct PlaylistDefinition {
    pub id: String,
    pub name: String,
    /// Local song paths or remote media item ids, depending on `key_kind`.
    pub song_keys: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum PlaylistSongKeyKind<'a> {
    LocalPath,
    RemoteItemId { origin_kind: &'a str },
}

/// Atomically replace playlist navigation data for the active library source.
/// Entries not present in the scanned song catalogue are ignored.
pub(crate) fn replace_all_playlists(
    definitions: &[PlaylistDefinition],
    key_kind: PlaylistSongKeyKind<'_>,
) -> Result<(), NightingaleError> {
    with_conn_mut(|conn| {
        conn.transaction::<_, NightingaleError, _>(|conn| {
            diesel::delete(playlists::table).execute(conn)?;

            let song_ids = song_ids_by_key(conn, key_kind)?;

            for playlist in definitions {
                if playlist.id.is_empty() || playlist.name.trim().is_empty() {
                    continue;
                }
                diesel::insert_into(playlists::table)
                    .values((
                        playlists::id.eq(&playlist.id),
                        playlists::name.eq(playlist.name.trim()),
                    ))
                    .execute(conn)?;

                let mut seen_song_ids = HashSet::new();
                for (position, key) in playlist.song_keys.iter().enumerate() {
                    let Some(&song_id) = song_ids.get(key) else {
                        continue;
                    };
                    if !seen_song_ids.insert(song_id) {
                        continue;
                    }
                    diesel::insert_into(playlist_songs::table)
                        .values((
                            playlist_songs::playlist_id.eq(&playlist.id),
                            playlist_songs::song_id.eq(song_id),
                            playlist_songs::position.eq(position as i64),
                        ))
                        .execute(conn)?;
                }
            }
            Ok(())
        })
    })
}

/// Every song's playlist key mapped to its row id, read in one pass so matching
/// a playlist entry is a lookup instead of a scan of the songs table. When two
/// rows share a key the lowest id wins.
fn song_ids_by_key(
    conn: &mut SqliteConnection,
    key_kind: PlaylistSongKeyKind<'_>,
) -> Result<HashMap<String, i64>, NightingaleError> {
    let rows: Vec<(String, i64)> = match key_kind {
        PlaylistSongKeyKind::LocalPath => songs::table
            .select((songs::path, songs::id))
            .order(songs::id.asc())
            .load::<(String, i64)>(conn)?,
        PlaylistSongKeyKind::RemoteItemId { origin_kind } => songs::table
            .filter(json_extract_text(songs::payload, "$.origin.kind").eq(origin_kind))
            .select((
                json_extract_text(songs::payload, "$.origin.item_id"),
                songs::id,
            ))
            .order(songs::id.asc())
            .load::<(Option<String>, i64)>(conn)?
            .into_iter()
            .filter_map(|(key, id)| key.map(|key| (key, id)))
            .collect(),
    };
    let mut ids = HashMap::with_capacity(rows.len());
    for (key, id) in rows {
        ids.entry(key).or_insert(id);
    }
    Ok(ids)
}
