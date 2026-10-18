#!/usr/bin/env bash
# ReadyPackets unified installer: native VPS, Docker, or Docker bootstrap.
set -Eeuo pipefail
umask 077

MODE=""
DOMAIN=""
PUBLIC_DOMAIN=""
PORTAL_ALIASES=()
EMAIL=""
PROJECT_DIR=""
TLS_PROVIDER=""
CLOUDFLARE_ORIGIN_CERT=""
CLOUDFLARE_ORIGIN_KEY=""
CLOUDFLARE_ORIGIN_ROOT=""
SITE_NAME=""
GITHUB_CONFIG_REPOSITORY=""
GITHUB_CONFIG_BRANCH="main"
GITHUB_CONFIG_FOLDER="readypackets-platform-config"
GITHUB_CONFIG_TOKEN_FILE=""
GITHUB_CONFIG_PASSPHRASE_FILE=""
TEMP_GITHUB_SECRET_FILES=()
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  # Interactive: prompts for native VPS, existing Docker, or Docker bootstrap.
  sudo bash deploy/unified-install.sh --domain portal.example.com --portal-alias my.example.com --email ops@example.com

  # Non-interactive / automation: explicitly select the install mode.
  sudo bash deploy/unified-install.sh --mode native --domain portal.example.com --email ops@example.com --tls-provider letsencrypt
  sudo bash deploy/unified-install.sh --mode native --domain portal.example.com --tls-provider cloudflare-origin --cloudflare-origin-cert /secure/origin.pem --cloudflare-origin-key /secure/origin-key.pem
  sudo bash deploy/unified-install.sh --mode docker --domain portal.example.com --email ops@example.com --tls-provider letsencrypt [--project-dir /srv/readypackets]

TLS options:
  --tls-provider letsencrypt|cloudflare-origin
  --cloudflare-origin-cert <PEM path>
  --cloudflare-origin-key <PEM path>
  --cloudflare-origin-root <PEM path>  Optional Cloudflare Origin CA root/chain
  --portal-alias <host>  Explicit portal alias; repeat up to five times. Native only; aliases redirect to --domain.
  --no-tls  Configure HTTP only / preserve certificate configuration.
  --site-name <name>  Website name used in public browser titles.
  --github-config-repository <owner/repository>  Restore latest encrypted configuration vault.
  --github-config-branch <branch> --github-config-folder <folder>
  --github-config-token-file <root-only file> --github-config-passphrase-file <root-only file>

Modes:
  native             Installs directly on the VPS using systemd, nginx, and MySQL.
  docker             Uses an existing Docker Engine and Docker Compose installation.
  docker-bootstrap   Installs Docker Engine packages first, then performs Docker deployment.

The native path remains the supported choice for a small VPS that uses the full
backup, upgrade, and rollback control helpers. Docker deployment creates an
isolated app/database stack behind host nginx with TLS and does not expose MySQL.
USAGE
}
fail() { printf '[unified-install] %s\n' "$*" >&2; exit 1; }
log() { printf '[unified-install] %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --portal-alias) PORTAL_ALIASES+=("${2:-}"); shift 2 ;;
    --public-domain) PUBLIC_DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --tls-provider) TLS_PROVIDER="${2:-}"; shift 2 ;;
    --cloudflare-origin-cert) CLOUDFLARE_ORIGIN_CERT="${2:-}"; shift 2 ;;
    --cloudflare-origin-key) CLOUDFLARE_ORIGIN_KEY="${2:-}"; shift 2 ;;
    --cloudflare-origin-root) CLOUDFLARE_ORIGIN_ROOT="${2:-}"; shift 2 ;;
    --cloudflare-api-token-file) CLOUDFLARE_API_TOKEN_FILE="${2:-}"; shift 2 ;;
    --cloudflare-origin-validity) CLOUDFLARE_ORIGIN_VALIDITY="${2:-5475}"; shift 2 ;;
    --no-tls) TLS_PROVIDER="none"; shift ;;
    --site-name) SITE_NAME="${2:-}"; shift 2 ;;
    --github-config-repository) GITHUB_CONFIG_REPOSITORY="${2:-}"; shift 2 ;;
    --github-config-branch) GITHUB_CONFIG_BRANCH="${2:-}"; shift 2 ;;
    --github-config-folder) GITHUB_CONFIG_FOLDER="${2:-}"; shift 2 ;;
    --github-config-token-file) GITHUB_CONFIG_TOKEN_FILE="${2:-}"; shift 2 ;;
    --github-config-passphrase-file) GITHUB_CONFIG_PASSPHRASE_FILE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run this installer as root."
