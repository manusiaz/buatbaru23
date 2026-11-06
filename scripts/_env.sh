# Helper bersama: baca variabel dari .env tanpa mengeksekusinya (nilai bisa berisi karakter shell).
# Pemakaian: env_get NAMA [bawaan]
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
env_get() {
  local name="$1" def="${2-}" line val
  if [ -n "${!name-}" ]; then printf '%s' "${!name}"; return; fi
  if [ -f "$APP_DIR/.env" ]; then
    line="$(grep -E "^[[:space:]]*${name}=" "$APP_DIR/.env" | tail -n1 || true)"
    if [ -n "$line" ]; then
      val="${line#*=}"
      val="${val%$'\r'}"
      case "$val" in \"*\") val="${val#\"}"; val="${val%\"}";; \'*\') val="${val#\'}"; val="${val%\'}";; esac
      printf '%s' "$val"; return
    fi
  fi
  printf '%s' "$def"
}
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
