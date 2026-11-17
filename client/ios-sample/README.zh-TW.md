[English](README.md) | 繁體中文

# iOS 範例

此範例使用原生 iOS 網路功能與本機 `SnifferKit` Swift 套件，連接既有的 Sniffer 背景服務。

實際 App 的原生 iOS 整合步驟，請參閱[原生 iOS 整合指南](../ios/README.zh-TW.md)。

```sh
cd server/daemon
npm start
```

開啟 `SnifferIOSSample.xcodeproj`，選擇 iOS 模擬器並執行。Control deck 與 Android samples 採用相同的四欄操作、獨立捲動操作區、固定底部 Activity 紀錄及系統淺色／深色模式。只在點擊操作時送出請求，開啟 App 不會消耗序列步驟。HTTP 提供 GET、POST、錯誤、圖片、外部 API 與 URLSession.AsyncBytes SSE 串流。Socket.IO 與原生 WebSocket 提供連線、傳送、ACK、斷線；Socket.IO 另有 Req/Res。Clear 只清除 sample 紀錄。

使用實機時，請在 scheme 的環境變數中，將 `SNIFFER_HOST` 設為 Mac 的區域網路 IP。
