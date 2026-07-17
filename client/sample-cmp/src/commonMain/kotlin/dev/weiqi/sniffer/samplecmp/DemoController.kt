package dev.weiqi.sniffer.samplecmp

import androidx.compose.runtime.mutableStateListOf
import dev.weiqi.sniffer.core.DEFAULT_PORT
import dev.weiqi.sniffer.ktor.SnifferKtor
import dev.weiqi.sniffer.ktorws.SnifferKtorWs
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.call.body
import io.ktor.client.HttpClient
import io.ktor.client.plugins.sse.sse
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.utils.io.readUTF8Line
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

// Android reaches the daemon via adb reverse; the iOS simulator shares the Mac's loopback
const val BASE = "http://localhost:$DEFAULT_PORT"
private const val ANIMATED_WEBP = "https://mathiasbynens.be/demo/animated-webp-supported.webp"

enum class LogKind { INFO, OK, ERROR, EVENT }

class LogEntry(val time: String, val text: String, val kind: LogKind, val firstOfAction: Boolean)

class DemoAction(val label: String, val block: suspend DemoController.() -> Unit)

class DemoSection(val title: String, val actions: List<DemoAction>)

class DemoController {
    val entries = mutableStateListOf<LogEntry>()

    private val scope = MainScope()
    private val handler = CoroutineExceptionHandler { _, e -> log("error: $e", LogKind.ERROR) }
    private var actionStart = false

    private val ktor by lazy {
        HttpClient(CIO) {
            install(SnifferKtor)
        install(SnifferKtorWs)
            install(io.ktor.client.plugins.sse.SSE)
            install(WebSockets)
        }
    }
    private var ws: DefaultClientWebSocketSession? = null
    private var pendingWsAck: CompletableDeferred<String>? = null

    val sections = listOf(
        DemoSection("HTTP · Ktor", listOf(
            DemoAction("GET") {
                val resp = ktor.get("$BASE/test/users/7")
                log("GET → ${resp.status.value} ${resp.bodyAsText().take(120)}", resp.status.value.kind())
            },
            DemoAction("POST") {
                val resp = ktor.post("$BASE/test/echo") {
                    contentType(ContentType.Application.Json)
                    setBody("""{"from":"cmp","platform":"ktor"}""")
                }
                log("POST → ${resp.status.value}", resp.status.value.kind())
            },
            DemoAction("Error") {
                val resp = ktor.get("$BASE/test/error")
                log("GET /test/error → ${resp.status.value}", resp.status.value.kind())
            },
            DemoAction("IMG") {
                val resp = ktor.get("$BASE/test/image")
                val bytes: ByteArray = resp.body()
                log("IMG → ${resp.status.value} ${bytes.size} bytes", resp.status.value.kind())
            },
            DemoAction("WEBP") {
                val resp = ktor.get(ANIMATED_WEBP)
                val bytes: ByteArray = resp.body()
                log("WEBP → ${resp.status.value} ${bytes.size} bytes", resp.status.value.kind())
            },
            DemoAction("SSE") {
                // exercises ktor's engine-level SSE session (the path real apps use)
                ktor.sse("$BASE/test/sse") {
                    incoming.collect { ev ->
                        log("SSE data: ${ev.data}", LogKind.EVENT)
                    }
                }
            },
        )),
        DemoSection("Ktor WebSocket", listOf(
            DemoAction("Connect") {
                if (ws != null) return@DemoAction log("already connected", LogKind.INFO)
                val session = ktor.webSocketSession("ws://localhost:$DEFAULT_PORT/test/ws")
                ws = session
                log("ws connected", LogKind.OK)
                scope.launch(handler) {
                    for (frame in session.incoming) {
                        if (frame is Frame.Text) {
                            val text = frame.readText()
                            val pending = pendingWsAck
                            if (pending != null) {
                                pendingWsAck = null
                                pending.complete(text) // consumed as the reply to an emit+ack
                            } else {
                                log("ws in: ${text.take(100)}", LogKind.EVENT)
                            }
                        }
                    }
                    log("ws closed", LogKind.INFO)
                    ws = null
                }
            },
            DemoAction("Send") {
                val session = ws ?: return@DemoAction log("connect first", LogKind.ERROR)
                session.send("hello from cmp")
            },
            DemoAction("ACK") {
                val session = ws ?: return@DemoAction log("connect first", LogKind.ERROR)
                // raw WebSocket has no protocol ack; correlate the next reply frame by convention
                val deferred = CompletableDeferred<String>()
                pendingWsAck = deferred
                session.send("req ${timeNow()}")
                val reply = withTimeoutOrNull(3000) { deferred.await() }
                if (reply != null) log("ws ack: ${reply.take(100)}", LogKind.OK)
                else { pendingWsAck = null; log("ws ack: (timeout)", LogKind.ERROR) }
            },
            DemoAction("Disconnect") {
                val session = ws ?: return@DemoAction log("not connected", LogKind.ERROR)
                session.close(CloseReason(CloseReason.Codes.NORMAL, "bye"))
            },
        )),
    )

    fun clearLog() = entries.clear()

    fun run(action: DemoAction) {
        actionStart = true
        scope.launch(handler) { action.block(this@DemoController) }
    }

    private fun log(text: String, kind: LogKind) {
        val first = actionStart
        actionStart = false
        scope.launch { entries.add(LogEntry(timeNow(), text, kind, first)) }
    }

    private fun Int.kind() = when {
        this in 200..299 -> LogKind.OK
        this >= 400 || this == 0 -> LogKind.ERROR
        else -> LogKind.INFO
    }
}

internal expect fun timeNow(): String
