/**
 * Stripe router — checkout, coupon validation, and admin finance operations.
 *
 * The webhook endpoint is registered as a raw Express route in app.ts
 * (before body-parser) so the raw buffer is available for signature verification.
 */
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  couponRedemptions,
  coupons,
  orders,
  orderItems,
  payments,
  payouts,
  referrals,
  refunds,
  users,
} from "../db/schema.js";
import { env } from "../config/env.js";
import {
  createCheckoutSession,
  initiateRefund,
  listPayments,
  validateCoupon,
  getEffectiveStripeKey,
  getEffectivePublishableKey,
  getEffectiveWebhookSecret,
  testStripeConnection,
} from "../services/stripe.js";
import { setSetting } from "../services/settings.js";
import { siteSettings } from "../db/schema.js";
import { protectedProcedure, adminProcedure, staffProcedure, router } from "../trpc/trpc.js";
import { getUserById } from "../db/users.js";
import { TRPCError } from "@trpc/server";
import { recordActivity } from "../observability/audit.js";

const couponInput = z
  .object({
    id: z.number().int().positive().optional(),
    code: z.string().min(1).max(48).toUpperCase(),
    description: z.string().max(255).optional(),
    discountType: z.enum(["percent", "fixed", "cart_price"]),
    discountValue: z.number().int().nonnegative(),
    maxRedemptions: z.number().int().positive().optional().nullable(),
    startsAt: z.string().datetime().optional().nullable(),
    expiresAt: z.string().datetime().optional().nullable(),
    active: z.boolean().default(true),
  })
  .superRefine((coupon, ctx) => {
    if (coupon.discountType === "percent" && (coupon.discountValue < 1 || coupon.discountValue > 100)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discountValue"], message: "Percentage discounts must be between 1 and 100." });
    }
    if (coupon.discountType === "fixed" && coupon.discountValue < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discountValue"], message: "Fixed discounts must be at least one cent." });
    }
  });

