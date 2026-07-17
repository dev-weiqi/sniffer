package dev.weiqi.sniffer.ktor

import dev.weiqi.sniffer.core.BreakpointHitMsg
import dev.weiqi.sniffer.core.BreakpointRegistry
import dev.weiqi.sniffer.core.BreakpointResolution
import dev.weiqi.sniffer.core.HttpMockRule
import dev.weiqi.sniffer.core.HttpRequestMsg
import dev.weiqi.sniffer.core.HttpResponseMsg
import dev.weiqi.sniffer.core.MAX_BODY_CHARS
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.capBody
import dev.weiqi.sniffer.core.expandMockPlaceholders
import dev.weiqi.sniffer.core.newId
import dev.weiqi.sniffer.core.now
import kotlin.coroutines.cancellation.CancellationException
import io.ktor.client.HttpClient
import io.ktor.client.call.HttpClientCall
import io.ktor.client.call.body
import io.ktor.client.call.save
import io.ktor.client.plugins.ResponseException
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.client.utils.EmptyContent
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.InternalAPI
import io.ktor.utils.io.readAvailable
import io.ktor.utils.io.writeFully
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.onCompletion
import io.ktor.client.plugins.isSaved
import io.ktor.client.plugins.sse.SSESession
import io.ktor.http.HttpProtocolVersion
import io.ktor.util.date.GMTDate
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.currentCoroutineContext
import io.ktor.client.plugins.api.Send
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.request
import io.ktor.client.request.takeFrom
import io.ktor.client.statement.bodyAsText
import io.ktor.client.statement.HttpResponsePipeline
import io.ktor.client.statement.HttpResponseContainer
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.charset
import io.ktor.http.content.ByteArrayContent
import io.ktor.http.content.OutgoingContent
import io.ktor.http.content.TextContent
import io.ktor.http.contentType
import io.ktor.sse.ServerSentEvent
import io.ktor.util.AttributeKey
import io.ktor.util.flattenEntries
import io.ktor.utils.io.charsets.Charsets
import kotlinx.coroutines.delay
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

private val MockRuleKey = AttributeKey<HttpMockRule>("SnifferMockRule")

// Captured in onResponse so the real status survives even when a downstream validator
// (e.g. Eden's HttpResponseValidator) rethrows the error as a custom exception without a cause.
private class ResponseStatusHolder(var status: Int? = null, var headers: Map<String, String> = emptyMap())

private val StatusHolderKey = AttributeKey<ResponseStatusHolder>("SnifferStatusHolder")
private val SnifferSseIdKey = AttributeKey<String>("SnifferSseId")

/** Thrown when the user aborts a paused response; propagates out of the send pipeline. */
internal class BreakpointAbort : Exception("Sniffer breakpoint aborted")

// Fabricates a call carrying the edited response on the HOST's client, so the app's response
// pipeline (ContentNegotiation, ...) still applies — same approach as mockHttpCall. Transport
// headers are dropped: the edited body sets its own length.
@OptIn(InternalAPI::class)
private suspend fun breakpointCall(
    client: HttpClient,
    request: HttpRequestBuilder,
    status: Int,
    headersMap: Map<String, String>,
    bodyText: String,
): HttpClientCall {
    val headers = io.ktor.http.headers {
        headersMap.forEach { (k, v) ->
            if (!k.equals("content-length", true) && !k.equals("transfer-encoding", true)) append(k, v)
        }
    }
    val requestData = HttpRequestData(
        url = request.url.build(), method = request.method,
        headers = request.headers.build(), body = EmptyContent,
        executionContext = Job(), attributes = request.attributes,
    )
    val responseData = HttpResponseData(
        statusCode = HttpStatusCode.fromValue(status),
        requestTime = GMTDate(), headers = headers,
        version = HttpProtocolVersion.HTTP_1_1,
        body = ByteReadChannel(bodyText.encodeToByteArray()),
        callContext = currentCoroutineContext() + Job(),
    )
    return HttpClientCall(client, requestData, responseData)
}

