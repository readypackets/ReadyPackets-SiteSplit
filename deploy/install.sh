#!/usr/bin/env bash
#
# ReadyPackets Portal — VPS installer (Ubuntu 22.04 / 24.04, Debian 12)
#
# Installs the application as a systemd service behind nginx, with MySQL on the
# same host. Generates all cryptographic secrets locally; nothing is sent
# anywhere. Safe to re-run: existing secrets and data are preserved.
#
# Usage:
#   sudo ./deploy/install.sh --domain portal.example.com --portal-alias my.example.com --public-domain www.example.com --email ops@example.com
#
# Options:
#   --domain <host>     Canonical portal/API hostname (required)
#   --portal-alias <host> Additional explicit portal hostname; repeat up to five times. Aliases redirect to --domain.
#   --public-domain <host> Optional marketing-site hostname; enables separate public and portal bundles
#   --email <address>   Contact address for Let's Encrypt (required for --tls-provider letsencrypt)
#   --tls               Compatibility alias for --tls-provider letsencrypt
#   --tls-provider <p>  letsencrypt, cloudflare-origin, or cloudflare-origin-ca
#   --cloudflare-origin-cert <path>  PEM Origin certificate (manual Cloudflare Origin CA)
#   --cloudflare-origin-key <path>   PEM private key (manual Cloudflare Origin CA)
#   --cloudflare-origin-root <path>  Optional PEM Cloudflare Origin CA root/chain
#   --cloudflare-api-token-file <path> Root-only Cloudflare API token file (automated Origin CA)
#   --cloudflare-origin-validity <days> Origin CA lifetime: 7,30,90,365,730,1095,5475 (default 5475)
#   --no-seed           Skip catalogue seeding (use when restoring a backup)
#   --skip-packages     Assume Node, MySQL and nginx are already installed
#   --site-name <name>  Website name used for public page metadata
#   --github-config-repository owner/repository  Restore latest encrypted vault configuration
#   --github-config-branch <branch> --github-config-folder <path>
#   --github-config-token-file <root-only file> --github-config-passphrase-file <root-only file>

set -Eeuo pipefail

readonly APP_USER="readypackets"
readonly APP_DIR="/opt/readypackets"
readonly DATA_DIR="/var/lib/readypackets"
readonly ENV_DIR="/etc/readypackets"
readonly ENV_FILE="${ENV_DIR}/portal.env"
readonly NODE_MAJOR="22"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DOMAIN=""
PUBLIC_DOMAIN=""
ALTERNATE_DOMAIN=""
PORTAL_ALIAS_INPUTS=()
PORTAL_ALIAS_HOSTS=()
ALL_ROUTED_HOSTS=()
APP_ROUTED_HOSTS=()
PORTAL_ALIASES_CSV=""
ALL_SERVER_NAMES=""
APP_SERVER_NAMES=""
# An empty server_name handles no real hostname; unknown TLS SNI/Host therefore
# stays in the explicit default 421 server when no aliases are configured.
PORTAL_ALIAS_SERVER_NAMES='""'
APP_HOST_ALLOWLIST_REGEX=""
APP_ALLOWED_ORIGINS=""
CONTACT_EMAIL=""
TLS_PROVIDER="" # letsencrypt, cloudflare-origin, cloudflare-origin-ca, or empty to preserve/expose HTTP only
CLOUDFLARE_ORIGIN_CERT=""
CLOUDFLARE_ORIGIN_KEY=""
CLOUDFLARE_ORIGIN_ROOT=""
CLOUDFLARE_API_TOKEN_FILE=""
CLOUDFLARE_ORIGIN_VALIDITY="5475"
WANT_SEED="true"
SKIP_PACKAGES="false"
SITE_NAME="ReadyPackets"
GITHUB_CONFIG_REPOSITORY=""
GITHUB_CONFIG_BRANCH="main"
GITHUB_CONFIG_FOLDER="readypackets-platform-config"
GITHUB_CONFIG_TOKEN_FILE=""
GITHUB_CONFIG_PASSPHRASE_FILE=""
EPHEMERAL_SECRET_PATHS=()

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

purge_ephemeral_secret_path() {
  local path="$1"
  [[ -n "$path" && -e "$path" ]] || return 0
  if [[ -d "$path" ]]; then
    # Best effort only: secure erasure depends on the underlying filesystem,
    # but never leave a recoverable request directory intentionally behind.
    find "$path" -xdev -type f -exec shred -u -- {} + 2>/dev/null || true
    rm -rf -- "$path" || true
  else
    shred -u -- "$path" 2>/dev/null || rm -f -- "$path" || true
  fi
}

cleanup_ephemeral_secret_paths() {
  local path
  for path in "${EPHEMERAL_SECRET_PATHS[@]:-}"; do
    purge_ephemeral_secret_path "$path"
  done
}

trap cleanup_ephemeral_secret_paths EXIT
trap 'die "Installation failed on line ${LINENO}. No changes were rolled back; re-run once the cause is fixed."' ERR

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)        DOMAIN="${2:-}"; shift 2 ;;
    --portal-alias)  PORTAL_ALIAS_INPUTS+=("${2:-}"); shift 2 ;;
    --public-domain) PUBLIC_DOMAIN="${2:-}"; shift 2 ;;
    --email)         CONTACT_EMAIL="${2:-}"; shift 2 ;;
    --tls)           TLS_PROVIDER="letsencrypt"; shift ;;
    --tls-provider)  TLS_PROVIDER="${2:-}"; shift 2 ;;
    --cloudflare-origin-cert) CLOUDFLARE_ORIGIN_CERT="${2:-}"; shift 2 ;;
    --cloudflare-origin-key)  CLOUDFLARE_ORIGIN_KEY="${2:-}"; shift 2 ;;
    --cloudflare-origin-root) CLOUDFLARE_ORIGIN_ROOT="${2:-}"; shift 2 ;;
    --cloudflare-api-token-file) CLOUDFLARE_API_TOKEN_FILE="${2:-}"; shift 2 ;;
    --cloudflare-origin-validity) CLOUDFLARE_ORIGIN_VALIDITY="${2:-}"; shift 2 ;;
    --no-seed)       WANT_SEED="false"; shift ;;
    --skip-packages) SKIP_PACKAGES="true"; shift ;;
    --site-name) SITE_NAME="${2:-}"; shift 2 ;;
    --github-config-repository) GITHUB_CONFIG_REPOSITORY="${2:-}"; shift 2 ;;
    --github-config-branch) GITHUB_CONFIG_BRANCH="${2:-}"; shift 2 ;;
    --github-config-folder) GITHUB_CONFIG_FOLDER="${2:-}"; shift 2 ;;
    --github-config-token-file) GITHUB_CONFIG_TOKEN_FILE="${2:-}"; shift 2 ;;
    --github-config-passphrase-file) GITHUB_CONFIG_PASSPHRASE_FILE="${2:-}"; shift 2 ;;
    -h|--help)       sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)               die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "This installer must run as root (use sudo)."
