#!/usr/bin/env bash
# ReadyPackets Portal — repair the confirmed split-client runtime cycle on an
# existing native VPS installation.
#
# Run ONLY when the portal shell renders blank after the server/local health is
# otherwise healthy and the known manual React/vendor chunk cycle is confirmed.
#
# This is intentionally NOT a general installer or platform update. It stages
# and atomically replaces only client/dist-portal from the immutable build fix.
# It preserves portal.env byte-for-byte, server.js, Cloudflare Origin CA TLS,
# Nginx, database, uploads, backups, aliases, integrations, and user accounts.
#
# Usage:
#   sudo bash deploy/repair-split-portal-bundle.sh --confirm-known-split-bundle-cycle

set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
# Immutable release that removes the unsafe split React/vendor manual chunks.
readonly COMMIT="d5b25e18b3f6b52ab3d82c02a9775f368c9e8cc1"
readonly SOURCE_DIR="/srv/readypackets"
readonly APP_DIR="/opt/readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"
readonly APP_USER="readypackets"
readonly WORK_ROOT="/var/lib/readypackets/recovery-work"

WORK_DIR=""
SOURCE_STAGE=""
PREVIOUS_PORTAL_DIST=""
PORTAL_DIST_SWAPPED="false"
CONFIRMED="false"

