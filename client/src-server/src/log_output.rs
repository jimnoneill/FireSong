//! Log output that never blocks the thread that logs. Formatted lines go
//! through a bounded queue to a thread that owns stdout (the journal under
//! systemd), so an async worker cannot wait on a journal that fell behind.
//! When the queue is full, lines are dropped and counted, and the writer logs
//! the count once it catches up.

use std::io::{self, Write as _};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tracing_subscriber::fmt::MakeWriter;

/// Lines waiting for stdout; an analyzer burst (1,700 lines in a second) fits.
const QUEUE_LINES: usize = 16_384;
/// How long exiting waits for queued lines to reach stdout.
const FLUSH_WAIT: Duration = Duration::from_secs(1);
/// How often exiting retries a full queue.
const FLUSH_RETRY: Duration = Duration::from_millis(10);

enum Queued {
    Line(Vec<u8>),
    Flush(SyncSender<()>),
}

/// The subscriber's writer: each event is one `write` of one whole line.
pub(crate) struct LogOutput {
    sender: SyncSender<Queued>,
    dropped: Arc<AtomicU64>,
}

/// Dropping it waits up to [`FLUSH_WAIT`] for queued lines to be written.
pub(crate) struct LogGuard {
    sender: SyncSender<Queued>,
}

/// Starts the `log-writer` thread.
pub(crate) fn start() -> io::Result<(LogOutput, LogGuard)> {
    let (sender, receiver) = mpsc::sync_channel(QUEUE_LINES);
    let dropped = Arc::new(AtomicU64::new(0));
    let counted = dropped.clone();
    std::thread::Builder::new()
        .name("log-writer".into())
        .spawn(move || write_lines(&receiver, &counted))?;
    let output = LogOutput {
        sender: sender.clone(),
        dropped,
    };
    Ok((output, LogGuard { sender }))
}

impl<'a> MakeWriter<'a> for LogOutput {
    type Writer = &'a Self;

    fn make_writer(&'a self) -> Self::Writer {
        self
    }
}

impl io::Write for &LogOutput {
    fn write(&mut self, line: &[u8]) -> io::Result<usize> {
        if self.sender.try_send(Queued::Line(line.to_vec())).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        Ok(line.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for LogGuard {
    fn drop(&mut self) {
        let deadline = Instant::now() + FLUSH_WAIT;
        let (done, flushed) = mpsc::sync_channel(1);
        let mut flush = Queued::Flush(done);
        loop {
            match self.sender.try_send(flush) {
                Ok(()) => {
                    let _ =
                        flushed.recv_timeout(deadline.saturating_duration_since(Instant::now()));
                    return;
                }
                Err(TrySendError::Full(again)) if Instant::now() < deadline => {
                    flush = again;
                    std::thread::sleep(FLUSH_RETRY);
                }
                Err(_) => return,
            }
        }
    }
}

fn write_lines(receiver: &Receiver<Queued>, dropped: &AtomicU64) {
    let mut stdout = io::stdout();
    for queued in receiver {
        match queued {
            Queued::Line(line) => {
                let lost = dropped.swap(0, Ordering::Relaxed);
                if lost > 0 {
                    tracing::warn!(lines = lost, "log output fell behind: lines dropped");
                }
                if let Err(error) = stdout.write_all(&line) {
                    // What tracing-subscriber does when its writer fails.
                    let _ = writeln!(io::stderr(), "cannot write a log line: {error}");
                }
            }
            Queued::Flush(done) => {
                let _ = stdout.flush();
                let _ = done.send(());
            }
        }
    }
}
