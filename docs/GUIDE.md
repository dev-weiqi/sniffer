# Sniffer

A self-hosted Flipper replacement for monitoring and mocking an app's HTTP and Socket traffic.

```
┌─────────────────────┐         ws://host:9091/device        ┌──────────────────────┐
│  App (Android/iOS)  │ ───────────────────────────────────► │  daemon (your Mac)   │
│  KMP SDK plugins    │ ◄────── mock rules / push events ─── │  Node/TS, port 9091  │
└─────────────────────┘                                      └─────────┬────────────┘
                                                                       │ ws /ui + REST
                                                             ┌─────────▼────────────┐
                                                             │  Web UI (browser)    │
                                                             └──────────────────────┘
```

| Directory | Contents |
|-----------|----------|
| `client/` | Kotlin Multiplatform SDK (plugin based) and samples |
| `server/` | Node/TS daemon (device connections, in-memory traffic, auto `adb reverse`, test endpoints) and React web UI |

## Prerequisites

- Node.js 20+, JDK 17+
- Android: `adb` on PATH
- iOS: a KMP shared module using ktor; Xcode for the sample

## Quick start

```bash
npm run setup                 # first time: install deps and build the UI
npm start                     # start the daemon
open http://localhost:9091
```

Launch your debug app and it connects. To try the samples:

```bash
# Android, full demo (okhttp / ktor / socket.io / ktor-ws)
cd client && ./gradlew :sample:installDebug

# Compose Multiplatform sample (ktor only), Android
cd client && ./gradlew :sample-cmp:installDebug

# Compose Multiplatform sample, iOS simulator (no Xcode project needed)
cd client/sample-cmp/ios && ./build-sim.sh
xcrun simctl boot "iPhone 17" && xcrun simctl install booted build/SnifferCmpSample.app
xcrun simctl launch booted dev.weiqi.sniffer.samplecmp.ios   # runs the whole demo
```

## Integrating the SDK

Dependencies, the Android cleartext setting, `Sniffer.start` and client plugins are in the
[README](../README.md#add-the-sdk). Details not covered there:

- The SDK reconnects every 3 s, retries silently while the daemon is down and buffers up
  to 1000 messages offline.
- A real iOS device reaches the daemon over USB with no setup, or over Wi-Fi with
  `Sniffer.start(appId = ..., host = "<Mac LAN IP>")`.
- Runtime overrides (override > `start()` args > defaults), no rebuild needed:

```bash
# Android: debug.* properties are settable without root; restart the app afterwards
adb shell setprop debug.sniffer.port 9092
adb shell setprop debug.sniffer.host 192.168.1.20

# iOS: SNIFFER_HOST / SNIFFER_PORT in the Xcode scheme's environment variables
# JVM: -Dsniffer.port=9092 or SNIFFER_PORT=9092
# daemon: PORT=9092 npm start
```

## Using the Web UI

The top bar has the connection dot, a device picker, global search (URL, method, status,
event, payload), a light / dark toggle and a clear button.

### API tab

- Live table of time (click the header to flip sort), method, status, URL, size and
  duration. `okhttp` / `ktor` badges show the library; a purple **MOCK** badge marks mocks.
- Row details: URL, query, headers and bodies (JSON pretty printed, collapsible, copyable).
- **Copy cURL** reproduces the request.
- **Mock this request** prefills a rule from the method, path and real response body.

### Socket tab

- Chips show each socket (socket.io / ktor-ws) and its state.
- Event stream: ↑ client emit, ↓ server to client. Click a row for the payload and ack.
- Outgoing event: **Mock this event's ack**. Incoming event: **Prefill push form**.
- **Push Server → Client event** fires the app's listener as if the server sent it, to one
  connection or all of a device's connections (ktor-ws receives a text frame).

### Mocks tab

Rules are stored per device on the daemon, pushed immediately and run on the device, so
they keep working offline.

- **HTTP rules**: method (ANY = any) plus exact request path, answered with the given
  status, headers and body, optional delay. Matched requests never reach the network.
- Bodies and socket payloads expand `${randomId}`, `${now}` (ISO-8601 UTC) and
  `${randomString(min~max)}` on each match.
- **Socket rules**: *sio ack* matches the emitted event name, does not send it and calls
  the ack locally with your payload (JSON array = multiple args). *ws reply* matches
  outgoing ktor-ws text frames by substring, drops them and injects your reply as an
  incoming frame. Both take an optional delay.
- The checkbox disables a rule without deleting it. Press **Save** to apply.

## Test endpoints (daemon, used by the samples)

| Endpoint | Behavior |
|----------|----------|
| `ANY /test/echo` | echoes method, headers and body |
| `GET /test/users/:id` | fake user JSON |
| `GET /test/slow?ms=1500` | responds after a delay |
| `GET /test/error` | responds 500 |
| `GET /test/sse` | Server-Sent Events: 5 ticks, 400 ms apart |
| `ws /test/ws` | echoes text frames |
| socket.io `chat:send` | acks `{ok,echo,ts}` and broadcasts `chat:new`; `echo` acks its input |

## Troubleshooting

- **Device missing**: check the daemon is running and `adb devices` lists the device (the
  daemon runs `adb reverse tcp:9091 tcp:9091` every 5 s). On Android, check cleartext is
  allowed. Over Wi-Fi, check `host`, the network and the firewall on port 9091.
- **UI shows plain text**: `cd server/ui && npm run build`, then refresh.
- **HTTPS bodies missing**: interception happens before TLS, so no certificate is needed.
  The client instance is probably missing the plugin.
- **SSE / streaming**: 101 upgrades pass through untouched. `text/event-stream` bodies are
  captured as the app reads them, except ktor `client.sse { }` calls, which record status
  and headers only.
- **Entries gone after restart**: traffic is in memory (max 2000 stored messages). Mock
  rules persist in `~/.sniffer/mocks.json`.
- **Truncated bodies**: bodies over 1 MB are cut and flagged; binary bodies record size only.

## Development

```bash
cd server/daemon && npm run typecheck    # daemon type check
cd server/ui && npm run dev              # UI dev mode (proxies to 9091)
cd client && ./gradlew build             # all SDK modules and tests, incl. iOS
cd client && ./gradlew :ktor-ws:wsDebug  # ktor-ws smoke test (needs a running daemon)
```

Wire protocol: [PROTOCOL.md](../PROTOCOL.md).
