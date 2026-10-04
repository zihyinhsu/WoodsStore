# 資料庫備份與還原

每天台灣時間 12:00、18:00 由 Synology NAS 排程執行：把正式庫與 dev 庫
各 dump 一份，上傳到 NAS 上的 S3（rustfs），保留 7 天。

## 架構

```
Synology NAS（任務排程器，每天 12:00、18:00）
  │
  ├─ 1. pg_dump 正式庫 ─┐
  ├─ 2. pg_dump dev 庫 ─┤─> 本機驗證 ─> s3://yijing/inventory/prod-YYYY-MM-DD_HHMMSS.sql.gz
  │                     │              s3://yijing/inventory/dev-YYYY-MM-DD_HHMMSS.sql.gz
  │                     │              （上傳後核對大小，成功才刪本機那份）
  │
  ├─ 3. 用正式庫刷新 dev（REFRESH_DEV_FROM_PROD=yes 時）
  │
  └─ 4. 刪除 S3 上超過 7 天的備份（只清本次備份成功的那個庫）
```

備份用 Docker 跑 `pg_dump`，不在 NAS 安裝 PostgreSQL。原因是 `pg_dump`
拒絕匯出比自己新的伺服器版本，而 Synology 套件庫的版本不一定跟 Supabase 一致。
腳本會先查伺服器版本再取用對應的 `postgres:<版本>-alpine` 映像，
Supabase 日後升級 PostgreSQL 時不需要改腳本。上傳 S3 同樣用 Docker 跑
`amazon/aws-cli`，NAS 上不需要另外安裝任何東西。

⚠️ **S3 與 NAS 是同一台機器。** 這份備份防的是「資料庫被改壞、誤刪、
Supabase 出狀況」，防不了 NAS 本身故障。要防 NAS 整台壞掉，需要另外用
Hyper Backup 等方式把 bucket 的資料同步到 NAS 以外的地方。

## 檔案

| 檔案 | 用途 |
|---|---|
| `scripts/nas-daily.sh` | 排程器唯一要呼叫的入口，串起所有步驟 |
| `scripts/backup-db.sh` | 備份一個庫（prod 或 dev）並上傳 S3，含完整性驗證 |
| `scripts/fetch-backup.sh` | 列出或下載 S3 上的備份，還原前使用 |
| `scripts/refresh-dev.sh` | 把備份還原到 dev，含三道防誤刪防護 |
| `scripts/lib-common.sh` | 共用函式（版本偵測、密碼遮蔽、S3 存取、過期清理） |
| `scripts/backup.env` | 你的連線設定（含密碼與金鑰，不進版控） |
| `scripts/work/` | 本機暫存：上傳前的備份檔、`backup.log`（不進版控） |

## 安裝步驟

### 1. 確認 NAS 已安裝 Container Manager

腳本需要 Docker 才能執行 `pg_dump` 與 `aws-cli`。
套件中心 → 搜尋 Container Manager → 安裝（已裝可跳過）。

### 2. 準備 S3 金鑰

在 rustfs 管理介面（`http://<NAS>:9001`）確認 bucket（`yijing`）存在，
並建立一組只能存取這個 bucket 的金鑰，權限需要**讀、寫、列出、刪除**
（刪除用於清掉超過 7 天的備份）。

### 3. 把腳本放到 NAS

```bash
# 在 /volume1 底下建目錄需要 root
ssh -t nas 'sudo mkdir -p /volume1/scripts/inventory-app && sudo chown yin /volume1/scripts/inventory-app'

# NAS 沒開 scp／rsync，用 tar 經 ssh 傳
cd <專案目錄>
tar -cf - scripts | ssh nas 'tar -xf - -C /volume1/scripts/inventory-app'
```

### 4. 建立設定檔

```bash
ssh nas
cd /volume1/scripts/inventory-app/scripts
cp backup.env.example backup.env
chmod 600 backup.env
vi backup.env
```

`chmod 600` 不可省略：這個檔含資料庫密碼與 S3 金鑰，預設權限會讓 NAS 上其他帳號讀到。

要填的值：

| 變數 | 從哪裡取得 |
|---|---|
| `PROD_DB_URL` | Supabase → 正式專案 → 上方 **Connect** → 選 **Session pooler** → 整串複製 |
| `DEV_DB_URL` | 同上，但選 dev 專案。留空則只備份正式庫 |
| `S3_ACCESS_KEY`／`S3_SECRET_KEY` | 步驟 2 建立的金鑰 |
| `S3_ENDPOINT`／`S3_BUCKET`／`S3_PREFIX` | 範本已填好（`http://127.0.0.1:9000`、`yijing`、`inventory`），通常不用改 |
| `REFRESH_DEV_FROM_PROD` | 範本為 `yes`：每次備份後用正式庫覆寫 dev（見「還原」一節） |

