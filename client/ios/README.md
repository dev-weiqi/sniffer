# Native iOS integration

The Swift package exposes two products:

| Product | Integration |
| --- | --- |
| `SnifferKit` | Apple `Foundation.URLSession` HTTP and `URLSessionWebSocketTask` |
| `SnifferSocketIO` | `Socket.IO Client Swift` traffic |

In Xcode, select **File > Add Package Dependencies**, enter `https://github.com/dev-weiqi/sniffer.git`, and select the `ios` branch. Link `SnifferKit` for HTTP. Also link `SnifferSocketIO` when the app uses Socket.IO. For a local checkout, select **File > Add Local Package** and choose the repository root containing `Package.swift`.

## Start the SDK

Start once before creating HTTP or socket clients:

```swift
import SnifferKit

Sniffer.start(appID: Bundle.main.bundleIdentifier ?? "com.example.app")
```

The simulator connects to `127.0.0.1:9091` by default. On a physical device, start the daemon with `SNIFFER_BIND=0.0.0.0` and set `SNIFFER_HOST` in the Xcode scheme to the Mac's LAN IP. `SNIFFER_PORT` overrides port `9091`.

## HTTP with URLSession

HTTP uses Apple Foundation without a third-party networking dependency. Pass the app's `URLSessionConfiguration` through `Sniffer.configure` before creating the session:

```swift
import SnifferKit

let configuration = Sniffer.configure(.default)
let session = URLSession(configuration: configuration)
```

Inject this session into the existing network layer. Request construction, decoding, authentication, and call sites stay unchanged. The configured session supports traffic inspection, HTTP response mocks, delay-only rules, placeholders, and response breakpoints.

## Socket.IO

The package integrates `Socket.IO Client Swift`. Wrap the existing `SocketIOClient`, then use the wrapper for listeners and emits:

```swift
import SocketIO
import SnifferSocketIO

let manager = SocketManager(socketURL: socketURL, config: socketConfig)
let rawSocket = manager.socket(forNamespace: namespace)
let socket = SnifferSocketIO.wrap(rawSocket, url: socketURL.absoluteString)

socket.on("chat:new") { values, ack in
    // Existing handler
}

socket.connect()
socket.emitWithAck("chat:send", "hello").timingOut(after: 5) { values in
    // Existing ack handler
}
```

Keep the `SocketManager` alive for as long as the socket is used. Socket.IO inspection, ack mocks, event-reply mocks, labels, and daemon push events run through `SnifferSocket`.

For new code, the SDK can create and retain the manager:

```swift
let socket = SnifferSocketIO.socket(url: socketURL, config: socketConfig)
socket.connect()
```

## Native WebSocket

For code based on `URLSessionWebSocketTask`, create `SnifferWebSocket` instead:

```swift
import SnifferKit

let socket = SnifferWebSocket(url: webSocketURL)
socket.resume()

Task {
    try await socket.send(.string("hello"))
    let message = try await socket.receive()
    print(message)
}
```

Call `socket.cancel()` when the owner closes the connection. Native WebSocket inspection, reply mocks, and daemon push events use the current daemon protocol.

## Failure behavior

Sniffer is fail-open. Unsupported traffic, malformed daemon messages, SDK failures, and daemon disconnects clear active rules and continue the owner's original behavior. Only an explicitly matched mock, delay, or armed breakpoint intentionally changes traffic.
