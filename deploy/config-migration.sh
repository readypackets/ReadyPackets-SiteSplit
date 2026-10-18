#!/usr/bin/env bash
# ReadyPackets encrypted configuration migration tool.
# Exports settings, integration configuration, and application secrets. It
# intentionally excludes customer data, orders, files, sessions, and logs.
#
# Export: sudo bash deploy/config-migration.sh export --output /secure/location/config.rpconfig
# Import: sudo bash deploy/config-migration.sh import --input /secure/location/config.rpconfig --replace-config --apply-env

set -Eeuo pipefail
umask 077

APP_ROOT="${RP_APP_ROOT:-/opt/readypackets}"
ENV_FILE="${RP_ENV_FILE:-/etc/readypackets/portal.env}"
DB_NAME="${RP_DB_NAME:-readypackets}"
MYSQL_BIN="${MYSQL_BIN:-mysql}"
MYSQLDUMP_BIN="${MYSQLDUMP_BIN:-mysqldump}"
OUTPUT_DIR="${RP_CONFIG_BACKUP_DIR:-/var/backups/readypackets/config-migrations}"
FORMAT_VERSION="1"
PBKDF2_ITERATIONS="600000"

# Only platform configuration. Operational, customer, order, file, session, and
# log tables are deliberately excluded from configuration migrations. Secret
# site-settings are exported only with --include-secrets. The ordinary browser
# export remains secret-free; the sole administrator-facing exception is the
# explicit private GitHub vault action, which requires a new recovery passphrase
# and typed confirmation for each secret-inclusive encrypted publication.
CONFIG_TABLES=(
  feature_flags rate_limit_configs registration_fields
  email_templates email_automations webhook_endpoints phase_kickoff_configs
  saml_configs outbound_connections subscription_plans products product_addons
  home_content_blocks policy_documents policy_versions
)
SECRET_ENV_PATTERN='^(DATABASE_URL|SESSION_SECRET|DATA_ENCRYPTION_KEY|EMAIL_INDEX_KEY|SMTP_PASS|S3_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|GRAPH_CLIENT_SECRET|SAML_IDP_CERT)='


