package dev.weiqi.sniffer.core

import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertEquals

class HttpBodyMockTest {
    @Test
    fun body_condition_must_not_become_a_path_only_rule() {
        MockRegistry.update(SnifferJson.decodeFromString<MockRules>(
            """{"http":[{"id":"conditional","urlPattern":"/messages","bodyMatch":"{\"limit\":20}"}]}"""
        ))
        try {
            assertNull(MockRegistry.matchHttp("POST", "/messages"))
        } finally {
            MockRegistry.update(MockRules())
        }
    }
    @Test
    fun query_and_json_body_conditions_match_together_before_fallback() {
        val fallback = HttpMockRule(id = "fallback", method = "POST", urlPattern = "/messages")
        val rules = listOf(
            fallback,
            fallback.copy(id = "broken", bodyMatch = "{"),
            fallback.copy(id = "array", bodyMatch = "[]"),
            fallback.copy(id = "one", queryParams = mapOf("locale" to "zh-TW"), bodyMatch = """{"session_id":"session","limit":20}"""),
            fallback.copy(id = "nested", bodyMatch = """{"filter":{"active":true},"ids":[1,{"id":2}]}"""),
            fallback.copy(id = "null", bodyMatch = """{"cursor":null}"""),
            fallback.copy(id = "off", enabled = false, bodyMatch = """{"limit":40}"""),
        )
        MockRegistry.update(MockRules(http = rules))
        try {
            val cases = listOf(
                """{"limit":20,"session_id":"session","extra":true}""" to "one",
                """{"session_id":"session","limit":20.0}""" to "one",
                """{"session_id":"other","limit":20}""" to "fallback",
                """{"session_id":"session","limit":"20"}""" to "fallback",
                """{"session_id":"session","limit":true}""" to "fallback",
                """{"filter":{"active":true,"extra":1},"ids":[1,{"id":2}]}""" to "nested",
                """{"filter":{"active":true},"ids":[1,{"id":2,"extra":1}]}""" to "fallback",
                """{"cursor":null}""" to "null",
                """{"limit":40}""" to "fallback",
                "{}" to "fallback", "[]" to "fallback", "null" to "fallback", "{" to "fallback", null to "fallback",
            )
            for ((body, id) in cases) assertEquals(id, MockRegistry.matchHttp("post", "/messages?locale=zh-TW", body)?.id)
            assertEquals("fallback", MockRegistry.matchHttp("POST", "/messages?locale=en-US", cases[0].first)?.id)
            assertNull(MockRegistry.matchHttp("GET", "/messages?locale=zh-TW", cases[0].first))
            assertNull(MockRegistry.matchHttp("POST", "/messages/child?locale=zh-TW", cases[0].first))
            MockRegistry.update(MockRules(http = rules.drop(1)))
            assertNull(MockRegistry.matchHttp("POST", "/messages", "{}"))
            assertNull(MockRegistry.matchHttp("POST", "/messages", " ".repeat(MAX_BODY_CHARS) + """{"cursor":null}"""))
            MockRegistry.update(MockRules(http = listOf(fallback.copy(bodyMatch = " {} "))))
            assertEquals("fallback", MockRegistry.matchHttp("POST", "/messages", null)?.id)
            val encoded = SnifferJson.encodeToString(MockRules(http = rules))
            assertEquals(rules, SnifferJson.decodeFromString<MockRules>(encoded).http)
        } finally { MockRegistry.update(MockRules()) }
    }

}
