# 藝境裝潢材料行 - 進銷存系統

HTML + Vanilla JS + Supabase 的輕量進銷存管理系統，以 Vite 建置，淡色工業風後台介面。

## 功能

- **總覽**：本月出貨收益／進貨支出／出貨成本／毛利、指定期間的逐商品進出貨成本分析
- **商品管理**：所有商品／庫存不足分頁檢視、商品 CRUD、即時庫存（流水帳計算）、搜尋、分頁
- **單據管理**：進貨／銷貨／調整單、草稿流程（存草稿 → 確認生效）、作廢回沖、付款狀態、時間區間＋關鍵字搜尋
- **收款管理**：客戶應收餘額、收款單沖帳分配、未分配預收追蹤、時間區間＋關鍵字搜尋
- **對帳單**：依期間產生各客戶應收明細、多選批次列印
- **往來對象**：供應商／客戶管理

## 技術架構

```
前端（Vite 建置的多頁式靜態站）
HTML + CSS + Vanilla JS（ES Modules）
        │ supabase-js v2（npm 套件，版本鎖在 package-lock.json）
        ▼
Supabase
├── Postgres（4 表 + 2 View）
├── RPC（create_order / confirm_order / void_order，原子性 + 防超賣）
├── RLS（限 authenticated，未登入無法讀寫）
└── Auth（Email 密碼登入，帳號在 Dashboard 建立、關閉自助註冊）
```

## 快速開始

1. 到 [Supabase](https://supabase.com) 建立專案
2. 將 `sql/migration.sql` 與 `sql/patch-*.sql` 依序貼到 SQL Editor 執行
   （含 `patch-017-auth.sql`，會關閉匿名存取——套用前先在 Authentication
   建立員工帳號並關閉「Allow new users to sign up」，否則自己也會被鎖在外面）
3. 複製 `.env.example` 為 `.env`，填入 Project URL 與 Publishable (anon) key
4. `npm install` — 安裝相依套件
5. `npm run dev` 啟動開發伺服器（http://localhost:5173），支援 HMR，存檔即更新

建置與預覽產物：

```bash
npm run build     # 輸出到 dist/
npm run preview   # 以 http://localhost:4173 預覽 dist/
```

## 部署（Vercel）

推上 git 後在 Vercel 匯入專案即可，建置指令與輸出目錄寫在 `vercel.json`。

**環境變數需在 Vercel 另外設定**：Project Settings → Environment Variables
新增 `VITE_SUPABASE_URL` 與 `VITE_SUPABASE_ANON_KEY`。這兩個值在 build 時內嵌進
產物，因此改動後必須重新部署才會生效。

## 測試

```bash
npm install       # 安裝 Playwright 並自動下載 chromium
npm run build     # 測試跑的是建置產物
npm run preview   # 另開終端機，伺服器需在 4173
npm test          # 執行全部 E2E 測試
```

詳見 `tests/README.md`。測試預設連 `http://localhost:4173`，要換連接埠請設 `BASE_URL`。

## 專案結構

```
├── index.html          # 總覽
├── products.html       # 商品管理
├── orders.html         # 單據管理
├── partners.html       # 往來對象
├── payments.html       # 收款管理
├── statement.html      # 對帳單
├── DESIGN.md           # 設計系統（色彩／字級／間距／元件規範）
├── css/style.css       # 淡色工業風設計系統
├── vite.config.mjs     # MPA 進入點設定（新增頁面要補進 pages 陣列）
├── js/
│   ├── config.js       # Supabase 連線設定
│   ├── supabase.js     # client 單例
│   ├── ui.js           # 共用元件（toast/modal/sidebar）
│   └── *.js            # 各頁邏輯
└── sql/
    ├── migration.sql   # 完整 schema
    └── patch-*.sql     # 增量補丁
```

## 注意事項

- 需登入：RLS 限 `authenticated`，所有頁面須先透過 Supabase Auth 登入（`login.html`）；帳號在 Supabase Dashboard 手動建立，並關閉自助註冊
- 庫存採流水帳設計：單據明細即異動紀錄，不可直接改庫存數字
- 單據不可編輯：開錯請作廢重開，保留完整追溯紀錄
- 報表聚合一律寫在 SQL function（見 `sql/patch-008-dashboard-report.sql`），前端只取彙總結果並分頁，不把明細搬到瀏覽器計算
- supabase-js 走 npm 套件而非 CDN：版本鎖在 `package-lock.json`，離線可用，也不必信任第三方 CDN。升級時改 `package.json` 後重跑 `npm install`
- 這是多頁式應用：新增 HTML 頁面時要一併補進 `vite.config.mjs` 的 `pages` 陣列，否則建置後該頁直接 404
- 部署時上傳 `npm run build` 產出的 `dist/`
- `VITE_` 開頭的環境變數會在 build 時內嵌進產物、瀏覽器可見，只放 publishable (anon) key，存取控制靠 RLS；`service_role` key 絕不可放
- `.env` 不進版控，新環境請從 `.env.example` 複製；Vercel 上改完環境變數要重新部署才生效
- 出貨成本為估算值：`order_items` 未保存出貨當下的進價，改以期間進貨均價回推（無進貨則採現行進價），查詢區間一變數字就會變
