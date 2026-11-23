package org.firesong.tv

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.Base64

/** One page text frame: a message, something tolerated and counted, or a reason to close with [Fatal.code]. */
sealed class ParseResult {
    /** [unknownFields]: the frame also carried fields this version does not know, at any depth. */
    data class Message(val message: PageMessage, val unknownFields: Boolean = false) : ParseResult()

    data object Ignored : ParseResult()

    data class Fatal(val code: Int) : ParseResult()
}

/**
 * The JSON of the voice door: page frames in, app messages out. Page text is strict JSON (RFC 8259) checked
 * against the field rules of the mics protocol. An unknown `t` and unknown extra fields are tolerated, because
 * the page ships from the server independently of the installed app.
 */
object DoorCodec {
    const val CLOSE_NORMAL = 1000
    const val CLOSE_GOING_AWAY = 1001
    const val CLOSE_PROTOCOL = 1002
    const val CLOSE_UNSUPPORTED = 1003
    const val CLOSE_NO_STATUS = 1005
    const val CLOSE_BAD_DATA = 1007
    const val CLOSE_POLICY = 1008
    const val CLOSE_TOO_BIG = 1009
    const val CLOSE_INTERNAL = 1011

    /** The largest page message: bytes of UTF-8 text after its continuation frames are joined. */
    const val MAX_MESSAGE = 65536

    private const val MAX_FEATURES = 16
    private const val MAX_FEATURE_CHARS = 32
    private const val MIC_ID_MIN = 8
    private const val MIC_ID_MAX = 64
    private const val MAX_SDP_CHARS = 32768
    private const val MAX_ICE_SERVERS = 8
    private const val MAX_URLS = 8
    private const val MAX_URL_CHARS = 512
    private const val MAX_CREDENTIAL_CHARS = 256
    private const val MAX_CANDIDATE_CHARS = 1024
    private const val MAX_M_LINE_INDEX = 65535
    private val iceSchemes = listOf("stun:", "turn:", "turns:")

    fun parsePage(text: String): ParseResult {
        if (text.length > MAX_MESSAGE) return ParseResult.Fatal(CLOSE_TOO_BIG)
        return try {
            val root = JsonReader(text).document()
            if (root !is Json.Obj) return ParseResult.Fatal(CLOSE_POLICY)
            val type = root.fields["t"]
            if (type !is Json.Str) return ParseResult.Fatal(CLOSE_POLICY)
            val scope = Scope()
            val fields = Fields(root.fields, scope)
            fields.required("t")
            val message = page(type.value, fields) ?: return ParseResult.Ignored
            fields.done()
            ParseResult.Message(message, scope.unknown)
        } catch (_: Rejected) {
            ParseResult.Fatal(CLOSE_POLICY)
        }
    }

    fun encode(message: AppMessage): String {
        val json = JsonWriter()
        json.obj {
            put("t", message.t)
            when (message) {
                is AppMessage.ReadyOk -> {
                    put("v", DOOR_VERSION)
                    put("ok", true)
                    key("features").arr { message.features.forEach { value(it) } }
                    put("audio", message.audio.wire)
                    put("rate", message.rate)
                    put("burstFrames", message.burstFrames)
                    put("outputLatencyMs", message.outputLatencyMs)
                }
                is AppMessage.ReadyFailed -> {
                    put("v", DOOR_VERSION)
                    put("ok", false)
                    put("reason", message.reason.wire)
                }
                is AppMessage.Answer -> {
                    put("peer", message.peer)
                    put("seq", message.seq)
                    put("sdp", message.sdp)
                }
                is AppMessage.PeerError -> {
                    put("peer", message.peer)
                    put("seq", message.seq)
                    put("code", message.code.wire)
                    put("detail", clip(message.detail, AppMessage.PeerError.DETAIL_MAX))
                }
                is AppMessage.RestartNeeded -> put("peer", message.peer)
                is AppMessage.PeerStats -> peerStats(message)
                is AppMessage.Status -> key("slots").arr { message.slots.forEach { obj { slotStatus(it) } } }
                is AppMessage.MonitorResultOk -> {
                    put("id", message.id)
                    put("slot", message.slot)
                    put("ok", true)
                    put("monitorMs", message.monitorMs)
                }
                is AppMessage.MonitorResultFailed -> {
                    put("id", message.id)
                    put("slot", message.slot)
                    put("ok", false)
                    put("reason", message.reason.wire)
                }
                is AppMessage.Fatal -> put("reason", message.reason.wire)
                is EngineStatsMsg -> engineStats(message)
            }
        }
        return json.toString()
    }

