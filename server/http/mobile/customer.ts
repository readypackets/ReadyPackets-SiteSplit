/**
 * Customer-only native API adapter.
 *
 * This module deliberately delegates policy, ownership, workflow and encryption
 * decisions to the existing Portal procedures/services. It never accepts a
 * browser cookie as a credential and never exposes an internal numeric resource
 * identifier to a device.
 */
import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import multer from "multer";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { MobileOAuthError, hashMobileValue, opaqueMobileId, type MobilePrincipal } from "../../auth/mobileOidc.js";
import type { ActiveSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { files, forumPosts, forumTopics, mobileIdempotencyKeys, orderPhaseLocks, orders, tickets, users } from "../../db/schema.js";
import { insertedId } from "../../db/result.js";
import { recordActivity, recordSecurityEvent } from "../../observability/audit.js";
import { appRouter } from "../../routers/index.js";
import { authoriseFileAccess, logFileAccess } from "../../routers/files.js";
import { assertCustomerWorkflowStageAccess, assertOrderAccess, listOrdersForUser, OrderStateError } from "../../services/orders.js";
import { probeAudioDurationSeconds } from "../../services/audioDuration.js";
import { buildOrderFileName } from "../../services/fileNaming.js";
import { queueOrderFileSharePointSync } from "../../services/sharepoint.js";
import { contentDisposition, getObjectStream, objectExists, putObject, validateUpload } from "../../services/storage.js";
import { decryptField, encryptField } from "../../security/crypto.js";
import { getOrCreatePaidOrderInvoice } from "../../services/invoices.js";
import { invoicePdfFileName, renderInvoicePdf } from "../../services/invoicePdf.js";
import { env } from "../../config/env.js";

interface MobileRequest extends Request {
  mobile?: MobilePrincipal;
}

type Scope = "mobile:read" | "mobile:write";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 26_214_400, files: 5, fields: 12, parts: 22 },
});

function clientIp(res: Response): string {
  return (res.locals.clientIp as string | undefined) ?? "";
}

function problem(res: Response, status: number, code: string, title: string, detail?: string): void {
  res.status(status).type("application/problem+json").json({
    type: `https://readypackets.com/problems/${code}`,
    title,
    status,
    code,
    detail,
    correlationId: randomBytes(9).toString("base64url"),
  });
}

function statusForTrpc(error: TRPCError): number {
  const map: Record<string, number> = {
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PRECONDITION_FAILED: 412,
    BAD_REQUEST: 400,
    TOO_MANY_REQUESTS: 429,
  };
  return map[error.code] ?? 422;
}

function withMobileError(handler: (req: MobileRequest, res: Response) => Promise<void>) {
  return async (req: MobileRequest, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof MobileOAuthError) {
        problem(res, error.status, error.code, "Mobile request rejected", error.message);
        return;
      }
      if (error instanceof TRPCError) {
        problem(res, statusForTrpc(error), error.code.toLowerCase(), "Mobile request rejected", error.message);
        return;
      }
      if (error instanceof OrderStateError) {
        problem(res, 422, "order_state", "Order action is unavailable", error.message);
        return;
      }
      problem(res, 500, "internal_error", "Unable to complete the mobile request");
    }
  };
}

function requireCustomer(req: MobileRequest, scope: Scope): MobilePrincipal {
  const principal = req.mobile;
  if (!principal) throw new MobileOAuthError("invalid_token", "Mobile authentication is required.", 401);
  if (principal.role !== "customer") {
    throw new MobileOAuthError("forbidden", "Customer mobile access is required.", 403);
  }
  if (!principal.scopes.includes(scope)) {
    throw new MobileOAuthError("insufficient_scope", `The ${scope} permission is required.`, 403);
  }
  return principal;
}

/** A resource reference is AES-GCM sealed and binds type plus owner user ID. */
function sealReference(kind: string, numericId: number, userId: number): string {
  const sealed = encryptField(`${kind}:${numericId}`, `mobile-ref:${kind}:${userId}`);
  if (!sealed) throw new MobileOAuthError("internal_error", "Unable to create a mobile resource reference.", 500);
  return Buffer.from(sealed, "utf8").toString("base64url");
}

function openReference(value: string, kind: string, userId: number): number {
  if (!/^[A-Za-z0-9_-]{24,1024}$/.test(value)) {
    throw new MobileOAuthError("not_found", "The requested resource was not found.", 404);
  }
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const plain = decryptField(decoded, `mobile-ref:${kind}:${userId}`);
  const prefix = `${kind}:`;
  const id = plain?.startsWith(prefix) ? Number(plain.slice(prefix.length)) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    throw new MobileOAuthError("not_found", "The requested resource was not found.", 404);
  }
  return id;
}

