# 退貨流程實作計畫

> 狀態：規劃完成並已 review（2026-11-13），尚未實作。
>
> **給接手實作的 session：**
> - 先讀專案根目錄 `CLAUDE.md`（utils 複用、`round2`、`escapeHtml`、測試直連正式庫等規則）。
> - 實作順序：① `tests/helpers.js` 的 `WRITE_RPCS` 加入 `create_return_order`（四-1）→
>   ② `sql/patch-030-returns.sql` + `sql/verify-030-returns.sql`（二、四-3）→ ③ 前端（三）→ ④ E2E（四-2）。
> - 文中 `schema.sql:行號`、`payments.js:行號` 以 commit `4d6c487` 為準，動工前先重新核對。
> - 「一、核心設計」的決策都已定案，不需再與 yin 確認；實作中若發現與現有程式衝突再提出。
> 已確認的需求：
> 1. 退貨記在退貨日那一期，收款時直接抵掉（不轉預收、不需先調整原單沖帳）。
> 2. 退貨單價預設帶原價，可往下改，不可高於原價。
> 3. 退貨單需要列印（銷貨退回單）。
> 4. 第一版不做「退現金」：客戶不再進貨時，退貨金額只會掛成負餘額。
> 5. 允許金額 0 元的「沖帳單」，處理退貨剛好抵掉出貨、不收現金的情況（換貨）。
> 6. 退貨可以部分抵扣：退貨大於本次出貨時，系統自動只抵到淨額為 0，剩下的留待下次。
>    （5、6 為 review 後補入，見「一、核心設計／純抵扣與部分抵扣」）

## 一、核心設計

### 單據類型
- 新增 `sale_return`（銷貨退回）、`purchase_return`（進貨退出）。
- 只能從已確認的出貨／進貨單建立，一張退貨單只對應一張原單。
- 不開放草稿，建立即生效；開錯作廢重開。
- 單號用 `RTN-` 開頭，一眼可與一般單據區分。

為什麼另開類型而不用負數量的 `sale`：現有查詢多半寫死 `type in ('sale','purchase')`，
退貨單預設不會被算進去、不會被悄悄算錯；要納入的地方一處一處明確改。

### 連回原單
- `orders.return_of_order_id`：退自哪張原單。
- `order_items.return_of_item_id`：退自原單哪一列。用明細層級連結，是因為同一張單可能有
  同商品不同單價的兩列，要靠它限制每列可退數量並沿用該列的成本快照。

不用 `parent_order_id`：它是分批進出貨的分組鍵（`guard_order_parent`），只允許兩層、同類型、
已有接續單的原單不能再被接續；退貨用它還會被 `search_order_groups` 算進同一組的合計。

### 正負號：錢往哪個方向就用哪個正負號

| | 出貨單 | 銷貨退回 | 進貨單 | 進貨退出 |
|---|---|---|---|---|
| 明細 `qty`（庫存） | − | **+** | + | **−** |
| `order_total_view.order_total` | + | **−** | + | **−** |
| 沖帳 `payment_orders.amount` | + | **−** | + | **−** |

照這個正負號一路加總，客戶餘額、對帳單、收款淨額自然正確，不需要每處各自判斷「是不是退貨」。

### 當期抵扣
- 退貨記在退貨日那一期；原單的金額與收款狀態都不動。
- 收款時把退貨單與出貨單一起勾選：出貨 1,000、退貨 −300，收款金額即 700。
- 原單在退貨前已收清也一樣：退貨單留在未抵扣清單，下次收款勾選抵掉。
- 退貨單抵完顯示「已抵扣」。

### 純抵扣與部分抵扣（0 元沖帳單）
換貨時出貨 300、退貨 −300，淨額 0，沒有現金進出。現行 `payments.amount > 0`、
`save_payment_with_allocations` 擋 `p_amount <= 0`，這種情況永遠沖不掉，兩張單會一直掛在未收清單。
- 放寬為 `payments.amount >= 0`；**金額為 0 時，分配必須非空且淨額恰為 0**，否則 `PAYMENT_AMOUNT_INVALID`。
  不開放無分配的 0 元收款：那只是一筆沒有意義的空紀錄。