log() { printf '[config-migration] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
cleanup_paths=()
cleanup() { for path in "${cleanup_paths[@]:-}"; do [[ -n "$path" && -e "$path" ]] && rm -rf -- "$path"; done; }
trap cleanup EXIT

usage() {
  cat <<'USAGE'
ReadyPackets encrypted configuration migration

Commands:
  export   Create a passphrase-encrypted .rpconfig bundle.
  import   Verify and restore an encrypted bundle after a new install.
  inspect  Verify an encrypted bundle and display its non-secret manifest.

Examples:
  sudo bash deploy/config-migration.sh export --output /secure/config.rpconfig
  sudo bash deploy/config-migration.sh import --input /secure/config.rpconfig --replace-config

Optional: --passphrase-file /root/readypackets-migration.pass (must be mode 600)
Safety:  --replace-config is mandatory for import.
         --include-secrets --apply-env together enable break-glass secret
         restoration. The unified installer can invoke this import only after it
         verifies a private GitHub vault archive and obtains the operator's
         recovery passphrase; target database credentials remain local.
         --dry-run validates a bundle without changing the system.
         --force skips the explicit import confirmation for controlled automation.

Default bundles deliberately omit application keys, database credentials, and
integration secrets—including Microsoft Graph/SharePoint client secrets. The
private GitHub vault is an explicit exception: it creates a passphrase-encrypted
secret-inclusive bundle and writes only ciphertext plus a non-secret manifest to
a configured private repository. The unified installer can restore a verified
latest vault bundle to a newly provisioned server while retaining that server's
database credentials. Store recovery passphrases offline and never
email, commit, or place them in a shared directory.
USAGE
}

require_root() { [[ "$(id -u)" -eq 0 ]] || die "Run as root via sudo."; }
require_commands() {
  for command in openssl tar sha256sum "$MYSQL_BIN" "$MYSQLDUMP_BIN"; do
    command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"
  done
}

read_passphrase() {
  local passphrase_file="$1"
  if [[ -n "$passphrase_file" ]]; then
    [[ -f "$passphrase_file" ]] || die "Passphrase file not found: $passphrase_file"
    local mode
    mode="$(stat -c '%a' "$passphrase_file")"
    [[ "$mode" =~ ^[67]00$ ]] || die "Passphrase file must be owner-only (mode 600 or 700)."
    PASSPHRASE="$(head -n 1 "$passphrase_file" | tr -d '\r\n')"
  else
    read -r -s -p "Migration bundle passphrase: " PASSPHRASE
    printf '\n' >&2
    [[ -n "$PASSPHRASE" ]] || die "Passphrase must not be empty."
    if [[ "$ACTION" == "export" ]]; then
      local confirmation
      read -r -s -p "Confirm passphrase: " confirmation
      printf '\n' >&2
      [[ "$PASSPHRASE" == "$confirmation" ]] || die "Passphrases did not match."
    fi
  fi
  [[ "${#PASSPHRASE}" -ge 16 ]] || die "Use a passphrase of at least 16 characters."
}

# Derive independent encryption and integrity keys from the operator passphrase.
derive_key() {
  local length="$1" salt="$2" label="$3" labelled
  labelled="${PASSPHRASE}:${label}"
  openssl kdf -keylen "$length" \
    -kdfopt digest:SHA512 \
    -kdfopt "hexsalt:${salt}" \
    -kdfopt "iter:${PBKDF2_ITERATIONS}" \
    -kdfopt "pass:${labelled}" PBKDF2 2>/dev/null | tr -d ':\n'
}

existing_tables() {
  local table
  for table in "${CONFIG_TABLES[@]}"; do
    if "$MYSQL_BIN" -N -e "SELECT 1 FROM information_schema.tables WHERE table_schema='${DB_NAME}' AND table_name='${table}' LIMIT 1" 2>/dev/null | grep -q 1; then
      printf '%s\n' "$table"
    fi
  done
}

# Configuration bundles must restore application keys and integration secrets,
# but a fresh target has its own provisioned database instance, credentials, and
# explicit hostname/alias routing. Retaining those target-bound values prevents
# an import from pointing to the old database or accepting the old portal hosts.
preserve_target_database_connection() {
  local source="$1" target="$2" key line
  [[ -f "$source" ]] || return 0
  for key in DATABASE_URL DB_NAME DB_USER DB_PASSWORD MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD MYSQL_ROOT_PASSWORD APP_URL PUBLIC_SITE_URL ALLOWED_ORIGINS PORTAL_ALIASES; do
    line="$(grep -E "^${key}=" "$source" | tail -n 1 || true)"
    [[ -n "$line" ]] || continue
    sed -i -E "/^${key}=.*/d" "$target"
    printf '%s\n' "$line" >> "$target"
  done
}

make_manifest() {
  local destination="$1" version json_tables table
  shift
  version="$(cd "$APP_ROOT" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
  json_tables=""
  for table in "$@"; do json_tables+="\"${table}\","; done
  json_tables="${json_tables%,}"
  cat > "$destination" <<EOF
{
  "format": "readypackets-config-migration",
  "formatVersion": ${FORMAT_VERSION},
  "createdAt": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "applicationVersion": "${version}",
  "contents": {
    "applicationEnvironment": true,
    "databaseConfiguration": true,
    "customerData": false,
    "orders": false,
    "uploadedFiles": false,
    "sessions": false,
    "logs": false
  },
  "tables": [${json_tables}]
}
EOF
}

export_bundle() {
  [[ -f "$ENV_FILE" ]] || die "Environment file not found: $ENV_FILE"
  mkdir -p "$OUTPUT_DIR"
  chmod 700 "$OUTPUT_DIR"

  local staging payload envelope salt iv enc_key mac_key mac output
  staging="$(mktemp -d)"; cleanup_paths+=("$staging")
  payload="$(mktemp)"; cleanup_paths+=("$payload")
  envelope="$(mktemp -d)"; cleanup_paths+=("$envelope")
  mapfile -t EXPORT_TABLES < <(existing_tables)
  [[ "${#EXPORT_TABLES[@]}" -gt 0 ]] || die "No known configuration tables found in ${DB_NAME}."

  log "Exporting ${#EXPORT_TABLES[@]} non-secret configuration tables."
  if [[ "$INCLUDE_SECRETS" == "true" ]]; then
    cp --preserve=mode "$ENV_FILE" "$staging/portal.env"
  else
    grep -Ev "$SECRET_ENV_PATTERN" "$ENV_FILE" > "$staging/portal.env"
  fi
  chmod 600 "$staging/portal.env"
  make_manifest "$staging/manifest.json" "site_settings" "${EXPORT_TABLES[@]}"
  "$MYSQLDUMP_BIN" --single-transaction --skip-comments --skip-triggers --no-create-info --complete-insert --replace "$DB_NAME" "${EXPORT_TABLES[@]}" > "$staging/configuration.sql"
  if [[ "$INCLUDE_SECRETS" == "true" ]]; then
    "$MYSQLDUMP_BIN" --single-transaction --skip-comments --skip-triggers --no-create-info --complete-insert --replace "$DB_NAME" site_settings >> "$staging/configuration.sql"
  else
    "$MYSQLDUMP_BIN" --single-transaction --skip-comments --skip-triggers --no-create-info --complete-insert --replace --skip-extended-insert --where="is_secret = 0" "$DB_NAME" site_settings >> "$staging/configuration.sql"
  fi
  chmod 600 "$staging/configuration.sql"
  (cd "$staging" && sha256sum portal.env configuration.sql manifest.json > contents.sha256)

  tar -C "$staging" -czf "$payload" manifest.json contents.sha256 portal.env configuration.sql
  salt="$(openssl rand -hex 16)"; iv="$(openssl rand -hex 16)"
  enc_key="$(derive_key 32 "$salt" encryption)"; mac_key="$(derive_key 32 "$salt" integrity)"
  [[ "${#enc_key}" -eq 64 && "${#mac_key}" -eq 64 ]] || die "Could not derive encryption keys."
  openssl enc -aes-256-cbc -K "$enc_key" -iv "$iv" -nosalt -in "$payload" -out "$envelope/payload.enc"
  mac="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:${mac_key}" "$envelope/payload.enc" | awk '{print $NF}')"
  printf '%s\n' "$mac" > "$envelope/payload.hmac"
  cat > "$envelope/envelope.json" <<EOF
{
  "format": "readypackets-config-migration-envelope",
  "formatVersion": ${FORMAT_VERSION},
  "cipher": "AES-256-CBC",
  "kdf": "PBKDF2-HMAC-SHA512",
  "iterations": ${PBKDF2_ITERATIONS},
  "saltHex": "${salt}",
  "ivHex": "${iv}",
  "integrity": "HMAC-SHA256"
}
EOF
  output="${OUTPUT:-${OUTPUT_DIR}/readypackets-config-$(date -u +'%Y%m%dT%H%M%SZ').rpconfig}"
  mkdir -p "$(dirname "$output")"
  tar -C "$envelope" -czf "$output" envelope.json payload.hmac payload.enc
  chmod 600 "$output"
  log "Encrypted migration bundle created: $output"
  log "SHA-256: $(sha256sum "$output" | awk '{print $1}')"
  log "Store the file and passphrase separately; this bundle contains application secrets."
}

