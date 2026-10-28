/**
 * Order lifecycle service.
 *
 * The state machine is enforced here rather than in the UI. Two business gates
 * are non-negotiable: an order cannot leave Phase I until both the intake
 * submission and the MNDA acceptance exist, and it cannot be delivered until at
 * least one customer-visible deliverable is attached.
 */
import { randomInt } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  files,
  intakeSubmissions,
  mndaAcceptances,
  orderItems,
  orderPhaseLocks,
  orderWorkflowAdvances,
  orderQuestions,
  orderWorkflows,
  workflowStageRuns,
  workflowCompletionJobs,
  orderAutomationRules,
  orders,
  orderStatusHistory,
  webhookDeliveries,
  webhookEndpoints,
  orderShares,
  phaseJobs,
  phaseKickoffConfigs,
  users,
} from "../db/schema.js";
import { decryptField, encryptField, generateOrderNumber } from "../security/crypto.js";
import { logger } from "../observability/logger.js";
import { raiseAlert, recordActivity } from "../observability/audit.js";
import { priceSelection } from "./catalog.js";
import { fireAutomations } from "./emailAutomations.js";
import { queueFullOrderFolderProvisioning } from "./sharepoint.js";
import { queueTemplatedEmail } from "./email.js";
import { displayNameOf, getUserById } from "../db/users.js";
import { ORDER_TRANSITIONS, type OrderStatus } from "../../shared/domain.js";
import { assertActiveOrderStatus, isSystemOrderStatus, isTerminalOrderStatus } from "./orderStatusConfig.js";
import { insertedId } from "../db/result.js";
import { deriveCanonicalP101Scope, getPacketGroupNumbers } from "./orderScope.js";
import { getOrCreatePaidOrderInvoice, queueAutomaticCustomerInvoiceEmail } from "./invoices.js";
import {
  buildSharepointCustomerFolderName,
  buildSharepointOrderFolderName,
} from "./sharepointFolderNaming.js";

export class OrderStateError extends Error {}

export interface CreateOrderInput {
  userId: number;
  selections: { productId: number; quantity?: number }[];
  projectName: string;
  integrityChoice?: string | null;
  canonVersion?: string | null;
  runMode?: string | null;
  releaseStatus?: string | null;
  orderScopeMode?: string | null;
  bundleScopeManifest?: string | null;
  paymentRequirement?: "required" | "waived" | "test";
  manualPriceCents?: number | null;
  actorUserId: number;
  actorRole: string;
  ipAddress?: string | null;
}

