package org.firesong.tv

/**
 * When the TV page exists. The page holds the song's and every phone voice's
 * Web Audio contexts and the `/rtc` TV seat, and `WebView.onPause()` pauses
 * neither JavaScript nor Web Audio. So the page lives only while the activity
 * is started: a stop (HOME, another app, the Cube going to sleep) destroys the
 * WebView, and the next start builds a new one and reloads the page.
 */
class PageLifecycle {
    enum class Action { NONE, BUILD_AND_LOAD, TEAR_DOWN, REBUILD_AND_LOAD, REBUILD_AND_RETRY }

    var started = false
        private set
    private var built = false

    fun onStart(): Action {
        started = true
        if (built) return Action.NONE
        built = true
        return Action.BUILD_AND_LOAD
    }

    /** A configuration change recreates the activity, which rebuilds the page anyway. */
    fun onStop(changingConfigurations: Boolean): Action {
        started = false
        if (changingConfigurations || !built) return Action.NONE
        built = false
        return Action.TEAR_DOWN
    }

    /**
     * The renderer died. In front it is replaced at once, or after a backoff
     * once it has died [lossLimit] times recently. Not in front, the page is
     * only dropped: reloading behind another app would compete with it for the
     * Cube's memory, and the next start rebuilds the page anyway.
     */
    fun onRendererGone(recentLosses: Int, lossLimit: Int): Action {
        if (!started) {
            built = false
            return Action.TEAR_DOWN
        }
        return if (recentLosses >= lossLimit) Action.REBUILD_AND_RETRY else Action.REBUILD_AND_LOAD
    }
}
