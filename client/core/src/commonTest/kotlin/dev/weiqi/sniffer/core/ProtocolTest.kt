package dev.weiqi.sniffer.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ProtocolTest {
    @Test
    fun deviceMessage_encodes_with_type_discriminator() {
        val msg: DeviceMessage = HttpRequestMsg(
            id = "r1", method = "GET", url = "http://x/y", headers = mapOf("a" to "b"),
            body = null, bodySize = 0, bodyTruncated = false, library = "okhttp", timestamp = 1,
        )
        val obj = Json.parseToJsonElement(SnifferJson.encodeToString<DeviceMessage>(msg)).jsonObject
        assertEquals("http-request", obj["type"]!!.jsonPrimitive.content)
        assertEquals("GET", obj["method"]!!.jsonPrimitive.content)
    }

    @Test
    fun daemonMessage_decodes_mock_rules_and_push_event() {
        val rules = SnifferJson.decodeFromString<DaemonMessage>(
            """{"type":"mock-rules","http":[{"id":"r1","urlPattern":"/api/","status":418,"body":"{}"}],"socket":[]}"""
        ) as MockRules
        assertEquals(418, rules.http.single().status)

        val push = SnifferJson.decodeFromString<DaemonMessage>(
            """{"type":"push-event","connectionId":null,"event":"chat:new","payload":"{}"}"""
        ) as PushEvent
        assertEquals("chat:new", push.event)
    }

    @Test
    fun mockRegistry_matches_method_and_url_substring() {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(id = "r1", method = "GET", urlPattern = "/api/users/", status = 200),
                    HttpMockRule(id = "r2", enabled = false, urlPattern = "/off/", status = 200),
                ),
                socket = listOf(SocketMockRule(id = "s1", event = "chat:send")),
            )
        )
        assertEquals("r1", MockRegistry.matchHttp("get", "http://h/api/users/3")?.id)
        assertNull(MockRegistry.matchHttp("POST", "http://h/api/users/3"))
        assertNull(MockRegistry.matchHttp("GET", "http://h/off/x"))
        assertEquals("s1", MockRegistry.matchSocketAck("chat:send")?.id)
        assertNull(MockRegistry.matchSocketAck("other"))
        MockRegistry.update(MockRules())
    }

    @Test
    fun capBody_truncates_over_limit() {
        val capped = capBody("x".repeat(MAX_BODY_CHARS + 5))
        assertEquals(MAX_BODY_CHARS, capped.body!!.length)
        assertEquals(true, capped.truncated)
        assertEquals((MAX_BODY_CHARS + 5).toLong(), capped.size)
    }
}
