#!/usr/bin/env bash
# ReadyPackets Portal — guided master installer for a brand-new native VPS.
#
# This script is intentionally interactive. It captures non-secret deployment
# choices, creates/validates a repository-scoped read-only GitHub deploy key,
# pins one approved immutable commit, obtains the audited bootstrap from that
# exact commit, installs the native portal, and creates the first local admin.
#
# It must never be used for an existing portal, a restore target, or an update.
# Existing portals use Admin -> Platform updates; replacement hosts use the
# documented full restore process after a clean deployment is verified.
set -Eeuo pipefail
umask 077

readonly DEFAULT_REPOSITORY="readypackets/ReadyPackets-SiteSplit"
readonly DEFAULT_SITE_NAME="ReadyPackets"
readonly DEFAULT_SSH_KEY="/root/.ssh/readypackets_deploy"
readonly DEFAULT_PROJECT_DIR="/srv/readypackets"
readonly TOKEN_DIR="/root/readypackets-secrets"

REPOSITORY="$DEFAULT_REPOSITORY"
DOMAIN=""
SITE_NAME="$DEFAULT_SITE_NAME"
ADMIN_NAME=""
ADMIN_EMAIL=""
TLS_PROVIDER=""
CONTACT_EMAIL=""
CLOUDFLARE_CERT=""
CLOUDFLARE_KEY=""
CLOUDFLARE_ROOT=""
CLOUDFLARE_ORIGIN_VALIDITY="5475"
CLOUDFLARE_API_TOKEN_FILE=""
COMMIT=""
GITHUB_KNOWN_HOSTS="/root/.ssh/readypackets_github_known_hosts"
RUNNER_DIR=""
TOKEN_CREATED="false"

usage() {
  cat <<'USAGE'
ReadyPackets Portal guided master installer

Usage:
  sudo bash master-install.sh

This interactive installer is for a brand-new Ubuntu 24.04 LTS VPS only. It:
  1. Captures portal host, ReadyPackets display name, administrator name/email,
     TLS choice, and an exact reviewed portal release.
  2. Creates a root-only read-only GitHub deploy key when needed and pauses so
     its PUBLIC half can be added to the private portal repository.
  3. Retrieves GitHub's published SSH host keys, resolves a candidate release,
     requires an explicit confirmation, and deploys one immutable Git commit.
  4. Installs the native portal stack and creates the first local administrator
     with a generated one-time password.

It will refuse to run where a ReadyPackets source directory, runtime data,
configuration directory, deployed runtime, or systemd unit already exists.
Never use it for an update, repair, or restore.

No GitHub personal-access token, repository password, Cloudflare token, TLS
private key, or portal password is accepted as a command-line argument.
USAGE
}

log() { printf '\n[ReadyPackets master install] %s\n' "$*"; }
warn() { printf '\n[ReadyPackets master install warning] %s\n' "$*" >&2; }
fail() { printf '\n[ReadyPackets master install error] %s\n' "$*" >&2; exit 1; }

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$TOKEN_CREATED" == "true" && -n "$CLOUDFLARE_API_TOKEN_FILE" && -f "$CLOUDFLARE_API_TOKEN_FILE" ]]; then
    shred -u -- "$CLOUDFLARE_API_TOKEN_FILE" 2>/dev/null || rm -f -- "$CLOUDFLARE_API_TOKEN_FILE"
  fi
  if [[ -n "$RUNNER_DIR" && -d "$RUNNER_DIR" ]]; then
    rm -rf -- "$RUNNER_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

ask_default() {
  local prompt="$1"
  local fallback="$2"
  local value=""
  read -r -p "${prompt} [${fallback}]: " value
  REPLY="${value:-$fallback}"
}

ask_required() {
  local prompt="$1"
  local value=""
  while :; do
    read -r -p "${prompt}: " value
    value="${value#${value%%[![:space:]]*}}"
    value="${value%${value##*[![:space:]]}}"
    if [[ -n "$value" ]]; then
      REPLY="$value"
      return 0
    fi
    warn "A value is required."
  done
}

ask_choice() {
  local prompt="$1"
  local allowed="$2"
  local value=""
  while :; do
    read -r -p "${prompt}: " value
    if [[ " $allowed " == *" $value "* ]]; then
      REPLY="$value"
      return 0
    fi
    warn "Choose one of: ${allowed}."
  done
}

valid_hostname() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]
}

valid_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

fresh_host_guard() {
  [[ $EUID -eq 0 ]] || fail "Run through sudo or as root."
  [[ -t 0 && -t 1 ]] || fail "This guided master installer requires an interactive terminal. Use deploy/github-bootstrap-install.sh for approved automation."

  local path
  for path in "$DEFAULT_PROJECT_DIR" /opt/readypackets /etc/readypackets /var/lib/readypackets; do
    [[ ! -e "$path" ]] || fail "Found existing ReadyPackets path: ${path}. This fresh-host installer will not overwrite a portal, failed installation, or recovery target."
  done
  if systemctl cat readypackets.service >/dev/null 2>&1; then
    fail "Found an existing readypackets.service unit. This fresh-host installer will not overwrite an existing deployment."
  fi
}

