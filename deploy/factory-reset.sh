#!/usr/bin/env bash
# ReadyPackets Portal — guarded factory reset.
# This is intentionally a root-console-only recovery tool. It is never exposed
# through the web application because it permanently destroys customer data.
set -Eeuo pipefail
umask 077

MODE="native"
PROJECT_DIR=""
DOMAIN=""
CONFIRMATION=""
PRESERVE_EVIDENCE="false"

usage() {
  cat <<'USAGE'
Usage:
  sudo bash deploy/factory-reset.sh --mode native --domain portal.example.com \
    --confirm 'FACTORY RESET portal.example.com'
  sudo bash deploy/factory-reset.sh --mode docker --project-dir /srv/readypackets \
    --domain portal.example.com --confirm 'FACTORY RESET portal.example.com'

The command stops ReadyPackets, removes application and storage files, removes
its database and application database users, removes application secrets, and
removes native service/reverse-proxy configuration or Docker volumes. It does
not uninstall MySQL, Docker, Node, nginx, or operating-system packages.

Use --preserve-evidence to keep /var/backups/readypackets and a timestamped
reset manifest. It does not preserve customer data in the active platform.
USAGE
}
fail() { printf '[factory-reset] %s\n' "$*" >&2; exit 1; }
log() { printf '[factory-reset] %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --confirm) CONFIRMATION="${2:-}"; shift 2 ;;
    --preserve-evidence) PRESERVE_EVIDENCE="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run this command as root."
[[ "$MODE" == "native" || "$MODE" == "docker" ]] || fail "--mode must be native or docker."
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || fail "A valid --domain is required."
[[ "$CONFIRMATION" == "FACTORY RESET $DOMAIN" ]] || fail "Type the exact confirmation: FACTORY RESET $DOMAIN"
if [[ "$MODE" == "docker" ]]; then
  [[ -n "$PROJECT_DIR" && -f "$PROJECT_DIR/docker-compose.yml" ]] || fail "Docker mode requires --project-dir containing docker-compose.yml."
fi

manifest_dir="/var/lib/readypackets/reset-evidence"
if [[ "$PRESERVE_EVIDENCE" == "true" ]]; then
  install -d -m 0700 -o root -g root "$manifest_dir"
  printf 'reset_at=%s\nmode=%s\ndomain=%s\noperator=%s\n' "$(date -u +%FT%TZ)" "$MODE" "$DOMAIN" "${SUDO_USER:-root}" > "$manifest_dir/reset-$(date -u +%Y%m%dT%H%M%SZ).txt"
fi

log "FACTORY RESET CONFIRMED. Stopping ReadyPackets and deleting active data."
if [[ "$MODE" == "docker" ]]; then
  log "Stopping Docker application and removing its named volumes."
  (cd "$PROJECT_DIR" && docker compose down --volumes --remove-orphans)
  rm -f "$PROJECT_DIR/.env"
  rm -rf "$PROJECT_DIR/storage"
else
  log "Stopping native ReadyPackets services."
  systemctl stop readypackets 2>/dev/null || true
  systemctl disable readypackets 2>/dev/null || true
  systemctl stop readypackets-backup.timer 2>/dev/null || true
  systemctl disable readypackets-backup.timer 2>/dev/null || true
  systemctl stop readypackets-platform-update-control.service 2>/dev/null || true
  systemctl disable readypackets-platform-update-control.service 2>/dev/null || true
  rm -f /etc/systemd/system/readypackets.service /etc/systemd/system/readypackets-backup.service /etc/systemd/system/readypackets-backup.timer /etc/systemd/system/readypackets-platform-update-control.service
  rm -f /etc/sudoers.d/readypackets-backup-control /etc/sudoers.d/readypackets-platform-update
  systemctl daemon-reload
fi

log "Dropping the ReadyPackets database and application database users."
mysql -u root -e "DROP DATABASE IF EXISTS readypackets; DROP USER IF EXISTS 'readypackets'@'localhost'; DROP USER IF EXISTS 'readypackets'@'127.0.0.1'; FLUSH PRIVILEGES;" 2>/dev/null || true

log "Removing active application data, configuration, secrets, and generated files."
rm -rf /opt/readypackets /home/ubuntu/src/readypackets /var/lib/readypackets /etc/readypackets
if [[ "$PRESERVE_EVIDENCE" != "true" ]]; then rm -rf /var/backups/readypackets; fi

if [[ "$MODE" == "native" ]]; then
  log "Removing ReadyPackets nginx site configuration."
  rm -f /etc/nginx/sites-enabled/readypackets /etc/nginx/sites-available/readypackets
  nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
fi

userdel readypackets 2>/dev/null || true
log "Factory reset complete. Reinstall using deploy/unified-install.sh or deploy/install.sh."
