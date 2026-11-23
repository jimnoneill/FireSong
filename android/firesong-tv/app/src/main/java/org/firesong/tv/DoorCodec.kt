package org.firesong.tv

/** One page text frame: a message, something tolerated and counted, or a reason to close with [Fatal.code]. */
sealed class ParseResult {
    /** [unknownFields]: the frame also carried fields this version does not know, at any depth. */
    data class Message(val message: PageMessage, val unknownFields: Boolean = false) : ParseResult()

    data object Ignored : ParseResult()

    data class Fatal(val code: Int) : ParseResult()
}

/** The JSON of the voice door: page frames in, app messages out. */
object DoorCodec {
    const val CLOSE_POLICY = 1008

    fun parsePage(text: String): ParseResult = ParseResult.Fatal(CLOSE_POLICY)

    fun encode(message: AppMessage): String = ""
}
