#!/usr/bin/env bash
# ============================================================
# Synology 任務排程器的進入點
#
# 這是唯一需要填到排程器裡的指令。它串起：
#   1. 備份正式庫到 NAS（永久保留）
#   2. 把剛備份的內容還原到 dev 庫（可選，設了 DEV_DB_URL 才做）
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
# 同時本檔也寫一份 log 到備份目錄，方便事後追查。
# ============================================================
set -euo pipefail

# Synology 任務排程器給的 PATH 很精簡，通常不含 /usr/local/bin，
# 而 Container Manager 的 docker 就裝在那裡。不補的話手動執行正常、
# 排程執行卻回報「找不到 docker」。
export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------------------------------------------------------------
# 載入設定
# ------------------------------------------------------------
ENV_FILE="${BACKUP_ENV_FILE:-${SCRIPT_DIR}/backup.env}"
if [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
else
  echo "找不到設定檔：${ENV_FILE}" >&2
  echo "請複製 scripts/backup.env.example 為 scripts/backup.env 並填入連線字串。" >&2
  exit 1
fi

: "${PROD_DB_URL:?backup.env 缺少 PROD_DB_URL}"
: "${BACKUP_DIR:?backup.env 缺少 BACKUP_DIR}"

mkdir -p "${BACKUP_DIR}"

LOG_FILE="${BACKUP_DIR}/backup.log"

# 同時輸出到畫面（進排程器的通知信）與 log 檔。
exec > >(tee -a "${LOG_FILE}") 2>&1

echo ""
echo "════════════════════════════════════════════════"
echo " 每日備份 $(date '+%F %T')"
echo "════════════════════════════════════════════════"

# ------------------------------------------------------------
# 防止重複執行
# 上一次還沒跑完就又被觸發（例如手動執行撞到排程），
# 兩份 pg_dump 同時對正式庫拉資料沒有好處。
# ------------------------------------------------------------
LOCK_DIR="${BACKUP_DIR}/.lock"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "已有另一份備份正在執行（${LOCK_DIR} 存在），本次跳過。"
  echo "若確認沒有在跑，手動刪除該目錄即可。"
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

# ------------------------------------------------------------
# 1. 備份正式庫
# ------------------------------------------------------------
PROD_DB_URL="${PROD_DB_URL}" \
BACKUP_DIR="${BACKUP_DIR}" \
  bash "${SCRIPT_DIR}/backup-prod.sh"

ARCHIVE="$(cat "${BACKUP_DIR}/.latest")"

# ------------------------------------------------------------
# 2. 還原到 dev（可選）
#
# 刻意放在備份之後，且備份失敗時（set -e）根本不會執行到這裡——
# 先確保「真正的備份」落地，再做「刷新測試環境」這件次要的事。
#
# 這一段失敗不應該讓整支腳本算失敗：備份已經成功了，
# dev 刷新失敗是另一個層級的問題，不該讓人誤以為備份沒跑。
# ------------------------------------------------------------
if [ -n "${DEV_DB_URL:-}" ]; then
  echo ""
  echo "--- 刷新 dev 庫 ---"
  if DEV_DB_URL="${DEV_DB_URL}" \
     PROD_DB_URL="${PROD_DB_URL}" \
     ARCHIVE="${ARCHIVE}" \
     CONFIRM_OVERWRITE_DEV=yes \
     ALLOW_DEV_ORDERS="${ALLOW_DEV_ORDERS:-5000}" \
       bash "${SCRIPT_DIR}/refresh-dev.sh"
  then
    echo "dev 刷新成功。"
  else
    echo "警告：dev 刷新失敗，但正式庫備份已完成（${ARCHIVE}）。" >&2
    echo "備份本身沒問題，請另外排查 dev 連線。" >&2
  fi
else
  echo ""
  echo "未設定 DEV_DB_URL，略過 dev 刷新。"
fi

echo ""
echo "本次完成 $(date '+%F %T')"
echo "備份目錄用量：$(du -sh "${BACKUP_DIR}" | cut -f1)"
