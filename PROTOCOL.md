English | [繁體中文](PROTOCOL.zh-TW.md)

# Sniffer Wire Protocol v1

Every message is a WebSocket text frame carrying flat JSON with a `type` field.
A single daemon port (default **9091**) hosts everything:

| Path        | Purpose |
|-------------|---------|
| `/device`   | SDK (device side) connects here |
| `/ui`       | Web UI connects here (read-only stream) |
| `/api/*`    | REST for UI actions (mock rules, push event, clear) |
| `/test/*`   | test HTTP endpoints for the sample app |
| `/test/ws`  | plain WebSocket echo for testing |
| `/socket.io`| test socket.io server |
| `/`         | UI static files |

**USB (physical iOS device).** usbmuxd can only connect *into* a device port, so roles
flip: the SDK listens on `127.0.0.1:9092` (`SNIFFER_USB_PORT`, both sides) and the daemon
dials it and performs the WebSocket client handshake (`GET /device`). After that the protocol
is identical. The SDK serves one session at a time; while an outbound `/device` session is
live, USB dial-ins are closed and the daemon retries on its next 5 s poll.

Timestamps are epoch millis. Bodies are strings; binary bodies are `null`. Bodies over
**1 MB** are truncated and flagged `bodyTruncated: true`.

## Device → Daemon

```jsonc
// first message after connecting
{ "type": "hello", "deviceId": "279f756", "deviceName": "sdk_gphone64_arm64",
  "platform": "android", "appId": "dev.weiqi.sniffer.sample", "sdkVersion": "0.1.0",
  "capabilities": ["http", "socketio", "ktor-ws"] }

// HTTP: request and response are sent separately, correlated by id
{ "type": "http-request", "id": "<uuid>", "method": "GET", "url": "https://host/path?q=1",
  "headers": { "Accept": "application/json" }, "body": null, "bodySize": 0,
  "bodyTruncated": false, "library": "okhttp", "timestamp": 0, "userId": "user-7" }
// userId is the Analytics identity when the request was captured (max 1024 chars).
// Empty means no user ID was set; absent/null means an older SDK did not capture identity.
// Responses preserve the request's identity, even if setUserId changes while it is in flight.

{ "type": "http-response", "id": "<uuid>", "status": 200, "headers": {},
  "body": "{...}", "bodySize": 18879, "bodyTruncated": false,
  "durationMs": 115, "mocked": false, "error": null, "timestamp": 0,
  "delayedMs": 0 }        // optional: latency injected by a delay-only rule (real request still ran)
// on transport failure: status=0, error=<message>

// Local Analytics mirror of an explicit logEvent call, with an immutable parameter snapshot.
{ "type": "firebase-analytics-event", "id": "<uuid>", "name": "select_content",
  "params": { "item_id": "42", "quantity": 2, "value": 9.99 },
  "timestamp": 0, "userId": "user-7", "truncated": false, "firebaseSdkCalled": true }
// firebaseSdkCalled means the original SDK call returned normally, never cloud acknowledgement.
// Parameters preserve strings, numbers, booleans, null, maps, and lists/arrays.
// Bounds: name 4096 chars; userId 1024; parameter capture budget 65536 chars/nodes,
// depth 8, 64 keys per object, 200 items per array. Oversized captures set truncated.
// Events use the normal in-memory offline queue. This is not confirmation of Firebase upload.

// socket connection lifecycle
{ "type": "socket-status", "connectionId": "<uuid>", "transport": "socketio",
  "url": "http://host", "status": "connected", "timestamp": 0 }
// transport: "socketio" | "ktor-ws"; status: "connected" | "disconnected"

// socket events; direction: "out" = client emit, "in" = server→client
// ktor-ws frames use the fixed event name "message"
// label (optional): short app-provided display tag (SDK label labeler on socket.on); the UI
// renders event(label). "event" stays the real wire name; mock matching and injection always use "event"
{ "type": "socket-event", "id": "<uuid>", "connectionId": "<uuid>",
  "transport": "socketio", "direction": "out", "event": "chat:send",
  "payload": "[\"hello\"]", "mocked": false, "timestamp": 0, "label": null }

// ack for a previous emit (same id)
{ "type": "socket-ack", "id": "<emit uuid>", "payload": "[...]",
  "mocked": false, "timestamp": 0 }

// a response matched an armed breakpoint and is paused: the host call blocks until the daemon
// sends a matching breakpoint-resolve. method/url identify the call; status/headers/body are
// the held (editable) response. Only non-streaming textual responses can be paused.
{ "type": "breakpoint-hit", "id": "<uuid>", "ruleId": "b1", "phase": "response",
  "method": "GET", "url": "https://host/path", "status": 200, "headers": {}, "body": "...",
  "library": "okhttp", "timestamp": 0 }
```

