/**
 * Stripe payment service.
 *
 * Handles checkout session creation, webhook event processing, coupon
 * validation, and refund initiation. All Stripe calls are gated behind
 * env.stripe.enabled so the application is fully functional without
 * Stripe credentials configured.
 *
 * Schema alignment notes:
 *   payments.provider        = "stripe"
 *   payments.providerReference = Stripe checkout session ID (later updated to payment intent ID)
 *   payments.methodSummary   = last4 / card brand summary
 *   payments.receivedAt      = timestamp when payment succeeded
 *   coupons.redemptionCount  = incremented on success
 *   coupons.maxRedemptions   = checked before allowing use
 *   referrals.referrerUserId = the referring user
 *   referrals.orderId        = the order that earned the referral
 *   referrals.rewardCents    = commission amount
 *   refunds.requestedByUserId = 0 for system-initiated (webhook) refunds
 */
import Stripe from "stripe";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  couponRedemptions,
  coupons,
  orders,
  payments,
  referrals,
  refunds,
  siteSettings,
} from "../db/schema.js";
import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import { activatePaidOrder, transitionOrder } from "./orders.js";
import { getOrCreatePaidOrderInvoice, queueAutomaticCustomerInvoiceEmail } from "./invoices.js";

let _stripe: Stripe | null = null;
let _stripeKeyFromDb: string | null | undefined = undefined; // undefined = not yet loaded

/** Load Stripe keys from the database settings table (runtime override). */
async function loadStripeKeysFromDb(): Promise<{
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
}> {
  const rows = await db
    .select({ key: siteSettings.settingKey, value: siteSettings.settingValue })
    .from(siteSettings)
    .where(
      sql`${siteSettings.settingKey} IN ('stripe.secret_key','stripe.publishable_key','stripe.webhook_secret')`,
    );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    secretKey: map["stripe.secret_key"] ?? null,
    publishableKey: map["stripe.publishable_key"] ?? null,
    webhookSecret: map["stripe.webhook_secret"] ?? null,
  };
}

/** Get effective Stripe secret key: DB setting takes priority over env var. */
export async function getEffectiveStripeKey(): Promise<string | null> {
  const dbKeys = await loadStripeKeysFromDb();
  return dbKeys.secretKey || env.stripe.secretKey || null;
}

/** Get effective Stripe publishable key. */
export async function getEffectivePublishableKey(): Promise<string | null> {
  const dbKeys = await loadStripeKeysFromDb();
  return dbKeys.publishableKey || env.stripe.publishableKey || null;
}

/** Get effective Stripe webhook secret. */
export async function getEffectiveWebhookSecret(): Promise<string | null> {
  const dbKeys = await loadStripeKeysFromDb();
  return dbKeys.webhookSecret || env.stripe.webhookSecret || null;
}

export async function getStripeAsync(): Promise<Stripe> {
  const secretKey = await getEffectiveStripeKey();
  if (!secretKey) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in the admin panel or environment.");
  }
  // Re-create the client if the key changed.
  if (_stripeKeyFromDb !== secretKey) {
    _stripe = new Stripe(secretKey, { apiVersion: "2026-07-29.dahlia", typescript: true });
    _stripeKeyFromDb = secretKey;
  }
  return _stripe!;
}

export async function testStripeConnection(): Promise<{ mode: "test" | "live"; availableBalanceCurrencies: string[] }> {
  const stripe = await getStripeAsync();
  // The balance endpoint requires valid account credentials but exposes no secret material.
  const balance = await stripe.balance.retrieve();
  const secretKey = await getEffectiveStripeKey();
  return {
    mode: balance.livemode || secretKey?.startsWith("sk_live_") ? "live" : "test",
    availableBalanceCurrencies: [...new Set(balance.available.map((entry) => entry.currency.toUpperCase()))],
  };
}

export function getStripe(): Stripe {
  if (!env.stripe.enabled || !env.stripe.secretKey) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.");
  }
  if (!_stripe) {
    _stripe = new Stripe(env.stripe.secretKey, {
      apiVersion: "2026-07-29.dahlia",
      typescript: true,
    });
  }
  return _stripe;
}