[[ -n "$DOMAIN" ]] || die "--domain is required."
[[ "$SITE_NAME" != *$'\n'* && ${#SITE_NAME} -le 100 ]] || die "--site-name must be 1 to 100 characters and contain no line breaks."
[[ -n "$SITE_NAME" ]] || die "--site-name must not be empty."

# A supported in-place update invokes this installer with the canonical domain.
# Preserve aliases from the protected environment unless the operator explicitly
# supplies one or more replacement --portal-alias values; silently dropping a
# certificate SAN or redirect hostname would be unsafe.
if [[ "${#PORTAL_ALIAS_INPUTS[@]}" -eq 0 && -f "$ENV_FILE" ]]; then
  existing_portal_aliases="$(grep -m1 '^PORTAL_ALIASES=' "$ENV_FILE" | cut -d= -f2- || true)"
  if [[ -n "$existing_portal_aliases" ]]; then
    IFS=',' read -r -a PORTAL_ALIAS_INPUTS <<< "$existing_portal_aliases"
  fi
fi

if [[ -n "$GITHUB_CONFIG_REPOSITORY" || -n "$GITHUB_CONFIG_TOKEN_FILE" || -n "$GITHUB_CONFIG_PASSPHRASE_FILE" ]]; then
  [[ "$GITHUB_CONFIG_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--github-config-repository must be owner/repository."
  [[ -f "$GITHUB_CONFIG_TOKEN_FILE" && -f "$GITHUB_CONFIG_PASSPHRASE_FILE" ]] || die "GitHub configuration recovery requires root-only token and passphrase files."
fi

# Interactive operators choose the certificate model explicitly. Noninteractive
# automation must pass --tls-provider to avoid an unattended prompt.
if [[ -z "$TLS_PROVIDER" && -t 0 ]]; then
  printf '\nTLS certificate provider:\n  1) Let\x27s Encrypt (public certificate, automatic renewal)\n  2) Cloudflare Origin CA (Cloudflare-proxied origin, Full strict)\n  3) Preserve current certificate / configure later\n'
  read -r -p "Choose [1-3] (default 1): " tls_choice
  case "${tls_choice:-1}" in
    1) TLS_PROVIDER="letsencrypt" ;;
    2) TLS_PROVIDER="cloudflare-origin" ;;
    3) TLS_PROVIDER="" ;;
    *) die "Choose 1, 2, or 3 for TLS certificate provider." ;;
  esac
fi
if [[ -n "$TLS_PROVIDER" && "$TLS_PROVIDER" != "letsencrypt" && "$TLS_PROVIDER" != "cloudflare-origin" && "$TLS_PROVIDER" != "cloudflare-origin-ca" ]]; then
  die "--tls-provider must be letsencrypt, cloudflare-origin, or cloudflare-origin-ca."
fi
if [[ "$TLS_PROVIDER" == "letsencrypt" && -z "$CONTACT_EMAIL" ]]; then
  die "--email is required for Let's Encrypt."
fi
if [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then
  [[ -f "$CLOUDFLARE_ORIGIN_CERT" ]] || die "Provide --cloudflare-origin-cert <PEM certificate path>."
  [[ -f "$CLOUDFLARE_ORIGIN_KEY" ]] || die "Provide --cloudflare-origin-key <PEM private key path>."
  [[ -z "$CLOUDFLARE_ORIGIN_ROOT" || -f "$CLOUDFLARE_ORIGIN_ROOT" ]] || die "Cloudflare Origin CA root path does not exist."
elif [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
  [[ -f "$CLOUDFLARE_API_TOKEN_FILE" ]] || die "Automated Cloudflare Origin CA requires --cloudflare-api-token-file <root-only file>."
  [[ "$(stat -c '%U:%a' "$CLOUDFLARE_API_TOKEN_FILE")" == "root:600" ]] || die "The Cloudflare API token file must be root-owned with mode 0600."
  [[ -s "$CLOUDFLARE_API_TOKEN_FILE" ]] || die "The Cloudflare API token file is empty."
  [[ "$CLOUDFLARE_ORIGIN_VALIDITY" =~ ^(7|30|90|365|730|1095|5475)$ ]] || die "--cloudflare-origin-validity must be one of 7, 30, 90, 365, 730, 1095, or 5475."
fi

# Normalize and validate every hostname before it reaches nginx, the certificate
# request, or the application's origin controls. Aliases are intentionally a
# bounded, explicit list: arbitrary Host headers are never made trustworthy.
valid_hostname() {
  [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]
}

is_reserved_public_website_hostname() {
  [[ "$1" == "readypackets.com" || "$1" == "www.readypackets.com" ]]
}

escape_regex() { printf '%s' "$1" | sed 's/[.[\\*^$()+?{|]/\\\\&/g'; }

DOMAIN="${DOMAIN,,}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN,,}"
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]] \
  || die "'${DOMAIN}' does not look like a valid hostname."
is_reserved_public_website_hostname "$DOMAIN" \
  && die "${DOMAIN} is reserved for the independently hosted ReadyPackets website. Use a dedicated portal hostname."
if [[ -n "$PUBLIC_DOMAIN" ]]; then
  valid_hostname "$PUBLIC_DOMAIN" \
    || die "'${PUBLIC_DOMAIN}' does not look like a valid hostname."
  [[ "$PUBLIC_DOMAIN" != "$DOMAIN" ]] || die "--public-domain must differ from --domain. Omit it for the legacy single-host deployment."
fi

# Treat a conventional apex/www pair as one public site. This preserves an
# explicit subdomain deployment (for example portal.example.com), but lets a
# user entering either example.com or www.example.com reach the same portal.
if [[ "$DOMAIN" == www.* ]]; then
  ALTERNATE_DOMAIN="${DOMAIN#www.}"
elif [[ "$DOMAIN" =~ ^[^.]+\.[^.]+$ ]]; then
  ALTERNATE_DOMAIN="www.${DOMAIN}"
fi
if [[ -n "$PUBLIC_DOMAIN" && "$PUBLIC_DOMAIN" == "$ALTERNATE_DOMAIN" ]]; then
  die "Use a dedicated portal subdomain with --public-domain (for example --domain portal.example.com --public-domain www.example.com); the canonical apex/www alias cannot simultaneously be the public site."
fi

add_portal_alias() {
  local alias="$1" known
  valid_hostname "$alias" || die "'${alias}' does not look like a valid portal alias hostname."
  [[ "$alias" != "$DOMAIN" ]] || die "--portal-alias must differ from the canonical --domain."
  is_reserved_public_website_hostname "$alias" \
    && die "${alias} is reserved for the independently hosted ReadyPackets website and cannot be a portal alias."
  [[ -z "$PUBLIC_DOMAIN" || "$alias" != "$PUBLIC_DOMAIN" ]] \
    || die "--portal-alias must differ from --public-domain."
  for known in "${PORTAL_ALIAS_HOSTS[@]}"; do
    [[ "$known" == "$alias" ]] && return 0
  done
  PORTAL_ALIAS_HOSTS+=("$alias")
}

explicit_alias_count=0
for requested_alias in "${PORTAL_ALIAS_INPUTS[@]}"; do
  requested_alias="${requested_alias,,}"
  ((explicit_alias_count += 1))
  (( explicit_alias_count <= 5 )) || die "At most five explicit --portal-alias values are permitted."
  add_portal_alias "$requested_alias"
done

# Retain backwards-compatible apex/www behavior, but make it use the same
# canonical redirect semantics as an explicitly configured portal alias.
if [[ -n "$ALTERNATE_DOMAIN" ]]; then
  add_portal_alias "$ALTERNATE_DOMAIN"
fi

ALL_ROUTED_HOSTS=("$DOMAIN" "${PORTAL_ALIAS_HOSTS[@]}")
APP_ROUTED_HOSTS=("$DOMAIN")
if [[ -n "$PUBLIC_DOMAIN" ]]; then
  ALL_ROUTED_HOSTS+=("$PUBLIC_DOMAIN")
  APP_ROUTED_HOSTS+=("$PUBLIC_DOMAIN")
fi
ALL_SERVER_NAMES="${ALL_ROUTED_HOSTS[*]}"
APP_SERVER_NAMES="${APP_ROUTED_HOSTS[*]}"
if [[ "${#PORTAL_ALIAS_HOSTS[@]}" -gt 0 ]]; then
  PORTAL_ALIAS_SERVER_NAMES="${PORTAL_ALIAS_HOSTS[*]}"
fi
for hostname in "${APP_ROUTED_HOSTS[@]}"; do
  escaped_hostname="$(escape_regex "$hostname")"
  if [[ -n "$APP_HOST_ALLOWLIST_REGEX" ]]; then
    APP_HOST_ALLOWLIST_REGEX+="|${escaped_hostname}"
  else
    APP_HOST_ALLOWLIST_REGEX="$escaped_hostname"
  fi
done
if [[ "${#PORTAL_ALIAS_HOSTS[@]}" -gt 0 ]]; then
  PORTAL_ALIASES_CSV="$(IFS=,; printf '%s' "${PORTAL_ALIAS_HOSTS[*]}")"
fi

# Portal aliases are edge redirects only. They never become application origins:
# this preserves one host-only __Host- session/CSRF cookie origin and prevents a
# direct proxy path from treating an alias as an authenticated portal host.
APP_ALLOWED_ORIGINS="https://${DOMAIN}"
[[ -n "$PUBLIC_DOMAIN" ]] && APP_ALLOWED_ORIGINS+=",https://${PUBLIC_DOMAIN}"

log "Installing ReadyPackets Portal for https://${DOMAIN}"
[[ -n "$PORTAL_ALIASES_CSV" ]] && log "Configured portal aliases (canonical HTTPS redirects): ${PORTAL_ALIASES_CSV}"

# ---------------------------------------------------------------------------
# Packages
# ---------------------------------------------------------------------------
if [[ "$SKIP_PACKAGES" == "false" ]]; then
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  # A stale NodeSource key can make apt refuse every package operation before
  # Node.js setup runs. Remove only the NodeSource source/keyring on that
  # specific failure, then retry the signed base-package refresh.
  if ! apt-get update -qq; then
    if [[ -f /etc/apt/sources.list.d/nodesource.list ]] && grep -q 'deb.nodesource.com' /etc/apt/sources.list.d/nodesource.list; then
      warn "Refreshing stale NodeSource apt source before installing Node.js ${NODE_MAJOR}."
      rm -f /etc/apt/sources.list.d/nodesource.list \
        /etc/apt/keyrings/nodesource.gpg \
        /usr/share/keyrings/nodesource.gpg \
        /etc/apt/trusted.gpg.d/nodesource.gpg
      apt-get update -qq
    else
      die "apt-get update failed before package installation; resolve the failing configured repository and retry."
    fi
  fi
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git build-essential python3 \
    mysql-server nginx nginx-extras ufw fail2ban unzip ffmpeg antiword poppler-utils pandoc ghostscript libreoffice-writer python3-pip
  # PDF-to-Word conversion is a documented application dependency. Pin it on
  # installation so the worker never relies on an untracked host package.
  python3 -m pip install --no-cache-dir --break-system-packages "pdf2docx==0.5.8"

  if ! command -v node >/dev/null 2>&1 || \
     [[ "$(node --version | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]]; then
    log "Installing Node.js ${NODE_MAJOR}"
    # NodeSource rotated its repository signing keys for current Ubuntu releases.
    # Its versioned setup script refreshes the signed source and its keyring before
    # apt is allowed to install Node.js; this avoids retaining a stale key locally.
    nodesource_setup="$(mktemp)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$nodesource_setup"
    bash "$nodesource_setup"
    rm -f "$nodesource_setup"
    apt-get install -y nodejs
  fi

  corepack enable || true
  corepack prepare pnpm@9.15.0 --activate || npm install -g pnpm@9.15.0
fi

command -v node >/dev/null 2>&1 || die "Node.js is not installed."
command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed."
for native_converter in ffmpeg pdftotext pandoc gs libreoffice; do
  command -v "$native_converter" >/dev/null 2>&1 || die "Required self-hosted conversion tool '$native_converter' is not installed. Re-run without --skip-packages."
done
python3 -c 'import pdf2docx' >/dev/null 2>&1 || die "Required Python package pdf2docx is not installed. Re-run without --skip-packages."

# ---------------------------------------------------------------------------
# Service account and directories
# ---------------------------------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating service account '${APP_USER}'"
  # No login shell and no home directory: this account exists only to own a
  # process and a storage directory.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi

log "Preparing directories"
install -d -m 0755 -o root      -g root      "$APP_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "${DATA_DIR}/storage"
install -d -m 0750 -o root      -g "$APP_USER" "$ENV_DIR"

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
# Generated on this machine with the kernel CSPRNG. If the file already exists,
# its values are reused so that re-running the installer cannot invalidate every
# existing session or, worse, orphan encrypted data.
if [[ -f "$ENV_FILE" ]]; then
  log "Reusing existing secrets in ${ENV_FILE}"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  log "Generating secrets"
  SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n=' )"
  DATA_ENCRYPTION_KEY="$(openssl rand -hex 32)"
  EMAIL_INDEX_KEY="$(openssl rand -hex 32)"
  DB_PASSWORD="$(openssl rand -base64 32 | tr -d '\n=/+' | cut -c1-32)"
fi

: "${SESSION_SECRET:?}" ; : "${DATA_ENCRYPTION_KEY:?}" ; : "${EMAIL_INDEX_KEY:?}"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 32 | tr -d '\n=/+' | cut -c1-32)}"
DB_NAME="${DB_NAME:-readypackets}"
DB_USER="${DB_USER:-readypackets}"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
log "Configuring MySQL"
systemctl enable --now mysql >/dev/null 2>&1 || systemctl enable --now mysqld

# MySQL distinguishes 'localhost' (Unix socket) from '127.0.0.1' (TCP loopback)
# and a grant for one does not apply to the other. DATABASE_URL below connects
# over TCP to 127.0.0.1, so that is the host the grant must name. Both are
# created because operators reasonably expect the socket form to work too when
# running maintenance commands by hand.
mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1'
  IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost'
  IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
-- Only the privileges the application needs. No GRANT, no FILE, no SUPER.
-- DROP is included because the migration runner must be able to replace an
-- index or a constraint; it cannot drop the database itself.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, DROP, REFERENCES
  ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, DROP, REFERENCES
  ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

# Fail loudly here rather than at the migration step, where the cause is far
# less obvious from the error message.
if ! mysql -h 127.0.0.1 -u "$DB_USER" -p"$DB_PASSWORD" -e 'SELECT 1' \
     "$DB_NAME" >/dev/null 2>&1; then
  die "The application database user cannot connect over TCP to 127.0.0.1. Check the grants for '${DB_USER}'@'127.0.0.1'."
fi

# MySQL must not listen on a public interface.
MYSQL_CONF="/etc/mysql/mysql.conf.d/zz-readypackets.cnf"
cat > "$MYSQL_CONF" <<'CONF'
# Installed by the ReadyPackets installer.
[mysqld]
bind-address = 127.0.0.1
skip-name-resolve
local_infile = 0
CONF
systemctl restart mysql >/dev/null 2>&1 || systemctl restart mysqld

# ---------------------------------------------------------------------------
# Application build
# ---------------------------------------------------------------------------
log "Building the application"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude var --exclude client/dist --exclude client/dist-public --exclude client/dist-portal --exclude dist \
  "${REPO_ROOT}/" "${APP_DIR}/"

cd "$APP_DIR"
pnpm install --prod=false --frozen-lockfile=false
pnpm run build:client
pnpm exec esbuild server/index.ts --bundle --platform=node --target=node22 \
  --format=esm --packages=external --outfile=dist/server.js
for script in migrate seed create-admin; do
  pnpm exec esbuild "scripts/${script}.ts" --bundle --platform=node --target=node22 \
    --format=esm --packages=external --outfile="dist/${script}.js"
done

# Fail before writing the protected runtime environment or touching the database
# if a development/build interruption left any mandatory operational bundle out.
# The migration runner is particularly important: a missing bundle must never be
# discovered only after database credentials and service configuration exist.
for runtime_artifact in dist/server.js dist/migrate.js dist/seed.js dist/create-admin.js; do
  [[ -s "$runtime_artifact" ]] || die "Required build artifact is missing: ${APP_DIR}/${runtime_artifact}. Re-run after fixing the source build."
  node --check "$runtime_artifact" >/dev/null
done
for client_shell in client/dist-public/public.html client/dist-portal/portal.html; do
  [[ -s "$client_shell" ]] || die "Required split client bundle is missing: ${APP_DIR}/${client_shell}. Re-run after fixing the source build."
done

# The bundler inlines code, not data. The seed reads the catalogue and the policy
# documents at runtime and resolves them relative to its own location, so they
# must sit beside the bundle. The migration runner reads its SQL the same way.
install -d -m 0755 "${APP_DIR}/dist/data"
cp -a "${APP_DIR}/scripts/data/." "${APP_DIR}/dist/data/"
[[ -f "${APP_DIR}/dist/data/catalog.json" ]] \
  || die "Seed data was not copied to dist/data; the catalogue would be empty."
[[ -d "${APP_DIR}/drizzle/migrations" ]] \
  || die "drizzle/migrations is missing from the source tree; the database cannot be created."
# Development dependencies are retained until migration and seed execution below.
# Some package-manager versions can prune executable build helpers aggressively;
# pruning only after the runtime has been initialized keeps a fresh install
# deterministic and prevents an absent migration artifact from blocking setup.

# The runtime tree contains application code and dependencies, not environment
# secrets. The service account must be able to traverse directories and read its
# root-owned runtime modules. Preserve existing owner/execute bits while adding
# only the read/traverse rights required by the dedicated service group.
grant_runtime_read_access() {
  chown -R root:"$APP_USER" "$APP_DIR"
  find "$APP_DIR" -type d -exec chmod g+rx {} +
  find "$APP_DIR" -type f -exec chmod g+r {} +
  chmod -R go-w "$APP_DIR"
}
grant_runtime_read_access

# ---------------------------------------------------------------------------
# Environment file
# ---------------------------------------------------------------------------
log "Writing ${ENV_FILE}"
umask 027
cat > "$ENV_FILE" <<ENVFILE
# ReadyPackets Portal environment. Generated $(date -u '+%Y-%m-%dT%H:%M:%SZ').
# This file contains secrets. Keep mode 0640, owner root, group ${APP_USER}.

NODE_ENV=production
PORT=3000
BIND_HOST=127.0.0.1
APP_URL=https://${DOMAIN}
PUBLIC_SITE_URL=https://${PUBLIC_DOMAIN:-$DOMAIN}
# Only the canonical portal and optional public website reach Node. Approved
# PORTAL_ALIASES are terminated by nginx and 308-redirected before cookies or
# application routes are available.
ALLOWED_ORIGINS=${APP_ALLOWED_ORIGINS}
PORTAL_ALIASES=${PORTAL_ALIASES_CSV}
# Root-owned source checkout used by the controlled platform-update helper.
RP_SOURCE_DIR=${REPO_ROOT}

DATABASE_URL=mysql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:3306/${DB_NAME}
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}

