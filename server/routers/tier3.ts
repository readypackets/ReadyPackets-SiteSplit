/**
 * Tier 3 combined router — AI hub, inbound webhooks, outbound connections,
 * scheduling/availability, portal wizard slides, A/B testing, admin preferences,
 * support permissions, feature toggle scheduling, system backups, billing events,
 * subscription plans, and API access logs.
 */
import { TRPCError } from "@trpc/server";
import net from "node:net";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, asc, count, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  aiMessages,
  aiResponseLogs,
  aiSessions,
  adminNavPreferences,
  apiActionLogs,
  apiKeyRateLimits,
  apiRequestLogs,
  availabilitySlots,
  billingEvents,
  featureToggleSchedules,
  inboundWebhookEvents,
  inboundWebhookListeners,
  meetingBookings,
  outboundCallLogs,
  outboundConnections,
  pinnedQuickAdd,
  portalWizardSlides,
  portalAnnouncements,
  portalAnnouncementRecipients,
  pwaAbEvents,
  pwaAbVariants,
  subscriptionItems,
  subscriptionPlans,
  supportPermissions,
  systemBackups,
} from "../db/schema.js";
import { encryptField, decryptField } from "../security/crypto.js";
import { adminProcedure, staffProcedure, protectedProcedure, router } from "../trpc/trpc.js";
import { recordActivity } from "../observability/audit.js";
import { setFeatureFlag } from "../services/settings.js";
import { configureGitHubVault, getGitHubVaultStatus, publishGitHubVaultBackup, testGitHubVault } from "../services/githubConfigVault.js";

// ── Subscription plans ────────────────────────────────────────────────────────
const subscriptionRouter = router({
  listPlans: staffProcedure.query(async () =>
    db.select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.priceCents)),
  ),
  createPlan: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(128),
      slug: z.string().trim().min(1).max(64),
      description: z.string().trim().max(2000).optional(),
      priceCents: z.number().int().min(0),
      intervalDays: z.number().int().min(1).default(30),
      features: z.array(z.string()).optional(),
    }))
    .mutation(async ({ input }) => {
      const [r] = await db.insert(subscriptionPlans).values({
        name: input.name, slug: input.slug,
        description: input.description ?? null,
        priceCents: input.priceCents,
        intervalDays: input.intervalDays,
        features: input.features ? JSON.stringify(input.features) : null,
      });
      return { id: (r as { insertId: number }).insertId };
    }),
  togglePlan: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.update(subscriptionPlans).set({ isActive: input.isActive }).where(eq(subscriptionPlans.id, input.id));
      return { ok: true as const };
    }),
  listBillingEvents: staffProcedure
    .input(z.object({ userId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ input }) => {
      const conditions = input.userId ? [eq(billingEvents.userId, input.userId)] : [];
      return db.select().from(billingEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(billingEvents.createdAt))
        .limit(input.limit);
    }),
});

// ── AI hub ────────────────────────────────────────────────────────────────────
const aiHubRouter = router({
  listSessions: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) =>
      db.select().from(aiSessions).orderBy(desc(aiSessions.createdAt)).limit(input.limit),
    ),
  getSession: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const [session] = await db.select().from(aiSessions).where(eq(aiSessions.id, input.id));
      if (!session) throw new TRPCError({ code: "NOT_FOUND" });
      const messages = await db.select().from(aiMessages)
        .where(eq(aiMessages.sessionId, input.id))
        .orderBy(asc(aiMessages.createdAt));
      const logs = await db.select().from(aiResponseLogs)
        .where(eq(aiResponseLogs.sessionId, input.id))
        .orderBy(desc(aiResponseLogs.createdAt))
        .limit(50);
      return { session, messages, logs };
    }),
  archiveSession: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.update(aiSessions).set({ status: "archived" }).where(eq(aiSessions.id, input.id));
      return { ok: true as const };
    }),
  responseLogs: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ input }) =>
      db.select().from(aiResponseLogs).orderBy(desc(aiResponseLogs.createdAt)).limit(input.limit),
    ),
});

// ── Inbound webhooks ──────────────────────────────────────────────────────────
const inboundWebhookRouter = router({
  listListeners: adminProcedure.query(async () =>
    db.select().from(inboundWebhookListeners).orderBy(asc(inboundWebhookListeners.name)),
  ),
  createListener: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(128),
      slug: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/),
      eventType: z.string().trim().max(128).optional(),
      handler: z.string().trim().max(128).default("log"),
    }))
    .mutation(async ({ ctx, input }) => {
      const [r] = await db.insert(inboundWebhookListeners).values({
        name: input.name, slug: input.slug,
        eventType: input.eventType ?? null,
        handler: input.handler,
        createdByUserId: ctx.session.user.id,
      });
      return { id: (r as { insertId: number }).insertId };
    }),
  toggleListener: adminProcedure
    .input(z.object({ id: z.number().int().positive(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.update(inboundWebhookListeners).set({ enabled: input.enabled }).where(eq(inboundWebhookListeners.id, input.id));
      return { ok: true as const };
    }),
  deleteListener: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(inboundWebhookListeners).where(eq(inboundWebhookListeners.id, input.id));
      return { ok: true as const };
    }),
  listEvents: adminProcedure
    .input(z.object({
      listenerId: z.number().int().positive().optional(),
      processed: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input }) => {
      const conditions = [];
      if (input.listenerId) conditions.push(eq(inboundWebhookEvents.listenerId, input.listenerId));
      if (input.processed !== undefined) conditions.push(eq(inboundWebhookEvents.processed, input.processed));
      return db.select().from(inboundWebhookEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(inboundWebhookEvents.createdAt))
        .limit(input.limit);
    }),
});

