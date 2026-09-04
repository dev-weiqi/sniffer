# iOS sample

This sample uses native iOS networking and the local `SnifferKit` Swift package against the existing Sniffer daemon.

See [`../ios/README.md`](../ios/README.md) for the native iOS integration steps used by a real app.

```sh
cd server/daemon
npm start
```

Open `SnifferIOSSample.xcodeproj`, select an iOS simulator, and run. The app automatically exercises HTTP, native WebSocket, and Socket.IO through the local SDK. The buttons run each transport again so mock, delay, breakpoint, ack, reply, and push rules can be checked from Sniffer.

For a physical device, set the `SNIFFER_HOST` scheme environment variable to the Mac's LAN IP.
