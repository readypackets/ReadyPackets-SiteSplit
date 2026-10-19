#!/usr/bin/env bash
# ReadyPackets Portal — repair the confirmed Express 5 anonymous-wildcard
# startup failure on an existing native VPS installation.
#
# Run ONLY when the VPS-local readypackets journal records:
#   Missing parameter name at index 1: *
#
# This is intentionally NOT a general installer or platform update. It stages
# and atomically replaces only dist/server.js from the immutable application-fix
# commit. It preserves portal.env byte-for-byte, the existing Cloudflare Origin
# CA certificate/private key, Nginx configuration, database, uploads, backups,
# aliases, optional integrations, and administrator accounts.
#
# Usage:
#   sudo bash deploy/repair-express5-startup.sh

set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
# Immutable application-fix release; this later helper retrieves it explicitly.
readonly COMMIT="9cce95ff4ca123d3c358659140c7f25b9feee5d9"
readonly SOURCE_DIR="/srv/readypackets"
readonly APP_DIR="/opt/readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"
readonly APP_USER="readypackets"
readonly SERVICE="readypackets"
readonly WORK_ROOT="/var/lib/readypackets/recovery-work"

WORK_DIR=""
SOURCE_STAGE=""
PREVIOUS_SERVER=""
SERVER_SWAPPED="false"

