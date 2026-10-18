# ReadyPackets Portal — Self-Hosted Installation Guide

**Audience:** Infrastructure administrators installing the ReadyPackets Portal on a new Ubuntu VPS.

The recommended production deployment is the authenticated ReadyPackets Portal on its own native Ubuntu 24.04 LTS VPS, for example `my.readypackets.com` or `portal.readypackets.com`. It is separate from the public ReadyPackets website at `www.readypackets.com`, which may remain hosted on Hostinger or another static host.

The recommended one-script procedure is [Guided Master Installer](MASTER_PORTAL_INSTALLER.md). It safely captures the name, canonical portal hostname, optional bounded canonical-redirect aliases, first administrator, TLS method, and reviewed release on the new VPS. The authoritative detailed controls remain in [Portal Production VPS Deployment Runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md).

## Deployment safety model

- The portal is self-hosted: it has no Manus runtime, OAuth, hosting, identity, or application dependency.
- The native deployment runs Node.js 22 as the unprivileged `readypackets` user, behind Nginx, with MySQL and Node.js bound privately.
- Use the private repository `readypackets/ReadyPackets-SiteSplit` and a repository-scoped, read-only GitHub deploy key.
- Install a reviewed, complete 40-character Git SHA. Never deploy a moving branch tip, an abbreviated SHA, a personal access token embedded in a clone URL, or an unreviewed source archive.
- The fresh-server bootstrap refuses an existing source directory or live portal service. Existing environments must use the approved update or recovery procedure instead.
- The installation applies **51 forward-only migrations** and fails closed unless it verifies **44 critical schema-contract tables**.
- Secrets are generated locally and stored at `/etc/readypackets/portal.env`, readable only by root and the service account group. Do not commit, transmit, or rotate the encryption keys after protected data exists.

## Recommended starting capacity

| Use | vCPU | RAM | NVMe storage |
| --- | ---:|---:|---:|
| Evaluation | 2 | 4 GB | 80 GB |
| Initial production | 4 | 8 GB | 160 GB |
| Conversion-heavy workload | 8 | 16 GB | 320 GB+ |

For horizontal/global rollout, use the staged design in [Global Growth & Horizontal Scaling Architecture](GLOBAL_SCALE_ARCHITECTURE.md). Web replicas must use the shared private object-storage and dedicated worker model; do not use the single-server local storage path across multiple nodes.

## New private-repository VPS installation

1. Create one dedicated DNS record for the canonical portal, not for the externally hosted public website. If you use aliases such as `portal.readypackets.com`, create DNS for each alias to the same VPS before installing.
2. Keep `80/tcp` and `443/tcp` public, restrict `22/tcp`, and leave `3000/tcp` and `3306/tcp` private.
3. Generate and register a **read-only** deploy key for the private portal repository.
4. Review the desired release and record its exact 40-character commit SHA.
5. Securely transfer the reviewed `deploy/github-bootstrap-install.sh` script to the new VPS.
6. For Cloudflare, set the portal record to **Proxied**, use **Full (strict)**, and place a least-privilege Origin CA API token in a root-owned `0600` temporary file.
7. Run the bootstrap, for example:

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

The `--portal-alias` line is optional and can be repeated for up to five explicit hostnames. Each must be present in DNS and TLS, and it receives only a permanent redirect to the canonical `--domain`; it is not a second portal session origin. For direct-DNS Let’s Encrypt, use `--tls-provider letsencrypt --email operations@readypackets.com` instead. The full commands, prerequisite checks, Cloudflare and deploy-key setup, token hygiene, verification, troubleshooting, administrator bootstrap, and go-live checklist are in the [production runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md).

## Existing portal update or replacement-server recovery

Do not run a fresh installer on a working portal. Use **Admin → Platform updates** for an administrator-reviewed exact release with protected snapshot and rollback controls. See [Approved Auto-Deployment](AUTO_DEPLOYMENT.md).

For a replacement server, first complete and validate a new installation, then use the protected full recovery process in [Full Backup and Recovery](FULL_BACKUP_RESTORE.md). The portable restore preserves the target server's hostname, TLS identity, network binding, storage identity, and target encryption material while restoring eligible system data; host-specific external callbacks must be reconfigured after a domain change.

## Required post-install actions

- Create the first local administrator from the protected console; enroll MFA and store recovery codes securely.
- Verify `readypackets.service`, Nginx, MySQL, TLS, local readiness, and public health.
- Confirm an encrypted off-host backup destination; run a full backup and isolated restore drill before accepting customer files.
- Configure email, payment, SharePoint/Graph, SAML, SIEM/syslog, cookie consent, and optional analytics only through the authenticated administrator portal.
- Record the deployed commit, server region, owner, backup location, TLS choice, recovery drill date, and approved change record.

## Temporary-public source window

A temporary-public GitHub repository window is a last-resort source-retrieval option, not the normal deployment model. It must not expose current or historical secrets, customer data, backups, environment files, certificates, or private keys. Review [Temporary Public-Repository Installation](TEMPORARY_PUBLIC_REPOSITORY_INSTALL.md) before considering it.
