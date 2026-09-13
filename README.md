# 藝境裝潢材料行 - 進銷存系統

純 HTML + Vanilla JS + Supabase 的輕量進銷存管理系統，淡色工業風後台介面。

## 功能

- **總覽**：本月收益／支出／成本、商品統計、指定期間的逐商品進出貨成本分析
- **商品管理**：所有商品／庫存不足分頁檢視、商品 CRUD、即時庫存（流水帳計算）、搜尋、分頁
- **單據管理**：進貨／銷貨／調整單、草稿流程（存草稿 → 確認生效）、作廢回沖、付款狀態、時間區間＋關鍵字搜尋
- **往來對象**：供應商／客戶管理

## 技術架構

```
前端（純靜態，免打包）
HTML + CSS + Vanilla JS（ES Modules）
        │ supabase-js v2（npm 套件，版本鎖在 package-lock.json）
        ▼
Supabase
├── Postgres（4 表 + 2 View）
├── RPC（create_order / confirm_order / void_order，原子性 + 防超賣）
└── RLS
```

## 快速開始

1. 到 [Supabase](https://supabase.com) 建立專案
2. 將 `sql/migration.sql` 與 `sql/patch-*.sql` 依序貼到 SQL Editor 執行
3. 編輯 `js/config.js`，填入 Project URL 與 Publishable (anon) key
4. `npm install` — 安裝相依並產生 `js/vendor/supabase-js.mjs`（**必要步驟**，缺少會讓所有頁面無法連線）
5. 用靜態伺服器開啟（ES Modules 需要 http 環境）：
   - `npm start`（http://localhost:4173），或
   - VSCode Live Server

## 測試

```bash
npm install   # 安裝 Playwright 並自動下載 chromium
npm start     # 另開終端機啟動靜態伺服器
npm test      # 執行全部 E2E 測試
```

詳見 `tests/README.md`。前端本身免 build，Node 套件僅供本機測試與靜態伺服器使用。

## 專案結構

```
├── index.html          # 總覽
├── products.html       # 商品管理
├── orders.html         # 單據管理
├── partners.html       # 往來對象
├── DESIGN.md           # 設計系統（色彩／字級／間距／元件規範）
├── css/style.css       # 淡色工業風設計系統
├── scripts/vendor.mjs  # 將 supabase-js 打包到 js/vendor/（npm install 時自動執行）
├── js/
│   ├── vendor/         # 產生物，不進版控
│   ├── config.js       # Supabase 連線設定
│   ├── supabase.js     # client 單例
│   ├── ui.js           # 共用元件（toast/modal/sidebar）
│   └── *.js            # 各頁邏輯
└── sql/
    ├── migration.sql   # 完整 schema
    └── patch-*.sql     # 增量補丁
```

## 注意事項

- 目前為無登入版：RLS 對 anon 全開，僅適合個人／內網使用
- 庫存採流水帳設計：單據明細即異動紀錄，不可直接改庫存數字
- 單據不可編輯：開錯請作廢重開，保留完整追溯紀錄
- 報表聚合一律寫在 SQL function（見 `sql/patch-008-dashboard-report.sql`），前端只取彙總結果並分頁，不把明細搬到瀏覽器計算
- supabase-js 走 npm 套件而非 CDN：版本鎖在 `package-lock.json`，離線可用，也不必信任第三方 CDN。升級時改 `package.json` 後重跑 `npm install`（或 `npm run vendor`）
- 部署時記得一併上傳 `js/vendor/`，該目錄不進版控，但屬於執行必要檔案
- 出貨成本為估算值：`order_items` 未保存出貨當下的進價，改以期間進貨均價回推（無進貨則採現行進價），查詢區間一變數字就會變
