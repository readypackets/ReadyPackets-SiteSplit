#!/usr/bin/env bash
# ReadyPackets Portal — read-only existing-platform inspection helper.
#
# Reports non-secret version and deployment topology evidence to plan a controlled
# upgrade. It never sources portal.env and never prints credentials, private keys,
# customer data, database rows, backup contents, or certificate material.
#
# Usage on the existing host:
#   sudo bash inspect-existing-platform.sh
set -uo pipefail
umask 077
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly SERVICE="readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"
readonly APP_DIR="/opt/readypackets"
readonly DATA_DIR="/var/lib/readypackets"
readonly BACKUP_DIR="/var/backups/readypackets"
readonly MAX_OUTPUT_VALUE=256

safe_text() {
  # Render only printable ASCII so an unexpected legacy config value cannot alter
  # terminal output. This helper intentionally reads only allowlisted non-secret
  # routing/topology assignments without evaluating shell syntax.
  LC_ALL=C tr -cd '\40-\176' | cut -c1-"$MAX_OUTPUT_VALUE"
}

print_value() {
  local label="$1" value="${2:-}"
  [[ -n "$value" ]] || value="unset"
  printf '%-34s %s\n' "$label" "$(printf '%s' "$value" | safe_text)"
}

print_status() {
  local label="$1" command_status="${2:-unknown}"
  printf '%-34s %s\n' "$label" "$command_status"
}

