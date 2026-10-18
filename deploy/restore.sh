#!/usr/bin/env bash
#
# ReadyPackets Portal — restore
#
# Restores a database dump, and optionally the uploaded files, from an archive
# produced by backup.sh. Destructive by nature, so it refuses to proceed without
# an explicit confirmation and takes a safety dump of the current state first.
#
# Usage:
#   sudo ./restore.sh --archive /var/backups/readypackets/readypackets-....tar.gz
#   sudo ./restore.sh --archive <file> --database rp_restore_test --no-files
#   sudo ./restore.sh --archive <file> --yes
#   sudo ./restore.sh --archive <file> --yes --restore-platform-secrets
#
# --restore-platform-secrets is a root-console-only replacement-server option.
# It restores application/integration secrets while preserving target database,
# network, hostname, TLS, and storage-location values.
#
# Verifying a backup without touching production:
#   sudo ./restore.sh --archive <file> --database rp_restore_test --no-files --yes

set -Eeuo pipefail

APP_ROOT="${RP_APP_ROOT:-/opt/readypackets}"
ENV_FILE="${RP_ENV_FILE:-/etc/readypackets/portal.env}"
DATA_DIR="${RP_DATA_DIR:-/var/lib/readypackets}"
ARCHIVE=""
TARGET_DB=""
RESTORE_FILES="true"
ASSUME_YES="false"
RESTORE_PLATFORM_SECRETS="false"
RECOVERY_HISTORY_FILE=""
RESTORE_UNIT=""
RESTORE_STARTED_AT=""
SERVICE="readypackets"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)   ARCHIVE="${2:?}"; shift 2 ;;
    --database)  TARGET_DB="${2:?}"; shift 2 ;;
    --no-files)  RESTORE_FILES="false"; shift ;;
    --yes)       ASSUME_YES="true"; shift ;;
    --restore-platform-secrets) RESTORE_PLATFORM_SECRETS="true"; shift ;;
    --history-file) RECOVERY_HISTORY_FILE="${2:?}"; shift 2 ;;
    --restore-unit) RESTORE_UNIT="${2:?}"; shift 2 ;;
    --restore-started-at) RESTORE_STARTED_AT="${2:?}"; shift 2 ;;
    --env-file)  ENV_FILE="${2:?}"; shift 2 ;;
    -h|--help)   sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)           die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root."
[[ -n "$ARCHIVE" ]] || die "--archive is required."
[[ -r "$ARCHIVE" ]] || die "Cannot read ${ARCHIVE}"
[[ -r "$ENV_FILE" ]] || die "Cannot read ${ENV_FILE}"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${DB_NAME:?}" ; : "${DB_USER:?}" ; : "${DB_PASSWORD:?}"

TARGET_DB="${TARGET_DB:-$DB_NAME}"
IS_PRODUCTION="false"
[[ "$TARGET_DB" == "$DB_NAME" ]] && IS_PRODUCTION="true"

STAGING="$(mktemp -d /tmp/rp-restore.XXXXXXXX)"
chmod 0700 "$STAGING"

write_restore_history() {
  local exit_code=$?
  rm -rf "$STAGING"
  [[ -n "$RECOVERY_HISTORY_FILE" && -n "$RESTORE_UNIT" && -f "$APP_ROOT/deploy/recovery-history.sh" ]] || return 0
  # shellcheck disable=SC1090
  source "$APP_ROOT/deploy/recovery-history.sh" || return 0
  local started_at archive_name
  started_at="${RESTORE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  archive_name="$(basename "$ARCHIVE")"
  if [[ "$exit_code" -eq 0 ]]; then
    recovery_history_append restore "$RESTORE_UNIT" "$archive_name" portable_full completed "$started_at" "Full system restore completed; the target hostname, TLS, network, database connection, storage paths, and SAML activation setting were preserved."
  else
    recovery_history_append restore "$RESTORE_UNIT" "$archive_name" portable_full failed "$started_at" "Full system restore failed; review the protected root restore journal for details."
  fi
  return 0
}
trap 'write_restore_history' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# Unpack
# ---------------------------------------------------------------------------
validate_backup_archive() {
  local source="$1" member normalized member_type
  while IFS= read -r member; do
    normalized="${member#./}"
    [[ -n "$normalized" ]] || continue
    [[ "$normalized" =~ ^(database\.sql|MANIFEST\.txt|SHA256SUMS|storage\.tar|platform-runtime\.tar|portal\.env)$ ]] || die "Archive contains an unsupported member."
  done < <(tar -tzf "$source")
  while IFS= read -r member_type; do
    [[ "$member_type" == "-" || "$member_type" == "d" ]] || die "Archive contains links or unsupported member types."
  done < <(tar -tvzf "$source" | awk '{print substr($1,1,1)}')
}

