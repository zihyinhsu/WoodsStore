#!/usr/bin/env bash
# ============================================================
# 把正式庫的備份還原到 dev 資料庫
#
# ⚠️ 這支腳本會「清空」目標資料庫的 public schema 再灌入資料。
#    它是破壞性操作，且不可逆。因此本檔的防護比其他腳本都嚴格。
#
# 先說清楚定位：這不是備份，是「拿正式資料刷新測試環境」。
#   - 真正的備份是 S3（NAS 上的 rustfs）裡那些 prod-*.sql.gz（獨立檔案、保留 7 天）。
#   - dev 庫是「可被任意覆寫的工作副本」，它下一次刷新就會被蓋掉，
#     所以不能當成備份的第二份。真正的兩份是：S3 上的檔案 + Supabase 自家備份。
#
# 用法（正常由 nas-daily.sh 呼叫）：
#   DEV_DB_URL='postgresql://...' ARCHIVE=./work/prod-xxx.sql.gz \
#   CONFIRM_OVERWRITE_DEV=yes ./scripts/refresh-dev.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
. "${SCRIPT_DIR}/lib-common.sh"

: "${DEV_DB_URL:?缺少 DEV_DB_URL（dev 專案的 Session pooler 連線字串）}"
: "${ARCHIVE:?缺少 ARCHIVE（要還原的 prod-*.sql.gz 路徑）}"

# ------------------------------------------------------------
# 防護一：必須明確確認
#
# 不接受「預設就會覆寫」。必須顯式帶 CONFIRM_OVERWRITE_DEV=yes，
# 手滑執行這支腳本不會造成任何後果。
#
# 這一段刻意排在 require_docker 之前：安全檢查要最先跑，否則
# 環境問題（docker 沒開）的錯誤訊息會蓋掉「你沒帶確認參數」這個
# 真正的原因，讓人以為是環境壞了而去修錯的地方。
# ------------------------------------------------------------
if [ "${CONFIRM_OVERWRITE_DEV:-}" != "yes" ]; then
  echo "拒絕執行：這支腳本會清空目標資料庫的 public schema。" >&2
  echo "確認要覆寫 dev 庫請帶 CONFIRM_OVERWRITE_DEV=yes" >&2
  exit 1
fi

# ------------------------------------------------------------
# 防護二：目標不可以是正式庫
#
# 最可怕的意外是把正式庫當成 dev 灌下去——那會用昨天的資料
# 覆蓋掉今天的營業紀錄，且無法復原。這裡用兩道比對：
#
#   1. 目標的 使用者@主機:port/資料庫 不得與 PROD_DB_URL 相同。
#   2. 目標連線字串不得包含正式庫的 project ref（有提供時）。
#
# 兩者都靠呼叫方傳入 PROD_DB_URL。沒傳時仍要求 DEV_DB_URL 看起來
# 像 dev（下面第三道），不讓防護在缺參數時默默失效。
#
# 與防護一同樣排在 require_docker 之前：這兩道只做字串比對、
# 不需要任何外部環境，因此必須在環境檢查之前跑完。順序反了的話，
# docker 沒開時使用者只會看到 docker 的錯誤，完全不知道自己
# 其實填了正式庫的連線字串——那是最危險的誤解。
# ------------------------------------------------------------
if [ -n "${PROD_DB_URL:-}" ]; then
  DEV_ID="$(db_identity_of "${DEV_DB_URL}")"
  PROD_ID="$(db_identity_of "${PROD_DB_URL}")"

  if [ "${DEV_ID}" = "${PROD_ID}" ]; then
    echo "拒絕執行：DEV_DB_URL 與 PROD_DB_URL 指向同一個資料庫（${DEV_ID}）。" >&2
    echo "這會用備份覆蓋正式資料。請確認 DEV_DB_URL 填的是 dev 專案。" >&2
    exit 1
  fi

  PROD_REF="$(printf '%s' "${PROD_DB_URL}" | sed -nE 's#.*://postgres\.([a-z0-9]+):.*#\1#p')"
  if [ -n "${PROD_REF}" ] && printf '%s' "${DEV_DB_URL}" | grep -q "postgres\.${PROD_REF}:"; then
    echo "拒絕執行：DEV_DB_URL 內含正式庫的 project ref（${PROD_REF}）。" >&2
    exit 1
  fi
fi

# ------------------------------------------------------------
# 封存檔驗證：不要把壞檔灌進去。
# 同樣不需要 docker，因此排在環境檢查之前。
# ------------------------------------------------------------
if [ ! -s "${ARCHIVE}" ]; then
  echo "還原中止：封存檔不存在或為空：${ARCHIVE}" >&2
  exit 1
fi
if ! gzip -t "${ARCHIVE}" 2>/dev/null; then
  echo "還原中止：封存檔損壞（gzip 驗證失敗）" >&2
  exit 1
fi

require_docker

# ------------------------------------------------------------
# 防護三：目標資料庫必須「看起來是 dev」
#
# 前兩道依賴呼叫方傳對參數。這一道直接問資料庫本身：
# 正式庫有大量單據，dev 庫不該有。若目標庫的單據數超過門檻，
# 停下來要人確認，避免在任何情況下默默輾過一個有實際資料的庫。
# ------------------------------------------------------------
PG_MAJOR="$(detect_pg_major "${DEV_DB_URL}")"

