[English](README.md) | 繁體中文

# iOS 範例

此範例使用原生 iOS 網路功能與本機 `SnifferKit` Swift 套件，連接既有的 Sniffer 背景服務。

實際 App 的原生 iOS 整合步驟，請參閱[原生 iOS 整合指南](../ios/README.zh-TW.md)。

```sh
cd server/daemon
npm start
```

開啟 `SnifferIOSSample.xcodeproj`，選擇 iOS 模擬器並執行。App 會自動透過本機 SDK 執行 HTTP、原生 WebSocket 與 Socket.IO。各按鈕可再次執行對應傳輸，方便在 Sniffer 中檢查模擬、延遲、中斷點、ack、回覆與推送規則。

使用實機時，請在 scheme 的環境變數中，將 `SNIFFER_HOST` 設為 Mac 的區域網路 IP。
