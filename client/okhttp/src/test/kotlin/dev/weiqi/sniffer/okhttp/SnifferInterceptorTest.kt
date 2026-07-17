package dev.weiqi.sniffer.okhttp

import dev.weiqi.sniffer.core.HttpMockRule
import dev.weiqi.sniffer.core.MAX_BODY_CHARS
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.MockRules
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.BufferedSource
import java.net.UnknownHostException
import java.io.IOException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SnifferInterceptorTest {
    @AfterTest
    fun cleanup() {
        MockRegistry.update(MockRules())
        Thread.interrupted()
    }

    @Test
    fun mock_rule_short_circuits_without_network() {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(
                        id = "r1", urlPattern = "/api/characters/18", status = 418,
                        headers = mapOf("x-mock" to "1"), body = """{"mocked":true}""",
                    )
                )
            )
        )
        val client = OkHttpClient.Builder().addInterceptor(SnifferOkHttp.interceptor()).build()
        // nonexistent host: if the mock did not short-circuit, this would throw UnknownHostException
        val response = client.newCall(
            Request.Builder().url("http://sniffer-test.invalid/api/characters/18").build()
        ).execute()
        assertEquals(418, response.code)
        assertEquals("1", response.header("x-mock"))
        assertEquals("""{"mocked":true}""", response.body.string())
    }

    @Test
    fun ignored_host_bypasses_mocks_and_reporting() {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(
                        id = "r1", urlPattern = "/api/characters/18", status = 418,
                        headers = emptyMap(), body = "mocked",
                    )
                )
            )
        )
        val client = OkHttpClient.Builder()
            .addInterceptor(SnifferOkHttp.interceptor(ignoredHosts = setOf("sniffer-test.invalid")))
            .build()
        // the mock would normally short-circuit; an ignored host must hit the real network instead
        assertFailsWith<UnknownHostException> {
            client.newCall(
                Request.Builder().url("http://sniffer-test.invalid/api/characters/18").build()
            ).execute()
        }
    }

    @Test
    fun real_chain_preserves_text_request_and_response() {
        var terminalBody = ""
        val client = clientReturning { request ->
            terminalBody = request.bodyString()
            response(request, body = """{"ok":true}""".toResponseBody("application/json".toMediaType()))
        }

        val response = client.newCall(
            Request.Builder()
                .url("http://example.test/api/post")
                .post("""{"name":"Ada"}""".toRequestBody("application/json".toMediaType()))
                .build()
        ).execute()

        assertEquals("""{"name":"Ada"}""", terminalBody)
        assertEquals(200, response.code)
        assertEquals("""{"ok":true}""", response.body.string())
    }

    @Test
    fun network_exception_is_rethrown() {
        val client = OkHttpClient.Builder()
            .addInterceptor(SnifferOkHttp.interceptor())
            .addInterceptor { throw IOException("boom") }
            .build()

        assertFailsWith<IOException> {
            client.newCall(Request.Builder().url("http://example.test/fail").build()).execute()
        }
    }

    @Test
    fun delay_only_rule_allows_real_response() {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(
                        id = "delay",
                        urlPattern = "/slow",
                        body = "mocked",
                        delayMs = 1,
                        delayOnly = true,
                    )
                )
            )
        )
        val client = clientReturning { request ->
            response(request, body = "real".toResponseBody("text/plain".toMediaType()))
        }

        val response = client.newCall(Request.Builder().url("http://example.test/slow").build()).execute()

        assertEquals(200, response.code)
        assertEquals("real", response.body.string())
    }

    @Test
    fun interrupted_delay_restores_interrupt_and_falls_through() {
        MockRegistry.update(
            MockRules(
                http = listOf(HttpMockRule(id = "delay", urlPattern = "/interrupted", delayMs = 5))
            )
        )
        val client = clientReturning { request ->
            val wasInterrupted = Thread.currentThread().isInterrupted
            response(request, body = wasInterrupted.toString().toResponseBody("text/plain".toMediaType()))
        }

        Thread.currentThread().interrupt()
        val response = client.newCall(Request.Builder().url("http://example.test/interrupted").build()).execute()

        assertEquals("true", response.body.string())
    }

    @Test
    fun image_response_known_length_stays_readable() {
        val bytes = byteArrayOf(1, 2, 3, 4)
        val client = clientReturning { request ->
            response(request, body = bytes.toResponseBody("image/png".toMediaType()))
        }

        val response = client.newCall(Request.Builder().url("http://example.test/image").build()).execute()

        assertEquals(bytes.toList(), response.body.bytes().toList())
    }

    @Test
    fun image_response_unknown_length_is_not_peeked() {
        val body = object : ResponseBody() {
            private val buffer = Buffer().write(byteArrayOf(9, 8, 7))
            override fun contentType(): MediaType = "image/png".toMediaType()
            override fun contentLength(): Long = -1
            override fun source(): BufferedSource = buffer
        }
        val client = clientReturning { request -> response(request, body = body) }

        val response = client.newCall(Request.Builder().url("http://example.test/image").build()).execute()

        assertEquals(listOf(9, 8, 7), response.body.bytes().map { it.toInt() })
    }

    @Test
    fun status_101_upgrade_body_is_not_peeked() {
        var bodyRead = false
        val body = object : ResponseBody() {
            override fun contentType(): MediaType? = null
            override fun contentLength(): Long = -1
            override fun source(): BufferedSource {
                bodyRead = true
                return Buffer()
            }
        }
        val client = clientReturning { request ->
            response(request, code = 101, message = "Switching Protocols", body = body)
        }

        val response = client.newCall(Request.Builder().url("http://example.test/ws").build()).execute()

        assertEquals(101, response.code)
        assertFalse(bodyRead)
    }

    @Test
    fun streaming_text_response_is_teed_while_app_reads() {
        val client = clientReturning { request ->
            response(
                request,
                body = UnknownLengthResponseBody("text/event-stream".toMediaType(), "data: hello\n\n"),
            )
        }

        val response = client.newCall(Request.Builder().url("http://example.test/events").build()).execute()

        assertEquals(-1, response.body.contentLength())
        assertEquals("data: hello\n\n", response.body.string())
    }

    @Test
    fun report_response_failure_returns_original_response() {
        val body = object : ResponseBody() {
            override fun contentType(): MediaType = "text/plain".toMediaType()
            override fun contentLength(): Long = error("length failed")
            override fun source(): BufferedSource = Buffer().writeUtf8("ok")
        }
        val client = clientReturning { request -> response(request, body = body) }

        val response = client.newCall(Request.Builder().url("http://example.test/fallback").build()).execute()

        assertEquals("ok", response.body.string())
    }

    @Test
    fun binary_non_image_response_is_not_peeked_as_text() {
        val bytes = byteArrayOf(5, 6, 7)
        val client = clientReturning { request ->
            response(request, body = bytes.toResponseBody("application/octet-stream".toMediaType()))
        }

        val response = client.newCall(Request.Builder().url("http://example.test/bin").build()).execute()

        assertEquals(bytes.toList(), response.body.bytes().toList())
    }

    @Test
    fun request_body_skip_paths_still_reach_real_chain() {
        val bodies = listOf(
            "abc".toRequestBody("application/octet-stream".toMediaType()),
            object : RequestBody() {
                override fun contentType(): MediaType = "text/plain".toMediaType()
                override fun contentLength(): Long = -1
                override fun writeTo(sink: okio.BufferedSink) {
                    sink.writeUtf8("unknown")
                }
            },
            object : RequestBody() {
                override fun contentType(): MediaType = "text/plain".toMediaType()
                override fun contentLength(): Long = (MAX_BODY_CHARS + 1).toLong()
                override fun writeTo(sink: okio.BufferedSink) {
                    sink.writeUtf8("oversized")
                }
            },
        )
        val client = clientReturning { request ->
            response(request, body = request.bodyString().toResponseBody("text/plain".toMediaType()))
        }

        val results = bodies.mapIndexed { index, body ->
            client.newCall(
                Request.Builder()
                    .url("http://example.test/body/$index")
                    .post(body)
                    .build()
            ).execute().body.string()
        }

        assertEquals(listOf("abc", "unknown", "oversized"), results)
    }

    private fun clientReturning(block: (Request) -> Response): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor(SnifferOkHttp.interceptor())
            .addInterceptor { chain -> block(chain.request()) }
            .build()

    private fun response(
        request: Request,
        code: Int = 200,
        message: String = "OK",
        body: ResponseBody = "ok".toResponseBody("text/plain".toMediaType()),
    ): Response {
        val builder = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(message)
            .body(body)
        body.contentType()?.let { builder.header("content-type", it.toString()) }
        return builder.build()
    }

    private fun Request.bodyString(): String {
        val buffer = Buffer()
        body?.writeTo(buffer)
        return buffer.readUtf8()
    }

    private class UnknownLengthResponseBody(
        private val type: MediaType,
        private val value: String,
    ) : ResponseBody() {
        private val buffer = Buffer().writeUtf8(value)

        override fun contentType(): MediaType = type
        override fun contentLength(): Long = -1
        override fun source(): BufferedSource = buffer
    }
}