- 一筆收款的分配淨額規則統一為 `0 ≤ 淨額 ≤ 收款金額`，前後端同一個定義：
  - 淨額 < 0 → `ALLOCATION_NET_NEGATIVE`（退貨抵超過出貨，多出來的負數無處可去）。
  - 收款金額 > 淨額的差額照現行規則列為預收（含完全不分配的預收款），不另外擋，維持既有行為。
- 退貨可以部分抵扣，金額由系統自動算，不開放手動輸入：
  - 勾選的退貨合計超過勾選的出貨時，**依勾選順序**從最後勾的那張退貨往回調低分配，讓淨額剛好為 0。
    使用者不必自己算哪些能一起勾，淨額 ≥ 0 也就恆成立。
  - 被調低的退貨列標示「本次抵 −150，剩 −150 待抵」；剩餘額度留在未抵扣清單，下次收款再勾。
  - 取消勾選任何一列時重新計算，被調低的退貨可能恢復成整張抵扣。
  - 範例：出貨 B +150、退貨 R −300 → R 自動調為 −150，淨額 0，存成 0 元沖帳單；R 剩 −150。
    之後出貨 D +500 → 勾 D＋R（−150），收現金 350，R 結清。
- DB 端不需要為部分抵扣另外改：驗證本就只要求分配絕對值不超過單據金額。

### 成本
退貨明細的 `unit_cost` 沿用原單那一列的成本快照，毛利剛好反向沖回，
不會因退貨當天均價不同而產生差額。

## 二、SQL：`sql/patch-030-returns.sql`（可重複執行），同步更新 `schema.sql`

### 2.1 Schema
- `orders.type` 的 check 加入兩種新類型。
- 新增兩個連結欄位，各建 partial index（`where … is not null`）。
- check：退貨單一定要有 `return_of_order_id`，其他類型一定不能有。
- `payment_orders_amount_positive`（amount > 0）改為 amount ≠ 0；正負號是否與單據類型相符交給 2.4 的 trigger。
- `payments.amount` 的 check 由 `> 0` 改 `>= 0`（0 元沖帳單，見一、純抵扣）。
- `idx_orders_sale_confirmed`（partial index，只涵蓋 `type = 'sale'`）：`statement_line_view` 改成
  `type in ('sale','sale_return')` 後可能用不到它，改為涵蓋兩種類型，上線後用 `explain` 確認。

### 2.2 新 RPC：`create_return_order`
```
create_return_order(p_original_order_id, p_items[{item_id, qty, unit_price}],
                    p_order_date, p_discount, p_tax, p_note) returns uuid
```
- `for update` 鎖住原單，避免兩人同時退同一張而超退。
- 原單必須是已確認的 `sale` 或 `purchase`，且有往來對象。
- 每列檢查：
  - `item_id` 必須屬於這張原單。
  - 退貨數量 > 0，且 ≤ 原數量 − 已退數量（作廢的退貨不算）→ `RETURN_QTY_EXCEEDS`。
  - 0 ≤ 單價 ≤ 原單價 → `RETURN_PRICE_EXCEEDS`。
  - 明細折扣 % 沿用原單，不可改。
- 進貨退出檢查庫存：不能退掉已賣出的貨 → `RETURN_STOCK_INSUFFICIENT`。
  與 `create_order` 一致，檢查的是「目前庫存」而非退貨日當時的庫存。
- 退貨日不可早於原單日期 → `RETURN_DATE_INVALID`。否則作廢檢查與報表的時間序會錯亂。
- 整單折讓、稅額 ≥ 0，退貨單淨額 ≥ 0。
- 整單折讓、稅額各自的「歷次有效退貨合計」不可超過原單的值 → `RETURN_AMOUNT_EXCEEDS`。
  單價上限只管得住明細，多次退貨仍可能把稅額退得比原單還多。
- 往來對象與原單相同；`unit_cost` 沿用原單那一列。

