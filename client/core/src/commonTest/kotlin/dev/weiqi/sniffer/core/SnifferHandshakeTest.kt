package dev.weiqi.sniffer.core

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** Unplugging the device (or restarting the daemon) drops our link while the app's own sockets
    stay open. The daemon only hears about a socket on connect/disconnect, so a reconnect has to
    replay the ones still open -- otherwise saved push events have no live target to bind to. */
class SnifferHandshakeTest {
    private val hello = Hello(
        deviceId = "d1", deviceName = "JUnit", platform = "jvm",
        appId = "app", sdkVersion = SDK_VERSION, capabilities = emptyList(),
    )

    private fun status(id: String, status: String) = SocketStatusMsg(
        connectionId = id, transport = "socketio", url = "https://api.example.com",
        status = status, timestamp = 1,
    )

    @AfterTest
    fun cleanup() {
        // the object is a singleton: leave no open connection behind for the next test
        Sniffer.report(status("c1", "disconnected"))
        Sniffer.report(status("c2", "disconnected"))
        Sniffer.reportSinkForTests = null
    }

    @Test
    fun handshake_carries_the_registered_capabilities() {
        Sniffer.registerCapability("http")
        val hellos = Sniffer.handshakeMessages(hello).filterIsInstance<Hello>()
        assertEquals(1, hellos.size)
        assertEquals(true, hellos.single().capabilities.contains("http"))
    }

    @Test
    fun open_sockets_are_replayed_on_every_reconnect() {
        Sniffer.report(status("c1", "connected"))
        Sniffer.report(status("c2", "connected"))

        val replayed = Sniffer.handshakeMessages(hello).filterIsInstance<SocketStatusMsg>()
        assertEquals(listOf("c1", "c2"), replayed.map { it.connectionId }.sorted())
        assertEquals(listOf("connected", "connected"), replayed.map { it.status })

        // replaying twice must stay idempotent -- a reconnect loop must not pile connections up
        assertEquals(2, Sniffer.handshakeMessages(hello).filterIsInstance<SocketStatusMsg>().size)
    }

    @Test
    fun a_closed_socket_is_not_replayed() {
        Sniffer.report(status("c1", "connected"))
        Sniffer.report(status("c2", "connected"))
        Sniffer.report(status("c1", "disconnected"))

        val replayed = Sniffer.handshakeMessages(hello).filterIsInstance<SocketStatusMsg>()
        assertEquals(listOf("c2"), replayed.map { it.connectionId })
    }

    @Test
    fun a_reconnecting_socket_replaces_its_earlier_report() {
        Sniffer.report(status("c1", "connected"))
        val reconnected = status("c1", "connected").copy(url = "https://other.example.com")
        Sniffer.report(reconnected)

        val replayed = Sniffer.handshakeMessages(hello).filterIsInstance<SocketStatusMsg>()
        assertEquals(listOf(reconnected), replayed)
    }
}