export async function activatePaidOrder(orderId: number, activationSource: "stripe" | "admin_waiver" | "test" = "stripe"): Promise<void> {
  const rows = await db
    .select({ id: orders.id, userId: orders.userId, orderNumber: orders.orderNumber, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
    .limit(1);
  const order = rows[0];
  if (!order || order.paymentStatus !== "paid") return;

  // Test orders are intentionally usable without creating external side effects.
  // They never provision SharePoint or send payment/order automation messages.
  if (activationSource !== "test") {
    void queueFullOrderFolderProvisioning(orderId).catch((error) =>
      logger.warn("sharepoint.full_order_provisioning.queue_failed", { orderId, error: String(error) }),
    );
    void fireAutomations("order.created", { userId: order.userId });
    void fireAutomations("payment.succeeded", { userId: order.userId });
    void applyOrderAutomationRules(orderId, "payment_status", "paid").catch((error) =>
      logger.warn("order.payment_activation.automation_failed", { orderId, error: String(error) }),
    );
  }
  const invoice = await getOrCreatePaidOrderInvoice(orderId);
  // Stripe coupon evidence is finalized immediately after activation in the signed
  // webhook handler; defer that path's email until then. Administrator waivers
  // are already final and receive their receipt automatically. Test orders keep
  // their invoice for portal QA without emailing a simulated payment receipt.
  if (activationSource === "admin_waiver") {
    await queueAutomaticCustomerInvoiceEmail(orderId);
  }
  logger.info("invoice.paid_order_materialized", { orderId, invoiceNumber: invoice.invoiceNumber, activationSource });

  void recordActivity({
    actorUserId: null,
    actorRole: "system",
    action: "order.activated_after_payment",
    entityType: "order",
    entityId: orderId,
    summary: `Order ${order.orderNumber} activated after ${activationSource === "stripe" ? "Stripe-confirmed payment" : activationSource === "test" ? "administrator test-order approval" : "administrator payment waiver"}`,
    changes: { paymentStatus: "paid", activationSource },
  });
}

export async function createOrder(input: CreateOrderInput) {
  if (input.selections.length === 0) {
    throw new OrderStateError("Select at least one packet before placing an order.");
  }
  const projectName = input.projectName.trim();
  if (!projectName) {
    throw new OrderStateError("Enter an order or project name before placing an order.");
  }

  const quote = await priceSelection(input.selections);
  const paymentRequirement = input.paymentRequirement ?? "required";
  const manualPriceCents = input.manualPriceCents ?? null;
  if (manualPriceCents !== null && (!Number.isInteger(manualPriceCents) || manualPriceCents < 0 || manualPriceCents > 100_000_000)) {
    throw new OrderStateError("The administrator price must be a whole number of cents between $0.00 and $1,000,000.00.");
  }
  if (quote.lines.length === 0) {
    throw new OrderStateError("None of the selected packets are currently available.");
  }
  const packetGroups = new Set(quote.lines.map((line) => line.packetGroupId));
  if (packetGroups.size !== quote.lines.length) {
    throw new OrderStateError("Choose only one tier from each packet group.");
  }

  // Look up the customer's unique number to embed in the order ID.
  const customerRow = await db
    .select({ customerNumber: users.customerNumber })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  const customerNumber = customerRow[0]?.customerNumber ?? null;
  const customer = await getUserById(input.userId);
  const customerId = customerNumber ?? customer?.publicId ?? "RP-CUS-UNKNOWN";
  const orderNumber = generateOrderNumber(new Date(), customerNumber);
  const sharepointCustomerFolderName = buildSharepointCustomerFolderName({
    email: customer?.email ?? "customer",
    customerId,
  });
  const sharepointOrderFolderName = buildSharepointOrderFolderName({ projectName, orderNumber });
  const defaultWorkflow = await db.select({ id: orderWorkflows.id }).from(orderWorkflows).where(and(eq(orderWorkflows.isDefault, true), eq(orderWorkflows.active, true))).limit(1);
  const packetGroupNumbers = await getPacketGroupNumbers(quote.lines.map((line) => line.packetGroupId));
  const canonicalP101Scope = deriveCanonicalP101Scope(quote.lines, packetGroupNumbers);
  const inserted = await db.insert(orders).values({
    orderNumber,
    userId: input.userId,
    createdByOrigin: input.actorRole === "admin" || input.actorRole === "staff" ? "admin" : "customer",
    projectNameEnc: encryptField(projectName, "order:pending"),
    status: "new",
    paymentStatus: paymentRequirement === "required" ? (quote.requiresCustomQuote ? "awaiting_invoice" : "unpaid") : "paid",
    paymentRequirement,
    subtotalCents: manualPriceCents ?? quote.subtotalCents,
    discountCents: manualPriceCents === null ? quote.discountCents : 0,
    totalCents: manualPriceCents ?? quote.totalCents,
    priceSource: manualPriceCents === null ? "catalog" : "admin_manual",
    manualPriceCents,
    isTestOrder: paymentRequirement === "test",
    bundleApplied: quote.bundleApplied,
    integrityChoice: input.integrityChoice ?? null,
    canonVersion: input.canonVersion ?? null,
    runMode: input.runMode ?? null,
    releaseStatus: input.releaseStatus ?? null,
    // The P101 production contract is derived only from the purchased packet tiers.
    // Caller-supplied scope values cannot create contradictory routing metadata.
    orderScopeMode: canonicalP101Scope.orderScopeMode,
    bundleScopeManifest: canonicalP101Scope.bundleScopeManifest,
    workflowId: defaultWorkflow[0]?.id ?? null,
  });

  const orderId = insertedId(inserted);

  // Bind the required commercial title and external folder labels to this exact
  // order. Later display-name or identifier changes never move external files.
  await db
    .update(orders)
    .set({
      projectNameEnc: encryptField(projectName, `order:${orderId}`),
      sharepointCustomerFolderEnc: encryptField(sharepointCustomerFolderName, `order:${orderId}:sharepoint-customer-folder`),
      sharepointOrderFolderEnc: encryptField(sharepointOrderFolderName, `order:${orderId}:sharepoint-order-folder`),
    })
    .where(eq(orders.id, orderId));

  await db.insert(orderItems).values(
    quote.lines.map((line) => ({
      orderId,
      productId: line.productId,
      packetGroupId: line.packetGroupId,
      sku: line.sku,
      name: line.name,
      tier: line.tier,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      lineTotalCents: line.lineTotalCents,
    })),
  );

  await db.insert(orderStatusHistory).values({
    orderId,
    fromStatus: null,
    toStatus: "new",
    actorUserId: input.actorUserId,
    reason: "Order created",
  });

  void recordActivity({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "order.create",
    entityType: "order",
    entityId: orderId,
    summary: `Order ${orderNumber} created with ${quote.lines.length} packet(s)`,
    changes: {
      subtotalCents: quote.subtotalCents,
      discountCents: quote.discountCents,
      totalCents: quote.totalCents,
      bundleApplied: quote.bundleApplied,
    },
    ipAddress: input.ipAddress ?? null,
  });

  // Required-payment orders are checkout records, not active engagements. A
  // deliberate administrator waiver activates the order immediately; test orders
  // activate without any external provisioning or notification side effects.
  if (paymentRequirement !== "required") {
    await activatePaidOrder(orderId, paymentRequirement === "test" ? "test" : "admin_waiver");
  }

  return { orderId, orderNumber, quote: { ...quote, totalCents: manualPriceCents ?? quote.totalCents } };
}

/** Apply active admin-configured order actions for a lifecycle event. */
export async function applyOrderAutomationRules(
  orderId: number,
  triggerType: "order_status" | "payment_status" | "intake_submitted" | "phase_started",
  triggerValue?: string,
): Promise<void> {
  const rules = await db
    .select()
    .from(orderAutomationRules)
    .where(and(eq(orderAutomationRules.isActive, true), eq(orderAutomationRules.triggerType, triggerType)))
    .orderBy(orderAutomationRules.sortOrder);

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  const customer = await getUserById(order.userId);
  const projectName = order.projectNameEnc ? decryptField(order.projectNameEnc, `order:${order.id}`) : null;
  const variables = {
    name: customer ? displayNameOf(customer) : "Customer",
    email: customer?.email ?? "",
    orderNumber: order.orderNumber,
    orderId: order.id,
    projectName: projectName ?? "",
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
    automationEvent: triggerType,
    automationValue: triggerValue ?? "",
  };

  for (const rule of rules) {
    if (rule.triggerValue && rule.triggerValue !== (triggerValue ?? null)) continue;
    if (rule.actionType === "set_completion_percent" && rule.completionPercent !== null) {
      await db
        .update(orders)
        .set({ completionPercent: Math.max(0, Math.min(100, rule.completionPercent)) })
        .where(eq(orders.id, orderId));
      void recordActivity({
        actorUserId: null,
        actorRole: "system",
        action: "order.automation_applied",
        entityType: "order",
        entityId: orderId,
        summary: `Order automation \"${rule.name}\" set completion to ${rule.completionPercent}%`,
        changes: { ruleId: rule.id, triggerType, triggerValue: triggerValue ?? null, completionPercent: rule.completionPercent },
      });
    } else if (rule.actionType === "send_email" && rule.emailTemplateKey && customer?.email) {
      await queueTemplatedEmail({ to: customer.email, templateKey: rule.emailTemplateKey, variables });
      void recordActivity({
        actorUserId: null,
        actorRole: "system",
        action: "order.automation_email_queued",
        entityType: "order",
        entityId: orderId,
        summary: `Order automation \"${rule.name}\" queued email template ${rule.emailTemplateKey}`,
        changes: { ruleId: rule.id, triggerType, triggerValue: triggerValue ?? null, templateKey: rule.emailTemplateKey },
      });
    } else if (rule.actionType === "send_webhook" && rule.webhookEndpointId) {
      const [endpoint] = await db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(eq(webhookEndpoints.id, rule.webhookEndpointId), eq(webhookEndpoints.enabled, true))).limit(1);
      if (!endpoint) {
        logger.warn("order.automation.webhook_endpoint_unavailable", { orderId, ruleId: rule.id, endpointId: rule.webhookEndpointId });
        continue;
      }
      await db.insert(webhookDeliveries).values({
        endpointId: endpoint.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: customer ? displayNameOf(customer) : null,
        eventType: `order.${triggerType}`,
        payload: { orderId: order.id, orderNumber: order.orderNumber, customerId: order.userId, projectName, status: order.status, paymentStatus: order.paymentStatus, triggerType, triggerValue: triggerValue ?? null, ruleId: rule.id, occurredAt: new Date().toISOString() },
        status: "pending",
        attempts: 0,
      });
      void recordActivity({
        actorUserId: null,
        actorRole: "system",
        action: "order.automation_webhook_queued",
        entityType: "order",
        entityId: orderId,
        summary: `Order automation \"${rule.name}\" queued webhook endpoint ${endpoint.id}`,
        changes: { ruleId: rule.id, triggerType, triggerValue: triggerValue ?? null, endpointId: endpoint.id },
      });
    }
  }
}

type WorkflowProgressStage = {
  key?: unknown;
  label?: unknown;
  order?: unknown;
  capabilities?: unknown;
  advanceMode?: unknown;
  customerMessage?: unknown;
};
type CustomerWorkflowProgressStage = {
  key: string;
  label: string;
  order: number;
  capabilities: unknown[];
  advanceMode: "next" | "submit_lock";
};

export type WorkflowProgress = {
  totalStages: number;
  completedStages: number;
  completionPercent: number;
  currentStageKey: string | null;
  currentStageLabel: string | null;
};

function hasCustomerMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const bodyMarkdown = (value as Record<string, unknown>).bodyMarkdown;
  return typeof bodyMarkdown === "string" && bodyMarkdown.trim().length > 0;
}