// when a mock rule matches, fabricate the HttpClientCall on the HOST's client -- not an
// internal one -- so its response pipeline (ContentNegotiation, ...) still applies when the
// app calls body<T>() on the mocked response.
@OptIn(InternalAPI::class)
private suspend fun mockHttpCall(
    client: HttpClient,
    request: HttpRequestBuilder,
    rule: HttpMockRule,
    bodyText: String,
): HttpClientCall {
    val headers = io.ktor.http.headers {
        rule.headers.forEach { (k, v) -> append(k, v) }
        if (rule.headers.keys.none { it.equals("content-type", true) }) {
            append("content-type", "application/json")
        }
    }
    val requestData = HttpRequestData(
        url = request.url.build(),
        method = request.method,
        headers = request.headers.build(),
        body = EmptyContent,
        // parentless on purpose: nothing completes a fabricated call's job (see teeEventStream)
        executionContext = Job(),
        attributes = request.attributes,
    )
    val responseData = HttpResponseData(
        statusCode = HttpStatusCode.fromValue(rule.status),
        requestTime = GMTDate(),
        headers = headers,
        version = HttpProtocolVersion.HTTP_1_1,
        body = ByteReadChannel(bodyText.encodeToByteArray()),
        callContext = currentCoroutineContext() + Job(),
    )
    return HttpClientCall(client, requestData, responseData)
}


// plugins may wrap the user's body (e.g. the SSE plugin's SSEClientContent);
// ContentWrapper.delegate() is the public way back to the real content
private fun requestBodyText(body: Any): String? {
    var b = body
    while (b is OutgoingContent.ContentWrapper) b = b.delegate()
    return when (b) {
        is TextContent -> b.text
        is ByteArrayContent ->
            if (isTextual(b.contentType)) runCatching {
                // same rule as okhttp: don't decode more than capBody will keep
                val bytes = b.bytes()
                if (bytes.size > MAX_BODY_CHARS) null else bytes.decodeToString()
            }.getOrNull() else null
        else -> null
    }
}

private fun isTextual(contentType: ContentType?): Boolean =
    contentType == null ||
            contentType.match(ContentType.Text.Any) ||
            contentType.contentSubtype.contains("json", true) ||
            contentType.contentSubtype.contains("xml", true) ||
            contentType.contentSubtype.contains("x-www-form-urlencoded", true)

