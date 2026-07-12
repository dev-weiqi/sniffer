package dev.weiqi.sniffer.core

import platform.Foundation.NSDate
import platform.Foundation.NSProcessInfo
import platform.Foundation.timeIntervalSince1970
import platform.UIKit.UIDevice

internal actual fun platformName(): String = "ios"

internal actual fun defaultDeviceName(): String = UIDevice.currentDevice.name

internal actual fun epochMillis(): Long = (NSDate().timeIntervalSince1970 * 1000).toLong()

internal actual fun configOverride(key: String): String? =
    (NSProcessInfo.processInfo.environment["SNIFFER_${key.uppercase()}"] as? String)
        ?.takeIf { it.isNotBlank() }