    private fun page(type: String, f: Fields): PageMessage? = when (type) {
        "hello" -> PageMessage.Hello(
            v = f.int("v", DOOR_VERSION, DOOR_VERSION),
            features = f.list("features", 0, MAX_FEATURES) { it.string(0, MAX_FEATURE_CHARS) },
        )
        "offer" -> PageMessage.Offer(
            peer = f.peer(),
            seq = f.int("seq", 1, Int.MAX_VALUE),
            slot = f.slot(),
            micId = f.string("micId", MIC_ID_MIN, MIC_ID_MAX).also { id -> if (!id.all(::isMicIdChar)) throw Rejected },
            sdp = f.string("sdp", 1, MAX_SDP_CHARS).also { if (!it.startsWith("v=0")) throw Rejected },
            iceServers = f.list("iceServers", 0, MAX_ICE_SERVERS) { f.nested(it, ::iceServer) },
        )
        "ice" -> PageMessage.Ice(f.peer(), f.nullable("candidate")?.let { f.nested(it, ::candidate) })
        "close" -> PageMessage.Close(f.peer())
        "detach" -> PageMessage.Detach(f.slot())
        "release" -> PageMessage.Release(f.slot())
        "monitor" -> PageMessage.Monitor(f.slot(), f.bool("on"))
        "mute" -> PageMessage.Mute(f.slot(), f.bool("muted"))
        "mix" -> PageMessage.Mix(f.slot(), f.double("volume", 0.0, 1.5), f.double("echo", 0.0, 2.0))
        "tap" -> PageMessage.Tap(f.slot(), f.bool("on"))
        "echo-mix" -> PageMessage.EchoMix(
            wet = f.double("wet", 0.0, 1.0),
            feedback = f.double("feedback", 0.0, 0.6),
            lowpassHz = f.double("lowpassHz", 500.0, 20000.0),
            reverbSend = f.double("reverbSend", 0.0, 1.0),
        )
        "measure-monitor" -> PageMessage.MeasureMonitor(f.int("id", 1, Int.MAX_VALUE), f.slot())
        else -> null
    }

    private fun iceServer(f: Fields) = IceServerSpec(
        urls = f.list("urls", 1, MAX_URLS) { item ->
            item.string(1, MAX_URL_CHARS).also { url -> if (iceSchemes.none { url.startsWith(it) }) throw Rejected }
        },
        username = f.optionalString("username", MAX_CREDENTIAL_CHARS),
        credential = f.optionalString("credential", MAX_CREDENTIAL_CHARS),
    )

    private fun candidate(f: Fields) = IceCandidateSpec(
        candidate = f.string("candidate", 0, MAX_CANDIDATE_CHARS),
        sdpMid = f.optionalString("sdpMid", MAX_CANDIDATE_CHARS),
        sdpMLineIndex = f.optionalInt("sdpMLineIndex", 0, MAX_M_LINE_INDEX),
        usernameFragment = f.optionalString("usernameFragment", MAX_CANDIDATE_CHARS),
    )

    private fun isMicIdChar(c: Char) = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '_' || c == '-'

    private fun JsonWriter.peerStats(s: AppMessage.PeerStats) {
        put("peer", s.peer)
        put("jitterBufferDelay", s.jitterBufferDelay)
        put("jitterBufferEmittedCount", s.jitterBufferEmittedCount)
        put("jitterBufferTargetDelay", s.jitterBufferTargetDelay)
        put("packetsReceived", s.packetsReceived)
        put("packetsLost", s.packetsLost)
        put("concealedSamples", s.concealedSamples)
        put("concealmentEvents", s.concealmentEvents)
        put("insertedSamplesForDeceleration", s.insertedSamplesForDeceleration)
        put("removedSamplesForAcceleration", s.removedSamplesForAcceleration)
        put("jitter", s.jitter)
        put("roundTripTimeMs", s.roundTripTimeMs)
        put("candidateType", s.candidateType?.wire)
    }

