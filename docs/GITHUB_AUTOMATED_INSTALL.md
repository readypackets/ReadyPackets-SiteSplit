# ReadyPackets Portal — Private GitHub Fresh-Server Bootstrap

The ReadyPackets Portal includes [`deploy/github-bootstrap-install.sh`](../deploy/github-bootstrap-install.sh) for a secure **first installation only** on a new Ubuntu VPS. It retrieves a reviewed immutable release from the private `readypackets/ReadyPackets-SiteSplit` repository through a repository-scoped **read-only GitHub deploy key**, then starts the native installer.

> Do not use this bootstrap to update or repair a working portal. It deliberately refuses an existing source directory and active `readypackets.service`. Use **Admin → Platform updates** for a reviewed in-place release, or follow [Full Backup and Recovery](FULL_BACKUP_RESTORE.md) for a replacement-server recovery.

## Controls enforced by the bootstrap

| Control | Behavior |
| --- | --- |
| Repository access | Read-only SSH deploy key; no GitHub PAT, password, or token is accepted in the command. |
| Release selection | Requires an administrator-reviewed, complete 40-character Git SHA. Branch names and abbreviated SHAs are rejected. |
| GitHub server identity | Downloads GitHub’s published SSH host keys from the authenticated GitHub Meta API and uses a dedicated strict `known_hosts` file. It does not accept an unknown first-use SSH key. |
| Source integrity | Fetches the exact SHA, compares the resolved SHA, checks out detached, and rejects an unexpectedly modified source tree. |
| Existing-deployment protection | Stops if the source directory exists or the portal service is active. |
| TLS | Supports Let’s Encrypt, an existing Cloudflare Origin CA PEM pair, and automated Cloudflare Origin CA issuance from a root-owned `0600` token file. |
| Health | Requires local portal readiness. Public HTTPS is checked separately because DNS/proxy/certificate propagation can still be pending immediately after a correct installation. |

## Recommended production procedure

Use the current [Portal Production VPS Deployment Runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md). It includes the deploy-key setup, immutable-release review, Cloudflare Full (strict), secure token-file creation, exact portal-only command, migration/schema checkpoint, initial administrator command, backup drill, and go-live checklist.

For a Cloudflare-proxied production portal, the command shape is:

```bash
sudo bash /root/github-bootstrap-install.sh \
  --repository readypackets/ReadyPackets-SiteSplit \
  --commit <REVIEWED_40_CHARACTER_SHA> \
  --domain my.readypackets.com \
  --mode native \
  --tls-provider cloudflare-origin-ca \
  --cloudflare-api-token-file /root/readypackets-secrets/cloudflare-origin-ca.token \
  --cloudflare-origin-validity 5475 \
  --site-name ReadyPackets
```

For a direct-DNS Let’s Encrypt installation, replace the TLS options with:

```bash
--tls-provider letsencrypt --email operations@readypackets.com
```

The current installer applies **51 forward-only migrations** and fails closed unless **44 critical tables** verify successfully. It provisions the portal service as the unprivileged `readypackets` user; secrets remain in root-owned `/etc/readypackets/portal.env`, and neither Node.js port `3000` nor MySQL port `3306` is made public.

## After a successful installation

Create the first local administrator, enroll MFA, validate the dedicated portal hostname, configure encrypted off-host backups, and complete an isolated restore drill before onboarding customers. Configure email, payment, SharePoint/Graph, SAML, SIEM/syslog, and consented analytics only through the protected administrator portal.

See also: [Self-Hosted Installation Guide](SELF_HOSTED_INSTALLATION_GUIDE.md), [Global Growth & Horizontal Scaling Architecture](GLOBAL_SCALE_ARCHITECTURE.md), and [Approved Auto-Deployment](AUTO_DEPLOYMENT.md).
