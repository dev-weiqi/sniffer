package dev.weiqi.sniffer.samplecmp

import androidx.compose.ui.window.ComposeUIViewController
import dev.weiqi.sniffer.core.Sniffer
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.UIKit.UIViewController

fun MainViewController(): UIViewController {
    // the iOS simulator shares the Mac's loopback, so localhost reaches the daemon directly
    Sniffer.start(appId = "dev.weiqi.sniffer.samplecmp.ios")
    return ComposeUIViewController { App() }
}

private val formatter = NSDateFormatter().apply { dateFormat = "HH:mm:ss" }

internal actual fun timeNow(): String = formatter.stringFromDate(NSDate())
