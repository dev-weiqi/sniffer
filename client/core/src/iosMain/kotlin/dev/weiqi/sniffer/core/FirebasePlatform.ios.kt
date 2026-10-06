package dev.weiqi.sniffer.core

import platform.Foundation.NSRecursiveLock

private val firebaseLock = NSRecursiveLock()
internal actual fun <T> firebaseLocked(block: () -> T): T {
    firebaseLock.lock()
    try { return block() } finally { firebaseLock.unlock() }
}
