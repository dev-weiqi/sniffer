[English](MCP.md) | 繁體中文

# Sniffer MCP

將 AI 工具連到 `sniffer mcp`，就能讀取 HTTP 與 Socket 紀錄、編輯模擬規則、注入事件及操作回應斷點。MCP 透過 REST 連接執行中的背景服務。MCP 本身不需更新 SDK，各項模擬功能仍需 SDK 宣告對應能力。

## 使用範例

連接 MCP 用戶端後，可以要求 AI 查看或調整指定 App：

1. 「找出 `/orders` 最近 10 則狀態為 503 的 HTTP 訊息，再查看完整失敗流程。」
2. 「列出失敗的 HTTP 請求與回應內容。」
3. 「只有 query `page=2` 且 JSON body `limit=20` 時，才模擬 `/orders`。」
4. 「Socket.IO 的 `items:get` payload 為 `page=2` 時，回覆 `items:result`。」
5. 「暫停 `/checkout` 回應，查看命中的斷點，再以 status 200 放行。」

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

替換絕對路徑與 App ID。`env` 可省略。以上 JSON 適用於使用 `mcpServers` 的用戶端，其他用戶端可在 MCP 設定中填入相同的執行檔、參數與環境變數。已安裝且包含此功能的套件可改用 `"command": "sniffer", "args": ["mcp"]`，或 `"command": "npx", "args": ["-y", "@dev-weiqi/sniffer", "mcp"]`。

MCP 自 0.8.0 起提供。`sniffer mcp` 不會啟動背景服務，stdout 僅供 MCP 訊息使用。

也可以連接桌面 App 正在執行的背景服務，將 `SNIFFER_PORT` 設成桌面 App 的連接埠即可。背景服務預設為 9091，9092 也是 iOS USB 監聽端的預設連接埠，在同一主機同時使用時請選擇其他空閒連接埠。

## 環境變數

| 變數 | 設定程序 | 預設值 | 用途 |
| --- | --- | --- | --- |
| `SNIFFER_HOST` | MCP | `127.0.0.1` | 背景服務所在主機。 |
| `SNIFFER_PORT` | MCP | `PORT`，未設定則為 `9091` | 要連接的背景服務連接埠。 |
| `SNIFFER_APP_ID` | MCP | 未設定 | 優先選擇此 App 的已連線裝置，多裝置流量查詢也限於此 App。明確指定 `deviceId` 時以它為準。 |
| `PORT` | 背景服務 | `9091` | 監聽連接埠。 |
| `SNIFFER_BIND` | 背景服務 | `127.0.0.1` | 監聽介面。只有需要區域網路存取時才使用 `0.0.0.0`。 |
| `SNIFFER_REDACT_HEADERS` | 背景服務 | 內建名稱 | 額外要遮罩的標頭名稱，以逗號分隔。 |
| `SNIFFER_REDACT_BODY_FIELDS` | 背景服務 | 內建名稱 | 額外要遮罩的欄位名稱，以逗號分隔，也套用到 Socket payload。 |

遮罩變數要設在背景服務，例如：

```bash
SNIFFER_REDACT_BODY_FIELDS=sessionKey,otp SNIFFER_REDACT_HEADERS=X-My-Token node server/daemon/bin/sniffer.js start
```

未指定 `deviceId` 時，工具會選擇唯一已連線裝置，並依 App ID 縮小範圍。無法確定單一裝置時，流量查詢涵蓋符合範圍的裝置，寫入操作必須明確指定 `deviceId`。`get_state` 一律列出背景服務中的所有裝置、模擬規則及斷點。`clear_traffic` 一律影響所有裝置，不受 App ID 限制。

## 工具

