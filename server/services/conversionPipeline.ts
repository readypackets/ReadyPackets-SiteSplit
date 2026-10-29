/**
 * Append-only conversion and multi-site SharePoint delivery pipeline.
 *
 * A profile maps to fixed native-tool arguments; administrators never supply an
 * executable, shell fragment, arbitrary destination URL, or unbounded retry.
 * Every queued job snapshots the source storage key/hash/version before any
 * worker starts. A converted result is always a new file plus provenance row.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  conversionJobs,
  conversionProfiles,
  fileDerivatives,
  files,
  orderSharepointLocations,
  orderWorkflows,
  orders,
  sharepointConnections,
  sharepointTargetBindings,
  sharepointTransferJobs,
} from "../db/schema.js";
import { decryptField, encryptField } from "../security/crypto.js";
import { getObjectBuffer, putObject, validateUpload } from "./storage.js";
import { probeAudioDurationSeconds } from "./audioDuration.js";
import { displayNameOf, getUserById } from "../db/users.js";
import { logger } from "../observability/logger.js";
import { recordActivity } from "../observability/audit.js";
import {
  normalizeSharepointIdentitySegment,
} from "./sharepointFolderNaming.js";

const execFile = promisify(execFileCallback);
const WORK_ROOT = path.join(tmpdir(), "readypackets-conversion");
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
export const NATIVE_CONVERTER_FINGERPRINT = "native-local-v1";

export const CONVERSION_OPERATIONS = [
  "pdf_to_docx",
  "pdf_to_text",
  "docx_to_pdf",
  "docx_to_text",
  "text_to_docx",
  "text_to_pdf",
  "pdf_compress_balanced",
  "pdf_compress_small",
  "audio_to_webm",
] as const;

export type ConversionOperation = (typeof CONVERSION_OPERATIONS)[number];
export type SharepointTargetRole = "originals" | "conversion_staging" | "intake_delivery";

export interface StageConversionPolicy {
  conversionProfileIds?: number[];
  originalsTargetBindingId?: number;
  stagingTargetBindingId?: number;
  intakeTargetBindingId?: number;
}

type ProfileSettings = Record<string, unknown>;

type ConversionOutput = {
  extension: string;
  mime: string;
  fileName: string;
  buffer: Buffer;
};

type ClaimedConversionJob = typeof conversionJobs.$inferSelect;
type ClaimedTransferJob = typeof sharepointTransferJobs.$inferSelect;

function asOperation(value: string): ConversionOperation {
  if (!(CONVERSION_OPERATIONS as readonly string[]).includes(value)) {
    throw new Error("The conversion profile uses an unsupported operation.");
  }
  return value as ConversionOperation;
}

function normalizedExtension(fileName: string): string {
  return path.extname(fileName).replace(/^\./, "").toLowerCase();
}

function outputName(sourceName: string, extension: string, operation: ConversionOperation): string {
  const stem = path.basename(sourceName, path.extname(sourceName)).replace(/[\r\n]/g, " ").trim() || "converted-file";
  const suffix = `-${operation}`;
  return `${stem.slice(0, Math.max(1, 244 - extension.length - suffix.length))}${suffix}.${extension}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function retryAt(attempt: number): Date {
  const baseMinutes = [1, 5, 15, 60, 240][Math.min(Math.max(attempt - 1, 0), 4)] ?? 240;
  const jitterMs = Math.floor(Math.random() * 20_000);
  return new Date(Date.now() + baseMinutes * 60_000 + jitterMs);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https:\/\/[^\s]+/g, "[external URL]").replace(/[\r\n]+/g, " ").slice(0, 800);
}

/**
 * One common segment policy for all external locations. It is deliberately
 * conservative: no nested client input, traversal, controls, or device names.
 */
export { normalizeSharepointIdentitySegment } from "./sharepointFolderNaming.js";

export function buildSharepointOrderPath(input: {
  rootFolderPath: string;
  relativeRootPath?: string | null;
  customerName: string;
  customerId: string;
  orderNumber: string;
  /** Immutable values taken from the order record when it was created. */
  customerFolderName?: string | null;
  orderFolderName?: string | null;
}): string {
  const base = [input.rootFolderPath, input.relativeRootPath ?? ""]
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .map((part) => normalizeSharepointIdentitySegment(part, "ReadyPackets"));
  const customer = input.customerFolderName
    ? normalizeSharepointIdentitySegment(input.customerFolderName, "Customer")
    : `${normalizeSharepointIdentitySegment(input.customerName, "Customer")}-${normalizeSharepointIdentitySegment(input.customerId, "RP-CUS-UNKNOWN")}`;
  const order = input.orderFolderName
    ? normalizeSharepointIdentitySegment(input.orderFolderName, "Order")
    : normalizeSharepointIdentitySegment(input.orderNumber, "Order");
  return [...base, customer.slice(0, 180), order].join("/");
}

function validatePolicy(policy: StageConversionPolicy): StageConversionPolicy {
  const validId = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
  const ids = Array.isArray(policy.conversionProfileIds)
    ? [...new Set(policy.conversionProfileIds.filter(validId))].slice(0, 9)
    : [];
  return {
    conversionProfileIds: ids.length ? ids : undefined,
    originalsTargetBindingId: validId(policy.originalsTargetBindingId) ? policy.originalsTargetBindingId : undefined,
    stagingTargetBindingId: validId(policy.stagingTargetBindingId) ? policy.stagingTargetBindingId : undefined,
    intakeTargetBindingId: validId(policy.intakeTargetBindingId) ? policy.intakeTargetBindingId : undefined,
  };
}

