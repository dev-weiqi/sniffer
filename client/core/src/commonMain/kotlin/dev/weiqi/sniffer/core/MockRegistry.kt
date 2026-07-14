package dev.weiqi.sniffer.core

import kotlin.concurrent.Volatile

/** Currently active mock rules. The daemon replaces the full set on every update. */
object MockRegistry {
    @Volatile
    private var rules: MockRules = MockRules()

    fun update(newRules: MockRules) {
        rules = newRules
    }

    // Exact-path match: [urlPattern] must equal the request's path (scheme, host, query and
    // fragment stripped). "/api/" no longer catches "/api/systems/v1/app-version". An empty
    // pattern matches nothing (a bare path always starts with "/").
    fun matchHttp(method: String, url: String): HttpMockRule? {
        val path = pathOf(url)
        return rules.http.firstOrNull {
            it.enabled &&
                (it.method == null || it.method.equals(method, ignoreCase = true)) &&
                path == it.urlPattern
        }
    }

    private fun pathOf(url: String): String {
        val path = if (url.contains("://")) "/" + url.substringAfter("://").substringAfter('/', "") else url
        return path.substringBefore('?').substringBefore('#')
    }

    fun matchSocketAck(event: String): SocketMockRule? =
        rules.socket.firstOrNull { it.enabled && it.transport == "socketio" && it.event == event }

    /** ktor-ws "reply mock": matches outgoing text frames by substring. */
    fun matchWsSend(text: String): SocketMockRule? =
        rules.socket.firstOrNull { it.enabled && it.transport == "ktor-ws" && text.contains(it.event) }
}