open_bundle() {
  local input="$1" envelope extracted salt iv enc_key mac_key expected actual
  [[ -f "$input" ]] || die "Bundle not found: $input"
  envelope="$(mktemp -d)"; cleanup_paths+=("$envelope")
  # The backup-control daemon intentionally drops ownership-changing capabilities.
  # Bundle validation needs only content, not archived root ownership metadata.
  tar --no-same-owner -C "$envelope" -xzf "$input"
  [[ -f "$envelope/envelope.json" && -f "$envelope/payload.enc" && -f "$envelope/payload.hmac" ]] || die "Invalid migration bundle envelope."
  salt="$(grep -oE '"saltHex": "[0-9a-f]+"' "$envelope/envelope.json" | sed -E 's/.*"([0-9a-f]+)"/\1/')"
  iv="$(grep -oE '"ivHex": "[0-9a-f]+"' "$envelope/envelope.json" | sed -E 's/.*"([0-9a-f]+)"/\1/')"
  [[ "${#salt}" -eq 32 && "${#iv}" -eq 32 ]] || die "Invalid envelope salt or IV."
  enc_key="$(derive_key 32 "$salt" encryption)"; mac_key="$(derive_key 32 "$salt" integrity)"
  expected="$(tr -d '\r\n ' < "$envelope/payload.hmac")"
  actual="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:${mac_key}" "$envelope/payload.enc" | awk '{print $NF}')"
  [[ "$actual" == "$expected" ]] || die "Bundle integrity verification failed. Wrong passphrase or modified file."
  extracted="$(mktemp -d)"; cleanup_paths+=("$extracted")
  openssl enc -d -aes-256-cbc -K "$enc_key" -iv "$iv" -nosalt -in "$envelope/payload.enc" | tar --no-same-owner -C "$extracted" -xzf -
  [[ -f "$extracted/manifest.json" && -f "$extracted/portal.env" && -f "$extracted/configuration.sql" && -f "$extracted/contents.sha256" ]] || die "Decrypted bundle contents are incomplete."
  (cd "$extracted" && sha256sum -c contents.sha256) >/dev/null || die "Decrypted contents checksum failed."
  EXTRACTED_DIR="$extracted"
}

