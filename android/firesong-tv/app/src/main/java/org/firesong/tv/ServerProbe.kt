package org.firesong.tv

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/**
 * Native liveness check for the TV origin, so the app notices a dead server
 * even while the single-page app is loaded and no main-frame error can fire.
 *
 * It sends `HEAD <origin>/favicon.png`: the favicon is exempt from the host
 * token (PROTOCOL §2.2), so no secret leaves the WebView's cookie jar.
 */
object ServerProbe {
    const val PATH = "/favicon.png"
    private const val TIMEOUT_MS = 4_000

    /**
     * true = the server answered. Any HTTP status counts except the proxy's
     * "backend down" codes (502/503/504). A TLS failure also counts as up: the
     * proxy answered, and the WebView has its own trust rules (pins).
     */
    fun classify(status: Int?, error: Throwable?): Boolean = when {
        error is SSLException -> true
        error != null -> false
        status == null -> false
        status == 502 || status == 503 || status == 504 -> false
        else -> true
    }

    /** Blocking; call off the main thread. */
    fun isUp(pageUrl: String): Boolean {
        val origin = UrlPolicy.origin(pageUrl) ?: return false
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(origin + PATH).openConnection() as HttpURLConnection).apply {
                requestMethod = "HEAD"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                instanceFollowRedirects = false
                useCaches = false
            }
            classify(conn.responseCode, null)
        } catch (e: IOException) {
            classify(null, e)
        } finally {
            conn?.disconnect()
        }
    }
}