/**
 * A paid order has satisfied the workflow's automatic payment-confirmation stage
 * even though that system event does not create a customer phase lock. A customer
 * choosing Next records a separate completed transition; only Submit and lock
 * creates an immutable phase lock. Historical Phase 1/2 lock aliases persist.
 */
function isStageComplete(
  stageKey: string,
  lockedKeys: Set<string>,
  advancedKeys: Set<string>,
  paymentStatus?: string,
): boolean {
  if (advancedKeys.has(stageKey) || lockedKeys.has(stageKey)) return true;
  if (stageKey === "phase_1_intake") return lockedKeys.has("phase_1");
  if (stageKey === "phase_2_synthesis") return lockedKeys.has("phase_2");
  if (stageKey === "new") return paymentStatus === "paid" || paymentStatus === "partially_refunded" || paymentStatus === "refunded";
  return false;
}

function normalizeCustomerWorkflowStages(rawStages: unknown): CustomerWorkflowProgressStage[] {
  if (!Array.isArray(rawStages)) return [];
  return (rawStages as WorkflowProgressStage[])
    .filter((stage): stage is WorkflowProgressStage & { key: string } =>
      typeof stage?.key === "string" &&
      (Array.isArray(stage.capabilities) && stage.capabilities.length > 0 || hasCustomerMessage(stage.customerMessage)),
    )
    .map((stage, index) => ({
      key: stage.key,
      label: typeof stage.label === "string" ? stage.label : stage.key.replaceAll("_", " "),
      order: typeof stage.order === "number" ? stage.order : index + 1,
      capabilities: Array.isArray(stage.capabilities) ? stage.capabilities : [],
      advanceMode: (stage.advanceMode === "next" ? "next" : "submit_lock") as "next" | "submit_lock",
    }))
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}

/** Calculates customer-completed workflow stages without relying on browser state. */
export async function getOrderWorkflowProgress(orderId: number): Promise<WorkflowProgress | null> {
  const orderRows = await db.select({ workflowId: orders.workflowId, paymentStatus: orders.paymentStatus }).from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).limit(1);
  const order = orderRows[0];
  if (!order?.workflowId) return null;
  const workflowRows = await db.select({ stages: orderWorkflows.stages }).from(orderWorkflows).where(eq(orderWorkflows.id, order.workflowId)).limit(1);
  const stages = normalizeCustomerWorkflowStages(workflowRows[0]?.stages);
  if (stages.length === 0) return null;
  const [locks, advances] = await Promise.all([
    db.select({ phaseKey: orderPhaseLocks.phaseKey }).from(orderPhaseLocks).where(and(eq(orderPhaseLocks.orderId, orderId), isNull(orderPhaseLocks.unlockedAt))),
    db.select({ phaseKey: orderWorkflowAdvances.phaseKey }).from(orderWorkflowAdvances).where(eq(orderWorkflowAdvances.orderId, orderId)),
  ]);
  const lockedKeys = new Set(locks.map((lock) => lock.phaseKey));
  const advancedKeys = new Set(advances.map((advance) => advance.phaseKey));
  const completedStages = stages.filter((stage) => isStageComplete(stage.key, lockedKeys, advancedKeys, order.paymentStatus)).length;
  const currentStage = stages.find((stage) => !isStageComplete(stage.key, lockedKeys, advancedKeys, order.paymentStatus)) ?? null;
  return {
    totalStages: stages.length,
    completedStages,
    completionPercent: Math.round((completedStages / stages.length) * 100),
    currentStageKey: currentStage?.key ?? null,
    currentStageLabel: currentStage?.label ?? null,
  };
}

