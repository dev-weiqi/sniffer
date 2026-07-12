package dev.weiqi.sniffer.ktorws

import dev.weiqi.sniffer.core.Sniffer
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking

// requires the daemon running on localhost:9091 — verifies the ktor SSE tee reports body updates
fun main() = runBlocking {
    Sniffer.start(appId = "ktor-sse-debug")
    delay(1500) // let the SDK connect so reports flow to the daemon

    val client = HttpClient(CIO) { install(dev.weiqi.sniffer.ktor.SnifferKtor) }
    client.prepareGet("http://localhost:9091/test/sse").execute { resp ->
        println("status: ${resp.status}")
        val ch = resp.bodyAsChannel()
        while (true) {
            val line = ch.readUTF8Line() ?: break
            if (line.startsWith("data:")) println("app saw: $line")
        }
    }
    delay(1500) // let the final tee report flush
    client.close()
    println("OK")
}
