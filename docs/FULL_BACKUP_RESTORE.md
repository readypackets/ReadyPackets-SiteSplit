# Full Backup and Recovery

## Purpose

A ReadyPackets **full backup** is a root-created archive named `readypackets-<timestamp>.tar.gz`. It is the recovery artifact for a complete self-hosted portal, not a selective-record export. A standard restore replaces the target database and uploaded-file storage with the archive contents.

> **Security classification:** A full archive contains the database and application encryption keys. Treat it as equivalent to an unencrypted copy of the entire platform. Store it in root-only local storage or an encrypted, access-controlled off-site destination. Keep the archive and its encryption/recovery credentials separate.

## Archive contents

| Archive member | Included | Recovery purpose |
|---|---:|---|
| `database.sql` | Always | Entire MySQL application database: user accounts, MFA recovery data, orders, messages, audit records, product/catalogue data, workflow definitions, policies, integration configuration, and application settings. |
| `storage.tar` | Full backups | Uploaded and generated order files, audio recordings, customer and staff attachments, and generated artifacts under ReadyPackets storage. |
| `portal.env` | Full backups | Application secrets and configuration, including session signing, AES-256-GCM data encryption, email blind-index, SMTP, payment, SAML, storage-provider, and other environment-backed settings. |
| `platform-runtime.tar` | When backup synchronization is configured | Root-owned rclone backup-sync configuration and destination mapping. TLS private keys are deliberately excluded. |
| `MANIFEST.txt` | Always | Creation time, source host, database name, schema version, included components, and warnings. |
| `SHA256SUMS` | Always | SHA-256 integrity verification for every archive member. |

A **database-only** archive intentionally excludes files and environment material. It is useful for a controlled database test but is not a complete disaster-recovery artifact.

## What is restored by each mode

| Recovery mode | Database and accounts | Order files | Application settings | Platform secrets | Backup cloud credentials | Target hostname and TLS |
|---|---:|---:|---:|---:|---:|---:|
| **Portal full restore** | Yes | Yes | Yes | Restored from archive, except target-host identity values | Restored when `platform-runtime.tar` is present | Preserved on target; issue or retain a certificate for the target hostname |
| **Root-console replacement-server restore** with `--restore-platform-secrets` | Yes | Yes | Yes | Restored from archive, except target-host identity values | Restored when `platform-runtime.tar` is present | Preserved on target; issue a certificate for the target hostname |
| **`.rpconfig` configuration restore** | No | No | Secret-free configuration only | Preserved on target | Preserved on target | Preserved on target |

The administrator portal’s full-restore flow performs a verified **portable full recovery** through the restricted root restore controller. It restores the archived application and integration secrets necessary to decrypt and operate the recovered data, while preserving the target server’s database connection, hostname, allowed origins, network binding, storage location, TLS materials, and SAML activation setting. The target certificate/private key is deliberately never restored from the archive. A root-console recovery remains available for larger or offline archives using the same target-identity safeguards.

## Administrator portal restore

Use this method to recover a server from a trusted archive, including a backup created on a different ReadyPackets hostname. The target server keeps its own public hostname, allowed origins, database connection, network settings, storage location, TLS certificate/private key, and SAML activation state; recovered application and integration secrets are restored so encrypted backup data remains usable.

1. Open **Admin → Backup management**.
2. Select either a listed archive’s **Restore** action or **Upload and restore backup file**.
3. Run the archive preflight. The portal verifies the gzip archive, allowlisted members, link/path safety, manifest, checksums, and database payload before any data changes.
4. Review the archive summary and type the exact phrase `RESTORE BACKUP`.
5. Start recovery and wait for the protected restore job to restart ReadyPackets. The Backup management page records the attempt as queued, completed, or failed with the archive name, scope, start/completion time, and safe diagnostic detail.
6. Sign in again after the readiness status is successful. Existing sessions are invalidated by the restored database state. If moving to a different hostname, validate the target TLS certificate and target SAML reply URL before enabling SSO.

Preflight is bound to the fully authenticated administrator and expires after ten minutes. Full-backup uploads are limited to 512 MB; larger archives should be recovered through the root-console procedure.

## Replacement-server recovery with secrets

Use this method only for a controlled lift-and-shift or disaster recovery to a new self-hosted host. Perform it as root after the latest ReadyPackets release is installed and its initial service environment exists.

```bash
sudo /opt/readypackets/deploy/restore.sh \
  --archive /var/backups/readypackets/readypackets-YYYYMMDDTHHMMSSZ.tar.gz \
  --yes \
  --restore-platform-secrets
```

The command first validates archive structure and checksums, creates a pre-restore database snapshot, restores the database and files, restores archived application/integration secrets while preserving the target database connection, hostname, allowed origins, network binding, storage path, Cloudflare/TLS materials, and SAML activation setting, restores root-owned backup-sync runtime if available, reruns forward-only migrations and the database schema contract, and starts the service only after readiness succeeds.

