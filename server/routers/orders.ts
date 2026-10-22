/**
 * Customer-facing order router.
 *
 * Every procedure resolves ownership through {@link assertOrderAccess} before
 * touching order data, and a caller who is not entitled to an order receives
 * "not found" rather than "forbidden", so ids cannot be probed.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  activityLogs,
  customerWorkspaceMembers,
  customerWorkspaces,
  files,
  orderAnswers,
  orderAnswerHistory,
  orderItems,
  orderNotes,
  orderQuestions,
  orderPhaseLocks,
  orderWorkflowAdvances,
  orderWorkflows,
  orderShares,
  orders,
  users,
} from "../db/schema.js";
import { decryptField, encryptField, emailIndex } from "../security/crypto.js";
import { recordActivity } from "../observability/audit.js";
import {
  OrderStateError,
  assertCustomerWorkflowStageAccess,
  assertOrderAccess,
  assertOrderWritableAccess,
  createOrder,
  getOrderDetail,
  getOrderWorkflowProgress,
  listOrdersForUser,
  syncOrderWorkflowProgress,
} from "../services/orders.js";
import { priceSelection } from "../services/catalog.js";
import { getOrderStatusOptions } from "../services/orderStatusConfig.js";
import { protectedProcedure, publicProcedure, router } from "../trpc/trpc.js";
import { insertedId } from "../db/result.js";
import { createOrderMessageReceipts } from "../services/orderMessages.js";

function toTrpcError(error: unknown): never {
  if (error instanceof OrderStateError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

const workflowParticipantRoles = new Set(["customer", "staff", "admin"]);

/**
 * A phase is an order-scoped action, not a customer-role-only action. Staff and
 * administrators may complete an authorized order phase on behalf of a customer,
 * but every actor must still pass writable-order and guided-stage checks below.
 */
