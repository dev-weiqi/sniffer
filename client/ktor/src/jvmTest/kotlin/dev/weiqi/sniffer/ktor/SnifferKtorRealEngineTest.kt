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
import io.ktor.client.plugins.sse.sse
import io.ktor.client.request.post
import io.ktor.client.request.preparePost
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Real-engine coverage for what a non-2xx response reports, in two groups.
 *
 * A saved (normal) call must keep its error body whatever the host's validator does with it —
 * regression guard for 8aa2dd4 (SDK 0.5.1), where the generic catch reported a hardcoded
 * body = null / bodySize = 0, so any non-2xx a validator rethrew showed as '(empty or binary)'
 * while its status and headers survived.
 *
 * A streaming (`prepareX`) call still loses it; that gap is pinned in [probeStreaming].
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
    private fun startServer(status: Int): String {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/api/chat") { exchange ->
            val bytes = errorJson.toByteArray()
            exchange.responseHeaders.add("content-type", "application/json; charset=utf-8")
            exchange.sendResponseHeaders(status, bytes.size.toLong())
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

    /**
     * The SSE plugin's requests take the handsOff path, which reports but never transforms — so an
     * error status on an SSE endpoint still arrives without a body, the same signature the
     * streaming branch used to produce. Left as-is deliberately: handsOff exists so an
     * engine-level response adapter is never touched, and buffering here would have to be proven
     * against the whole SSE integration matrix, not a unit test. Pinned so the choice stays visible.
     */
    @Test
    fun sse_plugin_error_status_reports_headers_only(): Unit = runBlocking {
        val url = startServer(402)
        val reports = mutableListOf<DeviceMessage>()
        setReportSink { reports += it }
        val client = HttpClient(CIO) { install(SSE); install(SnifferKtor) }
        val appSaw = runCatching { client.sse(url) { } }.exceptionOrNull()?.let { it::class.simpleName }
        val r = report(reports)
        println("[sse-plugin/402] status=${r.status} error=${r.error} bodySize=${r.bodySize} body=${r.body} appEx=$appSaw")
        assertEquals(402, r.status)
        assertNull(r.body, "handsOff path: body stays uncaptured by design")
        assertEquals("SSEClientException", appSaw, "the app still gets the SSE plugin's own failure")
        client.close()
        server?.stop(0)
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
