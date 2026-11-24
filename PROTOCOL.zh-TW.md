[English](PROTOCOL.md) | 繁體中文

# Sniffer 傳輸協定 v1

每則訊息都是 WebSocket 文字訊框，承載含有 `type` 欄位的 JSON 物件，不另加外層封裝。
背景服務預設在連接埠 9091 提供以下入口：

| 路徑 | 用途 |
| --- | --- |
| `/device` | SDK（裝置端）連線入口 |
| `/ui` | 網頁介面連線入口（唯讀串流） |
| `/api/*` | 介面操作的 REST API（模擬規則、推送事件、清除） |
| `/test/*` | 範例 App 使用的 HTTP 測試端點 |
| `/test/ws` | 一般 WebSocket 回音測試端點 |
| `/socket.io` | socket.io 測試伺服器 |
| `/` | 介面靜態檔案 |

**USB（iOS 實機）。** usbmuxd 只能連入裝置的連接埠，因此角色對調：SDK 在 `127.0.0.1:9092` 監聽（兩端皆使用 `SNIFFER_USB_PORT`），背景服務主動連入並執行 WebSocket 用戶端交握（`GET /device`）。之後使用相同協定。SDK 一次只服務一個工作階段，已有向外連線的 `/device` 工作階段時，USB 連入會被關閉，背景服務會在下一次 5 秒輪詢時重試。

時間戳記以 Unix epoch 起算的毫秒表示。內容為字串，二進位內容為 `null`。超過 **1 MB** 的內容會被截斷，並標記 `bodyTruncated: true`。

## 裝置 → 背景服務

```jsonc
// first message after connecting
{ "type": "hello", "deviceId": "279f756", "deviceName": "sdk_gphone64_arm64",
  "platform": "android", "appId": "dev.weiqi.sniffer.sample", "sdkVersion": "0.1.0",
  "capabilities": ["http", "socketio", "ktor-ws"] }

// HTTP: request and response are sent separately, correlated by id
{ "type": "http-request", "id": "<uuid>", "method": "GET", "url": "https://host/path?q=1",
  "headers": { "Accept": "application/json" }, "body": null, "bodySize": 0,
  "bodyTruncated": false, "library": "okhttp", "timestamp": 0, "userId": "user-7" }
// userId is optional legacy metadata; current SDKs do not capture it.

{ "type": "http-response", "id": "<uuid>", "status": 200, "headers": {},
  "body": "{...}", "bodySize": 18879, "bodyTruncated": false,
  "durationMs": 115, "mocked": false, "error": null, "timestamp": 0,
  "delayedMs": 0 }        // optional: latency injected by a delay-only rule (real request still ran)
// on transport failure: status=0, error=<message>

// socket connection lifecycle
{ "type": "socket-status", "connectionId": "<uuid>", "transport": "socketio",
  "url": "http://host", "status": "connected", "timestamp": 0 }
// transport: "socketio" | "ktor-ws"; status: "connected" | "disconnected"

// socket events; direction: "out" = client emit, "in" = server→client
// ktor-ws frames use the fixed event name "message"
// label (optional): short app-provided display tag (SDK label labeler on socket.on); the UI
// renders event(label). "event" stays the real wire name; mock matching and injection always use "event"
{ "type": "socket-event", "id": "<uuid>", "connectionId": "<uuid>",
  "transport": "socketio", "direction": "out", "event": "chat:send",
  "payload": "[\"hello\"]", "mocked": false, "timestamp": 0, "label": null }

// ack for a previous emit (same id)
{ "type": "socket-ack", "id": "<emit uuid>", "payload": "[...]",
  "mocked": false, "timestamp": 0 }

// a response matched an armed breakpoint and is paused: the host call blocks until the daemon
// sends a matching breakpoint-resolve. method/url identify the call; status/headers/body are
// the held (editable) response. Only non-streaming textual responses can be paused.
{ "type": "breakpoint-hit", "id": "<uuid>", "ruleId": "b1", "phase": "response",
  "method": "GET", "url": "https://host/path", "status": 200, "headers": {}, "body": "...",
  "library": "okhttp", "timestamp": 0 }
```

