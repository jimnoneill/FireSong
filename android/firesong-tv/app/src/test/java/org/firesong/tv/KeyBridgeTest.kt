package org.firesong.tv

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyBridgeTest {
    @Test fun androidKeyCodesAreTheOnesWeExpect() {
        // Guards against a wrong constant: values from the Android KeyEvent docs.
        assertEquals(4, KeyEvent.KEYCODE_BACK)
        assertEquals(62, KeyEvent.KEYCODE_SPACE)
        assertEquals(85, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
        assertEquals(111, KeyEvent.KEYCODE_ESCAPE)
        assertEquals(126, KeyEvent.KEYCODE_MEDIA_PLAY)
        assertEquals(127, KeyEvent.KEYCODE_MEDIA_PAUSE)
    }

    @Test fun mediaKeysBecomeSpace() {
        for (k in listOf(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE)) {
            assertEquals(KeyEvent.KEYCODE_SPACE, KeyBridge.translate(k))
            assertTrue(KeyBridge.isTranslated(k))
        }
    }

    @Test fun dpadAndOtherKeysPassThrough() {
        for (k in listOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_REWIND,
        )) {
            assertEquals(k, KeyBridge.translate(k))
            assertFalse(KeyBridge.isTranslated(k))
        }
        assertEquals(KeyEvent.KEYCODE_ESCAPE, KeyBridge.BACK_TARGET)
    }

    @Test fun shortBackSendsEscapeOnRelease() {
        val t = BackKeyTracker(700)
        assertEquals(BackKeyTracker.Action.NONE, t.onDown(1000, 0, false))
        assertEquals(BackKeyTracker.Action.SEND_ESCAPE, t.onUp(1100))
    }

    @Test fun heldBackWithRepeatsShowsExitOnceAndNoEscape() {
        val t = BackKeyTracker(700)
        t.onDown(1000, 0, false)
        assertEquals(BackKeyTracker.Action.NONE, t.onDown(1400, 1, false))
        assertEquals(BackKeyTracker.Action.SHOW_EXIT, t.onDown(1750, 2, false))
        assertEquals(BackKeyTracker.Action.NONE, t.onDown(1800, 3, false))
        assertEquals(BackKeyTracker.Action.NONE, t.onUp(1900))
    }

    @Test fun longPressFlagShowsExitImmediately() {
        val t = BackKeyTracker(700)
        t.onDown(1000, 0, false)
        assertEquals(BackKeyTracker.Action.SHOW_EXIT, t.onDown(1010, 1, true))
        assertEquals(BackKeyTracker.Action.NONE, t.onUp(1020))
    }

    @Test fun heldBackWithoutRepeatsDecidesOnRelease() {
        val t = BackKeyTracker(700)
        t.onDown(1000, 0, false)
        assertEquals(BackKeyTracker.Action.SHOW_EXIT, t.onUp(1800))
    }

    @Test fun releaseWithoutPressIsIgnored() {
        val t = BackKeyTracker(700)
        assertEquals(BackKeyTracker.Action.NONE, t.onUp(1000))
        t.onDown(2000, 0, false)
        t.reset()
        assertEquals(BackKeyTracker.Action.NONE, t.onUp(2100))
    }
}
