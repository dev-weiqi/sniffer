package dev.weiqi.sniffer.core

import android.app.ActivityThread
import android.os.Build
import android.os.SystemProperties
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PlatformJvmTest {
    @BeforeTest
    @AfterTest
    fun resetPlatformFakes() {
        SystemProperties.clear()
        ActivityThread.deviceName = null
        Build.MODEL = "sdk_gphone64_arm64"
        System.clearProperty("sniffer.host")
        System.clearProperty("sniffer.port")
        System.clearProperty("os.name")
    }

    @Test
    fun platform_name_detects_android_runtime_when_android_build_exists() {
        assertEquals("android", platformName())
    }

    @Test
    fun default_device_name_prefers_boot_avd_name() {
        SystemProperties.set("ro.boot.qemu.avd_name", "Pixel_9")
        SystemProperties.set("ro.kernel.qemu.avd_name", "Kernel_Device")

        assertEquals("Pixel_9", defaultDeviceName())
    }

    @Test
    fun default_device_name_uses_kernel_avd_name_when_boot_name_is_blank() {
        SystemProperties.set("ro.boot.qemu.avd_name", "")
        SystemProperties.set("ro.kernel.qemu.avd_name", "Kernel_Device")

        assertEquals("Kernel_Device", defaultDeviceName())
    }

    @Test
    fun default_device_name_uses_user_visible_android_name() {
        ActivityThread.deviceName = "Wei Pixel"

        assertEquals("Wei Pixel", defaultDeviceName())
    }

    @Test
    fun default_device_name_skips_generic_user_name_and_uses_build_model() {
        ActivityThread.deviceName = "sdk_gphone64_arm64"
        Build.MODEL = "Pixel 10"

        assertEquals("Pixel 10", defaultDeviceName())
    }

    @Test
    fun default_device_name_falls_back_to_os_name() {
        ActivityThread.deviceName = ""
        Build.MODEL = 42
        System.setProperty("os.name", "JUnit OS")

        assertEquals("JUnit OS", defaultDeviceName())
    }

    @Test
    fun config_override_prefers_android_debug_property_then_system_property() {
        System.setProperty("sniffer.host", "system-host")
        SystemProperties.set("debug.sniffer.host", "android-host")

        assertEquals("android-host", configOverride("host"))

        SystemProperties.set("debug.sniffer.host", "")
        assertEquals("system-host", configOverride("host"))
        assertEquals(null, configOverride("missing"))
    }

    @Test
    fun now_iso_is_utc_timestamp() {
        val value = nowIso()

        assertTrue(value.endsWith("Z"), value)
        assertNotNull(Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z""").matchEntire(value))
    }
}
