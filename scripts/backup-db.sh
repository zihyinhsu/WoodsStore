#!/usr/bin/env bash
# ============================================================
# 備份一個資料庫（正式或 dev）到 S3（NAS 上的 rustfs）
#
# 由 nas-daily.sh 呼叫，正式庫與 dev 各呼叫一次；也可單獨執行做驗證。
#
# 流程：pg_dump → 在本機暫存目錄驗證、壓縮 → 上傳 S3 並核對大小。
# 驗證一定要在本機做（要逐行檢查 dump 內容），所以檔案會先落地在
# STAGING_DIR；上傳成功後由 nas-daily.sh 刪除。
# 單獨執行本腳本時本機那份會留著，需要時請手動清掉。
#
# 為什麼用 docker 跑 pg_dump 而不在 NAS 裝 PostgreSQL：
#   Synology 套件中心的 PostgreSQL 版本不一定跟 Supabase 一致，而
#   pg_dump 拒絕匯出比自己新的伺服器。改用 docker 就能精準取用
#   與伺服器同主版本的 pg_dump，且版本由 detect_pg_major 自動偵測。
#
# 這支腳本只新增、不刪除 S3 上的東西。保留 7 天的清理由 nas-daily.sh
# 在「本次備份已上傳成功」之後另外呼叫 s3_prune_old，刻意不放在這裡：
# 單獨執行本腳本做驗證時，不該順手刪掉任何歷史備份。
#
# 用法：
#   DB_URL='postgresql://...' DB_LABEL=prod STAGING_DIR=./work \
#   S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=yijing S3_PREFIX=inventory \
#   S3_ACCESS_KEY=... S3_SECRET_KEY=... \
#     ./scripts/backup-db.sh
# ============================================================
set -euo pipefail

# 絕不開 set -x：連線字串含密碼，展開後會直接寫進 log。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
. "${SCRIPT_DIR}/lib-common.sh"

: "${DB_URL:?缺少 DB_URL（要備份的資料庫的 Session pooler 連線字串）}"
: "${DB_LABEL:?缺少 DB_LABEL（prod 或 dev，會成為檔名開頭）}"
: "${STAGING_DIR:?缺少 STAGING_DIR（本機暫存目錄，備份上傳 S3 前先落地在這裡）}"

# 只接受這兩個值：DB_LABEL 會成為檔名開頭，而 s3_prune_old 是靠
# 「<label>-日期時間.sql.gz」這個固定格式決定要刪哪些。
# 放任自由字串的話，打錯一個字就會產生清理認不得、永遠不會被刪的檔案。
case "${DB_LABEL}" in
  prod|dev) ;;
  *) echo "DB_LABEL 只能是 prod 或 dev，收到：${DB_LABEL}" >&2; exit 1 ;;
esac

require_s3_config
require_docker

# 時間一律用本地時間：這是給人看的檔名，材料行的人講「9月27號那份」
# 指的是台北時間。NAS 時區固定，不像雲端 runner 有 UTC 落差問題。
TIMESTAMP="$(date '+%Y-%m-%d_%H%M%S')"
ARCHIVE="${STAGING_DIR}/${DB_LABEL}-${TIMESTAMP}.sql.gz"

mkdir -p "${STAGING_DIR}"