install_source_prerequisites() {
  log "Installing only the source-retrieval prerequisites required before portal deployment."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3
}

ensure_deploy_key() {
  install -d -m 0700 -o root -g root /root/.ssh
  if [[ -e "$DEFAULT_SSH_KEY" ]]; then
    [[ -f "$DEFAULT_SSH_KEY" ]] || fail "GitHub deploy-key path exists but is not a regular file: ${DEFAULT_SSH_KEY}"
    [[ "$(stat -c '%U:%a' "$DEFAULT_SSH_KEY")" =~ ^root:(400|600)$ ]] || fail "Existing GitHub deploy key must be owned by root with mode 0400 or 0600."
  else
    log "Generating a new root-only read-only GitHub deploy key."
    ssh-keygen -t ed25519 -f "$DEFAULT_SSH_KEY" -N '' -C 'readypackets-portal-production-deploy'
    chmod 0600 "$DEFAULT_SSH_KEY"
    chown root:root "$DEFAULT_SSH_KEY"
  fi

  [[ -s "${DEFAULT_SSH_KEY}.pub" ]] || fail "The GitHub deploy-key public half is missing: ${DEFAULT_SSH_KEY}.pub"
  cat <<KEY_INSTRUCTIONS

Add this PUBLIC key to the private ReadyPackets portal repository now:
  https://github.com/${REPOSITORY}/settings/keys

Choose “Add deploy key”, give it a clear VPS name, paste this one line, and
leave “Allow write access” UNCHECKED:

KEY_INSTRUCTIONS
  cat "${DEFAULT_SSH_KEY}.pub"
  printf '\n'
  read -r -p "After the public key is saved as a read-only GitHub deploy key, press Enter to continue (or Ctrl+C to stop): " _
}

configure_github_known_hosts() {
  local metadata temporary
  log "Retrieving GitHub's published SSH host keys over HTTPS."
  temporary="$(mktemp /root/.ssh/readypackets-master-github-keys.XXXXXX)"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 30 \
    https://api.github.com/meta -o "$temporary"
  python3 - "$temporary" "$GITHUB_KNOWN_HOSTS" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
data = json.loads(source.read_text(encoding="utf-8"))
keys = data.get("ssh_keys")
if not isinstance(keys, list) or not keys:
    raise SystemExit("GitHub metadata did not contain SSH host keys")
allowed_types = {"ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"}
lines = []
for item in keys:
    if not isinstance(item, str):
        continue
    parts = item.split()
    if len(parts) == 2 and parts[0] in allowed_types:
        lines.append(f"github.com {parts[0]} {parts[1]}")
if not lines:
    raise SystemExit("GitHub metadata did not contain usable SSH host keys")
target.write_text("\n".join(lines) + "\n", encoding="utf-8")
target.chmod(0o600)
PY
  rm -f -- "$temporary"
  chown root:root "$GITHUB_KNOWN_HOSTS"
}

prepare_git_transport() {
  configure_github_known_hosts
  export GIT_SSH_COMMAND="ssh -i ${DEFAULT_SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${GITHUB_KNOWN_HOSTS} -o GlobalKnownHostsFile=/dev/null"
}

resolve_candidate_commit() {
  local remote main_ref
  remote="git@github.com:${REPOSITORY}.git"
  log "Checking the configured read-only GitHub deploy key."
  GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$remote" HEAD >/dev/null \
    || fail "GitHub deploy-key access failed. Confirm that the displayed public key was added to ${REPOSITORY} with write access disabled."

  main_ref="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$remote" refs/heads/main | awk 'NR==1 { print $1 }')"
  [[ "$main_ref" =~ ^[0-9a-fA-F]{40}$ ]] || fail "Could not resolve a current main commit from ${REPOSITORY}."

  printf '\nThe current GitHub main candidate is:\n  %s\n' "$main_ref"
  printf 'Review the desired commit in GitHub, then type its complete 40-character SHA below.\n'
  printf 'A moving branch name is never deployed, and pressing Enter without a reviewed SHA is not accepted.\n\n'
  ask_required "Reviewed 40-character Git commit SHA to deploy"
  COMMIT="${REPLY,,}"
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "The release must be a reviewed 40-character Git SHA."
}

