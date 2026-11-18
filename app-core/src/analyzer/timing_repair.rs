//! FireSong lyric-timing repair (PHONE-V2.md, feature 9). Forced alignment
//! sometimes squeezes most lyric lines into a fraction of a second (Blur,
//! "Song 2": 31 of 35 lines), and sometimes drifts: lines land many seconds
//! from where they are sung, mostly after a break or towards the end (50 Cent,
//! "21 Questions": the last lines 30 s early). After a full analysis whose
//! lyrics came from LRCLIB, such a transcript is rebuilt from LRCLIB's
//! line-synced lyrics of the same pick, when those pass sanity checks: the
//! analysis runs again with each LRCLIB line as a window its words are aligned
//! inside (falling back to evenly spread words if that pass fails), and the
//! repair is recorded in the transcript as `timing_repair`.

use serde_json::{Value, json};
use tracing::{info, warn};

use crate::cache::CacheDir;
use crate::library_db;
use crate::lrc::{self, ParsedLrc};
use crate::lyrics::{
    LineWindow, build_lrc_transcript, load_lyrics_file, lrclib_candidates, write_timed_lyrics_file,
    write_transcript_json,
};

/// A line shorter than this is squeezed.
const SQUEEZED_LINE_SECS: f64 = 0.5;
/// Fewer lines than this are never judged, and synced lyrics need as many.
const MIN_LINES: usize = 6;
/// Squeezed lines, in percent of all lines, that make the alignment squeezed.
const SQUEEZED_PERCENT: usize = 40;
/// A line this far from LRCLIB's start for it has drifted.
const DRIFTED_LINE_SECS: f64 = 3.0;
/// Drifted lines, in percent of the lines compared, that make the alignment drifted.
const DRIFTED_PERCENT: usize = 10;
/// A line this near LRCLIB's start for it agrees with it.
const CLOSE_LINE_SECS: f64 = 1.5;
/// Agreeing lines, in percent of the lines compared, that show LRCLIB's lyrics
/// are timed to this recording and not to another edit of the song.
const CLOSE_PERCENT: usize = 25;
/// How many words either side of its expected place a line's first word is looked for.
const ANCHOR_WINDOW_WORDS: usize = 6;
/// Synced lyrics may have this share more or fewer lines than the plain ones.
const LINE_COUNT_TOLERANCE: f64 = 0.25;
/// The last synced line must start before the song's end plus this.
const END_SLACK_SECS: f64 = 5.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Squeeze {
    squeezed: usize,
    lines: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Drift {
    drifted: usize,
    lines: usize,
}

/// Why an alignment gives way to LRCLIB's line timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    Squeezed(Squeeze),
    Drifted(Drift),
}

impl Fault {
    fn describe(self) -> String {
        match self {
            Self::Squeezed(Squeeze { squeezed, lines }) => {
                format!("{squeezed} of {lines} lyric lines are squeezed")
            }
            Self::Drifted(Drift { drifted, lines }) => {
                format!("{drifted} of {lines} lyric lines are over {DRIFTED_LINE_SECS} s off")
            }
        }
    }
}

/// A drifted or squeezed alignment gets a second, windowed pass: each line of
/// LRCLIB's line-synced lyrics becomes a window, and the aligner only places
/// that line's words inside it, so lines start where they are sung and words
/// keep the singer's pacing. `fallback`, the same lines with their words
/// spread evenly, is used only when that pass fails.
pub(super) struct WindowedRetry {
    /// The first pass's language, so the second pass skips detecting it.
    pub(super) language: Option<String>,
    fault: Fault,
    fallback: Value,
}

