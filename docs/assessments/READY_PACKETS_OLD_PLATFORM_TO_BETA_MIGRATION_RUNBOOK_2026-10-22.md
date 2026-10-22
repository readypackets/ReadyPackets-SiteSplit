# ReadyPackets — Old Platform Upgrade and `beta.readypackets.com` Migration Runbook

**Prepared:** 2026-10-22
**Purpose:** Safely upgrade an existing self-hosted ReadyPackets Portal to a reviewed current release while preserving users, password hashes, MFA data, orders, order files, settings, and encryption continuity; then make `https://beta.readypackets.com` the canonical Portal URL.

> This is a planned migration, not a `git pull` or installer rerun. Do not use a moving branch, a fresh installer over the old VPS, `deploy/upgrade.sh`, or `deploy/install.sh --skip-packages` directly on the live old Portal. Do not paste a backup archive, `/etc/readypackets/portal.env`, certificate key, API token, password, or secret into chat.

## Outcome and recommended approach

### What can be preserved

A ReadyPackets **full backup** preserves the required data when used with the proper restore flow:

- user accounts, one-way password hashes, roles, MFA enrollment/recovery data, profile data, sessions, policies, and audit history;
- orders, workflow records, messages, status history, invoices, payments/refunds, and identifier histories;
- uploaded/generated documents, recordings, attachments, and file metadata/version history;
- application settings and integration configuration;
- encryption and lookup-key continuity through the protected archived runtime configuration.

A full archive is highly sensitive because it contains the database and recovery material. Store it encrypted and off-host, with recovery credentials held separately. A database-only archive or a secret-free platform setup profile does **not** preserve a complete system.

### Recommended: replacement-host / blue-green migration

If `beta.readypackets.com` must become the new customer Portal containing all existing accounts/orders/files, use a **new current-version VPS** as the beta target, then perform one controlled final full restore and DNS cutover.

This is the lowest-risk option because the old VPS remains unchanged and available for rollback while beta is installed, tested, and configured. During final cutover the old system must stop accepting customer writes; ReadyPackets has no supported dual-write/automatic data-reconciliation mechanism.

### Same-VPS alternative

A healthy current native VPS can be upgraded in place first through **Admin → Platform updates**, which preserves the old protected configuration exactly. After that, the canonical domain can be changed through **Admin → System → Domain & URL**.

This route is only suitable when all of the following are true:

1. The old platform is a supported native ReadyPackets install with `readypackets.service`, `/etc/readypackets/portal.env`, a working MySQL database, and a usable protected update controller or a separately approved recovery/update path.
2. An isolated full restore rehearsal proves that the old archive upgrades cleanly through the current forward-only migrations.
3. `PORTAL_ALIASES` is empty at the moment of the canonical domain change.
4. `beta.readypackets.com` can use **Let’s Encrypt HTTP-01**. The current in-portal canonical-domain tool is Let’s Encrypt-only.
5. The cutover owner accepts that the old URL’s session cookies cannot follow the beta hostname and that all users must sign in again.

If the old host uses Cloudflare Origin CA and must remain on Origin CA, has existing aliases, is not a supported native installation, or needs a low-risk rehearsal, use the replacement-host route instead.

## Decision tree

| Question | Answer | Required path |
|---|---|---|
| Must beta contain every existing customer/account/order/file at launch? | No | Run beta as a separate synthetic/internal environment; leave the old Portal canonical and do not migrate customer data. |
| Must beta contain every existing record? | Yes | Perform a controlled one-way full backup/restore and cutover. |
| Is there a new VPS available? | Yes | Use the recommended replacement-host/blue-green path. |
| Is only the old native VPS available and it has the current protected update/domain controllers? | Yes | Use the same-VPS sequence only after a restore drill, alias/TLS eligibility check, and approval. |
| Is the old deployment Docker, a materially different/original schema, missing native controls, or unable to perform an isolated restore rehearsal? | Yes | Do not attempt an in-place update. Build beta on a new host and plan a compatibility migration/recovery with a disposable rehearsal. |

## Read-only preflight for the old VPS

Run this as root on the existing VPS. It prints only non-secret topology/status information. It does **not** modify the server or print the environment file, passwords, keys, tokens, certificates, user data, or backups.

