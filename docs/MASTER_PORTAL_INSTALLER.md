# ReadyPackets Portal — Guided Master Installer

**Script:** [`deploy/master-install.sh`](../deploy/master-install.sh)
**Repository:** <https://github.com/readypackets/ReadyPackets-SiteSplit> (private)
**Use:** A **brand-new Ubuntu 24.04 or 26.04 LTS VPS** for the dedicated, self-hosted ReadyPackets Portal.

> This is the recommended guided installation path. It does not update, repair, or restore an existing portal. It refuses existing ReadyPackets runtime, source, configuration, data, or systemd state. Use **Admin → Platform updates** for a working portal and [Full Backup and Recovery](FULL_BACKUP_RESTORE.md) for a replacement-server recovery.

## What it captures and installs

The script prompts for and validates the following non-secret operational details:

| Prompt | Purpose |
| --- | --- |
| ReadyPackets display name | Browser and portal display name; defaults to `ReadyPackets`. |
| Dedicated portal hostname | Example: `my.readypackets.com`. The public `readypackets.com` and `www.readypackets.com` website hostnames are explicitly rejected. |
| Additional portal aliases | Optional comma-separated list of up to five explicit hostnames, for example `portal.readypackets.com`. Each alias redirects with HTTPS `308` to the dedicated canonical portal hostname; it does not become a separate session origin. |
| First administrator name and email | Used to create the first local administrator after a successful deployment. The email defaults to `tools@readypackets.com` and can be deliberately overridden for a specific VPS. |
| TLS method | Cloudflare Origin CA automatic issuance, Let's Encrypt, or an existing Cloudflare Origin CA PEM pair. |
| Exact immutable Git release | Shows the current `main` candidate but requires the operator to type a full reviewed 40-character SHA; pressing Enter without it is rejected. |

After confirmation, it performs the complete native installation:

1. Installs only the minimum source-retrieval prerequisites before deployment.
2. Generates or validates `/root/.ssh/readypackets_deploy`, a root-only GitHub deploy key.
3. Displays only the public half and pauses for the operator to add it as a **read-only** deploy key to the private portal repository.
4. Retrieves GitHub's published SSH host keys from the GitHub Meta API and uses strict host-key validation.
5. Retrieves and verifies the approved immutable source commit.
6. Runs the existing hardened native installer: Node.js 22, MySQL 8, Nginx, systemd, the self-hosted conversion toolchain, protected backups, restricted controllers, migrations, schema contract, TLS, local readiness, and public HTTPS verification.
7. Creates the first local administrator with a generated one-time password displayed once on the VPS console.

The default dedicated-host installation is **portal-only**: the canonical portal hostname serves the sign-in, registration (when enabled), password-recovery, customer workspace, and administrator console—not the public ReadyPackets marketing pages. Navigation such as “Public site” goes to the separately hosted marketing URL (`MARKETING_SITE_URL`, defaulting to `https://www.readypackets.com`) without making that host a portal origin, cookie domain, or API trust entry.

The fresh installation must report:

```text
Applied 53 migration(s); 48 critical tables verified.
```

## Before you start

1. Use a new Ubuntu 24.04 or 26.04 LTS VPS with a public IPv4 address and sudo/root access.
2. Reserve `readypackets.com` and `www.readypackets.com` for the independently hosted ReadyPackets website. Use a dedicated portal hostname, such as `my.readypackets.com` or `portal.readypackets.com`.
3. Create an `A` record for the canonical portal hostname to the VPS. If aliases are selected, create an `A` or appropriate proxied DNS record for **every** alias to the same VPS before beginning. Keep `3000/tcp` and `3306/tcp` private; only `80/tcp` and `443/tcp` are public for portal traffic.
4. For automatic Cloudflare Origin CA, proxy every portal DNS record and set Cloudflare to **Full (strict)**. Prepare a short-lived zone-scoped token with only **Zone → SSL and Certificates → Edit**. The script asks for it in a non-echoed prompt only after deployment confirmation.
5. Ensure a person with repository-administration authority is available to add the generated public key at:

   ```text
   https://github.com/readypackets/ReadyPackets-SiteSplit/settings/keys
   ```

   Leave **Allow write access** unchecked.

## Get the script onto the VPS

Because the portal repository is private, download the reviewed script from GitHub through an authenticated administrator session and transfer it through an approved channel:

