import type { Request, Response, Router } from "express";
import express from "express";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import multer from "multer";
import { resolveSession } from "../auth/session.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import { constantTimeEqual } from "../security/crypto.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../security/csrf.js";

const BACKUP_CONTROL_SOCKET = "/run/readypackets/backup-control.sock";
const IMPORT_DIR = "/var/lib/readypackets/storage/backup-restore-imports";
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CONFIRMATION = "RESTORE BACKUP";
const IMPORT_FILENAME = /^rpbackup-import-[a-f0-9]{32}\.tar\.gz$/;
const SCOPED_IMPORT_FILENAME = /^rprecovery-import-[a-f0-9]{32}\.rprecovery$/;
const SCOPED_RECOVERY_SCOPE = new Set(["identities", "orders"]);

type ArchiveManifest = {
  archive: string;
  databaseBytes: number;
  includesFiles: boolean;
  recoveryInventory: boolean;
  referencedObjects: number;
};

type PendingRestore = {
  filename: string;
  userId: number;
  expiresAt: number;
  manifest: ArchiveManifest;
};

const pendingRestores = new Map<string, PendingRestore>();
type PendingScopedRestore = PendingRestore & { scope: "identities" | "orders" };
const pendingScopedRestores = new Map<string, PendingScopedRestore>();

function parseControlOutput(output: string): ArchiveManifest {
  const values = Object.fromEntries(output.split("\n").map((line) => line.split("=", 2)).filter(([key, value]) => Boolean(key) && value !== undefined));
  if (values.verified !== "true" || !values.archive || !/^rpbackup-import-[a-f0-9]{32}\.tar\.gz$/.test(values.archive)) {
    throw new Error("The archive did not pass ReadyPackets backup verification.");
  }
  const databaseBytes = Number(values.database_bytes ?? 0);
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes <= 1024) throw new Error("The archive database dump is invalid.");
  const recoveryInventory = values.recovery_inventory === "full";
  const referencedObjects = Number(values.referenced_objects ?? 0);
  if (!Number.isSafeInteger(referencedObjects) || referencedObjects < 0) throw new Error("The archive recovery inventory is invalid.");
  if (recoveryInventory && values.includes_files !== "true") throw new Error("A full recovery inventory requires the uploaded file archive.");
  return { archive: values.archive, databaseBytes, includesFiles: values.includes_files === "true", recoveryInventory, referencedObjects };
}

function runBackupControl(action: "inspect-archive-import" | "start-restore-import" | "inspect-scoped-recovery-import" | "restore-scoped-recovery-import", args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: BACKUP_CONTROL_SOCKET });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Backup restore request timed out.")); }, 5 * 60_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ action, args, stdin })}\n`));
    socket.on("data", (chunk) => { response += chunk; if (response.includes("\n")) socket.end(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      try {
        const payload = JSON.parse(response.trim()) as { ok?: boolean; output?: string; error?: string };
        payload.ok ? resolve((payload.output ?? "").trim()) : reject(new Error(payload.error ?? "Backup restore was rejected."));
      } catch {
        reject(new Error("Backup restore control returned an invalid response."));
      }
    });
  });
}