inspect_bundle() { open_bundle "$INPUT"; if [[ "$MANIFEST_ONLY" == "true" ]]; then cat "$EXTRACTED_DIR/manifest.json"; else log "Bundle integrity verified. Non-secret manifest:"; cat "$EXTRACTED_DIR/manifest.json"; fi; }

import_bundle() {
  [[ "$REPLACE_CONFIG" == "true" ]] || die "Import requires --replace-config."
  if [[ "$INCLUDE_SECRETS" == "true" && "$APPLY_ENV" != "true" ]]; then
    die "Break-glass secret import requires --include-secrets --apply-env."
  fi
  open_bundle "$INPUT"
  log "Bundle verified. Secret-free imports preserve the target server environment and omit secret settings."
  if [[ "$DRY_RUN" == "true" ]]; then
    log "Dry run only: no files, database settings, or service state were changed."
    cat "$EXTRACTED_DIR/manifest.json"
    return
  fi
  if [[ "$FORCE" != "true" ]]; then
    printf 'Type IMPORT READY PACKETS CONFIG to continue: ' >&2
    local confirmation
    read -r confirmation
    [[ "$confirmation" == "IMPORT READY PACKETS CONFIG" ]] || die "Import cancelled."
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  local now previous_env
  now="$(date -u +'%Y%m%dT%H%M%SZ')"
  if [[ -f "$ENV_FILE" ]]; then
    previous_env="${ENV_FILE}.pre-import-${now}"
    cp --preserve=mode "$ENV_FILE" "$previous_env"
    chmod 600 "$previous_env"
    log "Saved current environment backup: $previous_env"
  fi
  if [[ "$INCLUDE_SECRETS" == "true" ]]; then
    # Environment is restored first because encrypted DB rows depend on the original key.
    # The target database was freshly provisioned by the installer, so retain its
    # connection credentials rather than point it at the source host database.
    cp "$EXTRACTED_DIR/portal.env" "$ENV_FILE"
    [[ -n "${previous_env:-}" ]] && preserve_target_database_connection "$previous_env" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
    if getent group readypackets >/dev/null 2>&1; then chown root:readypackets "$ENV_FILE"; else chown root:root "$ENV_FILE"; fi
  fi
  "$MYSQL_BIN" "$DB_NAME" < "$EXTRACTED_DIR/configuration.sql"
  if [[ "$INCLUDE_SECRETS" == "true" ]]; then
    log "Configuration tables and protected environment restored under break-glass mode; target database credentials and portal hostname/alias routing were retained."
  else
    log "Non-secret configuration restored; target environment and secret settings were preserved."
  fi
  log "Review target-specific public URLs and network destinations before use."
  if [[ "$NO_RESTART" == "true" ]]; then
    log "readypackets restart deferred to the protected caller."
  elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files readypackets.service >/dev/null 2>&1; then
    systemctl restart readypackets
    log "readypackets service restarted."
  fi
}

ACTION="${1:-}"; shift || true
OUTPUT=""; INPUT=""; PASSPHRASE_FILE=""; REPLACE_CONFIG="false"; APPLY_ENV="false"; DRY_RUN="false"; FORCE="false"; INCLUDE_SECRETS="false"; NO_RESTART="false"; MANIFEST_ONLY="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --input) INPUT="${2:-}"; shift 2 ;;
    --passphrase-file) PASSPHRASE_FILE="${2:-}"; shift 2 ;;
    --replace-config) REPLACE_CONFIG="true"; shift ;;
    --apply-env) APPLY_ENV="true"; shift ;;
    --dry-run) DRY_RUN="true"; shift ;;
    --force) FORCE="true"; shift ;;
    --include-secrets) INCLUDE_SECRETS="true"; shift ;;
    --no-restart) NO_RESTART="true"; shift ;;
    --manifest-only) MANIFEST_ONLY="true"; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
require_root; require_commands
case "$ACTION" in
  export) [[ -n "$OUTPUT" ]] || OUTPUT="${OUTPUT_DIR}/readypackets-config-$(date -u +'%Y%m%dT%H%M%SZ').rpconfig"; read_passphrase "$PASSPHRASE_FILE"; export_bundle ;;
  import) [[ -n "$INPUT" ]] || die "Import requires --input PATH."; read_passphrase "$PASSPHRASE_FILE"; import_bundle ;;
  inspect) [[ -n "$INPUT" ]] || die "Inspect requires --input PATH."; read_passphrase "$PASSPHRASE_FILE"; inspect_bundle ;;
  *) usage; exit 1 ;;
esac
