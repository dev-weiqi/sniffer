package dev.weiqi.sniffer.ktor

import com.sun.net.httpserver.HttpServer
import dev.weiqi.sniffer.core.DeviceMessage
import dev.weiqi.sniffer.core.HttpResponseMsg
import dev.weiqi.sniffer.core.Sniffer
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.sse.SSE
import io.ktor.client.plugins.sse.SSEClientException
import io.ktor.client.plugins.sse.sse
import io.ktor.client.request.post
import io.ktor.client.request.preparePost
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.content.TextContent
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Real-engine coverage for what a non-2xx response reports, in two groups.
 *
 * A saved (normal) call must keep its error body whatever the host's validator does with it —
 * regression guard for 8aa2dd4 (SDK 0.5.1), where the generic catch reported a hardcoded
 * body = null / bodySize = 0, so any non-2xx a validator rethrew showed as '(empty or binary)'
 * while its status and headers survived.
 *
 * Bounded streaming errors and the SSE plugin's saved error responses must also retain their bodies.
 *
 * Every other ktor test here runs on MockEngine. These drive real engines (CIO and OkHttp)
 * against a loopback server because the capture is gated on [io.ktor.client.plugins.isSaved],
 * and whether a body is saved is engine and call-shape behaviour that MockEngine can't stand in
 * for.
 */
class SnifferKtorRealEngineTest {
    private val errorJson = """{"code":113012,"msg":"Point balance is not enough"}"""
    private var server: HttpServer? = null

    @AfterTest
    fun cleanup() {
        server?.stop(0)
        setReportSink(null)
    }