// ---------------------------------------------------------------------------
// Coupon validation
// ---------------------------------------------------------------------------

export interface CouponResult {
  valid: boolean;
  couponId?: number;
  code?: string;
  discountType?: "percent" | "fixed" | "cart_price";
  // Percent for percentage discounts; cents off for fixed discounts; target
  // cart total in cents for fixed-cart-price discounts.
  discountValue?: number;
  discountCents?: number;
  cartPriceCents?: number;
  message?: string;
}

export async function validateCoupon(
  code: string,
  orderTotalCents: number
): Promise<CouponResult> {
  const now = new Date();
  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.code, code.toUpperCase().trim()),
        eq(coupons.active, true),
        sql`(${coupons.startsAt} IS NULL OR ${coupons.startsAt} <= ${now})`,
        sql`(${coupons.expiresAt} IS NULL OR ${coupons.expiresAt} > ${now})`,
        sql`(${coupons.maxRedemptions} IS NULL OR ${coupons.redemptionCount} < ${coupons.maxRedemptions})`
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return { valid: false, message: "Coupon code not found or has expired." };
  }

  const coupon = rows[0]!;

  let discountCents = 0;
  if (coupon.discountType === "percent") {
    discountCents = Math.round((orderTotalCents * coupon.discountValue) / 100);
  } else if (coupon.discountType === "cart_price") {
    // A cart-price coupon sets the final total, never increases it. The stored
    // value is the desired final cart price in cents.
    discountCents = Math.max(0, orderTotalCents - coupon.discountValue);
    if (discountCents === 0) {
      return {
        valid: false,
        message: "This fixed cart price does not reduce the current order total.",
      };
    }
  } else {
    // Fixed amount in cents.
    discountCents = Math.min(coupon.discountValue, orderTotalCents);
  }

  return {
    valid: true,
    couponId: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType as "percent" | "fixed" | "cart_price",
    discountValue: coupon.discountValue,
    discountCents,
    cartPriceCents: coupon.discountType === "cart_price" ? coupon.discountValue : undefined,
  };
}

// ---------------------------------------------------------------------------
// Checkout session creation
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  orderId: number;
  orderNumber: string;
  userId: number;
  userEmail: string;
  lineItems: { name: string; amountCents: number; quantity: number }[];
  totalCents: number;
  couponCode?: string;
  referralCode?: string;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(input: CheckoutInput) {
  const stripe = await getStripeAsync();

  let stripeCouponId: string | undefined;
  let couponDiscountCents = 0;
  let appliedCouponId: number | undefined;

  if (input.couponCode) {
    const couponResult = await validateCoupon(input.couponCode, input.totalCents);
    if (!couponResult.valid || !couponResult.couponId) {
      throw new Error(couponResult.message ?? "This coupon cannot be applied to this order.");
    }
    {
      appliedCouponId = couponResult.couponId;
      couponDiscountCents = couponResult.discountCents ?? 0;

      // Stripe supports percentage and amount-off coupons, but not a final-cart
      // price directly. Translate cart-price coupons to the exact amount off for
      // this order. Include the original amount in its Stripe name so a coupon
      // generated for one cart total cannot be reused for a different total.
      const stripeCouponName = couponResult.discountType === "cart_price"
        ? `RP-${input.couponCode}-TOTAL-${input.totalCents}`
        : `RP-${input.couponCode}`;
      const existingCoupons = await stripe.coupons.list({ limit: 100 });
      const existing = existingCoupons.data.find((c) => c.name === stripeCouponName);

      if (existing) {
        stripeCouponId = existing.id;
      } else {
        const created = await stripe.coupons.create(
          couponResult.discountType === "percent"
            ? {
                name: stripeCouponName,
                percent_off: couponResult.discountValue!,
                duration: "once",
              }
            : {
                name: stripeCouponName,
                amount_off: couponResult.discountCents!,
                currency: "usd",
                duration: "once",
              }
        );
        stripeCouponId = created.id;
      }
    }
  }

  // Resolve referral code to a referrer user id.
  let referrerId: number | undefined;
  if (input.referralCode) {
    const refRows = await db
      .select()
      .from(referrals)
      .where(eq(referrals.code, input.referralCode.toUpperCase().trim()))
      .limit(1);
    if (refRows.length > 0) referrerId = refRows[0]!.referrerUserId;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: input.userEmail,
    line_items: input.lineItems.map((item) => ({
      price_data: {
        currency: "usd",
        product_data: { name: item.name },
        unit_amount: item.amountCents,
      },
      quantity: item.quantity,
    })),
    discounts: stripeCouponId ? [{ coupon: stripeCouponId }] : undefined,
    metadata: {
      orderId: String(input.orderId),
      orderNumber: input.orderNumber,
      userId: String(input.userId),
      couponId: appliedCouponId ? String(appliedCouponId) : "",
      referrerId: referrerId ? String(referrerId) : "",
    },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    payment_intent_data: {
      metadata: {
        orderId: String(input.orderId),
        orderNumber: input.orderNumber,
      },
    },
  });

  // Record the pending payment using the generic schema.
  await db.insert(payments).values({
    orderId: input.orderId,
    provider: "stripe",
    providerReference: session.id,
    amountCents: input.totalCents - couponDiscountCents,
    status: "pending",
  });

  // Update the order payment status.
  await db
    .update(orders)
    .set({ paymentStatus: "processing" })
    .where(eq(orders.id, input.orderId));

  logger.info("stripe.checkout.created", {
    orderId: input.orderId,
    sessionId: session.id,
    amountCents: input.totalCents,
  });

  return { url: session.url!, sessionId: session.id };
}

