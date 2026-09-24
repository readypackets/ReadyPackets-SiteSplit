/**
 * Integrations router — webhooks, SharePoint, email automations, and phase kickoff config.
 *
 * All procedures require at least staff access; destructive operations require admin.
 */
import { z } from "zod";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  phaseJobs,
  phaseKickoffConfigs,
  sharepointSyncLog,
  conversionJobs,
  conversionProfiles,
  sharepointConnections,
  sharepointTargetBindings,
  sharepointTransferJobs,
  files,
  orders,
  webhookDeliveries,
  webhookEndpoints,
} from "../db/schema.js";
import { adminProcedure, staffProcedure, router } from "../trpc/trpc.js";
import { TRPCError } from "@trpc/server";
import { encryptField, decryptField } from "../security/crypto.js";
import { env } from "../config/env.js";
import { browseSharePointFolders, DEFAULT_FOLDER_TEMPLATES, discoverSharePointConfig, normalizeSharePointFolderTemplate, normalizeSharePointRootFolderPath, runPhaseKickoff, resetGraphTokenCache, testSharePointConnection } from "../services/sharepoint.js";
import { disconnectDelegatedSharePointIdentity, getDelegatedSharePointStatus, startDelegatedSharePointAuthorization } from "../services/sharepointDelegatedAuth.js";
import { getSetting, setSetting } from "../services/settings.js";
import { recordActivity } from "../observability/audit.js";
import { CONVERSION_OPERATIONS, conversionProfileLabel, NATIVE_CONVERTER_FINGERPRINT, saveSharepointConnection, testSelectedSiteConnection } from "../services/conversionPipeline.js";

