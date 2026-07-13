# Sniffer

A self-hosted Flipper replacement: monitor and mock your app's HTTP and Socket traffic.

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
| `client/` | Kotlin Multiplatform SDK (plugin-based; apps include only what they need) + samples |
| `server/` | Node/TS daemon (device connections, in-memory traffic store, auto `adb reverse`, test endpoints) + React web UI |

## Prerequisites

- Node.js 18+, JDK 17+
- Android: `adb` on PATH (USB devices and emulators are reached through the daemon's automatic `adb reverse`)
- iOS: the app embeds a KMP shared module (networking via ktor); Xcode for the sample

## Quick start

```bash
npm run setup                 # first time only: install deps + build the UI
npm start                     # start the daemon (auto adb reverse every 5 s)
open http://localhost:9091    # open the interface
```

Then just launch your debug app — the SDK connects automatically.
To try everything with the bundled samples:

```bash
# Android (full demo: okhttp / ktor / socket.io / ktor-ws)
cd client && ./gradlew :sample:installDebug

# Compose Multiplatform sample (ktor only) — Android target
cd client && ./gradlew :sample-cmp:installDebug

# Compose Multiplatform sample — iOS simulator (no Xcode project needed)
cd client/sample-cmp/ios && ./build-sim.sh
xcrun simctl boot "iPhone 17" && xcrun simctl install booted build/SnifferCmpSample.app
xcrun simctl launch booted dev.weiqi.sniffer.samplecmp.ios   # auto-runs the whole demo
```

`sample` is the full Android demo (okhttp / ktor / socket.io / ktor-ws, incl. SSE and
mock scenarios). `sample-cmp` shares one Compose UI across Android and iOS with a
ktor-only stack — on iOS it runs the whole demo automatically on launch.

## Integrating the SDK into your app

### 1. Add dependencies (Android / KMP)

Modules are plugin-based: `core` is required, pick the rest to match your stack.
Every module has a matching `-noop` stand-in (same API, empty implementation) so
release builds carry zero monitoring code.

```kotlin
debugImplementation("dev.weiqi.sniffer:core")
releaseImplementation("dev.weiqi.sniffer:core-noop")

// only if you use okhttp
debugImplementation("dev.weiqi.sniffer:okhttp")
releaseImplementation("dev.weiqi.sniffer:okhttp-noop")

// only if you use ktor client (KMP common, works on iOS too)
debugImplementation("dev.weiqi.sniffer:ktor")
releaseImplementation("dev.weiqi.sniffer:ktor-noop")

// only if you use socket.io
debugImplementation("dev.weiqi.sniffer:socketio")
releaseImplementation("dev.weiqi.sniffer:socketio-noop")

// only if you use ktor WebSockets (KMP common)
debugImplementation("dev.weiqi.sniffer:ktor-ws")
releaseImplementation("dev.weiqi.sniffer:ktor-ws-noop")
```

> Not published to Maven yet — use a composite build, `mavenLocal`
> (add publish config and `./gradlew publishToMavenLocal`), or a direct
> project dependency as in `client/sample/build.gradle.kts`.

### 2. Start the connection (Application.onCreate / app init)

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Android defaults to localhost:9091, reached via the daemon's adb reverse;
        // works unchanged for emulators and USB devices
        Sniffer.start(appId = packageName)
    }
}
```

iOS (inside the KMP shared module) — the iOS **simulator** shares the Mac's
loopback so `localhost` works; a **real device** needs your Mac's LAN IP:

```kotlin
Sniffer.start(appId = "com.example.app")                      // simulator
Sniffer.start(appId = "com.example.app", host = "192.168.x.x") // real device
```

The SDK reconnects every 3 s, retries silently when the daemon is down, and
buffers up to 1000 messages while disconnected. It never affects the app.

Host and port can also be overridden at runtime, without rebuilding the app
(override > `start()` args > defaults). The daemon side is `PORT=9092 npm start`.

```bash
# Android: debug.* system properties are settable via adb without root
adb shell setprop debug.sniffer.port 9092
adb shell setprop debug.sniffer.host 192.168.1.20   # then restart the app

# iOS: set SNIFFER_HOST / SNIFFER_PORT in the Xcode scheme's environment variables
# JVM: -Dsniffer.port=9092 or SNIFFER_PORT=9092
```

### 3. Install the plugins

```kotlin
// okhttp: one interceptor
val client = OkHttpClient.Builder()
    .addInterceptor(SnifferOkHttp.interceptor())
    .build()

// ktor: one plugin
val ktor = HttpClient(CIO) {
    install(SnifferKtor)
}