// ---------------------------------------------------------------------------
// Webhook event processing
// ---------------------------------------------------------------------------

export async function handleStripeWebhook(
  rawBody: Buffer,
  signature: string
): Promise<{ handled: boolean; eventType: string }> {
  const webhookSecret = await getEffectiveWebhookSecret();
  if (!webhookSecret) {
    throw new Error("Stripe webhook signing secret is not configured.");
  }

  const stripe = await getStripeAsync();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("stripe.webhook.signature_invalid", { error: msg });
    throw new Error(`Webhook signature verification failed: ${msg}`);
  }

  logger.info("stripe.webhook.received", { type: event.type, id: event.id });

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case "payment_intent.payment_failed":
      await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    case "charge.refunded":
      await handleChargeRefunded(event.data.object as Stripe.Charge);
      break;
    default:
      return { handled: false, eventType: event.type };
  }

  return { handled: true, eventType: event.type };
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.orderId ? Number(session.metadata.orderId) : null;
  const couponId = session.metadata?.couponId ? Number(session.metadata.couponId) : null;
  const referrerId = session.metadata?.referrerId
    ? Number(session.metadata.referrerId)
    : null;

  if (!orderId) {
    logger.warn("stripe.checkout.completed.no_order_id", { sessionId: session.id });
    return;
  }

  const existingOrder = await db.select({ paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (existingOrder[0]?.paymentStatus === "paid") {
    // Stripe delivery is at-least-once. Reusing the idempotent invoice service
    // repairs any historical paid order that reached completion before its
    // invoice was materialized, without replaying provisioning or automations.
    const invoice = await getOrCreatePaidOrderInvoice(orderId);
    await queueAutomaticCustomerInvoiceEmail(orderId);
    logger.info("stripe.checkout.completed.duplicate", { orderId, sessionId: session.id, invoiceNumber: invoice.invoiceNumber });
    return;
  }

  const amountCents = session.amount_total ?? 0;
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : null;

  // Update the payment record: set the payment intent reference and mark succeeded.
  await db
    .update(payments)
    .set({
      providerReference: paymentIntentId ?? session.id,
      amountCents,
      status: "succeeded",
      receivedAt: new Date(),
    })
    .where(
      and(eq(payments.orderId, orderId), eq(payments.providerReference, session.id))
    );

  // Mark the order as paid.
  await db
    .update(orders)
    .set({ paymentStatus: "paid" })
    .where(eq(orders.id, orderId));

  // Only the signed checkout webhook can activate customer access, folders, and
  // downstream order automations. Browser success redirects are never trusted.
  await activatePaidOrder(orderId);

  // Persist an immutable coupon redemption record alongside the aggregate counter.
  // The successful Stripe webhook is the sole source of truth for redemption.
  if (couponId) {
    const couponRows = await db.select({ code: coupons.code }).from(coupons).where(eq(coupons.id, couponId)).limit(1);
    const paymentRows = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, "succeeded"))).orderBy(desc(payments.receivedAt)).limit(1);
    const customerId = session.metadata?.userId ? Number(session.metadata.userId) : null;
    if (couponRows[0] && customerId) {
      await db.insert(couponRedemptions).values({
        couponId,
        orderId,
        userId: customerId,
        paymentId: paymentRows[0]?.id ?? null,
        codeSnapshot: couponRows[0].code,
        discountCents: Math.max(0, (session.amount_subtotal ?? amountCents) - amountCents),
      });
      await db.update(coupons).set({ redemptionCount: sql`${coupons.redemptionCount} + 1` }).where(eq(coupons.id, couponId));
      await recordActivity({
        actorUserId: customerId,
        actorRole: "customer",
        action: "coupon.redeemed",
        entityType: "coupon",
        entityId: couponId,
        summary: `Coupon ${couponRows[0].code} redeemed on order ${orderId}`,
        changes: { orderId, discountCents: Math.max(0, (session.amount_subtotal ?? amountCents) - amountCents) },
      });
    }
  }

  // Coupon and payment evidence are now final, so create/send the one branded
  // invoice email with the actual settled amount and immutable discount record.
  await queueAutomaticCustomerInvoiceEmail(orderId);

  // Record referral commission (5% of amount).
  if (referrerId) {
    const commissionCents = Math.round(amountCents * 0.05);
    await db.insert(referrals).values({
      referrerUserId: referrerId,
      referredUserId: null,
      orderId,
      rewardCents: commissionCents,
      status: "pending",
      code: `AUTO-${orderId}`,
    });
  }

  await recordActivity({
    actorUserId: null,
    action: "payment.completed",
    entityType: "order",
    entityId: orderId,
    summary: `Payment completed for order ${orderId}: ${amountCents} cents`,
  });

  logger.info("stripe.checkout.completed", { orderId, amountCents });
}

