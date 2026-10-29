#!/usr/bin/env bash
# ReadyPackets Portal — temporary-public existing-VPS updater.
#
# Applies one reviewed immutable ReadyPackets release to an existing native VPS
# only while the source repository is intentionally public. This is not a fresh
# installer and refuses a host without an existing protected ReadyPackets state.
# It creates a full backup plus a root-only rollback snapshot before it changes
# application, source, systemd, nginx, TLS, or controller material.
#
# Usage:
#   sudo bash temporary-public-existing-vps-upgrade.sh --commit <40-hex-sha>
#
# Never use a branch name in place of --commit. The script also verifies that
# the configured main branch still resolves to that exact reviewed SHA.
set -Eeuo pipefail
umask 077

readonly REPOSITORY="readypackets/ReadyPackets-SiteSplit"
readonly DEFAULT_BRANCH="main"
readonly APP_USER="readypackets"
readonly APP_DIR="/opt/readypackets"
readonly ENV_FILE="/etc/readypackets/portal.env"
readonly DATA_DIR="/var/lib/readypackets"
readonly BACKUP_ROOT="/var/backups/readypackets/manual-upgrades"
# Never stage reviewed source below /var/lib/readypackets: that parent is owned
# by the runtime service and would let a compromised application process race a
# root update. /run is root-owned and automatically clears abandoned staging
# after reboot; the rollback snapshot remains in protected persistent backup.
readonly WORK_ROOT="/run/readypackets-manual-upgrades"
readonly LOCK_FILE="${WORK_ROOT}/manual-upgrade.lock"
readonly SERVICE="readypackets"
readonly SHA_RE='^[a-f0-9]{40}$'
readonly BRANCH_RE='^[A-Za-z0-9._/-]{1,128}$'

COMMIT=""
BRANCH="$DEFAULT_BRANCH"
STAGE_PHASE_WEBHOOK_DEFAULTS="false"
SOURCE_DIR=""
CONFIGURED_SOURCE_DIR=""
DOMAIN=""
PUBLIC_DOMAIN=""
PORTAL_ALIASES=()
DB_NAME=""
PORT="3000"
SNAPSHOT=""
WORK_DIR=""
UPDATE_SUCCEEDED="false"

log() { printf '\n[ReadyPackets existing-VPS upgrade] %s\n' "$*"; }
warn() { printf '\n[ReadyPackets existing-VPS upgrade warning] %s\n' "$*" >&2; }
fail() { printf '\n[ReadyPackets existing-VPS upgrade error] %s\n' "$*" >&2; exit 1; }
audit() { logger -p authpriv.notice -t readypackets-existing-vps-upgrade -- "$*" 2>/dev/null || true; }

usage() {
  cat <<'USAGE'
ReadyPackets Portal temporary-public existing-VPS updater

Usage:
  sudo bash temporary-public-existing-vps-upgrade.sh --commit <40-hex-sha> [--branch main] [--stage-phase-webhook-defaults]

This root-only updater is for an existing native ReadyPackets portal only. It
requires a reviewed immutable commit and a temporarily public source repository.
It refuses fresh hosts, does not accept tokens or secrets, preserves the existing
portal.env unchanged, creates a full backup and protected rollback snapshot, and
rolls back automatically if the upgrade cannot pass readiness.

--stage-phase-webhook-defaults is optional. Only after a successful application
update it invokes the reviewed local helper, which prompts for P101/P201 Make
destinations with hidden terminal input. It never accepts, prints, or logs the
destination URLs and stages non-overriding disabled endpoints only.
USAGE
}

valid_hostname() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]
}

runtime_env_value() {
  local key="$1"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "Invalid protected environment key request."
  # Read each known value in an isolated, minimal environment. The native
  # portal.env supports shell-quoted values, so a naïve grep/xargs parser would
  # corrupt valid configuration. This avoids allowing its assignments to shadow
  # the update controller's own path, commit, or shell-control variables.
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/bash -c '
    set -a
    . "$1"
    set +a
    key="$2"
    printf "%s" "${!key-}"
  ' bash "$ENV_FILE" "$key"
}

