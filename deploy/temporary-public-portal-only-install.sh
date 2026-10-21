#!/usr/bin/env bash
# ReadyPackets Portal — temporary-public, portal-only fresh VPS installer.
#
# Purpose: install one reviewed immutable ReadyPackets portal release onto a
# brand-new Ubuntu 24.04 VPS while the source repository is intentionally
# public for a short, approved period. This is for the established topology:
#   * portal VPS: my.readypackets.com (plus optional redirect aliases)
#   * independent marketing site: www.readypackets.com (not served by this VPS)
#
# Do not use this script to update, repair, restore, or overwrite an existing
# portal. Use the private deploy-key installer whenever possible.
set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
# The portal source installed by this reviewed bootstrap. Do not replace with a
# branch name or abbreviated SHA: production deployment must remain immutable.
readonly RELEASE_COMMIT="45d84b020bc5b7824309cc8af8ced22ae4380bc1"
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
  [[ -r /etc/os-release ]] || fail "This installer requires Ubuntu 24.04 LTS."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
    || fail "This installer supports a new Ubuntu 24.04 LTS VPS only."

  local path
  for path in "$SOURCE_DIR" /opt/readypackets /etc/readypackets /var/lib/readypackets; do
    [[ ! -e "$path" ]] || fail "Existing ReadyPackets state found at ${path}; this fresh installer will not overwrite it."
  done
  if systemctl cat readypackets.service >/dev/null 2>&1; then
    fail "Found an existing readypackets.service; use the approved in-place update or recovery workflow instead."
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

check_public_source() {
  log "Checking temporary anonymous GitHub access before collecting any certificate secret."
  GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "https://github.com/${REPOSITORY}.git" HEAD >/dev/null \
    || fail "${REPOSITORY} is not anonymously readable. Keep the repository private and use the read-only deploy-key installer, or make the repository public only after a complete reachable-history secret review."
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
  export DEBIAN_FRONTEND=noninteractive
  log "Installing only source-retrieval prerequisites."
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl git

  check_public_source

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
  [[ "$RELEASE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "The embedded release pin is invalid."

  cat <<'BANNER'

ReadyPackets Portal — temporary-public fresh VPS installer
===========================================================

This is only for a brand-new Ubuntu 24.04 VPS and an intentionally temporary
public source repository. It deploys the portal only; it does not claim or
serve readypackets.com or www.readypackets.com, which remain on the separate
marketing host. It never accepts passwords, tokens, or keys on a command line.

Before continuing, verify that the canonical portal DNS record (and every
optional alias) points to this VPS. For Cloudflare Origin CA, keep each portal
record proxied and set the zone to Full (strict).
BANNER

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
  2. Confirm the installer reported: Applied 52 migration(s); 46 critical tables verified.
  3. Configure email, payments, Microsoft Graph/SharePoint, SAML, SIEM/syslog, and consented analytics from the administrator portal.
  4. Configure encrypted off-host backups and complete an isolated restore drill before handling customer data.
  5. Return the source repository to private visibility immediately after installation and revoke the short-lived Cloudflare token if it is no longer needed.
SUMMARY
}

main "$@"