SESSION_SECRET=${SESSION_SECRET}
DATA_ENCRYPTION_KEY=${DATA_ENCRYPTION_KEY}
EMAIL_INDEX_KEY=${EMAIL_INDEX_KEY}
SITE_NAME=$(printf '%q' "$SITE_NAME")

# nginx on this host is the only proxy in front of the application.
# BEHIND_CLOUDFLARE=true tells the app to read CF-Connecting-IP for real client IPs.
TRUST_PROXY_HOPS=1
BEHIND_CLOUDFLARE=true

SESSION_TTL_MINUTES=720
SESSION_IDLE_TIMEOUT_MINUTES=120

STORAGE_DRIVER=local
STORAGE_LOCAL_ROOT=${DATA_DIR}/storage
MAX_UPLOAD_BYTES=52428800
# For a horizontally replicated deployment, switch to STORAGE_DRIVER=s3 and
# configure a private versioned S3-compatible bucket after installation.
# S3_ENDPOINT=https://object-storage.example.net
# S3_REGION=us-east-1
# S3_BUCKET=readypackets-production
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
# S3_FORCE_PATH_STYLE=false

# Outbound email. Until these are set, messages queue in the database and the
# admin dashboard reports the queue as degraded.
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=no-reply@${DOMAIN#portal.}
SMTP_REPLY_TO=

# Optional payment capture. Leave blank to record payments manually.
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PUBLISHABLE_KEY=

# Optional SAML single sign-on for staff.
SAML_ENABLED=false
SAML_ENTRY_POINT=
SAML_ISSUER=
SAML_IDP_CERT=

# Comma-separated addresses or CIDR ranges permitted to reach /admin.
ADMIN_IP_ALLOWLIST=

LOG_LEVEL=info
SYSLOG_TARGET=
ENVFILE

chown root:"$APP_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

# ---------------------------------------------------------------------------
# Migrate and seed
# ---------------------------------------------------------------------------
# A migration runner is essential even on a fresh database because it creates the
# entire application schema. Build a new runner at the execution boundary rather
# than trusting any earlier bundle: this removes package-manager/cache timing from
# the path between source compilation and the service-account migration command.
rebuild_migration_runner() {
  local artifact="${APP_DIR}/dist/migrate.js"
  local temporary="${APP_DIR}/dist/.migrate.$$.js"
  log "Building the database migration runner immediately before schema initialization."
  [[ -f "${APP_DIR}/scripts/migrate.ts" ]] \
    || die "Migration source is missing: ${APP_DIR}/scripts/migrate.ts"
  rm -f -- "$temporary"
  pnpm exec esbuild "${APP_DIR}/scripts/migrate.ts" --bundle --platform=node --target=node22 \
    --format=esm --packages=external --outfile="$temporary"
  [[ -s "$temporary" ]] || die "The database migration runner could not be built: $temporary"
  node --check "$temporary" >/dev/null || die "The database migration runner has invalid JavaScript: $temporary"
  install -o root -g root -m 0644 "$temporary" "$artifact"
  rm -f -- "$temporary"
  [[ -s "$artifact" ]] || die "The database migration runner disappeared after installation: $artifact"
  runuser -u "$APP_USER" -- test -r "$artifact" \
    || die "The service account cannot read the database migration runner: $artifact"
}
rebuild_migration_runner

grant_runtime_read_access

# The environment file is controlled by this installer and contains shell-quoted
# values such as SITE_NAME. Loading it in a dedicated service-account shell
# preserves spaces and other valid values without the unsafe word splitting
# performed by `env $(... | xargs)`.
run_app_command() {
  runuser -u "$APP_USER" -- sh -c '
    set -a
    . "$1"
    set +a
    shift
    exec "$@"
  ' sh "$ENV_FILE" "$@"
}

log "Applying database migrations"
run_app_command node "${APP_DIR}/dist/migrate.js"

if [[ "$WANT_SEED" == "true" ]]; then
  log "Seeding catalogue, policies and settings"
  run_app_command node "${APP_DIR}/dist/seed.js"
fi


# Runtime initialization is complete. Now remove development-only packages while
# leaving the already verified bundled operational artifacts intact.
log "Pruning development dependencies"
pnpm prune --prod
for runtime_artifact in dist/server.js dist/migrate.js dist/seed.js dist/create-admin.js; do
  [[ -s "$runtime_artifact" ]] || die "Production dependency pruning removed a required artifact: ${APP_DIR}/${runtime_artifact}."
done
grant_runtime_read_access

if [[ -n "$GITHUB_CONFIG_REPOSITORY" ]]; then
  log "Downloading the latest encrypted configuration vault bundle from private GitHub."
  vault_bundle="/root/readypackets-github-vault.rpconfig"
  bash "${APP_DIR}/deploy/github-config-vault-restore.sh" \
    --repository "$GITHUB_CONFIG_REPOSITORY" --branch "$GITHUB_CONFIG_BRANCH" --folder "$GITHUB_CONFIG_FOLDER" \
    --token-file "$GITHUB_CONFIG_TOKEN_FILE" --output "$vault_bundle"
  bash "${APP_DIR}/deploy/config-migration.sh" import --input "$vault_bundle" \
    --passphrase-file "$GITHUB_CONFIG_PASSPHRASE_FILE" --replace-config --include-secrets --apply-env --force
  rm -f -- "$vault_bundle"
  # The explicit installer choice wins for the new public site identity.
  sed -i -E '/^SITE_NAME=.*/d' "$ENV_FILE"
  printf 'SITE_NAME=%q\n' "$SITE_NAME" >> "$ENV_FILE"
  chown root:"$APP_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"
fi

# Record the immutable source revision whenever the installer runs from a Git checkout.
# The controlled Platform updates screen reads this root-owned marker rather than
# guessing from a branch name or another server's deployment configuration.
if release_commit="$(git -C "$REPO_ROOT" rev-parse --verify HEAD 2>/dev/null)"; then
  printf '%s\n' "$release_commit" > "${APP_DIR}/RELEASE_COMMIT"
  chown root:"$APP_USER" "${APP_DIR}/RELEASE_COMMIT"
  chmod 0640 "${APP_DIR}/RELEASE_COMMIT"
else
  warn "Source checkout has no Git commit marker; Platform updates will show unknown until an immutable release is installed."
fi

# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------
log "Installing the systemd service"
install -m 0644 "${APP_DIR}/deploy/readypackets.service" /etc/systemd/system/readypackets.service
systemctl daemon-reload
systemctl enable readypackets
systemctl restart readypackets

# ---------------------------------------------------------------------------
# nginx
# ---------------------------------------------------------------------------
log "Configuring nginx"
NGINX_SITE="/etc/nginx/sites-available/readypackets"

# A configuration that names a certificate file which does not exist yet is a
# fatal error, not a warning, and `systemctl reload` in that state silently keeps
# serving the previous configuration. So the order matters: serve plain HTTP,
# obtain the certificate against that, and only then install the TLS
# configuration.
write_http_only_site() {
  cat > "$NGINX_SITE" <<TEMP
# Temporary HTTP-only configuration, replaced once a certificate exists.
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    return 421;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${ALL_SERVER_NAMES};
    server_tokens off;
    client_max_body_size 55m;

    # The ^~ prefix keeps the ACME HTTP-01 exception ahead of hidden-file protections.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
        default_type "text/plain";
    }

    location / {
        return 308 https://${DOMAIN}\$request_uri;
    }
}
TEMP
}