first_existing_directory() {
  local candidate
  for candidate in "$@"; do
    [[ -n "$candidate" && -d "$candidate" ]] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

runtime_env_value() {
  local key="$1" line value
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || return 1
  [[ -r "$ENV_FILE" && ! -L "$ENV_FILE" ]] || return 1
  # Parse exactly one assignment without command substitution/evaluation. Quotes
  # are removed only when the complete value is wrapped by matching outer quotes.
  line="$(grep -m1 -E "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

git_value() {
  local directory="$1" argument="$2"
  git -C "$directory" "$argument" 2>/dev/null || true
}

package_identity() {
  local package_file="$1"
  [[ -r "$package_file" && -x "$(command -v node || true)" ]] || return 0
  node -e '
    const fs = require("fs");
    const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const name = typeof input.name === "string" ? input.name : "unknown";
    const version = typeof input.version === "string" ? input.version : "unknown";
    process.stdout.write(`${name}@${version}`);
  ' "$package_file" 2>/dev/null || true
}

report_unit() {
  local unit="$1" status enabled fragment
  if ! systemctl cat "$unit" >/dev/null 2>&1; then
    print_status "${unit} installed" "no"
    return 0
  fi
  status="$(systemctl is-active "$unit" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  fragment="$(systemctl show "$unit" -p FragmentPath --value 2>/dev/null || true)"
  print_status "${unit} active" "${status:-unknown}"
  print_status "${unit} enabled" "${enabled:-unknown}"
  [[ -n "$fragment" ]] && print_value "${unit} unit path" "$fragment"
}

main() {
  printf '%s\n' 'ReadyPackets existing-platform report (read-only, no secrets)'
  printf '%s\n' '=========================================================='
  print_value "Report time (UTC)" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    print_value "Operating system" "${PRETTY_NAME:-${NAME:-unknown} ${VERSION_ID:-}}"
  fi
  print_value "Kernel" "$(uname -sr 2>/dev/null || true)"
  print_status "Running as root" "$([[ ${EUID:-99999} -eq 0 ]] && echo yes || echo no)"

  printf '\n%s\n' '--- Runtime service ---'
  report_unit "${SERVICE}.service"
  report_unit "${SERVICE}-backup.timer"
  report_unit "${SERVICE}-backup-control.service"
  report_unit "${SERVICE}-certificate-control.service"
  report_unit "${SERVICE}-platform-update-control.service"
  print_status "nginx active" "$(systemctl is-active nginx 2>/dev/null || true)"
  local mysql_status="inactive"
  if systemctl is-active --quiet mysql 2>/dev/null || systemctl is-active --quiet mysqld 2>/dev/null; then
    mysql_status="active"
  fi
  print_status "mysql active" "$mysql_status"

  printf '\n%s\n' '--- Installation layout ---'
  local working_dir=""
  if systemctl cat "${SERVICE}.service" >/dev/null 2>&1; then
    working_dir="$(systemctl show "${SERVICE}.service" -p WorkingDirectory --value 2>/dev/null || true)"
  fi
  local source_dir=""
  source_dir="$(first_existing_directory "$working_dir" /srv/readypackets /home/ubuntu/src/readypackets /home/ubuntu/readypackets "$APP_DIR" || true)"
  print_value "Detected source/application directory" "${source_dir:-not found}"
  print_status "Application directory present" "$([[ -d "$APP_DIR" ]] && echo yes || echo no)"
  print_status "Application data directory present" "$([[ -d "$DATA_DIR" ]] && echo yes || echo no)"
  print_status "Protected runtime environment present" "$([[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] && echo yes || echo no)"
  if [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]]; then
    print_value "Runtime environment owner/mode" "$(stat -c '%U:%G %a' "$ENV_FILE" 2>/dev/null || true)"
  fi

  printf '\n%s\n' '--- Version evidence ---'
  local release_commit=""
  for candidate in "$APP_DIR/RELEASE_COMMIT" "$source_dir/RELEASE_COMMIT"; do
    [[ -n "$candidate" && -r "$candidate" ]] || continue
    release_commit="$(tr -d '\r\n' < "$candidate" | safe_text)"
    [[ -n "$release_commit" ]] && break
  done
  print_value "Installed RELEASE_COMMIT" "${release_commit:-not recorded}"
  if [[ -n "$source_dir" && -d "$source_dir/.git" ]] && git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    print_value "Git HEAD" "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)"
    print_value "Git ref" "$(git -C "$source_dir" symbolic-ref --short -q HEAD 2>/dev/null || echo detached)"
    print_value "Git describe" "$(git -C "$source_dir" describe --tags --always --dirty 2>/dev/null || true)"
    local dirty_count
    dirty_count="$(git -C "$source_dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    print_value "Uncommitted source entries" "${dirty_count:-unknown}"
  else
    print_status "Git checkout detected" "no"
  fi
  local pkg=""
  for candidate in "$APP_DIR/package.json" "$source_dir/package.json"; do
    [[ -n "$candidate" && -r "$candidate" ]] || continue
    pkg="$(package_identity "$candidate")"
    [[ -n "$pkg" ]] && break
  done
  print_value "package.json identity" "${pkg:-not available}"
  if [[ -n "$source_dir" ]]; then
    local migration_dir=""
    migration_dir="$(first_existing_directory "$source_dir/migrations" "$source_dir/deploy/migrations" "$source_dir/drizzle" || true)"
    if [[ -n "$migration_dir" ]]; then
      local migration_count
      migration_count="$(find "$migration_dir" -maxdepth 1 -type f \( -name '*.sql' -o -name '*.ts' \) 2>/dev/null | wc -l | tr -d ' ')"
      print_value "Migration source directory" "$migration_dir"
      print_value "Migration source files" "$migration_count"
    fi
  fi

  printf '\n%s\n' '--- Non-secret routing and topology ---'
  if [[ ${EUID:-99999} -ne 0 ]]; then
    print_status "Runtime topology" "not inspected; rerun with sudo"
  elif [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]]; then
    local key value
    for key in APP_URL PUBLIC_SITE_URL MARKETING_SITE_URL PORTAL_ONLY PORTAL_ALIASES STORAGE_DRIVER INSTANCE_ROLE BEHIND_CLOUDFLARE TRUST_PROXY_HOPS; do
      value="$(runtime_env_value "$key" || true)"
      print_value "$key" "${value:-unset}"
    done
  else
    print_status "Runtime topology" "environment file unavailable"
  fi

  printf '\n%s\n' '--- Upgrade and recovery indicators ---'
  print_status "Controlled platform update helper" "$([[ -x /usr/local/sbin/readypackets-platform-update ]] && echo present || echo absent)"
  print_status "Certificate control helper" "$([[ -e /usr/local/lib/readypackets/certificate-control-daemon.mjs ]] && echo present || echo absent)"
  print_status "Backup control helper" "$([[ -x /usr/local/sbin/readypackets-backup-control ]] && echo present || echo absent)"
  local backup_count=0
  if [[ -d "$BACKUP_DIR" ]]; then
    backup_count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'readypackets-*.tar.gz*' 2>/dev/null | wc -l | tr -d ' ')"
  fi
  print_value "Local full-backup file count" "$backup_count"
  local native_deployment="no"
  if [[ -d "$APP_DIR" && -f "$ENV_FILE" ]] && systemctl cat "${SERVICE}.service" >/dev/null 2>&1; then
    native_deployment="yes"
  fi
  print_status "Native deployment evidence" "$native_deployment"

  printf '\n%s\n' '--- Safe next step ---'
  printf '%s\n' 'Keep this report with the approved change record. Do not share portal.env, backup archives, keys, passwords, tokens, private certificates, or customer/order data.'
  printf '%s\n' 'For a beta migration, determine whether beta must contain existing data. If yes, perform a tested full backup/restore migration with a write-freeze; do not run an untracked in-place installer command.'
}

main "$@"