```bash
sudo bash -s <<'EOF'
set -Eeuo pipefail
printf '%s\n' '=== ReadyPackets migration preflight (non-secret) ==='
printf 'OS: '; . /etc/os-release && printf '%s %s\n' "$NAME" "$VERSION_ID"
printf 'Service active: '; systemctl is-active readypackets 2>/dev/null || true
printf 'Service unit present: '; systemctl cat readypackets.service >/dev/null 2>&1 && echo yes || echo no
printf 'Current release: '; if [[ -r /opt/readypackets/RELEASE_COMMIT ]]; then tr -d '\n' </opt/readypackets/RELEASE_COMMIT; else echo unknown; fi
printf 'Source directory: '; if [[ -d /srv/readypackets ]]; then echo /srv/readypackets; elif [[ -d /home/ubuntu/src/readypackets ]]; then echo /home/ubuntu/src/readypackets; else echo unknown; fi
printf 'Required native paths: '; for p in /opt/readypackets /var/lib/readypackets /etc/readypackets/portal.env; do [[ -e "$p" ]] && printf '%s=present ' "$p" || printf '%s=MISSING ' "$p"; done; echo
printf 'Controllers: '; for u in readypackets-backup-control.service readypackets-certificate-control.service readypackets-platform-update-control.service; do systemctl cat "$u" >/dev/null 2>&1 && printf '%s=present ' "$u" || printf '%s=absent ' "$u"; done; echo
printf 'Backup timer: '; systemctl is-enabled readypackets-backup.timer 2>/dev/null || true
printf 'Listeners: '; ss -lnt '( sport = :80 or sport = :443 or sport = :3000 or sport = :3306 )' | awk 'NR==1 || /:80 |:443 |:3000|:3306/'
if [[ -f /etc/readypackets/portal.env && ! -L /etc/readypackets/portal.env ]]; then
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root /bin/bash -c '
    set -a; . "$1"; set +a
    printf "Canonical APP_URL: %s\n" "${APP_URL:-unset}"
    printf "Portal aliases configured: %s\n" "${PORTAL_ALIASES:-none}"
    printf "Portal-only mode: %s\n" "${PORTAL_ONLY:-unset}"
    printf "Storage driver: %s\n" "${STORAGE_DRIVER:-local}"
    printf "Instance role: %s\n" "${INSTANCE_ROLE:-all}"
    printf "Cloudflare mode: %s\n" "${BEHIND_CLOUDFLARE:-false}"
    printf "Trust proxy hops: %s\n" "${TRUST_PROXY_HOPS:-unset}"
  ' bash /etc/readypackets/portal.env
else
  echo 'Protected runtime environment is missing or not a regular file.'
fi
EOF
```

Review this output locally. Share only the status/topology lines if help is needed; do not share host IP addresses or any file contents.

## Common prerequisites — both migration paths

1. **Freeze and approve an exact release.** Record the 40-character target commit after a change review. Never use `main`, `latest`, or another moving branch as the deployment target.
2. **Create a full encrypted backup.** Run the root-controlled backup on the old host, verify its manifest/checksums, copy it to protected encrypted off-host storage, and retain recovery access separately.
3. **Perform an isolated restore rehearsal.** Restore the archive into a disposable database and storage target, apply current migrations, and verify representative account sign-in, order lookup, and protected file download. A rehearsal is the compatibility gate for an old platform.
4. **Record a non-secret baseline.** Capture counts of active accounts, orders, files, queued jobs, and current health. Capture integration state (enabled/disabled), not secret values.
5. **Reserve the change window.** Disable or drain customer writes, Stripe Checkout/fulfilment, scheduled/queued work, SharePoint sync, email automation, and webhooks only during the final consistency window. Announce that users will need to sign in again after beta is live.
6. **Create beta DNS in advance.** Point `beta.readypackets.com` to the beta target. Keep the old hostname/DNS/TLS running until beta acceptance is complete. Do not make `www.readypackets.com` a portal host; it remains the separate public website.
7. **Choose exactly one edge topology.**
   - **Cloudflare-proxied:** beta record proxied, Cloudflare Full (strict), an origin certificate valid for beta, and origin ingress restricted to authenticated/verified Cloudflare paths.
   - **Direct origin:** `BEHIND_CLOUDFLARE=false`, direct certificate, and no trust in Cloudflare headers.
   In either case keep Node port 3000 and MySQL 3306 non-public.

