# Sniffer UX 與競品功能盤點

本次於 2026 年 11 月 17 日檢查 main 的 UI、背景服務程式與競品官方文件。使用者尚未採納下列提案，Diff 與網路品質模擬已暫不排入實作。

## 現有功能與缺口

| 操作 | 現有功能 | 待評估方向 |
| --- | --- | --- |
| 查看 JSON 欄位 | Tree、Raw、搜尋標記、整份複製、時間換算提示 | 右鍵複製值或 JSON Pointer，保留文字選取，不恢復已移除的欄位編輯表單。 |
| 確認 Mock 結果 | MOCK 標章、MCP 同步與命中回報、序列最後命中步驟、相同比對條件提示 | 在能確定規則 ID 時，從流量連回該規則。避免把推測寫成未命中的原因。 |
| 理解缺少的內容 | 文件說明擷取與串流限制 | 先確認現有提示，再評估是否需要於 body 附近顯示截斷、無法擷取或等待中。 |
| 比較兩次回應 | 請求清單已有狀態、內容與耗時 | 尚未找到獨立的 Response Diff。使用者目前沒有足夠需求，先不做。 |
| 保存驗證資料 | Mock 匯入匯出、MCP run 摘要匯出 | 尚未找到可保存並重開完整流量的 Session。需求未確認。 |

程式中也未找到 HTTP Replay 或 JSON 欄位路徑複製。請求右鍵選單已有 Copy cURL、Copy URL 與 Copy path，最後一項是 URL path。

`mockOrder.ts` 會偵測已啟用且比對條件相同的規則，`MocksView.tsx` 顯示衝突與優先順序。這些資料還不足以解釋單筆請求為何沒命中。`SequenceEditor.tsx` 顯示同步與最後命中步驟，MCP 提供規則 ID 與同步狀態。命中只代表選到規則，不代表回應完成或畫面正確。

流量保留在記憶體，最多 2000 則訊息。持久化的 Mock、情境與 run 資料，以及匯出的摘要，都不等於可重開的流量 Session。

檢查來源包括 `server/ui/src/JsonView.tsx`、`HttpView.tsx`、`MocksView.tsx`、`SequenceEditor.tsx`、`mockOrder.ts`，以及 `server/daemon/src/api.ts`、`mcpCore.ts`、`entryStore.ts` 與 [MCP 指南](../../server/daemon/MCP.md)。

## 競品差異

Sniffer 透過已整合的 SDK 觀察與控制 App 請求，提供情境套用與驗證證據，不需安裝 TLS 攔截憑證。代理型工具涵蓋的流量較廣，兩者不能直接互換。

[Proxyman 官方文件](https://proxyman.com/docs/) 列出 Map Local、Map Remote、斷點、Scripting 與 Diff。[Charles 工具](https://www.charlesproxy.com/documentation/tools/) 包含本機與遠端映射、Rewrite、Repeat 與 Edit。[Charles Session](https://www.charlesproxy.com/documentation/using-charles/sessions/) 可儲存與重開，[功能說明](https://www.charlesproxy.com/overview/features/) 包含 SSL proxy 與頻寬限制。

若之後評估 Replay，要區分執行位置。由背景服務重送請求，不會自動重現 App 的 cookie、interceptor、驗證更新與網路堆疊，也可能重複執行寫入操作。現有固定延遲同樣不等於頻寬限制。

可繼續研究情境參數、SDK 就緒、規則命中與限定範圍清理如何配合實際驗證流程。這是尚未確認的方向，不能據此宣稱競品缺少自動化或 MCP。

## 驗證範圍

本次只檢查原始碼與官方文件，未操作競品、未做完整協定稽核，也未修改產品功能。
