# 預計收款日與追款清單頁（Google 日曆連動）

在出貨單加「預計收款日」，做一個追款清單頁，並讓使用者把「到期去追款」
以 L1 方式（手動加／更新／移除、系統記住 event_id）連動到自己的 Google 日曆。

## 背景與設計取捨

- **提醒的對象是「還沒收到的錢」**，不是收款單。`payments` 表是已發生的收款（`amount > 0`），
  收款單存在時錢已入帳，加提醒已無意義。因此「預計收款日」掛在**出貨單（order）層級**。
- 「實付日期」不新增欄位：收款單的 `payment_date` 就是實收日。
- **追款由一人負責 → 用個人主日曆（`primary`），不導入共享日曆**，event_id 綁該使用者本人即可。
- **連動做到 L1（手動觸發）**：加／更新／移除提醒都由使用者在清單頁當場點按，
  用當下的 access token 即可，**不需要 refresh token、不需要後端**。
  不做 L2/L3 自動雙向同步（那需 Edge Function + refresh token + webhook，現階段 CP 值低）。
- 走 **Google Identity Services（GIS）token flow**，不動現有 Supabase 帳密登入，
  前端只需公開的 Client ID，不需 client secret。
- 一張單假設一個約定回款日（月結／票期）。日後若出現「同一張單分多次承諾」再升級為承諾表。

## 前置作業（Google Cloud Console，手動）

- 建 OAuth 2.0 Client ID（類型 Web application）。
- 啟用 Google Calendar API。
- Authorized JavaScript origins 加 `http://localhost:4173`（preview）與 Vercel 正式網域。
- Client ID 放進 `.env` 的 `VITE_GOOGLE_CLIENT_ID`，Vercel 環境變數也設一份（改完須重新部署）。
- 單人使用，OAuth 可停在「測試模式」加白名單帳號，不必送 Google 審查。

---

## Stage 1: 資料層
**Goal**: `orders` 具備預計收款日與提醒 event_id，並有追款清單的聚合來源。
**Success Criteria**:
- `orders` 新增 `expected_payment_date date`（可空）與 `reminder_event_id text`（可空，
  記已建立的 Google 事件，用於更新／移除與避免重複）。
- `create_order`、`update_draft_order`、`update_order_meta` 可寫入 `expected_payment_date`；
  `update_order_meta` 另可回寫 `reminder_event_id`（比照備註，已確認單亦可改）。
- `order_search_view` 輸出 `expected_payment_date`、`reminder_event_id`。
- 新增追款清單聚合來源（view 或 RPC）：未收出貨單 ＋ 應收餘額 ＋ 預計收款日 ＋ 逾期判斷。
**Tests**: 開新單帶預計收款日查得到；已確認單改預計收款日與回寫 event_id 成功；
聚合來源正確標示逾期／本月待追；不影響庫存與付款狀態推導。
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
**Goal**: 提供可複用的 Google 日曆讀寫模組。
**Success Criteria**:
- 新建 `js/calendar.js`：動態載入 GIS script、`initTokenClient`（scope `calendar.events`）、
  封裝 `events.insert`／`events.patch`／`events.delete`（寫入 `primary` 日曆）。
- `config.js` 新增 `GOOGLE_CLIENT_ID`（來自 `VITE_GOOGLE_CLIENT_ID`）。
**Tests**: 授權可取得 access token；建立／更新／刪除事件皆回傳預期結果；缺 Client ID 時給明確錯誤。
**Status**: Not Started

## Stage 4: 提醒的加／更新／移除（可複用邏輯）
**Goal**: 一段共用邏輯處理提醒的建立、更新、移除與狀態呈現。
**Success Criteria**:
- 依 `reminder_event_id` 有無決定入口狀態：無 → 「加提醒」；有 → 「更新／移除提醒」。
- 加 → `events.insert` 後把 event_id 回寫 `orders`；更新 → `events.patch`；
  移除 → `events.delete` 後清空 `reminder_event_id`。
- 全天事件標題「追款：{客戶} {單號} 應收 ${餘額}」，設當天與前一天 popup 提醒。
- 無預計收款日時提示先填；`paid` 的單不提供加提醒。
- 塞進 DOM 與事件標題的使用者輸入一律 `escapeHtml`。
**Tests**: 三種操作正確反映於 Google 與 `reminder_event_id`；重複加被擋；已收單不顯示入口。
**Status**: Not Started

## Stage 5: 追款清單頁
**Goal**: 一個聚焦追款的頁面，逾期／本月待追一目了然並可直接操作提醒。
**Success Criteria**:
- 新增追款清單 HTML 頁（暫定 `receivables.html`），並註冊進 `vite.config.mjs` 的 `pages`。
- 讀 Stage 1 的聚合來源，分「逾期」「本月待追」等區塊，顯示客戶、單號、應收餘額、預計收款日。
- 每列整合 Stage 4 的提醒入口；點列可跳至對應單據。
- 分頁沿用 `renderPagination`；聚合寫在 SQL，前端只取彙總（CLAUDE.md 第七條）。
**Tests**: 逾期與本月分區正確；提醒入口與 orders 頁行為一致；點列正確導向單據。
**Status**: Not Started

---

## 已知取捨

- 每次進頁面第一次操作提醒會彈 Google 授權視窗（access token 1 小時過期，不持久化）；
  同一 session 內後續可靜默取得。對單人手動操作可接受。
- 未來若要多人追款，需改寫共享日曆並讓 event_id 全域一致，屆時再評估。
- E2E 預設攔截寫入；日曆呼叫走 Google 不經 Supabase，測試需避開實際呼叫。