/** Read a stage-local conversion policy without exposing workflow JSON elsewhere. */
export async function getStageConversionPolicy(orderId: number, phase: string): Promise<StageConversionPolicy> {
  const rows = await db.select({ stages: orderWorkflows.stages }).from(orders)
    .innerJoin(orderWorkflows, eq(orders.workflowId, orderWorkflows.id))
    .where(eq(orders.id, orderId)).limit(1);
  const stages = rows[0]?.stages;
  if (!Array.isArray(stages)) return {};
  const equivalent = phase === "phase_1" ? ["phase_1", "phase_1_intake"] : phase === "phase_2" ? ["phase_2", "phase_2_synthesis"] : [phase];
  const stage = stages.find((candidate) => candidate && typeof candidate === "object" && equivalent.includes(String((candidate as Record<string, unknown>).key)));
  if (!stage || typeof stage !== "object") return {};
  return validatePolicy(((stage as Record<string, unknown>).conversionRouting ?? {}) as StageConversionPolicy);
}

/** Snapshot a profile and the intended transfer targets before a job can run. */
export async function queueConversionForFile(input: {
  fileId: number;
  profileId: number;
  policy: StageConversionPolicy;
}): Promise<{ queued: boolean; jobId: number | null }> {
  const policy = validatePolicy(input.policy);
  const [source, profile] = await Promise.all([
    db.select().from(files).where(and(eq(files.id, input.fileId), isNull(files.deletedAt))).limit(1),
    db.select().from(conversionProfiles).where(and(eq(conversionProfiles.id, input.profileId), eq(conversionProfiles.active, true))).limit(1),
  ]);
  const file = source[0];
  const selected = profile[0];
  if (!file || !file.orderId) throw new Error("A current order file is required for conversion.");
  if (!selected) throw new Error("Select an active conversion profile.");
  const operation = asOperation(selected.operation);
  // A stage can accept both documents and audio. A PDF profile should simply
  // not queue for its audio uploads (and vice versa), rather than making an
  // otherwise valid upload look like a failed conversion request.
  if (!operationMatchesSource(operation, file.extension ?? normalizedExtension(file.originalName))) {
    return { queued: false, jobId: null };
  }

  const idempotencyKey = sha256([
    file.id,
    file.version,
    file.storageKey,
    file.sha256,
    selected.id,
    selected.revision,
    JSON.stringify(policy),
  ].join("|"));
  const existing = await db.select({ id: conversionJobs.id }).from(conversionJobs).where(eq(conversionJobs.idempotencyKey, idempotencyKey)).limit(1);
  if (existing[0]) return { queued: false, jobId: existing[0].id };

  const inserted = await db.insert(conversionJobs).values({
    orderId: file.orderId,
    sourceFileId: file.id,
    sourceFileVersion: file.version,
    sourceStorageKey: file.storageKey,
    sourceSha256: file.sha256,
    sourceOriginalName: file.originalName,
    sourcePhase: file.phase,
    conversionProfileId: selected.id,
    profileRevision: selected.revision,
    profileOperation: operation,
    profileSettingsJson: selected.settingsJson,
    toolFingerprint: selected.toolFingerprint,
    targetBindingsJson: policy,
    status: "pending",
    idempotencyKey,
    correlationId: randomUUID(),
  });
  const jobId = Number((inserted as unknown as { insertId?: number }).insertId ?? 0) || null;
  void recordActivity({
    actorUserId: null,
    action: "conversion.requested",
    entityType: "file",
    entityId: file.id,
    summary: `Queued append-only ${operation} conversion for order ${file.orderId}.`,
    changes: { profileId: selected.id, profileRevision: selected.revision, correlationId: jobId ? undefined : "pending" },
  });
  return { queued: true, jobId };
}

/** Queue an original-file transfer using a selected target only; no free-form URL path exists. */
export async function queueOriginalTransferForFile(input: {
  fileId: number;
  targetBindingId: number;
}): Promise<{ queued: boolean; jobId: number | null }> {
  const source = await db.select().from(files).where(and(eq(files.id, input.fileId), isNull(files.deletedAt))).limit(1);
  const file = source[0];
  if (!file || !file.orderId) throw new Error("A current order file is required for SharePoint synchronization.");
  return queueTransfer({
    orderId: file.orderId,
    sourceFileId: file.id,
    artifactFileId: null,
    targetBindingId: input.targetBindingId,
    operationType: "original_sync",
    storageKey: file.storageKey,
    sha256: file.sha256,
    fileName: file.originalName,
    mime: file.detectedMime,
    phase: file.phase,
  });
}

/**
 * Called after an accepted upload. Workflows are allowed to request original
 * sync and profile conversions, but cannot supply their own command or target.
 */