capture_tls_inputs() {
  printf '\nTLS certificate choice:\n'
  printf '  1) Cloudflare Origin CA automatic issuance (recommended for a proxied portal)\n'
  printf '  2) Let’s Encrypt (portal host resolves directly to this VPS for HTTP-01)\n'
  printf '  3) Existing Cloudflare Origin CA certificate and private key\n'
  ask_choice "Choose [1-3]" "1 2 3"

  case "$REPLY" in
    1)
      TLS_PROVIDER="cloudflare-origin-ca"
      ;;
    2)
      TLS_PROVIDER="letsencrypt"
      while :; do
        ask_required "Let’s Encrypt notification email"
        CONTACT_EMAIL="${REPLY,,}"
        valid_email "$CONTACT_EMAIL" && break
        warn "Enter a valid email address."
      done
      ;;
    3)
      TLS_PROVIDER="cloudflare-origin"
      while :; do
        ask_required "Absolute path to the existing Cloudflare Origin CA certificate PEM"
        CLOUDFLARE_CERT="$REPLY"
        [[ "$CLOUDFLARE_CERT" == /* && -r "$CLOUDFLARE_CERT" ]] && break
        warn "The certificate must be a readable absolute path."
      done
      while :; do
        ask_required "Absolute path to the existing Cloudflare Origin CA private-key PEM"
        CLOUDFLARE_KEY="$REPLY"
        [[ "$CLOUDFLARE_KEY" == /* && -r "$CLOUDFLARE_KEY" ]] && break
        warn "The private key must be a readable absolute path."
      done
      ;;
  esac
}

capture_cloudflare_token() {
  [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]] || return 0
  install -d -m 0700 -o root -g root "$TOKEN_DIR"
  CLOUDFLARE_API_TOKEN_FILE="${TOKEN_DIR}/cloudflare-origin-ca.token"
  [[ ! -e "$CLOUDFLARE_API_TOKEN_FILE" ]] || fail "Refusing to replace an existing Cloudflare token file: ${CLOUDFLARE_API_TOKEN_FILE}"
  TOKEN_CREATED="true"

  printf '\nEnter the short-lived, zone-scoped Cloudflare API token now. It will not echo, enter shell history,\n'
  printf 'the process list, the portal environment, or source control. It will be securely removed on completion.\n'
  local token=""
  read -r -s -p "Cloudflare Origin CA token: " token
  printf '\n'
  [[ -n "$token" ]] || fail "A Cloudflare Origin CA token is required for automatic issuance."
  printf '%s\n' "$token" > "$CLOUDFLARE_API_TOKEN_FILE"
  unset token
  chown root:root "$CLOUDFLARE_API_TOKEN_FILE"
  chmod 0600 "$CLOUDFLARE_API_TOKEN_FILE"
}

show_plan_and_confirm() {
  local tls_label
  case "$TLS_PROVIDER" in
    cloudflare-origin-ca) tls_label="Cloudflare Origin CA automatic issuance; token will be prompted securely after confirmation" ;;
    letsencrypt) tls_label="Let’s Encrypt; notification email ${CONTACT_EMAIL}" ;;
    cloudflare-origin) tls_label="Existing Cloudflare Origin CA PEM pair; paths will not be displayed in logs" ;;
  esac

  cat <<PLAN

ReadyPackets Portal fresh-install plan
======================================
Repository:          ${REPOSITORY} (read-only deploy key)
Immutable release:   ${COMMIT}
Portal URL:          https://${DOMAIN}
Display name:        ${SITE_NAME}
Initial admin:       ${ADMIN_NAME} <${ADMIN_EMAIL}>
Deployment:          Native Ubuntu VPS (systemd, Nginx, MySQL, backups, restricted controllers)
TLS:                 ${tls_label}
Website boundary:    www.readypackets.com remains outside this portal VPS

The installer will create local cryptographic secrets, MySQL data, protected
runtime files, systemd services, Nginx configuration, backup controls, and an
initial administrator. It will not overwrite an existing ReadyPackets portal.
PLAN

  local confirmation=""
  read -r -p "Type INSTALL READY PACKETS to begin this new-server installation: " confirmation
  [[ "$confirmation" == "INSTALL READY PACKETS" ]] || fail "Confirmation did not match; no portal installation was started."
}

checkout_verified_runner() {
  local remote resolved
  remote="git@github.com:${REPOSITORY}.git"
  RUNNER_DIR="$(mktemp -d /root/readypackets-master-source.XXXXXX)"
  log "Retrieving the reviewed master-bootstrap source at ${COMMIT}."
  GIT_TERMINAL_PROMPT=0 git clone --no-checkout "$remote" "$RUNNER_DIR"
  (
    cd "$RUNNER_DIR"
    GIT_TERMINAL_PROMPT=0 git fetch --depth=1 origin "$COMMIT"
    resolved="$(git rev-parse FETCH_HEAD)"
    [[ "${resolved,,}" == "$COMMIT" ]] || fail "Fetched source does not match the approved immutable release."
    git checkout --detach --force "$resolved"
    test -f deploy/github-bootstrap-install.sh || fail "The reviewed release does not contain deploy/github-bootstrap-install.sh."
    test -z "$(git status --porcelain)" || fail "The reviewed source checkout is unexpectedly modified."
  )
}

run_verified_bootstrap() {
  local -a command
  command=(
    bash "$RUNNER_DIR/deploy/github-bootstrap-install.sh"
    --repository "$REPOSITORY"
    --commit "$COMMIT"
    --domain "$DOMAIN"
    --mode native
    --tls-provider "$TLS_PROVIDER"
    --ssh-key "$DEFAULT_SSH_KEY"
    --site-name "$SITE_NAME"
  )

  case "$TLS_PROVIDER" in
    cloudflare-origin-ca)
      command+=(--cloudflare-api-token-file "$CLOUDFLARE_API_TOKEN_FILE" --cloudflare-origin-validity "$CLOUDFLARE_ORIGIN_VALIDITY")
      ;;
    letsencrypt)
      command+=(--email "$CONTACT_EMAIL")
      ;;
    cloudflare-origin)
      command+=(--cloudflare-origin-cert "$CLOUDFLARE_CERT" --cloudflare-origin-key "$CLOUDFLARE_KEY")
      [[ -n "$CLOUDFLARE_ROOT" ]] && command+=(--cloudflare-origin-root "$CLOUDFLARE_ROOT")
      ;;
  esac

  log "Starting the verified ReadyPackets native deployment."
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${command[@]}"
}

create_initial_administrator() {
  log "Creating the first local administrator with a generated one-time password."
  printf 'Store the generated password immediately in an approved password manager; it is shown only once.\n\n'
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

main() {
  fresh_host_guard
  printf '\nReadyPackets Portal guided master installer\n'
  printf 'This runs only on a brand-new native VPS and will preserve the separate public website boundary.\n\n'

  ask_default "ReadyPackets portal display name" "$DEFAULT_SITE_NAME"
  SITE_NAME="$REPLY"
  [[ -n "$SITE_NAME" && ${#SITE_NAME} -le 100 && "$SITE_NAME" != *$'\n'* ]] || fail "Display name must be 1 to 100 characters with no line breaks."

  while :; do
    ask_required "Dedicated portal hostname (example: my.readypackets.com)"
    DOMAIN="${REPLY,,}"
    valid_hostname "$DOMAIN" && break
    warn "Enter a valid fully qualified hostname. Do not use www.readypackets.com."
  done
  [[ "$DOMAIN" != "readypackets.com" && "$DOMAIN" != "www.readypackets.com" ]] \
    || fail "readypackets.com and www.readypackets.com are reserved for the separate public website. Use a dedicated portal hostname."

  ask_required "Initial administrator full name"
  ADMIN_NAME="$REPLY"
  [[ ${#ADMIN_NAME} -le 120 && "$ADMIN_NAME" != *$'\n'* ]] || fail "Administrator name must be 1 to 120 characters with no line breaks."
  while :; do
    ask_required "Initial administrator email"
    ADMIN_EMAIL="${REPLY,,}"
    valid_email "$ADMIN_EMAIL" && break
    warn "Enter a valid administrator email address."
  done

  capture_tls_inputs

  cat <<'PREFLIGHT'

Before portal deployment, this installer will install only source-retrieval
prerequisites and create or validate a root-only read-only GitHub deploy key.
It will display the public key so you can add it to the private portal
repository. No portal files, database, services, TLS configuration, or customer
data are created until the final confirmation.
PREFLIGHT
  local preflight_confirmation=""
  read -r -p "Type PREPARE DEPLOY KEY to continue: " preflight_confirmation
  [[ "$preflight_confirmation" == "PREPARE DEPLOY KEY" ]] || fail "Preflight confirmation did not match; no system changes were made."

  install_source_prerequisites
  ensure_deploy_key
  prepare_git_transport
  resolve_candidate_commit
  show_plan_and_confirm
  capture_cloudflare_token
  checkout_verified_runner
  run_verified_bootstrap
  create_initial_administrator

  cat <<SUMMARY

ReadyPackets Portal deployment is complete.
  Portal URL: https://${DOMAIN}
  Installed commit: ${COMMIT}
  Administrator: ${ADMIN_EMAIL}

Next steps:
  1. Sign in, enroll mandatory MFA, and store recovery codes securely.
  2. Verify the local/public health output, certificate, and loopback-only
     Node.js/MySQL listeners.
  3. Configure encrypted off-host backups and complete an isolated full restore
     drill before handling production customer data.
  4. Configure payments, email, SharePoint/Graph, SAML, SIEM, and consented
     analytics only in the authenticated administrator portal.
SUMMARY
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") main ;;
  *) fail "Unknown option: $1. Run with --help for usage." ;;
esac
