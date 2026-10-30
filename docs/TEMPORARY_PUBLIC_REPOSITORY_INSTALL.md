# ReadyPackets Portal — Temporary Public-Repository Installation

**Purpose:** Controlled, short-duration source retrieval for a brand-new VPS only when the ReadyPackets Portal repository has deliberately been made public.

> The normal production path is the private-repository, read-only deploy-key method in [Portal Production VPS Deployment Runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md). Use this fallback only when a named administrator has authorized temporary public visibility and reviewed the full Git history for sensitive material.

## Non-negotiable safety boundary

A public repository must never contain, now or in its reachable Git history:

- `/etc/readypackets/portal.env`, `.env` production files, or generated encryption keys;
- MySQL dumps, customer accounts, uploads, invoices, order records, or backup archives;
- Cloudflare tokens, Stripe secrets, Microsoft Graph/Entra credentials, SMTP passwords, GitHub tokens, deploy keys, TLS private keys, certificate bundles, recovery passphrases, or SSH configuration containing credentials;
- any other operational secret or personal data.

Before changing visibility, inspect the intended commit and history in a trusted private checkout. This is a useful signal, not a substitute for human review:

```bash
cd /path/to/ReadyPackets-SiteSplit
git status --short
git log --all --oneline
git grep -nEI 'github_pat_|ghp_|cfut_|BEGIN( [A-Z]+)? PRIVATE KEY|DATA_ENCRYPTION_KEY=.{16,}|EMAIL_INDEX_KEY=.{16,}|STRIPE_SECRET|CLIENT_SECRET' $(git rev-list --all) || true
```

If this reveals a real secret, revoke/rotate it and remediate the Git history before any public exposure. Removing only the current file is not sufficient.

## Normal portal-only VPS installation

The established production topology keeps the marketing website independently hosted and sends authenticated users to a dedicated portal VPS:

- `www.readypackets.com` is independently hosted on Hostinger; and
- `my.readypackets.com` or `portal.readypackets.com` is the dedicated portal VPS.

The normal and preferred process keeps the portal repository private and uses the read-only deploy-key bootstrap in the [production runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md). If temporary public visibility has been explicitly approved after the history review above, use the dedicated portal-only bootstrap—not the older dual-host `one-click-install.sh`:

```bash
BOOTSTRAP_COMMIT=55d1ddb79b0ce336a26463b21d59113552f0d5f3
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://raw.githubusercontent.com/readypackets/ReadyPackets-SiteSplit/${BOOTSTRAP_COMMIT}/deploy/temporary-public-portal-only-install.sh" \
  -o /root/readypackets-fresh-install.sh \
  && sudo chown root:root /root/readypackets-fresh-install.sh \
  && sudo chmod 0700 /root/readypackets-fresh-install.sh \
  && sudo bash -n /root/readypackets-fresh-install.sh \
  && sudo bash /root/readypackets-fresh-install.sh
```

The script is interactive by design and is safe only on a brand-new Ubuntu **24.04 or 26.04 LTS** VPS. It pins and verifies the exact reviewed source commit, asks for the canonical portal hostname, up to five redirect-only aliases, the first administrator, and the TLS method. It deliberately **does not** ask for or configure `www.readypackets.com`; the portal receives `PORTAL_ONLY=true` and its outward marketing navigation continues to use the separate website.

For automatic Cloudflare Origin CA, create the portal record (and every selected alias) as **Proxied**, set the zone to **Full (strict)**, and use the non-echoed prompt for a short-lived token scoped only to **Zone → SSL and Certificates → Edit**. The token is held in a temporary root-only file and removed when the script exits.

After a successful source checkout, return the repository to private visibility. The running portal is not disrupted by that visibility change.

## Existing native VPS upgrade during a temporary-public window

This is **not** the fresh-server procedure above. Do not use a fresh installer,
`git pull`, `deploy/upgrade.sh`, or a raw `deploy/install.sh` rerun on a server
that already contains ReadyPackets data. Instead, retrieve the separately
reviewed `deploy/temporary-public-existing-vps-upgrade.sh` from its immutable
bootstrap commit and pass the separately reviewed 40-character target commit.

The existing-VPS updater refuses a fresh/Docker host, requires an interactive
typed confirmation, verifies that the configured branch still points at the
reviewed target, validates the staged source unprivileged, creates a normal full
backup and a root-only rollback snapshot, preserves the existing
`/etc/readypackets/portal.env` byte-for-byte, does not reseed configuration, and
automatically restores the prior database/application/source/Nginx/TLS/systemd/
controller state if the upgrade cannot reach local readiness.

The immutable source checkout and lock use a root-owned ephemeral `/run` staging
directory rather than the portal's persistent service-owned data root. The
unprivileged account can traverse only a named disposable validation copy; it
cannot alter the reviewed source that root deploys. On-host validation never runs
database-backed tests against the live portal database; those tests are verified
in disposable-MySQL CI.

Record both immutable SHAs in the approved change record. The bootstrap SHA is
the reviewed release that contains the updater itself; the target SHA is the
reviewed release to deploy. Do not replace either with `main` or another moving
branch name. Keep the repository public only while the script retrieves the
approved target, then return it to private visibility.

## If a temporary-public dual-host deployment is explicitly approved

1. Record the exact reviewed 40-character commit SHA.
2. In GitHub, temporarily make `readypackets/ReadyPackets-SiteSplit` public only after the full secret/history review.
3. On the new VPS, install only the bootstrap prerequisites:

   ```bash
   sudo apt-get update
   sudo apt-get install -y curl ca-certificates git
   ```

4. Retrieve the guided installer from the public repository and run it:

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/readypackets/ReadyPackets-SiteSplit/main/deploy/one-click-install.sh \
     && chmod 0700 one-click-install.sh \
     && sudo ./one-click-install.sh
   ```

5. At the prompts, supply both dedicated hostnames, select the appropriate TLS method, specify the approved full commit SHA rather than accepting a moving branch tip, and review the redacted plan before entering the confirmation phrase.
6. Confirm the installer prints the migration count from its exact pinned source commit and **`48 critical tables verified.`**, then passes local/readiness checks. Do not compare it to a later `main` release: this temporary-public bootstrap intentionally pins its own reviewed historical application commit. Use the private read-only deploy-key master installer when the current reviewed release is required.
7. Make the repository private immediately after the source has been cloned and the installer has recorded the installed commit. The running portal is not interrupted by that visibility change.
8. Run the same MFA, backup, restore-drill, and public-health verification required for every production portal.

## TLS and credentials

For Cloudflare Origin CA automatic issuance, create a token scoped to the portal zone with only **Zone → SSL and Certificates → Edit**. The guided installer reads this from a masked terminal prompt or a root-owned `0600` file. Never pass it in an environment variable, command-line argument, pasted source file, or browser URL.

Use Cloudflare **Full (strict)** for a proxied origin. If Let’s Encrypt HTTP-01 is selected instead, the relevant hostname must resolve to the VPS and be reachable on port 80.

## When this procedure is complete

Revoke any one-time certificate token, remove temporary root-only token files, return the source repository to private visibility, and record the deployed commit plus deployment approver. Future source updates must use **Admin → Platform updates** or the documented private deploy-key process, not a permanently public source repository.

## References

- [GitHub: Repository visibility](https://docs.github.com/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
- [GitHub: Deploy keys](https://docs.github.com/authentication/connecting-to-github-with-ssh/managing-deploy-keys)
- [Cloudflare Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
- [Cloudflare Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
