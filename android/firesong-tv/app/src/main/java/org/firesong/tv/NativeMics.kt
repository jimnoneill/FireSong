package org.firesong.tv

import java.nio.ByteBuffer

/** The native voice engine in libfiresongvoice.so (cpp/engine.c). Slots are 1..4. */
object NativeMics {
    const val ABI = 1
    const val RATE = 48000
    const val STATUS_LEN = 8
    const val STATS_LEN = 40
    const val TAP_MESSAGE_MAX = 65536
    const val MONITOR = 1
    const val MUTED = 2
    const val VOLUME = 3
    const val ECHO_AMOUNT = 4
    const val TAP = 5

    val available: Boolean = try {
        System.loadLibrary("firesongvoice")
        abi() == ABI
    } catch (_: UnsatisfiedLinkError) {
        false
    }

    @JvmStatic external fun abi(): Int

    /** Opens a session: returns a token > 0 (AAudio open attempted; retried in C while it fails), or <= 0 on a library error. */
    @JvmStatic external fun start(): Int

    /** Ends the session `token`; does nothing when `token` is not the current one. */
    @JvmStatic external fun stop(token: Int)

    @JvmStatic external fun attach(slot: Int, gen: Int)

    @JvmStatic external fun detach(slot: Int, gen: Int)

    @JvmStatic external fun release(slot: Int)

    /** Called from the WebRTC worker thread inside AudioTrackSink.onData. Returns tap blocks ready (>= 0) or a negative fsv_result. */
    @JvmStatic external fun push(slot: Int, gen: Int, pcm: ByteBuffer, frames: Int, rate: Int, channels: Int): Int

    @JvmStatic external fun set(slot: Int, control: Int, value: Float): Boolean

    @JvmStatic external fun setEchoMix(wet: Float, feedback: Float, lowpassHz: Float, reverbSend: Float): Boolean

    /**
     * Writes one complete tap message (§3.1.5) into a direct buffer of TAP_MESSAGE_MAX bytes; returns its length,
     * 0 when none. The tap queue has a single consumer: calls never overlap, process-wide.
     */
    @JvmStatic external fun drainTap(out: ByteBuffer): Int

    /** out[0..7]: levelRms, gateOpen, feedbackHz (0 = none), boostDb, fillMs, outRms, attached, duckedMs. */
    @JvmStatic external fun slotStatus(slot: Int, out: FloatArray)

    /**
     * out[0..18]: open, outputLatencyUs (-1 unknown), burstFrames, bufferFrames, xruns, restarts,
     * callbackP99Us, callbackMaxUs, pushIntervalP50Us, pushIntervalP99Us, pushIntervalMaxUs,
     * pushToPresentP50Us, pushToPresentP95Us, tapDropped, peakQ15 (reset on read), callbacks,
     * tapDrainP99Us, tapDrainMaxUs, openAttempts; 19-23 reserved; then per slot at 24 + 4 * (slot - 1):
     * underruns, trimmedFrames, marginFrames, pushedFrames.
     */
    @JvmStatic external fun engineStats(out: LongArray)

    /**
     * Starts the monitor beep for a slot; returns a token > 0, or minus a [MonitorFailReason.code]: BUSY (a
     * measurement is running), NO_AUDIO (slot out of range or not attached), STOPPED (no session, or no output).
     */
    @JvmStatic external fun measureMonitor(slot: Int): Int

    /** out[0] state (0 pending, 1 done, 2 failed), out[1] ms, out[2] reason ([MonitorFailReason.code]). */
    @JvmStatic external fun monitorResult(token: Int, out: FloatArray)
}
