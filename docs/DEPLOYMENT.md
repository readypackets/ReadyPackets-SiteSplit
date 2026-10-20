# Deployment Guide

**Applies to:** ReadyPackets Portal, self-hosted build
**Targets:** A Linux VPS with systemd, or any Docker host

This guide covers both supported deployment models end to end, including TLS, email, backups, upgrades, and recovery. The application has no external service dependency: once the host, database, and reverse proxy are in place, nothing else is contacted.

## Requirements

| Component | Minimum | Recommended |
| --- | --- | --- |
| CPU | 1 vCPU | 2 vCPU |
| Memory | 2 GB | 4 GB |
| Disk | 20 GB SSD | 40 GB SSD, growing with uploads |
| Operating system | Ubuntu 22.04, Ubuntu 24.04, or Debian 12 | Ubuntu 24.04 LTS |
| Node.js | 22.x | 22.x LTS |
| MySQL | 8.0 | 8.4 |
| Reverse proxy | nginx 1.24 | nginx 1.27 |

Memory is the binding constraint rather than CPU, because Argon2id is deliberately memory-hard: each password verification allocates 64 MB briefly. A 2 GB host is comfortable for normal traffic; 4 GB gives headroom for concurrent logins alongside MySQL's buffer pool.

Before starting, point an A record (and an AAAA record if you have IPv6) at the server, and confirm that ports 80 and 443 are reachable. Certificate issuance depends on it.

### Running on a 1 GB host

The reference deployment runs on a 1 GB instance, which is below the stated minimum and works only because two adjustments were made first. Both are necessary rather than advisable: without them the kernel's out-of-memory killer will eventually reap either MySQL or the application, and on a 1 GB host that is a question of when rather than whether.

```bash
# Swap, since a 1 GB instance typically ships with none.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-readypackets.conf

# MySQL sized for the host rather than for the defaults, which assume a far larger machine.
sudo tee /etc/mysql/mysql.conf.d/99-readypackets.cnf >/dev/null <<'CNF'
[mysqld]
innodb_buffer_pool_size = 192M
innodb_log_buffer_size  = 8M
max_connections         = 40
bind-address            = 127.0.0.1
CNF
sudo systemctl restart mysql
```

A 1 GB host is adequate for evaluation and light production. Move to 4 GB before a launch or a marketing push.

### Ubuntu 22.04 and nginx 1.18

Ubuntu 22.04 ships nginx 1.18, which predates the `http2 on;` directive. The supplied configuration uses the `listen ... http2` form, which is valid on both 1.18 and 1.25 or later, so no change is needed. What does matter is that **nginx keeps its last valid configuration when a reload fails**, so a configuration error can leave the previous version serving while appearing to have applied. Always confirm a reload took effect rather than trusting its exit status:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -sI https://your.domain/ | head -1   # confirm the new behaviour is live
```

The installer also depends on `nginx-extras` for the headers-more module, which removes the `Server` header. On a base nginx install the header remains; the site still works, and the installer detects this rather than emitting a directive that would fail the whole configuration.

## Option A: VPS with systemd

The installer is the supported path. It is idempotent, so it is safe to re-run after a configuration change or an upgrade.

```bash
git clone <repository-url> readypackets
cd readypackets
sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 ./deploy/install.sh \
  --domain my.readypackets.com --portal-alias portal.readypackets.com \
  --email ops@readypackets.com --tls
```

The `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` prefix is not optional in an unattended run. Without it corepack prompts for confirmation before fetching pnpm, and the installer blocks on standard input with no indication of why.

The installer performs the following, in order:

1. Installs system packages, and Node.js 22 if a suitable version is absent.
2. Creates the `readypackets` service account with no login shell and no home directory.
3. Creates the database and a user with only the privileges the application needs, deliberately excluding `DROP`, `GRANT`, and `FILE`, and binds MySQL to loopback.
4. Generates `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`, `EMAIL_INDEX_KEY`, and the database password from the kernel CSPRNG. **Existing values are reused on re-run**, so encrypted data is never orphaned.
5. Builds the client bundle and the server bundle, then prunes to production dependencies.
6. Writes `/etc/readypackets/portal.env` as mode `0640`, owned by root with the service account as group.
7. Applies migrations and seeds the catalogue, policies, email templates, and settings.
8. Installs and starts the systemd unit.
9. Installs the nginx site, obtains a certificate with certbot when `--tls` is given, and reinstates the hardened configuration afterwards, because certbot rewrites the file it touches.
10. Configures `ufw` to allow only SSH, 80, and 443. **Port 3000 is never opened**; the application is reachable only through the proxy.
11. Configures fail2ban for SSH and for nginx rate-limit violations.
12. Installs log rotation and the nightly backup timer.
13. Runs one backup immediately and reports the artefact, because an untested backup is not a backup, and installation is a better time to discover a broken one than a restore.
14. Verifies that the service is active and the readiness probe succeeds.

### Create the first administrator

```bash
sudo runuser -u readypackets -- \
  env $(grep -v '^#' /etc/readypackets/portal.env | xargs) \
  node /opt/readypackets/dist/create-admin.js --email you@readypackets.com
