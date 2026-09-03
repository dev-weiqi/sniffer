# SnifferKit

`SnifferKit` captures HTTP traffic from a configured `URLSession` and reports it to the existing Sniffer daemon.

Add this repository as a Swift Package and link the `SnifferKit` product. Start the client before creating the app's `URLSession`:

```swift
import SnifferKit

Sniffer.start(appID: Bundle.main.bundleIdentifier!)
let configuration = Sniffer.configure(.POPO)
let apiEngine = APINetworkingManager(configuration: configuration)
```

The Popup networking interface stays unchanged. Only its `URLSessionConfiguration` is passed through `Sniffer.configure`.

The simulator connects to `127.0.0.1:9091` by default. On a physical device, set `SNIFFER_HOST` to the Mac's LAN IP. `SNIFFER_PORT` overrides port `9091`.