cleanup_installer_secrets() { for file in "${TEMP_GITHUB_SECRET_FILES[@]:-}"; do rm -f -- "$file"; done; }
trap cleanup_installer_secrets EXIT
if [[ -z "$SITE_NAME" && -t 0 ]]; then
  read -r -p "Website name [ReadyPackets]: " SITE_NAME
fi
SITE_NAME="${SITE_NAME:-ReadyPackets}"
[[ "$SITE_NAME" != *$'\n'* && ${#SITE_NAME} -le 100 ]] || fail "--site-name must be 1 to 100 characters and contain no line breaks."
if [[ -z "$GITHUB_CONFIG_REPOSITORY" && -t 0 ]]; then
  read -r -p "Restore the latest encrypted GitHub configuration vault backup? [y/N]: " restore_choice
  if [[ "${restore_choice,,}" == "y" || "${restore_choice,,}" == "yes" ]]; then
    read -r -p "Private GitHub vault repository (owner/repository): " GITHUB_CONFIG_REPOSITORY
    read -r -p "Vault branch [main]: " GITHUB_CONFIG_BRANCH; GITHUB_CONFIG_BRANCH="${GITHUB_CONFIG_BRANCH:-main}"
    read -r -p "Vault folder [readypackets-platform-config]: " GITHUB_CONFIG_FOLDER; GITHUB_CONFIG_FOLDER="${GITHUB_CONFIG_FOLDER:-readypackets-platform-config}"
    GITHUB_CONFIG_TOKEN_FILE="$(mktemp /root/readypackets-github-token.XXXXXX)"; TEMP_GITHUB_SECRET_FILES+=("$GITHUB_CONFIG_TOKEN_FILE")
    GITHUB_CONFIG_PASSPHRASE_FILE="$(mktemp /root/readypackets-github-passphrase.XXXXXX)"; TEMP_GITHUB_SECRET_FILES+=("$GITHUB_CONFIG_PASSPHRASE_FILE")
    read -r -s -p "Fine-grained GitHub token: " token; printf '\n' >&2; printf '%s\n' "$token" > "$GITHUB_CONFIG_TOKEN_FILE"; unset token
    read -r -s -p "Vault recovery passphrase: " passphrase; printf '\n' >&2; printf '%s\n' "$passphrase" > "$GITHUB_CONFIG_PASSPHRASE_FILE"; unset passphrase
    chmod 0600 "$GITHUB_CONFIG_TOKEN_FILE" "$GITHUB_CONFIG_PASSPHRASE_FILE"
  fi
fi
if [[ -n "$GITHUB_CONFIG_REPOSITORY" || -n "$GITHUB_CONFIG_TOKEN_FILE" || -n "$GITHUB_CONFIG_PASSPHRASE_FILE" ]]; then
  [[ "$GITHUB_CONFIG_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--github-config-repository must be owner/repository."
  [[ -f "$GITHUB_CONFIG_TOKEN_FILE" && -f "$GITHUB_CONFIG_PASSPHRASE_FILE" ]] || fail "GitHub configuration restore requires root-only token and passphrase files."
fi

# A human operator can omit --mode and select an installation method safely.
# Non-interactive use must supply --mode so automation never blocks on stdin.
if [[ -z "$MODE" && -t 0 ]]; then
  printf '\nReadyPackets installation method:\n'
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
[[ "$MODE" == "native" || "$MODE" == "docker" || "$MODE" == "docker-bootstrap" ]] || fail "Choose --mode native, docker, or docker-bootstrap."
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || fail "A valid --domain is required."
[[ "${DOMAIN,,}" != "readypackets.com" && "${DOMAIN,,}" != "www.readypackets.com" ]] || fail "readypackets.com and www.readypackets.com are reserved for the independently hosted ReadyPackets website. Use a dedicated portal hostname."
[[ -z "$PUBLIC_DOMAIN" || "$PUBLIC_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || fail "--public-domain must be a valid hostname."
[[ -z "$PUBLIC_DOMAIN" || "$PUBLIC_DOMAIN" != "$DOMAIN" ]] || fail "--public-domain must differ from --domain."
(( ${#PORTAL_ALIASES[@]} <= 5 )) || fail "At most five --portal-alias values are permitted."
for portal_alias in "${PORTAL_ALIASES[@]}"; do
  [[ "$portal_alias" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || fail "--portal-alias must be a valid hostname."
  [[ "${portal_alias,,}" != "readypackets.com" && "${portal_alias,,}" != "www.readypackets.com" ]] || fail "readypackets.com and www.readypackets.com are reserved for the independently hosted ReadyPackets website."
done
if [[ "${#PORTAL_ALIASES[@]}" -gt 0 && "$MODE" != "native" ]]; then
  fail "--portal-alias is currently supported only by the native VPS installer."
fi
if [[ -z "$TLS_PROVIDER" && -t 0 ]]; then
  printf '\nTLS certificate provider:\n  1) Let\x27s Encrypt\n  2) Cloudflare Origin CA\n  3) HTTP only / configure later\n'
  read -r -p "Choose [1-3] (default 1): " tls_choice
  case "${tls_choice:-1}" in 1) TLS_PROVIDER="letsencrypt" ;; 2) TLS_PROVIDER="cloudflare-origin" ;; 3) TLS_PROVIDER="none" ;; *) fail "Choose 1, 2, or 3." ;; esac
fi
TLS_PROVIDER="${TLS_PROVIDER:-letsencrypt}"
[[ "$TLS_PROVIDER" == "letsencrypt" || "$TLS_PROVIDER" == "cloudflare-origin" || "$TLS_PROVIDER" == "cloudflare-origin-ca" || "$TLS_PROVIDER" == "none" ]] || fail "--tls-provider must be letsencrypt, cloudflare-origin, or cloudflare-origin-ca."
if [[ "$TLS_PROVIDER" == "letsencrypt" ]]; then [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "A valid --email is required for Let's Encrypt."; fi
if [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then
  [[ -f "$CLOUDFLARE_ORIGIN_CERT" && -f "$CLOUDFLARE_ORIGIN_KEY" ]] || fail "Cloudflare Origin CA requires --cloudflare-origin-cert and --cloudflare-origin-key files."
  [[ -z "$CLOUDFLARE_ORIGIN_ROOT" || -f "$CLOUDFLARE_ORIGIN_ROOT" ]] || fail "Cloudflare Origin CA root file was not found."
elif [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
  [[ "$MODE" == "native" ]] || fail "Automated Cloudflare Origin CA issuance is currently supported only for native VPS installations."
  [[ -f "$CLOUDFLARE_API_TOKEN_FILE" ]] || fail "Automated Cloudflare Origin CA needs --cloudflare-api-token-file."
  [[ "$(stat -c '%U:%a' "$CLOUDFLARE_API_TOKEN_FILE")" == "root:600" ]] || fail "Cloudflare API token file must be root-owned mode 0600."
  [[ "$CLOUDFLARE_ORIGIN_VALIDITY" =~ ^(7|30|90|365|730|1095|5475)$ ]] || fail "Invalid Cloudflare Origin CA validity."
fi

if [[ "$MODE" == "native" ]]; then
  args=(--domain "$DOMAIN")
  for portal_alias in "${PORTAL_ALIASES[@]}"; do args+=(--portal-alias "$portal_alias"); done
  [[ -n "$PUBLIC_DOMAIN" ]] && args+=(--public-domain "$PUBLIC_DOMAIN")
  [[ -n "$EMAIL" ]] && args+=(--email "$EMAIL")
  [[ "$TLS_PROVIDER" != "none" ]] && args+=(--tls-provider "$TLS_PROVIDER")
  [[ -n "$CLOUDFLARE_ORIGIN_CERT" ]] && args+=(--cloudflare-origin-cert "$CLOUDFLARE_ORIGIN_CERT")
  [[ -n "$CLOUDFLARE_ORIGIN_KEY" ]] && args+=(--cloudflare-origin-key "$CLOUDFLARE_ORIGIN_KEY")
  [[ -n "$CLOUDFLARE_ORIGIN_ROOT" ]] && args+=(--cloudflare-origin-root "$CLOUDFLARE_ORIGIN_ROOT")
  [[ -n "${CLOUDFLARE_API_TOKEN_FILE:-}" ]] && args+=(--cloudflare-api-token-file "$CLOUDFLARE_API_TOKEN_FILE" --cloudflare-origin-validity "${CLOUDFLARE_ORIGIN_VALIDITY:-5475}")
  args+=(--site-name "$SITE_NAME")
  if [[ -n "$GITHUB_CONFIG_REPOSITORY" ]]; then
    args+=(--github-config-repository "$GITHUB_CONFIG_REPOSITORY" --github-config-branch "$GITHUB_CONFIG_BRANCH" --github-config-folder "$GITHUB_CONFIG_FOLDER" --github-config-token-file "$GITHUB_CONFIG_TOKEN_FILE" --github-config-passphrase-file "$GITHUB_CONFIG_PASSPHRASE_FILE")
  fi
  bash "$REPO_ROOT/deploy/install.sh" "${args[@]}"
  exit 0
fi

PROJECT_DIR="${PROJECT_DIR:-$REPO_ROOT}"
[[ -f "$PROJECT_DIR/docker-compose.yml" && -f "$PROJECT_DIR/.env.example" ]] || fail "Docker deployment requires a ReadyPackets project directory with docker-compose.yml and .env.example."

if [[ "$MODE" == "docker-bootstrap" ]]; then
  log "Installing Docker Engine and Compose plugin."
  apt-get update -qq
  apt-get install -y --no-install-recommends docker.io docker-compose-plugin
  systemctl enable --now docker
fi
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Use --mode docker-bootstrap or install Docker first."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."

ENV_FILE="$PROJECT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating initial Docker environment file."
  session_secret="$(openssl rand -base64 48 | tr -d '\n=')"
  data_key="$(openssl rand -hex 32)"
  index_key="$(openssl rand -hex 32)"
  mysql_password="$(openssl rand -base64 32 | tr -d '\n=/+' | cut -c1-32)"
  mysql_root_password="$(openssl rand -base64 40 | tr -d '\n=/+' | cut -c1-40)"
  cat > "$ENV_FILE" <<ENV
APP_URL=https://${DOMAIN}
PUBLIC_SITE_URL=https://${PUBLIC_DOMAIN:-$DOMAIN}
ALLOWED_ORIGINS=https://${DOMAIN},https://${PUBLIC_DOMAIN:-$DOMAIN}
HEALTHCHECK_HOST=${DOMAIN}
MYSQL_DATABASE=readypackets
MYSQL_USER=readypackets
MYSQL_PASSWORD=${mysql_password}
MYSQL_ROOT_PASSWORD=${mysql_root_password}
SESSION_SECRET=${session_secret}
DATA_ENCRYPTION_KEY=${data_key}
EMAIL_INDEX_KEY=${index_key}
SITE_NAME=$(printf '%q' "$SITE_NAME")
TRUST_PROXY_HOPS=1
BEHIND_CLOUDFLARE=false
ENV
  chmod 0600 "$ENV_FILE"
  log "Created $ENV_FILE with generated secrets. Store an encrypted offline copy before continuing production use."
fi
# The explicit installer website name is the local public-title override and is
# retained independently from any optional imported configuration bundle.
sed -i -E '/^SITE_NAME=.*/d' "$ENV_FILE"
printf 'SITE_NAME=%q\n' "$SITE_NAME" >> "$ENV_FILE"
chmod 0600 "$ENV_FILE"

log "Building and starting Docker services."
(cd "$PROJECT_DIR" && docker compose up --build -d)
log "Running schema migrations and base seed inside the application container."
(cd "$PROJECT_DIR" && docker compose exec -T app node dist/migrate.js && docker compose exec -T app node dist/seed.js)

if [[ -n "$GITHUB_CONFIG_REPOSITORY" ]]; then
  log "Downloading the latest encrypted configuration vault bundle from private GitHub."
  vault_bundle="/root/readypackets-github-vault.rpconfig"
  bash "$PROJECT_DIR/deploy/github-config-vault-restore.sh" \
    --repository "$GITHUB_CONFIG_REPOSITORY" --branch "$GITHUB_CONFIG_BRANCH" --folder "$GITHUB_CONFIG_FOLDER" \
    --token-file "$GITHUB_CONFIG_TOKEN_FILE" --output "$vault_bundle"
  adapter_dir="$(mktemp -d /root/readypackets-config-db.XXXXXX)"; TEMP_GITHUB_SECRET_FILES+=("$adapter_dir")
  cat > "$adapter_dir/mysql" <<EOF
#!/bin/sh
exec docker compose --project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" exec -T db mysql -uroot -p"\$MYSQL_ROOT_PASSWORD" "\$@"
EOF
  cat > "$adapter_dir/mysqldump" <<EOF
#!/bin/sh
exec docker compose --project-directory "$PROJECT_DIR" --env-file "$PROJECT_DIR/.env" exec -T db mysqldump -uroot -p"\$MYSQL_ROOT_PASSWORD" "\$@"
EOF
  chmod 0700 "$adapter_dir/mysql" "$adapter_dir/mysqldump"
  set -a; source "$PROJECT_DIR/.env"; set +a
  RP_APP_ROOT="$PROJECT_DIR" RP_ENV_FILE="$PROJECT_DIR/.env" RP_DB_NAME="${MYSQL_DATABASE:-readypackets}" \
    MYSQL_BIN="$adapter_dir/mysql" MYSQLDUMP_BIN="$adapter_dir/mysqldump" \
    bash "$PROJECT_DIR/deploy/config-migration.sh" import --input "$vault_bundle" \
      --passphrase-file "$GITHUB_CONFIG_PASSPHRASE_FILE" --replace-config --include-secrets --apply-env --force
  rm -f -- "$vault_bundle"; rm -rf -- "$adapter_dir"
  sed -i -E '/^SITE_NAME=.*/d' "$PROJECT_DIR/.env"
  printf 'SITE_NAME=%q\n' "$SITE_NAME" >> "$PROJECT_DIR/.env"
  chmod 0600 "$PROJECT_DIR/.env"
  (cd "$PROJECT_DIR" && docker compose up -d --force-recreate app)
fi

log "Installing host nginx reverse proxy for loopback-only Docker application access."
apt-get update -qq
apt-get install -y --no-install-recommends nginx nginx-extras certbot
host_regex="${DOMAIN//./\\\\.}"
# Install HTTP-only ACME configuration first. The complete template references a
# certificate that does not exist until Certbot has issued it, so installing the
# TLS server block first would make nginx validation fail on a fresh host.
acme_config="$(mktemp)"
sed -n '1,50p' "$PROJECT_DIR/deploy/nginx.conf" > "$acme_config"
sed -e "s/portal\.readypackets\.com/${DOMAIN}/g" -e "s/__RP_HOST_REGEX__/${host_regex}/g" "$acme_config" > /etc/nginx/sites-available/readypackets
rm -f "$acme_config"
ln -sf /etc/nginx/sites-available/readypackets /etc/nginx/sites-enabled/readypackets
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
TLS_DIR="/etc/readypackets/tls"
TLS_INCLUDE="${TLS_DIR}/nginx-tls.conf"
CLOUDFLARE_TLS_DIR="${TLS_DIR}/cloudflare-origin"
write_tls_include() {
  local provider="$1" certificate="$2" private_key="$3"
  install -d -m 0700 -o root -g root "$TLS_DIR"
  cat > "$TLS_INCLUDE" <<TLSCONF
# Managed by the ReadyPackets unified installer. Provider: ${provider}
ssl_certificate ${certificate};
ssl_certificate_key ${private_key};
TLSCONF
  chown root:root "$TLS_INCLUDE"; chmod 0640 "$TLS_INCLUDE"
}
if [[ "$TLS_PROVIDER" == "letsencrypt" ]]; then
  certbot certonly --webroot --webroot-path /var/www/html --non-interactive --agree-tos --email "$EMAIL" -d "$DOMAIN"
  write_tls_include "letsencrypt" "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
elif [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then
  install -d -m 0700 -o root -g root "$CLOUDFLARE_TLS_DIR"
  install -m 0644 -o root -g root "$CLOUDFLARE_ORIGIN_CERT" "${CLOUDFLARE_TLS_DIR}/certificate.pem"
  install -m 0600 -o root -g root "$CLOUDFLARE_ORIGIN_KEY" "${CLOUDFLARE_TLS_DIR}/private-key.pem"
  if [[ -n "$CLOUDFLARE_ORIGIN_ROOT" ]]; then install -m 0644 -o root -g root "$CLOUDFLARE_ORIGIN_ROOT" "${CLOUDFLARE_TLS_DIR}/cloudflare-origin-ca-root.pem"; fi
  openssl x509 -in "${CLOUDFLARE_TLS_DIR}/certificate.pem" -noout -checkhost "$DOMAIN" | grep -q "does match certificate" || fail "Cloudflare Origin certificate does not match ${DOMAIN}."
  write_tls_include "cloudflare-origin" "${CLOUDFLARE_TLS_DIR}/certificate.pem" "${CLOUDFLARE_TLS_DIR}/private-key.pem"
fi
if [[ "$TLS_PROVIDER" != "none" ]]; then
  sed -e "s/portal\.readypackets\.com/${DOMAIN}/g" -e "s/__RP_HOST_REGEX__/${host_regex}/g" "$PROJECT_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/readypackets
  nginx -t && systemctl reload nginx
  curl -fsS -H "Host: $DOMAIN" -H 'X-Forwarded-Proto: https' http://127.0.0.1:3000/api/health >/dev/null
  log "Docker ReadyPackets installation is healthy at https://${DOMAIN}."
else
  log "Docker ReadyPackets installation is serving HTTP only; configure a certificate before production use."
fi
