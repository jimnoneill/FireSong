package org.firesong.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.webrtc.PeerConnection.PeerConnectionState

class RestartRuleTest {
    @Test fun failedAsksOnce() {
        val rule = RestartRule()
        assertTrue(rule.onState(PeerConnectionState.FAILED, 0))
        assertFalse(rule.onState(PeerConnectionState.FAILED, 100))
        assertFalse(rule.onState(PeerConnectionState.DISCONNECTED, 200))
        assertFalse(rule.onTimer(PeerConnectionState.DISCONNECTED, 3200))
    }

    @Test fun disconnectedForThreeSecondsAsks() {
        val rule = RestartRule()
        assertFalse(rule.onState(PeerConnectionState.DISCONNECTED, 1000))
        assertEquals(4000L, rule.dueAtMs())
        assertFalse(rule.onState(PeerConnectionState.DISCONNECTED, 2000))
        assertEquals(4000L, rule.dueAtMs())
        assertFalse(rule.onTimer(PeerConnectionState.DISCONNECTED, 3999))
        assertTrue(rule.onTimer(PeerConnectionState.DISCONNECTED, 4000))
        assertNull(rule.dueAtMs())
        assertFalse(rule.onState(PeerConnectionState.FAILED, 5000))
    }

    @Test fun aConnectionThatRecoversWithinTheGraceDoesNotAsk() {
        val rule = RestartRule()
        rule.onState(PeerConnectionState.DISCONNECTED, 0)
        assertFalse(rule.onState(PeerConnectionState.CONNECTED, 1500))
        assertNull(rule.dueAtMs())
        assertFalse(rule.onTimer(PeerConnectionState.CONNECTED, 3000))
    }

    @Test fun connectedResets() {
        val rule = RestartRule()
        assertTrue(rule.onState(PeerConnectionState.FAILED, 0))
        assertFalse(rule.onState(PeerConnectionState.CONNECTED, 1000))
        assertTrue(rule.onState(PeerConnectionState.FAILED, 2000))
    }

    @Test fun aNewOfferResets() {
        val rule = RestartRule()
        assertTrue(rule.onState(PeerConnectionState.FAILED, 0))
        rule.onOffer()
        assertTrue(rule.onState(PeerConnectionState.FAILED, 1000))
        rule.onOffer()
        rule.onState(PeerConnectionState.DISCONNECTED, 2000)
        assertTrue(rule.onTimer(PeerConnectionState.DISCONNECTED, 5000))
    }
}
