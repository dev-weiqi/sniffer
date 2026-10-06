package dev.weiqi.sniffer.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SocketPayloadTest {
    @Test
    fun payload_conditions_match_both_transports_before_fallback() {
        for (transport in listOf("socketio", "ktor-ws")) {
            val base = SocketMockRule(id = "fallback", transport = transport, event = "")
            val rules = listOf(
                base,
                base.copy(id = "invalid", payloadMatch = "{"),
                base.copy(id = "array", payloadMatch = "[]"),
                base.copy(id = "one", payloadMatch = """{"page":1}"""),
                base.copy(id = "two", payloadMatch = """{"page":2,"filter":{"active":true}}"""),
                base.copy(id = "duplicate", payloadMatch = """{"page":1}"""),
                base.copy(id = "null", payloadMatch = """{"cursor":null}"""),
                base.copy(id = "list", payloadMatch = """{"ids":[1,{"id":2}]}"""),
                base.copy(id = "off", enabled = false, payloadMatch = """{"page":3}"""),
            )
            fun match(payload: String) = if (transport == "socketio") MockRegistry.matchSocketAck("", "[$payload]")
                else MockRegistry.matchWsSend(payload)
            MockRegistry.update(MockRules(socket = rules))
            try {
                val cases = listOf(
                    """{"page":1,"extra":true}""" to "one",
                    """{"page":1.0}""" to "one",
                    """{"page":2,"filter":{"active":true,"extra":9}}""" to "two",
                    """{"page":2}""" to "fallback",
                    """{"page":"1"}""" to "fallback",
                    """{"page":true}""" to "fallback",
                    """{"page":3}""" to "fallback",
                    """{"cursor":null}""" to "null",
                    """{"ids":[1,{"id":2}]}""" to "list",
                    """{"ids":[1,{"id":2,"extra":true}]}""" to "fallback",
                    "{}" to "fallback", "[]" to "fallback", "null" to "fallback", "{" to "fallback",
                )
                for ((payload, expected) in cases) assertEquals(expected, match(payload)?.id, "$transport: $payload")
                MockRegistry.update(MockRules(socket = rules.drop(1)))
                assertNull(match("""{"page":99}"""))
                if (transport == "socketio") {
                    assertNull(MockRegistry.matchSocketAck("other", """[{"page":1}]"""))
                    assertNull(MockRegistry.matchSocketAck("", """[{}, {"page":1}]"""))
                }
                MockRegistry.update(MockRules(socket = listOf(base.copy(payloadMatch = "{}"))))
                assertEquals("fallback", match("not json")?.id)
            } finally { MockRegistry.update(MockRules()) }
        }
    }
}
