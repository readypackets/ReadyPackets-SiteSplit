#!/usr/bin/env bash
# ReadyPackets post-install connectivity verifier.
# Local service health is authoritative for installation success. Public reachability
# is separately evaluated because DNS, certificate issuance, Cloudflare proxying,
# and external firewall propagation may legitimately lag a fresh server build.
# Public checks bypass inherited proxy variables: an enterprise egress proxy can
# replace the public certificate chain or impose its own block page, which would
# make an origin-host health diagnostic misleading.
set -Eeuo pipefail

DOMAIN=""
PORTAL_ALIASES=()
LOCAL_ONLY="false"

usage() {
  cat <<'USAGE'
Usage: sudo bash deploy/verify-public-connectivity.sh --domain portal.example.com [--portal-alias alias.example.com]... [--local-only]

Checks the local ReadyPackets service through its loopback listener first. Unless
--local-only is given, then checks the canonical public HTTPS endpoint and every
optional alias redirect separately.

Exit codes:
  0  Local service is healthy and, when requested, public HTTPS is reachable.
  2  Local service is healthy but public HTTPS is not reachable yet.
  1  Local service health failed or the command was used incorrectly.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --portal-alias) PORTAL_ALIASES+=("${2:-}"); shift 2 ;;
    --local-only) LOCAL_ONLY="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || { printf 'A valid --domain is required.\n' >&2; exit 1; }
(( ${#PORTAL_ALIASES[@]} <= 5 )) || { printf 'At most five --portal-alias values are permitted.\n' >&2; exit 1; }
for portal_alias in "${PORTAL_ALIASES[@]}"; do
  [[ "$portal_alias" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
    || { printf 'Each --portal-alias must be a valid hostname.\n' >&2; exit 1; }
done

if ! systemctl is-active --quiet readypackets; then
  printf 'Local ReadyPackets service is not active. Inspect: journalctl -u readypackets -n 80 --no-pager\n' >&2
  exit 1
fi

if ! curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
  -H "Host: ${DOMAIN}" -H 'X-Forwarded-Proto: https' \
  http://127.0.0.1:3000/api/health/ready >/dev/null; then
  printf 'Local ReadyPackets readiness endpoint failed. Inspect: journalctl -u readypackets -n 80 --no-pager\n' >&2
  exit 1
fi

printf 'Local installation health: PASS\n'
[[ "$LOCAL_ONLY" == "true" ]] && exit 0

if curl --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 15 \
  "https://${DOMAIN}/api/health" >/dev/null; then
  printf 'Public HTTPS health: PASS\n'
else
  printf '\nPublic HTTPS health: PENDING\n' >&2
  printf 'The local portal is installed and running, but the canonical public path is not reachable yet.\n' >&2
  printf 'Check DNS/Cloudflare routing, inbound TCP 443, and certificate issuance, then retry:\n' >&2
  printf '  sudo bash /opt/readypackets/deploy/verify-public-connectivity.sh --domain %s\n' "$DOMAIN" >&2
  printf '\nLocal diagnostics:\n' >&2
  printf '  getent ahostsv4 %s\n' "$DOMAIN" >&2
  printf "  sudo ss -ltnp '( sport = :443 )'\n" >&2
  printf '  sudo ufw status numbered\n' >&2
  exit 2
fi

for portal_alias in "${PORTAL_ALIASES[@]}"; do
  expected="https://${DOMAIN}/api/health"
  actual="$(curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 15 --output /dev/null \
    --write-out '%{http_code} %{redirect_url}' "https://${portal_alias}/api/health" || true)"
  if [[ "$actual" != "308 ${expected}" ]]; then
    printf 'Portal alias redirect: PENDING (%s returned %s; expected 308 %s)\n' "$portal_alias" "${actual:-no response}" "$expected" >&2
    printf 'Check the alias DNS record, TLS certificate SANs, and Nginx configuration, then retry the verifier.\n' >&2
    exit 2
  fi
  printf 'Portal alias redirect: PASS (%s -> %s)\n' "$portal_alias" "$DOMAIN"
done

exit 0