// socket.io: wrap once, use the wrapper from then on
val socket = SnifferSocketIO.wrap(IO.socket("https://your-server"), "https://your-server")
socket.on("chat:new") { args -> /* ... */ }
socket.connect()
socket.emit("chat:send", arrayOf("hello"), Ack { args -> /* ... */ })

// ktor WebSocket: install(SnifferKtorWs) once, then use the client normally
val session = ktor.webSocketSession("wss://your-server/ws")
session.send("ping")
for (frame in session.incoming) { /* ... */ }
```

## Using the Web UI

Top bar: connection dot, device picker (filters when several devices are
connected), global search (URL / method / status / event / payload),
light–dark theme toggle (defaults to light), clear button.

### API tab

- Live request/response table: time (click the header to toggle sort order),
  method, status (color-coded), URL, size, duration; `okhttp` / `ktor` badges
  mark the source library and a purple **MOCK** badge marks mocked entries.
- Click a row for details: URL, query, request/response headers, bodies
  (JSON pretty-printed, collapsible, copyable).
- **Copy cURL**: reproduces the request as a runnable curl command.
- **Mock this request**: prefills a mock rule from the request's method, path
  and actual response body, then jumps to the Mocks tab.

### Socket tab

- Connection chips show each socket (socket.io / ktor-ws) and its state.
- Event stream: ↑ = client emit, ↓ = server→client; click a row for the full
  payload and ack.
- On an outgoing event: **Mock this event's ack** prefills a socket rule.
  On an incoming event: **Prefill push form** copies it into the push composer.
- **Push Server → Client event**: choose a target (all connections of a device,
  or one connection), enter event name and payload — the app's listener fires
  as if the server had sent it (a ktor-ws connection receives a text frame).

### Mocks tab

Rules live in the daemon per device and are pushed to that device immediately;
they then run **on the device**, so they keep working offline.

- **HTTP rules**: method (ANY = any) + URL substring match → respond with the
  given status/headers/body, optional delay. Matched requests never touch the
  network — the interceptor short-circuits locally. The body editor has
  pretty-print / minify JSON helpers.
- Mock bodies and socket payloads support placeholders expanded on the device
  each time a rule matches: `${id}` and `${randomString(length)}`. Replace
  `length` with the number you want for that rule.
- **Socket rules** come in two flavors. **sio ack**: matches the emitted
  socket.io event name; matched emits are **not sent to the server** and the SDK
  calls the ack callback locally with your payload (JSON array = multiple ack
  args). **ws reply**: matches outgoing ktor-ws text frames by substring;
  matched frames are not sent and your fake reply is injected as an incoming
  frame. Both support an optional delay.
- The checkbox disables a rule without deleting it. Press **Save** to apply.

## Test endpoints (built into the daemon, used by the sample)

| Endpoint | Behavior |
|----------|----------|
| `ANY /test/echo` | echoes method/headers/body |
| `GET /test/users/:id` | fake user JSON |
| `GET /test/slow?ms=1500` | responds after a delay |
| `GET /test/error` | responds 500 |
| `GET /test/sse` | Server-Sent Events: 5 ticks, 400 ms apart |
| `ws /test/ws` | echoes text frames |
| socket.io `chat:send` | acks `{ok,echo,ts}` and broadcasts `chat:new`; `echo` acks its input |

## Troubleshooting

- **Device doesn't show up**: check the daemon is running and `adb devices`
  lists your device (the daemon runs `adb reverse tcp:9091 tcp:9091` every 5 s).
  For iOS/real devices over LAN, verify the `host`, same network, and that
  port 9091 isn't firewalled.
- **UI shows plain text**: run `cd server/ui && npm run build`, then refresh.
- **HTTPS bodies missing**: interception happens in the library (before TLS),
  no certificate needed — a missing body usually means that client instance
  doesn't have the plugin installed.
- **SSE / streaming**: upgrade (101) and `text/event-stream` responses are
  passed through untouched — headers and status are recorded, bodies are not
  captured (buffering a live stream would break it).
- **Entries gone after daemon restart**: traffic is in-memory (max 5000
  entries) by design. Mock rules DO survive restarts — they are persisted to
  `~/.sniffer/mocks.json`.
- **Truncated bodies**: bodies over 1 MB keep only the first part and are
  flagged; binary bodies record size only.

## Development

```bash
cd server/daemon && npm run typecheck        # daemon type check
cd server/ui && npm run dev                  # UI dev mode (proxies to 9091)
cd client && ./gradlew build             # all SDK modules + tests (incl. iOS targets)
cd client && ./gradlew :ktor-ws:wsDebug  # ktor-ws smoke test (needs a running daemon)
```

Wire protocol details: [PROTOCOL.md](../PROTOCOL.md).
