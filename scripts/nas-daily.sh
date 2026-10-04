#!/usr/bin/env bash
# ============================================================
# Synology 任務排程器的進入點（每天 12:00、18:00 各跑一次）
#
# 這是唯一需要填到排程器裡的指令。它串起：
#   0. 補傳上次沒傳成功、還留在本機暫存目錄的備份
#   1. 備份正式庫並上傳 S3
#   2. 備份 dev 庫並上傳 S3（設了 DEV_DB_URL 才做）
#   3. 用剛備份的正式庫刷新 dev（REFRESH_DEV_FROM_PROD=yes 才做，預設不做）
#   4. 刪除 S3 上超過 7 天的備份（只清本次備份成功的那個庫）
#   5. 刪掉本機暫存的那份（S3 已核對過大小）
#
# 設定值放在同目錄的 backup.env（不進版控），本檔負責載入。
# 這樣排程器裡不必填一長串含密碼的環境變數，改密碼也不用動排程。
#
# Synology 任務排程器設定：
#   控制台 → 任務排程器 → 新增 → 排定的任務 → 使用者定義的指令碼
#   使用者：root（需要 docker 權限）
#   指令：bash /volume1/<你的路徑>/scripts/nas-daily.sh
#
# 排程器會把輸出寄給你（勾選「傳送執行詳細資料」），
# 同時本檔也寫一份 log 到本機暫存目錄，方便事後追查。
# ============================================================
set -euo pipefail

# Synology 任務排程器給的 PATH 很精簡，通常不含 /usr/local/bin，
# 而 Container Manager 的 docker 就裝在那裡。不補的話手動執行正常、
# 排程執行卻回報「找不到 docker」。
export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
. "${SCRIPT_DIR}/lib-common.sh"

load_backup_env "${SCRIPT_DIR}"

: "${PROD_DB_URL:?backup.env 缺少 PROD_DB_URL}"
require_s3_config

RETENTION_DAYS="${S3_RETENTION_DAYS:-7}"
# 一天兩份 × 7 天。正常情況下 7 天前的那份剛好是第 15 份，
# 這個下限只在排程停擺過一段時間後才會起作用。
KEEP_MIN="${S3_KEEP_MIN:-14}"

# 備份檔上傳 S3 前的落地處，也放 log 與鎖。
# 不放在要備份的 S3 裡：log 要在 S3 連不上的那天也寫得進去，才查得出原因。
STAGING_DIR="${STAGING_DIR:-${SCRIPT_DIR}/work}"
mkdir -p "${STAGING_DIR}"
# 暫存的是未加密的完整營業資料，只讓執行排程的 root 讀得到。
chmod 700 "${STAGING_DIR}"

LOG_FILE="${STAGING_DIR}/backup.log"

# 同時輸出到畫面（進排程器的通知信）與 log 檔。
exec > >(tee -a "${LOG_FILE}") 2>&1

echo ""
echo "════════════════════════════════════════════════"
echo " 定時備份 $(date '+%F %T')"
echo "════════════════════════════════════════════════"

# ------------------------------------------------------------
# 防止重複執行
# 上一次還沒跑完就又被觸發（例如手動執行撞到排程），
# 兩份 pg_dump 同時對同一個庫拉資料沒有好處。
# ------------------------------------------------------------
LOCK_DIR="${STAGING_DIR}/.lock"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "已有另一份備份正在執行（${LOCK_DIR} 存在），本次跳過。"
  echo "若確認沒有在跑，手動刪除該目錄即可。"
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

# 任一步驟失敗都記下來、最後以非零結束，讓排程器判定為失敗。
# 不在第一個失敗就停：正式庫備份失敗，不該連帶讓 dev 也沒備份。
FAILED=0

# ------------------------------------------------------------
# 0. 補傳上次沒傳成功的備份
#
# 正常流程跑完，暫存目錄不會留下任何 prod-*／dev-*.sql.gz。
# 有殘留就代表之前某次上傳失敗（rustfs 沒在跑、磁碟滿……），
# 那一次的備份只存在這裡，趁這次補上去。
# 補傳失敗不擋這次的備份：檔案留著，下次再試。
# ------------------------------------------------------------
for leftover in "${STAGING_DIR}"/prod-*.sql.gz "${STAGING_DIR}"/dev-*.sql.gz; do
  [ -e "${leftover}" ] || continue
  echo "--- 補傳上次未上傳的備份：$(basename "${leftover}") ---"
  if s3_upload_verified "${leftover}"; then
    rm -f "${leftover}"
  else
    echo "警告：補傳失敗，檔案保留在 ${leftover}，下次再試。" >&2
    FAILED=1
  fi
done

# ------------------------------------------------------------
# 備份一個庫。成功時把本機那份的路徑記在 ARCHIVE_<label>。
# 失敗時（含上傳失敗）本機那份保留，留給下次補傳。
# ------------------------------------------------------------
ARCHIVE_prod=""
ARCHIVE_dev=""
backup_one() {
  local label="$1" url="$2"
  echo ""
  if DB_URL="${url}" DB_LABEL="${label}" STAGING_DIR="${STAGING_DIR}" \
       bash "${SCRIPT_DIR}/backup-db.sh"
  then
    printf -v "ARCHIVE_${label}" '%s' "$(cat "${STAGING_DIR}/.latest-${label}")"
    rm -f "${STAGING_DIR}/.latest-${label}"
  else
    echo "錯誤：${label} 庫備份失敗。" >&2
    FAILED=1
  fi
}

