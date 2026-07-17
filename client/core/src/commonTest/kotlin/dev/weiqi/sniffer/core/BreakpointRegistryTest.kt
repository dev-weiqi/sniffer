package dev.weiqi.sniffer.core

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BreakpointRegistryTest {

    @AfterTest
    fun reset() = BreakpointRegistry.update(emptyList())

    private fun rule(
        pattern: String,
        method: String? = null,
        phase: String = "response",
        enabled: Boolean = true,
        id: String = "b1",
    ) = BreakpointRule(id = id, enabled = enabled, method = method, urlPattern = pattern, phase = phase)

    @Test
    fun matchesExactPath() {
        BreakpointRegistry.update(listOf(rule("/api/orders")))
        assertEquals("b1", BreakpointRegistry.match("GET", "https://h.dev/api/orders", "response")?.id)
    }

    @Test
    fun deeperPathDoesNotMatch() {
        BreakpointRegistry.update(listOf(rule("/api/orders")))
        assertNull(BreakpointRegistry.match("GET", "https://h.dev/api/orders/9", "response"))
    }

    @Test
    fun fullUrlPatternIsNormalized() {
        // a rule saved with a full URL still matches its path (host/query stripped)
        BreakpointRegistry.update(listOf(rule("https://h.dev/api/orders?x=1#f")))
        assertEquals("b1", BreakpointRegistry.match("GET", "https://other.host/api/orders", "response")?.id)
    }

    @Test
    fun phaseMustMatch() {
        BreakpointRegistry.update(listOf(rule("/api/orders", phase = "request")))
        assertNull(BreakpointRegistry.match("GET", "https://h.dev/api/orders", "response"))
    }

    @Test
    fun methodFiltersWhenSet() {
        BreakpointRegistry.update(listOf(rule("/api/orders", method = "POST")))
        assertNull(BreakpointRegistry.match("GET", "https://h.dev/api/orders", "response"))
        assertEquals("b1", BreakpointRegistry.match("post", "https://h.dev/api/orders", "response")?.id)
    }

    @Test
    fun nullMethodMatchesAny() {
        BreakpointRegistry.update(listOf(rule("/api/orders")))
        assertEquals("b1", BreakpointRegistry.match("DELETE", "https://h.dev/api/orders", "response")?.id)
    }

    @Test
    fun disabledRuleNeverMatches() {
        BreakpointRegistry.update(listOf(rule("/api/orders", enabled = false)))
        assertNull(BreakpointRegistry.match("GET", "https://h.dev/api/orders", "response"))
    }

    @Test
    fun relativePatternMatches() {
        BreakpointRegistry.update(listOf(rule("/api/orders")))
        assertEquals("b1", BreakpointRegistry.match("GET", "/api/orders?x=1", "response")?.id)
    }

    @Test
    fun armedReflectsEnabledRules() {
        BreakpointRegistry.update(listOf(rule("/api/orders", enabled = false)))
        assertFalse(BreakpointRegistry.armed)
        BreakpointRegistry.update(listOf(rule("/api/orders", enabled = true)))
        assertTrue(BreakpointRegistry.armed)
    }
}
