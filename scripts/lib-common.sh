#!/usr/bin/env bash
# ============================================================
# 備份腳本共用函式
#
# 三支腳本（backup-prod / refresh-dev / nas-daily）共用這裡的函式，
# 不各寫一份：版本偵測與連線遮蔽的邏輯只能有一個版本，
# 改一邊漏另一邊在這種無人看顧的排程裡特別難發現。
#
# 不直接執行這支檔案，由其他腳本 source。
# ============================================================

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
