package dev.weiqi.sniffer.core

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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

    internal var reportSinkForTests: ((DeviceMessage) -> Unit)? = null

    @Volatile
    private var capabilities: Set<String> = emptySet()

    @Volatile
    private var pushHandlers: Map<String, (event: String, payload: String) -> Unit> = emptyMap()

    // sockets the app currently holds open, kept so a reconnect can re-announce them
    @Volatile
    private var liveConnections: Map<String, SocketStatusMsg> = emptyMap()

    // ponytail: Volatile narrows but does not eliminate the double-start race; atomics if it ever matters
    @Volatile
    private var scope: CoroutineScope? = null

    /**
     * Starts the connection to the daemon. Defaults to localhost:9091 (Android devices and
     * emulators are reached via the daemon's adb reverse; a physical iOS device is reached over
     * USB instead, see [USB_PORT], or pass your Mac's LAN IP for wifi). Calling it again is a no-op.
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
            if (usbListenerEnabled()) sc.launch { usbLoop(hello) }
        }
    }

    fun stop() {
        scope?.cancel()
        scope = null
        failOpen()
    }

    /** Reports one message. While disconnected, up to 1000 messages are buffered (oldest dropped). */
    fun report(msg: DeviceMessage) {
        if (msg is SocketStatusMsg) {
            liveConnections =
                if (msg.status == "connected") liveConnections + (msg.connectionId to msg)
                else liveConnections - msg.connectionId
        }
        reportSinkForTests?.invoke(msg)
        queue.trySend(msg)
    }

    /**
     * What the daemon is told on every (re)connect. Unplugging the device or restarting the
     * daemon kills our link while the app's own sockets stay open, and the daemon only ever
     * hears about a socket when it connects or disconnects -- so without replaying them here it
     * stays blind to those sockets until the app restarts, and saved push events lose their target.
     */
    internal fun handshakeMessages(hello: Hello): List<DeviceMessage> =
        listOf(hello.copy(capabilities = capabilities.toList())) + liveConnections.values

    /**
     * Pauses the calling response until the daemon resolves breakpoint [hit], returning how to
     * proceed. Never hangs the host when the daemon can't answer: returns Resume() immediately if
     * we're not connected, and a mid-pause disconnect releases every waiter with Resume().
     */
    suspend fun awaitBreakpoint(hit: BreakpointHitMsg): BreakpointResolution =
        Breakpoints.await(hit.id) { report(hit) }

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

    // outbound (wifi / adb reverse / simulator) and USB may both reach a daemon; one session drains the queue
    private val sessionLock = Mutex()

    @CoverageExcluded
    private suspend fun connectLoop(host: String, port: Int, hello: Hello) {
        while (currentCoroutineContext().isActive) {
            try {
                sessionLock.withLock {
                    client.webSocket(host = host, port = port, path = "/device") { runSession(hello) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // daemon not running: retry silently, the SDK must never affect the app
            }
            delay(3000)
        }
    }

    @CoverageExcluded
    private suspend fun usbLoop(hello: Hello) {
        val port = configOverride("usb_port")?.toIntOrNull() ?: USB_PORT
        while (currentCoroutineContext().isActive) {
            try {
                serveUsb(port, accept = { sessionLock.tryLock() }) {
                    try { runSession(hello) } finally { sessionLock.unlock() }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // ponytail: port held by another Sniffer app (even a suspended one) -> keep retrying; SNIFFER_USB_PORT overrides
            }
            delay(3000)
        }
    }

    /** The wire session, identical whichever side opened the socket. */
    private suspend fun WebSocketSession.runSession(hello: Hello) {
        for (msg in handshakeMessages(hello)) send(SnifferJson.encodeToString(msg))
        Breakpoints.connected = true
        val sender = launch {
            for (msg in queue) send(SnifferJson.encodeToString<DeviceMessage>(msg))
        }
        try {
            for (frame in incoming) {
                if (frame is Frame.Text) handleDaemonMessage(frame.readText(), pushHandlers)
            }
        } finally {
            Breakpoints.connected = false
            failOpen()
            sender.cancel()
        }
    }

}

internal fun handleDaemonMessage(
    text: String,
    pushHandlers: Map<String, (event: String, payload: String) -> Unit>,
) {
    val msg = runCatching { SnifferJson.decodeFromString<DaemonMessage>(text) }.getOrNull()
        ?: return failOpen()
    when (msg) {
        is MockRules -> MockRegistry.update(msg)
        is BreakpointRules -> BreakpointRegistry.update(msg.rules)
        is BreakpointResolveMsg -> Breakpoints.resolve(
            msg.id,
            if (msg.action == "abort") BreakpointResolution.Abort
            else BreakpointResolution.Resume(msg.status, msg.headers, msg.body),
        )
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

private fun failOpen() {
    MockRegistry.clear()
    BreakpointRegistry.clear()
    Breakpoints.releaseAll()
}
