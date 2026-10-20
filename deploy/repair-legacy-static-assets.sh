#!/usr/bin/env bash
# ReadyPackets Portal — recover the confirmed one-host legacy shell-to-asset 404.
#
# Use only when a one-host portal serves a blank page, its HTML shell references
# /assets/<hash>.js, and the local/Nginx request for that exact asset returns 404.
# This is not a general installer, source updater, or migration tool.
#
# The helper atomically updates only the compiled server.js static-directory fix
# and the active legacy client/dist bundle from immutable reviewed source. It
# preserves portal.env byte-for-byte, TLS/Nginx/Cloudflare, database, uploads,
# backup history, users, MFA, aliases, and integration settings.
#
# Usage:
#   sudo bash deploy/repair-legacy-static-assets.sh --confirm-known-legacy-asset-404

set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
# Immutable source target that couples legacy client shell and asset directories.
readonly COMMIT="d412dee82c4ad4e4ee58dba0ec49037befd5dd9b"
readonly SOURCE_DIR="/srv/readypackets"
readonly APP_DIR="/opt/readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"
readonly APP_USER="readypackets"
readonly SERVICE="readypackets"
readonly WORK_ROOT="/var/lib/readypackets/recovery-work"

WORK_DIR=""
SOURCE_STAGE=""
NEXT_CLIENT_DIST=""
PREVIOUS_CLIENT_DIST=""
NEXT_SERVER=""
PREVIOUS_SERVER=""
CLIENT_SWAPPED="false"
SERVER_SWAPPED="false"
CONFIRMED="false"

