package dev.weiqi.sniffer.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Wire protocol with the daemon; fields mirror PROTOCOL.md. */
val SnifferJson = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = true
    encodeDefaults = true
}

@Serializable
sealed interface DeviceMessage

@Serializable
@SerialName("hello")
data class Hello(
    val deviceId: String,
    val deviceName: String,
    val platform: String,
    val appId: String,
    val sdkVersion: String,
    val capabilities: List<String>,
) : DeviceMessage

@Serializable
@SerialName("http-request")
data class HttpRequestMsg(
    val id: String,
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String?,
    val bodySize: Long,
    val bodyTruncated: Boolean,
    val library: String,
    val timestamp: Long,
) : DeviceMessage

@Serializable
@SerialName("http-response")
data class HttpResponseMsg(
    val id: String,
    val status: Int,
    val headers: Map<String, String>,
    val body: String?,
    val bodySize: Long,
    val bodyTruncated: Boolean,
    val durationMs: Long,
    val mocked: Boolean,
    val error: String?,
    val timestamp: Long,
    // when true, [body] is base64-encoded raw bytes (e.g. an image) rather than text
    val bodyBase64: Boolean = false,
    // latency injected by a matched delay-only rule (0 = none); the real request still ran
    val delayedMs: Long = 0,
) : DeviceMessage

@Serializable
@SerialName("socket-status")
data class SocketStatusMsg(
    val connectionId: String,
    val transport: String,
    val url: String,
    val status: String,
    val timestamp: Long,
) : DeviceMessage

@Serializable
@SerialName("socket-event")
data class SocketEventMsg(
    val id: String,
    val connectionId: String,
    val transport: String,
    val direction: String,
    val event: String,
    val payload: String,
    val mocked: Boolean,
    val timestamp: Long,
) : DeviceMessage

@Serializable
@SerialName("socket-ack")
data class SocketAckMsg(
    val id: String,
    val payload: String?,
    val mocked: Boolean,
    val timestamp: Long,
) : DeviceMessage

@Serializable
sealed interface DaemonMessage

@Serializable
@SerialName("mock-rules")
data class MockRules(
    val http: List<HttpMockRule> = emptyList(),
    val socket: List<SocketMockRule> = emptyList(),
) : DaemonMessage

@Serializable
@SerialName("push-event")
data class PushEvent(
    val connectionId: String?,
    val event: String,
    val payload: String,
) : DaemonMessage

@Serializable
data class HttpMockRule(
    val id: String,
    val enabled: Boolean = true,
    val method: String? = null,
    val urlPattern: String,
    val status: Int = 200,
    val headers: Map<String, String> = emptyMap(),
    val body: String = "",
    val delayMs: Long = 0,
    // delayOnly: let the real request run but inject [delayMs]; do not fake the response
    val delayOnly: Boolean = false,
)

@Serializable
data class SocketMockRule(
    val id: String,
    val enabled: Boolean = true,
    // "socketio": [event] matches the emitted event name, [ackPayload] is a JSON array of ack args.
    // "ktor-ws": [event] is a substring matched against outgoing text frames,
    //            [ackPayload] is the raw text frame injected as the fake server reply.
    val transport: String = "socketio",
    val event: String,
    val ackPayload: String = "[]",
    val delayMs: Long = 0,
)
