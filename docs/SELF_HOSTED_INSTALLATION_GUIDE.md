# ReadyPackets Self-Hosted Installation Guide

**Audience:** Infrastructure administrators deploying ReadyPackets on a new Ubuntu server.

**Current installation target:** Native VPS deployment with Ubuntu LTS, Node.js 22, MySQL 8, nginx, systemd, protected local backups, and a self-hosted ReadyPackets service. The native deployment is the recommended production path because it includes the platform backup, migration, update, and rollback helpers.

> ReadyPackets is self-hosted. The installer generates application encryption keys locally on the VPS, binds the application only to `127.0.0.1:3000`, keeps MySQL private, and places nginx in front of the portal. Do not expose ports `3000` or `3306` to the Internet.

## 1. Choose the correct installation path

| Situation | Recommended procedure |
|---|---|
| **New production VPS with a private GitHub repository** | Use the read-only GitHub deploy-key path in this guide, then run `deploy/install.sh`. |
| **New VPS with an approved public source repository** | Use the guided `one-click-install.sh` bootstrap. It reviews settings before it changes the host. |
| **Existing ReadyPackets native installation** | Pull the reviewed source under `/srv/readypackets`, then re-run `deploy/install.sh` with `--skip-packages`. Do not run a fresh bootstrap over an active service. |
| **Replacement server / disaster recovery** | Install a clean native portal first, verify schema readiness, then use the root-console full restore flow described in [Full Backup Restore](FULL_BACKUP_RESTORE.md). |
| **Existing Docker estate** | Use `deploy/unified-install.sh --mode docker` or `--mode docker-bootstrap`. Native VPS remains the recommended path for most installations. |

The active production application is installed at `/opt/readypackets`. The source checkout used for deployment belongs at `/srv/readypackets`; do not expect `/opt/readypackets` to be a Git checkout.

## 2. VPS and DNS prerequisites

Use a supported Ubuntu LTS server with a static public IP address, root or sudo access, and enough capacity for MySQL, Node.js, customer files, and backups. A practical starting point is **2 vCPU, 4 GB RAM, and 80 GB SSD**, with additional storage for order-file and archive growth.

Create an `A` record for the chosen hostname before certificate issuance. For an apex domain such as `readypackets.com`, the installer also configures the conventional `www.readypackets.com` alias and certificate coverage. If IPv6 is used, ensure the matching `AAAA` record points to the same server.

| Port | Purpose | Required public exposure |
|---|---|---|
| `22/tcp` | SSH administration | Restrict to known administrator IP addresses where practical. |
| `80/tcp` | HTTP redirect and Let’s Encrypt HTTP-01 validation | Public for Let’s Encrypt deployments. |
| `443/tcp` | ReadyPackets HTTPS portal | Public. |
| `3000/tcp` | ReadyPackets Node.js application | **Never public.** Loopback only. |
| `3306/tcp` | MySQL | **Never public.** Local only. |

Prepare the operating system, then reconnect after the reboot:

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git openssh-client
sudo reboot
```

```bash
hostnamectl
lsblk
sudo ufw status verbose
```

## 3. Securely obtain the ReadyPackets source

For the private `readypackets/ReadyPackets` repository, use a read-only deploy key. Do not place a personal access token in a shell command, Git remote URL, environment file, browser console, or source repository.

```bash
sudo install -d -m 0700 /root/.ssh
sudo ssh-keygen -t ed25519 -f /root/.ssh/readypackets_deploy -N '' -C 'readypackets-production-deploy'
sudo cat /root/.ssh/readypackets_deploy.pub
```

Add the displayed public key in GitHub under **Repository → Settings → Deploy keys**. Leave **Allow write access** disabled. Then configure the server and clone the repository:

```bash
sudo tee /root/.ssh/config >/dev/null <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile /root/.ssh/readypackets_deploy
  IdentitiesOnly yes
EOF
sudo chmod 0600 /root/.ssh/config

sudo ssh -T git@github.com || true
sudo git clone git@github.com:readypackets/ReadyPackets.git /srv/readypackets
cd /srv/readypackets
sudo git rev-parse --verify HEAD
```

GitHub may state that shell access is unavailable after successful deploy-key authentication. That response is normal; the `git clone` result is the relevant access test.

## 4. Native VPS installation — Let’s Encrypt

Use Let’s Encrypt only when the hostname resolves directly to this VPS and Cloudflare or another proxy permits HTTP-01 validation. Use a real contact address for expiry notices.

```bash
cd /srv/readypackets
sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/install.sh \
  --domain portal.example.com \
  --email operations@example.com \
  --tls-provider letsencrypt \
  --site-name ReadyPackets
