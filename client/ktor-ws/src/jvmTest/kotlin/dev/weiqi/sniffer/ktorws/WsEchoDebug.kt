package dev.weiqi.sniffer.ktorws

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

// requires the daemon running on localhost:9091 (debug harness, not a CI test)
fun main() = runBlocking {
    // install SnifferKtor too: reproduces the "HTTP plugin save() on a 101 upgrade kills the session" scenario
    val client = HttpClient(CIO) {
        install(WebSockets)
        install(dev.weiqi.sniffer.ktor.SnifferKtor)
    }
    val session = client.snifferWebSocketSession("ws://localhost:9091/test/ws")
    println("connected, sending…")
    session.send("hello-debug")
    withTimeout(3000) {
        for (frame in session.incoming) {
            if (frame is Frame.Text) {
                println("ECHO: ${frame.readText()}")
                break
            }
        }
    }
    println("OK")
    client.close()
}