// ── Outbound connections ──────────────────────────────────────────────────────
const outboundRouter = router({
  listConnections: adminProcedure.query(async () =>
    db.select({
      id: outboundConnections.id,
      name: outboundConnections.name,
      connectionType: outboundConnections.connectionType,
      baseUrl: outboundConnections.baseUrl,
      authType: outboundConnections.authType,
      enabled: outboundConnections.enabled,
      lastTestedAt: outboundConnections.lastTestedAt,
      lastTestOk: outboundConnections.lastTestOk,
      createdAt: outboundConnections.createdAt,
    }).from(outboundConnections).orderBy(asc(outboundConnections.name)),
  ),
  createConnection: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(128),
      connectionType: z.string().trim().max(64).default("http"),
      baseUrl: z.string().url().max(512).optional(),
      authType: z.enum(["none", "api_key", "bearer", "basic", "oauth2"]).default("none"),
      credentials: z.string().max(4000).optional(),
      timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    }))
    .mutation(async ({ input }) => {
      const credentialsEnc = input.credentials
        ? encryptField(input.credentials, "outbound_connections:credentials")
        : null;
      const [r] = await db.insert(outboundConnections).values({
        name: input.name,
        connectionType: input.connectionType,
        baseUrl: input.baseUrl ?? null,
        authType: input.authType,
        credentialsEnc,
        timeoutMs: input.timeoutMs,
      });
      return { id: (r as { insertId: number }).insertId };
    }),
  toggleConnection: adminProcedure
    .input(z.object({ id: z.number().int().positive(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await db.update(outboundConnections).set({ enabled: input.enabled }).where(eq(outboundConnections.id, input.id));
      return { ok: true as const };
    }),
  deleteConnection: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(outboundConnections).where(eq(outboundConnections.id, input.id));
      return { ok: true as const };
    }),
  callLogs: adminProcedure
    .input(z.object({ connectionId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ input }) => {
      const conditions = input.connectionId ? [eq(outboundCallLogs.connectionId, input.connectionId)] : [];
      return db.select().from(outboundCallLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(outboundCallLogs.createdAt))
        .limit(input.limit);
    }),
});

// ── Scheduling / availability ─────────────────────────────────────────────────
const schedulingRouter = router({
  listSlots: staffProcedure
    .input(z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      ownerUserId: z.number().int().positive().optional(),
    }).optional())
    .query(async ({ input }) => {
      const conditions = [];
      if (input?.from) conditions.push(gte(availabilitySlots.startsAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(availabilitySlots.endsAt, new Date(input.to)));
      if (input?.ownerUserId) conditions.push(eq(availabilitySlots.ownerUserId, input.ownerUserId));
      return db.select().from(availabilitySlots)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(availabilitySlots.startsAt));
    }),
  createSlot: staffProcedure
    .input(z.object({
      slotType: z.string().trim().max(64).default("consultation"),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      durationMinutes: z.number().int().min(5).max(480).default(30),
      maxBookings: z.number().int().min(1).max(100).default(1),
      notes: z.string().trim().max(1000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [r] = await db.insert(availabilitySlots).values({
        ownerUserId: ctx.session.user.id,
        slotType: input.slotType,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        durationMinutes: input.durationMinutes,
        maxBookings: input.maxBookings,
        notes: input.notes ?? null,
      });
      return { id: (r as { insertId: number }).insertId };
    }),
  deleteSlot: staffProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(availabilitySlots).where(eq(availabilitySlots.id, input.id));
      return { ok: true as const };
    }),
  listBookings: staffProcedure
    .input(z.object({ slotId: z.number().int().positive().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      const conditions = [];
      if (input.slotId) conditions.push(eq(meetingBookings.slotId, input.slotId));
      if (input.status) conditions.push(eq(meetingBookings.status, input.status as "pending" | "confirmed" | "cancelled" | "completed" | "no_show"));
      return db.select().from(meetingBookings)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(meetingBookings.createdAt))
        .limit(input.limit);
    }),
  updateBookingStatus: staffProcedure
    .input(z.object({
      id: z.number().int().positive(),
      status: z.enum(["pending", "confirmed", "cancelled", "completed", "no_show"]),
      cancelReason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ input }) => {
      const patch: Record<string, unknown> = { status: input.status };
      if (input.status === "confirmed") patch.confirmedAt = new Date();
      if (input.status === "cancelled") { patch.cancelledAt = new Date(); patch.cancelReason = input.cancelReason ?? null; }
      await db.update(meetingBookings).set(patch).where(eq(meetingBookings.id, input.id));
      return { ok: true as const };
    }),
});

