package dev.weiqi.sniffer.ktorws

import dev.weiqi.sniffer.core.DeviceMessage
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.MockRules
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.SocketEventMsg
import dev.weiqi.sniffer.core.SocketMockRule
import dev.weiqi.sniffer.core.SocketStatusMsg
import io.ktor.websocket.CloseReason
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketExtension
import io.ktor.websocket.readText
import io.ktor.utils.io.InternalAPI
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.CoroutineContext
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class SnifferKtorWsTest {
    @AfterTest
    fun cleanup() {
        MockRegistry.update(MockRules())
        setReportSink(null)
        Sniffer.stop()
    }

    @Test
    fun reports_status_and_forwards_inbound_text_frames() = runBlocking {
        val reports = captureReports()
        val delegate = FakeDefaultWebSocketSession()
        val wrapped = SnifferFrameInterceptor(delegate, "ws://example.test/socket")

        delegate.incomingChannel.send(Frame.Text("from server"))
        val frame = withTimeout(1000) { wrapped.incoming.receive() }
        delegate.incomingChannel.close()

        assertEquals("from server", (frame as Frame.Text).readText())
        assertTrue(reports.any { it is SocketStatusMsg && it.status == "connected" })
        assertTrue(reports.any { it is SocketEventMsg && it.direction == "in" && it.payload == "from server" })
        withTimeout(1000) {
            while (reports.none { it is SocketStatusMsg && it.status == "disconnected" }) {
                kotlinx.coroutines.delay(10)
            }
        }
        delegate.terminate()
    }

    @Test
    fun outbound_text_without_mock_is_forwarded_to_delegate() = runBlocking {
        val reports = captureReports()
        val delegate = FakeDefaultWebSocketSession()
        val wrapped = SnifferFrameInterceptor(delegate, "ws://example.test/socket")

        assertEquals(wrapped.outgoing, wrapped.outgoing)
        wrapped.send(Frame.Text("to server"))
        val forwarded = withTimeout(1000) { delegate.outgoingChannel.receive() }

        assertEquals("to server", (forwarded as Frame.Text).readText())
        assertTrue(reports.any { it is SocketEventMsg && it.direction == "out" && it.payload == "to server" && !it.mocked })
        delegate.terminate()
    }

    @Test
    fun closed_delegate_outgoing_closes_intercepted_outgoing() = runBlocking {
        val delegate = FakeDefaultWebSocketSession()
        val wrapped = SnifferFrameInterceptor(delegate, "ws://example.test/socket")
        delegate.outgoingChannel.close()

        wrapped.send(Frame.Text("after close"))
        delay(50)

        assertTrue(wrapped.outgoing.isClosedForSend)
        delegate.terminate()
    }

    @Test
    fun outbound_text_with_reply_mock_is_consumed_and_injects_reply() = runBlocking {
        val reports = captureReports()
        MockRegistry.update(
            MockRules(
                socket = listOf(
                    SocketMockRule(
                        id = "ws",
                        transport = "ktor-ws",
                        event = "needle",
                        ackPayload = "mock reply",
                    )
                )
            )
        )
        val delegate = FakeDefaultWebSocketSession()
        val wrapped = SnifferFrameInterceptor(delegate, "ws://example.test/socket")

        wrapped.send(Frame.Text("has needle"))
        val reply = withTimeout(1000) { wrapped.incoming.receive() }

        assertEquals("mock reply", (reply as Frame.Text).readText())
        assertTrue(delegate.outgoingChannel.tryReceive().isFailure)
        assertTrue(reports.any { it is SocketEventMsg && it.direction == "out" && it.mocked })
        assertTrue(reports.any { it is SocketEventMsg && it.direction == "in" && it.mocked && it.payload == "mock reply" })
        delegate.terminate()
    }

    @Test
    fun non_text_outbound_frames_are_forwarded_without_mocking() = runBlocking {
        val delegate = FakeDefaultWebSocketSession()
        val wrapped = SnifferFrameInterceptor(delegate, "ws://example.test/socket")

        wrapped.send(Frame.Binary(fin = true, data = byteArrayOf(1, 2)))
        val forwarded = withTimeout(1000) { delegate.outgoingChannel.receive() }

        assertIs<Frame.Binary>(forwarded)
        delegate.terminate()
    }

    @Test
    fun registered_push_handler_injects_mocked_inbound_frame() = runBlocking {
        val reports = captureReports()
        val delegate = FakeDefaultWebSocketSession()
        val wrapped = SnifferFrameInterceptor(delegate, "ws://example.test/socket")
        val handler = pushHandlers().values.single()

        handler("push", "payload")
        val frame = withTimeout(1000) { wrapped.incoming.receive() }

        assertEquals("payload", (frame as Frame.Text).readText())
        assertTrue(reports.any { it is SocketEventMsg && it.event == "push" && it.mocked })
        delegate.terminate()
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

    @OptIn(InternalAPI::class)
    private class FakeDefaultWebSocketSession : DefaultWebSocketSession {
        val incomingChannel = Channel<Frame>(Channel.UNLIMITED)
        val outgoingChannel = Channel<Frame>(Channel.UNLIMITED)
        private val job = SupervisorJob()

        override val coroutineContext: CoroutineContext = job + Dispatchers.Default
        override var masking: Boolean = false
        override var maxFrameSize: Long = Long.MAX_VALUE
        override val incoming = incomingChannel
        override val outgoing = outgoingChannel
        override val extensions: List<WebSocketExtension<*>> = emptyList()
        override var pingIntervalMillis: Long = 0
        override var timeoutMillis: Long = 0
        override val closeReason = CompletableDeferred<CloseReason>()

        override suspend fun send(frame: Frame) {
            outgoing.send(frame)
        }

        override suspend fun flush() = Unit

        override fun terminate() {
            incomingChannel.close()
            outgoingChannel.close()
            closeReason.complete(CloseReason(CloseReason.Codes.NORMAL, "done"))
            job.cancel()
        }

        override fun start(extensions: List<WebSocketExtension<*>>) = Unit
    }
}