export async function queueStageFileProcessing(fileId: number, policy: StageConversionPolicy): Promise<void> {
  const normalized = validatePolicy(policy);
  const failures: unknown[] = [];
  if (normalized.originalsTargetBindingId) {
    try {
      await queueOriginalTransferForFile({ fileId, targetBindingId: normalized.originalsTargetBindingId });
    } catch (error) {
      failures.push(error);
    }
  }
  for (const profileId of normalized.conversionProfileIds ?? []) {
    try {
      await queueConversionForFile({ fileId, profileId, policy: normalized });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}

async function queueTransfer(input: {
  orderId: number;
  sourceFileId: number;
  artifactFileId: number | null;
  targetBindingId: number;
  operationType: "original_sync" | "conversion_staging" | "intake_delivery";
  storageKey: string;
  sha256: string;
  fileName: string;
  mime: string;
  phase: string;
}): Promise<{ queued: boolean; jobId: number | null }> {
  const binding = await db.select({ id: sharepointTargetBindings.id, enabled: sharepointTargetBindings.enabled, targetRole: sharepointTargetBindings.targetRole }).from(sharepointTargetBindings).where(eq(sharepointTargetBindings.id, input.targetBindingId)).limit(1);
  if (!binding[0]?.enabled) throw new Error("The selected SharePoint target is not active.");
  const expectedRole = input.operationType === "original_sync" ? "originals" : input.operationType;
  if (binding[0].targetRole !== expectedRole) throw new Error("The selected SharePoint target role does not match this transfer operation.");
  const idempotencyKey = sha256([
    input.orderId,
    input.storageKey,
    input.sha256,
    input.targetBindingId,
    input.operationType,
    input.fileName,
  ].join("|"));
  const existing = await db.select({ id: sharepointTransferJobs.id }).from(sharepointTransferJobs).where(eq(sharepointTransferJobs.idempotencyKey, idempotencyKey)).limit(1);
  if (existing[0]) return { queued: false, jobId: existing[0].id };
  const inserted = await db.insert(sharepointTransferJobs).values({
    orderId: input.orderId,
    sourceFileId: input.sourceFileId,
    artifactFileId: input.artifactFileId,
    targetBindingId: input.targetBindingId,
    operationType: input.operationType,
    storageKeySnapshot: input.storageKey,
    sha256Snapshot: input.sha256,
    fileNameSnapshot: input.fileName,
    mimeSnapshot: input.mime,
    phaseSnapshot: input.phase,
    idempotencyKey,
    correlationId: randomUUID(),
    status: "pending",
  });
  return { queued: true, jobId: Number((inserted as unknown as { insertId?: number }).insertId ?? 0) || null };
}

function operationMatchesSource(operation: ConversionOperation, extension: string): boolean {
  const source = extension.toLowerCase();
  if ((operation === "pdf_to_docx" || operation === "pdf_to_text" || operation.startsWith("pdf_compress")) && source !== "pdf") {
    return false;
  }
  if ((operation === "docx_to_pdf" || operation === "docx_to_text") && source !== "docx") {
    return false;
  }
  if ((operation === "text_to_docx" || operation === "text_to_pdf") && source !== "txt") {
    return false;
  }
  if (operation === "audio_to_webm" && !["mp3", "m4a", "wav", "webm", "ogg", "opus", "aac", "flac", "aiff", "mp4"].includes(source)) {
    return false;
  }
  return true;
}

/** Atomically claims one conversion without allowing a second worker to execute it. */
async function claimConversionJob(): Promise<ClaimedConversionJob | null> {
  const now = new Date();
  const rows = await db.select().from(conversionJobs).where(and(
    lte(conversionJobs.runAfter, now),
    or(eq(conversionJobs.status, "pending"), and(eq(conversionJobs.status, "running"), lte(conversionJobs.leaseExpiresAt, now))),
  )).orderBy(conversionJobs.runAfter).limit(1);
  const candidate = rows[0];
  if (!candidate) return null;
  if (candidate.attempts >= MAX_ATTEMPTS) {
    await db.update(conversionJobs).set({ status: "failed", leaseToken: null, leaseExpiresAt: null, lastError: candidate.lastError ?? "Conversion lease expired after the maximum retry count." }).where(eq(conversionJobs.id, candidate.id));
    return null;
  }
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  const result = await db.update(conversionJobs).set({
    status: "running",
    attempts: candidate.attempts + 1,
    leaseToken,
    leaseExpiresAt,
    lastError: null,
  }).where(and(
    eq(conversionJobs.id, candidate.id),
    or(eq(conversionJobs.status, "pending"), and(eq(conversionJobs.status, "running"), lte(conversionJobs.leaseExpiresAt, now))),
  ));
  const affected = Number((result as unknown as { affectedRows?: number })?.affectedRows ?? 0);
  return affected === 1 ? { ...candidate, attempts: candidate.attempts + 1, status: "running", leaseToken, leaseExpiresAt } : null;
}

/** Process a bounded number of durable conversion jobs. */
export async function processConversionJobs(maxJobs = 2): Promise<void> {
  for (let index = 0; index < Math.max(1, Math.min(maxJobs, 4)); index += 1) {
    const job = await claimConversionJob();
    if (!job) return;
    await processClaimedConversionJob(job);
  }
}

async function processClaimedConversionJob(job: ClaimedConversionJob): Promise<void> {
  try {
    const source = await getObjectBuffer(job.sourceStorageKey);
    if (!source.byteLength || source.byteLength > MAX_SOURCE_BYTES) throw new Error("The source file is outside the safe conversion size limit.");
    if (createHash("sha256").update(source).digest("hex") !== job.sourceSha256) throw new Error("The conversion source hash does not match the queued immutable snapshot.");
    const output = await convertBuffer({
      source,
      sourceName: job.sourceOriginalName,
      operation: asOperation(job.profileOperation),
      settings: (job.profileSettingsJson ?? {}) as ProfileSettings,
    });
    const validation = await validateUpload(output.fileName, output.buffer, { maxBytes: MAX_OUTPUT_BYTES });
    if (!validation.ok || !validation.extension || !validation.mime) throw new Error(validation.reason ?? "The generated artifact did not pass file validation.");
    if (validation.extension !== output.extension) throw new Error("The conversion tool generated an unexpected output extension.");
    const stored = await putObject(output.buffer, output.extension);
    const sourceRows = await db.select({ uploadedByUserId: files.uploadedByUserId, ownerUserId: files.ownerUserId, visibleToCustomer: files.visibleToCustomer }).from(files).where(eq(files.id, job.sourceFileId)).limit(1);
    const sourceFile = sourceRows[0];
    if (!sourceFile) throw new Error("The source file metadata is no longer available.");
    const insert = await db.insert(files).values({
      storageKey: stored.storageKey,
      orderId: job.orderId,
      ownerUserId: sourceFile.ownerUserId,
      uploadedByUserId: sourceFile.uploadedByUserId,
      originalName: output.fileName,
      detectedMime: validation.mime,
      extension: validation.extension,
      sizeBytes: stored.sizeBytes,
      durationSeconds: output.extension === "webm" ? await probeAudioDurationSeconds(output.buffer, "webm") : null,
      sha256: stored.sha256,
      category: "derived_artifact",
      phase: job.sourcePhase,
      visibleToCustomer: false,
    });
    const artifactFileId = Number((insert as unknown as { insertId?: number }).insertId ?? 0);
    if (!artifactFileId) throw new Error("The converted artifact record could not be created.");
    await db.insert(fileDerivatives).values({
      sourceFileId: job.sourceFileId,
      sourceFileVersion: job.sourceFileVersion,
      sourceStorageKey: job.sourceStorageKey,
      sourceSha256: job.sourceSha256,
      conversionProfileId: job.conversionProfileId,
      conversionProfileRevision: job.profileRevision,
      artifactFileId,
      outputSha256: stored.sha256,
      outputMime: validation.mime,
      outputExtension: validation.extension,
      toolFingerprint: job.toolFingerprint,
    });
    const targets = validatePolicy((job.targetBindingsJson ?? {}) as StageConversionPolicy);
    if (targets.stagingTargetBindingId) {
      await queueTransfer({ orderId: job.orderId, sourceFileId: job.sourceFileId, artifactFileId, targetBindingId: targets.stagingTargetBindingId, operationType: "conversion_staging", storageKey: stored.storageKey, sha256: stored.sha256, fileName: output.fileName, mime: validation.mime, phase: job.sourcePhase });
    }
    if (targets.intakeTargetBindingId) {
      await queueTransfer({ orderId: job.orderId, sourceFileId: job.sourceFileId, artifactFileId, targetBindingId: targets.intakeTargetBindingId, operationType: "intake_delivery", storageKey: stored.storageKey, sha256: stored.sha256, fileName: output.fileName, mime: validation.mime, phase: job.sourcePhase });
    }
    await db.update(conversionJobs).set({ status: "succeeded", artifactFileId, completedAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: null }).where(and(eq(conversionJobs.id, job.id), eq(conversionJobs.leaseToken, job.leaseToken ?? "")));
    void recordActivity({ actorUserId: null, action: "conversion.succeeded", entityType: "file", entityId: artifactFileId, summary: `Created append-only ${job.profileOperation} artifact for order ${job.orderId}.`, changes: { sourceFileId: job.sourceFileId, sourceSha256: job.sourceSha256, outputSha256: stored.sha256, correlationId: job.correlationId } });
    logger.info("conversion.succeeded", { jobId: job.id, artifactFileId, operation: job.profileOperation, correlationId: job.correlationId });
  } catch (error) {
    const detail = safeError(error);
    const status = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await db.update(conversionJobs).set({ status, runAfter: retryAt(job.attempts), leaseToken: null, leaseExpiresAt: null, lastError: detail }).where(and(eq(conversionJobs.id, job.id), eq(conversionJobs.leaseToken, job.leaseToken ?? "")));
    void recordActivity({ actorUserId: null, action: status === "failed" ? "conversion.failed" : "conversion.retry_scheduled", entityType: "file", entityId: job.sourceFileId, severity: status === "failed" ? "error" : "warning", summary: `Conversion ${job.profileOperation} ${status} for order ${job.orderId}.`, changes: { correlationId: job.correlationId, attempt: job.attempts } });
    logger.warn("conversion.failed", { jobId: job.id, operation: job.profileOperation, attempt: job.attempts, correlationId: job.correlationId, error: detail });
  }
}

async function convertBuffer(input: { source: Buffer; sourceName: string; operation: ConversionOperation; settings: ProfileSettings }): Promise<ConversionOutput> {
  const directory = path.join(WORK_ROOT, randomUUID());
  const sourceExt = normalizedExtension(input.sourceName) || "bin";
  const inputPath = path.join(directory, `source.${sourceExt}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(inputPath, input.source, { mode: 0o600 });
  try {
    const output = await runRegisteredConverter({ directory, inputPath, sourceName: input.sourceName, operation: input.operation, settings: input.settings });
    const buffer = await readFile(output.path);
    if (!buffer.byteLength || buffer.byteLength > MAX_OUTPUT_BYTES) throw new Error("The conversion output is empty or exceeds the safe output limit.");
    return { extension: output.extension, mime: output.mime, fileName: outputName(input.sourceName, output.extension, input.operation), buffer };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runRegisteredConverter(input: { directory: string; inputPath: string; sourceName: string; operation: ConversionOperation; settings: ProfileSettings }): Promise<{ path: string; extension: string; mime: string }> {
  const base = path.join(input.directory, "converted");
  const run = async (command: string, args: string[], timeout = 120_000) => {
    await execFile(command, args, { timeout, maxBuffer: 64 * 1024, windowsHide: true });
  };
  switch (input.operation) {
    case "pdf_to_text": {
      const output = `${base}.txt`;
      await run("/usr/bin/pdftotext", ["-enc", "UTF-8", input.inputPath, output]);
      return { path: output, extension: "txt", mime: "text/plain" };
    }
    case "pdf_to_docx": {
      const output = `${base}.docx`;
      // The container pins python pdf2docx. Its module interface is invoked with
      // fixed arguments only; source and output paths are service-generated.
      await run("/usr/bin/python3", ["-m", "pdf2docx", "convert", input.inputPath, output]);
      return { path: output, extension: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    }
    case "docx_to_text": {
      const output = `${base}.txt`;
      await run("/usr/bin/pandoc", ["--from=docx", "--to=plain", "--output", output, input.inputPath]);
      return { path: output, extension: "txt", mime: "text/plain" };
    }
    case "docx_to_pdf": {
      await run("/usr/bin/libreoffice", ["--headless", "--nologo", "--nodefault", "--nolockcheck", "--convert-to", "pdf", "--outdir", input.directory, input.inputPath]);
      const output = path.join(input.directory, `${path.basename(input.inputPath, path.extname(input.inputPath))}.pdf`);
      return { path: output, extension: "pdf", mime: "application/pdf" };
    }
    case "text_to_docx": {
      const output = `${base}.docx`;
      await run("/usr/bin/pandoc", ["--from=plain", "--to=docx", "--output", output, input.inputPath]);
      return { path: output, extension: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    }
    case "text_to_pdf": {
      const docxOutput = `${base}.docx`;
      await run("/usr/bin/pandoc", ["--from=plain", "--to=docx", "--output", docxOutput, input.inputPath]);
      await run("/usr/bin/libreoffice", ["--headless", "--nologo", "--nodefault", "--nolockcheck", "--convert-to", "pdf", "--outdir", input.directory, docxOutput]);
      return { path: `${base}.pdf`, extension: "pdf", mime: "application/pdf" };
    }
    case "pdf_compress_balanced":
    case "pdf_compress_small": {
      const output = `${base}.pdf`;
      const preset = input.operation === "pdf_compress_small" ? "/screen" : "/ebook";
      await run("/usr/bin/gs", ["-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.4", "-dNOPAUSE", "-dBATCH", "-dSAFER", `-dPDFSETTINGS=${preset}`, `-sOutputFile=${output}`, input.inputPath]);
      return { path: output, extension: "pdf", mime: "application/pdf" };
    }
    case "audio_to_webm": {
      const output = `${base}.webm`;
      const configuredRate = typeof input.settings.bitrateKbps === "number" ? input.settings.bitrateKbps : 64;
      const bitrate = Math.min(128, Math.max(32, Math.round(configuredRate)));
      await run("/usr/bin/ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", input.inputPath, "-map", "0:a:0", "-vn", "-c:a", "libopus", "-b:a", `${bitrate}k`, "-y", output]);
      return { path: output, extension: "webm", mime: "audio/webm" };
    }
  }
}

async function claimTransferJob(): Promise<ClaimedTransferJob | null> {
  const now = new Date();
  const rows = await db.select().from(sharepointTransferJobs).where(and(
    lte(sharepointTransferJobs.runAfter, now),
    or(eq(sharepointTransferJobs.status, "pending"), and(eq(sharepointTransferJobs.status, "running"), lte(sharepointTransferJobs.leaseExpiresAt, now))),
  )).orderBy(sharepointTransferJobs.runAfter).limit(1);
  const candidate = rows[0];
  if (!candidate) return null;
  if (candidate.attempts >= MAX_ATTEMPTS) {
    await db.update(sharepointTransferJobs).set({ status: "failed", leaseToken: null, leaseExpiresAt: null, lastError: candidate.lastError ?? "SharePoint transfer lease expired after the maximum retry count." }).where(eq(sharepointTransferJobs.id, candidate.id));
    return null;
  }
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  const result = await db.update(sharepointTransferJobs).set({ status: "running", attempts: candidate.attempts + 1, leaseToken, leaseExpiresAt, lastError: null }).where(and(
    eq(sharepointTransferJobs.id, candidate.id),
    or(eq(sharepointTransferJobs.status, "pending"), and(eq(sharepointTransferJobs.status, "running"), lte(sharepointTransferJobs.leaseExpiresAt, now))),
  ));
  const affected = Number((result as unknown as { affectedRows?: number })?.affectedRows ?? 0);
  return affected === 1 ? { ...candidate, attempts: candidate.attempts + 1, status: "running", leaseToken, leaseExpiresAt } : null;
}

export async function processSharepointTransferJobs(maxJobs = 3): Promise<void> {
  for (let index = 0; index < Math.max(1, Math.min(maxJobs, 5)); index += 1) {
    const job = await claimTransferJob();
    if (!job) return;
    await processClaimedTransferJob(job);
  }
}

async function processClaimedTransferJob(job: ClaimedTransferJob): Promise<void> {
  try {
    const resolved = await resolveTargetLocation(job.orderId, job.targetBindingId);
    const bytes = await getObjectBuffer(job.storageKeySnapshot);
    if (createHash("sha256").update(bytes).digest("hex") !== job.sha256Snapshot) throw new Error("The transfer source hash does not match its immutable snapshot.");
    const existing = await graphGetByPath(resolved.connection, `${resolved.location.resolvedPath}/${job.fileNameSnapshot}`);
    if (existing?.id) {
      if (existing.size === bytes.byteLength) {
        await markTransferSucceeded(job, existing.id, existing.eTag ?? null, existing.size ?? null);
        return;
      }
      throw new Error("A nonmatching file already exists at the immutable SharePoint destination; ReadyPackets will not overwrite it.");
    }
    const folderId = await ensureGraphFolder(resolved.connection, resolved.location.resolvedPath);
    const uploaded = await uploadGraphFile(resolved.connection, folderId, job.fileNameSnapshot, bytes, job.mimeSnapshot);
    await markTransferSucceeded(job, uploaded.id, uploaded.eTag ?? null, uploaded.size ?? bytes.byteLength);
  } catch (error) {
    const detail = safeError(error);
    const status = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await db.update(sharepointTransferJobs).set({ status, runAfter: retryAt(job.attempts), leaseToken: null, leaseExpiresAt: null, lastError: detail }).where(and(eq(sharepointTransferJobs.id, job.id), eq(sharepointTransferJobs.leaseToken, job.leaseToken ?? "")));
    void recordActivity({ actorUserId: null, action: status === "failed" ? "sharepoint.transfer.failed" : "sharepoint.transfer.retry_scheduled", entityType: "file", entityId: job.artifactFileId ?? job.sourceFileId, severity: status === "failed" ? "error" : "warning", summary: `SharePoint ${job.operationType} transfer ${status} for order ${job.orderId}.`, changes: { targetBindingId: job.targetBindingId, correlationId: job.correlationId, attempt: job.attempts } });
    logger.warn("sharepoint.transfer.failed", { jobId: job.id, targetBindingId: job.targetBindingId, attempt: job.attempts, correlationId: job.correlationId, error: detail });
  }
}

async function markTransferSucceeded(job: ClaimedTransferJob, remoteItemId: string, remoteEtag: string | null, remoteSizeBytes: number | null): Promise<void> {
  await db.update(sharepointTransferJobs).set({ status: "succeeded", remoteItemId, remoteEtag, remoteSizeBytes, completedAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: null }).where(and(eq(sharepointTransferJobs.id, job.id), eq(sharepointTransferJobs.leaseToken, job.leaseToken ?? "")));
  void recordActivity({ actorUserId: null, action: "sharepoint.transfer.succeeded", entityType: "file", entityId: job.artifactFileId ?? job.sourceFileId, summary: `SharePoint ${job.operationType} transfer completed for order ${job.orderId}.`, changes: { targetBindingId: job.targetBindingId, remoteItemId, correlationId: job.correlationId } });
  logger.info("sharepoint.transfer.succeeded", { jobId: job.id, remoteItemId, correlationId: job.correlationId });
}

type ConnectionConfig = { id: number; tenantId: string; clientId: string; clientSecret: string; siteId: string; driveId: string; rootFolderPath: string };
type ResolvedTarget = { connection: ConnectionConfig; location: typeof orderSharepointLocations.$inferSelect };

async function resolveTargetLocation(orderId: number, targetBindingId: number): Promise<ResolvedTarget> {
  const existing = await db.select().from(orderSharepointLocations).where(and(eq(orderSharepointLocations.orderId, orderId), eq(orderSharepointLocations.targetBindingId, targetBindingId))).limit(1);
  const bindingRows = await db.select({
    bindingId: sharepointTargetBindings.id,
    targetRole: sharepointTargetBindings.targetRole,
    relativeRootPath: sharepointTargetBindings.relativeRootPath,
    enabled: sharepointTargetBindings.enabled,
    connectionId: sharepointConnections.id,
    tenantId: sharepointConnections.tenantId,
    clientId: sharepointConnections.clientId,
    clientSecretEnc: sharepointConnections.clientSecretEnc,
    siteId: sharepointConnections.siteId,
    driveId: sharepointConnections.driveId,
    rootFolderPath: sharepointConnections.rootFolderPath,
  }).from(sharepointTargetBindings).innerJoin(sharepointConnections, eq(sharepointTargetBindings.connectionId, sharepointConnections.id)).where(and(eq(sharepointTargetBindings.id, targetBindingId), eq(sharepointTargetBindings.enabled, true), eq(sharepointConnections.enabled, true))).limit(1);
  const binding = bindingRows[0];
  if (!binding) throw new Error("The configured SharePoint target is unavailable or disabled.");
  const clientSecret = decryptField(binding.clientSecretEnc, `sharepoint_connection:${binding.connectionId}`);
  if (!clientSecret) throw new Error("The configured SharePoint target credential cannot be decrypted on this host.");
  const connection: ConnectionConfig = { id: binding.connectionId, tenantId: binding.tenantId, clientId: binding.clientId, clientSecret, siteId: binding.siteId, driveId: binding.driveId, rootFolderPath: binding.rootFolderPath };
  if (existing[0]) return { connection, location: existing[0] };
  const orderRows = await db.select({
    orderNumber: orders.orderNumber,
    userId: orders.userId,
    sharepointCustomerFolderEnc: orders.sharepointCustomerFolderEnc,
    sharepointOrderFolderEnc: orders.sharepointOrderFolderEnc,
  }).from(orders).where(eq(orders.id, orderId)).limit(1);
  const order = orderRows[0];
  if (!order) throw new Error("The order is no longer available for SharePoint location creation.");
  const customer = await getUserById(order.userId);
  const customerId = customer?.customerNumber ?? customer?.publicId ?? "RP-CUS-UNKNOWN";
  const customerName = customer ? displayNameOf(customer) : "Customer";
  // A null snapshot means this order predates immutable friendly folders. Pass
  // no fabricated value so buildSharepointOrderPath retains its historical
  // CustomerName-CustomerID/order-number fallback instead of creating a second
  // location under the current naming convention.
  const customerFolderName = decryptField(order.sharepointCustomerFolderEnc, `order:${orderId}:sharepoint-customer-folder`);
  const orderFolderName = decryptField(order.sharepointOrderFolderEnc, `order:${orderId}:sharepoint-order-folder`);
  const resolvedPath = buildSharepointOrderPath({ rootFolderPath: binding.rootFolderPath, relativeRootPath: binding.relativeRootPath, customerName, customerId, orderNumber: order.orderNumber, customerFolderName, orderFolderName });
  const inserted = await db.insert(orderSharepointLocations).values({ orderId, targetBindingId, customerNameSnapshot: customerName, customerIdSnapshot: customerId, orderNumberSnapshot: order.orderNumber, resolvedPath });
  const locationId = Number((inserted as unknown as { insertId?: number }).insertId ?? 0);
  const location = (await db.select().from(orderSharepointLocations).where(eq(orderSharepointLocations.id, locationId)).limit(1))[0];
  if (!location) throw new Error("The immutable SharePoint location could not be persisted.");
  return { connection, location };
}

async function graphToken(connection: ConnectionConfig): Promise<string> {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(connection.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: connection.clientId, client_secret: connection.clientSecret, scope: "https://graph.microsoft.com/.default" }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Microsoft Graph token request failed (HTTP ${response.status}).`);
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error("Microsoft Graph did not return an access token.");
  return body.access_token;
}

async function graphRequest(connection: ConnectionConfig, method: "GET" | "POST" | "PUT", graphPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const token = await graphToken(connection);
  const response = await fetch(`https://graph.microsoft.com/v1.0${graphPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : Buffer.isBuffer(body) ? new Blob([Uint8Array.from(body)]) : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) {
    if (response.status === 429 || response.status >= 500) throw new Error(`Microsoft Graph temporarily unavailable (HTTP ${response.status}).`);
    throw new Error(`Microsoft Graph request rejected (HTTP ${response.status}).`);
  }
  return response;
}

async function graphGetByPath(connection: ConnectionConfig, remotePath: string): Promise<{ id?: string; eTag?: string; size?: number } | null> {
  const encoded = remotePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const response = await graphRequest(connection, "GET", `/drives/${encodeURIComponent(connection.driveId)}/root:/${encoded}:?$select=id,eTag,size`);
  if (response.status === 404) return null;
  return response.json() as Promise<{ id?: string; eTag?: string; size?: number }>;
}

async function ensureGraphFolder(connection: ConnectionConfig, remotePath: string): Promise<string> {
  let parentId = "root";
  for (const segment of remotePath.split("/").filter(Boolean)) {
    const found = await graphRequest(connection, "GET", `/drives/${encodeURIComponent(connection.driveId)}/items/${parentId}:/${encodeURIComponent(segment)}?$select=id,folder`);
    if (found.ok) {
      const item = await found.json() as { id?: string; folder?: unknown };
      if (!item.id || item.folder === undefined) throw new Error("An immutable SharePoint path segment is occupied by a file.");
      parentId = item.id;
      continue;
    }
    const created = await graphRequest(connection, "POST", `/drives/${encodeURIComponent(connection.driveId)}/items/${parentId}/children`, { name: segment, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }, { "Content-Type": "application/json" });
    const item = await created.json() as { id?: string };
    if (!item.id) throw new Error("Microsoft Graph did not return a folder identifier.");
    parentId = item.id;
  }
  return parentId;
}

async function uploadGraphFile(connection: ConnectionConfig, folderId: string, fileName: string, content: Buffer, contentType: string): Promise<{ id: string; eTag?: string; size?: number }> {
  if (content.byteLength > 4 * 1024 * 1024) {
    return uploadGraphFileResumable(connection, folderId, fileName, content);
  }
  const response = await graphRequest(connection, "PUT", `/drives/${encodeURIComponent(connection.driveId)}/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(fileName)}:/content?@microsoft.graph.conflictBehavior=fail`, content, { "Content-Type": contentType || "application/octet-stream" });
  const item = await response.json() as { id?: string; eTag?: string; size?: number };
  if (!item.id) throw new Error("Microsoft Graph did not return the uploaded file identifier.");
  return { id: item.id, eTag: item.eTag, size: item.size };
}

/**
 * Microsoft Graph requires chunks divisible by 320 KiB (except the last). A
 * new upload session is safe after a transient failure because the transfer job
 * still performs its immutable-path existence check before trying again and the
 * session is created with conflictBehavior=fail.
 */
async function uploadGraphFileResumable(connection: ConnectionConfig, folderId: string, fileName: string, content: Buffer): Promise<{ id: string; eTag?: string; size?: number }> {
  const sessionResponse = await graphRequest(connection, "POST", `/drives/${encodeURIComponent(connection.driveId)}/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(fileName)}:/createUploadSession`, {
    item: { name: fileName, "@microsoft.graph.conflictBehavior": "fail" },
  }, { "Content-Type": "application/json" });
  const session = await sessionResponse.json() as { uploadUrl?: string };
  if (!session.uploadUrl) throw new Error("Microsoft Graph did not return a resumable upload URL.");
  const uploadUrl = new URL(session.uploadUrl);
  if (uploadUrl.protocol !== "https:" || !(uploadUrl.hostname.endsWith(".up.1drv.com") || uploadUrl.hostname.endsWith(".sharepoint.com"))) {
    throw new Error("Microsoft Graph returned an unexpected resumable upload host.");
  }
  const chunkSize = 5 * 320 * 1024;
  for (let start = 0; start < content.byteLength; start += chunkSize) {
    const end = Math.min(content.byteLength, start + chunkSize);
    const chunk = content.subarray(start, end);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${start}-${end - 1}/${content.byteLength}`,
      },
      body: new Blob([Uint8Array.from(chunk)]),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 202) continue;
    if (!response.ok) throw new Error(`Microsoft Graph resumable upload failed (HTTP ${response.status}).`);
    const item = await response.json() as { id?: string; eTag?: string; size?: number };
    if (!item.id) throw new Error("Microsoft Graph did not return the final uploaded file identifier.");
    return { id: item.id, eTag: item.eTag, size: item.size };
  }
  throw new Error("Microsoft Graph resumable upload did not return a completed file.");
}