// ── Portal wizard slides ──────────────────────────────────────────────────────
const wizardSlidesRouter = router({
  listSlides: adminProcedure.query(async () =>
    db.select().from(portalWizardSlides).orderBy(asc(portalWizardSlides.sortOrder)),
  ),
  publicSlides: protectedProcedure.query(async () =>
    db.select().from(portalWizardSlides)
      .where(eq(portalWizardSlides.isActive, true))
      .orderBy(asc(portalWizardSlides.sortOrder)),
  ),
  upsertSlide: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      title: z.string().trim().min(1).max(255),
      subtitle: z.string().trim().max(500).optional(),
      bodyMarkdown: z.string().trim().max(10_000).optional(),
      imageUrl: z.string().url().max(512).optional(),
      ctaLabel: z.string().trim().max(128).optional(),
      ctaHref: z.string().trim().max(512).optional(),
      sortOrder: z.number().int().min(0).default(0),
      isActive: z.boolean().default(true),
      targetAudience: z.enum(["all", "new", "returning"]).default("all"),
    }))
    .mutation(async ({ input }) => {
      const values = {
        title: input.title,
        subtitle: input.subtitle ?? null,
        bodyMarkdown: input.bodyMarkdown ?? null,
        imageUrl: input.imageUrl ?? null,
        ctaLabel: input.ctaLabel ?? null,
        ctaHref: input.ctaHref ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        targetAudience: input.targetAudience,
      };
      if (input.id) {
        await db.update(portalWizardSlides).set(values).where(eq(portalWizardSlides.id, input.id));
        return { id: input.id };
      }
      const [r] = await db.insert(portalWizardSlides).values(values);
      return { id: (r as { insertId: number }).insertId };
    }),
  deleteSlide: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(portalWizardSlides).where(eq(portalWizardSlides.id, input.id));
      return { ok: true as const };
    }),
});

// ── A/B testing ───────────────────────────────────────────────────────────────
const abTestRouter = router({
  listVariants: adminProcedure.query(async () =>
    db.select().from(pwaAbVariants).orderBy(asc(pwaAbVariants.experimentKey), asc(pwaAbVariants.variantKey)),
  ),
  upsertVariant: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      experimentKey: z.string().trim().min(1).max(128),
      variantKey: z.string().trim().min(1).max(64),
      description: z.string().trim().max(500).optional(),
      weight: z.number().int().min(0).max(100).default(50),
      isControl: z.boolean().default(false),
      isActive: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const values = {
        experimentKey: input.experimentKey,
        variantKey: input.variantKey,
        description: input.description ?? null,
        weight: input.weight,
        isControl: input.isControl,
        isActive: input.isActive,
      };
      if (input.id) {
        await db.update(pwaAbVariants).set(values).where(eq(pwaAbVariants.id, input.id));
        return { id: input.id };
      }
      const [r] = await db.insert(pwaAbVariants).values(values);
      return { id: (r as { insertId: number }).insertId };
    }),
  deleteVariant: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(pwaAbVariants).where(eq(pwaAbVariants.id, input.id));
      return { ok: true as const };
    }),
  eventStats: adminProcedure
    .input(z.object({ experimentKey: z.string().trim().min(1).max(128) }))
    .query(async ({ input }) => {
      const rows = await db.select({ variantKey: pwaAbEvents.variantKey, eventType: pwaAbEvents.eventType, total: count() })
        .from(pwaAbEvents)
        .where(eq(pwaAbEvents.experimentKey, input.experimentKey))
        .groupBy(pwaAbEvents.variantKey, pwaAbEvents.eventType);
      return rows.map((r) => ({ ...r, total: Number(r.total) }));
    }),
  recordEvent: protectedProcedure
    .input(z.object({
      experimentKey: z.string().trim().min(1).max(128),
      variantKey: z.string().trim().min(1).max(64),
      eventType: z.string().trim().max(64).default("impression"),
      metadata: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await db.insert(pwaAbEvents).values({
        experimentKey: input.experimentKey,
        variantKey: input.variantKey,
        userId: ctx.session.user.id,
        eventType: input.eventType,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      });
      return { ok: true as const };
    }),
});