```

The command prints a generated password once. Sign in, then **enrol multi-factor authentication immediately** — administrative procedures require a satisfied factor challenge, so until enrolment completes the account can reach only the enrolment flow.

Two practical notes. The script accepts `--generate-password`, which is preferable to `--password`, since a password on the command line lands in shell history. And if the account is created before `EMAIL_INDEX_KEY` is set in the environment, its email blind index is computed under a different key and the account becomes **unfindable at sign-in** — not insecure, but unreachable. Always create administrators using the same environment the service runs with, exactly as above.

### Installer options

| Option | Effect |
| --- | --- |
| `--domain <host>` | Public hostname; required, and used for origin checks, cookie scope, and the certificate |
| `--portal-alias <host>` | Native installer only; repeat up to five explicit names. Each is included in certificate validation and permanently redirects to the canonical `--domain` before reaching Node. |
| `--email <address>` | Certificate contact address; required with `--tls` |
| `--tls` | Obtain a Let's Encrypt certificate |
| `--no-seed` | Skip catalogue seeding, for use when restoring a backup |
| `--skip-packages` | Assume Node, MySQL, and nginx are already present |

## Option B: Docker

```bash
cp .env.example .env
# Generate the three secrets:
openssl rand -base64 48 | tr -d '\n='   # SESSION_SECRET
openssl rand -hex 32                    # DATA_ENCRYPTION_KEY
openssl rand -hex 32                    # EMAIL_INDEX_KEY
# Edit .env: set APP_URL, MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD, and the three secrets.

docker compose up -d
docker compose exec app node dist/migrate.js
docker compose exec app node dist/seed.js
docker compose exec app node dist/create-admin.js --email you@readypackets.com
```

The compose file publishes the application on `127.0.0.1:3000` only, so a reverse proxy on the host must terminate TLS. To run nginx in a container instead, place your certificates in `deploy/tls/`, adjust `deploy/nginx.conf`, and start with `docker compose --profile proxy up -d`.

Container hardening is already applied: the application runs as an unprivileged user on a read-only root filesystem, all capabilities are dropped, `no-new-privileges` is set, a small `noexec` tmpfs covers the one writable path, and the database port is not published at all.

### Container operations

```bash
docker compose logs -f app                 # follow logs
docker compose ps                          # health status
docker compose restart app                 # restart after a configuration change
docker compose down                         # stop, preserving volumes
docker compose build --no-cache app         # rebuild after a code change
```

## Horizontal and global growth

The default installer deploys a safe single-node portal (`INSTANCE_ROLE=all`) for an initial self-hosted site. Do not clone that local-disk pattern behind a load balancer. For scale-out, use private S3-compatible storage, a shared highly available MySQL service, and independent roles:

```dotenv
# web replicas behind the load balancer
INSTANCE_ROLE=web
DATABASE_CONNECTION_LIMIT=8
STORAGE_DRIVER=s3

# exactly one active worker (or one active plus standby)
INSTANCE_ROLE=worker
DATABASE_CONNECTION_LIMIT=12
STORAGE_DRIVER=s3
```

Web-only replicas do not execute recurring jobs. Worker-capable instances coordinate scheduler jobs with MySQL named locks, so a standby cannot duplicate queue work. Run migrations once as a controlled release step **before** increasing web-replica count; do not have every replica apply DDL. Full design, regional rollout, residency, least privilege, and failover controls are in [GLOBAL_SCALE_ARCHITECTURE.md](GLOBAL_SCALE_ARCHITECTURE.md).

## Configuration

Every setting is documented in `.env.example`. Configuration is validated at startup and the process **refuses to start** when a required secret is missing, too short, or left at a development default. This is intentional: an install that boots with a predictable key is worse than one that fails visibly.

### Required

| Variable | Notes |
| --- | --- |
| `APP_URL` | Canonical **portal/API** URL. Determines session-facing links, SAML/native callback identity, and the authenticated host. |
| `PUBLIC_SITE_URL` | Optional same-VPS anonymous marketing-site URL. Set it to a distinct HTTPS hostname only when this portal VPS intentionally also hosts the public bundle. |
| `PORTAL_ONLY` | `true` for the recommended topology: serve only the portal bundle on `APP_URL`; never treat an external marketing hostname as a portal host, cookie domain, or API origin. |
| `MARKETING_SITE_URL` | Navigation-only HTTPS origin for the separately hosted public website. It is injected into the portal shell for outward links and is never accepted as an application host or Origin. |
| `PORTAL_ALIASES` | Installer-managed comma-separated redirect aliases. Keep `APP_URL` canonical; aliases must never be added as application origins because they redirect before host-only portal cookies are issued. |
| `DATABASE_URL` | `mysql://user:password@host:3306/database` |
| `SESSION_SECRET` | At least 32 characters of random data |
| `DATA_ENCRYPTION_KEY` | Exactly 64 hex characters. **Loss is unrecoverable.** |
| `EMAIL_INDEX_KEY` | Exactly 64 hex characters. Loss breaks email lookup. |