The prior target environment is retained as a root-only file beside `portal.env` with a `.pre-full-restore-<timestamp>` suffix. The target must issue or install a valid certificate for its own public hostname; Cloudflare Origin CA material is intentionally never included in the backup archive.

## Fresh VPS installation assurance

The supported native installer builds a fresh migration runner from the released source, applies all forward-only migrations before starting ReadyPackets, then verifies the critical schema contract. The contract includes Phase Kickoff configuration, phase jobs, webhook deliveries, email automations, system backups, outbound connections, and outbound call logs. If an installation is incomplete, the installer fails before the portal starts and names the missing table or column rather than exposing a partially functional administrator interface.

For a new VPS, install the desired reviewed release first, confirm the installer reports the database schema contract as verified, then perform the explicit replacement-server recovery above if complete secret continuity is required.

## Safeguards and operations

The portal restore flow is administrator-only and requires an MFA-backed active session, CSRF validation, typed confirmation, strict archive-member checks, path/link rejection, checksums, protected staging, audit records, and a narrowly scoped root backup-control helper. The helper accepts only fixed archive names and action types; it cannot execute arbitrary user-controlled commands. Every full backup and restore attempt is also retained in a root-owned, append-only recovery history with a start/completion/failure status and bounded non-sensitive diagnostic; it survives database replacement so an attempted restore is still visible after recovery.

Run a restore drill periodically against an isolated, nonproduction database and storage location. A backup that has not been verified and tested cannot be relied on for disaster recovery.

A full archive should be encrypted before it is copied off-host. ReadyPackets can create encrypted archives through the root backup procedure when `age` or GPG recovery material is configured. Cloud destinations should also use provider-side encryption, versioning or immutability, and separate least-privilege credentials.

## Scoped recovery archives

The administrator portal also provides two **passphrase-encrypted selective recovery** archives under **Admin → Backup management → Scoped recovery archives**. These are for controlled restoration of one business scope, not a replacement for a tested full-system backup.

| Scope | Included | Deliberately excluded | Restore effect |
|---|---|---|---|
| **User accounts** | User accounts, encrypted profile values, one-way password hashes, roles, login policy values, MFA enrollment, and MFA recovery-code material | Plaintext passwords, active sessions, orders, files, platform environment, payment keys, and TLS material | Restored identity rows are merged into the target; all user sessions are revoked. |
| **Orders and files** | Orders, workflow state, questions/answers, notes/messages, status history, SharePoint sync evidence, invoices, payments, refunds, MNDA/policy acceptance evidence, phase records, file metadata/version history, and only local files referenced by orders | User accounts, plaintext passwords, active sessions, platform environment, unrelated storage, payment keys, and TLS material | Restored order rows and referenced files are merged into the target; unrelated target records are retained. |

Both archive types use an administrator-provided passphrase of at least 16 characters. The passphrase is used for PBKDF2-HMAC-SHA512 key derivation, AES-256-CBC encryption, and a separate HMAC-SHA256 integrity check; it is never stored by ReadyPackets. The archive also carries a non-secret fingerprint of the portal data-encryption key. An archive from a different encryption-key lineage is rejected before restore, protecting encrypted profile/order data from becoming unreadable.

### Administrator procedure

1. Open **Admin → Backup management → Scoped recovery archives**.
2. Select **Back up user accounts** or **Back up orders and files**.
3. Enter and confirm a new recovery passphrase; store it separately from the downloaded `.rprecovery` file.
4. To restore, select **Restore scoped recovery archive**, choose the same recovery type, upload the encrypted `.rprecovery` file, and enter the original passphrase.
5. Review the verified scope and type `RESTORE IDENTITIES RECOVERY` or `RESTORE ORDERS RECOVERY` exactly. The preflight token is administrator-bound and expires after ten minutes.
6. Wait for the protected root-controlled recovery operation to complete, then sign in again and verify the restored records. Identity recovery deliberately invalidates every active session.

Each export, preflight, and restore is authenticated, CSRF-protected, audited, staged in a non-listable protected directory, and passed through a root-only fixed-action Unix-socket control boundary. Before selected records are merged, the server creates a root-only full database safety dump. Scoped recovery does not delete unrelated target records and is therefore not a point-in-time whole-platform rollback.

## Current fresh-install verification

The current reviewed release applies **50 forward-only migrations** and verifies **44 critical tables**, including operational UI tables, native-mobile authorization/device tables, subscriptions, billing, CRM, scheduling, AI, API, feature scheduling, PWA experiment, administration preference, selected-site SharePoint, and append-only conversion pipeline tables. Treat the installer's successful schema-contract line—not a manually created table list—as the authoritative fresh-install checkpoint.

> A customer password can never be backed up or restored in plaintext. Identity recovery preserves the existing one-way password hash so users can authenticate with their existing password after a compatible restore; it does not reveal or email that password.
