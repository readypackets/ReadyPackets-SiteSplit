#!/usr/bin/env bash
# ReadyPackets backup operations control plane. Invoked only by the root-owned
# fixed-action socket daemon; it never accepts shell fragments or paths.
set -Eeuo pipefail
umask 077

APP_ROOT="${RP_APP_ROOT:-/opt/readypackets}"
BACKUP_DIR="${RP_BACKUP_DIR:-/var/backups/readypackets}"
EXPORT_DIR="${RP_EXPORT_DIR:-/var/lib/readypackets/storage/admin-exports}"
CONFIG_IMPORT_DIR="${RP_CONFIG_IMPORT_DIR:-/var/lib/readypackets/storage/config-restore-imports}"
BACKUP_IMPORT_DIR="${RP_BACKUP_IMPORT_DIR:-/var/lib/readypackets/storage/backup-restore-imports}"
TARGETS_FILE="${RP_BACKUP_SYNC_TARGETS_FILE:-/etc/readypackets/backup-sync-targets.conf}"
STATE_DIR="${RP_BACKUP_CONTROL_STATE_DIR:-/var/lib/readypackets/backup-control}"
RESTORE_STATUS_FILE="${RP_BACKUP_RESTORE_STATUS_FILE:-${STATE_DIR}/restore-status.conf}"
RECOVERY_HISTORY_FILE="${RP_RECOVERY_HISTORY_FILE:-${STATE_DIR}/recovery-history.jsonl}"
TIMER_UNIT="readypackets-backup.timer"
SERVICE_UNIT="readypackets-backup.service"

