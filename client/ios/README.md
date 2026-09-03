# SnifferKit

`SnifferKit` captures and mocks `URLSession` HTTP and native WebSocket traffic against the existing Sniffer daemon. `SnifferSocketIO` adds Socket.IO monitoring, ack mocks, and pushed events using the same Socket.IO 16.0.1 dependency as Popup-iOS.

Add this repository as a Swift Package and link the `SnifferKit` product. Start the client before creating the app's `URLSession`:

```swift
import SnifferKit

Sniffer.start(appID: Bundle.main.bundleIdentifier!)
let configuration = Sniffer.configure(.POPO)
let apiEngine = APINetworkingManager(configuration: configuration)
```

The Popup networking interface stays unchanged. Only its `URLSessionConfiguration` is passed through `Sniffer.configure`.

Use the wrappers for socket traffic:

```swift
import SnifferKit
import SnifferSocketIO

let webSocket = SnifferWebSocket(url: URL(string: "ws://localhost:9091/test/ws")!)
webSocket.resume()

let socketIO = SnifferSocketIO.socket(url: URL(string: "http://localhost:9091")!)
socketIO.connect()
```

HTTP response mocks, delay-only rules, response breakpoints, placeholders, WebSocket replies, Socket.IO acks, and pushed events use the current daemon protocol. If the daemon disconnects or a rule cannot be applied safely, rules are cleared or the original owner request continues unchanged.

The simulator connects to `127.0.0.1:9091` by default. On a physical device, set `SNIFFER_HOST` to the Mac's LAN IP. `SNIFFER_PORT` overrides port `9091`.