```

For an apex domain, substitute `readypackets.com` for `portal.example.com`. The installer requests certificate coverage for the apex and `www` alias when applicable.

## 5. Native VPS installation — automated Cloudflare Origin CA

For a Cloudflare-proxied site, set **Cloudflare SSL/TLS mode to Full (strict)** and keep both portal DNS records proxied (orange cloud). A Cloudflare Origin CA certificate is trusted by Cloudflare at the origin; it is not intended for a browser that connects directly to the VPS.

Create a least-privilege Cloudflare API token scoped to the target zone with **Zone → SSL and Certificates → Edit**. Enter the token through a root-only temporary file rather than through an environment variable or command-line argument.

```bash
sudo install -d -m 0700 /root/readypackets-secrets
sudo sh -c 'umask 077; cat > /root/readypackets-secrets/cloudflare-origin-ca.token'
sudo chown root:root /root/readypackets-secrets/cloudflare-origin-ca.token
sudo chmod 0600 /root/readypackets-secrets/cloudflare-origin-ca.token
```

Paste the scoped token, press `Enter`, then press `Ctrl+D`. Issue and install a 15-year Origin CA certificate:

```bash
cd /srv/readypackets
sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/install.sh \
  --domain readypackets.com \
  --tls-provider cloudflare-origin-ca \
  --cloudflare-api-token-file /root/readypackets-secrets/cloudflare-origin-ca.token \
  --cloudflare-origin-validity 5475 \
  --site-name ReadyPackets
```

After successful issuance, remove the one-time token file and revoke the token unless it is being retained under an approved renewal procedure:

```bash
sudo shred -u /root/readypackets-secrets/cloudflare-origin-ca.token
```

The installed certificate material is stored under `/etc/readypackets/tls/cloudflare-origin/`, and nginx reads the managed `/etc/readypackets/tls/nginx-tls.conf` include.

### Manual Cloudflare Origin CA certificate

If a certificate and private key were generated in the Cloudflare dashboard, place them in root-only paths and use this alternative:

```bash
cd /srv/readypackets
sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/install.sh \
  --domain portal.example.com \
  --tls-provider cloudflare-origin \
  --cloudflare-origin-cert /root/readypackets-secrets/origin-cert.pem \
  --cloudflare-origin-key /root/readypackets-secrets/origin-key.pem \
  --site-name ReadyPackets
```

## 6. Guided fresh-VPS bootstrap

If the approved source repository is publicly retrievable, a guided installer can collect deployment choices through a terminal review. It asks for the mode, hostname, display name, certificate model, optional encrypted configuration-vault recovery, backup schedule, initial administrator, and a final confirmation phrase.

```bash
curl -fsSLO https://raw.githubusercontent.com/readypackets/ReadyPackets/main/deploy/one-click-install.sh \
  && chmod 0700 one-click-install.sh \
  && sudo ./one-click-install.sh
```

The guided installer supports Let’s Encrypt, manual Cloudflare Origin CA PEM files, and automated Cloudflare Origin CA issuance with a scoped token. It performs an unauthenticated source-reachability check and is appropriate only while the source repository is intentionally public. Follow [Temporary Public-Repository Installation](TEMPORARY_PUBLIC_REPOSITORY_INSTALL.md) for the required preflight, immutable-commit, and re-private steps. It prints the installed commit at completion. For a failed **fresh** installation only, use its controlled resume path; it refuses to run against an active ReadyPackets service.

## 7. What the installer creates and verifies

The installer is idempotent. On a clean server it installs system packages, creates the service account, generates local secrets, configures MySQL, builds the application, runs migrations, verifies the critical schema contract, configures systemd and nginx, configures TLS, installs protected backup helpers, and runs a local readiness probe.

| Location or service | Purpose |
|---|---|
| `/opt/readypackets` | Deployed server bundle and client assets. |
| `/srv/readypackets` | Deployment source checkout. |
| `/etc/readypackets/portal.env` | Root-protected runtime settings and generated application secrets. |
| `/var/lib/readypackets/storage` | Uploaded and generated customer files. |
| `/var/backups/readypackets` | Root-protected full backup archives. |
| `readypackets.service` | Node.js portal service, bound only to `127.0.0.1:3000`. |
| `/etc/nginx/sites-available/readypackets` | nginx reverse-proxy configuration. |
| `readypackets-backup.timer` | Nightly protected backup schedule. |

> Do not replace `DATA_ENCRYPTION_KEY` or `EMAIL_INDEX_KEY` after customer data exists. The first protects encrypted customer fields; the second supports protected email lookup. Both must be retained for a successful replacement-server recovery.

A current installation fails closed if migrations leave a required critical table or column absent. It names the incomplete schema object and stops before exposing a partly working portal.

## 8. First administrator and initial configuration

After installation, create the first administrator if the installer did not provision one. Replace the sample address with the real administrator email address:

```bash
sudo runuser -u readypackets -- env $(grep -v '^#' /etc/readypackets/portal.env | xargs) \
  node /opt/readypackets/dist/create-admin.js --email admin@example.com
