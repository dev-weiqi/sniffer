package dev.weiqi.sniffer.core

/** Release twin: preserve Firebase calls without capturing Analytics locally. */
object SnifferAnalytics {
    fun logEvent(name: String, params: Map<String, Any?>? = null, reportToFirebase: (() -> Unit)? = null) { reportToFirebase?.invoke() }
    fun setUserId(id: String?, reportToFirebase: (String?) -> Unit = {}) = reportToFirebase(id)
}
