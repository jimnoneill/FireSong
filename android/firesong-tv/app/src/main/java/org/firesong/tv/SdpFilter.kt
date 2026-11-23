package org.firesong.tv

/**
 * The checks a phone's offer passes before libwebrtc parses it, and its reduction to Opus only: one
 * audio section over UDP/TLS/RTP/SAVPF, no video or data channel, bounded line count and length.
 * Candidates naming a host other than an IP literal or a `.local` name are dropped, so a guest never
 * makes the app look a name up. Rejection reasons name the rule, never SDP content.
 */
object SdpFilter {
    const val MAX_LINES = 300
    const val MAX_LINE_CHARS = 1024

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
    private val IPV4_OCTET = Regex("25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d")
    private val IPV6_GROUP = Regex("[0-9A-Fa-f]{1,4}")
    private val MDNS_NAME = Regex("[A-Za-z0-9-]{1,63}\\.local")

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

        val kept = lines.mapIndexedNotNull { index, line ->
            when {
                index == mediaIndex -> "${media[0]} ${media[1]} ${media[2]} $opus"
                PAYLOAD_LINE.matchEntire(line)?.groupValues?.get(1).let { it != null && it != opus } -> null
                line.startsWith(CANDIDATE_LINE) && !candidateAllowed(line.removePrefix("a=")) -> null
                else -> line
            }
        }
        return Result.Accepted(kept.joinToString("\r\n", postfix = "\r\n"))
    }

    /** A `candidate:` value whose address is an IPv4 or IPv6 literal or a one-label `.local` name. */
    fun candidateAllowed(candidate: String): Boolean {
        if (!candidate.startsWith("candidate:")) return false
        val address = candidate.split(' ').getOrNull(CANDIDATE_ADDRESS_FIELD) ?: return false
        return isIpv4(address) || isIpv6(address) || MDNS_NAME.matches(address)
    }

    private fun isIpv4(address: String): Boolean {
        val octets = address.split('.')
        return octets.size == 4 && octets.all { IPV4_OCTET.matches(it) }
    }

    /** RFC 4291 text form: eight groups, or fewer around one `::`, optionally ending in a dotted IPv4. */
    private fun isIpv6(address: String): Boolean {
        val halves = address.split("::")
        if (halves.size > 2) return false
        val last = halves.last()
        val ipv4Tail = last.isNotEmpty() && isIpv4(last.substringAfterLast(':'))
        val parts = halves.flatMap { if (it.isEmpty()) emptyList() else it.split(':') }
        val groups = if (ipv4Tail) parts.dropLast(1) else parts
        if (!groups.all { IPV6_GROUP.matches(it) }) return false
        val count = groups.size + if (ipv4Tail) 2 else 0
        return if (halves.size == 2) count < IPV6_GROUPS else count == IPV6_GROUPS
    }
}