```

Store any generated temporary password in an approved password manager. Sign in over HTTPS, enroll the administrator’s required MFA, save the recovery codes, and then complete the protected settings under **Admin → Platform setup**, **Admin → Integrations**, **Admin → Finance**, **Admin → Security centre**, and **Admin → Backup Management**.

Configure SMTP or Microsoft Graph mail delivery, Stripe settings/webhook verification, Microsoft Entra ID when required, phase webhooks, SharePoint, trusted administrative network controls, backup retention, and at least one encrypted off-host backup destination.

## 9. Required post-install verification

Run these checks before inviting users:

```bash
sudo systemctl status readypackets nginx mysql --no-pager
sudo systemctl is-enabled readypackets readypackets-backup.timer
sudo nginx -t
sudo systemctl list-timers readypackets-backup.timer certbot.timer
curl -fsS https://portal.example.com/api/health
curl -fsS https://portal.example.com/api/health/ready
sudo ss -ltnp | grep -E ':(22|80|443|3000|3306)'
```

The health endpoints should return `{"status":"ok"}` and `{"status":"ready"}`. Node.js and MySQL must remain private on loopback; nginx alone should accept public portal traffic.

For a Cloudflare Origin CA installation, verify the certificate path and nginx include:

```bash
sudo openssl x509 \
  -in /etc/readypackets/tls/cloudflare-origin/certificate.pem \
  -noout -issuer -subject -dates
sudo cat /etc/readypackets/tls/nginx-tls.conf
```

A `308 Permanent Redirect` from an apex hostname to the canonical `www` hostname is expected when the installer configured that canonical pair. A `522` returned by Cloudflare means Cloudflare cannot reach the origin; first confirm the VPS firewall allows `80`/`443`, nginx is active, and the DNS records point to the correct server.

## 10. Backup and replacement-server recovery

Use **Admin → Backup Management** for routine portal recovery. That standard restore validates the archive, restores database and order-file content, and intentionally retains the target server’s hostname, TLS material, and protected secret environment.

For a complete replacement-server migration, install a clean portal first and verify its health. Then use the root-console recovery mode with the protected full archive:

```bash
sudo /opt/readypackets/deploy/restore.sh \
  --archive /var/backups/readypackets/readypackets-YYYYMMDDTHHMMSSZ.tar.gz \
  --yes \
  --restore-platform-secrets
```

This deliberate command restores the database, ReadyPackets-managed files, application/integration settings, encryption keys, and backup-sync runtime when included. It preserves the replacement server’s database connection, hostname, network binding, and TLS configuration. Review [Full Backup Restore](FULL_BACKUP_RESTORE.md) before performing a recovery.

## 11. Updating an existing native portal

Use the built-in **Admin → Platform updates** approval workflow for ordinary application updates. It creates a protected snapshot, performs a reviewed update, performs health checks, and offers rollback.

For a controlled installer re-run after system packages are already installed, update the deployment source and preserve the existing TLS configuration by not specifying a new TLS provider:

```bash
cd /srv/readypackets
sudo git fetch origin main
sudo git pull --ff-only origin main
sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/install.sh \
  --domain portal.example.com \
  --skip-packages
```

Do not use this command to change a live hostname or replace TLS keys. Use the portal’s domain/certificate management controls or follow a planned certificate-change procedure instead.

## 12. Troubleshooting

| Symptom | Correct first action |
|---|---|
| Installer reports a missing database table or column | Do not manually alter the database. Pull the reviewed current source and re-run the installer so its forward-only migrations and schema contract execute. |
| P101 or P201 fails before queueing a webhook | Check `sudo journalctl -u readypackets.service -n 150 --no-pager`; verify the installation completed its critical schema contract. |
| Let’s Encrypt validation fails through Cloudflare | Confirm the proxy/firewall permits HTTP-01 validation, or use Cloudflare Origin CA with Full (strict). |
| Cloudflare returns `522` | Verify DNS, Cloudflare proxy status, VPS firewall `80`/`443`, nginx service status, and local readiness before changing application settings. |
| Health responds with `308` at the apex hostname | Follow the redirect or check the canonical `www` host; the redirect is not a readiness failure. |
| Cannot find a Git checkout under `/opt/readypackets` | Use `/srv/readypackets`; `/opt/readypackets` is the deployed artifact directory. |
| Restore preflight rejects an archive | Re-run the archive preflight, confirm the passphrase and archive integrity, and use the full replacement-server path only when the protected secret environment must be restored. |

## 13. Go-live security acceptance

Before public launch, verify that HTTPS is active; Cloudflare is set to **Full (strict)** if proxying; SSH uses named administrators and key-based access; ports `3000` and `3306` are private; every administrator has MFA; the first full backup has been tested in an isolated restore drill; an encrypted off-host backup destination is configured; Stripe webhooks have been tested; external webhooks have approved endpoints; and encryption keys are retained in an approved recovery vault.

## References

[1]: https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/ "Cloudflare Origin CA"
[2]: https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/ "Cloudflare Full (strict)"
[3]: https://eff-certbot.readthedocs.io/en/stable/using.html "Certbot user guide"
[4]: https://docs.github.com/authentication/connecting-to-github-with-ssh/managing-deploy-keys "GitHub deploy keys"
[5]: https://dev.mysql.com/doc/refman/8.0/en/ "MySQL 8.0 Reference Manual"