    private fun JsonWriter.slotStatus(s: SlotStatusMsg) {
        put("slot", s.slot)
        put("attached", s.attached)
        put("monitored", s.monitored)
        put("muted", s.muted)
        put("levelRms", s.levelRms)
        put("gateOpen", s.gateOpen)
        put("gateThreshold", s.gateThreshold)
        put("feedbackHz", s.feedbackHz)
        put("boostDb", s.boostDb)
        key("echo").obj {
            put("delayMs", s.echo.delayMs)
            put("dryGain", s.echo.dryGain)
            put("wetGain", s.echo.wetGain)
            put("late", s.echo.late)
        }
        key("mix").obj {
            put("volume", s.mix.volume)
            put("echo", s.mix.echo)
        }
        put("fillMs", s.fillMs)
        put("outRms", s.outRms)
        put("monitorMs", s.monitorMs)
    }

    private fun JsonWriter.engineStats(s: EngineStatsMsg) {
        put("open", s.open)
        put("outputLatencyMs", s.outputLatencyMs)
        put("burstFrames", s.burstFrames)
        put("bufferFrames", s.bufferFrames)
        put("xruns", s.xruns)
        put("restarts", s.restarts)
        put("openAttempts", s.openAttempts)
        put("callbackP99Us", s.callbackP99Us)
        put("callbackMaxUs", s.callbackMaxUs)
        put("pushIntervalP50Us", s.pushIntervalP50Us)
        put("pushIntervalP99Us", s.pushIntervalP99Us)
        put("pushIntervalMaxUs", s.pushIntervalMaxUs)
        put("pushToPresentP50Ms", s.pushToPresentP50Ms)
        put("pushToPresentP95Ms", s.pushToPresentP95Ms)
        put("tapDropped", s.tapDropped)
        put("tapDrainP99Us", s.tapDrainP99Us)
        put("tapDrainMaxUs", s.tapDrainMaxUs)
        put("conceals", s.conceals)
        put("resyncs", s.resyncs)
        put("concealedFrames", s.concealedFrames)
        put("silentFrames", s.silentFrames)
        put("clampHits", s.clampHits)
        put("ratioMinPpm", s.ratioMinPpm)
        put("ratioMaxPpm", s.ratioMaxPpm)
        put("longestConcealUs", s.longestConcealUs)
        put("callbackBusyPermille", s.callbackBusyPermille)
        put("callbackGapMaxUs", s.callbackGapMaxUs)
        put("outputStalls", s.outputStalls)
        put("pushGaps20", s.pushGaps20)
        put("pushIntervals", s.pushIntervals)
        put("callbacksOver2ms", s.callbacksOver2ms)
        put("tapDrainsOver25ms", s.tapDrainsOver25ms)
        put("tapDrains", s.tapDrains)
        put("peak", s.peak)
        put("sinkErrors", s.sinkErrors)
        put("ignored", s.ignored)
        put("apm", s.apm)
        key("slots").arr {
            s.slots.forEach { slot ->
                obj {
                    put("slot", slot.slot)
                    put("underruns", slot.underruns)
                    put("droppedFrames", slot.droppedFrames)
                    put("lowWaterMs", slot.lowWaterMs)
                }
            }
        }
    }

    /** At most [max] UTF-16 units, never splitting a surrogate pair. */
    private fun clip(text: String, max: Int): String {
        if (text.length <= max) return text
        val end = if (Character.isHighSurrogate(text[max - 1])) max - 1 else max
        return text.substring(0, end)
    }
}

/** A connection's order rule: the first page message is `hello`, and `hello` comes only once. */
class HelloGate {
    private var greeted = false

    fun admit(result: ParseResult): ParseResult = when (result) {
        is ParseResult.Fatal -> result
        ParseResult.Ignored -> if (greeted) result else ParseResult.Fatal(DoorCodec.CLOSE_POLICY)
        is ParseResult.Message -> {
            val hello = result.message is PageMessage.Hello
            when {
                hello && greeted -> ParseResult.Fatal(DoorCodec.CLOSE_POLICY)
                !hello && !greeted -> ParseResult.Fatal(DoorCodec.CLOSE_POLICY)
                else -> {
                    greeted = true
                    result
                }
            }
        }
    }
}

/** The page's HTTP upgrade request (RFC 6455 §4.2.1) and the door's reply. */
object WsHandshake {
    const val BAD_REQUEST = "400 Bad Request"
    const val FORBIDDEN = "403 Forbidden"
    const val UPGRADE_REQUIRED = "426 Upgrade Required"

