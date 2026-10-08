[English](PROTOCOL.md) | 繁體中文

# Sniffer 傳輸協定 v1

每則訊息都是 WebSocket 文字訊框，承載含有 `type` 欄位的 JSON 物件，不另加外層封裝。
背景服務使用單一連接埠（預設 **9091**）提供所有功能：

| 路徑 | 用途 |
| --- | --- |
| `/device` | SDK（裝置端）連線入口 |
| `/ui` | 網頁介面連線入口（唯讀串流） |
| `/api/*` | 介面操作的 REST API（模擬規則、推送事件、清除） |
| `/test/*` | 範例 App 使用的 HTTP 測試端點 |
| `/test/ws` | 一般 WebSocket 回音測試端點 |
| `/socket.io` | socket.io 測試伺服器 |
| `/` | 介面靜態檔案 |

**USB（iOS 實機）。** usbmuxd 只能連入裝置的連接埠，因此角色對調：SDK 在 `127.0.0.1:9092` 監聽（兩端皆使用 `SNIFFER_USB_PORT`），背景服務主動連入並執行 WebSocket 用戶端交握（`GET /device`）。之後使用相同協定。SDK 一次只服務一個工作階段；已有向外連線的 `/device` 工作階段時，USB 連入會被關閉，背景服務會在下一次 5 秒輪詢時重試。

時間戳記以 Unix epoch 起算的毫秒表示。內容為字串，二進位內容為 `null`。超過 **1 MB** 的內容會被截斷，並標記 `bodyTruncated: true`。

## 裝置 → 背景服務

```jsonc
// 連線後的第一則訊息
{ "type": "hello", "deviceId": "279f756", "deviceName": "sdk_gphone64_arm64",
  "platform": "android", "appId": "dev.weiqi.sniffer.sample", "sdkVersion": "0.1.0",
  "capabilities": ["http", "socketio", "ktor-ws"] }

// HTTP：請求與回應分開傳送，以 id 關聯
{ "type": "http-request", "id": "<uuid>", "method": "GET", "url": "https://host/path?q=1",
  "headers": { "Accept": "application/json" }, "body": null, "bodySize": 0,
  "bodyTruncated": false, "library": "okhttp", "timestamp": 0, "userId": "user-7" }
// userId 是擷取請求當下的 Analytics 身分，最多 1024 個字元。
// 空字串表示尚未設定使用者 ID；缺少欄位或 null 表示舊版 SDK 未擷取身分。
// 即使請求途中 setUserId 有變更，回應仍保留請求原本的身分。

{ "type": "http-response", "id": "<uuid>", "status": 200, "headers": {},
  "body": "{...}", "bodySize": 18879, "bodyTruncated": false,
  "durationMs": 115, "mocked": false, "error": null, "timestamp": 0,
  "delayedMs": 0 }        // 選填：僅延遲規則加入的延遲時間，真實請求仍會執行
// 傳輸失敗時：status=0，error=<錯誤訊息>

// 明確呼叫 logEvent 時產生的本機 Analytics 紀錄，參數為不可變快照。
{ "type": "firebase-analytics-event", "id": "<uuid>", "name": "select_content",
  "params": { "item_id": "42", "quantity": 2, "value": 9.99 },
  "timestamp": 0, "userId": "user-7", "truncated": false, "firebaseSdkCalled": true }
// firebaseSdkCalled 表示原始 SDK 呼叫正常返回，絕不代表雲端已確認收到。
// 參數保留字串、數字、布林值、null、Map，以及清單／陣列。
// 限制：name 4096 個字元，userId 1024 個字元；參數擷取預算為 65536 個字元／節點，
// 深度 8，每個物件 64 個鍵，每個陣列 200 個項目。超過限制時設定 truncated。
// 事件使用一般的記憶體離線佇列，不代表已上傳至 Firebase。

// socket 連線生命週期
{ "type": "socket-status", "connectionId": "<uuid>", "transport": "socketio",
  "url": "http://host", "status": "connected", "timestamp": 0 }
// transport："socketio" | "ktor-ws"；status："connected" | "disconnected"

// socket 事件；direction："out" = 用戶端送出，"in" = 伺服器傳至用戶端
// ktor-ws 訊框固定使用事件名稱 "message"
// label（選填）：App 提供的簡短顯示標籤，由 SDK socket.on 的 label 函式產生。
// 介面顯示為 event(label)。"event" 仍是實際傳輸名稱；模擬比對與注入一律使用 "event"。
{ "type": "socket-event", "id": "<uuid>", "connectionId": "<uuid>",
  "transport": "socketio", "direction": "out", "event": "chat:send",
  "payload": "[\"hello\"]", "mocked": false, "timestamp": 0, "label": null }

// 先前送出事件的 ack，使用相同 id
{ "type": "socket-ack", "id": "<emit uuid>", "payload": "[...]",
  "mocked": false, "timestamp": 0 }

// 回應命中已啟用的中斷點並暫停：宿主呼叫會阻塞，直到背景服務送出對應的
// breakpoint-resolve。method／url 識別呼叫；status／headers／body 是暫停中、可編輯的回應。
// 只有非串流的文字回應可以暫停。
{ "type": "breakpoint-hit", "id": "<uuid>", "ruleId": "b1", "phase": "response",
  "method": "GET", "url": "https://host/path", "status": 200, "headers": {}, "body": "...",
  "library": "okhttp", "timestamp": 0 }
```

