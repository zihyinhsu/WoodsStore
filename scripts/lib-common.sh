#!/usr/bin/env bash
# ============================================================
# 備份腳本共用函式
#
# 各支腳本（backup-db / refresh-dev / nas-daily / fetch-backup）共用這裡的函式，
# 不各寫一份：版本偵測、連線遮蔽、S3 存取的邏輯只能有一個版本，
# 改一邊漏另一邊在這種無人看顧的排程裡特別難發現。
#
# 不直接執行這支檔案，由其他腳本 source。
# ============================================================

# ------------------------------------------------------------
# 載入 backup.env（連線字串與 S3 金鑰）。
# 設定集中在一個不進版控的檔案：排程器裡不必填一長串含密碼的
# 環境變數，改密碼也不用動排程。
# ------------------------------------------------------------
load_backup_env() {
  local script_dir="$1"
  local env_file="${BACKUP_ENV_FILE:-${script_dir}/backup.env}"
  if [ ! -f "${env_file}" ]; then
    echo "找不到設定檔：${env_file}" >&2
    echo "請複製 scripts/backup.env.example 為 scripts/backup.env 並填入連線字串。" >&2
    exit 1
  fi
  # set -a：讓檔內所有變數自動 export。backup-db.sh 等是以 bash 另起的
  # 子行程，只用 . 載入的話它們看不到 S3_* 設定，會回報「缺少 S3 設定」。
  set -a
  # shellcheck disable=SC1090
  . "${env_file}"
  set +a
}

# ------------------------------------------------------------
# 從連線字串遮蔽密碼，供 log 輸出使用。
# 備份 log 會留在 NAS 上很久，不能讓資料庫密碼明文躺在裡面。
# ------------------------------------------------------------
mask_db_url() {
  local url="$1"
  # postgresql://user:password@host:port/db → postgresql://user:****@host:port/db
  printf '%s\n' "$url" | sed -E 's#(://[^:/@]+):[^@]*@#\1:****@#'
}

# ------------------------------------------------------------
# 取出連線字串的「身分」：使用者@主機:port/資料庫（不含密碼）。
#
# 不能只比主機：Supabase 的 Session pooler 主機是整個區域共用的
# （aws-0-ap-northeast-1.pooler.supabase.com），同區的正式與 dev
# 專案主機完全相同，靠使用者名稱 postgres.<project-ref> 區分。
# 只比主機會把同區的 dev 誤判成正式庫，每天擋掉 dev 刷新。
# ------------------------------------------------------------
db_identity_of() {
  local url="$1"
  printf '%s\n' "$url" \
    | sed -E 's#^[a-z]+://([^:@/]+)(:[^@]*)?@([^:/?]+)(:([0-9]+))?(/([^?]*))?.*#\1@\3:\5/\7#'
}

# ------------------------------------------------------------
# 偵測伺服器的 PostgreSQL 主版本。
#
# 這一步不能省。pg_dump 拒絕匯出比自己新的伺服器（官方行為：
# 「it will refuse to even try, rather than risk making an invalid dump」），
# 硬寫死映像版本的話，Supabase 哪天升級 PG 版本，備份就會在某個凌晨
# 開始持續失敗。改成先問伺服器、再挑同版本的 docker 映像，
# 升級後腳本會自己跟上。
#
# psql 對版本差異寬容（只是跑一句查詢），所以用哪個映像問都可以。
# ------------------------------------------------------------
detect_pg_major() {
  local url="$1"
  local probe_image="${PG_PROBE_IMAGE:-postgres:17-alpine}"
  local version_num

  version_num="$(
    docker run --rm -i \
      -e PGCONNECT_TIMEOUT=15 \
      "$probe_image" \
      psql "$url" -tAc 'show server_version_num' 2>/dev/null | tr -d '[:space:]'
  )" || true

  if ! printf '%s' "$version_num" | grep -qE '^[0-9]+$'; then
    echo "無法取得伺服器版本，連線可能失敗或被拒。" >&2
    echo "請確認連線字串正確、且使用 Session pooler（port 5432）。" >&2
    return 1
  fi

  # server_version_num 形如 170004（PG17）、160009（PG16）。
  # 除以 10000 取主版本。
  echo $(( version_num / 10000 ))
}

