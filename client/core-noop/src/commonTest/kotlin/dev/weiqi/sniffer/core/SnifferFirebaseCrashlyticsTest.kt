package dev.weiqi.sniffer.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame

class SnifferFirebaseCrashlyticsTest {
    @Test
    fun release_twin_keeps_firebase_reporting() {
        val calls = mutableListOf<String>()
        val error = IllegalStateException("test")
        SnifferFirebaseCrashlytics.start("unused")
        SnifferFirebaseCrashlytics.log("log") { calls += it }
        SnifferFirebaseCrashlytics.setUserId("user") { calls += it }
        SnifferFirebaseCrashlytics.setCustomKey("key", "value") { k, v -> calls += "$k=$v" }
        SnifferFirebaseCrashlytics.recordException(error) { assertSame(error, it); calls += "exception" }
        SnifferFirebaseCrashlytics.recordFatal(error)
        SnifferFirebaseCrashlytics.stop()
        assertEquals(listOf("log", "user", "key=value", "exception"), calls)
    }
}
