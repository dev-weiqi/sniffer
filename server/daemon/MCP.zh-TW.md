[English](MCP.md) | 繁體中文

# Sniffer MCP

stdio MCP 伺服器讓 AI 工具讀取 HTTP、Socket 與 Firebase Analytics 紀錄、編輯模擬規則、注入事件，以及操作回應斷點。它透過 REST 連接正在執行的背景服務。MCP 本身不需要更新 App SDK；較新的模擬條件仍需要 SDK 支援對應能力。

## 從目前的原始碼執行

先建置背景服務與介面，再啟動背景服務：

```bash
npm --prefix server/daemon install
npm --prefix server/ui install
npm --prefix server/ui run build
npm --prefix server/daemon run build
node server/daemon/bin/sniffer.js start
```

保持背景服務執行，並讓 MCP 用戶端啟動另一個程序：

```json
{
  "mcpServers": {
    "sniffer": {
      "command": "node",
      "args": ["/absolute/path/to/sniffer/server/daemon/bin/sniffer.js", "mcp"],
      "env": {
        "SNIFFER_PORT": "9091",
        "SNIFFER_APP_ID": "com.example.app"
      }
    }
  }
}
```

替換絕對路徑與 App ID。`env` 可省略。以上 JSON 適用於使用 `mcpServers` 的用戶端；其他用戶端可在 MCP 設定中填入相同的執行檔、參數與環境變數。已安裝且包含此功能的套件可改用 `"command": "sniffer", "args": ["mcp"]`，或 `"command": "npx", "args": ["-y", "@dev-weiqi/sniffer", "mcp"]`。

既有已發布版本不一定包含 MCP。`sniffer mcp` 不會啟動背景服務，stdout 僅供 MCP 訊息使用。

也可以連接桌面 App 正在執行的背景服務，將 `SNIFFER_PORT` 設成桌面 App 的連接埠即可。背景服務預設為 9091；9092 也是 iOS USB 監聽端的預設連接埠，在同一主機同時使用時請選擇其他空閒連接埠。

## 環境變數

| 變數 | 設定程序 | 預設值 | 用途 |
| --- | --- | --- | --- |
| `SNIFFER_HOST` | MCP | `127.0.0.1` | 背景服務所在主機。 |
| `SNIFFER_PORT` | MCP | `PORT`，未設定則為 `9091` | 要連接的背景服務連接埠。 |
| `SNIFFER_APP_ID` | MCP | 未設定 | 優先選擇此 App 的已連線裝置；多裝置流量查詢也限於此 App。明確指定 `deviceId` 時以它為準。 |
| `PORT` | 背景服務 | `9091` | 監聽連接埠。 |
| `SNIFFER_BIND` | 背景服務 | `127.0.0.1` | 監聽介面。只有需要區域網路存取時才使用 `0.0.0.0`。 |
| `SNIFFER_REDACT_HEADERS` | 背景服務 | 內建名稱 | 額外要遮罩的標頭名稱，以逗號分隔。 |
| `SNIFFER_REDACT_BODY_FIELDS` | 背景服務 | 內建名稱 | 額外要遮罩的欄位名稱，以逗號分隔，也套用到 Socket payload 與 Analytics params。 |

遮罩變數要設在背景服務，例如：

```bash
SNIFFER_REDACT_BODY_FIELDS=sessionKey,otp SNIFFER_REDACT_HEADERS=X-My-Token node server/daemon/bin/sniffer.js start
```

未指定 `deviceId` 時，工具會選擇唯一已連線裝置，並依 App ID 縮小範圍。無法確定單一裝置時，流量查詢涵蓋符合範圍的裝置；寫入操作必須明確指定 `deviceId`。`get_state` 一律列出背景服務中的所有裝置、模擬規則及斷點。`clear_traffic` 一律影響所有裝置，不受 App ID 限制。

## 工具

| 工具 | 用途 | 參數 |
| --- | --- | --- |
| `get_state` | 裝置、紀錄筆數、模擬規則、已啟用斷點與暫停中的回應。 | 無 |
| `list_traffic` | 讀取紀錄，遮罩已知敏感資料。 | `deviceId?`、`type?`（`http`、`socket`、`firebase`）、`method?`、`status?`、`urlContains?`、`bodyContains?`、`userId?`、`event?`、`connectionId?`、`limit?` |
| `get_entry` | 讀取同一 ID 的所有訊息，包括請求／回應、事件／ack 或 Analytics 事件。 | `id`、`deviceId?` |
| `create_mock` | 建立 HTTP 規則（預設）或 Socket 規則，回傳 `{deviceId, created: {id}}`。 | `deviceId?`、`type?`（`http`、`socket`），以及下方欄位 |
| `update_mock` | 修改規則，保留未指定欄位，回傳 `{deviceId, updated: {id}}`。 | `id`、`deviceId?`，以及下方欄位 |
| `delete_mock` | 依 ID 刪除規則。 | `id`、`deviceId?` |
| `push_event` | 向 App 注入收到的 Socket 事件。省略 `connectionId` 或設為 null，會廣播至該裝置的連線。 | `event`、`payload`、`deviceId?`、`connectionId?` |
| `clear_traffic` | 清除所有裝置的紀錄；清除 HTTP 或全部時，也會原樣放行暫停中的回應。 | `type?`（`http`、`socket`、`firebase`），省略表示全部 |
| `set_breakpoints` | 完整取代單一裝置的回應斷點規則，空陣列表示全部停用。 | `rules`、`deviceId?` |
| `resolve_breakpoint` | 放行並選擇性修改回應，或中止暫停中的請求。 | `id`、`action`（`resume`、`abort`）、`deviceId?`、`status?`、`headers?`、`body?` |