/** Updates the dashboard/list progress when a customer finishes any workflow stage. */
export async function syncOrderWorkflowProgress(orderId: number): Promise<WorkflowProgress | null> {
  const progress = await getOrderWorkflowProgress(orderId);
  if (!progress) return null;
  const rows = await db.select({ completionPercent: orders.completionPercent }).from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).limit(1);
  const current = rows[0]?.completionPercent;
  if (current === undefined) return progress;
  const next = Math.max(current, progress.completionPercent);
  if (next !== current) await db.update(orders).set({ completionPercent: next }).where(eq(orders.id, orderId));
  return { ...progress, completionPercent: next };
}

export interface CustomerWorkflowStage {
  key: string;
  label: string;
  order: number;
  capabilities: unknown[];
  advanceMode: "next" | "submit_lock";
}

/** Resolves the current stage and prevents customers from working ahead in a guided workflow. */
export async function assertCustomerWorkflowStageAccess(orderId: number, stageKey: string): Promise<{ stage: CustomerWorkflowStage; currentStageKey: string | null; completed: boolean }> {
  const [order] = await db.select({ workflowId: orders.workflowId, paymentStatus: orders.paymentStatus }).from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).limit(1);
  if (!order?.workflowId) throw new OrderStateError("This order does not have an assigned workflow.");
  const [workflow] = await db.select({ stages: orderWorkflows.stages, customerPresentation: orderWorkflows.customerPresentation }).from(orderWorkflows).where(eq(orderWorkflows.id, order.workflowId)).limit(1);
  const stages = normalizeCustomerWorkflowStages(workflow?.stages);
  const stage = stages.find((candidate) => candidate.key === stageKey);
  if (!stage) throw new OrderStateError("This phase is not part of the assigned workflow.");
  const [locks, advances] = await Promise.all([
    db.select({ phaseKey: orderPhaseLocks.phaseKey }).from(orderPhaseLocks).where(and(eq(orderPhaseLocks.orderId, orderId), isNull(orderPhaseLocks.unlockedAt))),
    db.select({ phaseKey: orderWorkflowAdvances.phaseKey }).from(orderWorkflowAdvances).where(eq(orderWorkflowAdvances.orderId, orderId)),
  ]);
  const lockedKeys = new Set(locks.map((lock) => lock.phaseKey));
  const advancedKeys = new Set(advances.map((advance) => advance.phaseKey));
  const completed = isStageComplete(stage.key, lockedKeys, advancedKeys, order.paymentStatus);
  const current = stages.find((candidate) => !isStageComplete(candidate.key, lockedKeys, advancedKeys, order.paymentStatus));
  // Wizard presentation is enforced server side rather than trusting route visibility.
  if (workflow?.customerPresentation === "wizard" && !completed && current && current.key !== stage.key) {
    throw new OrderStateError(`Complete ${current.label} before opening ${stage.label}.`);
  }
  return { stage, currentStageKey: current?.key ?? null, completed };
}

export type WorkflowStageActionConfig = {
  emailTemplateKey?: string;
  adminAlert?: { enabled?: boolean; message?: string; severity?: "warning" | "error" | "critical" };
  orderStatus?: string;
  /** Legacy/static completion target. A missing completionMode is treated as fixed. */
  completionPercent?: number;
  completionMode?: "fixed" | "random";
  completionRangeMin?: number;
  completionRangeMax?: number;
  completionDelayMinutes?: number;
  webhookEndpointId?: number;
};

type ResolvedCompletionPolicy = {
  mode: "fixed" | "random";
  minPercent: number;
  maxPercent: number;
  delayMinutes: number;
};

function resolveCompletionPolicy(actions: WorkflowStageActionConfig): ResolvedCompletionPolicy | null {
  const mode = actions.completionMode ?? (actions.completionPercent !== undefined ? "fixed" : undefined);
  if (!mode) return null;
  const delayMinutes = Math.max(0, Math.min(43_200, Math.round(actions.completionDelayMinutes ?? 0)));
  if (mode === "fixed") {
    if (!Number.isInteger(actions.completionPercent) || actions.completionPercent! < 0 || actions.completionPercent! > 100) return null;
    return { mode, minPercent: actions.completionPercent!, maxPercent: actions.completionPercent!, delayMinutes };
  }
  if (!Number.isInteger(actions.completionRangeMin) || !Number.isInteger(actions.completionRangeMax)) return null;
  const minPercent = actions.completionRangeMin!;
  const maxPercent = actions.completionRangeMax!;
  if (minPercent < 0 || maxPercent > 100 || minPercent > maxPercent) return null;
  return { mode, minPercent, maxPercent, delayMinutes };
}

function chooseCompletionTarget(policy: ResolvedCompletionPolicy): number {
  return policy.mode === "random" ? randomInt(policy.minPercent, policy.maxPercent + 1) : policy.minPercent;
}

