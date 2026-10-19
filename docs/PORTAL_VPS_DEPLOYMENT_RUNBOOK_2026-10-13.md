# ReadyPackets Portal — Production VPS Deployment Runbook

**Release repository:** <https://github.com/readypackets/ReadyPackets-SiteSplit> (private)
**Recommended runtime:** Native Ubuntu 24.04 LTS VPS with systemd, Nginx, MySQL, root-protected backups, and the ReadyPackets restricted update/recovery controllers.
**Current fresh-install checkpoint:** The installer must report **51 forward-only migrations** and **44 critical tables verified**.

> This runbook deploys only the authenticated ReadyPackets Portal at `my.readypackets.com` or `portal.readypackets.com`. The ReadyPackets website stays independently hosted at `www.readypackets.com` (and any staging hostname such as `go.readypackets.com`). Do not add an externally hosted website hostname to the portal installer.

## 1. Choose the safe deployment route

| Situation | Correct route | Do not use |
| --- | --- | --- |
| New/reimaged VPS; portal repository remains private | **Route A — reviewed private release with a read-only deploy key** | Anonymous source download or a personal access token in a command |
| New/reimaged VPS; repository is deliberately public for a short, controlled window | **Route B — temporary-public guided bootstrap** | Leaving the repository public after the release is installed |
| Working ReadyPackets Portal already exists | **Route C — approved in-place update** | Any fresh-server bootstrap or reinstallation |
| Replacement server recovery | Install a clean portal with Route A, verify it, then use the documented full restore | Copying database/files manually or overwriting live secrets |

The repository is private, so **Route A is the normal production installation path**.

> **Recommended one-script route:** Use [`deploy/master-install.sh`](../deploy/master-install.sh) on a brand-new native VPS. It collects the portal name/hostname, first administrator, TLS method, and immutable release; creates the restricted read-only GitHub deploy key; runs the full native installer; and creates the first local administrator. Its operator guide is [Guided Master Installer](MASTER_PORTAL_INSTALLER.md). The detailed manual Route A below remains available for reviewed automation and break-glass diagnostics.

## 2. Prerequisites before the VPS is changed

### Server capacity and operating system

Provision **Ubuntu 24.04 LTS** with a static public IPv4 address, sudo/root access, and at least:

| Environment | vCPU | RAM | NVMe storage |
| --- | ---:|---:|---:|
| Evaluation only | 2 | 4 GB | 80 GB |
| Recommended initial production | 4 | 8 GB | 160 GB |
| Conversion-heavy / higher volume | 8 | 16 GB | 320 GB+ |

The native installer provisions Node.js 22, MySQL 8, Nginx, the self-hosted document/audio converter toolchain, the portal service, restricted root controllers, log rotation, and the backup timer. It does **not** require any Manus service or identity provider.

### Network and DNS

1. Permit public inbound traffic only on `80/tcp` and `443/tcp`; keep `22/tcp` restricted to administrator networks where possible.
2. Do **not** expose `3000/tcp` (Node.js) or `3306/tcp` (MySQL). The installer binds them to loopback/private paths.
3. In Cloudflare DNS, create one canonical dedicated portal record. For example:

   ```text
   Type: A
   Name: my
   Target: <new-VPS-public-IPv4>
   Proxy: Proxied (orange cloud) for Cloudflare Origin CA
   ```

4. Optional explicit aliases such as `portal.readypackets.com` are supported only as permanent redirects to the canonical portal URL. Create a separate record for every selected alias, pointing to the same VPS and using the same Cloudflare proxy state. Do not use a wildcard record, and do not add aliases until their DNS is ready for certificate validation.
5. Keep `www.readypackets.com` and its Hostinger website record untouched. The website links to the portal; it does not share portal authentication cookies, CSRF state, database access, or customer files.
6. Before a migration or replacement-server deployment, retain and verify a full backup plus its recovery material. Never run a fresh installer over an active portal.

### TLS choice

| Choice | Use when | Required Cloudflare state |
| --- | --- | --- |
| **Cloudflare Origin CA automatic issuance — recommended** | The portal remains Cloudflare-proxied | Zone SSL/TLS mode **Full (strict)**; one zone-scoped token with only **Zone → SSL and Certificates → Edit** |
| **Cloudflare Origin CA existing certificate** | A reviewed Origin CA PEM certificate/key already exist in root-only files | **Full (strict)** |
| **Let's Encrypt** | The hostname points directly at the VPS for HTTP-01 validation | Temporarily set only the portal record to **DNS only** (grey cloud) if Cloudflare interferes |

