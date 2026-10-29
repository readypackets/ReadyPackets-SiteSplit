#!/usr/bin/env bash
# ReadyPackets phase-start webhook default staging helper.
#
# This is a post-update, root-console operation for staging P101/P201 Make
# endpoint defaults. It never accepts endpoint URLs in command-line arguments,
# never displays them, and never replaces, enables, disables, or removes an
# existing explicit or generic webhook route.
set -Eeuo pipefail
umask 077

readonly ENV_FILE="/etc/readypackets/portal.env"
readonly LOCK_ROOT="/run/readypackets-phase-webhook-defaults"
readonly LOCK_FILE="${LOCK_ROOT}/configure.lock"
readonly MAKE_WEBHOOK_HOST="hook.us2.make.com"

DB_NAME=""
P101_URL=""
P201_URL=""

fail() { printf '\n[ReadyPackets phase defaults error] %s\n' "$*" >&2; exit 1; }
notice() { printf '\n[ReadyPackets phase defaults] %s\n' "$*"; }
audit() { logger -p authpriv.notice -t readypackets-phase-webhook-defaults -- "$*" 2>/dev/null || true; }

usage() {
  cat <<'USAGE'
ReadyPackets phase-start webhook default staging helper

Usage:
  sudo bash deploy/configure-phase-webhook-defaults.sh

Run this only after a successful reviewed ReadyPackets update. It securely
prompts at the local root console for P101 and P201 Make HTTPS destinations,
creates disabled defaults only if no explicit P101/P201, phase.start, or * route
already exists, and never displays a raw destination or changes phase settings.

The destination URLs are capability values. Do not provide them as command-line
arguments, environment variables, shell-history text, tickets, or source code.
After staging, review the masked configuration in Admin → Integrations, test the
receiver with a non-customer test order, then explicitly enable the endpoint and
its phase notification gate only when approved.
USAGE
}