```bash
scp deploy/master-install.sh root@<VPS-IP>:/root/readypackets-master-install.sh
```

On the VPS:

```bash
sudo chown root:root /root/readypackets-master-install.sh
sudo chmod 0700 /root/readypackets-master-install.sh
sudo bash -n /root/readypackets-master-install.sh
sudo bash /root/readypackets-master-install.sh
```

The master installer will guide the remaining process. It intentionally stops after it prints the deploy key so that you can register only its public half in GitHub before it attempts source retrieval.

## Canonical portal URL and aliases

Choose exactly one canonical portal hostname, such as `my.readypackets.com`. It remains the only `APP_URL`, email-link, SAML/native callback, CSRF, and `__Host-` cookie origin. You may add up to five explicit aliases, including `portal.readypackets.com`, when the installer asks. The native proxy validates every alias, includes it in the TLS certificate SAN set, serves HTTP-01 validation where applicable, and issues a permanent `308` redirect to the canonical HTTPS URL before the request reaches the application.

This is intentionally not a wildcard or arbitrary-host feature. An unconfigured hostname is rejected, and `readypackets.com` and `www.readypackets.com` remain reserved for the separately hosted ReadyPackets website. Do not expect a session created at an alias to work: aliases redirect before a session is issued, so users should bookmark and use the canonical portal URL.

### Add an alias after installation

After installing a release that includes post-install alias administration, a portal administrator can open **System → Domain & URL → Add a portal redirect alias**. The console lists current aliases and remaining capacity, accepts at most five explicit aliases in total, and writes security/audit records for successful and failed requests. It does **not** accept wildcard hostnames, change `APP_URL`, broaden CORS/CSRF origins, or create a second login/session hostname.

Create the new DNS record before opening the console. For a Let’s Encrypt deployment, every active A/AAAA route for the alias must expose port 80 to this VPS for HTTP-01; the alias remains pending on HTTP challenge handling only until its expanded SAN certificate is validated. For Cloudflare Origin CA, create a **replacement** certificate in Cloudflare covering the canonical hostname, every existing alias, and the new alias; retain its private key and keep all portal records proxied with **Full (strict)**. The console validates the certificate/key pair and every required hostname before changing Nginx. In either path, Nginx tests, reloads, verifies canonical health, verifies the exact alias `308` redirect, and restores root-owned routing/TLS configuration on failure.

### Temporary-public repository fallback

If—and only if—the source repository has been deliberately made public after a full current and reachable-history secret review, retrieve an **immutable reviewed script revision**, not a moving `main` branch:

```bash
COMMIT=<REVIEWED_40_CHARACTER_SHA>
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://raw.githubusercontent.com/readypackets/ReadyPackets-SiteSplit/${COMMIT}/deploy/master-install.sh" \
  -o /root/readypackets-master-install.sh \
  && sudo chmod 0700 /root/readypackets-master-install.sh \
  && sudo bash /root/readypackets-master-install.sh
```

This remains a last-resort source-retrieval option. See [Temporary Public-Repository Installation](TEMPORARY_PUBLIC_REPOSITORY_INSTALL.md). Return the repository to private visibility immediately after installation.

For the normal portal-only VPS topology with the marketing website hosted separately, use the dedicated `temporary-public-portal-only-install.sh` procedure in that document. It does not configure or claim the marketing hostname and is the approved temporary-public alternative to the private deploy-key route. The older `one-click-install.sh` remains only for an explicitly approved dual-host deployment where both names are intentionally served from the same VPS.

### Repair only the confirmed Express 5 startup error

Do **not** run a fresh installer over an existing portal. If the VPS-local `readypackets` journal specifically records `Missing parameter name at index 1: *`, use [`deploy/repair-express5-startup.sh`](../deploy/repair-express5-startup.sh). It is a narrow repair for the legacy Express 4 anonymous SPA wildcard that is rejected by Express 5.

The helper requires the expected clean native source checkout and protected environment ownership/mode before it proceeds. It first checks the current boot, then retained logs from the previous 14 days for the exact error. If the journal has already rotated, it stops unless the operator uses its intentionally verbose `--confirm-known-express5-journal-error` flag after separately verifying that exact error. It retrieves immutable source, preserves the existing TLS certificate/private key, aliases, database, files, backup history, and administrator account, skips seed data, and never asks for a Cloudflare token. A different service error requires investigation; do not apply this helper speculatively.