write_hardened_site() {
  # The hostname appears twice in different forms: as a literal in server_name
  # and the certificate paths, and regex-escaped in the host allowlist. Both are
  # substituted, and the result is checked, because a silent miss here produces a
  # server that rejects its own hostname with 421.
  # Order matters. Substituting the regex token first and the literal hostname
  # second lets the literal rule match the substring "portal.readypackets.com"
  # inside a freshly written "myportal\.readypackets\.com", yielding
  # "mymyportal...". Replacing the literal first, then the token, avoids the
  # overlap entirely.
  # sed processes backslashes in the replacement text, so a single "\." would
  # arrive as a bare "." -- still functional, since an unescaped dot matches any
  # character, but it would accept "myportalXreadypackets.com" too. Doubling them
  # means one backslash survives into the file.
  # `more_clear_headers` comes from the headers-more module, present in
  # nginx-extras but not in the base nginx package. Emitting the directive
  # unconditionally would make the whole configuration fail to load on a stock
  # install, so it is enabled only when nginx actually has the module.
  local clear_headers="# headers-more module not installed; \"Server: nginx\" is still sent."
  if nginx -V 2>&1 | grep -q 'headers-more'; then
    clear_headers="more_clear_headers 'Server';"
  fi

  sed -e "s/portal\.readypackets\.com/${DOMAIN}/g" \
      -e "s/__RP_HTTP_SERVER_NAMES__/${ALL_SERVER_NAMES}/g" \
      -e "s/__RP_PORTAL_ALIAS_SERVER_NAMES__/${PORTAL_ALIAS_SERVER_NAMES}/g" \
      -e "s/__RP_APP_SERVER_NAMES__/${APP_SERVER_NAMES}/g" \
      -e "s/__RP_CANONICAL_DOMAIN__/${DOMAIN}/g" \
      -e "s/__RP_APP_HOST_REGEX__/${APP_HOST_ALLOWLIST_REGEX}/g" \
      -e "s|# __RP_MORE_CLEAR_HEADERS__|${clear_headers}|g" \
      "${APP_DIR}/deploy/nginx.conf" > "$NGINX_SITE"

  if grep -q '__RP_' "$NGINX_SITE"; then
    die "A placeholder was left unsubstituted in ${NGINX_SITE}."
  fi
  # Word-anchored: an unanchored search for "portal.readypackets.com" also matches
  # the correctly substituted "myportal.readypackets.com", which would reject a
  # perfectly good configuration. The template's example hostname can also be a
  # deliberate redirect-only alias, so only reject it when it is absent from every
  # approved routed hostname after rendering.
  local template_hostname="portal.readypackets.com"
  local template_hostname_is_routed="false"
  local configured_hostname
  for configured_hostname in "${ALL_ROUTED_HOSTS[@]}"; do
    if [[ "$configured_hostname" == "$template_hostname" ]]; then
      template_hostname_is_routed="true"
      break
    fi
  done
  if [[ "$template_hostname_is_routed" == "false" ]] \
     && grep -qE '(^|[^.[:alnum:]-])portal\.readypackets\.com' "$NGINX_SITE"; then
    die "The template hostname survived substitution in ${NGINX_SITE}."
  fi
}

