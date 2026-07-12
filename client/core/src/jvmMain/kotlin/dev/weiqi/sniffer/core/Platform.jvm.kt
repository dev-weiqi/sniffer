package dev.weiqi.sniffer.core

// ponytail: a single jvm target detects Android via reflection, avoiding the whole AGP setup;
// add a real androidTarget once Android-specific APIs (e.g. ContentProvider auto-init) are needed
private val androidBuild: Class<*>? = runCatching { Class.forName("android.os.Build") }.getOrNull()

internal actual fun platformName(): String = if (androidBuild != null) "android" else "jvm"

internal actual fun defaultDeviceName(): String =
    androidBuild?.let { runCatching { it.getField("MODEL").get(null) as? String }.getOrNull() }
        ?: (runCatching { System.getProperty("os.name") }.getOrNull() ?: "jvm")

internal actual fun epochMillis(): Long = System.currentTimeMillis()

internal actual fun configOverride(key: String): String? {
    // Android: debug.* system properties are settable via adb without root
    val fromProp = runCatching {
        val sp = Class.forName("android.os.SystemProperties")
        sp.getMethod("get", String::class.java).invoke(null, "debug.sniffer.$key") as? String
    }.getOrNull()
    if (!fromProp.isNullOrBlank()) return fromProp
    return System.getProperty("sniffer.$key")
        ?: System.getenv("SNIFFER_${key.uppercase()}")?.takeIf { it.isNotBlank() }
}
