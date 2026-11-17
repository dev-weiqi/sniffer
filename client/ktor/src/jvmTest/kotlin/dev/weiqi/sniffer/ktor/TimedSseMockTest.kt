package dev.weiqi.sniffer.ktor

import dev.weiqi.sniffer.core.*
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.sse.SSE
import io.ktor.client.plugins.sse.sse
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlin.test.*

class TimedSseMockTest {
    @AfterTest fun clear() { MockRegistry.update(MockRules()) }
    private fun arm(ending: String = "close") {
        MockRegistry.update(MockRules(http = listOf(HttpMockRule(id = "stream", urlPattern = "/events",
            headers = mapOf("Content-Length" to "999", "content-type" to "application/json"),
            sse = MockSseStream(listOf(MockSseEvent("first", id = "1", delayMs = 100), MockSseEvent("second\nline", event = "update", delayMs = 120)), ending)))))
    }
    @Test fun raw_channel_delivers_timed_frames_and_eof(): Unit = runBlocking {
        arm()
        val client = HttpClient(CIO) { install(SnifferKtor) }
        try { withTimeout(5000) {
            client.prepareGet("http://sniffer-test.invalid/events").execute { response ->
                assertNull(response.headers["content-length"])
                assertTrue(response.headers["content-type"]!!.startsWith("text/event-stream"))
                val start = System.nanoTime()
                val channel = response.bodyAsChannel()
                assertEquals("id: 1", channel.readUTF8Line())
                assertEquals("data: first", channel.readUTF8Line())
                assertEquals("", channel.readUTF8Line())
                assertEquals("event: update", channel.readUTF8Line())
                assertTrue((System.nanoTime() - start) / 1_000_000 >= 100)
                assertEquals("data: second", channel.readUTF8Line())
                assertEquals("data: line", channel.readUTF8Line())
                assertEquals("", channel.readUTF8Line())
                assertNull(channel.readUTF8Line())
            }
        } } finally { client.close() }
    }
    @Test fun plugin_consumes_frames_with_both_engines_and_install_orders(): Unit = runBlocking {
        for (engine in listOf(CIO, OkHttp)) for (snifferFirst in listOf(true, false)) {
            arm()
            val client = HttpClient(engine) {
                if (snifferFirst) { install(SnifferKtor); install(SSE) } else { install(SSE); install(SnifferKtor) }
            }
            try { withTimeout(5000) {
                client.sse("http://sniffer-test.invalid/events") {
                    val events = incoming.toList()
                    assertEquals(listOf("first", "second\r\nline"), events.map { it.data })
                    assertEquals("1", events.first().id)
                    assertEquals("update", events.last().event)
                }
            } } finally { client.close() }
        }
    }
    @Test fun open_stream_can_be_cancelled_after_first_event(): Unit = runBlocking {
        arm("open")
        val client = HttpClient(CIO) { install(SSE); install(SnifferKtor) }
        try { withTimeout(5000) {
            client.sse("http://sniffer-test.invalid/events") { assertEquals("first", incoming.take(1).toList().single().data) }
        } } finally { client.close() }
    }
    @Test fun caller_can_cancel_before_first_event(): Unit = runBlocking {
        MockRegistry.update(MockRules(http = listOf(HttpMockRule(id = "slow", urlPattern = "/events",
            sse = MockSseStream(listOf(MockSseEvent("late", delayMs = 300000)), "open")))))
        val client = HttpClient(CIO) { install(SSE); install(SnifferKtor) }
        try {
            assertFailsWith<TimeoutCancellationException> {
                withTimeout(100) { client.sse("http://sniffer-test.invalid/events") { incoming.toList() } }
            }
        } finally { client.close() }
    }
    @Test fun disconnect_delivers_earlier_events_then_fails(): Unit = runBlocking {
        arm("disconnect")
        val client = HttpClient(CIO) { install(SnifferKtor) }
        try { withTimeout(5000) {
            client.prepareGet("http://sniffer-test.invalid/events").execute { response ->
                val channel = response.bodyAsChannel()
                assertEquals("id: 1", channel.readUTF8Line())
                assertEquals("data: first", channel.readUTF8Line())
                assertEquals("", channel.readUTF8Line())
                // Ktor's channel transformer can discard unread buffered bytes on transport failure.
                assertFailsWith<kotlinx.io.IOException> { while (channel.readUTF8Line() != null) { } }
            }
        } } finally { client.close() }
    }
}