TLS_DIR="/etc/readypackets/tls"
TLS_INCLUDE="${TLS_DIR}/nginx-tls.conf"
CLOUDFLARE_TLS_DIR="${TLS_DIR}/cloudflare-origin"

certificate_covers_public_names() {
  local certificate="$1" hostname
  local -a hostnames=("${ALL_ROUTED_HOSTS[@]}")
  [[ -f "$certificate" ]] || return 1
  for hostname in "${hostnames[@]}"; do
    openssl x509 -in "$certificate" -noout -checkhost "$hostname" 2>/dev/null | grep -q "does match certificate" || return 1
  done
}

write_tls_include() {
  local provider="$1" certificate="$2" private_key="$3"
  install -d -m 0700 -o root -g root "$TLS_DIR"
  umask 027
  cat > "$TLS_INCLUDE" <<TLSCONF
# Managed by the ReadyPackets installer. Provider: ${provider}
ssl_certificate ${certificate};
ssl_certificate_key ${private_key};
TLSCONF
  chown root:root "$TLS_INCLUDE"
  chmod 0640 "$TLS_INCLUDE"
}

install_cloudflare_origin_material() {
  install -d -m 0700 -o root -g root "$CLOUDFLARE_TLS_DIR"
  install -m 0644 -o root -g root "$CLOUDFLARE_ORIGIN_CERT" "${CLOUDFLARE_TLS_DIR}/certificate.pem"
  install -m 0600 -o root -g root "$CLOUDFLARE_ORIGIN_KEY" "${CLOUDFLARE_TLS_DIR}/private-key.pem"
  if [[ -n "$CLOUDFLARE_ORIGIN_ROOT" ]]; then
    install -m 0644 -o root -g root "$CLOUDFLARE_ORIGIN_ROOT" "${CLOUDFLARE_TLS_DIR}/cloudflare-origin-ca-root.pem"
  fi
  certificate_covers_public_names "${CLOUDFLARE_TLS_DIR}/certificate.pem" || die "Cloudflare Origin certificate does not cover every configured public hostname."
  openssl x509 -in "${CLOUDFLARE_TLS_DIR}/certificate.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 > /tmp/rp-cert-pub.$$
  openssl pkey -in "${CLOUDFLARE_TLS_DIR}/private-key.pem" -pubout -outform DER | openssl dgst -sha256 > /tmp/rp-key-pub.$$
  cmp -s /tmp/rp-cert-pub.$$ /tmp/rp-key-pub.$$ || die "Cloudflare Origin certificate and private key do not match."
  rm -f /tmp/rp-cert-pub.$$ /tmp/rp-key-pub.$$
  write_tls_include "cloudflare-origin" "${CLOUDFLARE_TLS_DIR}/certificate.pem" "${CLOUDFLARE_TLS_DIR}/private-key.pem"
}

