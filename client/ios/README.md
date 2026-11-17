English | [繁體中文](README.zh-TW.md)

# Native iOS integration

The Swift package exposes two products:

| Product | Integration |
| --- | --- |
| `SnifferKit` | Apple `Foundation.URLSession` HTTP and `URLSessionWebSocketTask` |
| `SnifferSocketIO` | `Socket.IO Client Swift` traffic |

In Xcode, select **File > Add Package Dependencies**, enter `https://github.com/dev-weiqi/sniffer.git`, and select the `ios` branch. Link `SnifferKit` for HTTP. Also link `SnifferSocketIO` when the app uses Socket.IO. For a local checkout, select **File > Add Local Package** and choose the repository root containing `Package.swift`.

The 0.7.2 snapshot is marked by the Git tag `ios/0.7.2`. Existing SPM integrations continue to track the `ios` branch. Update package versions in Xcode to receive HTTP query/body conditions and Socket payload matching.

## Debug builds only

Link `SnifferKit` and `SnifferSocketIO` only in Debug; exclude them from AdHoc and Release. The Swift package has no noop variant. Neither `#if DEBUG` nor Do Not Embed removes package linkage.

Guard Sniffer imports and integration code with `#if DEBUG`, and enable `DEBUG` only in the Debug configuration. Apply the same restriction if your project uses `DEVELOPMENT`. Keep the original networking implementation outside Debug and Sniffer types out of shared interfaces. The Socket.IO and WebSocket examples below are for Debug only.

### Xcode configuration

This setup was tested with `SnifferKit.o`. The package builds in every configuration, but only Debug links it into the app.

1. Remove `SnifferKit` from the app target's Build Phases > Link Binary With Libraries.
2. Add a `PBXTargetDependency` in the project file with `productRef` pointing to the SnifferKit package product, and include it in the app target's `dependencies`. Confirm SnifferKit appears in Target Dependencies. Removing only the Frameworks entry or changing `packageProductDependencies` can still allow automatic linking.
3. Add `"$(BUILT_PRODUCTS_DIR)/SnifferKit.o"` to Other Linker Flags for Debug only, preserving existing flags and `$(inherited)`. AdHoc and Release must not inherit this path.

Do not add SnifferKit back through General > Frameworks: AdHoc and Release will link it again without a build error. Clean after applying this setup and after SDK updates, since object file changes may not trigger relinking.

### Verification

Verify API and socket traffic in Debug, then archive AdHoc and Release separately. Run this command on the app executable and confirm that `nm` reports no errors and the count is `0`:

```bash
nm -U /path/to/App.app/App | grep -c '10SnifferKit'
```

If symbols have been stripped, also check the linker inputs or Link Map. This test covered SnifferKit only; verify `SnifferSocketIO` and its dependencies separately.

## Start the SDK

Start once before creating HTTP or socket clients:

```swift
#if DEBUG
import SnifferKit
#endif

#if DEBUG
Sniffer.start(appID: Bundle.main.bundleIdentifier ?? "com.example.app")
#endif
```

The simulator connects to `127.0.0.1:9091` by default. On a physical device, start the daemon with `SNIFFER_BIND=0.0.0.0` and set `SNIFFER_HOST` in the Xcode scheme to the Mac's LAN IP. `SNIFFER_PORT` overrides port `9091`.

## HTTP with URLSession

HTTP uses Apple Foundation without a third-party networking dependency. Pass the app's `URLSessionConfiguration` through `Sniffer.configure` before creating the session:

```swift
import Foundation
#if DEBUG
import SnifferKit
#endif

let configuration = URLSessionConfiguration.default
#if DEBUG
Sniffer.configure(configuration)
#endif
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

## Verification workflows on the iOS branch

Use server 0.9.0 and this branch's native SDK for parameterized scenarios, isolated
verification runs, synchronization acknowledgment, exact HTTP/Socket hit reporting,
`wait_for_hits`, and `export_run_summary`. The historical `ios/0.7.2` tag does not
include these additions. Feature negotiation uses `mock-observability`,
`http-sequences`, and `http-sse-mocks`; do not infer support from the version string.

HTTP sequences reserve a step atomically per matching request. Repeat-last, loop,
and stop behavior match the Kotlin SDK. Stop fails locally without sending the
request to the backend. Identical rule resends and temporary daemon disconnects
preserve the position; changing the sequence/reset token, deleting the rule, or
restarting the app resets it. Background requests can also consume steps.

Timed SSE mocks emit UTF-8 frames through URLProtocol, with per-event delay, optional
event/id/retry fields and placeholder expansion for data. They support normal close,
open until the caller cancels or times out, and disconnect errors. Content-Length
and Transfer-Encoding are removed. Each request starts its own stream; cancelled
loads stop scheduled delivery. Streaming mock telemetry omits the response body.
A rule hit confirms selection, not completion or UI correctness.

Unmatched HTTP traffic keeps the existing forwarding path. Socket wrappers keep
existing reply/ACK behavior and additionally report the matched rule ID. No new
HTTP endpoint or iOS-only MCP tool is required. See [MCP workflows](../../server/daemon/MCP.md).
