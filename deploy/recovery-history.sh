#!/usr/bin/env bash
# ReadyPackets Portal — durable backup and restore operation history.
# This file is sourced by trusted root-owned helpers only. It deliberately stores
# no archive contents, credentials, passphrases, customer data, or stack traces.

# Respect a caller-supplied destination (for controlled restore drills) before
# falling back to the protected production location.
RECOVERY_HISTORY_FILE="${RECOVERY_HISTORY_FILE:-${RP_RECOVERY_HISTORY_FILE:-/var/lib/readypackets/recovery-history.jsonl}}"

recovery_history_clean() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr '\r\n\t' '   ' | tr -cd '[:print:]')"
  printf '%s' "${value:0:500}"
}

recovery_history_append() {
  local operation="$1" run_id="$2" archive="$3" mode="$4" status="$5" started_at="$6" detail="${7:-}"
  [[ "$operation" =~ ^(backup|restore)$ ]] || return 1
  [[ "$run_id" =~ ^[A-Za-z0-9@._:-]{1,128}$ ]] || return 1
  [[ "$archive" =~ ^[A-Za-z0-9._-]{0,512}$ ]] || return 1
  [[ "$mode" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || return 1
  [[ "$status" =~ ^(started|completed|failed)$ ]] || return 1
  install -d -m 0700 "$(dirname "$RECOVERY_HISTORY_FILE")"
  detail="$(recovery_history_clean "$detail")"
  local record
  record="$(node -e '
const [operation, runId, archive, mode, status, startedAt, detail] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ operation, runId, archive, mode, status, startedAt, completedAt: status === "started" ? null : new Date().toISOString(), detail: detail || null }));
' "$operation" "$run_id" "$archive" "$mode" "$status" "$started_at" "$detail")"
  (
    flock -x 9
    printf '%s\n' "$record" >&9
  ) 9>>"$RECOVERY_HISTORY_FILE"
  chmod 0600 "$RECOVERY_HISTORY_FILE"
}

recovery_history_list() {
  [[ -r "$RECOVERY_HISTORY_FILE" ]] || return 0
  # The file is written only by this helper. Return recent JSONL records in reverse
  # chronological order so the administrator sees the newest result first.
  tail -n 200 "$RECOVERY_HISTORY_FILE" | tac
}
