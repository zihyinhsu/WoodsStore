# 藝境裝潢材料行進銷存 Design System

本文件由 `css/style.css` 既有實作反推整理，記錄的是「目前程式碼實際使用的值」，
而非理想值。新增介面一律沿用本表的 token，需要新 token 時先更新本文件。

## 1. Atmosphere & Identity

一個看得見骨架的工作台。淡米灰底帶細方格紙紋路，所有面板用 2px 實心黑框加上
不帶模糊的硬陰影，像把紙卡釘在工作板上。識別特徵是「硬邊 + 零圓角 + 位移陰影」：
沒有柔化、沒有漸層，資訊密度優先，適合每天長時間盯著看的內部後台。

## 2. Color

### Palette

| 角色 | Token | 值 | 用途 |
|------|-------|-----|------|
| 頁面底色 | `--bg-page` | `#e8e6e1` | body 背景（疊 20px 方格紋） |
| 面板底色 | `--bg-card` | `#f5f4f1` | `.glass-card`、sidebar、modal |
| 主邊框 | `--border-color` | `#1f1f1f` | 面板/按鈕/badge 的 2px 邊框 |
| 次邊框 | `--border-light` | `#c9c6c0` | 表格列分隔線、輸入框邊框 |
| 主文字 | `--text-main` | `#1f1f1f` | 標題、內文 |
| 次文字 | `--text-muted` | `#6b6b6b` | 標籤、輔助說明、空狀態 |
| 主色 | `--primary` | `#c0531f` | 標題前色塊、主按鈕、focus、連結 |
| 主色 hover | `--primary-hover` | `#a04215` | 主按鈕 hover |
| 成功 | `--success` | `#2f855a` | 正向金額、成功按鈕 |
| 成功 hover | `--success-hover` | `#22543d` | 成功按鈕 hover |
| 警告 | `--warning` | `#c05621` | 部分付款等中間狀態 |
| 危險 | `--danger` | `#c53030` | 低庫存、負值、作廢 |
| 危險 hover | `--danger-hover` | `#9b2c2c` | 危險按鈕 hover |

### Badge 配色

| 類別 | 背景 | 文字 |
|------|------|------|
| `.badge-blue` | `#ebf8ff` | `#2b6cb0` |
| `.badge-green` | `#f0fff4` | `#2f855a` |
| `.badge-orange` | `#fffaf0` | `#c05621` |
| `.badge-red` | `#fff5f5` | `#c53030` |
| `.badge-gray` | `#edf2f7` | `#4a5568` |

### Rules

- 主色只用於互動元素與標題色塊，不作裝飾性大面積填色。
- 金額語意固定：收入／正向用 `--success`，支出／負向用 `--danger`，中性用 `--text-main`。
- 不得在元件中寫入未列於本表的 hex，需要新色先擴充本表。

## 3. Typography

### Font Stack

- 主要：`'Noto Sans TC', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`
- 數字強調：`'Bebas Neue', sans-serif`（僅用於 `.stat-value` 這類大字統計值）
- 金額表格：`'Roboto', sans-serif`（目前未載入字重檔，實際 fallback 到系統 sans）

### Scale

| 層級 | 大小 | 字重 | 用途 |
|------|------|------|------|
| 統計值 | `2.25rem`–`3rem` | 400（Bebas） | `.stat-value` |
| h2 | 瀏覽器預設 | 700 | 頁面標題（前置 6px 主色塊） |
| h3 | 瀏覽器預設 | 700 | 卡片標題（前置 6px 主色塊） |
| 內文 | `1rem` | 400 | 表格、表單 |
| 標籤 | `0.9rem` | 600 | `.form-group label` |
| 輔助 | `0.85rem` | 400 | 說明文字、註記 |
| Badge | `0.8rem` | 700 | 狀態標記（大寫） |

### Rules

- 內文不得小於 `0.8rem`。
- 一個頁面最多兩種字體家族（主要 + 數字強調）。

## 4. Spacing & Layout

基準單位 4px，實際以 `rem` 表示。

| Token | 值 | 用途 |
|-------|-----|------|
| 0.25rem | 4px | badge 內距 |
| 0.5rem | 8px | 元素間微距、`.gap-2` |
| 0.75rem | 12px | 輸入框內距 |
| 1rem | 16px | 表格儲存格內距、`.gap-3`、`.mb-3` |
| 1.5rem | 24px | 卡片內距、`.gap-4`、`.mb-4` |
| 2rem | 32px | 統計卡上下內距 |

### Grid

- 內容最大寬度：`1200px`（`.container`）
- 側邊欄：展開 `240px`，收合 `64px`
- 欄位工具類：`.grid-cols-2`、`.grid-cols-3`、`.grid-cols-4`
- 斷點：`1024px`（三欄降為兩欄）、`768px`（全部降為單欄並切換行動版選單）

### Rules

- 間距一律取自上表，不使用未列出的魔術數字。
- 表格橫向溢出一律包 `.table-responsive`。

## 5. Components

### Glass Card（`.glass-card`）

