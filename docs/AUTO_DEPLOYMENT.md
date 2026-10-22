# ReadyPackets Approved Auto-Deployment

ReadyPackets supports **self-hosted, administrator-approved deployment** of an immutable commit from a private GitHub repository. It does not provide an unsafe unattended mechanism that silently deploys whichever commit is at the tip of a branch.

> A deployment is eligible only after an administrator has reviewed the change scan and approved the exact commit SHA. The protected helper verifies that the remote branch still resolves to that reviewed SHA before it starts the release.

## Architecture

| Control | Purpose |
|---|---|
| Administrator Platform Updates workspace | Stores the repository, branch, scan findings, approval decision, and run history. |
| `/usr/local/sbin/readypackets-platform-update` | Root-owned deployment helper. It accepts a GitHub PAT only through standard input from the encrypted administrative setting, performs immutable SHA verification, validates staged code unprivileged, deploys, and rolls back automatically on error. |
| `deploy/auto-deploy-approved.sh` | Root-only convenience wrapper for an already approved run. It requires an explicit `READYPACKETS_APPROVED_DEPLOYMENT=yes` acknowledgement and delegates to the protected helper. |
| Protected upgrade snapshots | Retained beneath `/var/backups/readypackets/platform-upgrades/` and include application/source, complete protected environment, configured database, Nginx/TLS controls, relevant systemd units, and root controller helpers. |

## Required release gates

The helper performs the following gates in sequence before it leaves the previous release unavailable:

1. It clones the selected private repository branch using a token supplied only through standard input.
2. It verifies that the fetched revision is the approved immutable 40-character SHA.
3. It runs `pnpm install --frozen-lockfile`, TypeScript validation, the automated test suite, and production client/server builds as the unprivileged service account.
4. It creates a rollback snapshot before copying source or applying migrations.
5. It runs the native installer in explicit existing-host mode, which applies pending migrations idempotently without reseeding and preserves `/etc/readypackets/portal.env` byte-for-byte.
6. It writes the deployed commit to `/opt/readypackets/RELEASE_COMMIT`, validates the ready endpoint on the configured loopback port, and queues a controller self-restart after the audited result returns.
7. Any failure after the snapshot is created triggers restoration of the recorded application/source, protected environment, configured database, Nginx/TLS, units, and root controller artifacts.

## Administrator workflow

Use **Admin → Platform updates** to configure the private repository, record a change scan, and approve a specific commit. Keep the GitHub PAT encrypted in the platform settings; it must never be saved in Git configuration, the system environment, a shell command, browser storage, or a timer definition. The normal platform interface invokes the protected helper after approval. Do not bypass the interface with a token-bearing root-console command; if the interface is unavailable, use the recorded rollback controls or a documented break-glass recovery procedure instead.

## Optional scheduling

A scheduler may be used to run the **scan and notification** portion of the platform-update process, but it must not apply a release automatically. The decision to apply remains a named administrator approval for a reviewed commit. This separation protects against a compromised repository, an accidental force push, an unreviewed migration, and a broken build.

## Rollback

Use **Admin → Platform updates** to select the failed run and initiate its recorded rollback, or from the protected root console:

```bash
sudo /usr/local/sbin/readypackets-platform-update rollback <run-id>
```

Rollback restores the recorded application, source tree, protected environment, configured database, Nginx/TLS controls, systemd units, and root controller helpers, then verifies the local readiness endpoint. Do not manually copy files over a failed release while a rollback is in progress.

## Verification

After every release, verify:

```bash
sudo systemctl status readypackets nginx mysql
curl -fsS https://my.readypackets.com/api/health
curl -fsS https://my.readypackets.com/api/health/ready
cd /home/ubuntu/src/readypackets
pnpm exec tsx scripts/verify-security.ts https://my.readypackets.com
```

The live security verification has an intentional repeated-login exercise. If it triggers the local source address block list, confirm application health directly from the server and remove only the temporary test address through the authorized Security Centre controls; do not weaken rate limits or network protections.
