#!/usr/bin/env bash
# ReadyPackets controlled platform upgrade helper.
# Invoked only through a narrowly scoped sudoers rule by the application account.
# It accepts a GitHub PAT only on stdin, never in an argument, log, or filename.
set -Eeuo pipefail
umask 077

readonly APP_USER="readypackets"
readonly APP_DIR="/opt/readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"
SOURCE_DIR=""
RUNTIME_DOMAIN=""
RUNTIME_PUBLIC_DOMAIN=""
RUNTIME_PORTAL_ALIASES=()
RUNTIME_PORTAL_ONLY="false"
RUNTIME_DB_NAME=""
RUNTIME_PORT="3000"
readonly BACKUP_ROOT="/var/backups/readypackets/platform-upgrades"
readonly WORK_ROOT="/var/lib/readypackets/platform-upgrades"
readonly SERVICE="readypackets"
readonly REPO_RE='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
readonly BRANCH_RE='^[A-Za-z0-9._/-]{1,128}$'
readonly SHA_RE='^[a-f0-9]{40}$'
readonly RUN_RE='^[1-9][0-9]*$'

fail() { printf '%s\n' "$*" >&2; exit 1; }
require_root() { [[ $EUID -eq 0 ]] || fail "This helper must run as root."; }
valid() { [[ "$1" =~ $2 ]] || fail "Invalid $3."; }
json_escape() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

env_value() {
  local key="$1"
  grep -m1 "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true
}

runtime_env_value() {
  local key="$1"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "Invalid protected environment key request."
  # `portal.env` is shell-compatible because it contains safely quoted values.
  # Read one named value in an empty child environment so its assignments cannot
  # shadow this root helper's own path, rollback, or shell-control variables.
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/bash -c '
    set -a
    . "$1"
    set +a
    key="$2"
    printf "%s" "${!key-}"
  ' bash "$ENV_FILE" "$key"
}

