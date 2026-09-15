# E2E 測試

以 Playwright 驅動真實瀏覽器，操作頁面並驗證行為。

## 前置需求

```bash
npm install
```

Playwright 與靜態伺服器都列在 `package.json` 的 devDependencies，
`postinstall` 會自動下載 chromium，不需要額外指令。

## 執行

測試跑的是建置產物。先開一個終端機建置並啟動預覽伺服器：

```bash
npm run build
npm run preview
```

再開另一個終端機執行：

```bash
npm test                        # 全部
npm run test:sorting            # 單一套件
node tests/sorting.test.cjs     # 或直接指定檔案
```

若要換連接埠，設定 `BASE_URL`：

```bash
BASE_URL=http://localhost:8080 node tests/run-all.cjs
```

## 重要：測試需登入

RLS 已限 `authenticated`，`helpers.js` 的 `launch()` 會在跑任何流程前先登入，
否則所有查詢回空、頁面全紅。請以環境變數提供測試帳號（不寫死進版控）：

```bash
TEST_EMAIL=someone@example.com TEST_PASSWORD=... npm test
```

此帳號需先在 Supabase → Authentication 建立。登入走 `/auth/v1/*`，不在寫入攔截
（`/rest/v1/*`）範圍內，因此不受 `allowWrites` 影響。

## 重要：測試預設不寫入資料庫

這個專案直連正式 Supabase，沒有獨立的測試資料庫。`helpers.js` 的 `launch()`
預設攔截所有寫入請求（POST/PATCH/PUT/DELETE 與會改狀態的 RPC），改以假回應取代。

這不是可有可無的保護——開發期間曾因測試寫入而在正式環境留下垃圾商品資料。
除非你清楚知道後果，否則不要傳 `allowWrites: true`。

`forms.test.cjs` 雖然傳了 `allowWrites: true`，但它在自己的 route handler 裡
攔下所有寫入，只用來計算「送出幾次請求」以驗證防連點，同樣不會真的寫入。

## 測試套件

| 檔案 | 涵蓋範圍 |
|---|---|
| `sorting.test.cjs` | 商品/往來對象依編號降冪、單據/收款依日期降冪、成本分析依編號升冪、跨頁不重複 |
| `dashboard.test.cjs` | 總覽本月出貨收益/進貨支出/出貨成本、成本分析預設區間與合計、日期區間驗證 |
| `products-tabs.test.cjs` | 商品頁「所有商品／庫存不足」分頁切換、空狀態、數量標記、hash 直達 |
| `statement.test.cjs` | 對帳單日期查詢、客戶 tabs、多選列印、全選三態、查無資料的狀態重置 |
| `orders-edit.test.cjs` | 連點不重複展開明細、草稿可編輯、已確認僅開放備註、作廢不可編輯 |
| `forms.test.cjs` | 自動編號提示、編號留空可送出、儲存按鈕防連點、動態按鈕文案 |

## 撰寫新測試

```js
const { launch, goto, Results } = require('./helpers');

(async () => {
  const r = new Results('套件名稱');
  const { browser, page, errors, blockedWrites } = await launch();

  await goto(page, 'products.html');
  r.check('說明', 實際值, 預期值);
  r.truthy('說明', 布林值);

  r.finish(errors, blockedWrites);   // 有 console 錯誤會自動判定失敗
  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
```

測試結果會反映在 exit code，失敗時為 1，方便接入 CI。
