package dev.weiqi.sniffer.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class SnifferLifecycleTest {
    @AfterTest
    fun stopSniffer() {
        Sniffer.stop()
        Sniffer.reportSinkForTests = null
    }

    @Test
    fun lifecycle_methods_are_safe_without_daemon() = runBlocking {
        val reported = mutableListOf<DeviceMessage>()
        Sniffer.reportSinkForTests = reported::add

        Sniffer.stop()
        Sniffer.registerCapability("http")
        Sniffer.registerCapability("socketio")
        Sniffer.start(appId = "app", host = "127.0.0.1", port = 1, deviceName = "JUnit")
        Sniffer.start(appId = "app", host = "127.0.0.1", port = 1, deviceName = "JUnit")
        val msg = SocketStatusMsg(
            connectionId = "c1",
            transport = "socketio",
            url = "ws://example",
            status = "connected",
            timestamp = 1,
        )
        Sniffer.report(msg)
        Sniffer.registerPushHandler("c1") { _, _ -> }
        Sniffer.unregisterPushHandler("c1")
        delay(50)
        Sniffer.stop()
        Sniffer.stop()

        assertEquals(listOf<DeviceMessage>(msg), reported)
    }

    @Test
    fun start_uses_default_connection_arguments() = runBlocking {
        Sniffer.start(appId = "defaults")
        delay(50)
        Sniffer.stop()
    }
}