[[ "$(id -u)" -eq 0 ]] || { echo "Must run as root" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemctl is unavailable" >&2; exit 1; }
# The controller is deliberately denied CAP_CHOWN. These fixed paths are
# provisioned by the installer (and by the backup service pre-start hook), then
# only verified here. Repeating `install -d -m` inside the sandbox invokes a
# chmod syscall even when the directory exists, which systemd correctly rejects.
verify_fixed_directory() {
  local directory="$1" expected="$2"
  [[ -d "$directory" ]] || { echo "Required protected directory is missing: $directory. Re-run the ReadyPackets installer or backup-control repair as root." >&2; exit 1; }
  [[ "$(stat -c '%U:%G:%a' "$directory")" == "$expected" ]] || {
    echo "Protected directory has unsafe ownership or permissions: $directory. Re-run the ReadyPackets installer or backup-control repair as root." >&2
    exit 1
  }
}
verify_fixed_directory "$BACKUP_DIR" "root:readypackets:2750"
verify_fixed_directory "$EXPORT_DIR" "root:readypackets:2750"
verify_fixed_directory "$STATE_DIR" "root:root:700"
# shellcheck disable=SC1090
source "$APP_ROOT/deploy/recovery-history.sh"
# These two staging directories are created by the root installer. The daemon
# intentionally runs without CAP_CHOWN, so it must never attempt an ownership
# change on every browser request. The service group needs write/traverse but
# not directory listing access (0730).
for restore_dir in "$CONFIG_IMPORT_DIR" "$BACKUP_IMPORT_DIR"; do
  [[ -d "$restore_dir" ]] || { echo "Required restore staging directory is missing: $restore_dir" >&2; exit 1; }
  [[ "$(stat -c '%U:%G' "$restore_dir")" == "root:readypackets" && "$(stat -c '%a' "$restore_dir")" == "730" ]] || {
    echo "Restore staging directory has unsafe ownership or permissions: $restore_dir" >&2
    exit 1
  }
done

safe_name() {
  [[ "$1" =~ ^readypackets-[0-9TZ-]+\.tar\.gz(\.age|\.gpg)?$ ]] || { echo "Invalid backup filename" >&2; exit 1; }
}

safe_config_export_name() {
  [[ "$1" =~ ^readypackets-config-github-secrets-[0-9TZ-]+\.rpconfig$ ]] || { echo "Invalid protected configuration export filename" >&2; exit 1; }
}

safe_scoped_recovery_name() {
  [[ "$1" =~ ^readypackets-(identities|orders)-recovery-[0-9TZ-]+\.rprecovery$ ]] || { echo "Invalid scoped recovery filename" >&2; exit 1; }
}

safe_scoped_recovery_import_name() {
  [[ "$1" =~ ^rprecovery-import-[a-f0-9]{32}\.rprecovery$ ]] || { echo "Invalid scoped recovery import filename" >&2; exit 1; }
}

safe_recovery_scope() {
  [[ "$1" == "identities" || "$1" == "orders" ]] || { echo "Invalid scoped recovery type" >&2; exit 1; }
}

safe_config_import_name() {
  [[ "$1" =~ ^rpconfig-import-[a-f0-9]{32}\.rpconfig$ ]] || { echo "Invalid protected configuration import filename" >&2; exit 1; }
}

safe_backup_import_name() {
  [[ "$1" =~ ^rpbackup-import-[a-f0-9]{32}\.tar\.gz$ ]] || { echo "Invalid protected backup import filename" >&2; exit 1; }
}

read_recovery_passphrase() {
  local passphrase
  IFS= read -r passphrase || true
  [[ ${#passphrase} -ge 16 && ${#passphrase} -le 512 && "$passphrase" != *$'\n'* && "$passphrase" != *$'\r'* ]] || { echo "Recovery passphrase is invalid" >&2; exit 1; }
  printf '%s' "$passphrase"
}

export_scoped_recovery() {
  local scope="$1" passphrase passfile output
  safe_recovery_scope "$scope"
  passphrase="$(read_recovery_passphrase)"
  passfile="$(mktemp)"; trap 'rm -f "$passfile"' RETURN
  printf '%s\n' "$passphrase" > "$passfile"; chmod 0600 "$passfile"
  output="$EXPORT_DIR/readypackets-${scope}-recovery-$(date -u +%Y%m%dT%H%M%SZ).rprecovery"
  RP_APP_ROOT="$APP_ROOT" RP_EXPORT_DIR="$EXPORT_DIR" bash "$APP_ROOT/deploy/scoped-recovery.sh" export "$scope" "$output" "$passfile" >/dev/null
  chmod 0640 "$output"
  basename "$output"
}

inspect_scoped_recovery_import() {
  local scope="$1" filename="$2" passphrase passfile
  safe_recovery_scope "$scope"; safe_scoped_recovery_import_name "$filename"
  [[ -f "$BACKUP_IMPORT_DIR/$filename" ]] || { echo "Scoped recovery upload was not found or has expired" >&2; exit 1; }
  passphrase="$(read_recovery_passphrase)"
  passfile="$(mktemp)"; trap 'rm -f "$passfile"' RETURN
  printf '%s\n' "$passphrase" > "$passfile"; chmod 0600 "$passfile"
  RP_APP_ROOT="$APP_ROOT" RP_IMPORT_DIR="$BACKUP_IMPORT_DIR" bash "$APP_ROOT/deploy/scoped-recovery.sh" inspect "$scope" "$BACKUP_IMPORT_DIR/$filename" "$passfile"
}

restore_scoped_recovery_import() {
  local scope="$1" filename="$2" passphrase confirmation passfile restart_unit
  safe_recovery_scope "$scope"; safe_scoped_recovery_import_name "$filename"
  [[ -f "$BACKUP_IMPORT_DIR/$filename" ]] || { echo "Scoped recovery upload was not found or has expired" >&2; exit 1; }
  IFS= read -r passphrase || true
  IFS= read -r confirmation || true
  [[ ${#passphrase} -ge 16 && ${#passphrase} -le 512 && "$passphrase" != *$'\n'* && "$passphrase" != *$'\r'* ]] || { echo "Recovery passphrase is invalid" >&2; exit 1; }
  [[ "$confirmation" == "RESTORE ${scope^^} RECOVERY" ]] || { echo "Type RESTORE ${scope^^} RECOVERY to confirm this scoped recovery" >&2; exit 1; }
  passfile="$(mktemp)"; trap 'rm -f "$passfile" "$BACKUP_IMPORT_DIR/$filename"' RETURN
  printf '%s\n' "$passphrase" > "$passfile"; chmod 0600 "$passfile"
  RP_APP_ROOT="$APP_ROOT" RP_IMPORT_DIR="$BACKUP_IMPORT_DIR" bash "$APP_ROOT/deploy/scoped-recovery.sh" restore "$scope" "$BACKUP_IMPORT_DIR/$filename" "$passfile" >/dev/null
  printf 'restored=true\nscope=%s\n' "$scope"
}

read_config_import_passphrase() {
  local passphrase
  IFS= read -r passphrase || true
  [[ ${#passphrase} -ge 16 && ${#passphrase} -le 512 && "$passphrase" != *$'\n'* && "$passphrase" != *$'\r'* ]] || { echo "Configuration restore passphrase is invalid" >&2; exit 1; }
  printf '%s' "$passphrase"
}

inspect_config_import() {
  local filename="$1" passphrase passfile
  safe_config_import_name "$filename"
  [[ -f "$CONFIG_IMPORT_DIR/$filename" ]] || { echo "Configuration restore upload was not found or has expired" >&2; exit 1; }
  passphrase="$(read_config_import_passphrase)"
  passfile="$(mktemp)"; trap 'rm -f "$passfile"' RETURN
  printf '%s\n' "$passphrase" > "$passfile"; chmod 0600 "$passfile"
  RP_APP_ROOT="$APP_ROOT" bash "$APP_ROOT/deploy/config-migration.sh" inspect --input "$CONFIG_IMPORT_DIR/$filename" --passphrase-file "$passfile" --manifest-only
}

restore_config_import() {
  local filename="$1" passphrase confirmation passfile restart_unit
  safe_config_import_name "$filename"
  [[ -f "$CONFIG_IMPORT_DIR/$filename" ]] || { echo "Configuration restore upload was not found or has expired" >&2; exit 1; }
  IFS= read -r passphrase || true
  IFS= read -r confirmation || true
  [[ ${#passphrase} -ge 16 && ${#passphrase} -le 512 && "$passphrase" != *$'\n'* && "$passphrase" != *$'\r'* ]] || { echo "Configuration restore passphrase is invalid" >&2; exit 1; }
  [[ "$confirmation" == "RESTORE CONFIGURATION" ]] || { echo "Type RESTORE CONFIGURATION to confirm the settings restore" >&2; exit 1; }
  passfile="$(mktemp)"; trap 'rm -f "$passfile" "$CONFIG_IMPORT_DIR/$filename"' RETURN
  printf '%s\n' "$passphrase" > "$passfile"; chmod 0600 "$passfile"
  RP_APP_ROOT="$APP_ROOT" bash "$APP_ROOT/deploy/config-migration.sh" import --input "$CONFIG_IMPORT_DIR/$filename" --passphrase-file "$passfile" --replace-config --force --no-restart >/dev/null
  restart_unit="readypackets-config-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  systemd-run --unit "$restart_unit" --collect --on-active=5s /bin/systemctl restart readypackets >/dev/null
  printf 'unit=%s\nstatus=applied\n' "$restart_unit"
}

archive_path() {
  safe_name "$1"
  local path="$BACKUP_DIR/$1"
  [[ -f "$path" ]] || { echo "Backup archive not found" >&2; exit 1; }
  printf '%s\n' "$path"
}

json_escape() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

validate_archive_members() {
  local source="$1" member normalized type
  while IFS= read -r member; do
    normalized="${member#./}"
    [[ -n "$normalized" ]] || continue
    [[ "$normalized" =~ ^(database\.sql|MANIFEST\.txt|SHA256SUMS|storage\.tar|platform-runtime\.tar|portal\.env)$ ]] || { echo "Archive contains an unsupported member" >&2; return 1; }
  done < <(tar -tzf "$source")
  while IFS= read -r type; do
    [[ "$type" == "-" || "$type" == "d" ]] || { echo "Archive contains links or unsupported member types" >&2; return 1; }
  done < <(tar -tvzf "$source" | awk '{print substr($1,1,1)}')
}

verify_archive_source() {
  local source="$1" filename="$2" staging
  [[ "$source" == *.tar.gz ]] || { echo "Browser verification supports unencrypted .tar.gz archives. Verify encrypted archives through the protected host restore procedure." >&2; exit 1; }
  validate_archive_members "$source"
  staging="$(mktemp -d /tmp/rp-archive-check.XXXXXXXX)"
  trap "rm -rf -- '$staging'" RETURN
  # Verification needs only content and checksums; preserving root ownership is
  # unnecessary and prohibited by the daemon's hardened syscall policy.
  tar --no-same-owner --no-same-permissions -C "$staging" -xzf "$source"
  [[ -s "$staging/database.sql" ]] || { echo "Archive is missing database.sql" >&2; exit 1; }
  [[ -f "$staging/MANIFEST.txt" ]] || { echo "Archive is missing MANIFEST.txt" >&2; exit 1; }
  if [[ -f "$staging/SHA256SUMS" ]]; then
    (cd "$staging" && sha256sum -c --ignore-missing --quiet SHA256SUMS) || { echo "Archive checksum verification failed" >&2; exit 1; }
  fi
  local dump_bytes has_files
  dump_bytes="$(stat -c '%s' "$staging/database.sql")"
  [[ "$dump_bytes" -gt 1024 ]] || { echo "Archive database dump is suspiciously small" >&2; exit 1; }
  has_files="false"; [[ -f "$staging/storage.tar" ]] && has_files="true"
  printf 'verified=true\narchive=%s\ndatabase_bytes=%s\nincludes_files=%s\n' "$filename" "$dump_bytes" "$has_files"
}

verify_archive() {
  local filename="$1"
  verify_archive_source "$(archive_path "$filename")" "$filename"
}

inspect_archive_import() {
  local filename="$1" source
  safe_backup_import_name "$filename"
  source="$BACKUP_IMPORT_DIR/$filename"
  [[ -f "$source" ]] || { echo "Backup restore upload was not found or has expired" >&2; exit 1; }
  verify_archive_source "$source" "$filename"
}

start_restore_import() {
  local filename="$1" source confirmation destination unit
  safe_backup_import_name "$filename"
  source="$BACKUP_IMPORT_DIR/$filename"
  [[ -f "$source" ]] || { echo "Backup restore upload was not found or has expired" >&2; exit 1; }
  confirmation="$(head -n 1 | tr -d '\r\n')"
  [[ "$confirmation" == "RESTORE BACKUP" ]] || { echo "Type RESTORE BACKUP to confirm production recovery." >&2; exit 1; }
  verify_archive_source "$source" "$filename" >/dev/null
  destination="$BACKUP_DIR/readypackets-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tu4 /dev/urandom | tr -d ' ').tar.gz"
  unit="readypackets-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  # GNU install may invoke chown when run as root. The hardened daemon is
  # intentionally denied CAP_CHOWN, so make a new root-owned copy without
  # ownership preservation and set only its mode inside the fixed backup path.
  if ! cp --no-preserve=mode,ownership "$source" "$destination" || ! chmod 0600 "$destination"; then
    rm -f -- "$destination"
    recovery_history_append restore "$unit" "$(basename "$destination")" portable_full failed "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "Verified uploaded archive could not be staged in protected backup storage."
    echo "Verified uploaded archive could not be staged in protected backup storage." >&2
    exit 1
  fi
  rm -f -- "$source"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$RESTORE_STATUS_FILE" <<EOF
unit=$unit
archive=$(basename "$destination")
mode=portable_full
started=$started_at
EOF
  chmod 0600 "$RESTORE_STATUS_FILE"
  if ! systemd-run --unit "$unit" --collect --property=Type=oneshot --property=Nice=15 --property=IOSchedulingClass=idle \
    "$APP_ROOT/deploy/restore.sh" --archive "$destination" --yes --restore-platform-secrets --history-file "$RECOVERY_HISTORY_FILE" --restore-unit "$unit" --restore-started-at "$started_at" >/dev/null; then
    recovery_history_append restore "$unit" "$(basename "$destination")" portable_full failed "$started_at" "Protected restore job could not be started."
    exit 1
  fi
  recovery_history_append restore "$unit" "$(basename "$destination")" portable_full started "$started_at" "Verified uploaded full-system archive queued; target hostname, TLS, network, database connection, and storage paths will be preserved."
  printf 'unit=%s\narchive=%s\n' "$unit" "$(basename "$destination")"
}

write_remote_config() {
  local remote="$1" body="$2" config_dir="/root/.config/rclone" config="/root/.config/rclone/rclone.conf"
  install -d -m 0700 "$config_dir"
  touch "$config"; chmod 0600 "$config"
  # Deleting a remote by name exposes no secret and lets this write a complete
  # replacement section without placing any credential in an argv string.
  rclone --config "$config" config delete "$remote" >/dev/null 2>&1 || true
  printf '\n[%s]\n%s\n' "$remote" "$body" >> "$config"
  chmod 0600 "$config"
}

configure_remote() {
  local provider="" remote="" destination="" access_key="" secret_key="" region="" endpoint="" account="" key="" client_id="" client_secret="" tenant="" token_b64=""
  while IFS='=' read -r field value; do
    case "$field" in
      provider) provider="$value" ;;
      remote) remote="$value" ;;
      destination) destination="$value" ;;
      access_key) access_key="$value" ;;
      secret_key) secret_key="$value" ;;
      region) region="$value" ;;
      endpoint) endpoint="$value" ;;
      account) account="$value" ;;
      key) key="$value" ;;
      client_id) client_id="$value" ;;
      client_secret) client_secret="$value" ;;
      tenant) tenant="$value" ;;
      token_b64) token_b64="$value" ;;
      "") ;;
      *) echo "Unsupported cloud configuration field" >&2; exit 1 ;;
    esac
  done
  [[ "$provider" =~ ^(Amazon\ S3|Wasabi\ S3|Backblaze\ B2|Azure\ Blob\ Storage|SharePoint|Google\ Drive|OneDrive|Dropbox)$ ]] || { echo "Unsupported backup provider" >&2; exit 1; }
  [[ "$remote" =~ ^[A-Za-z][A-Za-z0-9_-]{1,63}$ ]] || { echo "Remote name must begin with a letter and use letters, numbers, underscore, or hyphen." >&2; exit 1; }
  [[ "$destination" =~ ^[A-Za-z0-9._/-]{0,512}$ && "$destination" != *".."* ]] || { echo "Destination path is invalid." >&2; exit 1; }
  command -v rclone >/dev/null 2>&1 || { echo "rclone is not installed on this server." >&2; exit 1; }
  case "$provider" in
    "Amazon S3"|"Wasabi S3")
      [[ -n "$access_key" && -n "$secret_key" && -n "$region" ]] || { echo "S3-compatible storage requires access key, secret key, and region." >&2; exit 1; }
      local s3_provider="AWS"; [[ "$provider" == "Wasabi S3" ]] && s3_provider="Wasabi"
      write_remote_config "$remote" "type = s3
