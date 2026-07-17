package dev.weiqi.sniffer.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertNull
import kotlin.test.assertTrue

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
    fun every_device_message_encodes_expected_type() {
        val messages = listOf(
            Hello(
                deviceId = "d1",
                deviceName = "Pixel",
                platform = "android",
                appId = "app",
                sdkVersion = "1",
                capabilities = listOf("http"),
            ) to "hello",
            HttpRequestMsg(
                id = "r1", method = "POST", url = "http://x/y", headers = mapOf("a" to "b"),
                body = "{}", bodySize = 2, bodyTruncated = false, library = "okhttp", timestamp = 1,
            ) to "http-request",
            HttpResponseMsg(
                id = "r1", status = 201, headers = mapOf("content-type" to "application/json"),
                body = "{}", bodySize = 2, bodyTruncated = false, durationMs = 3,
                mocked = false, error = null, timestamp = 4, bodyBase64 = true, delayedMs = 5,
            ) to "http-response",
            SocketStatusMsg(
                connectionId = "c1", transport = "socketio", url = "ws://x", status = "connected", timestamp = 1,
            ) to "socket-status",
            SocketEventMsg(
                id = "e1", connectionId = "c1", transport = "socketio", direction = "out",
                event = "chat", payload = "[]", mocked = false, timestamp = 1,
            ) to "socket-event",
            SocketAckMsg(id = "a1", payload = null, mocked = true, timestamp = 1) to "socket-ack",
        )

        for ((message, expectedType) in messages) {
            val obj = Json.parseToJsonElement(SnifferJson.encodeToString<DeviceMessage>(message)).jsonObject
            assertEquals(expectedType, obj["type"]!!.jsonPrimitive.content)
        }
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
    fun daemon_message_defaults_are_applied() {
        val rules = SnifferJson.decodeFromString<DaemonMessage>(
            """{"type":"mock-rules"}"""
        ) as MockRules

        assertTrue(rules.http.isEmpty())
        assertTrue(rules.socket.isEmpty())

        val httpRule = SnifferJson.decodeFromString<HttpMockRule>(
            """{"id":"h1","urlPattern":"/users"}"""
        )
        assertEquals(true, httpRule.enabled)
        assertNull(httpRule.method)
        assertEquals(200, httpRule.status)
        assertTrue(httpRule.headers.isEmpty())
        assertEquals("", httpRule.body)
        assertEquals(0, httpRule.delayMs)
        assertEquals(false, httpRule.delayOnly)

        val socketRule = SnifferJson.decodeFromString<SocketMockRule>(
            """{"id":"s1","event":"chat"}"""
        )
        assertEquals(true, socketRule.enabled)
        assertEquals("socketio", socketRule.transport)
        assertEquals("[]", socketRule.ackPayload)
        assertEquals(0, socketRule.delayMs)
    }

    @Test
    fun unknown_daemon_message_fails_to_decode() {
        assertFails {
            SnifferJson.decodeFromString<DaemonMessage>("""{"type":"wat"}""")
        }
    }

    @Test
    fun http_response_defaults_are_encoded() {
        val encoded = SnifferJson.encodeToString<DeviceMessage>(
            HttpResponseMsg(
                id = "r1", status = 200, headers = emptyMap(), body = null,
                bodySize = 0, bodyTruncated = false, durationMs = 1,
                mocked = false, error = null, timestamp = 2,
            )
        )
        val obj = Json.parseToJsonElement(encoded).jsonObject

        assertEquals("false", obj["bodyBase64"]!!.jsonPrimitive.content)
        assertEquals("0", obj["delayedMs"]!!.jsonPrimitive.content)
    }

    @Test
    fun mockRegistry_matches_method_and_exact_path() {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(id = "r1", method = "GET", urlPattern = "/api/users/3", status = 200),
                    HttpMockRule(id = "r2", enabled = false, urlPattern = "/off/x", status = 200),
                    HttpMockRule(id = "r3", urlPattern = "/api/", status = 200),
                ),
                socket = listOf(SocketMockRule(id = "s1", event = "chat:send")),
            )
        )
        // exact path, case-insensitive method, host + query stripped
        assertEquals("r1", MockRegistry.matchHttp("get", "https://h/api/users/3?x=1")?.id)
        assertNull(MockRegistry.matchHttp("POST", "http://h/api/users/3"))
        assertNull(MockRegistry.matchHttp("GET", "http://h/off/x")) // disabled
        // "/api/" must NOT catch a deeper path (the reported bug)
        assertNull(MockRegistry.matchHttp("GET", "http://MOCKapi.test/api/systems/v1/app-version"))
        assertEquals("r3", MockRegistry.matchHttp("GET", "http://h/api/")?.id)
        assertEquals("s1", MockRegistry.matchSocketAck("chat:send")?.id)
        assertNull(MockRegistry.matchSocketAck("other"))
        MockRegistry.update(MockRules())
    }

    @Test
    fun mockRegistry_handles_relative_urls_fragments_and_ws_reply_rules() {
        MockRegistry.update(
            MockRules(
                http = listOf(
                    HttpMockRule(id = "any-method", method = null, urlPattern = "/local/path"),
                    HttpMockRule(id = "empty", method = null, urlPattern = ""),
                ),
                socket = listOf(
                    SocketMockRule(id = "off", enabled = false, event = "chat:send"),
                    SocketMockRule(id = "ack", transport = "socketio", event = "chat:send"),
                    SocketMockRule(id = "ws", transport = "ktor-ws", event = "needle"),
                ),
            )
        )

        assertEquals("any-method", MockRegistry.matchHttp("PATCH", "/local/path?x=1#frag")?.id)
        assertNull(MockRegistry.matchHttp("PATCH", "/anything"))
        assertEquals("ack", MockRegistry.matchSocketAck("chat:send")?.id)
        assertNull(MockRegistry.matchSocketAck("chat:other"))
        assertEquals("ws", MockRegistry.matchWsSend("has needle in it")?.id)
        assertNull(MockRegistry.matchWsSend("plain text"))
        MockRegistry.update(MockRules())
    }

    @Test
    fun capBody_truncates_over_limit() {
        val capped = capBody("x".repeat(MAX_BODY_CHARS + 5))
        assertEquals(MAX_BODY_CHARS, capped.body!!.length)
        assertEquals(true, capped.truncated)
        assertEquals((MAX_BODY_CHARS + 5).toLong(), capped.size)
    }

    @Test
    fun capBody_handles_null_and_boundary() {
        assertEquals(CappedBody(null, 0, false), capBody(null))
        val exact = "x".repeat(MAX_BODY_CHARS)
        assertEquals(CappedBody(exact, MAX_BODY_CHARS.toLong(), false), capBody(exact))
    }

    @Test
    fun sniffer_report_can_be_observed_by_tests() {
        val reported = mutableListOf<DeviceMessage>()
        Sniffer.reportSinkForTests = reported::add
        try {
            val msg = SocketAckMsg(id = "a1", payload = "[]", mocked = false, timestamp = 1)
            Sniffer.report(msg)
            assertEquals(listOf<DeviceMessage>(msg), reported)
        } finally {
            Sniffer.reportSinkForTests = null
        }
    }

    @Test
    fun daemon_message_handler_updates_mocks_and_dispatches_push_events() {
        MockRegistry.update(MockRules())
        val received = mutableListOf<Pair<String, String>>()
        val handlers = mapOf<String, (String, String) -> Unit>(
            "c1" to { event, payload -> received += event to payload },
            "throwing" to { _, _ -> error("ignored") },
        )

        handleDaemonMessage(
            """{"type":"mock-rules","http":[{"id":"h1","urlPattern":"/mock"}],"socket":[]}""",
            handlers,
        )
        assertEquals("h1", MockRegistry.matchHttp("GET", "/mock")?.id)

        handleDaemonMessage(
            """{"type":"push-event","connectionId":"c1","event":"chat","payload":"hello"}""",
            handlers,
        )
        handleDaemonMessage(
            """{"type":"push-event","connectionId":null,"event":"broadcast","payload":"${'$'}{unknown}"}""",
            handlers,
        )
        handleDaemonMessage("""{"type":"bad"}""", handlers)
        handleDaemonMessage("""not json""", handlers)

        assertEquals(
            listOf("chat" to "hello", "broadcast" to """${'$'}{unknown}"""),
            received,
        )
        MockRegistry.update(MockRules())
    }
}
