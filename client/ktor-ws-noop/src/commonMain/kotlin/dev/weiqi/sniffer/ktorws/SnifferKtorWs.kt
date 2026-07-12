package dev.weiqi.sniffer.ktorws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.HttpRequestBuilder

/** Release-build stand-in: returns the raw session, no monitoring. */
suspend fun HttpClient.snifferWebSocketSession(
    urlString: String,
    block: HttpRequestBuilder.() -> Unit = {},
): DefaultClientWebSocketSession = webSocketSession(urlString, block)
