package dev.weiqi.sniffer.core

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals

/** Same as the JVM UsbServerTest, on Kotlin/Native: the listener + hand-rolled handshake must work on iOS. */
class UsbServerNativeTest {
    @Test
    fun serves_a_real_websocket_client_on_native() = runBlocking {
        val port = 39092
        val server = launch {
            serveUsb(port, accept = { true }) {
                for (frame in incoming) if (frame is Frame.Text) send("echo:" + frame.readText())
            }
        }
        delay(300)
        val client = HttpClient(CIO) { install(WebSockets) }
        withTimeout(10_000) {
            client.webSocket(host = "127.0.0.1", port = port, path = "/device") {
                send("hi")
                assertEquals("echo:hi", (incoming.receive() as Frame.Text).readText())
            }
        }
        client.close()
        server.cancelAndJoin()
    }
}