echo "=== 還原到 dev $(date '+%F %T') ==="
echo "目標：$(mask_db_url "${DEV_DB_URL}")"
echo "來源封存：${ARCHIVE}"
echo "目標 PostgreSQL 主版本：${PG_MAJOR}"

EXISTING_ORDERS="$(
  docker run --rm -i \
    -e PGCONNECT_TIMEOUT=30 \
    "postgres:${PG_MAJOR}-alpine" \
    psql "${DEV_DB_URL}" -tAc \
    "select coalesce((select count(*) from public.orders), 0)" 2>/dev/null \
    | tr -d '[:space:]'
)" || EXISTING_ORDERS="0"

# 查不到表（新庫或空庫）會回空字串，視為 0。
[ -n "${EXISTING_ORDERS}" ] || EXISTING_ORDERS="0"

MAX_EXISTING="${ALLOW_DEV_ORDERS:-5000}"
if [ "${EXISTING_ORDERS}" -gt "${MAX_EXISTING}" ]; then
  echo "拒絕執行：目標庫已有 ${EXISTING_ORDERS} 筆單據，超過安全門檻 ${MAX_EXISTING}。" >&2
  echo "這看起來不像 dev 庫。確認無誤請帶 ALLOW_DEV_ORDERS=<更大的數字>。" >&2
  exit 1
fi
echo "目標庫現有單據數：${EXISTING_ORDERS}（門檻 ${MAX_EXISTING}，通過）"

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "${WORK_DIR}"; }
trap cleanup EXIT

RESTORE_SQL="${WORK_DIR}/restore.sql"

# drop schema 放在還原檔開頭而不是另跑一次連線：整份在同一個
# 交易裡執行，中途失敗會整筆回滾，不會留下「刪掉舊的、新的沒進來」
# 的半毀狀態。
#
# pg_trgm 要在清空後補裝：它若裝在 public，會被 cascade 一起刪掉，
# 而 --schema=public 的 dump 不含 CREATE EXTENSION，還原到 trigram
# 索引（idx_partners_*_trgm）時就會找不到 gin_trgm_ops。
# 若它原本裝在別的 schema（例如 Supabase 的 extensions），
# if not exists 讓這一句成為 no-op。
#
# dump 自帶 CREATE SCHEMA public，這裡已先建好，改寫成 IF NOT EXISTS。
#
# ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin 要刪掉：連線用的 postgres
# 不是 supabase_admin 的成員，執行會報 permission denied to change default
# privileges，整筆還原因此回滾。少了它只影響 supabase_admin 日後新建的物件，
# 本專案的表與函式都由 postgres 建立，FOR ROLE postgres 的那幾句照常還原。
#
# ensure_rls 要在還原後補建：它是 Supabase 替新表自動開 RLS 的事件觸發器，
# 依附在 public.rls_auto_enable() 上，drop schema cascade 會連帶刪掉；
# 但事件觸發器屬於整個資料庫而非 schema，--schema=public 的 dump 不會帶回來。
# 用 DO 區塊判斷：dump 裡沒有這支函式（舊專案）就不建，已存在也不重複建。
{
  echo 'drop schema if exists public cascade;'
  echo 'create schema public;'
  echo 'create extension if not exists pg_trgm with schema public;'
  gzip -dc "${ARCHIVE}" \
    | sed 's/^CREATE SCHEMA public;$/CREATE SCHEMA IF NOT EXISTS public;/' \
    | sed '/^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin /d'
  cat <<'SQL'
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null
     and not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable();
  end if;
end
$$;
SQL
} > "${RESTORE_SQL}"

echo "--- 還原中（單一交易，失敗會整筆回滾）---"
# --single-transaction + ON_ERROR_STOP：任一句失敗即整體回滾。
# 沒有這兩個旗標的話，psql 會跳過錯誤繼續跑，最後得到一個
# 「部分還原」的資料庫——那比還原失敗更難察覺。
docker run --rm -i \
  -e PGCONNECT_TIMEOUT=30 \
  "postgres:${PG_MAJOR}-alpine" \
  psql "${DEV_DB_URL}" \
    --single-transaction \
    --variable ON_ERROR_STOP=1 \
    --quiet \
  < "${RESTORE_SQL}"

# ------------------------------------------------------------
# 還原後驗證：證明資料真的進去了
# ------------------------------------------------------------
echo "--- 驗證還原結果 ---"
docker run --rm -i \
  -e PGCONNECT_TIMEOUT=30 \
  "postgres:${PG_MAJOR}-alpine" \
  psql "${DEV_DB_URL}" -tAc "
    select 'products=' || (select count(*) from public.products)
        || ' partners=' || (select count(*) from public.partners)
        || ' orders='   || (select count(*) from public.orders)
        || ' items='    || (select count(*) from public.order_items)
        || ' payments=' || (select count(*) from public.payments)
  "

echo "=== dev 還原完成 ==="
echo "注意：未還原 auth schema，dev 的登入帳號需在該專案的 Dashboard 自行建立。"
