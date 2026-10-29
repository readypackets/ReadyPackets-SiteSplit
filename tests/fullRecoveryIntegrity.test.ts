import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const backup = resolve(root, "deploy/backup.sh");
const restore = resolve(root, "deploy/restore.sh");
const adapter = resolve(root, "deploy/object-storage-archive.mjs");
const backupControl = resolve(root, "deploy/backup-control.sh");
const backupSource = readFileSync(backup, "utf8");
const restoreSource = readFileSync(restore, "utf8");
const adapterSource = readFileSync(adapter, "utf8");
const backupControlSource = readFileSync(backupControl, "utf8");

function bashSyntax(script: string) {
  const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

describe("verified portable full recovery", () => {
  it("keeps the backup, restore, and storage adapter scripts syntactically valid", () => {
    bashSyntax(backup);
    bashSyntax(restore);
    bashSyntax(backupControl);
    const result = spawnSync(process.execPath, ["--check", adapter], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("binds the archived file tree to the database file and version references without customer metadata", () => {
    expect(backupSource).toContain('local references="$STAGING/storage-references.tsv"');
    expect(backupSource).toContain("SELECT storage_key, sha256, size_bytes FROM files");
    expect(backupSource).toContain("SELECT storage_key, sha256, size_bytes FROM file_versions");
    expect(backupSource).toContain("--references-file \"${STAGING}/storage-references.tsv\"");
    expect(backupSource).toContain('local dataset_counts="$STAGING/dataset-counts.tsv"');
    expect(backupSource).toContain('local migration_ledger="$STAGING/migration-ledger.tsv"');
    expect(backupSource).toContain('"users", COUNT(*) FROM users');
    expect(backupSource).toContain('"administrators", COUNT(*) FROM users WHERE role = "admin"');
    expect(backupSource).toContain('"orders", COUNT(*) FROM orders');
    expect(backupSource).toContain('"files", COUNT(*) FROM files');
    expect(backupSource).toContain('"file_versions", COUNT(*) FROM file_versions');
    expect(backupSource).toContain("SELECT filename, checksum FROM schema_migrations ORDER BY filename");
    expect(backupSource).toContain("storage-references.tsv (opaque key, SHA-256, bytes)");
    expect(backupSource).not.toContain("original_name");
    expect(backupSource).not.toContain("SELECT email");
  });

  it("rejects malformed, incomplete, incompatible, or non-verifiable full recovery archives before service is returned", () => {
    expect(restoreSource).toContain("validate_recovery_inventory");
    expect(restoreSource).toContain("verify_archive_migration_compatibility");
    expect(restoreSource).toContain("verify_restored_database_inventory");
    expect(restoreSource).toContain("Backup recovery inventory is incomplete.");
    expect(restoreSource).toContain("full recovery inventory requires its referenced storage archive");
    expect(restoreSource).toContain("target release does not match an applied migration");
    expect(restoreSource).toContain("newer than the target release");
    expect(restoreSource).toContain("Restored account, administrator, order, or file counts do not match the backup inventory.");
    expect(restoreSource).toContain('verify --references-file "${STAGING}/storage-references.tsv"');
    expect(restoreSource).toContain("The archive contains no storage.tar; uploaded files were not restored.");
    expect(restoreSource).toContain("Migration step failed; the pre-restore state will be restored.");
    expect(restoreSource).toContain("The portal readiness probe failed after restore; the pre-restore state will be restored.");
    expect(backupControlSource).toContain("validate_full_recovery_inventory");
    expect(backupControlSource).toContain("storage-references\\.tsv|dataset-counts\\.tsv|migration-ledger\\.tsv");
    expect(backupControlSource).toContain("Archive full-recovery inventory is incomplete");
    expect(backupControlSource).toContain("recovery_inventory=%s");
    expect(backupControlSource).toContain("referenced_objects=%s");
  });

  it("keeps recovery fail closed, reverses failed mutation, and invalidates restored browser sessions", () => {
    expect(restoreSource).toContain('RESTORE_MUTATED="false"');
    expect(restoreSource).toContain('RESTORE_COMPLETED="false"');
    expect(restoreSource).toContain("rollback_failed_restore");
    expect(restoreSource).toContain('gzip -cd "$SAFETY"');
    expect(restoreSource).toContain('LOCAL_STORAGE_ROLLBACK_PATH');
    expect(restoreSource).toContain('PRE_RESTORE_STORAGE');
    expect(restoreSource).toContain('RESTORE_MUTATED="true"');
    expect(restoreSource).toContain('RESTORE_COMPLETED="true"');
    expect(restoreSource).toContain("UPDATE user_sessions SET revoked_at=COALESCE(revoked_at, UTC_TIMESTAMP())");
    expect(restoreSource).toContain("session rows must not continue authenticating");
    expect(restoreSource).not.toContain("Migration step failed; review before serving traffic.");
  });

  it("validates opaque storage reference hashes and bytes by reading restored objects, not only a filename list", () => {
    expect(adapterSource).toContain("references-file");
    expect(adapterSource).toContain("Storage reference manifest maps one object key to conflicting content");
    expect(adapterSource).toContain("Referenced upload object did not match its expected SHA-256 and size");
    expect(adapterSource).toContain("verifyS3Object");
    expect(adapterSource).toContain("hash.digest(\"hex\")");
    expect(adapterSource).not.toContain("originalName");
  });
});
