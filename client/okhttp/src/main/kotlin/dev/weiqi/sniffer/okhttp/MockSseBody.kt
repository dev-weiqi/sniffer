package dev.weiqi.sniffer.okhttp

import dev.weiqi.sniffer.core.MockSseStream
import dev.weiqi.sniffer.core.frame
import okhttp3.Call
import okhttp3.ResponseBody
import okhttp3.MediaType.Companion.toMediaType
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

internal class MockSseBody(stream: MockSseStream, call: Call, readTimeoutMs: Int) : ResponseBody() {
    private val source = object : Source {
        private val pending = Buffer()
        private var index = 0
        private var nextAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(stream.events[0].delayMs)
        @Volatile private var closed = false
        private val timeout = Timeout().apply { if (readTimeoutMs > 0) timeout(readTimeoutMs.toLong(), TimeUnit.MILLISECONDS) }
        override fun timeout() = timeout
        override fun close() { closed = true }
        override fun read(sink: Buffer, byteCount: Long): Long {
            require(byteCount >= 0)
            if (byteCount == 0L) return 0
            val started = System.nanoTime()
            while (true) {
                if (closed || call.isCanceled()) throw IOException("Canceled")
                timeout.throwIfReached()
                if (pending.size > 0) return pending.read(sink, byteCount)
                if (index >= stream.events.size) when (stream.ending) {
                    "close" -> return -1
                    "disconnect" -> throw IOException("Sniffer simulated SSE disconnect")
                }
                if (index < stream.events.size && System.nanoTime() >= nextAt) {
                    pending.writeUtf8(stream.events[index++].frame())
                    if (index < stream.events.size) nextAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(stream.events[index].delayMs)
                    continue
                }
                if (timeout.timeoutNanos() > 0 && System.nanoTime() - started >= timeout.timeoutNanos()) throw SocketTimeoutException("Read timed out")
                try { Thread.sleep(10) } catch (e: InterruptedException) { Thread.currentThread().interrupt(); throw IOException("Interrupted", e) }
            }
        }
    }.buffer()
    override fun contentType() = "text/event-stream; charset=utf-8".toMediaType()
    override fun contentLength() = -1L
    override fun source() = source
}
