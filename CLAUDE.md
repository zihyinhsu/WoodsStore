# 專案開發約定

藝境裝潢材料行進銷存系統。HTML + Vanilla JS（ES Modules）+ Supabase，Vite 建置的多頁式靜態站。
架構總覽與部署方式見 `README.md`，設計系統見 `DESIGN.md`；這份文件只記錄「動手改程式前必須知道的規則」。

## 一、寫新函式前，先查 `js/utils.js`

**這是本專案最常被違反的規則。** 新增任何函式之前，一律先打開 `js/utils.js` 確認有沒有現成的。

- **有現成的 → 直接 import 複用**，不要在頁面模組裡重寫一份。
- **沒有、但這個函式其他頁面也可能用到 → 寫進 `js/utils.js`**，讓它從第一天就是共用資產。
- **只有單一頁面會用、且與該頁業務強綁定 → 留在該頁模組**（例如 `payments.js` 的 `collectAllocations`）。

判準是「換一個頁面還會不會需要它」，而不是「現在有幾個地方在用」。

### 共用層的分工邊界

| 檔案 | 放什麼 | 判準 |
|---|---|---|
| `js/utils.js` | 純函式：格式化、日期換算、數值處理、集合操作 | 不碰 DOM、不依賴頁面狀態，可單獨測試 |
| `js/ui.js` | 共用 UI 元件：toast、modal、sidebar、分頁渲染、送出防連點 | 會操作 DOM 或瀏覽器狀態 |
| `js/supabase.js` | Supabase client 單例 | 全站唯一連線來源，不要另外 `createClient` |
| `js/inventory-cost.js` | 成本分析的資料存取 | 包裝 RPC 呼叫，回傳整理過的結果 |

放錯地方的代價是真實的：`toDateInputValue` 曾經在 `ui.js` 和 `statement.js` 各有一份完全相同的實作，
分頁渲染更是同一段邏輯散落在五支檔案。改一邊、漏另一邊，是這個專案已經發生過的事。

### 目前 `utils.js` 已有的函式

先看這份清單，再決定要不要新增：

`PAGE_SIZE`、`formatCurrency`、`formatDate`、`toDateInputValue`、`dateRange`、`debounce`、
`escapeHtml`、`round2`、`sum`、`groupBy`、`totalPages`

## 二、日期：禁用 `toISOString()` 取日期字串

要產生 `YYYY-MM-DD`（日期 input 的值、查詢區間）時，**一律用 `toDateInputValue(date)`**。

`toISOString()` 會先轉成 UTC，台北時間當天 08:00 前會變成前一天。實際症狀是早上開單據時，
日期欄自動填成昨天。凡是看到 `toISOString().split('T')[0]` 都是 bug，不是風格問題。

快捷區間（今天／本週／本月／上月／近 30 天）用 `dateRange(preset)`，不要自己算月份邊界。
注意 `thisMonth`（月初到今天）與 `currentMonth`（整個月份）用途不同：前者給查詢預設值，後者給月報表。

## 三、金額運算一律經過 `round2()`

浮點數相加會出現尾數，沖帳時比對「分配總額是否剛好等於收款金額」會誤判。
累加、相減、寫回資料庫前，每一步都收斂到分。

## 四、把資料塞進 `innerHTML` 前要 `escapeHtml()`

商品名稱、客戶名稱、備註這些欄位是使用者自由輸入，直接串進 HTML 字串會有 XSS 風險。
目前只有 `statement.js` 有完整處理，其他頁面尚未補齊——**新寫的渲染程式碼請一律跳脫**，
不要沿用鄰近那些還沒修的舊寫法。

## 五、多頁式應用：新增頁面要註冊

新增 HTML 頁面時，必須把檔名補進 `vite.config.mjs` 的 `pages` 陣列。
沒註冊的頁面不會被打包，建置後直接 404。

## 六、測試直連正式資料庫

**這個專案沒有測試資料庫，E2E 測試連的是正式 Supabase。**

`tests/helpers.js` 的 `launch()` 預設攔截所有寫入請求（POST/PATCH/PUT/DELETE 與會改狀態的 RPC）。
除非你完全清楚後果，否則不要傳 `allowWrites: true`——開發期間曾因此在正式環境留下垃圾商品資料。

測試跑的是建置產物，不是開發伺服器：

```bash
npm run build && npm run preview   # 伺服器需在 4173
npm test                           # 另開終端機
```

## 七、資料模型的硬性限制

- **庫存是流水帳**：單據明細即異動紀錄，不可直接改 `stock_qty`。
- **單據不可編輯**：開錯要作廢重開，保留追溯紀錄。已確認的單據只開放改備註。
- **付款狀態是推導值**：由收款紀錄算出，不可直接寫入。
- **報表聚合寫在 SQL function**：前端只取彙總結果並分頁，不要把明細拉到瀏覽器計算。

## 八、環境變數

`VITE_` 開頭的變數會在 build 時內嵌進產物、瀏覽器可見，因此**只放 publishable (anon) key**，
存取控制靠 RLS。`service_role` key 絕對不可出現在前端。

Vercel 上改完環境變數必須重新部署才會生效。

## 九、註解寫「為什麼」

這個專案的註解風格是解釋決策理由與踩過的雷，不是複述程式碼在做什麼。

```js
// 好：說明為什麼不能用另一種寫法
// 不能用 toISOString()：那會先轉成 UTC，台北時間當天 08:00 前會變成前一天。

// 不好：複述程式碼
// 將日期轉為字串
```

修改帶有這類註解的程式碼時，請確認註解描述的前提是否仍然成立，一併更新。