provider = $s3_provider
env_auth = false
access_key_id = $access_key
secret_access_key = $secret_key
region = $region
endpoint = $endpoint"
      ;;
    "Backblaze B2")
      [[ -n "$account" && -n "$key" ]] || { echo "Backblaze B2 requires key ID and application key." >&2; exit 1; }
      write_remote_config "$remote" "type = b2
account = $account
key = $key"
      ;;
    "Azure Blob Storage")
      [[ -n "$account" && -n "$key" ]] || { echo "Azure Blob Storage requires account name and account key." >&2; exit 1; }
      write_remote_config "$remote" "type = azureblob
account = $account
key = $key
endpoint = $endpoint"
      ;;
    "SharePoint"|"OneDrive")
      [[ -n "$client_id" && -n "$tenant" && -n "$token_b64" ]] || { echo "Microsoft cloud storage requires client ID, tenant ID, and OAuth token JSON." >&2; exit 1; }
      local token; token="$(printf '%s' "$token_b64" | base64 --decode)"
      write_remote_config "$remote" "type = onedrive
client_id = $client_id
client_secret = $client_secret
tenant = $tenant
token = $token
drive_type = business"
      ;;
    "Google Drive")
      [[ -n "$client_id" && -n "$token_b64" ]] || { echo "Google Drive requires client ID and OAuth token JSON." >&2; exit 1; }
      local drive_token; drive_token="$(printf '%s' "$token_b64" | base64 --decode)"
      write_remote_config "$remote" "type = drive