Every selected canonical hostname and explicit portal alias must be present in the certificate SAN set. The installer sends every configured portal hostname to Cloudflare Origin CA and adds every name as a Let’s Encrypt `-d` value. A manual Origin CA PEM pair is rejected unless it covers every configured name.

Never paste a Cloudflare token, GitHub key, password, private key, database dump, portal environment file, or backup key into chat, source control, terminal history, or a URL.

### Add a portal alias after installation

After a reviewed platform update that includes alias administration is installed, sign in as an administrator and use **System → Domain & URL → Add a portal redirect alias**. The console lists the canonical URL, active aliases, and remaining capacity; it supports no more than five aliases and records success or failure in security and activity logs. The canonical `APP_URL` does not change, and aliases never become application origins or independent authentication/session URLs.

1. Create the alias DNS record for the portal VPS. Do not use a wildcard and do not use `readypackets.com` or `www.readypackets.com`.
2. With **Let’s Encrypt**, verify every published IPv4/IPv6 path reaches the VPS on port `80`. The controller temporarily enables only the ACME HTTP-01 path for the pending hostname, requests a SAN certificate for the canonical host plus every current alias, validates all SANs, then enables the alias TLS redirect. If issuance or verification fails, it restores the prior root-owned Nginx, TLS, and environment files.
3. With **Cloudflare Origin CA**, create a replacement Origin certificate in Cloudflare covering the canonical hostname, every active alias, and the pending alias. Keep every portal hostname proxied and use **Full (strict)**. In the console, provide the replacement certificate/key only in the protected modal; the controller validates the key pair and every hostname before it writes root-owned files.
4. Confirm the displayed operation phrase. The controller runs `nginx -t`, reloads only after validation, checks canonical local HTTPS health, and requires the new alias to return exactly `308 https://<canonical>/api/health` before it commits the protected alias list.

The redirect is deliberately terminal at Nginx. It does not proxy the alias into Node, issue a session cookie, trust an alias in CSRF/CORS checks, or reflect a client-controlled host in the redirect target.

## 3. Route A — private GitHub repository deployment

### 3.1 Create a read-only repository deploy key

Connect to the new VPS as a sudo-capable administrator and run:

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y ca-certificates curl git openssh-client

sudo install -d -m 0700 /root/.ssh
sudo ssh-keygen -t ed25519 \
  -f /root/.ssh/readypackets_deploy \
  -N '' \
  -C 'readypackets-portal-production-deploy'
sudo cat /root/.ssh/readypackets_deploy.pub
```

In GitHub:

1. Open <https://github.com/readypackets/ReadyPackets-SiteSplit/settings/keys>.
2. Select **Add deploy key**.
3. Give the key a clear name, such as `portal-vps-YYYY-MM-DD`.
4. Paste the one public-key line printed above.
5. Leave **Allow write access** **unchecked**.
6. Save the key.

The corresponding private key must remain only in `/root/.ssh/readypackets_deploy` with `0400` or `0600` permissions. It is a source-read credential, not a general GitHub login and not a key to distribute.

### 3.2 Obtain and approve a precise release SHA

From a trusted administrator workstation with repository access, review the desired `main` release in GitHub and record its full 40-character commit SHA. Do **not** use a short SHA or a moving branch name as the deployment reference.

You can also obtain the current full SHA after the deploy key is added:

```bash
sudo GIT_SSH_COMMAND='ssh -i /root/.ssh/readypackets_deploy -o IdentitiesOnly=yes' \
  git ls-remote git@github.com:readypackets/ReadyPackets-SiteSplit.git refs/heads/main
```

Treat the result as a candidate only until an authorized administrator has reviewed and approved that exact commit. The bootstrap refuses any value other than a 40-character SHA and verifies the fetched result exactly.

### 3.3 Put the reviewed bootstrap script on the VPS

Download `deploy/github-bootstrap-install.sh` from the approved release in the private GitHub repository using GitHub’s authenticated download interface, then transfer it to the VPS through an approved administrator channel. For example, from your trusted workstation:

```bash
scp deploy/github-bootstrap-install.sh root@<VPS-IP>:/root/github-bootstrap-install.sh
```

On the VPS, lock the local copy down and verify its syntax before use:

```bash
sudo chown root:root /root/github-bootstrap-install.sh
sudo chmod 0700 /root/github-bootstrap-install.sh
sudo bash -n /root/github-bootstrap-install.sh
```

The bootstrap itself downloads GitHub’s published SSH host keys over authenticated HTTPS and uses a dedicated strict `known_hosts` file. It does not accept an unknown GitHub SSH key on first use.

### 3.4 Automatic Cloudflare Origin CA deployment — recommended

Set the `my` record to **Proxied** in Cloudflare and set the zone encryption mode to **Full (strict)**. Create a short-lived, zone-scoped Cloudflare API token with only **Zone → SSL and Certificates → Edit**.

Create the token file locally on the VPS; it is deliberately not accepted on a command line:

```bash
sudo install -d -m 0700 -o root -g root /root/readypackets-secrets
sudo bash -c '
  read -r -s -p "Cloudflare Origin CA token: " token
  printf "\n"
  umask 077
  printf "%s\n" "$token" > /root/readypackets-secrets/cloudflare-origin-ca.token
  unset token
