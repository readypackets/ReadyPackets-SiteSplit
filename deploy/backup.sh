#!/usr/bin/env bash
#
# ReadyPackets Portal — backup
#
# Produces a single compressed, optionally encrypted archive containing the
# database dump, uploaded files, application environment, and root-owned backup
# synchronization runtime. Retention is enforced locally; nothing is uploaded
# anywhere by default.
#
# Usage:
#   sudo ./backup.sh                       # nightly default
#   sudo ./backup.sh --output /mnt/backups # alternative destination
#   sudo ./backup.sh --encrypt             # age/gpg encryption if available
#   sudo ./backup.sh --db-only
#
# IMPORTANT: the archive contains DATA_ENCRYPTION_KEY. Without that key the
# encrypted columns in the dump are unrecoverable, and with it the dump is
# fully readable. Store backups accordingly.

set -Eeuo pipefail

APP_ROOT="${RP_APP_ROOT:-/opt/readypackets}"
ENV_FILE="${RP_ENV_FILE:-/etc/readypackets/portal.env}"
DATA_DIR="${RP_DATA_DIR:-/var/lib/readypackets}"
RECOVERY_HISTORY_FILE="${RP_RECOVERY_HISTORY_FILE:-/var/lib/readypackets/backup-control/recovery-history.jsonl}"
OUTPUT_DIR="/var/backups/readypackets"
RETENTION_DAYS=30
DB_ONLY="false"
ENCRYPT="false"
GPG_RECIPIENT="${RP_GPG_RECIPIENT:-}"
SYNC_TARGETS_FILE="${RP_BACKUP_SYNC_TARGETS_FILE:-/etc/readypackets/backup-sync-targets.conf}"
SKIP_SYNC="false"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)    OUTPUT_DIR="${2:?}"; shift 2 ;;
    --retention) RETENTION_DAYS="${2:?}"; shift 2 ;;
    --db-only)   DB_ONLY="true"; shift ;;
    --encrypt)   ENCRYPT="true"; shift ;;
    --recipient) GPG_RECIPIENT="${2:?}"; ENCRYPT="true"; shift 2 ;;
    --env-file)  ENV_FILE="${2:?}"; shift 2 ;;
    --skip-sync) SKIP_SYNC="true"; shift ;;
    -h|--help)   sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)           die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Run as root: the environment file and storage are not world-readable."
[[ -r "$ENV_FILE" ]] || die "Cannot read ${ENV_FILE}"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${DB_NAME:?DB_NAME missing from the environment file}"
: "${DB_USER:?DB_USER missing from the environment file}"
: "${DB_PASSWORD:?DB_PASSWORD missing from the environment file}"

TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BACKUP_STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
BACKUP_RUN_ID="backup-${TIMESTAMP}-$$"
BACKUP_STATUS="failed"
ARCHIVE=""
STAGING="$(mktemp -d /tmp/rp-backup.XXXXXXXX)"
VERIFY_STAGING="$(mktemp -d /tmp/rp-backup-verify.XXXXXXXX)"
chmod 0700 "$STAGING" "$VERIFY_STAGING"

write_backup_history() {
  local exit_code=$?
  rm -rf "$STAGING" "$VERIFY_STAGING"
  [[ -f "$APP_ROOT/deploy/recovery-history.sh" ]] || return 0
  # shellcheck disable=SC1090
  source "$APP_ROOT/deploy/recovery-history.sh" || return 0
  local archive_name status detail
  archive_name="${ARCHIVE:+$(basename "$ARCHIVE")}"
  status="$BACKUP_STATUS"
  detail="Verified full backup archive retained locally."
  if [[ "$exit_code" -ne 0 || "$BACKUP_STATUS" != "completed" ]]; then
    status="failed"
    detail="Backup job failed; review the protected root backup journal for details."
  fi
  recovery_history_append backup "$BACKUP_RUN_ID" "$archive_name" full "$status" "$BACKUP_STARTED_AT" "$detail"
  return 0
}
trap 'write_backup_history' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The installer and the service pre-start hook provision the default location as
# root:readypackets with set-group-ID. The hardened backup service must only
# verify that precondition; attempting `install -d` from its sandbox can invoke
# a prohibited ownership or mode-changing operation. An alternate output path is
# supported only for an explicit root-console backup invocation.
if [[ "$OUTPUT_DIR" == "/var/backups/readypackets" ]]; then
  [[ -d "$OUTPUT_DIR" ]] || die "The protected backup directory is missing; rerun the ReadyPackets installer."
  [[ "$(stat -c '%U:%G:%a' "$OUTPUT_DIR")" == "root:readypackets:2750" ]] || \
    die "The protected backup directory has unsafe ownership or permissions; rerun the ReadyPackets installer."
