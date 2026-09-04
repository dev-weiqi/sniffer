package dev.weiqi.sniffer.core

import io.ktor.http.cio.parseRequest
import io.ktor.network.selector.SelectorManager
import io.ktor.network.sockets.Socket
import io.ktor.network.sockets.aSocket
import io.ktor.network.sockets.openReadChannel
import io.ktor.network.sockets.openWriteChannel
import io.ktor.util.encodeBase64
import io.ktor.utils.io.InternalAPI
import io.ktor.util.sha1
import io.ktor.utils.io.writeStringUtf8
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.RawWebSocket
import io.ktor.websocket.WebSocketSession
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Device-side loopback port the daemon dials into over USB. Deliberately not [DEFAULT_PORT]:
 * the outbound `localhost:9091` attempt must never loop back into our own listener.
 */
const val USB_PORT = 9092

/**
 * iOS has no `adb reverse`: usbmuxd only lets the Mac open a connection *into* a device port.
 * So on a real device the SDK also listens on loopback; the daemon connects through usbmuxd,
 * performs the WebSocket *client* handshake and from then on the protocol is identical to
 * `/device`. This is the minimal RFC 6455 server side of that handshake.
 *
 * [accept] decides whether a fresh connection gets served (one live session at a time); a
 * refused socket is just closed and the daemon retries on its next poll.
 */
internal suspend fun serveUsb(port: Int, accept: () -> Boolean, session: suspend WebSocketSession.() -> Unit) {
    // ktor's selector loop is launched without a parent Job: an exception there would be an
    // unhandled coroutine exception, which terminates the process on Kotlin/Native. The handler
    // keeps the SDK's rule -- a monitoring failure must never take the host app down.
    val selector = SelectorManager(Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })
    try {
        val server = aSocket(selector).tcp().bind("127.0.0.1", port)
        try {
            coroutineScope {
                while (currentCoroutineContext().isActive) {
                    val socket = server.accept()
                    launch {
                        try {
                            if (accept()) socket.upgrade(session)
                        } catch (_: Throwable) {
                            // a broken handshake or dropped tunnel must never reach the host app
                        } finally {
                            socket.close()
                        }
                    }
                }
            }
        } finally {
            server.close()
        }
    } finally {
        // the caller retries on failure: a leaked selector is a thread parked in select() forever
        selector.close()
    }
}

private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// ponytail: DefaultWebSocketSession.start() is @InternalAPI; the alternative is answering ping/close by hand
@OptIn(InternalAPI::class)
private suspend fun Socket.upgrade(session: suspend WebSocketSession.() -> Unit) {
    val input = openReadChannel()
    val output = openWriteChannel(autoFlush = true)
    val request = parseRequest(input) ?: return
    val key = request.headers["Sec-WebSocket-Key"]?.toString().also { request.release() } ?: return
    val accept = sha1((key + WS_GUID).encodeToByteArray()).encodeBase64()
    output.writeStringUtf8(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $accept\r\n\r\n",
    )
    // servers send unmasked frames; DefaultWebSocketSession answers ping/close for us
    val raw = RawWebSocket(input, output, masking = false, coroutineContext = currentCoroutineContext())
    DefaultWebSocketSession(raw).apply { start() }.session()
}