fail() { printf '\n[ReadyPackets portal bundle repair] ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf '\n[ReadyPackets portal bundle repair] WARNING: %s\n' "$*" >&2; }
log() { printf '[ReadyPackets portal bundle repair] %s\n' "$*"; }

cleanup() {
  local status=$?
  trap - EXIT
  [[ -z "$SOURCE_STAGE" || ! -d "$SOURCE_STAGE" ]] || git -C "$SOURCE_DIR" worktree remove --force "$SOURCE_STAGE" >/dev/null 2>&1 || true
  [[ -z "$WORK_DIR" || ! -d "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-known-split-bundle-cycle)
      CONFIRMED="true"
      shift
      ;;
    -h|--help)
      printf 'Usage: sudo bash deploy/repair-split-portal-bundle.sh --confirm-known-split-bundle-cycle\n'
      printf 'Use only after confirming a blank portal page from the known split React/vendor circular-chunk issue.\n'
      exit 0
      ;;
    *) fail "Unsupported argument: $1" ;;
  esac
done

restore_previous_portal_dist() {
  [[ "$PORTAL_DIST_SWAPPED" == "true" && -n "$PREVIOUS_PORTAL_DIST" && -d "$PREVIOUS_PORTAL_DIST" ]] || return 0
  warn "Restoring the pre-repair portal client bundle because post-swap validation did not succeed."
  rm -rf -- "${APP_DIR}/client/dist-portal"
  mv -- "$PREVIOUS_PORTAL_DIST" "${APP_DIR}/client/dist-portal"
  PORTAL_DIST_SWAPPED="false"
}
trap 'status=$?; restore_previous_portal_dist; exit "$status"' ERR

[[ $EUID -eq 0 ]] || fail "Run this repair as root via sudo."
[[ -t 0 && -t 1 ]] || fail "Run from an interactive SSH terminal."
[[ "$CONFIRMED" == "true" ]] || fail "This narrow repair requires --confirm-known-split-bundle-cycle."
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "The split-bundle repair release must be a complete immutable Git SHA."
[[ -d "$SOURCE_DIR/.git" ]] || fail "Expected ReadyPackets source checkout is absent: $SOURCE_DIR."
[[ -d "${APP_DIR}/client/dist-portal" && ! -L "${APP_DIR}/client/dist-portal" ]] || fail "Expected active portal client bundle is absent or unsafe."
[[ -s "${APP_DIR}/client/dist-portal/portal.html" ]] || fail "The active portal shell is absent or incomplete."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "Expected protected portal environment is absent or unsafe: $ENV_FILE."
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" == "root:readypackets:640" ]] || fail "Protected portal environment ownership or mode is unexpected; stop rather than loading it."
[[ -f /etc/readypackets/tls/nginx-tls.conf ]] || fail "Existing TLS include is absent. This targeted repair will not recreate certificate material."
command -v git >/dev/null 2>&1 || fail "git is required to retrieve the immutable repair source."
command -v node >/dev/null 2>&1 || fail "Node.js is required to build the repaired portal bundle."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required to build the repaired portal bundle."
command -v curl >/dev/null 2>&1 || fail "curl is required to verify the repaired portal shell."

ORIGIN="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
[[ "$ORIGIN" == "https://github.com/${REPOSITORY}.git" ]] || fail "The source checkout does not use the expected temporary-public ReadyPackets repository."
[[ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ]] || fail "The source checkout has local changes. Stop rather than overwriting unreviewed source."

# Read only the canonical non-secret host value after validating the protected
# file. The environment is never written, copied, printed, or exported.
routing_values="$(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  printf '%s\n' "${APP_URL:-}"
)"
DOMAIN="${routing_values#https://}"
[[ "$routing_values" == "https://${DOMAIN}" && "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || fail "Protected APP_URL is not a valid HTTPS portal hostname."

ENV_DIGEST_BEFORE="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
install -d -m 0700 -o root -g root "$WORK_ROOT"
WORK_DIR="$(mktemp -d "${WORK_ROOT}/split-portal-bundle.XXXXXX")"
SOURCE_STAGE="${WORK_DIR}/source"
BUILD_LOG="${WORK_DIR}/portal-build.log"
NEXT_PORTAL_DIST="${APP_DIR}/client/.dist-portal.split-next.$$"

log "Fetching reviewed immutable split-bundle fix ${COMMIT}"
# The parent is fetched so the helper can prove the pinned target itself did not
# introduce server, dependency, deployment, or schema changes. Comparing the
# target with the local checkout would reject a safe repair on an older fresh
# install merely because unrelated releases were published in between.
git -C "$SOURCE_DIR" fetch --depth=2 origin "$COMMIT"
RESOLVED_COMMIT="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)"
[[ "$RESOLVED_COMMIT" == "$COMMIT" ]] || fail "Fetched source did not match the reviewed split-bundle repair commit."

# This helper must never become a dependency, server, or schema update path.
TARGET_PARENT="$(git -C "$SOURCE_DIR" rev-parse "${RESOLVED_COMMIT}^")"
if ! git -C "$SOURCE_DIR" diff --quiet "$TARGET_PARENT" "$RESOLVED_COMMIT" -- package.json pnpm-lock.yaml; then
  fail "The target release changes package dependencies; use the controlled platform update workflow instead."
fi
if ! git -C "$SOURCE_DIR" diff --quiet "$TARGET_PARENT" "$RESOLVED_COMMIT" -- drizzle/migrations server deploy; then
  fail "The target release changes server, deployment, or migration code; use the controlled platform update workflow instead."
fi

git -C "$SOURCE_DIR" worktree add --detach "$SOURCE_STAGE" "$RESOLVED_COMMIT"
(
  cd "$SOURCE_STAGE"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  # Vite is a development dependency required only in this isolated staging
  # worktree. Do not set NODE_ENV=production for installation or pnpm may omit
  # the compiler before the production-mode build can run.
  pnpm install --frozen-lockfile
  NODE_ENV=production pnpm run build:portal 2>&1 | tee "$BUILD_LOG"
)
if grep -Fq 'Circular chunk:' "$BUILD_LOG"; then
  fail "The staged portal build still reports a circular chunk; do not activate it."
fi
[[ -s "${SOURCE_STAGE}/client/dist-portal/portal.html" ]] || fail "The staged portal shell is missing."

# Verify every emitted shell asset is a bounded local path and a nonempty file.
mapfile -t portal_assets < <(grep -oE '(src|href)="/assets/[A-Za-z0-9._-]+\.(js|css)"' "${SOURCE_STAGE}/client/dist-portal/portal.html" | sed -E 's/^(src|href)="\/assets\///; s/"$//' | sort -u)
(( ${#portal_assets[@]} > 0 )) || fail "The staged portal shell does not reference any built assets."
for portal_asset in "${portal_assets[@]}"; do
  [[ "$portal_asset" =~ ^[A-Za-z0-9._-]+\.(js|css)$ ]] || fail "The staged portal shell contains an unsafe asset reference."
  [[ -s "${SOURCE_STAGE}/client/dist-portal/assets/${portal_asset}" ]] || fail "The staged portal asset is missing: ${portal_asset}."
done

ENV_DIGEST_AFTER_BUILD="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
[[ "$ENV_DIGEST_AFTER_BUILD" == "$ENV_DIGEST_BEFORE" ]] || fail "portal.env changed unexpectedly before activation; stop rather than risk configuration loss."

# Build output is copied beside the active runtime, permissioned identically for
# the dedicated service group, then replaced with same-filesystem directory
# renames. The prior directory remains available for automatic rollback.
rm -rf -- "$NEXT_PORTAL_DIST"
cp -a "${SOURCE_STAGE}/client/dist-portal" "$NEXT_PORTAL_DIST"
chown -R root:"$APP_USER" "$NEXT_PORTAL_DIST"
find "$NEXT_PORTAL_DIST" -type d -exec chmod 0750 {} +
find "$NEXT_PORTAL_DIST" -type f -exec chmod 0640 {} +
PREVIOUS_PORTAL_DIST="${APP_DIR}/client/.dist-portal.split-previous.$$"
mv -- "${APP_DIR}/client/dist-portal" "$PREVIOUS_PORTAL_DIST"
PORTAL_DIST_SWAPPED="true"
mv -- "$NEXT_PORTAL_DIST" "${APP_DIR}/client/dist-portal"

# serveIndex reads the shell on each request. Validate it and every first-level
# built JS/CSS dependency through the existing local Nginx TLS route, bypassing
# external proxies and without exposing a local port publicly.
SHELL_HEADERS="${WORK_DIR}/portal-shell.headers"
SHELL_BODY="${WORK_DIR}/portal-shell.html"
curl --noproxy '*' --fail --silent --show-error --insecure \
  --connect-timeout 3 --max-time 15 \
  --resolve "${DOMAIN}:443:127.0.0.1" \
  -D "$SHELL_HEADERS" -o "$SHELL_BODY" \
  "https://${DOMAIN}/login"
grep -Eqi '^content-security-policy: ' "$SHELL_HEADERS" || fail "The repaired portal shell response has no Content-Security-Policy header."
grep -Fq '<div id="root"></div>' "$SHELL_BODY" || fail "The repaired portal shell is malformed."
for portal_asset in "${portal_assets[@]}"; do
  curl --noproxy '*' --fail --silent --show-error --insecure \
    --connect-timeout 3 --max-time 15 \
    --resolve "${DOMAIN}:443:127.0.0.1" \
    "https://${DOMAIN}/assets/${portal_asset}" -o /dev/null
done

ENV_DIGEST_AFTER="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
[[ "$ENV_DIGEST_AFTER" == "$ENV_DIGEST_BEFORE" ]] || fail "portal.env changed unexpectedly; the pre-repair portal bundle was restored."

rm -rf -- "$PREVIOUS_PORTAL_DIST"
PORTAL_DIST_SWAPPED="false"
printf '\nReadyPackets portal bundle repair completed.\n'
printf '  Installed portal bundle source: %s\n' "$RESOLVED_COMMIT"
printf '  Canonical portal: https://%s/login\n' "$DOMAIN"
printf '  Protected environment: byte-for-byte unchanged\n'
printf '  Server/TLS/Nginx/database/administrator: unchanged\n'