async function customerCaller(req: MobileRequest, res: Response, scope: Scope = "mobile:read") {
  const principal = requireCustomer(req, scope);
  const account = (await db
    .select({ id: users.id, role: users.role, emailVerified: users.emailVerified, mfaEnabled: users.mfaEnabled, mustChangePassword: users.mustChangePassword, status: users.status })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1))[0];
  if (!account || account.role !== "customer" || account.status !== "active") {
    throw new MobileOAuthError("invalid_token", "The mobile account is no longer active.", 401);
  }
  const session: ActiveSession = {
    sessionId: principal.sessionId,
    user: { ...account, role: "customer" },
    csrfSecret: "mobile-bearer-not-a-browser-csrf-token",
    mfaPending: false,
    restricted: false,
    expiresAt: new Date(Date.now() + 60_000),
  };
  return appRouter.createCaller({
    req: req as never,
    res: res as never,
    session,
    clientIp: clientIp(res),
    userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
  });
}

async function internalOrderId(req: MobileRequest, publicOrderId: string): Promise<number> {
  const principal = requireCustomer(req, "mobile:read");
  if (!/^RP-ORD-[A-Z0-9-]{8,48}$/i.test(publicOrderId)) {
    throw new MobileOAuthError("not_found", "The requested order was not found.", 404);
  }
  const summary = (await listOrdersForUser(principal.userId)).find((item) => item.orderNumber === publicOrderId);
  if (!summary) throw new MobileOAuthError("not_found", "The requested order was not found.", 404);
  await assertOrderAccess(summary.id, principal.userId, "customer");
  return summary.id;
}

async function runIdempotent<T>(req: MobileRequest, route: string, body: unknown, action: () => Promise<T>) {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 16 || key.length > 128) {
    throw new MobileOAuthError("idempotency_key_required", "A valid Idempotency-Key is required.");
  }
  const principal = requireCustomer(req, "mobile:write");
  const keyHash = hashMobileValue(key);
  const requestHash = hashMobileValue(JSON.stringify(body ?? null));
  const existing = (await db.select().from(mobileIdempotencyKeys).where(and(eq(mobileIdempotencyKeys.userId, principal.userId), eq(mobileIdempotencyKeys.keyHash, keyHash))).limit(1))[0];
  if (existing) {
    if (existing.route !== route || existing.requestHash !== requestHash) {
      throw new MobileOAuthError("idempotency_conflict", "This Idempotency-Key was already used for a different request.", 409);
    }
    return { replayed: true, value: existing.responseJson as T };
  }
  const value = await action();
  await db.insert(mobileIdempotencyKeys).values({
    id: opaqueMobileId(), userId: principal.userId, route, keyHash, requestHash,
    responseJson: value as Record<string, unknown>, expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  });
  return { replayed: false, value };
}

function fileDto(row: Record<string, unknown>, userId: number) {
  return {
    mobileFileRef: sealReference("file", Number(row.id), userId),
    originalName: String(row.originalName ?? "file"),
    extension: row.extension ?? null,
    sizeBytes: Number(row.sizeBytes ?? 0),
    durationSeconds: row.durationSeconds ?? null,
    category: row.category ?? null,
    phase: row.phase ?? null,
    version: Number(row.version ?? 1),
    createdAt: row.createdAt ?? null,
    uploadedByStaff: row.uploadedByStaff === true,
    audio: String(row.detectedMime ?? "").startsWith("audio/"),
  };
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(size - 1, end) };
}