fail() { printf '\n[ReadyPackets repair] ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf '\n[ReadyPackets repair] WARNING: %s\n' "$*" >&2; }
log() { printf '[ReadyPackets repair] %s\n' "$*"; }

cleanup() {
  local status=$?
  trap - EXIT
  [[ -z "$SOURCE_STAGE" || ! -d "$SOURCE_STAGE" ]] || git -C "$SOURCE_DIR" worktree remove --force "$SOURCE_STAGE" >/dev/null 2>&1 || true
  [[ -z "$WORK_DIR" || ! -d "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

restore_previous_server() {
  [[ "$SERVER_SWAPPED" == "true" && -n "$PREVIOUS_SERVER" && -f "$PREVIOUS_SERVER" ]] || return 0
  warn "Restoring the pre-repair server bundle because local readiness did not succeed."
  mv -f -- "$PREVIOUS_SERVER" "${APP_DIR}/dist/server.js"
  SERVER_SWAPPED="false"
  systemctl reset-failed "$SERVICE" || true
  systemctl restart "$SERVICE" || true
}
trap 'status=$?; restore_previous_server; exit "$status"' ERR

[[ $EUID -eq 0 ]] || fail "Run this repair as root via sudo."
[[ -t 0 && -t 1 ]] || fail "Run from an interactive SSH terminal."
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "The application-fix release must be a complete immutable Git SHA."
[[ -d "$SOURCE_DIR/.git" ]] || fail "Expected ReadyPackets source checkout is absent: $SOURCE_DIR."
[[ -d "$APP_DIR" && -d "${APP_DIR}/dist" ]] || fail "Expected ReadyPackets runtime is absent or incomplete: $APP_DIR."
[[ -f "${APP_DIR}/dist/server.js" && ! -L "${APP_DIR}/dist/server.js" ]] || fail "The active server bundle is absent or unsafe."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "Expected protected portal environment is absent or unsafe: $ENV_FILE."
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" == "root:readypackets:640" ]] || fail "Protected portal environment ownership or mode is unexpected; stop rather than loading it."
[[ -f /etc/readypackets/tls/nginx-tls.conf ]] || fail "Existing TLS include is absent. This targeted repair will not recreate certificate material."
command -v git >/dev/null 2>&1 || fail "git is required to retrieve the immutable repair source."
command -v node >/dev/null 2>&1 || fail "Node.js is required to build the repaired server bundle."
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required to build the repaired server bundle."
if ! journalctl -u "$SERVICE" -b --no-pager | grep -Fq "Missing parameter name at index 1: *"; then
  fail "The confirmed Express 5 anonymous-wildcard startup signature was not found in this boot's journal. Do not apply this narrow repair to a different service failure."
fi

ORIGIN="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
[[ "$ORIGIN" == "https://github.com/${REPOSITORY}.git" ]] || fail "The source checkout does not use the expected temporary-public ReadyPackets repository."
[[ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ]] || fail "The source checkout has local changes. Stop rather than overwriting unreviewed source."

# Read only non-secret routing metadata in a child shell after ownership/mode
# validation. The portal environment itself is never written, copied, printed,
# or exported by this repair process.
routing_values="$(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  printf '%s\037%s\n' "${APP_URL:-}" "${PORTAL_ALIASES:-}"
)"
IFS=$'\037' read -r APP_URL PORTAL_ALIASES <<< "$routing_values"
DOMAIN="${APP_URL#https://}"
[[ "$APP_URL" == "https://${DOMAIN}" && "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || fail "Protected APP_URL is not a valid HTTPS portal hostname."
if [[ -n "$PORTAL_ALIASES" ]]; then
  IFS=',' read -r -a aliases <<< "$PORTAL_ALIASES"
  (( ${#aliases[@]} <= 5 )) || fail "Protected portal alias list exceeds the configured maximum."
else
  aliases=()
fi

ENV_DIGEST_BEFORE="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
install -d -m 0700 -o root -g root "$WORK_ROOT"
WORK_DIR="$(mktemp -d "${WORK_ROOT}/express5-startup.XXXXXX")"
SOURCE_STAGE="${WORK_DIR}/source"

log "Fetching reviewed immutable application fix ${COMMIT}"
git -C "$SOURCE_DIR" fetch --depth=1 origin "$COMMIT"
RESOLVED_COMMIT="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)"
[[ "$RESOLVED_COMMIT" == "$COMMIT" ]] || fail "Fetched source did not match the reviewed application-fix commit."

# This helper fixes one bundled server route. It must never silently become a
# dependency or schema update path: those require the controlled platform
# update flow and its complete configuration-preserving snapshot process.
if ! git -C "$SOURCE_DIR" diff --quiet HEAD "$RESOLVED_COMMIT" -- package.json pnpm-lock.yaml; then
  fail "The targeted repair release changes package dependencies; use the controlled platform update workflow instead."
fi
if ! git -C "$SOURCE_DIR" diff --quiet HEAD "$RESOLVED_COMMIT" -- drizzle/migrations; then
  fail "The targeted repair release changes database migrations; use the controlled platform update workflow instead."
fi

# Preserve the canonical source checkout for its future controlled-update role.
# A detached staging worktree is where dependencies and the replacement bundle
# are created, so no production runtime/configuration file is modified while
# the replacement is being validated.
git -C "$SOURCE_DIR" worktree add --detach "$SOURCE_STAGE" "$RESOLVED_COMMIT"

(
  cd "$SOURCE_STAGE"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  pnpm install --frozen-lockfile
  pnpm exec esbuild server/index.ts --bundle --platform=node --target=node22 \
    --format=esm --packages=external --outfile="${WORK_DIR}/server.js"
)
[[ -s "${WORK_DIR}/server.js" ]] || fail "The staged server bundle is missing."
node --check "${WORK_DIR}/server.js" >/dev/null || fail "The staged server bundle is not valid JavaScript."

# The fixed application source must not contain the Express 4 anonymous
# wildcard that caused this exact outage. Verify before the single-file swap.
grep -Fq 'app.get("/{*splat}", async (req: Request, res: Response) => {' "${SOURCE_STAGE}/server/app.ts" \
  || fail "The staged source does not contain the reviewed Express 5 SPA fallback."
if grep -Fq 'app.get("*", async (req: Request, res: Response) => {' "${SOURCE_STAGE}/server/app.ts"; then
  fail "The staged source still contains the unsafe Express 4 anonymous wildcard."
fi

# Nothing above is allowed to change protected configuration. Verify this before
# atomically swapping the single compiled server artifact.
ENV_DIGEST_AFTER_BUILD="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
[[ "$ENV_DIGEST_AFTER_BUILD" == "$ENV_DIGEST_BEFORE" ]] || fail "portal.env changed unexpectedly before activation; stop rather than risk configuration loss."

NEXT_SERVER="${APP_DIR}/dist/.server.js.express5-next.$$"
PREVIOUS_SERVER="${APP_DIR}/dist/.server.js.express5-previous.$$"
install -o root -g "$APP_USER" -m 0640 "${WORK_DIR}/server.js" "$NEXT_SERVER"
mv -- "${APP_DIR}/dist/server.js" "$PREVIOUS_SERVER"
SERVER_SWAPPED="true"
mv -- "$NEXT_SERVER" "${APP_DIR}/dist/server.js"

# Do not change the service unit, TLS, Nginx, database, or configuration. Clear
# only the systemd crash-rate limit triggered by the known bad bundle, restart,
# then require the same bounded loopback readiness property as a fresh install.
systemctl reset-failed "$SERVICE" || true
systemctl restart "$SERVICE"

readiness_attempts=20
readiness_delay_seconds=2
readiness_succeeded="false"
for ((attempt=1; attempt<=readiness_attempts; attempt++)); do
  if systemctl is-active --quiet "$SERVICE" \
    && curl --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time 5 \
      -H "Host: ${DOMAIN}" -H 'X-Forwarded-Proto: https' \
      http://127.0.0.1:3000/api/health/ready >/dev/null; then
    readiness_succeeded="true"
    break
  fi
  if (( attempt < readiness_attempts )); then sleep "$readiness_delay_seconds"; fi
done

if [[ "$readiness_succeeded" != "true" ]]; then
  restore_previous_server
  systemctl --no-pager --full status "$SERVICE" || true
  journalctl -u "$SERVICE" -b -n 80 --no-pager || true
  fail "The repaired server did not become locally ready; the pre-repair bundle was restored."
fi

ENV_DIGEST_AFTER="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
if [[ "$ENV_DIGEST_AFTER" != "$ENV_DIGEST_BEFORE" ]]; then
  restore_previous_server
  fail "portal.env changed unexpectedly; the pre-repair server bundle was restored."
fi

VERIFY_ARGS=(--domain "$DOMAIN" --local-only)
for alias in "${aliases[@]}"; do VERIFY_ARGS+=(--portal-alias "$alias"); done
bash "${SOURCE_STAGE}/deploy/verify-public-connectivity.sh" "${VERIFY_ARGS[@]}"

PUBLIC_VERIFY_ARGS=(--domain "$DOMAIN")
for alias in "${aliases[@]}"; do PUBLIC_VERIFY_ARGS+=(--portal-alias "$alias"); done
if bash "${SOURCE_STAGE}/deploy/verify-public-connectivity.sh" "${PUBLIC_VERIFY_ARGS[@]}"; then
  printf '\n[ReadyPackets repair] Public HTTPS verification: PASS\n'
else
  status=$?
  if [[ "$status" -eq 2 ]]; then
    warn "Local portal repair is complete; public DNS/Cloudflare verification is pending."
  else
    warn "Local repair succeeded, but public verification failed. Review the verifier output without changing portal.env or TLS material."
  fi
fi

rm -f -- "$PREVIOUS_SERVER"
SERVER_SWAPPED="false"
printf '\nReadyPackets Express 5 startup repair completed.\n'
printf '  Installed server source: %s\n' "$RESOLVED_COMMIT"
printf '  Canonical portal: https://%s\n' "$DOMAIN"
printf '  Protected environment: byte-for-byte unchanged\n'
printf '  TLS/Nginx/database/administrator: unchanged\n'