### 2.3 既有函式
| 物件 | 修改 |
|---|---|
| `void_order` | 原單還有有效退貨單不可作廢（`ORDER_HAS_RETURNS`）。作廢銷貨退回單要檢查庫存（貨可能已再賣出）。退貨單已抵扣過的，現有 `ORDER_HAS_ALLOCATIONS` 會擋 |
| `purchase_avg_cost_asof` | 計入進貨退出：Σ帶正負號金額 ÷ Σ帶正負號數量。全部退光時分母為 0 回 null，交呼叫端 fallback。`subtotal` 是 `abs(qty)` 算出的生成欄位、恆為正，正負號必須依 `orders.type` 補上。退貨價低於原進價時，差額會攤進剩餘庫存的均價——這是刻意的（供應商少退的錢就是剩下那些貨的成本），不是 bug |
| `create_order` | 不改。類型檢查本就擋掉退貨單，只能經新 RPC 建立 |

### 2.4 收付款
| 物件 | 修改 |
|---|---|
| `order_total_view` | 退貨單 `order_total` 為負數 |
| `save_payment_with_allocations` | 分配金額檢查由 `<= 0` 改為 `= 0` 才擋（`schema.sql:1174`），否則退貨分配在 RPC 就被退回。`p_amount` 改為允許 0（0 元沖帳單），是否合法交給 trigger 依淨額判斷 |
| `validate_payment_order_allocations` | 允許沖退貨單。方向：客戶沖 sale／sale_return，供應商沖 purchase／purchase_return。分配正負號須與單據一致，絕對值不可超過單據金額。淨額規則 `0 ≤ 淨額 ≤ 收款金額`（淨額 < 0 → `ALLOCATION_NET_NEGATIVE`）；收款金額為 0 時分配必須非空且淨額 = 0 |
| `guard_order_total_against_allocations` | 金額比較改用絕對值 |
| `order_payment_summary_view` | 納入兩種退貨類型；退貨單 `outstanding_amount` 用 `least(…, 0)`（負數）。`paid_amount` 對退貨單為負數，現行 `<= 0 then 'unpaid'` 會讓退貨單永遠未抵扣，狀態改為：`abs(paid) = 0` → unpaid、`abs(paid) < abs(total)` → partial、其餘 paid |
| `outstanding_order_view` | `type in ('sale','sale_return') and outstanding_amount <> 0` |
| `partner_balance_view`、`get_partner_balances` | 加總時納入 sale_return／purchase_return（帶正負號） |
| `search_order_groups` | 組付款狀態推導改用絕對值。退貨單不會被歸組（parent 為 null） |
| `payment_allocation_view` | 確認 `order_total` 改為負數後的顯示 |

### 2.5 報表與成本（全部未稅、已扣分攤折讓，口徑不變）
- `product_movement_base`：納入退貨單，退貨列的 `qty`、`subtotal`、折讓分攤為負數；尾端追加 `flow`（sale/purchase）。
  - **折讓分攤的正負號要小心**：若 `subtotal` 帶號後直接套現行算式 `discount * subtotal / sum(subtotal)`，
    分子分母同為負，結果變正數，`subtotal − alloc` 會從應有的 −900 算成 −1100。
    寫法：比例用絕對值算（`discount * abs(subtotal) / sum(abs(subtotal))`），最後再乘單據正負號。
- 下列函式篩選從 `m.type = 'sale'` 改為 `m.flow = 'sale'`，退貨自動扣掉：
  - `product_movement`
  - `product_cost_detail_summary`
  - `cost_trend`
  - `partner_profit`（`order_count`、`last_sale_date` 仍只算 `type = 'sale'`，否則最後出貨日會變成退貨日）。
    只有退貨、沒有出貨的客戶會以負毛利出現在清單——保留，因為那就是該期的真實毛利；
    同步更新函式註解「只回期間內有出貨的客戶」為「有出貨或退貨」。
  - `partner_profit_products`
- `dashboard_summary`：revenue／expense 計入退貨單（負數）。它的 `order_totals` 是自己從 `subtotal` 算，
  不讀 `order_total_view`，正負號要在這裡另外補。
- `product_cost_movements`：不過濾類型，`qty` 本就帶號；但 `subtotal` 恆為正，退貨列改為輸出負數，
  與 `product_movement_base` 同口徑。