`S3_ENDPOINT` 要用 `127.0.0.1:9000` 直連，不要填 `https://files.nildev.net`：
那條會出網路經 Cloudflare 再繞回同一台 NAS，且 Cloudflare 免費方案單次上傳上限 100MB。

資料庫連線字串有兩個容易出錯的地方：

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
ssh -t nas 'sudo bash /volume1/scripts/inventory-app/scripts/nas-daily.sh'
```

要看到兩個庫的各表筆數、「已上傳：s3://…（大小核對一致）」，
最後一行是「S3 上現有備份：正式庫 N 份，dev N 份」。
第一次執行會下載 `postgres` 與 `aws-cli` 映像，會比較久。

確認 S3 上真的有檔案：

```bash
ssh -t nas 'sudo bash /volume1/scripts/inventory-app/scripts/fetch-backup.sh'
```

### 6. 設定排程（每天 12:00、18:00）

先設定 Email 通知：控制台 → 通知設定 → 電子郵件。

再到 控制台 → 任務排程器 → 新增 → **排定的任務** → **使用者定義的指令碼**：

| 欄位 | 值 |
|---|---|
| 一般 → 使用者 | `root`（需要 Docker 權限） |
| 排程 → 執行日期 | 每日 |
| 排程 → 首次執行時間 | `12:00` |
| 排程 → 頻率 | 每 6 小時 |
| 排程 → 最後執行時間 | `18:00` |
| 任務設定 → 執行指令 | `bash /volume1/scripts/inventory-app/scripts/nas-daily.sh` |
| 任務設定 → 傳送執行詳細資料 | 勾選，並設定收件信箱 |

12:00 起每 6 小時、最後一次 18:00，就是一天兩次。若你的 DSM 版本沒有
「頻率／最後執行時間」，改建兩個相同的任務，一個 12:00、一個 18:00。

NAS 的時區必須是台北（控制台 → 區域選項）。排程時間與備份檔名都用 NAS 的本地時間。

**「傳送執行詳細資料」要勾。** 備份的價值在於「真的有跑」，
沒有通知就無法察覺它哪天開始失敗。任一個庫備份失敗、上傳失敗、
過期清理失敗，腳本都會以非零結束，排程器會把它標成失敗。

建好後可在任務排程器選取該任務按「執行」，確認排程環境下也能跑、也收得到信。

## 保留策略：7 天

每次備份成功後，刪除 S3 上**該庫**檔名時間超過 7 天的備份。
正常情況下每個庫保留約 14～15 份（一天兩份 × 7 天）。

刪除邏輯有幾層限制，避免「寫錯一次就把歷史全部帶走」：

- **備份失敗的那個庫不清理。** 連續失敗幾天也不會把能用的備份刪光。
- **只認固定格式的檔名**（`prod-YYYY-MM-DD_HHMMSS.sql.gz`、`dev-…`）。
  手動放進 bucket 的其他檔案不會被動到。
- **時間看檔名，不看上傳時間。** 補傳的舊檔不會因此多留 7 天。
- **最新 14 份一律保留**（`S3_KEEP_MIN`），不論多舊。排程停擺十天後恢復時，
  不會一口氣刪到只剩一份。

天數與下限可在 `backup.env` 用 `S3_RETENTION_DAYS`、`S3_KEEP_MIN` 調整。

⚠️ **保留 7 天代表：資料被改壞超過 7 天才發現，就救不回來了。**
而且排程每跑一次，就會多一份「已經壞掉的」備份，並擠掉一份最舊的好備份。
**發現資料有問題時，第一件事是到任務排程器把這個任務停用**，再開始排查。

## 上傳失敗時

上傳 S3 失敗（rustfs 沒在跑、磁碟滿……）時，該次備份檔會留在 `scripts/work/`，
排程器回報失敗。下一次排程執行時會自動補傳，成功後才刪除本機那份，不需要手動處理。

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

所有還原都要先把備份從 S3 下載回 NAS：

```bash
cd /volume1/scripts/inventory-app
sudo bash scripts/fetch-backup.sh                                # 列出所有備份
sudo bash scripts/fetch-backup.sh prod-2026-10-04_120001.sql.gz  # 下載
# → 已下載：/volume1/scripts/inventory-app/scripts/work/restore/prod-2026-10-04_120001.sql.gz
```

下載的檔案是未加密的完整營業資料，還原完請手動刪除。

### 還原到 dev

正式庫或 dev 自己的備份都可以還原到 dev：

```bash
cd /volume1/scripts/inventory-app
sudo DEV_DB_URL='<dev 連線字串>' \
PROD_DB_URL='<正式連線字串>' \
ARCHIVE=scripts/work/restore/prod-2026-10-04_120001.sql.gz \
CONFIRM_OVERWRITE_DEV=yes \
  bash scripts/refresh-dev.sh