// ── Support permissions ───────────────────────────────────────────────────────
const supportPermissionsRouter = router({
  list: adminProcedure.query(async () =>
    db.select().from(supportPermissions).orderBy(asc(supportPermissions.userId)),
  ),
  upsert: adminProcedure
    .input(z.object({
      userId: z.number().int().positive(),
      canViewAllTickets: z.boolean().default(false),
      canCloseTickets: z.boolean().default(false),
      canAssignTickets: z.boolean().default(false),
      canViewCustomerPii: z.boolean().default(false),
      canIssueRefunds: z.boolean().default(false),
      ticketCategories: z.array(z.string()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const values = {
        userId: input.userId,
        canViewAllTickets: input.canViewAllTickets,
        canCloseTickets: input.canCloseTickets,
        canAssignTickets: input.canAssignTickets,
        canViewCustomerPii: input.canViewCustomerPii,
        canIssueRefunds: input.canIssueRefunds,
        ticketCategories: input.ticketCategories ? JSON.stringify(input.ticketCategories) : null,
        grantedByUserId: ctx.session.user.id,
      };
      await db.insert(supportPermissions).values(values)
        .onDuplicateKeyUpdate({ set: { ...values } });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "support.permissions.update",
        entityType: "support_permissions",
        entityId: input.userId,
        summary: `Support permissions updated for user ${input.userId}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),
  delete: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(supportPermissions).where(eq(supportPermissions.userId, input.userId));
      return { ok: true as const };
    }),
});

// ── Feature toggle scheduling ─────────────────────────────────────────────────
const featureScheduleRouter = router({
  list: adminProcedure.query(async () =>
    db.select().from(featureToggleSchedules).orderBy(asc(featureToggleSchedules.scheduledAt)),
  ),
  create: adminProcedure
    .input(z.object({
      flagKey: z.string().trim().min(1).max(128),
      scheduledValue: z.boolean(),
      scheduledAt: z.string().datetime(),
      note: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [r] = await db.insert(featureToggleSchedules).values({
        flagKey: input.flagKey,
        scheduledValue: input.scheduledValue,
        scheduledAt: new Date(input.scheduledAt),
        note: input.note ?? null,
        createdByUserId: ctx.session.user.id,
      });
      return { id: (r as { insertId: number }).insertId };
    }),
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(featureToggleSchedules).where(eq(featureToggleSchedules.id, input.id));
      return { ok: true as const };
    }),
  /** Execute all pending schedules whose time has passed. Called by the scheduler. */
  executePending: adminProcedure.mutation(async () => {
    const now = new Date();
    const pending = await db.select().from(featureToggleSchedules)
      .where(and(isNull(featureToggleSchedules.executedAt), lte(featureToggleSchedules.scheduledAt, now)));
    let executed = 0;
    for (const schedule of pending) {
      await setFeatureFlag(schedule.flagKey, schedule.scheduledValue);
      await db.update(featureToggleSchedules).set({ executedAt: now }).where(eq(featureToggleSchedules.id, schedule.id));
      executed++;
    }
    return { executed };
  }),
});

// ── Customer portal announcements ────────────────────────────────────────────
const announcementsRouter = router({
  list: adminProcedure.query(async () => {
    const [announcements, recipients] = await Promise.all([
      db.select().from(portalAnnouncements).orderBy(desc(portalAnnouncements.createdAt)),
      db.select().from(portalAnnouncementRecipients),
    ]);
    const recipientMap = new Map<number, number[]>();
    for (const recipient of recipients) recipientMap.set(recipient.announcementId, [...(recipientMap.get(recipient.announcementId) ?? []), recipient.userId]);
    return announcements.map((announcement) => ({ ...announcement, recipientUserIds: recipientMap.get(announcement.id) ?? [] }));
  }),
  visible: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const rows = await db.select().from(portalAnnouncements).where(and(eq(portalAnnouncements.isActive, true), sql`(${portalAnnouncements.startsAt} IS NULL OR ${portalAnnouncements.startsAt} <= ${now})`, sql`(${portalAnnouncements.endsAt} IS NULL OR ${portalAnnouncements.endsAt} >= ${now})`)).orderBy(desc(portalAnnouncements.createdAt));
    const selected = await db.select({ announcementId: portalAnnouncementRecipients.announcementId }).from(portalAnnouncementRecipients).where(eq(portalAnnouncementRecipients.userId, ctx.session.user.id));
    const selectedIds = new Set(selected.map((row) => row.announcementId));
    return rows.filter((announcement) => announcement.audience === "all" || (announcement.audience === "customers" && ctx.session.user.role === "customer") || (announcement.audience === "staff" && ctx.session.user.role !== "customer") || (announcement.audience === "selected" && selectedIds.has(announcement.id)));
  }),
  upsert: adminProcedure.input(z.object({ id: z.number().int().positive().optional(), title: z.string().trim().min(2).max(255), bodyMarkdown: z.string().trim().min(1).max(20_000), audience: z.enum(["all", "customers", "staff", "selected"]).default("all"), recipientUserIds: z.array(z.number().int().positive()).max(200).default([]), isActive: z.boolean().default(true), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().optional() })).mutation(async ({ ctx, input }) => {
    if (input.audience === "selected" && input.recipientUserIds.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose at least one recipient for a selected-user announcement." });
    const values = { title: input.title, bodyMarkdown: input.bodyMarkdown, audience: input.audience, isActive: input.isActive, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null };
    let id = input.id;
    if (id) await db.update(portalAnnouncements).set(values).where(eq(portalAnnouncements.id, id));
    else { const [r] = await db.insert(portalAnnouncements).values({ ...values, createdByUserId: ctx.session.user.id }); id = (r as { insertId: number }).insertId; }
    await db.delete(portalAnnouncementRecipients).where(eq(portalAnnouncementRecipients.announcementId, id));
    const recipientUserIds = [...new Set(input.recipientUserIds)];
    if (input.audience === "selected" && recipientUserIds.length > 0) await db.insert(portalAnnouncementRecipients).values(recipientUserIds.map((userId) => ({ announcementId: id!, userId })));
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "portal_announcement.upsert", entityType: "portal_announcement", entityId: id!, summary: `${input.id ? "Updated" : "Created"} ${input.audience} announcement`, ipAddress: ctx.clientIp });
    return { id };
  }),
  remove: adminProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input }) => { await db.delete(portalAnnouncements).where(eq(portalAnnouncements.id, input.id)); return { ok: true as const }; }),
});

// ── System backups ────────────────────────────────────────────────────────────
const BACKUP_CONTROL_SOCKET = "/run/readypackets/backup-control.sock";
const BACKUP_DIR = "/var/backups/readypackets";
const BACKUP_EXPORT_DIR = "/var/lib/readypackets/storage/admin-exports";
const BACKUP_FILENAME = /^readypackets-[0-9TZ-]+\.tar\.gz(?:\.(?:age|gpg))?$/;
const SCOPED_RECOVERY_FILENAME = /^readypackets-(?:identities|orders)-recovery-[0-9TZ-]+\.rprecovery$/;

function parseBackupControl(output: string) {
  return Object.fromEntries(output.split("\n").map((line) => line.split("=", 2)).filter(([key, value]) => Boolean(key) && value !== undefined));
}

const recoveryHistoryEntrySchema = z.object({
  operation: z.enum(["backup", "restore"]),
  runId: z.string().max(128),
  archive: z.string().max(512),
  mode: z.string().max(64),
  status: z.enum(["started", "completed", "failed"]),
  startedAt: z.string().max(64),
  completedAt: z.string().max(64).nullable(),
  detail: z.string().max(500).nullable(),
});

function parseRecoveryHistory(output: string) {
  return output.split("\n").flatMap((line) => {
    try {
      const result = recoveryHistoryEntrySchema.safeParse(JSON.parse(line));
      return result.success ? [result.data] : [];
    } catch {
      return [];
    }
  }).slice(0, 200);
}

function runBackupControl(args: string[], stdin = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: BACKUP_CONTROL_SOCKET });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Backup control request timed out.")); }, 30_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ action: args[0], args: args.slice(1), stdin })}\n`));
    socket.on("data", (chunk) => { response += chunk; if (response.includes("\n")) socket.end(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      try {
        const payload = JSON.parse(response.trim()) as { ok?: boolean; output?: string; error?: string };
        // Root helpers terminate human-readable output with a newline. Normalize it
        // at the privilege boundary so filename-based actions never pass whitespace
        // into the protected export reader or a browser download payload.
        payload.ok ? resolve((payload.output ?? "").trim()) : reject(new Error(payload.error ?? "Backup control rejected the request."));
      } catch { reject(new Error("Backup control returned an invalid response.")); }
    });
  });
}

async function availableBackupFiles() {
  try {
    const entries = await readdir(BACKUP_DIR);
    const rows = await Promise.all(entries.filter((filename) => BACKUP_FILENAME.test(filename)).map(async (filename) => {
      const details = await stat(path.join(BACKUP_DIR, filename));
      return { filename, sizeBytes: details.size, createdAt: details.mtime };
    }));
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  } catch { return []; }
}

async function readProtectedExport(filename: string) {
  if (!BACKUP_FILENAME.test(filename) && !/^readypackets-config-[0-9TZ-]+\.rpconfig$/.test(filename) && !SCOPED_RECOVERY_FILENAME.test(filename)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid protected export filename." });
  const location = path.join(BACKUP_EXPORT_DIR, filename);
  const details = await stat(location);
  if (details.size > 50 * 1024 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "This protected export exceeds the 50 MB browser download limit. Retrieve it from the server console instead." });
  return { filename, mimeType: "application/octet-stream", base64: (await readFile(location)).toString("base64") };
}

const systemBackupsRouter = router({
  list: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) =>
      db.select().from(systemBackups).orderBy(desc(systemBackups.createdAt)).limit(input.limit),
    ),
  files: adminProcedure.query(async () => availableBackupFiles()),
  status: adminProcedure.query(async () => {
    const [output, archives] = await Promise.all([
      runBackupControl(["status"]).catch((error) => { throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `Backup control is unavailable: ${String(error.message ?? error)}` }); }),
      availableBackupFiles(),
    ]);
    const values = parseBackupControl(output);
    const targets = output.split("\n").filter((line) => line.includes("|")).map((line) => { const [provider, destination] = line.split("|", 2); return { provider, destination }; });
    return {
      nextRun: values.next_run || null,
      targets,
      backupState: values.backup_state || "unknown",
      backupResult: values.backup_result || null,
      backupStarted: values.backup_started || null,
      backupFinished: values.backup_finished || null,
      archiveCount: archives.length,
      lastArchive: archives[0] ?? null,
    };
  }),
  start: adminProcedure.mutation(async ({ ctx }) => {
    await runBackupControl(["start"]);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.started", entityType: "backup", entityId: 0, summary: "Administrator started a backup job", ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),
  setSchedule: adminProcedure.input(z.object({ time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Use a 24-hour HH:MM time.") })).mutation(async ({ ctx, input }) => {
    await runBackupControl(["schedule", input.time]);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.schedule_updated", entityType: "backup", entityId: 0, summary: `Administrator set the daily backup schedule to ${input.time}`, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),
  setCloudTargets: adminProcedure.input(z.object({ targets: z.array(z.object({ provider: z.enum(["Amazon S3", "Wasabi S3", "Backblaze B2", "Azure Blob Storage", "SharePoint", "Google Drive", "OneDrive", "Dropbox"]), destination: z.string().trim().min(3).max(512).regex(/^[A-Za-z0-9._-]+:.+$/, "Use an rclone remote and destination path.") })).max(16) })).mutation(async ({ ctx, input }) => {
    await runBackupControl(["configure-targets"], input.targets.map((target) => `${target.provider}|${target.destination}`).join("\\n") + (input.targets.length ? "\\n" : ""));
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.cloud_targets_updated", entityType: "backup", entityId: 0, summary: `Administrator configured ${input.targets.length} cloud backup target(s)`, changes: { providers: input.targets.map((target) => target.provider) }, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),
  configureCloudRemote: adminProcedure.input(z.object({
    provider: z.enum(["Amazon S3", "Wasabi S3", "Backblaze B2", "Azure Blob Storage", "SharePoint", "Google Drive", "OneDrive", "Dropbox"]),
    remote: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{1,63}$/),
    destination: z.string().trim().max(512).regex(/^[A-Za-z0-9._/-]*$/, "Use a folder, bucket prefix, or container path without .. segments."),
    accessKey: z.string().max(2048).optional(), secretKey: z.string().max(4096).optional(), region: z.string().max(256).optional(), endpoint: z.string().url().max(512).optional(),
    account: z.string().max(2048).optional(), key: z.string().max(4096).optional(), clientId: z.string().max(2048).optional(), clientSecret: z.string().max(4096).optional(), tenant: z.string().max(2048).optional(), oauthToken: z.string().max(20_000).optional(),
  })).mutation(async ({ ctx, input }) => {
    const fields: Record<string, string> = { provider: input.provider, remote: input.remote, destination: input.destination, access_key: input.accessKey ?? "", secret_key: input.secretKey ?? "", region: input.region ?? "", endpoint: input.endpoint ?? "", account: input.account ?? "", key: input.key ?? "", client_id: input.clientId ?? "", client_secret: input.clientSecret ?? "", tenant: input.tenant ?? "", token_b64: input.oauthToken ? Buffer.from(input.oauthToken, "utf8").toString("base64") : "" };
    const result = parseBackupControl(await runBackupControl(["configure-remote"], Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n") + "\n"));
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.cloud_remote_configured", entityType: "backup", entityId: 0, severity: "warning", summary: `Administrator configured ${input.provider} backup remote ${input.remote}`, changes: { provider: input.provider, remote: input.remote, destination: result.destination ?? null }, ipAddress: ctx.clientIp });
    return { provider: result.provider ?? input.provider, destination: result.destination ?? `${input.remote}:${input.destination}` };
  }),
  testCloudTarget: adminProcedure.input(z.object({ destination: z.string().trim().min(3).max(512).regex(/^[A-Za-z0-9._-]+:.+$/, "Use an rclone remote and destination path.") })).mutation(async ({ ctx, input }) => {
    const result = parseBackupControl(await runBackupControl(["test-target", input.destination]));
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.cloud_target_tested", entityType: "backup", entityId: 0, summary: `Administrator tested cloud backup target ${input.destination}`, ipAddress: ctx.clientIp });
    return { reachable: result.reachable === "true", destination: result.destination ?? input.destination };
  }),
  exportScopedRecovery: adminProcedure.input(z.object({ scope: z.enum(["identities", "orders"]), passphrase: z.string().min(16).max(512).regex(/^[^\r\n]+$/, "Use a single-line recovery passphrase.") })).mutation(async ({ ctx, input }) => {
    const filename = (await runBackupControl(["export-scoped-recovery", input.scope], `${input.passphrase}\n`)).trim();
    if (!SCOPED_RECOVERY_FILENAME.test(filename)) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The protected recovery helper did not return a valid encrypted archive name. Review the backup-control service log before retrying." });
    }
    const payload = await readProtectedExport(filename);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: `backup.${input.scope}_recovery_exported`, entityType: "backup", entityId: 0, severity: "warning", summary: `Administrator exported an encrypted ${input.scope} recovery archive`, ipAddress: ctx.clientIp });
    return { ...payload, scope: input.scope };
  }),
  exportConfiguration: adminProcedure.input(z.object({ passphrase: z.string().min(16).max(512) })).mutation(async ({ ctx, input }) => {
    const filename = (await runBackupControl(["export-config"], `${input.passphrase}\n`)).trim();
    if (!/^readypackets-config-[0-9TZ-]+\.rpconfig$/.test(filename)) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The protected export helper did not return a valid encrypted configuration filename. Review the backup-control service log before retrying." });
    }
    const payload = await readProtectedExport(filename);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.configuration_exported", entityType: "backup", entityId: 0, severity: "warning", summary: "Administrator exported an encrypted configuration migration bundle", ipAddress: ctx.clientIp });
    return payload;
  }),
  githubVaultStatus: adminProcedure.query(async () => getGitHubVaultStatus()),
  configureGitHubVault: adminProcedure.input(z.object({
    repository: z.string().trim().min(3).max(201),
    branch: z.string().trim().min(1).max(255),
    folder: z.string().trim().min(1).max(240),
    enabled: z.boolean().default(false),
    token: z.string().trim().min(20).max(4096).optional(),
  })).mutation(async ({ ctx, input }) => {
    const result = await configureGitHubVault({ ...input, updatedByUserId: ctx.session.user.id });
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.github_vault_configured", entityType: "backup", entityId: 0, severity: "warning", summary: `Administrator ${input.enabled ? "enabled" : "saved"} the private GitHub configuration vault`, changes: { repository: result.repository, branch: result.branch, folder: result.folder, tokenConfigured: result.tokenConfigured }, ipAddress: ctx.clientIp });
    return result;
  }),
  testGitHubVault: adminProcedure.mutation(async ({ ctx }) => {
    const result = await testGitHubVault();
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.github_vault_tested", entityType: "backup", entityId: 0, summary: `Administrator validated private GitHub configuration vault ${result.repository}`, changes: { repository: result.repository, branch: result.branch, folder: result.folder }, ipAddress: ctx.clientIp });
    return result;
  }),
  publishGitHubVault: adminProcedure.input(z.object({
    passphrase: z.string().min(16).max(512),
    confirmation: z.literal("BACKUP SECRETS TO GITHUB"),
  })).mutation(async ({ ctx, input }) => {
    const filename = await runBackupControl(["export-config-secrets"], `${input.passphrase}\n`);
    try {
      const result = await publishGitHubVaultBackup({ filename, releasedAt: new Date().toISOString() });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.github_vault_published", entityType: "backup", entityId: 0, severity: "warning", summary: `Administrator published an encrypted secret-inclusive configuration vault backup to ${result.repository}`, changes: { repository: result.repository, branch: result.branch, archivePath: result.archivePath, manifestPath: result.manifestPath, sha256: result.sha256, sizeBytes: result.sizeBytes }, ipAddress: ctx.clientIp });
      return result;
    } finally {
      await runBackupControl(["delete-export", filename]).catch(() => undefined);
    }
  }),
  download: adminProcedure.input(z.object({ filename: z.string().regex(BACKUP_FILENAME, "Invalid backup filename.") })).mutation(async ({ ctx, input }) => {
    const filename = await runBackupControl(["prepare-download", input.filename]);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.downloaded", entityType: "backup", entityId: 0, severity: "warning", summary: `Administrator prepared protected backup ${filename} for download`, ipAddress: ctx.clientIp });
    return readProtectedExport(filename);
  }),
  verifyArchive: adminProcedure.input(z.object({ filename: z.string().regex(BACKUP_FILENAME, "Invalid backup filename.") })).mutation(async ({ ctx, input }) => {
    const verification = parseBackupControl(await runBackupControl(["verify-archive", input.filename]));
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.verified", entityType: "backup", entityId: 0, summary: `Administrator verified backup archive ${input.filename}`, ipAddress: ctx.clientIp });
    return { archive: verification.archive ?? input.filename, databaseBytes: Number(verification.database_bytes ?? 0), includesFiles: verification.includes_files === "true" };
  }),
  restoreStatus: adminProcedure.query(async () => {
    const status = parseBackupControl(await runBackupControl(["restore-status"]));
    return { status: status.status ?? "unknown", unit: status.unit ?? null, archive: status.archive ?? null, mode: status.mode ?? null, started: status.started ?? null, result: status.result ?? null };
  }),
  recoveryHistory: adminProcedure.query(async () => parseRecoveryHistory(await runBackupControl(["recovery-history"]))),
  startRestore: adminProcedure.input(z.object({ filename: z.string().regex(BACKUP_FILENAME, "Invalid backup filename."), confirmation: z.string().max(512) })).mutation(async ({ ctx, input }) => {
    if (input.confirmation !== `RESTORE ${input.filename}`) throw new TRPCError({ code: "BAD_REQUEST", message: `Type RESTORE ${input.filename} to confirm production recovery.` });
    const started = parseBackupControl(await runBackupControl(["start-restore", input.filename], `${input.confirmation}\n`));
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "backup.restore_started", entityType: "backup", entityId: 0, severity: "warning", summary: `Administrator started portable full-system restore from ${input.filename}`, changes: { restoreUnit: started.unit ?? null }, ipAddress: ctx.clientIp });
    return { unit: started.unit ?? null, archive: started.archive ?? input.filename };
  }),
  record: adminProcedure
    .input(z.object({
      filename: z.string().trim().min(1).max(512),
      sizeBytes: z.number().int().min(0),
      backupType: z.enum(["full", "database", "files", "incremental"]).default("full"),
      status: z.enum(["running", "completed", "failed", "deleted"]).default("completed"),
      schemaVersion: z.string().trim().max(32).optional(),
      checksum: z.string().trim().max(128).optional(),
      storagePath: z.string().trim().max(1024).optional(),
      triggeredBy: z.enum(["scheduler", "manual", "pre_upgrade"]).default("manual"),
      error: z.string().trim().max(2000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [r] = await db.insert(systemBackups).values({
        filename: input.filename,
        sizeBytes: input.sizeBytes,
        backupType: input.backupType,
        status: input.status,
        schemaVersion: input.schemaVersion ?? null,
        checksum: input.checksum ?? null,
        storagePath: input.storagePath ?? null,
        triggeredBy: input.triggeredBy,
        triggeredByUserId: ctx.session.user.id,
        error: input.error ?? null,
      });
      return { id: (r as { insertId: number }).insertId };
    }),
  markDeleted: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.update(systemBackups).set({ status: "deleted" }).where(eq(systemBackups.id, input.id));
      return { ok: true as const };
    }),
});

