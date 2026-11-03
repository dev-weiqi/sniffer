[English](README.md) | 繁體中文

# 原生 iOS 整合

Swift 套件提供兩個產品：

| 產品 | 整合對象 |
| --- | --- |
| `SnifferKit` | Apple `Foundation.URLSession` HTTP 與 `URLSessionWebSocketTask` |
| `SnifferSocketIO` | `Socket.IO Client Swift` 流量 |

在 Xcode 選擇 **File > Add Package Dependencies**，輸入 `https://github.com/dev-weiqi/sniffer.git`，並選擇 `ios` 分支。HTTP 請連結 `SnifferKit`；App 使用 Socket.IO 時，另連結 `SnifferSocketIO`。使用本機原始碼時，選擇 **File > Add Local Package**，並選取包含 `Package.swift` 的儲存庫根目錄。

0.7.2 版本快照的 Git 標籤為 `ios/0.7.2`。既有 SPM 整合仍追蹤 `ios` 分支。在 Xcode 更新套件版本，即可取得 HTTP Query／Body 條件與 Socket 負載比對功能。

## 僅限 Debug 建置

`SnifferKit` 與 `SnifferSocketIO` 僅限 Debug 連結，AdHoc／Release 必須排除。Swift 套件沒有 noop 版本；只加 `#if DEBUG` 或選擇 Do Not Embed 都不會取消連結。

用 `#if DEBUG` 包住 Sniffer 的 import 與整合程式碼，並確認 `DEBUG` 只在 Debug 組態啟用。若專案使用 `DEVELOPMENT`，請套用相同限制。非 Debug 保留原本的網路實作，共用介面不要依賴 Sniffer 型別。下方 Socket.IO 與 WebSocket 範例僅供 Debug 使用。

### Xcode 設定

以下為 `SnifferKit.o` 的實測設定。套件仍會在各組態建置，只有 Debug 連入 App。

1. 從 App target 的 Build Phases > Link Binary With Libraries 移除 `SnifferKit`。
2. 在專案檔新增 `PBXTargetDependency`，以 `productRef` 指向 SnifferKit 套件產品，並加入 App target 的 `dependencies`。確認 Target Dependencies 有 SnifferKit。只移除 Frameworks 項目或修改 `packageProductDependencies`，仍可能自動連結。
3. 僅在 Debug 的 Other Linker Flags 加入 `"$(BUILT_PRODUCTS_DIR)/SnifferKit.o"`，保留既有旗標與 `$(inherited)`。AdHoc／Release 不得繼承此路徑。

不要從 General > Frameworks 把 SnifferKit 加回去，否則 AdHoc／Release 會再次連入，且建置不會報錯。首次套用與更新 SDK 後，請 clean 一次，避免物件檔更新未觸發重新連結。

### 驗證

在 Debug 確認 API／Socket 流量正常，再分別封存 AdHoc／Release。對 App 主執行檔執行以下指令，確認 `nm` 無錯誤且結果為 `0`：

```bash
nm -U /path/to/App.app/App | grep -c '10SnifferKit'
```

若符號已被 strip，請另查連結輸入或 Link Map。以上實測僅涵蓋 SnifferKit，`SnifferSocketIO` 與其相依項目需另行驗證。

## 啟動 SDK

建立 HTTP 或 socket 用戶端之前，啟動一次：

```swift
#if DEBUG
import SnifferKit
#endif

#if DEBUG
Sniffer.start(appID: Bundle.main.bundleIdentifier ?? "com.example.app")
#endif
```

模擬器預設連到 `127.0.0.1:9091`。實機請以 `SNIFFER_BIND=0.0.0.0` 啟動背景服務，並在 Xcode scheme 將 `SNIFFER_HOST` 設為 Mac 的區域網路 IP。`SNIFFER_PORT` 可覆寫預設連接埠 `9091`。

## 使用 URLSession 傳送 HTTP

HTTP 使用 Apple Foundation，不依賴第三方網路函式庫。建立 session 前，先將 App 的 `URLSessionConfiguration` 傳入 `Sniffer.configure`：

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

將這個 session 注入既有網路層。請求建構、解碼、驗證與呼叫處都不需變更。設定後的 session 支援流量檢視、HTTP 回應模擬、僅延遲規則、佔位符與回應中斷點。

## Socket.IO

套件整合 `Socket.IO Client Swift`。包裝既有的 `SocketIOClient`，再透過包裝器註冊監聽器及送出事件：

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

使用 socket 期間，必須讓 `SocketManager` 持續存活。Socket.IO 檢視、ack 模擬、事件回覆模擬、標籤與背景服務推送事件，都透過 `SnifferSocket` 運作。

新增程式碼時，也可以讓 SDK 建立並持有 manager：

```swift
let socket = SnifferSocketIO.socket(url: socketURL, config: socketConfig)
socket.connect()
```

## 原生 WebSocket

以 `URLSessionWebSocketTask` 為基礎的程式碼，請改為建立 `SnifferWebSocket`：

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

宿主關閉連線時，呼叫 `socket.cancel()`。原生 WebSocket 檢視、回覆模擬與背景服務推送事件，都使用目前的背景服務協定。

## 失敗時的行為

Sniffer 在失敗時會放行流量。遇到不支援的流量、格式錯誤的背景服務訊息、SDK 失敗或背景服務斷線時，會清除啟用中的規則，並繼續執行宿主原本的行為。只有明確命中的模擬、延遲或已啟用中斷點，才會刻意改變流量。