export function createMobileCustomerRouter(): Router {
  const router = createRouter();

  router.get("/orders/:publicOrderId/detail", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const caller = await customerCaller(req, res);
    const detail = await caller.orders.detail({ orderId }) as Record<string, any>;
    const order = detail.order as Record<string, unknown>;
    res.json({
      order: {
        publicOrderId: req.params.publicOrderId,
        projectName: order.projectName ?? null,
        status: order.status,
        statusLabel: order.statusLabel,
        paymentStatus: order.paymentStatus,
        totalCents: order.totalCents,
        completionPercent: order.completionPercent,
        dueAt: order.dueAt ?? null,
        deliveredAt: order.deliveredAt ?? null,
        createdAt: order.createdAt ?? null,
      },
      workflow: detail.workflow ? {
        name: detail.workflow.name,
        description: detail.workflow.description,
        customerPresentation: detail.workflow.customerPresentation,
        stages: detail.workflow.stages,
      } : null,
      workflowProgress: detail.workflowProgress,
      phaseLocks: detail.phaseLocks,
      workflowAdvances: detail.workflowAdvances,
      items: (detail.items ?? []).map((item: Record<string, unknown>) => ({ sku: item.sku, name: item.name, tier: item.tier, quantity: item.quantity, unitPriceCents: item.unitPriceCents, lineTotalCents: item.lineTotalCents })),
      deliverables: (detail.deliverables ?? []).map((item: Record<string, unknown>) => fileDto(item, principal.userId)),
      messages: (detail.notes ?? []).map((note: Record<string, unknown>) => ({ mobileMessageRef: sealReference("message", Number(note.id), principal.userId), body: note.body, createdAt: note.createdAt })),
      history: detail.history,
    });
  }));

  router.get("/orders/:publicOrderId/files", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const rows = await db.select({
      id: files.id, originalName: files.originalName, extension: files.extension,
      sizeBytes: files.sizeBytes, durationSeconds: files.durationSeconds, detectedMime: files.detectedMime,
      category: files.category, phase: files.phase, version: files.version, createdAt: files.createdAt,
      ownerUserId: files.ownerUserId, visibleToCustomer: files.visibleToCustomer, isPlaceholder: files.isPlaceholder,
    }).from(files).where(and(eq(files.orderId, orderId), eq(files.visibleToCustomer, true), isNull(files.deletedAt)));
    res.json({ items: rows.filter((row) => !row.isPlaceholder && (row.ownerUserId === principal.userId || row.visibleToCustomer)).map((row) => fileDto(row, principal.userId)) });
  }));

  router.get("/files/:mobileFileRef/content", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const fileId = openReference(req.params.mobileFileRef ?? "", "file", principal.userId);
    const authorised = await authoriseFileAccess([fileId], principal.userId, "customer");
    const file = authorised[0];
    if (!file || !(await objectExists(file.storageKey))) {
      await logFileAccess(fileId, principal.userId, "mobile_content", clientIp(res), "denied");
      throw new MobileOAuthError("not_found", "The requested file was not found.", 404);
    }
    const row = (await db.select({ sizeBytes: files.sizeBytes, detectedMime: files.detectedMime }).from(files).where(and(eq(files.id, fileId), isNull(files.deletedAt))).limit(1))[0];
    const size = row?.sizeBytes ?? 0;
    const inlineAudio = req.query.disposition === "inline";
    if (inlineAudio && !row?.detectedMime.startsWith("audio/")) {
      throw new MobileOAuthError("not_found", "The requested audio recording was not found.", 404);
    }
    if (size <= 0) throw new MobileOAuthError("not_found", "The requested file was not found.", 404);
    const range = parseRange(req.headers.range, size);
    if (!range) { res.status(416).setHeader("Content-Range", `bytes */${size}`).end(); return; }
    const length = range.end - range.start + 1;
    res.status(req.headers.range ? 206 : 200);
    res.setHeader("Content-Type", inlineAudio ? row!.detectedMime : "application/octet-stream");
    res.setHeader("Content-Disposition", inlineAudio ? `inline; filename="recording"` : contentDisposition(file.originalName));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (req.headers.range) res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    await logFileAccess(fileId, principal.userId, inlineAudio ? "mobile_audio_playback" : "mobile_download", clientIp(res));
    getObjectStream(file.storageKey, { start: range.start, end: range.end }).pipe(res);
  }));

  router.delete("/files/:mobileFileRef", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const fileId = openReference(req.params.mobileFileRef ?? "", "file", principal.userId);
    const result = await runIdempotent(req, "DELETE /files/:ref", { fileId }, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.files.delete({ fileId });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/orders/:publicOrderId/uploads", (req, res, next) => {
    upload.array("files", 5)(req, res, (error: unknown) => {
      if (error) { problem(res, 413, "upload_rejected", "The upload could not be processed", "Each file must be 25 MB or smaller."); return; }
      next();
    });
  }, withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const body = req.body ?? {};
    const phase = typeof body.phase === "string" && /^[a-z0-9_]{2,64}$/.test(body.phase) ? body.phase : "phase_1";
    const recordedAudio = body.recordedAudio === "true";
    const prerecordedAudio = body.prerecordedAudio === "true";
    const capability = recordedAudio ? "recording" : prerecordedAudio ? "audio_upload" : "documents";
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (uploaded.length === 0) throw new MobileOAuthError("invalid_request", "Choose at least one document or recording.");
    if (uploaded.length > 5) throw new MobileOAuthError("invalid_request", "Upload no more than five files at a time.");
    const stageAccess = await assertCustomerWorkflowStageAccess(orderId, phase === "phase_1" ? "phase_1_intake" : phase);
    const capabilities = Array.isArray(stageAccess.stage.capabilities) ? stageAccess.stage.capabilities : [];
    if (!capabilities.includes(capability)) {
      throw new MobileOAuthError("workflow_capability_denied", "This workflow phase does not permit the selected upload type.", 403);
    }
    const locks = await db.select({ id: orderPhaseLocks.id }).from(orderPhaseLocks).where(and(eq(orderPhaseLocks.orderId, orderId), eq(orderPhaseLocks.phaseKey, phase), isNull(orderPhaseLocks.unlockedAt))).limit(1);
    if (locks[0]) throw new MobileOAuthError("workflow_locked", "This workflow phase is submitted and locked.", 403);
    const order = (await db.select({ orderNumber: orders.orderNumber, customerPublicId: users.publicId }).from(orders).innerJoin(users, eq(orders.userId, users.id)).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).limit(1))[0];
    const customerPublicId = order?.customerPublicId;
    if (!order || !customerPublicId) throw new MobileOAuthError("conflict", "The customer tracking reference is unavailable.", 409);
    const expectedExtensions = recordedAudio ? [".m4a", ".webm"] : prerecordedAudio ? [".m4a", ".webm", ".mp3", ".wav", ".ogg"] : undefined;
    const response = await runIdempotent(req, "POST /orders/:publicOrderId/uploads", { order: req.params.publicOrderId, phase, recordedAudio, prerecordedAudio, files: uploaded.map((file) => ({ name: file.originalname, size: file.size })) }, async () => {
      const accepted: Record<string, unknown>[] = [];
      const rejected: Record<string, string>[] = [];
      for (const candidate of uploaded) {
        const validated = await validateUpload(candidate.originalname, candidate.buffer, { allowedExtensions: expectedExtensions });
        if (!validated.ok || !validated.extension || !validated.mime) { rejected.push({ name: candidate.originalname, reason: validated.reason ?? "The file type is not accepted." }); continue; }
        const audio = validated.mime.startsWith("audio/") || validated.mime === "video/webm" || validated.mime === "video/ogg";
        if ((recordedAudio || prerecordedAudio) && !audio) { rejected.push({ name: candidate.originalname, reason: "Choose an approved audio recording." }); continue; }
        if (recordedAudio && ![".m4a", ".webm"].includes(validated.extension)) { rejected.push({ name: candidate.originalname, reason: "Native recordings must be M4A or WebM audio." }); continue; }
        const durationSeconds = audio ? await probeAudioDurationSeconds(candidate.buffer, validated.extension) : null;
        const stored = await putObject(candidate.buffer, validated.extension);
        const originalName = buildOrderFileName({ customerPublicId, orderNumber: order.orderNumber, sourceName: candidate.originalname });
        const result = await db.insert(files).values({
          storageKey: stored.storageKey, orderId, ownerUserId: principal.userId, uploadedByUserId: principal.userId,
          originalName, detectedMime: audio && recordedAudio && validated.mime === "video/webm" ? "audio/webm" : validated.mime,
          extension: validated.extension, sizeBytes: stored.sizeBytes, durationSeconds, sha256: stored.sha256,
          category: "intake_attachment", phase, visibleToCustomer: true,
        });
        const fileId = insertedId(result);
        accepted.push({ mobileFileRef: sealReference("file", fileId, principal.userId), originalName, sizeBytes: stored.sizeBytes, durationSeconds, detectedMime: validated.mime });
        void queueOrderFileSharePointSync(fileId);
        void recordActivity({ actorUserId: principal.userId, actorRole: "customer", action: audio ? "audio.upload" : "file.upload", entityType: "file", entityId: fileId, summary: "Customer mobile upload accepted", changes: { order: req.params.publicOrderId, phase, audio }, ipAddress: clientIp(res) });
      }
      if (accepted.length === 0) throw new MobileOAuthError("upload_rejected", rejected[0]?.reason ?? "No file was accepted.", 422);
      return { files: accepted, rejected };
    });
    res.status(response.replayed ? 200 : 201).json(response.value);
  }));

  router.get("/orders/:publicOrderId/intake", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const caller = await customerCaller(req, res);
    res.json(await caller.intake.get({ orderId }));
  }));

  router.put("/orders/:publicOrderId/intake", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const result = await runIdempotent(req, "PUT /orders/:publicOrderId/intake", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.intake.save({ orderId, projectName: req.body?.projectName, desiredOutcomes: req.body?.desiredOutcomes, integrityChoice: req.body?.integrityChoice, answers: req.body?.answers });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/orders/:publicOrderId/intake/submit", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const result = await runIdempotent(req, "POST /orders/:publicOrderId/intake/submit", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.intake.submit({ orderId, confirmAccurate: req.body?.confirmAccurate === true });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/mnda", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    const publicOrderId = typeof req.query.publicOrderId === "string" ? req.query.publicOrderId : undefined;
    const orderId = publicOrderId ? await internalOrderId(req, publicOrderId) : undefined;
    const [document, status] = await Promise.all([caller.intake.mndaDocument(), caller.intake.mndaStatus({ orderId })]);
    res.json({ document, status });
  }));

  router.post("/mnda/accept", withMobileError(async (req, res) => {
    const publicOrderId = typeof req.body?.publicOrderId === "string" ? req.body.publicOrderId : undefined;
    const orderId = publicOrderId ? await internalOrderId(req, publicOrderId) : undefined;
    const result = await runIdempotent(req, "POST /mnda/accept", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.intake.acceptMnda({ orderId, signatureName: req.body?.signatureName, confirmAuthority: req.body?.confirmAuthority === true });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/orders/:publicOrderId/questions", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const caller = await customerCaller(req, res);
    const questions = await caller.orders.questions({ orderId }) as unknown as Record<string, unknown>[];
    res.json({ items: questions.map((question) => ({ mobileQuestionRef: sealReference("question", Number(question.id), principal.userId), question: question.question, phase: question.phase, required: question.required, status: question.status, answer: question.answer })) });
  }));

  router.post("/questions/:mobileQuestionRef/answer", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const questionId = openReference(req.params.mobileQuestionRef ?? "", "question", principal.userId);
    const result = await runIdempotent(req, "POST /questions/:ref/answer", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.orders.answerQuestion({ questionId, body: req.body?.body });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/orders/:publicOrderId/workflow/:phaseKey/submit", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const result = await runIdempotent(req, "POST /orders/:publicOrderId/workflow/:phaseKey/submit", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.orders.submitWorkflowPhase({ orderId, phaseKey: req.params.phaseKey ?? "", acknowledged: req.body?.acknowledged === true, acknowledgementText: req.body?.acknowledgementText });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/orders/:publicOrderId/workflow/:phaseKey/advance", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const result = await runIdempotent(req, "POST /orders/:publicOrderId/workflow/:phaseKey/advance", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.orders.advanceWorkflowStage({ orderId, phaseKey: req.params.phaseKey ?? "" });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/orders/:publicOrderId/invoice", withMobileError(async (req, res) => {
    await requireCustomer(req, "mobile:read");
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const caller = await customerCaller(req, res);
    const invoice = await caller.invoices.getForOrder({ orderId });
    res.json({
      invoiceNumber: invoice.invoiceNumber,
      orderNumber: invoice.orderNumber,
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt,
      lines: invoice.lines,
      subtotalCents: invoice.subtotalCents,
      discountCents: invoice.discountCents,
      totalCents: invoice.totalCents,
      actualCustomerPaidCents: invoice.actualCustomerPaidCents,
      paymentEvidenceLabel: invoice.paymentEvidenceLabel,
      customerVisible: invoice.customerVisible,
    });
  }));

  router.get("/orders/:publicOrderId/invoice/content", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const invoice = await getOrCreatePaidOrderInvoice(orderId);
    if (!invoice.customerVisible) throw new MobileOAuthError("not_found", "The requested invoice was not found.", 404);
    const pdf = renderInvoicePdf(invoice);
    res.status(200)
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", contentDisposition(invoicePdfFileName(invoice)))
      .setHeader("Content-Length", String(pdf.length))
      .setHeader("Cache-Control", "private, no-store, max-age=0")
      .setHeader("X-Content-Type-Options", "nosniff")
      .send(pdf);
    void recordActivity({ actorUserId: principal.userId, actorRole: "customer", action: "invoice.download", entityType: "invoice", entityId: invoice.id, summary: "Customer downloaded an invoice through the mobile client", ipAddress: clientIp(res) });
  }));

  router.post("/orders/:publicOrderId/checkout-handoff", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const result = await runIdempotent(req, "POST /orders/:publicOrderId/checkout-handoff", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      const checkout = await caller.stripe.createCheckout({
        orderId,
        couponCode: typeof req.body?.couponCode === "string" ? req.body.couponCode : undefined,
        referralCode: typeof req.body?.referralCode === "string" ? req.body.referralCode : undefined,
      });
      return { checkoutUrl: checkout.url, provider: "hosted_checkout", message: "Complete payment in the verified system browser. Card data never enters ReadyPackets mobile storage." };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.get("/messages", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const caller = await customerCaller(req, res);
    const value = await caller.messages.list({ unreadOnly: req.query.unreadOnly === "true", limit: Math.min(250, Math.max(1, Number(req.query.limit) || 100)) });
    res.json({ unreadCount: value.unreadCount, items: value.messages.map((message) => ({
      mobileMessageRef: sealReference("message", message.id, principal.userId),
      publicOrderId: message.orderNumber,
      projectName: message.projectName,
      authorRole: message.authorRole,
      body: message.body,
      createdAt: message.createdAt,
      unread: message.unread,
    })) });
  }));

  router.post("/messages/:mobileMessageRef/read", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const noteId = openReference(req.params.mobileMessageRef ?? "", "message", principal.userId);
    const result = await runIdempotent(req, "POST /messages/:ref/read", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.messages.markRead({ noteId });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/orders/:publicOrderId/messages", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const result = await runIdempotent(req, "POST /orders/:publicOrderId/messages", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      const note = await caller.orders.addNote({ orderId, body: req.body?.body });
      return { ok: note.ok, message: "Your message has been sent to the ReadyPackets team." };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.get("/notifications", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const caller = await customerCaller(req, res);
    const [unreadMessages, unreadTickets, orders] = await Promise.all([
      caller.messages.unread(),
      caller.tickets.unreadCount(),
      listOrdersForUser(principal.userId),
    ]);
    const items = [
      ...unreadMessages.messages.map((message) => ({ kind: "message", publicOrderId: message.orderNumber, createdAt: message.createdAt, title: "New ReadyPackets message", body: "Open Messages to read the latest approved communication." })),
      ...orders.filter((order) => order.attention.state === "awaiting_customer_response").map((order) => ({ kind: "workflow", publicOrderId: order.orderNumber, createdAt: order.createdAt, title: "Action requested", body: "A ReadyPackets workflow item needs your response." })),
      ...(unreadTickets > 0 ? [{ kind: "support", publicOrderId: null, createdAt: new Date(), title: "Support update", body: `You have ${unreadTickets} support ticket update${unreadTickets === 1 ? "" : "s"}.` }] : []),
    ];
    res.json({ items, unreadCount: items.length, generatedAt: new Date().toISOString() });
  }));

  router.get("/notification-preferences", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    res.json({ items: await caller.account.notificationChannels() });
  }));

  router.put("/notification-preferences/:channel", withMobileError(async (req, res) => {
    const channel = req.params.channel ?? "";
    const result = await runIdempotent(req, "PUT /notification-preferences/:channel", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.account.setNotificationPreference({ channel: channel as any, enabled: req.body?.enabled === true });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/tickets/categories", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    res.json(await caller.tickets.categories());
  }));

  router.get("/tickets", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    const value = await caller.tickets.list();
    res.json({ items: value.map((ticket) => ({ ticketNumber: ticket.ticketNumber, subject: ticket.subject, category: ticket.category, status: ticket.status, priority: ticket.priority, lastReplyAt: ticket.lastReplyAt, createdAt: ticket.createdAt })) });
  }));

  router.get("/tickets/:ticketNumber", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const ticketNumber = req.params.ticketNumber ?? "";
    const ticket = (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.userId, principal.userId), eq(tickets.ticketNumber, ticketNumber))).limit(1))[0];
    if (!ticket) throw new MobileOAuthError("not_found", "The requested support ticket was not found.", 404);
    const caller = await customerCaller(req, res);
    const value = await caller.tickets.detail({ ticketId: ticket.id });
    res.json({ ticket: { ticketNumber: value.ticket.ticketNumber, subject: value.ticket.subject, category: value.ticket.category, status: value.ticket.status, priority: value.ticket.priority, createdAt: value.ticket.createdAt, resolvedAt: value.ticket.resolvedAt }, replies: value.replies.map((reply) => ({ body: reply.body, author: reply.author, isStaffReply: reply.isStaffReply, createdAt: reply.createdAt })) });
  }));

  router.post("/tickets", withMobileError(async (req, res) => {
    const publicOrderId = typeof req.body?.publicOrderId === "string" ? req.body.publicOrderId : undefined;
    const orderId = publicOrderId ? await internalOrderId(req, publicOrderId) : undefined;
    const result = await runIdempotent(req, "POST /tickets", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      const value = await caller.tickets.create({ subject: req.body?.subject, body: req.body?.body, category: req.body?.category, priority: req.body?.priority, orderId });
      return { ok: value.ok, ticketNumber: value.ticketNumber };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.post("/tickets/:ticketNumber/replies", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const ticket = (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.userId, principal.userId), eq(tickets.ticketNumber, req.params.ticketNumber ?? ""))).limit(1))[0];
    if (!ticket) throw new MobileOAuthError("not_found", "The requested support ticket was not found.", 404);
    const result = await runIdempotent(req, "POST /tickets/:ticketNumber/replies", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.tickets.reply({ ticketId: ticket.id, body: req.body?.body });
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.post("/tickets/:ticketNumber/close", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const ticket = (await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.userId, principal.userId), eq(tickets.ticketNumber, req.params.ticketNumber ?? ""))).limit(1))[0];
    if (!ticket) throw new MobileOAuthError("not_found", "The requested support ticket was not found.", 404);
    const result = await runIdempotent(req, "POST /tickets/:ticketNumber/close", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.tickets.close({ ticketId: ticket.id });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/community/categories", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    const items = await caller.community.categories();
    res.json({ items: items.map((category) => ({ slug: category.slug, name: category.name, description: category.description })) });
  }));

  router.get("/community/topics", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    const categorySlug = typeof req.query.category === "string" ? req.query.category : undefined;
    let categoryId: number | undefined;
    if (categorySlug) {
      const category = (await caller.community.categories()).find((value) => value.slug === categorySlug);
      if (!category) throw new MobileOAuthError("not_found", "The requested community category was not found.", 404);
      categoryId = category.id;
    }
    const value = await caller.community.topics({ categoryId, limit: Math.min(50, Math.max(1, Number(req.query.limit) || 25)), offset: Math.max(0, Number(req.query.offset) || 0) });
    res.json({ items: value.map((topic) => ({ slug: topic.slug, title: topic.title, excerpt: topic.excerpt, pinned: topic.pinned, locked: topic.locked, replyCount: topic.replyCount, author: topic.author, lastPostAt: topic.lastPostAt, createdAt: topic.createdAt })) });
  }));

  router.get("/community/topics/:slug", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const caller = await customerCaller(req, res);
    const value = await caller.community.topic({ slug: req.params.slug ?? "" });
    res.json({
      topic: { slug: value.topic.slug, title: value.topic.title, body: value.topic.body, locked: value.topic.locked, pinned: value.topic.pinned, author: value.topic.author, createdAt: value.topic.createdAt, reactions: value.topic.reactions },
      posts: value.posts.map((post) => ({ mobilePostRef: sealReference("forum-post", post.id, principal.userId), body: post.body, author: post.author, createdAt: post.createdAt, reactions: post.reactions })),
    });
  }));

  router.post("/community/topics", withMobileError(async (req, res) => {
    const result = await runIdempotent(req, "POST /community/topics", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      const category = (await caller.community.categories()).find((value) => value.slug === req.body?.categorySlug);
      if (!category) throw new MobileOAuthError("not_found", "Choose an available community category.", 404);
      const value = await caller.community.createTopic({ categoryId: category.id, title: req.body?.title, body: req.body?.body });
      return { ok: value.ok, slug: value.slug };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.post("/community/topics/:slug/posts", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const topic = (await db.select({ id: forumTopics.id }).from(forumTopics).where(and(eq(forumTopics.slug, req.params.slug ?? ""), isNull(forumTopics.deletedAt))).limit(1))[0];
    if (!topic) throw new MobileOAuthError("not_found", "The requested community topic was not found.", 404);
    const result = await runIdempotent(req, "POST /community/topics/:slug/posts", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      const value = await caller.community.createPost({ topicId: topic.id, body: req.body?.body });
      return { ok: value.ok, mobilePostRef: sealReference("forum-post", value.postId, principal.userId) };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.post("/community/topics/:slug/reaction", withMobileError(async (req, res) => {
    const topic = (await db.select({ id: forumTopics.id }).from(forumTopics).where(and(eq(forumTopics.slug, req.params.slug ?? ""), isNull(forumTopics.deletedAt))).limit(1))[0];
    if (!topic) throw new MobileOAuthError("not_found", "The requested community topic was not found.", 404);
    const result = await runIdempotent(req, "POST /community/topics/:slug/reaction", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.community.react({ topicId: topic.id });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/community/posts/:mobilePostRef/reaction", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const postId = openReference(req.params.mobilePostRef ?? "", "forum-post", principal.userId);
    const post = (await db.select({ topicId: forumPosts.topicId }).from(forumPosts).where(and(eq(forumPosts.id, postId), isNull(forumPosts.deletedAt))).limit(1))[0];
    if (!post) throw new MobileOAuthError("not_found", "The requested community post was not found.", 404);
    const result = await runIdempotent(req, "POST /community/posts/:ref/reaction", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.community.react({ topicId: post.topicId, postId });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/community/reviews", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    const [reviewable, reviews] = await Promise.all([caller.community.reviewableOrders(), caller.community.myReviews()]);
    res.json({ reviewableOrders: reviewable.map((order) => ({ publicOrderId: order.orderNumber, deliveredAt: order.deliveredAt })), reviews: reviews.map((review) => ({ rating: review.rating, title: review.title, body: review.body, status: review.status, moderationNote: review.moderationNote, createdAt: review.createdAt, publishedAt: review.publishedAt })) });
  }));

  router.post("/community/reviews", withMobileError(async (req, res) => {
    const orderId = await internalOrderId(req, req.body?.publicOrderId ?? "");
    const result = await runIdempotent(req, "POST /community/reviews", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.community.createReview({ orderId, rating: req.body?.rating, title: req.body?.title, body: req.body?.body, displayName: req.body?.displayName });
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.get("/workspaces", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:read");
    const caller = await customerCaller(req, res);
    const items = await caller.orders.workspaces();
    res.json({ items: items.map((workspace) => ({ mobileWorkspaceRef: sealReference("workspace", workspace.id, principal.userId), name: workspace.name, slug: workspace.slug, role: workspace.role, youOwnThisWorkspace: workspace.ownerUserId === principal.userId })) });
  }));

  router.post("/workspaces", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const result = await runIdempotent(req, "POST /workspaces", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      const value = await caller.orders.createWorkspace({ name: req.body?.name });
      return { mobileWorkspaceRef: sealReference("workspace", value.id, principal.userId), slug: value.slug };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.post("/workspaces/:mobileWorkspaceRef/members", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const workspaceId = openReference(req.params.mobileWorkspaceRef ?? "", "workspace", principal.userId);
    const result = await runIdempotent(req, "POST /workspaces/:ref/members", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.orders.addWorkspaceMember({ workspaceId, email: req.body?.email, role: req.body?.role });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/orders/:publicOrderId/workspaces/:mobileWorkspaceRef", withMobileError(async (req, res) => {
    const principal = requireCustomer(req, "mobile:write");
    const orderId = await internalOrderId(req, req.params.publicOrderId ?? "");
    const workspaceId = openReference(req.params.mobileWorkspaceRef ?? "", "workspace", principal.userId);
    const result = await runIdempotent(req, "POST /orders/:publicOrderId/workspaces/:ref", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.orders.shareOrderWithWorkspace({ orderId, workspaceId, scope: req.body?.scope });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/referrals", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    const [code, stats] = await Promise.all([caller.tier4.referral.myCode(), caller.tier4.referral.myStats()]);
    res.json({ code: code.code, stats });
  }));

  router.get("/me/profile", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    res.json({ fields: await caller.account.profileFields() });
  }));

  router.put("/me/profile", withMobileError(async (req, res) => {
    const result = await runIdempotent(req, "PUT /me/profile", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      return caller.auth.updateProfile(req.body ?? {});
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/me/policies", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    res.json({ pending: await caller.account.pendingPolicies() });
  }));

  router.post("/me/policies/:policyVersionId/accept", withMobileError(async (req, res) => {
    const policyVersionId = Number(req.params.policyVersionId);
    if (!Number.isInteger(policyVersionId) || policyVersionId <= 0) throw new MobileOAuthError("not_found", "The requested policy was not found.", 404);
    const result = await runIdempotent(req, "POST /me/policies/:policyVersionId/accept", req.body, async () => {
      const caller = await customerCaller(req, res, "mobile:write");
      if (req.body?.accepted !== true) throw new MobileOAuthError("affirmation_required", "Confirm that you accept the policy before continuing.", 422);
      return caller.account.acceptPolicy({ policyVersionId });
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.get("/knowledge", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    const items = await caller.knowledgeBase.visible({ query: typeof req.query.query === "string" ? req.query.query : undefined, category: typeof req.query.category === "string" ? req.query.category : undefined });
    res.json({ items });
  }));

  router.get("/knowledge/:slug", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    res.json(await caller.knowledgeBase.article({ slug: req.params.slug ?? "" }));
  }));

  router.get("/public/faqs", withMobileError(async (req, res) => {
    const caller = await customerCaller(req, res);
    res.json({ items: await caller.faqs.visible({ category: typeof req.query.category === "string" ? req.query.category : undefined }) });
  }));

  router.get("/public/entrypoints", withMobileError(async (req, res) => {
    // Auth lifecycle and legal flows run in the secure system browser so the app
    // retains Portal antifraud, email, session, SSO, and step-up-auth controls.
    res.json({
      catalogueUrl: new URL("/packets", env.appUrl).toString(),
      registrationUrl: new URL("/register", env.appUrl).toString(),
      passwordRecoveryUrl: new URL("/forgot-password", env.appUrl).toString(),
      securityUrl: new URL("/portal/account/security", env.appUrl).toString(),
      policiesUrl: new URL("/policies", env.appUrl).toString(),
      contactUrl: new URL("/contact", env.appUrl).toString(),
    });
  }));

  return router;
}
