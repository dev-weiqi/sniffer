package dev.weiqi.sniffer.core

/** Local Crashlytics mirror. Forwarding callbacks still run in the core-noop release twin. */
object SnifferFirebaseCrashlytics {
    private const val TEXT_LIMIT = 4096
    private const val STACK_LIMIT = 65536
    private var path: String? = null
    private var started = false
    private var uninstall: (() -> Unit)? = null
    private var pending = emptyList<FirebaseEventMsg>()
    private var logs = emptyList<FirebaseLog>()
    private var keys = emptyMap<String, String>()
    private var userId = ""

    /** Call after Firebase initialization. An optional private directory enables fatal replay after restart. */
    fun start(directory: String? = null, captureUncaughtExceptions: Boolean = true) {
        runCatching {
            firebaseLocked {
                if (started) return@firebaseLocked
                require(directory == null || directory.isNotBlank())
                val file = directory?.let { "${it.trimEnd('/')}/sniffer-firebase.json" }
                val saved = file?.let { runCatching { readFirebaseFile(it) }.getOrNull() }
                pending = saved?.let { runCatching { SnifferJson.decodeFromString<List<FirebaseEventMsg>>(it) }.getOrNull() }
                    ?.filter { it.severity == "fatal" }?.takeLast(20) ?: emptyList()
                path = file
                started = true
                Sniffer.registerCapability("firebase")
                if (captureUncaughtExceptions) uninstall = installFirebaseCrashHandler { error, thread ->
                    recordFatal(error, thread)
                }
                // Also supports starting this bridge after Sniffer already connected.
                pending.forEach(Sniffer::report)
            }
        }
    }

    fun stop() {
        runCatching {
            firebaseLocked {
                uninstall?.invoke()
                uninstall = null
                path = null
                started = false
                pending = emptyList()
                keys = emptyMap()
                logs = emptyList()
                userId = ""
            }
        }
    }

    fun log(message: String, reportToFirebase: (String) -> Unit = {}) {
        capture {
            val entry = FirebaseLog(now(), message.take(TEXT_LIMIT))
            logs = (logs + entry).takeLast(64)
            Sniffer.report(event("log", message).copy(timestamp = entry.timestamp))
        }
        reportToFirebase(message)
    }

    fun setUserId(id: String, reportToFirebase: (String) -> Unit = {}) {
        capture { userId = id.take(1024) }
        reportToFirebase(id)
    }

    fun setCustomKey(key: String, value: String, reportToFirebase: (String, String) -> Unit = { _, _ -> }) {
        capture {
            val name = key.take(1024)
            if (name.isNotBlank() && (name in keys || keys.size < 64)) keys = keys + (name to value.take(1024))
        }
        reportToFirebase(key, value)
    }

    fun recordException(error: Throwable, reportToFirebase: (Throwable) -> Unit = {}) {
        capture { Sniffer.report(exceptionEvent(error, "non-fatal", firebaseThreadName())) }
        reportToFirebase(error)
    }

    /** Records only; does not crash or send a non-fatal report to Firebase. */
    fun recordFatal(error: Throwable, thread: String = "") {
        capture {
            val event = exceptionEvent(error, "fatal", thread)
            // Persist synchronously before delegating to the host's crash handler. Never wait on a socket.
            // ponytail: retain the latest 20 unacknowledged fatals; increase only for longer offline runs.
            pending = (pending + event).takeLast(20)
            runCatching { persist() }
            Sniffer.report(event)
        }
    }

    internal fun pendingEvents(): List<FirebaseEventMsg> = firebaseLocked { pending.toList() }

    internal fun userIdSnapshot(): String = firebaseLocked { userId }

    internal fun acknowledge(id: String) {
        capture {
            if (pending.any { it.id == id }) {
                pending = pending.filterNot { it.id == id }
                persist()
            }
        }
    }

    private fun persist() {
        path?.let { writeFirebaseFile(it, SnifferJson.encodeToString(pending)) }
    }

    private fun capture(block: () -> Unit) {
        runCatching { firebaseLocked { Sniffer.registerCapability("firebase"); block() } }
    }

    private fun event(severity: String, message: String) = FirebaseEventMsg(
        id = newId(), severity = severity, message = message.take(TEXT_LIMIT), timestamp = now(),
        userId = userId, keys = keys.toMap(), logs = if (severity == "log") emptyList() else logs.toList(),
        truncated = message.length > TEXT_LIMIT,
    )

    private fun exceptionEvent(error: Throwable, severity: String, thread: String): FirebaseEventMsg {
        val stack = error.stackTraceToString()
        return event(severity, error.message ?: error::class.simpleName.orEmpty()).copy(
            exception = error::class.simpleName.orEmpty().take(1024), stackTrace = stack.take(STACK_LIMIT),
            thread = thread.take(1024), truncated = stack.length > STACK_LIMIT || (error.message?.length ?: 0) > TEXT_LIMIT,
        )
    }
}

internal expect fun <T> firebaseLocked(block: () -> T): T
internal expect fun readFirebaseFile(path: String): String?
internal expect fun writeFirebaseFile(path: String, content: String)
internal expect fun firebaseThreadName(): String
internal expect fun installFirebaseCrashHandler(report: (Throwable, String) -> Unit): () -> Unit
