English | [繁體中文](README.zh-TW.md)

# iOS sample

This sample uses native iOS networking and the local `SnifferKit` Swift package against the existing Sniffer daemon.

See [`../ios/README.md`](../ios/README.md) for the native iOS integration steps used by a real app.

```sh
cd server/daemon
npm start
```

Open `SnifferIOSSample.xcodeproj`, select an iOS simulator, and run. The Control deck matches the Android samples: compact four-column action groups, an independently scrolling action area, a fixed Activity log, and system light/dark colors. Requests run only when you press an action, so opening the sample does not consume sequence steps. HTTP includes GET, POST, errors, images, external API, and SSE streaming through URLSession.AsyncBytes. Socket.IO and native WebSocket provide connect, send, ACK, and disconnect controls; Socket.IO also provides Req/Res. The Clear button clears only the sample log.

For a physical device, set the `SNIFFER_HOST` scheme environment variable to the Mac's LAN IP.
