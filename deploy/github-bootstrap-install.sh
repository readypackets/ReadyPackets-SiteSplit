#!/usr/bin/env bash
# ReadyPackets Portal — secure fresh-VPS bootstrap.
#
# Retrieves one explicitly approved immutable Git commit through a repository-
# scoped read-only GitHub deploy key, then invokes the native installer. This
# script is deliberately for NEW servers only: it refuses an existing project
# directory or running portal instead of attempting to overwrite live data.
set -Eeuo pipefail
umask 077

REPOSITORY=""
COMMIT=""
DOMAIN=""
EMAIL=""
MODE="native"
TLS_PROVIDER=""
PROJECT_DIR="/srv/readypackets"
SSH_KEY="/root/.ssh/readypackets_deploy"
CLOUDFLARE_CERT=""
CLOUDFLARE_KEY=""
CLOUDFLARE_ROOT=""
CLOUDFLARE_API_TOKEN_FILE=""
CLOUDFLARE_ORIGIN_VALIDITY="5475"
SITE_NAME="ReadyPackets"
REQUIRE_PUBLIC_HEALTH="no"

usage() {
  cat <<'USAGE'
Usage:
  sudo bash github-bootstrap-install.sh \
    --repository owner/repository \
    --commit <reviewed-40-character-Git-SHA> \
    --domain portal.example.com \
    --mode native \
    --tls-provider letsencrypt \
    --email operations@example.com

Recommended Cloudflare-proxied production example:
  sudo bash github-bootstrap-install.sh \
    --repository readypackets/ReadyPackets-SiteSplit \
    --commit <reviewed-40-character-Git-SHA> \
    --domain my.readypackets.com \
    --mode native \
    --tls-provider cloudflare-origin-ca \
    --cloudflare-api-token-file /root/readypackets-secrets/cloudflare-origin-ca.token

Required arguments:
  --repository <owner/repository>                  Private GitHub repository.
  --commit <40-character SHA>                      Reviewed immutable release.
  --domain <hostname>                              Canonical portal hostname.

Optional arguments:
  --mode native|docker|docker-bootstrap             Defaults to native. Native is recommended.
  --tls-provider letsencrypt|cloudflare-origin|cloudflare-origin-ca
  --email <address>                                Required only for Let's Encrypt.
  --cloudflare-api-token-file <root-owned-0600-file>
                                                    Required for automated Origin CA issuance.
  --cloudflare-origin-validity 7|30|90|365|730|1095|5475
  --cloudflare-origin-cert <PEM> --cloudflare-origin-key <PEM>
                                                    Required for a manually-issued Origin CA cert.
  --cloudflare-origin-root <PEM>                   Optional Origin CA root/chain.
  --project-dir </absolute/path>                   Defaults to /srv/readypackets.
  --ssh-key </absolute/path>                       Defaults to /root/.ssh/readypackets_deploy.
  --site-name <name>                               Defaults to ReadyPackets.
  --require-public-health yes|no                   Defaults to no; local readiness remains mandatory.

Before execution:
  * Create the read-only GitHub deploy key at --ssh-key and add only its public
    half to the repository Deploy keys page. Never enable write access.
  * Verify the commit in a trusted review before starting. Moving branch names,
    abbreviated SHAs, GitHub PATs, and repository passwords are intentionally
    not accepted.
  * For Cloudflare Origin CA, set the portal DNS record to proxied and set the
    Cloudflare zone TLS mode to Full (strict). Store the scoped API token only
    in the root-owned token file; never place it on the command line.
USAGE
}

