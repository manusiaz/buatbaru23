#!/usr/bin/env bash
# Pulihkan database dari file backup. Membuat backup pengaman dulu, menghentikan app selama restore.
#   bash scripts/restore.sh backups/galeri-db-20261106-031700-harian.dump
set -Eeuo pipefail
source "$(dirname "$0")/_env.sh"
cd "$APP_DIR"
FILE="${1:-}"
[ -f "$FILE" ] || { echo "Pakai: bash scripts/restore.sh <file .dump>"; ls -1t "$APP_DIR"/backups/galeri-db-*.dump 2>/dev/null | head -5; exit 2; }
DB_URL="$(env_get DATABASE_URL)"
echo "Database di .env akan DITIMPA dengan isi: $FILE"
if [ "${RESTORE_YES:-}" != "PULIHKAN" ]; then
  read -r -p "Ketik PULIHKAN untuk lanjut: " jawab
  [ "$jawab" = "PULIHKAN" ] || { echo "Dibatalkan."; exit 1; }
fi
log "Backup pengaman sebelum restore..."
bash "$APP_DIR/scripts/backup.sh" pra-restore
HAS_DOCKER=0; command -v docker >/dev/null 2>&1 && HAS_DOCKER=1
[ "$HAS_DOCKER" = 1 ] && docker compose stop app || true
if command -v pg_restore >/dev/null 2>&1 && [ "$(env_get BACKUP_USE_DOCKER 0)" != "1" ]; then
  pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname="${DB_URL//host.docker.internal/127.0.0.1}" "$FILE"
else
  docker run --rm -i --add-host host.docker.internal:host-gateway -e PGURL="$DB_URL" postgres:17-alpine \
    sh -c 'pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname="$PGURL"' < "$FILE"
fi
[ "$HAS_DOCKER" = 1 ] && docker compose start app || true
log "Restore selesai."