## Daemon → Device

```jsonc
// full replacement of this device's mock rules (sent on connect and on every change for this device)
{ "type": "mock-rules",
  "http": [ { "id": "r1", "enabled": true, "method": "GET",
              "urlPattern": "/api/characters/3",
              "status": 200, "headers": {}, "body": "{...}", "delayMs": 0 } ],
  "socket": [ { "id": "s1", "enabled": true, "transport": "socketio", "event": "chat:send",
                "ackPayload": "[{\"ok\":true}]", "delayMs": 0 } ] }
// http rule: method null = any; urlPattern is an exact match against the request path
//   (scheme, host, query and fragment stripped). Empty pattern matches nothing.
// Optional queryParams: { "page": "2" } requires every specified decoded key/value to match.
//   Extra request parameters are ignored. Keys and values are case-sensitive strings; percent
//   escapes are decoded and + means space. A repeated key matches if any value equals the rule.
//   An empty string matches ?key or ?key=, but not a missing key.
//   Matching rules with nonempty queryParams or bodyMatch win before path-only fallback rules, regardless of
//   list position; the first matching rule wins within each group. No match means real traffic.
//   SDKs advertise "http-query-mocks" in hello.capabilities. The daemon omits conditional rules
//   for older SDKs, which would otherwise ignore queryParams and match every page.
// Optional bodyMatch: a string containing a JSON object, e.g. "{\"limit\":20}".
//   All query and body conditions must match. Objects use recursive subset matching; arrays
//   match exactly, including object fields inside arrays. JSON types matter; missing != null.
//   Absent/null/blank bodyMatch or {} imposes no body constraint. Invalid conditions never match.
//   Only complete, safely readable JSON request bodies within the capture limit are matched;
//   missing, truncated, binary, or non-replayable bodies cannot satisfy a nonempty body condition.
//   SDKs advertise "http-body-mocks". The daemon omits body-conditioned rules for older SDKs;
//   a rule using both queryParams and bodyMatch requires both capabilities. Invalid drafts stay
//   in storage/export but are never synced. No matching rule means the original request proceeds.
// body and ackPayload support placeholders expanded on the device at match time:
//   ${randomId}, ${now} (ISO-8601 UTC), ${randomString(min~max)}
//   min/max are user-provided whole numbers; the string length is random within [min, max]
// socket rule, transport "socketio": matched emits are not sent; a fake ack (JSON array of args)
//   is returned locally. A non-blank [pushEvent] switches the rule to the event-reply mode: after
//   [delayMs] the SDK injects [pushEvent] with [pushPayload] (JSON array of args, placeholders
//   expanded) as a server→client event into the app's listeners and sends no fake ack
//   ([ackPayload] is ignored), for request/response APIs that answer with a separate event
//   instead of an ack. transport "ktor-ws": [event] is a substring matched against outgoing
//   text frames; matched frames are not sent and [ackPayload] is injected as a fake incoming
//   frame ([pushEvent]/[pushPayload] are ignored; the reply frame already is the injection)
// socket rule optional payloadMatch: a string containing a JSON object, e.g. "{\"page\":2}".
//   Socket.IO compares the first emitted argument (ack callbacks and other arguments are ignored).
//   WebSocket compares the outgoing JSON text frame, in addition to the existing event substring.
//   All specified fields must match; nested objects also use subset matching. Extra object fields
//   are ignored. Arrays match exactly, including object fields inside arrays. Values retain their
//   JSON types (2 differs from "2" and true); numbers compare numerically (2 equals 2.0).
//   Missing fields differ from null. Absent/null/blank payloadMatch or {} is a fallback.
//   Conditional matches precede fallbacks; the first matching rule wins within each group.
//   Invalid conditions/non-object roots never match. Invalid/non-object payloads can only use fallbacks.
//   SDKs advertise "socket-payload-mocks". The daemon omits conditional rules for older SDKs and
//   invalid conditions for all SDKs. Drafts remain in storage/export so users can correct them.
// UI-only rule fields the daemon strips before sending to the device: "starred" (rule is shared
//   with every device of the same appId, stored per appId on the daemon and merged in ahead of
//   the device's own rules), plus "name" / "createdAt" pass through untouched (SDK ignores them)

// inject a server→client event from the UI; connectionId null = broadcast to all connections
{ "type": "push-event", "connectionId": null, "event": "chat:new",
  "payload": "{\"msg\":\"hi\"}" }

// full replacement of this device's armed breakpoint rules (like mock-rules)
{ "type": "breakpoint-rules",
  "rules": [ { "id": "b1", "enabled": true, "method": "GET",
               "urlPattern": "/api/orders", "phase": "response" } ] }
// same matching semantics as a mock (method null = any; urlPattern is an exact path match).
//   The SDK pauses a matching response (before the app reads it) and blocks until the resolve
//   below. Golden rule 3: a pause only happens while connected, and the SDK releases every paused
//   call (as if resumed unchanged) if the daemon connection drops.

// releases a paused response. action "resume" applies any non-null edit to the response then
//   hands it to the app; "abort" fails the host call.
{ "type": "breakpoint-resolve", "id": "<hit uuid>", "action": "resume",
  "status": 200, "headers": {}, "body": "..." }
```

