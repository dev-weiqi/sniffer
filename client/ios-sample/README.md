# iOS sample

This sample uses the Popup iOS networking shape and the local `SnifferKit` Swift package against the existing Sniffer daemon.

```sh
cd server/daemon
npm start
```

Open `SnifferIOSSample.xcodeproj`, select an iOS simulator, and run. The app calls `http://127.0.0.1:9091/test/users/42` on launch through `TargetAPI` and `APINetworkingManager`. The request appears in the Sniffer HTTP traffic view.

For a physical device, set the `SNIFFER_HOST` scheme environment variable to the Mac's LAN IP.
