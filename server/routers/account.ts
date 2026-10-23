/**
 * Account self-service: notification preferences, data export, deletion.
 *
 * The export is assembled server-side and returned as a JSON document covering
 * every table that holds the caller's data. Deletion is a request rather than an
 * immediate purge, because financial and contractual records carry statutory
 * retention obligations that a self-service button must not override.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  intakeAnswers,
  intakeSubmissions,
  mndaAcceptances,
  notificationPreferences,
  orderNotes,
  orders,
  policyAcceptances,
  policyDocuments,
  policyVersions,
  reviews,
  ticketReplies,
  tickets,
  users,
} from "../db/schema.js";
import { decryptField } from "../security/crypto.js";
import { displayNameOf, getProfileValues, getUserById } from "../db/users.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import { revokeMobileSessionsForUser } from "../auth/mobileOidc.js";
import { listOrdersForUser } from "../services/orders.js";
import { queueTemplatedEmail, wrapHtmlBody } from "../services/email.js";
import { policyAcceptanceProcedure, protectedProcedure, router } from "../trpc/trpc.js";
import { listPendingRequiredPolicies } from "../services/policies.js";

const NOTIFICATION_CHANNELS = [
  "order_status",
  "deliverable_ready",
  "ticket_reply",
  "forum_reply",
  "product_updates",
  "maintenance_notices",
] as const;

export const accountRouter = router({
  notificationChannels: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({ channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, ctx.session.user.id));
    const stored = new Map(rows.map((row) => [row.channel, row.enabled]));
    return NOTIFICATION_CHANNELS.map((channel) => ({
      channel,
      enabled: stored.get(channel) ?? true,
    }));
  }),

  setNotificationPreference: protectedProcedure
    .input(
      z.object({
        channel: z.enum(NOTIFICATION_CHANNELS),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .insert(notificationPreferences)
        .values({
          userId: ctx.session.user.id,
          channel: input.channel,
          enabled: input.enabled,
        })
        .onDuplicateKeyUpdate({ set: { enabled: input.enabled } });
      return { ok: true as const };
    }),

  profileFields: protectedProcedure.query(async ({ ctx }) =>
    getProfileValues(ctx.session.user.id),
  ),

  /** Full data export in machine-readable form, per the Privacy Policy. */
  exportData: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const user = await getUserById(userId);
    if (!user) return { ok: false as const };

    const orderList = await listOrdersForUser(userId);

    const submissions = await db
      .select()
      .from(intakeSubmissions)
      .where(eq(intakeSubmissions.userId, userId));

    const intakeData: Record<string, unknown>[] = [];
    for (const submission of submissions) {
      const answers = await db
        .select()
        .from(intakeAnswers)
        .where(eq(intakeAnswers.submissionId, submission.id));
      intakeData.push({
        orderId: submission.orderId,
        status: submission.status,
        submittedAt: submission.submittedAt,
        projectName: decryptField(submission.projectNameEnc, `intake:${submission.id}`),
        desiredOutcomes: submission.desiredOutcomes,
        integrityChoice: submission.integrityChoice,
        answers: Object.fromEntries(
          answers.map((row) => [
            row.questionKey,
            decryptField(row.answerEnc, `intake:${submission.id}:${row.questionKey}`),
          ]),
        ),
      });
    }

    const ticketRows = await db.select().from(tickets).where(eq(tickets.userId, userId));
    const ticketData: Record<string, unknown>[] = [];
    for (const ticket of ticketRows) {
      const replies = await db
        .select()
        .from(ticketReplies)
        .where(and(eq(ticketReplies.ticketId, ticket.id), eq(ticketReplies.internalOnly, false)));
      ticketData.push({
        ticketNumber: ticket.ticketNumber,
        subject: decryptField(ticket.subjectEnc, `ticket:${ticket.id}`),
        category: ticket.category,
        status: ticket.status,
        createdAt: ticket.createdAt,
        replies: replies.map((reply) => ({
          body: decryptField(reply.bodyEnc, `ticket_reply:${reply.id}`),
          createdAt: reply.createdAt,
          authoredByYou: reply.authorUserId === userId,
        })),
      });
    }

    const reviewRows = await db
      .select({
        orderId: reviews.orderId,
        rating: reviews.rating,
        title: reviews.title,
        body: reviews.body,
        status: reviews.status,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .where(eq(reviews.userId, userId));

    const acceptanceRows = await db
      .select({
        policyVersionId: policyAcceptances.policyVersionId,
        acceptedAt: policyAcceptances.acceptedAt,
      })
      .from(policyAcceptances)
      .where(eq(policyAcceptances.userId, userId))
      .orderBy(desc(policyAcceptances.acceptedAt));

    const mndaRows = await db
      .select({
        orderId: mndaAcceptances.orderId,
        acceptedAt: mndaAcceptances.acceptedAt,
        signatureNameEnc: mndaAcceptances.signatureNameEnc,
        id: mndaAcceptances.id,
      })
      .from(mndaAcceptances)
      .where(eq(mndaAcceptances.userId, userId));

    const sharedNotes = await db
      .select({
        id: orderNotes.id,
        orderId: orderNotes.orderId,
        bodyEnc: orderNotes.bodyEnc,
        createdAt: orderNotes.createdAt,
      })
      .from(orderNotes)
      .where(and(eq(orderNotes.authorUserId, userId), eq(orderNotes.visibility, "shared")));

    void recordActivity({
      actorUserId: userId,
      actorRole: ctx.session.user.role,
      action: "account.export",
      entityType: "user",
      entityId: userId,
      summary: "Customer exported their personal data",
      ipAddress: ctx.clientIp,
    });

    return {
      ok: true as const,
      generatedAt: new Date().toISOString(),
      profile: {
        email: user.email,
        firstName: user.firstName,
        middleName: user.middleName,
        lastName: user.lastName,
        preferredName: user.preferredName,
        suffix: user.suffix,
        company: user.company,
        phone: user.phone,
        address: user.address,
        timezone: user.timezone,
        marketingOptIn: user.marketingOptIn,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      customFields: await getProfileValues(userId),
      orders: orderList,
      intakeSubmissions: intakeData,
      tickets: ticketData,
      reviews: reviewRows,
      policyAcceptances: acceptanceRows,
      mndaAcceptances: mndaRows.map((row) => ({
        orderId: row.orderId,
        acceptedAt: row.acceptedAt,
        signatureName: decryptField(row.signatureNameEnc, `mnda:${row.id}`),
      })),
      notes: sharedNotes.map((note) => ({
        orderId: note.orderId,
        body: decryptField(note.bodyEnc, `order_note:${note.id}`),
        createdAt: note.createdAt,
      })),
    };
  }),

  /**
   * Request deletion. The account is deactivated at once so it can no longer be
   * used, and the retention review is queued for an administrator.
   */
  requestDeletion: protectedProcedure
    .input(
      z.object({
        confirmPhrase: z.literal("DELETE MY ACCOUNT"),
        reason: z.string().trim().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const user = await getUserById(userId);
      if (!user) return { ok: false as const };

      const activeOrders = await db
        .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
        .from(orders)
        .where(eq(orders.userId, userId));
      const openOrders = activeOrders.filter(
        (order) => !["closed", "cancelled", "refunded"].includes(order.status),
      );

      await db.update(users).set({ status: "deactivated" }).where(eq(users.id, userId));
      await revokeMobileSessionsForUser(userId, "account_deletion_requested");

      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "notice",
        message: "Customer requested account deletion; account deactivated pending review",
        userId,
        ipAddress: ctx.clientIp,
        metadata: { openOrders: openOrders.length, reason: input.reason ?? null },
      });

      await queueTemplatedEmail({
        to: user.email,
        templateKey: "account_deletion_requested",
        variables: { name: displayNameOf(user), openOrders: openOrders.length },
        fallback: {
          subject: "We have received your deletion request",
          html: wrapHtmlBody(
            "Deletion request received",
            `<p style="margin:0 0 12px 0;">Hello {{name}}, your ReadyPackets account has been deactivated and your deletion request is now with our team.</p>
             <p style="margin:0 0 12px 0;">Records tied to completed engagements are retained for the period set out in our Privacy Policy before secure erasure.</p>
             <p style="margin:0;">If this was not you, reply to this message immediately.</p>`,
          ),
        },
      });

      return {
        ok: true as const,
        openOrders: openOrders.length,
        message:
          openOrders.length > 0
            ? "Your account has been deactivated. Because you have work in progress, our team will contact you to confirm how to proceed."
            : "Your account has been deactivated and your deletion request has been logged.",
      };
    }),

  /** Mark the onboarding wizard as completed for this user. */
  completeOnboarding: protectedProcedure.mutation(async ({ ctx }) => {
    await db
      .update(users)
      .set({ onboardingCompletedAt: new Date() })
      .where(eq(users.id, ctx.session.user.id));
    return { ok: true as const };
  }),

  /**
   * Returns policies that require acceptance and have not yet been accepted
   * by this user at the current published version.
   */
  pendingPolicies: policyAcceptanceProcedure.query(async ({ ctx }) =>
    listPendingRequiredPolicies(ctx.session.user.id),
  ),

  /** Accept a specific policy version. */
  acceptPolicy: policyAcceptanceProcedure
    .input(z.object({ policyVersionId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      await db
        .insert(policyAcceptances)
        .values({
          userId,
          policyVersionId: input.policyVersionId,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        })
        .onDuplicateKeyUpdate({
          set: {
            acceptedAt: new Date(),
            ipAddress: ctx.clientIp,
          },
        });
      return { ok: true as const };
    }),
});
