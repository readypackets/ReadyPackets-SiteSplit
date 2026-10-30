/**
 * Administrative operations: orders, customers, catalogue, content, moderation.
 *
 * Every mutation writes an activity record with a before/after diff, so the
 * admin panel is auditable rather than merely powerful. Destructive operations
 * are soft deletes wherever a record has legal or financial significance.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  changelogEntries,
  changelogEntryVersions,
  contactMessages,
  conversionJobs,
  customerIdChangeHistory,
  customReports,
  emailTemplates,
  emailLog,
  emailQueue,
  files,
  forumPosts,
  forumTopics,
  homeContentBlocks,
  intakeAnswers,
  intakeSubmissions,
  mndaAcceptances,
  activityLogs,
  invoices,
  orderStatusHistory,
  orderIdChangeHistory,
  orderNotes,
  orderQuestionTemplates,
  orderQuestions,
  orderAnswers,
  orderAnswerHistory,
  orderItems,
  orderPhaseLocks,
  orderWorkflows,
  orderSharepointLocations,
  payments,
  refunds,
  siteSettings,
  sharepointSyncLog,
  sharepointTransferJobs,
  conversionProfiles,
  sharepointTargetBindings,
  workflowStageRuns,
  workflowCompletionJobs,
  orderAutomationRules,
  orders,
  packetGroups,
  policyAcceptances,
  policyDocuments,
  policyVersions,
  passwordResetTokens,
  productFeatures,
  products,
  registrationFields,
  reviews,
  ticketReplies,
  tickets,
  users,
  samlConfigs,
  webhookDeliveries,
  webhookEndpoints,
} from "../db/schema.js";
import { decryptField, encryptField, hashPassword, isPublicUserId, randomToken } from "../security/crypto.js";
import { getSetting, getSettingBool, getSettingJson, getSettingNumber, invalidateSettingsCache, setSetting } from "../services/settings.js";
import { getOrderStatusOptions, normalizeOrderStatusOptions, ORDER_STATUS_OPTIONS_SETTING } from "../services/orderStatusConfig.js";
import { createOrderMessageReceipts } from "../services/orderMessages.js";
import {
  createUser,
  decryptUser,
  displayNameOf,
  getUserById,
  listUsers,
  searchUsers,
  setAdminNotes,
  setUserRole,
  setUserStatus,
  softDeleteUser,
  restoreUser,
} from "../db/users.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import { revokeAllUserSessions } from "../auth/session.js";
import { revokeMobileSessionsForUser } from "../auth/mobileOidc.js";
import { hasConfirmedMfa } from "../auth/mfa.js";
import {
  OrderStateError,
  createOrder,
  applyOrderAutomationRules,
  getOrderAttentionStates,
  getOrderStats,
  runWorkflowStageActions,
  transitionOrder,
} from "../services/orders.js";
import { getCatalog } from "../services/catalog.js";
import { getCatalogPresentationSettings } from "../services/catalogPresentation.js";
import { queueTemplatedEmail, wrapHtmlBody } from "../services/email.js";
import { normalizeAdministratorIdentifier, ORDER_REFERENCE_PATTERN, orderReferenceEvidenceLabels } from "../services/identifierManagement.js";
import { adminProcedure, staffProcedure, router } from "../trpc/trpc.js";
import { ORDER_STATUSES, PRODUCT_TIERS, USER_ROLES } from "../../shared/domain.js";
import { insertedId } from "../db/result.js";
import { deriveCanonicalP101ScopeForOrder } from "../services/orderScope.js";

type AppliedWorkflowStage = {
  key: string;
  label: string;
  order: number;
  capabilities: string[];
};

function normalizeAppliedWorkflowStages(rawStages: unknown): AppliedWorkflowStage[] {
  if (!Array.isArray(rawStages)) return [];
  return rawStages
    .filter((stage): stage is { key?: unknown; label?: unknown; order?: unknown; capabilities?: unknown } => Boolean(stage) && typeof stage === "object" && typeof stage.key === "string")
    .map((stage, index) => ({
      key: stage.key as string,
      label: typeof stage.label === "string" && stage.label.trim() ? stage.label : (stage.key as string).replaceAll("_", " "),
      order: typeof stage.order === "number" ? stage.order : index + 1,
      capabilities: Array.isArray(stage.capabilities) ? stage.capabilities.filter((capability): capability is string => typeof capability === "string") : [],
    }))
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}

/** Normal operational paths must not read or mutate records in the admin-only trash. */
async function assertActiveOrderExists(orderId: number): Promise<void> {
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
    .limit(1);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
}

/** Matches historic Phase 1/2 lock keys to the stable keys used by current workflows. */
function equivalentPhaseKeys(phaseKey: string): string[] {
  if (phaseKey === "phase_1" || phaseKey === "phase_1_intake") return ["phase_1", "phase_1_intake"];
  if (phaseKey === "phase_2" || phaseKey === "phase_2_synthesis") return ["phase_2", "phase_2_synthesis"];
  return [phaseKey];
}

const workflowStageActionsSchema = z.object({
  emailTemplateKey: z.string().trim().min(1).max(64).optional(),
  adminAlert: z.object({
    enabled: z.boolean().default(false),
    message: z.string().trim().max(500).optional(),
    severity: z.enum(["warning", "error", "critical"]).default("warning"),
  }).optional(),
  orderStatus: z.string().trim().min(2).max(32).optional(),
  completionPercent: z.number().int().min(0).max(100).optional(),
  completionMode: z.enum(["fixed", "random"]).optional(),
  completionRangeMin: z.number().int().min(0).max(100).optional(),
  completionRangeMax: z.number().int().min(0).max(100).optional(),
  completionDelayMinutes: z.number().int().min(0).max(43_200).optional(),
  webhookEndpointId: z.number().int().positive().optional(),
}).superRefine((actions, ctx) => {
  const mode = actions.completionMode ?? (actions.completionPercent !== undefined ? "fixed" : undefined);
  if (!mode) {
    if (actions.completionRangeMin !== undefined || actions.completionRangeMax !== undefined || actions.completionDelayMinutes !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a completion policy mode before configuring a range or delay.", path: ["completionMode"] });
    }
    return;
  }
  if (mode === "fixed" && actions.completionPercent === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a fixed completion percentage.", path: ["completionPercent"] });
  }
  if (mode === "random") {
    if (actions.completionRangeMin === undefined || actions.completionRangeMax === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter both ends of the randomized completion range.", path: ["completionRangeMin"] });
    } else if (actions.completionRangeMin > actions.completionRangeMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The randomized completion minimum cannot exceed the maximum.", path: ["completionRangeMin"] });
    }
  }
}).default({});

const workflowStageSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]+$/).max(48),
  label: z.string().trim().min(2).max(120),
  order: z.number().int().min(1).max(50),
  capabilities: z.array(z.enum(["documents", "questions", "recording", "audio_upload", "review_space"])).max(5).default([]),
  adminTasks: z.array(z.enum(["upload_document", "assign_questions", "review_submission", "run_automation"])).max(4).default([]),
  customerMessage: z.object({
    kind: z.enum(["instructions", "announcement"]),
    title: z.string().trim().min(2).max(120).optional(),
    bodyMarkdown: z.string().trim().min(1).max(8_000),
  }).optional(),
  advanceMode: z.enum(["next", "submit_lock"]).default("submit_lock"),
  customerAcknowledgement: z.enum(["required", "optional", "none"]).default("required"),
  submissionNotice: z.string().trim().min(10).max(2_000).optional(),
  uploadLimits: z.object({
    documentMaxFiles: z.number().int().min(1).max(50).optional(),
    documentMaxSizeMb: z.number().int().min(1).max(100).optional(),
    audioMaxFiles: z.number().int().min(1).max(50).optional(),
    audioMaxSizeMb: z.number().int().min(1).max(100).optional(),
    recordingMaxDurationSeconds: z.number().int().min(1).max(7_200).optional(),
    audioTotalDurationSeconds: z.number().int().min(1).max(7_200).optional(),
  }).optional(),
  sharePointDestination: z.string().trim().min(1).max(240).regex(/^(?!.*\.\.)(?:[A-Za-z0-9 _().-]+)(?:\/[A-Za-z0-9 _().-]+)*$/, "Use a safe relative SharePoint folder path without dot segments.").optional(),
  sharePointAudioDestination: z.string().trim().min(1).max(240).regex(/^(?!.*\.\.)(?:[A-Za-z0-9 _().-]+)(?:\/[A-Za-z0-9 _().-]+)*$/, "Use a safe relative SharePoint folder path without dot segments.").optional(),
  conversionRouting: z.object({
    conversionProfileIds: z.array(z.number().int().positive()).max(9).optional(),
    originalsTargetBindingId: z.number().int().positive().optional(),
    stagingTargetBindingId: z.number().int().positive().optional(),
    intakeTargetBindingId: z.number().int().positive().optional(),
  }).optional(),
  actions: workflowStageActionsSchema,
});

type WorkflowStageInput = z.infer<typeof workflowStageSchema>;

const workflowConfigurationSchema = z.object({
  format: z.literal("readypackets.order-workflow"),
  version: z.literal(1),
  exportedAt: z.string().datetime().optional(),
  workflow: z.object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(4_000).nullable().optional(),
    customerPresentation: z.literal("wizard").default("wizard"),
    stages: z.array(workflowStageSchema).min(1).max(20),
    active: z.boolean().default(true),
  }),
}).strict();

async function validateWorkflowStageReferences(stages: WorkflowStageInput[]): Promise<void> {
  for (const stage of stages) {
    if (stage.actions.emailTemplateKey) {
      const [template] = await db.select({ templateKey: emailTemplates.templateKey }).from(emailTemplates).where(eq(emailTemplates.templateKey, stage.actions.emailTemplateKey)).limit(1);
      if (!template) throw new TRPCError({ code: "BAD_REQUEST", message: `Select a valid Email Template Center template for ${stage.label}.` });
    }
    if (stage.actions.webhookEndpointId) {
      const [endpoint] = await db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(eq(webhookEndpoints.id, stage.actions.webhookEndpointId), eq(webhookEndpoints.enabled, true))).limit(1);
      if (!endpoint) throw new TRPCError({ code: "BAD_REQUEST", message: `Select an enabled webhook endpoint for ${stage.label}.` });
    }
    const routing = stage.conversionRouting;
    if (routing?.conversionProfileIds?.length) {
      const profiles = await db.select({ id: conversionProfiles.id }).from(conversionProfiles).where(and(inArray(conversionProfiles.id, routing.conversionProfileIds), eq(conversionProfiles.active, true)));
      if (profiles.length !== new Set(routing.conversionProfileIds).size) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Select only active conversion profiles for ${stage.label}.` });
      }
    }
    const targetIds = [routing?.originalsTargetBindingId, routing?.stagingTargetBindingId, routing?.intakeTargetBindingId].filter((value): value is number => typeof value === "number");
    if (targetIds.length) {
      const targets = await db.select({ id: sharepointTargetBindings.id }).from(sharepointTargetBindings).where(and(inArray(sharepointTargetBindings.id, targetIds), eq(sharepointTargetBindings.enabled, true)));
      if (targets.length !== new Set(targetIds).size) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Select only active SharePoint targets for ${stage.label}.` });
      }
    }
  }
}

function portableWorkflowStages(rawStages: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rawStages)) return [];
  return rawStages.map((stage) => {
    const source = stage && typeof stage === "object" ? stage as Record<string, unknown> : {};
    const actions = source.actions && typeof source.actions === "object" ? { ...(source.actions as Record<string, unknown>) } : {};
    delete actions.webhookEndpointId;
    // Selected-site connection and conversion profile ids are local to one
    // self-hosted environment. Portable workflow exports retain folder rules
    // but deliberately require operators to select local targets after import.
    delete source.conversionRouting;
    return { ...source, actions };
  });
}

async function purgeOrdersFromTrash(orderIds: number[]) {
  if (orderIds.length === 0) return;
  await db.transaction(async (tx) => {
    const ids = sql.join(orderIds.map((id) => sql`${id}`), sql`, `);
    await tx.execute(sql`DELETE ah FROM order_answer_history ah INNER JOIN order_answers oa ON oa.id = ah.answer_id WHERE oa.order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM order_answers WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE ia FROM intake_answers ia INNER JOIN intake_submissions s ON s.id = ia.submission_id WHERE s.order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM intake_submissions WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM workflow_completion_jobs WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM workflow_stage_runs WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM webhook_deliveries WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM phase_jobs WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM sharepoint_sync_log WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM order_questions WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM order_notes WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM order_shares WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM order_status_history WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM order_items WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM mnda_acceptances WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM meeting_bookings WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM tickets WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM reviews WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM referrals WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM refunds WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM payments WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM invoices WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM billing_events WHERE order_id IN (${ids})`);
    await tx.execute(sql`DELETE FROM files WHERE order_id IN (${ids})`);
    await tx.delete(orders).where(inArray(orders.id, orderIds));
  });
}

