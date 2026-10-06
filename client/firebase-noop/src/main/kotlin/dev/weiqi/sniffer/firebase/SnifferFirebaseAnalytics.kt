package dev.weiqi.sniffer.firebase

import android.os.Bundle
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.analytics.ParametersBuilder

/** No local capture in release builds. Every operation still calls the original Firebase instance. */
class SnifferFirebaseAnalytics private constructor(private val delegate: FirebaseAnalytics) {
    companion object {
        fun wrap(analytics: FirebaseAnalytics): SnifferFirebaseAnalytics = SnifferFirebaseAnalytics(analytics)
    }

    fun logEvent(name: String, params: Bundle?) = delegate.logEvent(name, params)

    fun logEvent(name: String, block: ParametersBuilder.() -> Unit) {
        delegate.logEvent(name, ParametersBuilder().apply(block).bundle)
    }

    fun setUserId(id: String?) = delegate.setUserId(id)
}
