# ReadyPackets Approved Auto-Deployment

ReadyPackets supports **self-hosted, administrator-approved deployment** of an immutable commit from a private GitHub repository. It does not provide an unsafe unattended mechanism that silently deploys whichever commit is at the tip of a branch.

> A deployment is eligible only after an administrator has reviewed the change scan and approved the exact commit SHA. The protected helper verifies that the remote branch still resolves to that reviewed SHA before it starts the release.

## Architecture

| Control | Purpose |
|---|---|
| Administrator Platform Updates workspace | Stores the repository, branch, scan findings, approval decision, and run history. |
| `/usr/local/sbin/readypackets-platform-update` | Root-owned deployment helper. It accepts a GitHub PAT only through standard input, performs an immutable SHA verification, backs up the application and database, validates the source, deploys, and rolls back automatically on error. |
| `deploy/auto-deploy-approved.sh` | Root-only convenience wrapper for an already approved run. It requires an explicit `READYPACKETS_APPROVED_DEPLOYMENT=yes` acknowledgement and delegates to the protected helper. |
| Protected upgrade snapshots | Retained beneath `/var/backups/readypackets/platform-upgrades/` and include application, staging source, protected environment, release marker, and a database dump. |

## Required release gates

The helper performs the following gates in sequence before it leaves the previous release unavailable:

1. It clones the selected private repository branch using a token supplied only through standard input.
2. It verifies that the fetched revision is the approved immutable 40-character SHA.
3. It runs `pnpm install --frozen-lockfile`, TypeScript validation, the automated test suite, and production client/server builds.
4. It creates a rollback snapshot before copying source or applying migrations.
5. It runs the unified installer, which applies pending migrations idempotently and preserves `/etc/readypackets/portal.env`.
6. It writes the deployed commit to `/opt/readypackets/RELEASE_COMMIT` and checks the ready endpoint.
7. Any failure after the snapshot is created triggers the protected rollback path.

## Administrator workflow

Use **Admin → Platform updates** to configure the private repository, record a change scan, and approve a specific commit. Keep the GitHub PAT encrypted in the platform settings; it must never be saved in Git configuration, the system environment, a shell command, browser storage, or a timer definition.

The normal platform interface invokes the protected helper after approval. If root-console automation is required for an approved maintenance window, use the wrapper only with the reviewed run ID and commit:

```bash
export READYPACKETS_APPROVED_DEPLOYMENT=yes
printf '%s\n' "$GITHUB_PAT" | sudo -E bash /opt/readypackets/deploy/auto-deploy-approved.sh \
  --run-id 42 \
  --repository readypackets/ReadyPackets-SiteSplit \
  --branch main \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --domain my.readypackets.com \
  --contact admin@readypackets.com
unset READYPACKETS_APPROVED_DEPLOYMENT
```

The command intentionally reads the token from standard input. Do **not** replace this with `--token`, an environment file, or a systemd `Environment=` line.

## Optional scheduling

A scheduler may be used to run the **scan and notification** portion of the platform-update process, but it must not apply a release automatically. The decision to apply remains a named administrator approval for a reviewed commit. This separation protects against a compromised repository, an accidental force push, an unreviewed migration, and a broken build.

## Rollback

Use **Admin → Platform updates** to select the failed run and initiate its recorded rollback, or from the protected root console:

```bash
sudo /usr/local/sbin/readypackets-platform-update rollback <run-id>
```

Rollback restores the recorded application, source tree, protected environment, and database snapshot, then verifies the local health endpoint. Do not manually copy files over a failed release while a rollback is in progress.

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