client_id = $client_id
client_secret = $client_secret
token = $drive_token"
      ;;
    "Dropbox")
      [[ -n "$client_id" && -n "$client_secret" && -n "$token_b64" ]] || { echo "Dropbox requires app key, app secret, and OAuth token JSON." >&2; exit 1; }
      local dropbox_token; dropbox_token="$(printf '%s' "$token_b64" | base64 --decode)"
      write_remote_config "$remote" "type = dropbox
client_id = $client_id
client_secret = $client_secret
token = $dropbox_token"
      ;;
  esac
  local target="${remote}:${destination}"
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  [[ -r "$TARGETS_FILE" ]] && grep -Fv "|${target}" "$TARGETS_FILE" > "$tmp" || true
  printf '%s|%s\n' "$provider" "$target" >> "$tmp"
    cat "$tmp" > "$TARGETS_FILE"
    chmod 0640 "$TARGETS_FILE"
  printf 'provider=%s\ndestination=%s\n' "$provider" "$target"
}

test_target() {
  local target="$1"
  [[ "$target" =~ ^[A-Za-z0-9._-]+:.+$ ]] || { echo "Destination must be an rclone remote and path" >&2; exit 1; }
  command -v rclone >/dev/null 2>&1 || { echo "rclone is not installed on this server." >&2; exit 1; }
  rclone lsf "$target" --max-depth 1 --contimeout 10s --timeout 20s --retries 1 >/dev/null
  printf 'reachable=true\ndestination=%s\n' "$target"
}