else
  install -d -m 0700 "$OUTPUT_DIR"
fi

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
log "Dumping database '${DB_NAME}'"
# The password is passed through the environment rather than the command line so
# it does not appear in the process table.
# --events and --routines are deliberately absent. They require the EVENT
# privilege and SELECT on mysql.proc respectively, which the application user
# does not hold and should not: the schema defines neither scheduled events nor
# stored procedures. Including them made mysqldump abort with "Access denied",
# and the tempting fix -- widening the grant -- would trade least privilege for
# the ability to dump objects that do not exist. --triggers is kept, needing only
# the TRIGGER privilege, so the dump stays faithful if one is ever added.
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host=127.0.0.1 \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --triggers \
  --set-gtid-purged=OFF \
  --default-character-set=utf8mb4 \
  --no-tablespaces \
  "$DB_NAME" > "${STAGING}/database.sql"

DUMP_BYTES="$(stat -c '%s' "${STAGING}/database.sql")"
[[ "$DUMP_BYTES" -gt 1024 ]] || die "The dump is suspiciously small (${DUMP_BYTES} bytes); aborting."
log "Dump size: $(numfmt --to=iec "$DUMP_BYTES")"

# ---------------------------------------------------------------------------
# Uploaded files and configuration
# ---------------------------------------------------------------------------
INCLUDES_RUNTIME="no"
STORAGE_OBJECT_COUNT="0"
STORAGE_OBJECT_BYTES="0"
STORAGE_DRIVER_EFFECTIVE="${STORAGE_DRIVER:-local}"
if [[ "$DB_ONLY" == "false" ]]; then
  # The archive adapter reads the configured local or S3-compatible backend and
  # writes an identical opaque-key tree to staging. This deliberately avoids an
  # undocumented host sync tool, preserves file hashes, and makes a full backup
  # portable between local-disk and shared object-storage deployments.
  log "Archiving uploaded files from ${STORAGE_DRIVER_EFFECTIVE} storage"
  STORAGE_EXPORT_RESULT="$(node "${APP_ROOT}/deploy/object-storage-archive.mjs" export --destination "${STAGING}/storage")"
  STORAGE_OBJECT_COUNT="$(printf '%s\n' "$STORAGE_EXPORT_RESULT" | sed -n 's/^object_count=//p' | head -n1)"
  STORAGE_OBJECT_BYTES="$(printf '%s\n' "$STORAGE_EXPORT_RESULT" | sed -n 's/^object_bytes=//p' | head -n1)"
  [[ "$STORAGE_OBJECT_COUNT" =~ ^[0-9]+$ && "$STORAGE_OBJECT_BYTES" =~ ^[0-9]+$ ]] || die "Storage archive adapter returned an invalid summary."
  tar -C "$STAGING" -cf "${STAGING}/storage.tar" storage

  # Included because the encryption and service-integration keys are required
  # to recover encrypted customer data and application settings on a replacement
  # host. The restore path requires an explicit break-glass flag to apply it.
  cp "$ENV_FILE" "${STAGING}/portal.env"

  # Backup-sync credentials are root-owned outside the application database.
  # Include only these runtime files; TLS private keys are intentionally excluded
  # because a replacement host must issue its own certificate for its hostname.
  runtime_paths=()
  [[ -d /root/.config/rclone ]] && runtime_paths+=("root/.config/rclone")
  [[ -f "$SYNC_TARGETS_FILE" ]] && runtime_paths+=("${SYNC_TARGETS_FILE#/}")
  if [[ ${#runtime_paths[@]} -gt 0 ]]; then
    log "Archiving backup synchronization runtime"
    tar -C / -cf "${STAGING}/platform-runtime.tar" "${runtime_paths[@]}"
    INCLUDES_RUNTIME="yes"
  fi
fi

# A manifest makes a restore verifiable rather than hopeful.
cat > "${STAGING}/MANIFEST.txt" <<MANIFEST
ReadyPackets Portal backup
Created:        ${TIMESTAMP}
Host:           $(hostname -f 2>/dev/null || hostname)
Database:       ${DB_NAME}
Dump bytes:     ${DUMP_BYTES}
Includes files: $([[ "$DB_ONLY" == "false" ]] && echo yes || echo no)
Storage driver: ${STORAGE_DRIVER_EFFECTIVE}
Storage objects: ${STORAGE_OBJECT_COUNT}
Storage bytes:   ${STORAGE_OBJECT_BYTES}
Includes application secrets: $([[ "$DB_ONLY" == "false" ]] && echo yes || echo no)
Includes backup-sync runtime: ${INCLUDES_RUNTIME}
Schema version: $(MYSQL_PWD="$DB_PASSWORD" mysql --host=127.0.0.1 --user="$DB_USER" \
                    --batch --skip-column-names -e \
                    "SELECT COALESCE(MAX(filename),'none') FROM \`${DB_NAME}\`.schema_migrations" 2>/dev/null || echo unknown)

WARNING: this archive contains DATA_ENCRYPTION_KEY, EMAIL_INDEX_KEY, application
integration secrets, and possibly root-owned cloud-backup credentials. Treat it
as equivalent to the full customer database in plaintext. Store it encrypted and
separately from its recovery passphrase or access controls.
MANIFEST

(cd "$STAGING" && sha256sum ./* > SHA256SUMS 2>/dev/null || true)

# ---------------------------------------------------------------------------
# Package
# ---------------------------------------------------------------------------
ARCHIVE="${OUTPUT_DIR}/readypackets-${TIMESTAMP}.tar.gz"
log "Writing ${ARCHIVE}"
tar -C "$STAGING" -czf "$ARCHIVE" .
chmod 0600 "$ARCHIVE"

# Verify the archive that will be retained or synchronized, not merely the
# source staging files. A corrupt backup must never be reported as successful.
gzip -t "$ARCHIVE"
tar -tzf "$ARCHIVE" >/dev/null
tar --no-same-owner --no-same-permissions -C "$VERIFY_STAGING" -xzf "$ARCHIVE"
(cd "$VERIFY_STAGING" && sha256sum -c --ignore-missing --quiet SHA256SUMS) \
  || die "Archive self-verification failed; no backup was retained or synchronized."
log "Archive structure and checksums verified"

if [[ "$ENCRYPT" == "true" ]]; then
  if command -v age >/dev/null 2>&1 && [[ -n "${RP_AGE_RECIPIENT:-}" ]]; then
    log "Encrypting with age"
    age -r "$RP_AGE_RECIPIENT" -o "${ARCHIVE}.age" "$ARCHIVE"
    shred -u "$ARCHIVE" 2>/dev/null || rm -f "$ARCHIVE"
    ARCHIVE="${ARCHIVE}.age"
  elif command -v gpg >/dev/null 2>&1 && [[ -n "$GPG_RECIPIENT" ]]; then
    log "Encrypting with gpg for ${GPG_RECIPIENT}"
    gpg --batch --yes --trust-model always --encrypt \
        --recipient "$GPG_RECIPIENT" --output "${ARCHIVE}.gpg" "$ARCHIVE"
    shred -u "$ARCHIVE" 2>/dev/null || rm -f "$ARCHIVE"
    ARCHIVE="${ARCHIVE}.gpg"
  else
    warn "Encryption requested but neither age (RP_AGE_RECIPIENT) nor gpg (--recipient) is available; the archive is unencrypted."
  fi
fi

chmod 0600 "$ARCHIVE"

# ---------------------------------------------------------------------------
# Optional multi-cloud synchronization
# ---------------------------------------------------------------------------
# Each non-comment line in the root-owned targets file has this form:
# Provider label|rclone-remote:destination/path
# The rclone remote must be provisioned by an administrator outside the web app,
# keeping cloud credentials out of application pages and browser storage.
if [[ "$SKIP_SYNC" == "false" && -r "$SYNC_TARGETS_FILE" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    while IFS='|' read -r provider destination; do
      provider="${provider#${provider%%[![:space:]]*}}"; provider="${provider%${provider##*[![:space:]]}}"
      destination="${destination#${destination%%[![:space:]]*}}"; destination="${destination%${destination##*[![:space:]]}}"
      [[ -n "$provider" && -n "$destination" && "${provider:0:1}" != "#" ]] || continue
      log "Syncing backup to ${provider}"
      if ! rclone copyto "$ARCHIVE" "${destination%/}/$(basename "$ARCHIVE")" --checksum --retries 3 --low-level-retries 3; then
        warn "Cloud sync failed for ${provider}; local archive remains available."
      fi
    done < "$SYNC_TARGETS_FILE"
  else
    warn "Cloud backup targets are configured but rclone is not installed; skipped remote sync."
  fi
fi

# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------
log "Removing archives older than ${RETENTION_DAYS} days"
find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'readypackets-*.tar.gz*' \
  -mtime "+${RETENTION_DAYS}" -print -delete || true

REMAINING="$(find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'readypackets-*' | wc -l)"

BACKUP_STATUS="completed"
log "Backup complete: ${ARCHIVE} ($(numfmt --to=iec "$(stat -c '%s' "$ARCHIVE")")), ${REMAINING} archive(s) retained"

# A backup that has never been restored is not a backup. Restore into a scratch
# database periodically:  ./restore.sh --archive <file> --database rp_restore_test
