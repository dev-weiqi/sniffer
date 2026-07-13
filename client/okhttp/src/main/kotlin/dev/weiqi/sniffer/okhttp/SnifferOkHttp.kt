package dev.weiqi.sniffer.okhttp

import dev.weiqi.sniffer.core.HttpRequestMsg
import dev.weiqi.sniffer.core.HttpResponseMsg
import dev.weiqi.sniffer.core.MAX_BODY_CHARS
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.capBody
import dev.weiqi.sniffer.core.expandMockPlaceholders
import dev.weiqi.sniffer.core.newId
import dev.weiqi.sniffer.core.now
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.buffer as okioBuffer
import java.io.IOException
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

object SnifferOkHttp {
    /**
     * Attach via OkHttpClient.Builder().addInterceptor(...).
     * Requests to a host in [ignoredHosts] pass through unreported and unmocked
     * (e.g. noisy CDN/static-asset domains).
     */
    fun interceptor(ignoredHosts: Set<String> = emptySet()): Interceptor =
        SnifferInterceptor(ignoredHosts)
}

private val TEXTUAL = listOf("json", "text", "xml", "x-www-form-urlencoded", "javascript")

private fun isTextual(contentType: String?): Boolean =
    contentType == null || TEXTUAL.any { contentType.contains(it, ignoreCase = true) }

private fun isImage(contentType: String?): Boolean =
    contentType?.trim()?.startsWith("image/", ignoreCase = true) == true

internal class SnifferInterceptor(
    private val ignoredHosts: Set<String> = emptySet(),
) : Interceptor {
    init {
        Sniffer.registerCapability("http")
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.url.host in ignoredHosts) return chain.proceed(request)
        val id = newId()
        val start = System.nanoTime()

        // Golden rule: a Sniffer bug must never break the host app's traffic. Everything
        // except the real chain.proceed runs fenced — on any SDK failure the request and
        // response pass through untouched.
        var injectedDelayMs = 0L
        try {
            reportRequest(id, request)
            val rule = MockRegistry.matchHttp(request.method, request.url.toString())
            if (rule != null) {
                if (rule.delayMs > 0) Thread.sleep(rule.delayMs)
                if (rule.delayOnly) injectedDelayMs = rule.delayMs
                else return mockResponse(id, request, rule)
            }
        } catch (t: Throwable) {
            // restore the flag so host cancellation semantics survive the fence
            if (t is InterruptedException) Thread.currentThread().interrupt()
            // fall through to the real request
        }

        val response = try {
            chain.proceed(request)
        } catch (e: IOException) {
            runCatching {
                Sniffer.report(
                    HttpResponseMsg(
                        id = id, status = 0, headers = emptyMap(), body = null,
                        bodySize = 0, bodyTruncated = false,
                        durationMs = (System.nanoTime() - start) / 1_000_000,
                        mocked = false, error = e.toString(), timestamp = now(),
                        delayedMs = injectedDelayMs,
                    )
                )
            }
            throw e
        }
        return try {
            reportResponse(id, start, response, injectedDelayMs)
        } catch (t: Throwable) {
            response
        }
    }

    private fun reportRequest(id: String, request: Request) {
        val reqBodyRaw = request.body?.let { body ->
            val len = runCatching { body.contentLength() }.getOrDefault(-1L)
            if (body.isOneShot() || body.isDuplex() || !isTextual(body.contentType()?.toString())) null
            // capBody would drop the excess anyway: never pay a full copy+decode of an
            // oversized/unknown-length body on the host's request thread
            else if (len < 0 || len > MAX_BODY_CHARS) null
            else runCatching { Buffer().also(body::writeTo).readUtf8() }.getOrNull()
        }
        val reqBody = capBody(reqBodyRaw)
        Sniffer.report(
            HttpRequestMsg(
                id = id, method = request.method, url = request.url.toString(),
                headers = request.headers.toMap(),
                body = reqBody.body,
                bodySize = request.body?.let { runCatching { it.contentLength() }.getOrNull() } ?: reqBody.size,
                bodyTruncated = reqBody.truncated,
                library = "okhttp", timestamp = now(),
            )
        )
    }

    private fun mockResponse(id: String, request: Request, rule: dev.weiqi.sniffer.core.HttpMockRule): Response {
        val body = expandMockPlaceholders(rule.body)
        val contentType = rule.headers.entries
            .firstOrNull { it.key.equals("content-type", true) }?.value ?: "application/json"
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(rule.status)
            .message("Sniffer Mock")
            .apply { rule.headers.forEach { (k, v) -> addHeader(k, v) } }
            .body(body.toResponseBody(contentType.toMediaTypeOrNull()))
            .build()
        Sniffer.report(
            HttpResponseMsg(
                id = id, status = rule.status, headers = rule.headers,
                body = body, bodySize = body.length.toLong(), bodyTruncated = false,
                durationMs = rule.delayMs, mocked = true, error = null, timestamp = now(),
            )
        )
        return response
    }

    private fun reportResponse(id: String, start: Long, response: Response, delayedMs: Long): Response {
        val durationMs = (System.nanoTime() - start) / 1_000_000

        val respCt = response.header("content-type")
        // a 101 upgrade body is a live connection: never peek or tee it (it usually has no
        // content-type, so the unknown-length-textual tee below would otherwise grab it)
        if (response.code == 101) {
            Sniffer.report(
                HttpResponseMsg(
                    id = id, status = response.code, headers = response.headers.toMap(),
                    body = null, bodySize = 0, bodyTruncated = false,
                    durationMs = durationMs, mocked = false, error = null,
                    timestamp = now(), delayedMs = delayedMs,
                )
            )
            return response
        }
        // images: capture the raw bytes (<= 1MB) as base64 so the UI can render a preview
        if (isImage(respCt)) {
            // peekBody blocks until byteCount bytes or EOF: only safe when the length is known
            val bytes = if (response.body.contentLength() >= 0)
                runCatching { response.peekBody((MAX_BODY_CHARS + 1).toLong()).bytes() }.getOrNull()
            else null
            val fits = bytes != null && bytes.size <= MAX_BODY_CHARS
            Sniffer.report(
                HttpResponseMsg(
                    id = id, status = response.code, headers = response.headers.toMap(),
                    body = if (fits) encodeBase64(bytes!!) else null,
                    bodySize = bytes?.size?.toLong() ?: 0,
                    bodyTruncated = bytes != null && !fits,
                    durationMs = durationMs, mocked = false, error = null,
                    timestamp = now(), bodyBase64 = fits, delayedMs = delayedMs,
                )
            )
            return response
        }
        // streaming responses (SSE) must not be peeked: peekBody blocks until the stream ends.
        // Instead, tee the body as the app consumes it and report updates with the same id.
        if (respCt?.contains("event-stream", ignoreCase = true) == true ||
            (isTextual(respCt) && response.body.contentLength() < 0)
        ) {
            Sniffer.report(
                HttpResponseMsg(
                    id = id, status = response.code, headers = response.headers.toMap(),
                    body = null, bodySize = 0, bodyTruncated = false,
                    durationMs = durationMs, mocked = false, error = null, timestamp = now(), delayedMs = delayedMs,
                )
            )
            return response.newBuilder()
                .body(TeeResponseBody(response.body, id, response.code, response.headers.toMap(), durationMs))
                .build()
        }
        val respBodyRaw =
            if (isTextual(respCt))
                runCatching { response.peekBody((1024 * 1024 + 1).toLong()).string() }.getOrNull()
            else null
        val respBody = capBody(respBodyRaw)
        Sniffer.report(
            HttpResponseMsg(
                id = id, status = response.code, headers = response.headers.toMap(),
                body = respBody.body, bodySize = respBody.size, bodyTruncated = respBody.truncated,
                durationMs = durationMs, mocked = false, error = null, timestamp = now(), delayedMs = delayedMs,
            )
        )
        return response
    }
}

