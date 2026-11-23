package org.firesong.tv

import java.nio.ByteBuffer

/** The voice output in `voice_out.c`: AAudio low latency, 48 kHz stereo s16. */
object NativeVoice {
    const val RATE = 48000
    const val CHANNELS = 2

    val available: Boolean = try {
        System.loadLibrary("firesongvoice")
        true
    } catch (_: UnsatisfiedLinkError) {
        false
    }

    @JvmStatic external fun start(): Boolean

    @JvmStatic external fun stop()

    /** Interleaved s16le frames from a direct buffer; returns the frames taken. */
    @JvmStatic external fun write(buffer: ByteBuffer, bytes: Int): Int

    /** See `Java_org_firesong_tv_NativeVoice_stats` for the 14 values. */
    @JvmStatic external fun stats(out: LongArray)
}
