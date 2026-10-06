package dev.weiqi.sniffer.core

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class SnifferFirebaseCrashlyticsTest {
    @Test
    fun requests_keep_the_user_at_capture_time_including_logout() {
        val reports = mutableListOf<HttpRequestMsg>()
        SnifferFirebaseCrashlytics.stop()
        Sniffer.reportSinkForTests = { if (it is HttpRequestMsg) reports += it }
        val request = HttpRequestMsg("r1", "GET", "https://example.com", emptyMap(), null, 0, false, "okhttp", 1)
        try {
            Sniffer.report(request)
            SnifferFirebaseCrashlytics.setUserId("alice")
            Sniffer.report(request.copy(id = "r2"))
            SnifferFirebaseCrashlytics.setUserId("bob")
            Sniffer.report(request.copy(id = "r3"))
            SnifferFirebaseCrashlytics.setUserId("")
            Sniffer.report(request.copy(id = "r4"))
            assertEquals(listOf("", "alice", "bob", ""), reports.map { it.userId })
            val encoded = SnifferJson.encodeToString<DeviceMessage>(reports[1])
            assertEquals(reports[1], SnifferJson.decodeFromString<DeviceMessage>(encoded))
        } finally {
            Sniffer.reportSinkForTests = null
            SnifferFirebaseCrashlytics.stop()
        }
    }

    @Test
    fun wrapper_context_durable_fatals_and_host_handler_are_preserved() {
        val directory = Files.createTempDirectory("sniffer-firebase").toFile()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        val reports = mutableListOf<FirebaseEventMsg>()
        val forwarded = mutableListOf<String>()
        val error = IllegalStateException("payment failed", IllegalArgumentException("bad input"))
        var delegated: Throwable? = null
        val hostHandler = Thread.UncaughtExceptionHandler { _, throwable -> delegated = throwable }
        Thread.setDefaultUncaughtExceptionHandler(hostHandler)
        Sniffer.reportSinkForTests = { if (it is FirebaseEventMsg) reports += it }
        try {
            SnifferFirebaseCrashlytics.start(directory.path)
            val handler = Thread.getDefaultUncaughtExceptionHandler()!!
            SnifferFirebaseCrashlytics.start(directory.path)
            assertSame(handler, Thread.getDefaultUncaughtExceptionHandler())
            SnifferFirebaseCrashlytics.setUserId("user") { forwarded += it }
            SnifferFirebaseCrashlytics.setCustomKey("screen", "checkout") { key, value -> forwarded += "$key=$value" }
            SnifferFirebaseCrashlytics.log("Pay tapped") { forwarded += it }
            SnifferFirebaseCrashlytics.recordException(error) { assertSame(error, it); forwarded += "exception" }
            assertEquals(listOf("user", "screen=checkout", "Pay tapped", "exception"), forwarded)
            val nonfatal = reports.last()
            assertEquals("non-fatal", nonfatal.severity)
            assertEquals("checkout", nonfatal.keys["screen"])
            assertEquals("user", nonfatal.userId)
            assertEquals("Pay tapped", nonfatal.logs.single().message)
            assertTrue(nonfatal.stackTrace.contains("bad input"))
            val encoded = SnifferJson.encodeToString<DeviceMessage>(nonfatal)
            assertEquals(nonfatal, SnifferJson.decodeFromString<DeviceMessage>(encoded))
            SnifferFirebaseCrashlytics.setCustomKey("screen", "other")
            assertEquals("checkout", nonfatal.keys["screen"], "captured context is immutable")

            handler.uncaughtException(Thread.currentThread(), error)
            assertSame(error, delegated, "fatal delegates to Firebase's existing handler")
            val fatal = reports.last()
            assertEquals("fatal", fatal.severity)
            assertTrue(directory.resolve("sniffer-firebase.json").readText().contains(fatal.id))
            SnifferFirebaseCrashlytics.stop()
            assertSame(hostHandler, Thread.getDefaultUncaughtExceptionHandler())
            reports.clear()
            SnifferFirebaseCrashlytics.start(directory.path, captureUncaughtExceptions = false)
            assertEquals(listOf(fatal), SnifferFirebaseCrashlytics.pendingEvents())
            assertEquals(listOf(fatal), reports, "restart replays the original id and timestamp")
            handleDaemonMessage(SnifferJson.encodeToString<DaemonMessage>(FirebaseAck(fatal.id)), emptyMap())
            SnifferFirebaseCrashlytics.stop()
            SnifferFirebaseCrashlytics.start(directory.path, false)
            assertTrue(SnifferFirebaseCrashlytics.pendingEvents().isEmpty(), "ack survives restart")

            repeat(70) { SnifferFirebaseCrashlytics.log("x".repeat(5000)) }
            SnifferFirebaseCrashlytics.recordException(IllegalStateException("y".repeat(70000)))
            assertEquals(64, reports.last().logs.size)
            assertTrue(reports.last().logs.all { it.message.length == 4096 })
            assertTrue(reports.last().truncated)
            assertEquals(65536, reports.last().stackTrace.length)
            repeat(21) { SnifferFirebaseCrashlytics.recordFatal(error) }
            assertEquals(20, SnifferFirebaseCrashlytics.pendingEvents().size)
            SnifferFirebaseCrashlytics.stop()

            val unwritable = directory.resolve("not-a-directory").apply { writeText("file") }
            SnifferFirebaseCrashlytics.start(unwritable.path, false)
            reports.clear()
            SnifferFirebaseCrashlytics.recordFatal(error)
            assertEquals("fatal", reports.single().severity, "disk failure still allows live delivery")
            SnifferFirebaseCrashlytics.stop()

            directory.resolve("sniffer-firebase.json").writeText("broken json")
            SnifferFirebaseCrashlytics.start(directory.path)
            assertTrue(Thread.getDefaultUncaughtExceptionHandler() !== hostHandler, "corrupt history cannot disable capture")
            Sniffer.reportSinkForTests = { error("capture failed") }
            SnifferFirebaseCrashlytics.recordException(error) { forwarded += "still forwarded" }
            assertEquals("still forwarded", forwarded.last())
            delegated = null
            Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(Thread.currentThread(), error)
            assertSame(error, delegated, "capture failure must never swallow the host crash handler")
            val laterHandler = Thread.UncaughtExceptionHandler { _, _ -> }
            Thread.setDefaultUncaughtExceptionHandler(laterHandler)
            SnifferFirebaseCrashlytics.stop()
            assertSame(laterHandler, Thread.getDefaultUncaughtExceptionHandler(), "stop preserves a later handler")
        } finally {
            SnifferFirebaseCrashlytics.stop()
            Sniffer.reportSinkForTests = null
            Thread.setDefaultUncaughtExceptionHandler(previous)
            directory.deleteRecursively()
        }
    }
}