'
```

Paste the token only at the non-echoed terminal prompt and press `Enter`. Then run the exact reviewed release, substituting **only** the approved SHA:

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

The `--portal-alias` line is optional and repeatable up to five times. It adds a certificate SAN and an Nginx `308` redirect to `https://my.readypackets.com`; it does not create a second portal login origin. The portal will be installed at `/opt/readypackets`; the immutable source checkout remains at `/srv/readypackets`. The installer starts and validates local health. It also checks public HTTPS, but treats DNS/Cloudflare propagation as pending rather than corrupting a healthy local deployment.

After certificate installation is verified, remove the one-time token file and revoke the token unless an approved renewal process requires it:

```bash
sudo shred -u /root/readypackets-secrets/cloudflare-origin-ca.token
```

### 3.5 Let’s Encrypt alternative

Use this only when `my.readypackets.com` resolves to the VPS and can complete HTTP-01 validation. If the record is proxied, temporarily set only `my` to **DNS only** until the certificate has been issued.

```bash
sudo bash /root/github-bootstrap-install.sh \
  --repository readypackets/ReadyPackets-SiteSplit \
  --commit <REVIEWED_40_CHARACTER_SHA> \
  --domain my.readypackets.com \
  --mode native \
  --tls-provider letsencrypt \
  --email operations@readypackets.com \
  --site-name ReadyPackets
```

Do not add `--public-domain www.readypackets.com`; `www` belongs to the independently hosted ReadyPackets website.

### 3.6 Existing Cloudflare Origin CA PEM alternative

If Cloudflare has already issued the portal certificate, place its certificate and key in separate root-only files, verify their content locally, and use:

```bash
sudo bash /root/github-bootstrap-install.sh \
  --repository readypackets/ReadyPackets-SiteSplit \
  --commit <REVIEWED_40_CHARACTER_SHA> \
  --domain my.readypackets.com \
  --mode native \
  --tls-provider cloudflare-origin \
  --cloudflare-origin-cert /root/readypackets-secrets/origin-cert.pem \
  --cloudflare-origin-key /root/readypackets-secrets/origin-key.pem \
  --site-name ReadyPackets
```

## 4. Route B — temporary-public source fallback

Use this path only when the repository has intentionally been made public for a brief, reviewed installation window. It is **not** the default production process.

Before changing repository visibility, confirm that no commit contains customer data, `portal.env`, database exports, backup archives, credentials, tokens, private keys, origin certificates, encryption keys, or deployment keys. Review [Temporary Public-Repository Installation](TEMPORARY_PUBLIC_REPOSITORY_INSTALL.md) before use.

The guided bootstrap is only appropriate if you deliberately configure the public-host portion of the dual-host portal application on the same VPS. For the normal Hostinger website + portal-VPS topology, use Route A; it prevents the VPS from claiming the website hostname.

## 5. Route C — updating an existing portal

Do not run any fresh-server bootstrap when `readypackets.service` or an existing `/srv/readypackets` checkout is present.

For routine changes, use **Admin → Platform updates**. It requires review/approval of an exact commit, creates a protected snapshot before migration, validates source/builds/migrations, performs a health check, and retains rollback evidence. See [Approved Auto-Deployment](AUTO_DEPLOYMENT.md).

For a replacement server, install the new host first, validate it, then use the protected full recovery process in [Full Backup and Recovery](FULL_BACKUP_RESTORE.md). It restores customer data, files, protected configuration, and relevant integration secrets while preserving the target server’s hostname, TLS material, database/network binding, and storage identity.

## 6. Required post-install verification

The installer must include this successful schema line:

```text
Applied 51 migration(s); 44 critical tables verified.
```

Run these checks on the VPS before inviting users:

