package org.firesong.tv

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DoorCodecTest {
    // ---- page messages ---------------------------------------------------------------------------------------

    @Test fun everyPageMessageParses() {
        assertEquals(PageMessage.Hello(2, listOf("mics")), page("""{"t":"hello","v":2,"features":["mics"]}"""))
        assertEquals(PageMessage.Hello(2, emptyList()), page("""{"t":"hello","v":2,"features":[]}"""))
        assertEquals(
            PageMessage.Offer(
                peer = 7,
                seq = 3,
                slot = 2,
                micId = "abcdEFGH_-12",
                sdp = SDP,
                iceServers = listOf(
                    IceServerSpec(listOf("stun:stun.example.org:3478"), null, null),
                    IceServerSpec(listOf("turn:turn.example.org", "turns:turn.example.org:443"), "user", "secret"),
                ),
            ),
            page(
                """{"t":"offer","peer":7,"seq":3,"slot":2,"micId":"abcdEFGH_-12","sdp":${JSONObject.quote(SDP)},""" +
                    """"iceServers":[{"urls":["stun:stun.example.org:3478"]},""" +
                    """{"urls":["turn:turn.example.org","turns:turn.example.org:443"],"username":"user","credential":"secret"}]}""",
            ),
        )
        assertEquals(
            PageMessage.Ice(4, IceCandidateSpec(CANDIDATE, "0", 0, "f00d")),
            page("""{"t":"ice","peer":4,"candidate":{"candidate":"$CANDIDATE","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"f00d"}}"""),
        )
        assertEquals(
            PageMessage.Ice(4, IceCandidateSpec(CANDIDATE, null, null, null)),
            page("""{"t":"ice","peer":4,"candidate":{"candidate":"$CANDIDATE"}}"""),
        )
        assertEquals(
            PageMessage.Ice(4, IceCandidateSpec("", null, null, null)),
            page("""{"t":"ice","peer":4,"candidate":{"candidate":"","sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}}"""),
        )
        assertEquals(PageMessage.Ice(4, null), page("""{"t":"ice","peer":4,"candidate":null}"""))
        assertEquals(PageMessage.Close(2147483647), page("""{"t":"close","peer":2147483647}"""))
        assertEquals(PageMessage.Detach(1), page("""{"t":"detach","slot":1}"""))
        assertEquals(PageMessage.Release(4), page("""{"t":"release","slot":4}"""))
        assertEquals(PageMessage.Monitor(3, true), page("""{"t":"monitor","slot":3,"on":true}"""))
        assertEquals(PageMessage.Mute(3, false), page("""{"t":"mute","slot":3,"muted":false}"""))
        assertEquals(PageMessage.Mix(2, 1.5, 0.0), page("""{"t":"mix","slot":2,"volume":1.5,"echo":0}"""))
        assertEquals(PageMessage.Mix(2, 0.0, 2.0), page("""{"t":"mix","slot":2,"volume":0,"echo":2}"""))
        assertEquals(PageMessage.Tap(1, true), page("""{"t":"tap","slot":1,"on":true}"""))
        assertEquals(
            PageMessage.EchoMix(0.35, 0.6, 20000.0, 1.0),
            page("""{"t":"echo-mix","wet":0.35,"feedback":0.6,"lowpassHz":20000,"reverbSend":1}"""),
        )
        assertEquals(
            PageMessage.EchoMix(0.0, 0.0, 500.0, 0.0),
            page("""{"t":"echo-mix","wet":0,"feedback":0,"lowpassHz":5e2,"reverbSend":0.0}"""),
        )
        assertEquals(PageMessage.MeasureMonitor(9, 2), page("""{"t":"measure-monitor","id":9,"slot":2}"""))
    }

    @Test fun jsonIsReadStrictlyButCompletely() {
        assertEquals(PageMessage.Close(3), page(" \t\r\n{ \"t\" : \"close\" ,\n\"peer\" : 3 } \n"))
        assertEquals(PageMessage.Close(3), page("""{"peer":3,"t":"close"}"""))
        assertEquals(PageMessage.Close(300), page("""{"t":"close","peer":3e2}"""))
        assertEquals(PageMessage.Close(3), page("""{"t":"close","peer":3.0}"""))
        assertEquals(PageMessage.Close(3), page("""{"t":"close","peer":3}"""))
        val escaped = page("""{"t":"offer","peer":1,"seq":1,"slot":1,"micId":"abcdefgh","sdp":"v=0\r\n\"q\"\\\/\b\f\té🎤","iceServers":[]}""")
        assertEquals("v=0\r\n\"q\"\\/\b\u000C\té🎤", (escaped as PageMessage.Offer).sdp)
    }

    @Test fun unknownTypesAreIgnoredAndUnknownFieldsAreNoted() {
        assertEquals(ParseResult.Ignored, DoorCodec.parsePage("""{"t":"karaoke-2","slot":99,"x":{"y":[1,2]}}"""))
        assertEquals(ParseResult.Ignored, DoorCodec.parsePage("""{"t":""}"""))
        assertEquals(
            ParseResult.Message(PageMessage.Detach(1), unknownFields = false),
            DoorCodec.parsePage("""{"t":"detach","slot":1}"""),
        )
        assertEquals(
            ParseResult.Message(PageMessage.Detach(1), unknownFields = true),
            DoorCodec.parsePage("""{"t":"detach","slot":1,"why":"reload","extra":{"deep":[null]}}"""),
        )
        val offer = """{"t":"offer","peer":1,"seq":1,"slot":1,"micId":"abcdefgh","sdp":"v=0","iceServers":[{"urls":["stun:a"],"credentialType":"password"}]}"""
        assertTrue((DoorCodec.parsePage(offer) as ParseResult.Message).unknownFields)
        val ice = """{"t":"ice","peer":1,"candidate":{"candidate":"$CANDIDATE","relayProtocol":"udp"}}"""
        assertTrue((DoorCodec.parsePage(ice) as ParseResult.Message).unknownFields)
        val nested = "{\"t\":\"detach\",\"slot\":1,\"x\":" + "[".repeat(31) + "]".repeat(31) + "}"
        assertTrue((DoorCodec.parsePage(nested) as ParseResult.Message).unknownFields)
    }

    @Test fun sizeLimits() {
        val sdpMax = "v=0" + "x".repeat(32768 - 3)
        assertEquals(sdpMax, (page(offer(sdp = sdpMax)) as PageMessage.Offer).sdp)
        fatal(offer(sdp = sdpMax + "x"))
        fatal(offer(sdp = ""))
        page(offer(micId = "a".repeat(8)))
        page(offer(micId = "Z".repeat(64)))
        fatal(offer(micId = "a".repeat(7)))
        fatal(offer(micId = "a".repeat(65)))
        page(offer(iceServers = (1..8).joinToString(",", "[", "]") { """{"urls":["stun:s$it"]}""" }))
        fatal(offer(iceServers = (1..9).joinToString(",", "[", "]") { """{"urls":["stun:s$it"]}""" }))
        page(offer(iceServers = """[{"urls":${urls(8)}}]"""))
        fatal(offer(iceServers = """[{"urls":${urls(9)}}]"""))
        fatal(offer(iceServers = """[{"urls":[]}]"""))
        page(offer(iceServers = """[{"urls":["stun:${"h".repeat(507)}"]}]"""))
        fatal(offer(iceServers = """[{"urls":["stun:${"h".repeat(508)}"]}]"""))
        page(offer(iceServers = """[{"urls":["turn:t"],"username":"${"u".repeat(256)}","credential":"${"c".repeat(256)}"}]"""))
        fatal(offer(iceServers = """[{"urls":["turn:t"],"username":"${"u".repeat(257)}"}]"""))
        fatal(offer(iceServers = """[{"urls":["turn:t"],"credential":"${"c".repeat(257)}"}]"""))
        page(ice(""""candidate":"${"c".repeat(1024)}""""))
        fatal(ice(""""candidate":"${"c".repeat(1025)}""""))
        page("""{"t":"hello","v":2,"features":${strings(16, 32)}}""")
        fatal("""{"t":"hello","v":2,"features":${strings(17, 1)}}""")
        fatal("""{"t":"hello","v":2,"features":${strings(1, 33)}}""")
        assertEquals(ParseResult.Fatal(1009), DoorCodec.parsePage("""{"t":"x","pad":"${"p".repeat(65536)}"}"""))
        val deep = "{\"t\":\"detach\",\"slot\":1,\"x\":" + "[".repeat(32) + "]".repeat(32) + "}"
        fatal(deep)
    }

    @Test fun everyHardLimitIsFatal() {
        fatal(offer(sdp = "x=0\r\n"))
        fatal(offer(micId = "abc defgh"))
        fatal(offer(micId = "abcdefgé"))
        fatal(offer(micId = "abcd/efgh"))
        fatal(offer(slot = "5"))
        fatal(offer(slot = "0"))
        fatal(offer(slot = "1.5"))
        fatal(offer(slot = "\"1\""))
        fatal(offer(slot = "null"))
        fatal(offer(peer = "0"))
        fatal(offer(peer = "-1"))
        fatal(offer(peer = "2147483648"))
        fatal(offer(peer = "1.5"))
        fatal(offer(seq = "0"))
        fatal(offer(seq = "-3"))
        fatal(offer(iceServers = """[{"urls":["http://x"]}]"""))
        fatal(offer(iceServers = """[{"urls":["STUN:x"]}]"""))
        fatal(offer(iceServers = """[{"urls":"stun:x"}]"""))
        fatal(offer(iceServers = """[{"username":"u"}]"""))
        fatal(offer(iceServers = """[{"urls":["stun:x"],"username":7}]"""))
        fatal(offer(iceServers = """["stun:x"]"""))
        fatal(offer(iceServers = "null"))
        fatal("""{"t":"mix","slot":1,"volume":NaN,"echo":1}""")
        fatal("""{"t":"mix","slot":1,"volume":Infinity,"echo":1}""")
        fatal("""{"t":"mix","slot":1,"volume":1e400,"echo":1}""")
        fatal("""{"t":"mix","slot":1,"volume":-1e400,"echo":1}""")
        fatal("""{"t":"mix","slot":1,"volume":1.5000001,"echo":1}""")
        fatal("""{"t":"mix","slot":1,"volume":-0.01,"echo":1}""")
        fatal("""{"t":"mix","slot":1,"volume":1,"echo":2.01}""")
        fatal("""{"t":"mix","slot":1,"volume":1,"echo":-1}""")
        fatal("""{"t":"mix","slot":1,"volume":"1","echo":1}""")
        fatal("""{"t":"echo-mix","wet":1.1,"feedback":0.5,"lowpassHz":4000,"reverbSend":0.5}""")
        fatal("""{"t":"echo-mix","wet":0.5,"feedback":0.601,"lowpassHz":4000,"reverbSend":0.5}""")
        fatal("""{"t":"echo-mix","wet":0.5,"feedback":0.5,"lowpassHz":499.9,"reverbSend":0.5}""")
        fatal("""{"t":"echo-mix","wet":0.5,"feedback":0.5,"lowpassHz":20000.1,"reverbSend":0.5}""")
        fatal("""{"t":"echo-mix","wet":0.5,"feedback":0.5,"lowpassHz":4000,"reverbSend":-0.5}""")
        fatal("""{"t":"echo-mix","wet":0.5,"feedback":0.5,"lowpassHz":4000}""")
        fatal("""{"t":"hello","v":1,"features":["mics"]}""")
        fatal("""{"t":"hello","v":3,"features":["mics"]}""")
        fatal("""{"t":"hello","v":"2","features":["mics"]}""")
        fatal("""{"t":"hello","features":["mics"]}""")
        fatal("""{"t":"hello","v":2,"features":"mics"}""")
        fatal("""{"t":"hello","v":2,"features":[1]}""")
        fatal("""{"t":"hello","v":2}""")
        fatal(ice(""""candidate":"c","sdpMLineIndex":-1"""))
        fatal(ice(""""candidate":"c","sdpMLineIndex":65536"""))
        fatal(ice(""""candidate":"c","sdpMLineIndex":0.5"""))
        fatal(ice(""""candidate":"c","sdpMid":0"""))
        fatal(ice(""""candidate":"c","usernameFragment":false"""))
        fatal(ice(""""sdpMid":"0""""))
        fatal("""{"t":"ice","peer":1}""")
        fatal("""{"t":"ice","peer":1,"candidate":"c"}""")
        fatal("""{"t":"close"}""")
        fatal("""{"t":"close","peer":true}""")
        fatal("""{"t":"detach","slot":5}""")
        fatal("""{"t":"release","slot":0}""")
        fatal("""{"t":"monitor","slot":1,"on":"true"}""")
        fatal("""{"t":"monitor","slot":1,"on":1}""")
        fatal("""{"t":"mute","slot":1}""")
        fatal("""{"t":"tap","slot":1,"on":null}""")
        fatal("""{"t":"measure-monitor","id":0,"slot":1}""")
        fatal("""{"t":"measure-monitor","id":1,"slot":9}""")
    }

    @Test fun textThatIsNotOneJsonObjectIsFatal() {
        listOf(
            "", " ", "[]", "\"hello\"", "1", "null", "true",
            """{"t":"close","peer":1,}""",
            """{'t':'close','peer':1}""",
            """{t:"close",peer:1}""",
            """{"t":"close","peer":1} x""",
            """{"t":"close","peer":1}{"t":"close","peer":2}""",
            """/*c*/{"t":"close","peer":1}""",
            """{"t":"close","peer":1}//c""",
            """{"t":"close","peer":01}""",
            """{"t":"close","peer":1.}""",
            """{"t":"close","peer":.5}""",
            """{"t":"close","peer":+1}""",
            """{"t":"close","peer":1e}""",
            """{"t":"close","peer":0x10}""",
            """{"t":"close","peer":1,"peer":2}""",
            """{"t":"close" "peer":1}""",
            """{"t":"close","peer":1""",
            "{\"t\":\"close\",\"peer\":1,\"x\":\"a\u0001b\"}",
            """{"t":"close","peer":1,"x":"\x"}""",
            """{"t":"close","peer":1,"x":"\u12"}""",
            """{"t":"close","peer":1,"x":"open}""",
            """{"t":"close","peer":1,"x":tru}""",
            """{"t":"close","peer":1,"x":[1,]}""",
            """{"peer":1}""",
            """{"t":7,"peer":1}""",
            """{"t":null}""",
        ).forEach { text -> assertEquals(text, ParseResult.Fatal(DoorCodec.CLOSE_POLICY), DoorCodec.parsePage(text)) }
    }

    @Test fun helloComesFirstAndOnlyOnce() {
        val hello = DoorCodec.parsePage("""{"t":"hello","v":2,"features":["mics"]}""")
        val detach = DoorCodec.parsePage("""{"t":"detach","slot":1}""")
        val unknown = DoorCodec.parsePage("""{"t":"later"}""")

        assertEquals(ParseResult.Fatal(1008), HelloGate().admit(detach))
        assertEquals(ParseResult.Fatal(1008), HelloGate().admit(unknown))
        assertEquals(ParseResult.Fatal(1009), HelloGate().admit(ParseResult.Fatal(1009)))

        val gate = HelloGate()
        assertEquals(hello, gate.admit(hello))
        assertEquals(detach, gate.admit(detach))
        assertEquals(ParseResult.Ignored, gate.admit(unknown))
        assertEquals(ParseResult.Fatal(1008), gate.admit(hello))
    }

    // ---- app messages ----------------------------------------------------------------------------------------

    @Test fun everyAppMessageRoundTrips() {
        val messages = listOf(
            AppMessage.ReadyOk(listOf("mics"), ReadyAudio.OPEN, 48000, 384, 31.25),
            AppMessage.ReadyOk(emptyList(), ReadyAudio.PENDING, 48000, null, null),
            AppMessage.ReadyFailed(ReadyFailReason.LIB),
            AppMessage.ReadyFailed(ReadyFailReason.WEBRTC),
            AppMessage.Answer(7, 3, SDP),
            AppMessage.PeerError(7, 3, PeerErrorCode.SDP, "m=video rejected"),
            AppMessage.PeerError(8, 1, PeerErrorCode.TIMEOUT, ""),
            AppMessage.PeerError(8, 2, PeerErrorCode.INTERNAL, "createAnswer failed"),
            AppMessage.PeerError(8, 3, PeerErrorCode.SUPERSEDED, "seq 4"),
            AppMessage.RestartNeeded(7),
            AppMessage.PeerStats(7, 12.5, 480000.0, 9.75, 1000.0, 2.0, 960.0, 3.0, 480.0, 240.0, 0.0021, 4.5, CandidateType.HOST),
            AppMessage.PeerStats(7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, null, null),
            AppMessage.PeerStats(7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, CandidateType.SRFLX),
            AppMessage.PeerStats(7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, CandidateType.PRFLX),
            AppMessage.PeerStats(7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, CandidateType.RELAY),
            AppMessage.Status(emptyList()),
            AppMessage.Status(listOf(SLOT_STATUS, SLOT_STATUS.copy(slot = 4, feedbackHz = null, monitorMs = null))),
            AppMessage.MonitorResultOk(5, 2, 141.5),
            AppMessage.MonitorResultFailed(5, 2, MonitorFailReason.BUSY),
            AppMessage.MonitorResultFailed(6, 3, MonitorFailReason.NO_AUDIO),
            AppMessage.MonitorResultFailed(7, 4, MonitorFailReason.NO_TONE),
            AppMessage.MonitorResultFailed(8, 1, MonitorFailReason.STOPPED),
            AppMessage.Fatal(FatalReason.WEBRTC),
            AppMessage.Fatal(FatalReason.INTERNAL),
            ENGINE_STATS,
            ENGINE_STATS.copy(outputLatencyMs = null, apm = null, slots = emptyList()),
        )
        for (message in messages) assertEquals(message, decodeApp(DoorCodec.encode(message)))
    }

    @Test fun appMessagesUseTheWireNames() {
        assertEquals(
            """{"t":"ready","v":2,"ok":true,"features":["mics"],"audio":"pending","rate":48000,"burstFrames":null,"outputLatencyMs":null}""",
            DoorCodec.encode(AppMessage.ReadyOk(listOf("mics"), ReadyAudio.PENDING, 48000, null, null)),
        )
        assertEquals("""{"t":"ready","v":2,"ok":false,"reason":"webrtc"}""", DoorCodec.encode(AppMessage.ReadyFailed(ReadyFailReason.WEBRTC)))
        assertEquals("""{"t":"restart-needed","peer":9}""", DoorCodec.encode(AppMessage.RestartNeeded(9)))
        assertEquals(
            """{"t":"monitor-result","id":1,"slot":2,"ok":false,"reason":"no-audio"}""",
            DoorCodec.encode(AppMessage.MonitorResultFailed(1, 2, MonitorFailReason.NO_AUDIO)),
        )
        assertEquals("""{"t":"fatal","reason":"internal"}""", DoorCodec.encode(AppMessage.Fatal(FatalReason.INTERNAL)))
        assertEquals(
            """{"t":"monitor-result","id":1,"slot":2,"ok":true,"monitorMs":0.001}""",
            DoorCodec.encode(AppMessage.MonitorResultOk(1, 2, 0.001)),
        )
    }

    @Test fun encodingKeepsTextAndClipsTheErrorDetail() {
        val tricky = "v=0\r\n\"quoted\" \\ back\u0001\u001f\té 🎤  "
        assertEquals(tricky, (decodeApp(DoorCodec.encode(AppMessage.Answer(1, 1, tricky))) as AppMessage.Answer).sdp)
        assertTrue(DoorCodec.encode(AppMessage.Answer(1, 1, "\u0001")).contains("\\u0001"))

        val long = "d".repeat(500)
        val clipped = decodeApp(DoorCodec.encode(AppMessage.PeerError(1, 1, PeerErrorCode.INTERNAL, long))) as AppMessage.PeerError
        assertEquals("d".repeat(200), clipped.detail)
        val pairAtEdge = "d".repeat(199) + "🎤"
        val kept = decodeApp(DoorCodec.encode(AppMessage.PeerError(1, 1, PeerErrorCode.INTERNAL, pairAtEdge))) as AppMessage.PeerError
        assertEquals("d".repeat(199), kept.detail)
    }

    @Test fun nonFiniteNumbersBecomeNull() {
        val json = JSONObject(DoorCodec.encode(AppMessage.MonitorResultOk(1, 1, Double.NaN)))
        assertTrue(json.isNull("monitorMs"))
        val stats = JSONObject(DoorCodec.encode(ENGINE_STATS.copy(peak = Double.POSITIVE_INFINITY)))
        assertTrue(stats.isNull("peak"))
    }

    // ---- WebSocket frames from the page ----------------------------------------------------------------------

    @Test fun textFramesAtEveryLengthEncoding() {
        for (size in listOf(0, 1, 125, 126, 127, 65535, 65536)) {
            val text = "a".repeat(size)
            val bytes = clientFrame(OP_TEXT, text.toByteArray())
            val expectedHeader = when {
                size <= 125 -> 2
                size <= 65535 -> 4
                else -> 10
            }
            assertEquals("size $size", expectedHeader + 4 + size, bytes.size)
            assertEquals("size $size", WsEvent.Text(text), reader(bytes).next())
        }
        assertEquals(WsEvent.Fail(1009), reader(clientFrame(OP_TEXT, ByteArray(65537) { 'a'.code.toByte() })).next())
    }

    @Test fun masksAreApplied() {
        val text = "masked hello, é"
        for (mask in listOf(byteArrayOf(0, 0, 0, 0), byteArrayOf(0x37, 0xfa.toByte(), 0x21, 0x3d), byteArrayOf(-1, -1, -1, -1))) {
            assertEquals(WsEvent.Text(text), reader(clientFrame(OP_TEXT, text.toByteArray(), mask = mask)).next())
        }
        // RFC 6455 §5.7: a masked "Hello".
        val rfc = byteArrayOf(0x81.toByte(), 0x85.toByte(), 0x37, 0xfa.toByte(), 0x21, 0x3d, 0x7f, 0x9f.toByte(), 0x4d, 0x51, 0x58)
        assertEquals(WsEvent.Text("Hello"), reader(rfc).next())
    }

    @Test fun fragmentsAreJoinedAroundControlFrames() {
        val frames = reader(
            clientFrame(OP_TEXT, "he".toByteArray(), fin = false),
            clientFrame(OP_PING, "p".toByteArray()),
            clientFrame(OP_CONTINUATION, "ll".toByteArray(), fin = false),
            clientFrame(OP_PONG, ByteArray(0)),
            clientFrame(OP_CONTINUATION, "o!".toByteArray()),
            clientFrame(OP_TEXT, "next".toByteArray()),
        )
        val ping = frames.next() as WsEvent.Ping
        assertArrayEquals("p".toByteArray(), ping.payload)
        assertEquals(WsEvent.Pong, frames.next())
        assertEquals(WsEvent.Text("hello!"), frames.next())
        assertEquals(WsEvent.Text("next"), frames.next())

        val euro = "€".toByteArray()
        val split = reader(
            clientFrame(OP_TEXT, euro.copyOfRange(0, 1), fin = false),
            clientFrame(OP_CONTINUATION, euro.copyOfRange(1, 3)),
        )
        assertEquals(WsEvent.Text("€"), split.next())

        val half = ByteArray(32768) { 'b'.code.toByte() }
        assertEquals(
            WsEvent.Text("b".repeat(65536)),
            reader(clientFrame(OP_TEXT, half, fin = false), clientFrame(OP_CONTINUATION, half)).next(),
        )
        assertEquals(
            WsEvent.Fail(1009),
            reader(clientFrame(OP_TEXT, half, fin = false), clientFrame(OP_CONTINUATION, half + 'b'.code.toByte())).next(),
        )
        assertEquals(
            WsEvent.Fail(1009),
            reader(clientFrame(OP_TEXT, half, fin = false), clientFrame(OP_CONTINUATION, half, fin = false), clientFrame(OP_CONTINUATION, byteArrayOf(1))).next(),
        )
    }

    @Test fun framingErrorsCloseWithTheirCodes() {
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_TEXT, "x".toByteArray(), mask = null)).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_TEXT, "x".toByteArray(), rsv = 0x40)).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_TEXT, "x".toByteArray(), rsv = 0x10)).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(0x3, "x".toByteArray())).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(0xB, "x".toByteArray())).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_CONTINUATION, "x".toByteArray())).next())
        assertEquals(
            WsEvent.Fail(1002),
            reader(clientFrame(OP_TEXT, "a".toByteArray(), fin = false), clientFrame(OP_TEXT, "b".toByteArray())).next(),
        )
        assertEquals(WsEvent.Fail(1003), reader(clientFrame(OP_BINARY, byteArrayOf(1, 2, 3))).next())
        assertEquals(WsEvent.Fail(1003), reader(clientFrame(OP_BINARY, byteArrayOf(1), fin = false)).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_PING, "p".toByteArray(), fin = false)).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_PING, ByteArray(126))).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_CLOSE, ByteArray(126))).next())
        val ping = reader(clientFrame(OP_PING, ByteArray(125) { it.toByte() })).next() as WsEvent.Ping
        assertArrayEquals(ByteArray(125) { it.toByte() }, ping.payload)
        val topBit = byteArrayOf(0x81.toByte(), 0xff.toByte(), 0x80.toByte(), 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0)
        assertEquals(WsEvent.Fail(1002), reader(topBit).next())
        val huge = byteArrayOf(0x81.toByte(), 0xff.toByte(), 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0)
        assertEquals(WsEvent.Fail(1009), reader(huge).next())
        val longShort = byteArrayOf(0x81.toByte(), 0xfe.toByte(), 0, 2, 0, 0, 0, 0, 'o'.code.toByte(), 'k'.code.toByte())
        assertEquals(WsEvent.Text("ok"), reader(longShort).next())
    }

    @Test fun textMustBeUtf8() {
        for (bad in listOf(byteArrayOf(0xc3.toByte(), 0x28), byteArrayOf(0xc0.toByte(), 0xaf.toByte()), byteArrayOf(0xed.toByte(), 0xa0.toByte(), 0x80.toByte()), byteArrayOf(0xe2.toByte(), 0x82.toByte()))) {
            assertEquals(WsEvent.Fail(1007), reader(clientFrame(OP_TEXT, bad)).next())
        }
    }

    @Test fun closeFrames() {
        assertEquals(WsEvent.Close(1005), reader(clientFrame(OP_CLOSE, ByteArray(0))).next())
        assertEquals(WsEvent.Close(1000), reader(clientFrame(OP_CLOSE, close(1000, "bye"))).next())
        assertEquals(WsEvent.Close(1001), reader(clientFrame(OP_CLOSE, close(1001))).next())
        assertEquals(WsEvent.Close(4000), reader(clientFrame(OP_CLOSE, close(4000))).next())
        assertEquals(WsEvent.Close(1000), reader(clientFrame(OP_TEXT, "a".toByteArray(), fin = false), clientFrame(OP_CLOSE, close(1000))).next())
        assertEquals(WsEvent.Fail(1002), reader(clientFrame(OP_CLOSE, byteArrayOf(3))).next())
        for (code in listOf(0, 999, 1004, 1005, 1006, 1015, 2000, 2999, 5000, 65535)) {
            assertEquals("code $code", WsEvent.Fail(1002), reader(clientFrame(OP_CLOSE, close(code))).next())
        }
        assertEquals(WsEvent.Fail(1007), reader(clientFrame(OP_CLOSE, close(1000) + byteArrayOf(0xc3.toByte(), 0x28))).next())
        for (code in listOf(1000, 1003, 1007, 1011, 1014, 3000, 4999)) assertTrue(WsFrames.validCloseCode(code))
    }

    @Test fun theStreamEndingIsAnIOException() {
        for (bytes in listOf(ByteArray(0), byteArrayOf(0x81.toByte()), clientFrame(OP_TEXT, "abc".toByteArray()).copyOf(7))) {
            try {
                reader(bytes).next()
                fail("expected IOException")
            } catch (_: IOException) {
            }
        }
        val frames = reader(clientFrame(OP_TEXT, "one".toByteArray()))
        assertEquals(WsEvent.Text("one"), frames.next())
        try {
            frames.next()
            fail("expected IOException")
        } catch (_: IOException) {
        }
    }

    // ---- WebSocket frames to the page ------------------------------------------------------------------------

    @Test fun serverFramesUseTheShortestLength() {
        for (size in listOf(0, 125, 126, 65535, 65536, 63740)) {
            val payload = ByteArray(size) { (it * 7).toByte() }
            val out = ByteArrayOutputStream()
            WsFrames.write(out, WsFrames.OP_BINARY, payload)
            val bytes = out.toByteArray()
            assertEquals(0x82, bytes[0].toInt() and 0xff)
            assertEquals("unmasked", 0, bytes[1].toInt() and 0x80)
            val (length, header) = when (val small = bytes[1].toInt() and 0x7f) {
                126 -> (((bytes[2].toInt() and 0xff) shl 8) or (bytes[3].toInt() and 0xff)) to 4
                127 -> (2 until 10).fold(0L) { acc, i -> (acc shl 8) or (bytes[i].toLong() and 0xff) }.toInt() to 10
                else -> small to 2
            }
            assertEquals("size $size", size, length)
            assertEquals(
                "size $size",
                when {
                    size <= 125 -> 2
                    size <= 65535 -> 4
                    else -> 10
                },
                header,
            )
            assertArrayEquals(payload, bytes.copyOfRange(header, bytes.size))
        }
        val text = ByteArrayOutputStream().also { WsFrames.write(it, WsFrames.OP_TEXT, "hi".toByteArray()) }.toByteArray()
        assertArrayEquals(byteArrayOf(0x81.toByte(), 2, 'h'.code.toByte(), 'i'.code.toByte()), text)
        val close = ByteArrayOutputStream().also { WsFrames.write(it, WsFrames.OP_CLOSE, WsFrames.closePayload(1011)) }.toByteArray()
        assertArrayEquals(byteArrayOf(0x88.toByte(), 2, 0x03, 0xf3.toByte()), close)
        val slice = ByteArrayOutputStream().also { WsFrames.write(it, WsFrames.OP_PONG, "xpongx".toByteArray(), 1, 4) }.toByteArray()
        assertArrayEquals(byteArrayOf(0x8a.toByte(), 4) + "pong".toByteArray(), slice)
    }

    // ---- the upgrade -----------------------------------------------------------------------------------------

    @Test fun theRfcAcceptKey() {
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", WsHandshake.acceptKey("dGhlIHNhbXBsZSBub25jZQ=="))
    }

    @Test fun upgradeChecksTokenOriginAndProtocol() {
        assertEquals(WsHandshake.Result.Accept("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), check(request()))
        assertEquals(WsHandshake.Result.Accept("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), check(request(extra = listOf("Connection: keep-alive, Upgrade"), connection = null)))
        val lowerCase = request().map { line -> line.substringBefore(':').lowercase() + line.substring(line.substringBefore(':').length) }
        assertEquals(WsHandshake.Result.Accept("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), check(listOf(request()[0]) + lowerCase.drop(1)))

        val forbidden = WsHandshake.Result.Refuse(WsHandshake.FORBIDDEN)
        assertEquals(forbidden, check(request(target = "/voice?t=0123456789abcdef0123456789abcdee")))
        assertEquals(forbidden, check(request(target = "/voice")))
        assertEquals(forbidden, check(request(target = "/voice?t=")))
        assertEquals(forbidden, check(request(target = "/voice?t=0123456789abcdef0123456789abcdef&x=1")))
        assertEquals(forbidden, check(request(target = "/other?t=0123456789abcdef0123456789abcdef")))
        assertEquals(forbidden, check(request(origin = "https://evil.example")))
        assertEquals(forbidden, check(request(origin = "https://tv.example.lan:64443/")))
        assertEquals(forbidden, check(request(origin = null)))
        assertEquals(forbidden, WsHandshake.check(request(), TARGET, null))

        val bad = WsHandshake.Result.Refuse(WsHandshake.BAD_REQUEST)
        assertEquals(bad, check(request(method = "POST")))
        assertEquals(bad, check(request(version = "HTTP/1.0")))
        assertEquals(bad, check(listOf("GET  $TARGET HTTP/1.1") + request().drop(1)))
        assertEquals(bad, check(emptyList()))
        assertEquals(bad, check(request(upgrade = null)))
        assertEquals(bad, check(request(upgrade = "h2c")))
        assertEquals(bad, check(request(connection = null)))
        assertEquals(bad, check(request(connection = "keep-alive")))
        assertEquals(bad, check(request(key = null)))
        assertEquals(bad, check(request(key = "not base64!")))
        assertEquals(bad, check(request(key = "c2hvcnQ=")))
        assertEquals(bad, check(request(extra = listOf("Origin: $ORIGIN"))))
        assertEquals(bad, check(request(extra = listOf("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="))))
        assertEquals(bad, check(request(extra = listOf("no colon here"))))
        assertEquals(WsHandshake.Result.Refuse(WsHandshake.UPGRADE_REQUIRED), check(request(wsVersion = "8")))
        assertEquals(WsHandshake.Result.Refuse(WsHandshake.UPGRADE_REQUIRED), check(request(wsVersion = null)))
    }

    @Test fun handshakeReplies() {
        assertEquals(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc=\r\n\r\n",
            String(WsHandshake.switching("abc="), Charsets.US_ASCII),
        )
        assertEquals(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            String(WsHandshake.refusal(WsHandshake.FORBIDDEN), Charsets.US_ASCII),
        )
        assertTrue(String(WsHandshake.refusal(WsHandshake.UPGRADE_REQUIRED), Charsets.US_ASCII).contains("\r\nSec-WebSocket-Version: 13\r\n"))
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    private fun page(text: String): PageMessage {
        val result = DoorCodec.parsePage(text)
        if (result !is ParseResult.Message) throw AssertionError("expected a message, got $result for $text")
        return result.message
    }

    private fun fatal(text: String) = assertEquals(text.take(200), ParseResult.Fatal(DoorCodec.CLOSE_POLICY), DoorCodec.parsePage(text))

    private fun offer(
        peer: String = "1",
        seq: String = "1",
        slot: String = "1",
        micId: String = "abcdefgh",
        sdp: String = "v=0\r\n",
        iceServers: String = "[]",
    ) = """{"t":"offer","peer":$peer,"seq":$seq,"slot":$slot,"micId":${JSONObject.quote(micId)},"sdp":${JSONObject.quote(sdp)},"iceServers":$iceServers}"""

    private fun ice(candidateFields: String) = """{"t":"ice","peer":1,"candidate":{$candidateFields}}"""

    private fun urls(count: Int) = (1..count).joinToString(",", "[", "]") { "\"stun:s$it\"" }

    private fun strings(count: Int, chars: Int) = (1..count).joinToString(",", "[", "]") { "\"${"f".repeat(chars)}\"" }

    private fun reader(vararg frames: ByteArray) = WsReader(ByteArrayInputStream(frames.fold(ByteArray(0)) { acc, f -> acc + f }))

    private fun close(code: Int, reason: String = "") = byteArrayOf((code shr 8).toByte(), code.toByte()) + reason.toByteArray()

    /** A client frame as a browser sends it: masked, with the shortest length encoding. */
    private fun clientFrame(
        opcode: Int,
        payload: ByteArray,
        fin: Boolean = true,
        mask: ByteArray? = byteArrayOf(0x12, 0x34, 0x56, 0x78),
        rsv: Int = 0,
    ): ByteArray {
        val out = ByteArrayOutputStream()
        out.write((if (fin) 0x80 else 0) or rsv or opcode)
        val maskBit = if (mask != null) 0x80 else 0
        when {
            payload.size <= 125 -> out.write(maskBit or payload.size)
            payload.size <= 65535 -> {
                out.write(maskBit or 126)
                out.write(payload.size shr 8)
                out.write(payload.size and 0xff)
            }
            else -> {
                out.write(maskBit or 127)
                for (shift in 56 downTo 0 step 8) out.write(((payload.size.toLong() shr shift) and 0xff).toInt())
            }
        }
        if (mask == null) {
            out.write(payload)
        } else {
            out.write(mask)
            out.write(ByteArray(payload.size) { (payload[it].toInt() xor mask[it and 3].toInt()).toByte() })
        }
        return out.toByteArray()
    }

    private fun request(
        method: String = "GET",
        target: String = TARGET,
        version: String = "HTTP/1.1",
        origin: String? = ORIGIN,
        upgrade: String? = "websocket",
        connection: String? = "Upgrade",
        key: String? = "dGhlIHNhbXBsZSBub25jZQ==",
        wsVersion: String? = "13",
        extra: List<String> = emptyList(),
    ): List<String> = listOfNotNull(
        "$method $target $version",
        "Host: 127.0.0.1:41234",
        upgrade?.let { "Upgrade: $it" },
        connection?.let { "Connection: $it" },
        origin?.let { "Origin: $it" },
        key?.let { "Sec-WebSocket-Key: $it" },
        wsVersion?.let { "Sec-WebSocket-Version: $it" },
        "User-Agent: test",
    ) + extra

    private fun check(head: List<String>) = WsHandshake.check(head, TARGET, ORIGIN)

    /** The page's view of an app message (native-mic-protocol.ts appMessageSchema), read back strictly. */
    private fun decodeApp(text: String): AppMessage {
        val o = JSONObject(text)
        fun keys(vararg names: String) = assertEquals(text, names.toSet(), o.keySet())
        fun nullableDouble(name: String) = if (o.isNull(name)) null else o.getDouble(name)
        return when (o.getString("t")) {
            "ready" -> {
                assertEquals(2, o.getInt("v"))
                if (o.getBoolean("ok")) {
                    keys("t", "v", "ok", "features", "audio", "rate", "burstFrames", "outputLatencyMs")
                    AppMessage.ReadyOk(
                        strings(o.getJSONArray("features")),
                        ReadyAudio.entries.single { it.wire == o.getString("audio") },
                        o.getInt("rate"),
                        if (o.isNull("burstFrames")) null else o.getInt("burstFrames"),
                        nullableDouble("outputLatencyMs"),
                    )
                } else {
                    keys("t", "v", "ok", "reason")
                    AppMessage.ReadyFailed(ReadyFailReason.entries.single { it.wire == o.getString("reason") })
                }
            }
            "answer" -> {
                keys("t", "peer", "seq", "sdp")
                AppMessage.Answer(o.getInt("peer"), o.getInt("seq"), o.getString("sdp"))
            }
            "peer-error" -> {
                keys("t", "peer", "seq", "code", "detail")
                AppMessage.PeerError(
                    o.getInt("peer"),
                    o.getInt("seq"),
                    PeerErrorCode.entries.single { it.wire == o.getString("code") },
                    o.getString("detail"),
                )
            }
            "restart-needed" -> {
                keys("t", "peer")
                AppMessage.RestartNeeded(o.getInt("peer"))
            }
            "peer-stats" -> {
                keys(
                    "t", "peer", "jitterBufferDelay", "jitterBufferEmittedCount", "jitterBufferTargetDelay", "packetsReceived",
                    "packetsLost", "concealedSamples", "concealmentEvents", "insertedSamplesForDeceleration",
                    "removedSamplesForAcceleration", "jitter", "roundTripTimeMs", "candidateType",
                )
                AppMessage.PeerStats(
                    o.getInt("peer"),
                    o.getDouble("jitterBufferDelay"),
                    o.getDouble("jitterBufferEmittedCount"),
                    o.getDouble("jitterBufferTargetDelay"),
                    o.getDouble("packetsReceived"),
                    o.getDouble("packetsLost"),
                    o.getDouble("concealedSamples"),
                    o.getDouble("concealmentEvents"),
                    o.getDouble("insertedSamplesForDeceleration"),
                    o.getDouble("removedSamplesForAcceleration"),
                    o.getDouble("jitter"),
                    nullableDouble("roundTripTimeMs"),
                    if (o.isNull("candidateType")) null else CandidateType.entries.single { it.wire == o.getString("candidateType") },
                )
            }
            "status" -> {
                keys("t", "slots")
                val slots = o.getJSONArray("slots")
                AppMessage.Status((0 until slots.length()).map { slotStatus(slots.getJSONObject(it)) })
            }
            "monitor-result" -> if (o.getBoolean("ok")) {
                keys("t", "id", "slot", "ok", "monitorMs")
                AppMessage.MonitorResultOk(o.getInt("id"), o.getInt("slot"), o.getDouble("monitorMs"))
            } else {
                keys("t", "id", "slot", "ok", "reason")
                AppMessage.MonitorResultFailed(
                    o.getInt("id"),
                    o.getInt("slot"),
                    MonitorFailReason.entries.single { it.wire == o.getString("reason") },
                )
            }
            "fatal" -> {
                keys("t", "reason")
                AppMessage.Fatal(FatalReason.entries.single { it.wire == o.getString("reason") })
            }
            "engine-stats" -> {
                keys(
                    "t", "open", "outputLatencyMs", "burstFrames", "bufferFrames", "xruns", "restarts", "openAttempts",
                    "callbackP99Us", "callbackMaxUs", "pushIntervalP50Us", "pushIntervalP99Us", "pushIntervalMaxUs",
                    "pushToPresentP50Ms", "pushToPresentP95Ms", "tapDropped", "tapDrainP99Us", "tapDrainMaxUs", "trims",
                    "jumps", "inserts", "insertedFrames", "clampHits", "peak", "sinkErrors", "ignored", "apm", "slots",
                )
                val slots = o.getJSONArray("slots")
                EngineStatsMsg(
                    o.getBoolean("open"),
                    nullableDouble("outputLatencyMs"),
                    o.getLong("burstFrames"),
                    o.getLong("bufferFrames"),
                    o.getLong("xruns"),
                    o.getLong("restarts"),
                    o.getLong("openAttempts"),
                    o.getLong("callbackP99Us"),
                    o.getLong("callbackMaxUs"),
                    o.getLong("pushIntervalP50Us"),
                    o.getLong("pushIntervalP99Us"),
                    o.getLong("pushIntervalMaxUs"),
                    o.getDouble("pushToPresentP50Ms"),
                    o.getDouble("pushToPresentP95Ms"),
                    o.getLong("tapDropped"),
                    o.getLong("tapDrainP99Us"),
                    o.getLong("tapDrainMaxUs"),
                    o.getLong("trims"),
                    o.getLong("jumps"),
                    o.getLong("inserts"),
                    o.getLong("insertedFrames"),
                    o.getLong("clampHits"),
                    o.getDouble("peak"),
                    o.getLong("sinkErrors"),
                    o.getLong("ignored"),
                    if (o.isNull("apm")) null else o.getString("apm"),
                    (0 until slots.length()).map { i ->
                        val s = slots.getJSONObject(i)
                        assertEquals(setOf("slot", "underruns", "trimmedFrames", "marginMs"), s.keySet())
                        EngineSlotStatsMsg(s.getInt("slot"), s.getLong("underruns"), s.getLong("trimmedFrames"), s.getDouble("marginMs"))
                    },
                )
            }
            else -> throw AssertionError("unknown t in $text")
        }
    }

    private fun slotStatus(s: JSONObject): SlotStatusMsg {
        assertEquals(
            setOf(
                "slot", "attached", "monitored", "muted", "levelRms", "gateOpen", "gateThreshold", "feedbackHz", "boostDb",
                "echo", "mix", "fillMs", "outRms", "monitorMs",
            ),
            s.keySet(),
        )
        val echo = s.getJSONObject("echo")
        assertEquals(setOf("delayMs", "dryGain", "wetGain", "late"), echo.keySet())
        val mix = s.getJSONObject("mix")
        assertEquals(setOf("volume", "echo"), mix.keySet())
        return SlotStatusMsg(
            s.getInt("slot"),
            s.getBoolean("attached"),
            s.getBoolean("monitored"),
            s.getBoolean("muted"),
            s.getDouble("levelRms"),
            s.getBoolean("gateOpen"),
            s.getDouble("gateThreshold"),
            if (s.isNull("feedbackHz")) null else s.getDouble("feedbackHz"),
            s.getDouble("boostDb"),
            EchoStatusMsg(echo.getDouble("delayMs"), echo.getDouble("dryGain"), echo.getDouble("wetGain"), echo.getBoolean("late")),
            SlotMixMsg(mix.getDouble("volume"), mix.getDouble("echo")),
            s.getDouble("fillMs"),
            s.getDouble("outRms"),
            if (s.isNull("monitorMs")) null else s.getDouble("monitorMs"),
        )
    }

    private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }

    private companion object {
        const val OP_CONTINUATION = 0x0
        const val OP_TEXT = 0x1
        const val OP_BINARY = 0x2
        const val OP_CLOSE = 0x8
        const val OP_PING = 0x9
        const val OP_PONG = 0xA
        const val ORIGIN = "https://tv.example.lan:64443"
        const val TARGET = "/voice?t=0123456789abcdef0123456789abcdef"
        const val CANDIDATE = "candidate:1 1 udp 2122260223 192.0.2.10 49152 typ host generation 0"
        const val SDP = "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n" +
            "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\n"

        val SLOT_STATUS = SlotStatusMsg(
            slot = 2,
            attached = true,
            monitored = false,
            muted = true,
            levelRms = 0.0125,
            gateOpen = true,
            gateThreshold = 0.001,
            feedbackHz = 2490.5,
            boostDb = 7.5,
            echo = EchoStatusMsg(delayMs = 120.0, dryGain = 1.0, wetGain = 0.35, late = false),
            mix = SlotMixMsg(volume = 1.25, echo = 0.5),
            fillMs = 16.2,
            outRms = 3.0e-5,
            monitorMs = 142.25,
        )

        val ENGINE_STATS = EngineStatsMsg(
            open = true,
            outputLatencyMs = 31.5,
            burstFrames = 384,
            bufferFrames = 768,
            xruns = 1,
            restarts = 2,
            openAttempts = 3,
            callbackP99Us = 900,
            callbackMaxUs = 2400,
            pushIntervalP50Us = 10000,
            pushIntervalP99Us = 14200,
            pushIntervalMaxUs = 31000,
            pushToPresentP50Ms = 44.5,
            pushToPresentP95Ms = 52.25,
            tapDropped = 0,
            tapDrainP99Us = 11800,
            tapDrainMaxUs = 21000,
            trims = 4,
            jumps = 1,
            inserts = 6,
            insertedFrames = 840,
            clampHits = 37,
            peak = 0.4987,
            sinkErrors = 0,
            ignored = 5,
            apm = "ec:SOFTWARE,ns:SOFTWARE",
            slots = listOf(EngineSlotStatsMsg(1, 0, 12, 3.0), EngineSlotStatsMsg(3, 2, 0, 6.5)),
        )
    }
}
