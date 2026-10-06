package dev.weiqi.sniffer.core

import java.io.File
import java.io.FileOutputStream

private val firebaseLock = Any()
internal actual fun <T> firebaseLocked(block: () -> T): T = synchronized(firebaseLock, block)
internal actual fun firebaseThreadName(): String = Thread.currentThread().name
internal actual fun readFirebaseFile(path: String): String? = File(path).takeIf { it.isFile }?.readText()
internal actual fun writeFirebaseFile(path: String, content: String) {
    val file = File(path)
    file.parentFile?.mkdirs()
    val temp = File("$path.tmp")
    FileOutputStream(temp).use { it.write(content.toByteArray(Charsets.UTF_8)); it.fd.sync() }
    check(temp.renameTo(file)) { "Cannot save Firebase crash record" }
}

internal actual fun installFirebaseCrashHandler(report: (Throwable, String) -> Unit): () -> Unit {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    val handler = Thread.UncaughtExceptionHandler { thread, error ->
        try { runCatching { report(error, thread.name) } }
        finally {
            if (previous != null) previous.uncaughtException(thread, error)
            else {
                // ThreadGroup's default behavior without a default handler is to print the exception.
                System.err.println("Exception in thread \"${thread.name}\"")
                error.printStackTrace(System.err)
            }
        }
    }
    Thread.setDefaultUncaughtExceptionHandler(handler)
    return { if (Thread.getDefaultUncaughtExceptionHandler() === handler) Thread.setDefaultUncaughtExceptionHandler(previous) }
}