// ── API access logs ───────────────────────────────────────────────────────────
const apiAccessRouter = router({
  listRateLimits: adminProcedure.query(async () =>
    db.select().from(apiKeyRateLimits).orderBy(asc(apiKeyRateLimits.apiKeyId)),
  ),
  upsertRateLimit: adminProcedure
    .input(z.object({
      apiKeyId: z.number().int().positive(),
      windowSeconds: z.number().int().min(10).max(86_400).default(60),
      maxRequests: z.number().int().min(1).max(100_000).default(100),
    }))
    .mutation(async ({ input }) => {
      await db.insert(apiKeyRateLimits).values(input).onDuplicateKeyUpdate({ set: { windowSeconds: input.windowSeconds, maxRequests: input.maxRequests } });
      return { ok: true as const };
    }),
  requestLogs: adminProcedure
    .input(z.object({ apiKeyId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ input }) => {
      const conditions = input.apiKeyId ? [eq(apiRequestLogs.apiKeyId, input.apiKeyId)] : [];
      return db.select().from(apiRequestLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(apiRequestLogs.createdAt))
        .limit(input.limit);
    }),
  actionLogs: adminProcedure
    .input(z.object({ apiKeyId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ input }) => {
      const conditions = input.apiKeyId ? [eq(apiActionLogs.apiKeyId, input.apiKeyId)] : [];
      return db.select().from(apiActionLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(apiActionLogs.createdAt))
        .limit(input.limit);
    }),
});