/** Persist a selected-site app-only connection. The secret is encrypted after id allocation. */
export async function saveSharepointConnection(input: {
  id?: number;
  name: string;
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  siteId: string;
  driveId: string;
  siteUrl?: string | null;
  rootFolderPath: string;
  enabled: boolean;
  actorUserId: number;
}): Promise<number> {
  if (input.id) {
    const existing = (await db.select({ id: sharepointConnections.id }).from(sharepointConnections).where(eq(sharepointConnections.id, input.id)).limit(1))[0];
    if (!existing) throw new Error("SharePoint connection not found.");
    await db.update(sharepointConnections).set({ name: input.name, tenantId: input.tenantId, clientId: input.clientId, siteId: input.siteId, driveId: input.driveId, siteUrl: input.siteUrl ?? null, rootFolderPath: input.rootFolderPath, enabled: input.enabled }).where(eq(sharepointConnections.id, input.id));
    if (input.clientSecret) await db.update(sharepointConnections).set({ clientSecretEnc: encryptField(input.clientSecret, `sharepoint_connection:${input.id}`) ?? "" }).where(eq(sharepointConnections.id, input.id));
    return input.id;
  }
  if (!input.clientSecret) throw new Error("A client secret is required for a new selected-site SharePoint connection.");
  const inserted = await db.insert(sharepointConnections).values({ name: input.name, tenantId: input.tenantId, clientId: input.clientId, clientSecretEnc: "", siteId: input.siteId, driveId: input.driveId, siteUrl: input.siteUrl ?? null, rootFolderPath: input.rootFolderPath, enabled: input.enabled, createdByUserId: input.actorUserId });
  const id = Number((inserted as unknown as { insertId?: number }).insertId ?? 0);
  if (!id) throw new Error("SharePoint connection could not be created.");
  await db.update(sharepointConnections).set({ clientSecretEnc: encryptField(input.clientSecret, `sharepoint_connection:${id}`) ?? "" }).where(eq(sharepointConnections.id, id));
  return id;
}

