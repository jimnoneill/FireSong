//! Work that can wait on the disk (files, the library database, the analyzer
//! queue, the `/rtc` hub that reaches them) runs on Tokio's blocking pool. One
//! async worker stuck in such a call can stop every socket and timer of the
//! runtime, so handlers hand that work over and await it.

/// Runs `work` on the blocking pool and waits for it. A panic in `work`
/// continues in the caller, as if `work` had run inline.
pub(crate) async fn run<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        Err(error) => match error.try_into_panic() {
            Ok(panic) => std::panic::resume_unwind(panic),
            // Cancelled: the runtime is shutting down and drops the caller too.
            Err(_) => std::future::pending().await,
        },
    }
}

/// Starts `work` on the blocking pool without waiting for it; without a
/// runtime (the desktop app, plain unit tests) it runs inline.
pub(crate) fn detach(work: impl FnOnce() + Send + 'static) {
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => {
            runtime.spawn_blocking(work);
        }
        Err(_) => work(),
    }
}
