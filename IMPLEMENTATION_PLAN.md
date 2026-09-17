# 預計收款日、追款清單頁與每日提醒信

在出貨單加「預計收款日」，做一個追款清單頁，並由排程每天寄出一封摘要信，
列出今日到期與已逾期的未收款項。

---

## ⚠️ 待辦（程式碼已完成，以下是尚未執行的部署與驗證步驟）

程式碼五個階段都寫完且建置通過，但**只有 Stage 1 的 SQL 經過實際執行驗證**
（拋棄式 Postgres 容器，新建與增量兩條路徑皆通過）。
其餘部分只確認過建置，沒有跑過真實資料——因為正式庫尚未套用 patch-023，
`receivable_followup_view` 不存在，頁面一開就會報錯。

### 1. 套用資料庫變更（最優先，其他都卡在這）
- [ ] 把 `sql/patch-023-expected-payment-date.sql` 貼到
      Supabase Dashboard → SQL Editor 執行。
- [ ] 確認 `receivable_followup_view` 存在、`orders.expected_payment_date` 已建立。

### 2. 驗證前端
- [ ] `npm run build && npm run preview`（伺服器需在 4173）
- [ ] 另開終端機跑 `npm run test:receivables`，需設 `TEST_EMAIL` / `TEST_PASSWORD`。
- [ ] 手動確認：開新出貨單可填預計收款日、已確認單可改、進貨單不顯示此欄。

### 3. 每日提醒信（可延後，追款清單頁不依賴它）
- [ ] Resend 註冊並**驗證寄件網域**（DNS 加 SPF/DKIM）。未驗證只能寄給自己的註冊信箱。
- [ ] `supabase functions deploy receivables-digest --no-verify-jwt`
- [ ] `supabase secrets set` 設定 `RESEND_API_KEY`、`DIGEST_TOKEN`、
      `DIGEST_FROM`、`DIGEST_RECIPIENTS`（收件人刻意不進版控）。
- [ ] 複製 `sql/cron-receivables-digest.sql.example`，填入專案網址與 token 後執行。
- [ ] 實測一次：手動 POST 帶正確 token，確認信件內容與「無到期項目不寄信」都正常。

### 4. 收尾
- [ ] 全部驗證通過後刪除本檔案。

### 可能想調整的
- 追款清單沿用專案常數 `PAGE_SIZE = 5`，一頁 5 筆對這個用途偏少。
  實際用過若覺得要翻太多頁，改成該頁獨立的頁筆數即可（`renderPagination` 已接受 pageSize 參數）。
- 目前沒有「逾期總金額」的彙總卡。要加的話依 CLAUDE.md 第七條應寫成 SQL function，
  不要在前端把明細拉下來自己加總。

---

## 背景與設計取捨

- **提醒的對象是「還沒收到的錢」**，不是收款單。`payments` 表是已發生的收款（`amount > 0`），
  收款單存在時錢已入帳，加提醒已無意義。因此「預計收款日」掛在**出貨單（order）層級**。
- 「實付日期」不新增欄位：收款單的 `payment_date` 就是實收日。
- **通知走 email 而非日曆或推播**。三個方案評估後的結論：
  - 日曆訂閱 feed：Google 對「訂閱的其他日曆」多半不發通知，會退化成「看得到但不提醒」；
    且訂閱端不帶 JWT，保護只能靠難猜 URL，應收資料的保護等級低於全站其他功能。
  - FCM 推播：要 Firebase、Service Worker、裝置 token 表、iOS 需先安裝成 PWA，
    約兩倍工作量，並在只有兩個依賴的專案裡引入整個 Firebase。
  - **Email**：同樣需要排程器（真正的核心），但發送端只是一次 `fetch`，
    每台裝置都收得到、不必安裝任何東西。對「早上看一眼今天要追誰的款」最合用。
- **難的是排程不是通道**：排程器（每天找出到期的單）做好後，
  日後要加 LINE 或推播只是換最後一哩的發送程式碼，不必重做。
- 一張單假設一個約定回款日（月結／票期）。日後若出現「同一張單分多次承諾」再升級為承諾表。

## 前置作業（手動）

- Supabase 啟用 `pg_cron` 與 `pg_net` 擴充（Dashboard → Database → Extensions）。
- 本機需可執行 Supabase CLI（`supabase functions deploy`）；Edge Function 不走 Vercel 部署。
- Resend 註冊、驗證寄件網域（DNS 加 SPF/DKIM），取得 API key。
- Edge Function secrets：`RESEND_API_KEY`、`DIGEST_RECIPIENTS`、`DIGEST_TOKEN`。
- 免費額度：Edge Function 50 萬次/月、Resend 3,000 封/月，本功能用量約每月 30 封，不會超額。

---

## Stage 1: 資料層
**Goal**: `orders` 具備預計收款日，並有追款清單與提醒信共用的聚合來源。
**Success Criteria**:
- `orders` 新增 `expected_payment_date date`（可空）。
- `create_order`、`update_draft_order`、`update_order_meta` 可寫入 `expected_payment_date`；
  `update_order_meta` 比照備註，已確認單亦可改（另以旗標區分「不動」與「清空」）。