### Repair only the confirmed split portal blank-page build issue

If the portal service and local Nginx health checks pass but the browser receives a blank portal page after the Express recovery, use [`deploy/repair-split-portal-bundle.sh`](../deploy/repair-split-portal-bundle.sh) only with its required `--confirm-known-split-bundle-cycle` option. It addresses the known React/vendor manual-chunk initialization cycle in the former split Vite build configuration.

The helper retrieves one immutable client-build-only commit, refuses a target that changes packages, server/deployment code, or migrations, and reads only non-secret routing metadata to select the active bundle: `client/dist` for a one-host portal or `client/dist-portal` when a separate public-site hostname is configured. It builds that one bundle in a detached worktree, rejects a circular-chunk build, validates the resulting shell and every direct JS/CSS asset through local Nginx TLS, then atomically swaps only that active client bundle directory. It checks `/etc/readypackets/portal.env` before and after and automatically restores the previous client bundle if validation fails. It never restarts the service or changes `server.js`, TLS, Nginx, Cloudflare, aliases, database, storage, backups, administrator accounts, or integration settings.

### Repair only the confirmed one-host legacy asset 404

If a one-host portal is blank and the local Nginx request for the exact JavaScript file named by the delivered `index.html` returns HTTP 404, use [`deploy/repair-legacy-static-assets.sh`](../deploy/repair-legacy-static-assets.sh) with `--confirm-known-legacy-asset-404`. This is the corrective path for the legacy runtime defect where `index.html` was selected from `client/dist` but `/assets/*` was incorrectly served from the separate `client/dist-portal` directory.

The helper refuses split-host deployments and retrieves one immutable, explicitly scoped server static-route repair. It builds a corrected legacy client bundle and server bundle in a detached worktree, atomically stages both beside the live files, makes the one required service restart, validates the health endpoint, shell, CSP header, and every direct hashed JavaScript/CSS asset through local Nginx TLS, then retains the changes only on success. Any failed activation or validation restores the previous server/client bundles and restarts the old service automatically. It verifies the protected environment file is byte-for-byte unchanged and does not migrate the database, reseed data, or alter TLS, Nginx, Cloudflare, aliases, user accounts, files, backups, or integrations.

## What the script never does

- It never accepts a GitHub personal access token, repository password, portal password, Cloudflare token, or TLS private key as a command-line parameter.
- It never writes a Cloudflare API token to the portal environment, source checkout, database, or logs. The temporary root-only token file is removed on script exit.
- It never deploys a moving branch name or a short SHA.
- It never accepts an unknown GitHub SSH host key on first use.
- It never overwrites an existing deployment, database, runtime, data directory, or portal configuration.
- It never claims `readypackets.com` or `www.readypackets.com`, which remain the independently hosted public website.

## After the script completes

1. Store the one-time administrator password shown on the VPS console in an approved password manager.
2. Sign in over HTTPS, enroll mandatory MFA, and save recovery codes securely.
3. Confirm `readypackets.service`, Nginx, MySQL, certificate coverage, and public health.
4. Confirm the backup timer and configure encrypted off-host backups.
5. Perform a full backup and an isolated restore drill before accepting production customer data.
6. Configure email, payment, SharePoint/Graph, SAML, SIEM/syslog, and consented analytics only through the authenticated administrator portal. In **Administration → Login page**, administrators can configure the one-to-five-slide desktop login carousel with bounded text and approved local ReadyPackets visuals. Every new order requires an order or project name; new SharePoint paths snapshot safe customer-email and project labels.

### Platform Setup profile

After the administrator signs in, **Administration → Platform setup** includes SharePoint site synchronization and the daily protected backup schedule. It can also download or import a versioned `readypackets-platform-setup-profile-v1.json` file for a future self-hosted portal. The profile contains only reviewable identifiers and non-secret choices; it intentionally excludes passwords, client secrets, OAuth tokens, certificates, private keys, Stripe secrets, webhook signing secrets, and host/network configuration. Imported webhooks remain disabled until reviewed, and Entra/access controls must be configured and enabled deliberately.

For detailed diagnostics, certificate verification, operational acceptance, and recovery boundaries, see the [Portal VPS Deployment Runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md).
