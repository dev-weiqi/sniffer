package dev.weiqi.sniffer.socketio

import io.socket.client.Manager
import io.socket.client.Socket
import io.socket.emitter.Emitter
import org.json.JSONArray

/** Release-build stand-in: an Emitter-compatible wrapper that forwards straight to the delegate. */
object SnifferSocketIO {
    fun wrap(socket: Socket, url: String = ""): SnifferSocket = SnifferSocket(socket)
}

class SnifferSocket internal constructor(val delegate: Socket) : Emitter() {
    override fun on(event: String, fn: Listener): Emitter = delegate.on(event, fn)
    fun on(event: String, label: (args: JSONArray) -> String?, fn: Listener): Emitter = on(event, fn)
    override fun once(event: String, fn: Listener): Emitter = delegate.once(event, fn)
    override fun off(): Emitter = delegate.off()
    override fun off(event: String): Emitter = delegate.off(event)
    // on() registers on the delegate, so removal/introspection must hit the delegate too
    override fun off(event: String, fn: Listener): Emitter = delegate.off(event, fn)
    override fun listeners(event: String): MutableList<Listener> = delegate.listeners(event)
    override fun hasListeners(event: String): Boolean = delegate.hasListeners(event)
    override fun emit(event: String, vararg args: Any?): Emitter = delegate.emit(event, *args)
    fun connect(): SnifferSocket = apply { delegate.connect() }
    fun disconnect(): SnifferSocket = apply { delegate.disconnect() }
    fun connected(): Boolean = delegate.connected()
    fun open(): SnifferSocket = apply { delegate.open() }
    fun close(): SnifferSocket = apply { delegate.close() }
    fun io(): Manager = delegate.io()
    fun id(): String? = delegate.id()
}
