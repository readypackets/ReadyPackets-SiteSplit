#!/usr/bin/env bash
# ReadyPackets scoped recovery archives. This root-only helper creates and restores
# passphrase-encrypted recovery artifacts for exactly one audited scope: identities
# (users, password hashes, MFA material, roles, and profile values) or orders
# (order records, workflow evidence, financial records, and referenced local files).
set -Eeuo pipefail
umask 077

APP_ROOT="${RP_APP_ROOT:-/opt/readypackets}"
ENV_FILE="${RP_ENV_FILE:-/etc/readypackets/portal.env}"
EXPORT_DIR="${RP_EXPORT_DIR:-/var/lib/readypackets/storage/admin-exports}"
IMPORT_DIR="${RP_IMPORT_DIR:-/var/lib/readypackets/storage/backup-restore-imports}"
STORAGE_ROOT="${RP_STORAGE_ROOT:-/var/lib/readypackets/storage}"
PBKDF2_ITERATIONS="600000"
FORMAT_VERSION="1"
ACTION="${1:-}"
SCOPE="${2:-}"
INPUT="${3:-}"
PASSPHRASE_FILE="${4:-}"

IDENTITY_TABLES=(users user_mfa user_backup_codes user_profile_values)
ORDER_TABLES=(
  orders order_workflows order_items order_status_history order_questions order_answers
  order_answer_history order_notes order_message_receipts order_shares intake_submissions
  intake_answers sharepoint_sync_log phase_jobs files file_versions file_access_log
  policy_acceptances mnda_acceptances invoices payments refunds order_phase_locks
  order_workflow_advances workflow_stage_runs workflow_completion_jobs
)