require_root_console() {
  [[ $EUID -eq 0 ]] || fail "Run this helper as root with sudo."
  [[ -t 0 && -t 1 ]] || fail "Run this helper from an interactive root console."
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "ReadyPackets protected environment is unavailable."
  [[ "$(stat -c '%U' "$ENV_FILE")" == "root" ]] || fail "ReadyPackets protected environment is not root-owned."
  local mode
  mode="$(stat -c '%a' "$ENV_FILE")"
  (( (8#$mode & 0022) == 0 )) || fail "ReadyPackets protected environment is group- or world-writable."
  command -v mysql >/dev/null 2>&1 || fail "mysql is required."
  command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."
  command -v flock >/dev/null 2>&1 || fail "flock is required."
}

runtime_env_value() {
  local key="$1"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "Invalid protected environment key request."
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/bash -c '
    set -a
    . "$1"
    set +a
    key="$2"
    printf "%s" "${!key-}"
  ' bash "$ENV_FILE" "$key"
}

validate_database_name() {
  DB_NAME="$(runtime_env_value DB_NAME)"
  [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "The configured database name is invalid."
}

validate_make_destination() {
  local phase="$1" value="$2"
  # This helper is deliberately scoped to the reviewed Make custom-webhook
  # host. The opaque path stays local to the root process and is never logged.
  [[ ${#value} -ge 12 && ${#value} -le 500 ]] || fail "${phase} destination length is invalid."
  [[ "$value" != *[[:space:][:cntrl:]]* ]] || fail "${phase} destination must not contain whitespace or control characters."
  [[ "$value" =~ ^https://hook\.us2\.make\.com/[A-Za-z0-9._~-]+$ ]] || fail "${phase} destination must be an HTTPS ${MAKE_WEBHOOK_HOST} custom webhook URL without credentials, query, or fragment."
}

fingerprint() {
  printf '%s' "$1" | sha256sum | awk '{print substr($1, 1, 16)}'
}

matching_endpoint_ids() {
  local phase="$1"
  mysql --protocol=socket --batch --skip-column-names -u root "$DB_NAME" <<SQL
SELECT id
FROM webhook_endpoints
WHERE JSON_CONTAINS(COALESCE(events, JSON_ARRAY()), JSON_QUOTE('${phase}'))
   OR JSON_CONTAINS(COALESCE(events, JSON_ARRAY()), JSON_QUOTE('phase.start'))
   OR JSON_CONTAINS(COALESCE(events, JSON_ARRAY()), JSON_QUOTE('*'))
ORDER BY id;
SQL
}

insert_disabled_default() {
  local phase="$1" url="$2" fingerprint_value="$3" name
  if [[ "$phase" == "P101" ]]; then
    name="Deployment default — Phase I Start (P101)"
  else
    name="Deployment default — Phase II Start (P201)"
  fi

  # The caller holds the root-only host lock and this table write lock. Existing
  # phase or generic routes are rechecked under the lock and always win.
  mysql --protocol=socket --batch --skip-column-names -u root "$DB_NAME" <<SQL
LOCK TABLES webhook_endpoints WRITE, activity_logs WRITE;
INSERT INTO webhook_endpoints (name, url, events, secret_enc, enabled, created_by_user_id)
SELECT '${name}', '${url}', JSON_ARRAY('${phase}'), NULL, 0, NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM webhook_endpoints AS existing
  WHERE JSON_CONTAINS(COALESCE(existing.events, JSON_ARRAY()), JSON_QUOTE('${phase}'))
     OR JSON_CONTAINS(COALESCE(existing.events, JSON_ARRAY()), JSON_QUOTE('phase.start'))
     OR JSON_CONTAINS(COALESCE(existing.events, JSON_ARRAY()), JSON_QUOTE('*'))
);
SELECT ROW_COUNT();
UNLOCK TABLES;
SQL
}

record_result() {
  local phase="$1" action="$2" endpoint_id="$3" fingerprint_value="$4" summary
  if [[ "$action" == "staged" ]]; then
    summary="Root console staged a disabled ${phase} deployment webhook default"
  else
    summary="Root console preserved existing ${phase} webhook routing"
  fi
  mysql --protocol=socket --batch --skip-column-names -u root "$DB_NAME" <<SQL
INSERT INTO activity_logs (actor_user_id, actor_role, action, entity_type, entity_id, severity, summary, changes, ip_address)
VALUES (NULL, 'system', 'webhook.phase_default_${action}', 'webhook_endpoint', '${endpoint_id}', 'notice', '${summary}', JSON_OBJECT('phase', '${phase}', 'source', 'root_console', 'urlHost', '${MAKE_WEBHOOK_HOST}', 'urlFingerprint', '${fingerprint_value}', 'enabled', FALSE), NULL);
SQL
}

stage_phase() {
  local phase="$1" url="$2" result endpoint_id existing fingerprint_value
  fingerprint_value="$(fingerprint "$url")"
  existing="$(matching_endpoint_ids "$phase")"
  if [[ -n "$existing" ]]; then
    endpoint_id="$(printf '%s\n' "$existing" | head -n 1)"
    record_result "$phase" "preserved_existing" "$endpoint_id" "$fingerprint_value"
    audit "phase=${phase} action=preserved_existing endpoint_id=${endpoint_id} host=${MAKE_WEBHOOK_HOST} fingerprint=${fingerprint_value}"
    printf '%s\n' "${phase}: preserved existing routing (endpoint ${endpoint_id}); no default was changed."
    return 0
  fi

  result="$(insert_disabled_default "$phase" "$url" "$fingerprint_value")"
  if [[ "$result" == "1" ]]; then
    endpoint_id="$(mysql --protocol=socket --batch --skip-column-names -u root "$DB_NAME" <<SQL
SELECT id
FROM webhook_endpoints
WHERE url = '${url}'
  AND JSON_CONTAINS(COALESCE(events, JSON_ARRAY()), JSON_QUOTE('${phase}'))
ORDER BY id DESC
LIMIT 1;
SQL
)"
    [[ "$endpoint_id" =~ ^[1-9][0-9]*$ ]] || fail "${phase} default was staged but could not be verified."
    record_result "$phase" "staged" "$endpoint_id" "$fingerprint_value"
    audit "phase=${phase} action=staged endpoint_id=${endpoint_id} enabled=false host=${MAKE_WEBHOOK_HOST} fingerprint=${fingerprint_value}"
    printf '%s\n' "${phase}: staged disabled default (endpoint ${endpoint_id})."
    return 0
  fi

  # A concurrent administrator save may have won after the initial precheck.
  # Preserve it rather than attempting an overwrite or a second insert.
  existing="$(matching_endpoint_ids "$phase")"
  endpoint_id="$(printf '%s\n' "$existing" | head -n 1)"
  [[ "$endpoint_id" =~ ^[1-9][0-9]*$ ]] || fail "${phase} staging did not produce a verifiable result."
  record_result "$phase" "preserved_existing" "$endpoint_id" "$fingerprint_value"
  audit "phase=${phase} action=preserved_existing endpoint_id=${endpoint_id} host=${MAKE_WEBHOOK_HOST} fingerprint=${fingerprint_value}"
  printf '%s\n' "${phase}: preserved existing routing (endpoint ${endpoint_id}); no default was changed."
}

main() {
  if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then usage; return 0; fi
  [[ $# -eq 0 ]] || { usage >&2; return 2; }
  require_root_console
  validate_database_name
  install -d -m 0700 -o root -g root "$LOCK_ROOT"
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "Another phase webhook default configuration is in progress."

  notice "P101 and P201 will be staged disabled only; existing direct or generic routes will be preserved."
  read -r -s -p "Enter P101 Make HTTPS destination: " P101_URL; printf '\n'
  read -r -s -p "Enter P201 Make HTTPS destination: " P201_URL; printf '\n'
  validate_make_destination "P101" "$P101_URL"
  validate_make_destination "P201" "$P201_URL"

  printf 'P101: host=%s fingerprint=%s\n' "$MAKE_WEBHOOK_HOST" "$(fingerprint "$P101_URL")"
  printf 'P201: host=%s fingerprint=%s\n' "$MAKE_WEBHOOK_HOST" "$(fingerprint "$P201_URL")"
  local confirmation=""
  read -r -p "Type STAGE PHASE WEBHOOK DEFAULTS to create disabled non-overriding defaults: " confirmation
  [[ "$confirmation" == "STAGE PHASE WEBHOOK DEFAULTS" ]] || fail "Confirmation did not match; no changes were made."

  stage_phase "P101" "$P101_URL"
  stage_phase "P201" "$P201_URL"
  unset P101_URL P201_URL

  notice "Completed. Defaults remain disabled and phase notification gates were not changed. Review and explicitly enable only after an approved non-customer test."
}

main "$@"
