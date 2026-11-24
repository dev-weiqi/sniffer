package dev.weiqi.sniffer.core

import kotlin.concurrent.Volatile
import io.ktor.http.decodeURLQueryComponent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Currently active mock rules. The daemon replaces the full set on every update. */
object MockRegistry {
    @Volatile
    private var rules: MockRules = MockRules()

    private val positions = mutableMapOf<String, Int>()

    fun update(newRules: MockRules) = mockLocked {
        positions.keys.toList().forEach { id ->
            val previous = rules.http.find { it.id == id }
            val next = newRules.http.find { it.id == id }
            if (next == null || previous?.sequence != next.sequence) positions.remove(id)
        }
        rules = newRules.copy(http = newRules.http.map { it.copy(syncRevision = newRules.revision) },
            socket = newRules.socket.map { it.copy(syncRevision = newRules.revision) })
    }

    private val pathParameter by lazy { Regex("""\{[A-Za-z_][A-Za-z0-9_]*\}""") }

    private fun matchesPath(pattern: String, path: String): Boolean {
        if ('{' !in pattern || pattern == path) return pattern == path
        val expected = pattern.split('/')
        val actual = path.split('/')
        return expected.size == actual.size && expected.indices.all { i ->
            expected[i] == actual[i] || (actual[i].isNotEmpty() && pathParameter.matches(expected[i]))
        }
    }

    fun matchHttp(method: String, url: String): HttpMockRule? = matchHttp(method, url, null)

    fun matchHttp(method: String, url: String, body: String?): HttpMockRule? = matchHttp(method, url, body) { null }

    fun matchHttp(method: String, url: String, body: String?, headerValues: (String) -> List<String>?): HttpMockRule? = mockLocked {
        val rule = findHttp(method, url, body, headerValues) ?: return@mockLocked null
        if (rule.sse != null && (rule.delayOnly || rule.sequence != null || !rule.sse.valid() || rule.status != 200)) return@mockLocked null
        val sequence = rule.sequence ?: return@mockLocked rule.also { reportHit(it.id, it.syncRevision) }
        // Invalid imported rules must never turn into an unrestricted static mock.
        if (rule.delayOnly || sequence.steps.isEmpty() || sequence.steps.size > 100 ||
            sequence.onExhausted !in listOf("last", "loop", "stop") ||
            sequence.steps.any { it.status !in 100..599 || it.delayMs !in 0..300_000 }) return@mockLocked null
        val position = positions[rule.id] ?: 0
        if (position >= sequence.steps.size) throw MockSequenceExhausted()
        positions[rule.id] = when {
            position < sequence.steps.lastIndex -> position + 1
            sequence.onExhausted == "loop" -> 0
            sequence.onExhausted == "last" -> position
            else -> sequence.steps.size
        }
        val step = sequence.steps[position]
        reportHit(rule.id, rule.syncRevision, position)
        rule.copy(status = step.status, headers = step.headers, body = step.body,
            delayMs = step.delayMs, stepIndex = position)
    }

    private fun reportHit(id: String, revision: String?, stepIndex: Int? = null) {
        if (revision != null) runCatching { Sniffer.report(MockHitMsg(id, revision, now(), stepIndex)) }
    }

    private fun findHttp(method: String, url: String, body: String?, headerValues: (String) -> List<String>?): HttpMockRule? {
        val actual by lazy { body?.takeIf { it.length <= MAX_BODY_CHARS }?.let(::parseJson) }
        val path = pathOf(url)
        val query by lazy {
            runCatching {
                url.substringBefore('#').substringAfter('?', "").split('&').map {
                    it.substringBefore('=').decodeURLQueryComponent(plusIsSpace = true) to
                        it.substringAfter('=', "").decodeURLQueryComponent(plusIsSpace = true)
                }
            }.getOrNull()
        }
        var fallback: HttpMockRule? = null
        for (rule in rules.http) {
            if (!rule.enabled || rule.urlPattern.isEmpty() || !matchesPath(rule.urlPattern, path) ||
                (rule.method != null && !rule.method.equals(method, ignoreCase = true))) continue
            val condition = rule.bodyMatch?.takeUnless { it.isBlank() }
            val expected = condition?.let { parseJson(it) as? JsonObject }
            if (condition != null && expected == null) continue
            if (!rule.requestHeaders.all { (name, value) -> headerValues(name)?.contains(value) == true }) continue
            if (rule.requestHeaders.isEmpty() && rule.queryParams.isEmpty() && expected.isNullOrEmpty()) {
                if (fallback == null) fallback = rule
            } else if (rule.queryParams.all { (key, value) ->
                key.isNotBlank() && query?.contains(key to value) == true
            } && (expected.isNullOrEmpty() || matchesJson(expected, actual))) return rule
        }
        return fallback
    }

    private fun pathOf(url: String): String {
        val path = if (url.contains("://")) "/" + url.substringAfter("://").substringAfter('/', "") else url
        return path.substringBefore('?').substringBefore('#')
    }

    fun matchSocketAck(event: String): SocketMockRule? = matchSocketAck(event, "[]")

    fun matchSocketAck(event: String, args: String): SocketMockRule? =
        matchSocket("socketio", event) { (parseJson(args) as? JsonArray)?.firstOrNull() }?.also { reportHit(it.id, it.syncRevision) }

    /** ktor-ws "reply mock": matches outgoing text frames by substring and optional JSON fields. */
    fun matchWsSend(text: String): SocketMockRule? =
        matchSocket("ktor-ws", text) { parseJson(text) }?.also { reportHit(it.id, it.syncRevision) }

    private fun matchSocket(transport: String, event: String, payload: () -> JsonElement?): SocketMockRule? {
        val actual by lazy(payload)
        var fallback: SocketMockRule? = null
        for (rule in rules.socket) {
            if (!rule.enabled || rule.transport != transport ||
                !(if (transport == "ktor-ws") event.contains(rule.event) else event == rule.event)) continue
            val condition = rule.payloadMatch?.takeUnless { it.isBlank() }
            val expected = condition?.let { parseJson(it) as? JsonObject }
            if (condition != null && expected == null) continue // Invalid constraints must never become fallbacks.
            if (expected == null || expected.isEmpty()) {
                if (fallback == null) fallback = rule
            } else if (matchesJson(expected, actual)) return rule
        }
        return fallback
    }

    private fun parseJson(text: String): JsonElement? = runCatching { Json.parseToJsonElement(text) }.getOrNull()

    private fun matchesJson(expected: JsonElement, actual: JsonElement?, partial: Boolean = true): Boolean = when {
        expected is JsonObject -> actual is JsonObject && (partial || expected.size == actual.size) &&
            expected.all { (key, value) -> matchesJson(value, actual[key], partial) }
        expected is JsonArray -> actual is JsonArray && expected.size == actual.size &&
            expected.indices.all { matchesJson(expected[it], actual[it], false) }
        expected is JsonPrimitive && actual is JsonPrimitive && !expected.isString && !actual.isString &&
            expected.doubleOrNull != null -> expected.doubleOrNull == actual.doubleOrNull
        else -> expected == actual
    }
}
