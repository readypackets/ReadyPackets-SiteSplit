/**
 * Multipart upload endpoint.
 *
 * Files are buffered in memory up to the configured limit and never written to
 * disk before validation, so a rejected file leaves nothing behind. Content is
 * validated by magic bytes, stored under a random key, and recorded with its
 * SHA-256 digest so tampering is detectable.
 */
import type { Request, Response, Router } from "express";
import express from "express";
import multer from "multer";
import { and, eq, isNull, sql } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { fileVersions, files, intakeAnswers, intakeSubmissions, orderPhaseLocks, orders, orderWorkflows, users } from "../db/schema.js";
import { getSetting, getSettingNumber } from "../services/settings.js";
import { resolveSession } from "../auth/session.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../security/csrf.js";
import { constantTimeEqual } from "../security/crypto.js";
import { putObject, validateUpload } from "../services/storage.js";
import { buildOrderFileName } from "../services/fileNaming.js";
import { probeAudioDurationSeconds } from "../services/audioDuration.js";
import { queueOrderFileSharePointSync } from "../services/sharepoint.js";
import { getStageConversionPolicy, queueStageFileProcessing } from "../services/conversionPipeline.js";
import { logger } from "../observability/logger.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import { assertCustomerWorkflowStageAccess, assertOrderWritableAccess, OrderStateError } from "../services/orders.js";
import { insertedId } from "../db/result.js";

const UPLOAD_CATEGORIES = new Set([
  "deliverable",
  "intake_attachment",
  "signed_document",
  "reference",
  "internal",
  "ticket_attachment",
]);

