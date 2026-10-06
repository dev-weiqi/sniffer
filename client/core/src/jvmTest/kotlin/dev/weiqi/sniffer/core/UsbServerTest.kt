package dev.weiqi.sniffer.core

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.ServerSocket
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The daemon dials in as a WebSocket client over usbmuxd; our hand-rolled 101 must satisfy a
    real client and the frames must round-trip through RawWebSocket. */
class UsbServerTest {
    private fun freePort() = ServerSocket(0).use { it.localPort }

    @Test
    fun outbound_transport_reuses_websocket_framing_without_an_http_client_engine() = runBlocking {
        val port = freePort()
        val server = launch {
            serveUsb(port, accept = { true }) {
                for (frame in incoming) if (frame is Frame.Text) send("echo:" + frame.readText())
            }
        }
        try {
            delay(200)
            withTimeout(5000) {
                repeat(2) { index ->
                    connectDaemon("127.0.0.1", port) {
                        send("message$index")
                        assertEquals("echo:message$index", (incoming.receive() as Frame.Text).readText())
                    }
                }
            }
        } finally { server.cancelAndJoin() }
    }

    @Test
    fun outbound_transport_rejects_an_invalid_websocket_accept() = runBlocking {
        ServerSocket(0).use { server ->
            val peer = async(Dispatchers.IO) {
                server.accept().use { socket ->
                    socket.soTimeout = 5000
                    val reader = socket.getInputStream().bufferedReader()
                    while (!reader.readLine().isNullOrEmpty()) { /* consume handshake headers */ }
                    socket.getOutputStream().write(("HTTP/1.1 101 Switching Protocols\r\n" +
                        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n").toByteArray())
                }
            }
            val result = runCatching { withTimeout(5000) { connectDaemon("127.0.0.1", server.localPort) {} } }
            peer.await()
            assertTrue(result.isFailure, "invalid handshakes must never enter a protocol session")
        }
    }

    @Test
    fun outbound_handshake_timeout_allows_the_connection_loop_to_retry() = runBlocking {
        ServerSocket(0).use { server ->
            val peer = async(Dispatchers.IO) {
                server.accept().use { socket ->
                    socket.soTimeout = 10000
                    while (socket.getInputStream().read() != -1) { /* wait for client timeout */ }
                }
            }
            val result = runCatching { withTimeout(10000) { connectDaemon("127.0.0.1", server.localPort) {} } }
            peer.await()
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() !is CancellationException, "transport timeout must not cancel reconnection")
        }
    }

    @Test
    fun serves_a_real_websocket_client_and_keeps_accepting() = runBlocking {
        val port = freePort()
        var accepted = 0
        val server = launch {
            serveUsb(port, accept = { accepted++; true }) {
                for (frame in incoming) if (frame is Frame.Text) send("echo:" + frame.readText())
            }
        }
        delay(200)
        val client = HttpClient(CIO) { install(WebSockets) }
        withTimeout(5000) {
            repeat(2) { i ->
                client.webSocket(host = "127.0.0.1", port = port, path = "/device") {
                    send("hi$i")
                    assertEquals("echo:hi$i", (incoming.receive() as Frame.Text).readText())
                }
            }
        }
        assertEquals(2, accepted)
        client.close()
        server.cancelAndJoin()
    }

    @Test
    fun refused_connections_are_closed_without_a_handshake() = runBlocking {
        val port = freePort()
        val server = launch { serveUsb(port, accept = { false }) { error("must not run") } }
        delay(200)
        val client = HttpClient(CIO) { install(WebSockets) }
        val failed = runCatching {
            withTimeout(5000) { client.webSocket(host = "127.0.0.1", port = port, path = "/device") {} }
        }.isFailure
        assertEquals(true, failed)
        client.close()
        server.cancelAndJoin()
    }
}