# ------------------------------------------------------------
# 確認 docker 可用。Synology 需先在套件中心安裝 Container Manager，
# 且執行排程的使用者要有 docker 權限（通常需以 root 執行排程）。
# ------------------------------------------------------------
require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "找不到 docker。Synology 請在套件中心安裝 Container Manager。" >&2
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "docker 存在但無法連線，通常是權限不足。" >&2
    echo "Synology 的任務排程器請把使用者設為 root。" >&2
    return 1
  fi
}

# ------------------------------------------------------------
# 以 docker 執行 aws-cli 操作 S3（NAS 上的 rustfs）。
#
# 和 pg_dump 一樣用 docker 跑，NAS 上不另外安裝任何東西。
# 映像固定版本：aws-cli 曾在 2.23 改了上傳預設行為（見下），
# 用 latest 等於讓別人決定哪天凌晨開始上傳失敗。
#
# --network host：S3_ENDPOINT 用 127.0.0.1:9000 直連同一台 NAS 的 rustfs。
#   預設的 bridge 網路裡 127.0.0.1 是容器自己，會連不到。
#   不走 files.nildev.net 是因為那條要出網路經 Cloudflare 再繞回來，
#   Cloudflare 免費方案還有單次上傳 100MB 的上限。
#
# 兩個 CHECKSUM 變數：aws-cli 2.23 起預設替每次上傳加 CRC 校驗標頭，
#   S3 相容服務不一定支援，改回「服務要求時才算」。
#
# 金鑰用 -e 變數名（不帶值）從環境傳入：寫成 -e KEY=值 的話，
#   金鑰會出現在 docker run 的指令列，NAS 上任何人 ps 都看得到。
# ------------------------------------------------------------
aws_s3() {
  AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" \
  AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}" \
  docker run --rm -i --network host \
    -e AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}" \
    -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    "${AWS_CLI_IMAGE:-amazon/aws-cli:2.37.9}" \
    --endpoint-url "${S3_ENDPOINT}" "$@"
}

# ------------------------------------------------------------
# 確認 S3 設定齊全。缺任何一個就不該開始備份：
# 等到 pg_dump 跑完才發現傳不上去，只會白白多拉一次正式庫。
# ------------------------------------------------------------
require_s3_config() {
  local missing="" v
  for v in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY; do
    if [ -z "${!v:-}" ]; then
      missing="${missing} ${v}"
    fi
  done
  if [ -n "${missing}" ]; then
    echo "缺少 S3 設定：${missing}" >&2
    return 1
  fi
}

# 備份檔在 bucket 裡的完整路徑。S3_PREFIX 允許留空（直接放 bucket 根目錄）。
s3_key_of() {
  local name="$1"
  if [ -n "${S3_PREFIX:-}" ]; then
    echo "${S3_PREFIX%/}/${name}"
  else
    echo "${name}"
  fi
}

# ------------------------------------------------------------
# 上傳一個檔案到 S3，並確認 S3 上的大小與本機一致才算成功。
#
# 本機那份在上傳確認前絕不能刪——S3 是唯一的長期存放處，
# 「以為傳上去了」而實際沒有，等於那天沒有備份。
# aws s3 cp 成功退出只代表請求被接受，這裡再用 head-object 確認。
# ------------------------------------------------------------
s3_upload_verified() {
  local file="$1"
  local name key local_bytes remote_bytes
  name="$(basename "${file}")"
  key="$(s3_key_of "${name}")"
  local_bytes="$(wc -c < "${file}" | tr -d '[:space:]')"

  # 以 stdin 送檔，不掛載本機目錄：容器看不到 NAS 上的其他檔案。
  # --expected-size 讓 aws-cli 預先切好分段上傳的大小，串流時必須提供。
  if ! aws_s3 s3 cp - "s3://${S3_BUCKET}/${key}" \
         --expected-size "${local_bytes}" --only-show-errors < "${file}"; then
    echo "上傳失敗：${name}" >&2
    return 1
  fi

  remote_bytes="$(
    aws_s3 s3api head-object --bucket "${S3_BUCKET}" --key "${key}" \
      --query ContentLength --output text 2>/dev/null | tr -d '[:space:]'
  )" || true

  if [ "${remote_bytes}" != "${local_bytes}" ]; then
    echo "上傳驗證失敗：${name} 本機 ${local_bytes} bytes，S3 上為「${remote_bytes:-查無檔案}」" >&2
    return 1
  fi

  echo "已上傳：s3://${S3_BUCKET}/${key}（${local_bytes} bytes，大小核對一致）"
}

