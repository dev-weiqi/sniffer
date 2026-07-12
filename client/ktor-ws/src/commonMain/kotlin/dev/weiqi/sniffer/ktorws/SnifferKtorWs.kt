package dev.weiqi.sniffer.ktorws

import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.SocketEventMsg
import dev.weiqi.sniffer.core.SocketStatusMsg
import dev.weiqi.sniffer.core.capBody
import dev.weiqi.sniffer.core.expandMockPlaceholders
import dev.weiqi.sniffer.core.newId
import dev.weiqi.sniffer.core.now
import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedSendChannelException
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * Opens a monitored WebSocket. Drop-in replacement for client.webSocketSession(...):
 * every in/out frame is reported to the daemon, and server→client messages can be injected from the UI.
 */
suspend fun HttpClient.snifferWebSocketSession(
    urlString: String,
    block: HttpRequestBuilder.() -> Unit = {},
): DefaultClientWebSocketSession {
    Sniffer.registerCapability("ktor-ws")
    val delegate = webSocketSession(urlString, block)
    return DefaultClientWebSocketSession(delegate.call, SnifferFrameInterceptor(delegate, urlString))
}

private class SnifferFrameInterceptor(
    private val delegate: DefaultClientWebSocketSession,
    url: String,
) : DefaultWebSocketSession by delegate {

    private val connectionId = newId()

    // bounded: real frames are forwarded with suspending send (backpressure), injected mocks use trySend
    private val interceptedIncoming = Channel<Frame>(1000)
    private val interceptedOutgoing = Channel<Frame>(Channel.BUFFERED)

    override val incoming: ReceiveChannel<Frame> get() = interceptedIncoming
    override val outgoing: SendChannel<Frame> get() = interceptedOutgoing

    // send() is an interface member with a default body; `by delegate` forwards it straight to the original session, bypassing the outgoing override
    override suspend fun send(frame: Frame) {
        interceptedOutgoing.send(frame)
    }

    init {
        Sniffer.report(SocketStatusMsg(connectionId, "ktor-ws", url, "connected", now()))
        Sniffer.registerPushHandler(connectionId) { event, payload ->
            // ktor-ws has no event concept; the injected payload becomes a plain text frame
            interceptedIncoming.trySend(Frame.Text(payload))
            Sniffer.report(
                SocketEventMsg(newId(), connectionId, "ktor-ws", "in", event, payload, mocked = true, timestamp = now())
            )
        }
        delegate.launch {
            try {
                for (frame in delegate.incoming) {
                    // forward first: monitoring must never gate real traffic
                    interceptedIncoming.send(frame)
                    // readText() throws on fragmented frames, so only report final text frames
                    if (frame is Frame.Text && frame.fin) {
                        runCatching {
                            Sniffer.report(
                                SocketEventMsg(
                                    newId(), connectionId, "ktor-ws", "in", "message",
                                    capBody(frame.readText()).body.orEmpty(), mocked = false, timestamp = now(),
                                )
                            )
                        }
                    }
                }
            } finally {
                interceptedIncoming.close()
                Sniffer.unregisterPushHandler(connectionId)
                Sniffer.report(SocketStatusMsg(connectionId, "ktor-ws", url, "disconnected", now()))
            }
        }
        delegate.launch {
            for (frame in interceptedOutgoing) {
                var consumed = false
                try {
                    if (frame is Frame.Text && frame.fin) {
                        val text = frame.readText()
                        val rule = MockRegistry.matchWsSend(text)
                        Sniffer.report(
                            SocketEventMsg(
                                newId(), connectionId, "ktor-ws", "out", "message",
                                capBody(text).body.orEmpty(), mocked = rule != null, timestamp = now(),
                            )
                        )
                        if (rule != null) {
                            // reply mock: swallow the send, inject a fake server reply instead.
                            // Launched so the mock delay doesn't stall unrelated frames in this serial pump.
                            launch {
                                try {
                                    if (rule.delayMs > 0) delay(rule.delayMs)
                                    val reply = expandMockPlaceholders(rule.ackPayload)
                                    interceptedIncoming.trySend(Frame.Text(reply))
                                    Sniffer.report(
                                        SocketEventMsg(
                                            newId(), connectionId, "ktor-ws", "in", "message",
                                            capBody(reply).body.orEmpty(), mocked = true, timestamp = now(),
                                        )
                                    )
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (_: Throwable) {
                                    // injected reply is best-effort
                                }
                            }
                            consumed = true
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    // monitoring failed: fall through and send the raw frame
                }
                if (consumed) continue
                try {
                    delegate.outgoing.send(frame)
                } catch (e: ClosedSendChannelException) {
                    // real session closed: fail host send() like a raw session instead of buffering forever
                    interceptedOutgoing.close(e)
                    return@launch
                }
            }
        }
    }
}
