package dev.weiqi.sniffer.core

import kotlin.test.*

class HttpSequenceTest {
    @AfterTest fun clear() { MockRegistry.update(MockRules()) }
    private fun rule(ending: String = "last") = HttpMockRule(id = "sequence", urlPattern = "/retry",
        sequence = HttpSequence(listOf(HttpResponseStep(status = 503), HttpResponseStep(status = 200)), ending))
    @Test fun matching_and_unrelated_updates_preserve_progress() {
        val rule = rule()
        MockRegistry.update(MockRules(http = listOf(rule)))
        assertNull(MockRegistry.matchHttp("GET", "/other"))
        assertEquals(503, MockRegistry.matchHttp("GET", "/retry")?.status)
        MockRegistry.update(MockRules(http = listOf(rule), revision = "new-sync"))
        assertEquals(200, MockRegistry.matchHttp("GET", "/retry")?.status)
        assertEquals(200, MockRegistry.matchHttp("GET", "/retry")?.status)
        MockRegistry.update(MockRules(http = listOf(rule.copy(sequence = rule.sequence!!.copy(resetToken = "reset")))))
        assertEquals(503, MockRegistry.matchHttp("GET", "/retry")?.status)
    }
    @Test fun loop_and_stop_are_explicit() {
        MockRegistry.update(MockRules(http = listOf(rule("loop"))))
        assertEquals(listOf(503, 200, 503), List(3) { MockRegistry.matchHttp("GET", "/retry")!!.status })
        MockRegistry.update(MockRules(http = listOf(rule("stop"))))
        repeat(2) { MockRegistry.matchHttp("GET", "/retry") }
        assertFailsWith<MockSequenceExhausted> { MockRegistry.matchHttp("GET", "/retry") }
        assertNull(MockRegistry.matchHttp("GET", "/unmatched"))
    }
    @Test fun sequence_round_trips_in_protocol() {
        val message = MockRules(http = listOf(rule("loop")))
        assertEquals(message, SnifferJson.decodeFromString<MockRules>(SnifferJson.encodeToString(MockRules.serializer(), message)))
    }
}
