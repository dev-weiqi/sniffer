package dev.weiqi.sniffer.firebase

import android.os.Bundle
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.analytics.ParametersBuilder
import dev.weiqi.sniffer.core.SnifferAnalytics

class SnifferFirebaseAnalytics private constructor(private val delegate: FirebaseAnalytics) {
    companion object {
        /** Keeps the supplied Firebase instance and mirrors its explicit Analytics calls locally. */
        fun wrap(analytics: FirebaseAnalytics): SnifferFirebaseAnalytics = SnifferFirebaseAnalytics(analytics)
    }

    fun logEvent(name: String, params: Bundle?) {
        val snapshot = runCatching { params?.toParams() }.getOrNull()
        SnifferAnalytics.logEvent(name, snapshot) { delegate.logEvent(name, params) }
    }

    fun logEvent(name: String, block: ParametersBuilder.() -> Unit) {
        logEvent(name, ParametersBuilder().apply(block).bundle)
    }

    fun setUserId(id: String?) = SnifferAnalytics.setUserId(id, delegate::setUserId)
}

@Suppress("DEPRECATION")
private fun Bundle.toParams(depth: Int = 0): Map<String, Any?> {
    check(depth <= 8) { "Analytics parameters are nested too deeply" }
    return keySet().associateWith { key ->
        when (val value = get(key)) {
            is Bundle -> value.toParams(depth + 1)
            is Array<*> -> value.map { if (it is Bundle) it.toParams(depth + 1) else it }
            is ArrayList<*> -> value.map { if (it is Bundle) it.toParams(depth + 1) else it }
            else -> value
        }
    }
}
