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

// A response matched an armed breakpoint and is now paused on the device: the real response is
// held and the host's call blocks until the daemon sends back a matching BreakpointResolve.
// [method]/[url] identify the call; [status]/[headers]/[body] are the editable response.
@Serializable
@SerialName("breakpoint-hit")
data class BreakpointHitMsg(
    val id: String,
    val ruleId: String,
    val phase: String, // "response"
    val method: String,
    val url: String,
    val status: Int,
    val headers: Map<String, String>,
    val body: String?,
    val library: String,
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

// Full replacement of this device's armed breakpoint rules (like mock-rules).
@Serializable
@SerialName("breakpoint-rules")
data class BreakpointRules(
    val rules: List<BreakpointRule> = emptyList(),
) : DaemonMessage

// Releases a paused response. action "resume" applies any non-null edit to the response then
// hands it to the app; "abort" fails the host call. Sent by the UI via the daemon.
@Serializable
@SerialName("breakpoint-resolve")
data class BreakpointResolveMsg(
    val id: String,
    val action: String, // "resume" | "abort"
    val status: Int? = null,
    val headers: Map<String, String>? = null,
    val body: String? = null,
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
data class BreakpointRule(
    val id: String,
    val enabled: Boolean = true,
    val method: String? = null,
    val urlPattern: String,
    // "response": pause after the real response arrives, before the app sees it.
    val phase: String = "response",
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
