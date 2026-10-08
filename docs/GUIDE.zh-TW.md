[English](GUIDE.md) | 繁體中文

# Sniffer

可自行架設的 Flipper 替代工具，用來監控與模擬 App 的 HTTP 與 Socket 流量。

```
┌─────────────────────┐         ws://host:9091/device        ┌──────────────────────┐
│  App (Android/iOS)  │ ───────────────────────────────────► │  daemon (your Mac)   │
│  KMP SDK plugins    │ ◄────── mock rules / push events ─── │  Node/TS, port 9091  │
└─────────────────────┘                                      └─────────┬────────────┘
                                                                       │ ws /ui + REST
                                                             ┌─────────▼────────────┐
                                                             │  Web UI (browser)    │
                                                             └──────────────────────┘
```

| 目錄        | 內容                                                           |
| --------- | ------------------------------------------------------------ |
| `client/` | Kotlin Multiplatform SDK（採外掛架構）與範例                           |
| `server/` | Node／TS 背景服務（裝置連線、記憶體流量紀錄、自動 `adb reverse`、測試端點）與 React 網頁介面 |

## 環境需求

* Node.js 20 以上、JDK 17 以上。
* Android：`adb` 必須位於 PATH 中。
* iOS：使用 ktor 的 KMP 共用模組；執行範例需要 Xcode。

## 快速開始

```bash
npm run setup                 # first time: install deps and build the UI
npm start                     # start the daemon
open http://localhost:9091
```

啟動偵錯版 App 後就會連線。若要試用範例：

```bash
# Android, full demo (okhttp / ktor / socket.io / ktor-ws)
cd client && ./gradlew :sample:installDebug

# Compose Multiplatform sample (ktor only), Android
cd client && ./gradlew :sample-cmp:installDebug

# Compose Multiplatform sample, iOS simulator (no Xcode project needed)
cd client/sample-cmp/ios && ./build-sim.sh
xcrun simctl boot "iPhone 17" && xcrun simctl install booted build/SnifferCmpSample.app
xcrun simctl launch booted dev.weiqi.sniffer.samplecmp.ios   # runs the whole demo
```

## 整合 SDK

相依套件、Android 明文傳輸設定、`Sniffer.start` 與用戶端外掛的說明請參閱 [README](../README.zh-TW.md#加入-sdk)。以下補充其他細節：

* SDK 每 3 秒重新連線一次，背景服務未執行時會靜默重試，離線時最多暫存 1000 筆訊息。
* iOS 實機可直接透過 USB 連到背景服務，不需設定；也可用 `Sniffer.start(appId = ..., host = "<Mac LAN IP>")` 透過 Wi-Fi 連線。
* 可在執行時覆寫設定，不必重新建置。優先順序為覆寫值 ＞ `start()` 參數 ＞ 預設值。

```bash
# Android: debug.* properties are settable without root; restart the app afterwards
adb shell setprop debug.sniffer.port 9092
adb shell setprop debug.sniffer.host 192.168.1.20

# iOS: SNIFFER_HOST / SNIFFER_PORT in the Xcode scheme's environment variables
# JVM: -Dsniffer.port=9092 or SNIFFER_PORT=9092
# daemon: PORT=9092 npm start
```

## 使用網頁介面

頂部工具列包含連線狀態圓點、裝置選擇器、全域搜尋（URL、方法、狀態、事件、負載）、淺色／深色切換，以及清除按鈕。

### API 分頁

* 即時表格顯示時間（點擊欄位標題可反轉排序）、方法、狀態、URL、大小與耗時。`okhttp`／`ktor` 標章表示使用的函式庫；紫色 **MOCK** 標章表示模擬資料。
* 每列詳情包含 URL、查詢參數、標頭與內容。JSON 會格式化顯示，可收合與複製。
* **Copy cURL** 可重現請求。
* **Mock this request** 會以請求方法、路徑與實際回應內容預填規則。

### Socket 分頁

* 標籤顯示每個 socket（socket.io／ktor-ws）及其狀態。
* 事件串流中，↑ 代表用戶端送出，↓ 代表伺服器傳入。點擊一列可查看負載與 ack。
* 送出事件可使用 **Mock this event's ack**，傳入事件可使用 **Prefill push form**。
* **Push Server → Client event** 會像伺服器送出事件一樣觸發 App 監聽器，可傳送至指定連線或裝置的所有連線（ktor-ws 會收到文字訊框）。

### Mocks 分頁

規則按裝置儲存在背景服務，立即推送並在裝置上執行，因此離線時仍可運作。

* **HTTP rules**：比對方法（ANY 表示任意方法）與完整請求路徑，使用指定的狀態、標頭及內容回應，可選擇加入延遲。命中的請求不會送到網路。
* 內容與 socket 負載會在每次命中時展開 `${randomId}`、`${now}`（ISO-8601 UTC）及 `${randomString(min~max)}`。
* **Socket rules**：*sio ack* 比對送出的事件名稱，攔下事件，並在本機以指定負載呼叫 ack（JSON 陣列代表多個參數）。*ws reply* 以子字串比對送出的 ktor-ws 文字訊框，捨棄該訊框，再將指定回覆注入為傳入訊框。兩者都可設定延遲。
* 核取方塊可停用規則而不刪除。按下 **Save** 套用。

## 測試端點（背景服務提供，供範例使用）

| 端點                       | 行為                                                 |
| ------------------------ | -------------------------------------------------- |
| `ANY /test/echo`         | 回傳收到的方法、標頭與內容                                      |
| `GET /test/users/:id`    | 模擬使用者 JSON                                         |
| `GET /test/slow?ms=1500` | 延遲後回應                                              |
| `GET /test/error`        | 回應 500                                             |
| `GET /test/sse`          | Server-Sent Events：每隔 400 毫秒送出一次，共 5 次             |
| `ws /test/ws`            | 回傳收到的文字訊框                                          |
| socket.io `chat:send`    | 以 `{ok,echo,ts}` 確認並廣播 `chat:new`；`echo` 會以收到的輸入確認 |

## 疑難排解

* **找不到裝置**：確認背景服務正在執行，且 `adb devices` 有列出裝置（背景服務每 5 秒執行一次 `adb reverse tcp:9091 tcp:9091`）。Android 須確認允許明文傳輸；Wi-Fi 連線須檢查 `host`、網路與連接埠 9091 的防火牆設定。
* **介面只顯示純文字**：執行 `cd server/ui && npm run build`，再重新整理。
* **缺少 HTTPS 內容**：攔截發生在 TLS 之前，不需要憑證。可能是用戶端實例未安裝外掛。
* **SSE／串流**：101 協定升級回應會原樣通過。`text/event-stream` 內容會隨 App 讀取而擷取，但 ktor 的 `client.sse { }` 呼叫只記錄狀態與標頭。
* **重新啟動後紀錄消失**：流量只儲存在記憶體（最多 2000 筆訊息），模擬規則則保存在 `~/.sniffer/mocks.json`。
* **內容遭截斷**：超過 1 MB 的內容會被截斷並標記；二進位內容只記錄大小。

## 開發

```bash
cd server/daemon && npm run typecheck    # daemon type check
cd server/ui && npm run dev              # UI dev mode (proxies to 9091)
cd client && ./gradlew build             # all SDK modules and tests, incl. iOS
cd client && ./gradlew :ktor-ws:wsDebug  # ktor-ws smoke test (needs a running daemon)
```

傳輸協定：[PROTOCOL.zh-TW.md](../PROTOCOL.zh-TW.md)。
