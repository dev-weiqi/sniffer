package dev.weiqi.sniffer.sample

import android.app.Application
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.SnifferFirebaseCrashlytics

class SampleApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // defaults to localhost:9091 -- the daemon opens it via adb reverse
        SnifferFirebaseCrashlytics.start(filesDir.absolutePath)
        Sniffer.start(appId = packageName)
    }
}
