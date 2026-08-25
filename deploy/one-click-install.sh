#!/usr/bin/env bash
# ReadyPackets guided fresh-server installer.
#
# With a terminal this script asks for the approved deployment settings, displays
# a redacted review, and requires an explicit confirmation before any server
# change. Without a terminal it retains RP_* environment-variable automation.
set -Eeuo pipefail
umask 077

readonly DEFAULT_REPOSITORY="readypackets/ReadyPackets"
SETTINGS_FILE="${RP_SETTINGS_FILE:-}"

# A failed fresh installation can safely reuse a root-owned, non-secret profile
# rather than prompting an operator to re-enter the selected deployment shape.
# Secrets (passwords, tokens, private keys, vault passphrases) are deliberately
# rejected from this profile and must continue to use protected interactive or
# temporary-file paths.
if [[ -n "$SETTINGS_FILE" ]]; then
  [[ $EUID -eq 0 ]] || { printf '%s\n' 'RP_SETTINGS_FILE may be loaded only by root.' >&2; exit 1; }
  [[ -f "$SETTINGS_FILE" ]] || { printf 'RP_SETTINGS_FILE was not found: %s\n' "$SETTINGS_FILE" >&2; exit 1; }
  [[ "$(stat -c '%U' "$SETTINGS_FILE")" == "root" && "$(stat -c '%a' "$SETTINGS_FILE")" == "600" ]] \
    || { printf 'RP_SETTINGS_FILE must be owned by root with mode 0600: %s\n' "$SETTINGS_FILE" >&2; exit 1; }
  if grep -Eq '^(RP_ADMIN_PASSWORD|RP_GITHUB_CONFIG_TOKEN|RP_GITHUB_CONFIG_PASSPHRASE|RP_CLOUDFLARE_ORIGIN_KEY|RP_CLOUDFLARE_API_TOKEN)=' "$SETTINGS_FILE"; then
    printf '%s\n' 'RP_SETTINGS_FILE must not contain passwords, tokens, passphrases, or private keys.' >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a; source "$SETTINGS_FILE"; set +a
fi

REPOSITORY="${RP_REPOSITORY:-$DEFAULT_REPOSITORY}"
REF="${RP_REF:-main}"
COMMIT="${RP_COMMIT:-}"
DOMAIN="${RP_DOMAIN:-}"
EMAIL="${RP_EMAIL:-}"
MODE="${RP_MODE:-}"
SITE_NAME="${RP_SITE_NAME:-ReadyPackets}"
TLS_PROVIDER="${RP_TLS_PROVIDER:-}"
PROJECT_DIR="${RP_PROJECT_DIR:-/srv/readypackets}"
CF_CERT="${RP_CLOUDFLARE_ORIGIN_CERT:-}"
CF_KEY="${RP_CLOUDFLARE_ORIGIN_KEY:-}"
CF_ROOT="${RP_CLOUDFLARE_ORIGIN_ROOT:-}"
CF_API_TOKEN=""
CF_API_TOKEN_FILE="${RP_CLOUDFLARE_API_TOKEN_FILE:-}"
CF_ORIGIN_VALIDITY="${RP_CLOUDFLARE_ORIGIN_VALIDITY:-5475}"
if [[ -n "${RP_CLOUDFLARE_API_TOKEN:-}" ]]; then
  printf '%s\n' 'Do not pass a Cloudflare API token through an environment variable; use the guided prompt or RP_CLOUDFLARE_API_TOKEN_FILE.' >&2
  exit 1