# ------------------------------------------------------------
# 1、2. 備份正式庫與 dev 庫
# ------------------------------------------------------------
backup_one prod "${PROD_DB_URL}"

if [ -n "${DEV_DB_URL:-}" ]; then
  backup_one dev "${DEV_DB_URL}"
else
  echo ""
  echo "未設定 DEV_DB_URL，略過 dev 庫備份。"
fi

# ------------------------------------------------------------
# 3. 用正式庫刷新 dev（可選，預設不做）
#
# 預設關閉：dev 現在本身也要備份，代表 dev 上的資料是有人在用的；
# 每天中午、傍晚各清空重灌一次，會把白天在 dev 上做的東西直接蓋掉。
#
# 開啟時，條件是兩邊都剛備份成功：正式庫那份是要灌進去的內容，
# dev 那份是被覆寫前的最後狀態，萬一灌錯還能還原回來。
#
# 這一段失敗也要讓整支腳本以非零結束：排程設為「僅在異常終止時寄信」，
# 正常結束就不會通知，dev 會從此默默停在舊資料（第一次對 Supabase 刷新
# 就因權限錯誤失敗過）。訊息裡講明備份已完成，避免誤以為備份沒跑。
# ------------------------------------------------------------
if [ "${REFRESH_DEV_FROM_PROD:-no}" = "yes" ]; then
  echo ""
  echo "--- 用正式庫刷新 dev 庫 ---"
  if [ -z "${DEV_DB_URL:-}" ]; then
    echo "警告：REFRESH_DEV_FROM_PROD=yes 但未設定 DEV_DB_URL，略過 dev 刷新。" >&2
    FAILED=1
  elif [ -z "${ARCHIVE_prod}" ] || [ -z "${ARCHIVE_dev}" ]; then
    echo "警告：正式庫或 dev 庫本次沒有備份成功，略過 dev 刷新。" >&2
  elif DEV_DB_URL="${DEV_DB_URL}" \
       PROD_DB_URL="${PROD_DB_URL}" \
       ARCHIVE="${ARCHIVE_prod}" \
       CONFIRM_OVERWRITE_DEV=yes \
       ALLOW_DEV_ORDERS="${ALLOW_DEV_ORDERS:-5000}" \
         bash "${SCRIPT_DIR}/refresh-dev.sh"
  then
    echo "dev 刷新成功。"
  else
    echo "警告：dev 刷新失敗，但兩個庫的備份都已完成。" >&2
    echo "備份本身沒問題，dev 維持刷新前的狀態（還原是單一交易，失敗會整筆回滾）。" >&2
    FAILED=1
  fi
fi

# ------------------------------------------------------------
# 4. 清理 S3 上過期的備份
#
# 只清本次備份成功的那個庫：備份失敗的那天再刪舊的，
# 連續失敗幾天就會把能用的備份全部刪光。
# ------------------------------------------------------------
echo ""
echo "--- 清理超過 ${RETENTION_DAYS} 天的備份 ---"
for label in prod dev; do
  archive_var="ARCHIVE_${label}"
  if [ -z "${!archive_var}" ]; then
    continue
  fi
  if ! s3_prune_old "${label}" "${RETENTION_DAYS}" "${KEEP_MIN}"; then
    echo "警告：${label} 的過期清理沒有完成（備份本身已成功）。" >&2
    FAILED=1
  fi
done

# ------------------------------------------------------------
# 5. 刪掉本機暫存
# 有 ARCHIVE_<label> 代表 backup-db.sh 已核對過 S3 上的大小，
# 本機這份是多餘的未加密複本，不留。
# ------------------------------------------------------------
# 逐一判斷非空：備份失敗的那個是空字串，GNU rm 遇到空字串參數會報錯，
# 在 set -e 下會讓整支腳本在這裡中斷。
for archive in "${ARCHIVE_prod}" "${ARCHIVE_dev}"; do
  if [ -n "${archive}" ]; then
    rm -f "${archive}"
  fi
done

echo ""
echo "本次結束 $(date '+%F %T')"
# 只是給人看的統計，查不到不影響本次結果。
# 查詢失敗要明講，不能顯示成 0——那會被讀成「S3 上沒有備份」。
if LISTING="$(aws_s3 s3 ls "s3://${S3_BUCKET}/$(s3_key_of '')" 2>/dev/null)"; then
  # 與 s3_prune_old 認同一種檔名，手動放進去的其他檔案不算在內。
  STAMP='-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}\.sql\.gz$'
  echo "S3 上現有備份：正式庫 $(printf '%s\n' "${LISTING}" | grep -cE " prod${STAMP}" || true) 份，dev $(printf '%s\n' "${LISTING}" | grep -cE " dev${STAMP}" || true) 份"
else
  echo "S3 上現有備份：查詢失敗"
fi

if [ "${FAILED}" -ne 0 ]; then
  echo "本次有步驟失敗，請檢查上方訊息。" >&2
  exit 1
fi