export const stripeRouter = router({
  // -------------------------------------------------------------------------
  // Customer: validate a coupon code before checkout
  // -------------------------------------------------------------------------
  validateCoupon: protectedProcedure
    .input(
      z.object({
        code: z.string().min(1).max(48),
        orderTotalCents: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      return validateCoupon(input.code, input.orderTotalCents);
    }),

  // -------------------------------------------------------------------------
  // Customer: create a Stripe checkout session for an order
  // -------------------------------------------------------------------------
  createCheckout: protectedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        couponCode: z.string().max(48).optional(),
        referralCode: z.string().max(48).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Database settings are the administrator-supported configuration source;
      // environment variables are only the optional deployment fallback.  Do not
      // gate checkout on the env-only boolean, otherwise a saved admin key appears
      // active in Finance while customers are incorrectly blocked here.
      const [stripeKey, webhookSecret] = await Promise.all([
        getEffectiveStripeKey(),
        getEffectiveWebhookSecret(),
      ]);
      if (!stripeKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Online payment is not currently enabled. Please contact support.",
        });
      }
      // A successful redirect is not proof of settlement. Require Stripe's signed
      // webhook before accepting charges so paid orders are updated only after the
      // server verifies the provider event.
      if (!webhookSecret) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Online payment setup is incomplete. An administrator must add the Stripe webhook signing secret in Finance → Stripe Settings before collecting payments.",
        });
      }

      // Verify the order belongs to this user and is in a payable state.
      const orderRows = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.id, input.orderId),
            eq(orders.userId, ctx.session!.user.id)
          )
        )
        .limit(1);

      if (orderRows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      }

      const order = orderRows[0]!;

      if (["paid", "partially_refunded", "refunded"].includes(order.paymentStatus) || ["cancelled", "refunded", "closed"].includes(order.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This order is settled or closed and cannot accept another online payment. Create a new order to continue.",
        });
      }
      if (order.paymentRequirement !== "required" || order.isTestOrder) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This administrator-created order does not require online payment.",
        });
      }

      if (order.paymentStatus === "processing") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A checkout session is already in progress for this order.",
        });
      }

      if (order.priceSource === "admin_manual" && input.couponCode) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A coupon cannot be applied because this order uses an administrator-set fixed price.",
        });
      }

      // Build line items from order items.
      const items = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, input.orderId));

      if (items.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Order has no items.",
        });
      }

      const lineItems = order.priceSource === "admin_manual"
        ? [{ name: `Administrator-set price — Order ${order.orderNumber}`, amountCents: order.totalCents, quantity: 1 }]
        : items.map((item) => ({
            name: item.name,
            amountCents: item.unitPriceCents,
            quantity: item.quantity,
          }));

      const result = await createCheckoutSession({
        orderId: order.id,
        orderNumber: order.orderNumber,
        userId: ctx.session!.user.id,
        userEmail: (await getUserById(ctx.session!.user.id))?.email ?? "",
        lineItems,
        totalCents: order.totalCents,
        couponCode: input.couponCode,
        referralCode: input.referralCode,
        successUrl: `${env.appUrl}/portal/orders/${order.id}?payment=success`,
        cancelUrl: `${env.appUrl}/portal/orders/${order.id}?payment=cancelled`,
      });

      return result;
    }),

  // -------------------------------------------------------------------------
  // Customer: check payment status for an order
  // -------------------------------------------------------------------------
  paymentStatus: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ input, ctx }) => {
      const orderRows = await db
        .select({ paymentStatus: orders.paymentStatus, totalCents: orders.totalCents })
        .from(orders)
        .where(
          and(
            eq(orders.id, input.orderId),
            eq(orders.userId, ctx.session!.user.id)
          )
        )
        .limit(1);

      if (orderRows.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found." });
      }

      return orderRows[0]!;
    }),

  // -------------------------------------------------------------------------
  // Admin: verify stored Stripe credentials without exposing any secret values
  // -------------------------------------------------------------------------
  testConnection: adminProcedure.mutation(async ({ ctx }) => {
    try {
      const result = await testStripeConnection();
      return { ok: true as const, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Stripe connection test failed.";
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Stripe connection test failed: ${message}` });
    } finally {
      void ctx;
    }
  }),

  // -------------------------------------------------------------------------
  // Admin: concise payment and refund dashboard
  // -------------------------------------------------------------------------
  financeOverview: staffProcedure.query(async () => {
    const [paymentTotals, refundTotals, counts] = await Promise.all([
      db.select({ collected: sql<number>`coalesce(sum(case when ${payments.status} = 'succeeded' then ${payments.amountCents} else 0 end), 0)`, pending: sql<number>`coalesce(sum(case when ${payments.status} = 'pending' then ${payments.amountCents} else 0 end), 0)` }).from(payments),
      db.select({ completed: sql<number>`coalesce(sum(case when ${refunds.status} = 'completed' then ${refunds.amountCents} else 0 end), 0)`, pending: sql<number>`coalesce(sum(case when ${refunds.status} in ('requested', 'pending') then ${refunds.amountCents} else 0 end), 0)` }).from(refunds),
      db.select({ payments: sql<number>`count(*)`, refunds: sql<number>`(select count(*) from refunds)` }).from(payments),
    ]);
    return {
      collectedCents: Number(paymentTotals[0]?.collected ?? 0),
      pendingPaymentCents: Number(paymentTotals[0]?.pending ?? 0),
      refundedCents: Number(refundTotals[0]?.completed ?? 0),
      pendingRefundCents: Number(refundTotals[0]?.pending ?? 0),
      paymentCount: Number(counts[0]?.payments ?? 0),
      refundCount: Number(counts[0]?.refunds ?? 0),
    };
  }),

  refundEligibleOrders: adminProcedure
    .input(z.object({ search: z.string().trim().max(190).optional(), userId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).default(25) }).optional())
    .query(async ({ input }) => {
      const search = input?.search?.trim();
      const conditions = [sql`${orders.deletedAt} IS NULL`, eq(payments.provider, "stripe"), eq(payments.status, "succeeded")];
      if (input?.userId) conditions.push(eq(orders.userId, input.userId));
      if (search) conditions.push(sql`(${orders.orderNumber} LIKE ${`%${search}%`} OR ${users.publicId} LIKE ${`%${search}%`})`);
      const rows = await db
        .select({ id: orders.id, orderNumber: orders.orderNumber, userId: orders.userId, customerPublicId: users.publicId, paymentId: payments.id, paidCents: payments.amountCents, receivedAt: payments.receivedAt })
        .from(orders)
        .innerJoin(payments, eq(payments.orderId, orders.id))
        .leftJoin(users, eq(users.id, orders.userId))
        .where(and(...conditions))
        .orderBy(desc(payments.receivedAt))
        .limit(input?.limit ?? 25);
      const unique = new Map<number, (typeof rows)[number]>();
      for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);
      return Array.from(unique.values());
    }),

  refundQuote: adminProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const paymentRows = await db.select().from(payments).where(and(eq(payments.orderId, input.orderId), eq(payments.provider, "stripe"), eq(payments.status, "succeeded"))).orderBy(desc(payments.receivedAt)).limit(1);
      if (!paymentRows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "No successful Stripe payment was found for this order." });
      const payment = paymentRows[0];
      const prior = await db.select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)` }).from(refunds).where(and(eq(refunds.paymentId, payment.id), sql`${refunds.status} IN ('requested', 'pending', 'completed')`));
      return { orderId: input.orderId, paymentId: payment.id, paidCents: payment.amountCents, remainingCents: Math.max(0, payment.amountCents - Number(prior[0]?.total ?? 0)) };
    }),

  // -------------------------------------------------------------------------
  // Admin: list all payments
  // -------------------------------------------------------------------------
  payments: staffProcedure
    .input(z.object({ page: z.number().int().min(1).default(1) }))
    .query(async ({ input }) => {
      return listPayments(input.page, 50);
    }),

  // -------------------------------------------------------------------------
  // Admin: list coupons
  // -------------------------------------------------------------------------
  coupons: staffProcedure.query(async () => db
    .select({ id: coupons.id, code: coupons.code, description: coupons.description, discountType: coupons.discountType, discountValue: coupons.discountValue, maxRedemptions: coupons.maxRedemptions, redemptionCount: coupons.redemptionCount, startsAt: coupons.startsAt, expiresAt: coupons.expiresAt, active: coupons.active, createdAt: coupons.createdAt, createdByUserId: coupons.createdByUserId, creatorPublicId: users.publicId, disabledAt: coupons.disabledAt, disabledByUserId: coupons.disabledByUserId })
    .from(coupons)
    .leftJoin(users, eq(users.id, coupons.createdByUserId))
    .orderBy(desc(coupons.createdAt))),

  // -------------------------------------------------------------------------
  // Admin: create or update a coupon
  // -------------------------------------------------------------------------
  upsertCoupon: adminProcedure
    .input(couponInput)
    .mutation(async ({ input, ctx }) => {
      const data = {
        code: input.code,
        description: input.description ?? null,
        discountType: input.discountType,
        discountValue: input.discountValue,
        maxRedemptions: input.maxRedemptions ?? null,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        active: input.active,
        updatedByUserId: ctx.session.user.id,
      };

      if (input.id) {
        await db.update(coupons).set(data).where(eq(coupons.id, input.id));
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "coupon.updated", entityType: "coupon", entityId: input.id, summary: `Updated coupon ${input.code}`, changes: { active: input.active, discountType: input.discountType, discountValue: input.discountValue }, ipAddress: ctx.clientIp });
        return { id: input.id };
      }
      const result = await db.insert(coupons).values({ ...data, createdByUserId: ctx.session.user.id, redemptionCount: 0 });
      const id = (result[0] as { insertId: number }).insertId;
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "coupon.created", entityType: "coupon", entityId: id, summary: `Created coupon ${input.code}`, changes: { discountType: input.discountType, discountValue: input.discountValue, maxRedemptions: input.maxRedemptions ?? null }, ipAddress: ctx.clientIp });
      return { id };
    }),

  // -------------------------------------------------------------------------
  // Admin: toggle coupon active state
  // -------------------------------------------------------------------------
  setCouponActive: adminProcedure
    .input(z.object({ id: z.number().int().positive(), active: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const rows = await db.select({ code: coupons.code }).from(coupons).where(eq(coupons.id, input.id)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Coupon not found." });
      await db.update(coupons).set({ active: input.active, updatedByUserId: ctx.session.user.id, disabledByUserId: input.active ? null : ctx.session.user.id, disabledAt: input.active ? null : new Date() }).where(eq(coupons.id, input.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: input.active ? "coupon.enabled" : "coupon.disabled", entityType: "coupon", entityId: input.id, severity: input.active ? "info" : "warning", summary: `${input.active ? "Enabled" : "Disabled"} coupon ${rows[0].code}`, changes: { active: input.active }, ipAddress: ctx.clientIp });
    }),

  couponUsage: staffProcedure
    .input(z.object({ couponId: z.number().int().positive(), limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ input }) => db
      .select({ id: couponRedemptions.id, code: couponRedemptions.codeSnapshot, orderId: couponRedemptions.orderId, orderNumber: orders.orderNumber, userId: couponRedemptions.userId, userPublicId: users.publicId, discountCents: couponRedemptions.discountCents, redeemedAt: couponRedemptions.redeemedAt })
      .from(couponRedemptions)
      .leftJoin(orders, eq(orders.id, couponRedemptions.orderId))
      .leftJoin(users, eq(users.id, couponRedemptions.userId))
      .where(eq(couponRedemptions.couponId, input.couponId))
      .orderBy(desc(couponRedemptions.redeemedAt))
      .limit(input.limit)),

  // -------------------------------------------------------------------------
  // Admin: permanently delete an unused, inactive coupon
  // -------------------------------------------------------------------------
  deleteCoupon: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const rows = await db
        .select({ id: coupons.id, code: coupons.code, active: coupons.active, redemptionCount: coupons.redemptionCount })
        .from(coupons)
        .where(eq(coupons.id, input.id))
        .limit(1);
      const coupon = rows[0];
      if (!coupon) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Coupon not found." });
      }
      if (coupon.active) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Disable this coupon before deleting it." });
      }
      if (coupon.redemptionCount > 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Coupons with redemption history are retained for audit purposes and cannot be deleted." });
      }

      await db.delete(coupons).where(eq(coupons.id, coupon.id));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "coupon.deleted",
        entityType: "coupon",
        entityId: coupon.id,
        severity: "warning",
        summary: `Permanently deleted unused coupon ${coupon.code}`,
        ipAddress: ctx.clientIp,
      });
      return { deleted: true };
    }),

  // -------------------------------------------------------------------------
  // Admin: list referrals
  // -------------------------------------------------------------------------
  referrals: staffProcedure
    .input(z.object({ page: z.number().int().min(1).default(1) }))
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const rows = await db
        .select()
        .from(referrals)
        .orderBy(desc(referrals.createdAt))
        .limit(50)
        .offset(offset);

      const countResult = await db
        .select({ total: sql<number>`count(*)` })
        .from(referrals);

      return { rows, total: Number(countResult[0]?.total ?? 0) };
    }),

  // -------------------------------------------------------------------------
  // Admin: list payouts
  // -------------------------------------------------------------------------
  payouts: staffProcedure
    .input(z.object({ page: z.number().int().min(1).default(1) }))
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const rows = await db
        .select()
        .from(payouts)
        .orderBy(desc(payouts.createdAt))
        .limit(50)
        .offset(offset);

      const countResult = await db
        .select({ total: sql<number>`count(*)` })
        .from(payouts);

      return { rows, total: Number(countResult[0]?.total ?? 0) };
    }),

  // -------------------------------------------------------------------------
  // Admin: process a payout
  // -------------------------------------------------------------------------
  processPayout: adminProcedure
    .input(
      z.object({
        payoutId: z.number().int().positive(),
        status: z.enum(["completed", "rejected"]),
        note: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input }) => {
      await db
        .update(payouts)
        .set({
          status: input.status,
          processedAt: new Date(),
        })
        .where(eq(payouts.id, input.payoutId));
    }),

  // -------------------------------------------------------------------------
  // Admin: list refunds
  // -------------------------------------------------------------------------
  refunds: staffProcedure
    .input(z.object({ page: z.number().int().min(1).default(1) }))
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const rows = await db
        .select()
        .from(refunds)
        .orderBy(desc(refunds.createdAt))
        .limit(50)
        .offset(offset);

      const countResult = await db
        .select({ total: sql<number>`count(*)` })
        .from(refunds);

      return { rows, total: Number(countResult[0]?.total ?? 0) };
    }),

  // -------------------------------------------------------------------------
  // Admin: initiate a Stripe refund
  // -------------------------------------------------------------------------
  initiateRefund: adminProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        amountCents: z.number().int().positive(),
        reason: z.string().min(10).max(500),
        confirmation: z.literal("REFUND ORDER"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      return initiateRefund(input.orderId, input.amountCents, input.reason, ctx.session!.user.id);
    }),

  // -------------------------------------------------------------------------
  // Admin: Stripe configuration status (DB keys take priority over env vars)
  // -------------------------------------------------------------------------
  config: adminProcedure.query(async () => {
    const secretKey = await getEffectiveStripeKey();
    const publishableKey = await getEffectivePublishableKey();
    const webhookSecret = await getEffectiveWebhookSecret();
    // Check if keys are stored in DB (vs env)
    const dbRows = await db
      .select({ key: siteSettings.settingKey })
      .from(siteSettings)
      .where(sql`${siteSettings.settingKey} IN ('stripe.secret_key','stripe.publishable_key','stripe.webhook_secret')`);
    const dbKeys = new Set(dbRows.map((r) => r.key));
    return {
      // A checkout key lets staff validate the Stripe connection, but settlement
      // is only safe when the webhook-signing secret is also configured.
      enabled: Boolean(secretKey && webhookSecret),
      checkoutKeyConfigured: Boolean(secretKey),
      publishableKey: publishableKey ?? null,
      webhookConfigured: Boolean(webhookSecret),
      secretKeySet: Boolean(secretKey),
      secretKeySource: dbKeys.has("stripe.secret_key") ? "database" : (env.stripe.secretKey ? "environment" : "none"),
      publishableKeySource: dbKeys.has("stripe.publishable_key") ? "database" : (env.stripe.publishableKey ? "environment" : "none"),
      webhookSecretSource: dbKeys.has("stripe.webhook_secret") ? "database" : (env.stripe.webhookSecret ? "environment" : "none"),
    };
  }),

  // Admin: save Stripe keys to the database (so they survive without env vars)
  saveStripeConfig: adminProcedure
    .input(
      z.object({
        secretKey: z.string().trim().optional(),
        publishableKey: z.string().trim().optional(),
        webhookSecret: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      if (input.secretKey !== undefined) {
        await setSetting(
          "stripe.secret_key",
          input.secretKey || null,
          { category: "payments", isSecret: true, userId },
        );
      }
      if (input.publishableKey !== undefined) {
        await setSetting(
          "stripe.publishable_key",
          input.publishableKey || null,
          { category: "payments", isSecret: false, userId },
        );
      }
      if (input.webhookSecret !== undefined) {
        await setSetting(
          "stripe.webhook_secret",
          input.webhookSecret || null,
          { category: "payments", isSecret: true, userId },
        );
      }
      return { ok: true };
    }),
});