    private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    private const val KEY_BYTES = 16
    private val once = setOf("origin", "upgrade", "connection", "sec-websocket-key", "sec-websocket-version")

    sealed class Result {
        data class Accept(val accept: String) : Result()

        data class Refuse(val status: String) : Result()
    }

    /**
     * [head]: the request line, then the header lines. [target]: the only path and query served, token
     * included. [origin]: the only page origin allowed, or null while there is none.
     */
    fun check(head: List<String>, target: String, origin: String?): Result {
        val request = head.firstOrNull()?.split(' ') ?: return Result.Refuse(BAD_REQUEST)
        if (request.size != 3 || request[0] != "GET" || request[2] != "HTTP/1.1") return Result.Refuse(BAD_REQUEST)
        val headers = HashMap<String, String>()
        for (line in head.drop(1)) {
            val colon = line.indexOf(':')
            if (colon <= 0) return Result.Refuse(BAD_REQUEST)
            val name = line.substring(0, colon).trim().lowercase()
            if (headers.put(name, line.substring(colon + 1).trim()) != null && name in once) {
                return Result.Refuse(BAD_REQUEST)
            }
        }
        if (!MessageDigest.isEqual(request[1].toByteArray(), target.toByteArray())) return Result.Refuse(FORBIDDEN)
        if (origin == null || headers["origin"] != origin) return Result.Refuse(FORBIDDEN)
        if (!headers["upgrade"].equals("websocket", ignoreCase = true)) return Result.Refuse(BAD_REQUEST)
        val connection = headers["connection"]?.split(',') ?: return Result.Refuse(BAD_REQUEST)
        if (connection.none { it.trim().equals("upgrade", ignoreCase = true) }) return Result.Refuse(BAD_REQUEST)
        if (headers["sec-websocket-version"] != "13") return Result.Refuse(UPGRADE_REQUIRED)
        val key = headers["sec-websocket-key"] ?: return Result.Refuse(BAD_REQUEST)
        val nonce = try {
            Base64.getDecoder().decode(key)
        } catch (_: IllegalArgumentException) {
            return Result.Refuse(BAD_REQUEST)
        }
        if (nonce.size != KEY_BYTES) return Result.Refuse(BAD_REQUEST)
        return Result.Accept(acceptKey(key))
    }

    fun acceptKey(key: String): String {
        val digest = MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.US_ASCII))
        return Base64.getEncoder().encodeToString(digest)
    }

    fun switching(accept: String): ByteArray =
        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $accept\r\n\r\n").toByteArray(Charsets.US_ASCII)

    fun refusal(status: String): ByteArray {
        val version = if (status == UPGRADE_REQUIRED) "Sec-WebSocket-Version: 13\r\n" else ""
        return "HTTP/1.1 $status\r\n${version}Content-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII)
    }
}

/** Server frames (RFC 6455 §5.2): final, unmasked, with the shortest of the 7-, 16- and 64-bit lengths. */
object WsFrames {
    const val OP_CONTINUATION = 0x0
    const val OP_TEXT = 0x1
    const val OP_BINARY = 0x2
    const val OP_CLOSE = 0x8
    const val OP_PING = 0x9
    const val OP_PONG = 0xA
    const val MAX_CONTROL = 125

    fun write(out: OutputStream, opcode: Int, payload: ByteArray, offset: Int = 0, length: Int = payload.size) {
        out.write(0x80 or opcode)
        when {
            length <= MAX_CONTROL -> out.write(length)
            length <= 0xffff -> {
                out.write(126)
                out.write(length ushr 8)
                out.write(length and 0xff)
            }
            else -> {
                out.write(127)
                for (shift in 56 downTo 0 step 8) out.write(((length.toLong() ushr shift) and 0xff).toInt())
            }
        }
        out.write(payload, offset, length)
    }

    fun closePayload(code: Int): ByteArray = byteArrayOf((code ushr 8).toByte(), code.toByte())

    /** The status codes a close frame may carry (RFC 6455 §7.4, IANA registry). */
    fun validCloseCode(code: Int): Boolean = code in 1000..1003 || code in 1007..1014 || code in 3000..4999
}

/** One event from the page's side of the WebSocket. */
sealed class WsEvent {
    data class Text(val text: String) : WsEvent()