function assertWorkflowParticipantRole(role: string): void {
  if (!workflowParticipantRoles.has(role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only authenticated customer, staff, or administrator accounts can complete a workflow phase." });
  }
}

function workflowActorLabel(role: string): string {
  if (role === "admin") return "Administrator";
  if (role === "staff") return "Staff member";
  return "Customer";
}

/** Customer-facing labels intentionally avoid exposing staff-only audit summaries. */
function customerOrderActivityLabel(action: string): string {
  const labels: Record<string, string> = {
    "order.activated_after_payment": "Payment confirmed and order opened",
    "order.admin_created": "Order created",
    "order.answer_question": "Clarification answer submitted",
    "order.automation_applied": "Order automation completed",
    "order.automation_email_queued": "Order email automation queued",
    "order.automation_webhook_queued": "Order webhook automation queued",
    "order.cancellation_requested": "Cancellation requested",
    "order.create": "Order created",
    "order.message_sent": "Message sent",
    "order.phase_advanced": "Workflow phase continued",
    "order.phase_kickoff_manual": "Order phase started",
    "order.phase_submitted": "Workflow phase submitted",
    "order.phase_unlocked": "Workflow phase reopened",
    "order.renamed": "Order title updated",
    "order.share": "Order sharing updated",
    "order.transition": "Order status updated",
    "order.update": "Order details updated",
    "order.workflow_assigned": "Order workflow updated",
  };
  return labels[action] ?? "Order activity recorded";
}

const selectionSchema = z
  .array(
    z.object({
      productId: z.number().int().positive(),
      quantity: z.number().int().min(1).max(10).default(1),
    }),
  )
  .min(1, "Select at least one packet.")
  .max(40);

export const ordersRouter = router({
  /** Live quote for the configurator; safe to call anonymously. */
  quote: publicProcedure
    .input(z.object({ selections: selectionSchema }))
    .query(async ({ input }) => priceSelection(input.selections)),

  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await listOrdersForUser(ctx.session.user.id);
    const labels = new Map((await getOrderStatusOptions()).map((option) => [option.key, option.label]));
    return rows.map((order) => ({ ...order, statusLabel: labels.get(order.status) ?? order.status.replaceAll("_", " ") }));
  }),

  checkoutDetail: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const orderRows = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          paymentStatus: orders.paymentStatus,
          subtotalCents: orders.subtotalCents,
          discountCents: orders.discountCents,
          totalCents: orders.totalCents,
        })
        .from(orders)
        .where(and(eq(orders.id, input.orderId), eq(orders.userId, ctx.session.user.id), isNull(orders.deletedAt)))
        .limit(1);
      const order = orderRows[0];
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      const items = await db
        .select({ id: orderItems.id, name: orderItems.name, tier: orderItems.tier, unitPriceCents: orderItems.unitPriceCents, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      return { order, items };
    }),

  detail: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        await assertOrderAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
        const detail = await getOrderDetail(input.orderId);

        const workflowRows = detail.order.workflowId
          ? await db
              .select({ id: orderWorkflows.id, name: orderWorkflows.name, description: orderWorkflows.description, customerPresentation: orderWorkflows.customerPresentation, stages: orderWorkflows.stages })
              .from(orderWorkflows)
              .where(eq(orderWorkflows.id, detail.order.workflowId))
              .limit(1)
          : [];

        const deliverables = await db
          .select({
            id: files.id,
            originalName: files.originalName,
            sizeBytes: files.sizeBytes,
            extension: files.extension,
            category: files.category,
            isPlaceholder: files.isPlaceholder,
            version: files.version,
            createdAt: files.createdAt,
          })
          .from(files)
          .where(
            and(
              eq(files.orderId, input.orderId),
              eq(files.visibleToCustomer, true),
              eq(files.category, "deliverable"),
              isNull(files.deletedAt),
            ),
          )
          .orderBy(desc(files.createdAt));

        const workflowProgress = await getOrderWorkflowProgress(input.orderId);
        const [phaseLocks, workflowAdvances] = await Promise.all([
          db
            .select({
              phaseKey: orderPhaseLocks.phaseKey,
              acknowledgementText: orderPhaseLocks.acknowledgementText,
              lockedAt: orderPhaseLocks.lockedAt,
            })
            .from(orderPhaseLocks)
            .where(and(eq(orderPhaseLocks.orderId, input.orderId), isNull(orderPhaseLocks.unlockedAt))),
          db
            .select({ phaseKey: orderWorkflowAdvances.phaseKey, advancedAt: orderWorkflowAdvances.advancedAt })
            .from(orderWorkflowAdvances)
            .where(eq(orderWorkflowAdvances.orderId, input.orderId)),
        ]);

        // Customers see shared notes only; internal notes never leave the admin panel.
        const notes = await db
          .select({
            id: orderNotes.id,
            bodyEnc: orderNotes.bodyEnc,
            createdAt: orderNotes.createdAt,
          })
          .from(orderNotes)
          .where(
            and(eq(orderNotes.orderId, input.orderId), eq(orderNotes.visibility, "shared")),
          )
          .orderBy(desc(orderNotes.createdAt));
        const activityHistory = await db
          .select({
            id: activityLogs.id,
            action: activityLogs.action,
            actorRole: activityLogs.actorRole,
            createdAt: activityLogs.createdAt,
          })
          .from(activityLogs)
          .where(and(eq(activityLogs.entityType, "order"), eq(activityLogs.entityId, String(input.orderId))))
          .orderBy(desc(activityLogs.createdAt))
          .limit(250);

        return {
          order: {
            id: detail.order.id,
            orderNumber: detail.order.orderNumber,
            status: detail.order.status,
            statusLabel: (await getOrderStatusOptions()).find((option) => option.key === detail.order.status)?.label ?? detail.order.status.replaceAll("_", " "),
            paymentStatus: detail.order.paymentStatus,
            projectName: detail.order.projectName,
            subtotalCents: detail.order.subtotalCents,
            discountCents: detail.order.discountCents,
            totalCents: detail.order.totalCents,
            bundleApplied: detail.order.bundleApplied,
            completionPercent: detail.order.completionPercent,
            integrityChoice: detail.order.integrityChoice,
            createdAt: detail.order.createdAt,
            dueAt: detail.order.dueAt,
            deliveredAt: detail.order.deliveredAt,
          },
          workflow: workflowRows[0] ?? null,
          workflowProgress,
          phaseLocks,
          workflowAdvances,
          items: detail.items.map((item) => ({
            id: item.id,
            sku: item.sku,
            name: item.name,
            tier: item.tier,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            lineTotalCents: item.lineTotalCents,
          })),
          history: {
            status: detail.history.map((entry) => ({
              id: entry.id,
              fromStatus: entry.fromStatus,
              toStatus: entry.toStatus,
              reason: entry.reason,
              createdAt: entry.createdAt,
            })),
            activity: activityHistory
              .filter((entry) => !["order.soft_delete", "order.restore", "order.permanently_purged", "order.bulk_soft_delete", "order.bulk_restore", "order.bulk_permanently_purged"].includes(entry.action))
              .map((entry) => ({
                id: entry.id,
                action: entry.action,
                actorRole: entry.actorRole,
                summary: customerOrderActivityLabel(entry.action),
                createdAt: entry.createdAt,
              })),
          },
          deliverables,
          notes: notes.map((note) => ({
            id: note.id,
            body: decryptField(note.bodyEnc, `order_note:${note.id}`) ?? "",
            createdAt: note.createdAt,
          })),
        };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  submitWorkflowPhase: protectedProcedure
    .input(z.object({
      orderId: z.number().int().positive(),
      phaseKey: z.string().trim().regex(/^[a-z0-9_]+$/).max(64),
      acknowledgementText: z.string().trim().min(10).max(2_000).optional(),
      acknowledged: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      assertWorkflowParticipantRole(ctx.session.user.role);
      try {
        await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
      } catch (error) {
        toTrpcError(error);
      }
      const legacyPhase = input.phaseKey === "phase_1" || input.phaseKey === "phase_2";
      if (!legacyPhase) {
        try {
          await assertCustomerWorkflowStageAccess(input.orderId, input.phaseKey);
        } catch (error) {
          toTrpcError(error);
        }
      }
      const [orderWorkflow] = await db.select({ workflowId: orders.workflowId }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
      const [workflow] = orderWorkflow?.workflowId ? await db.select({ stages: orderWorkflows.stages }).from(orderWorkflows).where(eq(orderWorkflows.id, orderWorkflow.workflowId)).limit(1) : [];
      const stages = Array.isArray(workflow?.stages) ? workflow.stages as { key?: unknown; customerAcknowledgement?: unknown; advanceMode?: unknown }[] : [];
      const configuredStage = stages.find((stage) => stage.key === input.phaseKey)
        ?? (input.phaseKey === "phase_1" ? stages.find((stage) => stage.key === "phase_1_intake") : undefined)
        ?? (input.phaseKey === "phase_2" ? stages.find((stage) => stage.key === "phase_2_synthesis") : undefined);
      if (configuredStage?.advanceMode === "next") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This workflow phase is configured to continue with Next and cannot be submitted as an irreversible lock." });
      }
      const configuredPolicy = configuredStage?.customerAcknowledgement;
      const acknowledgementPolicy = configuredPolicy === "none" || configuredPolicy === "optional" || configuredPolicy === "required" ? configuredPolicy : "required";
      if (acknowledgementPolicy === "required" && (!input.acknowledged || !input.acknowledgementText)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A phase acknowledgement is required before this phase can be submitted." });
      }
      const actorLabel = workflowActorLabel(ctx.session.user.role);
      const acknowledgementText = acknowledgementPolicy === "none" ? "Workflow acknowledgement was not required for this phase." : input.acknowledgementText ?? `${actorLabel} submitted this workflow phase without an optional acknowledgement.`;
      const existing = await db.select({ id: orderPhaseLocks.id, unlockedAt: orderPhaseLocks.unlockedAt }).from(orderPhaseLocks).where(and(eq(orderPhaseLocks.orderId, input.orderId), eq(orderPhaseLocks.phaseKey, input.phaseKey))).limit(1);
      if (existing[0] && !existing[0].unlockedAt) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This workflow phase is already locked." });
      }
      const lockedAt = new Date();
      if (existing[0]) {
        await db.update(orderPhaseLocks).set({ acknowledgementText, lockedByUserId: ctx.session.user.id, lockedAt, unlockedByUserId: null, unlockedAt: null, unlockReason: null }).where(eq(orderPhaseLocks.id, existing[0].id));
      } else {
        await db.insert(orderPhaseLocks).values({ orderId: input.orderId, phaseKey: input.phaseKey, acknowledgementText, lockedByUserId: ctx.session.user.id, lockedAt });
      }
      const workflowProgress = await syncOrderWorkflowProgress(input.orderId);
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: ctx.session.user.role, action: "order.phase_submitted", entityType: "order", entityId: input.orderId, summary: `${actorLabel} submitted and locked workflow phase ${input.phaseKey}`, changes: { phaseKey: input.phaseKey, acknowledgementPolicy, acknowledged: input.acknowledged, workflowProgress }, ipAddress: ctx.clientIp });
      return { ok: true as const, lockedAt, workflowProgress };
    }),

  advanceWorkflowStage: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive(), phaseKey: z.string().trim().regex(/^[a-z0-9_]+$/).max(64) }))
    .mutation(async ({ ctx, input }) => {
      assertWorkflowParticipantRole(ctx.session.user.role);
      try {
        await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
        const access = await assertCustomerWorkflowStageAccess(input.orderId, input.phaseKey);
        if (access.completed) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This workflow phase has already been completed." });
        }
        if (access.stage.advanceMode !== "next") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This workflow phase requires Submit and lock before the next phase can open." });
        }
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        toTrpcError(error);
      }
      const advancedAt = new Date();
      await db.insert(orderWorkflowAdvances).values({
        orderId: input.orderId,
        phaseKey: input.phaseKey,
        advancedByUserId: ctx.session.user.id,
        advancedAt,
      }).onDuplicateKeyUpdate({ set: { advancedByUserId: ctx.session.user.id, advancedAt } });
      const workflowProgress = await syncOrderWorkflowProgress(input.orderId);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.phase_advanced",
        entityType: "order",
        entityId: input.orderId,
        summary: `${workflowActorLabel(ctx.session.user.role)} continued from workflow phase ${input.phaseKey} without locking it`,
        changes: { phaseKey: input.phaseKey, advanceMode: "next", workflowProgress },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, advancedAt, workflowProgress };
    }),

  workflowStageAccess: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive(), phaseKey: z.string().trim().regex(/^[a-z0-9_]+$/).max(64) }))
    .query(async ({ ctx, input }) => {
      try {
        await assertOrderAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
        return await assertCustomerWorkflowStageAccess(input.orderId, input.phaseKey);
      } catch (error) {
        toTrpcError(error);
      }
    }),

  shares: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const owner = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, input.orderId), eq(orders.userId, ctx.session.user.id), isNull(orders.deletedAt))).limit(1);
      if (!owner[0] && ctx.session.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN", message: "Only the order owner can manage sharing." });
      const rows = await db.select({ id: orderShares.id, scope: orderShares.scope, createdAt: orderShares.createdAt, revokedAt: orderShares.revokedAt, userId: users.id, firstNameEnc: users.firstNameEnc, lastNameEnc: users.lastNameEnc, emailEnc: users.emailEnc, customerNumber: users.customerNumber }).from(orderShares).innerJoin(users, eq(users.id, orderShares.sharedWithUserId)).where(eq(orderShares.orderId, input.orderId));
      return rows.map((row) => ({ id: row.id, scope: row.scope, createdAt: row.createdAt, revokedAt: row.revokedAt, userId: row.userId, name: [decryptField(row.firstNameEnc, `user:${row.userId}:first_name`), decryptField(row.lastNameEnc, `user:${row.userId}:last_name`)].filter(Boolean).join(" ") || "Customer", email: decryptField(row.emailEnc, `user:${row.userId}:email`) ?? "", customerNumber: row.customerNumber }));
    }),

  share: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive(), email: z.string().trim().email(), scope: z.enum(["view", "upload_documents", "view_deliverables", "record_business_pitch", "contributor", "manager"]) }))
    .mutation(async ({ ctx, input }) => {
      try { await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role); } catch (error) { toTrpcError(error); }
      const owner = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, input.orderId), eq(orders.userId, ctx.session.user.id), isNull(orders.deletedAt))).limit(1);
      if (!owner[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Only the order owner can share this order." });
      const recipient = await db.select({ id: users.id, role: users.role, deletedAt: users.deletedAt }).from(users).where(eq(users.emailIndex, emailIndex(input.email))).limit(1);
      if (!recipient[0] || recipient[0].deletedAt || recipient[0].role !== "customer") throw new TRPCError({ code: "NOT_FOUND", message: "An active customer account with that email was not found." });
      if (recipient[0].id === ctx.session.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "You already own this order." });
      await db.insert(orderShares).values({ orderId: input.orderId, sharedWithUserId: recipient[0].id, scope: input.scope, createdByUserId: ctx.session.user.id }).onDuplicateKeyUpdate({ set: { scope: input.scope, revokedAt: null } });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "customer", action: "order.share", entityType: "order", entityId: input.orderId, summary: `Order shared with customer ${recipient[0].id} as ${input.scope}`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  workspaces: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db.select({ id: customerWorkspaces.id, name: customerWorkspaces.name, slug: customerWorkspaces.slug, ownerUserId: customerWorkspaces.ownerUserId, role: customerWorkspaceMembers.role }).from(customerWorkspaceMembers).innerJoin(customerWorkspaces, eq(customerWorkspaces.id, customerWorkspaceMembers.workspaceId)).where(and(eq(customerWorkspaceMembers.userId, ctx.session.user.id), isNull(customerWorkspaceMembers.revokedAt)));
    return rows;
  }),

  createWorkspace: protectedProcedure.input(z.object({ name: z.string().trim().min(2).max(190) })).mutation(async ({ ctx, input }) => {
    const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 72)}-${Math.random().toString(36).slice(2, 8)}`;
    const [result] = await db.insert(customerWorkspaces).values({ name: input.name, slug, ownerUserId: ctx.session.user.id });
    const workspaceId = insertedId(result);
    await db.insert(customerWorkspaceMembers).values({ workspaceId, userId: ctx.session.user.id, role: "owner", invitedByUserId: ctx.session.user.id });
    return { id: workspaceId, slug };
  }),

  addWorkspaceMember: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), email: z.string().trim().email(), role: z.enum(["manager", "contributor", "viewer"]).default("contributor") })).mutation(async ({ ctx, input }) => {
    const owner = await db.select({ id: customerWorkspaces.id }).from(customerWorkspaces).where(and(eq(customerWorkspaces.id, input.workspaceId), eq(customerWorkspaces.ownerUserId, ctx.session.user.id))).limit(1);
    if (!owner[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Only a Packet Collective owner can invite members." });
    const recipient = await db.select({ id: users.id }).from(users).where(and(eq(users.emailIndex, emailIndex(input.email)), isNull(users.deletedAt))).limit(1);
    if (!recipient[0]) throw new TRPCError({ code: "NOT_FOUND", message: "An active customer account with that email was not found." });
    await db.insert(customerWorkspaceMembers).values({ workspaceId: input.workspaceId, userId: recipient[0].id, role: input.role, invitedByUserId: ctx.session.user.id }).onDuplicateKeyUpdate({ set: { role: input.role, revokedAt: null } });
    return { ok: true as const };
  }),

  shareOrderWithWorkspace: protectedProcedure.input(z.object({ orderId: z.number().int().positive(), workspaceId: z.number().int().positive(), scope: z.enum(["view", "upload_documents", "view_deliverables", "record_business_pitch", "contributor", "manager"]).default("contributor") })).mutation(async ({ ctx, input }) => {
          try { await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role); } catch (error) { toTrpcError(error); }
      const owner = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, input.orderId), eq(orders.userId, ctx.session.user.id))).limit(1);
      const workspace = await db.select({ id: customerWorkspaces.id }).from(customerWorkspaces).where(and(eq(customerWorkspaces.id, input.workspaceId), eq(customerWorkspaces.ownerUserId, ctx.session.user.id))).limit(1);
    if (!owner[0] || !workspace[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Only the order owner and Packet Collective owner can share this order." });
    const members = await db.select({ userId: customerWorkspaceMembers.userId }).from(customerWorkspaceMembers).where(and(eq(customerWorkspaceMembers.workspaceId, input.workspaceId), isNull(customerWorkspaceMembers.revokedAt)));
    for (const member of members.filter((member) => member.userId !== ctx.session.user.id)) await db.insert(orderShares).values({ orderId: input.orderId, sharedWithUserId: member.userId, scope: input.scope, createdByUserId: ctx.session.user.id }).onDuplicateKeyUpdate({ set: { scope: input.scope, revokedAt: null } });
    return { ok: true as const, memberCount: members.length };
  }),

  revokeShare: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive(), shareId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      try { await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role); } catch (error) { toTrpcError(error); }
      const owner = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, input.orderId), eq(orders.userId, ctx.session.user.id))).limit(1);
      if (!owner[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Only the order owner can revoke sharing." });
      await db.update(orderShares).set({ revokedAt: new Date() }).where(and(eq(orderShares.id, input.shareId), eq(orderShares.orderId, input.orderId)));
      return { ok: true as const };
    }),

  rename: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive(), projectName: z.string().trim().min(1, "Enter an order title.").max(190) }))
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
        const rows = await db.select({ userId: orders.userId, projectNameEnc: orders.projectNameEnc }).from(orders).where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt))).limit(1);
        const order = rows[0];
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
        // A shared customer collaborator may work in an order, but cannot rename
        // the account owner's legal/commercial order reference. Administrators
        // retain the operational ability to correct it.
        if (ctx.session.user.role === "customer" && order.userId !== ctx.session.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the order owner can rename this order." });
        }
        const previousName = decryptField(order.projectNameEnc, `order:${input.orderId}`);
        if (previousName === input.projectName) return { ok: true as const, projectName: input.projectName };
        await db.update(orders).set({ projectNameEnc: encryptField(input.projectName, `order:${input.orderId}`) }).where(eq(orders.id, input.orderId));
        await recordActivity({
          actorUserId: ctx.session.user.id,
          actorRole: ctx.session.user.role,
          action: "order.renamed",
          entityType: "order",
          entityId: input.orderId,
          severity: "info",
          summary: `Order ${input.orderId} title updated`,
          // Do not place potentially sensitive commercial titles in an
          // unencrypted JSON audit column; the event remains fully attributable.
          changes: { renamed: true },
          ipAddress: ctx.clientIp,
        });
        return { ok: true as const, projectName: input.projectName };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  create: protectedProcedure
    .input(
      z.object({
        selections: selectionSchema,
        projectName: z.string().trim().min(1, "Enter an order or project name.").max(190),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await createOrder({
          userId: ctx.session.user.id,
          selections: input.selections,
          projectName: input.projectName,
          actorUserId: ctx.session.user.id,
          actorRole: ctx.session.user.role,
          ipAddress: ctx.clientIp,
        });
        return {
          orderId: result.orderId,
          orderNumber: result.orderNumber,
          totalCents: result.quote.totalCents,
          requiresCustomQuote: result.quote.requiresCustomQuote,
        };
      } catch (error) {
        toTrpcError(error);
      }
    }),

  /* ---------------------------------------------------------------- */
  /* Clarification questions raised by the analyst team               */
  /* ---------------------------------------------------------------- */

  questions: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        await assertOrderAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
        const questions = await db
          .select()
          .from(orderQuestions)
          .where(eq(orderQuestions.orderId, input.orderId))
          .orderBy(asc(orderQuestions.sortOrder), asc(orderQuestions.id));

        const answers = await db
          .select()
          .from(orderAnswers)
          .where(eq(orderAnswers.orderId, input.orderId));
        const answerByQuestion = new Map(answers.map((row) => [row.questionId, row]));

        return questions.map((question) => {
          const answer = answerByQuestion.get(question.id);
          return {
            id: question.id,
            question: decryptField(question.questionEnc, `order_question:${question.id}`) ?? "",
            phase: question.phase,
            required: question.required,
            status: question.status,
            answer: answer
              ? {
                  id: answer.id,
                  body: decryptField(answer.answerEnc, `order_answer:${answer.id}`) ?? "",
                  version: answer.version,
                  updatedAt: answer.updatedAt,
                }
              : null,
          };
        });
      } catch (error) {
        toTrpcError(error);
      }
    }),

  answerQuestion: protectedProcedure
    .input(
      z.object({
        questionId: z.number().int().positive(),
        body: z.string().trim().min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await db
        .select({ id: orderQuestions.id, orderId: orderQuestions.orderId, phase: orderQuestions.phase })
        .from(orderQuestions)
        .where(eq(orderQuestions.id, input.questionId))
        .limit(1);
      const question = rows[0];
      if (!question) throw new TRPCError({ code: "NOT_FOUND", message: "Question not found." });

      try {
        await assertOrderWritableAccess(question.orderId, ctx.session.user.id, ctx.session.user.role);
      } catch (error) {
        toTrpcError(error);
      }

      if (ctx.session.user.role === "customer" && question.phase) {
        try {
          await assertCustomerWorkflowStageAccess(question.orderId, question.phase === "phase_1" ? "phase_1_intake" : question.phase === "phase_2" ? "phase_2_synthesis" : question.phase);
        } catch (error) {
          toTrpcError(error);
        }
        const activeLocks = await db
          .select({ id: orderPhaseLocks.id })
          .from(orderPhaseLocks)
          .where(and(eq(orderPhaseLocks.orderId, question.orderId), eq(orderPhaseLocks.phaseKey, question.phase), isNull(orderPhaseLocks.unlockedAt)))
          .limit(1);
        if (activeLocks[0]) {
          throw new TRPCError({ code: "FORBIDDEN", message: "This workflow phase has been submitted and locked. Ask an administrator to unlock it before changing answers." });
        }
      }

      const existing = await db
        .select()
        .from(orderAnswers)
        .where(eq(orderAnswers.questionId, input.questionId))
        .limit(1);
      const previous = existing[0];

      if (previous) {
        // Edits are versioned rather than overwritten, so the trail is complete.
        await db.insert(orderAnswerHistory).values({
          answerId: previous.id,
          previousAnswerEnc: previous.answerEnc,
          version: previous.version,
          changedByUserId: ctx.session.user.id,
        });
        await db
          .update(orderAnswers)
          .set({
            answerEnc: encryptField(input.body, `order_answer:${previous.id}`) ?? "",
            version: previous.version + 1,
            answeredByUserId: ctx.session.user.id,
          })
          .where(eq(orderAnswers.id, previous.id));
      } else {
        const inserted = await db.insert(orderAnswers).values({
          questionId: input.questionId,
          orderId: question.orderId,
          answeredByUserId: ctx.session.user.id,
          answerEnc: encryptField(input.body, "order_answer:pending") ?? "",
        });
        const answerId = insertedId(inserted);
        await db
          .update(orderAnswers)
          .set({ answerEnc: encryptField(input.body, `order_answer:${answerId}`) ?? "" })
          .where(eq(orderAnswers.id, answerId));
      }

      await db
        .update(orderQuestions)
        .set({ status: "answered" })
        .where(eq(orderQuestions.id, input.questionId));

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.answer_question",
        entityType: "order",
        entityId: question.orderId,
        summary: `Customer answered clarification question ${input.questionId}`,
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const };
    }),

  /** Cancellation is a request, not an action: staff confirm and handle refunds. */
  requestCancellation: protectedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        reason: z.string().trim().min(10).max(2000),
        confirmation: z.literal("REQUEST CANCELLATION"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
      } catch (error) {
        toTrpcError(error);
      }

      const inserted = await db.insert(orderNotes).values({
        orderId: input.orderId,
        authorUserId: ctx.session.user.id,
        bodyEnc: encryptField(`Cancellation requested: ${input.reason}`, "order_note:pending") ?? "",
        visibility: "shared",
      });
      const noteId = insertedId(inserted);
      await db
        .update(orderNotes)
        .set({
          bodyEnc:
            encryptField(`Cancellation requested: ${input.reason}`, `order_note:${noteId}`) ?? "",
        })
        .where(eq(orderNotes.id, noteId));
      await createOrderMessageReceipts({
        orderId: input.orderId,
        orderNoteId: noteId,
        authorUserId: ctx.session.user.id,
        visibility: "shared",
      });

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.cancellation_requested",
        entityType: "order",
        entityId: input.orderId,
        severity: "notice",
        summary: "Customer requested cancellation",
        ipAddress: ctx.clientIp,
      });

      return { ok: true as const };
    }),

  addNote: protectedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        body: z.string().trim().min(1).max(5000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
      } catch (error) {
        toTrpcError(error);
      }
      const inserted = await db.insert(orderNotes).values({
        orderId: input.orderId,
        authorUserId: ctx.session.user.id,
        bodyEnc: encryptField(input.body, "order_note:pending") ?? "",
        visibility: "shared",
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
        visibility: "shared",
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "order.message_sent",
        entityType: "order",
        entityId: input.orderId,
        summary: "Customer sent a shared order message",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, noteId };
    }),

  /** Dashboard counters for the portal landing page. */
  summary: protectedProcedure.query(async ({ ctx }) => {
    const rows = await listOrdersForUser(ctx.session.user.id);
    const active = rows.filter(
      (row) => !["delivered", "closed", "cancelled", "refunded"].includes(row.status),
    ).length;
    const delivered = rows.filter((row) => row.status === "delivered" || row.status === "closed")
      .length;
    const awaitingPayment = rows.filter(
      (row) => row.paymentStatus === "unpaid" || row.paymentStatus === "awaiting_invoice",
    ).length;
    const awaitingTeamReview = rows.filter((row) => row.attention.state === "awaiting_staff_review").length;
    const awaitingYourResponse = rows.filter((row) => row.attention.state === "awaiting_customer_response").length;

    return { total: rows.length, active, delivered, awaitingPayment, awaitingTeamReview, awaitingYourResponse };
  }),
});
