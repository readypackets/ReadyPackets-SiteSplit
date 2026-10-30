#!/usr/bin/env bash
# ReadyPackets Portal — temporary-public, portal-only fresh VPS installer.
#
# Purpose: install one reviewed immutable ReadyPackets portal release onto a
# brand-new Ubuntu 24.04 or 26.04 LTS VPS while the source repository is intentionally
# public for a short, approved period. This is for the established topology:
#   * portal VPS: my.readypackets.com (plus optional redirect aliases)
#   * independent marketing site: www.readypackets.com (not served by this VPS)
#
# Do not use this script to update, repair, restore, or overwrite an existing
# portal. Use the private deploy-key installer whenever possible.
set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
readonly SOURCE_BRANCH="main"
readonly SHA_RE='^[a-f0-9]{40}$'
readonly SOURCE_DIR="/srv/readypackets"
readonly TOKEN_DIR="/root/readypackets-secrets"

DOMAIN=""
PORTAL_ALIASES=()
SITE_NAME="ReadyPackets"
ADMIN_NAME=""
ADMIN_EMAIL="tools@readypackets.com"
TLS_PROVIDER=""
LETSENCRYPT_EMAIL=""
CLOUDFLARE_ORIGIN_VALIDITY="5475"
TOKEN_FILE=""
RELEASE_COMMIT=""
CURRENT_MAIN_COMMIT=""
EXPECTED_MIGRATION_COUNT=""

log() { printf '\n[ReadyPackets fresh portal install] %s\n' "$*"; }
warn() { printf '\n[ReadyPackets fresh portal install warning] %s\n' "$*" >&2; }
fail() { printf '\n[ReadyPackets fresh portal install error] %s\n' "$*" >&2; exit 1; }

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$TOKEN_FILE" && -f "$TOKEN_FILE" ]]; then
    shred -u -- "$TOKEN_FILE" 2>/dev/null || rm -f -- "$TOKEN_FILE"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'fail "Stopped at line ${LINENO}. Review the message above and correct the fresh-server prerequisite before retrying."' ERR

valid_hostname() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]
}

valid_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

is_reserved_marketing_host() {
  [[ "$1" == "readypackets.com" || "$1" == "www.readypackets.com" ]]
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

prompt_required() {
  local prompt="$1" value=""
  while [[ -z "$value" ]]; do
    read -r -p "${prompt}: " value
    value="$(trim "$value")"
    [[ -n "$value" ]] || warn "A value is required."
  done
  REPLY="$value"
}

prompt_default() {
  local prompt="$1" default_value="$2" value=""
  read -r -p "${prompt} [${default_value}]: " value
  value="$(trim "$value")"
  REPLY="${value:-$default_value}"
}

require_new_ubuntu_vps() {
  [[ $EUID -eq 0 ]] || fail "Run this script with sudo or as root."
  [[ -t 0 && -t 1 ]] || fail "Run from an interactive SSH terminal; secrets are requested only through masked prompts."
  [[ -r /etc/os-release ]] || fail "This installer requires Ubuntu 24.04 or 26.04 LTS."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] \
    || fail "This installer supports Ubuntu Server only."
  case "${VERSION_ID:-}" in
    24.04|26.04) ;;
    *) fail "This installer supports a new Ubuntu 24.04 or 26.04 LTS VPS only." ;;
  esac

  local path
  for path in \
    "$SOURCE_DIR" \
    /opt/readypackets \
    /etc/readypackets \
    /var/lib/readypackets \
    /var/lib/mysql/readypackets \
    /etc/mysql/mysql.conf.d/zz-readypackets.cnf \
    /etc/nginx/sites-available/readypackets \
    /etc/nginx/sites-enabled/readypackets \
    /etc/systemd/system/readypackets.service \
    /etc/systemd/system/readypackets-backup.service \
    /etc/systemd/system/readypackets-backup-control.service \
    /etc/systemd/system/readypackets-certificate-control.service \
    /etc/systemd/system/readypackets-platform-update-control.service; do
    [[ ! -e "$path" ]] || fail "Existing ReadyPackets state found at ${path}; this fresh installer will not overwrite it."
  done
  ! getent passwd readypackets >/dev/null 2>&1 \
    || fail "The readypackets system account already exists; reimage the VPS or use the documented recovery path."
  if systemctl cat readypackets.service >/dev/null 2>&1; then
    fail "Found an existing readypackets.service; use the approved in-place update or recovery workflow instead."
  fi
  if command -v mysql >/dev/null 2>&1 && mysqladmin --protocol=socket -uroot ping --silent >/dev/null 2>&1; then
    local existing_database existing_user
    existing_database="$(mysql --protocol=socket -uroot -NBe \"SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = 'readypackets'\")" \
      || fail "Could not inspect the existing MySQL server for ReadyPackets state."
    [[ -z "$existing_database" ]] \
      || fail "The readypackets MySQL database already exists; reimage the VPS or use the documented recovery path."
    existing_user="$(mysql --protocol=socket -uroot -NBe \"SELECT User FROM mysql.user WHERE User = 'readypackets' LIMIT 1\")" \
      || fail "Could not inspect the existing MySQL server for the ReadyPackets account."
    [[ -z "$existing_user" ]] \
      || fail "The readypackets MySQL account already exists; reimage the VPS or use the documented recovery path."
  fi
}

