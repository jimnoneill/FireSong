use diesel::sql_types::{BigInt, Double, Nullable, Text};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub(crate) type NullableText = Nullable<Text>;

diesel::postfix_operator!(NoCase, " COLLATE NOCASE", Text, backend: diesel::sqlite::Sqlite);
diesel::prefix_operator!(CastOpen, "CAST(", Double, backend: diesel::sqlite::Sqlite);
diesel::postfix_operator!(CastInteger, " AS INTEGER)", BigInt, backend: diesel::sqlite::Sqlite);

pub(super) fn normalize_search(input: &str) -> String {
    input
        .nfd()
        .filter(|character| !is_combining_mark(*character))
        .flat_map(char::to_lowercase)
        .collect()
}

diesel::define_sql_function! {
    fn search_normalize(input: Text) -> Text;
}

/// What a library search matches: title, artist, album and path, normalized
/// like the search words and one per line, so a word (no whitespace) never
/// matches across two of them. Stored in `songs.search_text`.
pub(super) fn song_search_text(title: &str, artist: &str, album: &str, path: &str) -> String {
    [title, artist, album, path]
        .map(normalize_search)
        .join("\n")
}

/// What the guests' song books match: title and artist, as in `search_text`.
/// Stored in `songs.search_people`.
pub(super) fn song_people_text(title: &str, artist: &str) -> String {
    [title, artist].map(normalize_search).join("\n")
}

diesel::define_sql_function! {
    fn instr(haystack: Text, needle: Text) -> BigInt;
}

diesel::define_sql_function! {
    #[sql_name = "json_extract"]
    fn json_extract_text(json: Text, path: Text) -> NullableText;
}
