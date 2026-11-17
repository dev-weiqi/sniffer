package dev.weiqi.sniffer.core

internal expect fun <T> mockLocked(block: () -> T): T