restore_status() {
  if [[ ! -r "$RESTORE_STATUS_FILE" ]]; then
    printf 'status=idle\n'
    return 0
  fi
  # The state file is written only by this root-owned helper; restrict output to
  # plain metadata fields before it crosses the administrator API boundary.
  local unit archive mode started state result
  unit="$(sed -n 's/^unit=//p' "$RESTORE_STATUS_FILE" | head -n1)"
  archive="$(sed -n 's/^archive=//p' "$RESTORE_STATUS_FILE" | head -n1)"
  mode="$(sed -n 's/^mode=//p' "$RESTORE_STATUS_FILE" | head -n1)"
  started="$(sed -n 's/^started=//p' "$RESTORE_STATUS_FILE" | head -n1)"
  [[ "$unit" =~ ^readypackets-restore-[A-Za-z0-9@._-]+$ ]] || { printf 'status=unknown\n'; return 0; }
  state="$(systemctl show "$unit" -p ActiveState --value 2>/dev/null || true)"
  result="$(systemctl show "$unit" -p Result --value 2>/dev/null || true)"
  printf 'status=%s\nunit=%s\narchive=%s\nmode=%s\nstarted=%s\nresult=%s\n' "${state:-unknown}" "$unit" "$archive" "$mode" "$started" "${result:-unknown}"
}

