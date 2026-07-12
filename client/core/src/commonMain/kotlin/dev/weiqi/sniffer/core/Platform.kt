package dev.weiqi.sniffer.core

internal expect fun platformName(): String
internal expect fun defaultDeviceName(): String
internal expect fun epochMillis(): Long

/**
 * Runtime connection override, so ports can be changed without rebuilding the app:
 * Android — `adb shell setprop debug.sniffer.host/.port` (debug.* needs no root);
 * iOS — SNIFFER_HOST / SNIFFER_PORT environment variables (Xcode scheme);
 * JVM — -Dsniffer.host/-Dsniffer.port or SNIFFER_HOST/SNIFFER_PORT env vars.
 */
internal expect fun configOverride(key: String): String?
