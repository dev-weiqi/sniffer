package dev.weiqi.sniffer.core

import java.util.concurrent.Executors
import java.util.concurrent.Callable
import kotlin.test.*

class HttpSequenceConcurrencyTest {
    @Test fun concurrent_requests_reserve_unique_steps() {
        val pool = Executors.newFixedThreadPool(8)
        try {
            MockRegistry.update(MockRules(http = listOf(HttpMockRule(id = "parallel", urlPattern = "/parallel",
                sequence = HttpSequence(List(100) { HttpResponseStep(body = "$it") }, "stop")))))
            val results = pool.invokeAll(List(100) { Callable { MockRegistry.matchHttp("GET", "/parallel")!!.body.toInt() } }).map { it.get() }
            assertEquals((0..99).toList(), results.sorted())
        } finally { pool.shutdownNow(); MockRegistry.update(MockRules()) }
    }
}