case "${1:-}" in
  start)
    systemctl start "$SERVICE_UNIT"
    printf '%s\n' '{"ok":true,"message":"Backup job started"}'
    ;;
  status)
    time="$(systemctl show "$TIMER_UNIT" --property=NextElapseUSecRealtime --value 2>/dev/null || true)"
    backup_state="$(systemctl show "$SERVICE_UNIT" --property=ActiveState --value 2>/dev/null || true)"
    backup_result="$(systemctl show "$SERVICE_UNIT" --property=Result --value 2>/dev/null || true)"
    backup_started="$(systemctl show "$SERVICE_UNIT" --property=ActiveEnterTimestamp --value 2>/dev/null || true)"
    backup_finished="$(systemctl show "$SERVICE_UNIT" --property=InactiveEnterTimestamp --value 2>/dev/null || true)"
    printf 'next_run=%s\nbackup_state=%s\nbackup_result=%s\nbackup_started=%s\nbackup_finished=%s\n' "${time:-}" "${backup_state:-unknown}" "${backup_result:-unknown}" "${backup_started:-}" "${backup_finished:-}"
    [[ -r "$TARGETS_FILE" ]] && cat "$TARGETS_FILE" || true
    ;;
  schedule)
    clock="${2:-}"
    [[ "$clock" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "Schedule must use 24-hour HH:MM" >&2; exit 1; }
    install -d -m 0755 "/etc/systemd/system/${TIMER_UNIT}.d"
    cat > "/etc/systemd/system/${TIMER_UNIT}.d/schedule.conf" <<EOF
[Timer]
OnCalendar=
OnCalendar=*-*-* ${clock}:00
RandomizedDelaySec=900
Persistent=true
EOF
    systemctl daemon-reload
    systemctl restart "$TIMER_UNIT"
    printf '%s\n' '{"ok":true,"message":"Backup schedule updated"}'
    ;;
  configure-remote)
    configure_remote
    ;;
  test-target)
    test_target "${2:-}"
    ;;
  configure-targets)
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    cat > "$tmp"
    : > "$TARGETS_FILE"
    while IFS='|' read -r provider destination; do
      provider="${provider#${provider%%[![:space:]]*}}"; provider="${provider%${provider##*[![:space:]]}}"
      destination="${destination#${destination%%[![:space:]]*}}"; destination="${destination%${destination##*[![:space:]]}}"
      [[ -n "$provider" && "$provider" =~ ^[A-Za-z0-9][A-Za-z0-9._[:space:]-]{0,63}$ ]] || { echo "Invalid provider label" >&2; exit 1; }
      [[ "$destination" =~ ^[A-Za-z0-9._-]+:.+$ ]] || { echo "Destination must be an rclone remote and path" >&2; exit 1; }
      printf '%s|%s\n' "$provider" "$destination" >> "$TARGETS_FILE"
    done < "$tmp"
    chmod 0640 "$TARGETS_FILE"
    printf '%s\n' '{"ok":true,"message":"Cloud backup targets updated"}'
    ;;
  verify-archive)
    verify_archive "${2:-}"
    ;;
  start-restore)
    filename="${2:-}"; source="$(archive_path "$filename")"
    confirmation="$(head -n 1 | tr -d '\r\n')"
    [[ "$confirmation" == "RESTORE $filename" ]] || { echo "Type RESTORE $filename to confirm production recovery." >&2; exit 1; }
    unit="readypackets-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat > "$RESTORE_STATUS_FILE" <<EOF