## 背景服務 → 裝置

```jsonc
// 完整取代此裝置的模擬規則，於連線時及此裝置的規則每次變更時傳送
{ "type": "mock-rules",
  "http": [ { "id": "r1", "enabled": true, "method": "GET",
              "urlPattern": "/api/characters/3",
              "status": 200, "headers": {}, "body": "{...}", "delayMs": 0 } ],
  "socket": [ { "id": "s1", "enabled": true, "transport": "socketio", "event": "chat:send",
                "ackPayload": "[{\"ok\":true}]", "delayMs": 0 } ] }
// http 規則：method 為 null 表示任意方法；urlPattern 必須與請求路徑完全相符，
//   比對前移除 scheme、host、query 與 fragment。空字串模式不會命中任何請求。
// 選填 queryParams：{ "page": "2" } 要求每個指定的解碼後鍵值都符合。
//   忽略請求中的其他參數。鍵與值是區分大小寫的字串；百分比編碼會解碼，+ 代表空白。
//   重複鍵只要任一值符合規則即命中。空字串可比對 ?key 或 ?key=，但不符合缺少的鍵。
//   非空 queryParams 或 bodyMatch 的規則優先於僅比對路徑的備援規則，不受清單位置影響；
//   各組內以第一個命中的規則為準。未命中時使用真實網路請求。
//   SDK 在 hello.capabilities 宣告 "http-query-mocks"。背景服務不會將條件規則傳給舊版 SDK，
//   避免舊版忽略 queryParams 而命中所有分頁。
// 選填 bodyMatch：包含 JSON 物件的字串，例如 "{\"limit\":20}"。
//   Query 與 Body 的所有條件都必須符合。物件採遞迴子集比對；陣列須完全相符，
//   包括陣列中物件的欄位。JSON 型別必須符合，缺少欄位不等於 null。
//   bodyMatch 缺少、為 null、空白或 {} 時，不限制 Body。無效條件不會命中。
//   只比對擷取限制內完整且可安全讀取的 JSON 請求內容；缺少、遭截斷、二進位或
//   無法重播的內容，都無法符合非空的 Body 條件。
//   SDK 宣告 "http-body-mocks"。背景服務不會將 Body 條件規則傳給舊版 SDK；
//   同時使用 queryParams 與 bodyMatch 的規則需要兩種能力。無效草稿保留於儲存與匯出，
//   但不會同步。未命中任何規則時，原始請求照常執行。
// body 與 ackPayload 支援佔位符，由裝置在命中規則時展開：
//   ${randomId}、${now}（ISO-8601 UTC）、${randomString(min~max)}
//   min／max 是使用者提供的整數，字串長度會在 [min, max] 範圍內隨機決定。
// socket 規則，transport 為 "socketio"：命中的送出事件不會傳送，改在本機回傳模擬 ack
//   （參數的 JSON 陣列）。非空白的 [pushEvent] 會切換至事件回覆模式：經過 [delayMs] 後，
//   SDK 將 [pushEvent] 與 [pushPayload]（參數的 JSON 陣列，佔位符已展開）作為伺服器傳入事件
//   注入 App 監聽器，不傳送模擬 ack（忽略 [ackPayload]）。適用於以獨立事件回覆、
//   而非使用 ack 的請求／回應 API。transport 為 "ktor-ws"：[event] 以子字串比對送出的
//   文字訊框，命中的訊框不會傳送，改將 [ackPayload] 注入為模擬傳入訊框。
//   忽略 [pushEvent]／[pushPayload]，因為回覆訊框本身就是注入內容。
// socket 規則可選填 payloadMatch：包含 JSON 物件的字串，例如 "{\"page\":2}"。
//   Socket.IO 比對第一個送出參數，忽略 ack 回呼與其他參數。
//   WebSocket 除了既有的 event 子字串比對，也會比對送出的 JSON 文字訊框。
//   所有指定欄位都必須符合；巢狀物件也採子集比對，忽略額外物件欄位。
//   陣列須完全相符，包括陣列中物件的欄位。保留 JSON 型別，2 與 "2"、true 不同；
//   數字則以數值比較，2 等於 2.0。缺少欄位不等於 null。
//   payloadMatch 缺少、為 null、空白或 {} 時，視為備援規則。
//   條件規則優先於備援規則，各組內以第一個命中的規則為準。
//   無效條件或根節點不是物件時不會命中；無效或非物件的負載只能使用備援規則。
//   SDK 宣告 "socket-payload-mocks"。背景服務不會將條件規則傳給舊版 SDK，
//   也不會將無效條件傳給任何 SDK。草稿保留於儲存與匯出，供使用者修正。
// 背景服務傳給裝置前會移除介面專用欄位 "starred"：此規則由相同 appId 的所有裝置共用，
//   背景服務按 appId 儲存，並在合併時排在裝置自己的規則之前。
//   "name"／"createdAt" 則原樣傳送，SDK 會忽略。

// 從介面注入伺服器傳至用戶端的事件；connectionId 為 null 表示廣播至所有連線
{ "type": "push-event", "connectionId": null, "event": "chat:new",
  "payload": "{\"msg\":\"hi\"}" }

// 完整取代此裝置已啟用的中斷點規則，方式與 mock-rules 相同
{ "type": "breakpoint-rules",
  "rules": [ { "id": "b1", "enabled": true, "method": "GET",
               "urlPattern": "/api/orders", "phase": "response" } ] }
// 比對語意與模擬規則相同：method 為 null 表示任意方法，urlPattern 必須與路徑完全相符。
//   SDK 會在 App 讀取之前暫停命中的回應，並阻塞至收到下方的 resolve。
//   核心規則 3：只有連線中才會暫停；若與背景服務的連線中斷，SDK 會釋放所有暫停的呼叫，
//   等同於不修改內容直接繼續。

// 釋放暫停的回應。action 為 "resume" 時，先套用所有非 null 的回應修改，再交給 App；
//   "abort" 則讓宿主呼叫失敗。
{ "type": "breakpoint-resolve", "id": "<hit uuid>", "action": "resume",
  "status": 200, "headers": {}, "body": "..." }
```