/** Execute the configured actions for an assigned workflow stage. Every request is recorded. */
export async function runWorkflowStageActions(input: {
  orderId: number;
  stageKey: string;
  actorUserId: number;
  actorRole: string;
  ipAddress?: string | null;
}) {
  const [order] = await db.select().from(orders).where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt))).limit(1);
  if (!order?.workflowId) throw new OrderStateError("Assign a workflow before running stage actions.");
  const [workflow] = await db.select().from(orderWorkflows).where(eq(orderWorkflows.id, order.workflowId)).limit(1);
  if (!workflow) throw new OrderStateError("Assigned workflow not found.");
  const stages = Array.isArray(workflow.stages) ? workflow.stages as Array<{ key?: string; label?: string; actions?: WorkflowStageActionConfig }> : [];
  const stage = stages.find((candidate) => candidate.key === input.stageKey);
  if (!stage) throw new OrderStateError("This phase is not part of the assigned workflow.");
  const actions = stage.actions ?? {};
  const run = await db.insert(workflowStageRuns).values({
    orderId: order.id,
    workflowId: workflow.id,
    stageKey: input.stageKey,
    actions,
    status: "running",
    startedByUserId: input.actorUserId,
  });
  const runId = insertedId(run);
  const executed: string[] = [];
  try {
    const customer = await getUserById(order.userId);
    const projectName = order.projectNameEnc ? decryptField(order.projectNameEnc, `order:${order.id}`) : null;
    const variables = {
      name: customer ? displayNameOf(customer) : "Customer",
      email: customer?.email ?? "",
      orderNumber: order.orderNumber,
      orderId: order.id,
      projectName: projectName ?? "",
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      workflowStage: stage.label ?? input.stageKey,
    };

    if (actions.orderStatus && actions.orderStatus !== order.status) {
      await transitionOrder({ orderId: order.id, to: actions.orderStatus, actorUserId: input.actorUserId, actorRole: input.actorRole, reason: `Workflow stage ${stage.label ?? input.stageKey} action`, ipAddress: input.ipAddress });
      executed.push(`status:${actions.orderStatus}`);
    }
    const completionPolicy = resolveCompletionPolicy(actions);
    if (completionPolicy) {
      const targetPercent = chooseCompletionTarget(completionPolicy);
      if (completionPolicy.delayMinutes === 0) {
        await db.update(orders).set({ completionPercent: targetPercent }).where(eq(orders.id, order.id));
        executed.push(`completion:${completionPolicy.mode}:${targetPercent}:immediate`);
      } else {
        const runAfter = new Date(Date.now() + completionPolicy.delayMinutes * 60_000);
        const result = await db.insert(workflowCompletionJobs).values({
          orderId: order.id,
          workflowId: workflow.id,
          stageKey: input.stageKey,
          mode: completionPolicy.mode,
          minPercent: completionPolicy.minPercent,
          maxPercent: completionPolicy.maxPercent,
          targetPercent,
          delayMinutes: completionPolicy.delayMinutes,
          runAfter,
          status: "pending",
          scheduledByUserId: input.actorUserId,
        });
        executed.push(`completion:${completionPolicy.mode}:${targetPercent}:delayed:${completionPolicy.delayMinutes}m:job:${insertedId(result)}`);
      }
    }
    if (actions.emailTemplateKey && customer?.email) {
      await queueTemplatedEmail({ to: customer.email, templateKey: actions.emailTemplateKey, variables });
      executed.push(`email:${actions.emailTemplateKey}`);
    }
    if (actions.adminAlert?.enabled) {
      await raiseAlert({
        alertKey: `workflow-stage-${order.id}-${workflow.id}-${input.stageKey}`,
        severity: actions.adminAlert.severity ?? "warning",
        source: "workflow",
        message: actions.adminAlert.message?.trim() || `Workflow stage ${stage.label ?? input.stageKey} action run for ${order.orderNumber}`,
        detail: `Order ${order.orderNumber}; workflow ${workflow.name}; stage ${stage.label ?? input.stageKey}.`,
      });
      executed.push("admin-alert");
    }
    if (actions.webhookEndpointId) {
      const [endpoint] = await db.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(eq(webhookEndpoints.id, actions.webhookEndpointId), eq(webhookEndpoints.enabled, true))).limit(1);
      if (!endpoint) throw new OrderStateError("The configured webhook endpoint is unavailable.");
      await db.insert(webhookDeliveries).values({
        endpointId: endpoint.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: customer ? displayNameOf(customer) : null,
        eventType: "workflow.stage_action",
        payload: { orderId: order.id, orderNumber: order.orderNumber, customerId: order.userId, workflowId: workflow.id, workflowName: workflow.name, stageKey: input.stageKey, stageLabel: stage.label ?? input.stageKey, actions, occurredAt: new Date().toISOString() },
        status: "pending",
        attempts: 0,
      });
      executed.push(`webhook:${endpoint.id}`);
    }
    await db.update(workflowStageRuns).set({ actions: { configured: actions, executed }, status: "completed", completedAt: new Date() }).where(eq(workflowStageRuns.id, runId));
    await recordActivity({ actorUserId: input.actorUserId, actorRole: input.actorRole, action: "workflow.stage_actions_run", entityType: "order", entityId: order.id, summary: `Ran ${executed.length} workflow action(s) for ${stage.label ?? input.stageKey}`, changes: { workflowId: workflow.id, stageKey: input.stageKey, executed }, ipAddress: input.ipAddress });
    return { runId, executed };
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : "Workflow stage actions failed.";
    await db.update(workflowStageRuns).set({ status: "failed", errorDetail: errorDetail.slice(0, 1000), completedAt: new Date() }).where(eq(workflowStageRuns.id, runId));
    throw error;
  }
}

