package dev.weiqi.sniffer.ktor

import dev.weiqi.sniffer.core.BreakpointRegistry
import dev.weiqi.sniffer.core.BreakpointResolution
import dev.weiqi.sniffer.core.BreakpointRule
import dev.weiqi.sniffer.core.Breakpoints
import dev.weiqi.sniffer.core.DeviceMessage
import dev.weiqi.sniffer.core.HttpMockRule
import dev.weiqi.sniffer.core.HttpRequestMsg
import dev.weiqi.sniffer.core.HttpResponseMsg
import dev.weiqi.sniffer.core.MAX_BODY_CHARS
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.MockRules
import dev.weiqi.sniffer.core.Sniffer
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.ClientRequestException
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.ResponseException
import io.ktor.client.plugins.api.Send
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.sse.SSESession
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.ByteArrayContent
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.util.AttributeKey
import io.ktor.utils.io.ByteReadChannel
import io.ktor.sse.ServerSentEvent
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlin.coroutines.cancellation.CancellationException
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SnifferKtorTest {
    @AfterTest
    fun cleanup() {
        MockRegistry.update(MockRules())
        BreakpointRegistry.update(emptyList())
        Breakpoints.connected = false
        Breakpoints.resolveAll(BreakpointResolution.Resume())
        setReportSink(null)
    }

    private fun armResponseBreakpoint() =
        BreakpointRegistry.update(listOf(BreakpointRule(id = "b1", urlPattern = "/bp", phase = "response")))

    private fun jsonClient() = HttpClient(
        MockEngine {
            respond(
                content = """{"real":true}""",
                headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
            )
        },
    ) { install(SnifferKtor) }

    @Test
    fun response_breakpoint_disconnected_passes_through_unchanged() = runBlocking {
        armResponseBreakpoint()
        val client = jsonClient()
        // connected = false: awaitBreakpoint returns Resume() immediately, so the body is untouched
        val response = client.get("http://example.test/bp")
        assertEquals(200, response.status.value)
        assertEquals("""{"real":true}""", response.bodyAsText())
        client.close()
    }

    @Test
    fun response_breakpoint_resume_with_edits_rewrites_the_response() = runBlocking {
        val reports = captureReports()
        armResponseBreakpoint()
        Breakpoints.connected = true
        val client = jsonClient()
        val resolver = launch {
            while (Breakpoints.pendingCount == 0) yield()
            Breakpoints.resolveAll(
                BreakpointResolution.Resume(status = 503, headers = mapOf("content-type" to "application/json"), body = """{"edited":true}"""),
            )
        }
        val response = client.get("http://example.test/bp")
        resolver.join()
        assertEquals(503, response.status.value)
        assertEquals("""{"edited":true}""", response.bodyAsText())
        assertEquals(503, reports.filterIsInstance<HttpResponseMsg>().last().status)
        client.close()
    }

    @Test
    fun response_breakpoint_abort_fails_the_call() = runBlocking {
        armResponseBreakpoint()
        Breakpoints.connected = true
        val client = jsonClient()
        val resolver = launch {
            while (Breakpoints.pendingCount == 0) yield()
            Breakpoints.resolveAll(BreakpointResolution.Abort)
        }
        assertFailsWith<BreakpointAbort> { client.get("http://example.test/bp") }
        resolver.join()
        client.close()
    }

    @Test
    fun mock_rule_short_circuits_engine_and_reports_mock_response() = runBlocking {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(
                        id = "r1",
                        urlPattern = "/mock",
                        status = 418,
                        headers = mapOf("x-mock" to "1"),
                        body = """{"mocked":true}""",
                    )
                )
            )
        )
        val reports = captureReports()
        val client = HttpClient(MockEngine { error("engine should not run") }) {
            install(SnifferKtor)
        }

        val response = client.get("http://example.test/mock")

        assertEquals(418, response.status.value)
        assertEquals("""{"mocked":true}""", response.bodyAsText())
        assertEquals("1", response.headers["x-mock"])
        assertTrue(reports.any { it is HttpRequestMsg && it.url == "http://example.test/mock" })
        assertTrue(reports.any { it is HttpResponseMsg && it.status == 418 && it.mocked })
        client.close()
    }

    @Test
    fun text_request_and_text_response_are_reported_and_preserved() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(
            MockEngine { request ->
                val requestBody = (request.body as TextContent).text
                respond(
                    content = """{"echo":$requestBody}""",
                    headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                )
            }
        ) {
            install(SnifferKtor)
        }

        val response = client.post("http://example.test/post") {
            setBody(TextContent("""{"ok":true}""", ContentType.Application.Json))
        }

        assertEquals("""{"echo":{"ok":true}}""", response.bodyAsText())
        val requestReport = reports.filterIsInstance<HttpRequestMsg>().last()
        val responseReport = reports.filterIsInstance<HttpResponseMsg>().last()
        assertEquals("""{"ok":true}""", requestReport.body)
        assertEquals("ktor", requestReport.library)
        assertEquals("""{"echo":{"ok":true}}""", responseReport.body)
        client.close()
    }

    @Test
    fun byte_array_request_body_respects_textual_and_binary_content_types() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(MockEngine { respond("ok") }) {
            install(SnifferKtor)
        }

        client.post("http://example.test/text") {
            setBody(ByteArrayContent("hello".encodeToByteArray(), ContentType.Text.Plain))
        }
        client.post("http://example.test/binary") {
            setBody(ByteArrayContent(byteArrayOf(1, 2, 3), ContentType.Application.OctetStream))
        }

        val requests = reports.filterIsInstance<HttpRequestMsg>()
        assertEquals("hello", requests.first { it.url.endsWith("/text") }.body)
        assertNull(requests.first { it.url.endsWith("/binary") }.body)
        client.close()
    }

    @Test
    fun oversized_byte_array_request_body_is_not_decoded() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(MockEngine { respond("ok") }) {
            install(SnifferKtor)
        }

        client.post("http://example.test/large") {
            setBody(ByteArrayContent(ByteArray(MAX_BODY_CHARS + 1) { 120 }, ContentType.Text.Plain))
        }

        assertNull(reports.filterIsInstance<HttpRequestMsg>().single().body)
        client.close()
    }

    @Test
    fun delay_only_rule_allows_real_response_and_reports_delay() = runBlocking {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(id = "delay", urlPattern = "/slow", delayMs = 1, delayOnly = true)
                )
            )
        )
        val reports = captureReports()
        val client = HttpClient(MockEngine { respond("real") }) {
            install(SnifferKtor)
        }

        val response = client.get("http://example.test/slow")

        assertEquals("real", response.bodyAsText())
        assertEquals(1, reports.filterIsInstance<HttpResponseMsg>().last().delayedMs)
        client.close()
    }

    @Test
    fun image_response_is_base64_reported_and_body_stays_readable() = runBlocking {
        val reports = captureReports()
        val bytes = byteArrayOf(1, 2, 3)
        val client = HttpClient(
            MockEngine {
                respond(
                    content = bytes,
                    headers = headersOf(HttpHeaders.ContentType, ContentType.Image.PNG.toString()),
                )
            }
        ) {
            install(SnifferKtor)
        }

        val response = client.get("http://example.test/image")

        assertEquals(bytes.toList(), response.bodyAsBytes().toList())
        val report = reports.filterIsInstance<HttpResponseMsg>().last()
        assertTrue(report.bodyBase64)
        assertEquals(3, report.bodySize)
        client.close()
    }

    @Test
    fun streaming_response_reports_headers_only_and_stays_streaming() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(
            MockEngine {
                respond(
                    content = ByteReadChannel("chunk"),
                    headers = headersOf(HttpHeaders.ContentType, ContentType.Text.Plain.toString()),
                )
            }
        ) {
            install(SnifferKtor)
        }

        val response = client.prepareGet("http://example.test/stream").execute { it.bodyAsText() }

        assertEquals("chunk", response)
        val report = reports.filterIsInstance<HttpResponseMsg>().last()
        assertNull(report.body)
        assertEquals(0, report.bodySize)
        client.close()
    }

    @Test
    fun hands_off_request_attribute_reports_without_transforming_call() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(MockEngine { respond("hands-off") }) {
            install(SnifferKtor)
        }
        val key = AttributeKey<Unit>("SSERequestFlag")

        val response = client.get("http://example.test/hands-off") {
            attributes.put(key, Unit)
        }

        assertEquals("hands-off", response.bodyAsText())
        assertTrue(reports.filterIsInstance<HttpRequestMsg>().any { it.url.endsWith("/hands-off") })
        val report = reports.filterIsInstance<HttpResponseMsg>().last()
        assertEquals(200, report.status)
        assertNull(report.body)
        client.close()
    }

    @Test
    fun event_stream_response_is_teed_as_app_reads_it() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(
            MockEngine {
                respond(
                    content = ByteReadChannel("data: one\n\n"),
                    headers = headersOf(HttpHeaders.ContentType, ContentType.Text.EventStream.toString()),
                )
            }
        ) {
            install(SnifferKtor)
        }

        val body = client.get("http://example.test/events").bodyAsText()

        assertEquals("data: one\n\n", body)
        val responseReports = reports.filterIsInstance<HttpResponseMsg>()
        assertTrue(responseReports.any { it.body == null && it.bodySize == 0L })
        assertTrue(responseReports.any { it.body == "data: one\n\n" })
        client.close()
    }

    @Test
    fun sse_session_wrapper_reports_events_as_flow_is_collected() = runBlocking {
        val reports = captureReports()
        val session = object : SSESession {
            override val coroutineContext: CoroutineContext = EmptyCoroutineContext
            override val incoming = flowOf(
                ServerSentEvent(data = "hello", event = "message"),
                ServerSentEvent(data = "bye"),
            )
        }

        val wrapped = snifferSseSession(
            id = "sse-1",
            body = session,
            headersMap = mapOf("content-type" to "text/event-stream"),
            status = 200,
        )

        assertEquals(EmptyCoroutineContext, wrapped.coroutineContext)
        assertEquals(listOf("hello", "bye"), wrapped.incoming.toList().map { it.data })
        assertTrue(
            reports.filterIsInstance<HttpResponseMsg>()
                .any { it.id == "sse-1" && it.body.orEmpty().contains("data: hello") }
        )
        assertTrue(
            reports.filterIsInstance<HttpResponseMsg>()
                .any { it.id == "sse-1" && it.body.orEmpty().contains("data: bye") }
        )
    }

    @Test
    fun response_exception_is_reported_and_rethrown() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(
            MockEngine {
                respond(
                    content = "missing",
                    status = HttpStatusCode.NotFound,
                    headers = headersOf(HttpHeaders.ContentType, ContentType.Text.Plain.toString()),
                )
            }
        ) {
            install(SnifferKtor)
            expectSuccess = true
        }

        assertFailsWith<ResponseException> {
            client.get("http://example.test/missing")
        }
        val report = reports.filterIsInstance<HttpResponseMsg>().last()
        assertEquals(404, report.status)
        assertEquals("missing", report.body)
        client.close()
    }

    @Test
    fun response_exception_thrown_inside_send_pipeline_is_reported() = runBlocking {
        val reports = captureReports()
        val throwingPlugin = createClientPlugin("ThrowResponseException") {
            on(Send) { request ->
                val call = proceed(request)
                throw ClientRequestException(call.response, "synthetic")
            }
        }
        val client = HttpClient(MockEngine { respond("bad", status = HttpStatusCode.BadRequest) }) {
            install(SnifferKtor)
            install(throwingPlugin)
        }

        assertFailsWith<ClientRequestException> {
            client.get("http://example.test/synthetic")
        }
        val report = reports.filterIsInstance<HttpResponseMsg>().last()
        assertEquals(400, report.status)
        assertTrue(report.error.orEmpty().contains("synthetic"))
        client.close()
    }

    @Test
    fun custom_validator_exception_uses_status_holder() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(MockEngine { respond("bad", status = HttpStatusCode.BadRequest) }) {
            install(SnifferKtor)
            HttpResponseValidator {
                validateResponse { response ->
                    if (response.status == HttpStatusCode.BadRequest) error("custom")
                }
            }
        }

        assertFailsWith<IllegalStateException> {
            client.get("http://example.test/custom")
        }
        val report = reports.filterIsInstance<HttpResponseMsg>().last()
        assertEquals(400, report.status)
        assertNull(report.error)
        client.close()
    }

    @Test
    fun transport_exception_reports_status_zero() = runBlocking {
        val reports = captureReports()
        val client = HttpClient(MockEngine { error("network") }) {
            install(SnifferKtor)
        }

        assertFailsWith<IllegalStateException> {
            client.get("http://example.test/fail")
        }
        val report = reports.filterIsInstance<HttpResponseMsg>().last()
        assertEquals(0, report.status)
        assertTrue(report.error.orEmpty().contains("network"))
        client.close()
    }

    @Test
    fun cancellation_from_request_reporting_is_rethrown() = runBlocking {
        setReportSink {
            if (it is HttpRequestMsg) throw CancellationException("request cancelled")
        }
        val client = HttpClient(MockEngine { respond("unused") }) {
            install(SnifferKtor)
        }

        assertFailsWith<CancellationException> {
            client.get("http://example.test/cancel-request")
        }
        client.close()
    }

    @Test
    fun cancellation_from_response_reporting_is_rethrown() = runBlocking {
        setReportSink {
            if (it is HttpResponseMsg) throw CancellationException("response cancelled")
        }
        val client = HttpClient(MockEngine { respond("cancel") }) {
            install(SnifferKtor)
        }

        assertFailsWith<CancellationException> {
            client.get("http://example.test/cancel-response")
        }
        client.close()
    }

    private fun captureReports(): MutableList<DeviceMessage> {
        val reports = mutableListOf<DeviceMessage>()
        setReportSink { reports += it }
        return reports
    }

    private fun setReportSink(sink: ((DeviceMessage) -> Unit)?) {
        val setter = Sniffer::class.java.methods.single { it.name.startsWith("setReportSinkForTests") }
        setter.invoke(Sniffer, sink)
    }
}