issue_cloudflare_origin_ca() {
  local work token api_config csr payload response hostname private_key hostnames_json san
  work="$(mktemp -d /root/readypackets-cloudflare-origin.XXXXXX)"
  chmod 0700 "$work"
  EPHEMERAL_SECRET_PATHS+=("$work")
  token="$(tr -d '\r\n' < "$CLOUDFLARE_API_TOKEN_FILE")"
  [[ "$token" =~ ^[A-Za-z0-9._-]{20,}$ ]] || { rm -rf "$work"; die "The Cloudflare API token has an unexpected format."; }
  api_config="${work}/curl.conf"
  csr="${work}/origin.csr.pem"
  payload="${work}/request.json"
  response="${work}/response.json"

  # Keep the token out of argv, environment exports, installer profiles, logs,
  # and persisted portal configuration. curl reads its Authorization header from
  # a root-only ephemeral config file that is removed before this function exits.
  printf 'header = "Authorization: Bearer %s"\\n' "$token" > "$api_config"
  chmod 0600 "$api_config"
  unset token

  private_key="${work}/private-key.pem"
  openssl genrsa -out "$private_key" 3072 >/dev/null 2>&1
  chmod 0600 "$private_key"
  hostname="$DOMAIN"
  local -a certificate_hosts=("${ALL_ROUTED_HOSTS[@]}")
  san="$(printf 'DNS:%s,' "${certificate_hosts[@]}")"
  san="${san%,}"
  openssl req -new -key "$private_key" -out "$csr" \
    -subj "/CN=${hostname}" -addext "subjectAltName=${san}"
  # jq treats every argument after --args as hostname data. Keep the filter
  # before --args so a canonical name such as my.readypackets.com is never
  # parsed as jq program text.
  hostnames_json="$(jq -n '$ARGS.positional' --args "${certificate_hosts[@]}")"
  jq -n --rawfile csr "$csr" --argjson hostnames "$hostnames_json" \
    --argjson validity "$CLOUDFLARE_ORIGIN_VALIDITY" \
    '{csr:$csr,hostnames:$hostnames,request_type:"origin-rsa",requested_validity:$validity}' > "$payload"

  if ! curl --fail --silent --show-error --config "$api_config" \
      --header 'Content-Type: application/json' --request POST \
      --data-binary "@${payload}" --output "$response" \
      https://api.cloudflare.com/client/v4/certificates; then
    rm -rf "$work"
    die "Cloudflare Origin CA API request failed. Verify the token has Zone → SSL and Certificates → Edit for this zone."
  fi
  if ! jq -e '.success == true and (.result.certificate | type == "string")' "$response" >/dev/null; then
    jq -r '.errors[]?.message // empty' "$response" >&2 || true
    rm -rf "$work"
    die "Cloudflare Origin CA did not issue a certificate."
  fi
  jq -r '.result.certificate' "$response" > "${work}/certificate.pem"
  certificate_covers_public_names "${work}/certificate.pem" || { rm -rf "$work"; die "Cloudflare Origin CA certificate does not cover every configured public hostname."; }
  openssl x509 -in "${work}/certificate.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 > "${work}/cert-pub.sha256"
  openssl pkey -in "$private_key" -pubout -outform DER | openssl dgst -sha256 > "${work}/key-pub.sha256"
  cmp -s "${work}/cert-pub.sha256" "${work}/key-pub.sha256" || { rm -rf "$work"; die "Cloudflare Origin CA certificate and generated private key do not match."; }

  install -d -m 0700 -o root -g root "$CLOUDFLARE_TLS_DIR"
  install -m 0644 -o root -g root "${work}/certificate.pem" "${CLOUDFLARE_TLS_DIR}/certificate.pem"
  install -m 0600 -o root -g root "$private_key" "${CLOUDFLARE_TLS_DIR}/private-key.pem"
  purge_ephemeral_secret_path "$work"

  openssl x509 -in "${CLOUDFLARE_TLS_DIR}/certificate.pem" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 > /tmp/rp-cert-pub.$$
  openssl pkey -in "${CLOUDFLARE_TLS_DIR}/private-key.pem" -pubout -outform DER | openssl dgst -sha256 > /tmp/rp-key-pub.$$
  cmp -s /tmp/rp-cert-pub.$$ /tmp/rp-key-pub.$$ || die "Cloudflare Origin CA certificate and generated private key do not match."
  rm -f /tmp/rp-cert-pub.$$ /tmp/rp-key-pub.$$
  write_tls_include "cloudflare-origin-ca-api" "${CLOUDFLARE_TLS_DIR}/certificate.pem" "${CLOUDFLARE_TLS_DIR}/private-key.pem"
}