fail() { printf '\n[ReadyPackets legacy asset repair] ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf '\n[ReadyPackets legacy asset repair] WARNING: %s\n' "$*" >&2; }
log() { printf '[ReadyPackets legacy asset repair] %s\n' "$*"; }

cleanup() {
  local status=$?
  trap - ERR EXIT
  # `fail` exits explicitly and does not necessarily invoke Bash's ERR trap.
  # Restore swapped runtime artifacts here as well, so every nonzero exit after
  # activation receives the same automatic rollback guarantee.
  if (( status != 0 )); then
    restore_previous_runtime
  fi
  [[ -z "$SOURCE_STAGE" || ! -d "$SOURCE_STAGE" ]] || git -C "$SOURCE_DIR" worktree remove --force "$SOURCE_STAGE" >/dev/null 2>&1 || true
  [[ -z "$WORK_DIR" || ! -d "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

restore_previous_runtime() {
  local restored="false"
  if [[ "$CLIENT_SWAPPED" == "true" && -n "$PREVIOUS_CLIENT_DIST" && -d "$PREVIOUS_CLIENT_DIST" ]]; then
    warn "Restoring the pre-repair legacy client bundle."
    rm -rf -- "${APP_DIR}/client/dist"
    mv -- "$PREVIOUS_CLIENT_DIST" "${APP_DIR}/client/dist"
    CLIENT_SWAPPED="false"
    restored="true"
  fi
  if [[ "$SERVER_SWAPPED" == "true" && -n "$PREVIOUS_SERVER" && -f "$PREVIOUS_SERVER" ]]; then
    warn "Restoring the pre-repair server bundle."
    rm -f -- "${APP_DIR}/dist/server.js"
    mv -- "$PREVIOUS_SERVER" "${APP_DIR}/dist/server.js"
    SERVER_SWAPPED="false"
    restored="true"
  fi
  if [[ "$restored" == "true" ]]; then
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
    systemctl restart "$SERVICE" >/dev/null 2>&1 || warn "Automatic rollback restored files, but ${SERVICE} did not restart; inspect its journal."
  fi
}
trap 'status=$?; restore_previous_runtime; exit "$status"' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-known-legacy-asset-404)
      CONFIRMED="true"
      shift
      ;;
    -h|--help)
      printf 'Usage: sudo bash deploy/repair-legacy-static-assets.sh --confirm-known-legacy-asset-404\n'
      printf 'Use only after confirming a one-host legacy HTML shell asset returns 404 through local Nginx.\n'
      exit 0
      ;;
    *) fail "Unsupported argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run this repair as root via sudo."
[[ -t 0 && -t 1 ]] || fail "Run from an interactive SSH terminal."
[[ "$CONFIRMED" == "true" ]] || fail "This narrow repair requires --confirm-known-legacy-asset-404."
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "The repair target must be a complete immutable Git SHA."
[[ -d "$SOURCE_DIR/.git" ]] || fail "Expected ReadyPackets source checkout is absent: $SOURCE_DIR."
[[ -d "${APP_DIR}/client/dist" && ! -L "${APP_DIR}/client/dist" ]] || fail "Expected legacy client bundle is absent or unsafe."
[[ -s "${APP_DIR}/client/dist/index.html" ]] || fail "The active legacy client shell is absent or incomplete."
[[ -f "${APP_DIR}/dist/server.js" && ! -L "${APP_DIR}/dist/server.js" ]] || fail "Expected active server bundle is absent or unsafe."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "Expected protected portal environment is absent or unsafe: $ENV_FILE."
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" == "root:readypackets:640" ]] || fail "Protected portal environment ownership or mode is unexpected; stop rather than loading it."
[[ -f /etc/readypackets/tls/nginx-tls.conf ]] || fail "Existing TLS include is absent. This targeted repair will not recreate certificate material."
command -v git >/dev/null 2>&1 || fail "git is required to retrieve immutable repair source."
command -v node >/dev/null 2>&1 || fail "Node.js is required to build the repair artifacts."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required to build the repair artifacts."
command -v curl >/dev/null 2>&1 || fail "curl is required to validate local TLS routing."
command -v systemctl >/dev/null 2>&1 || fail "systemctl is required to activate and roll back the server bundle safely."

ORIGIN="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
[[ "$ORIGIN" == "https://github.com/${REPOSITORY}.git" ]] || fail "The source checkout does not use the expected temporary-public ReadyPackets repository."
[[ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ]] || fail "The source checkout has local changes. Stop rather than overwriting unreviewed source."

# Read only the non-secret routing values needed to make sure this is the narrow
# one-host legacy condition. The protected environment is never printed, copied,
# exported, or written.
routing_values="$(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  printf '%s\037%s\n' "${APP_URL:-}" "${PUBLIC_SITE_URL:-}"
)"
IFS=$'\037' read -r APP_URL PUBLIC_SITE_URL <<< "$routing_values"
DOMAIN="${APP_URL#https://}"
[[ "$APP_URL" == "https://${DOMAIN}" && "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || fail "Protected APP_URL is not a valid HTTPS portal hostname."
[[ -z "$PUBLIC_SITE_URL" || "$PUBLIC_SITE_URL" == "$APP_URL" ]] \
  || fail "This repair is only for a one-host legacy portal. A split-host portal requires a separately diagnosed repair."

ENV_DIGEST_BEFORE="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
install -d -m 0700 -o root -g root "$WORK_ROOT"
WORK_DIR="$(mktemp -d "${WORK_ROOT}/legacy-static-assets.XXXXXX")"
SOURCE_STAGE="${WORK_DIR}/source"
BUILD_LOG="${WORK_DIR}/build.log"
NEXT_CLIENT_DIST="${APP_DIR}/client/.dist.legacy-assets-next.$$"
NEXT_SERVER="${APP_DIR}/dist/.server.js.legacy-assets-next.$$"

log "Fetching reviewed immutable legacy asset repair ${COMMIT}"
git -C "$SOURCE_DIR" fetch --depth=2 origin "$COMMIT"
RESOLVED_COMMIT="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)"
[[ "$RESOLVED_COMMIT" == "$COMMIT" ]] || fail "Fetched source did not match the reviewed repair commit."
TARGET_PARENT="$(git -C "$SOURCE_DIR" rev-parse "${RESOLVED_COMMIT}^")"

# The target must remain a narrowly reviewed server static-route correction.
mapfile -t target_files < <(git -C "$SOURCE_DIR" diff --name-only "$TARGET_PARENT" "$RESOLVED_COMMIT")
(( ${#target_files[@]} > 0 )) || fail "The repair target unexpectedly has no reviewed changes."
for target_file in "${target_files[@]}"; do
  case "$target_file" in
    SESSION_LOG.md|server/app.ts|tests/legacyStaticBundleRouting.test.ts) ;;
    *) fail "The repair target changes an out-of-scope path (${target_file}); use the controlled platform update workflow instead." ;;
  esac
done
# The target inherits the legacy graph-safe build fix. Refuse a source target
# that restores manual chunks before compiling a replacement client bundle.
git -C "$SOURCE_DIR" show "${RESOLVED_COMMIT}:vite.config.ts" | grep -Fq "Keep automatic graph-aware chunking." \
  || fail "The immutable repair target does not contain the reviewed legacy client build fix."
git -C "$SOURCE_DIR" show "${RESOLVED_COMMIT}:vite.config.ts" | grep -Fq "manualChunks" \
  && fail "The immutable repair target reintroduces manual client chunking."

git -C "$SOURCE_DIR" worktree add --detach "$SOURCE_STAGE" "$RESOLVED_COMMIT"
(
  cd "$SOURCE_STAGE"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  # Vite is needed only in the isolated worktree, so dependency installation may
  # not omit development dependencies before the production-mode builds run.
  pnpm install --frozen-lockfile
  NODE_ENV=production pnpm run build:legacy 2>&1 | tee "$BUILD_LOG"
  NODE_ENV=production pnpm run build:server 2>&1 | tee -a "$BUILD_LOG"
)
if grep -Fq 'Circular chunk:' "$BUILD_LOG"; then
  fail "The staged legacy client build still reports a circular chunk; do not activate it."
fi
STAGED_CLIENT_DIST="${SOURCE_STAGE}/client/dist"
STAGED_SERVER="${SOURCE_STAGE}/dist/server.js"
[[ -s "${STAGED_CLIENT_DIST}/index.html" ]] || fail "The staged legacy client shell is missing."
[[ -s "$STAGED_SERVER" ]] || fail "The staged server bundle is missing."

mapfile -t client_assets < <(grep -oE '(src|href)="/assets/[A-Za-z0-9._-]+\.(js|css)"' "${STAGED_CLIENT_DIST}/index.html" | sed -E 's/^(src|href)="\/assets\///; s/"$//' | sort -u)
(( ${#client_assets[@]} > 0 )) || fail "The staged legacy client shell does not reference built assets."
for client_asset in "${client_assets[@]}"; do
  [[ "$client_asset" =~ ^[A-Za-z0-9._-]+\.(js|css)$ ]] || fail "The staged legacy shell contains an unsafe asset reference."
  [[ -s "${STAGED_CLIENT_DIST}/assets/${client_asset}" ]] || fail "The staged legacy client asset is missing: ${client_asset}."
done

ENV_DIGEST_AFTER_BUILD="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
[[ "$ENV_DIGEST_AFTER_BUILD" == "$ENV_DIGEST_BEFORE" ]] || fail "portal.env changed unexpectedly before activation; stop rather than risk configuration loss."

# Stage next files next to their active counterparts, set the dedicated runtime
# group permissions, then use same-filesystem renames for an atomic transition.
rm -rf -- "$NEXT_CLIENT_DIST"
rm -f -- "$NEXT_SERVER"
cp -a "$STAGED_CLIENT_DIST" "$NEXT_CLIENT_DIST"
cp --preserve=mode "$STAGED_SERVER" "$NEXT_SERVER"
chown -R root:"$APP_USER" "$NEXT_CLIENT_DIST"
find "$NEXT_CLIENT_DIST" -type d -exec chmod 0750 {} +
find "$NEXT_CLIENT_DIST" -type f -exec chmod 0640 {} +
chown root:"$APP_USER" "$NEXT_SERVER"
chmod 0640 "$NEXT_SERVER"

PREVIOUS_CLIENT_DIST="${APP_DIR}/client/.dist.legacy-assets-previous.$$"
PREVIOUS_SERVER="${APP_DIR}/dist/.server.js.legacy-assets-previous.$$"
mv -- "${APP_DIR}/client/dist" "$PREVIOUS_CLIENT_DIST"
CLIENT_SWAPPED="true"
mv -- "$NEXT_CLIENT_DIST" "${APP_DIR}/client/dist"
mv -- "${APP_DIR}/dist/server.js" "$PREVIOUS_SERVER"
SERVER_SWAPPED="true"
mv -- "$NEXT_SERVER" "${APP_DIR}/dist/server.js"

# A restart is required only because the static-directory selection lives in the
# server bundle. The ERR trap restores both artifacts and restarts the old server
# if readiness or asset validation fails.
systemctl reset-failed "$SERVICE"
systemctl restart "$SERVICE"
for _attempt in $(seq 1 20); do
  if systemctl is-active --quiet "$SERVICE" && curl --noproxy '*' --fail --silent --show-error --insecure \
    --connect-timeout 3 --max-time 10 \
    --resolve "${DOMAIN}:443:127.0.0.1" \
    "https://${DOMAIN}/api/health" >/dev/null; then
    break
  fi
  sleep 2
done
systemctl is-active --quiet "$SERVICE" || fail "${SERVICE} did not become active after the narrow server bundle repair."
curl --noproxy '*' --fail --silent --show-error --insecure \
  --connect-timeout 3 --max-time 10 \
  --resolve "${DOMAIN}:443:127.0.0.1" \
  "https://${DOMAIN}/api/health" >/dev/null

SHELL_HEADERS="${WORK_DIR}/legacy-shell.headers"
SHELL_BODY="${WORK_DIR}/legacy-shell.html"
curl --noproxy '*' --fail --silent --show-error --insecure \
  --connect-timeout 3 --max-time 15 \
  --resolve "${DOMAIN}:443:127.0.0.1" \
  -D "$SHELL_HEADERS" -o "$SHELL_BODY" \
  "https://${DOMAIN}/login"
grep -Eqi '^content-security-policy: ' "$SHELL_HEADERS" || fail "The repaired legacy shell response has no Content-Security-Policy header."
grep -Fq '<div id="root"></div>' "$SHELL_BODY" || fail "The repaired legacy client shell is malformed."
for client_asset in "${client_assets[@]}"; do
  curl --noproxy '*' --fail --silent --show-error --insecure \
    --connect-timeout 3 --max-time 15 \
    --resolve "${DOMAIN}:443:127.0.0.1" \
    "https://${DOMAIN}/assets/${client_asset}" -o /dev/null
done

ENV_DIGEST_AFTER="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
[[ "$ENV_DIGEST_AFTER" == "$ENV_DIGEST_BEFORE" ]] || fail "portal.env changed unexpectedly; the pre-repair server and client bundles were restored."

rm -rf -- "$PREVIOUS_CLIENT_DIST"
rm -f -- "$PREVIOUS_SERVER"
CLIENT_SWAPPED="false"
SERVER_SWAPPED="false"
printf '\nReadyPackets legacy static-asset repair completed.\n'
printf '  Installed server/client source: %s\n' "$RESOLVED_COMMIT"
printf '  Active client bundle: client/dist\n'
printf '  Canonical portal: https://%s/login\n' "$DOMAIN"
printf '  Protected environment: byte-for-byte unchanged\n'
printf '  TLS/Nginx/Cloudflare/database/files/accounts/integrations: unchanged\n'
