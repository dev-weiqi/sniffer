<h1 align="center">Sniffer</h1>

<p align="center">
  <a href="https://github.com/dev-weiqi/sniffer/releases"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://www.npmjs.com/package/@dev-weiqi/sniffer"><img src="https://img.shields.io/npm/v/%40dev-weiqi%2Fsniffer?label=npm" alt="npm"></a>
  <a href="https://central.sonatype.com/namespace/io.github.dev-weiqi.sniffer"><img src="https://img.shields.io/maven-central/v/io.github.dev-weiqi.sniffer/core?label=maven" alt="Maven Central"></a>
</p>

Sniffer is a Kotlin Multiplatform SDK and local monitor for inspecting and mocking
mobile network traffic while you develop apps.

It supports **OkHttp**, **Ktor Client**, **Socket.IO**, and **Ktor WebSocket**.

![Sniffer API traffic panel](docs/assets/sniffer-api-preview.png)

It follows the developer workflow that made
[Flipper](https://github.com/facebook/flipper) useful: connect a debug app,
watch traffic live, and change behavior from a desktop UI. Sniffer exists because
our Flipper-based Android setup ran into the
[Android 16 KB page-size migration](https://developer.android.com/guide/practices/page-sizes),
while the upstream Flipper repository is now a public archive/read-only project.
Sniffer keeps the network debugging pieces in a small stack we can maintain.

## Install the monitor

Run the local daemon on your development machine. It serves the browser UI,
stores mock rules, and automatically runs `adb reverse` for Android devices.

Install with npm:

```bash
npm install -g @dev-weiqi/sniffer
```

Or run it without installing:

```bash
npx @dev-weiqi/sniffer start
```

Start the monitor:

```bash
sniffer start
open http://localhost:9091
```

Use another port when needed:

```bash
PORT=9092 sniffer start
```

## Add the SDK

Use `core` plus the transport modules your app actually uses. Add the matching
`-noop` artifacts to release builds so production builds keep the same API with
empty implementations.

Supported client integrations:

| Client | Sniffer artifact |
| --- | --- |
| OkHttp | `io.github.dev-weiqi.sniffer:okhttp` |
| Ktor Client | `io.github.dev-weiqi.sniffer:ktor` |
| Socket.IO Java client | `io.github.dev-weiqi.sniffer:socketio` |
| Ktor WebSocket | `io.github.dev-weiqi.sniffer:ktor-ws` |

```kotlin
val snifferVersion = "0.1.0"

dependencies {
    debugImplementation("io.github.dev-weiqi.sniffer:core:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:core-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:okhttp:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:okhttp-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:ktor:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:ktor-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:socketio:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:socketio-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:ktor-ws:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:ktor-ws-noop:$snifferVersion")
}
```

For Kotlin Multiplatform shared code, add the KMP modules you need to
`commonMain`:

```kotlin
commonMain.dependencies {
    implementation("io.github.dev-weiqi.sniffer:core:$snifferVersion")
    implementation("io.github.dev-weiqi.sniffer:ktor:$snifferVersion")
    implementation("io.github.dev-weiqi.sniffer:ktor-ws:$snifferVersion")
}
```

## Start Sniffer

Start the SDK once when the app boots. The SDK reconnects automatically and does
not throw into your app when the daemon is not running.

```kotlin
import dev.weiqi.sniffer.core.Sniffer

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Sniffer.start(appId = packageName)
    }
}
```

Android devices and emulators reach the daemon through `adb reverse`, so
`localhost:9091` works by default. iOS simulators can also use `localhost`.
For a physical iOS device, pass your Mac's LAN address:

```kotlin
Sniffer.start(appId = "com.example.app", host = "192.168.1.20")
```

Runtime overrides are available when you do not want to rebuild:

```bash
adb shell setprop debug.sniffer.port 9092
adb shell setprop debug.sniffer.host 192.168.1.20
```

## Attach your clients

OkHttp:

```kotlin
import dev.weiqi.sniffer.okhttp.SnifferOkHttp

val okHttp = OkHttpClient.Builder()
    .addInterceptor(SnifferOkHttp.interceptor())
    .build()
```

Ktor client:

```kotlin
import dev.weiqi.sniffer.ktor.SnifferKtor

val ktor = HttpClient(CIO) {
    install(SnifferKtor)
}
```

Socket.IO:

```kotlin
import dev.weiqi.sniffer.socketio.SnifferSocketIO

val raw = IO.socket("https://api.example.com")
val socket = SnifferSocketIO.wrap(raw, "https://api.example.com")

socket.connect()
socket.emit("cart:update", mapOf("sku" to "pro"))
```

Ktor WebSocket:

```kotlin
import dev.weiqi.sniffer.ktorws.snifferWebSocketSession

val session = ktor.snifferWebSocketSession("wss://api.example.com/realtime")
session.send("ping")
```

## Use the UI

Open `http://localhost:9091`, launch your debug app, and select the connected
device.

- **API**: inspect live requests and responses, headers, JSON, images, animated
  WebP responses, copied cURL commands, and mocked entries.
- **Socket**: inspect Socket.IO and WebSocket connections, events, payloads,
  acks, and pushed server-to-client messages.
- **Mocks**: create per-device HTTP response rules, delay-only rules, Socket.IO
  ack rules, WebSocket reply rules, and server-to-client push events.

Rules are sent to the selected device and run inside the SDK. HTTP mocks
short-circuit matched requests before the network. Socket ack rules answer the
client locally. Mock bodies support placeholders such as `${id}`,
`${randomString(length)}`, and `${randomNumber(min~max)}`.

## Modules

| Artifact | Use it for |
| --- | --- |
| `io.github.dev-weiqi.sniffer:core` | SDK connection, device identity, mock rule sync |
| `io.github.dev-weiqi.sniffer:okhttp` | OkHttp request/response inspection and HTTP mocks |
| `io.github.dev-weiqi.sniffer:ktor` | Ktor client inspection for Android/iOS/JVM |
| `io.github.dev-weiqi.sniffer:socketio` | Socket.IO event inspection, ack mocks, push events |
| `io.github.dev-weiqi.sniffer:ktor-ws` | Ktor WebSocket frame inspection and reply mocks |

Each artifact has a `-noop` twin with the same API.

## Local Development

From this repository:

```bash
npm run setup
npm start

cd client
./gradlew :sample:installDebug
./gradlew :sample-cmp:installDebug
```

Useful checks:

```bash
cd server/daemon && npm run typecheck
cd server/ui && npm run build
cd client && ./gradlew :core:jvmTest :okhttp:test :sample:compileDebugKotlin
```

More detail: [docs/GUIDE.md](docs/GUIDE.md) and [PROTOCOL.md](PROTOCOL.md).
