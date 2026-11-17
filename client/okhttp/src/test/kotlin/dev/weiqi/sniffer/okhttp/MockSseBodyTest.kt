package dev.weiqi.sniffer.okhttp

import dev.weiqi.sniffer.core.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import kotlin.test.*

class MockSseBodyTest {
    @AfterTest fun clear() { MockRegistry.update(MockRules()) }
    private fun arm(ending: String = "close", delay: Long = 100) {
        MockRegistry.update(MockRules(http = listOf(HttpMockRule(id = "sse", urlPattern = "/events",
            headers = mapOf("Content-Length" to "999"), sse = MockSseStream(listOf(MockSseEvent("first", delayMs = delay), MockSseEvent("second", delayMs = delay)), ending)))))
    }
    private val request get() = Request.Builder().url("http://sniffer-test.invalid/events").build()
    @Test fun frames_arrive_over_time_and_have_stream_headers() {
        arm()
        val client = OkHttpClient.Builder().addInterceptor(SnifferOkHttp.interceptor()).build()
        client.newCall(request).execute().use { response ->
            assertNull(response.header("Content-Length"))
            assertEquals(-1, response.body.contentLength())
            val start = System.nanoTime()
            val source = response.body.source()
            assertEquals("data: first", source.readUtf8LineStrict()); assertEquals("", source.readUtf8LineStrict())
            assertEquals("data: second", source.readUtf8LineStrict()); assertEquals("", source.readUtf8LineStrict())
            assertTrue((System.nanoTime() - start) / 1_000_000 >= 180)
            assertTrue(source.exhausted())
        }
    }
    @Test fun open_stream_obeys_cancellation_and_read_timeout() {
        arm("open", 0)
        val client = OkHttpClient.Builder().addInterceptor(SnifferOkHttp.interceptor()).readTimeout(60, TimeUnit.MILLISECONDS).build()
        val call = client.newCall(request)
        call.execute().use { response ->
            repeat(4) { response.body.source().readUtf8LineStrict() }
            assertFailsWith<SocketTimeoutException> { response.body.source().readUtf8LineStrict() }
            call.cancel()
            assertFailsWith<IOException> { response.body.source().readUtf8LineStrict() }
        }
    }
    @Test fun disconnect_is_not_successful_eof() {
        arm("disconnect", 0)
        val client = OkHttpClient.Builder().addInterceptor(SnifferOkHttp.interceptor()).build()
        client.newCall(request).execute().use { response ->
            repeat(4) { response.body.source().readUtf8LineStrict() }
            assertFailsWith<IOException> { response.body.source().readUtf8LineStrict() }
        }
    }
}