async function requireAdmin(req: Request, res: Response) {
  const session = await resolveSession(req);
  if (!session || session.mfaPending || session.restricted || session.user.role !== "admin" || session.user.status !== "active") {
    res.status(403).json({ error: "A fully authenticated administrator session is required." });
    return null;
  }
  const headerToken = req.headers[CSRF_HEADER];
  const cookieToken = (req.cookies?.[CSRF_COOKIE] as string | undefined) ?? "";
  if (typeof headerToken !== "string" || !constantTimeEqual(headerToken, cookieToken) || !constantTimeEqual(headerToken, session.csrfSecret)) {
    void recordSecurityEvent({ eventType: "csrf.rejected", outcome: "blocked", severity: "warning", message: "Full backup restore rejected: invalid CSRF token", userId: session.user.id, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
    res.status(403).json({ error: "Invalid or missing security token." });
    return null;
  }
  return session;
}

function purgeExpiredPendingRestores() {
  const now = Date.now();
  for (const [token, pending] of pendingRestores.entries()) {
    if (pending.expiresAt <= now) {
      pendingRestores.delete(token);
      void fs.unlink(path.join(IMPORT_DIR, pending.filename)).catch(() => undefined);
    }
  }
  for (const [token, pending] of pendingScopedRestores.entries()) {
    if (pending.expiresAt <= now) {
      pendingScopedRestores.delete(token);
      void fs.unlink(path.join(IMPORT_DIR, pending.filename)).catch(() => undefined);
    }
  }
}

export function createBackupRestoreRouter(): Router {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 2, parts: 4 } });

  router.post("/preflight", (req, res, next) => {
    upload.single("file")(req, res, (error: unknown) => {
      if (!error) return next();
      const tooLarge = error instanceof Error && /file too large/i.test(error.message);
      res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Backup archives must be 512 MB or smaller." : "The backup archive could not be uploaded." });
    });
  }, async (req: Request, res: Response) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    purgeExpiredPendingRestores();
    const file = req.file;
    if (!file || !file.originalname.toLowerCase().endsWith(".tar.gz") || file.buffer.subarray(0, 2).toString("hex") !== "1f8b") {
      res.status(400).json({ error: "Choose one ReadyPackets .tar.gz backup archive." });
      return;
    }
    const filename = `rpbackup-import-${crypto.randomBytes(16).toString("hex")}.tar.gz`;
    const location = path.join(IMPORT_DIR, filename);
    try {
      await fs.writeFile(location, file.buffer, { mode: 0o600, flag: "wx" });
      const manifest = parseControlOutput(await runBackupControl("inspect-archive-import", [filename], ""));
      const restoreToken = crypto.randomBytes(32).toString("base64url");
      pendingRestores.set(restoreToken, { filename, userId: session.user.id, expiresAt: Date.now() + PENDING_TTL_MS, manifest });
      void recordActivity({ actorUserId: session.user.id, actorRole: "admin", action: "backup.archive_restore_preflight", entityType: "backup_restore", entityId: filename.slice(-16), severity: "warning", summary: "Administrator verified an uploaded full backup archive", changes: { databaseBytes: manifest.databaseBytes, includesFiles: manifest.includesFiles, recoveryInventory: manifest.recoveryInventory, referencedObjects: manifest.referencedObjects }, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.setHeader("Cache-Control", "no-store").status(200).json({ restoreToken, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(), manifest });
    } catch (error) {
      await fs.unlink(location).catch(() => undefined);
      const message = error instanceof Error ? error.message : "The backup archive could not be verified.";
      void recordSecurityEvent({ eventType: "file.access_denied", outcome: "blocked", severity: "notice", message: `Uploaded backup restore preflight blocked: ${message}`, userId: session.user.id, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.status(422).json({ error: message });
    }
  });

  router.post("/apply", async (req: Request, res: Response) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    purgeExpiredPendingRestores();
    const restoreToken = typeof req.body?.restoreToken === "string" ? req.body.restoreToken : "";
    const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation : "";
    const pending = pendingRestores.get(restoreToken);
    if (!pending || pending.userId !== session.user.id || pending.expiresAt <= Date.now() || !IMPORT_FILENAME.test(pending.filename)) {
      res.status(400).json({ error: "This backup verification has expired. Verify the archive again before restoring." });
      return;
    }
    if (confirmation !== CONFIRMATION) {
      res.status(400).json({ error: `Type ${CONFIRMATION} to confirm production recovery.` });
      return;
    }
    try {
      const result = await runBackupControl("start-restore-import", [pending.filename], `${CONFIRMATION}\n`);
      pendingRestores.delete(restoreToken);
      const unit = /^unit=([A-Za-z0-9@._-]+)$/m.exec(result)?.[1] ?? null;
      void recordActivity({ actorUserId: session.user.id, actorRole: "admin", action: "backup.archive_restore_started", entityType: "backup_restore", entityId: pending.filename.slice(-16), severity: "warning", summary: "Administrator started production restore from a verified uploaded backup archive", changes: { databaseBytes: pending.manifest.databaseBytes, includesFiles: pending.manifest.includesFiles, recoveryInventory: pending.manifest.recoveryInventory, referencedObjects: pending.manifest.referencedObjects, restoreUnit: unit }, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.setHeader("Cache-Control", "no-store").status(202).json({ ok: true, restartUnit: unit, message: "Production restore has started in a protected job. The portal will be temporarily unavailable; monitor restore status before signing in." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backup restore could not start.";
      void recordSecurityEvent({ eventType: "file.access_denied", outcome: "blocked", severity: "warning", message: `Uploaded backup restore failed: ${message}`, userId: session.user.id, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.status(422).json({ error: message });
    }
  });

  router.post("/scoped/preflight", (req, res, next) => {
    upload.single("file")(req, res, (error: unknown) => {
      if (!error) return next();
      const tooLarge = error instanceof Error && /file too large/i.test(error.message);
      res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Recovery archives must be 512 MB or smaller." : "The recovery archive could not be uploaded." });
    });
  }, async (req: Request, res: Response) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    purgeExpiredPendingRestores();
    const scope = typeof req.body.scope === "string" && SCOPED_RECOVERY_SCOPE.has(req.body.scope) ? req.body.scope as "identities" | "orders" : null;
    const passphrase = typeof req.body.passphrase === "string" ? req.body.passphrase : "";
    const file = req.file;
    if (!scope || !file || !file.originalname.toLowerCase().endsWith(".rprecovery") || file.buffer.subarray(0, 2).toString("hex") !== "1f8b") {
      res.status(400).json({ error: "Choose one encrypted .rprecovery archive and a valid recovery scope." });
      return;
    }
    if (passphrase.length < 16 || passphrase.length > 512 || /[\r\n]/.test(passphrase)) {
      res.status(400).json({ error: "Use the same single-line recovery passphrase used to create this archive." });
      return;
    }
    const filename = `rprecovery-import-${crypto.randomBytes(16).toString("hex")}.rprecovery`;
    const location = path.join(IMPORT_DIR, filename);
    try {
      await fs.writeFile(location, file.buffer, { mode: 0o600, flag: "wx" });
      const values = Object.fromEntries((await runBackupControl("inspect-scoped-recovery-import", [scope, filename], `${passphrase}\n`)).split("\n").map((line) => line.split("=", 2)).filter(([key, value]) => Boolean(key) && value !== undefined));
      if (values.verified !== "true" || values.scope !== scope) throw new Error("The encrypted recovery archive did not pass ReadyPackets verification.");
      const restoreToken = crypto.randomBytes(32).toString("base64url");
      const manifest: ArchiveManifest = { archive: filename, databaseBytes: 0, includesFiles: scope === "orders", recoveryInventory: false, referencedObjects: 0 };
      pendingScopedRestores.set(restoreToken, { filename, userId: session.user.id, expiresAt: Date.now() + PENDING_TTL_MS, manifest, scope });
      void recordActivity({ actorUserId: session.user.id, actorRole: "admin", action: `backup.${scope}_recovery_preflight`, entityType: "backup_restore", entityId: filename.slice(-16), severity: "warning", summary: `Administrator verified an encrypted ${scope} recovery archive`, changes: { scope, orderFileCount: Number(values.order_file_count ?? 0) }, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.setHeader("Cache-Control", "no-store").status(200).json({ restoreToken, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(), scope, orderFileCount: Number(values.order_file_count ?? 0) });
    } catch (error) {
      await fs.unlink(location).catch(() => undefined);
      const message = error instanceof Error ? error.message : "The encrypted recovery archive could not be verified.";
      void recordSecurityEvent({ eventType: "file.access_denied", outcome: "blocked", severity: "notice", message: `Scoped recovery preflight blocked: ${message}`, userId: session.user.id, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.status(422).json({ error: message });
    }
  });

  router.post("/scoped/apply", async (req: Request, res: Response) => {
    const session = await requireAdmin(req, res);
    if (!session) return;
    purgeExpiredPendingRestores();
    const restoreToken = typeof req.body?.restoreToken === "string" ? req.body.restoreToken : "";
    const confirmation = typeof req.body?.confirmation === "string" ? req.body.confirmation : "";
    const passphrase = typeof req.body?.passphrase === "string" ? req.body.passphrase : "";
    const pending = pendingScopedRestores.get(restoreToken);
    const expectedConfirmation = pending ? `RESTORE ${pending.scope.toUpperCase()} RECOVERY` : "";
    if (!pending || pending.userId !== session.user.id || pending.expiresAt <= Date.now() || !SCOPED_IMPORT_FILENAME.test(pending.filename)) {
      res.status(400).json({ error: "This recovery verification has expired. Verify the archive again before restoring." });
      return;
    }
    if (passphrase.length < 16 || passphrase.length > 512 || /[\r\n]/.test(passphrase) || confirmation !== expectedConfirmation) {
      res.status(400).json({ error: `Re-enter the recovery passphrase and type ${expectedConfirmation} to confirm this restore.` });
      return;
    }
    try {
      await runBackupControl("restore-scoped-recovery-import", [pending.scope, pending.filename], `${passphrase}\n${confirmation}\n`);
      pendingScopedRestores.delete(restoreToken);
      void recordActivity({ actorUserId: session.user.id, actorRole: "admin", action: `backup.${pending.scope}_recovery_restored`, entityType: "backup_restore", entityId: pending.filename.slice(-16), severity: "warning", summary: `Administrator restored an encrypted ${pending.scope} recovery archive`, changes: { scope: pending.scope }, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.setHeader("Cache-Control", "no-store").status(202).json({ ok: true, message: `${pending.scope === "identities" ? "User accounts and access material" : "Orders and their referenced files"} were restored. All sessions were revoked after identity recovery.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scoped recovery could not start.";
      void recordSecurityEvent({ eventType: "file.access_denied", outcome: "blocked", severity: "warning", message: `Scoped recovery restore failed: ${message}`, userId: session.user.id, ipAddress: (res.locals.clientIp as string | undefined) ?? null });
      res.status(422).json({ error: message });
    }
  });

  return router;
}
