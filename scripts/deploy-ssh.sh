#!/usr/bin/env bash
# Perintah terkunci untuk kunci SSH deploy (authorized_keys "command=..."):
# kunci GitHub Actions HANYA bisa menjalankan "deploy <sha>", bukan shell bebas.
set -Eeuo pipefail
CMD="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$CMD" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec bash "$(dirname "$0")/deploy.sh" "${BASH_REMATCH[1]}"
fi
echo "Ditolak: hanya 'deploy <commit sha 40 karakter>' yang diizinkan." >&2
exit 1