/// Runs when a full analysis whose lyrics came from LRCLIB (not a realign, not
/// lyrics the user edited) has finished, before the song is marked analysed.
/// When the alignment needs repair, writes LRCLIB's lines with their windows as
/// the song's lyrics, removes the transcript and returns the retry; the caller
/// runs the analysis again. `None` keeps the transcript as it is.
pub(super) fn windowed_retry(file_hash: &str, cache: &CacheDir) -> Option<WindowedRetry> {
    let (transcript, parsed, fault) = diagnose(file_hash, cache)?;
    let fallback = rebuilt(&transcript, &parsed, fault);
    let language = transcript
        .get("language")
        .and_then(Value::as_str)
        .map(str::to_string);
    let retry = WindowedRetry {
        language,
        fault,
        fallback,
    };
    let lines = parsed
        .segments
        .iter()
        .map(|line| line.text.clone())
        .collect();
    let windows = parsed
        .segments
        .iter()
        .map(|line| LineWindow {
            start: line.start,
            end: line.end,
        })
        .collect();
    if let Err(error) = write_timed_lyrics_file(cache, file_hash, lines, windows) {
        warn!("[analyzer] {file_hash}: could not write LRCLIB's line windows: {error}");
        windowed_failed(file_hash, cache, retry);
        return None;
    }
    let _ = std::fs::remove_file(cache.transcript_path(file_hash));
    cache.delete_transcript_variants(file_hash);
    info!(
        "[analyzer] {file_hash}: {}; aligning again inside LRCLIB's {} line windows",
        retry.fault.describe(),
        parsed.segments.len()
    );
    Some(retry)
}

/// The windowed pass finished: records the repair in its transcript.
pub(super) fn windowed_done(file_hash: &str, cache: &CacheDir, retry: &WindowedRetry) {
    let Some(mut transcript) = read_transcript(cache, file_hash) else {
        return;
    };
    transcript["timing_repair"] = repair_record("lrclib-windows", retry.fault);
    match write_transcript_json(cache, file_hash, &transcript) {
        Ok(()) => info!("[analyzer] {file_hash}: words aligned inside LRCLIB's line timing"),
        Err(error) => warn!("[analyzer] {file_hash}: could not record the repair: {error}"),
    }
}

/// The windowed pass failed: LRCLIB's line timing with evenly spread words.
pub(super) fn windowed_failed(file_hash: &str, cache: &CacheDir, retry: WindowedRetry) {
    cache.delete_transcript_variants(file_hash);
    match write_transcript_json(cache, file_hash, &retry.fallback) {
        Ok(()) => info!(
            "[analyzer] {file_hash}: {}; using LRCLIB line timing with evenly spread words",
            retry.fault.describe()
        ),
        Err(error) => {
            warn!("[analyzer] {file_hash}: could not write the repaired transcript: {error}")
        }
    }
}

fn read_transcript(cache: &CacheDir, file_hash: &str) -> Option<Value> {
    std::fs::read_to_string(cache.transcript_path(file_hash))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
}

/// The transcript, LRCLIB's checked line timing for it and what is wrong with
/// the alignment; `None` when nothing is wrong or nothing can be checked.
fn diagnose(file_hash: &str, cache: &CacheDir) -> Option<(Value, ParsedLrc, Fault)> {
    let transcript = read_transcript(cache, file_hash)?;
    let squeeze = squeezed(&transcript);
    let song = library_db::load_song_by_hash(file_hash).ok().flatten()?;
    let plain = load_lyrics_file(file_hash).map(|lyrics| lyrics.lines)?;
    let pick = lrclib_candidates(&song).into_iter().next();
    let Some(synced) = pick
        .filter(|pick| pick.lines == plain)
        .and_then(|pick| pick.synced_lyrics)
    else {
        if let Some(squeeze) = squeeze {
            warn!(
                "[analyzer] {file_hash}: {}; LRCLIB has no synced lyrics for the same pick, keeping the alignment",
                Fault::Squeezed(squeeze).describe()
            );
        }
        return None;
    };
    let parsed = match checked_lrc(&synced, plain.len(), song.duration_secs) {
        Ok(parsed) => parsed,
        Err(reason) => {
            if let Some(squeeze) = squeeze {
                warn!(
                    "[analyzer] {file_hash}: {}; LRCLIB's synced lyrics {reason}, keeping the alignment",
                    Fault::Squeezed(squeeze).describe()
                );
            }
            return None;
        }
    };
    let fault = squeeze
        .map(Fault::Squeezed)
        .or_else(|| drifted(&transcript, &parsed).map(Fault::Drifted))?;
    Some((transcript, parsed, fault))
}

/// `Some` when at least [`MIN_LINES`] lines and [`SQUEEZED_PERCENT`] of them
/// last under [`SQUEEZED_LINE_SECS`].
fn squeezed(transcript: &Value) -> Option<Squeeze> {
    let segments = transcript.get("segments")?.as_array()?;
    let lines = segments.len();
    let squeezed = segments
        .iter()
        .filter(|segment| {
            let time = |key: &str| segment.get(key).and_then(Value::as_f64);
            matches!((time("start"), time("end")), (Some(start), Some(end)) if end - start < SQUEEZED_LINE_SECS)
        })
        .count();
    (lines >= MIN_LINES && squeezed * 100 >= lines * SQUEEZED_PERCENT)
        .then_some(Squeeze { squeezed, lines })
}

