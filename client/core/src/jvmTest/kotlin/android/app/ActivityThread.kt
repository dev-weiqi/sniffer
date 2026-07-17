package android.app

import android.content.ContentResolver

class ActivityThread {
    companion object {
        var deviceName: String? = null
        private val application = TestApplication()

        @JvmStatic
        fun currentApplication(): Any? = application
    }
}

class TestApplication {
    fun getContentResolver(): ContentResolver = ContentResolver()
}
