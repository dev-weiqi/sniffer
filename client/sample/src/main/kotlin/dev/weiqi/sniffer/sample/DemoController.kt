package dev.weiqi.sniffer.sample

import androidx.compose.runtime.mutableStateListOf
import dev.weiqi.sniffer.core.DEFAULT_PORT
import dev.weiqi.sniffer.ktor.SnifferKtor
import dev.weiqi.sniffer.ktorws.SnifferKtorWs
import io.ktor.client.plugins.websocket.webSocketSession
import dev.weiqi.sniffer.okhttp.SnifferOkHttp
import dev.weiqi.sniffer.socketio.SnifferSocket
import dev.weiqi.sniffer.socketio.SnifferSocketIO
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
import io.socket.client.Ack
import io.socket.client.IO
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// localhost is reachable on the emulator/device through the daemon's adb reverse
private const val BASE = "http://localhost:$DEFAULT_PORT"
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

    private val okhttp by lazy {
        okhttp3.OkHttpClient.Builder().addInterceptor(SnifferOkHttp.interceptor()).build()
    }
    private val ktor by lazy {
        HttpClient(CIO) {
            install(SnifferKtor)
        install(SnifferKtorWs)
            install(io.ktor.client.plugins.sse.SSE)
            install(WebSockets)
        }
    }
    private var socket: SnifferSocket? = null
    private var ws: DefaultClientWebSocketSession? = null
    private var pendingWsAck: CompletableDeferred<String>? = null

    val sections = listOf(
        DemoSection("HTTP · OkHttp", listOf(
            DemoAction("GET") {
                io { okhttp.newCall(okhttp3.Request.Builder().url("$BASE/test/users/18").build()).execute()
                    .use { log("okhttp GET → ${it.code} ${it.body.string().take(120)}", it.kind()) } }
            },
            DemoAction("POST") {
                io {
                    val body = """{"hello":"sniffer","n":42}"""
                        .toRequestBody("application/json".toMediaType())
                    okhttp.newCall(okhttp3.Request.Builder().url("$BASE/test/echo").post(body).build()).execute()
                        .use { log("okhttp POST → ${it.code}", it.kind()) }
                }
            },
            DemoAction("Error") {
                io { okhttp.newCall(okhttp3.Request.Builder().url("$BASE/test/error").build()).execute()
                    .use { log("okhttp GET /test/error → ${it.code}", it.kind()) } }
            },
            DemoAction("IMG") {
                io {
                    okhttp.newCall(okhttp3.Request.Builder().url("$BASE/test/image").build()).execute().use { resp ->
                        log("okhttp IMG → ${resp.code} ${resp.body.bytes().size} bytes", resp.kind())
                    }
                }
            },
            DemoAction("WEBP") {
                io {
                    okhttp.newCall(okhttp3.Request.Builder().url(ANIMATED_WEBP).build()).execute().use { resp ->
                        log("okhttp WEBP → ${resp.code} ${resp.body.bytes().size} bytes", resp.kind())
                    }
                }
            },
            DemoAction("SSE") {
                io {
                    okhttp.newCall(okhttp3.Request.Builder().url("$BASE/test/sse").build()).execute().use { resp ->
                        log("SSE ← ${resp.code} streaming…", resp.kind())
                        val source = resp.body.source()
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            if (line.startsWith("data:")) log("SSE $line", LogKind.EVENT)
                        }
                        log("SSE done", LogKind.OK)
                    }
                }
            },
        )),
        DemoSection("HTTP · Ktor", listOf(
            DemoAction("GET") {
                val resp = ktor.get("$BASE/test/users/7")
                log("ktor GET → ${resp.status.value} ${resp.bodyAsText().take(120)}", resp.status.value.kind())
            },
            DemoAction("POST") {
                val resp = ktor.post("$BASE/test/echo") {
                    contentType(ContentType.Application.Json)
                    setBody("""{"from":"ktor"}""")
                }
                log("ktor POST → ${resp.status.value}", resp.status.value.kind())
            },
            DemoAction("Error") {
                val resp = ktor.get("$BASE/test/error")
                log("ktor GET /test/error → ${resp.status.value}", resp.status.value.kind())
            },
            DemoAction("IMG") {
                val resp = ktor.get("$BASE/test/image")
                val bytes: ByteArray = resp.body()
                log("ktor IMG → ${resp.status.value} ${bytes.size} bytes", resp.status.value.kind())
            },
            DemoAction("WEBP") {
                val resp = ktor.get(ANIMATED_WEBP)
                val bytes: ByteArray = resp.body()
                log("ktor WEBP → ${resp.status.value} ${bytes.size} bytes", resp.status.value.kind())
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
        DemoSection("Socket.IO", listOf(
            DemoAction("Connect") {
                if (socket != null) return@DemoAction log("already connected", LogKind.INFO)
                socket = SnifferSocketIO.wrap(IO.socket(BASE), BASE).also { s ->
                    s.on("chat:new") { args -> log("in chat:new: ${args.joinToString()}", LogKind.EVENT) }
                    s.connect()
                }
                log("socket.io connecting…", LogKind.INFO)
            },
            DemoAction("Send") {
                val s = socket ?: return@DemoAction log("connect first", LogKind.ERROR)
                s.emit("chat:send", "fire-and-forget from sample") // emit without ack
                log("emit chat:send (no ack)", LogKind.INFO)
            },
            DemoAction("ACK") {
                val s = socket ?: return@DemoAction log("connect first", LogKind.ERROR)
                s.emit("chat:send", "hello from sample", Ack { args ->
                    log("ack: ${args.joinToString()}", LogKind.OK)
                })
            },
            DemoAction("Disconnect") {
                socket?.disconnect() ?: return@DemoAction log("not connected", LogKind.ERROR)
                socket = null
                log("socket.io disconnected", LogKind.INFO)
            },
        )),
        DemoSection("Ktor WebSocket", listOf(
            DemoAction("Connect") {
                if (ws != null) return@DemoAction log("already connected", LogKind.INFO)
                val session = ktor.webSocketSession("ws://localhost:$DEFAULT_PORT/test/ws")
                ws = session
                log("ktor-ws connected", LogKind.OK)
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
                    log("ktor-ws closed", LogKind.INFO)
                    ws = null
                }
            },
            DemoAction("Send") {
                val session = ws ?: return@DemoAction log("connect first", LogKind.ERROR)
                session.send("ping ${System.currentTimeMillis()}")
            },
            DemoAction("ACK") {
                val session = ws ?: return@DemoAction log("connect first", LogKind.ERROR)
                // raw WebSocket has no protocol ack; correlate the next reply frame by convention
                val deferred = CompletableDeferred<String>()
                pendingWsAck = deferred
                session.send("req ${System.currentTimeMillis()}")
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

    fun dispose() = scope.cancel()

    private suspend fun io(block: () -> Unit) =
        kotlinx.coroutines.withContext(Dispatchers.IO) { block() }

    private fun log(text: String, kind: LogKind) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        val first = actionStart
        actionStart = false
        scope.launch { entries.add(LogEntry(time, text, kind, first)) }
    }

    private fun okhttp3.Response.kind() = code.kind()
    private fun Int.kind() = when {
        this in 200..299 -> LogKind.OK
        this >= 400 || this == 0 -> LogKind.ERROR
        else -> LogKind.INFO
    }
}