| 工具 | 用途 | 參數 |
| --- | --- | --- |
| `get_state` | 裝置、紀錄筆數、模擬規則、已啟用斷點與暫停中的回應。 | 無 |
| `list_traffic` | 讀取紀錄，遮罩已知敏感資料。 | `deviceId?`、`type?`（`http`、`socket`）、`method?`、`status?`、`urlContains?`、`bodyContains?`、`userId?`、`event?`、`connectionId?`、`limit?` |
| `get_entry` | 讀取同一 ID 的所有訊息，包括請求／回應、事件／ack。 | `id`、`deviceId?` |
| `create_mock` | 建立 HTTP 規則（預設）或 Socket 規則，回傳 `{deviceId, created: {id}}`。 | `deviceId?`、`type?`（`http`、`socket`），以及下方欄位 |
| `copy_mock_with_fields` | 複製 HTTP JSON Mock 並修改指定欄位，新副本停用且不共享。 | `id`、`replacements: [{path, value}]`、`deviceId?`、`name?` |
| `update_mock` | 修改規則，保留未指定欄位，回傳 `{deviceId, updated: {id}}`。 | `id`、`deviceId?`，以及下方欄位 |
| `delete_mock` | 依 ID 刪除規則。 | `id`、`deviceId?` |
| `push_event` | 向 App 注入收到的 Socket 事件。省略 `connectionId` 或設為 null，會廣播至該裝置的連線。 | `event`、`payload`、`deviceId?`、`connectionId?` |
| `clear_traffic` | 清除所有裝置的紀錄，清除 HTTP 或全部時，也會原樣放行暫停中的回應。 | `type?`（`http`、`socket`），省略表示全部 |
| `set_breakpoints` | 完整取代單一裝置的回應斷點規則，空陣列表示全部停用。 | `rules`、`deviceId?` |
| `resolve_breakpoint` | 放行並選擇性修改回應，或中止暫停中的請求。 | `id`、`action`（`resume`、`abort`）、`deviceId?`、`status?`、`headers?`、`body?` |

HTTP 請求與回應是共用 ID 的兩則訊息。method、status、URL 與 user ID 篩選會在同一裝置內關聯兩者。`limit` 取最後 N 則訊息，不是 N 組完整流程，完整內容請用 `get_entry`。

`bodyContains` 搜尋各則訊息的 body、Socket payload。`event` 精確比對 Socket 事件名稱，`userId` 精確比對擷取當下的身分，空字串表示明確未設定。

回傳資料保留圖片的 `bodyBase64`、截斷、延遲、錯誤欄位、Socket label。大型圖片內容可能超過 MCP 用戶端的訊息大小限制。

### 模擬規則欄位

共用欄位為 `enabled`、`name`、`starred`、`delayMs`（非負毫秒）。`starred` 會將規則分享給相同 App ID 的裝置，修改或刪除也影響這些裝置。新規則放在所屬群組前面，共享規則優先於裝置專屬規則。ID 與建立時間由工具產生。

HTTP 必填 `urlPattern`，比對不含 scheme、host、query 的請求路徑。整段 `{id}` 可比對一個非空路徑區段，需有 `http-path-templates` 能力。選填欄位為 `method`（null 表示不限）、`status`（預設 200）、`headers`、`body`、`delayOnly`、`queryParams`（值為字串）、`bodyMatch`（以字串表示的 JSON 物件）。`delayOnly: true` 只延遲真實請求，不產生模擬回應。

例如 `create_mock({"urlPattern":"/users/{id}","requestHeaders":{"Accept-Language":"zh-TW","X-Version":"2"}})` 要求兩個請求標頭都符合。名稱不分大小寫，值精確比對，同名標頭有任一值符合即可。`update_mock` 會取代整份標頭條件，傳入 `requestHeaders: {}` 即可清除。非空條件需要 `http-header-mocks` 能力。`headers` 仍用來設定回應標頭。

Socket 必須指定 `type: "socket"` 與 `event`。選填欄位為 `transport`（預設 `socketio`，或 `ktor-ws`）、`ackPayload`、`payloadMatch`（以字串表示的 JSON 物件）、`pushEvent`、`pushPayload`。Socket.IO 的 ack／push payload 是 JSON 參數陣列。Ktor WS 使用原始文字訊框，`event` 比對送出內容的子字串，`ackPayload` 是回覆訊框。`pushEvent`／`pushPayload` 只適用於 Socket.IO 的事件回覆。

將 `bodyMatch`／`payloadMatch` 設為 null 或空字串即可移除條件。Query、body、payload 條件分別需要 SDK 的 `http-query-mocks`、`http-body-mocks`、`socket-payload-mocks` 能力，背景服務不會將不支援的條件規則傳給舊 SDK。內容與回覆支援 `${randomId}`、`${now}`、`${randomString(min~max)}`。無效參數會在寫入前遭拒絕。

修改模擬規則時，MCP 會先讀取完整規則集再寫回。同一個 MCP 程序會依序執行修改，請避免同時從 UI 或另一個 MCP 程序編輯，否則可能用舊快照覆蓋其他修改。

### 斷點

每條規則包含 `id`、`urlPattern`，以及選填的 `method`、`enabled`、`phase: "response"`。可從 `get_state.pausedHits` 取得暫停回應的 ID 與裝置。

斷點只適用於 SDK 支援的真實 HTTP 文字回應，不暫停模擬回應、SSE 串流、圖片或升級連線的回應。連線中斷時會放行暫停中的請求。

### 複製並修改 JSON 欄位

