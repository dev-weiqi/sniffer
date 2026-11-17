package dev.weiqi.sniffer.core

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MockObservabilityTest {
    @AfterTest fun cleanup() { Sniffer.reportSinkForTests = null; MockRegistry.update(MockRules()) }

    @Test fun appliedAcknowledgementAndExactHits() {
        val messages = mutableListOf<DeviceMessage>()
        Sniffer.reportSinkForTests = { messages.add(it) }
        handleDaemonMessage("""{"type":"mock-rules","revision":"rev-2","http":[{"id":"rule","urlPattern":"/comments"}]}""", emptyMap())
        assertEquals("rev-2", messages.filterIsInstance<MockRulesApplied>().single().revision)
        assertNull(MockRegistry.matchHttp("GET", "/unrelated"))
        assertEquals(0, messages.filterIsInstance<MockHitMsg>().size)
        assertEquals("rule", MockRegistry.matchHttp("GET", "/comments")?.id)
        assertEquals("rule", messages.filterIsInstance<MockHitMsg>().single().ruleId)
        assertEquals("rev-2", messages.filterIsInstance<MockHitMsg>().single().revision)
    }

    @Test fun reportingFailureDoesNotChangeMatching() {
        MockRegistry.update(MockRules(http = listOf(HttpMockRule("r", urlPattern = "/a")), revision = "v"))
        Sniffer.reportSinkForTests = { error("Reporting failed") }
        assertEquals("r", MockRegistry.matchHttp("GET", "/a")?.id)
        assertNull(MockRegistry.matchHttp("GET", "/other"))
    }
}
