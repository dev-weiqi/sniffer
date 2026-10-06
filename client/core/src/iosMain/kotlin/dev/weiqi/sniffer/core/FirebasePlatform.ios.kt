@file:OptIn(kotlin.experimental.ExperimentalNativeApi::class, kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package dev.weiqi.sniffer.core

import platform.Foundation.NSFileManager
import platform.Foundation.NSRecursiveLock
import platform.Foundation.NSString
import platform.Foundation.NSThread
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.create
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.writeToFile
import kotlin.native.getUnhandledExceptionHook
import kotlin.native.setUnhandledExceptionHook
import kotlin.native.terminateWithUnhandledException

private val firebaseLock = NSRecursiveLock()
internal actual fun <T> firebaseLocked(block: () -> T): T {
    firebaseLock.lock()
    try { return block() } finally { firebaseLock.unlock() }
}
internal actual fun firebaseThreadName(): String = NSThread.currentThread.name ?: ""
internal actual fun readFirebaseFile(path: String): String? =
    NSString.stringWithContentsOfFile(path, NSUTF8StringEncoding, null)
internal actual fun writeFirebaseFile(path: String, content: String) {
    NSFileManager.defaultManager.createDirectoryAtPath(path.substringBeforeLast('/'), true, null, null)
    check(NSString.create(string = content).writeToFile(path, true, NSUTF8StringEncoding, null))
}

internal actual fun installFirebaseCrashHandler(report: (Throwable, String) -> Unit): () -> Unit {
    val previous = getUnhandledExceptionHook()
    val handler: (Throwable) -> Unit = { error ->
        try { runCatching { report(error, firebaseThreadName()) } }
        finally {
            if (previous != null) previous(error) else terminateWithUnhandledException(error)
        }
    }
    setUnhandledExceptionHook(handler)
    return { if (getUnhandledExceptionHook() === handler) setUnhandledExceptionHook(previous) }
}