### Proxy awareness

`TRUST_PROXY_HOPS` must equal the number of proxies in front of the application: `1` for nginx on the same host, `2` when a CDN sits in front of nginx. Setting it too high lets a client spoof its apparent address by forging `X-Forwarded-For`, which would defeat rate limiting and any IP allowlist. Setting it too low makes every request appear to originate from the proxy, so one abusive client throttles everyone. Set `BEHIND_CLOUDFLARE=true` to prefer `CF-Connecting-IP`.

### Email

Until SMTP is configured, messages queue in the database and the administrative dashboard reports the queue as degraded. Nothing is lost; the queue drains once credentials are supplied.

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false          # true only for implicit TLS on 465
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=no-reply@readypackets.com
```

Publish SPF, DKIM, and DMARC records for the sending domain. Security notifications that land in spam are equivalent to notifications never sent.

### Optional integrations

Both are disabled unless configured, and the application is fully functional without either. Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) enables card capture; without it, staff record payment states manually, and the order state machine supports the full payment lifecycle including refunds either way. SAML (`SAML_ENABLED`, `SAML_ENTRY_POINT`, `SAML_ISSUER`, `SAML_IDP_CERT`) enables staff single sign-on; local accounts with MFA remain available regardless.

`ADMIN_IP_ALLOWLIST` accepts a comma-separated list of addresses and CIDR ranges. When set, the administrative surface is reachable only from those sources. Use it if administration does not need to happen from arbitrary networks; it is the single highest-value optional control.

## TLS

With `--tls`, certbot obtains and installs the certificate and configures renewal. Verify renewal explicitly rather than assuming it:

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

For a certificate from another authority, place the chain and key on the host, update the two `ssl_certificate` paths in the nginx site, and reload. Do not remove the `Strict-Transport-Security` header once it has been served, because browsers will refuse plain HTTP for the duration of `max-age` regardless.

## Backups

The nightly timer runs at 02:30 local time with a randomised delay. Each run produces one archive containing the database dump, the uploaded files, a manifest, and checksums.

The installer pre-provisions `/var/backups/readypackets`, protected browser-download staging, restore-upload staging, and `/var/lib/readypackets/backup-control` with fixed root-controlled ownership and modes before the capability-restricted socket controller starts. The controller verifies those fixed directories on requests; it does not attempt `chmod` or `chown` inside its systemd sandbox. If an existing host reports that backup control is unavailable because permission changes were denied, update through the approved platform-update path or re-run the reviewed native installer with its canonical `--domain` and `--skip-packages` parameters—do not relax the service sandbox.

### Standard Platform Setup profile

**Administration → Platform setup** can download and import a portable versioned JSON setup profile. It preserves non-secret choices such as email transport fields, SharePoint site/library/base-folder identifiers, backup schedule and target labels, public Stripe key, and webhook destinations. It intentionally excludes all secrets and host identity: passwords, client secrets, OAuth tokens, certificates, private keys, Stripe secret/webhook keys, webhook signing secrets, `APP_URL`, TLS, database values, and access-control activation. Import requires the replacement operator to enter secrets again; imported webhooks are saved disabled for review. Use encrypted `.rpconfig` migration archives—not setup profiles—only when the documented full configuration-transfer process is approved.

```bash
sudo /usr/local/sbin/readypackets-backup                          # run now
sudo /usr/local/sbin/readypackets-backup --output /mnt/backups    # alternative destination
sudo /usr/local/sbin/readypackets-backup --encrypt --recipient ops@readypackets.com
systemctl list-timers readypackets-backup.timer
```

> **The archive contains `DATA_ENCRYPTION_KEY`.** This is deliberate, because without that key the encrypted columns in the dump cannot be read. It also means the archive is equivalent to the full customer database in plaintext. Encrypt archives that leave the host, and store them somewhere the application cannot write, so that ransomware on the application host cannot destroy them.

Copy archives off the host on a schedule. A backup on the same disk as the data protects against deletion, not against disk failure or host compromise.

### Restore

```bash
sudo ./deploy/restore.sh --archive /var/backups/readypackets/readypackets-<timestamp>.tar.gz
```

The script verifies checksums, prints the manifest, compares the archive's encryption key against the running configuration and warns loudly on mismatch, takes a safety dump of the current database, stops the service, restores, reapplies migrations, restarts, and probes readiness. It refuses to proceed without an explicit typed confirmation unless `--yes` is given.

**Test restores regularly.** A backup that has never been restored is an assumption:

```bash
sudo ./deploy/restore.sh --archive <file> --database rp_restore_test --no-files --yes
```

This loads into a scratch database and leaves production untouched.

## Upgrades

```bash
cd /path/to/checkout
git pull
sudo ./deploy/install.sh --domain portal.readypackets.com --skip-packages
```

The installer rebuilds, reuses existing secrets, applies pending migrations, and restarts. Under Docker:

```bash
git pull
docker compose build app
docker compose up -d app
docker compose exec app node dist/migrate.js
```

Take a backup before any upgrade, and run the verification suite afterwards against the real hostname:

```bash
pnpm exec tsx scripts/verify-security.ts https://portal.readypackets.com
```

Migrations are additive and idempotent; the runner records what it has applied and skips it on re-run.

## Monitoring

```bash
systemctl status readypackets
journalctl -u readypackets -f
journalctl -u readypackets -p err --since today
curl -fsS -H "Host: portal.readypackets.com" http://127.0.0.1:3000/api/health/ready
```

`/api/health` reports process liveness and is exempt from rate limiting so that a probe cannot be throttled into restarting a healthy service. `/api/health/ready` additionally verifies database connectivity and is the correct target for a load balancer. Neither discloses a version or configuration detail.

Logs are structured JSON on stdout, captured by journald under Docker or systemd. Set `SYSLOG_TARGET` to forward to a central collector. Within the application, the security centre surfaces the security and activity trails, login pressure by address, and open system alerts.

## Troubleshooting

**The service will not start.** Read `journalctl -u readypackets -n 50`. The most common cause is a missing or malformed secret; validation names the offending variable precisely. The second most common is an unreachable database.

**Requests return 421 Misdirected Request.** Host validation rejected the `Host` header. Confirm `APP_URL` matches the hostname being requested and that the proxy forwards `Host` unchanged. When testing against loopback, send the header explicitly: `curl -H "Host: portal.readypackets.com" http://127.0.0.1:3000/`.

