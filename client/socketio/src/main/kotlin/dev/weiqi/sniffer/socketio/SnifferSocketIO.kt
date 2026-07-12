package dev.weiqi.sniffer.socketio

import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.SocketAckMsg
import dev.weiqi.sniffer.core.SocketEventMsg
import dev.weiqi.sniffer.core.SocketStatusMsg
import dev.weiqi.sniffer.core.expandMockPlaceholders
import dev.weiqi.sniffer.core.newId
import dev.weiqi.sniffer.core.now
import io.socket.client.Ack
import io.socket.client.Socket
import io.socket.emitter.Emitter
import io.socket.thread.EventThread
import org.json.JSONArray
import org.json.JSONTokener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object SnifferSocketIO {
    /**
     * Wraps a socket.io [Socket]. The returned [SnifferSocket] IS an [Emitter], so any code that
     * used the raw Socket (on/once/off/emit/listeners) keeps working — emit/on are reported to the
     * daemon and support ack mocking and server→client injection.
     */
    fun wrap(socket: Socket, url: String = ""): SnifferSocket {
        Sniffer.registerCapability("socketio")
        return SnifferSocket(socket, url)
    }
}

private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
    Thread(r, "sniffer-socketio").apply { isDaemon = true }
}

/**
 * Emitter-compatible monitoring wrapper around a socket.io [Socket]. Create via [SnifferSocketIO.wrap].
 */
class SnifferSocket internal constructor(
    val delegate: Socket,
    private val url: String,
) : Emitter() {
    private val connectionId = newId()
    private val bridged = ConcurrentHashMap.newKeySet<String>()

    init {
        // report connection status even if the app never subscribes to these events
        ensureBridge(Socket.EVENT_CONNECT)
        ensureBridge(Socket.EVENT_DISCONNECT)
    }

    // server→client injection from the daemon: fire the app's own listeners like a real event.
    // Registered per-connection (idempotent) so the handler dies with the connection and
    // re-registering on reconnect works.
    private fun registerPushHandler() {
        Sniffer.registerPushHandler(connectionId) { event, payload ->
            val args = parseArgs(payload)
            Sniffer.report(
                SocketEventMsg(newId(), connectionId, "socketio", "in", event, toJsonArrayString(args), mocked = true, timestamp = now())
            )
            // host callbacks keep io.socket's EventThread guarantee
            EventThread.exec { super.emit(event, *args) }
        }
    }

    // subscribe once on the delegate for [event]; pipe real inbound args into this emitter's
    // listeners and report them (status for connect/disconnect, data event otherwise)
    private fun ensureBridge(event: String) {
        if (!bridged.add(event)) return
        delegate.on(event) { args ->
            when (event) {
                // connect/disconnect drive the connection status; every other event the app subscribes
                // to (reconnect_attempt, connect_error, real data events, …) is an inbound event
                Socket.EVENT_CONNECT -> {
                    // covers auto-reconnect, where the host never calls connect() again
                    registerPushHandler()
                    Sniffer.report(SocketStatusMsg(connectionId, "socketio", url, "connected", now()))
                }
                Socket.EVENT_DISCONNECT -> {
                    // unregister here too, so the handler dies even when the host used delegate.disconnect()
                    Sniffer.unregisterPushHandler(connectionId)
                    Sniffer.report(SocketStatusMsg(connectionId, "socketio", url, "disconnected", now()))
                }
                else -> Sniffer.report(
                    SocketEventMsg(newId(), connectionId, "socketio", "in", event, toJsonArrayString(args), mocked = false, timestamp = now())
                )
            }
            super.emit(event, *args)
        }
    }

    override fun on(event: String, fn: Listener): Emitter {
        ensureBridge(event)
        return super.on(event, fn)
    }

    override fun once(event: String, fn: Listener): Emitter {
        ensureBridge(event)
        return super.once(event, fn)
    }

    override fun off(): Emitter {
        bridged.clear()
        delegate.off()
        return super.off()
    }

    override fun off(event: String): Emitter {
        bridged.remove(event)
        delegate.off(event)
        return super.off(event)
    }

    override fun emit(event: String, vararg args: Any?): Emitter {
        var toSend: Array<out Any?> = args
        try {
            // socket.io convention: a trailing Ack argument is the acknowledgement callback
            val ack = args.lastOrNull() as? Ack
            val data = if (ack != null) args.copyOfRange(0, args.size - 1) else arrayOf(*args)
            val id = newId()
            val rule = MockRegistry.matchSocketAck(event)
            Sniffer.report(
                SocketEventMsg(id, connectionId, "socketio", "out", event, toJsonArrayString(data), mocked = rule != null, timestamp = now())
            )
            if (rule != null) {
                // ack mock hit: do not send to the server, answer with a fake ack locally
                val ackPayload = expandMockPlaceholders(rule.ackPayload)
                if (ack != null) {
                    val fakeArgs = parseArgs(ackPayload)
                    scheduler.schedule({
                        Sniffer.report(SocketAckMsg(id, ackPayload, mocked = true, timestamp = now()))
                        // host callbacks keep io.socket's EventThread guarantee
                        EventThread.exec { ack.call(*fakeArgs) }
                    }, rule.delayMs, TimeUnit.MILLISECONDS)
                } else {
                    Sniffer.report(SocketAckMsg(id, ackPayload, mocked = true, timestamp = now()))
                }
                return this
            }
            if (ack != null) {
                val wrapped = Ack { ackArgs ->
                    runCatching { Sniffer.report(SocketAckMsg(id, toJsonArrayString(ackArgs), mocked = false, timestamp = now())) }
                    ack.call(*ackArgs)
                }
                toSend = arrayOf(*data, wrapped)
            }
        } catch (_: Throwable) {
            // monitoring failed: fall through to the raw emit
            toSend = args
        }
        delegate.emit(event, *toSend)
        return this
    }

    fun connect(): SnifferSocket = apply {
        registerPushHandler()
        delegate.connect()
    }

    fun disconnect(): SnifferSocket = apply {
        delegate.disconnect()
        Sniffer.unregisterPushHandler(connectionId)
    }

    fun connected(): Boolean = delegate.connected()
}

/** Payload string (JSON array = multiple args, anything else = single arg) → socket.io args. */
private fun parseArgs(payload: String): Array<Any?> {
    val parsed = runCatching { JSONTokener(payload).nextValue() }.getOrElse { payload }
    return if (parsed is JSONArray) Array(parsed.length()) { parsed.opt(it) } else arrayOf(parsed)
}

private fun toJsonArrayString(args: Array<out Any?>): String {
    val arr = JSONArray()
    for (a in args) {
        when (a) {
            null -> arr.put(org.json.JSONObject.NULL)
            // JSONArray rejects non-finite numbers; report them as strings instead of throwing
            is Double -> arr.put(if (a.isFinite()) a else a.toString())
            is Float -> arr.put(if (a.isFinite()) a else a.toString())
            is org.json.JSONObject, is JSONArray, is String, is Boolean, is Int, is Long -> arr.put(a)
            else -> arr.put(a.toString())
        }
    }
    return arr.toString()
}
