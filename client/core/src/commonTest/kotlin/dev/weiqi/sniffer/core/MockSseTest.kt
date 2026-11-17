package dev.weiqi.sniffer.core

import kotlin.test.*

class MockSseTest {
    @Test fun encodes_multiline_data_and_metadata() {
        assertEquals("event: update\nid: 7\nretry: 1000\ndata: first\ndata: second\ndata: third\n\n",
            MockSseEvent("first\r\nsecond\rthird", "update", "7", 1000).frame())
    }
    @Test fun rejects_protocol_injection_and_invalid_timing() {
        assertFalse(MockSseStream(listOf(MockSseEvent("ok", id = "1\ndata: fake"))).valid())
        assertFalse(MockSseStream(listOf(MockSseEvent("ok", delayMs = -1))).valid())
        assertFalse(MockSseStream(emptyList()).valid())
        assertTrue(MockSseStream(listOf(MockSseEvent("ok"))).valid())
    }
    @Test fun strips_framing_headers() {
        val rule = HttpMockRule(id = "s", urlPattern = "/", headers = mapOf("Content-Length" to "10", "Transfer-Encoding" to "chunked", "X-Test" to "yes"))
        assertEquals(mapOf("X-Test" to "yes", "content-type" to "text/event-stream; charset=utf-8"), rule.sseHeaders())
    }
}