async function handlePaymentFailed(intent: Stripe.PaymentIntent) {
  const orderId = intent.metadata?.orderId ? Number(intent.metadata.orderId) : null;
  if (!orderId) return;

  await db
    .update(payments)
    .set({ status: "failed" })
    .where(
      and(eq(payments.orderId, orderId), eq(payments.providerReference, intent.id))
    );

  await db
    .update(orders)
    .set({ paymentStatus: "failed" })
    .where(eq(orders.id, orderId));

  await recordSecurityEvent({
    eventType: "encryption.failure",
    outcome: "failure",
    message: `Payment failed for order ${orderId}: ${intent.last_payment_error?.message ?? "unknown"}`,
    metadata: { orderId, intentId: intent.id },
  });

  logger.warn("stripe.payment.failed", { orderId, intentId: intent.id });
}

async function handleChargeRefunded(charge: Stripe.Charge) {
  const orderId = charge.metadata?.orderId ? Number(charge.metadata.orderId) : null;
  if (!orderId) return;

  const refundedCents = charge.amount_refunded;
  const isFullRefund = charge.refunded;

  await db
    .update(orders)
    .set({ paymentStatus: isFullRefund ? "refunded" : "partially_refunded" })
    .where(eq(orders.id, orderId));

  // A full refund is an irreversible customer-work closure, not merely a
  // payment label. Partial refunds intentionally retain the active workflow.
  if (isFullRefund) {
    await transitionOrder({
      orderId,
      to: "refunded",
      actorUserId: 0,
      actorRole: "system",
      reason: "Stripe confirmed a full refund",
    });
  }

  // Complete the reserved portal refund when this webhook corresponds to an
  // administrator-initiated request. Direct Stripe-dashboard refunds retain a
  // separate system-attributed record for reconciliation.
  const pending = await db.select({ id: refunds.id }).from(refunds)
    .where(and(eq(refunds.orderId, orderId), sql`${refunds.status} IN ('requested', 'pending')`))
    .orderBy(desc(refunds.createdAt)).limit(1);
  if (pending[0]) {
    await db.update(refunds).set({ status: "completed", processedAt: new Date() }).where(eq(refunds.id, pending[0].id));
  } else {
    await db.insert(refunds).values({
      orderId,
      paymentId: null,
      amountCents: refundedCents,
      reason: `Stripe webhook: charge ${charge.id}`,
      providerReference: `charge:${charge.id}`,
      status: "completed",
      requestedByUserId: 0,
      processedAt: new Date(),
    });
  }

  logger.info("stripe.charge.refunded", { orderId, refundedCents, isFullRefund });
}

