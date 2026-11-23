package org.firesong.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SdpFilterTest {
    @Test fun aChromeOfferPassesWithOnlyOpus() {
        val sdp = accepted(CHROME_OFFER.crlf())
        val lines = sdp.removeSuffix("\r\n").split("\r\n")
        assertTrue(sdp.endsWith("\r\n"))
        assertEquals("m=audio 35839 UDP/TLS/RTP/SAVPF 111", lines.single { it.startsWith("m=") })
        assertEquals(listOf("a=rtpmap:111 opus/48000/2"), lines.filter { it.startsWith("a=rtpmap:") })
        assertEquals(listOf("a=fmtp:111 minptime=10;useinbandfec=1"), lines.filter { it.startsWith("a=fmtp:") })
        assertEquals(listOf("a=rtcp-fb:111 transport-cc"), lines.filter { it.startsWith("a=rtcp-fb:") })
        assertEquals(2, lines.count { it.startsWith("a=candidate:") })
        assertEquals(CHROME_OFFER.filterNot { it in CHROME_DROPPED || it.startsWith("m=") }, lines.filterNot { it.startsWith("m=") })
    }

    @Test fun aSafariOfferPassesWithOnlyOpus() {
        val lines = accepted(SAFARI_OFFER.crlf()).removeSuffix("\r\n").split("\r\n")
        assertEquals("m=audio 56143 UDP/TLS/RTP/SAVPF 111", lines.single { it.startsWith("m=") })
        assertEquals(listOf("a=rtpmap:111 opus/48000/2"), lines.filter { it.startsWith("a=rtpmap:") })
        assertEquals(listOf("a=fmtp:111 minptime=10;useinbandfec=1"), lines.filter { it.startsWith("a=fmtp:") })
        assertTrue(lines.contains("a=candidate:2203410930 1 udp 2122262783 2001:db8::20 56144 typ host generation 0"))
        assertTrue(lines.contains("a=ssrc:3893454370 cname:mIgxS0pzGpLx/5Bs"))
    }

    @Test fun opusIsFoundAnywhereInTheFormatList() {
        val offer = CHROME_OFFER.map { if (it.startsWith("m=audio")) "m=audio 9 UDP/TLS/RTP/SAVPF 0 8 111 126" else it }
        val lines = accepted(offer.crlf()).split("\r\n")
        assertEquals("m=audio 9 UDP/TLS/RTP/SAVPF 111", lines.single { it.startsWith("m=") })
    }

    @Test fun lfLineBreaksAreAccepted() {
        assertEquals(accepted(CHROME_OFFER.crlf()), accepted(CHROME_OFFER.joinToString("\n", postfix = "\n")))
    }

    @Test fun aVideoSectionIsRejected() {
        rejected(CHROME_OFFER + listOf("m=video 9 UDP/TLS/RTP/SAVPF 96", "a=rtpmap:96 VP8/90000", "a=mid:1"))
    }

    @Test fun aDataChannelSectionIsRejected() {
        rejected(CHROME_OFFER + listOf("m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "a=mid:1"))
    }

    @Test fun anSctpPortIsRejected() {
        rejected(CHROME_OFFER + "a=sctp-port:5000")
        rejected(CHROME_OFFER + "a=sctpmap:5000 webrtc-datachannel 1024")
        rejected(CHROME_OFFER + "a=max-message-size:262144")
    }

    @Test fun twoAudioSectionsAreRejected() {
        rejected(CHROME_OFFER + listOf("m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:1", "a=rtpmap:111 opus/48000/2"))
    }

    @Test fun anAudioSectionOverAnotherProtocolIsRejected() {
        rejected(CHROME_OFFER.map { if (it.startsWith("m=audio")) "m=audio 9 RTP/AVP 111 63 9 0 8 13 110 126" else it })
    }

    @Test fun anOfferWithoutOpusIsRejected() {
        rejected(CHROME_OFFER.filterNot { it == "a=rtpmap:111 opus/48000/2" })
        rejected(CHROME_OFFER.map { if (it == "a=rtpmap:111 opus/48000/2") "a=rtpmap:111 opus/48000/1" else it })
        rejected(CHROME_OFFER.map { if (it.startsWith("m=audio")) "m=audio 9 UDP/TLS/RTP/SAVPF 0 8" else it })
    }

    @Test fun threeHundredLinesPassAndThreeHundredAndOneDoNot() {
        val filler = (0 until SdpFilter.MAX_LINES - CHROME_OFFER.size).map { "a=ssrc:2430149629 x-filler:$it" }
        accepted((CHROME_OFFER + filler).crlf())
        rejected(CHROME_OFFER + filler + "a=ssrc:2430149629 x-filler:last")
    }

    @Test fun aLineOf1024CharsPassesAnd1025DoNot() {
        val prefix = "a=ssrc:2430149629 x-filler:"
        accepted((CHROME_OFFER + (prefix + "x".repeat(SdpFilter.MAX_LINE_CHARS - prefix.length))).crlf())
        rejected(CHROME_OFFER + (prefix + "x".repeat(SdpFilter.MAX_LINE_CHARS + 1 - prefix.length)))
    }

    @Test fun aFirefoxOfferPassesWithOnlyOpusAndNoLocalNames() {
        val lines = accepted(FIREFOX_OFFER.crlf()).removeSuffix("\r\n").split("\r\n")
        assertEquals("m=audio 9 UDP/TLS/RTP/SAVPF 109", lines.single { it.startsWith("m=") })
        assertEquals(listOf("a=rtpmap:109 opus/48000/2"), lines.filter { it.startsWith("a=rtpmap:") })
        assertEquals(listOf("a=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1"), lines.filter { it.startsWith("a=fmtp:") })
        assertEquals(listOf("a=rtcp-fb:109 transport-cc"), lines.filter { it.startsWith("a=rtcp-fb:") })
        assertEquals(emptyList<String>(), lines.filter { it.startsWith("a=candidate:") })
        assertTrue(lines.contains("a=end-of-candidates"))
    }

    @Test fun hostnameCandidatesAreDroppedAndTheOfferKept() {
        val offer = CHROME_OFFER + listOf(
            "a=candidate:1 1 udp 2113937151 phone.example 35841 typ host generation 0",
            "a=candidate:2 1 udp 2113937151 192.0.2.256 35842 typ host generation 0",
            "a=candidate:3 1 udp 2113937151 0f8c1a2e-5b7d-4c3a-9e21-6d4f0a8b3c55.local 35840 typ host generation 0",
            "a=candidate:4 1 udp 2113937151 127.0.0.1 35843 typ host generation 0",
        )
        val lines = accepted(offer.crlf()).removeSuffix("\r\n").split("\r\n")
        assertEquals(CHROME_OFFER.filter { it.startsWith("a=candidate:") }, lines.filter { it.startsWith("a=candidate:") })
    }

    @Test fun onlyTheFirstSixteenAllowedCandidatesAreKept() {
        val extra = (0 until 20).map { "a=candidate:$it 1 udp 2113937151 192.0.2.${it + 100} ${40000 + it} typ host generation 0" }
        val offer = CHROME_OFFER + "a=candidate:99 1 udp 2113937151 phone.example 35841 typ host generation 0" + extra
        val lines = accepted(offer.crlf()).removeSuffix("\r\n").split("\r\n")
        val expected = (CHROME_OFFER.filter { it.startsWith("a=candidate:") } + extra).take(SdpFilter.MAX_CANDIDATES)
        assertEquals(expected, lines.filter { it.startsWith("a=candidate:") })
    }

    @Test fun onlyUnicastIpLiteralsAreAllowedCandidates() {
        listOf(
            "192.0.2.10", "10.0.0.5", "100.64.1.2", "223.255.255.254", "2001:db8::10", "2001:db8:0:0:0:0:0:1",
            "fd00::1", "::ffff:192.0.2.1", "::192.0.2.1", "2001:db8::192.0.2.1",
        ).forEach { assertTrue(it, SdpFilter.candidateAllowed(candidate(it))) }
        listOf(
            "phone.example", "a.b.local", "local", "0f8c1a2e-5b7d-4c3a-9e21-6d4f0a8b3c55.local", "192.0.2.256", "192.0.2",
            "192.0.02.1", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "1:2:3:4::5:6:7:8", "2001:db8:::1", "fe80::1%wlan0",
            "192.0.2.1::", "", "0.0.0.0", "0.1.2.3", "127.0.0.1", "127.1.2.3", "169.254.1.1", "224.0.0.251",
            "239.255.255.250", "240.0.0.1", "255.255.255.255", "::", "::1", "ff02::fb", "FF05::1:3", "fe80::1", "febf::1",
            "::ffff:127.0.0.1", "::ffff:169.254.1.1", "::ffff:224.0.0.251", "::127.0.0.1", "0:0:0:0:0:ffff:7f00:1",
        ).forEach { assertFalse(it, SdpFilter.candidateAllowed(candidate(it))) }
        assertFalse(SdpFilter.candidateAllowed("candidate:1 1 udp 2113937151"))
        assertFalse(SdpFilter.candidateAllowed("a=" + candidate("192.0.2.10")))
    }

    @Test fun rejectionReasonsCarryNoSdp() {
        val result = SdpFilter.filter((CHROME_OFFER + "a=sctp-port:5000").crlf())
        val reason = (result as? SdpFilter.Result.Rejected)?.reason ?: return fail("not rejected")
        assertFalse(reason.contains("192.0.2"))
        assertFalse(reason.contains("5000"))
    }

    private fun accepted(sdp: String): String = when (val result = SdpFilter.filter(sdp)) {
        is SdpFilter.Result.Accepted -> result.sdp
        is SdpFilter.Result.Rejected -> throw AssertionError("rejected: ${result.reason}")
    }

    private fun rejected(lines: List<String>) {
        val result = SdpFilter.filter(lines.crlf())
        assertTrue("expected a rejection, got $result", result is SdpFilter.Result.Rejected)
    }

    private fun List<String>.crlf(): String = joinToString("\r\n", postfix = "\r\n")

    private fun candidate(address: String): String = "candidate:842163049 1 udp 2113937151 $address 56143 typ host generation 0"

    private companion object {
        /** A headless Chrome 156 send-only offer from the rig's phone setup; addresses replaced. */
        val CHROME_OFFER = listOf(
            "v=0",
            "o=- 5643644723796980598 2 IN IP4 127.0.0.1",
            "s=-",
            "t=0 0",
            "a=group:BUNDLE 0",
            "a=extmap-allow-mixed",
            "a=msid-semantic: WMS",
            "m=audio 35839 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
            "c=IN IP4 192.0.2.10",
            "a=rtcp:9 IN IP4 0.0.0.0",
            "a=candidate:3382223388 1 udp 2113937151 192.0.2.10 35839 typ host generation 0 network-cost 999",
            "a=candidate:3025003610 1 udp 2113939711 2001:db8::10 42653 typ host generation 0 network-cost 999",
            "a=ice-ufrag:h+Mi",
            "a=ice-pwd:jbrDy0BuzaWxHBh2BTNkDDGg",
            "a=ice-options:trickle",
            "a=fingerprint:sha-256 52:B0:B1:DF:09:F4:8D:21:D5:E3:36:F8:FC:34:51:BA:D3:97:0F:94:33:B9:B3:50:2A:4F:E6:A0:7E:B5:A2:C1",
            "a=setup:actpass",
            "a=mid:0",
            "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
            "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
            "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
            "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
            "a=sendonly",
            "a=msid:- 601b83bd-d004-4190-b7e7-8983c48b33f1",
            "a=rtcp-mux",
            "a=rtcp-rsize",
            "a=rtcp-xr:rcvr-rtt=all",
            "a=rtpmap:111 opus/48000/2",
            "a=rtcp-fb:111 transport-cc",
            "a=fmtp:111 minptime=10;useinbandfec=1",
            "a=rtpmap:63 red/48000/2",
            "a=fmtp:63 111/111",
            "a=rtpmap:9 G722/8000",
            "a=rtpmap:0 PCMU/8000",
            "a=rtpmap:8 PCMA/8000",
            "a=rtpmap:13 CN/8000",
            "a=rtpmap:110 telephone-event/48000",
            "a=rtpmap:126 telephone-event/8000",
            "a=ssrc:2430149629 cname:d0noOX2uYymAKByZ",
            "a=ssrc:2430149629 msid:- 601b83bd-d004-4190-b7e7-8983c48b33f1",
        )

        val CHROME_DROPPED = setOf(
            "a=rtpmap:63 red/48000/2",
            "a=fmtp:63 111/111",
            "a=rtpmap:9 G722/8000",
            "a=rtpmap:0 PCMU/8000",
            "a=rtpmap:8 PCMA/8000",
            "a=rtpmap:13 CN/8000",
            "a=rtpmap:110 telephone-event/48000",
            "a=rtpmap:126 telephone-event/8000",
        )

        /** A headless Firefox 159 send-only offer with the mic captured: every host candidate is a `.local` name. */
        val FIREFOX_OFFER = listOf(
            "v=0",
            "o=mozilla...THIS_IS_SDPARTA-99.0 2575419069122366187 0 IN IP4 0.0.0.0",
            "s=-",
            "t=0 0",
            "a=sendrecv",
            "a=fingerprint:sha-256 2A:86:9D:34:FF:07:11:33:98:1C:1A:68:2D:3A:A1:C4:1F:90:CD:D9:B4:D7:B7:E4:67:C3:02:05:BD:78:23:7E",
            "a=group:BUNDLE 0",
            "a=ice-options:trickle",
            "a=msid-semantic:WMS *",
            "m=audio 9 UDP/TLS/RTP/SAVPF 109 9 0 8 101",
            "c=IN IP4 0.0.0.0",
            "a=candidate:0 1 UDP 2122187007 00f287af-0925-44ea-af72-0f96ce3aedce.local 40006 typ host",
            "a=candidate:1 1 UDP 2122252543 c73b6b08-ed59-4ce3-bae0-a7de98ff8f32.local 54425 typ host",
            "a=candidate:2 1 TCP 2105458943 00f287af-0925-44ea-af72-0f96ce3aedce.local 9 typ host tcptype active",
            "a=candidate:3 1 TCP 2105524479 c73b6b08-ed59-4ce3-bae0-a7de98ff8f32.local 9 typ host tcptype active",
            "a=candidate:0 2 UDP 2122187006 00f287af-0925-44ea-af72-0f96ce3aedce.local 41870 typ host",
            "a=candidate:1 2 UDP 2122252542 c73b6b08-ed59-4ce3-bae0-a7de98ff8f32.local 59305 typ host",
            "a=candidate:2 2 TCP 2105458942 00f287af-0925-44ea-af72-0f96ce3aedce.local 9 typ host tcptype active",
            "a=candidate:3 2 TCP 2105524478 c73b6b08-ed59-4ce3-bae0-a7de98ff8f32.local 9 typ host tcptype active",
            "a=sendonly",
            "a=end-of-candidates",
            "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
            "a=extmap:2/recvonly urn:ietf:params:rtp-hdrext:csrc-audio-level",
            "a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:mid",
            "a=extmap:7 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
            "a=extmap-allow-mixed",
            "a=fmtp:109 maxplaybackrate=48000;stereo=1;useinbandfec=1",
            "a=fmtp:101 0-15",
            "a=ice-pwd:16db6cd4ec68efddfc23456f98270e35",
            "a=ice-ufrag:6d6f90a9",
            "a=mid:0",
            "a=msid:{cc5428b6-95ef-46f8-8b72-183b6cfab3ec} {630f8ac8-a753-47a0-9da9-25aae581c31a}",
            "a=rtcp:9 IN IP4 0.0.0.0",
            "a=rtcp-fb:109 transport-cc",
            "a=rtcp-fb:9 transport-cc",
            "a=rtcp-fb:0 transport-cc",
            "a=rtcp-fb:8 transport-cc",
            "a=rtcp-mux",
            "a=rtpmap:109 opus/48000/2",
            "a=rtpmap:9 G722/8000/1",
            "a=rtpmap:0 PCMU/8000",
            "a=rtpmap:8 PCMA/8000",
            "a=rtpmap:101 telephone-event/8000",
            "a=setup:actpass",
            "a=ssrc:496726074 cname:{2c778274-e101-473c-986b-0f16ee309d39}",
        )

        /** The shape of an iOS Safari send-only offer (WebKit's libwebrtc codec list); addresses replaced. */
        val SAFARI_OFFER = listOf(
            "v=0",
            "o=- 2867385710463452018 2 IN IP4 127.0.0.1",
            "s=-",
            "t=0 0",
            "a=group:BUNDLE 0",
            "a=extmap-allow-mixed",
            "a=msid-semantic: WMS 5D9B0B53-4E4D-4B4B-9B43-2C8B7D8F1E21",
            "m=audio 56143 UDP/TLS/RTP/SAVPF 111 63 9 102 0 8 105 13 110 113 126",
            "c=IN IP4 192.0.2.20",
            "a=rtcp:9 IN IP4 0.0.0.0",
            "a=candidate:3471623853 1 udp 2122194687 192.0.2.20 56143 typ host generation 0",
            "a=candidate:2203410930 1 udp 2122262783 2001:db8::20 56144 typ host generation 0",
            "a=candidate:842163049 1 udp 1686052607 192.0.2.120 56143 typ srflx raddr 192.0.2.20 rport 56143 generation 0",
            "a=ice-ufrag:Qx7Z",
            "a=ice-pwd:3vR0b9pTzN6sYw1KcL8aHq2E",
            "a=ice-options:trickle",
            "a=fingerprint:sha-256 0A:3F:8C:21:9B:7E:44:D2:15:6A:C9:E0:53:B8:2F:71:9D:04:6E:A3:C5:18:7B:F2:E6:39:84:5D:0C:A1:72:BE",
            "a=setup:actpass",
            "a=mid:0",
            "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
            "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
            "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
            "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
            "a=sendonly",
            "a=msid:5D9B0B53-4E4D-4B4B-9B43-2C8B7D8F1E21 0C7F6E4A-91B2-4D3C-A8E5-6F1B2C3D4E5F",
            "a=rtcp-mux",
            "a=rtpmap:111 opus/48000/2",
            "a=rtcp-fb:111 transport-cc",
            "a=fmtp:111 minptime=10;useinbandfec=1",
            "a=rtpmap:63 red/48000/2",
            "a=fmtp:63 111/111",
            "a=rtpmap:9 G722/8000",
            "a=rtpmap:102 ILBC/8000",
            "a=rtpmap:0 PCMU/8000",
            "a=rtpmap:8 PCMA/8000",
            "a=rtpmap:105 CN/16000",
            "a=rtpmap:13 CN/8000",
            "a=rtpmap:110 telephone-event/48000",
            "a=rtpmap:113 telephone-event/16000",
            "a=rtpmap:126 telephone-event/8000",
            "a=ssrc:3893454370 cname:mIgxS0pzGpLx/5Bs",
            "a=ssrc:3893454370 msid:5D9B0B53-4E4D-4B4B-9B43-2C8B7D8F1E21 0C7F6E4A-91B2-4D3C-A8E5-6F1B2C3D4E5F",
        )
    }
}
