#!/usr/bin/env bash
# ReadyPackets Portal — approved auto-deployment wrapper
#
# This wrapper is intentionally NOT an unattended "pull main and deploy" tool.
# It only delegates an already reviewed, immutable commit to the protected
# platform-upgrade helper, which snapshots application/database state, rebuilds,
# validates, deploys, and automatically restores the snapshot on failure.
#
# Usage (root only):
#   printf '%s\n' "$GITHUB_PAT" | sudo -E bash deploy/auto-deploy-approved.sh \
#     --run-id 42 --repository readypackets/ReadyPackets --branch main \
#     --commit <40-hex-sha>
#
# The protected helper reads the active hostname and source checkout from the
# target server's root-owned ReadyPackets environment file.
#
# The PAT is accepted on standard input only. Never place it in a command-line
# argument, systemd unit, shell history, timer definition, or world-readable file.

set -Eeuo pipefail
umask 077

readonly CONTROL="/usr/local/sbin/readypackets-platform-update"
readonly SHA_RE='^[a-f0-9]{40}$'
readonly RUN_RE='^[1-9][0-9]*$'

fail() { printf '[auto-deploy] %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || fail "Run as root."
[[ -x "$CONTROL" ]] || fail "Protected platform-upgrade helper is not installed. Run the unified installer first."

RUN_ID=""; REPOSITORY=""; BRANCH="main"; COMMIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --repository) REPOSITORY="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ "$RUN_ID" =~ $RUN_RE ]] || fail "--run-id must be a positive approved upgrade run ID."
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--repository must be owner/repository."
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,128}$ ]] || fail "Invalid --branch."
[[ "$COMMIT" =~ $SHA_RE ]] || fail "--commit must be an immutable 40-character lowercase SHA."

# Explicit environmental acknowledgement prevents accidental invocation by an
# inherited cron/timer environment. Root remains the final authorization boundary.
[[ "${READYPACKETS_APPROVED_DEPLOYMENT:-}" == "yes" ]] || fail "Set READYPACKETS_APPROVED_DEPLOYMENT=yes only after the administrator approves the scanned run."

# The helper reads the PAT exactly once from stdin, verifies the remote branch
# still points at the scanned SHA, performs tests and builds, snapshots state, and
# rolls back on any error. Do not add a token persistence mechanism to this script.
exec "$CONTROL" apply "$RUN_ID" "$REPOSITORY" "$BRANCH" "$COMMIT"
