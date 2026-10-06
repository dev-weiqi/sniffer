package dev.weiqi.sniffer.core

/** Release twin: disable local capture while preserving every Firebase call. */
object SnifferFirebaseCrashlytics {
    fun start(directory: String? = null, captureUncaughtExceptions: Boolean = true) = Unit
    fun stop() = Unit
    fun log(message: String, reportToFirebase: (String) -> Unit = {}) = reportToFirebase(message)
    fun setUserId(id: String, reportToFirebase: (String) -> Unit = {}) = reportToFirebase(id)
    fun setCustomKey(key: String, value: String, reportToFirebase: (String, String) -> Unit = { _, _ -> }) = reportToFirebase(key, value)
    fun recordException(error: Throwable, reportToFirebase: (Throwable) -> Unit = {}) = reportToFirebase(error)
    fun recordFatal(error: Throwable, thread: String = "") = Unit
}
