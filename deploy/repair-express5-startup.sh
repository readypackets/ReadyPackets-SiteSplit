#!/usr/bin/env bash
# ReadyPackets Portal — repair the known Express 5 anonymous-wildcard startup
# failure on an existing fresh native VPS installation.
#
# This script preserves the root-owned portal environment, existing Origin CA
# certificate and private key, Nginx configuration, database, uploads, backup
# history, aliases, site name, and administrator account. It does not prompt for
# or use a Cloudflare token, and it deliberately skips catalogue/policy seeding.
#
# Usage, only after this exact startup failure has been confirmed in journald:
#   sudo bash deploy/repair-express5-startup.sh

set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
# Immutable application-fix release; this later helper retrieves it explicitly.
readonly COMMIT="9cce95ff4ca123d3c358659140c7f25b9feee5d9"
readonly SOURCE_DIR="/srv/readypackets"
readonly APP_DIR="/opt/readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"

fail() { printf '\n[ReadyPackets repair] ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf '\n[ReadyPackets repair] WARNING: %s\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || fail "Run this repair as root via sudo."
[[ -t 0 && -t 1 ]] || fail "Run from an interactive SSH terminal."
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "This repair script must be downloaded from its immutable reviewed Git commit."
[[ -d "$SOURCE_DIR/.git" ]] || fail "Expected ReadyPackets source checkout is absent: $SOURCE_DIR."
[[ -d "$APP_DIR" ]] || fail "Expected ReadyPackets runtime is absent: $APP_DIR."
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "Expected protected portal environment is absent or unsafe: $ENV_FILE."
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" == "root:readypackets:640" ]] || fail "Protected portal environment ownership or mode is unexpected; stop rather than loading it."
[[ -f /etc/readypackets/tls/nginx-tls.conf ]] || fail "Existing TLS include is absent. This targeted repair will not recreate certificate material."

ORIGIN="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
[[ "$ORIGIN" == "https://github.com/${REPOSITORY}.git" ]] || fail "The source checkout does not use the expected temporary-public ReadyPackets repository."
[[ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ]] || fail "The source checkout has local changes. Stop rather than overwriting unreviewed source."

# The generated environment uses shell-safe serialization. Load it only after
# owner/mode/symlink validation in a child shell, then emit only the three
# non-secret routing/display values this repair needs. Database and application
# secrets are never exported by this script.
routing_values="$(
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  printf '%s\037%s\037%s\n' "${APP_URL:-}" "${PORTAL_ALIASES:-}" "${SITE_NAME:-}"
)"
IFS=$'\037' read -r APP_URL PORTAL_ALIASES SITE_NAME <<< "$routing_values"
DOMAIN="${APP_URL#https://}"
[[ "$APP_URL" == "https://${DOMAIN}" && "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || fail "Protected APP_URL is not a valid HTTPS portal hostname."
[[ -n "$SITE_NAME" && "$SITE_NAME" != *$'\n'* ]] || fail "Protected site name is invalid."

if [[ -n "$PORTAL_ALIASES" ]]; then
  IFS=',' read -r -a aliases <<< "$PORTAL_ALIASES"
  (( ${#aliases[@]} <= 5 )) || fail "Protected portal alias list exceeds the configured maximum."
else
  aliases=()
fi

printf '[ReadyPackets repair] Fetching reviewed immutable source %s\n' "$COMMIT"
git -C "$SOURCE_DIR" fetch --depth=1 origin "$COMMIT"
RESOLVED_COMMIT="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)"
[[ "$RESOLVED_COMMIT" == "$COMMIT" ]] || fail "Fetched source did not match the reviewed repair commit."
git -C "$SOURCE_DIR" checkout --detach "$RESOLVED_COMMIT"

# Clear systemd's crash-rate limit for the known fixed service, but do not alter
# service hardening. The native installer rebuilds the runtime and restarts it
# with the existing protected environment.
systemctl reset-failed readypackets || true

# stdin is deliberately closed. With no --tls-provider, install.sh verifies and
# preserves the existing TLS include rather than offering a certificate prompt.
# --no-seed leaves existing catalogue, policy, customer, and order data untouched.
bash "$SOURCE_DIR/deploy/install.sh" \
  --skip-packages \
  --no-seed \
  --domain "$DOMAIN" \
  --site-name "$SITE_NAME" \
  </dev/null

VERIFY_ARGS=(--domain "$DOMAIN" --local-only)
for alias in "${aliases[@]}"; do
  VERIFY_ARGS+=(--portal-alias "$alias")
done
bash "$SOURCE_DIR/deploy/verify-public-connectivity.sh" "${VERIFY_ARGS[@]}"

PUBLIC_VERIFY_ARGS=(--domain "$DOMAIN")
for alias in "${aliases[@]}"; do
  PUBLIC_VERIFY_ARGS+=(--portal-alias "$alias")
done
if bash "$SOURCE_DIR/deploy/verify-public-connectivity.sh" "${PUBLIC_VERIFY_ARGS[@]}"; then
  printf '\n[ReadyPackets repair] Public HTTPS verification: PASS\n'
else
  status=$?
  if [[ "$status" -eq 2 ]]; then
    warn "Local portal repair is complete; public DNS/Cloudflare verification is pending."
  else
    fail "Post-repair verification failed. Review the local diagnostics above."
  fi
fi

printf '\nReadyPackets Express 5 startup repair completed.\n'
printf '  Installed commit: %s\n' "$RESOLVED_COMMIT"
printf '  Canonical portal: https://%s\n' "$DOMAIN"
printf '  Administrator: unchanged\n'
printf '  TLS certificate: unchanged\n'
printf '  Database/data: unchanged (migrations only; no seed)\n'
