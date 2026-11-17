package dev.weiqi.sniffer.core

fun MockSseEvent.frame(): String = buildString {
    event?.let { append("event: ").append(it).append('\n') }
    id?.let { append("id: ").append(it).append('\n') }
    retry?.let { append("retry: ").append(it).append('\n') }
    expandMockPlaceholders(data).replace("\r\n", "\n").replace('\r', '\n').split('\n').forEach {
        append("data: ").append(it).append('\n')
    }
    append('\n')
}

fun MockSseStream.valid(): Boolean = events.size in 1..1000 && ending in listOf("close", "open", "disconnect") &&
    events.all { it.delayMs in 0..300_000 && it.data.length <= 512 * 1024 &&
        (it.retry == null || it.retry in 0..300_000) &&
        listOfNotNull(it.event, it.id).all { text -> text.length <= 1024 && text.none { c -> c == '\r' || c == '\n' || c == '\u0000' } } }

fun HttpMockRule.sseHeaders(): Map<String, String> = headers.filterKeys {
    !it.equals("content-type", true) && !it.equals("content-length", true) && !it.equals("transfer-encoding", true)
} + ("content-type" to "text/event-stream; charset=utf-8")
