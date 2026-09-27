# 資料庫備份與還原

每天由 Synology NAS 排程執行：把正式資料庫備份成檔案存在 NAS（永久保留），
並用同一份備份刷新 dev 資料庫。

## 架構

```
Synology NAS（任務排程器，每日）
  │
  ├─ 1. pg_dump 正式庫 ──> /volume1/backup/inventory/prod-YYYY-MM-DD_HHMMSS.sql.gz
  │                        （永久保留，不自動刪除）
  │
  └─ 2. 用剛產出的備份 ──> 還原到 Supabase dev 專案
                           （dev 每天被清空重灌）
```

備份用 Docker 跑 `pg_dump`，不在 NAS 安裝 PostgreSQL。原因是 `pg_dump`
拒絕匯出比自己新的伺服器版本，而 Synology 套件庫的版本不一定跟 Supabase 一致。
腳本會先查伺服器版本再取用對應的 `postgres:<版本>-alpine` 映像，
Supabase 日後升級 PostgreSQL 時不需要改腳本。

## 檔案

| 檔案 | 用途 |
|---|---|
| `scripts/nas-daily.sh` | 排程器唯一要呼叫的入口，串起備份與 dev 刷新 |
| `scripts/backup-prod.sh` | 備份正式庫到 NAS，含完整性驗證 |
| `scripts/refresh-dev.sh` | 還原到 dev，含三道防誤刪防護 |
| `scripts/lib-common.sh` | 共用函式（版本偵測、密碼遮蔽） |
| `scripts/backup.env` | 你的連線設定（含密碼，不進版控） |

## 安裝步驟

### 1. NAS 安裝 Container Manager

套件中心 → 搜尋 Container Manager → 安裝。腳本需要 Docker 才能執行 `pg_dump`。

### 2. 建立備份資料夾

File Station → 建立共用資料夾，例如 `backup`，底下建 `inventory`。
記下完整路徑，通常是 `/volume1/backup/inventory`。

### 3. 把專案放到 NAS

把這個專案（至少 `scripts/` 目錄）複製到 NAS 上，例如 `/volume1/scripts/inventory-app`。

### 4. 建立設定檔

複製範本並填值：

```bash
cp scripts/backup.env.example scripts/backup.env
chmod 600 scripts/backup.env
```

`chmod 600` 不可省略：這個檔含資料庫密碼，預設權限會讓 NAS 上其他帳號讀到。

要填的值只有三個（第三個選填）：

| 變數 | 從哪裡取得 |
|---|---|
| `PROD_DB_URL` | Supabase → 正式專案 → 上方 **Connect** → 選 **Session pooler** → 整串複製 |
| `BACKUP_DIR` | 步驟 2 建的路徑，例如 `/volume1/backup/inventory` |
| `DEV_DB_URL` | 同上，但選 dev 專案。留空則只做備份、不刷新 dev |

連線字串有兩個容易出錯的地方：

**必須選 Session pooler（port 5432）。** Transaction pooler（6543）官方明載
不支援 prepared statements，`pg_dump` 會失敗。Direct connection
（`db.xxx.supabase.co`）在多數專案是 IPv6-only，家用網路通常連不到。

**密碼含特殊字元要做 URL 編碼。** 複製回來的字串裡 `[YOUR-PASSWORD]`
要換成資料庫密碼（不是你登入 Supabase 的密碼，在 Settings → Database 可重設）。
若密碼含這些字元必須轉換，否則連線字串會被解析錯誤：

| 字元 | 改寫成 |
|---|---|
| `@` | `%40` |
| `/` | `%2F` |
| `#` | `%23` |
| `?` | `%3F` |
| `:` | `%3A` |
| `&` | `%26` |

最省事的做法是重設一個只含英數字的密碼。

### 5. 先手動跑一次

不要直接設排程就當作好了。先手動確認能跑：

```bash
sudo bash /volume1/scripts/inventory-app/scripts/nas-daily.sh
```

要看到各表筆數與「備份完成」。若失敗，錯誤訊息會指出是連線、版本還是權限問題。

第一次執行也是驗收，請一併完成下方「尚未驗證的部分」的檢查清單。

### 6. 設定排程

控制台 → 任務排程器 → 新增 → **排定的任務** → **使用者定義的指令碼**

| 欄位 | 值 |
|---|---|
| 一般 → 使用者 | `root`（需要 Docker 權限） |
| 排程 | 每天，時間自選（例如 03:00） |
| 任務設定 → 執行指令 | `bash /volume1/scripts/inventory-app/scripts/nas-daily.sh` |
| 任務設定 → 傳送執行詳細資料 | 勾選，並設定收件信箱 |

