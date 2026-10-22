#!/usr/bin/env bash
# ReadyPackets Portal — exact legacy combined-platform migration runner.
#
# This break-glass migration is intentionally limited to the known restored
# all-in-one ReadyPackets release 9f608821df78b3d003a349606390fa2b8340ac99.
# It upgrades that release in place to one reviewed immutable current release
# while retaining the old canonical hostname and complete protected runtime
# configuration. It does not change DNS, TLS provider, portal hostname, or
# external integrations. The later beta hostname cutover is a separate,
# administrator-approved action after acceptance testing.
#
# It is not a general updater, a fresh installer, or a moving-branch deployment.
# It refuses unexpected source, schema, hostname, storage, or environment state.
#
# Usage:
#   sudo bash migrate-legacy-combined-platform.sh --check --commit <40-hex-sha>
#   sudo bash migrate-legacy-combined-platform.sh --commit <40-hex-sha>
set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
readonly DEFAULT_BRANCH="main"
readonly LEGACY_RELEASE_COMMIT="9f608821df78b3d003a349606390fa2b8340ac99"
readonly LEGACY_MIGRATION_COUNT="48"
readonly TARGET_MIGRATION_COUNT="54"
readonly APP_USER="readypackets"
readonly APP_DIR="/opt/readypackets"
readonly DATA_DIR="/var/lib/readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"
readonly SOURCE_CANDIDATES=("/srv/readypackets" "/home/ubuntu/src/readypackets")
readonly SERVICE="readypackets"
readonly BACKUP_TIMER="readypackets-backup.timer"
readonly BACKUP_ROOT="/var/backups/readypackets/legacy-combined-migrations"
readonly WORK_ROOT="/run/readypackets-legacy-migrations"
readonly LOCK_FILE="${WORK_ROOT}/legacy-combined-migration.lock"
readonly AUDIT_ROOT="/var/log/readypackets/legacy-migrations"
readonly NGINX_DEFAULT_SITE="/etc/nginx/sites-enabled/default"
readonly TLS_INCLUDE="/etc/readypackets/tls/nginx-tls.conf"
readonly NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"
readonly NGINX_CONF_D="/etc/nginx/conf.d"
readonly SHA_RE='^[a-f0-9]{40}$'
readonly BRANCH_RE='^[A-Za-z0-9._/-]{1,128}$'
readonly HOST_RE='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'

TARGET_COMMIT=""
BRANCH="$DEFAULT_BRANCH"
CHECK_ONLY="false"
SOURCE_DIR=""
DOMAIN=""
DB_NAME=""
PORT="3000"
STORAGE_DRIVER="local"
SNAPSHOT=""
WORK_DIR=""
AUDIT_FILE=""
AUDIT_MIRROR_FILE=""
NGINX_DIAGNOSTIC_FILE=""
RUN_ID="legacy-combined-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
MUTATION_STARTED="false"
UPDATE_SUCCEEDED="false"
TIMER_WAS_ENABLED="false"

log() { printf '\n[ReadyPackets legacy migration] %s\n' "$*"; }
warn() { printf '\n[ReadyPackets legacy migration warning] %s\n' "$*" >&2; }
fail() { printf '\n[ReadyPackets legacy migration error] %s\n' "$*" >&2; exit 1; }

# This structured local audit trail contains only allowlisted operation metadata:
# run id, event name, result, commit prefix, and snapshot basename. It never
# emits runtime configuration, customer data, passwords, tokens, or file paths.
audit() {
  local event="$1" result="${2:-ok}" detail="${3:-none}" now
  [[ "$event" =~ ^[a-z0-9_.-]{1,80}$ ]] || event="invalid_event"
  [[ "$result" =~ ^[a-z0-9_.-]{1,32}$ ]] || result="invalid_result"
  [[ "$detail" =~ ^[A-Za-z0-9._:/=-]{1,180}$ ]] || detail="redacted"
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [[ -n "$AUDIT_FILE" ]]; then
    printf '{"timestamp":"%s","run":"%s","event":"%s","result":"%s","detail":"%s"}\n' \
      "$now" "$RUN_ID" "$event" "$result" "$detail" >> "$AUDIT_FILE"
  fi
  if [[ -n "$AUDIT_MIRROR_FILE" ]]; then
    printf '{"timestamp":"%s","run":"%s","event":"%s","result":"%s","detail":"%s"}\n' \
      "$now" "$RUN_ID" "$event" "$result" "$detail" >> "$AUDIT_MIRROR_FILE"
  fi
  logger -p authpriv.notice -t readypackets-legacy-migration -- \
    "run=${RUN_ID} event=${event} result=${result} detail=${detail}" 2>/dev/null || true
}

usage() {
  cat <<'USAGE'
ReadyPackets exact legacy combined-platform migration runner

Usage:
  sudo bash migrate-legacy-combined-platform.sh --check --commit <40-hex-sha> [--branch main]
  sudo bash migrate-legacy-combined-platform.sh --commit <40-hex-sha> [--branch main]

This root-only migration accepts only the restored ReadyPackets legacy release
9f608821df78b3d003a349606390fa2b8340ac99 with its 48-migration ledger. It
requires a reviewed immutable target SHA that is currently the exact tip of the
selected temporary-public source branch. It preserves the existing hostname and
protected portal.env byte-for-byte, creates a verified full backup plus a
root-only rollback snapshot, pauses customer traffic and scheduled side effects,
checks non-secret account/order/file counters, and rolls back automatically if
any validation fails.

--check performs read-only compatibility checks only. It does not create logs,
backups, source staging, files, databases, service changes, or network writes.
USAGE
}

valid_hostname() {
  [[ "$1" =~ $HOST_RE ]]
}

