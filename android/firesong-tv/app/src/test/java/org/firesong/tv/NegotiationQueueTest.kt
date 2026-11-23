package org.firesong.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NegotiationQueueTest {
    private val sent = mutableListOf<AppMessage>()
    private val begun = mutableListOf<Pair<Int, String>>()
    private val queue = NegotiationQueue(PEER, { seq, sdp -> begun += seq to sdp }, { sent += it })

    @Test fun anAnswerIsSentForTheOnlyOffer() {
        queue.offer(1, "offer 1")
        assertEquals(listOf(1 to "offer 1"), begun)
        assertTrue(queue.isRunning(1))
        queue.answered(1, "answer 1")
        assertEquals(listOf(AppMessage.Answer(PEER, 1, "answer 1")), sent)
        assertFalse(queue.isRunning(1))
    }

    @Test fun anOfferDuringTheGatherSupersedesTheRunningAnswer() {
        queue.offer(1, "offer 1")
        queue.offer(2, "offer 2")
        assertEquals("offer 2 waits for offer 1", listOf(1 to "offer 1"), begun)
        queue.answered(1, "answer 1")
        assertEquals(listOf(superseded(1)), sent)
        assertEquals(listOf(1 to "offer 1", 2 to "offer 2"), begun)
        queue.answered(2, "answer 2")
        assertEquals(listOf(superseded(1), AppMessage.Answer(PEER, 2, "answer 2")), sent)
    }

    @Test fun ofSeveralWaitingOffersOnlyTheNewestRuns() {
        queue.offer(1, "offer 1")
        queue.offer(2, "offer 2")
        queue.offer(3, "offer 3")
        assertEquals(listOf(superseded(2)), sent)
        queue.answered(1, "answer 1")
        queue.answered(3, "answer 3")
        assertEquals(listOf(1 to "offer 1", 3 to "offer 3"), begun)
        assertEquals(listOf(superseded(2), superseded(1), AppMessage.Answer(PEER, 3, "answer 3")), sent)
    }

    @Test fun aFailureIsReportedWithItsSeq() {
        queue.offer(4, "offer 4")
        queue.failed(4, PeerErrorCode.SDP, "setRemoteDescription failed")
        assertEquals(listOf(AppMessage.PeerError(PEER, 4, PeerErrorCode.SDP, "setRemoteDescription failed")), sent)
    }

    @Test fun aLateResultOfAnOldOfferIsDropped() {
        queue.offer(1, "offer 1")
        queue.offer(2, "offer 2")
        queue.answered(1, "answer 1")
        queue.failed(1, PeerErrorCode.TIMEOUT, "late")
        queue.answered(1, "answer 1 again")
        assertEquals(listOf(superseded(1)), sent)
        assertTrue(queue.isRunning(2))
    }

    @Test fun thePendingSeqIsTheNewestOfferOwedAReply() {
        assertNull(queue.pendingSeq())
        queue.offer(1, "offer 1")
        assertEquals(1, queue.pendingSeq())
        queue.offer(2, "offer 2")
        assertEquals(2, queue.pendingSeq())
        queue.answered(1, "answer 1")
        queue.answered(2, "answer 2")
        assertNull(queue.pendingSeq())
        queue.offer(3, "offer 3")
        queue.close()
        assertNull(queue.pendingSeq())
    }

    @Test fun closeDuringAPendingAnswerSendsNothing() {
        queue.offer(1, "offer 1")
        queue.offer(2, "offer 2")
        queue.close()
        queue.answered(1, "answer 1")
        queue.failed(1, PeerErrorCode.TIMEOUT, "no answer within 5 s")
        queue.offer(3, "offer 3")
        assertEquals(emptyList<AppMessage>(), sent)
        assertEquals(listOf(1 to "offer 1"), begun)
        assertFalse(queue.isRunning(1))
    }

    @Test fun anOfferWhoseSeqDoesNotIncreaseIsRefused() {
        queue.offer(5, "offer 5")
        queue.offer(5, "offer 5 again")
        assertEquals(
            listOf(AppMessage.PeerError(PEER, 5, PeerErrorCode.INTERNAL, "offer seq not increasing")),
            sent,
        )
        assertEquals(listOf(5 to "offer 5"), begun)
    }

    private fun superseded(seq: Int) = AppMessage.PeerError(PEER, seq, PeerErrorCode.SUPERSEDED, "a newer offer")

    private companion object {
        const val PEER = 7
    }
}
