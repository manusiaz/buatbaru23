#!/usr/bin/env bash
# Pasang backup harian otomatis (cron user ini). Aman dijalankan berulang.
#   bash scripts/install-cron.sh [jam-menit, bawaan "17 3" = 03:17]
set -Eeuo pipefail
source "$(dirname "$0")/_env.sh"
WAKTU="${1:-17 3}"
[[ "$WAKTU" =~ ^[0-9]{1,2}\ [0-9]{1,2}$ ]] || { echo "Format: \"MENIT JAM\", mis. \"17 3\"" >&2; exit 2; }
mkdir -p "$APP_DIR/backups"
BARIS="$WAKTU * * * cd '$APP_DIR' && bash scripts/backup.sh harian >> '$APP_DIR/backups/backup.log' 2>&1 # galeri-seleksi-backup"
( crontab -l 2>/dev/null | grep -v 'galeri-seleksi-backup' || true; echo "$BARIS" ) | crontab -
echo "Terpasang: $BARIS"