先從 `get_state` 取得既有 HTTP 規則 ID，再呼叫 `copy_mock_with_fields`：

```json
{
  "id": "source-rule-id",
  "replacements": [{ "path": "/data/commentCount", "value": 36 }],
  "name": "36 comments"
}
```

原始回覆必須是有效 JSON。路徑使用 JSON Pointer，例如 `/items/0/name`，欄位名稱中的 `/` 寫成 `~1`，`~` 寫成 `~0`。只替換已存在且型別相同的欄位，不新增、不刪除、不替換整份根節點。可一次修改 1 至 100 個不重複、不互相包含的路徑。任何一處無效都不寫入，包含不安全整數的底稿也會被拒絕，以免編輯時改壞其他數值。JSON 會重新排版，格式與鍵順序不保證保留。只驗證 JSON 結構與型別，不驗證 App 的業務 schema。

回傳 `{deviceId, sourceId, created: {id, enabled: false, starred: false}, changedPaths}`，不回傳欄位內容。原規則、其他規則與其他裝置不變，來源即使共享，副本仍只屬於所選裝置。副本保留匹配條件、狀態、標頭與延遲，可用 `update_mock` 明確啟用。共享規則原有的優先權不變，因此啟用副本不保證覆蓋共享來源。

不呼叫真實後端，不需要更新 SDK。僅延遲規則、Socket 規則、非 JSON 及不能解析成 JSON 的 placeholder 底稿不支援。

指定欄位修改透過 MCP 使用。UI 保留原有 Copy 按鈕與回應編輯器。

本機預覽 API 保留 `POST /api/mock-body/replace-fields`，傳入 `{body, replacements}`，成功回傳 `{body, changes: [{path, before, after}]}`，錯誤回傳 HTTP 400。此端點不儲存規則，前後值不遮罩。

## 情境套組

`save_scenario({name, appId, rules, id?})` 將套組保存在 daemon 的規則儲存檔，帶 id 可更新既有套組。rules 使用 `create_mock` 的欄位，不帶 deviceId。
`list_scenarios({appId?})` 回傳名稱、規則數與所需參數，不回傳回覆內容。
`delete_scenario({id})` 只刪套組，不刪先前產生的規則。
`apply_scenario({id, deviceId?, parameters})` 驗證整組後一次加入新的裝置專屬規則，回傳 `{deviceId, scenarioId, ruleIds, status: "sent"}`，sent 不代表 SDK 已就緒。
裝置需在線且 appId 相符，原有規則及共享優先順序不變。

範例套組的 urlPattern 為 `/characters/{{characterId}}/comments`，body 為 `{"commentCount":"{{count}}","comments":[]}`。執行時傳入 `parameters: {"characterId":"194","count":0}`，產生精確路徑及數值 0。

所有參數都必須提供，不接受多餘參數。JSON 中完整的 `{{parameter}}` 字串會轉成傳入的 JSON 純量，字串內嵌替換則保留字串且正確跳脫。URL 參數限單一路徑片段，只接受英數字、底線、點、波浪號與連字號。SDK 原有 `${randomId}` 等 placeholder 不變。
重複執行會產生新規則，清理時使用回傳的 ruleIds。現有 UI 會顯示產生的規則，不需改 SDK。

## 驗證工作階段

`start_run({deviceId?, name?, scenarioId?, parameters?})` 建立可跨 daemon 重啟保留的工作階段，可同時套用情境，回傳 `{run, status: "sent"}`。
用 `create_mock({runId, ...fields})` 加入本輪規則，裝置由工作階段決定，新增規則強制不共享。
`list_runs({deviceId?})` 列出已結束及未結束的工作階段，會遵守 MCP 設定的 appId 範圍。

`end_run({runId})` 只刪所記錄的本輪規則 ID，不清流量、不動其他輪或原有規則，可重複呼叫。若本輪規則被改成共享，會拒絕清理，必須先明確取消共享。
裝置離線時清理 daemon 儲存狀態，回報 `cleanup-pending-device`，在線時回報 `cleanup-sent`，不冒充 SDK 已確認。沒有自動過期，驗證失敗也需明確結束本輪。這部分不需更新 SDK。

## 裝置就緒與命中

`get_run_status({runId, waitMs?})` 回傳 supported、connected、ready、revision、acknowledged、omittedRuleIds 與近期精準規則 hits。waitMs 可為 0 至 30000，只等待就緒，裝置不支援或離線會提早返回。操作畫面後再查一次取得命中。
進行中的工作階段必須所有規則都已下發且 SDK 確認目前同步才算 ready，結束後則確認本輪規則已移除。需要 SDK 的 `mock-observability` 能力。
命中只是有限筆數的記憶體證據，不代表回覆完成或 UI 正確，共享規則仍可能優先命中。MCP 等待不阻擋 App 網路請求。

