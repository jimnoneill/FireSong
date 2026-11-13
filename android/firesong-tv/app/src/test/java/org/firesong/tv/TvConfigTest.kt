package org.firesong.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TvConfigTest {
    private val token = "0123456789abcdef0123456789abcdef"
    private val tv = "https://tv.example.lan:64443/?tv=1"

    private fun ok(r: ConfigResult): TvSettings {
        assertTrue("expected Ok, got $r", r is ConfigResult.Ok)
        return (r as ConfigResult.Ok).settings
    }

    @Test fun urlPolicyReleaseAcceptsHttpsOnly() {
        assertNull(UrlPolicy.problem(tv, allowCleartext = false))
        assertNotNull(UrlPolicy.problem("http://localhost:64448/?tv=1", allowCleartext = false))
        assertNull(UrlPolicy.problem("http://localhost:64448/?tv=1", allowCleartext = true))
    }

    @Test fun urlPolicyRejectsOddUrls() {
        for (bad in listOf("javascript:alert(1)", "file:///sdcard/x.html", "ftp://h/", "https://", "not a url", "https://user:pw@h/")) {
            assertNotNull(bad, UrlPolicy.problem(bad, allowCleartext = true))
        }
    }

    @Test fun originNormalisesCaseAndDefaultPorts() {
        assertEquals("https://tv.example.lan:64443", UrlPolicy.origin(tv))
        assertEquals("https://h", UrlPolicy.origin("HTTPS://H:443/x"))
        assertEquals("http://localhost:8080", UrlPolicy.origin("http://localhost:8080/probe.html?a=1"))
        assertTrue(UrlPolicy.sameOrigin("https://h/a", "https://H:443/b?c"))
        assertTrue(!UrlPolicy.sameOrigin("https://h/a", "http://h/a"))
        assertTrue(!UrlPolicy.sameOrigin(null, "http://h/a"))
    }

    @Test fun tokenBindsToTheUrlOrigin() {
        val s = ok(TvConfig.apply(TvSettings(), ConfigExtras(url = tv, hostToken = token), "", false))
        assertEquals("https://tv.example.lan:64443", s.boundOrigin)
        assertEquals(token, TvConfig.tokenFor(s, tv))
        assertNull(TvConfig.tokenFor(s, "https://evil.example/"))
    }

    @Test fun newOriginWithoutTokenDropsTokenAndPins() {
        val pin = "a".repeat(64)
        val first = ok(TvConfig.apply(TvSettings(), ConfigExtras(url = tv, hostToken = token, leafPin = pin), "", false))
        assertEquals(listOf(pin), first.leafPins)
        val moved = ok(TvConfig.apply(first, ConfigExtras(url = "https://other.lan/"), "", false))
        assertNull(moved.hostToken)
        assertNull(moved.boundOrigin)
        assertTrue(moved.leafPins.isEmpty())
        // same origin, other path: token kept
        val samePlace = ok(TvConfig.apply(first, ConfigExtras(url = "https://tv.example.lan:64443/other"), "", false))
        assertEquals(token, samePlace.hostToken)
    }

    @Test fun tokenFollowsBuildDefaultWhenNoUrlStored() {
        val s = ok(TvConfig.apply(TvSettings(), ConfigExtras(hostToken = token), "http://localhost:64448/?tv=1", true))
        assertEquals("http://localhost:64448", s.boundOrigin)
        assertEquals(token, TvConfig.tokenFor(s, "http://localhost:64448/?tv=1"))
    }

    @Test fun tokenWithoutAnyUrlIsRejected() {
        val r = TvConfig.apply(TvSettings(), ConfigExtras(hostToken = token), "", false)
        assertTrue(r is ConfigResult.Rejected)
    }

    @Test fun cookieUnsafeTokensAreRejected() {
        for (bad in listOf("short", "$token; Domain=evil", "$token,x", "tok en tok en tok en", "ä".repeat(20))) {
            val r = TvConfig.apply(TvSettings(), ConfigExtras(url = tv, hostToken = bad), "", false)
            assertTrue(bad, r is ConfigResult.Rejected)
        }
    }

    @Test fun releaseRejectsHttpUrlAndKeepsOldSettings() {
        val r = TvConfig.apply(TvSettings(url = tv), ConfigExtras(url = "http://192.0.2.1:64448/"), "", false)
        assertTrue(r is ConfigResult.Rejected)
    }

    @Test fun emptyTokenRemovesItButKeepsPins() {
        val pin = "b".repeat(64)
        val s = ok(TvConfig.apply(TvSettings(), ConfigExtras(url = tv, hostToken = token, leafPin = pin), "", false))
        val r = ok(TvConfig.apply(s, ConfigExtras(hostToken = ""), "", false))
        assertNull(r.hostToken)
        assertEquals(listOf(pin), TvConfig.pinsFor(r, tv))
    }

    @Test fun pinsAreNormalisedAndValidated() {
        val colon = (1..32).joinToString(":") { "AB" }
        assertEquals("ab".repeat(32), TvConfig.normalizePin(colon))
        assertEquals("sha256/4ZkZ8TnAETUoKZ18j88mI5ncANgTWDhsst9RugNA8Os=", TvConfig.normalizePin(" sha256/4ZkZ8TnAETUoKZ18j88mI5ncANgTWDhsst9RugNA8Os= "))
        assertNull(TvConfig.normalizePin("abc"))
        assertNull(TvConfig.normalizePin("sha256/short="))
        assertEquals(2, TvConfig.parsePins("${"c".repeat(64)}, junk ,sha256/4ZkZ8TnAETUoKZ18j88mI5ncANgTWDhsst9RugNA8Os=").size)
        val r = TvConfig.apply(TvSettings(), ConfigExtras(url = tv, leafPin = "nothex"), "", false)
        assertTrue(r is ConfigResult.Rejected)
    }

    @Test fun clearResetsEverythingAndDevtoolsIsStored() {
        val cleared = ok(TvConfig.apply(TvSettings(url = tv, hostToken = token, boundOrigin = "https://tv.example.lan:64443", devtools = true), ConfigExtras(clear = true), "", false))
        assertEquals(TvSettings(), cleared)
        assertEquals(false, ok(TvConfig.apply(TvSettings(), ConfigExtras(devtools = false), "", false)).devtools)
        val clearThenSet = ok(TvConfig.apply(TvSettings(url = tv), ConfigExtras(clear = true, url = "https://other.lan/"), "", false))
        assertEquals("https://other.lan/", clearThenSet.url)
    }

    @Test fun effectiveUrlFallsBackToBuildDefault() {
        assertEquals("http://localhost:64448/?tv=1", TvConfig.effectiveUrl(TvSettings(), "http://localhost:64448/?tv=1", true))
        assertNull(TvConfig.effectiveUrl(TvSettings(), "", false))
        assertNull(TvConfig.effectiveUrl(TvSettings(), "http://localhost:64448/", false))
        assertEquals(tv, TvConfig.effectiveUrl(TvSettings(url = tv), "http://localhost:64448/", true))
    }

    @Test fun notesNeverContainTheToken() {
        val r = TvConfig.apply(TvSettings(), ConfigExtras(url = tv, hostToken = token), "", false) as ConfigResult.Ok
        assertTrue(r.notes.none { it.contains(token) })
    }

    @Test fun anOlderConfigureIntentNeverOverwritesNewerSettings() {
        val local = "http://localhost:64490/?tv=1"
        val smoke = ok(TvConfig.apply(TvSettings(), ConfigExtras(url = local, issuedMs = 1_000), "", allowCleartext = true))
        assertEquals(1_000L, smoke.lastIssuedMs)
        val party = ok(TvConfig.apply(smoke, ConfigExtras(url = tv, hostToken = token, issuedMs = 2_000), "", allowCleartext = true))
        // Android can recreate the activity with the intent that first started it.
        assertEquals(ConfigResult.Superseded, TvConfig.apply(party, ConfigExtras(url = local, issuedMs = 1_000), "", allowCleartext = true))
        assertEquals(ConfigResult.Superseded, TvConfig.apply(party, ConfigExtras(url = tv, issuedMs = 2_000), "", allowCleartext = true))
        assertEquals(3_000L, ok(TvConfig.apply(party, ConfigExtras(devtools = true, issuedMs = 3_000), "", allowCleartext = true)).lastIssuedMs)
    }

    @Test fun issuedTimeSurvivesClearAndIntentsWithoutOneStillApply() {
        val cleared = ok(TvConfig.apply(TvSettings(url = tv, lastIssuedMs = 1_000), ConfigExtras(clear = true, issuedMs = 5_000), "", allowCleartext = false))
        assertEquals(TvSettings(lastIssuedMs = 5_000), cleared)
        val kept = ok(TvConfig.apply(cleared, ConfigExtras(url = tv), "", allowCleartext = false))
        assertEquals(5_000L, kept.lastIssuedMs)
        assertEquals(tv, kept.url)
        assertTrue(TvConfig.apply(TvSettings(), ConfigExtras(url = tv, issuedMs = -1), "", allowCleartext = false) is ConfigResult.Rejected)
    }
}