```

`CONFIRM_OVERWRITE_DEV=yes` 是必要的：這支腳本會清空目標資料庫，
不接受「預設就覆寫」。`PROD_DB_URL` 用來比對、防止目標填成正式庫。

### 每次排程後自動用正式庫刷新 dev（本專案開啟）

`backup.env` 的 `REFRESH_DEV_FROM_PROD=yes`（範本已設好）。排程一天跑兩次，
dev 每天中午、傍晚各被清空重灌一次，白天在 dev 上做的東西都會消失，
所以 dev 只當正式庫的複本使用，不在上面存需要保留的東西。
覆寫前會先備份 dev，萬一灌錯還能從 dev 自己的備份還原。
正式庫或 dev 任一個當次備份失敗時，不會刷新。

不想刷新時改成 `no` 或整行刪掉，腳本在沒設定時不刷新。

### 還原到正式庫（災難復原）

**這是破壞性操作，只在正式資料真的毀損時執行。**

`refresh-dev.sh` 有防護會拒絕對正式庫執行，這是刻意的。真的要還原正式庫時，
手動執行以下步驟，每一步都先確認：

```bash
cd /volume1/scripts/inventory-app

# 0. 先到任務排程器停用備份任務（理由見「保留策略」）

# 1. 下載要還原的那份，並檢查內容
sudo bash scripts/fetch-backup.sh prod-2026-10-04_120001.sql.gz
F=scripts/work/restore/prod-2026-10-04_120001.sql.gz
sudo gzip -dc "$F" | head -40
sudo gzip -dc "$F" | grep -c '^COPY '

# 2. 還原前先備份「現在的」狀態，即使它是壞的
#    弄錯還原方向時，這是唯一能回頭的路
sudo bash -c 'set -a; . scripts/backup.env; set +a;
  DB_URL="$PROD_DB_URL" DB_LABEL=prod STAGING_DIR=scripts/work bash scripts/backup-db.sh'

# 3. 還原（single-transaction：任一句失敗即整筆回滾，不會留下半毀狀態）
#    前三行與 refresh-dev.sh 相同：先清空 public、補裝 pg_trgm，
#    並把 dump 的 CREATE SCHEMA public 改成 IF NOT EXISTS。
#    直接灌 dump 會失敗在「schema "public" already exists」。
#    映像版本要與伺服器一致（backup.log 裡「伺服器 PostgreSQL 主版本」那行）。
{
  echo 'drop schema if exists public cascade;'
  echo 'create schema public;'
  echo 'create extension if not exists pg_trgm with schema public;'
  sudo gzip -dc "$F" \
    | sed 's/^CREATE SCHEMA public;$/CREATE SCHEMA IF NOT EXISTS public;/'
} | sudo /usr/local/bin/docker run --rm -i postgres:17-alpine psql '<正式連線字串>' \
  --single-transaction --variable ON_ERROR_STOP=1

