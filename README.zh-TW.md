[English](README.md) | 繁體中文

<h1 align="center">Sniffer</h1>

<p align="center">
  <a href="https://github.com/dev-weiqi/sniffer/tags"><img src="https://img.shields.io/github/v/tag/dev-weiqi/sniffer?label=version" alt="最新版本"></a>
  <a href="https://www.npmjs.com/package/@dev-weiqi/sniffer"><img src="https://img.shields.io/npm/v/%40dev-weiqi%2Fsniffer?label=npm" alt="npm"></a>
  <a href="https://central.sonatype.com/namespace/io.github.dev-weiqi.sniffer"><img src="https://img.shields.io/maven-central/v/io.github.dev-weiqi.sniffer/core?label=maven" alt="Maven Central"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="授權條款"></a>
</p>


Sniffer 是 Kotlin Multiplatform SDK 與本機監控工具，用來在開發期間檢視與模擬行動應用程式的網路流量。支援 **OkHttp**、**Ktor Client**、**Socket.IO** 與 **Ktor WebSocket**。

![Sniffer API 流量面板](docs/assets/sniffer-api-preview.png)

[Flipper](https://github.com/facebook/flipper) 封存後，我們的開發環境又遇上 [Android 16 KB 記憶體分頁大小遷移](https://developer.android.com/guide/practices/page-sizes)。Sniffer 延續了 Flipper 的工作流程：連接偵錯版 App、即時查看流量，並從桌面介面調整行為。

## 安裝監控工具

背景服務（daemon）在開發電腦上執行，提供瀏覽器介面、儲存模擬規則，並為 Android 裝置維持 `adb reverse` 連線。

需要 [Node.js](https://nodejs.org) 20 以上版本。使用 Android 時，`adb` 也必須位於 PATH 中。

```bash
npm install -g @dev-weiqi/sniffer
sniffer start
```

介面會在 [http://localhost:9091](http://localhost:9091) 開啟。也可以不安裝，直接執行：

```bash
npx @dev-weiqi/sniffer start
```

如果連接埠 9091 已被占用，Sniffer 會提供釋放連接埠的選項，也可以指定其他連接埠：

```bash
PORT=9092 sniffer start
```

背景服務預設綁定 `127.0.0.1`。Android（透過 `adb reverse`）、iOS 模擬器與透過 USB 連接的 iPhone 都經由 `localhost` 存取。只有使用 Wi-Fi 的裝置需要開放對外連線，並在 App 中設定 `host`（請參閱[啟動 Sniffer](#啟動-sniffer)）：

```bash
SNIFFER_BIND=0.0.0.0 sniffer start
```

更新版本，或安裝指定版本：

```bash
npm install -g @dev-weiqi/sniffer@latest
npm install -g @dev-weiqi/sniffer@0.7.3
```

## 桌面應用程式

macOS 版本將背景服務與介面整合在同一個視窗。使用前請先安裝 [Node.js](https://nodejs.org) 20 以上版本。從 [Releases](https://github.com/dev-weiqi/sniffer/releases) 下載 `.dmg`，Apple Silicon 使用 `Sniffer-server-mac-aarch64.dmg`，Intel 使用 `Sniffer-server-mac-x64.dmg`，再將 `Sniffer.app` 拖入 `/Applications`。連接埠可在 App 設定中調整。

dmg 尚未完成 Apple 公證。如果 macOS 顯示「Sniffer 已損毀」，執行一次以下指令以清除隔離標記：

```bash
xattr -d com.apple.quarantine /Applications/Sniffer.app
```

## 加入 SDK

加入 `core`，以及所使用的用戶端對應模組。正式發行版本請使用對應的 `-noop` 模組，API 相同，但實作不執行任何操作。

| 用戶端 | Sniffer 套件 |
| --- | --- |
| OkHttp | `io.github.dev-weiqi.sniffer:okhttp` |
| Ktor Client | `io.github.dev-weiqi.sniffer:ktor` |
| Socket.IO | `io.github.dev-weiqi.sniffer:socketio` |
| Ktor WebSocket | `io.github.dev-weiqi.sniffer:ktor-ws` |

```kotlin
val snifferVersion = "0.7.2"

dependencies {
    debugImplementation("io.github.dev-weiqi.sniffer:core:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:core-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:okhttp:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:okhttp-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:ktor:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:ktor-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:socketio:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:socketio-noop:$snifferVersion")

    debugImplementation("io.github.dev-weiqi.sniffer:ktor-ws:$snifferVersion")
    releaseImplementation("io.github.dev-weiqi.sniffer:ktor-ws-noop:$snifferVersion")
}
```

KMP 共用程式碼請將模組加入 `commonMain`：

```kotlin
commonMain.dependencies {
    implementation("io.github.dev-weiqi.sniffer:core:$snifferVersion")
    implementation("io.github.dev-weiqi.sniffer:ktor:$snifferVersion")
    implementation("io.github.dev-weiqi.sniffer:ktor-ws:$snifferVersion")
}
```

### 連線至背景服務

SDK 自行管理連到 `localhost:9091` 的一般 WebSocket 連線，使用與 USB 傳輸相同的 socket 與 WebSocket 基礎實作。App 不需要為 Sniffer 額外加入 Ktor 用戶端引擎，Sniffer 也不會註冊可能改變 App 自身 `HttpClient()` 引擎選擇的引擎。Android App 需要一般的 `android.permission.INTERNET` 權限。

## 啟動 Sniffer

App 啟動時啟動一次 SDK。SDK 會自行重新連線，背景服務未執行時也不會向 App 拋出例外。

```kotlin
import dev.weiqi.sniffer.core.Sniffer

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Sniffer.start(appId = packageName)
    }
}
```

除了 Wi-Fi，其他連線方式都可以使用預設的 `Sniffer.start(appId)`：

| App 執行環境 | 連線方式 | 設定 |
| --- | --- | --- |
| Android 裝置／模擬器 | 透過 `adb reverse` 連到 `localhost:9091` | 無（adb 必須位於 PATH 中） |
| iOS 模擬器 | `localhost:9091`（共用 Mac 的回送介面） | 無 |
| 透過 USB 連接的 iPhone | 背景服務透過 usbmuxd 連入 App | 無 |
| 透過 Wi-Fi 連接的任何裝置 | App 連到 Mac 的區域網路 IP | `SNIFFER_BIND=0.0.0.0` ＋ `host` |

**iPhone USB 連線。** SDK 在裝置的 `127.0.0.1:9092` 監聽，背景服務透過 macOS 內建的 usbmuxd 連入。手機必須與這台 Mac 配對，且 App 必須位於前景；約 5 秒內就會出現。如果 9092 已被占用，請在兩端設定 `SNIFFER_USB_PORT`。只有 Sniffer 流量會走 USB，因此 App 自身請求中的 `localhost` 仍指向手機。

使用 Wi-Fi 時，傳入 Mac 的區域網路位址：

```kotlin
Sniffer.start(appId = "com.example.app", host = "192.168.1.20")
```

也可以在執行時覆寫，不必重新建置：

```bash
adb shell setprop debug.sniffer.port 9092
adb shell setprop debug.sniffer.host 192.168.1.20
```

## 接入用戶端

OkHttp：

```kotlin
import dev.weiqi.sniffer.okhttp.SnifferOkHttp

val okHttp = OkHttpClient.Builder()
    .addInterceptor(SnifferOkHttp.interceptor())
    .build()
```

Ktor 用戶端：

```kotlin
import dev.weiqi.sniffer.ktor.SnifferKtor

val ktor = HttpClient(CIO) {
    install(Auth) { /* ... */ }
    install(SnifferKtor) // install last, see below
}
```

> **請在所有會處理回應的外掛（例如 `Auth`、重試外掛）之後安裝 `SnifferKtor`。**
> 命中模擬規則時會直接中斷傳送鏈，因此安裝在 Sniffer 之後的外掛看不到該回應。將 Sniffer 裝在最後，模擬的 401 回應仍可觸發 `Auth` 的權杖更新。

Socket.IO：

```kotlin
import dev.weiqi.sniffer.socketio.SnifferSocketIO

val raw = IO.socket("https://api.example.com")
val socket = SnifferSocketIO.wrap(raw, "https://api.example.com")

socket.connect()
socket.emit("cart:update", mapOf("sku" to "pro"))
```

如果 App 將所有訊息共用同一個事件傳送，可在 `on` 傳入 `label`。它回傳的簡短標籤會在介面中顯示為 `event(tag)`；監聽器、實際傳輸與模擬比對仍使用原始事件名稱。不需要標籤時回傳 null：

```kotlin
socket.on("message", label = { args ->
    args.optJSONObject(0)?.optString("type")?.takeIf { it.isNotEmpty() }
}) { args ->
    // normal listener
}
// server sends: message {"type":"chat",...} → listed as message(chat)
```

Ktor WebSocket：安裝一次外掛後，一般的 `webSocket` 呼叫就會受到監控：

```kotlin
import dev.weiqi.sniffer.ktorws.SnifferKtorWs

val ktor = HttpClient(CIO) {
    install(SnifferKtorWs)
    install(WebSockets)
}

val session = ktor.webSocketSession("wss://api.example.com/realtime")
session.send("ping")
```

## Firebase 面板（Beta）

在 Settings 啟用 **Firebase · Beta**，即可檢視 Analytics 事件與參數。可搜尋或依事件名稱、使用者 ID 篩選；**Include API** 會顯示相鄰的請求。只擷取透過包裝器呼叫的事件，不包含 Firebase 自動事件。

偵錯版加入 `firebase`，正式版加入 `firebase-noop`，Sniffer 版本須與 `core` 相同。保留既有的 Firebase Analytics 相依套件與 BoM。初始化 Firebase 後，在 App 的事件封裝層中包裝實例：

```kotlin
import com.google.firebase.Firebase
import com.google.firebase.analytics.analytics
import dev.weiqi.sniffer.firebase.SnifferFirebaseAnalytics

val analytics = SnifferFirebaseAnalytics.wrap(Firebase.analytics)
analytics.setUserId("user-7") // Pass null to clear the user ID.
analytics.logEvent("select_item") {
    param("item_id", "42")
}
```

Firebase 呼叫仍照常執行，正式版包裝器只停用本機擷取。擷取紀錄不代表雲端已收到，請使用 Firebase DebugView 確認。KMP 或本機測試可使用 `SnifferAnalytics` 傳入參數 Map；未提供 Firebase 回呼的事件會顯示為 **Local capture**。

## 使用介面

開啟 `http://localhost:9091`，啟動偵錯版 App，並選擇裝置。

* **API**：即時請求與回應、標頭、JSON、圖片、動態 WebP、複製 cURL，以及模擬紀錄。
* **Socket**：Socket.IO 與 WebSocket 連線、事件、負載、ack，以及伺服器推送至用戶端的訊息。
* **Firebase · Beta**（在 Settings 中啟用）：Analytics 事件與就地展開的參數。
* **Mocks**：各裝置的 HTTP 回應規則、僅延遲規則、Socket.IO ack 規則、WebSocket 回覆規則與推送事件。

規則在所選裝置的 SDK 內執行。HTTP 模擬在發出網路請求前回應，socket ack 規則則在本機回應。模擬內容支援 `${randomId}`、`${now}` 與 `${randomString(min~max)}`。

HTTP 規則可同時使用 **Query parameters** 與 JSON **Body conditions**，所有指定條件都必須符合，其他物件欄位則忽略。**Mock this request** 預設為 **Path only**，可從選單加入已擷取的查詢參數、完整 JSON 物件內容，或兩者。**Mock this ack** 預設為 **Event only**，可從選單加入第一個送出參數中的 JSON 物件欄位。回應資料與這些條件分開設定。裝置 SDK 必須支援所選條件，舊版 SDK 請先更新。

HTTP 與 Socket 編輯器預設收合 **Request conditions**。建立模擬時若帶入擷取條件，會自動展開並選取對應分頁；同時包含 Query 與 Body 時選取 Body。每個裝置的規則都會在此瀏覽器記住展開狀態及 Query／Body 分頁，關閉面板或重新載入後也會保留。延遲設定仍放在回應旁邊。**Break on path** 只比對 HTTP 方法與路徑，忽略 Query 與 Body 條件。

## 模組

| 套件 | 用途 |
| --- | --- |
| `io.github.dev-weiqi.sniffer:core` | SDK 連線、裝置識別、模擬規則同步 |
| `io.github.dev-weiqi.sniffer:okhttp` | OkHttp 檢視與 HTTP 模擬 |
| `io.github.dev-weiqi.sniffer:ktor` | Android、iOS 與 JVM 的 Ktor 用戶端檢視 |
| `io.github.dev-weiqi.sniffer:socketio` | Socket.IO 檢視、ack 模擬、推送事件 |
| `io.github.dev-weiqi.sniffer:ktor-ws` | Ktor WebSocket 檢視與回覆模擬 |
| `io.github.dev-weiqi.sniffer:firebase` | Firebase Analytics 事件與使用者 ID 追蹤 |

每個套件都有 API 相同的 `-noop` 對應版本。

## 本機開發

```bash
npm run setup
npm start

cd client
./gradlew :sample:installDebug
./gradlew :sample-cmp:installDebug
```

從儲存庫根目錄執行用戶端與伺服器單元測試：

```bash
npm test
```

從儲存庫根目錄執行建置檢查：

```bash
npm --prefix server/daemon run typecheck
npm --prefix server/ui run build
(cd client && ./gradlew :sample:compileDebugKotlin :sample-cmp:compileDebugKotlinAndroid)
```

更多說明：[使用指南](docs/GUIDE.zh-TW.md)與[傳輸協定](PROTOCOL.zh-TW.md)。