## Recommended replacement-host / blue-green sequence

### Phase A — build beta safely

1. Provision a clean Ubuntu 24.04 or 26.04 LTS VPS. Do not install over the old Portal.
2. Install the reviewed immutable current release as a portal-only deployment with beta as canonical:
   - `APP_URL=https://beta.readypackets.com`
   - `PORTAL_ONLY=true`
   - `MARKETING_SITE_URL=https://www.readypackets.com`
   - `ALLOWED_ORIGINS=https://beta.readypackets.com`
   - no portal aliases initially;
   - independent beta database/storage target, TLS material, backup destination, and administrator access allowlist.
3. Confirm the fresh beta installation applies the current schema contract successfully before moving customer data.
4. Validate beta public TLS/health and local readiness, but keep beta customer workflows disabled until cutover.
5. Keep beta integration effects disabled while testing: no live Stripe checkout/fulfilment, production SharePoint sync, production generic webhooks, or broad outbound mail.

### Phase B — final consistency window and restore

1. Put the old Portal into a declared maintenance/write freeze. Do not allow writes on old and beta at the same time.
2. Drain/stop order writes, payment fulfillment, background jobs, mail queue, SharePoint sync, conversion jobs, and webhooks. Record the freeze time and remaining queues.
3. Take a **new final encrypted full backup** from the old VPS and verify it.
4. Transfer the archive through a protected administrator-controlled channel; do not upload it to chat, source control, or a public file service.
5. On beta, use the controlled full recovery with platform secrets:

   ```bash
   sudo /opt/readypackets/deploy/restore.sh \
     --archive /protected/path/readypackets-YYYYMMDDTHHMMSSZ.tar.gz \
     --yes \
     --restore-platform-secrets
   ```

   The restore preserves beta target hostname, origins, database connection, network/storage target identity, TLS material, and SAML activation state. It restores the source application/integration secrets needed to decrypt existing records, including the original encryption and email-index-key lineage. It then reapplies forward-only migrations and verifies readiness.
6. Do not regenerate `DATA_ENCRYPTION_KEY` or `EMAIL_INDEX_KEY`. Loss or replacement would make encrypted data unreadable or prevent expected email lookup.
7. Keep the old Portal unavailable for customer writes after the final backup. It becomes a rollback/reference system until the migration is accepted.

### Phase C — external dependency cutover

| Dependency | Required beta action |
|---|---|
| Browser sessions | Users sign in again. `__Host-` cookies are host-only and intentionally cannot move from the old hostname to beta. |
| SAML/Entra | Register beta metadata/entity ID and ACS URL `https://beta.readypackets.com/api/saml/acs` before enabling beta SSO. Keep the old IdP registration while it remains a rollback path. Maintain a local MFA-backed break-glass admin. |
| Stripe | Add beta webhook `https://beta.readypackets.com/api/stripe/webhook`, save the matching beta signing secret, and test in Stripe test mode first. Do not send one live event stream to two writable databases. Keep the old endpoint available only long enough to settle pre-freeze sessions/events. |
| Email/reset/magic/invoice links | Test actual beta email links. Future links use beta after `APP_URL` changes; already queued legacy emails may retain old absolute links. |
| Mobile | Update the mobile portal API base/issuer to beta in a controlled app release. Keep only exact app-controlled callback URIs in `MOBILE_OAUTH_REDIRECT_URIS`; test authorization, refresh, revocation, and expected re-login. |
| SharePoint/Graph | Add the beta delegated callback to Entra before enabling sync. Do not enable beta production sync until old queues are drained and duplicate-folder/transfer risks are reviewed. |
| Webhooks | Move/allowlist beta receiver URLs, confirm HMAC signatures, and test each inbound/outbound webhook with synthetic events. |
| Cloudflare/TLS | Confirm hostname-valid certificate, Full (strict) where used, no direct-origin header spoofing, and beta-only host/origin acceptance. |