## 背景服務 → 裝置

```jsonc
// full replacement of this device's mock rules (sent on connect and on every change for this device)
{ "type": "mock-rules",
  "http": [ { "id": "r1", "enabled": true, "method": "GET",
              "urlPattern": "/api/characters/3",
              "status": 200, "headers": {}, "body": "{...}", "delayMs": 0 } ],
  "socket": [ { "id": "s1", "enabled": true, "transport": "socketio", "event": "chat:send",
                "ackPayload": "[{\"ok\":true}]", "delayMs": 0 } ] }
// HTTP rule: method null = any. Match the raw request path
//   (scheme, host, query and fragment stripped). Empty pattern matches nothing.
// A whole {name} segment matches one nonempty encoded path segment (name: [A-Za-z_][A-Za-z0-9_]*).
// All other segments are literal. Templates require http-path-templates.
// Optional requestHeaders: {"Accept-Language":"zh-TW"}. All specified names must be present
// at interception time (case-insensitive names, exact values, any repeated value). An empty
// map adds no condition. Nonempty maps require http-header-mocks. All required capabilities
// must be present or the daemon omits the entire rule. Response headers are separate.
// Optional queryParams: { "page": "2" } requires every specified decoded key/value to match.
//   Extra request parameters are ignored. Keys and values are case-sensitive strings; percent
//   escapes are decoded and + means space. A repeated key matches if any value equals the rule.
//   An empty string matches ?key or ?key=, but not a missing key.
//   Matching rules with nonempty queryParams, requestHeaders or bodyMatch win before path-only fallback rules, regardless of
//   list position; the first matching rule wins within each group. No match means real traffic.
//   SDKs advertise "http-query-mocks" in hello.capabilities. The daemon omits conditional rules
//   for older SDKs, which would otherwise ignore queryParams and match every page.
// Optional bodyMatch: a string containing a JSON object, e.g. "{\"limit\":20}".
//   All query and body conditions must match. Objects use recursive subset matching; arrays
//   match exactly, including object fields inside arrays. JSON types matter; missing != null.
//   Absent/null/blank bodyMatch or {} imposes no body constraint. Invalid conditions never match.
//   Only complete, safely readable JSON request bodies within the capture limit are matched;
//   missing, truncated, binary, or non-replayable bodies cannot satisfy a nonempty body condition.
//   SDKs advertise "http-body-mocks". The daemon omits body-conditioned rules for older SDKs;
//   a rule using both queryParams and bodyMatch requires both capabilities. Invalid drafts stay
//   in storage/export but are never synced. No matching rule means the original request proceeds.
// body and ackPayload support placeholders expanded on the device at match time:
//   ${randomId}, ${now} (ISO-8601 UTC), ${randomString(min~max)}
//   min/max are user-provided whole numbers; the string length is random within [min, max]
// socket rule, transport "socketio": matched emits are not sent; a fake ack (JSON array of args)
//   is returned locally. A non-blank [pushEvent] switches the rule to the event-reply mode: after
//   [delayMs] the SDK injects [pushEvent] with [pushPayload] (JSON array of args, placeholders
//   expanded) as a server→client event into the app's listeners and sends no fake ack
//   ([ackPayload] is ignored), for request/response APIs that answer with a separate event
//   instead of an ack. transport "ktor-ws": [event] is a substring matched against outgoing
//   text frames; matched frames are not sent and [ackPayload] is injected as a fake incoming
//   frame ([pushEvent]/[pushPayload] are ignored; the reply frame already is the injection)
// socket rule optional payloadMatch: a string containing a JSON object, e.g. "{\"page\":2}".
//   Socket.IO compares the first emitted argument (ack callbacks and other arguments are ignored).
//   WebSocket compares the outgoing JSON text frame, in addition to the existing event substring.
//   All specified fields must match; nested objects also use subset matching. Extra object fields
//   are ignored. Arrays match exactly, including object fields inside arrays. Values retain their
//   JSON types (2 differs from "2" and true); numbers compare numerically (2 equals 2.0).
//   Missing fields differ from null. Absent/null/blank payloadMatch or {} is a fallback.
//   Conditional matches precede fallbacks; the first matching rule wins within each group.
//   Invalid conditions/non-object roots never match. Invalid/non-object payloads can only use fallbacks.
//   SDKs advertise "socket-payload-mocks". The daemon omits conditional rules for older SDKs and
//   invalid conditions for all SDKs. Drafts remain in storage/export so users can correct them.
// UI-only rule fields the daemon strips before sending to the device: "starred" (rule is shared
//   with every device of the same appId, stored per appId on the daemon and merged in ahead of
//   the device's own rules), plus "name" / "createdAt" pass through untouched (SDK ignores them)

// inject a server→client event from the UI; connectionId null = broadcast to all connections
{ "type": "push-event", "connectionId": null, "event": "chat:new",
  "payload": "{\"msg\":\"hi\"}" }

// full replacement of this device's armed breakpoint rules (like mock-rules)
{ "type": "breakpoint-rules",
  "rules": [ { "id": "b1", "enabled": true, "method": "GET",
               "urlPattern": "/api/orders", "phase": "response" } ] }
// Breakpoints use an exact path. A null method matches any method.
//   The SDK pauses a matching response (before the app reads it) and blocks until the resolve
//   below. Golden rule 3: a pause only happens while connected, and the SDK releases every paused
//   call (as if resumed unchanged) if the daemon connection drops.

// releases a paused response. action "resume" applies any non-null edit to the response then
//   hands it to the app; "abort" fails the host call.
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
{ "type": "breakpoints-changed", "deviceId": "...", "rules": [ { "...": "breakpoint rule" } ] }
{ "type": "breakpoint-hit", "deviceId": "...", "hit": { "...": "breakpoint-hit message" } }
{ "type": "breakpoint-resolved", "deviceId": "...", "id": "<hit uuid>" }   // user resumed/aborted
{ "type": "breakpoints-released", "deviceId": "..." }   // device disconnected: SDK auto-resumed its paused calls
```