# 建在 STAGING_DIR 底下而不是預設的 /tmp：DSM 的 /tmp 是 tmpfs，吃的是記憶體。
# 這台 NAS 只有 4GB、閒置可用約 1.2GB，未壓縮的 dump 放進去等於直接佔用 RAM，
# 資料量長大後可能把整台拖垮（NAS 曾因記憶體不足卡死過）。
WORK_DIR="$(mktemp -d "${STAGING_DIR}/.tmp.XXXXXX")"
cleanup() {
  # dump 是未加密的完整營業資料，不留在暫存目錄。
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

DUMP_FILE="${WORK_DIR}/dump.sql"

echo "=== 備份 ${DB_LABEL} 庫 $(date '+%F %T') ==="
echo "來源：$(mask_db_url "${DB_URL}")"

PG_MAJOR="$(detect_pg_major "${DB_URL}")"
echo "伺服器 PostgreSQL 主版本：${PG_MAJOR}（使用 postgres:${PG_MAJOR}-alpine 的 pg_dump）"

# ------------------------------------------------------------
# Dump
#
# 只取 public schema：業務資料（商品、單據、收款）都在這裡。
# 刻意不含 auth schema——那需要更高權限、官方 CLI 也預設排除，
# 且還原到另一個專案時 JWT secret 不同、既有 token 一律失效。
# 代價寫在文件裡：還原後需在 Dashboard 重建登入帳號。
# 對材料行而言重建幾個帳號是幾分鐘的事，單據與庫存流水帳才是重建不回來的。
#
# --no-owner：不寫死擁有者。還原端的連線帳號不一定叫同一個名字。
#
# 刻意「保留」授權（不加 --no-privileges）：schema.sql 的 GRANT 給
# authenticated、REVOKE 掉 anon，這就是整個系統的存取控制。
# 丟掉它們的話，還原出來的庫前端登入後全是 permission denied；
# 更糟的是若目標庫預設開放 anon，還原反而會把資料暴露出去。
# anon / authenticated / service_role 是每個 Supabase 專案都有的內建角色，
# 還原到任何 Supabase 專案都對得上。
#
# 備份檔刻意不含 DROP 指令（不加 --clean）：這份檔案是保留下來的歷史，
# 「清空目標」是還原時的決策，由 refresh-dev.sh 在還原當下決定，
# 不該內建在備份檔裡讓人一不小心 psql 灌下去就把目標清空。
# ------------------------------------------------------------
echo "--- 匯出中 ---"
pg_exec "${DB_URL}" "postgres:${PG_MAJOR}-alpine" pg_dump \
    --schema=public \
    --no-owner \
    --format=plain \
  > "${DUMP_FILE}"

# ------------------------------------------------------------
# 完整性驗證
#
# 這段是整支腳本最重要的部分。備份最糟的失敗不是「跑失敗」——那看得到；
# 而是「產出一個看似正常、實際是空的檔案」，讓人以為有備份，
# 真要還原時才發現沒有。pg_dump 失敗會非零退出（set -e 擋掉），
# 但連線成功卻撈到空結果不會，所以明確驗內容。
# ------------------------------------------------------------
echo "--- 驗證內容 ---"

if [ ! -s "${DUMP_FILE}" ]; then
  echo "備份中止：dump 是空檔" >&2
  exit 1
fi

# 六張業務表必須都在。缺任何一張都代表連錯資料庫或 dump 範圍出錯。
MISSING=""
for t in products partners orders order_items payments payment_orders; do
  if ! grep -qE "CREATE TABLE (IF NOT EXISTS )?(public\.)?\"?${t}\"?" "${DUMP_FILE}"; then
    MISSING="${MISSING} ${t}"
  fi
done
if [ -n "${MISSING}" ]; then
  echo "備份中止：dump 缺少預期的資料表：${MISSING}" >&2
  echo "這通常代表連到了錯誤的資料庫。" >&2
  exit 1
fi

# pg_dump 對每張表都會輸出 COPY 區塊（空表也有），沒有任何 COPY
# 代表只匯出了結構，通常是權限不足讀不到資料。
# 那種備份還原後是一個空系統，比沒有備份更容易誤判。
if ! grep -q '^COPY ' "${DUMP_FILE}"; then
  echo "備份中止：dump 沒有任何 COPY 區塊（只有結構、沒有資料）" >&2
  exit 1
fi

# 逐表回報筆數，讓每天的 log 自己就能看出資料量異常縮水。
echo "--- 各表資料筆數 ---"
for t in products partners orders order_items payments payment_orders; do
  # COPY 區塊以 \. 單獨一行結束，中間的行數即筆數。
  count="$(
    awk -v tbl="${t}" '
      $0 ~ "^COPY (public\\.)?\"?" tbl "\"? " { inblock=1; n=0; next }
      inblock && $0 == "\\." { print n; inblock=0; found=1; exit }
      inblock { n++ }
      END { if (!found) print 0 }
    ' "${DUMP_FILE}"
  )"
  printf '  %-16s %s\n' "${t}" "${count}"
done

# ------------------------------------------------------------
# 壓縮並落地
# 先寫到 mktemp 再搬進 STAGING_DIR：中途失敗不會留下半截檔案。
# nas-daily.sh 會把 STAGING_DIR 裡殘留的 prod-*／dev-*.sql.gz 當成
# 「上次沒傳成功」補傳，半截檔案若混進去就會被當成正常備份傳上 S3。
# ------------------------------------------------------------
gzip -c "${DUMP_FILE}" > "${WORK_DIR}/archive.sql.gz"

if ! gzip -t "${WORK_DIR}/archive.sql.gz" 2>/dev/null; then
  echo "備份中止：壓縮檔驗證失敗" >&2
  exit 1
fi

BYTES="$(wc -c < "${WORK_DIR}/archive.sql.gz" | tr -d '[:space:]')"
if [ "${BYTES}" -lt 500 ]; then
  echo "備份中止：壓縮檔只有 ${BYTES} bytes，異常過小" >&2
  exit 1
fi

mv "${WORK_DIR}/archive.sql.gz" "${ARCHIVE}"

# 讓呼叫方（nas-daily.sh）知道剛產出哪一份：上傳成功後要刪本機那份，
# 正式庫那份還可能拿去刷新 dev。
echo "${ARCHIVE}" > "${STAGING_DIR}/.latest-${DB_LABEL}"

# ------------------------------------------------------------
# 上傳 S3
# 失敗時整支腳本失敗（排程通知信會看到），本機那份保留，
# 下次 nas-daily.sh 執行時會自動補傳。
# ------------------------------------------------------------
echo "--- 上傳 S3 ---"
s3_upload_verified "${ARCHIVE}"

echo "=== 備份完成 ==="
echo "大小：$(du -h "${ARCHIVE}" | cut -f1)"