**「傳送執行詳細資料」要勾。** 備份的價值在於「真的有跑」，
沒有通知就無法察覺它哪天開始失敗。

## 尚未驗證的部分

腳本在 2026-09-27 以兩個本機 `postgres:17` 容器做過端對端測試：prod 載入
`sql/schema.sql` 並灌入測試資料，然後實際執行備份、還原到 dev，
再比對筆數與權限。

**已驗證（本機）**

- 備份與還原後各表筆數一致
- 還原後 dev 與 prod 的權限與結構指標一致：authenticated 可讀寫、
  anon 讀資料表與 view 都被拒、RLS 6 張表、policy 6 條、trigger 4 個、
  trgm 索引 2 個、取號序列值
- view、RPC 可以執行，新增客戶時 trigger 仍會自動取號
- 同一份備份連續還原兩次都成功
- dev 連不上時，備份照樣完成並正常退出
- 鎖機制、log 中不含明文密碼、各項防誤刪防護

**尚未驗證（需在第一次真實執行時確認）**

測試環境是一般 PostgreSQL，不是 Supabase。Supabase 有自己的角色與權限設定，
以下幾項在本機無法重現：

| # | 項目 | 風險 | 怎麼確認 |
|---|---|---|---|
| 1 | 還原時的 `ALTER DEFAULT PRIVILEGES` | Supabase 由 `supabase_admin` 替 public 設定預設權限。dump 若帶出 `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ...`，用 `postgres` 還原時可能因權限不足報錯，整筆回滾，**dev 刷新每天失敗**。這是目前風險最高的一項 | 第一次 dev 刷新成功就代表沒問題；失敗時看錯誤是否提到 `default privileges` |
| 2 | `drop schema public cascade` 的權限 | Supabase 的 `postgres` 不是 superuser，不確定能否 drop public schema | 同上，dev 刷新是否成功 |
| 3 | 還原後 authenticated 對 schema 的 USAGE 權限 | 本機測試沒有檢查這一項。缺少的話，dev 前端登入後會全部 permission denied | 在 dev 的 SQL Editor 執行下方查詢 |
| 4 | 透過 Session pooler 執行 `pg_dump` | 研究結果顯示可行，但沒有實際連線測試過 | 第一次備份成功即可確認 |
| 5 | Synology 上的執行環境 | 排程器的 PATH、DSM 的 bash 對 `tee` 和 process substitution 的支援、root 的 docker 權限 | 手動執行成功後，再讓排程實際跑一次並確認收到通知信 |
| 6 | 還原到正式庫的流程 | 從未執行過 | 先對 dev 演練一次 |

dev 第一次刷新成功後，在 **dev 專案**的 SQL Editor 執行：

```sql
select has_schema_privilege('authenticated','public','USAGE')         as schema_usage, -- 應為 true
       has_table_privilege('authenticated','public.orders','SELECT')  as can_read,     -- 應為 true
       has_table_privilege('anon','public.orders','SELECT')           as anon_read;    -- 應為 false
```

接著用 dev 環境的前端登入（需先在 dev 專案建立帳號），確認商品列表、
單據列表、總覽報表都能正常顯示。**做到這一步才算真正驗收。**

**已知限制**

- **dev 單據數門檻會在正式資料成長後擋下刷新。** 第三道防護會檢查目標庫的
  單據數，但 dev 本來就是正式庫的複本，兩者筆數相同，所以這道防護實際上分辨不出
  兩者。等正式庫單據超過 5000 筆，dev 刷新就會開始被擋。到時請在 `backup.env`
  調高 `ALLOW_DEV_ORDERS`。真正有效的防護是前兩道（連線身分比對、project ref 比對）
- **不含登入帳號**（見下節），這是刻意的取捨，不是缺漏

## 備份涵蓋什麼

只備份 `public` schema，也就是全部業務資料：商品、往來對象、單據、
單據明細、收款、收款沖帳，以及所有 view、function、trigger、RLS policy、
取號序列的目前值，和 `authenticated` / `anon` 的授權設定。

授權一定要跟著備份走：`schema.sql` 撤掉 anon、只開放 authenticated，
這就是整個系統的存取控制。少了它，還原出來的庫登入後會全是 permission denied。

**不含登入帳號（`auth` schema）。** 還原後需在 Supabase Dashboard 重新建立
員工帳號。這是刻意的取捨：帳號重建只要幾分鐘，而單據與庫存流水帳重建不回來。
另外還原到不同專案時 JWT secret 不同，原有的登入 token 一律失效，
帳號即使還原也得重新登入。

## 還原

### 還原到 dev（日常）

排程每天自動做。要手動觸發：

