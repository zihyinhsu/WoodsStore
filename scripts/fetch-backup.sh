#!/usr/bin/env bash
# ============================================================
# 從 S3 列出或下載備份檔，供還原使用。
#
# 備份只存在 S3，refresh-dev.sh 與災難復原的 psql 都要讀本機檔案，
# 所以還原前一律先用這支把那份抓下來。
#
# 用法：
#   bash scripts/fetch-backup.sh                                # 列出所有備份
#   bash scripts/fetch-backup.sh prod-2026-09-27_030000.sql.gz  # 下載
#
# 下載完會印出本機路徑，接著把它當 ARCHIVE 傳給 refresh-dev.sh。
# ============================================================
set -euo pipefail

# 與 nas-daily.sh 相同：DSM 非互動環境的 PATH 不含 docker 所在的 /usr/local/bin。
export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
. "${SCRIPT_DIR}/lib-common.sh"

load_backup_env "${SCRIPT_DIR}"
require_s3_config
require_docker

if [ $# -eq 0 ]; then
  aws_s3 s3 ls "s3://${S3_BUCKET}/$(s3_key_of '')"
  exit 0
fi

NAME="$(basename "$1")"

# 下載到暫存目錄底下的 restore/，不能直接放暫存目錄本身：
# nas-daily.sh 會把暫存目錄裡的 prod-*.sql.gz 當成「上次沒傳成功」
# 補傳回 S3，舊備份就會被同名重傳一次。
DEST_DIR="${STAGING_DIR:-${SCRIPT_DIR}/work}/restore"
mkdir -p "${DEST_DIR}"
chmod 700 "${DEST_DIR}"
DEST="${DEST_DIR}/${NAME}"

# 先寫到 .part 再改名：下載中斷時不會留下一個看似完整的檔案。
if ! aws_s3 s3 cp "s3://${S3_BUCKET}/$(s3_key_of "${NAME}")" - --only-show-errors > "${DEST}.part"; then
  rm -f "${DEST}.part"
  echo "下載失敗，請先不帶參數執行本腳本，確認檔名存在：${NAME}" >&2
  exit 1
fi

if ! gzip -t "${DEST}.part" 2>/dev/null; then
  rm -f "${DEST}.part"
  echo "下載的檔案無法解壓，已刪除。請確認檔名正確：${NAME}" >&2
  exit 1
fi
mv "${DEST}.part" "${DEST}"

echo "已下載：${DEST}"
echo "還原完畢後請手動刪除，這是未加密的完整營業資料。"