- 結構：`<div class="glass-card">` 內含 `h3` 標題與內容
- 樣式：`--bg-card` 底、2px `--border-color` 邊框、`--shadow-hard` 陰影、`1.5rem` 內距
- 用途：所有頁面區塊的基本容器

### Stat Card（`.stat-card`）

- 結構：`.stat-label`（說明）+ `.stat-value`（數值）
- 變體：純展示；或包成 `a.stat-link` 變可點擊（hover 位移 1px + 加深陰影）
- 狀態：可點擊版本需具 hover 與 `:focus-visible` 外框（已實作於 `css/style.css`）
- 樣式位置：元件樣式統一放在 `css/style.css`。數值顏色由 `.text-success` / `.text-danger` 等 utility class 決定，因此 utility 必須宣告在元件之後，以確保正確的 cascade 覆蓋。
- 用途：總覽頁指標（註：可點擊的 `a.stat-link` 變體目前未使用，保留作為擴充用途）

### Button（`.btn`）

- 變體：`.btn-primary`、`.btn-success`、`.btn-danger`、`.btn-outline`
- 狀態：hover 位移 `translate(-1px,-1px)` 並加深陰影；`:disabled` 降透明度並取消位移
- 尺寸：預設 `0.5rem 1rem`；表格內小按鈕 `0.25rem 0.5rem`

### Tabs（`.tabs` + `.tab-btn`）

- 結構：`<div class="tabs" role="tablist">` 內含數個 `.tab-btn[data-*]`
- 樣式：無背景、底部 3px 主色線標示選取，未選取為 `--text-muted`
- 狀態：hover 轉為 `--text-main`、`.active` 轉主色、具 `:focus-visible` 外框
- 數量標記：`.tab-count` 為危險色小標，數量為 0 時以 `hidden` 隱藏
- 已用於：往來對象（供應商／客戶）、商品管理（所有商品／庫存不足）
- 規則：切換分頁一律重置回第一頁，並同步 `aria-selected`

### Search Bar（日期區間查詢）

- 結構：`.glass-card` 內含兩個 `form-group`（起訖日期）+ 查詢按鈕，以 flex 對齊底部
- 已用於：對帳單、單據管理、總覽成本分析
- 規則：起訖日期需驗證 from ≤ to，錯誤以 toast 呈現

### Analysis Block（`.metric-cards` + `.records-table` + `.date-controls`）

- 用途：modal 內的「分析」版型。上方一排指標卡、下方明細表，最上方為區間工具列
- 結構：
  - `.date-controls`：兩個 `input[type=date]` + 快捷鈕 `.btn-quick-date[data-range]`（對應 `dateRange()` 的 preset）
  - `.metric-cards` → `.metric-card` → `.metric-card-title` / `.metric-card-value` / `.metric-card-subtitle`；
    四張固定並排，負值加 `.negative`（危險色）
  - `.records-table`：modal 內的緊湊表格（`0.75rem` 內距），數字欄加 `.num` 或 `.num-col` 轉等寬 Roboto
- 已用於：商品成本分析（商品管理）、客戶毛利分析（總覽與往來對象共用的 modal）
- 樣式位置：`css/style.css`。這組元件曾各自內聯在 `index.html` / `products.html`，
  第三個使用者出現時就會複製第三份，因此收進共用層
- 規則：寬版 modal 套 `.modal-content--wide`；分頁列必須放在會被重繪的容器之外

### Table

- `th` 下方 2px 主邊框，`td` 下方 1px 次邊框，列 hover 反白 5% 黑
- 空狀態使用 `<td class="empty-state">` 置中說明
- 整列可點（點列開分析 modal）加 `.clickable-row`；列內的按鈕需在 handler 中 `closest()` 排除，
  否則點編輯鈕會同時開兩個 modal

### Badge

- 2px 主邊框 + 2px 硬陰影 + 大寫字，僅用於狀態與類型標記

## 6. Motion & Interaction

| 類型 | 時長 | 曲線 | 用途 |
|------|------|------|------|
| 標準 | `0.2s` | `ease` | `--transition`，按鈕/連結/表格列 |
| 側邊欄 | `0.2s` | `ease` | 寬度與版面位移 |
| Toast | `0.3s` | `ease` | 進場滑入、離場淡出 |

### Rules

- 僅動畫 `transform` 與 `opacity`。
- 所有互動元素需具 hover 與 `:focus-visible` 狀態。
- 已定義 `prefers-reduced-motion` 時移除版面位移動畫，新增動畫需比照處理。

## 7. Depth & Surface

策略：**邊框 + 硬陰影**（不使用模糊陰影、不使用圓角）。

| 層級 | 值 | 用途 |
|------|-----|------|
| 標準 | `4px 4px 0 rgba(31,31,31,0.15)` | 卡片、按鈕、modal |
| Hover | `6px 6px 0 rgba(31,31,31,0.2)` | 按鈕與可點擊卡片 hover |
| Badge | `2px 2px 0 rgba(31,31,31,0.15)` | 狀態標記 |

圓角固定為 `--border-radius: 0`，不得局部引入圓角。
