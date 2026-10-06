package dev.weiqi.sniffer.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Mirrors explicit Analytics calls without changing Firebase delivery or requiring a Firebase dependency. */
object SnifferAnalytics {
    private var userId: String? = null

    fun logEvent(name: String, params: Map<String, Any?>? = null, reportToFirebase: (() -> Unit)? = null) {
        // Firebase owns delivery. Only mark SDK-called after the original call returns normally.
        reportToFirebase?.invoke()
        runCatching {
            firebaseLocked {
                var truncated = name.length > 4096
                var remaining = 65536
                fun value(raw: Any?, depth: Int = 0): JsonElement {
                    if (depth > 8 || remaining <= 0) {
                        truncated = true
                        return JsonNull
                    }
                    remaining--
                    return when (raw) {
                        null -> JsonNull
                        is String -> {
                            val text = raw.take(remaining)
                            truncated = truncated || text.length != raw.length
                            remaining -= text.length
                            JsonPrimitive(text)
                        }
                        is Boolean -> JsonPrimitive(raw)
                        is Number -> if (raw.toDouble().isFinite()) JsonPrimitive(raw) else JsonNull
                        is Map<*, *> -> {
                            val entries = raw.entries.asSequence().take(64).takeWhile { remaining > 0 }.associate { (key, item) ->
                                val original = key as? String ?: error("Analytics parameter names must be strings")
                                val keyText = original.take(minOf(1024, remaining.coerceAtLeast(0)))
                                remaining -= keyText.length
                                truncated = truncated || keyText.length != original.length
                                keyText to value(item, depth + 1)
                            }
                            truncated = truncated || raw.size > entries.size
                            JsonObject(entries)
                        }
                        is List<*> -> {
                            val items = raw.asSequence().take(200).takeWhile { remaining > 0 }.map { value(it, depth + 1) }.toList()
                            truncated = truncated || raw.size > items.size
                            JsonArray(items)
                        }
                        is Array<*> -> value(raw.asList(), depth)
                        else -> error("Unsupported Analytics parameter type")
                    }
                }
                val snapshot = value(params ?: emptyMap<String, Any?>()) as JsonObject
                Sniffer.registerCapability("firebase")
                Sniffer.report(FirebaseAnalyticsEventMsg(
                    id = newId(), name = name.take(4096), params = snapshot,
                    timestamp = now(), userId = userId.orEmpty(), truncated = truncated,
                    firebaseSdkCalled = reportToFirebase != null,
                ))
            }
        }
    }

    fun setUserId(id: String?, reportToFirebase: (String?) -> Unit = {}) {
        reportToFirebase(id)
        runCatching {
            firebaseLocked {
                userId = id.orEmpty().take(1024)
                Sniffer.registerCapability("firebase")
            }
        }
    }

    internal fun userIdSnapshot(): String? = firebaseLocked { userId }
}
