package org.firesong.tv

import java.net.URI
import java.net.URISyntaxException

/**
 * What the app loads and with which credentials. Persisted in SharedPreferences
 * by [MainActivity]; this file holds only the pure rules so they can be unit
 * tested on the JVM.
 *
 * The host token and the leaf pins are bound to the origin they were given
 * for ([boundOrigin]). If the URL later moves to another origin without a new
 * token, both are dropped, so a changed URL can never receive the token as a
 * cookie.
 */
data class TvSettings(
    val url: String? = null,
    val hostToken: String? = null,
    val boundOrigin: String? = null,
    val leafPins: List<String> = emptyList(),
    /** 0 = the display's own density; otherwise an override in dpi (120..640). */
    val uiDensity: Int = 0,
    /** null = the build default (debug builds on, release off). */
    val devtools: Boolean? = null,
)

/** Raw values from a `.Configure` intent. null means "not given". */
data class ConfigExtras(
    val url: String? = null,
    val hostToken: String? = null,
    val leafPin: String? = null,
    val uiDensity: Int? = null,
    val devtools: Boolean? = null,
    val clear: Boolean = false,
)

sealed class ConfigResult {
    data class Ok(val settings: TvSettings, val notes: List<String>) : ConfigResult()
    data class Rejected(val reason: String) : ConfigResult()
}

object UrlPolicy {
    /**
     * Returns null when [url] may be loaded as the TV page, otherwise a short
     * reason. Release builds (allowCleartext=false) accept only https. Debug
     * builds also accept http, for `adb reverse` (http://localhost:<port>) and
     * plain LAN testing.
     */
    fun problem(url: String, allowCleartext: Boolean): String? {
        val uri = try {
            URI(url)
        } catch (e: URISyntaxException) {
            return "not a URL"
        }
        val scheme = uri.scheme?.lowercase() ?: return "missing scheme"
        if (scheme != "https" && scheme != "http") return "scheme must be https or http"
        if (scheme == "http" && !allowCleartext) return "release builds load https only"
        if (uri.host.isNullOrEmpty()) return "missing host"
        if (uri.rawUserInfo != null) return "user info is not allowed in the URL"
        return null
    }

