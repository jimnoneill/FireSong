package org.firesong.tv

/** Reconnect delays: 1, 2, 4, 8, 16, then 30 s. */
class Backoff(private val baseMs: Long = 1_000L, private val maxMs: Long = 30_000L) {
    var attempt = 0
        private set

    fun nextDelayMs(): Long {
        val shift = attempt.coerceAtMost(20)
        attempt++
        return (baseMs shl shift).coerceAtMost(maxMs)
    }

    fun reset() {
        attempt = 0
    }
}