log() { printf '[scoped-recovery] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
require_root() { [[ "$(id -u)" -eq 0 ]] || die "This recovery helper must run as root."; }
require_commands() { for command in openssl tar sha256sum mysql mysqldump systemctl; do command -v "$command" >/dev/null 2>&1 || die "Required command not found: $command"; done; }
valid_scope() { [[ "$1" == "identities" || "$1" == "orders" ]]; }
valid_artifact_name() { [[ "$1" =~ ^readypackets-(identities|orders)-recovery-[0-9TZ-]+\.rprecovery$ ]]; }
valid_import_name() { [[ "$1" =~ ^rprecovery-import-[a-f0-9]{32}\.rprecovery$ ]]; }

cleanup_paths=()
APP_STOPPED="false"
cleanup() {
  local path
  for path in "${cleanup_paths[@]:-}"; do [[ -n "$path" && -e "$path" ]] && rm -rf -- "$path"; done
  # Never leave the production portal stopped if a scoped recovery fails.
  if [[ "$APP_STOPPED" == "true" ]]; then systemctl start readypackets >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

load_environment() {
  [[ -r "$ENV_FILE" ]] || die "Portal environment is unavailable."
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  : "${DB_NAME:?DB_NAME is required}" "${DB_USER:?DB_USER is required}" "${DB_PASSWORD:?DB_PASSWORD is required}" "${DATA_ENCRYPTION_KEY:?DATA_ENCRYPTION_KEY is required}"
}

read_passphrase() {
  [[ -f "$PASSPHRASE_FILE" ]] || die "Recovery passphrase file is unavailable."
  local mode
  mode="$(stat -c '%a' "$PASSPHRASE_FILE")"
  [[ "$mode" =~ ^[67]00$ ]] || die "Recovery passphrase file must be owner-only."
  PASSPHRASE="$(head -n 1 "$PASSPHRASE_FILE" | tr -d '\r\n')"
  [[ ${#PASSPHRASE} -ge 16 && ${#PASSPHRASE} -le 512 ]] || die "Use a recovery passphrase between 16 and 512 characters."
}

derive_key() {
  local length="$1" salt="$2" label="$3"
  openssl kdf -keylen "$length" -kdfopt digest:SHA512 -kdfopt "hexsalt:${salt}" -kdfopt "iter:${PBKDF2_ITERATIONS}" -kdfopt "pass:${PASSPHRASE}:${label}" PBKDF2 2>/dev/null | tr -d ':\n'
}

scope_tables() {
  case "$1" in
    identities) printf '%s\n' "${IDENTITY_TABLES[@]}" ;;
    orders) printf '%s\n' "${ORDER_TABLES[@]}" ;;
    *) die "Unsupported recovery scope." ;;
  esac
}

data_key_fingerprint() { printf '%s' "$DATA_ENCRYPTION_KEY" | sha256sum | awk '{print $1}'; }

make_manifest() {
  local destination="$1" scope="$2" files_count="$3" tables_json="" table
  while IFS= read -r table; do tables_json+="\"${table}\","; done < <(scope_tables "$scope")
  tables_json="${tables_json%,}"
  cat > "$destination" <<EOF
{
  "format": "readypackets-scoped-recovery",
  "formatVersion": ${FORMAT_VERSION},
  "scope": "${scope}",
  "createdAt": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "applicationVersion": "$(cd "$APP_ROOT" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || printf unknown)",
  "dataKeyFingerprint": "$(data_key_fingerprint)",
  "contents": {
    "passwordHashes": $([[ "$scope" == identities ]] && printf true || printf false),
    "mfaMaterial": $([[ "$scope" == identities ]] && printf true || printf false),
    "sessions": false,
    "orders": $([[ "$scope" == orders ]] && printf true || printf false),
    "uploadedOrderFiles": $([[ "$scope" == orders ]] && printf true || printf false)
  },
  "tableCount": $(scope_tables "$scope" | wc -l | tr -d ' '),
  "orderFileCount": ${files_count},
  "tables": [${tables_json}]
}
EOF
}

create_order_storage_archive() {
  local staging="$1" keys_file="$staging/storage-keys.txt" key count=0
  MYSQL_PWD="$DB_PASSWORD" mysql --host=127.0.0.1 --user="$DB_USER" --batch --skip-column-names "$DB_NAME" -e \
    "SELECT storage_key FROM files WHERE order_id IS NOT NULL UNION SELECT fv.storage_key FROM file_versions fv INNER JOIN files f ON f.id=fv.file_id WHERE f.order_id IS NOT NULL" > "$keys_file"
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    [[ "$key" =~ ^[A-Za-z0-9._/-]{1,128}$ && "$key" != *".."* && "$key" != /* ]] || die "Database contains an unsafe order-file storage key."
    [[ -f "$STORAGE_ROOT/$key" ]] || die "Referenced order file is missing from protected storage."
    count=$((count + 1))
  done < "$keys_file"
  if [[ "$count" -eq 0 ]]; then
    tar --files-from /dev/null -cf "$staging/order-files.tar"
  else
    tar -C "$STORAGE_ROOT" --verbatim-files-from --no-recursion --files-from "$keys_file" -cf "$staging/order-files.tar"
  fi
  printf '%s\n' "$count"
}

export_recovery() {
  local scope="$1" output="$2" staging payload envelope salt iv enc_key mac_key mac file_count=0
  valid_scope "$scope" || die "Unsupported recovery scope."
  mkdir -p "$EXPORT_DIR"
  chmod 0750 "$EXPORT_DIR"
  staging="$(mktemp -d /tmp/rp-scoped-recovery.XXXXXXXX)"; cleanup_paths+=("$staging")
  payload="$(mktemp /tmp/rp-scoped-payload.XXXXXXXX)"; cleanup_paths+=("$payload")
  envelope="$(mktemp -d /tmp/rp-scoped-envelope.XXXXXXXX)"; cleanup_paths+=("$envelope")

  mapfile -t tables < <(scope_tables "$scope")
  log "Exporting ${scope} recovery database records."
  MYSQL_PWD="$DB_PASSWORD" mysqldump --host=127.0.0.1 --user="$DB_USER" --single-transaction --quick --skip-comments --skip-triggers --skip-add-locks --skip-disable-keys --no-create-info --complete-insert --replace --set-gtid-purged=OFF --no-tablespaces "$DB_NAME" "${tables[@]}" > "$staging/recovery.sql"
  [[ -s "$staging/recovery.sql" ]] || die "Scoped database export is empty."
  if [[ "$scope" == "orders" ]]; then file_count="$(create_order_storage_archive "$staging")"; fi
  make_manifest "$staging/manifest.json" "$scope" "$file_count"
  if [[ "$scope" == "orders" ]]; then
    (cd "$staging" && sha256sum manifest.json recovery.sql order-files.tar > contents.sha256)
    tar -C "$staging" -czf "$payload" manifest.json contents.sha256 recovery.sql order-files.tar
  else
    (cd "$staging" && sha256sum manifest.json recovery.sql > contents.sha256)
    tar -C "$staging" -czf "$payload" manifest.json contents.sha256 recovery.sql
  fi
  salt="$(openssl rand -hex 16)"; iv="$(openssl rand -hex 16)"
  enc_key="$(derive_key 32 "$salt" encryption)"; mac_key="$(derive_key 32 "$salt" integrity)"
  [[ ${#enc_key} -eq 64 && ${#mac_key} -eq 64 ]] || die "Unable to derive recovery encryption keys."
  openssl enc -aes-256-cbc -K "$enc_key" -iv "$iv" -nosalt -in "$payload" -out "$envelope/payload.enc"
  mac="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:${mac_key}" "$envelope/payload.enc" | awk '{print $NF}')"
  printf '%s\n' "$mac" > "$envelope/payload.hmac"
  cat > "$envelope/envelope.json" <<EOF
{
  "format": "readypackets-scoped-recovery-envelope",
  "formatVersion": ${FORMAT_VERSION},
  "cipher": "AES-256-CBC",
  "kdf": "PBKDF2-HMAC-SHA512",
  "iterations": ${PBKDF2_ITERATIONS},
  "saltHex": "${salt}",
  "ivHex": "${iv}",
  "integrity": "HMAC-SHA256"
}
EOF
  tar -C "$envelope" -czf "$output" envelope.json payload.hmac payload.enc
  chmod 0640 "$output"
  printf 'artifact=%s\nscope=%s\norder_file_count=%s\n' "$(basename "$output")" "$scope" "$file_count"
}

OPENED_PAYLOAD=""
open_recovery() {
  local input="$1" envelope extracted salt iv enc_key mac_key expected actual
  [[ -f "$input" ]] || die "Recovery archive is unavailable."
  envelope="$(mktemp -d /tmp/rp-scoped-envelope-open.XXXXXXXX)"; cleanup_paths+=("$envelope")
  tar -tzf "$input" | sort | cmp -s - <(printf 'envelope.json\npayload.enc\npayload.hmac\n') || die "Recovery envelope contains unsupported members."
  tar --no-same-owner --no-same-permissions -C "$envelope" -xzf "$input"
  salt="$(sed -nE 's/^[[:space:]]*"saltHex"[[:space:]]*:[[:space:]]*"([0-9a-f]{32})".*/\1/p' "$envelope/envelope.json")"
  iv="$(sed -nE 's/^[[:space:]]*"ivHex"[[:space:]]*:[[:space:]]*"([0-9a-f]{32})".*/\1/p' "$envelope/envelope.json")"
  [[ ${#salt} -eq 32 && ${#iv} -eq 32 ]] || die "Recovery envelope parameters are invalid."
  enc_key="$(derive_key 32 "$salt" encryption)"; mac_key="$(derive_key 32 "$salt" integrity)"
  expected="$(tr -d '\r\n ' < "$envelope/payload.hmac")"
  actual="$(openssl dgst -sha256 -mac HMAC -macopt "hexkey:${mac_key}" "$envelope/payload.enc" | awk '{print $NF}')"
  [[ "$actual" == "$expected" ]] || die "Recovery archive integrity check failed. The passphrase may be incorrect."
  extracted="$(mktemp -d /tmp/rp-scoped-payload-open.XXXXXXXX)"; cleanup_paths+=("$extracted")
  openssl enc -d -aes-256-cbc -K "$enc_key" -iv "$iv" -nosalt -in "$envelope/payload.enc" | tar --no-same-owner --no-same-permissions -C "$extracted" -xzf -
  [[ -f "$extracted/manifest.json" && -f "$extracted/recovery.sql" && -f "$extracted/contents.sha256" ]] || die "Recovery payload is incomplete."
  OPENED_PAYLOAD="$extracted"
}

read_manifest_value() { sed -nE "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"?([^\",}]+)\"?.*/\\1/p" "$1" | head -n1; }

validate_payload() {
  local extracted="$1" expected_scope="$2" scope fingerprint members
  scope="$(read_manifest_value "$extracted/manifest.json" scope)"
  [[ "$scope" == "$expected_scope" ]] || die "Recovery archive scope does not match the requested action."
  fingerprint="$(read_manifest_value "$extracted/manifest.json" dataKeyFingerprint)"
  [[ "$fingerprint" =~ ^[a-f0-9]{64}$ && "$fingerprint" == "$(data_key_fingerprint)" ]] || die "Recovery archive belongs to a different data-encryption key. Restore its encrypted data only after performing the controlled configuration/key recovery."
  if [[ "$expected_scope" == "orders" ]]; then
    [[ -f "$extracted/order-files.tar" ]] || die "Order recovery archive is missing its file bundle."
    members="$(tar -tf "$extracted/order-files.tar" | sed '/^$/d' | wc -l | tr -d ' ')"
    [[ "$members" =~ ^[0-9]+$ ]] || die "Order file archive validation failed."
  fi
  (cd "$extracted" && sha256sum -c --quiet contents.sha256) || die "Recovery payload checksum verification failed."
}

inspect_recovery() {
  local scope="$1" input="$2" extracted files_count
  valid_scope "$scope" || die "Unsupported recovery scope."
  open_recovery "$input"
  extracted="$OPENED_PAYLOAD"
  validate_payload "$extracted" "$scope"
  files_count="$(read_manifest_value "$extracted/manifest.json" orderFileCount)"
  [[ "$files_count" =~ ^[0-9]+$ ]] || files_count=0
  printf 'verified=true\nscope=%s\norder_file_count=%s\n' "$scope" "$files_count"
}

restore_recovery() {
  local scope="$1" input="$2" extracted safety unit
  valid_scope "$scope" || die "Unsupported recovery scope."
  open_recovery "$input"
  extracted="$OPENED_PAYLOAD"
  validate_payload "$extracted" "$scope"
  safety="/var/backups/readypackets/pre-${scope}-recovery-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  install -d -m 0700 /var/backups/readypackets
  MYSQL_PWD="$DB_PASSWORD" mysqldump --host=127.0.0.1 --user="$DB_USER" --single-transaction --quick --no-tablespaces "$DB_NAME" | gzip > "$safety"
  chmod 0600 "$safety"
  systemctl stop readypackets
  APP_STOPPED="true"
  {
    printf 'SET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\n'
    cat "$extracted/recovery.sql"
    printf 'SET UNIQUE_CHECKS=1;\nSET FOREIGN_KEY_CHECKS=1;\n'
  } | MYSQL_PWD="$DB_PASSWORD" mysql --host=127.0.0.1 --user="$DB_USER" "$DB_NAME"
  if [[ "$scope" == "orders" ]]; then
    tar -tf "$extracted/order-files.tar" | while IFS= read -r key; do
      [[ "$key" =~ ^[A-Za-z0-9._/-]{1,128}$ && "$key" != *".."* && "$key" != /* ]] || die "Order file bundle contains an unsafe path."
    done
    tar --no-same-owner --no-same-permissions -C "$STORAGE_ROOT" -xf "$extracted/order-files.tar"
    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      chown readypackets:readypackets "$STORAGE_ROOT/$key"
      chmod go-rwx "$STORAGE_ROOT/$key"
    done < <(tar -tf "$extracted/order-files.tar")
  else
    # Recovered password hashes and MFA material must not inherit any existing
    # authenticated browser sessions on the target system.
    MYSQL_PWD="$DB_PASSWORD" mysql --host=127.0.0.1 --user="$DB_USER" "$DB_NAME" -e "UPDATE user_sessions SET revoked_at=COALESCE(revoked_at, UTC_TIMESTAMP()), revoked_reason=COALESCE(revoked_reason, 'identity recovery')"
  fi
  systemctl start readypackets
  APP_STOPPED="false"
  printf 'restored=true\nscope=%s\nsafety_dump=%s\n' "$scope" "$(basename "$safety")"
}

require_root
require_commands
case "$ACTION" in
  export)
    valid_scope "$SCOPE" || die "Usage: export {identities|orders} OUTPUT PASSPHRASE_FILE"
    [[ -n "$INPUT" && -n "$PASSPHRASE_FILE" ]] || die "Usage: export {identities|orders} OUTPUT PASSPHRASE_FILE"
    valid_artifact_name "$(basename "$INPUT")" || die "Invalid recovery archive name."
    load_environment; read_passphrase; export_recovery "$SCOPE" "$INPUT"
    ;;
  inspect)
    valid_scope "$SCOPE" || die "Usage: inspect {identities|orders} INPUT PASSPHRASE_FILE"
    [[ -n "$INPUT" && -n "$PASSPHRASE_FILE" ]] || die "Usage: inspect {identities|orders} INPUT PASSPHRASE_FILE"
    load_environment; read_passphrase; inspect_recovery "$SCOPE" "$INPUT"
    ;;
  restore)
    valid_scope "$SCOPE" || die "Usage: restore {identities|orders} INPUT PASSPHRASE_FILE"
    [[ -n "$INPUT" && -n "$PASSPHRASE_FILE" ]] || die "Usage: restore {identities|orders} INPUT PASSPHRASE_FILE"
    load_environment; read_passphrase; restore_recovery "$SCOPE" "$INPUT"
    ;;
  *)
    die "Usage: $0 {export|inspect|restore} {identities|orders} INPUT_OR_OUTPUT PASSPHRASE_FILE"
    ;;
esac
