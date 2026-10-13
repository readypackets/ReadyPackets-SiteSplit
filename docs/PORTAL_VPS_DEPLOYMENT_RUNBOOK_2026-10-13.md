# ReadyPackets Portal — VPS Deployment Runbook

**Release repository:** [readypackets/ReadyPackets-SiteSplit](https://github.com/readypackets/ReadyPackets-SiteSplit) (private)
**Reviewed release:** `f083ea3d773d94e509c42a0f76796546d00aa09c`
**Expected database checkpoint:** `Applied 51 migration(s); 44 critical tables verified.`
**Preferred runtime:** Native Ubuntu 24.04 VPS with systemd, Nginx, MySQL, and the ReadyPackets protected backup/update helpers.

> This runbook deploys the **authenticated ReadyPackets portal** only. The independent Hostinger marketing site remains separate. With the current marketing-site configuration, use `my.readypackets.com` as the portal hostname because the public CTA targets that hostname. Do not point the Hostinger marketing host (`go` now, later `www`) at the portal VPS.

## 1. Choose the correct deployment route

| Situation | Use this route | Do not use |
| --- | --- | --- |
| A new/reimaged VPS; repository remains private | **Route A — private repository + read-only deploy key** | The anonymous one-click bootstrap |
| A new/reimaged VPS; repository is intentionally public for a short installation window | **Route B — temporary-public guided bootstrap** | A personal GitHub token in a command |
| An already working ReadyPackets portal | **Route C — controlled in-place upgrade** | Either fresh-server route; they refuse/are unsafe for a live portal |

The application source repository is currently **private**, so **Route A is the normal production route**.

## 2. Before touching the VPS

1. Provision **Ubuntu 24.04 LTS** (Ubuntu 22.04 LTS or Debian 12 are also supported) with at least **2 vCPU, 4 GB RAM, and 40 GB SSD**.
2. Keep only SSH administration plus inbound **TCP 80 and 443** available. Do **not** expose application port `3000` or MySQL port `3306`.
3. In Cloudflare DNS, create the portal record:

   ```text
   Type: A
   Name: my
   Target: <new portal VPS public IPv4 address>
   ```

4. Do not change the marketing Hostinger record (`go` staging or `www` future production), the root redirect, or the existing Hostinger deployment.
5. Choose one TLS path:
   - **Cloudflare Origin CA (recommended when `my` stays orange-cloud/proxied):** Set Cloudflare SSL/TLS mode to **Full (strict)**. Create a new zone-scoped token with only **Zone → SSL and Certificates → Edit** for `readypackets.com`. Do not paste it into chat, source files, or a shell command.
   - **Let’s Encrypt:** Set only the `my` record to **DNS only** (grey cloud) until issuance completes. You need an email address for renewal notices.
6. If this is a migration rather than a blank portal, retain a tested full backup and its recovery material before beginning. A fresh installer must never overwrite an existing working portal.

## 3. Route A — Private repository and read-only deploy key (recommended)

### 3.1 Prepare the fresh VPS

SSH to the new VPS as a sudo-capable administrator, then run:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git openssh-client
sudo install -d -m 0700 /root/.ssh
sudo ssh-keygen -t ed25519 -f /root/.ssh/readypackets_deploy -N '' -C 'readypackets-production-deploy'
sudo cat /root/.ssh/readypackets_deploy.pub
```

### 3.2 Add the public deploy key in GitHub

1. Copy the single public-key line printed by the last command.
2. Open the private repository: <https://github.com/readypackets/ReadyPackets-SiteSplit/settings/keys>
3. Select **Add deploy key**.
4. Give it a descriptive name such as `portal-vps-YYYY-MM-DD`.
5. Paste the public key.
6. **Leave “Allow write access” unchecked.**
7. Save it.

> The private key stays only in `/root/.ssh/readypackets_deploy` on the VPS. Never email it, attach it to a ticket, commit it, or paste it into chat.

### 3.3 Configure SSH access and retrieve the reviewed release

Back on the VPS:

```bash
sudo tee /root/.ssh/config >/dev/null <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile /root/.ssh/readypackets_deploy
  IdentitiesOnly yes
EOF
sudo chmod 0600 /root/.ssh/config
sudo ssh-keyscan -H github.com | sudo tee -a /root/.ssh/known_hosts >/dev/null
sudo chmod 0600 /root/.ssh/known_hosts

sudo git clone --no-checkout git@github.com:readypackets/ReadyPackets-SiteSplit.git /srv/readypackets
cd /srv/readypackets
sudo git fetch --depth=1 origin f083ea3d773d94e509c42a0f76796546d00aa09c
sudo git checkout --detach f083ea3d773d94e509c42a0f76796546d00aa09c
sudo test "$(git rev-parse HEAD)" = "f083ea3d773d94e509c42a0f76796546d00aa09c"
sudo test -z "$(git status --porcelain)"
```

Before trusting a newly collected GitHub host key, compare it to GitHub’s published SSH host-key fingerprints using a trusted browser or your organization’s known-hosts process.

### 3.4 Install the portal — choose one TLS command

#### Option A — Cloudflare Origin CA automatic issuance

Use this when `my.readypackets.com` remains **proxied** through Cloudflare. Create the token file locally; do not put the token on the command line:

```bash
sudo install -d -m 0700 /root/readypackets-secrets
sudo nano /root/readypackets-secrets/cloudflare-origin-ca.token
sudo chown root:root /root/readypackets-secrets/cloudflare-origin-ca.token
sudo chmod 0600 /root/readypackets-secrets/cloudflare-origin-ca.token

cd /srv/readypackets
sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/unified-install.sh \
  --mode native \
  --domain my.readypackets.com \
  --tls-provider cloudflare-origin-ca \
  --cloudflare-api-token-file /root/readypackets-secrets/cloudflare-origin-ca.token \
  --cloudflare-origin-validity 5475 \
  --site-name ReadyPackets
```

When the installer asks whether to restore a configuration-vault backup, select **No** for a clean new portal. Select **Yes** only when you intentionally have a verified encrypted configuration vault, its recovery passphrase, and a plan to restore only configuration—not customer data/files.

#### Option B — Let’s Encrypt

Use this only after `my.readypackets.com` resolves to the VPS and is **DNS only** during validation:

```bash
cd /srv/readypackets
sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash deploy/unified-install.sh \
  --mode native \
  --domain my.readypackets.com \
  --email operations@readypackets.com \
  --tls-provider letsencrypt \
  --site-name ReadyPackets
```

> Do **not** add `--public-domain www.readypackets.com` to either portal-only command. `www` is reserved for the independent Hostinger marketing site. Adding it would make this installer try to serve and certificate a hostname that belongs to Hostinger.

## 4. Route B — Temporary-public guided bootstrap

Use only after making `readypackets/ReadyPackets-SiteSplit` deliberately public for a short, reviewed installation window. Confirm there are no secrets, customer uploads, database exports, backup archives, certificates, or `.env` files in the repository before changing its visibility.

On the new VPS:

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates git

curl -fsSLO https://raw.githubusercontent.com/readypackets/ReadyPackets-SiteSplit/f083ea3d773d94e509c42a0f76796546d00aa09c/deploy/one-click-install.sh
chmod 0700 one-click-install.sh
sudo env \
  RP_REPOSITORY=readypackets/ReadyPackets-SiteSplit \
  RP_REF=main \
  RP_COMMIT=f083ea3d773d94e509c42a0f76796546d00aa09c \
  ./one-click-install.sh
```

At the guided prompts choose:

| Prompt | Recommended value |
| --- | --- |
| Installation type | **1 — Native VPS** |
| Customer portal hostname | `my.readypackets.com` |
| Public marketing-site hostname | The installer currently requires a value; enter a dedicated host only if it also resolves to this same VPS. **For the Hostinger-separated marketing architecture, use Route A instead** so no external marketing hostname is incorrectly included in VPS TLS configuration. |
| TLS | Cloudflare Origin CA automatic for an orange-cloud `my` record; otherwise Let’s Encrypt |
| Source | Keep `readypackets/ReadyPackets-SiteSplit` and use the pinned SHA above |
| Nightly local backups | **Yes** for production |
| Initial administrator | Generate a one-time password; store it immediately in a password manager |
| Final confirmation | Verify every displayed value, then type `INSTALL READY PACKETS` |

Once the installer prints its completed commit and local readiness result, change the repository back to **private**.

## 5. Route C — Existing portal upgrade

Do not run a fresh-install bootstrap on a live VPS. Use **Admin → Platform updates**:

1. Confirm the current deployed commit and service status are known and healthy.
2. Configure the private repository as `readypackets/ReadyPackets-SiteSplit` with a short-lived fine-grained GitHub token limited to **Repository contents: Read-only**.
3. Scan for changes.
4. Review the changed paths and target commit.
5. Type the commit-specific **Approve** phrase, then the commit-specific **Upgrade** phrase.
6. Let the protected helper create its pre-upgrade snapshot, apply the approved release, migrate, restart, and health check.
7. Verify the post-upgrade checks below. Rollback restores a pre-upgrade database snapshot, so do not treat it as a casual undo after new customer activity begins.

## 6. Required post-install verification

The installer must report:

```text
Applied 51 migration(s); 44 critical tables verified.
```

Run the following on the VPS:

```bash
sudo systemctl status readypackets nginx mysql --no-pager
sudo systemctl is-enabled readypackets readypackets-backup.timer
sudo nginx -t
sudo bash /opt/readypackets/deploy/verify-public-connectivity.sh --domain my.readypackets.com

curl -fsS https://my.readypackets.com/api/health
curl -fsS https://my.readypackets.com/api/health/ready
```

Expected health output:

```json
{"status":"ok"}
{"status":"ready"}
```

For Cloudflare Origin CA, also confirm the certificate is present and covers the portal hostname:

```bash
sudo openssl x509 \
  -in /etc/readypackets/tls/cloudflare-origin/certificate.pem \
  -noout -issuer -subject -dates -ext subjectAltName
```

Then:

1. Sign in as the initial administrator.
2. Enroll MFA and save backup codes in a secure password manager.
3. Create a full backup and complete an isolated restore drill before inviting customers.
4. Configure email, payment, SharePoint/Graph, SAML, and analytics only through their protected admin settings.
5. Confirm `my.readypackets.com` serves the portal and that `go.readypackets.com`/`www.readypackets.com` remain on Hostinger marketing hosting.

## 7. What this deployment does and does not change

| Asset | Result |
| --- | --- |
| `my.readypackets.com` | New canonical authenticated portal host on the VPS |
| `go.readypackets.com` | Remains Hostinger staging marketing site |
| `www.readypackets.com` | Remains reserved for Hostinger marketing production cutover |
| Existing portal data | Untouched by a fresh-server installation; migrate only through the reviewed full backup/restore process |
| VPS application port 3000 | Loopback-only; never publicly exposed |
| MySQL port 3306 | Loopback-only; never publicly exposed |
| Nightly backups | Enabled by default for native production installs unless explicitly declined |

## 8. Rollback / recovery boundary

- A failed fresh install on a truly new VPS can be corrected and re-run only after the cause is understood; do not use the failed-install resume mode on an active portal.
- For an existing portal, use Platform Updates rollback only after assessing post-upgrade data loss implications.
- For host migration, restore the tested full backup using the documented portable-recovery flow. It restores protected configuration and data while preserving the target host’s identity and TLS material.
- Keep a record of the installed commit, deployment time, certificate choice, backup location, and verification results.