capture_aliases() {
  local raw alias known
  local -a requested=()
  read -r -p "Additional portal aliases, comma-separated (optional; maximum 5; HTTPS 308 redirects to ${DOMAIN}): " raw
  raw="$(trim "$raw")"
  [[ -n "$raw" ]] || return 0

  IFS=',' read -r -a requested <<< "$raw"
  (( ${#requested[@]} <= 5 )) || fail "Enter no more than five explicit portal aliases."
  for alias in "${requested[@]}"; do
    alias="$(trim "$alias")"
    alias="${alias,,}"
    valid_hostname "$alias" || fail "${alias:-<empty>} is not a valid portal alias hostname."
    [[ "$alias" != "$DOMAIN" ]] || fail "A portal alias must differ from the canonical portal hostname."
    is_reserved_marketing_host "$alias" && fail "${alias} is reserved for the separate marketing website."
    for known in "${PORTAL_ALIASES[@]}"; do
      [[ "$known" == "$alias" ]] && continue 2
    done
    PORTAL_ALIASES+=("$alias")
  done
}

capture_tls_choice() {
  printf '\nTLS certificate method:\n'
  printf '  1) Cloudflare Origin CA automatic issuance (recommended; proxied + Full strict)\n'
  printf '  2) Let\x27s Encrypt (the canonical portal hostname must reach this VPS directly on port 80)\n'
  local choice=""
  while [[ "$choice" != "1" && "$choice" != "2" ]]; do
    read -r -p "Choose [1-2] (default 1): " choice
    choice="${choice:-1}"
    [[ "$choice" == "1" || "$choice" == "2" ]] || warn "Choose 1 or 2."
  done

  if [[ "$choice" == "1" ]]; then
    TLS_PROVIDER="cloudflare-origin-ca"
  else
    TLS_PROVIDER="letsencrypt"
    while :; do
      prompt_default "Let’s Encrypt contact email" "$ADMIN_EMAIL"
      LETSENCRYPT_EMAIL="${REPLY,,}"
      valid_email "$LETSENCRYPT_EMAIL" && break
      warn "Enter a valid email address."
    done
  fi
}

prepare_reviewed_release() {
  export DEBIAN_FRONTEND=noninteractive
  log "Installing only source-retrieval prerequisites before selecting a reviewed release."
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl git

  log "Checking temporary anonymous GitHub access before collecting any certificate secret."
  GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "https://github.com/${REPOSITORY}.git" HEAD >/dev/null \
    || fail "${REPOSITORY} is not anonymously readable. Keep the repository private and use the read-only deploy-key installer, or make the repository public only after a complete reachable-history secret review."

  CURRENT_MAIN_COMMIT="$(GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/${REPOSITORY}.git" "refs/heads/${SOURCE_BRANCH}" | awk 'NR == 1 { print tolower($1) }')"
  [[ "$CURRENT_MAIN_COMMIT" =~ $SHA_RE ]] \
    || fail "Could not resolve a current immutable ${SOURCE_BRANCH} release from ${REPOSITORY}."

  printf '\nThe current public %s candidate is:\n  %s\n' "$SOURCE_BRANCH" "$CURRENT_MAIN_COMMIT"
  printf 'Review that commit in GitHub, then type the complete 40-character SHA below.\n'
  printf 'A branch name, abbreviated SHA, or earlier release is not accepted by this latest-release bootstrap.\n\n'
  prompt_required "Reviewed 40-character Portal commit SHA to install"
  RELEASE_COMMIT="${REPLY,,}"
  [[ "$RELEASE_COMMIT" =~ $SHA_RE ]] || fail "The Portal release must be a reviewed 40-character Git SHA."
  [[ "$RELEASE_COMMIT" == "$CURRENT_MAIN_COMMIT" ]] \
    || fail "The reviewed release must match the current public ${SOURCE_BRANCH} candidate. Refresh/review the current commit rather than installing a stale or moving target."
}

verify_current_main_still_selected() {
  local latest_main_commit
  latest_main_commit="$(GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/${REPOSITORY}.git" "refs/heads/${SOURCE_BRANCH}" | awk 'NR == 1 { print tolower($1) }')"
  [[ "$latest_main_commit" =~ $SHA_RE ]] \
    || fail "Could not revalidate the current public ${SOURCE_BRANCH} release before checkout."
  [[ "$latest_main_commit" == "$RELEASE_COMMIT" ]] \
    || fail "The public ${SOURCE_BRANCH} candidate changed after review. No source was checked out and no credential was requested; restart, review the new commit, and try again."
}

capture_cloudflare_token() {
  [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]] || return 0
  install -d -m 0700 -o root -g root "$TOKEN_DIR"
  TOKEN_FILE="$(mktemp "${TOKEN_DIR}/cloudflare-origin-ca.XXXXXX")"
  chown root:root "$TOKEN_FILE"
  chmod 0600 "$TOKEN_FILE"

  printf '\nPaste the short-lived Cloudflare Origin CA token only at this masked prompt.\n'
  printf 'Required permission: Zone → SSL and Certificates → Edit.\n'
  local token=""
  read -r -s -p "Cloudflare Origin CA token: " token
  printf '\n'
  [[ -n "$token" ]] || fail "A Cloudflare Origin CA token is required for automatic issuance."
  printf '%s\n' "$token" > "$TOKEN_FILE"
  unset token
}

