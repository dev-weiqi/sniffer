package android.provider

import android.app.ActivityThread
import android.content.ContentResolver

class Settings {
    class Global {
        companion object {
            @JvmStatic
            fun getString(resolver: ContentResolver, name: String): String? =
                ActivityThread.deviceName
        }
    }
}
