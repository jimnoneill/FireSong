package org.firesong.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageLifecycleTest {
    @Test fun pageLivesOnlyWhileStarted() {
        val life = PageLifecycle()
        assertEquals(PageLifecycle.Action.BUILD_AND_LOAD, life.onStart())
        assertTrue(life.started)
        // HOME, another app, the Cube going to sleep: the song and every phone voice stop.
        assertEquals(PageLifecycle.Action.TEAR_DOWN, life.onStop(changingConfigurations = false))
        assertFalse(life.started)
        assertEquals(PageLifecycle.Action.BUILD_AND_LOAD, life.onStart())
    }

    @Test fun aConfigurationChangeKeepsThePage() {
        val life = PageLifecycle()
        life.onStart()
        assertEquals(PageLifecycle.Action.NONE, life.onStop(changingConfigurations = true))
        assertEquals(PageLifecycle.Action.NONE, life.onStart())
    }

    @Test fun stoppingTwiceTearsDownOnce() {
        val life = PageLifecycle()
        life.onStart()
        life.onStop(changingConfigurations = false)
        assertEquals(PageLifecycle.Action.NONE, life.onStop(changingConfigurations = false))
    }

    @Test fun aLostRendererIsReplacedWhileInFront() {
        val life = PageLifecycle()
        life.onStart()
        assertEquals(PageLifecycle.Action.REBUILD_AND_LOAD, life.onRendererGone(recentLosses = 1, lossLimit = 3))
        assertEquals(PageLifecycle.Action.REBUILD_AND_RETRY, life.onRendererGone(recentLosses = 3, lossLimit = 3))
    }

    @Test fun aRendererLostInTheBackgroundIsRebuiltOnlyOnTheNextStart() {
        val life = PageLifecycle()
        life.onStart()
        life.onStop(changingConfigurations = true)
        // The low-memory killer takes a hidden renderer first; never reload behind another app.
        assertEquals(PageLifecycle.Action.TEAR_DOWN, life.onRendererGone(recentLosses = 1, lossLimit = 3))
        assertEquals(PageLifecycle.Action.BUILD_AND_LOAD, life.onStart())
    }
}