// ── Admin preferences ─────────────────────────────────────────────────────────
const adminPrefsRouter = router({
  getNavPrefs: adminProcedure.query(async ({ ctx }) => {
    const [prefs] = await db.select().from(adminNavPreferences).where(eq(adminNavPreferences.userId, ctx.session.user.id));
    return prefs ?? null;
  }),
  saveNavPrefs: adminProcedure
    .input(z.object({
      pinnedItems: z.array(z.string()).optional(),
      collapsedSections: z.array(z.string()).optional(),
      defaultView: z.string().trim().max(64).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const values = {
        userId: ctx.session.user.id,
        pinnedItems: input.pinnedItems ? JSON.stringify(input.pinnedItems) : null,
        collapsedSections: input.collapsedSections ? JSON.stringify(input.collapsedSections) : null,
        defaultView: input.defaultView ?? null,
      };
      await db.insert(adminNavPreferences).values(values).onDuplicateKeyUpdate({ set: values });
      return { ok: true as const };
    }),
  listQuickAdd: adminProcedure.query(async ({ ctx }) =>
    db.select().from(pinnedQuickAdd)
      .where(eq(pinnedQuickAdd.userId, ctx.session.user.id))
      .orderBy(asc(pinnedQuickAdd.sortOrder)),
  ),
  upsertQuickAdd: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      actionKey: z.string().trim().min(1).max(64),
      label: z.string().trim().min(1).max(128),
      href: z.string().trim().min(1).max(512),
      sortOrder: z.number().int().min(0).default(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const values = { userId: ctx.session.user.id, actionKey: input.actionKey, label: input.label, href: input.href, sortOrder: input.sortOrder };
      if (input.id) {
        await db.update(pinnedQuickAdd).set(values).where(and(eq(pinnedQuickAdd.id, input.id), eq(pinnedQuickAdd.userId, ctx.session.user.id)));
        return { id: input.id };
      }
      const [r] = await db.insert(pinnedQuickAdd).values(values);
      return { id: (r as { insertId: number }).insertId };
    }),
  deleteQuickAdd: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db.delete(pinnedQuickAdd).where(and(eq(pinnedQuickAdd.id, input.id), eq(pinnedQuickAdd.userId, ctx.session.user.id)));
      return { ok: true as const };
    }),
});

// ── Root Tier 3 router ────────────────────────────────────────────────────────
export const tier3Router = router({
  subscription: subscriptionRouter,
  aiHub: aiHubRouter,
  inboundWebhook: inboundWebhookRouter,
  outbound: outboundRouter,
  scheduling: schedulingRouter,
  wizardSlides: wizardSlidesRouter,
  abTest: abTestRouter,
  supportPermissions: supportPermissionsRouter,
  featureSchedule: featureScheduleRouter,
  systemBackups: systemBackupsRouter,
  apiAccess: apiAccessRouter,
  adminPrefs: adminPrefsRouter,
  announcements: announcementsRouter,
});
