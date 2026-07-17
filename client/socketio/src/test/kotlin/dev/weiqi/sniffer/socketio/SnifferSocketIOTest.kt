package dev.weiqi.sniffer.socketio

import dev.weiqi.sniffer.core.DeviceMessage
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.MockRules
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.SocketAckMsg
import dev.weiqi.sniffer.core.SocketEventMsg
import dev.weiqi.sniffer.core.SocketMockRule
import dev.weiqi.sniffer.core.SocketStatusMsg
import io.socket.client.Ack
import io.socket.client.Manager
import io.socket.client.Socket
import io.socket.emitter.Emitter
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class SnifferSocketIOTest {
    @AfterTest
    fun cleanup() {
        MockRegistry.update(MockRules())
        setReportSink(null)
        Sniffer.stop()
    }

    @Test
    fun inbound_events_are_bridged_and_status_is_reported() {
        val reports = captureReports()
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket, "ws://example.test")
        val received = mutableListOf<Array<out Any?>>()

        wrapped.on("chat:new") { args -> received += args }
        socket.fire(Socket.EVENT_CONNECT)
        socket.fire("chat:new", "hello", 3)
        socket.fire(Socket.EVENT_DISCONNECT)

        assertEquals(listOf(listOf("hello", 3)), received.map { it.toList() })
        assertTrue(reports.any { it is SocketStatusMsg && it.status == "connected" })
        assertTrue(reports.any { it is SocketStatusMsg && it.status == "disconnected" })
        assertTrue(reports.any { it is SocketEventMsg && it.direction == "in" && it.event == "chat:new" })
    }

    @Test
    fun once_listener_runs_once_and_bridge_is_idempotent() {
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)
        var count = 0

        wrapped.once("once") { count++ }
        wrapped.on("once") {}
        socket.fire("once")
        socket.fire("once")

        assertEquals(1, count)
        assertEquals(1, socket.listeners("once").size)
    }

    @Test
    fun emit_without_ack_reports_and_forwards_to_delegate() {
        val reports = captureReports()
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)

        wrapped.emit("chat:send", "hello", 1)

        assertEquals("chat:send", socket.emitted.single().event)
        assertEquals(listOf("hello", 1), socket.emitted.single().args.toList())
        assertTrue(reports.any { it is SocketEventMsg && it.direction == "out" && it.event == "chat:send" && !it.mocked })
    }

    @Test
    fun emit_with_real_ack_reports_ack_and_calls_host_ack() = runBlocking {
        val reports = captureReports()
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)
        val ackArgs = CompletableDeferred<List<Any?>>()

        wrapped.emit("chat:send", "hello", Ack { args -> ackArgs.complete(args.toList()) })
        val sentAck = socket.emitted.single().args.last()
        assertIs<Ack>(sentAck)
        sentAck.call("server-ok", 2)

        assertEquals(listOf("server-ok", 2), withTimeout(1000) { ackArgs.await() })
        assertTrue(reports.any { it is SocketAckMsg && !it.mocked && it.payload == """["server-ok",2]""" })
    }

    @Test
    fun emit_with_mock_ack_short_circuits_delegate_and_calls_fake_ack() = runBlocking {
        val reports = captureReports()
        MockRegistry.update(
            MockRules(
                socket = listOf(
                    SocketMockRule(id = "s1", event = "chat:send", ackPayload = """["mock-ok",7]""")
                )
            )
        )
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)
        val ackArgs = CompletableDeferred<List<Any?>>()

        wrapped.emit("chat:send", "hello", Ack { args -> ackArgs.complete(args.toList()) })

        assertTrue(socket.emitted.isEmpty())
        assertEquals(listOf("mock-ok", 7), withTimeout(1000) { ackArgs.await() })
        assertTrue(reports.any { it is SocketEventMsg && it.mocked && it.direction == "out" })
        assertTrue(reports.any { it is SocketAckMsg && it.mocked && it.payload == """["mock-ok",7]""" })
    }

    @Test
    fun emit_with_mock_without_ack_reports_mock_ack_without_delegate() {
        val reports = captureReports()
        MockRegistry.update(
            MockRules(socket = listOf(SocketMockRule(id = "s1", event = "chat:send", ackPayload = """["mock"]""")))
        )
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)

        wrapped.emit("chat:send", "hello")

        assertTrue(socket.emitted.isEmpty())
        assertTrue(reports.any { it is SocketAckMsg && it.mocked && it.payload == """["mock"]""" })
    }

    @Test
    fun monitoring_failure_falls_back_to_raw_emit() {
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)
        val bad = object {
            override fun toString(): String = error("boom")
        }

        wrapped.emit("bad", bad)

        assertEquals("bad", socket.emitted.single().event)
        assertEquals(bad, socket.emitted.single().args.single())
    }

    @Test
    fun push_handler_injects_mocked_inbound_event() = runBlocking {
        val reports = captureReports()
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)
        val received = CompletableDeferred<List<Any?>>()
        wrapped.on("push") { args -> received.complete(args.toList()) }
        wrapped.connect()

        pushHandlers().values.single().invoke("push", """["server",5]""")

        assertEquals(listOf("server", 5), withTimeout(1000) { received.await() })
        assertTrue(reports.any { it is SocketEventMsg && it.event == "push" && it.mocked })
    }

    @Test
    fun mirrors_socket_methods_and_listener_removal() {
        val socket = FakeSocket()
        val wrapped = SnifferSocketIO.wrap(socket)
        val manager = socket.io()

        var called = 0
        val listener = Emitter.Listener { called++ }
        wrapped.on("x", listener)
        assertTrue(wrapped.hasListeners("x"))
        wrapped.off("x", listener)
        assertFalse(wrapped.hasListeners("x"))
        wrapped.on("x", listener)
        wrapped.off("x")
        assertFalse(wrapped.hasListeners("x"))
        wrapped.on("x", listener)
        wrapped.off()
        assertFalse(wrapped.hasListeners("x"))

        assertEquals(wrapped, wrapped.open())
        assertEquals(true, wrapped.connected())
        assertEquals(wrapped, wrapped.close())
        assertEquals(false, wrapped.connected())
        assertEquals(manager, wrapped.io())
        assertEquals("fake-id", wrapped.id())
    }

    @Test
    fun payload_codec_handles_arrays_scalars_null_non_finite_and_objects() {
        assertEquals(listOf("a", 1), parseArgs("""["a",1]""").toList())
        assertEquals(listOf("plain"), parseArgs("plain").toList())
        assertEquals(listOf(JSONObject.NULL), parseArgs("null").toList())

        val json = toJsonArrayString(
            arrayOf(
                null,
                Double.POSITIVE_INFINITY,
                Float.NaN,
                JSONObject("""{"a":1}"""),
                JSONArray("""[2]"""),
                true,
                3,
                4L,
                object {
                    override fun toString() = "custom"
                },
            )
        )

        assertEquals("""[null,"Infinity","NaN",{"a":1},[2],true,3,4,"custom"]""", json)
    }

    private fun captureReports(): MutableList<DeviceMessage> {
        val reports = mutableListOf<DeviceMessage>()
        setReportSink { reports += it }
        return reports
    }

    private fun setReportSink(sink: ((DeviceMessage) -> Unit)?) {
        val setter = Sniffer::class.java.methods.single { it.name.startsWith("setReportSinkForTests") }
        setter.invoke(Sniffer, sink)
    }

    @Suppress("UNCHECKED_CAST")
    private fun pushHandlers(): Map<String, (String, String) -> Unit> {
        val method = Sniffer::class.java.methods.single { it.name.startsWith("access\$getPushHandlers") }
        return method.invoke(null) as Map<String, (String, String) -> Unit>
    }

    private data class Emitted(val event: String, val args: Array<out Any?>)

    private class FakeSocket : Socket(Manager(), "/", Manager.Options()) {
        val emitted = mutableListOf<Emitted>()
        private val delegateListeners = linkedMapOf<String, MutableList<Emitter.Listener>>()
        private var isConnected = false

        fun fire(event: String, vararg args: Any?) {
            delegateListeners[event].orEmpty().toList().forEach { it.call(*args) }
        }

        override fun on(event: String, fn: Emitter.Listener): Emitter {
            delegateListeners.getOrPut(event) { mutableListOf() } += fn
            return this
        }

        override fun once(event: String, fn: Emitter.Listener): Emitter {
            lateinit var wrapper: Emitter.Listener
            wrapper = Emitter.Listener { args ->
                off(event, wrapper)
                fn.call(*args)
            }
            return on(event, wrapper)
        }

        override fun off(): Emitter {
            delegateListeners.clear()
            return this
        }

        override fun off(event: String): Emitter {
            delegateListeners.remove(event)
            return this
        }

        override fun off(event: String, fn: Emitter.Listener): Emitter {
            delegateListeners[event]?.remove(fn)
            return this
        }

        override fun listeners(event: String): MutableList<Emitter.Listener> =
            delegateListeners[event]?.toMutableList() ?: mutableListOf()

        override fun hasListeners(event: String): Boolean =
            delegateListeners[event]?.isNotEmpty() == true

        override fun emit(event: String, vararg args: Any?): Emitter {
            emitted += Emitted(event, args)
            return this
        }

        override fun connect(): Socket {
            isConnected = true
            return this
        }

        override fun disconnect(): Socket {
            isConnected = false
            return this
        }

        override fun open(): Socket = connect()
        override fun close(): Socket = disconnect()
        override fun connected(): Boolean = isConnected
        override fun id(): String = "fake-id"
    }
}