/** HttpClient { install(SnifferKtor) } */
val SnifferKtor = createClientPlugin("SnifferKtor") {
    Sniffer.registerCapability("http")
    Sniffer.registerCapability("breakpoint")

    // fires when a response is received, before any response validator can convert it to an exception
    onResponse { response ->
        response.call.attributes.getOrNull(StatusHolderKey)?.let { holder ->
            holder.status = response.status.value
            holder.headers = response.headers.flattenEntries().toMap()
        }
    }

    // SSE plugin sessions: observe events by swapping the pipeline subject for a delegating
    // wrapper — same SSESession type, so the SSE plugin's own Transform still accepts it.
    // Any failure falls back to the original, untouched session.
	    client.responsePipeline.intercept(HttpResponsePipeline.Parse) { (info, body) ->
	        val id = context.request.attributes.getOrNull(SnifferSseIdKey) ?: return@intercept
	        if (body !is SSESession) return@intercept
	        val wrapped = runCatching {
	            val headersMap = context.response.headers.flattenEntries().toMap()
	            val status = context.response.status.value
	            snifferSseSession(id, body, headersMap, status)
	        }.getOrNull() ?: return@intercept
	        proceedWith(HttpResponseContainer(info, wrapped))
	    }

    on(Send) { request ->
        val id = newId()
        val start = now()

        // ktor's SSE plugin (client.sse { … }) produces an engine-level SSESession body;
        // rebuilding or teeing that call destroys the session and every SSE request fails
        // with "Expected SSESession content but was ByteChannel". Report what we can and
        // hand the call through completely untouched.
        // Default-safe policy: any request wired to an engine-level response adapter (SSE
        // today, anything similar tomorrow) gets reported but never transformed or mocked.
        val handsOff = request.attributes.allKeys.any {
            it.name == "SSERequestFlag" || it.name == "ResponseAdapterAttributeKey"
        }
        if (handsOff) {
            runCatching {
                val reqBody = capBody(requestBodyText(request.body))
                Sniffer.report(
                    HttpRequestMsg(
                        id = id, method = request.method.value, url = request.url.buildString(),
                        headers = request.headers.build().flattenEntries().toMap(),
                        body = reqBody.body, bodySize = reqBody.size, bodyTruncated = reqBody.truncated,
                        library = "ktor", timestamp = now(),
                    )
                )
            }
            request.attributes.put(SnifferSseIdKey, id)
            val sseCall = proceed(request)
            runCatching {
                Sniffer.report(
                    HttpResponseMsg(
                        id = id, status = sseCall.response.status.value,
                        headers = sseCall.response.headers.flattenEntries().toMap(),
                        body = null, bodySize = 0, bodyTruncated = false,
                        durationMs = now() - start, mocked = false, error = null, timestamp = now(),
                    )
                )
            }
            return@on sseCall
        }

        val statusHolder = ResponseStatusHolder()
        request.attributes.put(StatusHolderKey, statusHolder)
        // Golden rule: a Sniffer bug must never break the host app's traffic. The
        // report/mock section runs fenced; on any SDK failure the request proceeds untouched.
        var injectedDelayMs = 0L
        try {
            val reqBodyRaw = requestBodyText(request.body)
            val reqBody = capBody(reqBodyRaw)
            val url = request.url.buildString()
            Sniffer.report(
                HttpRequestMsg(
                    id = id, method = request.method.value, url = url,
                    headers = request.headers.build().flattenEntries().toMap(),
                    body = reqBody.body, bodySize = reqBody.size, bodyTruncated = reqBody.truncated,
                    library = "ktor", timestamp = now(),
                )
            )

            val rule = MockRegistry.matchHttp(request.method.value, url)
            if (rule != null && !rule.delayOnly) {
                if (rule.delayMs > 0) delay(rule.delayMs)
                val body = expandMockPlaceholders(rule.body)
                val mockCall = mockHttpCall(client, request, rule, body)
                Sniffer.report(
                    HttpResponseMsg(
                        id = id, status = rule.status, headers = rule.headers,
                        body = body, bodySize = body.length.toLong(), bodyTruncated = false,
                        durationMs = rule.delayMs, mocked = true, error = null, timestamp = now(),
                    )
                )
                return@on mockCall
            }
            if (rule != null && rule.delayOnly && rule.delayMs > 0) {
                delay(rule.delayMs)
                injectedDelayMs = rule.delayMs
            }
        } catch (t: Throwable) {
            if (t is CancellationException) throw t
            // fall through to the real request
        }

        val call = try {
            proceed(request)
        } catch (e: ResponseException) {
            // reading an unsaved (streaming) error body would consume what the host may re-read
            val responseBody = if (e.response.isSaved) runCatching { e.response.bodyAsText() }.getOrNull() else null
            val cappedBody = capBody(responseBody)
            Sniffer.report(
                HttpResponseMsg(
                    id = id, status = e.response.status.value,
                    headers = e.response.headers.flattenEntries().toMap(),
                    body = cappedBody.body,
                    bodySize = cappedBody.size,
                    bodyTruncated = cappedBody.truncated,
                    durationMs = now() - start,
                    mocked = false,
                    error = e.toString(),
                    timestamp = now(),
                    delayedMs = injectedDelayMs,
                )
            )
            throw e
        } catch (e: Throwable) {
            // a validator may have rethrown a real HTTP error as a custom exception; recover the
            // status captured in onResponse. Only a genuine transport failure leaves status null.
            val captured = statusHolder.status
            Sniffer.report(
                HttpResponseMsg(
                    id = id, status = captured ?: 0, headers = statusHolder.headers, body = null,
                    bodySize = 0, bodyTruncated = false, durationMs = now() - start,
                    mocked = false, error = if (captured == null) e.toString() else null,
                    timestamp = now(),
                    delayedMs = injectedDelayMs,
                )
            )
            throw e
        }
        // fenced for the same reason: reporting must never replace or break the real response
        try {
            val durationMs = now() - start

            var resultCall = call
            var respBodyRaw: String? = null
            var respStatus = call.response.status.value
            var respHeaders = call.response.headers.flattenEntries().toMap()
            // a 101 (WebSocket upgrade) body is a live connection -- save() would freeze it, pass through.
            // SSE is a never-ending stream: tee it as the app consumes it, reporting body updates.
            // a malformed Content-Type from the server must not become our exception in the host
            val ct = runCatching { call.response.contentType() }.getOrNull()
            val isUpgrade = call.response.status.value == 101
            val isEventStream = ct?.contentSubtype?.contains("event-stream", ignoreCase = true) == true
            if (isEventStream) {
                Sniffer.report(
                    HttpResponseMsg(
                        id = id, status = call.response.status.value,
                        headers = call.response.headers.flattenEntries().toMap(),
                        body = null, bodySize = 0, bodyTruncated = false,
                        durationMs = durationMs, mocked = false, error = null, timestamp = now(), delayedMs = injectedDelayMs,
                    )
                )
                return@on teeEventStream(client, call, id, durationMs)
            }
            // a streaming call (prepareGet().execute { ... }) is not saved by ktor's SaveBody
            // plugin; save() here would read the ENTIRE body into memory (no cap) before the app
            // sees it. Report headers only and hand the call back untouched.
            if (!isUpgrade && !call.response.isSaved) {
                Sniffer.report(
                    HttpResponseMsg(
                        id = id, status = call.response.status.value,
                        headers = call.response.headers.flattenEntries().toMap(),
                        body = null, bodySize = 0, bodyTruncated = false,
                        durationMs = durationMs, mocked = false, error = null, timestamp = now(), delayedMs = injectedDelayMs,
                    )
                )
                return@on call
            }
            // images: capture raw bytes (<= 1MB) as base64 so the UI can render a preview
            if (!isUpgrade && ct?.contentType.equals("image", ignoreCase = true)) {
                var b64: String? = null
                var size = 0L
                var truncated = false
                runCatching {
                    resultCall = call.save()
                    val bytes = resultCall.body<ByteArray>()
                    size = bytes.size.toLong()
                    if (bytes.size <= MAX_BODY_CHARS) b64 = encodeBase64(bytes) else truncated = true
                }
                Sniffer.report(
                    HttpResponseMsg(
                        id = id, status = call.response.status.value,
                        headers = call.response.headers.flattenEntries().toMap(),
                        body = b64, bodySize = size, bodyTruncated = truncated,
                        durationMs = durationMs, mocked = false, error = null,
                        timestamp = now(), bodyBase64 = b64 != null,
                    )
                )
                return@on resultCall
            }
            if (!isUpgrade && isTextual(ct)) {
                runCatching {
                    resultCall = call.save()
                    respBodyRaw = resultCall.response.bodyAsText(
                        call.response.contentType()?.charset() ?: Charsets.UTF_8
                    )
                }
                // Breakpoint (response-phase): hold the saved textual response before the app reads
                // it. Abort propagates (see the catch below); a resume with edits fabricates a new
                // call carrying the edited status/headers/body.
                val bpRule = if (respBodyRaw != null)
                    BreakpointRegistry.match(request.method.value, request.url.buildString(), "response") else null
                if (bpRule != null) {
                    val hit = BreakpointHitMsg(
                        id = id, ruleId = bpRule.id, phase = "response",
                        method = request.method.value, url = request.url.buildString(),
                        status = respStatus, headers = respHeaders,
                        body = capBody(respBodyRaw).body, library = "ktor", timestamp = now(),
                    )
                    when (val res = Sniffer.awaitBreakpoint(hit)) {
                        is BreakpointResolution.Resume ->
                            if (res.status != null || res.headers != null || res.body != null) {
                                respStatus = res.status ?: respStatus
                                respHeaders = res.headers ?: respHeaders
                                respBodyRaw = res.body ?: respBodyRaw
                                resultCall = breakpointCall(client, request, respStatus, respHeaders, respBodyRaw ?: "")
                            }
                        BreakpointResolution.Abort -> throw BreakpointAbort()
                    }
                }
            }
            val respBody = capBody(respBodyRaw)
            Sniffer.report(
                HttpResponseMsg(
                    id = id, status = respStatus, headers = respHeaders,
                    body = respBody.body, bodySize = respBody.size, bodyTruncated = respBody.truncated,
                    durationMs = durationMs, mocked = false, error = null, timestamp = now(), delayedMs = injectedDelayMs,
                )
            )
            resultCall
        } catch (t: Throwable) {
            if (t is CancellationException || t is BreakpointAbort) throw t
            call
        }
    }
}

