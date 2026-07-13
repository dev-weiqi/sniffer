package dev.weiqi.sniffer.ktorws

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

// requires the daemon running on localhost:9091 (debug harness, not a CI test)
fun main() = runBlocking {
    dev.weiqi.sniffer.core.Sniffer.start(appId = "ktor-ws-debug")
    kotlinx.coroutines.delay(1500)
    // install SnifferKtor too: reproduces the "HTTP plugin save() on a 101 upgrade kills the session" scenario
    val client = HttpClient(CIO) {
        install(SnifferKtorWs)
        install(WebSockets)
        install(dev.weiqi.sniffer.ktor.SnifferKtor)
    }
    val session = client.webSocketSession("ws://localhost:9091/test/ws")
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
    kotlinx.coroutines.delay(1500) // let reports flush to the daemon
    println("OK")
    client.close()
}
