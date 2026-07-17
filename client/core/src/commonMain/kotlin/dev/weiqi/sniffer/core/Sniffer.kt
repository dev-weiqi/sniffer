package dev.weiqi.sniffer.core

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.concurrent.Volatile
import kotlin.coroutines.cancellation.CancellationException
import kotlin.uuid.Uuid

const val SDK_VERSION = "0.1.0"

/** Default daemon port. Single source for the SDK default and the sample apps. */
const val DEFAULT_PORT = 9091

/** Bodies larger than this are truncated (approximated by UTF-16 length). */
const val MAX_BODY_CHARS = 1024 * 1024

data class CappedBody(val body: String?, val size: Long, val truncated: Boolean)

fun capBody(raw: String?): CappedBody = when {
    raw == null -> CappedBody(null, 0, false)
    raw.length > MAX_BODY_CHARS -> CappedBody(raw.take(MAX_BODY_CHARS), raw.length.toLong(), true)
    else -> CappedBody(raw, raw.length.toLong(), false)
}

fun newId(): String = Uuid.random().toString()

fun now(): Long = epochMillis()

object Sniffer {
    private val queue = Channel<DeviceMessage>(1000, BufferOverflow.DROP_OLDEST)

    @Volatile
    private var capabilities: Set<String> = emptySet()

    @Volatile
    private var pushHandlers: Map<String, (event: String, payload: String) -> Unit> = emptyMap()

    // ponytail: Volatile narrows but does not eliminate the double-start race; atomics if it ever matters
    @Volatile
    private var scope: CoroutineScope? = null

    /**
     * Starts the connection to the daemon. Defaults to localhost:9091 (Android devices and
     * emulators are reached via the daemon's adb reverse; on iOS pass your Mac's LAN IP).
     * Calling it again is a no-op.
     */
    fun start(
        appId: String,
        host: String = "localhost",
        port: Int = DEFAULT_PORT,
        deviceName: String? = null,
    ) {
        if (scope != null) return
        // runtime override wins, so ports can be fixed without rebuilding (see configOverride)
        val actualHost = configOverride("host") ?: host
        val actualPort = configOverride("port")?.toIntOrNull() ?: port
        val name = deviceName ?: defaultDeviceName()
        val hello = Hello(
            // stable id: survives restarts so the daemon overwrites the same entry instead of piling up
            // ponytail: two same-model devices running the same app would collide; switch to a persisted random id if that ever matters
            deviceId = (name + appId).hashCode().toUInt().toString(16),
            deviceName = name,
            platform = platformName(),
            appId = appId,
            sdkVersion = SDK_VERSION,
            capabilities = emptyList(), // filled with the currently registered capabilities on every (re)connect
        )
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { sc ->
            sc.launch { connectLoop(actualHost, actualPort, hello) }
        }
    }

    fun stop() {
        scope?.cancel()
        scope = null
    }

    /** Reports one message. While disconnected, up to 1000 messages are buffered (oldest dropped). */
    fun report(msg: DeviceMessage) {
        queue.trySend(msg)
    }

    /** Plugin modules register their capability; it shows up in hello.capabilities. */
    fun registerCapability(name: String) {
        capabilities = capabilities + name
    }

    /** Socket modules register a handler for push-event (server→client injection). */
    fun registerPushHandler(connectionId: String, handler: (event: String, payload: String) -> Unit) {
        pushHandlers = pushHandlers + (connectionId to handler)
    }

    fun unregisterPushHandler(connectionId: String) {
        pushHandlers = pushHandlers - connectionId
    }

    private val client by lazy { HttpClient(CIO) { install(WebSockets) } }

    private suspend fun connectLoop(host: String, port: Int, hello: Hello) {
        while (currentCoroutineContext().isActive) {
            try {
                client.webSocket(host = host, port = port, path = "/device") {
                    send(SnifferJson.encodeToString<DeviceMessage>(hello.copy(capabilities = capabilities.toList())))
                    val sender = launch {
                        for (msg in queue) send(SnifferJson.encodeToString<DeviceMessage>(msg))
                    }
                    try {
                        for (frame in incoming) {
                            if (frame is Frame.Text) handleDaemonMessage(frame.readText())
                        }
                    } finally {
                        sender.cancel()
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // daemon not running: retry silently, the SDK must never affect the app
            }
            delay(3000)
        }
    }

    private fun handleDaemonMessage(text: String) {
        val msg = runCatching { SnifferJson.decodeFromString<DaemonMessage>(text) }.getOrNull() ?: return
        when (msg) {
            is MockRules -> MockRegistry.update(msg)
            is PushEvent -> {
                // expand ${randomId}/${now}/${randomString} just like mock payloads
                val payload = runCatching { expandMockPlaceholders(msg.payload) }.getOrDefault(msg.payload)
                val targets = if (msg.connectionId == null) pushHandlers.values
                else listOfNotNull(pushHandlers[msg.connectionId])
                // a throwing handler must not kill the daemon connection loop
                targets.forEach { h -> runCatching { h(msg.event, payload) } }
            }
        }
    }
}
