package dev.weiqi.sniffer.core

import kotlin.test.Test
import kotlin.test.assertEquals

class SnifferAnalyticsTest {
    @Test
    fun release_twin_preserves_analytics_callbacks() {
        val calls = mutableListOf<String?>()
        SnifferAnalytics.setUserId("alice") { calls += it }
        SnifferAnalytics.logEvent("items", mapOf("page" to 1)) { calls += "items" }
        SnifferAnalytics.setUserId(null) { calls += it }
        assertEquals(listOf("alice", "items", null), calls)
    }
}