/// A word as the two timings share it: lowercase letters and digits only.
fn plain_word(word: &str) -> String {
    word.chars()
        .filter(|char| char.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// `Some` when at least [`DRIFTED_PERCENT`] of the synced lines start more
/// than [`DRIFTED_LINE_SECS`] from where the alignment put them, while at
/// least [`CLOSE_PERCENT`] start within [`CLOSE_LINE_SECS`]: the two timings
/// follow the same recording and part of the alignment has slipped. Lyrics
/// timed to another edit are off everywhere and are left alone. A line is
/// found in the alignment by its first word, near the place its share of the
/// words predicts; lines whose first word is not there are not compared, and
/// fewer than [`MIN_LINES`] compared lines are never judged.
fn drifted(transcript: &Value, parsed: &ParsedLrc) -> Option<Drift> {
    let aligned: Vec<(f64, String)> = transcript
        .get("segments")?
        .as_array()?
        .iter()
        .filter_map(|segment| segment.get("words")?.as_array())
        .flatten()
        .filter_map(|word| {
            let text = plain_word(word.get("word")?.as_str()?);
            (!text.is_empty()).then_some((word.get("start")?.as_f64()?, text))
        })
        .collect();
    let synced: Vec<(f64, Vec<String>)> = parsed
        .segments
        .iter()
        .map(|line| {
            let words = line.text.split_whitespace().map(plain_word);
            (line.start, words.filter(|word| !word.is_empty()).collect())
        })
        .collect();
    let total: usize = synced.iter().map(|(_, words)| words.len()).sum();
    if aligned.is_empty() || total == 0 {
        return None;
    }

    let (mut before, mut lines, mut drifted, mut close) = (0, 0, 0, 0);
    for (start, words) in &synced {
        let expected = before * aligned.len() / total;
        before += words.len();
        let Some(first) = words.first() else {
            continue;
        };
        let from = expected.saturating_sub(ANCHOR_WINDOW_WORDS);
        let to = (expected + ANCHOR_WINDOW_WORDS + 1).min(aligned.len());
        let anchor = (from..to)
            .filter(|index| &aligned[*index].1 == first)
            .min_by_key(|index| index.abs_diff(expected));
        if let Some(anchor) = anchor {
            let gap = (aligned[anchor].0 - start).abs();
            lines += 1;
            if gap > DRIFTED_LINE_SECS {
                drifted += 1;
            } else if gap <= CLOSE_LINE_SECS {
                close += 1;
            }
        }
    }
    (lines >= MIN_LINES
        && drifted * 100 >= lines * DRIFTED_PERCENT
        && close * 100 >= lines * CLOSE_PERCENT)
        .then_some(Drift { drifted, lines })
}

/// LRCLIB's synced lyrics, if they are usable: at least [`MIN_LINES`] lines
/// with strictly increasing starts from 0 on, the last before the song's end
/// (plus [`END_SLACK_SECS`]), and about as many lines as the plain lyrics.
fn checked_lrc(
    synced: &str,
    plain_lines: usize,
    duration_secs: f64,
) -> Result<ParsedLrc, &'static str> {
    // In written order: the full parse sorts its lines.
    let starts: Vec<f64> = synced
        .lines()
        .filter_map(|line| lrc::parse_lrc(line).ok())
        .flat_map(|parsed| parsed.segments.into_iter().map(|segment| segment.start))
        .collect();
    if starts.len() < MIN_LINES {
        return Err("have too few lines");
    }
    if starts.windows(2).any(|pair| pair[1] <= pair[0]) {
        return Err("are not in order");
    }
    let parsed = lrc::parse_lrc(synced).map_err(|_| "cannot be parsed")?;
    let (Some(first), Some(last)) = (parsed.segments.first(), parsed.segments.last()) else {
        return Err("have too few lines");
    };
    if first.start < 0.0 || last.start >= duration_secs + END_SLACK_SECS {
        return Err("run past the song");
    }
    let count = parsed.segments.len() as f64;
    let plain = plain_lines as f64;
    if (count - plain).abs() > plain * LINE_COUNT_TOLERANCE {
        return Err("have a different number of lines");
    }
    Ok(parsed)
}

/// The LRC transcript, as `apply_timed_lyrics` builds it at the base key and
/// tempo, plus the repair record.
fn rebuilt(transcript: &Value, parsed: &ParsedLrc, fault: Fault) -> Value {
    let text = |key: &str| transcript.get(key).and_then(Value::as_str);
    let no_stems = transcript
        .get("no_stems")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut value = build_lrc_transcript(parsed, text("language"), text("key"), 1.0, no_stems);
    value["timing_repair"] = repair_record("lrclib-lines", fault);
    value
}

/// `timing_repair` in a transcript: how its timing was repaired and why.
fn repair_record(method: &str, fault: Fault) -> Value {
    match fault {
        Fault::Squeezed(Squeeze { squeezed, lines }) => json!({
            "method": method,
            "reason": "squeezed-alignment",
            "squeezed": squeezed,
            "lines": lines,
        }),
        Fault::Drifted(Drift { drifted, lines }) => json!({
            "method": method,
            "reason": "drifted-alignment",
            "drifted": drifted,
            "lines": lines,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript(lines: &[(f64, f64)]) -> Value {
        let segments: Vec<Value> = lines
            .iter()
            .enumerate()
            .map(|(index, (start, end))| {
                json!({"text": format!("line {index}"), "start": start, "end": end,
                       "words": [{"word": "x", "start": start, "end": end}]})
            })
            .collect();
        json!({"language": "en", "source": "lyrics", "key": "A major", "tempo": 1.0,
               "no_stems": false, "segments": segments})
    }

    /// 35 lines, 31 of them squeezed into 0.2 s, like the bad "Song 2".
    fn squeezed_song() -> Value {
        let lines: Vec<(f64, f64)> = (0..35)
            .map(|index| {
                let start = 10.0 + f64::from(index) * 4.0;
                if index < 31 {
                    (start, start + 0.2)
                } else {
                    (start, start + 3.0)
                }
            })
            .collect();
        transcript(&lines)
    }

    fn lrc(lines: usize, first: f64) -> String {
        (0..lines)
            .map(|index| {
                let secs = first + index as f64 * 5.0;
                format!(
                    "[{:02}:{:05.2}]line {index}",
                    (secs / 60.0) as u32,
                    secs % 60.0
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn a_squeezed_alignment_takes_lrclib_line_timing() {
        let transcript = squeezed_song();
        let squeeze = squeezed(&transcript).expect("squeezed");
        assert_eq!(
            squeeze,
            Squeeze {
                squeezed: 31,
                lines: 35
            }
        );

        let parsed = checked_lrc(&lrc(35, 14.5), 35, 200.0).expect("usable LRC");
        let repaired = rebuilt(&transcript, &parsed, Fault::Squeezed(squeeze));
        assert_eq!(repaired["source"], "lrc");
        assert_eq!(repaired["key"], "A major");
        assert_eq!(repaired["language"], "en");
        assert_eq!(repaired["tempo"], 1.0);
        assert_eq!(
            repaired["timing_repair"],
            json!({"method": "lrclib-lines", "reason": "squeezed-alignment", "squeezed": 31, "lines": 35})
        );
        let starts: Vec<f64> = repaired["segments"]
            .as_array()
            .expect("segments")
            .iter()
            .filter_map(|segment| segment["start"].as_f64())
            .collect();
        let expected: Vec<f64> = (0..35).map(|index| 14.5 + f64::from(index) * 5.0).collect();
        assert_eq!(starts.len(), expected.len());
        assert!(
            starts
                .iter()
                .zip(&expected)
                .all(|(got, want)| (got - want).abs() < 0.01)
        );
    }

    /// 20 lines of three words; the alignment sings line `n` at `at(n)`.
    fn three_word_lines(at: impl Fn(u32) -> f64) -> Value {
        let segments: Vec<Value> = (0..20)
            .map(|index| {
                let start = at(index);
                let words: Vec<Value> = ["one", "two", "three"]
                    .iter()
                    .enumerate()
                    .map(|(n, word)| {
                        let from = start + n as f64;
                        json!({"word": format!("{word}{index},"), "start": from, "end": from + 0.8})
                    })
                    .collect();
                json!({"text": format!("One{index} two{index} three{index}"),
                       "start": start, "end": start + 3.0, "words": words})
            })
            .collect();
        json!({"language": "en", "source": "lyrics", "key": "A major", "tempo": 1.0,
               "no_stems": false, "segments": segments})
    }

    fn three_word_lrc() -> ParsedLrc {
        let text = (0..20)
            .map(|index| {
                let secs = 10.0 + f64::from(index) * 5.0;
                format!(
                    "[{:02}:{:05.2}]One{index} two{index} three{index}",
                    (secs / 60.0) as u32,
                    secs % 60.0
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        checked_lrc(&text, 20, 200.0).expect("usable LRC")
    }

    #[test]
    fn a_drifted_alignment_takes_lrclib_line_timing() {
        let parsed = three_word_lrc();
        let on_time = three_word_lines(|index| 10.3 + f64::from(index) * 5.0);
        assert_eq!(drifted(&on_time, &parsed), None);
        // One late line of 20 is under 10 %.
        let one_late = three_word_lines(|index| {
            10.0 + f64::from(index) * 5.0 + if index == 19 { 4.0 } else { 0.0 }
        });
        assert_eq!(drifted(&one_late, &parsed), None);
        // Every line 13 s late: lyrics timed to another edit of the song.
        let other_edit = three_word_lines(|index| 23.0 + f64::from(index) * 5.0);
        assert_eq!(drifted(&other_edit, &parsed), None);
        // The last five lines run early, more and more, like "21 Questions".
        let early_end = three_word_lines(|index| {
            10.0 + f64::from(index) * 5.0 - f64::from(index.saturating_sub(14)) * 4.0
        });
        let drift = drifted(&early_end, &parsed).expect("drifted");
        assert_eq!(
            drift,
            Drift {
                drifted: 5,
                lines: 20
            }
        );

        let repaired = rebuilt(&early_end, &parsed, Fault::Drifted(drift));
        assert_eq!(repaired["source"], "lrc");
        assert_eq!(
            repaired["timing_repair"],
            json!({"method": "lrclib-lines", "reason": "drifted-alignment", "drifted": 5, "lines": 20})
        );
        assert_eq!(repaired["segments"][19]["start"], 105.0);
    }

    #[test]
    fn healthy_or_short_transcripts_are_left_alone() {
        let healthy: Vec<(f64, f64)> = (0..20)
            .map(|index| (f64::from(index) * 4.0, f64::from(index) * 4.0 + 3.0))
            .collect();
        assert_eq!(squeezed(&transcript(&healthy)), None);
        // 7 of 20 squeezed is under 40 %.
        let mut some: Vec<(f64, f64)> = healthy.clone();
        for line in some.iter_mut().take(7) {
            line.1 = line.0 + 0.3;
        }
        assert_eq!(squeezed(&transcript(&some)), None);
        // 8 of 20 is 40 %.
        some[7].1 = some[7].0 + 0.3;
        assert_eq!(
            squeezed(&transcript(&some)),
            Some(Squeeze {
                squeezed: 8,
                lines: 20
            })
        );
        let short = [(0.0, 0.1); 5];
        assert_eq!(squeezed(&transcript(&short)), None);
    }

    #[test]
    fn bad_synced_lyrics_are_refused() {
        assert_eq!(
            checked_lrc(&lrc(5, 10.0), 5, 200.0).err(),
            Some("have too few lines")
        );
        let shuffled =
            "[00:10.00]a\n[00:20.00]b\n[00:15.00]c\n[00:30.00]d\n[00:40.00]e\n[00:50.00]f";
        assert_eq!(
            checked_lrc(shuffled, 6, 200.0).err(),
            Some("are not in order")
        );
        let repeated =
            "[00:10.00]a\n[00:10.00]b\n[00:15.00]c\n[00:30.00]d\n[00:40.00]e\n[00:50.00]f";
        assert_eq!(
            checked_lrc(repeated, 6, 200.0).err(),
            Some("are not in order")
        );
        assert_eq!(
            checked_lrc(&lrc(35, 14.5), 50, 200.0).err(),
            Some("have a different number of lines")
        );
        assert_eq!(
            checked_lrc(&lrc(35, 14.5), 35, 150.0).err(),
            Some("run past the song")
        );
        assert!(checked_lrc(&lrc(35, 14.5), 30, 200.0).is_ok());
    }
}