HTTP 請求與回應是共用 ID 的兩則訊息。method、status、URL 與 user ID 篩選會在同一裝置內關聯兩者。`limit` 取最後 N 則訊息，不是 N 組完整流程；完整內容請用 `get_entry`。

`bodyContains` 搜尋各則訊息的 body、Socket payload 或 Analytics params。`event` 精確比對 Socket 事件名稱或 Analytics 名稱；`userId` 精確比對擷取當下的身分，空字串表示明確未設定。

回傳資料保留圖片的 `bodyBase64`、截斷、延遲、錯誤欄位、Socket label，以及 Analytics 的 `firebaseSdkCalled`。本機擷取不代表 Firebase 雲端已收到事件。大型圖片內容可能超過 MCP 用戶端的訊息大小限制。

### 模擬規則欄位

共用欄位為 `enabled`、`name`、`starred`、`delayMs`（非負毫秒）。`starred` 會將規則分享給相同 App ID 的裝置，修改或刪除也影響這些裝置。新規則放在所屬群組前面；共享規則優先於裝置專屬規則。ID 與建立時間由工具產生。

HTTP 必填 `urlPattern`，精確比對不含 scheme、host、query 的請求路徑。選填欄位為 `method`（null 表示不限）、`status`（預設 200）、`headers`、`body`、`delayOnly`、`queryParams`（值為字串）、`bodyMatch`（以字串表示的 JSON 物件）。`delayOnly: true` 只延遲真實請求，不產生模擬回應。

Socket 必須指定 `type: "socket"` 與 `event`。選填欄位為 `transport`（預設 `socketio`，或 `ktor-ws`）、`ackPayload`、`payloadMatch`（以字串表示的 JSON 物件）、`pushEvent`、`pushPayload`。Socket.IO 的 ack／push payload 是 JSON 參數陣列。Ktor WS 使用原始文字訊框，`event` 比對送出內容的子字串，`ackPayload` 是回覆訊框。`pushEvent`／`pushPayload` 只適用於 Socket.IO 的事件回覆。

將 `bodyMatch`／`payloadMatch` 設為 null 或空字串即可移除條件。Query、body、payload 條件分別需要 SDK 的 `http-query-mocks`、`http-body-mocks`、`socket-payload-mocks` 能力；背景服務不會將不支援的條件規則傳給舊 SDK。內容與回覆支援 `${randomId}`、`${now}`、`${randomString(min~max)}`。無效參數會在寫入前遭拒絕。

修改模擬規則時，MCP 會先讀取完整規則集再寫回。同一個 MCP 程序會依序執行修改；請避免同時從 UI 或另一個 MCP 程序編輯，否則可能用舊快照覆蓋其他修改。

### 斷點

每條規則包含 `id`、`urlPattern`，以及選填的 `method`、`enabled`、`phase: "response"`。可從 `get_state.pausedHits` 取得暫停回應的 ID 與裝置。

斷點只適用於 SDK 支援的真實 HTTP 文字回應，不暫停模擬回應、SSE 串流、圖片或升級連線的回應。連線中斷時會放行暫停中的請求。

## 使用範例

1. 「找出 `/orders` 最近 10 則狀態為 503 的 HTTP 訊息，再查看完整失敗流程。」
2. 「列出 `user-7` 的 `screen_view` Analytics 事件與參數。」
3. 「只有 query `page=2` 且 JSON body `limit=20` 時，才模擬 `/orders`。」
4. 「Socket.IO 的 `items:get` payload 為 `page=2` 時，回覆 `items:result`。」
5. 「暫停 `/checkout` 回應，查看命中的斷點，再以 status 200 放行。」

## 資料處理

背景服務遮罩已知敏感標頭與 JSON 欄位、符合 JWT、Bearer／Basic、PEM 格式的字串，以及 URL query 中的敏感參數。範圍包含 HTTP body、Socket payload／ack、Analytics params，以及 MCP 讀取的狀態。儲存中的流量與 UI WebSocket 不受影響。MCP 不提供未遮罩讀取選項；REST `/api/entries?redact=0` 是明確指定的本機除錯例外。

遮罩無法保證涵蓋所有內容，任意純文字密碼、圖片內容與未知欄位仍可能保留。請在背景服務設定專案特有的敏感欄位名稱。背景服務沒有驗證機制，請維持預設的本機監聽，或只在可信任網路使用。

參考[傳輸協定](../../PROTOCOL.zh-TW.md)與[使用指南](../../docs/GUIDE.zh-TW.md)。