### Phase D — beta acceptance and DNS cutover

1. Verify beta health, TLS/SANs, redirects, HSTS, unknown-host rejection, admin MFA, password reset, verification/magic/invoice links, user sign-in, order visibility, representative file download, and database/storage record counts against the pre-freeze baseline.
2. Verify encrypted data can be read, files are accessible only to their authorized users, and old users’ password hashes authenticate without exposing/resetting plaintext passwords.
3. Verify the new backup, alerting, audit trail, and off-host backup replication before taking customer traffic.
4. Move the marketing site’s Portal link and customer communications to `https://beta.readypackets.com` only after the acceptance gate passes.
5. Retain the old host, protected backup, and DNS/TLS capacity for the rollback period. Do not configure its historical hostname as a beta alias while it is still serving legacy records.

## Same-VPS sequence — only for an eligible native host

1. Perform the common prerequisites and isolated restore rehearsal first.
2. Upgrade the existing host to the reviewed immutable release using **Admin → Platform updates**:
   - scan the repository;
   - review the target commit and risk indicators;
   - approve the exact target;
   - execute the separate typed upgrade confirmation.

   This upgrade snapshots application/source/environment/database/Nginx/TLS/systemd/controller state and preserves the complete existing runtime configuration byte-for-byte. It applies forward-only migrations without reseeding.
3. Validate the updated system on the **old hostname** before changing DNS/identity: readiness, backup timer, schema health, admin MFA, representative account/order/file, and integrations.
4. Confirm `PORTAL_ALIASES` is empty. The protected canonical-domain controller refuses a change while aliases are configured.
5. Create a beta DNS record pointing to the existing VPS; ensure port 80 can complete Let’s Encrypt HTTP-01. The in-Portal domain change is Let’s Encrypt-only.
6. In **Admin → System → Domain & URL**, choose **Change domain and request certificate**, enter `beta.readypackets.com` and the certificate-contact email, then type `CHANGE DOMAIN AND REQUEST CERTIFICATE`.
7. The root-controlled service snapshots environment/Nginx/TLS, changes only canonical host configuration, obtains/verifies a beta certificate, updates `APP_URL` and `ALLOWED_ORIGINS`, restarts ReadyPackets, and checks local beta health. It restores the snapshot automatically on failure.
8. Verify beta from an external network, then test administrator sign-in/MFA and all integration/link paths listed above.
9. Only after beta succeeds, add the former host as an explicit redirect-only portal alias if business policy requires it. It must have certificate SAN coverage and issue a permanent Nginx redirect to beta before Node/cookies. It must never become a second portal origin or be added to `ALLOWED_ORIGINS`.

## Rollback principles

- **Before beta receives writes:** revert DNS/marketing links to the old Portal; stop beta side effects. The old VPS remains the source of truth.
- **After beta receives writes:** DNS reversal alone creates a data split. Do not switch back without a documented data-reconciliation decision for orders, payments, messages, uploads, and provider events created on beta.
- **In-place platform-update rollback:** restores the pre-upgrade database/configuration snapshot, so writes after its snapshot can be lost. Do not use it casually during active customer work.
- **Domain-controller rollback:** restores its environment/Nginx/TLS snapshot but cannot automatically undo changes made in Entra, Stripe, mobile app stores, third-party webhooks, email inboxes, or DNS caches.

## Security and production-readiness condition

The current production-readiness review remains Blocked for a broad public customer Portal because its High-severity findings still require remediation and proof. A hostname called “beta” does not lower that threshold. Treat this migration runbook as the data-preservation and deployment path; apply the separate security launch gates before accepting real customer data or payments on beta.

## Change-record deliverables

Before the change window, retain these non-secret evidence items:

- approved target commit SHA and reviewer/approver;
- preflight status, host topology, and integration inventory;
- encrypted backup manifest/checksum and off-host location reference;
- successful isolated restore drill record;
- pre/post account/order/file/queue count comparison;
- beta TLS/origin/health verification, migration/schema evidence, and backup verification;
- IdP/Stripe/SharePoint/mobile/webhook cutover confirmations;
- rollback owner, expiry for old-host retention, and communications plan.
