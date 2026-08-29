/**
 * Public router — everything the marketing site needs, with no authentication.
 *
 * Responses are deliberately narrow: only approved reviews, only published
 * policy versions, and for the forum only a truncated teaser, so the public
 * surface cannot be used to enumerate members or read private discussion.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  changelogEntries,
  contactMessages,
  forumCategories,
  forumTopics,
  homeContentBlocks,
  maintenanceSubscribers,
  newsletterSubscribers,
  policyDocuments,
  policyVersions,
  reviews,
  users,
} from "../db/schema.js";
import { blindIndex, encryptField, hashToken, randomToken } from "../security/crypto.js";
import { decryptUser, displayNameOf } from "../db/users.js";
import { getCatalog } from "../services/catalog.js";
import { getMaintenanceState, isFeatureEnabled } from "../services/settings.js";
import { getCatalogPresentationSettings } from "../services/catalogPresentation.js";
import { recordActivity } from "../observability/audit.js";
import { queueTemplatedEmail, wrapHtmlBody } from "../services/email.js";
import { publicProcedure, router } from "../trpc/trpc.js";
import { POLICY_SLUGS } from "../../shared/domain.js";

const TEASER_LENGTH = 260;

export const publicRouter = router({
  catalog: publicProcedure.query(async () => getCatalog()),

  /**
   * Public display preferences only; checkout and protected customer quotes
   * remain server-authoritative regardless of what the marketing site shows.
   */
  catalogPresentation: publicProcedure.query(async () => getCatalogPresentationSettings()),

  /** Legacy response retained for native/mobile compatibility. */
  catalogPriceVisibility: publicProcedure.query(async () => {
    const presentation = await getCatalogPresentationSettings();
    return { visible: presentation.pricingMode === "show", mode: presentation.pricingMode };
  }),

  homeContent: publicProcedure.query(async () => {
    const blocks = await db
      .select()
      .from(homeContentBlocks)
      .where(eq(homeContentBlocks.enabled, true))
      .orderBy(homeContentBlocks.sortOrder);
    return blocks;
  }),

  siteStatus: publicProcedure.query(async () => {
    const [maintenance, forum, reviewsEnabled, changelog, presentation] = await Promise.all([
      getMaintenanceState(),
      isFeatureEnabled("forum", true),
      isFeatureEnabled("reviews", true),
      isFeatureEnabled("changelog", true),
      getCatalogPresentationSettings(),
    ]);
    return {
      maintenance,
      features: { forum, reviews: reviewsEnabled, changelog },
      navigation: {
        reviewsVisible: presentation.publicReviewsNavigationVisible,
        communityVisible: presentation.publicCommunityNavigationVisible,
      },
    };
  }),

  reviews: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(12) }).optional())
    .query(async ({ input }) => {
      if (!(await isFeatureEnabled("reviews", true))) return { enabled: false as const, items: [], average: null };

      const rows = await db
        .select({
          id: reviews.id,
          rating: reviews.rating,
          title: reviews.title,
          body: reviews.body,
          displayName: reviews.displayName,
          publishedAt: reviews.publishedAt,
          userId: reviews.userId,
        })
        .from(reviews)
        .where(eq(reviews.status, "approved"))
        .orderBy(desc(reviews.publishedAt))
        .limit(input?.limit ?? 12);

      const averageRows = await db
        .select({
          average: sql<number>`AVG(${reviews.rating})`,
          total: sql<number>`COUNT(*)`,
        })
        .from(reviews)
        .where(eq(reviews.status, "approved"));

      // Fall back to the reviewer's preferred name only when they supplied no display name.
      const authorIds = [...new Set(rows.map((row) => row.userId))];
      const authorRows =
        authorIds.length > 0
          ? await db.select().from(users).where(sql`${users.id} IN ${authorIds}`)
          : [];
      const authorNames = new Map(
        authorRows.map((row) => {
          const user = decryptUser(row);
          return [user.id, displayNameOf(user)];
        }),
      );

      return {
        enabled: true as const,
        items: rows.map((row) => ({
          id: row.id,
          rating: row.rating,
          title: row.title,
          body: row.body,
          author: row.displayName ?? authorNames.get(row.userId) ?? "Verified client",
          publishedAt: row.publishedAt,
        })),
        average: averageRows[0]?.average ? Number(averageRows[0].average) : null,
        total: Number(averageRows[0]?.total ?? 0),
      };
    }),

  /** Truncated forum content for non-members; full bodies are never returned. */
  forumTeaser: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(20).default(6) }).optional())
    .query(async ({ input }) => {
      if (!(await isFeatureEnabled("forum", true))) {
        return { enabled: false as const, categories: [], topics: [] };
      }

      const categories = await db
        .select({
          id: forumCategories.id,
          slug: forumCategories.slug,
          name: forumCategories.name,
          description: forumCategories.description,
        })
        .from(forumCategories)
        .orderBy(forumCategories.sortOrder);

      const topics = await db
        .select({
          id: forumTopics.id,
          title: forumTopics.title,
          body: forumTopics.body,
          replyCount: forumTopics.replyCount,
          createdAt: forumTopics.createdAt,
          categoryId: forumTopics.categoryId,
        })
        .from(forumTopics)
        .where(and(eq(forumTopics.status, "published"), isNull(forumTopics.deletedAt)))
        .orderBy(desc(forumTopics.createdAt))
        .limit(input?.limit ?? 6);

      return {
        enabled: true as const,
        categories,
        topics: topics.map((topic) => ({
          id: topic.id,
          title: topic.title,
          excerpt:
            topic.body.length > TEASER_LENGTH
              ? `${topic.body.slice(0, TEASER_LENGTH).trimEnd()}…`
              : topic.body,
          truncated: topic.body.length > TEASER_LENGTH,
          replyCount: topic.replyCount,
          createdAt: topic.createdAt,
          categoryId: topic.categoryId,
        })),
      };
    }),

  changelog: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).optional())
    .query(async ({ input }) => {
      if (!(await isFeatureEnabled("changelog", true))) return { enabled: false as const, items: [] };
      const items = await db
        .select({
          id: changelogEntries.id,
          version: changelogEntries.version,
          title: changelogEntries.title,
          bodyMarkdown: changelogEntries.bodyMarkdown,
          entryType: changelogEntries.entryType,
          releasedAt: changelogEntries.releasedAt,
        })
        .from(changelogEntries)
        .where(eq(changelogEntries.isPublic, true))
        .orderBy(desc(changelogEntries.releasedAt))
        .limit(input?.limit ?? 20);
      return { enabled: true as const, items };
    }),

  policy: publicProcedure
    .input(z.object({ slug: z.enum(POLICY_SLUGS) }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          title: policyDocuments.title,
          slug: policyDocuments.slug,
          version: policyVersions.version,
          effectiveDate: policyVersions.effectiveDate,
          bodyMarkdown: policyVersions.bodyMarkdown,
        })
        .from(policyDocuments)
        .innerJoin(policyVersions, eq(policyVersions.policyId, policyDocuments.id))
        .where(and(eq(policyDocuments.slug, input.slug), eq(policyDocuments.isVisible, true), eq(policyVersions.published, true)))
        .orderBy(desc(policyVersions.id))
        .limit(1);

      const policy = rows[0];
      if (!policy) throw new TRPCError({ code: "NOT_FOUND", message: "Policy not found." });
      return policy;
    }),

  policyList: publicProcedure.query(async () => {
    return db
      .select({
        slug: policyDocuments.slug,
        title: policyDocuments.title,
        publicRoute: policyDocuments.publicRoute,
      })
      .from(policyDocuments)
      .where(eq(policyDocuments.isVisible, true))
      .orderBy(policyDocuments.id);
  }),

  submitContact: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().toLowerCase().email().max(254),
        company: z.string().trim().max(160).optional(),
        topic: z.enum(["general", "packets", "bundle", "support", "partnership", "press"]),
        message: z.string().trim().min(20, "Please provide a little more detail.").max(5000),
        /** Honeypot: a real user never fills this in. */
        website: z.string().max(0).optional(),
        acceptedPrivacy: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.website) {
        // Silently accept and discard: bots receive no useful signal.
        return { ok: true as const };
      }
      if (!input.acceptedPrivacy) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Please confirm you have read the Privacy Policy.",
        });
      }

      await db.insert(contactMessages).values({
        nameEnc: encryptField(input.name, "contact") ?? "",
        emailEnc: encryptField(input.email, "contact") ?? "",
        emailIndex: blindIndex(input.email),
        companyEnc: encryptField(input.company ?? null, "contact"),
        topic: input.topic,
        messageEnc: encryptField(input.message, "contact") ?? "",
        ipAddress: ctx.clientIp.slice(0, 64),
      });

      void recordActivity({
        action: "contact.submitted",
        entityType: "contact_message",
        summary: `New contact enquiry (${input.topic})`,
        ipAddress: ctx.clientIp,
      });

      await queueTemplatedEmail({
        to: input.email,
        templateKey: "contact_acknowledgement",
        variables: { name: input.name },
        fallback: {
          subject: "We received your message — ReadyPackets",
          html: wrapHtmlBody(
            "We received your message",
            `<h1 style="margin:0 0 12px 0;font-size:20px;">Thank you, {{name}}</h1>
             <p style="margin:0 0 12px 0;">Your message has reached the ReadyPackets team. We reply to enquiries within one business day.</p>
             <p style="margin:0;">If your question concerns an existing order, replying to this email will keep everything in one thread.</p>`,
          ),
          text: "Thank you, {{name}}. We received your message and will reply within one business day.",
        },
      });

      return { ok: true as const };
    }),

  subscribeNewsletter: publicProcedure
    .input(
      z.object({
        email: z.string().trim().toLowerCase().email().max(254),
        website: z.string().max(0).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.website) return { ok: true as const };
      const token = randomToken(24);
      await db
        .insert(newsletterSubscribers)
        .values({
          emailIndex: blindIndex(input.email),
          emailEnc: encryptField(input.email, "newsletter") ?? "",
          confirmTokenHash: hashToken(token),
        })
        .onDuplicateKeyUpdate({ set: { confirmTokenHash: hashToken(token) } });
      // Double opt-in keeps the list clean and complies with consent requirements.
      await queueTemplatedEmail({
        to: input.email,
        templateKey: "newsletter_confirm",
        variables: { token },
        fallback: {
          subject: "Confirm your ReadyPackets subscription",
          html: wrapHtmlBody(
            "Confirm your subscription",
            `<p style="margin:0 0 12px 0;">Please confirm you would like occasional updates from ReadyPackets.</p>
             <p style="margin:0;">Confirmation code: <strong>{{token}}</strong></p>`,
          ),
        },
      });
      return { ok: true as const };
    }),

  subscribeMaintenance: publicProcedure
    .input(z.object({ email: z.string().trim().toLowerCase().email().max(254) }))
    .mutation(async ({ input }) => {
      await db
        .insert(maintenanceSubscribers)
        .values({
          emailIndex: blindIndex(input.email),
          emailEnc: encryptField(input.email, "maintenance") ?? "",
        })
        .onDuplicateKeyUpdate({ set: { notifiedAt: null } });
      return { ok: true as const };
    }),
});