/** Apply due delayed completion policies. The stored target makes random selection auditable and restart-safe. */
export async function processWorkflowCompletionJobs(limit = 25): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(Date.now() - 5 * 60_000);
  await db
    .update(workflowCompletionJobs)
    .set({ status: "pending", claimedAt: null, runAfter: now })
    .where(and(eq(workflowCompletionJobs.status, "running"), lte(workflowCompletionJobs.claimedAt, staleBefore)));
  const jobs = await db
    .select()
    .from(workflowCompletionJobs)
    .where(and(eq(workflowCompletionJobs.status, "pending"), lte(workflowCompletionJobs.runAfter, now)))
    .orderBy(workflowCompletionJobs.runAfter)
    .limit(Math.max(1, Math.min(100, limit)));

  for (const job of jobs) {
    const claim = await db
      .update(workflowCompletionJobs)
      .set({ status: "running", claimedAt: now, attempts: job.attempts + 1 })
      .where(and(eq(workflowCompletionJobs.id, job.id), eq(workflowCompletionJobs.status, "pending")));
    if (Number((claim as { affectedRows?: number }).affectedRows ?? 0) === 0) continue;

    try {
      const [order] = await db
        .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, completionPercent: orders.completionPercent })
        .from(orders)
        .where(and(eq(orders.id, job.orderId), isNull(orders.deletedAt)))
        .limit(1);
      if (!order || isTerminalOrderStatus(order.status)) {
        await db.update(workflowCompletionJobs).set({ status: "cancelled", claimedAt: null, completedAt: new Date(), lastError: order ? `Order is in terminal status ${order.status}.` : "Order is unavailable." }).where(eq(workflowCompletionJobs.id, job.id));
        continue;
      }

      const appliedPercent = Math.max(order.completionPercent, job.targetPercent);
      if (appliedPercent !== order.completionPercent) {
        await db.update(orders).set({ completionPercent: appliedPercent }).where(eq(orders.id, order.id));
      }
      await db.update(workflowCompletionJobs).set({ status: "completed", claimedAt: null, completedAt: new Date(), lastError: null }).where(eq(workflowCompletionJobs.id, job.id));
      void recordActivity({
        actorUserId: null,
        actorRole: "system",
        action: "workflow.completion_policy_applied",
        entityType: "order",
        entityId: order.id,
        summary: `Applied delayed ${job.mode} workflow completion policy to ${order.orderNumber}: ${appliedPercent}%`,
        changes: { jobId: job.id, workflowId: job.workflowId, stageKey: job.stageKey, mode: job.mode, minPercent: job.minPercent, maxPercent: job.maxPercent, targetPercent: job.targetPercent, priorPercent: order.completionPercent, appliedPercent, delayMinutes: job.delayMinutes },
      });
    } catch (error) {
      const errorDetail = error instanceof Error ? error.message : String(error);
      const permanentlyFailed = job.attempts + 1 >= 5;
      await db.update(workflowCompletionJobs).set({
        status: permanentlyFailed ? "failed" : "pending",
        claimedAt: null,
        lastError: errorDetail.slice(0, 1_000),
        runAfter: permanentlyFailed ? job.runAfter : new Date(Date.now() + Math.min(60, (job.attempts + 1) * 5) * 60_000),
        completedAt: permanentlyFailed ? new Date() : null,
      }).where(eq(workflowCompletionJobs.id, job.id));
      if (permanentlyFailed) {
        void raiseAlert({
          alertKey: `workflow-completion-job-${job.id}`,
          severity: "error",
          source: "workflow",
          message: `Workflow completion update for order ${job.orderId} failed permanently`,
          detail: errorDetail.slice(0, 1_000),
        });
      }
    }
  }
}

export interface TransitionInput {
  orderId: number;
  to: string;
  actorUserId: number;
  actorRole: string;
  reason?: string;
  ipAddress?: string | null;
}

async function assertPhaseOneComplete(orderId: number): Promise<void> {
  const intake = await db
    .select({ submittedAt: intakeSubmissions.submittedAt })
    .from(intakeSubmissions)
    .where(eq(intakeSubmissions.orderId, orderId))
    .limit(1);
  if (!intake[0]?.submittedAt) {
    throw new OrderStateError(
      "Phase I cannot close until the intake form has been submitted.",
    );
  }
  const mnda = await db
    .select({ id: mndaAcceptances.id })
    .from(mndaAcceptances)
    .where(eq(mndaAcceptances.orderId, orderId))
    .limit(1);
  if (!mnda[0]) {
    throw new OrderStateError(
      "Phase I cannot close until the mutual NDA has been signed.",
    );
  }
}

async function assertDeliverablePresent(orderId: number): Promise<void> {
  const rows = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(files)
    .where(
      and(
        eq(files.orderId, orderId),
        eq(files.visibleToCustomer, true),
        eq(files.isPlaceholder, false),
        isNull(files.deletedAt),
      ),
    );
  if (Number(rows[0]?.total ?? 0) === 0) {
    throw new OrderStateError(
      "An order cannot be marked delivered until at least one customer-visible deliverable is attached.",
    );
  }
}

export async function transitionOrder(input: TransitionInput) {
  const rows = await db
    .select({ id: orders.id, status: orders.status, orderNumber: orders.orderNumber })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt)))
    .limit(1);
  const order = rows[0];
  if (!order) throw new OrderStateError("Order not found.");

  const from = order.status;
  if (from === input.to) return { changed: false as const };
  try {
    await assertActiveOrderStatus(input.to);
  } catch {
    throw new OrderStateError("The selected order status is not active or is not configured.");
  }

  // Core lifecycle states retain their guarded transition graph. A custom status
  // is an administrator-defined operating label; it may be entered or exited by
  // staff only while the order remains non-terminal and the target is active.
  if (isSystemOrderStatus(from) && isSystemOrderStatus(input.to)) {
    const allowed = ORDER_TRANSITIONS[from] ?? [];
    if (!allowed.includes(input.to)) throw new OrderStateError(`An order in state "${from}" cannot move to "${input.to}".`);
  } else if (isTerminalOrderStatus(from)) {
    throw new OrderStateError(`A terminal order in state "${from}" cannot move to a custom status.`);
  }

  if (from === "phase_1_intake" && input.to === "phase_2_synthesis") {
    await assertPhaseOneComplete(input.orderId);
  }
  if (input.to === "delivered") {
    await assertDeliverablePresent(input.orderId);
  }

  const patch: Partial<typeof orders.$inferInsert> = { status: input.to };
  if (input.to === "delivered") {
    patch.deliveredAt = new Date();
    patch.completionPercent = 100;
  }
  if (input.to === "closed" || input.to === "cancelled" || input.to === "refunded") patch.closedAt = new Date();

  await db.update(orders).set(patch).where(eq(orders.id, input.orderId));

  await db.insert(orderStatusHistory).values({
    orderId: input.orderId,
    fromStatus: from,
    toStatus: input.to,
    actorUserId: input.actorUserId,
    reason: input.reason?.slice(0, 255) ?? null,
  });

  void recordActivity({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: "order.transition",
    entityType: "order",
    entityId: input.orderId,
    summary: `Order ${order.orderNumber} moved from ${from} to ${input.to}`,
    changes: { from, to: input.to, reason: input.reason ?? null },
    ipAddress: input.ipAddress ?? null,
  });

  if (isSystemOrderStatus(input.to)) await enqueuePhaseJobs(input.orderId, input.to);
  await applyOrderAutomationRules(input.orderId, "order_status", input.to);

  // Fire email automation triggers based on the new order state.
  const orderRow = await db
    .select({ userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1);
  const userId = orderRow[0]?.userId;
  if (userId) {
    if (input.to === "delivered") {
      void fireAutomations("order.delivered", { userId });
    } else if (input.to === "closed") {
      void fireAutomations("order.closed", { userId });
    } else {
      void fireAutomations("order.phase_changed", { userId });
    }
  }

  return { changed: true as const, from, to: input.to };
}