export function createUploadRouter(): Router {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: env.storage.maxUploadBytes,
      files: 5,
      fields: 10,
      parts: 20,
    },
  });

  router.post(
    "/upload",
    (req, res, next) => {
      upload.array("files", 5)(req, res, (error: unknown) => {
        if (error) {
          const message =
            error instanceof Error && error.message.includes("File too large")
              ? `Each file must be ${Math.floor(env.storage.maxUploadBytes / 1_048_576)} MB or smaller.`
              : "The upload could not be processed.";
          res.status(413).json({ error: message });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      const session = await resolveSession(req);
      if (!session || session.mfaPending || session.restricted) {
        res.status(401).json({ error: "Authentication required." });
        return;
      }

      // The multipart route sits outside tRPC, so CSRF is verified explicitly.
      const headerToken = req.headers[CSRF_HEADER];
      const cookieToken = (req.cookies?.[CSRF_COOKIE] as string | undefined) ?? "";
      if (
        typeof headerToken !== "string" ||
        !constantTimeEqual(headerToken, cookieToken) ||
        !constantTimeEqual(headerToken, session.csrfSecret)
      ) {
        void recordSecurityEvent({
          eventType: "csrf.rejected",
          outcome: "blocked",
          severity: "warning",
          message: "Upload rejected: invalid CSRF token",
          userId: session.user.id,
          ipAddress: (res.locals.clientIp as string | undefined) ?? null,
        });
        res.status(403).json({ error: "Invalid or missing CSRF token." });
        return;
      }

      const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (uploaded.length === 0) {
        res.status(400).json({ error: "No file was supplied." });
        return;
      }

      const isStaff = session.user.role === "admin" || session.user.role === "staff";
      const rawOrderId = typeof req.body.orderId === "string" ? Number(req.body.orderId) : null;
      const orderId = Number.isInteger(rawOrderId) && rawOrderId! > 0 ? rawOrderId! : null;
      const requestedCategory =
        typeof req.body.category === "string" ? req.body.category : "intake_attachment";
      const category = UPLOAD_CATEGORIES.has(requestedCategory)
        ? requestedCategory
        : "intake_attachment";
      const requestedPhase = typeof req.body.phase === "string" ? req.body.phase.trim().toLowerCase() : null;
      const phase = requestedPhase && /^[a-z0-9_]{2,64}$/.test(requestedPhase)
        ? requestedPhase
        : category === "intake_attachment" ? "phase_1" : "unassigned";
      const replaceFileId =
        typeof req.body.replaceFileId === "string" ? Number(req.body.replaceFileId) : null;
      const intakeQuestionKey =
        typeof req.body.intakeQuestionKey === "string" ? req.body.intakeQuestionKey : null;
      const recordedPitch = req.body.recordedPitch === "true" && req.get("x-rp-recorded-pitch") === "true";
      const prerecordedAudio = req.body.prerecordedAudio === "true";

      // Customers may only attach to their own orders, and only in safe categories.
      if (orderId !== null) {
        try {
          await assertOrderWritableAccess(orderId, session.user.id, session.user.role);
        } catch {
          res.status(404).json({ error: "Order not found." });
          return;
        }
      }
      if (orderId === null) {
        res.status(400).json({ error: "An order is required for uploaded files so the customer and order tracking prefix can be applied." });
        return;
      }
      const fileContextRows = await db
        .select({ orderNumber: orders.orderNumber, customerPublicId: users.publicId })
        .from(orders)
        .innerJoin(users, eq(users.id, orders.userId))
        .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
        .limit(1);
      const fileContext = fileContextRows[0];
      if (!fileContext?.customerPublicId) {
        res.status(409).json({ error: "This order’s customer tracking ID is unavailable. Ask an administrator to repair the customer record before uploading files." });
        return;
      }

      if (!isStaff && orderId !== null) {
        const activeLocks = await db
          .select({ id: orderPhaseLocks.id })
          .from(orderPhaseLocks)
          .where(and(eq(orderPhaseLocks.orderId, orderId), eq(orderPhaseLocks.phaseKey, phase), isNull(orderPhaseLocks.unlockedAt)))
          .limit(1);
        if (activeLocks[0]) {
          res.status(403).json({ error: "This workflow phase has been submitted and locked. Ask an administrator to unlock it before changing files or recordings." });
          return;
        }
      }
      type StageUploadLimits = { documentMaxFiles?: unknown; documentMaxSizeMb?: unknown; audioMaxFiles?: unknown; audioMaxSizeMb?: unknown; recordingMaxDurationSeconds?: unknown; audioTotalDurationSeconds?: unknown };
      let stageCapabilities: string[] | null = null;
      let stageUploadLimits: { documentMaxFiles?: number; documentMaxSizeMb?: number; audioMaxFiles?: number; audioMaxSizeMb?: number; recordingMaxDurationSeconds?: number; audioTotalDurationSeconds?: number } | null = null;
      if (requestedPhase && phase !== "unassigned") {
        const orderRows = await db.select({ workflowId: orders.workflowId }).from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).limit(1);
        const workflowId = orderRows[0]?.workflowId;
        const workflowRows = workflowId
          ? await db.select({ stages: orderWorkflows.stages }).from(orderWorkflows).where(eq(orderWorkflows.id, workflowId)).limit(1)
          : [];
        const stages = Array.isArray(workflowRows[0]?.stages) ? workflowRows[0]?.stages as { key?: unknown; capabilities?: unknown; uploadLimits?: unknown }[] : [];
        const workflowStageKey = phase === "phase_1" ? "phase_1_intake" : phase === "phase_2" ? "phase_2_synthesis" : phase;
        const stage = stages.find((item) => item.key === workflowStageKey);
        if (!stage && !["phase_1", "phase_2"].includes(phase)) {
          res.status(400).json({ error: "The selected workflow phase is not available for this order." });
          return;
        }
        if (!isStaff && stage) {
          try {
            await assertCustomerWorkflowStageAccess(orderId, workflowStageKey);
          } catch (error) {
            const message = error instanceof OrderStateError ? error.message : "This workflow phase is not available yet.";
            res.status(403).json({ error: message });
            return;
          }
        }
        if (stage) {
          stageCapabilities = Array.isArray(stage.capabilities)
            ? stage.capabilities.filter((capability): capability is string => typeof capability === "string")
            : ["documents", "questions", "recording"];
          const rawLimits = stage.uploadLimits && typeof stage.uploadLimits === "object" ? stage.uploadLimits as StageUploadLimits : {};
          const limit = (value: unknown, maximum: number) => typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(maximum, value) : undefined;
          stageUploadLimits = {
            documentMaxFiles: limit(rawLimits.documentMaxFiles, 50),
            documentMaxSizeMb: limit(rawLimits.documentMaxSizeMb, 100),
            audioMaxFiles: limit(rawLimits.audioMaxFiles, 50),
            audioMaxSizeMb: limit(rawLimits.audioMaxSizeMb, 100),
            recordingMaxDurationSeconds: limit(rawLimits.recordingMaxDurationSeconds, 7_200),
            audioTotalDurationSeconds: limit(rawLimits.audioTotalDurationSeconds, 7_200),
          };
        }
      }
      if (!isStaff && (category === "deliverable" || category === "internal")) {
        res.status(403).json({ error: "You cannot upload files of that type." });
        return;
      }
      if (stageCapabilities && prerecordedAudio && !stageCapabilities.includes("audio_upload")) {
        res.status(403).json({ error: "This workflow phase does not allow pre-recorded audio uploads." });
        return;
      }
      if (!isStaff && stageCapabilities) {
        const requiredCapability = recordedPitch ? "recording" : prerecordedAudio ? "audio_upload" : "documents";
        if (!stageCapabilities.includes(requiredCapability)) {
          const capabilityLabel = requiredCapability === "recording" ? "browser recordings" : requiredCapability === "audio_upload" ? "pre-recorded audio uploads" : "document uploads";
          res.status(403).json({ error: `This workflow phase does not accept customer ${capabilityLabel}.` });
          return;
        }
      }
      if (!isStaff && replaceFileId) {
        res.status(403).json({ error: "Only staff can replace an existing file." });
        return;
      }

      // Configuration is resolved once and snapshotted into every subsequent job.
      // A failed optional conversion/sync queue must never roll back a valid upload.
      const conversionPolicy = await getStageConversionPolicy(orderId, phase);

      const results: {
        fileId: number;
        originalName: string;
        sizeBytes: number;
        detectedMime: string;
      }[] = [];
      const rejected: { name: string; reason: string }[] = [];

      let existingDocumentCount = 0;
      let existingAudioCount = 0;
      let existingAudioDurationSeconds = 0;
      if (stageUploadLimits && (stageUploadLimits.documentMaxFiles || stageUploadLimits.audioMaxFiles || stageUploadLimits.audioTotalDurationSeconds)) {
        const existingRows = await db.select({ detectedMime: files.detectedMime, durationSeconds: files.durationSeconds }).from(files).where(and(eq(files.orderId, orderId), eq(files.phase, phase), isNull(files.deletedAt), eq(files.isPlaceholder, false)));
        for (const row of existingRows) {
          const audio = row.detectedMime.startsWith("audio/") || row.detectedMime === "video/webm" || row.detectedMime === "video/ogg";
          if (audio) {
            existingAudioCount += 1;
            existingAudioDurationSeconds += Math.max(0, row.durationSeconds ?? 0);
          } else existingDocumentCount += 1;
        }
      }

      let allowedExtensions: string[] | undefined;
      if (category === "intake_attachment") {
        if (recordedPitch) {
          allowedExtensions = [".webm", ".m4a", ".ogg"];
          if (!orderId || uploaded.length !== 1) {
            res.status(400).json({ error: "A Business Pitch Idea must be recorded as one browser audio file for a specific order." });
            return;
          }
          const maxPitchRecordings = await getSettingNumber("intake.max_pitch_recordings", 1);
          const existingPitchRows = await db
            .select({ total: sql<number>`COUNT(*)` })
            .from(files)
            .where(and(eq(files.orderId, orderId), eq(files.category, "intake_attachment"), eq(files.phase, phase), isNull(files.deletedAt), sql`${files.detectedMime} IN ('audio/webm', 'video/webm', 'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'video/ogg')`));
          if (Number(existingPitchRows[0]?.total ?? 0) >= maxPitchRecordings) {
            res.status(400).json({ error: `This intake already has the maximum of ${maxPitchRecordings} Business Pitch recording(s).` });
            return;
          }
        } else if (prerecordedAudio) {
          allowedExtensions = [".webm", ".mp3", ".m4a", ".wav", ".ogg", ".opus", ".aac", ".flac", ".aiff", ".mp4"];
        } else {
          const allowedTypesSetting = await getSetting("intake.allowed_document_types");
          if (allowedTypesSetting) allowedExtensions = allowedTypesSetting.split(",").map(s => s.trim().toLowerCase());
        }
      }

      for (const file of uploaded) {
        const validation = await validateUpload(file.originalname, file.buffer, { allowedExtensions });
        if (!validation.ok) {
          rejected.push({ name: file.originalname, reason: validation.reason ?? "Rejected." });
          void recordSecurityEvent({
            eventType: "file.access_denied",
            outcome: "blocked",
            severity: "warning",
            message: `Upload rejected: ${validation.reason ?? "validation failed"}`,
            userId: session.user.id,
            ipAddress: (res.locals.clientIp as string | undefined) ?? null,
            metadata: { filename: file.originalname, size: file.size },
          });
          continue;
        }

        const isAudio = validation.mime?.startsWith("audio/") || validation.mime === "video/webm" || validation.mime === "video/ogg";
        // Magic-byte validation accepts only browser-recordable audio containers.
        // Generic WebM and Ogg containers can be classified as video MIME types
        // before tracks are inspected; browser-recorded pitches are audio-only by construction.
        const recordedPitchFormat = (
          validation.extension === "webm" && (validation.mime === "audio/webm" || validation.mime === "video/webm")
        ) || (
          validation.extension === "m4a" && (validation.mime === "audio/mp4" || validation.mime === "audio/x-m4a")
        ) || (
          validation.extension === "ogg" && (validation.mime === "audio/ogg" || validation.mime === "video/ogg")
        );
        if (recordedPitch && !recordedPitchFormat) {
          rejected.push({ name: file.originalname, reason: "Business Pitch recordings must use a browser-recorded M4A, WebM, or Ogg audio container." });
          continue;
        }
        const detectedMime = validation.mime ?? "application/octet-stream";
        const countsAsAudio = recordedPitch || isAudio || prerecordedAudio;
        const audioDurationSeconds = countsAsAudio ? await probeAudioDurationSeconds(file.buffer, validation.extension ?? "") : null;
        const durationGoverned = Boolean(stageUploadLimits?.recordingMaxDurationSeconds || stageUploadLimits?.audioTotalDurationSeconds);
        if (countsAsAudio && durationGoverned && !audioDurationSeconds) {
          rejected.push({ name: file.originalname, reason: "The recording duration could not be verified, so this governed audio file was not accepted." });
          continue;
        }
        if (recordedPitch && stageUploadLimits?.recordingMaxDurationSeconds && audioDurationSeconds && audioDurationSeconds > stageUploadLimits.recordingMaxDurationSeconds) {
          rejected.push({ name: file.originalname, reason: `This browser recording is ${audioDurationSeconds} seconds; this phase allows up to ${stageUploadLimits.recordingMaxDurationSeconds} seconds per browser recording.` });
          continue;
        }
        if (!replaceFileId && stageUploadLimits?.audioTotalDurationSeconds && audioDurationSeconds && existingAudioDurationSeconds + audioDurationSeconds > stageUploadLimits.audioTotalDurationSeconds) {
          rejected.push({ name: file.originalname, reason: `This phase allows ${stageUploadLimits.audioTotalDurationSeconds} total audio seconds. Remove an existing recording or choose a shorter recording.` });
          continue;
        }
        const maxFiles = countsAsAudio ? stageUploadLimits?.audioMaxFiles : stageUploadLimits?.documentMaxFiles;
        const maxSizeMb = countsAsAudio ? stageUploadLimits?.audioMaxSizeMb : stageUploadLimits?.documentMaxSizeMb;
        const existingCount = countsAsAudio ? existingAudioCount : existingDocumentCount;
        if (maxFiles && !replaceFileId && existingCount >= maxFiles) {
          rejected.push({ name: file.originalname, reason: `This workflow phase allows up to ${maxFiles} ${countsAsAudio ? "audio recording(s)/file(s)" : "document(s)"}. Remove an existing item before adding another.` });
          continue;
        }
        if (maxSizeMb && file.size > maxSizeMb * 1_048_576) {
          rejected.push({ name: file.originalname, reason: `This workflow phase limits each ${countsAsAudio ? "audio file" : "document"} to ${maxSizeMb} MB.` });
          continue;
        }
        if (isAudio && !recordedPitch && !prerecordedAudio) {
          rejected.push({ name: file.originalname, reason: "Choose the pre-recorded audio upload option for an audio file and enable it for this workflow phase." });
          continue;
        }
        if (prerecordedAudio && !isAudio) {
          rejected.push({ name: file.originalname, reason: "Select an approved audio file for this workflow phase." });
          continue;
        }

        const canonicalOriginalName = buildOrderFileName({
          customerPublicId: fileContext.customerPublicId,
          orderNumber: fileContext.orderNumber,
          sourceName: file.originalname,
        });
        try {
          const stored = await putObject(file.buffer, validation.extension ?? "");

          // Replacement keeps the file identity and archives the previous version.
          if (replaceFileId) {
            const existingRows = await db
              .select()
              .from(files)
              .where(and(eq(files.id, replaceFileId), isNull(files.deletedAt)))
              .limit(1);
            const existing = existingRows[0];
            if (existing) {
              await db.insert(fileVersions).values({
                fileId: existing.id,
                storageKey: existing.storageKey,
                sizeBytes: existing.sizeBytes,
                sha256: existing.sha256,
                version: existing.version,
                replacedByUserId: session.user.id,
              });
              await db
                .update(files)
                .set({
                  storageKey: stored.storageKey,
                  originalName: canonicalOriginalName,
                  detectedMime,
                  extension: validation.extension ?? null,
                  sizeBytes: stored.sizeBytes,
                  durationSeconds: audioDurationSeconds,
                  sha256: stored.sha256,
                  version: existing.version + 1,
                  isPlaceholder: false,
                })
                .where(eq(files.id, existing.id));

              results.push({
                fileId: existing.id,
                originalName: canonicalOriginalName,
                sizeBytes: stored.sizeBytes,
                detectedMime,
              });

              void queueOrderFileSharePointSync(existing.id).catch((error) => logger.warn("SharePoint file sync could not be queued", { fileId: existing.id, error }));
              void queueStageFileProcessing(existing.id, conversionPolicy).catch((error) => logger.warn("Configured file processing could not be queued", { fileId: existing.id, error: String(error) }));
              void recordActivity({
                actorUserId: session.user.id,
                actorRole: session.user.role,
                action: "file.replace",
                entityType: "file",
                entityId: existing.id,
                summary: `File "${existing.originalName}" replaced with version ${existing.version + 1}`,
                ipAddress: (res.locals.clientIp as string | undefined) ?? null,
              });
              continue;
            }
          }

          const inserted = await db.insert(files).values({
            storageKey: stored.storageKey,
            orderId,
            ownerUserId: isStaff ? null : session.user.id,
            uploadedByUserId: session.user.id,
            originalName: canonicalOriginalName,
            detectedMime,
            extension: validation.extension ?? null,
            sizeBytes: stored.sizeBytes,
            durationSeconds: audioDurationSeconds,
            sha256: stored.sha256,
            category,
            phase,
            // Staff publish deliverables explicitly; customer uploads are theirs by definition.
            visibleToCustomer: !isStaff,
          });
          const fileId = insertedId(inserted);

          // Link an intake attachment to its question.
          if (intakeQuestionKey && orderId) {
            const submissionRows = await db
              .select({ id: intakeSubmissions.id })
              .from(intakeSubmissions)
              .where(eq(intakeSubmissions.orderId, orderId))
              .limit(1);
            const submissionId = submissionRows[0]?.id;
            if (submissionId) {
              await db
                .insert(intakeAnswers)
                .values({
                  submissionId,
                  questionKey: intakeQuestionKey.slice(0, 48),
                  attachmentFileId: fileId,
                });
            }
          }

          results.push({
            fileId,
            originalName: canonicalOriginalName,
            sizeBytes: stored.sizeBytes,
            detectedMime,
          });
          if (countsAsAudio) {
            existingAudioCount += 1;
            existingAudioDurationSeconds += audioDurationSeconds ?? 0;
          } else existingDocumentCount += 1;

          void queueOrderFileSharePointSync(fileId).catch((error) => logger.warn("SharePoint file sync could not be queued", { fileId, error }));
          void queueStageFileProcessing(fileId, conversionPolicy).catch((error) => logger.warn("Configured file processing could not be queued", { fileId, error: String(error) }));
          void recordActivity({
            actorUserId: session.user.id,
            actorRole: session.user.role,
            action: "file.upload",
            entityType: "file",
            entityId: fileId,
            summary: `Uploaded "${canonicalOriginalName}" (${category})`,
            changes: { sizeBytes: stored.sizeBytes, durationSeconds: audioDurationSeconds, orderId, phase },
            ipAddress: (res.locals.clientIp as string | undefined) ?? null,
          });
        } catch (error) {
          logger.error("Upload storage failed", { error });
          rejected.push({ name: file.originalname, reason: "The file could not be stored." });
        }
      }

      if (results.length === 0) {
        res.status(400).json({ error: rejected[0]?.reason ?? "No file was accepted.", rejected });
        return;
      }

      res.status(201).json({ files: results, rejected });
    },
  );

  return router;
}