REST（介面／MCP → 背景服務）：

```
PUT    /api/mocks              body: { "deviceId": "...", "http": [...], "socket": [...] }
                               完整取代單一裝置的規則，starred 規則按 appId 分享給同 App 的裝置
POST   /api/push-event         body: { "deviceId": "...", "connectionId": null, "event": "...", "payload": "..." }
PUT    /api/breakpoints        body: { "deviceId": "...", "rules": [...] }，完整取代裝置的斷點規則
POST   /api/breakpoints/resolve body: { "deviceId": "...", "id": "<hit uuid>", "action": "resume"|"abort",
                                         "status"?, "headers"?, "body"? }
DELETE /api/entries            清除所有流量，並原樣放行暫停中的回應
DELETE /api/entries/http       清除 HTTP 紀錄，並原樣放行暫停中的回應
DELETE /api/entries/socket     清除 Socket 事件與 ack
GET    /api/entries            唯讀快照：{ "entries": [{ "deviceId": "...", "message": {...} }] }
                               選填篩選：deviceId、appId、id、type=http|socket、
                               method、status、urlContains、bodyContains、userId、event、connectionId、limit
                               HTTP 的 method／status／URL／userId 篩選會在同一裝置內關聯請求與回應，
                               Socket 的事件／連線篩選會關聯事件與 ack。
                               bodyContains 搜尋各則訊息的 body／payload／params，event 比對 Socket
                               事件名稱。limit 取篩選後最後 N 則訊息。
                               預設遮罩 headers、body、payload、params、URL 中的已知敏感資料，
                               redact=0 明確要求原始資料。/ui WebSocket 不遮罩。
GET    /api/state              devices、entryCount、mocksByDevice、breakpointsByDevice、pausedHits
                               pausedHits 為 [{ "deviceId": "...", "hit": {...} }]，格式與 /ui init 相同。
                               redact=1 遮罩狀態中的已知敏感資料，MCP 使用此選項，預設仍為原始資料。
DELETE /api/devices/offline    移除離線裝置紀錄及其專屬模擬規則
DELETE /api/devices/<deviceId> 移除裝置，在線上時也中斷連線
```