load_runtime_config() {
  [[ -r "$ENV_FILE" ]] || fail "ReadyPackets environment file is unavailable."
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" && "$(stat -c '%U' "$ENV_FILE")" == "root" ]] \
    || fail "ReadyPackets environment file is not a root-owned regular file."
  local env_mode
  env_mode="$(stat -c '%a' "$ENV_FILE")"
  (( (8#$env_mode & 0022) == 0 )) || fail "ReadyPackets environment file is group- or world-writable."
  local app_url public_site_url configured candidate alias
  app_url="$(runtime_env_value APP_URL)"
  RUNTIME_DOMAIN="${app_url#https://}"
  RUNTIME_DOMAIN="${RUNTIME_DOMAIN#http://}"
  RUNTIME_DOMAIN="${RUNTIME_DOMAIN%%/*}"
  [[ "$RUNTIME_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "The active APP_URL does not contain a valid hostname."

  public_site_url="$(runtime_env_value PUBLIC_SITE_URL)"
  RUNTIME_PORTAL_ONLY="$(runtime_env_value PORTAL_ONLY)"
  # In the recommended split-site topology PUBLIC_SITE_URL is a navigation-only
  # marketing origin. It must not become a portal nginx/application host during
  # an otherwise unrelated platform update.
  if [[ "$RUNTIME_PORTAL_ONLY" != "true" && -n "$public_site_url" ]]; then
    RUNTIME_PUBLIC_DOMAIN="${public_site_url#https://}"
    RUNTIME_PUBLIC_DOMAIN="${RUNTIME_PUBLIC_DOMAIN#http://}"
    RUNTIME_PUBLIC_DOMAIN="${RUNTIME_PUBLIC_DOMAIN%%/*}"
    [[ "$RUNTIME_PUBLIC_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "The active PUBLIC_SITE_URL does not contain a valid hostname."
    [[ "$RUNTIME_PUBLIC_DOMAIN" == "$RUNTIME_DOMAIN" ]] && RUNTIME_PUBLIC_DOMAIN=""
  fi
  IFS=',' read -r -a RUNTIME_PORTAL_ALIASES <<< "$(runtime_env_value PORTAL_ALIASES)"
  for alias in "${RUNTIME_PORTAL_ALIASES[@]}"; do
    [[ -z "$alias" || "$alias" =~ ^[A-Za-z0-9.-]+$ ]] || fail "PORTAL_ALIASES contains an invalid hostname."
  done

  RUNTIME_DB_NAME="$(runtime_env_value DB_NAME)"
  RUNTIME_PORT="$(runtime_env_value PORT)"
  [[ "$RUNTIME_DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "The configured DB_NAME is invalid."
  RUNTIME_PORT="${RUNTIME_PORT:-3000}"
  [[ "$RUNTIME_PORT" =~ ^[0-9]{2,5}$ && "$RUNTIME_PORT" -le 65535 ]] || fail "The configured PORT is invalid."
  configured="$(runtime_env_value RP_SOURCE_DIR)"
  for candidate in "$configured" /srv/readypackets /home/ubuntu/src/readypackets; do
    [[ -n "$candidate" && -d "$candidate" && -f "$candidate/deploy/install.sh" ]] || continue
    SOURCE_DIR="$candidate"
    break
  done
  [[ -n "$SOURCE_DIR" ]] || fail "ReadyPackets source checkout is unavailable. Re-run deploy/install.sh from the source checkout before enabling platform updates."
}

safe_copy_tree() {
  local source="$1" destination="$2"
  rm -rf "$destination"
  mkdir -p "$destination"
  cp -a "$source/." "$destination/"
}

snapshot_host_path() {
  local source="$1" destination="$2"
  [[ -e "$source" || -L "$source" ]] || return 0
  mkdir -p "$(dirname "$destination")"
  cp -a "$source" "$destination"
}

restore_host_path() {
  local target="$1" source="$2"
  rm -rf "$target"
  [[ -e "$source" || -L "$source" ]] || return 0
  mkdir -p "$(dirname "$target")"
  cp -a "$source" "$target"
}

write_snapshot() {
  local run_id="$1" snapshot="$BACKUP_ROOT/$run_id" path
  local -a host_paths=(
    /etc/nginx/sites-available/readypackets
    /etc/nginx/sites-enabled/readypackets
    /etc/readypackets/tls
    /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    /etc/fail2ban/jail.d/readypackets.local
    /etc/logrotate.d/readypackets
    /etc/mysql/mysql.conf.d/zz-readypackets.cnf
    /etc/systemd/system/readypackets.service
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
  )
  install -d -m 0700 -o root -g root "$snapshot"
  safe_copy_tree "$APP_DIR" "$snapshot/app"
  safe_copy_tree "$SOURCE_DIR" "$snapshot/source"
  cp -a "$ENV_FILE" "$snapshot/portal.env"
  [[ -f "$APP_DIR/RELEASE_COMMIT" ]] && cp -a "$APP_DIR/RELEASE_COMMIT" "$snapshot/RELEASE_COMMIT" || true
  for path in "${host_paths[@]}"; do
    snapshot_host_path "$path" "$snapshot/host${path}"
  done
  printf '%s\n' "${host_paths[@]}" > "$snapshot/host-paths.txt"
  mysqldump --single-transaction --routines --events -u root "$RUNTIME_DB_NAME" | gzip -9 > "$snapshot/database.sql.gz"
  [[ -s "$snapshot/database.sql.gz" ]] || fail "Platform-update database snapshot is empty."
  chmod 0600 "$snapshot/database.sql.gz" "$snapshot/host-paths.txt"
  printf '%s\n' "$snapshot"
}

restore_snapshot() {
  local snapshot="$1" path
  [[ -f "$snapshot/database.sql.gz" && -d "$snapshot/app" && -d "$snapshot/source" ]] || fail "Rollback snapshot is incomplete."
  systemctl stop "$SERVICE" || true
  safe_copy_tree "$snapshot/app" "$APP_DIR"
  safe_copy_tree "$snapshot/source" "$SOURCE_DIR"
  cp -a "$snapshot/portal.env" "$ENV_FILE"
  [[ -r "$snapshot/host-paths.txt" ]] || fail "Rollback snapshot is missing its host-artifact manifest."
  while IFS= read -r path; do
    [[ "$path" == /* ]] || fail "Rollback snapshot contains an invalid host-artifact path."
    restore_host_path "$path" "$snapshot/host${path}"
  done < "$snapshot/host-paths.txt"
  gunzip -c "$snapshot/database.sql.gz" | mysql -u root "$RUNTIME_DB_NAME"
  chown -R root:readypackets "$APP_DIR"
  find "$APP_DIR" -type d -exec chmod 0750 {} +
  find "$APP_DIR" -type f -exec chmod 0640 {} +
  chmod 0750 "$APP_DIR/deploy/install.sh" "$APP_DIR/deploy/platform-upgrade-control.sh" 2>/dev/null || true
  systemctl daemon-reload
  if [[ -e /etc/nginx/sites-available/readypackets ]]; then
    nginx -t && systemctl reload nginx
  fi
  systemctl restart readypackets-backup-control.service || true
  systemctl restart readypackets-certificate-control.service || true
  queue_platform_update_controller_restart || true
  systemctl start "$SERVICE"
  sleep 4
  curl --noproxy '*' -fsS -H "Host: ${RUNTIME_DOMAIN}" -H 'X-Forwarded-Proto: https' "http://127.0.0.1:${RUNTIME_PORT}/api/health/ready" >/dev/null
}

queue_platform_update_controller_restart() {
  # This helper runs under the controller it updates. A synchronous restart would
  # terminate the active request before its audited result reaches the browser.
  # Queue a short root-owned transient unit for immediately after this request.
  systemd-run --quiet --collect --unit="readypackets-platform-update-restart-$$" \
    --on-active=3s /bin/systemctl restart readypackets-platform-update-control.service
}

clone_release() {
  local run_id="$1" repository="$2" branch="$3" target="$4" token="$5"
  local work="$WORK_ROOT/$run_id/source"
  rm -rf "$work"
  mkdir -p "$WORK_ROOT/$run_id"
  local header
  header="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 -w0)"
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$header" \
    git clone --depth 1 --branch "$branch" "https://github.com/${repository}.git" "$work"
  local actual
  actual="$(git -C "$work" rev-parse HEAD)"
  [[ "$actual" == "$target" ]] || fail "Remote branch changed during review; rescan before approval."
  printf '%s\n' "$work"
}

apply_upgrade() {
  local run_id="$1" repository="$2" branch="$3" target="$4" token="$5"
  local snapshot work
  snapshot="$(write_snapshot "$run_id")"
  work="$(clone_release "$run_id" "$repository" "$branch" "$target" "$token")"
  trap 'restore_snapshot "$snapshot" || true' ERR
  cd "$work"
  corepack enable >/dev/null 2>&1 || true
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$WORK/home"
  chown -R "$APP_USER:$APP_USER" "$work"
  runuser -u "$APP_USER" -- env HOME="$WORK/home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    bash -c 'set -Eeuo pipefail; cd "$1"; pnpm install --frozen-lockfile; pnpm run typecheck; pnpm test; pnpm run build' bash "$work"
  bash -n "$work/deploy/install.sh"
  node --check "$work/deploy/platform-update-control-daemon.mjs"
  chown -R root:root "$work"
  safe_copy_tree "$work" "$SOURCE_DIR"
  cd "$SOURCE_DIR"
  local -a installer_args=(--domain "$RUNTIME_DOMAIN" --skip-packages --no-seed --preserve-runtime-config)
  [[ -n "$RUNTIME_PUBLIC_DOMAIN" ]] && installer_args+=(--public-domain "$RUNTIME_PUBLIC_DOMAIN")
  for alias in "${RUNTIME_PORTAL_ALIASES[@]}"; do
    [[ -n "$alias" ]] && installer_args+=(--portal-alias "$alias")
  done
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/install.sh "${installer_args[@]}" < /dev/null
  printf '%s\n' "$target" > "$APP_DIR/RELEASE_COMMIT"
  chmod 0640 "$APP_DIR/RELEASE_COMMIT"
  chown root:readypackets "$APP_DIR/RELEASE_COMMIT"
  queue_platform_update_controller_restart
  trap - ERR
  printf '{"status":"completed","snapshot":%s,"targetCommit":%s}\n' "$(json_escape "$snapshot")" "$(json_escape "$target")"
}

require_root
load_runtime_config
install -d -m 0700 -o root -g root "$BACKUP_ROOT"
install -d -m 0750 -o root -g "$APP_USER" "$WORK_ROOT"
exec 9>"${WORK_ROOT}/platform-update.lock"
flock -n 9 || fail "Another ReadyPackets platform update or rollback is already running."
[[ $# -ge 1 ]] || fail "Usage: status|apply|rollback"
case "$1" in
  status)
    current="unknown"; [[ -f "$APP_DIR/RELEASE_COMMIT" ]] && current="$(tr -d '\n' < "$APP_DIR/RELEASE_COMMIT")"
    printf '{"currentCommit":%s,"serviceActive":%s}\n' "$(json_escape "$current")" "$(systemctl is-active --quiet "$SERVICE" && printf true || printf false)"
    ;;
  apply)
    [[ $# -eq 5 ]] || fail "Usage: apply <run> <repository> <branch> <target-sha>"
    valid "$2" "$RUN_RE" "run id"; valid "$3" "$REPO_RE" "repository"; valid "$4" "$BRANCH_RE" "branch"; valid "$5" "$SHA_RE" "target commit"
    IFS= read -r token || true
    [[ ${#token} -ge 20 ]] || fail "A GitHub token is required."
    apply_upgrade "$2" "$3" "$4" "$5" "$token"
    ;;
  rollback)
    [[ $# -eq 2 ]] || fail "Usage: rollback <run>"
    valid "$2" "$RUN_RE" "run id"
    restore_snapshot "$BACKUP_ROOT/$2"
    printf '{"status":"rolled_back","snapshot":%s}\n' "$(json_escape "$BACKUP_ROOT/$2")"
    ;;
  *) fail "Unsupported action." ;;
esac