**Mutations return 403.** The CSRF check failed. Verify the proxy is not stripping the `x-rp-csrf` header or rewriting `Origin`, and that clients reach the site over HTTPS, because the `__Host-` cookie prefix requires a secure context.

**The page loads but is blank, with policy violations in the console.** The nonce was not substituted, which happens when the client build is stale or missing. Rebuild and restart. As a last resort, set `CLIENT_DIST_PATH` to the absolute path of the build directory.

**Everything returns 429.** A rate-limit penalty is active for your address. Penalties are per category and expire; to clear one immediately, restart the service, since counters are in-process. Check the security log for the triggering events, and confirm `TRUST_PROXY_HOPS` is correct — if it is too low, every request appears to come from the proxy and one client throttles all others.

**Email is not being delivered.** Check the queue depth on the administrative dashboard. A growing queue with failures indicates SMTP credentials or connectivity; a growing queue with no attempts indicates SMTP is unconfigured.

**Uploads are rejected.** Validation is by magic bytes, so a file with a mismatched extension is refused by design. Confirm the type is in the allowed list, that the size is under `MAX_UPLOAD_BYTES`, and that nginx `client_max_body_size` exceeds it.

## Hardening checklist

Complete this before serving real customers.

- [ ] SSH restricted to key authentication, root login disabled
- [ ] `ufw` active, allowing only SSH, 80, and 443
- [ ] fail2ban active for SSH and nginx
- [ ] TLS certificate installed, renewal dry-run verified
- [ ] `DATA_ENCRYPTION_KEY` and `EMAIL_INDEX_KEY` backed up **separately from the database**
- [ ] MFA enrolled on every administrative account
- [ ] `ADMIN_IP_ALLOWLIST` set, if administration is from known networks
- [ ] SMTP configured with SPF, DKIM, and DMARC published
- [ ] Nightly backup timer active, and a restore tested into a scratch database
- [ ] Archives copied to storage the application host cannot write
- [ ] `pnpm exec tsx scripts/verify-security.ts https://your-domain` passes 46 of 46
- [ ] Unattended security upgrades enabled on the host
- [ ] Full-disk encryption enabled, if the provider supports it