source_environment() {
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "No regular ReadyPackets environment file was found at ${ENV_FILE}. This updater will not initialize a fresh host."
  [[ "$(stat -c '%U' "$ENV_FILE")" == "root" ]] || fail "Refusing to load a runtime environment not owned by root."
  local env_mode
  env_mode="$(stat -c '%a' "$ENV_FILE")"
  (( (8#$env_mode & 0022) == 0 )) || fail "Refusing to load a group- or world-writable runtime environment."
  # Never echo its contents: only these fixed non-secret topology values are
  # read, and only derived host/commit/snapshot metadata reaches the audit log.
  local app_url public_site_url portal_only configured_aliases
  app_url="$(runtime_env_value APP_URL)"
  DB_NAME="$(runtime_env_value DB_NAME)"
  PORT="$(runtime_env_value PORT)"
  public_site_url="$(runtime_env_value PUBLIC_SITE_URL)"
  portal_only="$(runtime_env_value PORTAL_ONLY)"
  configured_aliases="$(runtime_env_value PORTAL_ALIASES)"
  CONFIGURED_SOURCE_DIR="$(runtime_env_value RP_SOURCE_DIR)"
  [[ -n "$app_url" ]] || fail "APP_URL is missing from the protected environment."
  [[ -n "$DB_NAME" && "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "The configured database name is invalid."
  PORT="${PORT:-3000}"
  [[ "$PORT" =~ ^[0-9]{2,5}$ && "$PORT" -le 65535 ]] || fail "The configured application port is invalid."

  local app_host="${app_url#https://}"
  app_host="${app_host#http://}"
  app_host="${app_host%%/*}"
  valid_hostname "$app_host" || fail "APP_URL does not contain a valid portal hostname."
  DOMAIN="${app_host,,}"

  # PORTAL_ONLY=true is the expected split-site topology. PUBLIC_SITE_URL may then
  # intentionally point at a separate marketing host and must never be passed back
  # into the native nginx application-host allowlist during an upgrade.
  if [[ "$portal_only" != "true" && -n "$public_site_url" ]]; then
    local public_host="${public_site_url#https://}"
    public_host="${public_host#http://}"
    public_host="${public_host%%/*}"
    if [[ -n "$public_host" && "$public_host" != "$DOMAIN" ]]; then
      valid_hostname "$public_host" || fail "PUBLIC_SITE_URL does not contain a valid hostname."
      PUBLIC_DOMAIN="${public_host,,}"
    fi
  fi

  local alias
  IFS=',' read -r -a PORTAL_ALIASES <<< "$configured_aliases"
  for alias in "${PORTAL_ALIASES[@]}"; do
    [[ -z "$alias" ]] && continue
    valid_hostname "$alias" || fail "PORTAL_ALIASES contains an invalid hostname."
  done
}

resolve_source_directory() {
  local candidate
  for candidate in "$CONFIGURED_SOURCE_DIR" /srv/readypackets /home/ubuntu/src/readypackets; do
    [[ -n "$candidate" && -d "$candidate" && -f "$candidate/deploy/install.sh" ]] || continue
    SOURCE_DIR="$candidate"
    return 0
  done
  fail "The native ReadyPackets source checkout is unavailable. Refusing to guess a source location."
}

prepare_validation_staging_root() {
  # The validator receives one explicit staged-source path and needs execute-only
  # traversal through this parent. Backups, snapshots, portal.env, uploaded data,
  # and the root-owned lock stay outside this directory. Explicit chown/chmod are
  # necessary because install -d -m deliberately does not repair an existing
  # directory's mode, including the 0700 directory created by an earlier build.
  install -d -m 0710 -o root -g "$APP_USER" "$WORK_ROOT"
  chown root:"$APP_USER" "$WORK_ROOT"
  chmod 0710 "$WORK_ROOT"
}

safe_copy_tree() {
  local source="$1" destination="$2"
  # A failed installer can leave this shell in SOURCE_DIR. Move away before
  # replacing any whole tree so rollback never unlinks its own working directory.
  cd -- /
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
  # Never relax a parent directory's existing mode during recovery. All native
  # targets are pre-existing on a supported host; a newly created parent keeps
  # the process umask rather than inheriting a broad default mode.
  mkdir -p -- "$(dirname "$target")"
  cp -a -- "$source" "$target"
}

snapshot_host_artifacts() {
  local path
  local -a host_paths=(
    /etc/nginx/sites-available/readypackets
    /etc/nginx/sites-enabled/readypackets
    /etc/readypackets/maintenance-mode.conf
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
  for path in "${host_paths[@]}"; do
    snapshot_path "$path"
  done
  printf '%s\n' "${host_paths[@]}" > "${SNAPSHOT}/host-paths.txt"
  chmod 0600 "${SNAPSHOT}/host-paths.txt"
}

restore_host_artifacts() {
  local path
  [[ -r "${SNAPSHOT}/host-paths.txt" ]] || fail "The rollback snapshot does not contain its host-artifact manifest."
  while IFS= read -r path; do
    [[ "$path" == /* ]] || fail "The rollback snapshot contains an invalid host-artifact path."
    restore_path "$path"
  done < "${SNAPSHOT}/host-paths.txt"
}

write_snapshot() {
  local timestamp
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  SNAPSHOT="${BACKUP_ROOT}/${timestamp}-${COMMIT:0:12}"
  install -d -m 0700 -o root -g root "$BACKUP_ROOT" "$SNAPSHOT"
  safe_copy_tree "$APP_DIR" "${SNAPSHOT}/app"
  safe_copy_tree "$SOURCE_DIR" "${SNAPSHOT}/source"
  cp -a -- "$ENV_FILE" "${SNAPSHOT}/portal.env"
  snapshot_host_artifacts
  mysqldump --single-transaction --routines --events -u root "$DB_NAME" | gzip -9 > "${SNAPSHOT}/database.sql.gz"
  [[ -s "${SNAPSHOT}/database.sql.gz" ]] || fail "The rollback database dump is empty."
  sha256sum "${SNAPSHOT}/database.sql.gz" "${SNAPSHOT}/portal.env" > "${SNAPSHOT}/SHA256SUMS"
  chmod 0600 "${SNAPSHOT}/SHA256SUMS" "${SNAPSHOT}/database.sql.gz"
  cat > "${SNAPSHOT}/MANIFEST.txt" <<MANIFEST
ReadyPackets existing-VPS upgrade rollback snapshot
Created: ${timestamp}
Repository: ${REPOSITORY}
Branch: ${BRANCH}
Target commit: ${COMMIT}
Canonical portal host: ${DOMAIN}
Database: ${DB_NAME}
Storage mutation contract: this upgrade path does not mutate application storage.
MANIFEST
  chmod 0600 "${SNAPSHOT}/MANIFEST.txt"
}

wait_for_readiness() {
  local attempt response=""
  for ((attempt = 1; attempt <= 20; attempt++)); do
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

restore_snapshot() {
  [[ -n "$SNAPSHOT" && -d "$SNAPSHOT" ]] || return 0
  warn "Upgrade failed; restoring the protected pre-upgrade snapshot."
  audit "rollback started snapshot=$(basename "$SNAPSHOT") target=${COMMIT:0:12}"
  trap - ERR INT TERM
  systemctl stop "$SERVICE" || true
  safe_copy_tree "${SNAPSHOT}/app" "$APP_DIR"
  safe_copy_tree "${SNAPSHOT}/source" "$SOURCE_DIR"
  cp -a -- "${SNAPSHOT}/portal.env" "$ENV_FILE"
  gunzip -c "${SNAPSHOT}/database.sql.gz" | mysql -u root "$DB_NAME"
  restore_host_artifacts
  systemctl daemon-reload
  if [[ -e /etc/nginx/sites-available/readypackets ]]; then
    nginx -t && systemctl reload nginx
  fi
  systemctl restart readypackets-backup-control.service || true
  systemctl restart readypackets-certificate-control.service || true
  systemctl restart readypackets-platform-update-control.service || true
  systemctl start "$SERVICE"
  if wait_for_readiness; then
    audit "rollback completed snapshot=$(basename "$SNAPSHOT") target=${COMMIT:0:12}"
    warn "Rollback completed and local readiness is healthy. Snapshot retained at ${SNAPSHOT}."
  else
    audit "rollback failed snapshot=$(basename "$SNAPSHOT") target=${COMMIT:0:12}"
    warn "Rollback was attempted but the local readiness check did not pass. Review the root-only journal immediately."
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$UPDATE_SUCCEEDED" != "true" ]]; then
    restore_snapshot || true
  fi
  [[ -n "$WORK_DIR" ]] && rm -rf -- "$WORK_DIR"
  exit "$status"
}

preflight_existing_host() {
  [[ $EUID -eq 0 ]] || fail "Run this updater as root with sudo."
  [[ -t 0 && -t 1 ]] || fail "Run from an interactive root console; the required typed confirmation cannot be supplied noninteractively."
  [[ -d "$APP_DIR" && -d "$DATA_DIR" ]] || fail "Existing ReadyPackets application or data state is missing. This updater refuses fresh or partial hosts."
  systemctl cat "$SERVICE" >/dev/null 2>&1 || fail "The native readypackets.service is not installed. This updater supports only the native VPS deployment."
  command -v git >/dev/null 2>&1 || fail "git is required on the existing host."
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required on the existing host."
  command -v mysqldump >/dev/null 2>&1 || fail "mysqldump is required on the existing host."
  command -v nginx >/dev/null 2>&1 || fail "nginx is required on the existing host."
  command -v flock >/dev/null 2>&1 || fail "flock is required on the existing host."
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --commit) COMMIT="${2:-}"; shift 2 ;;
      --branch) BRANCH="${2:-}"; shift 2 ;;
      --stage-phase-webhook-defaults) STAGE_PHASE_WEBHOOK_DEFAULTS="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  [[ "$COMMIT" =~ $SHA_RE ]] || fail "--commit must be a reviewed 40-character lowercase Git SHA."
  [[ "$BRANCH" =~ $BRANCH_RE ]] || fail "--branch is invalid."
}

fetch_and_validate_release() {
  prepare_validation_staging_root
  WORK_DIR="$(mktemp -d "${WORK_ROOT}/stage.XXXXXXXX")"
  # The staged release contains source code only. Permit the service account to
  # traverse this one isolated directory for unprivileged validation; it cannot
  # list its parent or write either path. Snapshots, backups, and runtime secrets
  # remain in separate root-only locations.
  chown root:"$APP_USER" "$WORK_DIR"
  chmod 0710 "$WORK_DIR"

  log "Checking anonymous source access and immutable branch approval."
  local remote_branch
  remote_branch="$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads "https://github.com/${REPOSITORY}.git" "refs/heads/${BRANCH}" | awk 'NR == 1 { print $1 }')"
  [[ "$remote_branch" =~ $SHA_RE ]] || fail "${REPOSITORY}@${BRANCH} is not anonymously readable. Keep the repository temporarily public for this approved update."
  [[ "$remote_branch" == "$COMMIT" ]] || fail "The branch tip changed after this release was reviewed. Refusing to deploy a different commit."

  git init "$WORK_DIR/source" >/dev/null
  git -C "$WORK_DIR/source" remote add origin "https://github.com/${REPOSITORY}.git"
  GIT_TERMINAL_PROMPT=0 git -C "$WORK_DIR/source" fetch --depth=1 origin "$COMMIT"
  local resolved
  resolved="$(git -C "$WORK_DIR/source" rev-parse FETCH_HEAD)"
  [[ "$resolved" == "$COMMIT" ]] || fail "Downloaded source does not match the reviewed immutable release."
  git -C "$WORK_DIR/source" checkout --detach --force "$resolved" >/dev/null
  [[ -f "$WORK_DIR/source/deploy/install.sh" && -f "$WORK_DIR/source/deploy/verify-public-connectivity.sh" ]] \
    || fail "The reviewed release is missing required native deployment files."
  [[ -z "$(git -C "$WORK_DIR/source" status --porcelain)" ]] || fail "The staged reviewed source is unexpectedly modified."
}

validate_staged_release() {
  log "Validating the reviewed release as the unprivileged service account."
  local validation_dir="$WORK_DIR/validation"
  # Keep the downloaded, SHA-verified source root-owned. The service account
  # validates only this disposable copy, so it cannot modify material that root
  # will later deploy even if the application account is compromised mid-run.
  rm -rf -- "$validation_dir"
  install -d -m 0710 -o root -g "$APP_USER" "$validation_dir"
  cp -a -- "$WORK_DIR/source/." "$validation_dir/"
  chown -R "$APP_USER:$APP_USER" "$validation_dir"
  install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$validation_dir/home"
  runuser -u "$APP_USER" -- test -x "$WORK_ROOT" \
    || fail "The service account cannot traverse the protected source-validation parent. No production change was made."
  runuser -u "$APP_USER" -- test -x "$WORK_DIR" \
    || fail "The service account cannot traverse the staged source directory. No production change was made."
  runuser -u "$APP_USER" -- test -x "$validation_dir" \
    || fail "The service account cannot traverse the disposable validation copy. No production change was made."
  runuser -u "$APP_USER" -- env HOME="$validation_dir/home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    bash -c 'set -Eeuo pipefail
      cd "$1"
      pnpm install --frozen-lockfile
      pnpm run typecheck
      # Update validation must never point tests at the live production database.
      # The only database-backed suite is verified in CI against disposable MySQL;
      # all remaining source/security/installer tests run here before root copies.
      mapfile -t tests < <(find tests -maxdepth 1 -type f -name "*.test.ts" ! -name "domain.test.ts" | sort)
      pnpm exec vitest run "${tests[@]}"
      pnpm run build
    ' bash "$validation_dir"
  bash -n "$WORK_DIR/source/deploy/install.sh"
  bash -n "$WORK_DIR/source/deploy/temporary-public-existing-vps-upgrade.sh"
  node --check "$WORK_DIR/source/deploy/platform-update-control-daemon.mjs"
  rm -rf -- "$validation_dir"
}

apply_release() {
  log "Creating a full application backup before upgrade."
  bash "$APP_DIR/deploy/backup.sh" --skip-sync
  log "Capturing application, database, runtime configuration, TLS, nginx, and controller rollback state."
  write_snapshot
  audit "apply started snapshot=$(basename "$SNAPSHOT") target=${COMMIT:0:12}"

  safe_copy_tree "$WORK_DIR/source" "$SOURCE_DIR"
  cd "$SOURCE_DIR"
  local -a installer=(
    bash deploy/install.sh
    --domain "$DOMAIN"
    --skip-packages
    --no-seed
    --preserve-runtime-config
  )
  local alias
  for alias in "${PORTAL_ALIASES[@]}"; do
    [[ -n "$alias" ]] && installer+=(--portal-alias "$alias")
  done
  [[ -n "$PUBLIC_DOMAIN" ]] && installer+=(--public-domain "$PUBLIC_DOMAIN")

  log "Installing the reviewed release while retaining the current protected runtime configuration."
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${installer[@]}" < /dev/null
  printf '%s\n' "$COMMIT" > "${APP_DIR}/RELEASE_COMMIT"
  chown root:"$APP_USER" "${APP_DIR}/RELEASE_COMMIT"
  chmod 0640 "${APP_DIR}/RELEASE_COMMIT"
  wait_for_readiness || fail "The upgraded service did not pass its local readiness check."
  UPDATE_SUCCEEDED="true"
  audit "apply completed snapshot=$(basename "$SNAPSHOT") target=${COMMIT:0:12}"
}

main() {
  parse_args "$@"
  preflight_existing_host
  prepare_validation_staging_root
  install -d -m 0700 -o root -g root "$BACKUP_ROOT"
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another ReadyPackets existing-VPS upgrade or rollback is already running."
  source_environment
  resolve_source_directory

  cat <<PLAN
ReadyPackets existing-VPS update review
=======================================
Canonical portal:  https://${DOMAIN}
Portal aliases:    ${PORTAL_ALIASES[*]:-none (canonical redirect only)}
Public app host:   ${PUBLIC_DOMAIN:-none; external marketing URL remains configuration only}
Source repository: ${REPOSITORY} (temporary public HTTPS retrieval)
Source branch:     ${BRANCH}
Source commit:     ${COMMIT}
Safety controls:   full backup, root-only rollback snapshot, immutable SHA gate,
                   no seed, protected runtime config preserved byte-for-byte,
                   local readiness gate, automatic rollback on failure
Phase defaults:    $([[ "$STAGE_PHASE_WEBHOOK_DEFAULTS" == "true" ]] && printf 'stage disabled P101/P201 after successful update' || printf 'not requested')
PLAN
  local confirmation=""
  read -r -p "Type UPGRADE READY PACKETS to apply this exact reviewed commit: " confirmation
  [[ "$confirmation" == "UPGRADE READY PACKETS" ]] || fail "Confirmation did not match; no changes were made."

  trap on_exit EXIT
  fetch_and_validate_release
  validate_staged_release
  apply_release

  if [[ "$STAGE_PHASE_WEBHOOK_DEFAULTS" == "true" ]]; then
    [[ -f "$SOURCE_DIR/deploy/configure-phase-webhook-defaults.sh" ]] \
      || fail "The reviewed release does not contain the phase-webhook defaults helper."
    log "Application update succeeded. Staging phase webhook defaults through the local protected helper."
    if bash "$SOURCE_DIR/deploy/configure-phase-webhook-defaults.sh"; then
      audit "phase webhook default staging completed target=${COMMIT:0:12}"
    else
      # The portal update has already passed readiness. Do not roll back its
      # application/database snapshot just because a separately staged,
      # non-overriding integration default was cancelled or rejected.
      warn "Application update succeeded, but phase webhook defaults were not fully staged. Review the helper output and rerun it only after correcting the configuration."
      audit "phase webhook default staging incomplete target=${COMMIT:0:12}"
    fi
  fi

  cat <<SUMMARY

ReadyPackets existing-VPS upgrade completed.
  Installed source: ${COMMIT}
  Canonical portal: https://${DOMAIN}
  Rollback snapshot: ${SNAPSHOT}

The pre-upgrade full backup and root-only rollback snapshot were retained. Do not
run a fresh installer on this server. Return the GitHub repository to private
visibility when the temporary public source window is no longer needed.
SUMMARY
}

main "$@"