checkout_reviewed_source() {
  log "Retrieving immutable reviewed portal release ${RELEASE_COMMIT}."
  install -d -m 0755 -o root -g root "$(dirname "$SOURCE_DIR")"
  git init "$SOURCE_DIR" >/dev/null
  git -C "$SOURCE_DIR" remote add origin "https://github.com/${REPOSITORY}.git"
  GIT_TERMINAL_PROMPT=0 git -C "$SOURCE_DIR" fetch --depth=1 origin "$RELEASE_COMMIT"
  local resolved
  resolved="$(git -C "$SOURCE_DIR" rev-parse FETCH_HEAD)"
  [[ "${resolved,,}" == "$RELEASE_COMMIT" ]] || fail "Downloaded source does not match the reviewed immutable release."
  git -C "$SOURCE_DIR" checkout --detach --force "$resolved" >/dev/null
  [[ -f "$SOURCE_DIR/deploy/install.sh" ]] || fail "The approved source is incomplete: deploy/install.sh is missing."
  [[ -f "$SOURCE_DIR/deploy/verify-public-connectivity.sh" ]] || fail "The approved source is incomplete: post-install verifier is missing."
  [[ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ]] || fail "The downloaded source is unexpectedly modified."
  ! find "$SOURCE_DIR/drizzle/migrations" -maxdepth 1 -name '*.sql' ! -type f -print -quit | grep -q . \
    || fail "The reviewed source migration ledger contains a non-regular SQL entry."
  EXPECTED_MIGRATION_COUNT="$(find "$SOURCE_DIR/drizzle/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
  [[ "$EXPECTED_MIGRATION_COUNT" =~ ^[1-9][0-9]*$ ]] || fail "The reviewed source does not contain a valid forward-only migration ledger."
}

