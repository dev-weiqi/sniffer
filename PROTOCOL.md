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

Timestamps are epoch millis. Bodies are always strings; binary bodies carry no
content (`body: null`). Bodies over **1 MB** are truncated and flagged
`bodyTruncated: true`.

## Device → Daemon

```jsonc
// first message after connecting
{ "type": "hello", "deviceId": "279f756", "deviceName": "sdk_gphone64_arm64",
  "platform": "android", "appId": "dev.weiqi.sniffer.sample", "sdkVersion": "0.1.0",
  "capabilities": ["http", "socketio", "ktor-ws"] }

// HTTP: request and response are sent separately, correlated by id
{ "type": "http-request", "id": "<uuid>", "method": "GET", "url": "https://host/path?q=1",
  "headers": { "Accept": "application/json" }, "body": null, "bodySize": 0,
  "bodyTruncated": false, "library": "okhttp", "timestamp": 0 }

{ "type": "http-response", "id": "<uuid>", "status": 200, "headers": {},
  "body": "{...}", "bodySize": 18879, "bodyTruncated": false,
  "durationMs": 115, "mocked": false, "error": null, "timestamp": 0 }
// on transport failure: status=0, error=<message>

// socket connection lifecycle
{ "type": "socket-status", "connectionId": "<uuid>", "transport": "socketio",
  "url": "http://host", "status": "connected", "timestamp": 0 }
// transport: "socketio" | "ktor-ws"; status: "connected" | "disconnected"

// socket events; direction: "out" = client emit, "in" = server→client
// ktor-ws frames use the fixed event name "message"
{ "type": "socket-event", "id": "<uuid>", "connectionId": "<uuid>",
  "transport": "socketio", "direction": "out", "event": "chat:send",
  "payload": "[\"hello\"]", "mocked": false, "timestamp": 0 }

// ack for a previous emit (same id)
{ "type": "socket-ack", "id": "<emit uuid>", "payload": "[...]",
  "mocked": false, "timestamp": 0 }
```

## Daemon → Device

```jsonc
// full replacement of this device's mock rules (sent on connect and on every change for this device)
{ "type": "mock-rules",
  "http": [ { "id": "r1", "enabled": true, "method": "GET",
              "urlPattern": "/api/characters/",
              "status": 200, "headers": {}, "body": "{...}", "delayMs": 0 } ],
  "socket": [ { "id": "s1", "enabled": true, "transport": "socketio", "event": "chat:send",
                "ackPayload": "[{\"ok\":true}]", "delayMs": 0 } ] }
// http rule: method null = any; urlPattern is a substring match
// body and ackPayload support placeholders expanded on the device at match time:
//   ${id}, ${randomString(length)}, ${randomNumber(min~max)}
//   length/min/max are user-provided numbers in each rule
// socket rule, transport "socketio": matched emits are not sent; a fake ack (JSON array of args)
//   is returned locally. transport "ktor-ws": [event] is a substring matched against outgoing
//   text frames; matched frames are not sent and [ackPayload] is injected as a fake incoming frame

// inject a server→client event from the UI; connectionId null = broadcast to all connections
{ "type": "push-event", "connectionId": null, "event": "chat:new",
  "payload": "{\"msg\":\"hi\"}" }
```

## Daemon ↔ UI

WebSocket `/ui`: a snapshot on connect, then a live stream:

```jsonc
{ "type": "init", "devices": [ { "...": "hello fields", "connected": true } ],
  "entries": [ { "deviceId": "...", "message": { "...": "any device message" } } ],
  "mocks": { "http": [], "socket": [] } }

{ "type": "event", "deviceId": "...", "message": {} }
{ "type": "device-status", "deviceId": "...", "connected": false }
{ "type": "mocks-changed", "deviceId": "...", "mocks": { "http": [], "socket": [] } }
{ "type": "entries-cleared" }
```

REST (UI → daemon):

```
PUT    /api/mocks        body: { "deviceId": "...", "http": [...], "socket": [...] }   full replace for one device
POST   /api/push-event   body: { "deviceId": "...", "connectionId": null, "event": "...", "payload": "..." }
DELETE /api/entries      clear recorded traffic
GET    /api/state        debug snapshot: devices, entry count, mocks
```
