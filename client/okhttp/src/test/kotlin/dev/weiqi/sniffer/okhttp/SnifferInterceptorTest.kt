package dev.weiqi.sniffer.okhttp

import dev.weiqi.sniffer.core.HttpMockRule
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.MockRules
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class SnifferInterceptorTest {
    @AfterTest
    fun cleanup() = MockRegistry.update(MockRules())

    @Test
    fun mock_rule_short_circuits_without_network() {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(
                        id = "r1", urlPattern = "/api/characters/", status = 418,
                        headers = mapOf("x-mock" to "1"), body = """{"mocked":true}""",
                    )
                )
            )
        )
        val client = OkHttpClient.Builder().addInterceptor(SnifferOkHttp.interceptor()).build()
        // nonexistent host: if the mock did not short-circuit, this would throw UnknownHostException
        val response = client.newCall(
            Request.Builder().url("http://sniffer-test.invalid/api/characters/18").build()
        ).execute()
        assertEquals(418, response.code)
        assertEquals("1", response.header("x-mock"))
        assertEquals("""{"mocked":true}""", response.body.string())
    }
}
