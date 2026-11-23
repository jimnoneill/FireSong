package org.firesong.tv

/**
 * The checks a phone's offer passes before libwebrtc parses it, and its reduction to Opus only: one
 * audio section over UDP/TLS/RTP/SAVPF, no video or data channel, bounded line count and length.
 * Only candidates whose address is a unicast IP literal are kept, at most [MAX_CANDIDATES] of them: a name,
 * `.local` included, would make the app look it up, and a loopback, multicast or link-local address would aim
 * the app's connectivity checks at itself or the whole LAN. Rejection reasons name the rule, never SDP content.
 */
object SdpFilter {
    const val MAX_LINES = 300
    const val MAX_LINE_CHARS = 1024
    const val MAX_CANDIDATES = 16

    sealed class Result {
        /** The offer with only the Opus payload type left in its audio section. */
        data class Accepted(val sdp: String) : Result()

        data class Rejected(val reason: String) : Result()
    }

    private const val AUDIO_PROTOCOL = "UDP/TLS/RTP/SAVPF"
    private val LINE_BREAK = Regex("\r?\n")
    private val OPUS_RTPMAP = Regex("a=rtpmap:(\\d+) opus/48000/2", RegexOption.IGNORE_CASE)
    private val PAYLOAD_LINE = Regex("a=(?:rtpmap|fmtp|rtcp-fb):(\\d+)(?: .*)?")
    private val DATA_CHANNEL_ATTRIBUTES = listOf("a=sctp-port", "a=sctpmap", "a=max-message-size")
    private const val CANDIDATE_LINE = "a=candidate:"
    private const val CANDIDATE_ADDRESS_FIELD = 4
    private const val IPV6_GROUPS = 8
    private const val HEX = 16
    private const val BYTE = 0xff
    private const val LOOPBACK_V4 = 127
    private const val LINK_LOCAL_V4_FIRST = 169
    private const val LINK_LOCAL_V4_SECOND = 254
    private const val MULTICAST_V4 = 224
    private const val MULTICAST_V6_MASK = 0xff00
    private const val LINK_LOCAL_V6_MASK = 0xffc0
    private const val LINK_LOCAL_V6 = 0xfe80
    private const val MAPPED_V6 = 0xffff
    private val IPV4_OCTET = Regex("25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d")
    private val IPV6_GROUP = Regex("[0-9A-Fa-f]{1,4}")

    fun filter(sdp: String): Result {
        val lines = sdp.split(LINE_BREAK).let { if (it.lastOrNull() == "") it.dropLast(1) else it }
        if (lines.size > MAX_LINES) return Result.Rejected("more than $MAX_LINES lines")
        if (lines.any { it.length > MAX_LINE_CHARS }) return Result.Rejected("a line longer than $MAX_LINE_CHARS chars")
        if (lines.any { it.startsWith("m=video") }) return Result.Rejected("video section")
        if (lines.any { it.startsWith("m=application") }) return Result.Rejected("data channel section")
        if (lines.any { line -> DATA_CHANNEL_ATTRIBUTES.any { line.startsWith(it) } }) {
            return Result.Rejected("data channel attribute")
        }

        val mediaIndex = lines.indexOfFirst { it.startsWith("m=") }
        if (mediaIndex < 0 || lines.count { it.startsWith("m=") } != 1) return Result.Rejected("not exactly one media section")
        val media = lines[mediaIndex].split(' ')
        if (media.size < 4 || media[0] != "m=audio" || media[2] != AUDIO_PROTOCOL) {
            return Result.Rejected("not an audio section over $AUDIO_PROTOCOL")
        }

        val opusTypes = lines.mapNotNull { OPUS_RTPMAP.matchEntire(it)?.groupValues?.get(1) }.toSet()
        val opus = media.drop(3).firstOrNull { it in opusTypes } ?: return Result.Rejected("no opus/48000/2")

        var candidates = 0
        val kept = lines.mapIndexedNotNull { index, line ->
            when {
                index == mediaIndex -> "${media[0]} ${media[1]} ${media[2]} $opus"
                PAYLOAD_LINE.matchEntire(line)?.groupValues?.get(1).let { it != null && it != opus } -> null
                line.startsWith(CANDIDATE_LINE) ->
                    line.takeIf { candidateAllowed(line.removePrefix("a=")) && ++candidates <= MAX_CANDIDATES }
                else -> line
            }
        }
        return Result.Accepted(kept.joinToString("\r\n", postfix = "\r\n"))
    }

    /** A `candidate:` value whose address is a unicast IPv4 or IPv6 literal. */
    fun candidateAllowed(candidate: String): Boolean {
        if (!candidate.startsWith("candidate:")) return false
        val address = candidate.split(' ').getOrNull(CANDIDATE_ADDRESS_FIELD) ?: return false
        ipv4(address)?.let { return unicastIpv4(it) }
        return ipv6(address)?.let(::unicastIpv6) ?: false
    }

    private fun ipv4(address: String): List<Int>? {
        val octets = address.split('.')
        return if (octets.size == 4 && octets.all { IPV4_OCTET.matches(it) }) octets.map { it.toInt() } else null
    }

    /** RFC 4291 text form as eight groups: eight, or fewer around one `::`, optionally ending in a dotted IPv4. */
    private fun ipv6(address: String): List<Int>? {
        val halves = address.split("::")
        if (halves.size > 2) return null
        val parts = halves.map { half -> if (half.isEmpty()) emptyList() else half.split(':') }
        val tail = parts.last().lastOrNull()?.let(::ipv4)
        val tailGroups = tail?.let { listOf(it[0] shl 8 or it[1], it[2] shl 8 or it[3]) } ?: emptyList()
        val texts = if (tail == null) parts else parts.dropLast(1) + listOf(parts.last().dropLast(1))
        if (!texts.all { half -> half.all { IPV6_GROUP.matches(it) } }) return null
        val head = texts.first().map { it.toInt(HEX) }
        val rest = texts.drop(1).flatten().map { it.toInt(HEX) } + tailGroups
        val count = head.size + rest.size
        return when {
            halves.size == 2 && count < IPV6_GROUPS -> head + List(IPV6_GROUPS - count) { 0 } + rest
            halves.size == 1 && count == IPV6_GROUPS -> head + rest
            else -> null
        }
    }

    /** Not 0.0.0.0/8, loopback, link-local, multicast, reserved or broadcast. */
    private fun unicastIpv4(octets: List<Int>): Boolean {
        val first = octets[0]
        val linkLocal = first == LINK_LOCAL_V4_FIRST && octets[1] == LINK_LOCAL_V4_SECOND
        return first != 0 && first != LOOPBACK_V4 && first < MULTICAST_V4 && !linkLocal
    }

    /** Not multicast or link-local; the IPv4-compatible and IPv4-mapped forms (`::`, `::1` among them) as IPv4. */
    private fun unicastIpv6(groups: List<Int>): Boolean {
        val first = groups[0]
        if ((first and MULTICAST_V6_MASK) == MULTICAST_V6_MASK) return false
        if ((first and LINK_LOCAL_V6_MASK) == LINK_LOCAL_V6) return false
        if (groups.take(5).all { it == 0 } && (groups[5] == 0 || groups[5] == MAPPED_V6)) {
            return unicastIpv4(listOf(groups[6] shr 8, groups[6] and BYTE, groups[7] shr 8, groups[7] and BYTE))
        }
        return true
    }
}
