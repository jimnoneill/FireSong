package org.firesong.tv

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

/**
 * Fallback trust for the TV origin when the WebView does not honour
 * `network_security_config.xml` (design §4, "TV trust details").
 *
 * `onReceivedSslError` may proceed only when all of these hold:
 * - the failing URL is on the configured TV host;
 * - the leaf certificate matches a pin, either its SHA-256 fingerprint
 *   (64 hex chars, exact certificate) or `sha256/<base64>` of its
 *   SubjectPublicKeyInfo (survives renewal while the key stays the same);
 * - the certificate is inside its validity window.
 * Every other SSL error is cancelled.
 */
object CertPin {
    fun certSha256Hex(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    fun spkiPin(cert: X509Certificate): String =
        "sha256/" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded))

    fun parse(der: ByteArray): X509Certificate? = try {
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    } catch (e: Exception) {
        null
    }

    /** The pin that matched, or null. [pins] must already be normalised ([TvConfig.normalizePin]). */
    fun match(der: ByteArray, pins: Collection<String>, nowMillis: Long = System.currentTimeMillis()): String? {
        if (pins.isEmpty()) return null
        val cert = parse(der) ?: return null
        if (nowMillis < cert.notBefore.time || nowMillis > cert.notAfter.time) return null
        val fingerprint = certSha256Hex(der)
        val spki = spkiPin(cert)
        return pins.firstOrNull { it == fingerprint || it == spki }
    }

    /** Decision for one `onReceivedSslError`, kept free of Android types for tests. */
    fun shouldProceed(
        errorUrl: String?,
        tvUrl: String?,
        leafDer: ByteArray?,
        pins: Collection<String>,
        nowMillis: Long = System.currentTimeMillis(),
    ): Boolean {
        if (leafDer == null || pins.isEmpty()) return false
        val errorHost = UrlPolicy.host(errorUrl) ?: return false
        if (errorHost != UrlPolicy.host(tvUrl)) return false
        if (!UrlPolicy.isHttps(errorUrl)) return false
        return match(leafDer, pins, nowMillis) != null
    }
}