    /** `scheme://host[:port]`, lower-cased, default ports dropped; null if unparsable. */
    fun origin(url: String?): String? {
        if (url == null) return null
        val uri = try {
            URI(url)
        } catch (e: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val port = uri.port
        val defaultPort = when (scheme) {
            "https" -> 443
            "http" -> 80
            else -> -1
        }
        return if (port == -1 || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
    }

    fun host(url: String?): String? = try {
        url?.let { URI(it).host?.lowercase() }
    } catch (e: URISyntaxException) {
        null
    }

    fun sameOrigin(a: String?, b: String?): Boolean {
        val oa = origin(a) ?: return false
        return oa == origin(b)
    }

    fun isHttps(url: String?): Boolean = origin(url)?.startsWith("https://") == true
}

object TvConfig {
    /**
     * Token characters are limited to a cookie-safe set so a value can never
     * smuggle extra cookie attributes (`;`, `,`, spaces). The server issues 32
     * lowercase hex characters (PROTOCOL §2.2); the wider set leaves room.
     */
    private val TOKEN = Regex("^[A-Za-z0-9._~-]{16,256}$")
    private val CERT_SHA256_HEX = Regex("^[0-9a-f]{64}$")
    private val SPKI_PIN = Regex("^sha256/[A-Za-z0-9+/]{43}=$")

    const val MIN_DENSITY = 120
    const val MAX_DENSITY = 640

    fun isValidToken(token: String): Boolean = TOKEN.matches(token)

    /** Normalises a pin (`AB:CD:..` hex or `sha256/<base64>`), or returns null if invalid. */
    fun normalizePin(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.startsWith("sha256/")) return trimmed.takeIf { SPKI_PIN.matches(it) }
        val hex = trimmed.replace(":", "").lowercase()
        return hex.takeIf { CERT_SHA256_HEX.matches(it) }
    }

    /** Parses a comma/space separated pin list (from BuildConfig); invalid entries are skipped. */
    fun parsePins(list: String?): List<String> =
        list.orEmpty().split(',', ' ', '\n').mapNotNull { s -> s.takeIf { it.isNotBlank() }?.let(::normalizePin) }

    /** The URL the app should load: the stored one, else the build default; null if neither is usable. */
    fun effectiveUrl(settings: TvSettings, buildDefault: String, allowCleartext: Boolean): String? {
        val candidate = settings.url ?: buildDefault.takeIf { it.isNotBlank() } ?: return null
        return candidate.takeIf { UrlPolicy.problem(it, allowCleartext) == null }
    }

    /** The token to send as a cookie to [url], or null when it belongs to another origin. */
    fun tokenFor(settings: TvSettings, url: String): String? {
        val token = settings.hostToken ?: return null
        return token.takeIf { settings.boundOrigin != null && UrlPolicy.sameOrigin(settings.boundOrigin, url) }
    }

    /** The extra leaf pins to accept for [url] (pins delivered with a `.Configure` intent). */
    fun pinsFor(settings: TvSettings, url: String): List<String> =
        if (settings.boundOrigin != null && UrlPolicy.sameOrigin(settings.boundOrigin, url)) settings.leafPins else emptyList()

    /**
     * Applies a `.Configure` intent to [current]. Never logs or returns the
     * token itself; notes are safe to log.
     */
    fun apply(
        current: TvSettings,
        extras: ConfigExtras,
        buildDefault: String,
        allowCleartext: Boolean,
    ): ConfigResult {
        val notes = mutableListOf<String>()
        var next = if (extras.clear) {
            notes += "cleared stored settings"
            TvSettings()
        } else {
            current
        }

        val oldUrl = effectiveUrl(next, buildDefault, allowCleartext)
        if (extras.url != null) {
            val url = extras.url.trim()
            UrlPolicy.problem(url, allowCleartext)?.let { return ConfigResult.Rejected("url rejected: $it") }
            next = next.copy(url = url)
            notes += "url set to ${UrlPolicy.origin(url)}"
        }
        val newUrl = effectiveUrl(next, buildDefault, allowCleartext)

        if (extras.hostToken != null) {
            val token = extras.hostToken.trim()
            if (token.isEmpty()) {
                // Pins (if any) stay bound to their origin.
                next = next.copy(hostToken = null, boundOrigin = next.boundOrigin.takeIf { next.leafPins.isNotEmpty() })
                notes += "host token removed"
            } else {
                if (!isValidToken(token)) return ConfigResult.Rejected("host_token rejected: bad format")
                val origin = UrlPolicy.origin(newUrl)
                    ?: return ConfigResult.Rejected("host_token rejected: no URL to bind it to")
                // Pins bound to a different origin do not follow the token.
                val keptPins = if (next.boundOrigin == origin) next.leafPins else emptyList()
                next = next.copy(hostToken = token, boundOrigin = origin, leafPins = keptPins)
                notes += "host token set for $origin (${token.length} chars)"
            }
        } else if (next.boundOrigin != null && !UrlPolicy.sameOrigin(next.boundOrigin, newUrl)) {
            // The URL moved to another origin without a new token: never carry the
            // old token (or pins) across.
            next = next.copy(hostToken = null, boundOrigin = null, leafPins = emptyList())
            notes += "origin changed (${UrlPolicy.origin(oldUrl)} -> ${UrlPolicy.origin(newUrl)}): host token and pins dropped"
        }

        if (extras.leafPin != null) {
            if (extras.leafPin.isBlank()) {
                next = next.copy(leafPins = emptyList())
                notes += "leaf pins removed"
            } else {
                val pins = extras.leafPin.split(',').map { it.trim() }.filter { it.isNotEmpty() }
                val normalized = pins.map { normalizePin(it) ?: return ConfigResult.Rejected("leaf_pin rejected: $it") }
                val origin = UrlPolicy.origin(newUrl)
                    ?: return ConfigResult.Rejected("leaf_pin rejected: no URL to bind it to")
                if (next.boundOrigin != null && next.boundOrigin != origin) {
                    return ConfigResult.Rejected("leaf_pin rejected: token is bound to another origin")
                }
                next = next.copy(leafPins = normalized, boundOrigin = origin)
                notes += "${normalized.size} leaf pin(s) set for $origin"
            }
        }

        if (extras.uiDensity != null) {
            val d = extras.uiDensity
            if (d != 0 && (d < MIN_DENSITY || d > MAX_DENSITY)) {
                return ConfigResult.Rejected("ui_density rejected: use 0 or $MIN_DENSITY..$MAX_DENSITY")
            }
            next = next.copy(uiDensity = d)
            notes += if (d == 0) "ui density: display default" else "ui density override: $d dpi"
        }

        if (extras.devtools != null) {
            next = next.copy(devtools = extras.devtools)
            notes += "webview devtools ${if (extras.devtools) "on" else "off"}"
        }
        return ConfigResult.Ok(next, notes)
    }
}