    /** Serves [status] + [errorJson] with a real content-length, like the reported API does. */
    private fun startServer(status: Int, chunked: Boolean = false): String {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/api/chat") { exchange ->
            val bytes = errorJson.toByteArray()
            exchange.responseHeaders.add("content-type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(status, if (chunked) 0 else bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        http.start()
        server = http
        return "http://127.0.0.1:${http.address.port}/api/chat"
    }

    private fun report(reports: List<DeviceMessage>) =
        reports.filterIsInstance<HttpResponseMsg>().last()

    private fun probe(
        name: String,
        status: Int,
        engine: io.ktor.client.engine.HttpClientEngineFactory<*> = CIO,
        configure: io.ktor.client.HttpClientConfig<*>.() -> Unit,
    ): Unit =
        runBlocking {
            val url = startServer(status)
            val reports = mutableListOf<DeviceMessage>()
            setReportSink { reports += it }
            val client = HttpClient(engine) {
                install(SnifferKtor)
                configure()
            }
            runCatching { client.post(url) }
            val r = report(reports)
            println("[$name] status=${r.status} error=${r.error} bodySize=${r.bodySize} body=${r.body}")
            assertEquals(status, r.status, "$name: status")
            // the point of this suite: an error status must not cost us the body
            assertEquals(errorJson, r.body, "$name: body")
            assertEquals(errorJson.length.toLong(), r.bodySize, "$name: bodySize")
            client.close()
            server?.stop(0)
        }

    @Test
    fun probe_no_validator() = probe("no-validator/402", 402) {}

    @Test
    fun probe_expect_success() = probe("expectSuccess/402", 402) { expectSuccess = true }

    @Test
    fun probe_custom_validator() = probe("custom-validator/402", 402) {
        HttpResponseValidator {
            validateResponse { response: HttpResponse ->
                if (response.status.value >= 400) error("custom")
            }
        }
    }

    // the shape a real app actually has: the validator reads the error body to build its message
    // (that is how "Point balance is not enough" reaches the UI) and only then throws
    @Test
    fun probe_validator_that_reads_the_body() = probe("validator-reads-body/402", 402) {
        HttpResponseValidator {
            validateResponse { response: HttpResponse ->
                if (response.status.value >= 400) error(response.bodyAsText())
            }
        }
    }

    // Android apps normally run ktor on the OkHttp engine, not CIO
    @Test
    fun probe_okhttp_engine_plain() = probe("okhttp/402", 402, OkHttp) {}

    @Test
    fun probe_okhttp_engine_validator_reads_body() = probe("okhttp+reads-body/402", 402, OkHttp) {
        HttpResponseValidator {
            validateResponse { response: HttpResponse ->
                if (response.status.value >= 400) error(response.bodyAsText())
            }
        }
    }

    @Test
    fun probe_success_baseline() = probe("baseline/200", 200) {}

    @Test
    fun get_post_error_capture_preserves_host_response(): Unit = runBlocking {
        for (engine in listOf(CIO, OkHttp)) {
            for (method in listOf(HttpMethod.Get, HttpMethod.Post)) {
                for (chunked in listOf(false, true)) {
                    val url = startServer(400, chunked)
                    val reports = mutableListOf<DeviceMessage>()
                    setReportSink { reports += it }
                    val client = HttpClient(engine) { install(SnifferKtor) }
                    try {
                        val response = client.request(url) { this.method = method }
                        assertEquals(400, response.status.value)
                        assertEquals("application/json; charset=utf-8", response.headers["content-type"])
                        assertEquals(errorJson, response.bodyAsText())
                        assertEquals(errorJson, report(reports).body)
                    } finally { client.close(); server?.stop(0) }
                }
            }
        }
    }

    @Test
    fun reporting_failure_keeps_saved_streaming_response_readable(): Unit = runBlocking {
        for (engine in listOf(CIO, OkHttp)) {
            val url = startServer(400)
            setReportSink { if (it is HttpResponseMsg) error("sniffer failed") }
            val client = HttpClient(engine) { install(SnifferKtor) }
            try {
                client.preparePost(url).execute { response ->
                    assertEquals(400, response.status.value)
                    assertEquals(errorJson, response.bodyAsText())
                }
            } finally { client.close(); server?.stop(0) }
        }
    }

    /**
     * `prepareX(...).execute { }` is not saved by ktor's SaveBody. The unsaved branch refuses to
     * buffer, because save()ing an unbounded stream ahead of the app is the worse failure — but a
     * body whose length the server declared, within the cap, is bounded by definition, and the
     * app must still read it unchanged afterwards.
     */
    private fun probeStreaming(
        name: String,
        engine: io.ktor.client.engine.HttpClientEngineFactory<*> = CIO,
        readBody: Boolean,
    ): Unit = runBlocking {
        val url = startServer(402)
        val reports = mutableListOf<DeviceMessage>()
        setReportSink { reports += it }
        val client = HttpClient(engine) { install(SnifferKtor) }
        var seenByApp: String? = null
        runCatching {
            client.preparePost(url).execute { resp ->
                if (readBody) seenByApp = resp.bodyAsText()
            }
        }
        val r = report(reports)
        println("[$name] status=${r.status} error=${r.error} bodySize=${r.bodySize} body=${r.body}")
        assertEquals(402, r.status, "$name: status")
        assertNull(r.error, "$name: error")
        assertEquals(errorJson, r.body, "$name: body")
        assertEquals(errorJson.length.toLong(), r.bodySize, "$name: bodySize")
        // capturing must not cost the app its body
        if (readBody) assertEquals(errorJson, seenByApp, "$name: body seen by the app")
        client.close()
        server?.stop(0)
    }

    @Test
    fun probe_streaming_cio_unread() = probeStreaming("stream-cio-unread/402", CIO, readBody = false)

    @Test
    fun probe_streaming_cio_read() = probeStreaming("stream-cio-read/402", CIO, readBody = true)

    @Test
    fun probe_streaming_okhttp_read() = probeStreaming("stream-okhttp-read/402", OkHttp, readBody = true)

    private suspend fun probeSseError(
        engine: io.ktor.client.engine.HttpClientEngineFactory<*>,
        status: Int = 400,
        chunked: Boolean = false,
        snifferFirst: Boolean = false,
        method: HttpMethod = HttpMethod.Post,
        brokenReporter: Boolean = false,
    ) {
        val url = startServer(status, chunked)
        val reports = mutableListOf<DeviceMessage>()
        setReportSink {
            if (brokenReporter && it is HttpResponseMsg) error("sniffer failed")
            reports += it
        }
        val client = HttpClient(engine) {
            if (snifferFirst) { install(SnifferKtor); install(SSE) }
            else { install(SSE); install(SnifferKtor) }
        }
        try {
            val failure = runCatching {
                client.sse(url, request = {
                    this.method = method
                    if (method == HttpMethod.Post) {
                        setBody(TextContent("""{"name":"yyy","content":""}""", ContentType.Application.Json))
                    }
                }) { }
            }.exceptionOrNull()
            val error = assertIs<SSEClientException>(failure)
            assertEquals(errorJson, error.response?.bodyAsText(), "the app still receives its error body")
            if (brokenReporter) return
            val response = report(reports)
            assertEquals(status, response.status)
            assertEquals(errorJson, response.body, "SSE error body must reach Sniffer")
            assertEquals(errorJson.length.toLong(), response.bodySize)
        } finally { client.close(); server?.stop(0) }
    }

    @Test
    fun sse_plugin_400_preserves_error_body(): Unit = runBlocking { probeSseError(OkHttp) }

    @Test
    fun sse_plugin_402_preserves_error_body(): Unit = runBlocking { probeSseError(CIO, status = 402) }

    @Test
    fun sse_error_body_survives_engine_framing_and_plugin_order(): Unit = runBlocking {
        for (engine in listOf(CIO, OkHttp)) {
            for (chunked in listOf(false, true)) {
                for (snifferFirst in listOf(false, true)) {
                    for (method in listOf(HttpMethod.Get, HttpMethod.Post)) {
                        probeSseError(engine, chunked = chunked, snifferFirst = snifferFirst, method = method)
                    }
                }
            }
            probeSseError(engine, brokenReporter = true)
        }
    }

    @Test
    fun successful_sse_delivers_events_before_the_response_finishes(): Unit = runBlocking {
        for (engine in listOf(CIO, OkHttp)) {
            val firstRead = CountDownLatch(1)
            val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
            http.createContext("/events") { exchange ->
                exchange.responseHeaders.add("content-type", "text/event-stream")
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.use { output ->
                    output.write("data: first\n\n".toByteArray())
                    output.flush()
                    if (firstRead.await(5, TimeUnit.SECONDS)) output.write("data: second\n\n".toByteArray())
                }
            }
            http.start()
            server = http
            val reports = mutableListOf<DeviceMessage>()
            setReportSink { reports += it }
            val client = HttpClient(engine) { install(SSE); install(SnifferKtor) }
            try {
                val events = mutableListOf<String?>()
                withTimeout(5_000) {
                    client.sse("http://127.0.0.1:${http.address.port}/events") {
                        incoming.onEach { firstRead.countDown() }.take(2).toList().mapTo(events) { it.data }
                    }
                }
                assertEquals(listOf<String?>("first", "second"), events.toList())
                assertTrue(reports.filterIsInstance<HttpResponseMsg>().any { it.body.orEmpty().contains("data: first") })
            } finally { firstRead.countDown(); client.close(); http.stop(0) }
        }
    }

    /** Chunked / unknown length: a genuine open-ended stream must stay untouched. */
    @Test
    fun streaming_without_content_length_is_left_alone(): Unit = runBlocking {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/api/chat") { exchange ->
            exchange.responseHeaders.add("content-type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(402, 0) // 0 = chunked, no declared length
            exchange.responseBody.use { it.write(errorJson.toByteArray()) }
        }
        http.start()
        server = http
        val url = "http://127.0.0.1:${http.address.port}/api/chat"
        val reports = mutableListOf<DeviceMessage>()
        setReportSink { reports += it }
        val client = HttpClient(CIO) { install(SnifferKtor) }
        var seenByApp: String? = null
        runCatching { client.preparePost(url).execute { seenByApp = it.bodyAsText() } }
        val r = report(reports)
        println("[chunked/402] bodySize=${r.bodySize} body=${r.body} appSaw=$seenByApp")
        assertNull(r.body, "unknown length must not be buffered")
        assertEquals(errorJson, seenByApp, "the app still reads it fine")
        client.close(); http.stop(0)
    }

    /** Past the streaming cap: left streamed, and the app must still receive every byte. */
    @Test
    fun streaming_with_large_declared_body_is_intact_for_the_app(): Unit = runBlocking {
        val big = "x".repeat(300_000)
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/api/chat") { exchange ->
            val bytes = big.toByteArray()
            exchange.responseHeaders.add("content-type", "text/plain; charset=utf-8")
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        http.start()
        server = http
        val url = "http://127.0.0.1:${http.address.port}/api/chat"
        val reports = mutableListOf<DeviceMessage>()
        setReportSink { reports += it }
        val client = HttpClient(CIO) { install(SnifferKtor) }
        var seenByApp: String? = null
        runCatching { client.preparePost(url).execute { seenByApp = it.bodyAsText() } }
        val r = report(reports)
        println("[large/200] bodySize=${r.bodySize} appLen=${seenByApp?.length}")
        assertNull(r.body, "over the streaming cap: stays streamed, not buffered")
        assertEquals(big.length, seenByApp?.length, "the app must get the whole body")
        client.close(); http.stop(0)
    }

    private fun setReportSink(sink: ((DeviceMessage) -> Unit)?) {
        val setter = Sniffer::class.java.methods.single { it.name.startsWith("setReportSinkForTests") }
        setter.invoke(Sniffer, sink)
    }
}