function toTrpcError(error: unknown): never {
  if (error instanceof OrderStateError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

const customReportConfigSchema = z.object({
  dataset: z.enum(["orders", "customers"]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  orderStatus: z.string().trim().max(32).optional(),
  paymentStatus: z.string().trim().max(32).optional(),
  customerStatus: z.string().trim().max(32).optional(),
});

type CustomReportConfig = z.infer<typeof customReportConfigSchema>;

async function buildCustomReport(config: CustomReportConfig) {
  if (config.dataset === "orders") {
    const conditions = [isNull(orders.deletedAt)];
    if (config.from) conditions.push(gte(orders.createdAt, new Date(`${config.from}T00:00:00.000Z`)));
    if (config.to) conditions.push(lte(orders.createdAt, new Date(`${config.to}T23:59:59.999Z`)));
    if (config.orderStatus) conditions.push(eq(orders.status, config.orderStatus));
    if (config.paymentStatus) conditions.push(eq(orders.paymentStatus, config.paymentStatus));
    const rows = await db.select({ id: orders.id, orderNumber: orders.orderNumber, userId: orders.userId, status: orders.status, paymentStatus: orders.paymentStatus, totalCents: orders.totalCents, completionPercent: orders.completionPercent, dueAt: orders.dueAt, createdAt: orders.createdAt, projectNameEnc: orders.projectNameEnc }).from(orders).where(and(...conditions)).orderBy(desc(orders.createdAt)).limit(2_000);
    const names = new Map<number, string>();
    for (const userId of new Set(rows.map((row) => row.userId))) {
      const user = await getUserById(userId);
      names.set(userId, user ? displayNameOf(user) : "Deleted customer");
    }
    return {
      dataset: "orders" as const,
      columns: ["Order", "Customer", "Project", "Status", "Payment", "Total", "Complete", "Due", "Created"],
      rows: rows.map((row) => ({
        orderNumber: row.orderNumber,
        customer: names.get(row.userId) ?? "Unknown",
        projectName: decryptField(row.projectNameEnc, `order:${row.id}`) ?? "Untitled project",
        status: row.status,
        paymentStatus: row.paymentStatus,
        totalCents: row.totalCents,
        completionPercent: row.completionPercent,
        dueAt: row.dueAt,
        createdAt: row.createdAt,
      })),
    };
  }

  const conditions = [eq(users.role, "customer"), isNull(users.deletedAt)];
  if (config.from) conditions.push(gte(users.createdAt, new Date(`${config.from}T00:00:00.000Z`)));
  if (config.to) conditions.push(lte(users.createdAt, new Date(`${config.to}T23:59:59.999Z`)));
  if (config.customerStatus) conditions.push(eq(users.status, config.customerStatus));
  const rows = await db.select({ id: users.id, publicId: users.publicId, status: users.status, createdAt: users.createdAt }).from(users).where(and(...conditions)).orderBy(desc(users.createdAt)).limit(2_000);
  const result = [] as Array<{ customerId: string | null; customer: string; status: string; joinedAt: Date }>;
  for (const row of rows) {
    const user = await getUserById(row.id);
    result.push({ customerId: row.publicId, customer: user ? displayNameOf(user) : "Deleted customer", status: row.status, joinedAt: row.createdAt });
  }
  return { dataset: "customers" as const, columns: ["Customer ID", "Customer", "Status", "Joined"], rows: result };
}

export const adminRouter = router({
  /* ---------------------------------------------------------------- */
  /* Dashboard                                                         */
  /* ---------------------------------------------------------------- */

  dashboard: staffProcedure.query(async () => {
    const [orderStats, customerCount, openTickets, pendingReviews, newMessages, failedPayments, overdueOrders, pendingPaymentOrders, activeOrderRows] =
      await Promise.all([
        getOrderStats(),
        db
          .select({ total: count() })
          .from(users)
          .where(and(eq(users.role, "customer"), isNull(users.deletedAt))),
        db
          .select({ total: count() })
          .from(tickets)
          .where(sql`${tickets.status} IN ('open','pending')`),
        db.select({ total: count() }).from(reviews).where(eq(reviews.status, "pending")),
        db.select({ total: count() }).from(contactMessages).where(eq(contactMessages.status, "new")),
        db.select({ total: count() }).from(orders).where(and(isNull(orders.deletedAt), eq(orders.paymentStatus, "failed"))),
        db.select({ total: count() }).from(orders).where(and(isNull(orders.deletedAt), lte(orders.dueAt, new Date()), sql`${orders.status} NOT IN ('delivered', 'closed')`)),
        db.select({ total: count() }).from(orders).where(and(isNull(orders.deletedAt), inArray(orders.paymentStatus, ["unpaid", "processing", "awaiting_invoice"]))),
        db.select({ id: orders.id }).from(orders).where(isNull(orders.deletedAt)),
      ]);
    const attentionByOrder = await getOrderAttentionStates(activeOrderRows.map((row) => row.id));
    const awaitingStaffReview = [...attentionByOrder.values()].filter((attention) => attention.state === "awaiting_staff_review").length;
    const awaitingCustomerResponse = [...attentionByOrder.values()].filter((attention) => attention.state === "awaiting_customer_response").length;

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [signupTrend, orderTrend, revenueTrend] = await Promise.all([
      db
        .select({ day: sql<string>`DATE(${users.createdAt})`, total: count() })
        .from(users)
        .where(and(gte(users.createdAt, since), isNull(users.deletedAt)))
        .groupBy(sql`DATE(${users.createdAt})`)
        .orderBy(sql`DATE(${users.createdAt})`),
      db
        .select({ day: sql<string>`DATE(${orders.createdAt})`, total: count() })
        .from(orders)
        .where(and(gte(orders.createdAt, since), isNull(orders.deletedAt)))
        .groupBy(sql`DATE(${orders.createdAt})`)
        .orderBy(sql`DATE(${orders.createdAt})`),
      db
        .select({
          day: sql<string>`DATE(${orders.createdAt})`,
          revenue: sql<number>`COALESCE(SUM(${orders.totalCents}), 0)`,
        })
        .from(orders)
        .where(and(
          gte(orders.createdAt, since),
          isNull(orders.deletedAt),
          inArray(orders.paymentStatus, ["paid", "partially_refunded"]),
        ))
        .groupBy(sql`DATE(${orders.createdAt})`)
        .orderBy(sql`DATE(${orders.createdAt})`),
    ]);

    return {
      orders: orderStats,
      customers: Number(customerCount[0]?.total ?? 0),
      openTickets: Number(openTickets[0]?.total ?? 0),
      pendingReviews: Number(pendingReviews[0]?.total ?? 0),
      newMessages: Number(newMessages[0]?.total ?? 0),
      orderAlerts: {
        failedPayments: Number(failedPayments[0]?.total ?? 0),
        overdue: Number(overdueOrders[0]?.total ?? 0),
        awaitingPayment: Number(pendingPaymentOrders[0]?.total ?? 0),
        awaitingStaffReview,
        awaitingCustomerResponse,
      },
      signupTrend: signupTrend.map((row) => ({ day: row.day, total: Number(row.total) })),
      orderTrend: orderTrend.map((row) => ({ day: row.day, total: Number(row.total) })),
      revenueTrend: revenueTrend.map((row) => ({ day: row.day, revenueCents: Number(row.revenue) })),
    };
  }),

  /* ---------------------------------------------------------------- */
  /* Orders                                                            */
  /* ---------------------------------------------------------------- */

  standardReports: adminProcedure.query(async () => {
    const [ordersByStatus, paymentsByStatus, customersByStatus] = await Promise.all([
      db.select({ label: orders.status, count: count(), totalCents: sql<number>`COALESCE(SUM(${orders.totalCents}), 0)` }).from(orders).where(isNull(orders.deletedAt)).groupBy(orders.status).orderBy(orders.status),
      db.select({ label: orders.paymentStatus, count: count(), totalCents: sql<number>`COALESCE(SUM(${orders.totalCents}), 0)` }).from(orders).where(isNull(orders.deletedAt)).groupBy(orders.paymentStatus).orderBy(orders.paymentStatus),
      db.select({ label: users.status, count: count() }).from(users).where(and(eq(users.role, "customer"), isNull(users.deletedAt))).groupBy(users.status).orderBy(users.status),
    ]);
    return {
      orderPipeline: ordersByStatus.map((row) => ({ label: row.label, count: Number(row.count), totalCents: Number(row.totalCents) })),
      paymentSummary: paymentsByStatus.map((row) => ({ label: row.label, count: Number(row.count), totalCents: Number(row.totalCents) })),
      customerAccounts: customersByStatus.map((row) => ({ label: row.label, count: Number(row.count) })),
    };
  }),

  customReports: adminProcedure.query(async () => {
    const rows = await db.select().from(customReports).orderBy(desc(customReports.updatedAt), desc(customReports.id));
    return rows.map((row) => ({ ...row, config: customReportConfigSchema.parse(row.configJson) }));
  }),

  saveCustomReport: adminProcedure
    .input(z.object({ id: z.number().int().positive().optional(), name: z.string().trim().min(2).max(190), description: z.string().trim().max(500).optional(), config: customReportConfigSchema }))
    .mutation(async ({ ctx, input }) => {
      const values = { name: input.name, description: input.description || null, dataset: input.config.dataset, configJson: input.config, createdByUserId: ctx.session.user.id };
      if (input.id) {
        const existing = (await db.select({ id: customReports.id }).from(customReports).where(eq(customReports.id, input.id)).limit(1))[0];
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Custom report not found." });
        await db.update(customReports).set({ name: values.name, description: values.description, dataset: values.dataset, configJson: values.configJson }).where(eq(customReports.id, input.id));
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "report.custom_updated", entityType: "custom_report", entityId: input.id, summary: `Updated custom report ${input.name}`, ipAddress: ctx.clientIp });
        return { id: input.id };
      }
      const result = await db.insert(customReports).values(values);
      const id = insertedId(result);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "report.custom_created", entityType: "custom_report", entityId: id, summary: `Created custom report ${input.name}`, ipAddress: ctx.clientIp });
      return { id };
    }),

  deleteCustomReport: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db.delete(customReports).where(eq(customReports.id, input.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "report.custom_deleted", entityType: "custom_report", entityId: input.id, severity: "warning", summary: "Deleted custom report", ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  runCustomReport: adminProcedure
    .input(z.object({ config: customReportConfigSchema }))
    .query(async ({ input }) => buildCustomReport(input.config)),

  orderStatusOptions: adminProcedure.query(async () => getOrderStatusOptions(true)),

  saveOrderStatusOptions: adminProcedure
    .input(z.object({ options: z.array(z.object({ key: z.string().trim().min(2).max(32), label: z.string().trim().min(1).max(64), tone: z.enum(["neutral", "teal", "gold", "success", "warning", "danger"]), active: z.boolean(), sortOrder: z.number().int().min(0).max(9_999) })).min(ORDER_STATUSES.length).max(40) }))
    .mutation(async ({ ctx, input }) => {
      const options = normalizeOrderStatusOptions(input.options);
      const requestedSystem = new Set(input.options.filter((option) => ORDER_STATUSES.includes(option.key as (typeof ORDER_STATUSES)[number])).map((option) => option.key));
      if (requestedSystem.size !== ORDER_STATUSES.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Every protected system order status must remain in the configuration." });
      const configuredKeys = new Set(options.map((option) => option.key));
      const liveRows = await db.select({ status: orders.status }).from(orders).where(isNull(orders.deletedAt));
      const orphaned = [...new Set(liveRows.map((row) => row.status).filter((status) => !configuredKeys.has(status)))];
      if (orphaned.length) throw new TRPCError({ code: "BAD_REQUEST", message: `Deactivate or transition active orders before removing these status options: ${orphaned.join(", ")}.` });
      await setSetting(ORDER_STATUS_OPTIONS_SETTING, JSON.stringify(options), { valueType: "json", category: "orders", userId: ctx.session.user.id });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "order.status_options_updated", entityType: "site_setting", entityId: 0, summary: `Updated ${options.length} order status option(s)`, changes: { options: options.map((option) => ({ key: option.key, label: option.label, active: option.active, sortOrder: option.sortOrder })) }, ipAddress: ctx.clientIp });
      return options;
    }),

  orders: staffProcedure
    .input(
      z
        .object({
          status: z.preprocess(
            (value) => (value === "" || value === "all" || value == null ? undefined : value),
            z.string().trim().min(2).max(32).optional(),
          ),
          attention: z.preprocess(
            (value) => (value === "" || value === "all" || value == null ? undefined : value),
            z.enum(["awaiting_staff_review", "awaiting_customer_response"]).optional(),
          ),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const conditions = [isNull(orders.deletedAt)];
      if (input?.status) conditions.push(eq(orders.status, input.status));

      // Apply queue attention predicates before paging. Filtering an already
      // bounded page would make older matching orders undiscoverable.
      const awaitingStaffReview = sql`EXISTS (
        SELECT 1
        FROM ${orderPhaseLocks}
        WHERE ${orderPhaseLocks.orderId} = ${orders.id}
          AND ${orderPhaseLocks.unlockedAt} IS NULL
          AND ${orderPhaseLocks.reviewedAt} IS NULL
      )`;
      const awaitingCustomerResponse = sql`EXISTS (
        SELECT 1
        FROM ${orderQuestions}
        WHERE ${orderQuestions.orderId} = ${orders.id}
          AND ${orderQuestions.status} = ${"open"}
      )`;
      if (input?.attention === "awaiting_staff_review") conditions.push(awaitingStaffReview);
      if (input?.attention === "awaiting_customer_response") {
        // Keep the same precedence as getOrderAttentionStates: a submitted
        // phase awaiting staff review takes priority over an open question.
        conditions.push(sql`${awaitingCustomerResponse} AND NOT ${awaitingStaffReview}`);
      }

      const limit = input?.limit ?? 100;
      const offset = input?.offset ?? 0;

      const [pageWithSentinel, totalRows] = await Promise.all([
        db
          .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            userId: orders.userId,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            totalCents: orders.totalCents,
            bundleApplied: orders.bundleApplied,
            completionPercent: orders.completionPercent,
            createdAt: orders.createdAt,
            dueAt: orders.dueAt,
            projectNameEnc: orders.projectNameEnc,
          })
          .from(orders)
          .where(and(...conditions))
          // An ID tie-breaker makes page boundaries deterministic when orders
          // were created in the same timestamp tick.
          .orderBy(desc(orders.createdAt), desc(orders.id))
          .limit(limit + 1)
          .offset(offset),
        db.select({ total: count() }).from(orders).where(and(...conditions)),
      ]);
      const hasMore = pageWithSentinel.length > limit;
      const rows = hasMore ? pageWithSentinel.slice(0, limit) : pageWithSentinel;

      const customerNames = new Map<number, string>();
      for (const userId of new Set(rows.map((row) => row.userId))) {
        const user = await getUserById(userId);
        customerNames.set(userId, user ? displayNameOf(user) : "Deleted customer");
      }

      const attentionByOrder = await getOrderAttentionStates(rows.map((row) => row.id));
      const result = rows.map((row) => ({
        id: row.id,
        orderNumber: row.orderNumber,
        customer: customerNames.get(row.userId) ?? "Unknown",
        userId: row.userId,
        status: row.status,
        paymentStatus: row.paymentStatus,
        totalCents: row.totalCents,
        bundleApplied: row.bundleApplied,
        completionPercent: row.completionPercent,
        projectName: decryptField(row.projectNameEnc, `order:${row.id}`),
        createdAt: row.createdAt,
        dueAt: row.dueAt,
        attention: attentionByOrder.get(row.id) ?? { state: "none" as const, phaseKey: null, occurredAt: null },
      }));
      return {
        items: result,
        total: Number(totalRows[0]?.total ?? 0),
        limit,
        offset,
        hasMore,
        scope: "active_platform" as const,
      };
    }),

  trashedOrders: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).optional())
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          userId: orders.userId,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          totalCents: orders.totalCents,
          projectNameEnc: orders.projectNameEnc,
          createdAt: orders.createdAt,
          deletedAt: orders.deletedAt,
        })
        .from(orders)
        .where(sql`${orders.deletedAt} IS NOT NULL`)
        .orderBy(desc(orders.deletedAt))
        .limit(input?.limit ?? 100);
      const customerNames = new Map<number, string>();
      for (const userId of new Set(rows.map((row) => row.userId))) {
        const user = await getUserById(userId);
        customerNames.set(userId, user ? displayNameOf(user) : "Deleted customer");
      }
      return rows.map((row) => ({
        id: row.id,
        orderNumber: row.orderNumber,
        customer: customerNames.get(row.userId) ?? "Unknown",
        status: row.status,
        paymentStatus: row.paymentStatus,
        totalCents: row.totalCents,
        projectName: decryptField(row.projectNameEnc, `order:${row.id}`),
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
      }));
    }),

  /** Create an order on behalf of a customer (admin/staff initiated). */
  createOrderForCustomer: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        selections: z
          .array(z.object({ productId: z.number().int().positive(), quantity: z.number().int().min(1).default(1) }))
          .min(1),
        projectName: z.string().trim().min(1, "Enter an order or project name.").max(200),
        integrityChoice: z.string().trim().max(60).optional(),
        canonVersion: z.string().trim().max(128).optional(),
        runMode: z.string().trim().max(32).optional(),
        releaseStatus: z.string().trim().max(128).optional(),
        orderScopeMode: z.string().trim().max(64).optional(),
        bundleScopeManifest: z.string().max(10000).optional(),
        paymentRequirement: z.enum(["required", "waived", "test"]).default("required"),
        manualPriceCents: z.number().int().min(0).max(100_000_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await createOrder({
          userId: input.userId,
          selections: input.selections,
          projectName: input.projectName,
          integrityChoice: input.integrityChoice ?? null,
          canonVersion: input.canonVersion ?? null,
          runMode: input.runMode ?? null,
          releaseStatus: input.releaseStatus ?? null,
          orderScopeMode: input.orderScopeMode ?? null,
          bundleScopeManifest: input.bundleScopeManifest ?? null,
          paymentRequirement: input.paymentRequirement,
          manualPriceCents: input.manualPriceCents ?? null,
          actorUserId: ctx.session.user.id,
          actorRole: ctx.session.user.role,
          ipAddress: ctx.clientIp,
        });
        void recordActivity({
          actorUserId: ctx.session.user.id,
          actorRole: ctx.session.user.role,
          action: "order.admin_created",
          entityType: "order",
          entityId: result.orderId,
          summary: `Admin created ${input.paymentRequirement === "test" ? "test " : ""}order ${result.orderNumber} for user ${input.userId}`,
          ipAddress: ctx.clientIp,
        });
        return result;
      } catch (error) {
        toTrpcError(error);
      }
    }),

  orderDetail: staffProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const rows = await db.select().from(orders).where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt))).limit(1);
      const order = rows[0];
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });

      const customer = await getUserById(order.userId);
      const notes = await db
        .select()
        .from(orderNotes)
        .where(eq(orderNotes.orderId, input.orderId))
        .orderBy(desc(orderNotes.createdAt));
      const questions = await db
        .select()
        .from(orderQuestions)
        .where(eq(orderQuestions.orderId, input.orderId))
        .orderBy(asc(orderQuestions.sortOrder));
      const attachments = await db
        .select({
          id: files.id,
          originalName: files.originalName,
          sizeBytes: files.sizeBytes,
          category: files.category,
          phase: files.phase,
          detectedMime: files.detectedMime,
          extension: files.extension,
          visibleToCustomer: files.visibleToCustomer,
          isPlaceholder: files.isPlaceholder,
          version: files.version,
          createdAt: files.createdAt,
        })
        .from(files)
        .where(and(eq(files.orderId, input.orderId), isNull(files.deletedAt)))
        .orderBy(desc(files.createdAt));

      const statusHistory = await db
        .select({ id: orderStatusHistory.id, fromStatus: orderStatusHistory.fromStatus, toStatus: orderStatusHistory.toStatus, reason: orderStatusHistory.reason, createdAt: orderStatusHistory.createdAt, actorUserId: orderStatusHistory.actorUserId })
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, input.orderId))
        .orderBy(desc(orderStatusHistory.createdAt));
      const activityHistory = await db
        .select({ id: activityLogs.id, action: activityLogs.action, severity: activityLogs.severity, summary: activityLogs.summary, actorRole: activityLogs.actorRole, createdAt: activityLogs.createdAt })
        .from(activityLogs)
        .where(and(eq(activityLogs.entityType, "order"), eq(activityLogs.entityId, String(input.orderId))))
        .orderBy(desc(activityLogs.createdAt))
        .limit(250);
      const mndaRows = await db
        .select({ id: mndaAcceptances.id, policyVersionId: mndaAcceptances.policyVersionId, signatureNameEnc: mndaAcceptances.signatureNameEnc, signatureMethod: mndaAcceptances.signatureMethod, uploadedFileId: mndaAcceptances.uploadedFileId, acceptedAt: mndaAcceptances.acceptedAt, ipAddress: mndaAcceptances.ipAddress, userAgent: mndaAcceptances.userAgent, version: policyVersions.version })
        .from(mndaAcceptances)
        .leftJoin(policyVersions, eq(mndaAcceptances.policyVersionId, policyVersions.id))
        .where(eq(mndaAcceptances.orderId, input.orderId))
        .orderBy(desc(mndaAcceptances.acceptedAt));

      const lineItems = await db
        .select({ productId: orderItems.productId, quantity: orderItems.quantity, productName: products.name })
        .from(orderItems)
        .leftJoin(products, eq(orderItems.productId, products.id))
        .where(eq(orderItems.orderId, input.orderId));
      const canonicalP101Scope = await deriveCanonicalP101ScopeForOrder(order.id);

      const submission = await db
        .select()
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.orderId, input.orderId))
        .limit(1);
      let intake: Record<string, string | null> | null = null;
      if (submission[0]) {
        const answers = await db
          .select()
          .from(intakeAnswers)
          .where(eq(intakeAnswers.submissionId, submission[0].id));
        intake = Object.fromEntries(
          answers.map((row) => [
            row.questionKey,
            decryptField(row.answerEnc, `intake:${submission[0]!.id}:${row.questionKey}`),
          ]),
        );
      }

      return {
        order: {
          ...order,
          projectName: decryptField(order.projectNameEnc, `order:${order.id}`),
          internalNotesText: decryptField(order.internalNotesEnc, `order_internal:${order.id}`),
          p101Packet: canonicalP101Scope.packet,
          p101Tier: canonicalP101Scope.tier,
          bundleScopeManifest: canonicalP101Scope.bundleScopeManifest,
        },
        customer: customer
          ? {
              id: customer.id,
              name: displayNameOf(customer),
              email: customer.email,
              company: customer.company,
              phone: customer.phone,
              customerNumber: customer.customerNumber,
            }
          : null,
        notes: notes.map((note) => ({
          id: note.id,
          body: decryptField(note.bodyEnc, `order_note:${note.id}`) ?? "",
          visibility: note.visibility,
          createdAt: note.createdAt,
        })),
        questions: questions.map((question) => ({
          id: question.id,
          question: decryptField(question.questionEnc, `order_question:${question.id}`) ?? "",
          required: question.required,
          status: question.status,
        })),
        attachments,
        history: {
          status: statusHistory,
          activity: activityHistory,
        },
        mnda: mndaRows.map((row) => ({
          id: row.id,
          policyVersionId: row.policyVersionId,
          version: row.version ?? "Unknown version",
          signatureName: decryptField(row.signatureNameEnc, `mnda:${row.id}`) ?? "",
          signatureMethod: row.signatureMethod,
          uploadedFileId: row.uploadedFileId,
          acceptedAt: row.acceptedAt,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
        })),
        lineItems,
        intakeSubmission: submission[0]
          ? {
              status: submission[0].status,
              submittedAt: submission[0].submittedAt,
              desiredOutcomes: submission[0].desiredOutcomes,
              integrityChoice: submission[0].integrityChoice,
              answers: intake,
            }
          : null,
      };
    }),

  transitionOrder: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        to: z.string().trim().regex(/^[a-z][a-z0-9_]{1,31}$/),
        reason: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await transitionOrder({
          orderId: input.orderId,
          to: input.to,
          actorUserId: ctx.session.user.id,
          actorRole: ctx.session.user.role,
          reason: input.reason,
          ipAddress: ctx.clientIp,
        });
      } catch (error) {
        toTrpcError(error);
      }
    }),

  updateOrder: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        completionPercent: z.number().int().min(0).max(100).optional(),
        dueAt: z.string().datetime().nullable().optional(),
        internalNotes: z.string().max(20_000).nullable().optional(),
        paymentStatus: z
          .enum(["unpaid", "awaiting_invoice", "processing", "paid", "partially_refunded", "refunded", "failed"])
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActiveOrderExists(input.orderId);
      const patch: Partial<typeof orders.$inferInsert> = {};
      if (input.completionPercent !== undefined) patch.completionPercent = input.completionPercent;
      if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
      if (input.paymentStatus !== undefined) patch.paymentStatus = input.paymentStatus;
      if (input.internalNotes !== undefined) {
        patch.internalNotesEnc = encryptField(
          input.internalNotes,
          `order_internal:${input.orderId}`,
        );
      }
      if (Object.keys(patch).length === 0) return { ok: true as const };

      await db.update(orders).set(patch).where(eq(orders.id, input.orderId));
      if (input.paymentStatus !== undefined) {
        await applyOrderAutomationRules(input.orderId, "payment_status", input.paymentStatus);
      }
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.update",
        entityType: "order",
        entityId: input.orderId,
        summary: "Staff updated order details",
        changes: { fields: Object.keys(patch) },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  addOrderNote: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        body: z.string().trim().min(1).max(10_000),
        visibility: z.enum(["internal", "shared"]).default("internal"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActiveOrderExists(input.orderId);
      const inserted = await db.insert(orderNotes).values({
        orderId: input.orderId,
        authorUserId: ctx.session.user.id,
        bodyEnc: encryptField(input.body, "order_note:pending") ?? "",
        visibility: input.visibility,
      });
      const noteId = insertedId(inserted);
      await db
        .update(orderNotes)
        .set({ bodyEnc: encryptField(input.body, `order_note:${noteId}`) ?? "" })
        .where(eq(orderNotes.id, noteId));
      await createOrderMessageReceipts({
        orderId: input.orderId,
        orderNoteId: noteId,
        authorUserId: ctx.session.user.id,
        visibility: input.visibility,
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.message_sent",
        entityType: "order",
        entityId: input.orderId,
        summary: input.visibility === "shared" ? "Staff sent a shared order message" : "Staff saved an internal order note",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, noteId };
    }),

  addOrderQuestion: staffProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        question: z.string().trim().min(5).max(2000),
        phase: z.string().trim().regex(/^[a-z0-9_]+$/).max(64).default("phase_1"),
        required: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActiveOrderExists(input.orderId);
      const inserted = await db.insert(orderQuestions).values({
        orderId: input.orderId,
        askedByUserId: ctx.session.user.id,
        questionEnc: encryptField(input.question, "order_question:pending") ?? "",
        phase: input.phase,
        required: input.required,
      });
      const questionId = insertedId(inserted);
      await db
        .update(orderQuestions)
        .set({
          questionEnc: encryptField(input.question, `order_question:${questionId}`) ?? "",
        })
        .where(eq(orderQuestions.id, questionId));

      const orderRow = await db
        .select({ userId: orders.userId, orderNumber: orders.orderNumber })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);
      if (orderRow[0]) {
        const customer = await getUserById(orderRow[0].userId);
        if (customer) {
          await queueTemplatedEmail({
            to: customer.email,
            templateKey: "order_question_raised",
            variables: {
              name: displayNameOf(customer),
              orderNumber: orderRow[0].orderNumber,
            },
            fallback: {
              subject: "A question about your ReadyPackets order {{orderNumber}}",
              html: wrapHtmlBody(
                "We have a question",
                `<p style="margin:0 0 12px 0;">Hello {{name}}, our analysts have raised a clarification question on order {{orderNumber}}.</p>
                 <p style="margin:0;">Sign in to your portal to answer it; the work continues as soon as we hear from you.</p>`,
              ),
            },
          });
        }
      }

      return { ok: true as const, questionId };
    }),

  /* Phase 1 question template bank and administrator answer workflow. */
  questionTemplates: staffProcedure
    .input(z.object({ phase: z.string().trim().max(16).optional(), includeInactive: z.boolean().default(false) }).optional())
    .query(async ({ input }) => {
      const conditions = [] as ReturnType<typeof eq>[];
      if (input?.phase) conditions.push(eq(orderQuestionTemplates.phase, input.phase));
      if (!input?.includeInactive) conditions.push(eq(orderQuestionTemplates.isActive, true));
      return db.select().from(orderQuestionTemplates).where(conditions.length ? and(...conditions) : undefined).orderBy(orderQuestionTemplates.sortOrder, orderQuestionTemplates.id);
    }),

  upsertQuestionTemplate: staffProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(2).max(190),
      question: z.string().trim().min(5).max(2_000),
      phase: z.enum(["phase_1", "phase_2", "both", "unassigned"]).default("unassigned"),
      required: z.boolean().default(true),
      sortOrder: z.number().int().min(0).default(0),
      isActive: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const values = { name: input.name, question: input.question, phase: input.phase, required: input.required, sortOrder: input.sortOrder, isActive: input.isActive };
      if (input.id) { await db.update(orderQuestionTemplates).set(values).where(eq(orderQuestionTemplates.id, input.id)); return { id: input.id }; }
      const result = await db.insert(orderQuestionTemplates).values({ ...values, createdByUserId: ctx.session.user.id });
      return { id: insertedId(result) };
    }),

  bulkCreateQuestionTemplates: staffProcedure
    .input(z.object({
      namePrefix: z.string().trim().min(2).max(150),
      questions: z.string().trim().min(5).max(20_000),
      phase: z.enum(["phase_1", "phase_2", "both", "unassigned"]).default("unassigned"),
      required: z.boolean().default(true),
      isActive: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const lines = [...new Set(input.questions.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 5))].slice(0, 100);
      if (lines.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter at least one question of five or more characters." });
      const current = await db.select({ maxSort: sql<number>`COALESCE(MAX(${orderQuestionTemplates.sortOrder}), 0)` }).from(orderQuestionTemplates);
      const baseSort = Number(current[0]?.maxSort ?? 0);
      await db.insert(orderQuestionTemplates).values(lines.map((question, index) => ({
        name: `${input.namePrefix} ${index + 1}`.slice(0, 190),
        question,
        phase: input.phase,
        required: input.required,
        isActive: input.isActive,
        sortOrder: baseSort + index + 1,
        createdByUserId: ctx.session.user.id,
      })));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: ctx.session.user.role, action: "question_template.bulk_created", entityType: "question_template", entityId: 0, summary: `Created ${lines.length} question templates from a bulk list`, changes: { count: lines.length, phase: input.phase }, ipAddress: ctx.clientIp });
      return { ok: true as const, count: lines.length };
    }),

  applyQuestionTemplate: staffProcedure
    .input(z.object({ orderId: z.number().int().positive(), templateId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await assertActiveOrderExists(input.orderId);
      const template = (await db.select().from(orderQuestionTemplates).where(and(eq(orderQuestionTemplates.id, input.templateId), eq(orderQuestionTemplates.isActive, true))).limit(1))[0];
      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "Question template not found." });
      const phases = template.phase === "both" ? ["phase_1", "phase_2"] : [template.phase || "unassigned"];
      const questionIds: number[] = [];
      for (const phase of phases) {
        const inserted = await db.insert(orderQuestions).values({ orderId: input.orderId, askedByUserId: ctx.session.user.id, questionEnc: encryptField(template.question, "order_question:pending") ?? "", phase, required: template.required, sortOrder: template.sortOrder });
        const questionId = insertedId(inserted);
        await db.update(orderQuestions).set({ questionEnc: encryptField(template.question, `order_question:${questionId}`) ?? "" }).where(eq(orderQuestions.id, questionId));
        questionIds.push(questionId);
      }
      return { ok: true as const, questionId: questionIds[0]!, questionIds };
    }),

  answerOrderQuestionAsAdmin: staffProcedure
    .input(z.object({ questionId: z.number().int().positive(), body: z.string().trim().min(1).max(10_000) }))
    .mutation(async ({ ctx, input }) => {
      const question = (await db.select({ id: orderQuestions.id, orderId: orderQuestions.orderId }).from(orderQuestions).where(eq(orderQuestions.id, input.questionId)).limit(1))[0];
      if (!question) throw new TRPCError({ code: "NOT_FOUND", message: "Question not found." });
      await assertActiveOrderExists(question.orderId);
      const existing = (await db.select().from(orderAnswers).where(eq(orderAnswers.questionId, input.questionId)).limit(1))[0];
      if (existing) {
        await db.insert(orderAnswerHistory).values({ answerId: existing.id, previousAnswerEnc: existing.answerEnc, version: existing.version, changedByUserId: ctx.session.user.id });
        await db.update(orderAnswers).set({ answerEnc: encryptField(input.body, `order_answer:${existing.id}`) ?? "", version: existing.version + 1, answeredByUserId: ctx.session.user.id }).where(eq(orderAnswers.id, existing.id));
      } else {
        const result = await db.insert(orderAnswers).values({ questionId: input.questionId, orderId: question.orderId, answeredByUserId: ctx.session.user.id, answerEnc: encryptField(input.body, "order_answer:pending") ?? "" });
        const answerId = insertedId(result);
        await db.update(orderAnswers).set({ answerEnc: encryptField(input.body, `order_answer:${answerId}`) ?? "" }).where(eq(orderAnswers.id, answerId));
      }
      await db.update(orderQuestions).set({ status: "answered" }).where(eq(orderQuestions.id, input.questionId));
      return { ok: true as const };
    }),

  bulkSoftDeleteOrders: adminProcedure
    .input(z.object({ orderIds: z.array(z.number().int().positive()).min(1).max(200), confirmation: z.literal("MOVE_TO_TRASH") }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.orderIds)];
      const now = new Date();
      await db.update(orders).set({ deletedAt: now }).where(inArray(orders.id, ids));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "order.bulk_soft_delete", entityType: "order", entityId: 0, severity: "warning", summary: `Administrator moved ${ids.length} order(s) to trash`, ipAddress: ctx.clientIp });
      return { ok: true as const, count: ids.length };
    }),

  softDeleteOrder: adminProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        reason: z.string().trim().min(5).max(255),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .update(orders)
        .set({ deletedAt: new Date() })
        .where(eq(orders.id, input.orderId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "order.soft_delete",
        entityType: "order",
        entityId: input.orderId,
        severity: "warning",
        summary: `Order soft-deleted: ${input.reason}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  bulkRestoreOrders: adminProcedure
    .input(z.object({ orderIds: z.array(z.number().int().positive()).min(1).max(200), confirmation: z.literal("RESTORE_FROM_TRASH") }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.orderIds)];
      const rows = await db.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, ids), sql`${orders.deletedAt} IS NOT NULL`));
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No trashed orders were found to restore." });
      await db.update(orders).set({ deletedAt: null }).where(inArray(orders.id, rows.map((row) => row.id)));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "order.bulk_restore", entityType: "order", entityId: 0, summary: `Administrator restored ${rows.length} order(s) from trash`, ipAddress: ctx.clientIp });
      return { ok: true as const, count: rows.length };
    }),

  restoreOrder: adminProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.update(orders).set({ deletedAt: null }).where(and(eq(orders.id, input.orderId), sql`${orders.deletedAt} IS NOT NULL`));
      if ((result[0] as { affectedRows?: number } | undefined)?.affectedRows !== 1) throw new TRPCError({ code: "NOT_FOUND", message: "Trashed order not found." });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "order.restore", entityType: "order", entityId: input.orderId, summary: "Administrator restored order from trash", ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  permanentlyPurgeOrder: adminProcedure
    .input(z.object({ orderId: z.number().int().positive(), confirmation: z.literal("DELETE ORDER") }))
    .mutation(async ({ ctx, input }) => {
      const [target] = await db.select({ id: orders.id, orderNumber: orders.orderNumber, deletedAt: orders.deletedAt }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!target?.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Only an order already in trash can be permanently deleted." });
      await purgeOrdersFromTrash([target.id]);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "order.permanently_purged", entityType: "order", entityId: target.id, severity: "critical", summary: `Administrator permanently deleted trashed order ${target.orderNumber}`, ipAddress: ctx.clientIp });
      return { ok: true as const, count: 1 };
    }),

  bulkPurgeOrders: adminProcedure
    .input(z.object({ orderIds: z.array(z.number().int().positive()).min(1).max(200), confirmation: z.literal("DELETE ORDER") }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.orderIds)];
      const rows = await db.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, ids), sql`${orders.deletedAt} IS NOT NULL`));
      if (rows.length !== ids.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Every selected order must already be in trash before permanent deletion." });
      await purgeOrdersFromTrash(rows.map((row) => row.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "order.bulk_permanently_purged", entityType: "order", entityId: 0, severity: "critical", summary: `Administrator permanently deleted ${rows.length} trashed order(s)`, changes: { count: rows.length }, ipAddress: ctx.clientIp });
      return { ok: true as const, count: rows.length };
    }),

  /* ---------------------------------------------------------------- */
  /* Customers                                                         */
  /* ---------------------------------------------------------------- */

  customers: staffProcedure
    .input(
      z
        .object({
          search: z.string().trim().max(190).optional(),
          role: z.preprocess(
            (value) => (value === "" || value === "all" || value == null ? undefined : value),
            z.enum(USER_ROLES).optional(),
          ),
          status: z.preprocess(
            (value) => (value === "" || value === "all" || value == null ? undefined : value),
            z.string().trim().max(24).optional(),
          ),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const list = input?.search
        ? await searchUsers(input.search, input.limit ?? 50)
        : await listUsers({
            role: input?.role,
            status: input?.status,
            limit: input?.limit ?? 50,
            offset: input?.offset ?? 0,
          });

      return list.map((user) => ({
        id: user.id,
        publicId: user.publicId,
        name: displayNameOf(user),
        email: user.email,
        company: user.company,
        phone: user.phone,
        role: user.role,
        status: user.status,
        emailVerified: user.emailVerified,
        mfaEnabled: user.mfaEnabled,
        loginMethod: user.loginMethod,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      }));
    }),

  trashedCustomers: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }).optional())
    .query(async ({ input }) => {
      const rows = await db
        .select()
        .from(users)
        .where(sql`${users.deletedAt} IS NOT NULL`)
        .orderBy(desc(users.deletedAt))
        .limit(input?.limit ?? 100);
      return rows.map((row) => {
        const user = decryptUser(row);
        return {
          id: user.id,
          name: displayNameOf(user),
          email: user.email,
          company: user.company,
          role: user.role,
          status: user.status,
          emailVerified: user.emailVerified,
          mfaEnabled: user.mfaEnabled,
          createdAt: user.createdAt,
          deletedAt: row.deletedAt,
        };
      });
    }),

  customerDetail: staffProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const [rows, activeSamlConfigs] = await Promise.all([
        db.select().from(users).where(eq(users.id, input.userId)).limit(1),
        db.select({ id: samlConfigs.id }).from(samlConfigs).where(eq(samlConfigs.enabled, true)).limit(2),
      ]);
      const row = rows[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      const user = decryptUser(row);

      const orderRows = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          status: orders.status,
          totalCents: orders.totalCents,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(and(eq(orders.userId, input.userId), isNull(orders.deletedAt)))
        .orderBy(desc(orders.createdAt));

      const ticketRows = await db
        .select({
          id: tickets.id,
          ticketNumber: tickets.ticketNumber,
          status: tickets.status,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .where(eq(tickets.userId, input.userId))
        .orderBy(desc(tickets.createdAt));

      return {
        user: {
          id: user.id,
          publicId: user.publicId,
          name: displayNameOf(user),
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          company: user.company,
          phone: user.phone,
          address: user.address,
          role: user.role,
          status: user.status,
          emailVerified: user.emailVerified,
          mfaEnabled: user.mfaEnabled,
          samlLoginEnabled: user.samlLoginEnabled,
          samlSignInAvailable: activeSamlConfigs.length === 1,
          loginMethod: user.loginMethod,
          timezone: user.timezone,
          notes: user.notes,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
        },
        orders: orderRows,
        tickets: ticketRows,
        lifetimeValueCents: orderRows.reduce((sum, order) => sum + order.totalCents, 0),
      };
    }),

  setCustomerNotes: staffProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        notes: z.string().max(20_000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await setAdminNotes(input.userId, input.notes);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "customer.notes_updated",
        entityType: "user",
        entityId: input.userId,
        summary: "Staff updated internal customer notes",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /**
   * Changes a customer-facing ID without allowing retired identifiers to be
   * reissued. Existing order references and external path snapshots deliberately
   * remain untouched so a customer ID correction cannot rewrite evidence.
   */
  changeCustomerId: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        customerId: z.string().trim().min(1).max(24),
        reason: z.string().trim().min(10).max(255),
        confirmation: z.literal("CHANGE CUSTOMER ID"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const customerId = normalizeAdministratorIdentifier(input.customerId);
      if (!isPublicUserId(customerId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Customer IDs must use the RP-CUS- prefix followed by 6 to 8 permitted uppercase characters." });
      }

      const [target] = await db
        .select({ id: users.id, role: users.role, customerNumber: users.customerNumber, publicId: users.publicId, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!target || target.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Active customer account not found." });
      if (target.role !== "customer") throw new TRPCError({ code: "BAD_REQUEST", message: "Only customer accounts may use the customer ID management control." });
      const previousCustomerId = target.customerNumber ?? target.publicId;
      if (!previousCustomerId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account does not have a customer ID to change." });
      if (customerId === previousCustomerId.toUpperCase()) throw new TRPCError({ code: "BAD_REQUEST", message: "The requested customer ID is already assigned to this account." });

      const [activeConflict, historicConflict] = await Promise.all([
        db.select({ id: users.id }).from(users).where(or(eq(users.customerNumber, customerId), eq(users.publicId, customerId))).limit(1),
        db.select({ id: customerIdChangeHistory.id }).from(customerIdChangeHistory).where(eq(customerIdChangeHistory.previousCustomerId, customerId)).limit(1),
      ]);
      if (activeConflict[0] || historicConflict[0]) {
        throw new TRPCError({ code: "CONFLICT", message: "This customer ID is already assigned or was retired and cannot be reused." });
      }

      const allowlist = (await getSettingJson<string[]>("access.login_whitelist_public_ids", []))
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
      const replaceInAllowlist = allowlist.includes(previousCustomerId.toUpperCase());
      const nextAllowlist = replaceInAllowlist
        ? [...new Set(allowlist.map((value) => value === previousCustomerId.toUpperCase() ? customerId : value))]
        : allowlist;

      try {
        await db.transaction(async (tx) => {
          await tx.insert(customerIdChangeHistory).values({
            userId: input.userId,
            previousCustomerId,
            newCustomerId: customerId,
            reason: input.reason,
            changedByUserId: ctx.session.user.id,
          });
          await tx.update(users).set({ customerNumber: customerId, publicId: customerId }).where(eq(users.id, input.userId));
          if (replaceInAllowlist) {
            await tx.insert(siteSettings).values({
              settingKey: "access.login_whitelist_public_ids",
              settingValue: JSON.stringify(nextAllowlist),
              valueType: "json",
              category: "security",
              isSecret: false,
              updatedByUserId: ctx.session.user.id,
            }).onDuplicateKeyUpdate({ set: { settingValue: JSON.stringify(nextAllowlist), updatedByUserId: ctx.session.user.id, updatedAt: new Date() } });
          }
          await tx.insert(activityLogs).values({
            actorUserId: ctx.session.user.id,
            actorRole: ctx.session.user.role,
            action: "customer.id_changed",
            entityType: "user",
            entityId: String(input.userId),
            severity: "warning",
            summary: "Administrator changed a customer identifier; historical order references were preserved.",
            changes: { previousCustomerId, newCustomerId: customerId, reason: input.reason, loginWhitelistUpdated: replaceInAllowlist },
            ipAddress: ctx.clientIp,
          });
        });
      } catch (error) {
        if (String(error).includes("Duplicate entry")) {
          throw new TRPCError({ code: "CONFLICT", message: "This customer ID is already assigned or was retired and cannot be reused." });
        }
        throw error;
      }
      invalidateSettingsCache();
      await recordSecurityEvent({ eventType: "settings.changed", severity: "warning", message: "Administrator changed a customer identifier", userId: input.userId, ipAddress: ctx.clientIp, metadata: { actorUserId: ctx.session.user.id, loginWhitelistUpdated: replaceInAllowlist } });
      return { ok: true as const, customerId, loginWhitelistUpdated: replaceInAllowlist };
    }),

  /**
   * Changes an order reference only while it has no financial, customer-file,
   * SharePoint, conversion, or webhook evidence. Once evidence exists, the
   * reference is immutable to protect reconciliation and external snapshots.
   */
  changeOrderId: adminProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        orderNumber: z.string().trim().min(1).max(64),
        reason: z.string().trim().min(10).max(255),
        confirmation: z.literal("CHANGE ORDER ID"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orderNumber = normalizeAdministratorIdentifier(input.orderNumber);
      if (!ORDER_REFERENCE_PATTERN.test(orderNumber)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Order IDs must use the RP-ORD current opaque reference format." });
      }
      const [order] = await db.select({ id: orders.id, orderNumber: orders.orderNumber, deletedAt: orders.deletedAt }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
      if (!order || order.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Active order not found." });
      if (orderNumber === order.orderNumber.toUpperCase()) throw new TRPCError({ code: "BAD_REQUEST", message: "The requested order ID is already assigned to this order." });

      const [activeConflict, historicConflict, invoiceRows, paymentRows, refundRows, fileRows, syncRows, locationRows, conversionRows, transferRows, webhookRows, mndaRows, intakeRows] = await Promise.all([
        db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1),
        db.select({ id: orderIdChangeHistory.id }).from(orderIdChangeHistory).where(eq(orderIdChangeHistory.previousOrderNumber, orderNumber)).limit(1),
        db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, input.orderId)).limit(1),
        db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, input.orderId)).limit(1),
        db.select({ id: refunds.id }).from(refunds).where(eq(refunds.orderId, input.orderId)).limit(1),
        db.select({ id: files.id }).from(files).where(and(eq(files.orderId, input.orderId), eq(files.isPlaceholder, false), isNull(files.deletedAt))).limit(1),
        db.select({ id: sharepointSyncLog.id }).from(sharepointSyncLog).where(eq(sharepointSyncLog.orderId, input.orderId)).limit(1),
        db.select({ id: orderSharepointLocations.id }).from(orderSharepointLocations).where(eq(orderSharepointLocations.orderId, input.orderId)).limit(1),
        db.select({ id: conversionJobs.id }).from(conversionJobs).where(eq(conversionJobs.orderId, input.orderId)).limit(1),
        db.select({ id: sharepointTransferJobs.id }).from(sharepointTransferJobs).where(eq(sharepointTransferJobs.orderId, input.orderId)).limit(1),
        db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.orderId, input.orderId)).limit(1),
        db.select({ id: mndaAcceptances.id }).from(mndaAcceptances).where(eq(mndaAcceptances.orderId, input.orderId)).limit(1),
        db.select({ id: intakeSubmissions.id }).from(intakeSubmissions).where(eq(intakeSubmissions.orderId, input.orderId)).limit(1),
      ]);
      if (activeConflict[0] || historicConflict[0]) throw new TRPCError({ code: "CONFLICT", message: "This order ID is already assigned or was retired and cannot be reused." });
      const evidence = orderReferenceEvidenceLabels({
        invoice: Boolean(invoiceRows[0]),
        payment: Boolean(paymentRows[0]),
        refund: Boolean(refundRows[0]),
        file: Boolean(fileRows[0]),
        sharepoint: Boolean(syncRows[0] || locationRows[0]),
        conversionOrTransfer: Boolean(conversionRows[0] || transferRows[0]),
        webhook: Boolean(webhookRows[0]),
        mnda: Boolean(mndaRows[0]),
        intake: Boolean(intakeRows[0]),
      });
      if (evidence.length) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Order ID cannot change because immutable ${evidence.join(", ")} evidence exists. Historical order references are intentionally preserved.` });
      }

      try {
        await db.transaction(async (tx) => {
          await tx.insert(orderIdChangeHistory).values({ orderId: input.orderId, previousOrderNumber: order.orderNumber, newOrderNumber: orderNumber, reason: input.reason, changedByUserId: ctx.session.user.id });
          await tx.update(orders).set({ orderNumber }).where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt)));
          await tx.insert(activityLogs).values({
            actorUserId: ctx.session.user.id,
            actorRole: ctx.session.user.role,
            action: "order.id_changed",
            entityType: "order",
            entityId: String(input.orderId),
            severity: "warning",
            summary: "Administrator changed a pre-evidence order identifier.",
            changes: { previousOrderNumber: order.orderNumber, newOrderNumber: orderNumber, reason: input.reason, externalEvidenceChecked: true },
            ipAddress: ctx.clientIp,
          });
        });
      } catch (error) {
        if (String(error).includes("Duplicate entry")) throw new TRPCError({ code: "CONFLICT", message: "This order ID is already assigned or was retired and cannot be reused." });
        throw error;
      }
      await recordSecurityEvent({ eventType: "settings.changed", severity: "warning", message: "Administrator changed a pre-evidence order identifier", userId: ctx.session.user.id, ipAddress: ctx.clientIp, metadata: { orderId: input.orderId } });
      return { ok: true as const, orderNumber };
    }),

  setCustomerStatus: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        status: z.enum(["active", "suspended", "deactivated"]),
        reason: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot change the status of your own account.",
        });
      }
      await setUserStatus(input.userId, input.status);
      if (input.status !== "active") {
        await revokeAllUserSessions(input.userId, `status_${input.status}`);
      }
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "notice",
        message: `Account status set to ${input.status}`,
        userId: input.userId,
        ipAddress: ctx.clientIp,
        metadata: { actorUserId: ctx.session.user.id, reason: input.reason ?? null },
      });
      return { ok: true as const };
    }),

  setCustomerRole: adminProcedure
    .input(
      z.object({
        userId: z.number().int().positive(),
        role: z.enum(USER_ROLES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot change your own role.",
        });
      }
      await setUserRole(input.userId, input.role);
      // A role change alters privileges, so existing sessions must not persist.
      await revokeAllUserSessions(input.userId, "role_changed");
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        message: `Account role changed to ${input.role}`,
        userId: input.userId,
        ipAddress: ctx.clientIp,
        metadata: { actorUserId: ctx.session.user.id, role: input.role },
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "account.role_changed",
        entityType: "user",
        entityId: input.userId,
        severity: "warning",
        summary: `Administrator changed account role to ${input.role}`,
        changes: { role: input.role },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  createStaffAccount: adminProcedure
    .input(
      z.object({
        email: z.string().trim().toLowerCase().email().max(254),
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        role: z.enum(["customer", "staff", "admin"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // A random initial password with a forced change avoids emailing a usable secret.
      const temporary = `${randomToken(9)}Aa1!`;
      const user = await createUser({
        email: input.email,
        passwordHash: await hashPassword(temporary),
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        emailVerified: true,
        mustChangePassword: true,
      });

      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        message: `New ${input.role} account created`,
        userId: user.id,
        ipAddress: ctx.clientIp,
        metadata: { actorUserId: ctx.session.user.id, role: input.role },
      });
      // The activity stream intentionally contains role and IDs only. It must
      // never retain the temporary password or account identifier.
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "account.provisioned",
        entityType: "user",
        entityId: user.id,
        severity: "warning",
        summary: `Administrator provisioned ${input.role} account`,
        changes: { role: input.role, mustChangePassword: true },
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const, userId: user.id, temporaryPassword: temporary };
    }),

  bulkDisableCustomers: adminProcedure
    .input(z.object({ userIds: z.array(z.number().int().positive()).min(1).max(200), confirmation: z.literal("DISABLE_ACCOUNTS") }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.userIds)].filter((id) => id !== ctx.session.user.id);
      if (ids.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot disable your own account." });
      const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), isNull(users.deletedAt)));
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No active accounts were found to disable." });
      for (const row of rows) {
        await setUserStatus(row.id, "deactivated");
        await revokeAllUserSessions(row.id, "status_deactivated");
      }
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "customer.bulk_disabled", entityType: "user", entityId: 0, severity: "warning", summary: `Administrator disabled ${rows.length} account(s) before lifecycle action`, ipAddress: ctx.clientIp });
      return { ok: true as const, count: rows.length };
    }),

  softDeleteCustomer: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), confirmation: z.literal("MOVE_TO_TRASH"), adminConfirmation: z.literal("DELETE ADMIN").optional() }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own account." });
      const rows = await db.select({ id: users.id, role: users.role, status: users.status, deletedAt: users.deletedAt }).from(users).where(eq(users.id, input.userId)).limit(1);
      const target = rows[0];
      if (!target || target.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Active account not found." });
      if (target.status !== "deactivated") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Disable this account before moving it to trash." });
      if (target.role === "admin" && input.adminConfirmation !== "DELETE ADMIN") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Administrator deletion requires the exact confirmation DELETE ADMIN." });
      }
      await softDeleteUser(input.userId);
      await revokeAllUserSessions(input.userId, "account_deleted");
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: target.role === "admin" ? "administrator.soft_delete" : "customer.soft_delete", entityType: "user", entityId: input.userId, severity: "critical", summary: `Administrator moved ${target.role} account to trash after disablement`, changes: { role: target.role, priorStatus: target.status }, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  forceCustomerOnboarding: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db.update(users).set({ onboardingCompletedAt: null, onboardingForcedAt: new Date() }).where(eq(users.id, input.userId));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "customer.force_onboarding", entityType: "user", entityId: input.userId, summary: "Administrator required customer to view onboarding again", ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  forceAllCustomerOnboarding: adminProcedure.mutation(async ({ ctx }) => {
    const result = await db.update(users).set({ onboardingCompletedAt: null, onboardingForcedAt: new Date() }).where(and(eq(users.role, "customer"), eq(users.status, "active"), isNull(users.deletedAt)));
    const count = Number((result as { affectedRows?: number }).affectedRows ?? 0);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "customer.force_onboarding_all", entityType: "user", entityId: 0, summary: `Administrator required ${count} customers to view onboarding again`, ipAddress: ctx.clientIp });
    return { ok: true as const, count };
  }),

  bulkSoftDeleteCustomers: adminProcedure
    .input(z.object({ userIds: z.array(z.number().int().positive()).min(1).max(200), confirmation: z.literal("MOVE_TO_TRASH") }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.userIds)].filter((id) => id !== ctx.session.user.id);
      if (ids.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot move your own account to trash." });
      const rows = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(and(inArray(users.id, ids), isNull(users.deletedAt)));
      if (rows.some((row) => row.role === "admin")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Administrator accounts cannot be bulk deleted. Disable and delete each administrator individually." });
      const notDisabled = rows.filter((row) => row.status !== "deactivated");
      if (notDisabled.length > 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Disable every selected account before moving it to trash." });
      for (const row of rows) { await softDeleteUser(row.id); await revokeAllUserSessions(row.id, "account_deleted"); }
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "customer.bulk_soft_delete", entityType: "user", entityId: 0, severity: "warning", summary: `Administrator moved ${rows.length} disabled non-administrator account(s) to trash`, ipAddress: ctx.clientIp });
      return { ok: true as const, count: rows.length };
    }),

  bulkRestoreCustomers: adminProcedure
    .input(z.object({ userIds: z.array(z.number().int().positive()).min(1).max(200), confirmation: z.literal("RESTORE_FROM_TRASH") }))
    .mutation(async ({ ctx, input }) => {
      const ids = [...new Set(input.userIds)];
      const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), sql`${users.deletedAt} IS NOT NULL`));
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No trashed accounts were found to restore." });
      for (const row of rows) await restoreUser(row.id);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "customer.bulk_restore", entityType: "user", entityId: 0, summary: `Administrator restored ${rows.length} account(s) from trash`, ipAddress: ctx.clientIp });
      return { ok: true as const, count: rows.length };
    }),

  permanentlyPurgeCustomer: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), confirmation: z.literal("DELETE") }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db.select({ id: users.id, role: users.role, status: users.status, deletedAt: users.deletedAt }).from(users).where(eq(users.id, input.userId)).limit(1);
      const target = rows[0];
      if (!target || !target.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Trashed account not found." });
      if (target.status !== "deleted") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only disabled accounts moved to trash can be permanently purged." });
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM portal_announcement_recipients WHERE user_id = ${target.id}`);
        await tx.delete(users).where(eq(users.id, target.id));
      });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "customer.permanently_purged", entityType: "user", entityId: input.userId, severity: "critical", summary: `Administrator permanently purged a trashed ${target.role} account`, changes: { role: target.role }, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  restoreCustomer: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await restoreUser(input.userId);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "customer.restore",
        entityType: "user",
        entityId: input.userId,
        summary: "Administrator restored a customer account",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Order workflows                                                   */
  /* ---------------------------------------------------------------- */

  orderWorkflows: adminProcedure.query(async () => {
    const rows = await db.select().from(orderWorkflows).orderBy(desc(orderWorkflows.isDefault), asc(orderWorkflows.name));
    return rows.map((row) => ({ ...row, stages: Array.isArray(row.stages) ? row.stages : [] }));
  }),

  exportOrderWorkflow: adminProcedure
    .input(z.object({ workflowId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const [workflow] = await db
        .select({ id: orderWorkflows.id, name: orderWorkflows.name, description: orderWorkflows.description, customerPresentation: orderWorkflows.customerPresentation, stages: orderWorkflows.stages, active: orderWorkflows.active })
        .from(orderWorkflows)
        .where(eq(orderWorkflows.id, input.workflowId))
        .limit(1);
      if (!workflow) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });

      const configuration = {
        format: "readypackets.order-workflow" as const,
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        workflow: {
          name: workflow.name,
          description: workflow.description,
          customerPresentation: "wizard" as const,
          stages: portableWorkflowStages(workflow.stages),
          active: workflow.active,
        },
      };
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "workflow.configuration_exported", entityType: "order_workflow", entityId: workflow.id, summary: `Administrator exported workflow configuration ${workflow.name}`, changes: { format: configuration.format, version: configuration.version, stageCount: configuration.workflow.stages.length, externalWebhookReferencesExcluded: true }, ipAddress: ctx.clientIp });
      return configuration;
    }),

  importOrderWorkflow: adminProcedure
    .input(z.object({
      name: z.string().trim().min(2).max(120),
      confirmation: z.literal("IMPORT WORKFLOW CONFIGURATION"),
      configuration: workflowConfigurationSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const stages = [...input.configuration.workflow.stages].sort((a, b) => a.order - b.order);
      if (new Set(stages.map((stage) => stage.key)).size !== stages.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Imported workflow stages must have unique keys." });
      await validateWorkflowStageReferences(stages);
      const result = await db.insert(orderWorkflows).values({
        name: input.name,
        description: input.configuration.workflow.description ?? null,
        customerPresentation: input.configuration.workflow.customerPresentation,
        stages,
        isDefault: false,
        active: input.configuration.workflow.active,
        createdByUserId: ctx.session.user.id,
      });
      const id = insertedId(result);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "workflow.configuration_imported", entityType: "order_workflow", entityId: id, summary: `Administrator imported workflow configuration as ${input.name}`, changes: { sourceFormat: input.configuration.format, sourceVersion: input.configuration.version, stageCount: stages.length, sourceWorkflowName: input.configuration.workflow.name, active: input.configuration.workflow.active, defaultWorkflowProtected: true }, ipAddress: ctx.clientIp });
      return { ok: true as const, id };
    }),

  upsertOrderWorkflow: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(2).max(120),
      description: z.string().trim().max(4_000).optional(),
      customerPresentation: z.literal("wizard").default("wizard"),
      stages: z.array(workflowStageSchema).min(1).max(20),
      isDefault: z.boolean().default(false),
      active: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const stages = [...input.stages].sort((a, b) => a.order - b.order);
      if (new Set(stages.map((stage) => stage.key)).size !== stages.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Workflow stages must have unique keys." });
      await validateWorkflowStageReferences(stages);
      if (input.isDefault) await db.update(orderWorkflows).set({ isDefault: false });
      if (input.id) {
        const existingRows = await db.select({ stages: orderWorkflows.stages }).from(orderWorkflows).where(eq(orderWorkflows.id, input.id)).limit(1);
        if (!existingRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });
        const existingStages = Array.isArray(existingRows[0].stages) ? existingRows[0].stages as { key?: unknown }[] : [];
        const removedStageKeys = existingStages.map((stage) => typeof stage.key === "string" ? stage.key : "").filter((key) => key && !stages.some((stage) => stage.key === key));
        if (removedStageKeys.length) {
          const [fileReferences, questionReferences] = await Promise.all([
            db.select({ total: count() }).from(files).innerJoin(orders, eq(files.orderId, orders.id)).where(and(eq(orders.workflowId, input.id), inArray(files.phase, removedStageKeys), isNull(files.deletedAt))),
            db.select({ total: count() }).from(orderQuestions).innerJoin(orders, eq(orderQuestions.orderId, orders.id)).where(and(eq(orders.workflowId, input.id), inArray(orderQuestions.phase, removedStageKeys))),
          ]);
          const references = Number(fileReferences[0]?.total ?? 0) + Number(questionReferences[0]?.total ?? 0);
          if (references > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This phase contains existing order files or questions. Keep its stable key and rename or disable its customer actions instead of removing it." });
        }
        await db.update(orderWorkflows).set({ name: input.name, description: input.description ?? null, customerPresentation: input.customerPresentation, stages, isDefault: input.isDefault, active: input.active }).where(eq(orderWorkflows.id, input.id));
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "workflow.updated", entityType: "order_workflow", entityId: input.id, summary: `Administrator updated workflow ${input.name}`, ipAddress: ctx.clientIp });
        return { ok: true as const, id: input.id };
      }
      const result = await db.insert(orderWorkflows).values({ name: input.name, description: input.description ?? null, customerPresentation: input.customerPresentation, stages, isDefault: input.isDefault, active: input.active, createdByUserId: ctx.session.user.id });
      const id = insertedId(result);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "workflow.created", entityType: "order_workflow", entityId: id, summary: `Administrator created workflow ${input.name}`, ipAddress: ctx.clientIp });
      return { ok: true as const, id };
    }),

  deleteOrderWorkflow: adminProcedure
    .input(z.object({ workflowId: z.number().int().positive(), confirmation: z.literal("DELETE WORKFLOW") }))
    .mutation(async ({ ctx, input }) => {
      const [workflow] = await db.select({ id: orderWorkflows.id, name: orderWorkflows.name, isDefault: orderWorkflows.isDefault }).from(orderWorkflows).where(eq(orderWorkflows.id, input.workflowId)).limit(1);
      if (!workflow) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found." });
      if (workflow.isDefault) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Choose another default workflow before deleting this workflow." });
      const [assignment] = await db.select({ total: count() }).from(orders).where(and(eq(orders.workflowId, input.workflowId), isNull(orders.deletedAt)));
      if (Number(assignment?.total ?? 0) > 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This workflow is assigned to active orders. Reassign those orders or archive the workflow instead of deleting it." });
      await db.delete(orderWorkflows).where(eq(orderWorkflows.id, input.workflowId));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "workflow.deleted", entityType: "order_workflow", entityId: input.workflowId, severity: "warning", summary: `Administrator deleted unused workflow ${workflow.name}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  assignOrderWorkflow: adminProcedure
    .input(z.object({ orderId: z.number().int().positive(), workflowId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const workflow = await db.select({ id: orderWorkflows.id, name: orderWorkflows.name, active: orderWorkflows.active }).from(orderWorkflows).where(eq(orderWorkflows.id, input.workflowId)).limit(1);
      if (!workflow[0] || !workflow[0].active) throw new TRPCError({ code: "BAD_REQUEST", message: "Select an active workflow." });
      const result = await db.update(orders).set({ workflowId: workflow[0].id }).where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt)));
      if (Number((result as { affectedRows?: number }).affectedRows ?? 0) === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "order.workflow_assigned", entityType: "order", entityId: input.orderId, summary: `Administrator assigned workflow ${workflow[0].name}`, changes: { workflowId: workflow[0].id }, ipAddress: ctx.clientIp });
      return { ok: true as const, workflow: workflow[0] };
    }),

  phaseLocks: staffProcedure
    .input(z.object({ orderId: z.number().int().positive(), includeUnlocked: z.boolean().default(false) }))
    .query(async ({ input }) => {
      const [order] = await db
        .select({ workflowId: orders.workflowId })
        .from(orders)
        .where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt)))
        .limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });

      const [workflow] = order.workflowId
        ? await db.select({ stages: orderWorkflows.stages }).from(orderWorkflows).where(eq(orderWorkflows.id, order.workflowId)).limit(1)
        : [];
      const stages = normalizeAppliedWorkflowStages(workflow?.stages);
      const locks = await db
        .select()
        .from(orderPhaseLocks)
        .where(eq(orderPhaseLocks.orderId, input.orderId))
        .orderBy(desc(orderPhaseLocks.lockedAt));

      const consumedLockIds = new Set<number>();
      const rows = stages.map((stage) => {
        const aliases = equivalentPhaseKeys(stage.key);
        const lock = locks.find((candidate) => aliases.includes(candidate.phaseKey) && !consumedLockIds.has(candidate.id));
        if (lock) consumedLockIds.add(lock.id);
        return {
          phaseKey: stage.key,
          label: stage.label,
          stageOrder: stage.order,
          capabilities: stage.capabilities,
          rawPhaseKey: lock?.phaseKey ?? null,
          lock,
          active: Boolean(lock && !lock.unlockedAt),
          appliedWorkflow: true,
        };
      });

      // Retain historical lock records when a workflow was reassigned or a stage
      // was removed; an administrator can still reopen an active retired lock.
      for (const lock of locks) {
        if (consumedLockIds.has(lock.id)) continue;
        rows.push({
          phaseKey: lock.phaseKey,
          label: lock.phaseKey.replaceAll("_", " "),
          stageOrder: 10_000 + lock.id,
          capabilities: [],
          rawPhaseKey: lock.phaseKey,
          lock,
          active: !lock.unlockedAt,
          appliedWorkflow: false,
        });
      }

      return input.includeUnlocked ? rows : rows.filter((row) => row.active);
    }),

  reviewWorkflowPhase: staffProcedure
    .input(z.object({ orderId: z.number().int().positive(), phaseKey: z.string().trim().regex(/^[a-z0-9_]+$/).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await assertActiveOrderExists(input.orderId);
      const lockRows = await db
        .select({ id: orderPhaseLocks.id })
        .from(orderPhaseLocks)
        .where(and(eq(orderPhaseLocks.orderId, input.orderId), inArray(orderPhaseLocks.phaseKey, equivalentPhaseKeys(input.phaseKey)), isNull(orderPhaseLocks.unlockedAt), isNull(orderPhaseLocks.reviewedAt)))
        .orderBy(desc(orderPhaseLocks.lockedAt))
        .limit(1);
      const lock = lockRows[0];
      if (!lock) throw new TRPCError({ code: "NOT_FOUND", message: "An unreviewed submitted workflow phase was not found." });
      await db.update(orderPhaseLocks).set({ reviewedAt: new Date(), reviewedByUserId: ctx.session.user.id }).where(eq(orderPhaseLocks.id, lock.id));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.phase_reviewed",
        entityType: "order",
        entityId: input.orderId,
        summary: `Staff reviewed submitted workflow phase ${input.phaseKey}`,
        changes: { phaseKey: input.phaseKey },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  unlockWorkflowPhase: adminProcedure
    .input(z.object({
      orderId: z.number().int().positive(),
      phaseKey: z.string().trim().regex(/^[a-z0-9_]+$/).max(64),
      reason: z.string().trim().min(10).max(1_000),
      confirmation: z.literal("UNLOCK PHASE"),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertActiveOrderExists(input.orderId);
      const lockRows = await db
        .select({ id: orderPhaseLocks.id, phaseKey: orderPhaseLocks.phaseKey })
        .from(orderPhaseLocks)
        .where(and(eq(orderPhaseLocks.orderId, input.orderId), inArray(orderPhaseLocks.phaseKey, equivalentPhaseKeys(input.phaseKey)), isNull(orderPhaseLocks.unlockedAt)))
        .orderBy(desc(orderPhaseLocks.lockedAt))
        .limit(1);
      const lock = lockRows[0];
      if (!lock) throw new TRPCError({ code: "NOT_FOUND", message: "An active lock for this workflow phase was not found." });
      await db.update(orderPhaseLocks).set({ unlockedAt: new Date(), unlockedByUserId: ctx.session.user.id, unlockReason: input.reason }).where(eq(orderPhaseLocks.id, lock.id));
      if (lock.phaseKey === "phase_1" || lock.phaseKey === "phase_1_intake") {
        await db.update(intakeSubmissions).set({ status: "draft", submittedAt: null }).where(eq(intakeSubmissions.orderId, input.orderId));
      }
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "order.phase_unlocked",
        entityType: "order",
        entityId: input.orderId,
        severity: "warning",
        summary: `Administrator unlocked workflow phase ${input.phaseKey}`,
        changes: { phaseKey: input.phaseKey, reason: input.reason },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  workflowStageRuns: staffProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await assertActiveOrderExists(input.orderId);
      return db.select().from(workflowStageRuns).where(eq(workflowStageRuns.orderId, input.orderId)).orderBy(desc(workflowStageRuns.startedAt), desc(workflowStageRuns.id));
    }),

  workflowCompletionJobs: staffProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ input }) => {
      await assertActiveOrderExists(input.orderId);
      return db.select().from(workflowCompletionJobs).where(eq(workflowCompletionJobs.orderId, input.orderId)).orderBy(desc(workflowCompletionJobs.createdAt), desc(workflowCompletionJobs.id));
    }),

  runWorkflowStageActions: adminProcedure
    .input(z.object({ orderId: z.number().int().positive(), stageKey: z.string().trim().regex(/^[a-z0-9_]+$/).max(64) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await assertActiveOrderExists(input.orderId);
        return await runWorkflowStageActions({ orderId: input.orderId, stageKey: input.stageKey, actorUserId: ctx.session.user.id, actorRole: "admin", ipAddress: ctx.clientIp });
      } catch (error) {
        return toTrpcError(error);
      }
    }),

  /* ---------------------------------------------------------------- */
  /* Catalogue                                                         */
  /* ---------------------------------------------------------------- */

  catalog: staffProcedure.query(async () => getCatalog({ includeUnlisted: true })),

  publicCatalogPresentation: adminProcedure.query(async () => getCatalogPresentationSettings()),

  setPublicCatalogPresentation: adminProcedure
    .input(z.object({
      pricingMode: z.enum(["show", "on_request", "hidden"]),
      publicDeliveryEstimatesVisible: z.boolean(),
      customerPortalDeliveryEstimatesVisible: z.boolean(),
      publicReviewsNavigationVisible: z.boolean(),
      publicCommunityNavigationVisible: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      await Promise.all([
        setSetting("catalog.public_pricing_mode", input.pricingMode, { category: "catalog", valueType: "string", userId: ctx.session.user.id }),
        // Preserve compatibility for older portal clients during rolling deployments.
        setSetting("catalog.public_prices_visible", input.pricingMode === "show" ? "true" : "false", { category: "catalog", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("catalog.public_delivery_estimates_visible", input.publicDeliveryEstimatesVisible ? "true" : "false", { category: "catalog", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("catalog.customer_portal_delivery_estimates_visible", input.customerPortalDeliveryEstimatesVisible ? "true" : "false", { category: "catalog", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("public.navigation.reviews_visible", input.publicReviewsNavigationVisible ? "true" : "false", { category: "public", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("public.navigation.community_visible", input.publicCommunityNavigationVisible ? "true" : "false", { category: "public", valueType: "boolean", userId: ctx.session.user.id }),
      ]);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "catalog.public_presentation_updated",
        entityType: "site_setting",
        entityId: 0,
        severity: "notice",
        summary: "Public catalogue and navigation presentation settings updated",
        changes: input,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, ...input };
    }),

  publicCatalogPriceVisibility: adminProcedure.query(async () => {
    const presentation = await getCatalogPresentationSettings();
    return { visible: presentation.pricingMode === "show", mode: presentation.pricingMode };
  }),

  setPublicCatalogPriceVisibility: adminProcedure
    .input(z.object({ visible: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await Promise.all([
        setSetting("catalog.public_prices_visible", input.visible ? "true" : "false", {
          category: "catalog",
          valueType: "boolean",
          userId: ctx.session.user.id,
        }),
        setSetting("catalog.public_pricing_mode", input.visible ? "show" : "on_request", {
          category: "catalog",
          valueType: "string",
          userId: ctx.session.user.id,
        }),
      ]);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "catalog.public_price_visibility_updated",
        entityType: "site_setting",
        entityId: 0,
        summary: `Public catalogue price visibility ${input.visible ? "enabled" : "disabled"}`,
        changes: { visible: input.visible },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, visible: input.visible };
    }),

  upsertPacketGroup: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(96),
        groupNumber: z.number().int().min(1).max(99),
        name: z.string().trim().min(2).max(190),
        category: z.string().trim().min(2).max(120),
        summary: z.string().trim().max(2000).optional(),
        icon: z.string().trim().max(48).default("Layers"),
        listed: z.boolean().default(true),
        sortOrder: z.number().int().min(0).max(999).default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.id) {
        await db
          .update(packetGroups)
          .set({
            slug: input.slug,
            groupNumber: input.groupNumber,
            name: input.name,
            category: input.category,
            summary: input.summary ?? null,
            icon: input.icon,
            listed: input.listed,
            sortOrder: input.sortOrder,
          })
          .where(eq(packetGroups.id, input.id));
        void recordActivity({
          actorUserId: ctx.session.user.id,
          actorRole: "admin",
          action: "catalog.group_update",
          entityType: "packet_group",
          entityId: input.id,
          summary: `Packet group "${input.name}" updated`,
          ipAddress: ctx.clientIp,
        });
        return { ok: true as const, id: input.id };
      }

      const inserted = await db.insert(packetGroups).values({
        slug: input.slug,
        groupNumber: input.groupNumber,
        name: input.name,
        category: input.category,
        summary: input.summary ?? null,
        icon: input.icon,
        listed: input.listed,
        sortOrder: input.sortOrder,
      });
      const id = insertedId(inserted);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "catalog.group_create",
        entityType: "packet_group",
        entityId: id,
        summary: `Packet group "${input.name}" created`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, id };
    }),

  upsertProduct: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        packetGroupId: z.number().int().positive(),
        sku: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).max(64),
        name: z.string().trim().min(2).max(190),
        tier: z.enum(PRODUCT_TIERS),
        /** Price in whole dollars; converted to integer cents for storage. */
        priceDollars: z.number().min(0).max(1_000_000).nullable(),
        customPricing: z.boolean().default(false),
        deliveryEstimate: z.string().trim().min(2).max(96),
        outcome: z.string().trim().max(4000).optional(),
        description: z.string().trim().max(8000).optional(),
        listed: z.boolean().default(true),
        active: z.boolean().default(true),
        sortOrder: z.number().int().min(0).max(999).default(0),
        features: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(255),
              detail: z.string().trim().max(2000).optional(),
              inheritedFromTier: z.string().trim().max(24).optional(),
            }),
          )
          .max(60)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const priceCents =
        input.priceDollars === null ? null : Math.round(input.priceDollars * 100);

      const payload = {
        packetGroupId: input.packetGroupId,
        sku: input.sku,
        name: input.name,
        tier: input.tier,
        priceCents,
        customPricing: input.customPricing || priceCents === null,
        deliveryEstimate: input.deliveryEstimate,
        outcome: input.outcome ?? null,
        description: input.description ?? null,
        listed: input.listed,
        active: input.active,
        sortOrder: input.sortOrder,
      };

      let productId = input.id ?? 0;
      if (input.id) {
        await db.update(products).set(payload).where(eq(products.id, input.id));
      } else {
        const inserted = await db.insert(products).values(payload);
        productId = insertedId(inserted);
      }

      if (input.features) {
        await db.delete(productFeatures).where(eq(productFeatures.productId, productId));
        if (input.features.length > 0) {
          await db.insert(productFeatures).values(
            input.features.map((feature, index) => ({
              productId,
              label: feature.label,
              detail: feature.detail ?? null,
              inheritedFromTier: feature.inheritedFromTier ?? null,
              sortOrder: index,
            })),
          );
        }
      }

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: input.id ? "catalog.product_update" : "catalog.product_create",
        entityType: "product",
        entityId: productId,
        summary: `Product "${input.name}" ${input.id ? "updated" : "created"}`,
        changes: { priceCents, listed: input.listed, active: input.active },
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const, id: productId };
    }),

  setProductActive: adminProcedure
    .input(z.object({ productId: z.number().int().positive(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(products)
        .set({ active: input.active })
        .where(eq(products.id, input.productId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "catalog.product_toggle",
        entityType: "product",
        entityId: input.productId,
        summary: `Product ${input.active ? "activated" : "deactivated"}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Moderation and content                                            */
  /* ---------------------------------------------------------------- */

  pendingReviews: staffProcedure.query(async () => {
    const rows = await db
      .select()
      .from(reviews)
      .where(sql`${reviews.status} IN ('pending','flagged')`)
      .orderBy(asc(reviews.createdAt));

    const names = new Map<number, string>();
    for (const userId of new Set(rows.map((row) => row.userId))) {
      const user = await getUserById(userId);
      names.set(userId, user ? displayNameOf(user) : "Unknown");
    }

    return rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      title: row.title,
      body: row.body,
      displayName: row.displayName,
      author: names.get(row.userId) ?? "Unknown",
      orderId: row.orderId,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }),

  moderateReview: staffProcedure
    .input(
      z.object({
        reviewId: z.number().int().positive(),
        decision: z.enum(["approved", "rejected", "flagged"]),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .update(reviews)
        .set({
          status: input.decision,
          moderatedByUserId: ctx.session.user.id,
          moderationNote: input.note ?? null,
          publishedAt: input.decision === "approved" ? new Date() : null,
        })
        .where(eq(reviews.id, input.reviewId));

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "review.moderate",
        entityType: "review",
        entityId: input.reviewId,
        summary: `Review ${input.decision}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  moderateForumTopic: staffProcedure
    .input(
      z.object({
        topicId: z.number().int().positive(),
        action: z.enum(["pin", "unpin", "lock", "unlock", "delete", "restore"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Partial<typeof forumTopics.$inferInsert> = {};
      if (input.action === "pin") patch.pinned = true;
      if (input.action === "unpin") patch.pinned = false;
      if (input.action === "lock") patch.locked = true;
      if (input.action === "unlock") patch.locked = false;
      if (input.action === "delete") patch.deletedAt = new Date();
      if (input.action === "restore") patch.deletedAt = null;

      await db.update(forumTopics).set(patch).where(eq(forumTopics.id, input.topicId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "forum.moderate_topic",
        entityType: "forum_topic",
        entityId: input.topicId,
        summary: `Forum topic ${input.action}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  deleteForumPost: staffProcedure
    .input(z.object({ postId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(forumPosts)
        .set({ deletedAt: new Date() })
        .where(eq(forumPosts.id, input.postId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "forum.delete_post",
        entityType: "forum_post",
        entityId: input.postId,
        summary: "Forum reply removed by moderator",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  contactMessages: staffProcedure
    .input(
      z
        .object({
          status: z.enum(["new", "in_progress", "closed"]).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const conditions = input?.status ? [eq(contactMessages.status, input.status)] : [];
      const rows = await db
        .select()
        .from(contactMessages)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(contactMessages.createdAt))
        .limit(input?.limit ?? 50);

      return rows.map((row) => ({
        id: row.id,
        name: decryptField(row.nameEnc, "contact") ?? "",
        email: decryptField(row.emailEnc, "contact") ?? "",
        company: decryptField(row.companyEnc, "contact"),
        topic: row.topic,
        message: decryptField(row.messageEnc, "contact") ?? "",
        status: row.status,
        createdAt: row.createdAt,
      }));
    }),

  setContactStatus: staffProcedure
    .input(
      z.object({
        messageId: z.number().int().positive(),
        status: z.enum(["new", "in_progress", "closed"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .update(contactMessages)
        .set({ status: input.status, handledByUserId: ctx.session.user.id })
        .where(eq(contactMessages.id, input.messageId));
      return { ok: true as const };
    }),

  tickets: staffProcedure
    .input(
      z
        .object({
          status: z.string().trim().max(16).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const conditions = input?.status ? [eq(tickets.status, input.status)] : [];
      const rows = await db
        .select()
        .from(tickets)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tickets.createdAt))
        .limit(input?.limit ?? 50);

      const names = new Map<number, string>();
      for (const userId of new Set(rows.map((row) => row.userId))) {
        const user = await getUserById(userId);
        names.set(userId, user ? displayNameOf(user) : "Unknown");
      }

      return rows.map((row) => ({
        id: row.id,
        ticketNumber: row.ticketNumber,
        subject: decryptField(row.subjectEnc, `ticket:${row.id}`) ?? "",
        customer: names.get(row.userId) ?? "Unknown",
        category: row.category,
        status: row.status,
        priority: row.priority,
        createdAt: row.createdAt,
        lastReplyAt: row.lastReplyAt,
      }));
    }),

  updateTicket: staffProcedure
    .input(
      z.object({
        ticketId: z.number().int().positive(),
        status: z.enum(["open", "pending", "answered", "resolved", "closed"]).optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        assignedToUserId: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const patch: Partial<typeof tickets.$inferInsert> = {};
      if (input.status) {
        patch.status = input.status;
        if (input.status === "resolved" || input.status === "closed") {
          patch.resolvedAt = new Date();
        }
      }
      if (input.priority) patch.priority = input.priority;
      if (input.assignedToUserId !== undefined) patch.assignedToUserId = input.assignedToUserId;
      if (Object.keys(patch).length === 0) return { ok: true as const };
      await db.update(tickets).set(patch).where(eq(tickets.id, input.ticketId));
      return { ok: true as const };
    }),

  addInternalTicketNote: staffProcedure
    .input(
      z.object({
        ticketId: z.number().int().positive(),
        body: z.string().trim().min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const inserted = await db.insert(ticketReplies).values({
        ticketId: input.ticketId,
        authorUserId: ctx.session.user.id,
        bodyEnc: encryptField(input.body, "ticket_reply:pending") ?? "",
        internalOnly: true,
      });
      const replyId = insertedId(inserted);
      await db
        .update(ticketReplies)
        .set({ bodyEnc: encryptField(input.body, `ticket_reply:${replyId}`) ?? "" })
        .where(eq(ticketReplies.id, replyId));
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Site content                                                      */
  /* ---------------------------------------------------------------- */

  homeContent: adminProcedure.query(async () =>
    db.select().from(homeContentBlocks).orderBy(asc(homeContentBlocks.sortOrder)),
  ),

  updateHomeBlock: adminProcedure
    .input(
      z.object({
        blockKey: z.string().trim().max(64),
        heading: z.string().trim().max(190).nullable().optional(),
        subheading: z.string().trim().max(255).nullable().optional(),
        body: z.string().max(8000).nullable().optional(),
        linkLabel: z.string().trim().max(96).nullable().optional(),
        linkHref: z.string().trim().max(255).nullable().optional(),
        enabled: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(999).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { blockKey, ...rest } = input;
      const patch = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(patch).length === 0) return { ok: true as const };
      await db
        .update(homeContentBlocks)
        .set(patch as Partial<typeof homeContentBlocks.$inferInsert>)
        .where(eq(homeContentBlocks.blockKey, blockKey));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "cms.update_block",
        entityType: "home_content_block",
        entityId: blockKey,
        summary: `Home content block "${blockKey}" updated`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  changelog: adminProcedure.query(async () =>
    db.select().from(changelogEntries).orderBy(desc(changelogEntries.releasedAt)),
  ),

  createChangelogEntry: adminProcedure
    .input(
      z.object({
        version: z.string().trim().min(1).max(32),
        title: z.string().trim().min(3).max(190),
        bodyMarkdown: z.string().trim().min(10).max(20_000),
        entryType: z.enum(["feature", "improvement", "fix", "security"]).default("improvement"),
        isPublic: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const inserted = await db.insert(changelogEntries).values({
        version: input.version,
        title: input.title,
        bodyMarkdown: input.bodyMarkdown,
        entryType: input.entryType,
        isPublic: input.isPublic,
        createdByUserId: ctx.session.user.id,
      });
      const id = insertedId(inserted);
      await db.insert(changelogEntryVersions).values({
        changelogEntryId: id,
        revisionNumber: 1,
        version: input.version,
        title: input.title,
        bodyMarkdown: input.bodyMarkdown,
        entryType: input.entryType,
        isPublic: input.isPublic,
        changeKind: input.isPublic ? "published" : "draft",
        changedByUserId: ctx.session.user.id,
      });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: input.isPublic ? "changelog.publish" : "changelog.draft_created", entityType: "changelog_entry", entityId: id, severity: "notice", summary: `${input.isPublic ? "Published" : "Saved draft"} release ${input.version}: ${input.title}`, ipAddress: ctx.clientIp });
      return { ok: true as const, id };
    }),

  updateChangelogEntry: adminProcedure
    .input(z.object({ id: z.number().int().positive(), version: z.string().trim().min(1).max(32), title: z.string().trim().min(3).max(190), bodyMarkdown: z.string().trim().min(10).max(20_000), entryType: z.enum(["feature", "improvement", "fix", "security"]) }))
    .mutation(async ({ ctx, input }) => {
      const current = (await db.select().from(changelogEntries).where(eq(changelogEntries.id, input.id)).limit(1))[0];
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Release entry not found." });
      await db.update(changelogEntries).set({ version: input.version, title: input.title, bodyMarkdown: input.bodyMarkdown, entryType: input.entryType }).where(eq(changelogEntries.id, input.id));
      const previous = (await db.select({ revisionNumber: changelogEntryVersions.revisionNumber }).from(changelogEntryVersions).where(eq(changelogEntryVersions.changelogEntryId, input.id)).orderBy(desc(changelogEntryVersions.revisionNumber)).limit(1))[0];
      await db.insert(changelogEntryVersions).values({ changelogEntryId: input.id, revisionNumber: (previous?.revisionNumber ?? 0) + 1, version: input.version, title: input.title, bodyMarkdown: input.bodyMarkdown, entryType: input.entryType, isPublic: current.isPublic, changeKind: "edited", changedByUserId: ctx.session.user.id });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "changelog.updated", entityType: "changelog_entry", entityId: input.id, summary: `Updated release ${input.version}: ${input.title}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  setChangelogEntryPublication: adminProcedure
    .input(z.object({ id: z.number().int().positive(), isPublic: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const current = (await db.select().from(changelogEntries).where(eq(changelogEntries.id, input.id)).limit(1))[0];
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Release entry not found." });
      await db.update(changelogEntries).set({ isPublic: input.isPublic, ...(input.isPublic ? { releasedAt: new Date() } : {}) }).where(eq(changelogEntries.id, input.id));
      const previous = (await db.select({ revisionNumber: changelogEntryVersions.revisionNumber }).from(changelogEntryVersions).where(eq(changelogEntryVersions.changelogEntryId, input.id)).orderBy(desc(changelogEntryVersions.revisionNumber)).limit(1))[0];
      await db.insert(changelogEntryVersions).values({ changelogEntryId: input.id, revisionNumber: (previous?.revisionNumber ?? 0) + 1, version: current.version, title: current.title, bodyMarkdown: current.bodyMarkdown, entryType: current.entryType, isPublic: input.isPublic, changeKind: input.isPublic ? "published" : "unpublished", changedByUserId: ctx.session.user.id });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: input.isPublic ? "changelog.publish" : "changelog.unpublish", entityType: "changelog_entry", entityId: input.id, severity: "notice", summary: `${input.isPublic ? "Published" : "Unpublished"} release ${current.version}: ${current.title}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  changelogHistory: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => db.select().from(changelogEntryVersions).where(eq(changelogEntryVersions.changelogEntryId, input.id)).orderBy(desc(changelogEntryVersions.revisionNumber))),

  policies: adminProcedure.query(async () => {
    const documents = await db.select().from(policyDocuments).orderBy(asc(policyDocuments.id));
    const versions = await db
      .select()
      .from(policyVersions)
      .orderBy(desc(policyVersions.id));
    return documents.map((document) => ({
      ...document,
      versions: versions.filter((version) => version.policyId === document.id),
    }));
  }),

  publishPolicyVersion: adminProcedure
    .input(
      z.object({
        policyId: z.number().int().positive(),
        version: z.string().trim().min(1).max(24),
        effectiveDate: z.string().trim().min(4).max(32),
        bodyMarkdown: z.string().trim().min(50).max(200_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Publishing a new version supersedes the previous one atomically enough:
      // older versions stay readable for the acceptance audit trail.
      await db
        .update(policyVersions)
        .set({ published: false })
        .where(eq(policyVersions.policyId, input.policyId));
      const inserted = await db.insert(policyVersions).values({
        policyId: input.policyId,
        version: input.version,
        effectiveDate: input.effectiveDate,
        bodyMarkdown: input.bodyMarkdown,
        published: true,
        createdByUserId: ctx.session.user.id,
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "policy.publish",
        entityType: "policy_version",
        entityId: insertedId(inserted),
        severity: "notice",
        summary: `Policy version ${input.version} published`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  emailTemplates: adminProcedure.query(async () =>
    db.select().from(emailTemplates).orderBy(asc(emailTemplates.templateKey)),
  ),

  updateEmailTemplate: adminProcedure
    .input(
      z.object({
        templateKey: z.string().trim().max(64),
        subject: z.string().trim().min(3).max(255),
        bodyHtml: z.string().trim().min(10).max(100_000),
        bodyText: z.string().max(50_000).nullable().optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .update(emailTemplates)
        .set({
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          bodyText: input.bodyText ?? null,
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        })
        .where(eq(emailTemplates.templateKey, input.templateKey));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "email.template_update",
        entityType: "email_template",
        entityId: input.templateKey,
        summary: `Email template "${input.templateKey}" updated`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  cloneEmailTemplate: adminProcedure
    .input(z.object({ sourceTemplateKey: z.string().trim().max(64), templateKey: z.string().trim().regex(/^[a-z0-9_.-]+$/).max(64), name: z.string().trim().min(2).max(190) }))
    .mutation(async ({ ctx, input }) => {
      const source = (await db.select().from(emailTemplates).where(eq(emailTemplates.templateKey, input.sourceTemplateKey)).limit(1))[0];
      if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Source email template not found." });
      try {
        await db.insert(emailTemplates).values({ templateKey: input.templateKey, name: input.name, subject: source.subject, bodyHtml: source.bodyHtml, bodyText: source.bodyText, variables: source.variables, enabled: false });
      } catch {
        throw new TRPCError({ code: "CONFLICT", message: "That template key is already in use." });
      }
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "email.template_clone", entityType: "email_template", entityId: input.templateKey, summary: `Cloned email template ${input.sourceTemplateKey}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  emailAuditSettings: adminProcedure.query(async () => ({
    auditBcc: (await getSetting("email.audit_bcc")) ?? "",
    retentionDays: await getSettingNumber("email.retention_days", 365),
  })),

  updateEmailAuditSettings: adminProcedure
    .input(z.object({ auditBcc: z.union([z.literal(""), z.string().trim().email().max(255)]), retentionDays: z.number().int().min(7).max(3650) }))
    .mutation(async ({ ctx, input }) => {
      await Promise.all([
        setSetting("email.audit_bcc", input.auditBcc || null, { category: "email", isSecret: true, userId: ctx.session.user.id }),
        setSetting("email.retention_days", String(input.retentionDays), { category: "email", userId: ctx.session.user.id }),
      ]);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "email.audit_settings_update", entityType: "email_settings", entityId: "delivery_audit", summary: "Updated email BCC and retention settings", ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  emailDeliveryHistory: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const rows = await db.select().from(emailLog).orderBy(desc(emailLog.createdAt)).limit(input?.limit ?? 50);
      return rows.map((row) => ({
        id: row.id,
        templateKey: row.templateKey,
        subject: row.subject,
        status: row.status,
        detail: row.detail,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
        to: row.toAddressEnc ? decryptField(row.toAddressEnc, "email_log:to") : null,
        bcc: row.bccAddressEnc ? decryptField(row.bccAddressEnc, "email_log:bcc") : null,
        bodyHtml: row.bodyHtmlEnc ? decryptField(row.bodyHtmlEnc, "email_log:html") : null,
        bodyText: row.bodyTextEnc ? decryptField(row.bodyTextEnc, "email_log:text") : null,
      }));
    }),

  queuedEmails: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ input }) => {
      const rows = await db.select().from(emailQueue).orderBy(desc(emailQueue.createdAt)).limit(input.limit);
      return rows.map((row) => ({
        ...row,
        to: decryptField(row.toAddressEnc, "email:queue"),
      }));
    }),

  stopQueuedEmail: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const [message] = await db.select().from(emailQueue).where(eq(emailQueue.id, input.id)).limit(1);
      if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "Queued email not found." });
      if (message.status !== "pending") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Only an active queued delivery can be stopped." });
      await db.update(emailQueue).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(emailQueue.id, input.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "email.queue_stop", entityType: "email_queue", entityId: input.id, summary: `Stopped queued email ${input.id}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  retryQueuedEmail: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const [message] = await db.select().from(emailQueue).where(eq(emailQueue.id, input.id)).limit(1);
      if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "Queued email not found." });
      if (message.status === "sent") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A delivered email cannot be retried. Use resend instead." });
      await db.update(emailQueue).set({ status: "pending", attempts: 0, lastError: null, runAfter: new Date(), cancelledAt: null }).where(eq(emailQueue.id, input.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "email.queue_retry", entityType: "email_queue", entityId: input.id, summary: `Retried queued email ${input.id}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  resendQueuedEmail: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const [message] = await db.select().from(emailQueue).where(eq(emailQueue.id, input.id)).limit(1);
      if (!message) throw new TRPCError({ code: "NOT_FOUND", message: "Queued email not found." });
      const inserted = await db.insert(emailQueue).values({
        toAddressEnc: message.toAddressEnc,
        templateKey: message.templateKey,
        subject: message.subject,
        bodyHtml: message.bodyHtml,
        bodyText: message.bodyText,
        status: "pending",
        attempts: 0,
        runAfter: new Date(),
        sourceQueueId: message.id,
      });
      const id = insertedId(inserted);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "email.queue_resend", entityType: "email_queue", entityId: id, summary: `Resent email ${message.id} as queue item ${id}`, ipAddress: ctx.clientIp });
      return { ok: true as const, id };
    }),

  purgeEmailDeliveryHistory: adminProcedure
    .mutation(async ({ ctx }) => {
      const retentionDays = await getSettingNumber("email.retention_days", 365);
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
      const result = await db.delete(emailLog).where(sql`${emailLog.createdAt} < ${cutoff}`);
      const deleted = Number((result as { affectedRows?: number }).affectedRows ?? 0);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "email.delivery_history_purge", entityType: "email_log", entityId: "retention", summary: `Purged ${deleted} email delivery logs older than ${retentionDays} days`, ipAddress: ctx.clientIp });
      return { ok: true as const, deleted, retentionDays };
    }),

  registrationFields: adminProcedure.query(async () =>
    db.select().from(registrationFields).orderBy(asc(registrationFields.sortOrder)),
  ),

  upsertRegistrationField: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive().optional(),
        fieldKey: z.string().trim().regex(/^[a-z0-9_]+$/).max(64),
        label: z.string().trim().min(2).max(190),
        helpText: z.string().trim().max(255).optional(),
        fieldType: z.enum(["text", "textarea", "select", "checkbox", "tel", "url"]),
        options: z.array(z.string().trim().max(120)).max(40).optional(),
        required: z.boolean().default(false),
        enabled: z.boolean().default(true),
        sortOrder: z.number().int().min(0).max(999).default(0),
      }),
    )
    .mutation(async ({ input }) => {
      const payload = {
        fieldKey: input.fieldKey,
        label: input.label,
        helpText: input.helpText ?? null,
        fieldType: input.fieldType,
        options: input.options ?? null,
        required: input.required,
        enabled: input.enabled,
        sortOrder: input.sortOrder,
      };
      if (input.id) {
        await db.update(registrationFields).set(payload).where(eq(registrationFields.id, input.id));
        return { ok: true as const, id: input.id };
      }
      const inserted = await db.insert(registrationFields).values(payload);
      return {
        ok: true as const,
        id: insertedId(inserted),
      };
    }),

  /** CSV export of orders for finance reconciliation. */
  exportOrdersCsv: adminProcedure
    .input(
      z
        .object({
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .optional(),
    )
    .mutation(async ({ ctx, input }) => {
      const conditions = [isNull(orders.deletedAt)];
      if (input?.from) conditions.push(gte(orders.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(sql`${orders.createdAt} <= ${new Date(input.to)}`);

      const rows = await db
        .select({
          orderNumber: orders.orderNumber,
          userId: orders.userId,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          subtotalCents: orders.subtotalCents,
          discountCents: orders.discountCents,
          totalCents: orders.totalCents,
          bundleApplied: orders.bundleApplied,
          createdAt: orders.createdAt,
          deliveredAt: orders.deliveredAt,
        })
        .from(orders)
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt))
        .limit(10_000);

      const header = [
        "order_number",
        "customer_id",
        "status",
        "payment_status",
        "subtotal_usd",
        "discount_usd",
        "total_usd",
        "bundle_applied",
        "created_at",
        "delivered_at",
      ].join(",");

      const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
      const lines = rows.map((row) =>
        [
          escape(row.orderNumber),
          row.userId,
          escape(row.status),
          escape(row.paymentStatus),
          (row.subtotalCents / 100).toFixed(2),
          (row.discountCents / 100).toFixed(2),
          (row.totalCents / 100).toFixed(2),
          row.bundleApplied ? "yes" : "no",
          escape(row.createdAt.toISOString()),
          escape(row.deliveredAt?.toISOString() ?? ""),
        ].join(","),
      );

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "orders.export_csv",
        severity: "notice",
        summary: `Exported ${rows.length} orders to CSV`,
        ipAddress: ctx.clientIp,
      });

      return { filename: `readypackets-orders-${Date.now()}.csv`, csv: [header, ...lines].join("\n") };
    }),

  /** Directory of staff accounts, for ticket assignment menus. */
  staffDirectory: staffProcedure.query(async () => {
    const rows = await db
      .select()
      .from(users)
      .where(and(sql`${users.role} IN ('admin','staff')`, isNull(users.deletedAt)));
    return rows.map((row) => {
      const user = decryptUser(row);
      return { id: user.id, name: displayNameOf(user), role: user.role };
    });
  }),

  searchCustomerByEmail: staffProcedure
    .input(z.object({ email: z.string().trim().toLowerCase().email() }))
    .query(async ({ input }) => {
      const found = await searchUsers(input.email, 1);
      const user = found[0];
      return user ? { id: user.id, name: displayNameOf(user), email: user.email } : null;
    }),

  /**
   * Admin: manually generate a new temporary password for a customer.
   * The user's sessions are revoked and mustChangePassword is set.
   */
  adminResetPassword: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const user = await getUserById(input.userId);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      if (user.loginMethod !== "local") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Convert this single sign-on account to local sign-in before resetting its password." });
      }
      const temporary = `${randomToken(9)}Aa1!`;
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(temporary), mustChangePassword: true })
        .where(eq(users.id, input.userId));
      await revokeAllUserSessions(input.userId, "admin_password_reset");
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        message: `Admin manually reset password for user ${input.userId}`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { targetUserId: input.userId },
      });
      return { ok: true as const, temporaryPassword: temporary };
    }),

  /**
   * Convert one SSO account to local-only authentication without changing the
   * user's role, data, MFA enrolment, or customer/order access. The password is
   * generated server-side, shown once to the acting administrator, and must be
   * changed at the next sign-in. SAML is explicitly disabled for this identity
   * so a subsequent SSO assertion cannot silently switch it back.
   */
  convertSamlAccountToLocal: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), confirmation: z.literal("ENABLE LOCAL LOGIN") }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Use a different active administrator to convert your own sign-in method." });
      }
      const user = await getUserById(input.userId);
      if (!user || user.status !== "active") throw new TRPCError({ code: "NOT_FOUND", message: "Active user not found." });
      if (user.loginMethod !== "saml") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is already configured for local sign-in." });
      }

      const temporary = `${randomToken(9)}Aa1!`;
      await db
        .update(users)
        .set({
          passwordHash: await hashPassword(temporary),
          passwordChangedAt: new Date(),
          mustChangePassword: true,
          loginMethod: "local",
          samlLoginEnabled: false,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(and(eq(users.id, input.userId), isNull(users.deletedAt)));
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, input.userId), isNull(passwordResetTokens.usedAt)));
      await Promise.all([
        revokeAllUserSessions(input.userId, "saml_converted_to_local"),
        revokeMobileSessionsForUser(input.userId, "saml_converted_to_local"),
      ]);

      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        message: "Administrator converted SSO account to local-only sign-in",
        userId: input.userId,
        ipAddress: ctx.clientIp,
        metadata: { actorUserId: ctx.session.user.id, authenticationMethod: "local", samlLoginEnabled: false },
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "account.saml_converted_to_local",
        entityType: "user",
        entityId: input.userId,
        severity: "warning",
        summary: "Administrator converted an SSO account to local-only sign-in",
        changes: { authenticationMethod: "local", samlLoginEnabled: false, mustChangePassword: true },
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const, temporaryPassword: temporary };
    }),

  /**
   * Convert one verified local account to SAML-only authentication. This removes
   * the password verifier rather than retaining a dormant local credential,
   * preserves the account's role/data/MFA enrolment, and requires a separately
   * enabled SAML configuration that will validate the account's matching email.
   */
  convertLocalAccountToSaml: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), confirmation: z.literal("ENABLE ENTRA SSO") }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Use a different active administrator to convert your own sign-in method." });
      }
      const [user, activeSamlConfig] = await Promise.all([
        getUserById(input.userId),
        db.select({ id: samlConfigs.id }).from(samlConfigs).where(eq(samlConfigs.enabled, true)).limit(2),
      ]);
      if (!user || user.status !== "active") throw new TRPCError({ code: "NOT_FOUND", message: "Active user not found." });
      if (user.loginMethod !== "local") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account is already configured for single sign-on." });
      }
      if (!user.emailVerified) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Verify the account email before converting it to single sign-on." });
      }
      const samlConfig = activeSamlConfig[0];
      if (!samlConfig || activeSamlConfig.length !== 1) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Exactly one enabled and tested Microsoft Entra SSO configuration is required before converting an account." });
      }
      if (user.role === "admin") {
        const localAdminCandidates = await db
          .select({ id: users.id })
          .from(users)
          .where(and(
            eq(users.role, "admin"),
            eq(users.status, "active"),
            eq(users.loginMethod, "local"),
            eq(users.samlLoginEnabled, false),
            eq(users.emailVerified, true),
            isNotNull(users.passwordHash),
            isNull(users.deletedAt),
            ne(users.id, input.userId),
          ))
          .limit(50);
        const hasLocalBreakGlassAdministrator = (await Promise.all(localAdminCandidates.map((candidate) => hasConfirmedMfa(candidate.id)))).some(Boolean);
        if (!hasLocalBreakGlassAdministrator) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Keep a different active local-only administrator with confirmed MFA before converting an administrator to Microsoft Entra SSO." });
        }
      }

      await db
        .update(users)
        .set({
          passwordHash: null,
          passwordChangedAt: null,
          mustChangePassword: false,
          loginMethod: "saml",
          samlLoginEnabled: true,
          samlSubjectIndex: null,
          samlSubjectConfigId: null,
          failedLoginCount: 0,
          lockedUntil: null,
        })
        .where(and(eq(users.id, input.userId), isNull(users.deletedAt)));
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, input.userId), isNull(passwordResetTokens.usedAt)));
      await Promise.all([
        revokeAllUserSessions(input.userId, "local_converted_to_saml"),
        revokeMobileSessionsForUser(input.userId, "local_converted_to_saml"),
      ]);

      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        message: "Administrator converted local account to SAML single sign-on",
        userId: input.userId,
        ipAddress: ctx.clientIp,
        metadata: { actorUserId: ctx.session.user.id, authenticationMethod: "saml", samlConfigId: samlConfig.id, localPasswordRemoved: true },
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "account.local_converted_to_saml",
        entityType: "user",
        entityId: input.userId,
        severity: "warning",
        summary: "Administrator converted a local account to SAML single sign-on",
        changes: { authenticationMethod: "saml", samlLoginEnabled: true, localPasswordRemoved: true, samlConfigId: samlConfig.id },
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const };
    }),

  /**
   * Admin: send a password-reset link to the user's email address.
   */
  adminSendPasswordResetLink: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const user = await getUserById(input.userId);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      if (user.loginMethod !== "local") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "User does not use password login." });
      }
      const { env } = await import("../config/env.js");
      const { hashToken } = await import("../security/crypto.js");
      const { passwordResetTokens } = await import("../db/schema.js");
      const token = randomToken(32);
      await db.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        requestIp: ctx.clientIp.slice(0, 64),
      });
      const { env: envCfg } = await import("../config/env.js");
      const link = `${envCfg.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
      await queueTemplatedEmail({
        to: user.email,
        templateKey: "password_reset",
        variables: { name: displayNameOf(user), link, resetUrl: link, expiry: "24 hours" },
        fallback: {
          subject: "Reset your ReadyPackets password",
          html: wrapHtmlBody(
            "Reset your password",
            `<h1 style="margin:0 0 12px 0;font-size:20px;">Password reset requested</h1>
             <p style="margin:0 0 12px 0;">Hello ${displayNameOf(user)}, an administrator has initiated a password reset for your account.</p>
             <a href="${link}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Choose a new password</a>
             <p style="margin:12px 0 0;font-size:13px;">This link expires in 24 hours and can be used once.</p>`,
          ),
          text: `Reset your password: ${link}`,
        },
      });
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "notice",
        message: `Admin sent password reset link to user ${input.userId}`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { targetUserId: input.userId },
      });
      return { ok: true as const };
    }),

  /** Manually mark a customer's email as verified (bypasses the email link). */
  adminVerifyEmail: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, input.userId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "customer.verify_email",
        entityType: "user",
        entityId: input.userId,
        summary: "Administrator manually verified customer email address",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /** Validate an account for access: activate it and mark its email address verified. */
  adminValidateAccount: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(users)
        .set({ emailVerified: true, status: "active", lockedUntil: null, failedLoginCount: 0 })
        .where(eq(users.id, input.userId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "customer.account_validated",
        entityType: "user",
        entityId: input.userId,
        summary: "Administrator validated the customer account and email address",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Configurable order automation                                     */
  /* ---------------------------------------------------------------- */

  orderAutomationRules: adminProcedure.query(async () =>
    db.select().from(orderAutomationRules).orderBy(orderAutomationRules.sortOrder, orderAutomationRules.id),
  ),

  upsertOrderAutomationRule: adminProcedure
    .input(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(2).max(190),
      triggerType: z.enum(["order_status", "payment_status", "intake_submitted", "phase_started"]),
      triggerValue: z.string().trim().max(64).optional(),
      actionType: z.enum(["set_completion_percent", "send_email", "send_webhook"]).default("set_completion_percent"),
      completionPercent: z.number().int().min(0).max(100).optional(),
      emailTemplateKey: z.string().trim().min(1).max(64).optional(),
      webhookEndpointId: z.number().int().positive().optional(),
      isActive: z.boolean().default(true),
      sortOrder: z.number().int().min(0).default(0),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.actionType === "set_completion_percent" && input.completionPercent === undefined) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a completion percentage for this automation." });
      if (input.actionType === "send_email") {
        if (!input.emailTemplateKey) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an email template for this automation." });
        const [template] = await db.select({ templateKey: emailTemplates.templateKey }).from(emailTemplates).where(eq(emailTemplates.templateKey, input.emailTemplateKey)).limit(1);
        if (!template) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an email template from the Email Template Center." });
      }
      if (input.actionType === "send_webhook") {
        if (!input.webhookEndpointId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose an enabled webhook endpoint for this automation." });
        const [endpoint] = await db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(eq(webhookEndpoints.id, input.webhookEndpointId), eq(webhookEndpoints.enabled, true))).limit(1);
        if (!endpoint) throw new TRPCError({ code: "BAD_REQUEST", message: "The selected webhook endpoint is unavailable." });
      }
      const values = {
        name: input.name,
        triggerType: input.triggerType,
        triggerValue: input.triggerValue || null,
        actionType: input.actionType,
        completionPercent: input.actionType === "set_completion_percent" ? input.completionPercent ?? null : null,
        emailTemplateKey: input.actionType === "send_email" ? input.emailTemplateKey ?? null : null,
        webhookEndpointId: input.actionType === "send_webhook" ? input.webhookEndpointId ?? null : null,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      };
      if (input.id) {
        await db.update(orderAutomationRules).set(values).where(eq(orderAutomationRules.id, input.id));
        return { id: input.id };
      }
      const result = await db.insert(orderAutomationRules).values({ ...values, createdByUserId: ctx.session.user.id });
      return { id: insertedId(result) };
    }),

  deleteOrderAutomationRule: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(orderAutomationRules).where(eq(orderAutomationRules.id, input.id));
      return { ok: true as const };
    }),

  /** Create a new policy document (slug + title). Versions are added via publishPolicyVersion. */
  createPolicyDocument: adminProcedure
    .input(
      z.object({
        slug: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only."),
        title: z.string().trim().min(1).max(190),
        requiresAcceptance: z.boolean().default(true),
        isVisible: z.boolean().default(true),
        publicRoute: z.string().trim().max(96).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const inserted = await db.insert(policyDocuments).values({
        slug: input.slug,
        title: input.title,
        requiresAcceptance: input.requiresAcceptance,
        isVisible: input.isVisible,
        publicRoute: input.publicRoute ?? null,
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "policy.create",
        entityType: "policy_document",
        entityId: insertedId(inserted),
        summary: `Policy document "${input.title}" created`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, id: insertedId(inserted) };
    }),

  /** Change whether customers must accept the currently published policy version. */
  updatePolicyRequirement: adminProcedure
    .input(z.object({ policyId: z.number().int().positive(), requiresAcceptance: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(policyDocuments)
        .set({ requiresAcceptance: input.requiresAcceptance })
        .where(eq(policyDocuments.id, input.policyId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "policy.requirement_updated",
        entityType: "policy_document",
        entityId: input.policyId,
        summary: input.requiresAcceptance
          ? "Administrator marked policy acceptance as required"
          : "Administrator marked policy acceptance as optional",
        changes: { requiresAcceptance: input.requiresAcceptance },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /** Change whether a policy is visible on public/customer policy routes without changing its acceptance status. */
  updatePolicyVisibility: adminProcedure
    .input(z.object({ policyId: z.number().int().positive(), isVisible: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await db.update(policyDocuments).set({ isVisible: input.isVisible }).where(eq(policyDocuments.id, input.policyId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "policy.visibility_updated",
        entityType: "policy_document",
        entityId: input.policyId,
        summary: input.isVisible ? "Administrator made policy visible" : "Administrator hid policy from customer and public routes",
        changes: { isVisible: input.isVisible },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /** List all policy acceptances for a user. */
  policyAcceptances: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: policyAcceptances.id,
          policyVersionId: policyAcceptances.policyVersionId,
          acceptedAt: policyAcceptances.acceptedAt,
          ipAddress: policyAcceptances.ipAddress,
          version: policyVersions.version,
          effectiveDate: policyVersions.effectiveDate,
          policyTitle: policyDocuments.title,
          policySlug: policyDocuments.slug,
        })
        .from(policyAcceptances)
        .innerJoin(policyVersions, eq(policyAcceptances.policyVersionId, policyVersions.id))
        .innerJoin(policyDocuments, eq(policyVersions.policyId, policyDocuments.id))
        .where(eq(policyAcceptances.userId, input.userId))
        .orderBy(desc(policyAcceptances.acceptedAt));
      return rows;
    }),

  /** Searchable acceptance ledger for policy-audit operations. */
  policyAcceptanceGrid: adminProcedure
    .input(z.object({ search: z.string().trim().max(160).optional(), policyId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(250) }).optional())
    .query(async ({ input }) => {
      const conditions = input?.policyId ? [eq(policyDocuments.id, input.policyId)] : [];
      const rows = await db
        .select({
          id: policyAcceptances.id,
          acceptedAt: policyAcceptances.acceptedAt,
          ipAddress: policyAcceptances.ipAddress,
          policyId: policyDocuments.id,
          policyTitle: policyDocuments.title,
          policySlug: policyDocuments.slug,
          version: policyVersions.version,
          effectiveDate: policyVersions.effectiveDate,
          user: users,
        })
        .from(policyAcceptances)
        .innerJoin(policyVersions, eq(policyAcceptances.policyVersionId, policyVersions.id))
        .innerJoin(policyDocuments, eq(policyVersions.policyId, policyDocuments.id))
        .innerJoin(users, eq(policyAcceptances.userId, users.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(policyAcceptances.acceptedAt))
        .limit(input?.limit ?? 250);
      const needle = input?.search?.trim().toLowerCase() ?? "";
      return rows
        .map((row) => {
          const user = decryptUser(row.user);
          return {
            id: row.id,
            acceptedAt: row.acceptedAt,
            policyId: row.policyId,
            policyTitle: row.policyTitle,
            policySlug: row.policySlug,
            version: row.version,
            effectiveDate: row.effectiveDate,
            userId: user.id,
            userPublicId: user.publicId,
            userName: displayNameOf(user),
            userEmail: user.email,
          };
        })
        .filter((row) => !needle || [row.userName, row.userEmail, row.userPublicId ?? "", row.policyTitle, row.policySlug, row.version].some((value) => value.toLowerCase().includes(needle)));
    }),

  /** Domain-level signup analytics; no addresses are exposed. */
  signupDomains: adminProcedure.query(async () => {
    const rows = await db
      .select({ domain: users.emailDomain, total: count() })
      .from(users)
      .where(and(isNull(users.deletedAt), like(users.emailDomain, "%.%")))
      .groupBy(users.emailDomain)
      .orderBy(desc(count()))
      .limit(25);
    return rows.map((row) => ({ domain: row.domain, total: Number(row.total) }));
  }),
});