    class Ping(val payload: ByteArray) : WsEvent()

    data object Pong : WsEvent()

    /** The page's close frame; [code] is [DoorCodec.CLOSE_NO_STATUS] when it carried none. */
    data class Close(val code: Int) : WsEvent()

    /** The page broke the protocol: close with [code]. */
    data class Fail(val code: Int) : WsEvent()
}

/**
 * Reads the page's frames (client to server, so masked). Text messages are joined across continuation frames up
 * to [maxMessage] bytes; control frames may arrive between them. [next] throws [IOException] at the end of the
 * stream. After a [WsEvent.Fail] the stream is no longer in step with the frames.
 */
class WsReader(private val input: InputStream, maxMessage: Int = DoorCodec.MAX_MESSAGE) {
    private val message = ByteArray(maxMessage)
    private var size = 0
    private var continuing = false
    private val mask = ByteArray(4)
    private val control = ByteArray(WsFrames.MAX_CONTROL)
    private val utf8 = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)

    fun next(): WsEvent {
        while (true) {
            val first = byte()
            val second = byte()
            val fin = (first and 0x80) != 0
            val opcode = first and 0x0f
            if ((first and 0x70) != 0 || (second and 0x80) == 0) return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
            val length = when (val small = second and 0x7f) {
                126 -> ((byte() shl 8) or byte()).toLong()
                127 -> long()
                else -> small.toLong()
            }
            if (length < 0) return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
            if (opcode >= OP_FIRST_CONTROL) {
                if (!fin || length > WsFrames.MAX_CONTROL) return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
                val n = length.toInt()
                payload(control, 0, n)
                return when (opcode) {
                    WsFrames.OP_CLOSE -> close(n)
                    WsFrames.OP_PING -> WsEvent.Ping(control.copyOf(n))
                    WsFrames.OP_PONG -> WsEvent.Pong
                    else -> WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
                }
            }
            when (opcode) {
                WsFrames.OP_TEXT -> if (continuing) return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
                WsFrames.OP_CONTINUATION -> if (!continuing) return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
                WsFrames.OP_BINARY -> return WsEvent.Fail(DoorCodec.CLOSE_UNSUPPORTED)
                else -> return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
            }
            if (length > message.size - size) return WsEvent.Fail(DoorCodec.CLOSE_TOO_BIG)
            val n = length.toInt()
            payload(message, size, n)
            size += n
            continuing = !fin
            if (continuing) continue
            val total = size
            size = 0
            return text(message, 0, total)?.let { WsEvent.Text(it) } ?: WsEvent.Fail(DoorCodec.CLOSE_BAD_DATA)
        }
    }

    private fun close(n: Int): WsEvent {
        if (n == 0) return WsEvent.Close(DoorCodec.CLOSE_NO_STATUS)
        if (n == 1) return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
        val code = ((control[0].toInt() and 0xff) shl 8) or (control[1].toInt() and 0xff)
        if (!WsFrames.validCloseCode(code)) return WsEvent.Fail(DoorCodec.CLOSE_PROTOCOL)
        if (text(control, 2, n - 2) == null) return WsEvent.Fail(DoorCodec.CLOSE_BAD_DATA)
        return WsEvent.Close(code)
    }

    private fun text(bytes: ByteArray, offset: Int, length: Int): String? = try {
        utf8.decode(ByteBuffer.wrap(bytes, offset, length)).toString()
    } catch (_: CharacterCodingException) {
        null
    }

    private fun payload(into: ByteArray, offset: Int, length: Int) {
        fill(mask, 0, 4)
        fill(into, offset, length)
        for (i in 0 until length) {
            into[offset + i] = (into[offset + i].toInt() xor mask[i and 3].toInt()).toByte()
        }
    }

    private fun byte(): Int {
        val b = input.read()
        if (b < 0) throw IOException("closed")
        return b
    }

    private fun long(): Long {
        var value = 0L
        repeat(8) { value = (value shl 8) or byte().toLong() }
        return value
    }

    private fun fill(into: ByteArray, offset: Int, length: Int) {
        var read = 0
        while (read < length) {
            val n = input.read(into, offset + read, length - read)
            if (n < 0) throw IOException("closed")
            read += n
        }
    }

    private companion object {
        const val OP_FIRST_CONTROL = 0x8
    }
}