### 2.6 對帳單與單據搜尋
- `statement_line_view`：納入 sale_return，`qty`、`subtotal` 為負數；尾端追加 `type` 供前端標「退貨」。`statement_summary` 自動算對。
- `order_search_view`：尾端追加 `return_of_order_id`、`return_of_order_no`（列印用）、`return_count`（原單已退幾張）；`search_text` 併入原單號，搜原單號會一併撈出退貨單。另有兩處既有欄位要改：
  - `total_amount` 是自己從 `subtotal` 算的（不讀 `order_total_view`），退貨單要改為負數；`search_order_groups` 的組合計也靠它。
  - `payment_status` 只對 `type in ('sale','purchase')` 給值，要納入兩種退貨類型，否則列表顯示不出「未抵扣／已抵扣」。

## 三、前端

### 單據頁（`orders.html`、`js/orders.js`、新增 `js/order-return.js`）
- 退貨按鈕：已確認的進貨或出貨單才顯示，含分批單展開後的每一批。邏輯放在新模組 `order-return.js`（`orders.js` 已逾千行）。
- 退貨 modal：
  - 每列：品名、原數量、已退、可退、退貨數量、單價（預設原價、上限原價）、小計。
  - 整單折讓與稅額依退貨比例預帶，可手改。
  - 計算一律 `round2`。
- 列表：類型篩選加兩種退貨；徽章銷貨退回紅色、進貨退出橘紅；收款標籤顯示「未抵扣／部分抵扣／已抵扣」。
- 明細互連：原單顯示「已退 N 張」，退貨單顯示「退自 ORD-xxx」。

### 列印
- `shippingSlipHtml`（`js/orders.js`）改為共用的 `slipHtml(…, kind)`，出貨單輸出保持一模一樣。
- 只印銷貨退回單（給客戶簽收）；進貨退出不印，與進貨單一致。

| 欄位 | 出貨單 | 銷貨退回單 |
|---|---|---|
| 標題 | 出貨單 | 銷貨退回單 |
| 日期欄 | 出貨日期 | 退貨日期 |
| 單號區 | 單號 | 單號＋原出貨單號 |
| 合計列 | 明細合計 | 退貨合計（印正數，避免客戶誤會成要付錢） |
| 應收餘額 | 列印當下餘額 | 同左（已扣這張退貨；補印舊單時是當下餘額，與出貨單行為一致） |
| 簽收 | 客戶簽收 | 客戶簽收（確認退回品項） |

- `printButton`、勾選列印、`printShippingOrders` 納入 `sale_return`；出貨單與退貨單可混選一起印，各用自己的格式。

### 收款頁（`js/payments.js`）
- `.gt('outstanding_amount', 0)` 改 `.neq(…, 0)`（`payments.js:777`），退貨單才出現在可勾選清單，金額紅字負數。
  收款、付款共用這段，進貨退出會一併出現。
- 會受正負號影響的比較全部逐一改（以 `!== 0` 或絕對值判斷），不只舊制過濾一處：
  - `:606` 判斷舊制分配的 `allocated > 0 && allocated < allocatable`。**這條必須排除退貨單**：
    部分抵扣的退貨本來就是「有分配但沒分配滿」，若改成絕對值比較而不排除，
    含部分抵扣的收款會被誤判為舊制分配，整筆鎖成唯讀、無法編輯。
  - `:630`、`:641` 勾選金額與勾選狀態
  - `:820` 舊制收款過濾 `allocated > 0`
  - `:902` 金額 > 0 的分支
- 部分抵扣的自動計算（見一、純抵扣與部分抵扣）：記錄勾選順序，每次勾選／取消勾選都重算退貨列的分配金額。
  編輯既有收款時，退貨列帶回的是當時存的分配金額，可動用上限為「剩餘待抵 + 這筆收款原本的分配」，與出貨單的 `allocatable` 算法相同。
- 淨額規則（與 DB 同一個定義，見一、純抵扣與部分抵扣）：
  - 自動計算後淨額不會 < 0；DB 的 `ALLOCATION_NET_NEGATIVE` 只是兜底。
  - 淨額 = 0 且有勾選 → 以 0 元沖帳單送出，收款方式欄位隱藏，送出前確認「本次不收現金，僅以退貨抵扣」。