fi
VAULT_REPOSITORY="${RP_GITHUB_CONFIG_REPOSITORY:-}"
VAULT_BRANCH="${RP_GITHUB_CONFIG_BRANCH:-main}"
VAULT_FOLDER="${RP_GITHUB_CONFIG_FOLDER:-readypackets-platform-config}"
VAULT_TOKEN="${RP_GITHUB_CONFIG_TOKEN:-}"
VAULT_PASSPHRASE="${RP_GITHUB_CONFIG_PASSPHRASE:-}"
BACKUP_ENABLED="${RP_ENABLE_NIGHTLY_BACKUPS:-yes}"
PROVISION_ADMIN="${RP_PROVISION_ADMIN:-auto}"
ADMIN_EMAIL="${RP_ADMIN_EMAIL:-}"
ADMIN_NAME="${RP_ADMIN_NAME:-}"
ADMIN_PASSWORD="${RP_ADMIN_PASSWORD:-}"
ADMIN_GENERATE_PASSWORD="${RP_ADMIN_GENERATE_PASSWORD:-yes}"
AUTO_CONFIRM="${RP_AUTO_CONFIRM:-}"
RESUME_FAILED_INSTALL="${RP_RESUME_FAILED_INSTALL:-no}"
REQUIRE_PUBLIC_HEALTH="${RP_REQUIRE_PUBLIC_HEALTH:-no}"
# This bootstrap path deliberately retrieves source over unauthenticated HTTPS.
# It is only appropriate while the selected repository is intentionally public.
REQUIRE_PUBLIC_SOURCE="${RP_REQUIRE_PUBLIC_SOURCE:-yes}"
TEMP_FILES=()

step() { printf '\n\033[1;36m[ReadyPackets install]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[ReadyPackets install warning]\033[0m %s\n' "$*" >&2; }
fail() { printf '\n\033[1;31m[ReadyPackets install failed]\033[0m %s\n' "$*" >&2; exit 1; }
cleanup() {
  unset VAULT_TOKEN VAULT_PASSPHRASE ADMIN_PASSWORD CF_API_TOKEN || true
  for item in "${TEMP_FILES[@]:-}"; do rm -rf -- "$item"; done
}
trap cleanup EXIT
trap 'fail "Stopped at line ${LINENO}. Review the message above, correct it, and rerun on this fresh server."' ERR

is_interactive() { [[ -t 0 && -t 1 && "${RP_NONINTERACTIVE:-false}" != "true" ]]; }
INTERACTIVE_MODE="false"
if is_interactive; then INTERACTIVE_MODE="true"; fi
prompt_value() {
  local label="$1" variable="$2" default_value="$3" answer
  [[ -n "${!variable-}" ]] && return 0
  read -r -p "${label} [${default_value}]: " answer
  printf -v "$variable" '%s' "${answer:-$default_value}"
}
prompt_required() {
  local label="$1" variable="$2" answer
  while [[ -z "${!variable-}" ]]; do
    read -r -p "${label}: " answer
    [[ -n "$answer" ]] && printf -v "$variable" '%s' "$answer" || printf 'A value is required.\n' >&2
  done
}
prompt_secret() {
  local label="$1" variable="$2" confirmation_variable="$3" first second
  [[ -n "${!variable-}" ]] && return 0
  while true; do
    read -r -s -p "${label}: " first; printf '\n' >&2
    read -r -s -p "Confirm ${label,,}: " second; printf '\n' >&2
    if [[ -n "$first" && "$first" == "$second" ]]; then
      printf -v "$variable" '%s' "$first"
      return 0
    fi
    printf 'Values did not match or were empty. Please try again.\n' >&2
  done
}
prompt_yes_no() {
  local label="$1" variable="$2" default_value="$3" answer normalized
  [[ -n "${!variable-}" ]] && return 0
  read -r -p "${label} [${default_value}]: " answer
  normalized="${answer:-$default_value}"
  case "${normalized,,}" in
    y|yes) printf -v "$variable" '%s' "yes" ;;
    n|no) printf -v "$variable" '%s' "no" ;;
    *) fail "Answer yes or no for: ${label}" ;;
  esac
}
write_secret_file() {
  local value="$1" prefix="$2" file
  file="$(mktemp "/root/${prefix}.XXXXXX")"
  TEMP_FILES+=("$file")
  printf '%s\n' "$value" > "$file"
  chmod 0600 "$file"
  printf '%s' "$file"
}

[[ $EUID -eq 0 ]] || fail "Run this installer as root, for example: sudo bash one-click-install.sh"

