# Clean-Room Fresh VPS Installation

**Purpose:** Install ReadyPackets from a blank Ubuntu 22.04 or 24.04 LTS VPS using a reviewed public-source release and verify that the portal never starts against a partial database schema.

> Use this procedure on a genuinely new or provider-reimaged VPS. Do not attempt to turn a failed, partially configured host into a "fresh" host by deleting a few directories. A reimage provides the cleanest and most repeatable baseline.

## 1. Preconditions

The ReadyPackets repository must be intentionally public for the duration of source retrieval. Before changing repository visibility, verify that it contains no `.env` files, production backups, customer files, private keys, API tokens, database exports, or deployment credentials. See [Temporary Public-Repository Installation](TEMPORARY_PUBLIC_REPOSITORY_INSTALL.md) for the public-source security procedure.

Create DNS records for the portal hostname before starting. If Cloudflare will proxy the site, configure its SSL/TLS mode as **Full (strict)** and be prepared to use a zone-scoped Cloudflare Origin CA token. The required token scope is **Zone → SSL and Certificates → Edit** for only the target zone.

The VPS must permit inbound TCP 80 and 443. Do not expose application port 3000 or MySQL port 3306 publicly.

## 2. Obtain a reviewed installer revision

Use an immutable 40-character Git commit SHA from the reviewed public `main` branch. Substituting a branch name without a commit pin is acceptable only for a controlled test, not a production installation.

The command below downloads the bootstrap script at the same reviewed commit that it will install. Replace `REVIEWED_40_CHARACTER_COMMIT_SHA` with the approved value.

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates git

curl -fsSLO \
  https://raw.githubusercontent.com/readypackets/ReadyPackets/REVIEWED_40_CHARACTER_COMMIT_SHA/deploy/one-click-install.sh

chmod 0700 one-click-install.sh
sudo env \
  RP_REPOSITORY=readypackets/ReadyPackets \
  RP_REF=main \
  RP_COMMIT=REVIEWED_40_CHARACTER_COMMIT_SHA \
  ./one-click-install.sh
```

The bootstrap performs an anonymous Git reachability check before it makes platform changes. It then clones only the selected commit, builds the application, applies forward-only migrations, and verifies the critical schema contract before ReadyPackets is permitted to start.

## 3. Guided installer choices

Select **Native VPS** unless Docker is an intentional operating requirement. Enter the canonical portal hostname and display name. Choose one TLS option:

| TLS model | Select when | Required preparation |
|---|---|---|
| Let’s Encrypt | The hostname resolves directly to the VPS, or Cloudflare allows HTTP-01 validation | Enter a valid certificate contact email. |
| Cloudflare Origin CA — automatic | Cloudflare proxy is enabled | Set Cloudflare to Full (strict); paste a least-privilege Origin CA token only into the masked installer prompt. |
| Cloudflare Origin CA — existing PEM | A certificate/key were already created outside the server | Keep the PEM/key in root-only VPS files. |

The installer shows a final review. Confirm the domain, source repository, pinned commit, TLS model, backup choice, and initial administrator email before typing `INSTALL READY PACKETS`.

## 4. Required successful migration checkpoint

A correct fresh installation prints a migration completion line in this form before it installs/starts ReadyPackets:

```text
Applied 46 migration(s); 7 critical tables verified.
```

The exact number of migrations may increase in a later release. The required invariant is that the message ends in **`7 critical tables verified`** and that no schema-contract error is printed. If the installer prints a missing table or column, stop; do not create the administrator account and do not expose the portal. Send the complete migration output and source commit for diagnosis.

## 5. Post-install verification

After the installer reports success, run:

```bash
sudo systemctl status readypackets nginx mysql --no-pager
sudo systemctl is-enabled readypackets readypackets-backup.timer
sudo nginx -t

curl -fsS https://portal.example.com/api/health
curl -fsS https://portal.example.com/api/health/ready

sudo mysql -t -e "
SELECT COUNT(*) AS critical_tables
FROM information_schema.tables
WHERE table_schema = 'readypackets'
  AND table_name IN (
    'phase_kickoff_configs',
    'phase_jobs',
    'webhook_deliveries',
    'email_automations',
    'system_backups',
    'outbound_connections',
    'outbound_call_logs'
  );
"
```

Expected results are two JSON health responses, `{"status":"ok"}` and `{"status":"ready"}`, plus `critical_tables = 7`. For a Cloudflare Origin CA deployment, also verify:

```bash
sudo openssl x509 \
  -in /etc/readypackets/tls/cloudflare-origin/certificate.pem \
  -noout -issuer -subject -dates
sudo cat /etc/readypackets/tls/nginx-tls.conf
```

## 6. First-day production tasks

Create the initial administrator account only after the checks above pass. Enroll MFA immediately, save backup codes, configure SMTP/identity/payment/integration settings through the administrator portal, create a full backup, and complete an isolated restore drill before customer launch. Review the Cloudflare WAF/rate limits and make the repository private again after source retrieval.

## 7. If a previous install failed at schema validation

A schema-contract failure means the installer intentionally refused to start a portal against an incomplete database. On a server intended to be a clean fresh install, reimage the VPS and repeat this guide using the fixed reviewed commit. Do not copy the failed database or `/etc/readypackets/portal.env` to the new server.

For a server that contains business data and must be repaired rather than reimaged, preserve a backup first, update to the corrected source release, and re-run the installer. The forward-only migration system will apply only missing migrations and then re-run the schema verification. This is a separate recovery operation and should not be mixed with a clean-room installation.