### 依次回覆

`create_mock` 與 `update_mock` 可設定 `sequence: {steps:[{status:503,body:"retry"},{status:200,body:"ok"}],onExhausted:"last",resetToken:""}`。每步支援 status、headers、body、delayMs。

用完後可選 `last` 重複最後一步、`loop` 從頭開始、`stop` 讓後續命中失敗，不會放行真實請求。以新 resetToken 更新完整序列即可重設，設 sequence 為 null 可回到固定回覆。

需要 SDK 能力 `http-sequences`，透過 `get_run_status` 確認就緒與從 0 起算的 `hits[].stepIndex`。命中只代表選中，不代表回覆完成。背景請求若命中也會消耗步驟。指定 JSON 欄位複製僅支援固定回覆。

### 定時 SSE 串流

`create_mock`／`update_mock` 可設定 `sse: {events:[{data:"first",delayMs:100},{event:"done",data:"second",delayMs:500}],ending:"close"}`。事件支援 data、event、id、retry、delayMs。

需要 status 200 與 SDK 能力 `http-sse-mocks`，不可搭配 sequence 或 delayOnly，切換模式時將舊模式設為 null。data 填純文字或序列化 JSON，不加 SSE 前綴。JSON data 與序列步驟 body 支援情境參數跳脫。

結束方式為 close 正常結束、open 等候呼叫端取消／逾時、disconnect 在送出最後一筆後產生讀取錯誤，尚未讀取的緩衝資料可能遺失。

每個命中請求都從第一筆開始，用戶端自動重連可能建立新串流，本功能不會停用重連。

`get_run_status` 確認同步與規則命中，不代表已讀取事件或完成 UI 渲染。定時串流刻意回報 null body，事件時序須透過 App 的串流讀取端驗證。

## 等待命中與匯出驗證摘要

`wait_for_hits({runId, ruleIds, minHits?, timeoutMs?, sinceTimestamp?, stepIndex?})`
等待指定的每條 run 所屬規則都累積至少 `minHits` 次命中（預設 1 次），且裝置已確認目前規則。
預設從 run 開始計算，`sinceTimestamp` 可指定更晚的起點，`stepIndex` 可限定從 0 起算的序列步驟。
要排除舊命中，請在操作 App 前記下時間並傳入。預設等待 10 秒，上限 30 秒，0 代表只查一次。
符合相同規則的背景請求也會計數。

回傳 `matched`、`reason`、每條規則的 `observedHits`、首次與最後命中時間及證據限制。
原因包含 `matched`、`timeout`、`ended`、`disconnected`、`unsupported`。
不屬於此 run 的規則會報錯。工具不修改規則或流量。

`export_run_summary({runId})` 回傳 `{summary, markdown}`，由呼叫端另存 JSON 或 Markdown，
工具本身不寫入檔案路徑。內容包含 run 所屬規則 ID、同步與連線狀態、保留的命中次數及時間，
不包含規則 body、headers 或流量內容。請在 daemon 關閉前匯出，run 結束後的 ready 代表清理確認。

兩個工具都使用記憶體中的命中證據，全裝置合計保留最新 1000 筆，daemon 重啟會清空。
`historyTruncated` 表示本次 daemon 曾淘汰舊紀錄，`runPredatesEvidence` 表示 run 早於本次啟動。
次數可能不完整，0 次不能證明從未命中。命中不代表回應完成、SSE 已被讀取或 UI 正確。
沿用現有 `mock-observability` 能力，不需額外修改 SDK。

## 安全性

背景服務遮罩已知敏感標頭與 JSON 欄位、符合 JWT、Bearer／Basic、PEM 格式的字串，以及 URL query 中的敏感參數。範圍包含 HTTP body、Socket payload／ack，以及 MCP 讀取的狀態。儲存中的流量與 UI WebSocket 不受影響。MCP 不提供未遮罩讀取選項，REST `/api/entries?redact=0` 是明確指定的本機除錯例外。

任意純文字密碼、圖片內容與未知欄位仍可能保留。請在背景服務透過 `SNIFFER_REDACT_HEADERS` 與 `SNIFFER_REDACT_BODY_FIELDS` 設定專案特有的敏感欄位名稱。背景服務沒有驗證機制，請維持預設的本機監聽，或只在可信任網路使用。

參考[傳輸協定](../../PROTOCOL.zh-TW.md)與[使用指南](../../docs/GUIDE.zh-TW.md)。
