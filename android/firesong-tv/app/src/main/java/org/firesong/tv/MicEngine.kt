package org.firesong.tv

import android.content.Context

/** One per process: the fs-mics FIFO executor and the PeerConnectionFactory (created on first hello, never disposed). */
object MicEngine {
    /** A handler for one door connection. Its messages and its teardown run on fs-mics in arrival order. */
    fun session(context: Context, channel: PageChannel): PageHandler = object : PageHandler {
        override fun onMessage(message: PageMessage) = Unit

        override fun onIgnored() = Unit

        override fun onClosed() = Unit
    }
}
