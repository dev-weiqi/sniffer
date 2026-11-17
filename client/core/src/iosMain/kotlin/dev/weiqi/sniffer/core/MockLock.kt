package dev.weiqi.sniffer.core

import platform.Foundation.NSRecursiveLock

private val mockLock = NSRecursiveLock()
internal actual fun <T> mockLocked(block: () -> T): T {
    mockLock.lock()
    try { return block() } finally { mockLock.unlock() }
}