/** A page message that breaks the protocol's rules. */
private object Rejected : RuntimeException("rejected", null, false, false)

private sealed class Json {
    class Obj(val fields: Map<String, Json>) : Json()

    class Arr(val items: List<Json>) : Json()

    class Str(val value: String) : Json()

    class Num(val value: Double) : Json()

    class Bool(val value: Boolean) : Json()

    data object Null : Json()

    fun int(min: Int, max: Int): Int {
        val n = number()
        if (n != Math.rint(n) || n < min || n > max) throw Rejected
        return n.toInt()
    }

    fun double(min: Double, max: Double): Double {
        val n = number()
        if (n < min || n > max) throw Rejected
        return n
    }

    fun string(minChars: Int, maxChars: Int): String {
        if (this !is Str || value.length < minChars || value.length > maxChars) throw Rejected
        return value
    }

    fun bool(): Boolean {
        if (this !is Bool) throw Rejected
        return value
    }

    private fun number(): Double {
        if (this !is Num || !value.isFinite()) throw Rejected
        return value
    }
}

/** Whether any object of one message carried a field this version does not read. */
private class Scope {
    var unknown = false
}

/** One JSON object's fields, read by name; [done] notes the names nobody read. */
private class Fields(private val values: Map<String, Json>, private val scope: Scope) {
    private val read = HashSet<String>()

    fun required(name: String): Json {
        read.add(name)
        return values[name] ?: throw Rejected
    }

    /** The key must be present; JSON null reads as null. */
    fun nullable(name: String): Json? = required(name).takeUnless { it is Json.Null }

    /** The key may be absent or null. */
    fun optional(name: String): Json? {
        read.add(name)
        return values[name]?.takeUnless { it is Json.Null }
    }

    fun int(name: String, min: Int, max: Int) = required(name).int(min, max)

    fun double(name: String, min: Double, max: Double) = required(name).double(min, max)

    fun bool(name: String) = required(name).bool()

    fun string(name: String, minChars: Int, maxChars: Int) = required(name).string(minChars, maxChars)

    fun optionalString(name: String, maxChars: Int) = optional(name)?.string(0, maxChars)

    fun optionalInt(name: String, min: Int, max: Int) = optional(name)?.int(min, max)

    fun slot() = int("slot", 1, MIC_SLOTS)

    fun peer() = int("peer", 1, Int.MAX_VALUE)

    fun <T> list(name: String, min: Int, max: Int, item: (Json) -> T): List<T> {
        val value = required(name)
        if (value !is Json.Arr || value.items.size < min || value.items.size > max) throw Rejected
        return value.items.map(item)
    }

    fun <T> nested(value: Json, read: (Fields) -> T): T {
        if (value !is Json.Obj) throw Rejected
        val child = Fields(value.fields, scope)
        return read(child).also { child.done() }
    }

    fun done() {
        if (values.keys.any { it !in read }) scope.unknown = true
    }

    private companion object {
        const val MIC_SLOTS = 4
    }
}

/** Strict RFC 8259: no comments, no single quotes, no NaN, no trailing commas, no duplicate keys. */
private class JsonReader(private val text: String) {
    private var at = 0

    fun document(): Json {
        val value = value(0)
        space()
        if (at != text.length) throw Rejected
        return value
    }

    private fun value(depth: Int): Json {
        space()
        return when (peek()) {
            '{' -> obj(depth + 1)
            '[' -> arr(depth + 1)
            '"' -> Json.Str(string())
            't' -> literal("true", Json.Bool(true))
            'f' -> literal("false", Json.Bool(false))
            'n' -> literal("null", Json.Null)
            else -> number()
        }
    }

    private fun obj(depth: Int): Json {
        if (depth > MAX_DEPTH) throw Rejected
        at++
        val fields = HashMap<String, Json>()
        space()
        if (peek() == '}') {
            at++
            return Json.Obj(fields)
        }
        while (true) {
            space()
            if (peek() != '"') throw Rejected
            val name = string()
            space()
            expect(':')
            if (fields.put(name, value(depth)) != null) throw Rejected
            space()
            when (take()) {
                ',' -> continue
                '}' -> return Json.Obj(fields)
                else -> throw Rejected
            }
        }
    }

