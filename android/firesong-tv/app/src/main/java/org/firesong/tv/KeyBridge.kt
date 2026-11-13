package org.firesong.tv

import android.view.KeyEvent

/**
 * Maps Fire TV remote keys onto the keys the web client listens for.
 *
 * The client reads only `KeyboardEvent.key`:
 * - `nav-input-context.tsx` (capture listener on window): ArrowUp/Down/Left/Right,
 *   Enter = confirm, Escape = back;
 * - `use-playback-input.ts`: " " (space) toggles pause/continue during a song.
 *
 * D-pad keys reach the page natively as Arrow keys. The others are translated
 * here into another Android key code and dispatched to the WebView, so the page
 * still receives trusted DOM events (no script injection, no client change).
 */
object KeyBridge {
    /** Hold Back at least this long to get the exit prompt instead of Escape. */
    const val LONG_PRESS_MS = 700L

    private val TRANSLATIONS: Map<Int, Int> = mapOf(
        // Play/Pause on the remote = the client's space-bar pause toggle. Fire TV
        // remotes send PLAY_PAUSE; some keyboards/remotes send PLAY or PAUSE.
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to KeyEvent.KEYCODE_SPACE,
        KeyEvent.KEYCODE_MEDIA_PLAY to KeyEvent.KEYCODE_SPACE,
        KeyEvent.KEYCODE_MEDIA_PAUSE to KeyEvent.KEYCODE_SPACE,
    )

    /** The key code the WebView should see for [keyCode] (Back is handled by [BackKeyTracker]). */
    fun translate(keyCode: Int): Int = TRANSLATIONS[keyCode] ?: keyCode

    fun isTranslated(keyCode: Int): Boolean = TRANSLATIONS.containsKey(keyCode)

    /** Back becomes Escape (the client's "back"), sent on release unless it was a long press. */
    const val BACK_TARGET = KeyEvent.KEYCODE_ESCAPE
}

/**
 * Short press of Back = Escape for the page; long press = native exit prompt.
 * The Escape is sent on key-up, so a long press never also sends Escape.
 */
class BackKeyTracker(private val longPressMs: Long = KeyBridge.LONG_PRESS_MS) {
    enum class Action { NONE, SEND_ESCAPE, SHOW_EXIT }

    private var downAt = -1L
    private var longFired = false

    fun onDown(eventTime: Long, repeatCount: Int, longPressFlag: Boolean): Action {
        if (repeatCount == 0) {
            downAt = eventTime
            longFired = false
            return Action.NONE
        }
        if (downAt >= 0 && !longFired && (longPressFlag || eventTime - downAt >= longPressMs)) {
            longFired = true
            return Action.SHOW_EXIT
        }
        return Action.NONE
    }

    fun onUp(eventTime: Long): Action {
        val start = downAt
        val fired = longFired
        downAt = -1L
        longFired = false
        return when {
            start < 0 -> Action.NONE // the press began in another window (e.g. a dialog)
            fired -> Action.NONE
            // Remotes that send no auto-repeat: decide on release.
            eventTime - start >= longPressMs -> Action.SHOW_EXIT
            else -> Action.SEND_ESCAPE
        }
    }

    fun reset() {
        downAt = -1L
        longFired = false
    }
}