```bash
sudo systemctl status readypackets nginx mysql --no-pager
sudo systemctl is-enabled readypackets readypackets-backup.timer
sudo systemctl list-timers readypackets-backup.timer
sudo nginx -t

sudo bash /opt/readypackets/deploy/verify-public-connectivity.sh \
  --domain my.readypackets.com \
  --portal-alias portal.readypackets.com

curl -fsS https://my.readypackets.com/api/health
curl -fsS https://my.readypackets.com/api/health/ready
curl -sSI https://portal.readypackets.com/api/health | grep -Ei '^(HTTP/|location: https://my\.readypackets\.com/)'

sudo ss -ltnp | grep -E ':(22|80|443|3000|3306)'
```

Expected health output:

```json
{"status":"ok"}
{"status":"ready"}
```

Omit the `--portal-alias` and alias `curl` command when no alias was configured. For each configured alias, the verifier requires an exact `308` redirect to the canonical hostname. It does not treat a direct application response or a redirect to an untrusted host as success.

For Cloudflare Origin CA, additionally verify that the certificate covers the hostname and that Nginx loads it:

```bash
sudo openssl x509 \
  -in /etc/readypackets/tls/cloudflare-origin/certificate.pem \
  -noout -issuer -subject -dates -ext subjectAltName
sudo cat /etc/readypackets/tls/nginx-tls.conf
```

The application listener (`127.0.0.1:3000`) and MySQL listener (`127.0.0.1:3306`) must not be public. Nginx is the only public application-facing service.

## 7. First administrator and go-live checklist

Create the first administrator after the clean installation. This command runs locally under the restricted application identity and prints a one-time generated password once; copy it directly into an approved password manager:

```bash
sudo runuser -u readypackets -- sh -c '
  set -a
  . "$1"
  set +a
  shift
  exec "$@"
' sh /etc/readypackets/portal.env \
  node /opt/readypackets/dist/create-admin.js \
  --email admin@readypackets.com \
  --name 'ReadyPackets Administrator' \
  --generate-password
```

Then complete the following before accepting customer data:

- [ ] Sign in over HTTPS; enroll administrator MFA; store recovery codes in a secure password manager.
- [ ] Verify Cloudflare is **Full (strict)** and edge WAF/rate-limit rules are active.
- [ ] Confirm the nightly backup timer is enabled and configure an encrypted, separate off-host backup destination.
- [ ] Create a full backup and perform an isolated restore drill, including a representative protected file download.
- [ ] Configure email, payment, SharePoint/Graph, webhooks, SAML, and SIEM only through protected administrator settings.
- [ ] Configure Microsoft Clarity/PostHog only after the consent, masking, retention, and data-processor settings have been reviewed; providers are disabled by default.
- [ ] Verify `my.readypackets.com` (or your dedicated portal host) serves the portal and `www.readypackets.com` remains the separate ReadyPackets website.
- [ ] Record the deployed commit, server region, backup location, certificate choice, recovery test date, and named deployment approver in your change record.

## 8. Troubleshooting without weakening security

| Symptom | Safe first response |
| --- | --- |
| Bootstrap says deploy-key access failed | Recheck that the public key belongs to the exact private portal repository and has no write permission. Do not use a GitHub PAT in a clone URL. |
| Bootstrap says project directory exists | Stop. Determine whether a failed fresh installation or live portal is present; do not delete it blindly. |
| Local health passes but public health is pending | Check Cloudflare DNS/proxy/TLS mode, `80/443` firewall access, and Nginx. Re-run only `verify-public-connectivity.sh`; do not reinstall. |
| Cloudflare `525` | Cloudflare cannot validate the origin TLS handshake. Confirm Full (strict), Nginx, the Origin CA certificate/key, and the certificate hostname. |
| Cloudflare `522` | Cloudflare cannot reach the origin. Confirm the portal DNS record, VPS public IP, Nginx status, and only ports `80/443` open publicly. |
| Schema contract fails | Do not create tables by hand. Stop, retain the logs, and deploy a reviewed release with the complete forward-only migration set. |
| Need to update a working portal | Use Admin → Platform updates; do not rerun the fresh-server bootstrap. |

## References

- [GitHub: Managing deploy keys](https://docs.github.com/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
- [GitHub Meta API: published SSH host keys](https://docs.github.com/rest/meta/meta#get-github-meta-information)
- [Cloudflare Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
- [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
- [Full Backup and Recovery](FULL_BACKUP_RESTORE.md)
- [Global Growth & Horizontal Scaling Architecture](GLOBAL_SCALE_ARCHITECTURE.md)
