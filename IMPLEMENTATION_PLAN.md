# 預計收款日與日曆追款提醒

在出貨單加「預計收款日」，並讓使用者手動把「到期去追款」加進自己的 Google 日曆。

## 背景與設計取捨

- **提醒的對象是「還沒收到的錢」**，不是收款單。`payments` 表是已發生的收款（`amount > 0`），
  收款單存在時錢已入帳，加提醒已無意義。因此「預計收款日」掛在**出貨單（order）層級**，
  而非收款管理頁。
- 「實付日期」不新增欄位：收款單的 `payment_date` 就是實收日。
- 走 **Google Identity Services（GIS）token flow** 手動授權，不動現有 Supabase 帳密登入，
  前端只需公開的 Client ID，不需 client secret。
- 一張單假設一個約定回款日（月結／票期情境）。若日後出現「同一張單分多次口頭承諾」，
  再升級為獨立的「收款承諾」表。

## 前置作業（Google Cloud Console，手動）

- 建 OAuth 2.0 Client ID（類型 Web application）。
- 啟用 Google Calendar API。
- Authorized JavaScript origins 加 `http://localhost:4173`（preview）與 Vercel 正式網域。
- Client ID 放進 `.env` 的 `VITE_GOOGLE_CLIENT_ID`，Vercel 環境變數也設一份（改完須重新部署）。
- 少數人使用時 OAuth 可停在「測試模式」加白名單帳號，不必送 Google 審查。

---

## Stage 1: 資料層
**Goal**: `orders` 具備預計收款日，前端讀寫皆有途徑。
**Success Criteria**:
- `orders` 新增 `expected_payment_date date`（可空）。
- `create_order`、`update_draft_order`、`update_order_meta` 皆可寫入該欄
  （`update_order_meta` 讓已確認單比照備註可改）。
- `order_search_view` 輸出 `expected_payment_date`。
**Tests**: 開新單帶預計收款日後查得到值；已確認單改預計收款日成功；不影響庫存與付款狀態推導。
**Status**: Not Started

## Stage 2: 輸入預計收款日
**Goal**: 開單／編輯畫面可填預計收款日。
**Success Criteria**:
- `orders.html` 開單 modal 新增日期欄位。
- `orders.js` 於開單／編輯草稿／改備註流程帶入此欄。
- 已確認單據時此欄不鎖定（不列入 `setOrderModalMode` 的 `headerLocked`）。
- 日期一律用 `toDateInputValue`，不使用 `toISOString`。
**Tests**: 三種模式（新增／草稿／已確認）皆能填寫並存回；預設值不因時區偏移。
**Status**: Not Started

## Stage 3: 日曆封裝
**Goal**: 提供可複用的 Google 日曆寫入模組。
**Success Criteria**:
- 新建 `js/calendar.js`：動態載入 GIS script、`initTokenClient`（scope `calendar.events`）、
  封裝 `events.insert`。
- `config.js` 新增 `GOOGLE_CLIENT_ID`（來自 `VITE_GOOGLE_CLIENT_ID`）。
**Tests**: 授權流程可取得 access token；建立事件回傳 event id；缺 Client ID 時給明確錯誤。
**Status**: Not Started

## Stage 4: 提醒入口
**Goal**: 未收出貨單可一鍵加追款提醒。
**Success Criteria**:
- `orders.js` 列表操作欄，對 `sale + confirmed + unpaid/partial` 的單顯示「加提醒」按鈕。
- 按下後於 `expected_payment_date` 建全天事件，標題「追款：{客戶} {單號} 應收 ${餘額}」，
  設當天與前一天 popup 提醒。
- `paid` 的單按鈕顯示「已收款」並停用（暫不做自動刪除事件）。
- 塞進 DOM 與事件標題的使用者輸入一律 `escapeHtml`。
**Tests**: 未收單顯示按鈕、已收單停用；無預計收款日時提示先填；事件內容含客戶／單號／餘額。
**Status**: Not Started

---

## 已知取捨

- 每次進頁面第一次加提醒會彈 Google 授權視窗（access token 1 小時過期，不持久化）；
  同一 session 內後續可靜默取得。對偶爾手動加提醒可接受。
- 未新增 HTML 頁面，不動 `vite.config.mjs`。
- E2E 預設攔截寫入；日曆呼叫走 Google 不經 Supabase，測試需避開實際呼叫。