validate_platform_runtime_archive() {
  local source="$1" member normalized member_type
  while IFS= read -r member; do
    normalized="${member#./}"
    [[ -n "$normalized" ]] || continue
    [[ "$normalized" == root/.config/rclone || "$normalized" == root/.config/rclone/* || "$normalized" == etc/readypackets/backup-sync-targets.conf ]] || die "Platform runtime archive contains an unsupported path."
  done < <(tar -tf "$source")
  while IFS= read -r member_type; do
    [[ "$member_type" == "-" || "$member_type" == "d" ]] || die "Platform runtime archive contains links or unsupported member types."
  done < <(tar -tvf "$source" | awk '{print substr($1,1,1)}')
}

validate_storage_archive() {
  local source="$1" member normalized member_type
  while IFS= read -r member; do
    normalized="${member#./}"
    [[ -n "$normalized" ]] || continue
    [[ "$normalized" == storage || "$normalized" == storage/* ]] || die "Storage archive contains an unsupported path."
  done < <(tar -tf "$source")
  while IFS= read -r member_type; do
    [[ "$member_type" == "-" || "$member_type" == "d" ]] || die "Storage archive contains links or unsupported member types."
  done < <(tar -tvf "$source" | awk '{print substr($1,1,1)}')
}

log "Unpacking archive"
ARCHIVE_TAR="$ARCHIVE"
case "$ARCHIVE" in
  *.age)
    command -v age >/dev/null 2>&1 || die "age is required to decrypt this archive."
    ARCHIVE_TAR="${STAGING}/archive.tar.gz"
    age --decrypt -o "$ARCHIVE_TAR" "$ARCHIVE"
    ;;
  *.gpg)
    command -v gpg >/dev/null 2>&1 || die "gpg is required to decrypt this archive."
    ARCHIVE_TAR="${STAGING}/archive.tar.gz"
    gpg --batch --yes --decrypt --output "$ARCHIVE_TAR" "$ARCHIVE"
    ;;
  *.tar.gz)
    ;;
  *)
    die "Unrecognised archive format: ${ARCHIVE}"
    ;;
esac
validate_backup_archive "$ARCHIVE_TAR"
tar --no-same-owner --no-same-permissions -C "$STAGING" -xzf "$ARCHIVE_TAR"

[[ -f "${STAGING}/database.sql" ]] || die "The archive contains no database.sql"

if [[ -f "${STAGING}/MANIFEST.txt" ]]; then
  log "Archive manifest:"
  sed 's/^/    /' "${STAGING}/MANIFEST.txt"
fi

if [[ -f "${STAGING}/SHA256SUMS" ]]; then
  log "Verifying checksums"
  (cd "$STAGING" && sha256sum -c --ignore-missing --quiet SHA256SUMS) \
    || die "Checksum verification failed; the archive is corrupt."
fi

# ---------------------------------------------------------------------------
# Replacement-server secrets (explicit root-console break-glass only)
# ---------------------------------------------------------------------------
TARGET_ENV_BACKUP=""
prepare_platform_secret_restore() {
  [[ -f "${STAGING}/portal.env" ]] || die "This archive has no portal.env; it cannot restore platform secrets."
  TARGET_ENV_BACKUP="${ENV_FILE}.pre-full-restore-$(date -u '+%Y%m%dT%H%M%SZ')"
  install -m 0600 -o root -g root "$ENV_FILE" "$TARGET_ENV_BACKUP"

  # These values identify and connect the replacement host. They must remain
  # local even when restoring source application and integration secrets.
  local preserve_keys=(DB_NAME DB_USER DB_PASSWORD DATABASE_URL PORT BIND_HOST APP_URL PUBLIC_SITE_URL ALLOWED_ORIGINS PORTAL_ALIASES TRUST_PROXY_HOPS BEHIND_CLOUDFLARE STORAGE_DRIVER STORAGE_LOCAL_ROOT S3_BUCKET S3_REGION S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE RP_ENV_FILE RP_DATA_DIR SAML_ENABLED)
  local preserve_regex key replacement
  preserve_regex="^($(IFS='|'; echo "${preserve_keys[*]}"))="
  replacement="${STAGING}/portal.env.recovered"
  grep -Ev "$preserve_regex" "${STAGING}/portal.env" > "$replacement" || true
  for key in "${preserve_keys[@]}"; do
    grep -m1 "^${key}=" "$ENV_FILE" >> "$replacement" || true
  done
  grep -q '^DATA_ENCRYPTION_KEY=' "$replacement" || die "Recovered portal environment lacks DATA_ENCRYPTION_KEY."
  grep -q '^EMAIL_INDEX_KEY=' "$replacement" || die "Recovered portal environment lacks EMAIL_INDEX_KEY."
  install -m 0640 -o root -g readypackets "$replacement" "$ENV_FILE"
  log "Applied archived application and integration secrets; target hostname, TLS/network settings, and SAML activation state preserved (previous file: $TARGET_ENV_BACKUP)"
  warn "SAML remains in the target host's prior activation state. Reconfigure and validate the target reply URL before enabling SSO after a hostname migration."
}

if [[ -f "${STAGING}/portal.env" ]]; then
  ARCHIVE_KEY="$(grep -E '^DATA_ENCRYPTION_KEY=' "${STAGING}/portal.env" | cut -d= -f2- || true)"
  if [[ -n "$ARCHIVE_KEY" && "$ARCHIVE_KEY" != "${DATA_ENCRYPTION_KEY:-}" ]]; then
    warn "The archive was created with a DIFFERENT DATA_ENCRYPTION_KEY than the one currently configured."
    if [[ "$RESTORE_PLATFORM_SECRETS" == "true" ]]; then
      prepare_platform_secret_restore
      # Reload the target connection values while retaining the archived data key.
      set -a; source "$ENV_FILE"; set +a
    else
      warn "Encrypted customer data will not decrypt unless this is a controlled replacement-server recovery."
      warn "Use --restore-platform-secrets only from the root console after validating the archive."
      if [[ "$ASSUME_YES" != "true" ]]; then
        read -r -p "Continue without restoring archived secrets? [y/N] " reply
        [[ "$reply" == "y" || "$reply" == "Y" ]] || die "Aborted."
      fi
    fi
  elif [[ "$RESTORE_PLATFORM_SECRETS" == "true" ]]; then
    prepare_platform_secret_restore
    set -a; source "$ENV_FILE"; set +a
  fi
elif [[ "$RESTORE_PLATFORM_SECRETS" == "true" ]]; then
  die "This archive has no portal.env; it cannot restore platform secrets."
fi

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------
if [[ "$ASSUME_YES" != "true" ]]; then
  echo
  if [[ "$IS_PRODUCTION" == "true" ]]; then
    warn "This will OVERWRITE the live database '${TARGET_DB}'."
  else
    log "This will overwrite the database '${TARGET_DB}' (not the live database)."
  fi
  [[ "$RESTORE_FILES" == "true" ]] && warn "Uploaded files in ${DATA_DIR}/storage will also be replaced."
  read -r -p "Type the database name to confirm: " reply
  [[ "$reply" == "$TARGET_DB" ]] || die "Confirmation did not match; nothing was changed."
fi

# ---------------------------------------------------------------------------
# Safety dump of the current state
# ---------------------------------------------------------------------------
if MYSQL_PWD="$DB_PASSWORD" mysql --host=127.0.0.1 --user="$DB_USER" \
     -e "USE \`${TARGET_DB}\`" 2>/dev/null; then
  SAFETY="/var/backups/readypackets/pre-restore-${TARGET_DB}-$(date -u '+%Y%m%dT%H%M%SZ').sql.gz"
  install -d -m 0700 /var/backups/readypackets
  log "Taking a safety dump of the current '${TARGET_DB}' to ${SAFETY}"
  MYSQL_PWD="$DB_PASSWORD" mysqldump --host=127.0.0.1 --user="$DB_USER" \
    --single-transaction --quick --no-tablespaces "$TARGET_DB" | gzip > "$SAFETY"
  chmod 0600 "$SAFETY"
fi

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
if [[ "$IS_PRODUCTION" == "true" ]]; then
  log "Stopping ${SERVICE}"
  systemctl stop "$SERVICE" 2>/dev/null || docker compose stop app 2>/dev/null || \
    warn "Could not stop the service automatically; ensure it is not writing during the restore."
fi

log "Restoring the database into '${TARGET_DB}'"
# This script is root-only. Provision the selected database through the local
# root socket, then grant the existing least-privilege application account access
# to that one database. This enables nonproduction restore drills without giving
# the application account global CREATE DATABASE privilege.
mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${TARGET_DB}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON \`${TARGET_DB}\`.* TO '${DB_USER}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`${TARGET_DB}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

# The dump recreates each table, so an existing schema is replaced rather than
# merged. Foreign key checks are disabled for the load and restored afterwards.
{
  echo "SET FOREIGN_KEY_CHECKS=0;"
  echo "SET UNIQUE_CHECKS=0;"
  cat "${STAGING}/database.sql"
  echo "SET UNIQUE_CHECKS=1;"
  echo "SET FOREIGN_KEY_CHECKS=1;"
} | MYSQL_PWD="$DB_PASSWORD" mysql --host=127.0.0.1 --user="$DB_USER" "$TARGET_DB"

TABLES="$(MYSQL_PWD="$DB_PASSWORD" mysql --host=127.0.0.1 --user="$DB_USER" \
  --batch --skip-column-names -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${TARGET_DB}'")"
log "Restored ${TABLES} tables"
[[ "$TABLES" -gt 10 ]] || die "Only ${TABLES} tables were restored; the dump appears incomplete."

# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
if [[ "$RESTORE_FILES" == "true" && -f "${STAGING}/storage.tar" ]]; then
  log "Restoring uploaded files to ${STORAGE_DRIVER:-local} storage"
  validate_storage_archive "${STAGING}/storage.tar"
  STORAGE_RESTORE_DIR="${STAGING}/storage-import"
  mkdir -p "$STORAGE_RESTORE_DIR"
  tar --no-same-owner --no-same-permissions -C "$STORAGE_RESTORE_DIR" -xf "${STAGING}/storage.tar"
  if [[ "${STORAGE_DRIVER:-local}" == "local" ]]; then
    if [[ -d "${DATA_DIR}/storage" ]]; then
      mv "${DATA_DIR}/storage" "${DATA_DIR}/storage.replaced-$(date -u '+%Y%m%dT%H%M%SZ')"
    fi
  fi
  node "${APP_ROOT}/deploy/object-storage-archive.mjs" import --source "$STORAGE_RESTORE_DIR/storage"
  if [[ "${STORAGE_DRIVER:-local}" == "local" ]]; then
    chown -R readypackets:readypackets "${DATA_DIR}/storage" 2>/dev/null || true
    chmod -R go-rwx "${DATA_DIR}/storage"
  fi
elif [[ "$RESTORE_FILES" == "true" ]]; then
  warn "The archive contains no storage.tar; uploaded files were not restored."
fi

# ---------------------------------------------------------------------------
# Root-owned backup synchronization runtime (explicit recovery mode only)
# ---------------------------------------------------------------------------
if [[ "$RESTORE_PLATFORM_SECRETS" == "true" && -f "${STAGING}/platform-runtime.tar" ]]; then
  log "Restoring root-owned backup synchronization runtime"
  validate_platform_runtime_archive "${STAGING}/platform-runtime.tar"
  runtime_safety="/var/backups/readypackets/pre-restore-runtime-$(date -u '+%Y%m%dT%H%M%SZ').tar.gz"
  runtime_paths=()
  [[ -d /root/.config/rclone ]] && runtime_paths+=("/root/.config/rclone")
  [[ -f /etc/readypackets/backup-sync-targets.conf ]] && runtime_paths+=("/etc/readypackets/backup-sync-targets.conf")
  if [[ ${#runtime_paths[@]} -gt 0 ]]; then
    tar -czf "$runtime_safety" "${runtime_paths[@]}"
    chmod 0600 "$runtime_safety"
  fi
  tar --no-same-owner --no-same-permissions -C / -xf "${STAGING}/platform-runtime.tar"
  [[ -d /root/.config/rclone ]] && { chown -R root:root /root/.config/rclone; chmod 0700 /root/.config/rclone; find /root/.config/rclone -type f -exec chmod 0600 {} +; }
  [[ -f /etc/readypackets/backup-sync-targets.conf ]] && { chown root:readypackets /etc/readypackets/backup-sync-targets.conf; chmod 0640 /etc/readypackets/backup-sync-targets.conf; }
elif [[ "$RESTORE_PLATFORM_SECRETS" == "true" ]]; then
  warn "Archive has no backup synchronization runtime; application secrets were restored without cloud-backup credentials."
fi

# ---------------------------------------------------------------------------
# Bring the service back
# ---------------------------------------------------------------------------
if [[ "$IS_PRODUCTION" == "true" ]]; then
  log "Applying any pending migrations"
  runuser -u readypackets -- sh -c '
    set -a
    . "$1"
    set +a
    shift
    exec "$@"
  ' sh "$ENV_FILE" node /opt/readypackets/dist/migrate.js \
    || warn "Migration step failed; review before serving traffic."

  log "Starting ${SERVICE}"
  systemctl start "$SERVICE" 2>/dev/null || docker compose start app 2>/dev/null || true
  sleep 3
  if curl -fsS -H "Host: localhost" http://127.0.0.1:3000/api/health/ready >/dev/null 2>&1; then
    log "The service is ready."
  else
    warn "The readiness probe failed. Check the service logs."
  fi
fi

log "Restore complete."