# 4. 確認無誤後刪除下載的檔案，重新啟用排程
```

步驟 2 不可跳過。還原是覆寫，跳過這步就沒有退路了。
步驟 2 會在 `scripts/work/` 留下一份本機檔案，下次排程時會被當成
「上次沒傳成功」補傳並刪除，不需要手動處理。

⚠️ 這個流程**從未對真正的 Supabase 執行過**（見下方「尚未驗證的部分」）。
建議先用同樣指令對 dev 演練一次，確認可行後再用於正式庫。

## 定期演練

**沒有實測過還原的備份不算備份。** 建議每季做一次：

1. 挑一份正式庫備份，用上面「還原到 dev」的方式還原
2. 開 dev 環境的前端，確認商品清單、單據列表、報表都正常
3. 抽查幾筆單據的金額與明細

演練會覆寫 dev，做之前確認 dev 上沒有需要保留的東西
（或先手動跑一次 `nas-daily.sh` 備份 dev）。

## 已驗證與尚未驗證的部分

**已驗證（2026-10-04，在 ci-runner 以兩個 `postgres:17` 容器模擬正式與 dev，
上傳到 NAS 上真正的 rustfs）**

- 兩個庫都備份、上傳成功，S3 上的大小與本機一致
- 7 天清理：只刪符合格式且超過 7 天的檔案，其他檔案不動；
  未超過最低保留份數時不刪
- S3 連不上時：排程判定失敗、本機檔案保留、不做任何清理；
  恢復後下次執行自動補傳並清掉本機檔案
- `REFRESH_DEV_FROM_PROD=yes` 時 dev 被正確覆寫成正式庫內容
- `fetch-backup.sh` 能列出與下載；檔名錯誤時清楚報錯、不留半截檔案
- log 中不含資料庫密碼與 S3 金鑰

更早（2026-09-27）以本機 `postgres:17` 驗證過：還原後權限與結構一致
（authenticated 可讀寫、anon 被拒、RLS、policy、trigger、trgm 索引、取號序列），
同一份備份可連續還原兩次。

**尚未驗證（需在第一次真實執行時確認）**

測試環境是一般 PostgreSQL 與 Debian，不是 Supabase 與 DSM：

| # | 項目 | 風險 | 怎麼確認 |
|---|---|---|---|
| 1 | 透過 Session pooler 執行 `pg_dump` | 研究結果顯示可行，但沒有實際連線測試過 | 第一次手動執行成功即可確認 |
| 2 | DSM 上的執行環境 | 排程器的 PATH、DSM 的 bash 對 `tee` 與 process substitution 的支援、root 的 Docker 權限、`--network host` | 手動執行成功後，再讓排程實際跑一次並確認收到通知信 |
| 3 | 還原到 Supabase 時的 `ALTER DEFAULT PRIVILEGES` 與 `drop schema public cascade` | Supabase 的 `postgres` 不是 superuser，還原可能因權限不足整筆回滾 | 第一次「還原到 dev」成功就代表沒問題 |
| 4 | 還原後 authenticated 對 schema 的 USAGE 權限 | 缺少的話，前端登入後會全部 permission denied | 還原到 dev 後在 SQL Editor 執行下方查詢 |
| 5 | 還原到正式庫的流程 | 從未執行過 | 先對 dev 演練一次 |

第一次還原到 dev 後，在 **dev 專案**的 SQL Editor 執行：

```sql
select has_schema_privilege('authenticated','public','USAGE')         as schema_usage, -- 應為 true
       has_table_privilege('authenticated','public.orders','SELECT')  as can_read,     -- 應為 true
       has_table_privilege('anon','public.orders','SELECT')           as anon_read;    -- 應為 false
```

**已知限制**

- **dev 單據數門檻會在正式資料成長後擋下 dev 刷新。** 第三道防護會檢查目標庫的
  單據數，等正式庫單據超過 5000 筆，用正式庫刷新 dev 就會被擋。到時請在
  `backup.env` 調高 `ALLOW_DEV_ORDERS`。真正有效的防護是前兩道（連線身分比對、project ref 比對）
- **不含登入帳號**（見「備份涵蓋什麼」），這是刻意的取捨，不是缺漏

## 故障排除

| 訊息 | 原因與處理 |
|---|---|
| `找不到 docker` | NAS 未安裝 Container Manager |
| `docker 存在但無法連線` | 排程的使用者不是 root |
| `缺少 S3 設定` | `backup.env` 沒填 `S3_ENDPOINT`／`S3_BUCKET`／`S3_ACCESS_KEY`／`S3_SECRET_KEY` |
| `無法取得伺服器版本` | 連線字串錯誤，或用了 Transaction pooler（6543）。改用 Session pooler（5432） |
| `備份中止：dump 缺少預期的資料表` | 連到了錯誤的資料庫 |
| `備份中止：dump 沒有任何 COPY 區塊` | 只匯出了結構沒有資料，通常是權限問題 |
| `Could not connect to the endpoint URL` | rustfs 沒在跑，或 `S3_ENDPOINT` 填錯。`docker ps` 確認 `rustfs` 容器狀態 |
| `AccessDenied` | S3 金鑰錯誤，或該金鑰對 bucket 沒有讀寫權限 |
| `上傳驗證失敗` | 上傳後 S3 上的大小與本機不符，本機檔案已保留，下次自動補傳 |
| `刪除失敗` | 金鑰沒有刪除權限。備份本身已成功，但舊備份不會被清掉 |
| `拒絕執行：DEV_DB_URL 與 PROD_DB_URL 指向同一個資料庫` | `backup.env` 的 `DEV_DB_URL` 填成正式庫了 |
| `拒絕執行：DEV_DB_URL 內含正式庫的 project ref` | 同上，連線字串的使用者名稱 `postgres.<ref>` 是正式專案的 |
| `拒絕執行：目標庫已有 N 筆單據` | 目標看起來不像 dev。確認無誤可調高 `ALLOW_DEV_ORDERS` |
| `已有另一份備份正在執行` | 上次異常中斷留下鎖目錄，手動刪除 `scripts/work/.lock` |

日誌在 `scripts/work/backup.log`，會累積每次執行的完整輸出。
連線字串在日誌中的密碼部分會被遮成 `****`。
