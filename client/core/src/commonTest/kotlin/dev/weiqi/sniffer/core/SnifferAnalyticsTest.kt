package dev.weiqi.sniffer.core

import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class SnifferAnalyticsTest {
    @Test
    fun analytics_and_requests_keep_identity_snapshots_after_logout() {
        val reports = mutableListOf<DeviceMessage>()
        val forwarded = mutableListOf<String>()
        SnifferAnalytics.setUserId(null)
        Sniffer.reportSinkForTests = reports::add
        val request = HttpRequestMsg("r1", "GET", "https://example.com", emptyMap(), null, 0, false, "okhttp", 1)
        try {
            Sniffer.report(request)
            SnifferAnalytics.setUserId("alice") { forwarded += it.orEmpty() }
            val params = mutableMapOf<String, Any?>("page" to 1)
            SnifferAnalytics.logEvent("items", params) { forwarded += "event" }
            params["page"] = 2
            Sniffer.report(request.copy(id = "r2"))
            SnifferAnalytics.setUserId(null) { forwarded += it.orEmpty() }
            Sniffer.report(request.copy(id = "r3"))
            SnifferAnalytics.logEvent("guest")
            assertEquals(listOf("", "alice", ""), reports.filterIsInstance<HttpRequestMsg>().map { it.userId })
            val events = reports.filterIsInstance<FirebaseAnalyticsEventMsg>()
            assertEquals(listOf("alice", ""), events.map { it.userId })
            assertEquals(listOf(true, false), events.map { it.firebaseSdkCalled })
            assertEquals(JsonPrimitive(1), events.first().params["page"])
            assertEquals(listOf("alice", "event", ""), forwarded)
            for (report in reports) {
                assertEquals(report, SnifferJson.decodeFromString<DeviceMessage>(SnifferJson.encodeToString(report)))
            }
            assertFailsWith<IllegalStateException> {
                SnifferAnalytics.logEvent("failed") { error("Firebase failure") }
            }
            assertEquals(2, reports.filterIsInstance<FirebaseAnalyticsEventMsg>().size)
        } finally {
            Sniffer.reportSinkForTests = null
            SnifferAnalytics.setUserId(null)
        }
    }
}