- 收款收據（讀 `statement_line_view`）確認退貨列顯示正確；0 元沖帳單的收據標題改為「沖帳單」。

### 其他頁面
- `js/ui.js` 錯誤對照表加入：`RETURN_QTY_EXCEEDS`、`RETURN_PRICE_EXCEEDS`、`RETURN_STOCK_INSUFFICIENT`、`RETURN_DATE_INVALID`、`RETURN_AMOUNT_EXCEEDS`、`ORDER_HAS_RETURNS`、`ALLOCATION_NET_NEGATIVE`。
- `js/statement.js`：退貨列加標籤、負數顯示。
- `js/products.js`：進出明細徽章補兩種新類型。
- 總覽、客戶毛利頁不改程式，只核對數字。
- 新渲染內容一律 `escapeHtml`。

## 四、測試與驗證
1. **最先做**：`create_return_order` 加進 `tests/helpers.js` 的 `WRITE_RPCS`，否則測試會在正式資料庫真的建立退貨單。
2. E2E：新增 `orders-return.test.cjs`
   - 退貨按鈕只出現在正確的單據上。
   - 可退數量計算正確、單價不可超過原價。
   - 送出的 payload 正確。
   - 退貨單列印版面正確，出貨單列印版面未被改動。
   - 收款頁：勾選含退貨的淨額計算、淨額 = 0 走 0 元沖帳單。
   - 部分抵扣：出貨 +150、退貨 −300 → 退貨自動調為 −150、顯示「剩 −150 待抵」；取消勾選出貨後退貨恢復；
     勾兩張退貨時從最後勾的那張調。
   - 編輯一筆「含部分抵扣退貨」的既有收款：退貨列帶回當時的分配金額、可動用上限正確、**不被誤判為舊制分配而鎖住**。
3. SQL 驗證腳本 `sql/verify-030-returns.sql`，整份包在 `begin … rollback`：
   - 涵蓋超退、超價、退貨日早於原單、多次退貨稅額超過原單、進貨退出防超賣、作廢限制、收款淨額、餘額與毛利數字。
   - 一筆**有整單折讓**的退貨：驗證 `product_movement` 的退貨淨額是 −900 而非 −1100。
   - 0 元沖帳單：淨額 0 可存；無分配或淨額 ≠ 0 被擋。
   - 部分抵扣：同一張退貨分兩筆收款抵完，`order_payment_summary_view` 依序為 partial → paid；
     兩筆合計超過退貨金額被擋（`ALLOCATION_EXCEEDS_ORDER`）。
   - 退貨單在 `order_search_view` 的 `total_amount` 為負、`payment_status` 有值。
   - 測試用商品、客戶要明確指定 `sku`、`partner_no`：rollback 不會歸還 sequence 已取的號碼，否則正式環境編號會跳號。

## 五、上線順序
1. SQL Editor 執行 patch-030，再跑驗證腳本。舊前端不受影響：收款頁用 `> 0` 篩選看不到退貨單，退貨單也只能從新前端建立。
2. 部署前端。
3. 更新 `README.md` 功能清單；`CLAUDE.md` 第七節補一條：退貨單金額為負、只能經 `create_return_order` 建立。

## 注意事項
- `order_total` 語意改變：退貨單為負數。所有讀這個欄位的地方（2.4 所列及 `payment_allocation_view`）都要逐一檢查。
- `order_items.subtotal` 是 `abs(qty)` 算出的生成欄位、恆為正。凡是不經 `order_total_view`、自己從
  `subtotal` 加總的地方（`order_search_view.total_amount`、`dashboard_summary`、`product_movement_base`、
  `purchase_avg_cost_asof`、`product_cost_movements`），正負號都要各自依 `orders.type` 補上。實作時用
  `grep -n "subtotal" sql/schema.sql` 逐一核對，不要只靠本計畫的清單。
- `payments.amount` 可以是 0 了：讀收款金額做除法或判斷「有沒有收款」的地方要確認不受影響。
- 退現金未做：等實際有需求再補退款功能。