runtime_env_value() {
  local key="$1"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "Invalid protected environment key request."
  # portal.env is shell-compatible, so grep/xargs would corrupt valid quoted
  # values. Load it only from a root-owned non-writable regular file into an
  # isolated child, then print precisely one fixed, non-secret topology value.
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/bash -c '
    set -a
    . "$1"
    set +a
    key="$2"
    printf "%s" "${!key-}"
  ' bash "$ENV_FILE" "$key"
}

safe_copy_tree() {
  local source="$1" destination="$2"
  rm -rf -- "$destination"
  install -d -m 0700 -o root -g root "$destination"
  cp -a -- "$source/." "$destination/"
}

snapshot_path() {
  local source="$1" destination="${SNAPSHOT}/host${1}"
  [[ -e "$source" || -L "$source" ]] || return 0
  install -d -m 0700 -o root -g root "$(dirname "$destination")"
  cp -a -- "$source" "$destination"
}

restore_path() {
  local target="$1" source="${SNAPSHOT}/host${1}"
  rm -rf -- "$target"
  [[ -e "$source" || -L "$source" ]] || return 0
  mkdir -p -- "$(dirname "$target")"
  cp -a -- "$source" "$target"
}

host_artifact_paths() {
  cat <<'PATHS'
/etc/nginx/sites-available/readypackets
/etc/nginx/sites-enabled/readypackets
/etc/nginx/sites-enabled/default
/etc/readypackets/maintenance-mode.conf
/etc/readypackets/tls
/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
/etc/fail2ban/jail.d/readypackets.local
/etc/logrotate.d/readypackets
/etc/mysql/mysql.conf.d/zz-readypackets.cnf
/etc/systemd/system/readypackets.service
/etc/systemd/system/readypackets.service.d/legacy-migration.conf
/etc/systemd/system/readypackets-backup.service
/etc/systemd/system/readypackets-backup-control.service
/etc/systemd/system/readypackets-certificate-control.service
/etc/systemd/system/readypackets-platform-update-control.service
/etc/systemd/system/readypackets-backup.timer
/usr/local/sbin/readypackets-backup
/usr/local/sbin/readypackets-backup-control
/usr/local/sbin/readypackets-recovery-history
/usr/local/sbin/readypackets-scoped-recovery
/usr/local/sbin/readypackets-platform-update
/usr/local/sbin/readypackets-auto-deploy-approved
/usr/local/lib/readypackets/certificate-control-daemon.mjs
PATHS
}

