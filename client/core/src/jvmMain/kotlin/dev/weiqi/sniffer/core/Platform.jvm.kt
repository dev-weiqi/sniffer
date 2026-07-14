package dev.weiqi.sniffer.core

// ponytail: a single jvm target detects Android via reflection, avoiding the whole AGP setup;
// add a real androidTarget once Android-specific APIs (e.g. ContentProvider auto-init) are needed
private val androidBuild: Class<*>? = runCatching { Class.forName("android.os.Build") }.getOrNull()

internal actual fun platformName(): String = if (androidBuild != null) "android" else "jvm"

internal actual fun defaultDeviceName(): String =
    emulatorAvdName()
        ?: androidUserDeviceName()
        ?: androidBuild?.let { runCatching { it.getField("MODEL").get(null) as? String }.getOrNull() }
        ?: (runCatching { System.getProperty("os.name") }.getOrNull() ?: "jvm")

// emulators: the AVD name ("Pixel_9_Pro") beats the generic Build.MODEL ("sdk_gphone64_arm64")
private fun emulatorAvdName(): String? = runCatching {
    val sp = Class.forName("android.os.SystemProperties")
    val get = sp.getMethod("get", String::class.java)
    (get.invoke(null, "ro.boot.qemu.avd_name") as? String)?.takeIf { it.isNotBlank() }
        ?: (get.invoke(null, "ro.kernel.qemu.avd_name") as? String)?.takeIf { it.isNotBlank() }
}.getOrNull()

// physical devices: the user-visible name from Settings ("Wei's Pixel 8") when reachable
private fun androidUserDeviceName(): String? = runCatching {
    val app = Class.forName("android.app.ActivityThread")
        .getMethod("currentApplication").invoke(null) ?: return null
    val resolver = app.javaClass.getMethod("getContentResolver").invoke(app)
    val global = Class.forName("android.provider.Settings\$Global")
    val name = global.getMethod("getString", Class.forName("android.content.ContentResolver"), String::class.java)
        .invoke(null, resolver, "device_name") as? String
    name?.takeIf { it.isNotBlank() && !it.startsWith("sdk_gphone") }
}.getOrNull()

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