export const integrationsRouter = router({
  // =========================================================================
  // Webhook endpoints
  // =========================================================================

  webhookEndpoints: staffProcedure.query(async () => {
    return db
      .select({
        id: webhookEndpoints.id,
        name: webhookEndpoints.name,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
        enabled: webhookEndpoints.enabled,
        createdAt: webhookEndpoints.createdAt,
      })
      .from(webhookEndpoints)
      .orderBy(desc(webhookEndpoints.createdAt));
  }),

  upsertWebhookEndpoint: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        name: z.string().min(1).max(120),
        url: z.string().url().max(500),
        events: z.array(z.string()).default(["*"]),
        secret: z.string().max(256).optional(),
        enabled: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const secretEnc = input.secret
        ? encryptField(input.secret, `webhook:${input.id ?? "new"}`)
        : null;

      if (input.id) {
        const updateData: Record<string, unknown> = {
          name: input.name,
          url: input.url,
          events: input.events,
          enabled: input.enabled,
        };
        if (input.secret !== undefined) {
          updateData.secretEnc = secretEnc;
        }
        await db
          .update(webhookEndpoints)
          .set(updateData)
          .where(eq(webhookEndpoints.id, input.id));

        // Re-encrypt the secret with the correct row id as AAD if it was just set.
        if (input.secret) {
          await db
            .update(webhookEndpoints)
            .set({ secretEnc: encryptField(input.secret, `webhook:${input.id}`) })
            .where(eq(webhookEndpoints.id, input.id));
        }

        return { id: input.id };
      } else {
        const result = await db.insert(webhookEndpoints).values({
          name: input.name,
          url: input.url,
          events: input.events,
          secretEnc: null, // set after insert with correct AAD
          enabled: input.enabled,
        });
        const newId = (result[0] as any).insertId as number;

        if (input.secret) {
          await db
            .update(webhookEndpoints)
            .set({ secretEnc: encryptField(input.secret, `webhook:${newId}`) })
            .where(eq(webhookEndpoints.id, newId));
        }

        return { id: newId };
      }
    }),

  deleteWebhookEndpoint: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db
        .delete(webhookEndpoints)
        .where(eq(webhookEndpoints.id, input.id));
    }),

  /** Purpose-built configuration for the P101 and P201 phase-start webhooks. */
  phaseStartWebhookConfigs: staffProcedure.query(async () => {
    const endpoints = await db.select({
      id: webhookEndpoints.id,
      name: webhookEndpoints.name,
      url: webhookEndpoints.url,
      events: webhookEndpoints.events,
      enabled: webhookEndpoints.enabled,
      createdAt: webhookEndpoints.createdAt,
    }).from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt));
    return (["P101", "P201"] as const).map((eventType) => {
      const endpoint = endpoints.find((candidate) => Array.isArray(candidate.events) && candidate.events.includes(eventType));
      return { eventType, endpoint: endpoint ?? null };
    });
  }),

  savePhaseStartWebhookConfig: adminProcedure
    .input(z.object({
      eventType: z.enum(["P101", "P201"]),
      url: z.string().trim().url().max(500).refine((value) => new URL(value).protocol === "https:", "Webhook URLs must use HTTPS."),
      secret: z.string().max(256).optional(),
      enabled: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const existing = (await db.select().from(webhookEndpoints).orderBy(desc(webhookEndpoints.createdAt)))
        .find((candidate) => Array.isArray(candidate.events) && candidate.events.includes(input.eventType));
      const name = input.eventType === "P101" ? "Phase I Start — P101" : "Phase II Start — P201";
      if (existing) {
        const patch: Record<string, unknown> = { name, url: input.url, events: [input.eventType], enabled: input.enabled };
        if (input.secret) patch.secretEnc = encryptField(input.secret, `webhook:${existing.id}`);
        await db.update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, existing.id));
        await recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "webhook.phase_endpoint_saved", entityType: "webhook_endpoint", entityId: existing.id, summary: `${input.eventType} webhook endpoint updated` });
        return { id: existing.id };
      }
      const insert = await db.insert(webhookEndpoints).values({ name, url: input.url, events: [input.eventType], enabled: input.enabled, secretEnc: null });
      const id = (insert[0] as { insertId: number }).insertId;
      if (input.secret) await db.update(webhookEndpoints).set({ secretEnc: encryptField(input.secret, `webhook:${id}`) }).where(eq(webhookEndpoints.id, id));
      await recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "webhook.phase_endpoint_saved", entityType: "webhook_endpoint", entityId: id, summary: `${input.eventType} webhook endpoint configured` });
      return { id };
    }),

  webhookDeliveries: staffProcedure
    .input(
      z.object({
        endpointId: z.number().int().positive().optional(),
        orderId: z.number().int().positive().optional(),
        status: z.string().optional(),
        page: z.number().int().min(1).default(1),
      })
    )
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const conditions = [];
      if (input.endpointId) conditions.push(eq(webhookDeliveries.endpointId, input.endpointId));
      if (input.orderId) conditions.push(eq(webhookDeliveries.orderId, input.orderId));
      if (input.status) conditions.push(eq(webhookDeliveries.status, input.status));

      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(50)
        .offset(offset);

      const countResult = await db
        .select({ total: sql<number>`count(*)` })
        .from(webhookDeliveries)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return { rows, total: Number(countResult[0]?.total ?? 0) };
    }),

  retryWebhookDelivery: adminProcedure
    .input(z.object({ deliveryId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, input.deliveryId)).limit(1);
      const delivery = rows[0];
      if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Webhook delivery not found." });
      if (!(["pending", "failed", "stopped"] as const).includes(delivery.status as "pending" | "failed" | "stopped")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only pending, failed, or stopped deliveries can be retried." });
      }
      await db.update(webhookDeliveries).set({
        status: "pending",
        runAfter: new Date(),
        attempts: delivery.status === "failed" ? 0 : delivery.attempts,
        lastError: null,
        responseCode: null,
        responseDetail: null,
      }).where(eq(webhookDeliveries.id, delivery.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "webhook.retry_requested", entityType: "webhook_delivery", entityId: delivery.id, summary: `Webhook delivery ${delivery.id} queued for retry`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  /** Stop a queued webhook before the scheduler makes its next delivery attempt. */
  stopWebhookDelivery: adminProcedure
    .input(z.object({ deliveryId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, input.deliveryId)).limit(1);
      const delivery = rows[0];
      if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Webhook delivery not found." });
      if (delivery.status !== "pending") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only pending deliveries can be stopped." });
      await db.update(webhookDeliveries).set({ status: "stopped", lastError: "Stopped by administrator" }).where(eq(webhookDeliveries.id, delivery.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "webhook.stopped", entityType: "webhook_delivery", entityId: delivery.id, severity: "warning", summary: `Stopped pending webhook delivery ${delivery.id}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  /** Create a fresh delivery row while retaining the original delivery history. */
  redeliverWebhook: adminProcedure
    .input(z.object({ deliveryId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, input.deliveryId)).limit(1);
      const delivery = rows[0];
      if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Webhook delivery not found." });
      if (delivery.status === "pending") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This delivery is already pending. Retry it or stop it before creating a separate redelivery." });
      }
      const insert = await db.insert(webhookDeliveries).values({
        endpointId: delivery.endpointId,
        orderId: delivery.orderId,
        orderNumber: delivery.orderNumber,
        customerName: delivery.customerName,
        eventType: delivery.eventType,
        payload: delivery.payload,
        status: "pending",
        attempts: 0,
        runAfter: new Date(),
      });
      const id = (insert[0] as { insertId: number }).insertId;
      await recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "webhook.redelivered", entityType: "webhook_delivery", entityId: id, summary: `Redelivery created from webhook delivery ${delivery.id}` });
      return { id };
    }),

  // =========================================================================
  // Phase kickoff configuration
  // =========================================================================

  phaseKickoffConfigs: staffProcedure.query(async () => {
    return db
      .select()
      .from(phaseKickoffConfigs)
      .orderBy(phaseKickoffConfigs.phase);
  }),

  /**
   * Returns the effective phase-relative folder structure without exposing Graph
   * credentials or allowing a client to infer a specific customer/order path.
   */
  phaseKickoffFolderTemplates: adminProcedure.query(async () => {
    const configured = await db
      .select({ phase: phaseKickoffConfigs.phase, folderTemplate: phaseKickoffConfigs.folderTemplate })
      .from(phaseKickoffConfigs);
    const byPhase = new Map(configured.map((row) => [row.phase, row.folderTemplate]));
    return Object.entries(DEFAULT_FOLDER_TEMPLATES).map(([phase, defaultTemplate]) => {
      const configuredTemplate = byPhase.get(phase);
      let folderTemplate = defaultTemplate;
      let source: "default" | "custom" | "invalid" = "default";
      if (Array.isArray(configuredTemplate)) {
        try {
          folderTemplate = normalizeSharePointFolderTemplate(configuredTemplate.map(String));
          source = "custom";
        } catch {
          source = "invalid";
        }
      }
      return { phase, folderTemplate, source };
    });
  }),

  upsertPhaseKickoffConfig: adminProcedure
    .input(
      z.object({
        phase: z.string().min(1).max(32),
        createFolders: z.boolean(),
        folderTemplate: z.array(z.string()).optional().nullable(),
        attachPlaceholders: z.boolean(),
        notifyCustomer: z.boolean(),
        notifyWebhooks: z.boolean(),
        emailTemplateKey: z.string().max(64).optional().nullable(),
        completionPercent: z.number().int().min(0).max(100).default(0),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Preserve auxiliary configuration when a simple toggle is saved by an older
      // or partial administrator form. This prevents unrelated settings from being
      // silently cleared during a checkbox update.
      const [existing] = await db
        .select({ id: phaseKickoffConfigs.id, folderTemplate: phaseKickoffConfigs.folderTemplate, emailTemplateKey: phaseKickoffConfigs.emailTemplateKey })
        .from(phaseKickoffConfigs)
        .where(eq(phaseKickoffConfigs.phase, input.phase))
        .limit(1);
      let folderTemplate: string[] | null;
      try {
        folderTemplate = input.folderTemplate === undefined
          ? (existing?.folderTemplate as string[] | null | undefined) ?? null
          : input.folderTemplate === null
            ? null
            : normalizeSharePointFolderTemplate(input.folderTemplate);
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "The SharePoint folder template is invalid.",
        });
      }
      const data = {
        createFolders: input.createFolders,
        folderTemplate,
        attachPlaceholders: input.attachPlaceholders,
        notifyCustomer: input.notifyCustomer,
        notifyWebhooks: input.notifyWebhooks,
        emailTemplateKey: input.emailTemplateKey === undefined ? existing?.emailTemplateKey ?? null : input.emailTemplateKey,
        completionPercent: input.completionPercent,
        enabled: input.enabled,
      };

      let id = existing?.id;
      if (existing) {
        await db.update(phaseKickoffConfigs).set(data).where(eq(phaseKickoffConfigs.id, existing.id));
      } else {
        const result = await db.insert(phaseKickoffConfigs).values({ ...data, phase: input.phase });
        id = Number((result as unknown as { insertId?: number }).insertId ?? 0) || undefined;
      }
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "integration.phase_kickoff_updated", entityType: "phase_kickoff_config", entityId: id, summary: `Administrator updated Phase Kickoff configuration for ${input.phase}`, changes: { createFolders: data.createFolders, folderTemplateCount: data.folderTemplate?.length ?? 0, attachPlaceholders: data.attachPlaceholders, notifyCustomer: data.notifyCustomer, notifyWebhooks: data.notifyWebhooks, completionPercent: data.completionPercent, enabled: data.enabled }, ipAddress: ctx.clientIp });
      return { ok: true as const, id: id ?? null };
    }),

  manualPhaseKickoff: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        phase: z.enum(["phase_1_intake", "phase_2_synthesis", "in_production", "delivered"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orderRows = await db
        .select({ id: orders.id, orderNumber: orders.orderNumber })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);
      if (!orderRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });

      const forceWebhook = input.phase === "phase_1_intake" || input.phase === "phase_2_synthesis";
      await runPhaseKickoff(input.orderId, input.phase as any, { forceWebhook });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.phase_kickoff_manual",
        summary: `Manually kicked off ${input.phase} for order ${orderRows[0].orderNumber}${forceWebhook ? " and queued its phase-start webhook" : ""}`,
      });
      return { ok: true, webhookQueued: forceWebhook };
    }),

  // =========================================================================
  // Phase jobs (monitoring)
  // =========================================================================

  phaseJobs: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive().optional(),
        status: z.string().optional(),
        page: z.number().int().min(1).default(1),
      })
    )
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const conditions = [];
      if (input.orderId) conditions.push(eq(phaseJobs.orderId, input.orderId));
      if (input.status) conditions.push(eq(phaseJobs.status, input.status));

      const rows = await db
        .select()
        .from(phaseJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(phaseJobs.createdAt))
        .limit(50)
        .offset(offset);

      const countResult = await db
        .select({ total: sql<number>`count(*)` })
        .from(phaseJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return { rows, total: Number(countResult[0]?.total ?? 0) };
    }),

  retryPhaseJob: adminProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db
        .update(phaseJobs)
        .set({ status: "pending", runAfter: new Date(), lastError: null })
        .where(eq(phaseJobs.id, input.jobId));
    }),

  // =========================================================================
  // SharePoint file synchronization log and controlled retry
  // =========================================================================

  sharepointSyncLogs: staffProcedure
    .input(z.object({
      orderId: z.number().int().positive().optional(),
      status: z.enum(["pending", "running", "succeeded", "failed"]).optional(),
      search: z.string().trim().max(120).optional(),
      page: z.number().int().min(1).default(1),
    }))
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const conditions = [eq(sharepointSyncLog.operationType, "file_sync")];
      if (input.orderId) conditions.push(eq(sharepointSyncLog.orderId, input.orderId));
      if (input.status) conditions.push(eq(sharepointSyncLog.status, input.status));
      if (input.search) {
        const escaped = input.search.replace(/[\\%_]/g, "\\$&");
        const pattern = `%${escaped}%`;
        conditions.push(or(
          like(orders.orderNumber, pattern),
          like(files.originalName, pattern),
          like(sharepointSyncLog.sharepointPath, pattern),
        )!);
      }

      const where = and(...conditions);
      const rows = await db
        .select({
          id: sharepointSyncLog.id,
          orderId: sharepointSyncLog.orderId,
          orderNumber: orders.orderNumber,
          fileId: sharepointSyncLog.fileId,
          fileName: files.originalName,
          detectedMime: files.detectedMime,
          extension: files.extension,
          phase: files.phase,
          status: sharepointSyncLog.status,
          attempts: sharepointSyncLog.attempts,
          sharepointPath: sharepointSyncLog.sharepointPath,
          errorMessage: sharepointSyncLog.errorMessage,
          createdAt: sharepointSyncLog.createdAt,
          updatedAt: sharepointSyncLog.updatedAt,
        })
        .from(sharepointSyncLog)
        .leftJoin(orders, eq(orders.id, sharepointSyncLog.orderId))
        .leftJoin(files, eq(files.id, sharepointSyncLog.fileId))
        .where(where)
        .orderBy(desc(sharepointSyncLog.updatedAt))
        .limit(50)
        .offset(offset);

      const totals = await db
        .select({ total: sql<number>`count(*)` })
        .from(sharepointSyncLog)
        .leftJoin(orders, eq(orders.id, sharepointSyncLog.orderId))
        .leftJoin(files, eq(files.id, sharepointSyncLog.fileId))
        .where(where);

      return { rows, total: Number(totals[0]?.total ?? 0) };
    }),

  retrySharepointSync: adminProcedure
    .input(z.object({ logId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db
        .select({
          id: sharepointSyncLog.id,
          orderId: sharepointSyncLog.orderId,
          fileId: sharepointSyncLog.fileId,
          status: sharepointSyncLog.status,
          orderNumber: orders.orderNumber,
          fileDeletedAt: files.deletedAt,
        })
        .from(sharepointSyncLog)
        .leftJoin(orders, eq(orders.id, sharepointSyncLog.orderId))
        .leftJoin(files, eq(files.id, sharepointSyncLog.fileId))
        .where(and(eq(sharepointSyncLog.id, input.logId), eq(sharepointSyncLog.operationType, "file_sync")))
        .limit(1);
      const log = rows[0];
      if (!log) throw new TRPCError({ code: "NOT_FOUND", message: "SharePoint sync record not found." });
      if (!log.fileId || !log.orderId || !log.orderNumber || log.fileDeletedAt) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The source order file is no longer available for requeue." });
      }
      if (log.status !== "failed") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only failed file transfers can be requeued. A pending or running transfer is already being processed." });
      }
      await db.update(sharepointSyncLog)
        .set({ status: "pending", attempts: 0, errorMessage: null })
        .where(and(eq(sharepointSyncLog.id, log.id), eq(sharepointSyncLog.status, "failed")));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "sharepoint.file_sync_requeued",
        entityType: "sharepoint_sync_log",
        entityId: log.id,
        summary: `SharePoint file synchronization requeued for order ${log.orderNumber}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  // =========================================================================
  // SharePoint / Graph configuration status
  // =========================================================================

  graphConfig: adminProcedure.query(async () => {
    const tenantId = (await getSetting("sharepoint.tenant_id")) || env.graph.tenantId || null;
    const clientId = (await getSetting("sharepoint.client_id")) || env.graph.clientId || null;
    const siteId = (await getSetting("sharepoint.site_id")) || env.graph.siteId || null;
    const driveId = (await getSetting("sharepoint.drive_id")) || env.graph.driveId || null;
    const siteUrl = await getSetting("sharepoint.site_url");
    const configuredRootFolderPath = (await getSetting("sharepoint.root_folder_path")) || env.graph.rootFolderPath;
    const rootFolderPath = normalizeSharePointRootFolderPath(configuredRootFolderPath);
    const hasSecret = Boolean((await getSetting("sharepoint.client_secret_enc")) || env.graph.clientSecret);
    const audioFallbackMode = (await getSetting("sharepoint.audio_fallback_mode")) === "none" ? "none" : "mp3";
    const delegatedSync = await getDelegatedSharePointStatus();
    const tenantIdValid = Boolean(tenantId && (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(tenantId) || /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(tenantId)));
    const clientIdValid = Boolean(clientId && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(clientId));
    return {
      enabled: Boolean(tenantIdValid && clientIdValid && hasSecret && siteId && driveId),
      tenantId: tenantId ? `...${tenantId.slice(-8)}` : null,
      clientId: clientId ? `...${clientId.slice(-8)}` : null,
      tenantIdValid,
      clientIdValid,
      siteId,
      driveId,
      siteUrl,
      rootFolderPath,
      hasSecret,
      audioFallbackMode,
      delegatedSync,
    };
  }),

  startDelegatedGraphAudioSync: adminProcedure.mutation(async ({ ctx }) => {
    try {
      const result = await startDelegatedSharePointAuthorization({ initiatedByUserId: ctx.session.user.id, requestIp: ctx.clientIp });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.delegated_sync_authorization_started", entityType: "sharepoint", entityId: 0, summary: "Started Microsoft 365 delegated SharePoint sync authorization", ipAddress: ctx.clientIp });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Could not start Microsoft 365 sync authorization.";
      throw new TRPCError({ code: "PRECONDITION_FAILED", message });
    }
  }),

  disconnectDelegatedGraphAudioSync: adminProcedure
    .input(z.object({ typedConfirmation: z.literal("DISCONNECT SYNC") }))
    .mutation(async ({ ctx }) => {
      await disconnectDelegatedSharePointIdentity(ctx.session.user.id);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.delegated_sync_disconnected", entityType: "sharepoint", entityId: 0, severity: "warning", summary: "Disconnected the delegated Microsoft 365 SharePoint sync identity", ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  discoverGraphConfig: adminProcedure
    .input(z.object({
      tenantId: z.string().trim().min(3).max(128).refine((value) => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value) || /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value), "Enter the Microsoft Entra tenant ID GUID or verified tenant domain.").optional(),
      clientId: z.string().trim().uuid("Enter the 36-character Application (client) ID from the Microsoft Entra app registration.").optional(),
      clientSecret: z.string().max(512).optional(),
      siteUrl: z.string().trim().url().max(1024),
    }))
    .mutation(async ({ ctx, input }) => {
      const storedTenantId = (await getSetting("sharepoint.tenant_id")) || env.graph.tenantId || null;
      const storedClientId = (await getSetting("sharepoint.client_id")) || env.graph.clientId || null;
      const tenantId = input.tenantId || storedTenantId;
      const clientId = input.clientId || storedClientId;
      const storedSecret = await getSetting("sharepoint.client_secret_enc");
      const clientSecret = input.clientSecret || (storedSecret ? decryptField(storedSecret, "sharepoint.client_secret") : null);
      if (!tenantId || !clientId || !clientSecret) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Enter the complete tenant ID, application client ID, and client secret before discovery." });
      try {
        const result = await discoverSharePointConfig({ tenantId, clientId, clientSecret, siteUrl: input.siteUrl });
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.discovery_succeeded", entityType: "sharepoint", entityId: 0, summary: `Discovered SharePoint site ${result.siteName} and ${result.drives.length} document library/libraries`, ipAddress: ctx.clientIp });
        return result;
      } catch (error) {
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.discovery_failed", entityType: "sharepoint", entityId: 0, severity: "warning", summary: "SharePoint discovery failed", ipAddress: ctx.clientIp });
        const message = error instanceof Error ? error.message.slice(0, 500) : "SharePoint discovery failed.";
        throw new TRPCError({ code: "PRECONDITION_FAILED", message });
      }
    }),

  browseGraphFolders: adminProcedure
    .input(z.object({ path: z.string().trim().max(240).optional() }))
    .query(async ({ ctx, input }) => {
      try {
        const result = await browseSharePointFolders(input.path ?? "");
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.root_folder_browsed", entityType: "sharepoint", entityId: 0, summary: `Browsed SharePoint folder ${result.currentPath || "/"}`, ipAddress: ctx.clientIp });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "Could not browse SharePoint folders.";
        throw new TRPCError({ code: "PRECONDITION_FAILED", message });
      }
    }),

  testGraphConnection: adminProcedure.mutation(async ({ ctx }) => {
    try {
      const result = await testSharePointConnection();
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.connection_test_succeeded", entityType: "sharepoint", entityId: 0, summary: `SharePoint connection test succeeded for ${result.siteName} / ${result.driveName}`, ipAddress: ctx.clientIp });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "SharePoint connection test failed.";
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.connection_test_failed", entityType: "sharepoint", entityId: 0, severity: "warning", summary: "SharePoint connection test failed", ipAddress: ctx.clientIp });
      throw new TRPCError({ code: "PRECONDITION_FAILED", message });
    }
  }),

  saveGraphConfig: adminProcedure
    .input(z.object({
      tenantId: z.string().trim().min(3).max(128).refine((value) => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value) || /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value), "Enter the Microsoft Entra tenant ID GUID or verified tenant domain.").optional(),
      clientId: z.string().trim().uuid("Enter the 36-character Application (client) ID from the Microsoft Entra app registration.").optional(),
      clientSecret: z.string().max(512).optional(),
      siteId: z.string().trim().min(1).max(512),
      driveId: z.string().trim().min(1).max(512),
      siteUrl: z.string().trim().url().max(1024).optional().or(z.literal("")),
      rootFolderPath: z.string().trim().min(1).max(512),
      audioFallbackMode: z.enum(["none", "mp3"]).default("mp3"),
    }))
    .mutation(async ({ ctx, input }) => {
      const storedTenantId = (await getSetting("sharepoint.tenant_id")) || env.graph.tenantId || null;
      const storedClientId = (await getSetting("sharepoint.client_id")) || env.graph.clientId || null;
      const tenantId = input.tenantId || storedTenantId;
      const clientId = input.clientId || storedClientId;
      if (!tenantId || !clientId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Enter the complete Microsoft Entra tenant ID and application client ID before saving." });
      const normalizedRootFolderPath = normalizeSharePointRootFolderPath(input.rootFolderPath);
      if (input.tenantId) await setSetting("sharepoint.tenant_id", tenantId, { category: "sharepoint", userId: ctx.session.user.id });
      if (input.clientId) await setSetting("sharepoint.client_id", clientId, { category: "sharepoint", userId: ctx.session.user.id });
      await setSetting("sharepoint.site_id", input.siteId, { category: "sharepoint", userId: ctx.session.user.id });
      await setSetting("sharepoint.drive_id", input.driveId, { category: "sharepoint", userId: ctx.session.user.id });
      await setSetting("sharepoint.site_url", input.siteUrl || null, { category: "sharepoint", userId: ctx.session.user.id });
      await setSetting("sharepoint.root_folder_path", normalizedRootFolderPath, { category: "sharepoint", userId: ctx.session.user.id });
      await setSetting("sharepoint.audio_fallback_mode", input.audioFallbackMode, { category: "sharepoint", userId: ctx.session.user.id });
      if (input.clientSecret) {
        await setSetting(
          "sharepoint.client_secret_enc",
          encryptField(input.clientSecret, "sharepoint.client_secret"),
          { category: "sharepoint", isSecret: true, userId: ctx.session.user.id },
        );
      }
      resetGraphTokenCache();
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "sharepoint.audio_fallback_saved",
        entityType: "sharepoint",
        entityId: 0,
        summary: `SharePoint audio fallback set to ${input.audioFallbackMode === "mp3" ? "MP3 transfer copy" : "original WebM only"}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true };
    }),

  // =========================================================================
  // Append-only conversion and selected-site SharePoint pipeline
  // =========================================================================

  conversionProfiles: adminProcedure.query(async () => {
    const rows = await db.select({
      id: conversionProfiles.id,
      name: conversionProfiles.name,
      operation: conversionProfiles.operation,
      settingsJson: conversionProfiles.settingsJson,
      revision: conversionProfiles.revision,
      toolFingerprint: conversionProfiles.toolFingerprint,
      active: conversionProfiles.active,
      createdAt: conversionProfiles.createdAt,
      updatedAt: conversionProfiles.updatedAt,
    }).from(conversionProfiles).orderBy(conversionProfiles.name);
    return rows.map((row) => ({ ...row, operationLabel: conversionProfileLabel(row.operation as (typeof CONVERSION_OPERATIONS)[number]) }));
  }),

  upsertConversionProfile: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(2).max(120),
      operation: z.enum(CONVERSION_OPERATIONS),
      audioBitrateKbps: z.number().int().min(32).max(128).optional(),
      active: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const settingsJson = input.operation === "audio_to_webm" ? { bitrateKbps: input.audioBitrateKbps ?? 64 } : {};
      let id = input.id;
      if (id) {
        const [existing] = await db.select({ id: conversionProfiles.id, revision: conversionProfiles.revision }).from(conversionProfiles).where(eq(conversionProfiles.id, id)).limit(1);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Conversion profile not found." });
        await db.update(conversionProfiles).set({ name: input.name, operation: input.operation, settingsJson, active: input.active, revision: existing.revision + 1, toolFingerprint: NATIVE_CONVERTER_FINGERPRINT }).where(eq(conversionProfiles.id, id));
      } else {
        const result = await db.insert(conversionProfiles).values({ name: input.name, operation: input.operation, settingsJson, active: input.active, revision: 1, toolFingerprint: NATIVE_CONVERTER_FINGERPRINT, createdByUserId: ctx.session.user.id });
        id = Number((result as unknown as { insertId?: number }).insertId ?? 0);
      }
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "conversion.profile_saved", entityType: "conversion_profile", entityId: id ?? 0, summary: `Saved ${conversionProfileLabel(input.operation)} conversion profile ${input.name}.`, changes: { operation: input.operation, active: input.active }, ipAddress: ctx.clientIp });
      return { id };
    }),

  selectedSiteConnections: adminProcedure.query(async () => {
    return db.select({
      id: sharepointConnections.id,
      name: sharepointConnections.name,
      tenantId: sharepointConnections.tenantId,
      clientId: sharepointConnections.clientId,
      tenantIdSuffix: sql<string>`CONCAT('…', RIGHT(${sharepointConnections.tenantId}, 8))`,
      clientIdSuffix: sql<string>`CONCAT('…', RIGHT(${sharepointConnections.clientId}, 8))`,
      siteId: sharepointConnections.siteId,
      driveId: sharepointConnections.driveId,
      siteUrl: sharepointConnections.siteUrl,
      rootFolderPath: sharepointConnections.rootFolderPath,
      enabled: sharepointConnections.enabled,
      lastTestedAt: sharepointConnections.lastTestedAt,
      lastTestOk: sharepointConnections.lastTestOk,
      lastError: sharepointConnections.lastError,
      createdAt: sharepointConnections.createdAt,
      updatedAt: sharepointConnections.updatedAt,
    }).from(sharepointConnections).orderBy(sharepointConnections.name);
  }),

  upsertSelectedSiteConnection: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(2).max(120),
      tenantId: z.string().trim().min(3).max(190),
      clientId: z.string().trim().uuid(),
      clientSecret: z.string().min(1).max(512).optional(),
      siteId: z.string().trim().min(1).max(512),
      driveId: z.string().trim().min(1).max(512),
      siteUrl: z.string().trim().url().max(512).optional().or(z.literal("")),
      rootFolderPath: z.string().trim().min(1).max(240),
      enabled: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const normalizedRoot = normalizeSharePointRootFolderPath(input.rootFolderPath);
      try {
        const id = await saveSharepointConnection({ ...input, siteUrl: input.siteUrl || null, rootFolderPath: normalizedRoot, actorUserId: ctx.session.user.id });
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.selected_site_connection_saved", entityType: "sharepoint_connection", entityId: id, summary: `Saved selected-site SharePoint connection ${input.name}.`, changes: { siteId: input.siteId, driveId: input.driveId, rootFolderPath: normalizedRoot, enabled: input.enabled }, ipAddress: ctx.clientIp });
        return { id };
      } catch (error) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message.slice(0, 500) : "Could not save the selected-site connection." });
      }
    }),

  testSelectedSiteConnection: adminProcedure
    .input(z.object({ connectionId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await testSelectedSiteConnection(input.connectionId);
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.selected_site_connection_test_succeeded", entityType: "sharepoint_connection", entityId: input.connectionId, summary: `Selected-site SharePoint connection ${input.connectionId} passed a drive-root test.`, ipAddress: ctx.clientIp });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "Selected-site SharePoint connection test failed.";
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.selected_site_connection_test_failed", entityType: "sharepoint_connection", entityId: input.connectionId, severity: "warning", summary: "Selected-site SharePoint connection test failed.", ipAddress: ctx.clientIp });
        throw new TRPCError({ code: "PRECONDITION_FAILED", message });
      }
    }),

  selectedSiteTargets: adminProcedure.query(async () => {
    return db.select({
      id: sharepointTargetBindings.id,
      name: sharepointTargetBindings.name,
      targetRole: sharepointTargetBindings.targetRole,
      connectionId: sharepointTargetBindings.connectionId,
      connectionName: sharepointConnections.name,
      relativeRootPath: sharepointTargetBindings.relativeRootPath,
      enabled: sharepointTargetBindings.enabled,
      createdAt: sharepointTargetBindings.createdAt,
      updatedAt: sharepointTargetBindings.updatedAt,
    }).from(sharepointTargetBindings).innerJoin(sharepointConnections, eq(sharepointTargetBindings.connectionId, sharepointConnections.id)).orderBy(sharepointTargetBindings.name);
  }),

  upsertSelectedSiteTarget: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(2).max(120),
      targetRole: z.enum(["originals", "conversion_staging", "intake_delivery"]),
      connectionId: z.number().int().positive(),
      relativeRootPath: z.string().trim().max(240).optional().or(z.literal("")),
      enabled: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const [connection] = await db.select({ id: sharepointConnections.id, enabled: sharepointConnections.enabled }).from(sharepointConnections).where(eq(sharepointConnections.id, input.connectionId)).limit(1);
      if (!connection?.enabled) throw new TRPCError({ code: "BAD_REQUEST", message: "Select an enabled selected-site SharePoint connection." });
      let id = input.id;
      const values = { name: input.name, targetRole: input.targetRole, connectionId: input.connectionId, relativeRootPath: input.relativeRootPath || null, enabled: input.enabled };
      if (id) {
        const [existing] = await db.select({ id: sharepointTargetBindings.id }).from(sharepointTargetBindings).where(eq(sharepointTargetBindings.id, id)).limit(1);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "SharePoint target not found." });
        await db.update(sharepointTargetBindings).set(values).where(eq(sharepointTargetBindings.id, id));
      } else {
        const result = await db.insert(sharepointTargetBindings).values({ ...values, createdByUserId: ctx.session.user.id });
        id = Number((result as unknown as { insertId?: number }).insertId ?? 0);
      }
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.selected_site_target_saved", entityType: "sharepoint_target", entityId: id ?? 0, summary: `Saved ${input.targetRole} SharePoint target ${input.name}.`, changes: { connectionId: input.connectionId, enabled: input.enabled }, ipAddress: ctx.clientIp });
      return { id };
    }),

  conversionPipelineActivity: adminProcedure
    .input(z.object({ page: z.number().int().min(1).default(1), status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]).optional() }))
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const condition = input.status ? eq(conversionJobs.status, input.status) : undefined;
      const rows = await db.select({
        id: conversionJobs.id,
        orderId: conversionJobs.orderId,
        sourceFileId: conversionJobs.sourceFileId,
        artifactFileId: conversionJobs.artifactFileId,
        sourceOriginalName: conversionJobs.sourceOriginalName,
        operation: conversionJobs.profileOperation,
        status: conversionJobs.status,
        attempts: conversionJobs.attempts,
        lastError: conversionJobs.lastError,
        completedAt: conversionJobs.completedAt,
        createdAt: conversionJobs.createdAt,
        updatedAt: conversionJobs.updatedAt,
      }).from(conversionJobs).where(condition).orderBy(desc(conversionJobs.updatedAt)).limit(50).offset(offset);
      const totals = await db.select({ total: sql<number>`count(*)` }).from(conversionJobs).where(condition);
      return { rows, total: Number(totals[0]?.total ?? 0) };
    }),

  retryConversionJob: adminProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const [job] = await db.select({ id: conversionJobs.id, status: conversionJobs.status }).from(conversionJobs).where(eq(conversionJobs.id, input.jobId)).limit(1);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Conversion job not found." });
      if (!(job.status === "failed" || job.status === "cancelled")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only failed or cancelled conversions can be requeued." });
      await db.update(conversionJobs).set({ status: "pending", attempts: 0, runAfter: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: null, cancelledAt: null }).where(eq(conversionJobs.id, job.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "conversion.requeued", entityType: "conversion_job", entityId: job.id, summary: `Administrator requeued conversion job ${job.id}.`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  cancelConversionJob: adminProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.update(conversionJobs).set({ status: "cancelled", cancelledAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: "Cancelled by administrator" }).where(and(eq(conversionJobs.id, input.jobId), eq(conversionJobs.status, "pending")));
      if (Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only pending conversions can be cancelled." });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "conversion.cancelled", entityType: "conversion_job", entityId: input.jobId, severity: "warning", summary: `Administrator cancelled pending conversion job ${input.jobId}.`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  selectedSiteTransferActivity: adminProcedure
    .input(z.object({ page: z.number().int().min(1).default(1), status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]).optional() }))
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const condition = input.status ? eq(sharepointTransferJobs.status, input.status) : undefined;
      const rows = await db.select({
        id: sharepointTransferJobs.id,
        orderId: sharepointTransferJobs.orderId,
        sourceFileId: sharepointTransferJobs.sourceFileId,
        artifactFileId: sharepointTransferJobs.artifactFileId,
        operationType: sharepointTransferJobs.operationType,
        targetName: sharepointTargetBindings.name,
        fileName: sharepointTransferJobs.fileNameSnapshot,
        status: sharepointTransferJobs.status,
        attempts: sharepointTransferJobs.attempts,
        lastError: sharepointTransferJobs.lastError,
        remoteItemId: sharepointTransferJobs.remoteItemId,
        completedAt: sharepointTransferJobs.completedAt,
        updatedAt: sharepointTransferJobs.updatedAt,
      }).from(sharepointTransferJobs).innerJoin(sharepointTargetBindings, eq(sharepointTransferJobs.targetBindingId, sharepointTargetBindings.id)).where(condition).orderBy(desc(sharepointTransferJobs.updatedAt)).limit(50).offset(offset);
      const totals = await db.select({ total: sql<number>`count(*)` }).from(sharepointTransferJobs).where(condition);
      return { rows, total: Number(totals[0]?.total ?? 0) };
    }),

  retrySelectedSiteTransfer: adminProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const [job] = await db.select({ id: sharepointTransferJobs.id, status: sharepointTransferJobs.status }).from(sharepointTransferJobs).where(eq(sharepointTransferJobs.id, input.jobId)).limit(1);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Selected-site transfer job not found." });
      if (!(job.status === "failed" || job.status === "cancelled")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only failed or cancelled transfers can be requeued." });
      await db.update(sharepointTransferJobs).set({ status: "pending", attempts: 0, runAfter: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: null, cancelledAt: null }).where(eq(sharepointTransferJobs.id, job.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.selected_site_transfer_requeued", entityType: "sharepoint_transfer", entityId: job.id, summary: `Administrator requeued selected-site SharePoint transfer ${job.id}.`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  cancelSelectedSiteTransfer: adminProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.update(sharepointTransferJobs).set({ status: "cancelled", cancelledAt: new Date(), leaseToken: null, leaseExpiresAt: null, lastError: "Cancelled by administrator" }).where(and(eq(sharepointTransferJobs.id, input.jobId), eq(sharepointTransferJobs.status, "pending")));
      if (Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0) !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only pending transfers can be cancelled." });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "sharepoint.selected_site_transfer_cancelled", entityType: "sharepoint_transfer", entityId: input.jobId, severity: "warning", summary: `Administrator cancelled pending selected-site SharePoint transfer ${input.jobId}.`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  // =========================================================================
  // Test webhook delivery (sends a test ping to an endpoint)
  // =========================================================================

  testWebhookEndpoint: adminProcedure
    .input(z.object({ endpointId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const rows = await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, input.endpointId))
        .limit(1);

      if (rows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Webhook endpoint not found." });
      }

      const endpoint = rows[0]!;
      const payload = {
        event: "test.ping",
        timestamp: new Date().toISOString(),
        message: "This is a test delivery from ReadyPackets Portal.",
      };

      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-ReadyPackets-Event": "test.ping",
      };

      if (endpoint.secretEnc) {
        const secret = decryptField(endpoint.secretEnc, `webhook:${endpoint.id}`);
        if (secret) {
          const { createHmac } = await import("node:crypto");
          const sig = createHmac("sha256", secret).update(body).digest("hex");
          headers["X-ReadyPackets-Signature"] = `sha256=${sig}`;
        }
      }

      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });

        return {
          success: response.ok,
          statusCode: response.status,
          message: response.ok
            ? "Test delivery succeeded."
            : `Endpoint returned HTTP ${response.status}.`,
        };
      } catch (err) {
        return {
          success: false,
          statusCode: null,
          message: err instanceof Error ? err.message : "Request failed.",
        };
      }
    }),
});