## Daemon ↔ UI

WebSocket `/ui` sends a snapshot on connect, then a live stream:

```jsonc
{ "type": "init", "devices": [ { "...": "hello fields", "connected": true } ],
  "entries": [ { "deviceId": "...", "message": { "...": "any device message" } } ],
  "mocks": { "http": [], "socket": [] },
  "breakpointsByDevice": { "<deviceId>": [ { "...": "breakpoint rule" } ] },
  "pausedHits": [ { "deviceId": "...", "hit": { "...": "breakpoint-hit message" } } ] }

{ "type": "event", "deviceId": "...", "message": {} }
{ "type": "device-status", "deviceId": "...", "connected": false }
{ "type": "mocks-changed", "deviceId": "...", "mocks": { "http": [], "socket": [] } }
{ "type": "entries-cleared" }
{ "type": "firebase-entries-cleared" } // Firebase only, all devices
{ "type": "breakpoints-changed", "deviceId": "...", "rules": [ { "...": "breakpoint rule" } ] }
{ "type": "breakpoint-hit", "deviceId": "...", "hit": { "...": "breakpoint-hit message" } }
{ "type": "breakpoint-resolved", "deviceId": "...", "id": "<hit uuid>" }   // user resumed/aborted
{ "type": "breakpoints-released", "deviceId": "..." }   // device disconnected: SDK auto-resumed its paused calls
```

REST (UI → daemon):

```
PUT    /api/mocks              body: { "deviceId": "...", "http": [...], "socket": [...] }   full replace for one device;
                               rules with "starred": true are stored per appId and delivered to every
                               device of that app, including ones that connect later
POST   /api/push-event         body: { "deviceId": "...", "connectionId": null, "event": "...", "payload": "..." }
PUT    /api/breakpoints         body: { "deviceId": "...", "rules": [...] }   full replace of a device's armed rules
POST   /api/breakpoints/resolve body: { "deviceId": "...", "id": "<hit uuid>", "action": "resume"|"abort",
                                         "status"?, "headers"?, "body"? }
DELETE /api/entries            clear recorded traffic
DELETE /api/entries/firebase   clear Firebase records for all devices; prevents replay of pre-clear Analytics events
GET    /api/state              debug snapshot: devices, entry count, mocks
```