# ------------------------------------------------------------
# 刪除 S3 上超過保留天數的備份（使用者指定保留 7 天）。
#
# 刪除邏輯寫錯一次就會把所有歷史一起帶走，所以層層設限：
#   - 只在「本次這個庫的備份已上傳並核對成功」之後呼叫（由 nas-daily.sh 保證），
#     備份壞掉的那天不會再把舊的刪掉。
#   - 只認完整符合 <label>-YYYY-MM-DD_HHMMSS.sql.gz 的檔名，其他檔案一律不碰。
#   - 時間看檔名而不是 S3 的 LastModified：補傳的舊檔 LastModified 是補傳當下，
#     檔名才是 dump 的真實時間。
#   - 不論多舊，最新的 keep_min 份一律保留。排程停擺十天後恢復時，
#     不會因為「全都超過 7 天」而一口氣刪到只剩當次那一份。
#
# 用法：s3_prune_old <prod|dev> <保留天數> <至少保留份數>
# ------------------------------------------------------------
s3_prune_old() {
  local label="$1" days="$2" keep_min="$3"
  local cutoff listing names total deletable name ts deleted=0 failed=0

  cutoff="$(date -d "@$(( $(date +%s) - days * 86400 ))" '+%Y-%m-%d_%H%M%S')"

  if ! listing="$(aws_s3 s3 ls "s3://${S3_BUCKET}/$(s3_key_of '')" </dev/null)"; then
    echo "無法列出 S3，略過 ${label} 的過期清理。" >&2
    return 1
  fi

  # s3 ls 每行形如「2026-10-04 12:00:03   12345 prod-2026-10-04_120001.sql.gz」。
  # 固定格式的檔名照字典序排就是時間順序，最舊的在前。
  names="$(
    printf '%s\n' "${listing}" | awk '{print $4}' \
      | grep -E "^${label}-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}\.sql\.gz$" | sort || true
  )"
  total="$(printf '%s' "${names}" | grep -c . || true)"
  deletable=$(( total - keep_min ))

  if [ "${deletable}" -le 0 ]; then
    echo "${label}：S3 上共 ${total} 份，未超過至少保留的 ${keep_min} 份，不清理。"
    return 0
  fi

  # 名單從 fd 3 讀：aws_s3 用 docker run -i，會把 stdin 整個吃掉，
  # 若名單走 stdin，刪完第一份迴圈就讀不到下一行，其餘過期檔默默留著。
  while IFS= read -r name <&3; do
    ts="${name#"${label}"-}"
    ts="${ts%.sql.gz}"
    # 由舊到新排，遇到第一份還沒過期的，後面的也都沒過期。
    if [[ ! "${ts}" < "${cutoff}" ]]; then
      break
    fi
    if aws_s3 s3 rm "s3://${S3_BUCKET}/$(s3_key_of "${name}")" --only-show-errors </dev/null; then
      echo "已刪除過期備份：${name}"
      deleted=$(( deleted + 1 ))
    else
      echo "刪除失敗：${name}" >&2
      failed=1
    fi
  done 3< <(printf '%s\n' "${names}" | head -n "${deletable}")

  echo "${label}：S3 上原有 ${total} 份，刪除 ${deleted} 份超過 ${days} 天的備份。"
  return "${failed}"
}
