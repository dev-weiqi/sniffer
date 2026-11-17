English | [繁體中文](README.zh-TW.md)

# iOS sample

Use this sample to test traffic capture and mocks for native HTTP, Socket.IO, and WebSocket. It uses the Swift package in this repository.

From the repository root, start the built daemon:

```sh
npm --prefix server/daemon start
```

Open `client/ios-sample/SnifferIOSSample.xcodeproj`, select an iOS simulator, and run. Press an action to send a request. Opening the app does not consume mock sequence steps.

The Control deck uses the Android samples' four-column controls, a separately scrolling action area, a fixed Activity log, and system light/dark colors. Clear removes only the sample log.

| Group | Actions |
| --- | --- |
| HTTP | GET, POST, errors, images, external API, and SSE through `URLSession.AsyncBytes` |
| Socket.IO | Connect, Send, ACK, Req/Res, Disconnect |
| Native WebSocket | Connect, Send, ACK, Disconnect |

For a physical device, start the daemon with `SNIFFER_BIND=0.0.0.0` and set the scheme's `SNIFFER_HOST` variable to the Mac's LAN IP.

To integrate your own app, follow the [native iOS guide](../ios/README.md), including its Debug-only linking configuration.
