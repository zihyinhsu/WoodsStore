# 藝境裝潢材料行 - 進銷存系統

純 HTML + Vanilla JS + Supabase 的輕量進銷存管理系統，淡色工業風後台介面。

## 功能

- **總覽**：商品統計、低庫存警示、今日銷貨、近期單據
- **商品管理**：商品 CRUD、即時庫存（流水帳計算）、搜尋、分頁
- **單據管理**：進貨／銷貨／調整單、草稿流程（存草稿 → 確認生效）、作廢回沖、付款狀態、時間區間＋關鍵字搜尋
- **往來對象**：供應商／客戶管理

## 技術架構

```
前端（純靜態，免 build）
HTML + CSS + Vanilla JS（ES Modules）
        │ supabase-js v2（CDN）
        ▼
Supabase
├── Postgres（4 表 + 2 View）
├── RPC（create_order / confirm_order / void_order，原子性 + 防超賣）
└── RLS
```

## 快速開始

1. 到 [Supabase](https://supabase.com) 建立專案
2. 將 `sql/migration.sql` 貼到 SQL Editor 執行
3. 編輯 `js/config.js`，填入 Project URL 與 Publishable (anon) key
4. 用靜態伺服器開啟（ES Modules 需要 http 環境）：
   - VSCode Live Server，或
   - `npx serve .`

## 專案結構

```
├── index.html          # 總覽
├── products.html       # 商品管理
├── orders.html         # 單據管理
├── partners.html       # 往來對象
├── css/style.css       # 淡色工業風設計系統
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

- 目前為無登入版：RLS 對 anon 全開，僅適合個人／內網使用
- 庫存採流水帳設計：單據明細即異動紀錄，不可直接改庫存數字
- 單據不可編輯：開錯請作廢重開，保留完整追溯紀錄