log() { printf '[ReadyPackets bootstrap] %s\n' "$*"; }
warn() { printf '[ReadyPackets bootstrap warning] %s\n' "$*" >&2; }
fail() { printf '[ReadyPackets bootstrap error] %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repository) REPOSITORY="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --tls-provider) TLS_PROVIDER="${2:-}"; shift 2 ;;
    --project-dir) PROJECT_DIR="${2:-}"; shift 2 ;;
    --ssh-key) SSH_KEY="${2:-}"; shift 2 ;;
    --cloudflare-origin-cert) CLOUDFLARE_CERT="${2:-}"; shift 2 ;;
    --cloudflare-origin-key) CLOUDFLARE_KEY="${2:-}"; shift 2 ;;
    --cloudflare-origin-root) CLOUDFLARE_ROOT="${2:-}"; shift 2 ;;
    --cloudflare-api-token-file) CLOUDFLARE_API_TOKEN_FILE="${2:-}"; shift 2 ;;
    --cloudflare-origin-validity) CLOUDFLARE_ORIGIN_VALIDITY="${2:-}"; shift 2 ;;
    --site-name) SITE_NAME="${2:-}"; shift 2 ;;
    --require-public-health) REQUIRE_PUBLIC_HEALTH="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run through sudo or as root."
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--repository must be owner/repository."
[[ "$COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--commit must be a reviewed 40-character Git SHA."
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || fail "--domain must be a valid public hostname."
[[ "$MODE" =~ ^(native|docker|docker-bootstrap)$ ]] || fail "--mode must be native, docker, or docker-bootstrap."
[[ "$TLS_PROVIDER" =~ ^(letsencrypt|cloudflare-origin|cloudflare-origin-ca)$ ]] || fail "--tls-provider must be letsencrypt, cloudflare-origin, or cloudflare-origin-ca."
[[ "$REQUIRE_PUBLIC_HEALTH" =~ ^(yes|no)$ ]] || fail "--require-public-health must be yes or no."
[[ "$PROJECT_DIR" == /* && "$PROJECT_DIR" != "/" && "$PROJECT_DIR" != "/srv" ]] || fail "--project-dir must be a safe absolute application path."
[[ "$PROJECT_DIR" != *$'\n'* && "$PROJECT_DIR" != *[[:space:]]* ]] || fail "--project-dir must not contain whitespace."
[[ "$SSH_KEY" == /* && "$SSH_KEY" != *$'\n'* && "$SSH_KEY" != *[[:space:]]* ]] || fail "--ssh-key must be an absolute path without whitespace."
[[ -n "$SITE_NAME" && ${#SITE_NAME} -le 100 && "$SITE_NAME" != *$'\n'* ]] || fail "--site-name must be 1 to 100 characters and contain no line breaks."

if [[ "$TLS_PROVIDER" == "letsencrypt" ]]; then
  [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "--email is required for Let's Encrypt."
else
  [[ -z "$EMAIL" || "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail "--email must be a valid address when supplied."
fi

if [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then
  [[ -r "$CLOUDFLARE_CERT" ]] || fail "--cloudflare-origin-cert must be readable."
  [[ -r "$CLOUDFLARE_KEY" ]] || fail "--cloudflare-origin-key must be readable."
  [[ -z "$CLOUDFLARE_ROOT" || -r "$CLOUDFLARE_ROOT" ]] || fail "--cloudflare-origin-root must be readable when supplied."
elif [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
  [[ "$MODE" == "native" ]] || fail "Automated Cloudflare Origin CA issuance is supported only for --mode native."
  [[ "$CLOUDFLARE_API_TOKEN_FILE" == /* && "$CLOUDFLARE_API_TOKEN_FILE" != *$'\n'* && "$CLOUDFLARE_API_TOKEN_FILE" != *[[:space:]]* ]] || fail "--cloudflare-api-token-file must be an absolute path without whitespace."
  [[ -n "$CLOUDFLARE_API_TOKEN_FILE" && -s "$CLOUDFLARE_API_TOKEN_FILE" ]] || fail "--cloudflare-api-token-file is required for automated Cloudflare Origin CA issuance."
  [[ "$(stat -c '%U:%a' "$CLOUDFLARE_API_TOKEN_FILE")" == "root:600" ]] || fail "Cloudflare API token file must be owned by root with mode 0600."
  [[ "$CLOUDFLARE_ORIGIN_VALIDITY" =~ ^(7|30|90|365|730|1095|5475)$ ]] || fail "--cloudflare-origin-validity must be 7, 30, 90, 365, 730, 1095, or 5475."
fi

[[ -r "$SSH_KEY" ]] || fail "Read-only GitHub deploy key is not readable: $SSH_KEY"
[[ "$(stat -c '%U:%a' "$SSH_KEY")" =~ ^root:(400|600)$ ]] || fail "GitHub deploy key must be owned by root with mode 0400 or 0600."
[[ ! -e "$PROJECT_DIR" ]] || fail "Project directory already exists: $PROJECT_DIR. This fresh-server bootstrap will not overwrite a deployment. Use the approved in-place update workflow instead."
if systemctl is-active --quiet readypackets 2>/dev/null; then
  fail "The ReadyPackets service is active. This fresh-server bootstrap cannot be used for a live portal."
fi

GITHUB_KNOWN_HOSTS="/root/.ssh/readypackets_github_known_hosts"
configure_github_known_hosts() {
  local metadata temporary
  log "Retrieving GitHub's published SSH host keys over verified HTTPS."
  install -d -m 0700 -o root -g root /root/.ssh
  temporary="$(mktemp /root/.ssh/readypackets-github-keys.XXXXXX)"
  trap 'rm -f -- "$temporary"' RETURN
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 30 \
    https://api.github.com/meta -o "$temporary"
  python3 - "$temporary" "$GITHUB_KNOWN_HOSTS" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
data = json.loads(source.read_text(encoding="utf-8"))
keys = data.get("ssh_keys")
if not isinstance(keys, list) or not keys:
    raise SystemExit("GitHub metadata did not contain SSH host keys")
allowed_types = {"ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"}
lines: list[str] = []
for item in keys:
    if not isinstance(item, str):
        continue
    parts = item.split()
    if len(parts) != 2 or parts[0] not in allowed_types:
        continue
    lines.append(f"github.com {parts[0]} {parts[1]}")
if not lines:
    raise SystemExit("GitHub metadata did not contain usable SSH host keys")
target.write_text("\n".join(lines) + "\n", encoding="utf-8")
target.chmod(0o600)
PY
  chown root:root "$GITHUB_KNOWN_HOSTS"
  rm -f -- "$temporary"
  trap - RETURN
}

log "Installing only source-retrieval prerequisites."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3
configure_github_known_hosts

# Do not accept an unverified first SSH host key. The dedicated known-hosts file
# comes from GitHub's authenticated metadata endpoint and is independent of any
# machine-wide SSH configuration.
export GIT_SSH_COMMAND="ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${GITHUB_KNOWN_HOSTS} -o GlobalKnownHostsFile=/dev/null"
remote="git@github.com:${REPOSITORY}.git"
log "Checking read-only deploy-key access to ${REPOSITORY}."
GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$remote" HEAD >/dev/null \
  || fail "GitHub deploy-key access failed. Confirm the public key is enabled as a read-only deploy key for ${REPOSITORY}."

log "Cloning the approved source without checking out a moving branch."
install -d -m 0755 -o root -g root "$(dirname "$PROJECT_DIR")"
GIT_TERMINAL_PROMPT=0 git clone --no-checkout "$remote" "$PROJECT_DIR"
cd "$PROJECT_DIR"
log "Fetching and verifying immutable release ${COMMIT}."
GIT_TERMINAL_PROMPT=0 git fetch --depth=1 origin "$COMMIT"
resolved="$(git rev-parse FETCH_HEAD)"
[[ "${resolved,,}" == "${COMMIT,,}" ]] || fail "Fetched revision does not match the reviewed immutable commit."
git checkout --detach --force "$resolved"
test -f deploy/unified-install.sh || fail "Reviewed source is missing deploy/unified-install.sh."
test -f deploy/verify-public-connectivity.sh || fail "Reviewed source is missing the post-install verifier."
test -z "$(git status --porcelain)" || fail "Checked-out source is unexpectedly modified."

installer=(
  bash deploy/unified-install.sh
  --mode "$MODE"
  --domain "$DOMAIN"
  --tls-provider "$TLS_PROVIDER"
  --site-name "$SITE_NAME"
)
if [[ "$TLS_PROVIDER" == "letsencrypt" ]]; then
  installer+=(--email "$EMAIL")
elif [[ "$TLS_PROVIDER" == "cloudflare-origin" ]]; then
  installer+=(--cloudflare-origin-cert "$CLOUDFLARE_CERT" --cloudflare-origin-key "$CLOUDFLARE_KEY")
  [[ -n "$CLOUDFLARE_ROOT" ]] && installer+=(--cloudflare-origin-root "$CLOUDFLARE_ROOT")
else
  installer+=(--cloudflare-api-token-file "$CLOUDFLARE_API_TOKEN_FILE" --cloudflare-origin-validity "$CLOUDFLARE_ORIGIN_VALIDITY")
fi
if [[ "$MODE" != "native" ]]; then
  installer+=(--project-dir "$PROJECT_DIR")
fi

log "Running the ReadyPackets ${MODE} installer for ${DOMAIN}."
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${installer[@]}"

if [[ "$MODE" == "native" ]]; then
  log "Requiring local service and database readiness."
  bash "$PROJECT_DIR/deploy/verify-public-connectivity.sh" --domain "$DOMAIN" --local-only

  log "Checking public HTTPS separately from local installation health."
  if bash "$PROJECT_DIR/deploy/verify-public-connectivity.sh" --domain "$DOMAIN"; then
    log "Public HTTPS health: PASS"
  else
    status=$?
    if [[ "$status" -eq 2 && "$REQUIRE_PUBLIC_HEALTH" == "no" ]]; then
      warn "Local installation is healthy; public HTTPS is pending DNS, Cloudflare, firewall, or certificate propagation."
    else
      fail "Public HTTPS verification failed. Correct DNS/proxy/TLS reachability and rerun /opt/readypackets/deploy/verify-public-connectivity.sh."
    fi
  fi
else
  log "Checking the Docker portal health endpoint."
  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 "https://${DOMAIN}/api/health/ready" >/dev/null \
    || warn "Docker deployment completed, but public HTTPS is not reachable yet. Verify DNS, proxy, firewall, and certificate propagation."
fi

cat <<SUMMARY

ReadyPackets Portal fresh deployment completed.
  Repository:       ${REPOSITORY}
  Installed commit: ${resolved}
  Portal URL:       https://${DOMAIN}
  Source checkout:  ${PROJECT_DIR}
  Runtime:          /opt/readypackets

Next required actions:
  1. Create the first administrator from the protected local console.
  2. Sign in over HTTPS, enroll MFA, and store the recovery codes securely.
  3. Configure email, payments, Microsoft Graph/SharePoint, SAML, SIEM, and
     consented analytics only in the authenticated administrator portal.
  4. Confirm an encrypted off-host backup destination and complete an isolated
     full restore drill before handling production customer data.
SUMMARY

if [[ "$TLS_PROVIDER" == "cloudflare-origin-ca" ]]; then
  cat <<'TOKEN_NOTICE'

Cloudflare token hygiene:
  The token file was used only for this Origin CA issuance and was never added
  to the command line, service environment, application database, or source.
  After confirming the certificate, remove the one-time token file and revoke
  the token unless an approved renewal process explicitly requires it:
TOKEN_NOTICE
  printf '    sudo shred -u -- %q\n' "$CLOUDFLARE_API_TOKEN_FILE"
fi