install_portal() {
  local -a installer=(
    bash "$SOURCE_DIR/deploy/install.sh"
    --domain "$DOMAIN"
    --tls-provider "$TLS_PROVIDER"
    --site-name "$SITE_NAME"
  )
  local alias
  for alias in "${PORTAL_ALIASES[@]}"; do
    installer+=(--portal-alias "$alias")
  done

  if [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
    installer+=(
      --cloudflare-api-token-file "$TOKEN_FILE"
      --cloudflare-origin-validity "$CLOUDFLARE_ORIGIN_VALIDITY"
    )
  else
    installer+=(--email "$LETSENCRYPT_EMAIL")
  fi

  log "Installing the portal-only native stack. The external marketing hostname is intentionally not passed to this VPS."
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${installer[@]}"
}

create_administrator() {
  log "Creating the first local administrator with a generated one-time password."
  printf 'Store the generated password immediately in an approved password manager; it is displayed once on this VPS console.\n\n'
  runuser -u readypackets -- sh -c '
    set -a
    . "$1"
    set +a
    shift
    exec "$@"
  ' sh /etc/readypackets/portal.env \
    node /opt/readypackets/dist/create-admin.js \
    --email "$ADMIN_EMAIL" \
    --name "$ADMIN_NAME" \
    --generate-password
}

verify_installation() {
  local -a local_args=(--domain "$DOMAIN" --local-only)
  local -a public_args=(--domain "$DOMAIN")
  local alias
  for alias in "${PORTAL_ALIASES[@]}"; do
    local_args+=(--portal-alias "$alias")
    public_args+=(--portal-alias "$alias")
  done

  log "Requiring local service, database, and application readiness."
  bash "$SOURCE_DIR/deploy/verify-public-connectivity.sh" "${local_args[@]}"

  log "Checking public HTTPS separately; DNS or Cloudflare propagation may still be pending."
  if bash "$SOURCE_DIR/deploy/verify-public-connectivity.sh" "${public_args[@]}"; then
    log "Public HTTPS verification: PASS"
  else
    local status=$?
    if [[ "$status" -eq 2 ]]; then
      warn "Local installation is healthy, but public DNS, Cloudflare, firewall, or certificate propagation is not complete. Re-run the verifier after propagation."
    else
      fail "Post-install verification failed. Review the diagnostics above; do not invite users until local health is green."
    fi
  fi
}

main() {
  require_new_ubuntu_vps

  cat <<'BANNER'

ReadyPackets Portal — temporary-public fresh VPS installer
===========================================================

This is only for a brand-new Ubuntu 24.04 or 26.04 LTS VPS and an intentionally temporary
public source repository. It deploys the portal only; it does not claim or
serve readypackets.com or www.readypackets.com, which remain on the separate
marketing host. It never accepts passwords, tokens, or keys on a command line.

Before continuing, verify that the canonical portal DNS record (and every
optional alias) points to this VPS. For Cloudflare Origin CA, keep each portal
record proxied and set the zone to Full (strict).
BANNER

  printf '\nBefore deployment, this installer will install only source-retrieval prerequisites,\n'
  printf 'show the current public main candidate, and require its reviewed immutable SHA.\n'
  local preflight_confirmation=""
  read -r -p "Type PREPARE PUBLIC SOURCE to continue: " preflight_confirmation
  [[ "$preflight_confirmation" == "PREPARE PUBLIC SOURCE" ]] \
    || fail "Preflight confirmation did not match; no portal installation was started."
  prepare_reviewed_release

  prompt_default "ReadyPackets portal display name" "$SITE_NAME"
  SITE_NAME="$REPLY"
  [[ -n "$SITE_NAME" && ${#SITE_NAME} -le 100 && "$SITE_NAME" != *$'\n'* ]] \
    || fail "Display name must be 1 to 100 characters with no line breaks."

  while :; do
    prompt_required "Canonical portal hostname (example: my.readypackets.com)"
    DOMAIN="${REPLY,,}"
    valid_hostname "$DOMAIN" && break
    warn "Enter a valid fully qualified hostname."
  done
  is_reserved_marketing_host "$DOMAIN" && fail "${DOMAIN} is reserved for the separately hosted marketing website."
  capture_aliases

  prompt_required "Initial administrator full name"
  ADMIN_NAME="$REPLY"
  [[ ${#ADMIN_NAME} -le 120 && "$ADMIN_NAME" != *$'\n'* ]] || fail "Administrator name must be 1 to 120 characters with no line breaks."
  while :; do
    prompt_default "Initial administrator email" "$ADMIN_EMAIL"
    ADMIN_EMAIL="${REPLY,,}"
    valid_email "$ADMIN_EMAIL" && break
    warn "Enter a valid administrator email address."
  done

  capture_tls_choice

  cat <<PLAN

Fresh installation review
=========================
Portal URL:          https://${DOMAIN}
Portal aliases:      ${PORTAL_ALIASES[*]:-none (HTTPS 308 redirects to the canonical URL)}
Marketing site:      separately hosted; not included in this VPS configuration
First administrator: ${ADMIN_NAME} <${ADMIN_EMAIL}>
TLS:                 ${TLS_PROVIDER}
Source repository:   ${REPOSITORY} (temporary public HTTPS retrieval)
Source commit:       ${RELEASE_COMMIT}
Runtime:             native Ubuntu (systemd, Nginx, MySQL, encrypted backups, restricted controllers)

No source branch name, token, private key, password, website hostname, or
customer data will be stored in the command line, Git source, or portal logs.
PLAN
  local confirmation=""
  read -r -p "Type INSTALL READY PACKETS to begin on this new VPS: " confirmation
  [[ "$confirmation" == "INSTALL READY PACKETS" ]] || fail "Confirmation did not match; no portal installation was started."

  verify_current_main_still_selected
  checkout_reviewed_source
  capture_cloudflare_token
  install_portal
  create_administrator
  verify_installation

  cat <<SUMMARY

ReadyPackets fresh portal installation completed.
  Installed source: ${RELEASE_COMMIT}
  Canonical portal: https://${DOMAIN}
  Portal aliases:   ${PORTAL_ALIASES[*]:-none (canonical redirect only)}
  Administrator:    ${ADMIN_EMAIL}

Next required steps:
  1. Store the generated one-time password, sign in over HTTPS, enroll MFA, and save recovery codes.
  2. Confirm the installer reported: Applied ${EXPECTED_MIGRATION_COUNT} migration(s); 48 critical tables verified.
  3. Configure email, payments, Microsoft Graph/SharePoint, SAML, SIEM/syslog, and consented analytics from the administrator portal.
  4. Configure encrypted off-host backups and complete an isolated restore drill before handling customer data.
  5. Return the source repository to private visibility immediately after installation and revoke the short-lived Cloudflare token if it is no longer needed.
SUMMARY
}

main "$@"