## MCP

`sniffer mcp` 透過 stdio 提供上述 REST 功能，不新增裝置訊息，也不需要為 MCP 修改 SDK。工具涵蓋流量、HTTP 與 Socket 模擬、事件注入及回應斷點。

設定與完整參數見 [MCP 說明](server/daemon/MCP.zh-TW.md)。MCP 不會要求未遮罩的流量，狀態查詢使用 `redact=1`。自訂敏感欄位必須設在背景服務，不是 MCP 程序。遮罩只能處理已知格式，無法保證移除所有機密或圖片內容。

## Mock 同步證據

宣告 `mock-observability` 的 SDK 接受 `mock-rules` 的選填 revision。安裝整組規則後送出 `{"type":"mock-rules-applied","revision":"..."}`，選中規則時送出 `{"type":"mock-hit","ruleId":"...","revision":"...","timestamp":0}`。

命中只表示選中規則，不代表回覆成功完成或 UI 驗證通過。這些是控制訊息，不加入流量表。

背景服務只接受目前 WebSocket 連線與同步 revision 的回報。重連或再次同步會使舊確認失效。命中紀錄最多保留 1000 筆，重啟後清空。舊 SDK 回報為不支援。

### HTTP 依次回覆

`HttpMockRule.sequence` 為選填物件，包含 `steps`、`onExhausted` 與 `resetToken`。每步可設定 `status`、`headers`、`body`、`delayMs`，預設為 200、空標頭、空內容與 0。步驟數為 1 至 100，延遲為 0 至 300000 毫秒，不可搭配 `delayOnly`。

僅向宣告 `http-sequences` 的裝置下發。命中時先原子保留一步，再執行延遲，未命中不消耗。`last` 重複最後一步，`loop` 從頭開始，`stop` 讓後續命中失敗，絕不送出真實請求。

一般同步與重新連線保留程序內進度。修改序列或 `resetToken`、刪除規則、重啟 App 會重設。並行請求以命中順序分配，不以完成順序分配。

`mock-hit.stepIndex` 是從 0 起算的保留步驟，不代表完成。`GET /api/mock-progress?deviceId=...&ruleId=...` 回傳支援狀態、連線、同步狀態及近期命中。

### 定時 SSE 模擬回覆

`HttpMockRule.sse` 為選填物件，例如 `{events:[{data:"first",event:"message",id:"1",retry:1000,delayMs:0},{data:"done",delayMs:1000}],ending:"close"}`。
需要 `http-sse-mocks` 能力、status 200，且不可搭配 sequence 或 delayOnly。不支援的裝置不會收到整條規則。events 為 1 至 1000 筆，data 預設空字串，delayMs 預設 0，其餘事件欄位選填。每筆 data 最多 524288 字元，event 與 id 最多 1024 字元且不得含 CR、LF、NUL。delayMs 與 retry 為 0 至 300000 的整數。

每個命中請求從第一筆開始，擁有獨立串流。規則 delayMs 延遲標頭，事件 delayMs 是前一筆送出後的最短等待，第一筆從回傳標頭起算。讀取速度與排程可能延長間隔。data 換行轉為多個 data 欄位，空行結束事件。retry 是用戶端重連提示，不是事件延遲。placeholder 在送出事件時展開。

close 正常結束，open 在最後一筆後等候呼叫端取消或逾時，disconnect 在送出最後一筆後讓讀取失敗，尚未讀取的緩衝資料可能遺失。SDK 強制使用 text/event-stream UTF-8，移除 Content-Length 與 Transfer-Encoding。紀錄僅包含回應標頭與 null body，命中不代表事件已被全部讀取。呼叫端取消會關閉模擬串流，原有重試與重連策略仍適用，也可能開啟另一條全新串流。

Ktor 沿用 SSEClientContent 的既有 SSE adapter，原始讀取則使用 ByteReadChannel，未知 adapter 不轉換。OkHttp 使用可取消且遵守讀取逾時的串流來源。真實串流維持原有行為。