## 背景服務 ↔ 介面

WebSocket `/ui` 在連線時傳送快照，之後持續傳送即時串流：

```jsonc
{ "type": "init", "devices": [ { "...": "hello fields", "connected": true } ],
  "entries": [ { "deviceId": "...", "message": { "...": "any device message" } } ],
  "mocks": { "http": [], "socket": [] },
  "breakpointsByDevice": { "<deviceId>": [ { "...": "breakpoint rule" } ] },
  "pausedHits": [ { "deviceId": "...", "hit": { "...": "breakpoint-hit message" } } ] }

{ "type": "event", "deviceId": "...", "message": {} }
{ "type": "device-status", "deviceId": "...", "connected": false }
{ "type": "mocks-changed", "deviceId": "...", "mocks": { "http": [], "socket": [] } }
{ "type": "entries-cleared" }
{ "type": "firebase-entries-cleared" } // 僅清除 Firebase，涵蓋所有裝置
{ "type": "breakpoints-changed", "deviceId": "...", "rules": [ { "...": "breakpoint rule" } ] }
{ "type": "breakpoint-hit", "deviceId": "...", "hit": { "...": "breakpoint-hit message" } }
{ "type": "breakpoint-resolved", "deviceId": "...", "id": "<hit uuid>" }   // 使用者繼續或中止
{ "type": "breakpoints-released", "deviceId": "..." }   // 裝置已斷線，SDK 自動繼續暫停的呼叫
```

REST（介面 → 背景服務）：

```
PUT    /api/mocks              body: { "deviceId": "...", "http": [...], "socket": [...] }   完整取代單一裝置的規則；
                               "starred": true 的規則按 appId 儲存，並傳送至該 App 的所有裝置，
                               包含之後才連線的裝置
POST   /api/push-event         body: { "deviceId": "...", "connectionId": null, "event": "...", "payload": "..." }
PUT    /api/breakpoints         body: { "deviceId": "...", "rules": [...] }   完整取代裝置已啟用的規則
POST   /api/breakpoints/resolve body: { "deviceId": "...", "id": "<hit uuid>", "action": "resume"|"abort",
                                         "status"?, "headers"?, "body"? }
DELETE /api/entries            清除已記錄的流量
DELETE /api/entries/firebase   清除所有裝置的 Firebase 紀錄，並防止清除前的 Analytics 事件重送還原
GET    /api/state              偵錯快照：裝置、紀錄筆數、模擬規則
```
