package dev.weiqi.sniffer.core

private val mockLock = Any()
internal actual fun <T> mockLocked(block: () -> T): T = synchronized(mockLock, block)
