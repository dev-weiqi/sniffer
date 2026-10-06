package dev.weiqi.sniffer.core

private val firebaseLock = Any()
internal actual fun <T> firebaseLocked(block: () -> T): T = synchronized(firebaseLock, block)
