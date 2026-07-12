package dev.weiqi.sniffer.ktorws

import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.Sniffer
import dev.weiqi.sniffer.core.SocketEventMsg
import dev.weiqi.sniffer.core.SocketStatusMsg
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
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.launch

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
    private val interceptedIncoming = Channel<Frame>(Channel.UNLIMITED)
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
                    if (frame is Frame.Text) {
                        Sniffer.report(
                            SocketEventMsg(
                                newId(), connectionId, "ktor-ws", "in", "message",
                                frame.readText(), mocked = false, timestamp = now(),
                            )
                        )
                    }
                    interceptedIncoming.send(frame)
                }
            } finally {
                interceptedIncoming.close()
                Sniffer.unregisterPushHandler(connectionId)
                Sniffer.report(SocketStatusMsg(connectionId, "ktor-ws", url, "disconnected", now()))
            }
        }
        delegate.launch {
            for (frame in interceptedOutgoing) {
                if (frame is Frame.Text) {
                    val text = frame.readText()
                    val rule = MockRegistry.matchWsSend(text)
                    Sniffer.report(
                        SocketEventMsg(
                            newId(), connectionId, "ktor-ws", "out", "message",
                            text, mocked = rule != null, timestamp = now(),
                        )
                    )
                    if (rule != null) {
                        // reply mock: swallow the send, inject a fake server reply instead
                        if (rule.delayMs > 0) kotlinx.coroutines.delay(rule.delayMs)
                        val reply = expandMockPlaceholders(rule.ackPayload)
                        interceptedIncoming.trySend(Frame.Text(reply))
                        Sniffer.report(
                            SocketEventMsg(
                                newId(), connectionId, "ktor-ws", "in", "message",
                                reply, mocked = true, timestamp = now(),
                            )
                        )
                        continue
                    }
                }
                delegate.outgoing.send(frame)
            }
        }
    }
}