- 三支 RPC 需先 `drop` 再 `create`：加參數會產生 overload，PostgREST 會報函式不唯一
  （比照 patch-021 對 `dashboard_summary` 的做法）。
- `order_search_view` 追加輸出 `expected_payment_date`（`create or replace view` 只能在尾端追加欄位）。
- 新增 `receivable_followup_view`：建在既有 `outstanding_order_view` 之上，
  補 `partner_name`、`expected_payment_date`、`due_bucket`（overdue／today／upcoming／unscheduled）與逾期天數。
- 「今天」一律用 `(now() at time zone 'Asia/Taipei')::date`，不可用 `current_date`：
  Supabase 的 session 時區是 UTC，台北時間當天 08:00 前 `current_date` 會是前一天，
  與前端禁用 `toISOString()` 是同一個坑。
- SQL 同時寫進 `sql/patch-023-expected-payment-date.sql` 與同步更新 `sql/schema.sql`。
**Tests**: 開新單帶預計收款日查得到；已確認單可改預計收款日；
`due_bucket` 正確分類；不影響庫存與付款狀態推導。
**Status**: Complete

## Stage 2: 輸入預計收款日
**Goal**: 開單／編輯畫面可填預計收款日。
**Success Criteria**:
- `orders.html` 開單 modal 新增日期欄位，不預填（未來日，預設今天無意義）。
- `orders.js` 於開單／編輯草稿／改備註流程帶入此欄。
- 已確認單據時此欄不鎖定（不列入 `setOrderModalMode` 的 `headerLocked`）。
- 日期一律用 `toDateInputValue`，不使用 `toISOString`。
**Tests**: 三種模式（新增／草稿／已確認）皆能填寫並存回；預設值不因時區偏移。
**Status**: Complete

## Stage 3: 追款清單頁
**Goal**: 一個聚焦追款的頁面，逾期／今日到期一目了然。
**Success Criteria**:
- 新增 `receivables.html` 與 `js/receivables.js`，註冊進 `vite.config.mjs` 的 `pages`。
- 讀 `receivable_followup_view`，依預計收款日升冪（逾期在前、未設定殿後），
  每列以 badge 標示逾期／今日到期，顯示客戶、單號、應收餘額、預計收款日。
- 未設預計收款日的未收單也要列出（標為「未設定」），提醒使用者去補日期。
- 分頁沿用 `renderPagination`；聚合寫在 SQL，前端只取彙總（CLAUDE.md 第七條）。
- 塞進 DOM 的使用者輸入一律 `escapeHtml`。
- 七支頁面的側邊欄新增「追款清單」入口。
**Tests**: 分類與排序正確；點單號可跳至對應單據；側邊欄 active 狀態正確。
**Status**: Complete（程式碼完成；E2E 待 patch-023 套用至 Supabase 後執行）

## Stage 4: 每日提醒信（排程 + Edge Function）
**Goal**: 每天早上自動寄出當日追款摘要。
**Success Criteria**:
- 新增 `supabase/functions/receivables-digest/index.ts`：
  驗證 `X-Digest-Token`、以 service_role 查 `receivable_followup_view`、
  組成 HTML 信件、`fetch` 呼叫 Resend API 寄給 `DIGEST_RECIPIENTS`。
- 部署需 `--no-verify-jwt`：由 pg_cron 呼叫，不帶使用者 JWT。
- service_role key 與 Resend API key 只存在 Edge Function 環境，**絕不進前端**（CLAUDE.md 第八條）。
- pg_cron 每日以 `pg_net` 呼叫該函式；排程時間以 UTC 設定，需換算成台北時間早上。
- **沒有到期或逾期項目時不寄信**，避免每天一封空信導致被忽略（狼來了）。
- 信件內容跳脫 HTML：客戶名為使用者自由輸入。
**Tests**: 缺少或錯誤 token 回 401；有到期項目時寄出且內容正確；無項目時不寄信且回明確訊息。
**Status**: Complete（程式碼完成；待部署與 Resend 網域驗證後實測）

## Stage 5: 測試與文件
**Goal**: 納入既有 E2E 與說明文件。
**Success Criteria**:
- 新增 `tests/receivables.test.cjs` 並掛進 `tests/run-all.cjs` 與 `package.json`。
- `README.md` 補 Edge Function 部署、排程設定與 Resend 設定；`tests/README.md` 補套件說明。
- Edge Function 走 `/functions/v1/*`，不在測試的 `/rest/v1/*` 寫入攔截範圍，
  測試不得實際呼叫該函式（會真的寄信）。
**Status**: Complete（測試檔已建立；待 patch-023 套用後執行）

---

## 已知取捨

- **提醒是每日一次、非即時**：排程跑完才知道，不適合當天臨時的催收。
- **收件人寫在 Edge Function secret**，人少時不另建資料表；
  日後若要細分「誰負責追哪些客戶」再升級為收件人表。
- **Resend 免費方案 3,000 封/月**，寄送量遠低於此；但若日後改為逐客戶寄送對帳提醒需重新評估。
- **免費專案閒置一週會被暫停**，排程會一併停擺。每日排程本身即為活動，通常不致發生。