```bash
cd /volume1/scripts/inventory-app
DEV_DB_URL='<dev 連線字串>' \
PROD_DB_URL='<正式連線字串>' \
ARCHIVE=/volume1/backup/inventory/prod-2026-09-27_030000.sql.gz \
CONFIRM_OVERWRITE_DEV=yes \
  bash scripts/refresh-dev.sh
```

`CONFIRM_OVERWRITE_DEV=yes` 是必要的：這支腳本會清空目標資料庫，
不接受「預設就覆寫」。

### 還原到正式庫（災難復原）

**這是破壞性操作，只在正式資料真的毀損時執行。**

`refresh-dev.sh` 有防護會拒絕對正式庫執行，這是刻意的。真的要還原正式庫時，
手動執行以下步驟，每一步都先確認：

```bash
# 1. 先確認要還原哪一份，並檢查它的內容
gzip -dc prod-2026-09-27_030000.sql.gz | head -40
gzip -dc prod-2026-09-27_030000.sql.gz | grep -c '^COPY '

# 2. 還原前先備份「現在的」狀態，即使它是壞的
#    弄錯還原方向時，這是唯一能回頭的路
PROD_DB_URL='<正式連線字串>' BACKUP_DIR=/volume1/backup/inventory \
  bash scripts/backup-prod.sh

# 3. 還原（single-transaction：任一句失敗即整筆回滾，不會留下半毀狀態）
#    前三行與 refresh-dev.sh 相同：先清空 public、補裝 pg_trgm，
#    並把 dump 的 CREATE SCHEMA public 改成 IF NOT EXISTS。
#    直接灌 dump 會失敗在「schema "public" already exists」。
#    映像版本要與伺服器一致（backup.log 裡「伺服器 PostgreSQL 主版本」那行）。
{
  echo 'drop schema if exists public cascade;'
  echo 'create schema public;'
  echo 'create extension if not exists pg_trgm with schema public;'
  gzip -dc prod-2026-09-27_030000.sql.gz \
    | sed 's/^CREATE SCHEMA public;$/CREATE SCHEMA IF NOT EXISTS public;/'
} | docker run --rm -i postgres:17-alpine psql '<正式連線字串>' \
  --single-transaction --variable ON_ERROR_STOP=1
```

步驟 2 不可跳過。還原是覆寫，跳過這步就沒有退路了。

⚠️ 這個流程**從未對真正的 Supabase 執行過**（見下方「尚未驗證的部分」）。
建議先用同樣指令對 dev 演練一次，確認可行後再用於正式庫。

## 定期演練

**沒有實測過還原的備份不算備份。** 建議每季做一次：

1. 挑一份舊備份還原到 dev
2. 開 dev 環境的前端，確認商品清單、單據列表、報表都正常
3. 抽查幾筆單據的金額與明細

dev 每天都會被刷新，所以這個演練本身就是日常在跑 —— 只要
dev 環境用起來正常，就代表備份是可還原的。這也是把 dev 刷新
排進每日流程的附帶價值。

## 保留策略

NAS 上的備份**永久保留**，腳本不刪任何檔案。

以這個專案的資料量估算，一份壓縮後約數百 KB 到數 MB，一年約 1GB 以下，
對 NAS 不構成負擔。要清理時請手動，並先確認要留的那幾份還在
（備份腳本一旦有刪除邏輯，寫錯一次就會把所有歷史一起帶走，
因此刻意不做自動清理）。

## 故障排除

| 訊息 | 原因與處理 |
|---|---|
| `找不到 docker` | NAS 未安裝 Container Manager |
| `docker 存在但無法連線` | 排程的使用者不是 root |
| `無法取得伺服器版本` | 連線字串錯誤，或用了 Transaction pooler（6543）。改用 Session pooler（5432） |
| `備份中止：dump 缺少預期的資料表` | 連到了錯誤的資料庫 |
| `備份中止：dump 沒有任何 COPY 區塊` | 只匯出了結構沒有資料，通常是權限問題 |
| `拒絕執行：DEV_DB_URL 與 PROD_DB_URL 指向同一個資料庫` | `backup.env` 的 `DEV_DB_URL` 填成正式庫了 |
| `拒絕執行：DEV_DB_URL 內含正式庫的 project ref` | 同上，連線字串的使用者名稱 `postgres.<ref>` 是正式專案的 |
| `拒絕執行：目標庫已有 N 筆單據` | 目標看起來不像 dev。確認無誤可調高 `ALLOW_DEV_ORDERS` |
| `已有另一份備份正在執行` | 上次異常中斷留下鎖目錄，手動刪除 `<備份目錄>/.lock` |

日誌在 `<備份目錄>/backup.log`，會累積每次執行的完整輸出。
連線字串在日誌中的密碼部分會被遮成 `****`。
