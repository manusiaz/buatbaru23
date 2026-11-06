#!/usr/bin/env bash
# Backup database (pg_dump format custom) + file penting di /data (logo, bukti top up, QRIS).
# Pratinjau foto tidak ikut (bisa dibuat ulang dari Google Drive).
#   bash scripts/backup.sh [label]        label: harian | pra-deploy | manual (bawaan: manual)
# Variabel opsional: BACKUP_DIR (bawaan ./backups), BACKUP_KEEP_DAYS (14), BACKUP_RCLONE_REMOTE (salin ke cloud via rclone)
set -Eeuo pipefail
source "$(dirname "$0")/_env.sh"
cd "$APP_DIR"

LABEL="${1:-manual}"
[[ "$LABEL" =~ ^[a-z0-9-]{1,20}$ ]] || { echo "Label tidak valid: $LABEL" >&2; exit 2; }
BACKUP_DIR="$(env_get BACKUP_DIR "$APP_DIR/backups")"
KEEP_DAYS="$(env_get BACKUP_KEEP_DAYS 14)"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || { echo "BACKUP_KEEP_DAYS harus angka" >&2; exit 2; }
DB_URL="$(env_get DATABASE_URL)"
[ -n "$DB_URL" ] || { echo "DATABASE_URL tidak ditemukan (env atau .env)" >&2; exit 2; }

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
DB_FILE="$BACKUP_DIR/galeri-db-$TS-$LABEL.dump"
TMP="$DB_FILE.tmp"
trap 'rm -f -- "$TMP"' EXIT

# 1) Database. Pakai pg_dump di host bila ada; kalau tidak, lewat container postgres resmi.
if command -v pg_dump >/dev/null 2>&1 && [ "$(env_get BACKUP_USE_DOCKER 0)" != "1" ]; then
  HOST_URL="${DB_URL//host.docker.internal/127.0.0.1}"
  PGCONNECT_TIMEOUT=15 pg_dump --format=custom --no-owner --no-privileges --dbname="$HOST_URL" --file="$TMP"
  pg_restore --list "$TMP" >/dev/null   # verifikasi file bisa dibaca
else
  docker run --rm -i --add-host host.docker.internal:host-gateway -e PGURL="$DB_URL" postgres:17-alpine \
    sh -c 'pg_dump --format=custom --no-owner --no-privileges --dbname="$PGURL"' > "$TMP"
  docker run --rm -i postgres:17-alpine pg_restore --list < "$TMP" >/dev/null
fi
[ -s "$TMP" ] || { echo "Backup database kosong" >&2; exit 1; }
mv -- "$TMP" "$DB_FILE"
trap - EXIT
log "Database: $DB_FILE ($(du -h "$DB_FILE" | cut -f1))"

# 2) File penting di volume /data (butuh container app berjalan)
DATA_FILE=""
if command -v docker >/dev/null 2>&1 && docker compose ps --status running -q app 2>/dev/null | grep -q .; then
  DATA_FILE="$BACKUP_DIR/galeri-data-$TS-$LABEL.tar.gz"
  docker compose exec -T app tar czf - --exclude=./previews -C /data . > "$DATA_FILE"
  log "File /data: $DATA_FILE ($(du -h "$DATA_FILE" | cut -f1))"
else
  log "Lewati backup /data: container app tidak berjalan atau Docker tidak ada"
fi

# 3) Salin ke penyimpanan luar (opsional)
REMOTE="$(env_get BACKUP_RCLONE_REMOTE)"
if [ -n "$REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$DB_FILE" "$REMOTE" && { [ -z "$DATA_FILE" ] || rclone copy "$DATA_FILE" "$REMOTE"; } && log "Disalin ke $REMOTE"
  else
    log "PERINGATAN: BACKUP_RCLONE_REMOTE diisi tapi rclone tidak terpasang"
  fi
fi

# 4) Retensi: hapus backup lebih tua dari KEEP_DAYS hari (hanya file buatan skrip ini, di folder backup saja)
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'galeri-db-*.dump' -o -name 'galeri-data-*.tar.gz' \) -mtime +"$KEEP_DAYS" -print -delete \
  | sed 's/^/[retensi] dihapus: /'
log "Selesai."
