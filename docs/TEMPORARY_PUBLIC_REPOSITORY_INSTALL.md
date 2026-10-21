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

## Important split-host limitation

The anonymous guided bootstrap (`deploy/one-click-install.sh`) requires both the portal hostname and a public-site hostname because it installs the portal repository's dual-host bundles onto one VPS. It is **not the appropriate path** for the established topology where:

- `www.readypackets.com` is independently hosted on Hostinger; and
- `my.readypackets.com` or `portal.readypackets.com` is the dedicated portal VPS.

For that normal architecture, keep the portal repository private and use the read-only deploy-key bootstrap in the [production runbook](PORTAL_VPS_DEPLOYMENT_RUNBOOK_2026-10-13.md), even if public visibility is temporarily available.

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
6. Confirm the installer prints **`Applied 52 migration(s); 46 critical tables verified.`** and passes local/readiness checks.
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
