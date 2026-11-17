[English](README.md) | 繁體中文

# iOS 範例

用這個範例測試原生 HTTP、Socket.IO 與 WebSocket 的流量擷取和 Mock。它使用儲存庫內的 Swift 套件。

先從儲存庫根目錄啟動已建置的背景服務：

```sh
npm --prefix server/daemon start
```

開啟 `client/ios-sample/SnifferIOSSample.xcodeproj`，選擇 iOS 模擬器並執行。點擊操作才會送出請求，開啟 App 不會消耗 Mock 序列步驟。

Control deck 沿用 Android 範例的四欄操作、獨立捲動操作區、固定底部 Activity 紀錄及系統淺色／深色模式。Clear 只清除範例的紀錄。

| 群組 | 操作 |
| --- | --- |
| HTTP | GET、POST、錯誤、圖片、外部 API，以及透過 `URLSession.AsyncBytes` 讀取 SSE |
| Socket.IO | Connect、Send、ACK、Req/Res、Disconnect |
| 原生 WebSocket | Connect、Send、ACK、Disconnect |

使用實機時，以 `SNIFFER_BIND=0.0.0.0` 啟動背景服務，並在 scheme 將 `SNIFFER_HOST` 設為 Mac 的區域網路 IP。

整合到自己的 App 時，請依[原生 iOS 整合指南](../ios/README.zh-TW.md)設定 Debug 專用連結。
