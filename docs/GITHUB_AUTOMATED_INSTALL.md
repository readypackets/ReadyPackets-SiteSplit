# ReadyPackets Portal — Private GitHub Fresh-Server Bootstrap

The recommended interactive path is [`deploy/master-install.sh`](../deploy/master-install.sh). It is a secure **first installation only** workflow for a new Ubuntu VPS: it captures the canonical portal hostname, up to five optional canonical-redirect aliases, ReadyPackets display name, first administrator name/email, TLS method, and reviewed immutable release; creates or validates the read-only deploy key; runs the full native install; and creates the first local administrator with a generated one-time password.

[`deploy/github-bootstrap-install.sh`](../deploy/github-bootstrap-install.sh) remains the lower-level non-interactive primitive for approved automation after an operator has separately created the deploy key and selected every parameter.

> Do not use this bootstrap to update or repair a working portal. It deliberately refuses an existing source directory and active `readypackets.service`. Use **Admin → Platform updates** for a reviewed in-place release, or follow [Full Backup and Recovery](FULL_BACKUP_RESTORE.md) for a replacement-server recovery.

## Controls enforced by the guided master installer

| Control | Behavior |
| --- | --- |
| Repository access | Read-only SSH deploy key; no GitHub PAT, password, or token is accepted in the command. |
| Release selection | Requires an administrator-reviewed, complete 40-character Git SHA. Branch names and abbreviated SHAs are rejected. |
| GitHub server identity | Downloads GitHub’s published SSH host keys from the authenticated GitHub Meta API and uses a dedicated strict `known_hosts` file. It does not accept an unknown first-use SSH key. |
| Source integrity | Fetches the exact SHA, compares the resolved SHA, checks out detached, and rejects an unexpectedly modified source tree. |
| Existing-deployment protection | Stops if the source directory exists or the portal service is active. |
| TLS | Supports Let’s Encrypt, an existing Cloudflare Origin CA PEM pair, and automated Cloudflare Origin CA issuance from a root-owned `0600` token file. |
| Health | Requires local portal readiness. Public HTTPS is checked separately because DNS/proxy/certificate propagation can still be pending immediately after a correct installation. |
| Initial administrator | Captures name/email and creates the local administrator only after the protected application deployment succeeds; its generated password is shown once on the VPS console. |

## Recommended production procedure

Use the current [Guided Master Installer](MASTER_PORTAL_INSTALLER.md) and [Portal Production VPS Deployment Runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md). Download the reviewed master script from authenticated GitHub, transfer it to the new VPS, then run:

```bash
sudo bash /root/readypackets-master-install.sh
```

The terminal captures the deployment information and displays a newly generated deploy-key public half for a repository administrator to register. It rejects the separate public-website hosts `readypackets.com` and `www.readypackets.com`, and does not accept secrets on the command line.

## Advanced non-interactive procedure

Use the lower-level bootstrap only where a reviewed automation process already owns the deploy-key, exact commit, hostname, TLS method, and certificate/token-file inputs. For a Cloudflare-proxied production portal, the command shape is:

```bash
sudo bash /root/github-bootstrap-install.sh \
  --repository readypackets/ReadyPackets-SiteSplit \
  --commit <REVIEWED_40_CHARACTER_SHA> \
  --domain my.readypackets.com \
  --portal-alias portal.readypackets.com \
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

`--portal-alias` is optional, repeatable up to five times, and currently supported only by the native installer. Create DNS for every listed name before deployment. The certificate must cover every name, and Nginx permanently redirects each alias to the canonical `--domain` before it can reach the application. This preserves one `APP_URL`, SAML/native callback origin, and host-only session/CSRF cookie origin. It does not authorize wildcard or arbitrary Host headers, and `readypackets.com` plus `www.readypackets.com` remain reserved for the separately hosted website.

The current installer applies **51 forward-only migrations** and fails closed unless **44 critical tables** verify successfully. It provisions the portal service as the unprivileged `readypackets` user; secrets remain in root-owned `/etc/readypackets/portal.env`, and neither Node.js port `3000` nor MySQL port `3306` is made public.

## After a successful installation

Create the first local administrator, enroll MFA, validate the dedicated portal hostname, configure encrypted off-host backups, and complete an isolated restore drill before onboarding customers. Configure email, payment, SharePoint/Graph, SAML, SIEM/syslog, and consented analytics only through the protected administrator portal.

See also: [Self-Hosted Installation Guide](SELF_HOSTED_INSTALLATION_GUIDE.md), [Global Growth & Horizontal Scaling Architecture](GLOBAL_SCALE_ARCHITECTURE.md), and [Approved Auto-Deployment](AUTO_DEPLOYMENT.md).
