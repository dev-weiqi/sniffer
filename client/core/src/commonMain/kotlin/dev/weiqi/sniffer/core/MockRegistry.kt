package dev.weiqi.sniffer.core

import kotlin.concurrent.Volatile

/** Currently active mock rules. The daemon replaces the full set on every update. */
object MockRegistry {
    @Volatile
    private var rules: MockRules = MockRules()

    fun update(newRules: MockRules) {
        rules = newRules
    }

    fun matchHttp(method: String, url: String): HttpMockRule? =
        rules.http.firstOrNull {
            it.enabled &&
                (it.method == null || it.method.equals(method, ignoreCase = true)) &&
                url.contains(it.urlPattern)
        }

    fun matchSocketAck(event: String): SocketMockRule? =
        rules.socket.firstOrNull { it.enabled && it.transport == "socketio" && it.event == event }

    /** ktor-ws "reply mock": matches outgoing text frames by substring. */
    fun matchWsSend(text: String): SocketMockRule? =
        rules.socket.firstOrNull { it.enabled && it.transport == "ktor-ws" && text.contains(it.event) }
}