HAVE_CERT="false"
LE_CERTIFICATE="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
LE_PRIVATE_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
if [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then
  log "Installing the supplied Cloudflare Origin CA material"
  install_cloudflare_origin_material
  HAVE_CERT="true"
elif [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
  log "Requesting a Cloudflare Origin CA certificate through the scoped API token"
  command -v jq >/dev/null 2>&1 || apt-get install -y --no-install-recommends jq >/dev/null
  issue_cloudflare_origin_ca
  HAVE_CERT="true"
elif [[ "$TLS_PROVIDER" == "letsencrypt" && -f "$LE_CERTIFICATE" && -f "$LE_PRIVATE_KEY" ]]; then
  if certificate_covers_public_names "$LE_CERTIFICATE"; then
    write_tls_include "letsencrypt" "$LE_CERTIFICATE" "$LE_PRIVATE_KEY"
    HAVE_CERT="true"
  else
    warn "The existing certificate does not cover every configured public hostname; it will be expanded."
  fi
elif [[ -z "$TLS_PROVIDER" && -f "$TLS_INCLUDE" ]]; then
  existing_certificate="$(awk '$1 == "ssl_certificate" { gsub(/;/, "", $2); print $2; exit }' "$TLS_INCLUDE")"
  if certificate_covers_public_names "$existing_certificate"; then
    HAVE_CERT="true"
  else
    warn "The preserved certificate does not cover every configured public hostname; HTTPS remains disabled until it does."
  fi
fi

if [[ "$HAVE_CERT" == "true" ]]; then
  write_hardened_site
else
  write_http_only_site
fi

ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/readypackets
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
# This must happen before certbot runs: the ACME challenge is fetched over
# inbound HTTP, so with port 80 closed the very first install can never
# validate. `ufw reset` is deliberately not used -- it would discard rules an
# operator added for their own reasons, and on a remote host a reset that
# reorders SSH is a good way to lock yourself out.
log "Configuring the firewall"
ufw --force enable >/dev/null 2>&1 || true
ufw default deny incoming  >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
# Port 3000 is never opened: the application is reachable only through nginx.

if [[ "$TLS_PROVIDER" == "letsencrypt" && "$HAVE_CERT" == "false" ]]; then
  log "Requesting a TLS certificate for ${DOMAIN}"
  apt-get install -y --no-install-recommends certbot >/dev/null

  # First use the normal webroot route with a test token served through the
  # generated HTTP-only nginx site. If a host-level hidden-path guard, stale
  # configuration, or proxy behavior blocks that path, use Certbot standalone
  # mode as a bounded fallback rather than leaving a fresh portal HTTP-only.
  install -d -m 0755 /var/www/html/.well-known/acme-challenge
  acme_probe_name="readypackets-local-${RANDOM}${RANDOM}"
  acme_probe_value="ready-${RANDOM}${RANDOM}"
  acme_probe_file="/var/www/html/.well-known/acme-challenge/${acme_probe_name}"
  printf '%s' "$acme_probe_value" > "$acme_probe_file"
  chmod 0644 "$acme_probe_file"

  certbot_domains=(--cert-name "$DOMAIN" -d "$DOMAIN")
  for certificate_hostname in "${ALL_ROUTED_HOSTS[@]:1}"; do
    certbot_domains+=(-d "$certificate_hostname")
  done
  # Certbot requires an explicit non-interactive expansion when a prior
  # canonical-name certificate is being widened to its apex/www counterpart.
  if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
    certbot_domains+=(--expand)
  fi

  webroot_ready="true"
  acme_hostnames=("${ALL_ROUTED_HOSTS[@]}")
  for acme_hostname in "${acme_hostnames[@]}"; do
    if ! curl --fail --silent --show-error --max-time 5 \
      --resolve "${acme_hostname}:80:127.0.0.1" \
      "http://${acme_hostname}/.well-known/acme-challenge/${acme_probe_name}" \
      | cmp -s - <(printf '%s' "$acme_probe_value"); then
      webroot_ready="false"
      warn "The local ACME challenge probe was not served for ${acme_hostname}; using standalone certificate validation."
      break
    fi
  done
  rm -f "$acme_probe_file"

  certificate_issued="false"
  if [[ "$webroot_ready" == "true" ]]; then
    if certbot certonly --webroot --webroot-path /var/www/html \
         --non-interactive --agree-tos --email "$CONTACT_EMAIL" \
         "${certbot_domains[@]}"; then
      certificate_issued="true"
    else
      warn "Webroot certificate validation was rejected; retrying through the standalone responder."
    fi
  fi

  if [[ "$certificate_issued" == "false" ]]; then
    nginx_was_active="false"
    if systemctl is-active --quiet nginx; then
      nginx_was_active="true"
      systemctl stop nginx
    fi
    if certbot certonly --standalone \
         --non-interactive --agree-tos --email "$CONTACT_EMAIL" \
         "${certbot_domains[@]}"; then
      certificate_issued="true"
    fi
    # Always restore the reverse proxy, even when Certbot rejects the fallback.
    if [[ "$nginx_was_active" == "true" ]]; then
      systemctl start nginx || die "Nginx did not restart after standalone certificate validation."
    fi
  fi

  if [[ "$certificate_issued" == "true" ]]; then
    certificate_covers_public_names "$LE_CERTIFICATE" || die "The issued certificate does not cover every configured public hostname."
    write_tls_include "letsencrypt" "$LE_CERTIFICATE" "$LE_PRIVATE_KEY"
    HAVE_CERT="true"
  else
    warn "Certificate issuance failed. The site remains available over HTTP."
    warn "Check that every configured hostname resolves to this host and that any Cloudflare proxy/WAF allows HTTP-01 validation, then re-run:"
    warn "  ${BASH_SOURCE[0]} --domain ${DOMAIN} --skip-packages"
  fi
fi

if [[ "$HAVE_CERT" == "true" ]]; then
  log "Installing the hardened TLS configuration"
  write_hardened_site
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
  else
    # Never leave a broken configuration in place: nginx would keep serving the
    # old one and the operator would have no idea the new one was rejected.
    warn "The hardened configuration was rejected by nginx; reverting to HTTP-only."
    nginx -t || true
    write_http_only_site
    nginx -t && systemctl reload nginx
  fi

  # Renewal must reload nginx, or the certificate silently expires in place.
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
# Installed by the ReadyPackets installer.
systemctl reload nginx
HOOK
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
fi

# ---------------------------------------------------------------------------
# fail2ban, log rotation, backups
# ---------------------------------------------------------------------------
log "Configuring fail2ban for SSH and nginx"
cat > /etc/fail2ban/jail.d/readypackets.local <<'JAIL'
[sshd]
enabled = true
maxretry = 4
bantime = 1h

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
maxretry = 20
findtime = 10m
bantime = 1h
JAIL
systemctl enable --now fail2ban
systemctl restart fail2ban || true

install -m 0644 "${APP_DIR}/deploy/logrotate.conf" /etc/logrotate.d/readypackets

log "Installing the nightly backup timer"
install -d -m 0755 -o root -g root /usr/local/lib/readypackets
install -m 0750 "${APP_DIR}/deploy/backup.sh" /usr/local/sbin/readypackets-backup
install -m 0750 "${APP_DIR}/deploy/backup-control.sh" /usr/local/sbin/readypackets-backup-control
install -m 0750 "${APP_DIR}/deploy/recovery-history.sh" /usr/local/sbin/readypackets-recovery-history
install -m 0750 "${APP_DIR}/deploy/scoped-recovery.sh" /usr/local/sbin/readypackets-scoped-recovery
chmod 0750 "${APP_DIR}/deploy/backup-control-daemon.mjs"
chmod 0750 "${APP_DIR}/deploy/platform-update-control-daemon.mjs"
install -m 0750 "${APP_DIR}/deploy/certificate-control-daemon.mjs" /usr/local/lib/readypackets/certificate-control-daemon.mjs
install -m 0750 "${APP_DIR}/deploy/platform-upgrade-control.sh" /usr/local/sbin/readypackets-platform-update
install -m 0750 "${APP_DIR}/deploy/auto-deploy-approved.sh" /usr/local/sbin/readypackets-auto-deploy-approved
install -m 0644 "${APP_DIR}/deploy/readypackets-backup.service" /etc/systemd/system/
install -m 0644 "${APP_DIR}/deploy/readypackets-backup-control.service" /etc/systemd/system/
install -m 0644 "${APP_DIR}/deploy/readypackets-certificate-control.service" /etc/systemd/system/
install -m 0644 "${APP_DIR}/deploy/readypackets-platform-update-control.service" /etc/systemd/system/
install -m 0644 "${APP_DIR}/deploy/readypackets-backup.timer" /etc/systemd/system/
# Backups use a root-owned Unix-socket daemon with a fixed action allowlist.
# The web service has no sudo rule for backup operations; it can reach only the
# group-writable local socket and cannot pass arbitrary commands or paths.
rm -f /etc/sudoers.d/readypackets-backup-control
# Platform updates use a second root-owned Unix-socket daemon with an action
# allowlist. This preserves NoNewPrivileges=true on the customer-facing service
# and removes the service account's sudo capability entirely.
rm -f /etc/sudoers.d/readypackets-platform-update
install -d -m 0700 -o root -g root /var/backups/readypackets/platform-upgrades
install -d -m 0700 -o root -g root /var/lib/readypackets/platform-upgrades
# The set-group-ID directory lets the hardened root controller create exports
# readable only by the portal service group without a CAP_CHOWN syscall.
install -d -m 2750 -o root -g readypackets /var/backups/readypackets
install -d -m 2750 -o root -g readypackets /var/lib/readypackets/storage/admin-exports
# The portal can create a random encrypted restore upload but cannot list or read
# the root-controlled staging directory. The backup helper is the only reader.
install -d -m 0730 -o root -g readypackets /var/lib/readypackets/storage/config-restore-imports
install -d -m 0730 -o root -g readypackets /var/lib/readypackets/storage/backup-restore-imports
systemctl daemon-reload
# `enable --now` starts an inactive controller but does not restart an already
# running process. Always restart these fixed-action root controllers after their
# code or unit files are replaced so an in-place upgrade never retains a stale
# allowlist or helper implementation in memory.
systemctl enable readypackets-backup-control.service
systemctl enable readypackets-certificate-control.service
systemctl enable readypackets-platform-update-control.service
systemctl restart readypackets-backup-control.service
systemctl restart readypackets-certificate-control.service
systemctl restart readypackets-platform-update-control.service
systemctl enable --now readypackets-backup.timer

# Run one backup now. An untested backup is not a backup, and discovering that
# the timer never worked is something that should happen during installation
# rather than during a restore.
log "Verifying the backup path with a first run"
if systemctl start readypackets-backup.service; then
  log "Backup completed: $(ls -1 /var/backups/readypackets/ 2>/dev/null | tail -1)"
else
  warn "The first backup failed. Investigate with: journalctl -u readypackets-backup -n 40"
fi

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------
log "Verifying the service"
sleep 3
if ! systemctl is-active --quiet readypackets; then
  journalctl -u readypackets -n 40 --no-pager || true
  die "The service failed to start. The journal output above shows why."
fi

if curl -fsS -H "Host: ${DOMAIN}" http://127.0.0.1:3000/api/health/ready >/dev/null; then
  log "Readiness probe succeeded."
else
  warn "The readiness probe failed. Check: journalctl -u readypackets -n 50"
fi

cat <<SUMMARY

$(printf '\033[1;32m')ReadyPackets Portal is installed.$(printf '\033[0m')

  Site            https://${DOMAIN}
  Service         systemctl status readypackets
  Logs            journalctl -u readypackets -f
  Configuration   ${ENV_FILE}
  Storage         ${DATA_DIR}/storage
  Backups         /var/backups/readypackets (nightly)

Next steps:

  1. Create the first administrator:
       sudo runuser -u ${APP_USER} -- sh -c 'set -a; . "\$1"; set +a; shift; exec "\$@"' \\
         sh ${ENV_FILE} node ${APP_DIR}/dist/create-admin.js --email you@${DOMAIN#portal.}

  2. Add SMTP credentials to ${ENV_FILE}, then:
       sudo systemctl restart readypackets

  3. Sign in, enrol multi-factor authentication immediately, and review
     Admin -> Security.

SUMMARY