internal fun snifferSseSession(
    id: String,
    body: SSESession,
    headersMap: Map<String, String>,
    status: Int,
): SSESession {
    val captured = StringBuilder()
    var lastReport = 0L
    fun report(final: Boolean) {
        val nowMs = now()
        if (!final && nowMs - lastReport < 1000) return
        lastReport = nowMs
        val capped = capBody(captured.toString())
        Sniffer.report(
            HttpResponseMsg(
                id = id, status = status, headers = headersMap,
                body = capped.body, bodySize = capped.size, bodyTruncated = capped.truncated,
                durationMs = 0, mocked = false, error = null, timestamp = nowMs,
            )
        )
    }
    return object : SSESession {
        override val coroutineContext get() = body.coroutineContext
        override val incoming = body.incoming
            .onEach { ev ->
                runCatching {
                    ev.event?.let { captured.append("event: ").append(it).append('\n') }
                    ev.data?.let { captured.append("data: ").append(it).append('\n') }
                    captured.append('\n')
                    report(final = false)
                }
            }
            .onCompletion { runCatching { report(final = true) } }
    }
}

@OptIn(ExperimentalEncodingApi::class)
private fun encodeBase64(bytes: ByteArray): String = Base64.encode(bytes)

/** Rebuilds the call with a teed body channel; captured bytes are reported as throttled updates. */
@OptIn(InternalAPI::class)
private fun teeEventStream(
    client: HttpClient,
    call: HttpClientCall,
    id: String,
    durationMs: Long,
): HttpClientCall {
    val response = call.response
    val status = response.status
    val headers = response.headers
    val headersMap = headers.flattenEntries().toMap()
    val original = response.rawContent
    val teed = ByteChannel(autoFlush = true)
    val captured = StringBuilder()
    var lastReport = 0L

    fun report(final: Boolean) {
        val nowMs = now()
        if (!final && nowMs - lastReport < 1000) return
        lastReport = nowMs
        val capped = capBody(captured.toString())
        Sniffer.report(
            HttpResponseMsg(
                id = id, status = status.value, headers = headersMap,
                body = capped.body, bodySize = capped.size, bodyTruncated = capped.truncated,
                durationMs = durationMs, mocked = false, error = null, timestamp = nowMs,
            )
        )
    }

    call.launch {
        val buffer = ByteArray(8192)
        try {
            while (true) {
                val n = original.readAvailable(buffer, 0, buffer.size)
                if (n == -1) break
                if (n > 0) {
                    teed.writeFully(buffer, 0, n)
                    if (captured.length < MAX_BODY_CHARS) {
                        captured.append(buffer.decodeToString(0, n))
                    }
                    report(final = false)
                }
            }
        } finally {
            teed.close()
            report(final = true)
        }
    }

    val requestData = HttpRequestData(
        url = call.request.url,
        method = call.request.method,
        headers = call.request.headers,
        body = EmptyContent,
        // parentless on purpose: ktor never completes HttpRequestData.executionContext, and a
        // child job stuck in Completing pins the real call's job (connection cleanup never fires)
        executionContext = Job(),
        attributes = call.request.attributes,
    )
    val responseData = HttpResponseData(
        statusCode = status,
        requestTime = response.requestTime,
        headers = headers,
        version = response.version,
        body = teed,
        callContext = call.coroutineContext,
    )
    return HttpClientCall(client, requestData, responseData)
}
