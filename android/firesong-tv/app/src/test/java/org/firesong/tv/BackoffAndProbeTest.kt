package org.firesong.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import javax.net.ssl.SSLHandshakeException

class BackoffAndProbeTest {
    @Test fun backoffDoublesThenCaps() {
        val b = Backoff()
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L), List(7) { b.nextDelayMs() })
        assertEquals(7, b.attempt)
        b.reset()
        assertEquals(1_000L, b.nextDelayMs())
    }

    @Test fun backoffNeverOverflows() {
        val b = Backoff()
        repeat(100) { assertTrue(b.nextDelayMs() in 1_000L..30_000L) }
    }

    @Test fun serverProbeClassification() {
        assertTrue(ServerProbe.classify(200, null))
        assertTrue(ServerProbe.classify(401, null))
        assertTrue(ServerProbe.classify(404, null))
        assertTrue(ServerProbe.classify(500, null))
        assertFalse(ServerProbe.classify(502, null))
        assertFalse(ServerProbe.classify(503, null))
        assertFalse(ServerProbe.classify(504, null))
        assertFalse(ServerProbe.classify(null, ConnectException("refused")))
        assertFalse(ServerProbe.classify(null, SocketTimeoutException("slow")))
        assertTrue(ServerProbe.classify(null, SSLHandshakeException("untrusted")))
        assertFalse(ServerProbe.classify(null, null))
    }
}