/** Queue the automation jobs configured for a phase, if that phase is enabled. */
export async function enqueuePhaseJobs(orderId: number, phase: OrderStatus): Promise<void> {
  const configs = await db
    .select()
    .from(phaseKickoffConfigs)
    .where(and(eq(phaseKickoffConfigs.phase, phase), eq(phaseKickoffConfigs.enabled, true)))
    .limit(1);
  const config = configs[0];
  if (!config) return;

  const jobs: { jobType: string }[] = [];
  if (config.createFolders) jobs.push({ jobType: "create_folders" });
  if (config.attachPlaceholders) jobs.push({ jobType: "attach_placeholders" });
  if (config.notifyCustomer) jobs.push({ jobType: "notify_customer" });
  if (config.notifyWebhooks) jobs.push({ jobType: "dispatch_webhooks" });
  if (jobs.length === 0) return;

  await db.insert(phaseJobs).values(
    jobs.map((job) => ({ orderId, phase, jobType: job.jobType })),
  );
  logger.info("Queued phase kickoff jobs", { orderId, phase, count: jobs.length });
}

export type OrderAttentionState = "awaiting_staff_review" | "awaiting_customer_response" | "none";

export interface OrderAttention {
  state: OrderAttentionState;
  phaseKey: string | null;
  occurredAt: Date | null;
}

/**
 * Resolves the next response owner for orders without inferring it from the
 * lifecycle label. A customer phase becomes a staff-review item only after the
 * customer explicitly submits and locks it; an open staff question becomes a
 * customer-action item. Staff-review takes precedence because it is a newly
 * submitted customer artifact requiring acknowledgement.
 */
export async function getOrderAttentionStates(orderIds: number[]): Promise<Map<number, OrderAttention>> {
  const result = new Map<number, OrderAttention>();
  if (orderIds.length === 0) return result;
  const [submittedPhases, openQuestions] = await Promise.all([
    db
      .select({ orderId: orderPhaseLocks.orderId, phaseKey: orderPhaseLocks.phaseKey, occurredAt: orderPhaseLocks.lockedAt })
      .from(orderPhaseLocks)
      .where(and(inArray(orderPhaseLocks.orderId, orderIds), isNull(orderPhaseLocks.unlockedAt), isNull(orderPhaseLocks.reviewedAt)))
      .orderBy(desc(orderPhaseLocks.lockedAt)),
    db
      .select({ orderId: orderQuestions.orderId, phaseKey: orderQuestions.phase, occurredAt: orderQuestions.createdAt })
      .from(orderQuestions)
      .where(and(inArray(orderQuestions.orderId, orderIds), eq(orderQuestions.status, "open")))
      .orderBy(desc(orderQuestions.createdAt)),
  ]);

  for (const phase of submittedPhases) {
    if (!result.has(phase.orderId)) result.set(phase.orderId, { state: "awaiting_staff_review", phaseKey: phase.phaseKey, occurredAt: phase.occurredAt });
  }
  for (const question of openQuestions) {
    if (!result.has(question.orderId)) result.set(question.orderId, { state: "awaiting_customer_response", phaseKey: question.phaseKey, occurredAt: question.occurredAt });
  }
  return result;
}

export interface OrderSummary {
  id: number;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  projectName: string | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  bundleApplied: boolean;
  completionPercent: number;
  createdAt: Date;
  deliveredAt: Date | null;
  dueAt: Date | null;
  itemCount: number;
  currentPhaseKey: string | null;
  currentPhaseLabel: string | null;
  attention: OrderAttention;
}

export async function listOrdersForUser(userId: number): Promise<OrderSummary[]> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      projectNameEnc: orders.projectNameEnc,
      subtotalCents: orders.subtotalCents,
      discountCents: orders.discountCents,
      totalCents: orders.totalCents,
      bundleApplied: orders.bundleApplied,
      completionPercent: orders.completionPercent,
      createdAt: orders.createdAt,
      deliveredAt: orders.deliveredAt,
      dueAt: orders.dueAt,
      workflowId: orders.workflowId,
    })
    .from(orders)
    .where(and(sql`(${orders.userId} = ${userId} OR EXISTS (SELECT 1 FROM order_shares os WHERE os.order_id = ${orders.id} AND os.shared_with_user_id = ${userId} AND os.revoked_at IS NULL))`, isNull(orders.deletedAt)))
    .orderBy(desc(orders.createdAt));

  if (rows.length === 0) return [];

  const counts = await db
    .select({ orderId: orderItems.orderId, total: count() })
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((row) => row.id)))
    .groupBy(orderItems.orderId);
  const countMap = new Map(counts.map((row) => [row.orderId, Number(row.total)]));
  const workflowIds = [...new Set(rows.map((row) => row.workflowId).filter((workflowId): workflowId is number => workflowId !== null))];
  const workflowRows = workflowIds.length > 0
    ? await db.select({ id: orderWorkflows.id, stages: orderWorkflows.stages }).from(orderWorkflows).where(inArray(orderWorkflows.id, workflowIds))
    : [];
  const workflowMap = new Map(workflowRows.map((workflow) => [workflow.id, normalizeCustomerWorkflowStages(workflow.stages)]));
  const attentionByOrder = await getOrderAttentionStates(rows.map((row) => row.id));
  const phaseLocks = await db
    .select({ orderId: orderPhaseLocks.orderId, phaseKey: orderPhaseLocks.phaseKey })
    .from(orderPhaseLocks)
    .where(and(inArray(orderPhaseLocks.orderId, rows.map((row) => row.id)), isNull(orderPhaseLocks.unlockedAt)));
  const locksByOrder = new Map<number, Set<string>>();
  for (const lock of phaseLocks) {
    const keys = locksByOrder.get(lock.orderId) ?? new Set<string>();
    keys.add(lock.phaseKey);
    locksByOrder.set(lock.orderId, keys);
  }
  const workflowAdvances = await db
    .select({ orderId: orderWorkflowAdvances.orderId, phaseKey: orderWorkflowAdvances.phaseKey })
    .from(orderWorkflowAdvances)
    .where(inArray(orderWorkflowAdvances.orderId, rows.map((row) => row.id)));
  const advancesByOrder = new Map<number, Set<string>>();
  for (const advance of workflowAdvances) {
    const keys = advancesByOrder.get(advance.orderId) ?? new Set<string>();
    keys.add(advance.phaseKey);
    advancesByOrder.set(advance.orderId, keys);
  }

  return rows.map((row) => {
    const stages = row.workflowId ? workflowMap.get(row.workflowId) ?? [] : [];
    const lockedKeys = locksByOrder.get(row.id) ?? new Set<string>();
    const advancedKeys = advancesByOrder.get(row.id) ?? new Set<string>();
    const currentStage = stages.find((stage) => !isStageComplete(stage.key, lockedKeys, advancedKeys, row.paymentStatus)) ?? null;
    return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    paymentStatus: row.paymentStatus,
    projectName: decryptField(row.projectNameEnc, `order:${row.id}`),
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    totalCents: row.totalCents,
    bundleApplied: row.bundleApplied,
    completionPercent: row.completionPercent,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    dueAt: row.dueAt,
    itemCount: countMap.get(row.id) ?? 0,
    currentPhaseKey: currentStage?.key ?? null,
    currentPhaseLabel: currentStage?.label ?? null,
    attention: attentionByOrder.get(row.id) ?? { state: "none", phaseKey: null, occurredAt: null },
  };
  });
}