private fun okhttp3.Headers.toMap(): Map<String, String> =
    names().associateWith { name -> values(name).joinToString(", ") }

@OptIn(ExperimentalEncodingApi::class)
private fun encodeBase64(bytes: ByteArray): String = Base64.encode(bytes)

/** Captures a streaming body (SSE) as the app reads it, reporting throttled body updates. */
private class TeeResponseBody(
    private val delegate: okhttp3.ResponseBody,
    private val id: String,
    private val status: Int,
    private val headers: Map<String, String>,
    private val durationMs: Long,
) : okhttp3.ResponseBody() {
    private val captured = java.io.ByteArrayOutputStream()
    private var lastReport = 0L
    private var finished = false

    override fun contentType() = delegate.contentType()
    override fun contentLength() = delegate.contentLength()

    // memoized: ResponseBody.close() calls source() again -- a fresh wrapper per call would
    // stack tees over the same delegate
    private val teedSource by lazy {
        object : okio.ForwardingSource(delegate.source()) {
            override fun read(sink: Buffer, byteCount: Long): Long {
                val read = super.read(sink, byteCount)
                // monitoring must never throw into the host's stream read loop
                runCatching {
                    if (read > 0 && captured.size() < MAX_BODY_CHARS) {
                        sink.copyTo(captured, sink.size - read, read)
                        maybeReport(final = false)
                    } else if (read == -1L) {
                        maybeReport(final = true)
                    }
                }
                return read
            }

            override fun close() {
                runCatching { maybeReport(final = true) }
                super.close()
            }
        }.okioBuffer()
    }

    override fun source(): okio.BufferedSource = teedSource

    private fun maybeReport(final: Boolean) {
        if (finished) return
        if (final) finished = true
        val nowMs = now()
        if (!final && nowMs - lastReport < 1000) return
        lastReport = nowMs
        val text = captured.toString(Charsets.UTF_8)
        val capped = capBody(text)
        Sniffer.report(
            HttpResponseMsg(
                id = id, status = status, headers = headers,
                body = capped.body, bodySize = capped.size, bodyTruncated = capped.truncated,
                durationMs = durationMs, mocked = false, error = null, timestamp = nowMs,
            )
        )
    }
}