// ---------------------------------------------------------------------------
// Admin: initiate refund
// ---------------------------------------------------------------------------

export async function initiateRefund(
  orderId: number,
  amountCents: number,
  reason: string,
  requestedByUserId: number
 ): Promise<{ refundId: string; localRefundId: number; remainingCents: number }> {
  const stripe = await getStripeAsync();

  const paymentRows = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.orderId, orderId),
        eq(payments.provider, "stripe"),
        eq(payments.status, "succeeded")
      )
    )
    .orderBy(desc(payments.receivedAt))
    .limit(1);

  if (paymentRows.length === 0) {
    throw new Error("No successful Stripe payment found for this order.");
  }

  const payment = paymentRows[0]!;

  const prior = await db.select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)` }).from(refunds).where(and(eq(refunds.paymentId, payment.id), sql`${refunds.status} IN ('requested', 'pending', 'completed')`));
  const alreadyCommitted = Number(prior[0]?.total ?? 0);
  const availableCents = payment.amountCents - alreadyCommitted;
  if (amountCents > availableCents) {
    throw new Error(`Refund exceeds the remaining refundable amount of ${availableCents} cents.`);
  }

  const created = await db.insert(refunds).values({
    orderId,
    paymentId: payment.id,
    amountCents,
    reason,
    status: "requested",
    requestedByUserId,
  });
  const localRefundId = Number((created[0] as { insertId?: number }).insertId ?? 0);
  if (!localRefundId) throw new Error("Could not reserve the refund request.");

  try {
    const refund = await stripe.refunds.create({
      payment_intent: payment.providerReference!,
      amount: amountCents,
      reason: "requested_by_customer",
      metadata: { orderId: String(orderId), reason, readyPacketsRefundId: String(localRefundId) },
    }, { idempotencyKey: `readypackets-refund-${localRefundId}` });
    await db.update(refunds).set({
      providerReference: refund.id,
      status: refund.status === "succeeded" ? "completed" : "pending",
      approvedByUserId: requestedByUserId,
      processedAt: refund.status === "succeeded" ? new Date() : null,
    }).where(eq(refunds.id, localRefundId));
    await recordActivity({
      actorUserId: requestedByUserId,
      actorRole: "admin",
      action: "refund.initiated",
      entityType: "refund",
      entityId: localRefundId,
      severity: "warning",
      summary: `Initiated Stripe refund of ${amountCents} cents for order ${orderId}`,
      changes: { orderId, paymentId: payment.id, amountCents, stripeRefundId: refund.id, reason },
    });
    logger.info("stripe.refund.initiated", { orderId, amountCents, refundId: refund.id, localRefundId });
    return { refundId: refund.id, localRefundId, remainingCents: availableCents - amountCents };
  } catch (error) {
    await db.update(refunds).set({ status: "failed" }).where(eq(refunds.id, localRefundId));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Admin: list payments
// ---------------------------------------------------------------------------

export async function listPayments(page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const rows = await db
    .select()
    .from(payments)
    .orderBy(desc(payments.receivedAt))
    .limit(pageSize)
    .offset(offset);

  const countResult = await db
    .select({ total: sql<number>`count(*)` })
    .from(payments);

  return { rows, total: Number(countResult[0]?.total ?? 0) };
}