/** Validate a selected-site app identity against its configured drive without exposing credentials. */
export async function testSelectedSiteConnection(connectionId: number): Promise<{ driveId: string; rootFolderPath: string }> {
  const row = (await db.select().from(sharepointConnections).where(eq(sharepointConnections.id, connectionId)).limit(1))[0];
  if (!row) throw new Error("Selected-site SharePoint connection not found.");
  const secret = decryptField(row.clientSecretEnc, `sharepoint_connection:${row.id}`);
  if (!secret) throw new Error("The selected-site client secret cannot be decrypted on this host.");
  const connection: ConnectionConfig = { id: row.id, tenantId: row.tenantId, clientId: row.clientId, clientSecret: secret, siteId: row.siteId, driveId: row.driveId, rootFolderPath: row.rootFolderPath };
  try {
    const response = await graphRequest(connection, "GET", `/drives/${encodeURIComponent(connection.driveId)}/root?$select=id,name`);
    if (!response.ok) throw new Error("Microsoft Graph could not read the configured selected-site drive.");
    await db.update(sharepointConnections).set({ lastTestedAt: new Date(), lastTestOk: true, lastError: null }).where(eq(sharepointConnections.id, row.id));
    return { driveId: connection.driveId, rootFolderPath: connection.rootFolderPath };
  } catch (error) {
    const detail = safeError(error);
    await db.update(sharepointConnections).set({ lastTestedAt: new Date(), lastTestOk: false, lastError: detail }).where(eq(sharepointConnections.id, row.id));
    throw new Error(detail);
  }
}

export function conversionProfileLabel(operation: ConversionOperation): string {
  return {
    pdf_to_docx: "PDF to Word (reflow)", pdf_to_text: "PDF to text", docx_to_pdf: "Word to PDF", docx_to_text: "Word to text", text_to_docx: "Text to Word", text_to_pdf: "Text to PDF", pdf_compress_balanced: "PDF compression — balanced", pdf_compress_small: "PDF compression — small", audio_to_webm: "Audio to WebM/Opus",
  }[operation];
}
