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

    fun update(newRules: MockRules) {
        rules = newRules
    }

    // Exact-path match: [urlPattern] must equal the request's path (scheme, host, query and
    // fragment stripped). "/api/" no longer catches "/api/systems/v1/app-version". An empty
    // pattern matches nothing (a bare path always starts with "/").
    fun matchHttp(method: String, url: String): HttpMockRule? {
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
            if (!rule.enabled || rule.urlPattern.isEmpty() || path != rule.urlPattern ||
                (rule.method != null && !rule.method.equals(method, ignoreCase = true))) continue
            if (rule.queryParams.isEmpty()) {
                if (fallback == null) fallback = rule
            } else if (rule.queryParams.all { (key, value) ->
                key.isNotBlank() && query?.contains(key to value) == true
            }) return rule
        }
        return fallback
    }

    private fun pathOf(url: String): String {
        val path = if (url.contains("://")) "/" + url.substringAfter("://").substringAfter('/', "") else url
        return path.substringBefore('?').substringBefore('#')
    }

    fun matchSocketAck(event: String): SocketMockRule? = matchSocketAck(event, "[]")

    fun matchSocketAck(event: String, args: String): SocketMockRule? =
        matchSocket("socketio", event) { (parseJson(args) as? JsonArray)?.firstOrNull() }

    /** ktor-ws "reply mock": matches outgoing text frames by substring and optional JSON fields. */
    fun matchWsSend(text: String): SocketMockRule? =
        matchSocket("ktor-ws", text) { parseJson(text) }

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