unit=$unit
archive=$filename
mode=portable_full
started=$started_at
EOF
    chmod 0600 "$RESTORE_STATUS_FILE"
    if ! systemd-run --unit "$unit" --collect --property=Type=oneshot --property=Nice=15 --property=IOSchedulingClass=idle \
      "$APP_ROOT/deploy/restore.sh" --archive "$source" --yes --restore-platform-secrets --history-file "$RECOVERY_HISTORY_FILE" --restore-unit "$unit" --restore-started-at "$started_at" >/dev/null; then
      recovery_history_append restore "$unit" "$filename" portable_full failed "$started_at" "Protected restore job could not be started."
      exit 1
    fi
    recovery_history_append restore "$unit" "$filename" portable_full started "$started_at" "Verified full-system archive queued; target hostname, TLS, network, database connection, and storage paths will be preserved."
    printf 'unit=%s\narchive=%s\n' "$unit" "$filename"
    ;;
  restore-status)
    restore_status
    ;;
  recovery-history)
    recovery_history_list
    ;;
  inspect-archive-import)
    inspect_archive_import "${2:-}"
    ;;
  start-restore-import)
    start_restore_import "${2:-}"
    ;;
  inspect-config)
    inspect_config_import "${2:-}"
    ;;
  restore-config)
    restore_config_import "${2:-}"
    ;;
  export-scoped-recovery)
    export_scoped_recovery "${2:-}"
    ;;
  inspect-scoped-recovery-import)
    inspect_scoped_recovery_import "${2:-}" "${3:-}"
    ;;
  restore-scoped-recovery-import)
    restore_scoped_recovery_import "${2:-}" "${3:-}"
    ;;
  export-config|export-config-secrets)
    passphrase="$(head -n 1 | tr -d '\r\n')"
    [[ ${#passphrase} -ge 16 ]] || { echo "Configuration export passphrase must be at least 16 characters" >&2; exit 1; }
    passfile="$(mktemp)"; trap 'rm -f "$passfile"' EXIT
    printf '%s\n' "$passphrase" > "$passfile"; chmod 0600 "$passfile"
    if [[ "$1" == "export-config-secrets" ]]; then
      output="$EXPORT_DIR/readypackets-config-github-secrets-$(date -u +%Y%m%dT%H%M%SZ).rpconfig"
      RP_APP_ROOT="$APP_ROOT" RP_CONFIG_BACKUP_DIR="$EXPORT_DIR" bash "$APP_ROOT/deploy/config-migration.sh" export --output "$output" --passphrase-file "$passfile" --include-secrets >/dev/null
    else
      output="$EXPORT_DIR/readypackets-config-$(date -u +%Y%m%dT%H%M%SZ).rpconfig"
      RP_APP_ROOT="$APP_ROOT" RP_CONFIG_BACKUP_DIR="$EXPORT_DIR" bash "$APP_ROOT/deploy/config-migration.sh" export --output "$output" --passphrase-file "$passfile" >/dev/null
    fi
    chmod 0640 "$output"
    basename "$output"
    ;;
  delete-export)
    filename="${2:-}"; safe_config_export_name "$filename"
    rm -f -- "$EXPORT_DIR/$filename"
    printf 'deleted=%s\n' "$filename"
    ;;
  prepare-download)
    safe_name "${2:-}"
    source="$(archive_path "$2")"
    output="$EXPORT_DIR/$2"
    cp --preserve=mode "$source" "$output"
    chmod 0640 "$output"
    basename "$output"
    ;;
  *)
    echo "Usage: $0 {start|status|schedule HH:MM|configure-remote|test-target DESTINATION|configure-targets|verify-archive FILENAME|start-restore FILENAME|restore-status|recovery-history|export-scoped-recovery identities|orders|inspect-scoped-recovery-import identities|orders FILENAME|restore-scoped-recovery-import identities|orders FILENAME|inspect-config FILENAME|restore-config FILENAME|export-config|export-config-secrets|delete-export FILENAME|prepare-download FILENAME}" >&2
    exit 2
    ;;
esac
