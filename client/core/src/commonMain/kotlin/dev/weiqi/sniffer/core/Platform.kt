package dev.weiqi.sniffer.core

internal expect fun platformName(): String
internal expect fun defaultDeviceName(): String
internal expect fun epochMillis(): Long

/** Current time as an ISO-8601 UTC string, for the ${now} mock placeholder. */
internal expect fun nowIso(): String

/**
 * Runtime connection override, so ports can be changed without rebuilding the app:
 * Android — `adb shell setprop debug.sniffer.host/.port` (debug.* needs no root);
 * iOS — SNIFFER_HOST / SNIFFER_PORT environment variables (Xcode scheme);
 * JVM — -Dsniffer.host/-Dsniffer.port or SNIFFER_HOST/SNIFFER_PORT env vars.
 */
internal expect fun configOverride(key: String): String?

/**
 * Whether to accept daemon connections over USB (see UsbServer.kt). Only a physical iOS device
 * needs it: Android has adb reverse and the simulator shares the Mac's loopback.
 */
internal expect fun usbListenerEnabled(): Boolean