    private fun arr(depth: Int): Json {
        if (depth > MAX_DEPTH) throw Rejected
        at++
        val items = ArrayList<Json>()
        space()
        if (peek() == ']') {
            at++
            return Json.Arr(items)
        }
        while (true) {
            items.add(value(depth))
            space()
            when (take()) {
                ',' -> continue
                ']' -> return Json.Arr(items)
                else -> throw Rejected
            }
        }
    }

    private fun string(): String {
        at++
        val out = StringBuilder()
        while (true) {
            val c = take()
            when {
                c == '"' -> return out.toString()
                c == '\\' -> escape(out)
                c < ' ' -> throw Rejected
                else -> out.append(c)
            }
        }
    }

    private fun escape(out: StringBuilder) {
        when (take()) {
            '"' -> out.append('"')
            '\\' -> out.append('\\')
            '/' -> out.append('/')
            'b' -> out.append('\b')
            'f' -> out.append('\u000C')
            'n' -> out.append('\n')
            'r' -> out.append('\r')
            't' -> out.append('\t')
            'u' -> {
                var code = 0
                repeat(4) {
                    val digit = Character.digit(take(), 16)
                    if (digit < 0) throw Rejected
                    code = (code shl 4) or digit
                }
                out.append(code.toChar())
            }
            else -> throw Rejected
        }
    }

    private fun number(): Json {
        val start = at
        if (peek() == '-') at++
        when (peek()) {
            '0' -> at++
            in '1'..'9' -> digits()
            else -> throw Rejected
        }
        if (peek() == '.') {
            at++
            if (peek() !in '0'..'9') throw Rejected
            digits()
        }
        if (peek() == 'e' || peek() == 'E') {
            at++
            if (peek() == '+' || peek() == '-') at++
            if (peek() !in '0'..'9') throw Rejected
            digits()
        }
        return Json.Num(text.substring(start, at).toDouble())
    }

    private fun digits() {
        while (peek() in '0'..'9') at++
    }

    private fun literal(word: String, value: Json): Json {
        if (!text.startsWith(word, at)) throw Rejected
        at += word.length
        return value
    }

    private fun expect(c: Char) {
        if (take() != c) throw Rejected
    }

    private fun space() {
        while (at < text.length && (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r')) at++
    }

    private fun peek(): Char = if (at < text.length) text[at] else END

    private fun take(): Char {
        if (at >= text.length) throw Rejected
        return text[at++]
    }

    private companion object {
        const val MAX_DEPTH = 32
        const val END = '\u0000'
    }
}

/** App messages as compact JSON. Non-finite numbers are written as null, as JSON.stringify does. */
private class JsonWriter {
    private val out = StringBuilder(256)
    private var comma = false

    fun key(name: String): JsonWriter {
        separate()
        quote(name)
        out.append(':')
        comma = false
        return this
    }

    fun obj(block: JsonWriter.() -> Unit) {
        separate()
        out.append('{')
        comma = false
        block(this)
        out.append('}')
        comma = true
    }

    fun arr(block: JsonWriter.() -> Unit) {
        separate()
        out.append('[')
        comma = false
        block(this)
        out.append(']')
        comma = true
    }

    fun value(text: String?) {
        separate()
        if (text == null) out.append("null") else quote(text)
        comma = true
    }

    fun put(name: String, text: String?) = key(name).value(text)

    fun put(name: String, flag: Boolean) {
        key(name)
        out.append(flag)
        comma = true
    }

    fun put(name: String, number: Int?) {
        key(name)
        if (number == null) out.append("null") else out.append(number)
        comma = true
    }

    fun put(name: String, number: Long) {
        key(name)
        out.append(number)
        comma = true
    }

    fun put(name: String, number: Double?) {
        key(name)
        when {
            number == null || !number.isFinite() -> out.append("null")
            number == Math.rint(number) && Math.abs(number) < EXACT_LONG -> out.append(number.toLong())
            else -> out.append(number)
        }
        comma = true
    }

    override fun toString(): String = out.toString()

    private fun separate() {
        if (comma) out.append(',')
    }

    private fun quote(text: String) {
        out.append('"')
        for (c in text) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append("\\u00").append(HEX[c.code shr 4]).append(HEX[c.code and 0xf])
                else -> out.append(c)
            }
        }
        out.append('"')
    }

    private companion object {
        const val EXACT_LONG = 1e15
        const val HEX = "0123456789abcdef"
    }
}