if [[ "$INTERACTIVE_MODE" == "true" ]]; then
  printf '\nReadyPackets guided fresh-server installation\n'
  printf 'This installer retrieves the latest public %s commit by default, asks for required settings, then shows a review before it changes this server.\n' "$REF"

  if [[ -z "$MODE" ]]; then
    printf '\nInstallation type:\n'
    printf '  1) Native VPS (recommended: systemd, nginx, MySQL, protected backup/update helpers)\n'
    printf '  2) Existing Docker Engine + Docker Compose\n'
    printf '  3) Install Docker Engine, then deploy with Docker Compose\n'
    read -r -p "Choose [1-3] (default 1): " install_choice
    case "${install_choice:-1}" in
      1) MODE="native" ;;
      2) MODE="docker" ;;
      3) MODE="docker-bootstrap" ;;
      *) fail "Choose 1, 2, or 3." ;;
    esac
  fi

  prompt_required "Public website hostname (for example www.example.com)" DOMAIN
  prompt_value "Website display name" SITE_NAME "ReadyPackets"

  if [[ -z "$TLS_PROVIDER" ]]; then
    printf '\nTLS certificate method:\n'
    printf '  1) Let\x27s Encrypt (public certificate with automatic renewal)\n'
    printf '  2) Cloudflare Origin CA — request automatically with a scoped API token (Cloudflare proxy + Full strict)\n'
    printf '  3) Cloudflare Origin CA — install an existing PEM certificate and key\n'
    printf '  4) HTTP only / configure a certificate later (not recommended for production)\n'
    read -r -p "Choose [1-4] (default 1): " tls_choice
    case "${tls_choice:-1}" in
      1) TLS_PROVIDER="letsencrypt" ;;
      2) TLS_PROVIDER="cloudflare-origin-ca" ;;
      3) TLS_PROVIDER="cloudflare-origin" ;;
      4) TLS_PROVIDER="none" ;;
      *) fail "Choose 1, 2, 3, or 4." ;;
    esac
  fi
  if [[ "$TLS_PROVIDER" == "letsencrypt" ]]; then
    prompt_required "Let's Encrypt contact email" EMAIL
  elif [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
    prompt_secret "Cloudflare API token (Zone → SSL and Certificates → Edit, scoped to this zone)" CF_API_TOKEN unused_confirmation
    prompt_value "Cloudflare Origin CA validity in days" CF_ORIGIN_VALIDITY "5475"
  elif [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then
    prompt_required "Cloudflare Origin certificate PEM file path" CF_CERT
    prompt_required "Cloudflare Origin private-key PEM file path" CF_KEY
    prompt_value "Optional Cloudflare Origin CA root PEM path (enter - to omit)" CF_ROOT "-"
    [[ "$CF_ROOT" == "-" ]] && CF_ROOT=""
  elif [[ "$TLS_PROVIDER" == "none" ]]; then
    read -r -p "Type HTTP ONLY to confirm an insecure non-production installation: " tls_danger
    [[ "$tls_danger" == "HTTP ONLY" ]] || fail "HTTP-only installation was not confirmed."
  fi

  prompt_yes_no "Use the default public source (${DEFAULT_REPOSITORY}, latest ${REF})" use_default_source "yes"
  if [[ "$use_default_source" == "no" ]]; then
    prompt_required "Public GitHub repository (owner/repository)" REPOSITORY
    prompt_value "Source branch" REF "main"
    read -r -p "Optional reviewed 40-character commit SHA (leave blank for latest ${REF}): " COMMIT
  fi

  prompt_yes_no "Restore the latest encrypted GitHub configuration vault backup" restore_vault "no"
  if [[ "$restore_vault" == "yes" ]]; then
    prompt_required "Private GitHub vault repository (owner/repository)" VAULT_REPOSITORY
    prompt_value "Vault branch" VAULT_BRANCH "main"
    prompt_value "Vault folder" VAULT_FOLDER "readypackets-platform-config"
    while [[ -z "$VAULT_TOKEN" ]]; do read -r -s -p "Fine-grained GitHub token: " VAULT_TOKEN; printf '\n' >&2; done
    prompt_secret "Vault recovery passphrase" VAULT_PASSPHRASE unused_confirmation
  fi

  if [[ "$MODE" == "native" ]]; then
    prompt_yes_no "Enable nightly local encrypted backups" BACKUP_ENABLED "yes"
  fi

  if [[ -n "$VAULT_REPOSITORY" ]]; then
    prompt_yes_no "Provision or reset a local administrator after recovery" provision_after_restore "no"
    [[ "$provision_after_restore" == "yes" ]] && PROVISION_ADMIN="yes" || PROVISION_ADMIN="no"
  elif [[ "$PROVISION_ADMIN" == "auto" ]]; then
    PROVISION_ADMIN="yes"
  fi
  if [[ "$PROVISION_ADMIN" == "yes" ]]; then
    prompt_required "Initial administrator email" ADMIN_EMAIL
    prompt_required "Initial administrator full name" ADMIN_NAME
    prompt_yes_no "Generate a one-time administrator password instead of typing one" ADMIN_GENERATE_PASSWORD "yes"
    if [[ "$ADMIN_GENERATE_PASSWORD" == "no" ]]; then
      prompt_secret "Initial administrator password" ADMIN_PASSWORD unused_confirmation
    fi
  fi
fi

# Safe defaults for values not set by a guided terminal flow.
MODE="${MODE:-native}"
TLS_PROVIDER="${TLS_PROVIDER:-letsencrypt}"
PROVISION_ADMIN="${PROVISION_ADMIN:-auto}"

[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "RP_REPOSITORY must be owner/repository."
[[ "$REQUIRE_PUBLIC_SOURCE" =~ ^(yes|no)$ ]] || fail "RP_REQUIRE_PUBLIC_SOURCE must be yes or no."
[[ "$REQUIRE_PUBLIC_SOURCE" == "yes" ]] || fail "This bootstrap only retrieves intentionally public source over anonymous HTTPS. Use the private-repository deploy-key procedure for a private repository."
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || fail "Set a valid public website hostname."
[[ "$MODE" =~ ^(native|docker|docker-bootstrap)$ ]] || fail "Installation type must be native, docker, or docker-bootstrap."
[[ "$TLS_PROVIDER" =~ ^(letsencrypt|cloudflare-origin|cloudflare-origin-ca|none)$ ]] || fail "TLS provider must be letsencrypt, cloudflare-origin, cloudflare-origin-ca, or none."
[[ "$SITE_NAME" != *$'\n'* && -n "$SITE_NAME" && ${#SITE_NAME} -le 100 ]] || fail "Website display name must be 1 to 100 characters and contain no line breaks."
[[ -z "$COMMIT" || "$COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || fail "Optional source commit must be a reviewed 40-character Git SHA."
if [[ "$TLS_PROVIDER" == "letsencrypt" ]]; then [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "A valid Let\x27s Encrypt contact email is required."; fi
if [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then [[ -f "$CF_CERT" && -f "$CF_KEY" ]] || fail "Cloudflare Origin CA needs readable certificate and key files."; fi
if [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
  if [[ -n "$CF_API_TOKEN_FILE" ]]; then
    [[ -f "$CF_API_TOKEN_FILE" && "$(stat -c '%U:%a' "$CF_API_TOKEN_FILE")" == "root:600" ]] || fail "RP_CLOUDFLARE_API_TOKEN_FILE must be root-owned mode 0600."
  else
    [[ "$CF_API_TOKEN" =~ ^[A-Za-z0-9._-]{20,}$ ]] || fail "Cloudflare API token format is invalid."
  fi
  [[ "$CF_ORIGIN_VALIDITY" =~ ^(7|30|90|365|730|1095|5475)$ ]] || fail "Cloudflare Origin CA validity must be 7, 30, 90, 365, 730, 1095, or 5475 days."
fi
if [[ -n "$VAULT_REPOSITORY" || -n "$VAULT_TOKEN" || -n "$VAULT_PASSPHRASE" ]]; then
  [[ "$VAULT_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "GitHub vault repository must be owner/private-repository."
  [[ ${#VAULT_TOKEN} -ge 20 && ${#VAULT_PASSPHRASE} -ge 16 ]] || fail "GitHub vault recovery needs a fine-grained token and a 16+ character passphrase."
fi
if [[ "$PROVISION_ADMIN" == "auto" ]]; then
  [[ -z "$VAULT_REPOSITORY" ]] && PROVISION_ADMIN="yes" || PROVISION_ADMIN="no"
fi
[[ "$PROVISION_ADMIN" =~ ^(yes|no)$ ]] || fail "RP_PROVISION_ADMIN must be yes, no, or auto."
if [[ "$PROVISION_ADMIN" == "yes" ]]; then
  [[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "A valid initial administrator email is required."
  [[ -n "$ADMIN_NAME" && ${#ADMIN_NAME} -le 120 ]] || fail "Initial administrator full name is required."
  [[ "$ADMIN_GENERATE_PASSWORD" =~ ^(yes|no)$ ]] || fail "RP_ADMIN_GENERATE_PASSWORD must be yes or no."
  if [[ "$ADMIN_GENERATE_PASSWORD" == "no" ]]; then [[ ${#ADMIN_PASSWORD} -ge 12 ]] || fail "Initial administrator password must meet the password policy."; fi
fi
[[ "$BACKUP_ENABLED" =~ ^(yes|no)$ ]] || fail "RP_ENABLE_NIGHTLY_BACKUPS must be yes or no."
if [[ -e "$PROJECT_DIR" ]]; then
  if [[ "$INTERACTIVE_MODE" == "true" && "$RESUME_FAILED_INSTALL" == "no" ]]; then
    prompt_yes_no "An existing ReadyPackets project directory was found. Resume a previously failed fresh installation" RESUME_FAILED_INSTALL "no"
  fi
  [[ "$RESUME_FAILED_INSTALL" == "yes" ]] || fail "Project directory already exists: $PROJECT_DIR. This script will not overwrite an existing installation. Set RP_RESUME_FAILED_INSTALL=yes only for a failed fresh installation."
  [[ -d "$PROJECT_DIR/.git" ]] || fail "The existing project directory is not a Git checkout and cannot be safely resumed."
  if systemctl is-active --quiet readypackets 2>/dev/null; then
    fail "The ReadyPackets service is active. This resume path is restricted to failed fresh installations and will not modify a live portal."
  fi
else
  RESUME_FAILED_INSTALL="no"
fi

if [[ "$INTERACTIVE_MODE" == "true" ]]; then
  printf '\n\033[1;36mReadyPackets installation review\033[0m\n'
  printf '  Installation type: %s\n' "$MODE"
  printf '  Public hostname:    %s\n' "$DOMAIN"
  printf '  Website name:       %s\n' "$SITE_NAME"
  printf '  TLS method:         %s\n' "$TLS_PROVIDER"
  printf '  Source:             https://github.com/%s.git (%s%s)\n' "$REPOSITORY" "$REF" "${COMMIT:+, pinned ${COMMIT}}"
  printf '  Source access:      temporary public repository over anonymous HTTPS\n'
  printf '  Config recovery:    %s\n' "$( [[ -n "$VAULT_REPOSITORY" ]] && printf 'enabled (secrets hidden)' || printf 'not requested' )"
  printf '  Nightly backup:     %s\n' "$BACKUP_ENABLED"
  printf '  Initial admin:      %s\n' "$( [[ "$PROVISION_ADMIN" == "yes" ]] && printf '%s (%s password)' "$ADMIN_EMAIL" "$ADMIN_GENERATE_PASSWORD" || printf 'not provisioned by installer' )"
  printf '  Failed-install resume: %s\n' "$RESUME_FAILED_INSTALL"
  printf '\nNo secrets will be displayed or stored in shell history by this guided flow.\n'
  read -r -p "Type INSTALL READY PACKETS to begin: " final_confirmation
  [[ "$final_confirmation" == "INSTALL READY PACKETS" ]] || fail "Installation cancelled before any server changes."
elif [[ "$AUTO_CONFIRM" != "INSTALL_READY_PACKETS" ]]; then
  fail "Non-interactive execution requires RP_AUTO_CONFIRM=INSTALL_READY_PACKETS. Run from a terminal to use guided prompts."
fi

step "Starting guided ${MODE} installation for ${DOMAIN}."
step "Installing only bootstrap packages needed to retrieve the public source."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git

step "Verifying that the selected source is reachable without GitHub credentials."
GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "https://github.com/${REPOSITORY}.git" "refs/heads/${REF}" >/dev/null \
  || fail "The selected source is not anonymously readable at the requested ref. Temporarily make the repository public, verify the ref, or use the private-repository deploy-key procedure."

step "Retrieving ReadyPackets source from https://github.com/${REPOSITORY}.git"
if [[ "$RESUME_FAILED_INSTALL" == "yes" ]]; then
  step "Resuming the failed fresh installation with the latest selected source."
  cd "$PROJECT_DIR"
  git remote set-url origin "https://github.com/${REPOSITORY}.git"
  git fetch --depth 1 origin "$REF"
  git reset --hard FETCH_HEAD
  git clean -fd
else
  install -d -m 0755 "$(dirname "$PROJECT_DIR")"
  git clone --depth 1 --branch "$REF" "https://github.com/${REPOSITORY}.git" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi
if [[ -n "$COMMIT" ]]; then
  step "Verifying reviewed immutable source commit ${COMMIT}."
  git fetch --depth=1 origin "$COMMIT"
  resolved="$(git rev-parse FETCH_HEAD)"
  [[ "${resolved,,}" == "${COMMIT,,}" ]] || fail "Fetched source does not match the reviewed commit."
  git checkout --detach "$resolved"
else
  resolved="$(git rev-parse HEAD)"
  printf '[ReadyPackets install] Using latest %s branch commit: %s\n' "$REF" "$resolved"
fi
git status --porcelain | grep -q . && fail "Downloaded source is unexpectedly modified."

installer=(bash deploy/unified-install.sh --mode "$MODE" --domain "$DOMAIN" --site-name "$SITE_NAME")
[[ -n "$EMAIL" ]] && installer+=(--email "$EMAIL")
case "$TLS_PROVIDER" in
  letsencrypt) installer+=(--tls-provider letsencrypt) ;;
  cloudflare-origin)
    installer+=(--tls-provider cloudflare-origin --cloudflare-origin-cert "$CF_CERT" --cloudflare-origin-key "$CF_KEY")
    [[ -n "$CF_ROOT" ]] && installer+=(--cloudflare-origin-root "$CF_ROOT")
    ;;
  cloudflare-origin-ca)
    step "Preparing the Cloudflare API token for one-time Origin CA issuance."
    if [[ -n "$CF_API_TOKEN_FILE" ]]; then
      cf_api_token_file="$CF_API_TOKEN_FILE"
    else
      cf_api_token_file="$(write_secret_file "$CF_API_TOKEN" readypackets-cloudflare-api-token)"
      unset CF_API_TOKEN
    fi
    installer+=(--tls-provider cloudflare-origin-ca --cloudflare-api-token-file "$cf_api_token_file" --cloudflare-origin-validity "$CF_ORIGIN_VALIDITY")
    ;;
  none) installer+=(--no-tls) ;;
esac
if [[ "$MODE" != "native" ]]; then installer+=(--project-dir "$PROJECT_DIR"); fi
if [[ -n "$VAULT_REPOSITORY" ]]; then
  step "Preparing encrypted private GitHub configuration-vault recovery inputs."
  token_file="$(write_secret_file "$VAULT_TOKEN" readypackets-vault-token)"
  passphrase_file="$(write_secret_file "$VAULT_PASSPHRASE" readypackets-vault-passphrase)"
  unset VAULT_TOKEN VAULT_PASSPHRASE
  installer+=(--github-config-repository "$VAULT_REPOSITORY" --github-config-branch "$VAULT_BRANCH" --github-config-folder "$VAULT_FOLDER" --github-config-token-file "$token_file" --github-config-passphrase-file "$passphrase_file")
fi

step "Running the ReadyPackets unified installer. Progress will remain visible until completion."
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${installer[@]}"

if [[ "$MODE" == "native" ]]; then
  if [[ "$BACKUP_ENABLED" == "yes" ]]; then
    step "Ensuring the nightly encrypted local backup timer is enabled."
    systemctl enable --now readypackets-backup.timer >/dev/null 2>&1 || warn "The backup timer is not available yet; configure backups in the Admin portal after first sign-in."
  else
    step "Leaving the nightly local backup timer disabled by operator choice."
    systemctl disable --now readypackets-backup.timer >/dev/null 2>&1 || true
  fi
fi

if [[ "$PROVISION_ADMIN" == "yes" ]]; then
  step "Provisioning the initial administrator account."
  admin_args=(--email "$ADMIN_EMAIL" --name "$ADMIN_NAME")
  if [[ "$ADMIN_GENERATE_PASSWORD" == "yes" ]]; then
    admin_args+=(--generate-password)
  else
    admin_args+=(--password-stdin)
  fi
  if [[ "$MODE" == "native" ]]; then
    if [[ "$ADMIN_GENERATE_PASSWORD" == "yes" ]]; then
      runuser -u readypackets -- env $(grep -v '^#' /etc/readypackets/portal.env | xargs) node /opt/readypackets/dist/create-admin.js "${admin_args[@]}"
    else
      printf '%s\n' "$ADMIN_PASSWORD" | runuser -u readypackets -- env $(grep -v '^#' /etc/readypackets/portal.env | xargs) node /opt/readypackets/dist/create-admin.js "${admin_args[@]}"
    fi
  else
    if [[ "$ADMIN_GENERATE_PASSWORD" == "yes" ]]; then
      (cd "$PROJECT_DIR" && docker compose exec -T app node dist/create-admin.js "${admin_args[@]}")
    else
      printf '%s\n' "$ADMIN_PASSWORD" | (cd "$PROJECT_DIR" && docker compose exec -T app node dist/create-admin.js "${admin_args[@]}")
    fi
  fi
  unset ADMIN_PASSWORD
fi

if [[ "$MODE" == "native" ]]; then
  step "Verifying the completed local installation."
  bash "$PROJECT_DIR/deploy/verify-public-connectivity.sh" --domain "$DOMAIN" --local-only

  if [[ "$TLS_PROVIDER" != "none" ]]; then
    step "Checking public HTTPS reachability separately from installation success."
    if bash "$PROJECT_DIR/deploy/verify-public-connectivity.sh" --domain "$DOMAIN"; then
      :
    else
      connectivity_status=$?
      if [[ "$connectivity_status" -eq 2 && "$REQUIRE_PUBLIC_HEALTH" != "yes" ]]; then
        warn "The portal is installed locally; public HTTPS is still pending DNS, proxy, firewall, or certificate propagation."
      else
        fail "Public connectivity verification failed. The local installation remains available; run /opt/readypackets/deploy/verify-public-connectivity.sh after correcting reachability."
      fi
    fi
  fi
elif [[ "$TLS_PROVIDER" != "none" ]]; then
  # Docker completion has already verified the local reverse-proxy path. Public
  # DNS/TLS propagation is advisory here for the same reason as native installs.
  step "Attempting public HTTPS reachability (advisory)."
  curl -fsS --connect-timeout 5 --max-time 15 "https://${DOMAIN}/api/health" >/dev/null \
    || warn "Public HTTPS is not reachable yet; verify DNS, proxy, firewall, and certificate propagation."
fi
printf '\n\033[1;32m[ReadyPackets install complete]\033[0m Source commit: %s\n' "$resolved"
printf '[ReadyPackets install complete] Open: %s://%s\n' "$([[ "$TLS_PROVIDER" == "none" ]] && printf http || printf https)" "$DOMAIN"