/**
 * Ownership assertion used by every customer-facing order endpoint.
 * Returns the order id when the caller is the owner, a delegate, or staff.
 */
export async function assertOrderAccess(
  orderId: number,
  userId: number,
  role: string,
): Promise<void> {
  if (role === "admin" || role === "staff") {
    const exists = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);
    if (!exists[0]) throw new OrderStateError("Order not found.");
    return;
  }

  const rows = await db
    .select({ id: orders.id, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId), isNull(orders.deletedAt)))
    .limit(1);
  if (rows[0]) {
    if (rows[0].paymentStatus !== "paid") {
      throw new OrderStateError("Payment confirmation is required before this order can be used. Complete checkout and wait for Stripe confirmation.");
    }
    return;
  }

  const shared = await db.execute(
    sql`SELECT o.payment_status AS paymentStatus FROM order_shares os INNER JOIN orders o ON o.id = os.order_id WHERE os.order_id = ${orderId} AND os.shared_with_user_id = ${userId} AND os.revoked_at IS NULL AND o.deleted_at IS NULL LIMIT 1`,
  );
  const sharedRows = (shared as unknown as [{ paymentStatus: string }[]])[0];
  if (Array.isArray(sharedRows) && sharedRows.length > 0) {
    if (sharedRows[0]?.paymentStatus !== "paid") {
      throw new OrderStateError("Payment confirmation is required before this order can be used.");
    }
    return;
  }

  // A missing order and a forbidden order are indistinguishable to the caller.
  throw new OrderStateError("Order not found.");
}

/**
 * Mutations must call this after ordinary access verification. Terminal orders
 * remain readable for invoices, history, and customer records, but no party may
 * add files, messages, answers, shares, or workflow actions after cancellation
 * or a full refund.
 */
export async function assertOrderWritableAccess(
  orderId: number,
  userId: number,
  role: string,
): Promise<void> {
  await assertOrderAccess(orderId, userId, role);
  const [order] = await db
    .select({ status: orders.status, paymentStatus: orders.paymentStatus })
    .from(orders)
    .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
    .limit(1);
  if (!order) throw new OrderStateError("Order not found.");
  if (isTerminalOrderStatus(order.status) || order.paymentStatus === "refunded") {
    throw new OrderStateError("This order is closed and is available only for viewing its records and invoice.");
  }
}

export async function getOrderDetail(orderId: number) {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
    .limit(1);
  const order = rows[0];
  if (!order) throw new OrderStateError("Order not found.");

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const history = await db
    .select()
    .from(orderStatusHistory)
    .where(eq(orderStatusHistory.orderId, orderId))
    .orderBy(desc(orderStatusHistory.createdAt));

  return {
    order: {
      ...order,
      projectName: decryptField(order.projectNameEnc, `order:${orderId}`),
      internalNotes: null as string | null,
    },
    items,
    history,
  };
}

export interface OrderStats {
  total: number;
  byStatus: Record<string, number>;
  revenueCents: number;
  last30DaysCount: number;
}

export async function getOrderStats(): Promise<OrderStats> {
  const statusRows = await db
    .select({ status: orders.status, total: count() })
    .from(orders)
    .where(isNull(orders.deletedAt))
    .groupBy(orders.status);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of statusRows) {
    byStatus[row.status] = Number(row.total);
    total += Number(row.total);
  }

  const revenueRows = await db
    .select({ revenue: sql<number>`COALESCE(SUM(${orders.totalCents}), 0)` })
    .from(orders)
    .where(and(isNull(orders.deletedAt), inArray(orders.paymentStatus, ["paid", "partially_refunded"])));

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentRows = await db
    .select({ total: count() })
    .from(orders)
    .where(and(isNull(orders.deletedAt), gte(orders.createdAt, since)));

  return {
    total,
    byStatus,
    revenueCents: Number(revenueRows[0]?.revenue ?? 0),
    last30DaysCount: Number(recentRows[0]?.total ?? 0),
  };
}

/** Permanently remove soft-deleted orders past the retention window. */
export async function purgeSoftDeletedOrders(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(sql`${orders.deletedAt} IS NOT NULL`, lte(orders.deletedAt, cutoff)))
    .limit(200);
  if (stale.length === 0) return 0;
  const ids = stale.map((row) => row.id);
  await db.delete(orderItems).where(inArray(orderItems.orderId, ids));
  await db.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, ids));
  await db.delete(orders).where(inArray(orders.id, ids));
  return ids.length;
}
