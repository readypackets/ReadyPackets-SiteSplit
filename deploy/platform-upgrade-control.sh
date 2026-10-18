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

load_runtime_config() {
  [[ -r "$ENV_FILE" ]] || fail "ReadyPackets environment file is unavailable."
  local app_url public_site_url configured candidate alias
  app_url="$(env_value APP_URL)"
  RUNTIME_DOMAIN="${app_url#https://}"
  RUNTIME_DOMAIN="${RUNTIME_DOMAIN#http://}"
  RUNTIME_DOMAIN="${RUNTIME_DOMAIN%%/*}"
  [[ "$RUNTIME_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "The active APP_URL does not contain a valid hostname."

  public_site_url="$(env_value PUBLIC_SITE_URL)"
  if [[ -n "$public_site_url" ]]; then
    RUNTIME_PUBLIC_DOMAIN="${public_site_url#https://}"
    RUNTIME_PUBLIC_DOMAIN="${RUNTIME_PUBLIC_DOMAIN#http://}"
    RUNTIME_PUBLIC_DOMAIN="${RUNTIME_PUBLIC_DOMAIN%%/*}"
    [[ "$RUNTIME_PUBLIC_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "The active PUBLIC_SITE_URL does not contain a valid hostname."
    [[ "$RUNTIME_PUBLIC_DOMAIN" == "$RUNTIME_DOMAIN" ]] && RUNTIME_PUBLIC_DOMAIN=""
  fi
  IFS=',' read -r -a RUNTIME_PORTAL_ALIASES <<< "$(env_value PORTAL_ALIASES)"
  for alias in "${RUNTIME_PORTAL_ALIASES[@]}"; do
    [[ -z "$alias" || "$alias" =~ ^[A-Za-z0-9.-]+$ ]] || fail "PORTAL_ALIASES contains an invalid hostname."
  done

  configured="$(env_value RP_SOURCE_DIR)"
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

write_snapshot() {
  local run_id="$1" snapshot="$BACKUP_ROOT/$run_id"
  mkdir -p "$snapshot"
  safe_copy_tree "$APP_DIR" "$snapshot/app"
  safe_copy_tree "$SOURCE_DIR" "$snapshot/source"
  cp -a "$ENV_FILE" "$snapshot/portal.env"
  [[ -f "$APP_DIR/RELEASE_COMMIT" ]] && cp -a "$APP_DIR/RELEASE_COMMIT" "$snapshot/RELEASE_COMMIT" || true
  mysqldump --single-transaction --routines --events -u root readypackets | gzip -9 > "$snapshot/database.sql.gz"
  printf '%s\n' "$snapshot"
}

restore_snapshot() {
  local snapshot="$1"
  [[ -f "$snapshot/database.sql.gz" && -d "$snapshot/app" && -d "$snapshot/source" ]] || fail "Rollback snapshot is incomplete."
  systemctl stop "$SERVICE" || true
  safe_copy_tree "$snapshot/app" "$APP_DIR"
  safe_copy_tree "$snapshot/source" "$SOURCE_DIR"
  cp -a "$snapshot/portal.env" "$ENV_FILE"
  gunzip -c "$snapshot/database.sql.gz" | mysql -u root readypackets
  chown -R root:readypackets "$APP_DIR"
  find "$APP_DIR" -type d -exec chmod 0750 {} +
  find "$APP_DIR" -type f -exec chmod 0640 {} +
  chmod 0750 "$APP_DIR/deploy/install.sh" "$APP_DIR/deploy/platform-upgrade-control.sh" 2>/dev/null || true
  systemctl daemon-reload
  systemctl start "$SERVICE"
  sleep 4
  curl -fsS -H "Host: ${RUNTIME_DOMAIN}" -H 'X-Forwarded-Proto: https' http://127.0.0.1:3000/api/health >/dev/null
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
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
  pnpm run typecheck
  pnpm test
  pnpm run build:client
  pnpm run build:server
  safe_copy_tree "$work" "$SOURCE_DIR"
  cd "$SOURCE_DIR"
  local -a installer_args=(--domain "$RUNTIME_DOMAIN" --skip-packages)
  [[ -n "$RUNTIME_PUBLIC_DOMAIN" ]] && installer_args+=(--public-domain "$RUNTIME_PUBLIC_DOMAIN")
  for alias in "${RUNTIME_PORTAL_ALIASES[@]}"; do
    [[ -n "$alias" ]] && installer_args+=(--portal-alias "$alias")
  done
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/install.sh "${installer_args[@]}" < /dev/null
  printf '%s\n' "$target" > "$APP_DIR/RELEASE_COMMIT"
  chmod 0640 "$APP_DIR/RELEASE_COMMIT"
  chown root:readypackets "$APP_DIR/RELEASE_COMMIT"
  trap - ERR
  printf '{"status":"completed","snapshot":%s,"targetCommit":%s}\n' "$(json_escape "$snapshot")" "$(json_escape "$target")"
}

require_root
load_runtime_config
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
