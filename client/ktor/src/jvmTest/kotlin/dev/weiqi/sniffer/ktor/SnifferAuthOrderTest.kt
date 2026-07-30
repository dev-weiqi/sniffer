package dev.weiqi.sniffer.ktor

import dev.weiqi.sniffer.core.HttpMockRule
import dev.weiqi.sniffer.core.MockRegistry
import dev.weiqi.sniffer.core.MockRules
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.auth.Auth
import io.ktor.client.plugins.auth.providers.BearerTokens
import io.ktor.client.plugins.auth.providers.bearer
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** ktor's HttpSend runs FIRST-installed interceptors outermost: for a mocked 401 to reach
    the Auth plugin's refresh logic, SnifferKtor must be installed AFTER Auth. */
class SnifferAuthOrderTest {
    @AfterTest
    fun cleanup() {
        MockRegistry.update(MockRules())
    }

    private fun mock401() = MockRegistry.update(
        MockRules(http = listOf(HttpMockRule(id = "r1", urlPattern = "/me", status = 401, body = """{"code":401}"""))),
    )

    private fun client(refreshed: MutableList<Unit>, snifferAfterAuth: Boolean) =
        HttpClient(MockEngine { respond("real", HttpStatusCode.OK) }) {
            if (!snifferAfterAuth) install(SnifferKtor)
            install(Auth) {
                bearer {
                    loadTokens { BearerTokens("access", "refresh") }
                    refreshTokens { refreshed.add(Unit); null }
                }
            }
            if (snifferAfterAuth) install(SnifferKtor)
        }

    @Test
    fun mocked401TriggersRefreshWhenSnifferInstalledAfterAuth() = runBlocking {
        mock401()
        val refreshed = mutableListOf<Unit>()
        val response = client(refreshed, snifferAfterAuth = true).get("http://api.local/me")
        assertEquals(401, response.status.value)
        assertEquals(1, refreshed.size)
    }

    @Test
    fun mocked401BypassesAuthWhenSnifferInstalledFirst() = runBlocking {
        mock401()
        val refreshed = mutableListOf<Unit>()
        val response = client(refreshed, snifferAfterAuth = false).get("http://api.local/me")
        assertEquals(401, response.status.value)
        assertEquals(0, refreshed.size)
    }
}
