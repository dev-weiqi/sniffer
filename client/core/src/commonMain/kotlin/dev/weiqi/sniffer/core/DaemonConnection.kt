package dev.weiqi.sniffer.core

import io.ktor.http.cio.parseResponse
import io.ktor.network.selector.SelectorManager
import io.ktor.network.sockets.aSocket
import io.ktor.network.sockets.openReadChannel
import io.ktor.network.sockets.openWriteChannel
import io.ktor.util.encodeBase64
import io.ktor.util.sha1
import io.ktor.utils.io.InternalAPI
import io.ktor.utils.io.writeStringUtf8
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.RawWebSocket
import io.ktor.websocket.WebSocketSession
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.uuid.Uuid

/** Shares the USB transport's socket/WebSocket primitives without registering a host HTTP engine. */
@OptIn(InternalAPI::class)
internal suspend fun connectDaemon(host: String, port: Int, block: suspend WebSocketSession.() -> Unit) = coroutineScope {
    require(host.isNotBlank() && host.none { it.isWhitespace() || it == '\r' || it == '\n' })
    require(port in 1..65535)
    val selector = SelectorManager(Dispatchers.IO + CoroutineExceptionHandler { _, _ -> })
    try {
        val socket = withTimeoutOrNull(5000) { aSocket(selector).tcp().connect(host, port) }
            ?: error("Daemon connection timed out")
        try {
            val input = socket.openReadChannel()
            val output = socket.openWriteChannel(autoFlush = true)
            val key = Uuid.random().toByteArray().encodeBase64()
            val authority = if (':' in host) "[$host]:$port" else "$host:$port"
            check(withTimeoutOrNull(5000) {
                output.writeStringUtf8(
                    "GET /device HTTP/1.1\r\nHost: $authority\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n\r\n",
                )
                val response = requireNotNull(parseResponse(input)) { "Missing WebSocket handshake" }
                try {
                    require(response.status == 101)
                    require(response.headers["Upgrade"]?.toString()?.equals("websocket", ignoreCase = true) == true)
                    require(response.headers["Connection"]?.toString()?.split(',')?.any { it.trim().equals("upgrade", ignoreCase = true) } == true)
                    require(response.headers["Sec-WebSocket-Accept"]?.toString() == sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encodeToByteArray()).encodeBase64())
                    require(response.headers["Sec-WebSocket-Extensions"] == null && response.headers["Sec-WebSocket-Protocol"] == null)
                } finally { response.release() }
                true
            } == true) { "Daemon handshake timed out" }
            // As on USB, Ktor handles framing, fragmentation, ping and close; clients must mask.
            val session = DefaultWebSocketSession(RawWebSocket(input, output, masking = true, coroutineContext = currentCoroutineContext()))
            try {
                session.start()
                session.block()
            } finally { session.cancel() }
        } finally { socket.close() }
    } finally { selector.close() }
}
