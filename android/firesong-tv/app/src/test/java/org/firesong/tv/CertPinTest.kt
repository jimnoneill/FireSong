package org.firesong.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CertPinTest {
    // Throwaway self-signed EC leaf for CN=localhost (private key discarded at creation).
    private val der = javaClass.classLoader!!.getResourceAsStream("leaf-test.der")!!.readBytes()
    // Expected values computed with openssl (independent of the code under test).
    private val fingerprint = "5dc35f9bfdde1768276c33b15135aeaafa185f67e3816d5d6ddca40192f38343"
    private val spki = "sha256/4ZkZ8TnAETUoKZ18j88mI5ncANgTWDhsst9RugNA8Os="
    private val cert = CertPin.parse(der)!!
    private val now = cert.notBefore.time + 86_400_000L
    private val tv = "https://localhost:8443/?tv=1"

    @Test fun fingerprintsMatchOpenssl() {
        assertEquals(fingerprint, CertPin.certSha256Hex(der))
        assertEquals(spki, CertPin.spkiPin(cert))
    }

    @Test fun matchesEitherPinForm() {
        assertEquals(fingerprint, CertPin.match(der, listOf("0".repeat(64), fingerprint), now))
        assertEquals(spki, CertPin.match(der, listOf(spki), now))
        assertNull(CertPin.match(der, listOf("0".repeat(64)), now))
        assertNull(CertPin.match(der, emptyList(), now))
    }

    @Test fun outsideValidityNeverMatches() {
        assertNull(CertPin.match(der, listOf(fingerprint), cert.notAfter.time + 1))
        assertNull(CertPin.match(der, listOf(fingerprint), cert.notBefore.time - 1))
    }

    @Test fun proceedsOnlyForTheTvHostOverHttps() {
        assertTrue(CertPin.shouldProceed("https://localhost:8443/assets/x.js", tv, der, listOf(fingerprint), now))
        assertFalse(CertPin.shouldProceed("https://evil.example/", tv, der, listOf(fingerprint), now))
        assertFalse(CertPin.shouldProceed("http://localhost:8443/", tv, der, listOf(fingerprint), now))
        assertFalse(CertPin.shouldProceed("https://localhost:8443/", tv, der, emptyList(), now))
        assertFalse(CertPin.shouldProceed("https://localhost:8443/", tv, null, listOf(fingerprint), now))
        assertFalse(CertPin.shouldProceed("https://localhost:8443/", tv, byteArrayOf(1, 2, 3), listOf(fingerprint), now))
        assertFalse(CertPin.shouldProceed(null, tv, der, listOf(fingerprint), now))
    }

    @Test fun parseRejectsGarbage() {
        assertNull(CertPin.parse(byteArrayOf(0x30, 0x01)))
        assertNotNull(CertPin.parse(der))
    }
}
