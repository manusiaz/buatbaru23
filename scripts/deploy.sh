#!/usr/bin/env bash
# Deploy di VPS: backup → ambil commit → build → jalankan → cek /healthz → rollback otomatis bila gagal.
#   bash scripts/deploy.sh [commit]     (bawaan: origin/main terbaru)
set -Eeuo pipefail
source "$(dirname "$0")/_env.sh"
cd "$APP_DIR"
mkdir -p "$APP_DIR/backups"
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || { echo "Deploy lain sedang berjalan." >&2; exit 1; }

BRANCH="$(env_get DEPLOY_BRANCH main)"
TARGET="${1:-origin/$BRANCH}"
[[ "$TARGET" =~ ^([0-9a-f]{7,40}|origin/[A-Za-z0-9._/-]+)$ ]] || { echo "Commit tidak valid: $TARGET" >&2; exit 2; }
PORT="$(env_get HOST_PORT 3000)"
IMAGE=galeri-seleksi

health() {
  local i
  for i in $(seq 1 "${HEALTH_TRIES:-40}"); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep "${HEALTH_SLEEP:-3}"
  done
  return 1
}

PREV="$(git rev-parse HEAD)"
git fetch --quiet origin "$BRANCH"
NEW="$(git rev-parse --verify "$TARGET^{commit}")"
git merge-base --is-ancestor "$NEW" "origin/$BRANCH" || { echo "Commit $NEW bukan bagian dari origin/$BRANCH" >&2; exit 2; }
if [ "$PREV" = "$NEW" ] && [ -z "${FORCE:-}" ] && health; then log "Sudah versi terbaru ($NEW)."; exit 0; fi

log "Deploy $PREV → $NEW"
bash "$APP_DIR/scripts/backup.sh" pra-deploy || { log "Backup pra-deploy GAGAL, deploy dibatalkan."; exit 1; }
HAS_PREV_IMAGE=0
if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then docker tag "$IMAGE:latest" "$IMAGE:prev"; HAS_PREV_IMAGE=1; fi

rollback() {
  log "ROLLBACK ke $PREV"
  git reset --quiet --hard "$PREV"
  if [ "$HAS_PREV_IMAGE" = 1 ]; then
    docker tag "$IMAGE:prev" "$IMAGE:latest"
    docker compose up -d --no-build app
  else
    docker compose up -d --build app
  fi
  if health; then log "Rollback berhasil, versi lama berjalan."; else log "PERHATIAN: versi lama juga tidak sehat. Cek: docker compose logs app"; fi
  echo "$(date '+%F %T') GAGAL $NEW → rollback $PREV" >> "$APP_DIR/backups/deploy.log"
  exit 1
}

git reset --quiet --hard "$NEW"
if ! docker compose build app; then log "Build gagal."; rollback; fi
if ! docker compose up -d app; then log "Gagal menjalankan container."; rollback; fi
if ! health; then
  log "Health check gagal setelah deploy. Log terakhir:"
  docker compose logs --tail=60 app || true
  rollback
fi
docker image prune -f >/dev/null 2>&1 || true
echo "$(date '+%F %T') OK $PREV → $NEW" >> "$APP_DIR/backups/deploy.log"
log "Deploy berhasil: $NEW"