readiness_check() {
  local attempt response=""
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if systemctl is-active --quiet "$SERVICE"; then
      response="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time 5 \
        -H "Host: ${DOMAIN}" -H 'X-Forwarded-Proto: https' \
        "http://127.0.0.1:${PORT}/api/health/ready" 2>/dev/null || true)"
      if [[ "$response" == *'"ready"'* ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

preflight_effective_nginx_topology() {
  # This narrow legacy transition replaces the only enabled ReadyPackets site.
  # Do not guess how a custom Nginx graph will select a TLS vhost: fail before
  # backup/mutation if another enabled site, conf.d snippet, loopback-specific
  # listener, error_page 503 handler, or nonstandard systemd configuration can
  # make the local proof reach a different response path.
  local effective_config extra_sites extra_conf tls_control_directives nginx_exec_start
  [[ -d "$NGINX_SITES_ENABLED" && -d "$NGINX_CONF_D" ]] \
    || fail "The expected Nginx site directories are unavailable; do not alter this host automatically."
  [[ -L "${NGINX_SITES_ENABLED}/readypackets" ]] \
    || fail "The active ReadyPackets Nginx site link is unavailable; do not alter this host automatically."
  extra_sites="$(find "$NGINX_SITES_ENABLED" -mindepth 1 -maxdepth 1 ! -name readypackets -printf '%f\n' 2>/dev/null)"
  [[ -z "$extra_sites" ]] \
    || fail "Additional enabled Nginx sites are present; do not alter this host automatically."
  extra_conf="$(find "$NGINX_CONF_D" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' 2>/dev/null)"
  [[ -z "$extra_conf" ]] \
    || fail "Additional Nginx conf.d snippets are present; do not alter this host automatically."
  nginx_exec_start="$(systemctl show nginx --property=ExecStart --value 2>/dev/null || true)"
  [[ "$nginx_exec_start" != *" -c "* ]] \
    || fail "Nginx uses a nonstandard configuration path; do not alter this host automatically."
  effective_config="$(nginx -T 2>&1)" \
    || fail "The active Nginx configuration is invalid; do not alter this host automatically."
  grep -Fq "# configuration file ${NGINX_SITES_ENABLED}/readypackets:" <<<"$effective_config" \
    || fail "The active Nginx graph does not load the ReadyPackets site link; do not alter this host automatically."
  if awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*listen[[:space:]]+(127\.0\.0\.1|\[::1\]):443([[:space:];]|$)/ { found=1 }
    END { exit(found ? 0 : 1) }
  ' <<<"$effective_config"; then
    fail "Nginx has a loopback-specific TLS listener; do not alter this host automatically."
  fi
  if awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*error_page[[:space:]].*(^|[[:space:]])503([[:space:];]|$)/ { found=1 }
    END { exit(found ? 0 : 1) }
  ' <<<"$effective_config"; then
    fail "Nginx has a 503 error-page handler; do not alter this host automatically."
  fi
  tls_control_directives="$(awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    /^[[:space:]]*(return|rewrite|error_page|proxy_pass|location|server|listen|if|include)([[:space:];]|$)/ { print $1 }
  ' "$TLS_INCLUDE")"
  [[ -z "$tls_control_directives" ]] \
    || fail "The retained TLS include contains request-routing controls; do not alter this host automatically."
}

verify_edge_maintenance_gate() {
  # A graceful reload can briefly leave an old worker serving the old proxy
  # generation. Restarting Nginx after a successful syntax check retires that
  # generation; require two consecutive fresh loopback TLS requests to return
  # the static gate before source/schema mutation begins.
  local attempt http_status="000" curl_status=0 probe_metadata="" consecutive=0 probe_classification="unexpected_status"
  if ! systemctl restart nginx >>"$NGINX_DIAGNOSTIC_FILE" 2>&1; then
    audit "maintenance_gate.nginx_restart" "failed" "diagnostic=retained"
    fail "Nginx could not restart the validated temporary maintenance configuration; protected migration diagnostics were retained."
  fi
  systemctl is-active --quiet nginx \
    || { audit "maintenance_gate.nginx_restart" "failed" "state=inactive"; fail "Nginx is not active after the temporary maintenance restart."; }
  audit "maintenance_gate.nginx_restart" "ok" "state=active"
  for ((attempt = 1; attempt <= 12; attempt++)); do
    curl_status=0
    probe_metadata="$(curl -q --noproxy '*' --insecure --silent --show-error \
      --connect-timeout 2 --max-time 8 --output /dev/null --write-out '%{http_code}' \
      --resolve "${DOMAIN}:443:127.0.0.1" -H "Host: ${DOMAIN}" \
      "https://${DOMAIN}/" 2>>"$NGINX_DIAGNOSTIC_FILE")" || curl_status=$?
    http_status="$probe_metadata"
    [[ "$http_status" =~ ^[0-9]{3}$ ]] || http_status="000"
    if [[ "$http_status" == "503" && "$curl_status" == "0" ]]; then
      consecutive=$((consecutive + 1))
      if (( consecutive >= 2 )); then
        audit "maintenance_gate.edge_probe" "ok" "class=maintenance/http=503/attempt=${attempt}"
        return 0
      fi
    else
      consecutive=0
      case "${http_status}/${curl_status}" in
        000/*) probe_classification="connect_or_tls" ;;
        421/0) probe_classification="host_guard" ;;
        308/0) probe_classification="redirect" ;;
        502/0) probe_classification="wrong_vhost_or_error_handler" ;;
        *) probe_classification="unexpected_status" ;;
      esac
    fi
    sleep 1
  done
  audit "maintenance_gate.edge_probe" "failed" "class=${probe_classification}/http=${http_status}/curl=${curl_status}"
  fail "The temporary edge maintenance gate did not return two consecutive HTTP 503 responses for ordinary traffic."
}

prepare_edge_maintenance_gate() {
  # The old proxy configuration does not know about the current maintenance
  # include. Install a minimal, validated target-derived configuration before
  # the new Node service can start; otherwise a short source-install window
  # could expose an app that is still migrating. The domain is preflighted as a
  # hostname and this runner only permits its exact historic apex/www pair.
  local alternate server_names app_regex rendered_app_regex expected_host_guard temporary_site default_target certificate hostname
  [[ -f "$WORK_DIR/source/deploy/nginx.conf" ]] || fail "The reviewed Nginx template is unavailable."
  audit "maintenance_gate.tls" "checking" "state=include"
  if [[ ! -f "$TLS_INCLUDE" ]]; then
    audit "maintenance_gate.tls" "failed" "state=include_missing"
    fail "The existing TLS include is missing; do not alter this restored host automatically."
  fi
  certificate="$(awk '$1 == "ssl_certificate" { gsub(/;/, "", $2); print $2; exit }' "$TLS_INCLUDE")"
  if [[ -z "$certificate" || ! -f "$certificate" ]]; then
    audit "maintenance_gate.tls" "failed" "state=certificate_unavailable"
    fail "The retained TLS include does not identify a readable certificate; do not alter this restored host automatically."
  fi
  if [[ "$DOMAIN" == "readypackets.com" ]]; then
    alternate="www.readypackets.com"
  else
    alternate="readypackets.com"
  fi
  for hostname in "$DOMAIN" "$alternate"; do
    if ! openssl x509 -in "$certificate" -noout -checkhost "$hostname" 2>/dev/null | grep -q 'does match certificate'; then
      audit "maintenance_gate.tls" "failed" "state=coverage_missing"
      fail "The retained certificate does not cover ${hostname}; do not alter this restored host automatically."
    fi
  done
  audit "maintenance_gate.tls" "ok" "coverage=canonical_and_alias"

  # The target template explicitly owns default HTTP/HTTPS servers. A stock
  # Ubuntu default link would cause nginx -t to reject a duplicate default
  # server. It is already included in the pre-mutation snapshot; remove only
  # the known distro symlink, never an arbitrary extra vhost.
  audit "maintenance_gate.default_site" "checking" "state=probe"
  if [[ -e "$NGINX_DEFAULT_SITE" || -L "$NGINX_DEFAULT_SITE" ]]; then
    if [[ ! -L "$NGINX_DEFAULT_SITE" ]]; then
      audit "maintenance_gate.default_site" "failed" "state=not_symlink"
      fail "The Nginx default-site path is not a symlink; do not alter this restored host automatically."
    fi
    default_target="$(readlink "$NGINX_DEFAULT_SITE")"
    if [[ "$default_target" != "/etc/nginx/sites-available/default" && "$default_target" != "../sites-available/default" ]]; then
      audit "maintenance_gate.default_site" "failed" "state=unexpected_target"
      fail "The Nginx default-site symlink has an unexpected target; do not alter this restored host automatically."
    fi
    rm -f -- "$NGINX_DEFAULT_SITE"
    audit "maintenance_gate.default_site" "ok" "state=removed_ubuntu_default"
  else
    audit "maintenance_gate.default_site" "ok" "state=absent"
  fi
  server_names="${DOMAIN} ${alternate}"
  app_regex="${DOMAIN//./\\\\.}"
  # `app_regex` contains two backslashes for sed so the rendered Nginx file
  # receives one literal backslash before each dot. Assert the final host guard
  # before reload; do not weaken it to wildcard dots merely to make a probe pass.
  rendered_app_regex="${DOMAIN//./\\.}"
  expected_host_guard="    if (\$host !~* ^(${rendered_app_regex})\$) {"
  temporary_site="/etc/nginx/sites-available/readypackets.legacy-maintenance.$$"
  cat > /etc/readypackets/maintenance-mode.conf <<'MAINTENANCE'
# Controlled ReadyPackets maintenance mode. All edge requests return 503.
# The migration runner verifies application readiness through the direct
# loopback Node listener, never through public Nginx while this gate is set.
return 503;
MAINTENANCE
  chown root:root /etc/readypackets/maintenance-mode.conf
  chmod 0640 /etc/readypackets/maintenance-mode.conf
  audit "maintenance_gate.include" "ok" "state=written"
  sed \
    -e "s|__RP_HTTP_SERVER_NAMES__|${server_names}|g" \
    -e "s|__RP_CANONICAL_DOMAIN__|${DOMAIN}|g" \
    -e "s|__RP_PORTAL_ALIAS_SERVER_NAMES__|${alternate}|g" \
    -e "s|__RP_APP_SERVER_NAMES__|${DOMAIN}|g" \
    -e "s|__RP_APP_HOST_REGEX__|${app_regex}|g" \
    -e 's|# __RP_MORE_CLEAR_HEADERS__|# headers-more module is intentionally not required for the temporary maintenance gate.|g' \
    "$WORK_DIR/source/deploy/nginx.conf" > "$temporary_site"
  if grep -q '__RP_' "$temporary_site"; then
    audit "maintenance_gate.render" "failed" "state=placeholder"
    fail "The temporary Nginx maintenance configuration contains an unresolved placeholder."
  fi
  if ! grep -Fqx "$expected_host_guard" "$temporary_site"; then
    audit "maintenance_gate.render" "failed" "state=host_guard"
    fail "The temporary Nginx maintenance configuration does not contain the expected canonical host guard."
  fi
  chown root:root "$temporary_site"
  chmod 0644 "$temporary_site"
  mv -f -- "$temporary_site" /etc/nginx/sites-available/readypackets
  ln -sfn /etc/nginx/sites-available/readypackets /etc/nginx/sites-enabled/readypackets
  audit "maintenance_gate.render" "ok" "state=complete"
  NGINX_DIAGNOSTIC_FILE="${AUDIT_ROOT}/${RUN_ID}.nginx-gate.log"
  install -m 0600 -o root -g root /dev/null "$NGINX_DIAGNOSTIC_FILE"
  if ! nginx -t >"$NGINX_DIAGNOSTIC_FILE" 2>&1; then
    audit "maintenance_gate.nginx_test" "failed" "diagnostic=retained"
    fail "Nginx rejected the temporary maintenance configuration; protected migration diagnostics were retained."
  fi
  audit "maintenance_gate.nginx_test" "ok" "state=passed"
  verify_edge_maintenance_gate
}

capture_preservation_counts() {
  local destination="$1"
  mysql --protocol=socket -u root --batch --skip-column-names "$DB_NAME" <<'SQL' > "$destination"
SELECT CONCAT('users=', COUNT(*)) FROM users;
SELECT CONCAT('admin_users=', COUNT(*)) FROM users WHERE role = 'admin';
SELECT CONCAT('password_hashes=', COUNT(*)) FROM users WHERE password_hash IS NOT NULL AND password_hash <> '';
SELECT CONCAT('orders=', COUNT(*)) FROM orders;
SELECT CONCAT('file_records=', COUNT(*)) FROM files;
SQL
  [[ "$(wc -l < "$destination")" -eq 5 ]] || fail "Could not record the required non-secret preservation counters."
  grep -Eq '^users=[0-9]+$' "$destination" \
    && grep -Eq '^admin_users=[0-9]+$' "$destination" \
    && grep -Eq '^password_hashes=[0-9]+$' "$destination" \
    && grep -Eq '^orders=[0-9]+$' "$destination" \
    && grep -Eq '^file_records=[0-9]+$' "$destination" \
    || fail "The preservation counters have an unexpected format."
  chmod 0600 "$destination"
}

write_snapshot() {
  local timestamp path
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  SNAPSHOT="${BACKUP_ROOT}/${timestamp}-legacy-${TARGET_COMMIT:0:12}"
  install -d -m 0700 -o root -g root "$BACKUP_ROOT" "$SNAPSHOT"

  # The application service is already stopped and its timer disabled before
  # this function runs, so database, storage, and environment form one
  # quiescent rollback point.
  safe_copy_tree "$APP_DIR" "${SNAPSHOT}/app"
  safe_copy_tree "$SOURCE_DIR" "${SNAPSHOT}/source"
  safe_copy_tree "$DATA_DIR" "${SNAPSHOT}/data"
  cp -a -- "$ENV_FILE" "${SNAPSHOT}/portal.env"
  while IFS= read -r path; do
    snapshot_path "$path"
  done < <(host_artifact_paths)
  host_artifact_paths > "${SNAPSHOT}/host-paths.txt"
  printf '%s\n' "$TIMER_WAS_ENABLED" > "${SNAPSHOT}/backup-timer-was-enabled"
  capture_preservation_counts "${SNAPSHOT}/preservation-counts.before"
  mysqldump --single-transaction --routines --events -u root "$DB_NAME" | gzip -9 > "${SNAPSHOT}/database.sql.gz"
  [[ -s "${SNAPSHOT}/database.sql.gz" ]] || fail "The root-only rollback database dump is empty."
  sha256sum "${SNAPSHOT}/database.sql.gz" "${SNAPSHOT}/portal.env" "${SNAPSHOT}/preservation-counts.before" > "${SNAPSHOT}/SHA256SUMS"
  cat > "${SNAPSHOT}/MANIFEST.txt" <<MANIFEST
ReadyPackets exact legacy combined-platform rollback snapshot
Created: ${timestamp}
Source release: ${LEGACY_RELEASE_COMMIT}
Target release: ${TARGET_COMMIT}
Canonical host retained: ${DOMAIN}
Database: ${DB_NAME}
Storage mutation contract: application data is restored from the protected data snapshot on rollback.
Audit run: ${RUN_ID}
MANIFEST
  chmod 0600 "${SNAPSHOT}/database.sql.gz" "${SNAPSHOT}/host-paths.txt" \
    "${SNAPSHOT}/backup-timer-was-enabled" "${SNAPSHOT}/SHA256SUMS" \
    "${SNAPSHOT}/MANIFEST.txt"
  # Keep the allowlisted migration audit with the retained recovery snapshot.
  # The live journal/log directory may be rotated or cleared after a host reboot;
  # the snapshot is the durable recovery evidence for a failed mutation.
  AUDIT_MIRROR_FILE="${SNAPSHOT}/migration-audit.jsonl"
  cp -- "$AUDIT_FILE" "$AUDIT_MIRROR_FILE"
  chown root:root "$AUDIT_MIRROR_FILE"
  chmod 0600 "$AUDIT_MIRROR_FILE"
}

create_verified_full_backup() {
  local backup_dir="${SNAPSHOT}/verified-full-backup"
  [[ -x "${SOURCE_DIR}/deploy/backup.sh" ]] || fail "The exact legacy backup helper is unavailable."
  install -d -m 0700 -o root -g root "$backup_dir"
  log "Creating a verified full backup from the restored legacy release."
  # --skip-sync avoids duplicate provider writes during the controlled change
  # window. The verified archive remains root-only inside the migration snapshot.
  bash "${SOURCE_DIR}/deploy/backup.sh" --output "$backup_dir" --skip-sync
  local archive
  archive="$(find "$backup_dir" -maxdepth 1 -type f -name 'readypackets-*.tar.gz*' -printf '%f\n' | sort | tail -n1)"
  [[ -n "$archive" && -s "${backup_dir}/${archive}" ]] || fail "The legacy full backup did not produce a verified archive."
  printf '%s\n' "$archive" > "${SNAPSHOT}/verified-full-backup-name"
  chmod 0600 "${SNAPSHOT}/verified-full-backup-name"
}

set_timer_paused() {
  if systemctl is-enabled --quiet "$BACKUP_TIMER"; then
    TIMER_WAS_ENABLED="true"
    systemctl disable --now "$BACKUP_TIMER"
  else
    TIMER_WAS_ENABLED="false"
    systemctl stop "$BACKUP_TIMER" >/dev/null 2>&1 || true
  fi
}

restore_timer_state() {
  local prior="false"
  [[ -r "${SNAPSHOT}/backup-timer-was-enabled" ]] && prior="$(tr -d '\r\n' < "${SNAPSHOT}/backup-timer-was-enabled")"
  if [[ "$prior" == "true" ]]; then
    systemctl enable --now "$BACKUP_TIMER" || true
  else
    systemctl disable --now "$BACKUP_TIMER" >/dev/null 2>&1 || true
  fi
}

install_scheduler_hold() {
  install -d -m 0755 -o root -g root /etc/systemd/system/readypackets.service.d
  cat > /etc/systemd/system/readypackets.service.d/legacy-migration.conf <<'UNIT'
# Managed only by migrate-legacy-combined-platform.sh.
# Keep the restored beta host web-only until preservation checks complete.
[Service]
Environment=INSTANCE_ROLE=web
UNIT
  chown root:root /etc/systemd/system/readypackets.service.d/legacy-migration.conf
  chmod 0644 /etc/systemd/system/readypackets.service.d/legacy-migration.conf
  systemctl daemon-reload
}

remove_scheduler_hold() {
  rm -f /etc/systemd/system/readypackets.service.d/legacy-migration.conf
  rmdir /etc/systemd/system/readypackets.service.d 2>/dev/null || true
  systemctl daemon-reload
}

restore_snapshot() {
  [[ -n "$SNAPSHOT" && -d "$SNAPSHOT" ]] || return 0
  warn "Migration failed; restoring the protected pre-upgrade application, database, data, configuration, and host snapshot."
  audit "rollback.started" "attempt" "snapshot=$(basename "$SNAPSHOT")"
  trap - ERR INT TERM EXIT
  systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  safe_copy_tree "${SNAPSHOT}/app" "$APP_DIR"
  safe_copy_tree "${SNAPSHOT}/source" "$SOURCE_DIR"
  safe_copy_tree "${SNAPSHOT}/data" "$DATA_DIR"
  cp -a -- "${SNAPSHOT}/portal.env" "$ENV_FILE"
  local path
  while IFS= read -r path; do
    [[ "$path" == /* ]] || fail "The rollback snapshot contains an invalid host-artifact path."
    restore_path "$path"
  done < "${SNAPSHOT}/host-paths.txt"
  gunzip -c "${SNAPSHOT}/database.sql.gz" | mysql --protocol=socket -u root "$DB_NAME"
  systemctl daemon-reload
  if [[ -e /etc/nginx/sites-available/readypackets ]]; then
    nginx -t && systemctl reload nginx
  fi
  systemctl restart readypackets-backup-control.service >/dev/null 2>&1 || true
  systemctl restart readypackets-certificate-control.service >/dev/null 2>&1 || true
  systemctl restart readypackets-platform-update-control.service >/dev/null 2>&1 || true
  restore_timer_state
  systemctl start "$SERVICE"
  if readiness_check; then
    audit "rollback.completed" "ok" "snapshot=$(basename "$SNAPSHOT")"
    warn "Rollback completed and local readiness is healthy. The protected snapshot was retained."
  else
    audit "rollback.completed" "readiness_failed" "snapshot=$(basename "$SNAPSHOT")"
    warn "Rollback was attempted but local readiness did not pass. Review the protected migration audit journal immediately."
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$MUTATION_STARTED" == "true" && "$UPDATE_SUCCEEDED" != "true" ]]; then
    if [[ -n "$SNAPSHOT" && -n "$NGINX_DIAGNOSTIC_FILE" && -f "$NGINX_DIAGNOSTIC_FILE" ]]; then
      cp -a -- "$NGINX_DIAGNOSTIC_FILE" "${SNAPSHOT}/nginx-gate-diagnostic.log"
      chown root:root "${SNAPSHOT}/nginx-gate-diagnostic.log"
      chmod 0600 "${SNAPSHOT}/nginx-gate-diagnostic.log"
    fi
    restore_snapshot || true
  fi
  [[ -n "$WORK_DIR" ]] && rm -rf -- "$WORK_DIR"
  if [[ "$status" -eq 0 ]]; then
    audit "migration.exit" "ok" "target=${TARGET_COMMIT:0:12}"
  else
    audit "migration.exit" "failed" "target=${TARGET_COMMIT:0:12}"
  fi
  exit "$status"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --commit) TARGET_COMMIT="${2:-}"; shift 2 ;;
      --branch) BRANCH="${2:-}"; shift 2 ;;
      --check) CHECK_ONLY="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  [[ "$TARGET_COMMIT" =~ $SHA_RE ]] || fail "--commit must be a reviewed 40-character lowercase Git SHA."
  [[ "$BRANCH" =~ $BRANCH_RE ]] || fail "--branch is invalid."
}

preflight_existing_host() {
  [[ $EUID -eq 0 ]] || fail "Run this migration runner as root with sudo."
  [[ -d "$APP_DIR" && -d "$DATA_DIR" ]] || fail "The native ReadyPackets application or data directory is missing."
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "The protected ReadyPackets environment file is missing or not regular."
  [[ "$(stat -c '%U' "$ENV_FILE")" == "root" ]] || fail "The protected environment file is not root-owned."
  local env_mode
  env_mode="$(stat -c '%a' "$ENV_FILE")"
  (( (8#$env_mode & 0022) == 0 )) || fail "The protected environment file is group- or world-writable."
  systemctl cat "$SERVICE" >/dev/null 2>&1 || fail "The native readypackets.service is not installed."
  id "$APP_USER" >/dev/null 2>&1 || fail "The ReadyPackets service account is unavailable."
  command -v git >/dev/null 2>&1 || fail "git is required."
  command -v node >/dev/null 2>&1 || fail "Node.js is required."
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required."
  command -v mysql >/dev/null 2>&1 || fail "mysql client is required."
  command -v mysqldump >/dev/null 2>&1 || fail "mysqldump is required."
  command -v nginx >/dev/null 2>&1 || fail "nginx is required."
  command -v flock >/dev/null 2>&1 || fail "flock is required."

  local candidate app_url portal_only aliases current_source_commit release_marker migration_count
  for candidate in "${SOURCE_CANDIDATES[@]}"; do
    [[ -d "$candidate/.git" && -f "$candidate/deploy/install.sh" ]] || continue
    SOURCE_DIR="$candidate"
    break
  done
  [[ -n "$SOURCE_DIR" ]] || fail "The expected restored native source checkout is missing."
  current_source_commit="$(git -C "$SOURCE_DIR" rev-parse --verify HEAD 2>/dev/null || true)"
  [[ "$current_source_commit" == "$LEGACY_RELEASE_COMMIT" ]] \
    || fail "This runner supports only source release ${LEGACY_RELEASE_COMMIT}; found a different source revision."
  [[ -z "$(git -C "$SOURCE_DIR" status --porcelain)" ]] \
    || fail "The restored legacy source checkout contains local changes. Restore a clean snapshot or use a reviewed migration plan."
  release_marker="$(tr -d '\r\n' < "${APP_DIR}/RELEASE_COMMIT" 2>/dev/null || true)"
  [[ "$release_marker" == "$LEGACY_RELEASE_COMMIT" ]] \
    || fail "This runner requires the matching ${APP_DIR}/RELEASE_COMMIT marker for the exact legacy release."

  app_url="$(runtime_env_value APP_URL)"
  DOMAIN="${app_url#https://}"
  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN%%/*}"
  valid_hostname "$DOMAIN" || fail "APP_URL does not contain a valid hostname."
  [[ "$DOMAIN" == "readypackets.com" || "$DOMAIN" == "www.readypackets.com" ]] \
    || fail "This runner is restricted to the restored all-in-one readypackets.com/www.readypackets.com host."
  portal_only="$(runtime_env_value PORTAL_ONLY)"
  [[ -z "$portal_only" || "$portal_only" == "false" ]] \
    || fail "This host already has portal-only topology; use the standard controlled updater instead."
  aliases="$(runtime_env_value PORTAL_ALIASES)"
  [[ -z "$aliases" ]] || fail "The legacy combined-host migration requires no configured portal aliases."
  STORAGE_DRIVER="$(runtime_env_value STORAGE_DRIVER)"
  STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
  [[ "$STORAGE_DRIVER" == "local" ]] \
    || fail "This exact runner supports only the restored local-storage legacy topology. Use a full restore rehearsal for object storage."
  [[ -d "${DATA_DIR}/storage" ]] || fail "The local upload storage directory is missing."
  DB_NAME="$(runtime_env_value DB_NAME)"
  [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "The protected DB_NAME is missing or invalid."
  PORT="$(runtime_env_value PORT)"
  PORT="${PORT:-3000}"
  [[ "$PORT" =~ ^[0-9]{2,5}$ && "$PORT" -le 65535 ]] || fail "The protected PORT is invalid."
  mysql --protocol=socket -u root "$DB_NAME" -NBe 'SELECT 1' >/dev/null \
    || fail "The configured database is not reachable through the local root socket."
  migration_count="$(mysql --protocol=socket -u root "$DB_NAME" -NBe 'SELECT COUNT(*) FROM schema_migrations' 2>/dev/null || true)"
  [[ "$migration_count" == "$LEGACY_MIGRATION_COUNT" ]] \
    || fail "This runner requires the exact ${LEGACY_MIGRATION_COUNT}-migration legacy ledger; found ${migration_count:-unavailable}."
  mysql --protocol=socket -u root "$DB_NAME" -NBe "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('users','orders','files')" \
    | grep -qx '3' || fail "The legacy user/order/file schema evidence is incomplete."
  preflight_effective_nginx_topology
}

ensure_snapshot_capacity() {
  local required_kb free_kb
  required_kb="$(( ( $(du -sk "$APP_DIR" "$SOURCE_DIR" "$DATA_DIR" | awk '{total += $1} END {print total + 0}') * 2 ) + 2097152 ))"
  free_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}')"
  [[ "$free_kb" =~ ^[0-9]+$ && "$free_kb" -ge "$required_kb" ]] \
    || fail "Insufficient free space for two protected data copies plus a 2 GiB database safety margin. Free space before retrying."
}

fetch_and_validate_release() {
  install -d -m 0710 -o root -g "$APP_USER" "$WORK_ROOT"
  chown root:"$APP_USER" "$WORK_ROOT"
  chmod 0710 "$WORK_ROOT"
  WORK_DIR="$(mktemp -d "${WORK_ROOT}/stage.XXXXXXXX")"
  chown root:"$APP_USER" "$WORK_DIR"
  chmod 0710 "$WORK_DIR"

  log "Checking temporary-public source access and immutable branch approval."
  local remote_branch resolved validation_dir migration_files
  remote_branch="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "https://github.com/${REPOSITORY}.git" "refs/heads/${BRANCH}" | awk 'NR == 1 { print $1 }')"
  [[ "$remote_branch" =~ $SHA_RE ]] || fail "${REPOSITORY}@${BRANCH} is not anonymously readable. Temporarily make only the reviewed source available, then retry."
  [[ "$remote_branch" == "$TARGET_COMMIT" ]] || fail "The branch tip changed after review. Refusing to deploy a different release."
  git init "$WORK_DIR/source" >/dev/null
  git -C "$WORK_DIR/source" remote add origin "https://github.com/${REPOSITORY}.git"
  GIT_TERMINAL_PROMPT=0 git -C "$WORK_DIR/source" fetch --depth=1 origin "$TARGET_COMMIT"
  resolved="$(git -C "$WORK_DIR/source" rev-parse FETCH_HEAD)"
  [[ "$resolved" == "$TARGET_COMMIT" ]] || fail "Downloaded source does not match the reviewed immutable target SHA."
  git -C "$WORK_DIR/source" checkout --detach --force "$resolved" >/dev/null
  [[ -z "$(git -C "$WORK_DIR/source" status --porcelain)" ]] || fail "The immutable staged source is unexpectedly modified."
  for required in deploy/install.sh deploy/backup.sh deploy/verify-public-connectivity.sh scripts/migrate.ts scripts/schemaContract.ts; do
    [[ -f "$WORK_DIR/source/$required" ]] || fail "The reviewed target is missing required release file: $required"
  done
  migration_files="$(find "$WORK_DIR/source/drizzle/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l)"
  [[ "$migration_files" == "$TARGET_MIGRATION_COUNT" ]] || fail "The reviewed target does not contain the expected ${TARGET_MIGRATION_COUNT}-migration baseline."
  grep -q -- '--allow-legacy-combined-host-transition' "$WORK_DIR/source/deploy/install.sh" \
    || fail "The reviewed target lacks the restricted legacy transition gate."
  grep -q -- '--maintenance-mode' "$WORK_DIR/source/deploy/install.sh" \
    || fail "The reviewed target lacks the controlled maintenance gate."

  log "Validating the immutable target without using the live database."
  validation_dir="$WORK_DIR/validation"
  install -d -m 0710 -o root -g "$APP_USER" "$validation_dir"
  cp -a -- "$WORK_DIR/source/." "$validation_dir/"
  chown -R "$APP_USER:$APP_USER" "$validation_dir"
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$validation_dir/home"
  runuser -u "$APP_USER" -- test -x "$WORK_ROOT" \
    || fail "The service account cannot traverse the protected validation parent."
  runuser -u "$APP_USER" -- test -x "$WORK_DIR" \
    || fail "The service account cannot traverse the staged target source."
  runuser -u "$APP_USER" -- env HOME="$validation_dir/home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    bash -c 'set -Eeuo pipefail
      cd "$1"
      pnpm install --frozen-lockfile
      pnpm run typecheck
      mapfile -t tests < <(find tests -maxdepth 1 -type f -name "*.test.ts" ! -name "domain.test.ts" | sort)
      pnpm exec vitest run "${tests[@]}"
      pnpm run build
    ' bash "$validation_dir"
  bash -n "$WORK_DIR/source/deploy/install.sh"
  bash -n "$WORK_DIR/source/deploy/migrate-legacy-combined-platform.sh"
  node --check "$WORK_DIR/source/deploy/platform-update-control-daemon.mjs"
  rm -rf -- "$validation_dir"
}

apply_migration() {
  MUTATION_STARTED="true"
  install -d -m 0700 -o root -g root "$BACKUP_ROOT" "$AUDIT_ROOT"
  AUDIT_FILE="${AUDIT_ROOT}/${RUN_ID}.jsonl"
  install -m 0600 -o root -g root /dev/null "$AUDIT_FILE"
  audit "migration.started" "ok" "target=${TARGET_COMMIT:0:12}"

  log "Pausing the backup timer and draining the legacy Portal before the consistency snapshot."
  set_timer_paused
  systemctl stop "$SERVICE"
  # The service stop is the write-freeze boundary. Record the baseline only now,
  # so the before/after counters represent the same customer-data point.
  install -d -m 0700 -o root -g root "$BACKUP_ROOT"
  ensure_snapshot_capacity
  write_snapshot
  audit "snapshot.created" "ok" "snapshot=$(basename "$SNAPSHOT")"
  create_verified_full_backup
  audit "full_backup.verified" "ok" "snapshot=$(basename "$SNAPSHOT")"

  prepare_edge_maintenance_gate
  audit "maintenance_gate.enabled" "ok" "canonical=${DOMAIN}"
  install_scheduler_hold
  log "Applying the reviewed target inside maintenance mode; external jobs remain disabled."
  safe_copy_tree "$WORK_DIR/source" "$SOURCE_DIR"
  cd "$SOURCE_DIR"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/install.sh \
    --domain "$DOMAIN" \
    --no-seed \
    --preserve-runtime-config \
    --allow-legacy-combined-host-transition \
    --maintenance-mode < /dev/null
  printf '%s\n' "$TARGET_COMMIT" > "${APP_DIR}/RELEASE_COMMIT"
  chown root:"$APP_USER" "${APP_DIR}/RELEASE_COMMIT"
  chmod 0640 "${APP_DIR}/RELEASE_COMMIT"
  readiness_check || fail "The maintenance-mode target did not pass local readiness."

  capture_preservation_counts "${SNAPSHOT}/preservation-counts.after"
  cmp -s "${SNAPSHOT}/preservation-counts.before" "${SNAPSHOT}/preservation-counts.after" \
    || fail "User, administrator, password-hash, order, or file-record counts changed during migration; automatic rollback will run."
  local migration_count
  migration_count="$(mysql --protocol=socket -u root "$DB_NAME" -NBe 'SELECT COUNT(*) FROM schema_migrations')"
  [[ "$migration_count" == "$TARGET_MIGRATION_COUNT" ]] \
    || fail "The target migration ledger is incomplete after install; automatic rollback will run."
  audit "preservation.verified" "ok" "schema=${migration_count}"

  # The first controlled installer run enabled the Nginx maintenance gate and
  # held the scheduler. Only after all count/schema/readiness checks pass do we
  # remove both gates. Do not invoke the installer a second time: it could reload
  # Nginx and reopen traffic before its later controller/backup steps complete.
  remove_scheduler_hold
  systemctl restart "$SERVICE"
  readiness_check || fail "The normal-operation target did not pass local readiness."
  cat > /etc/readypackets/maintenance-mode.conf <<'MAINTENANCE'
# ReadyPackets normal operation. This root-owned include is intentionally blank.
MAINTENANCE
  chown root:root /etc/readypackets/maintenance-mode.conf
  chmod 0640 /etc/readypackets/maintenance-mode.conf
  nginx -t
  systemctl reload nginx
  UPDATE_SUCCEEDED="true"
  restore_timer_state
  audit "migration.completed" "ok" "snapshot=$(basename "$SNAPSHOT")"
}

main() {
  parse_args "$@"
  preflight_existing_host

  cat <<PLAN
ReadyPackets exact legacy combined-platform migration review
============================================================
Restored source:    ${LEGACY_RELEASE_COMMIT}
Target source:      ${TARGET_COMMIT}
Source branch:      ${BRANCH}
Canonical host:     https://${DOMAIN} (retained; beta is a separate later cutover)
Storage topology:   ${STORAGE_DRIVER}
Database:           ${DB_NAME}
Schema transition:  ${LEGACY_MIGRATION_COUNT} -> ${TARGET_MIGRATION_COUNT} forward-only migrations
Safety controls:    read-only legacy fingerprint gate, immutable SHA gate,
                    full verified backup, root-only app/source/data/database/
                    configuration/TLS rollback snapshot, traffic maintenance gate,
                    scheduler hold, non-secret preservation counters, and
                    automatic rollback on any failed gate.
PLAN

  if [[ "$CHECK_ONLY" == "true" ]]; then
    printf '\nRead-only compatibility check passed. No VPS state was changed.\n'
    return 0
  fi
  [[ -t 0 && -t 1 ]] || fail "Run from an interactive root console; the typed migration confirmation cannot be supplied noninteractively."
  local confirmation=""
  read -r -p "Type MIGRATE LEGACY READY PACKETS to apply this exact reviewed release: " confirmation
  [[ "$confirmation" == "MIGRATE LEGACY READY PACKETS" ]] \
    || fail "Confirmation did not match; no changes were made."

  install -d -m 0710 -o root -g "$APP_USER" "$WORK_ROOT"
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another ReadyPackets legacy migration, update, or rollback is already running."
  trap on_exit EXIT
  fetch_and_validate_release
  apply_migration

  cat <<SUMMARY

ReadyPackets legacy combined-platform migration completed.
  Installed source:  ${TARGET_COMMIT}
  Canonical host:    https://${DOMAIN} (retained for validation)
  Full backup:       ${SNAPSHOT}/verified-full-backup
  Rollback snapshot: ${SNAPSHOT}
  Audit record:      ${AUDIT_FILE}

Search the redacted structured migration journal with:
  journalctl -t readypackets-legacy-migration --since "today" | grep "run=${RUN_ID}"

Do not change the hostname yet. Validate administrator MFA, customer sign-in,
orders, representative protected downloads, and integrations on the retained
host first. Only then use Admin → System → Domain & URL for the separately
approved beta.readypackets.com cutover.
SUMMARY
}

main "$@"
