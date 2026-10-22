/**
 * Tier 4 & 5 router.
 *
 * Covers: newsletter management, referral programme management, login page
 * configurator, forum teaser click tracking, activity log replay, avatar
 * upload/serve, and admin preferences.
 */
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, isNull, like, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  activityLogs,
  forumTeaserClicks,
  forumTopics,
  loginPageConfig,
  newsletterSubscribers,
  referrals,
  securityLogs,
  siteSettings,
  users,
} from "../db/schema.js";
import { decryptField, isPublicUserId, randomToken } from "../security/crypto.js";
import { putObject, getObjectStream, objectExists, deleteObject, validateUpload } from "../services/storage.js";
import { recordActivity } from "../observability/audit.js";
import { adminProcedure, protectedProcedure, publicProcedure, staffProcedure, router } from "../trpc/trpc.js";
import { getUserById, displayNameOf } from "../db/users.js";
import {
  DEFAULT_LOGIN_SLIDES,
  LOGIN_SLIDESHOW_IMAGE_KEYS,
  MAX_LOGIN_SLIDESHOW_SLIDES,
  loginSlideshowSlidesOrDefault,
} from "../../shared/loginSlideshow.js";


async function resolveActivityUserReference(reference: string): Promise<number> {
  const value = reference.trim();
  if (isPublicUserId(value)) {
    const row = (await db.select({ id: users.id }).from(users).where(eq(users.publicId, value.toUpperCase())).limit(1))[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No account matches that public customer ID." });
    return row.id;
  }
  if (/^\d{1,10}$/.test(value)) return Number(value);
  throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a public customer ID in the form RPYY-XXXXXXXX, for example RP26-2UH4D3OT." });
}

// ── Newsletter management ─────────────────────────────────────────────────────

const newsletterRouter = router({
  /** List all newsletter subscribers (emails decrypted for admin view). */
  list: adminProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        confirmed: z.boolean().optional(),
        unsubscribed: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 100;
      const conditions = [];
      if (input.confirmed !== undefined) {
        conditions.push(eq(newsletterSubscribers.confirmed, input.confirmed));
      }
      if (input.unsubscribed === true) {
        conditions.push(sql`${newsletterSubscribers.unsubscribedAt} IS NOT NULL`);
      } else if (input.unsubscribed === false) {
        conditions.push(isNull(newsletterSubscribers.unsubscribedAt));
      }
      const rows = await db
        .select()
        .from(newsletterSubscribers)
        .where(conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])) : undefined)
        .orderBy(desc(newsletterSubscribers.createdAt))
        .limit(100)
        .offset(offset);
      const [countResult] = await db
        .select({ total: count() })
        .from(newsletterSubscribers)
        .where(conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])) : undefined);
      return {
        rows: rows.map((row) => ({
          id: row.id,
          email: decryptField(row.emailEnc, "newsletter") ?? "—",
          confirmed: row.confirmed,
          unsubscribedAt: row.unsubscribedAt,
          createdAt: row.createdAt,
        })),
        total: Number(countResult?.total ?? 0),
      };
    }),

  /** Export subscriber list as CSV-compatible array. */
  export: adminProcedure
    .input(z.object({ confirmedOnly: z.boolean().default(true) }))
    .query(async ({ input }) => {
      const conditions = [isNull(newsletterSubscribers.unsubscribedAt)];
      if (input.confirmedOnly) {
        conditions.push(eq(newsletterSubscribers.confirmed, true));
      }
      const rows = await db
        .select()
        .from(newsletterSubscribers)
        .where(and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])))
        .orderBy(asc(newsletterSubscribers.createdAt));
      return rows.map((row) => ({
        email: decryptField(row.emailEnc, "newsletter") ?? "",
        confirmed: row.confirmed,
        subscribedAt: row.createdAt.toISOString(),
      }));
    }),

  /** Unsubscribe a specific subscriber (admin action). */
  unsubscribe: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(newsletterSubscribers)
        .set({ unsubscribedAt: new Date() })
        .where(eq(newsletterSubscribers.id, input.id));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "newsletter.unsubscribe",
        entityType: "newsletter_subscriber",
        entityId: input.id,
        summary: `Admin unsubscribed newsletter subscriber #${input.id}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /** Delete a subscriber record permanently. */
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.id, input.id));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "newsletter.delete",
        entityType: "newsletter_subscriber",
        entityId: input.id,
        summary: `Admin deleted newsletter subscriber #${input.id}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /** Stats: total, confirmed, unsubscribed. */
  stats: adminProcedure.query(async () => {
    const [totals] = await db
      .select({
        total: count(),
        confirmed: sql<number>`SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END)`,
        unsubscribed: sql<number>`SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END)`,
      })
      .from(newsletterSubscribers);
    return {
      total: Number(totals?.total ?? 0),
      confirmed: Number(totals?.confirmed ?? 0),
      unsubscribed: Number(totals?.unsubscribed ?? 0),
    };
  }),
});

// ── Referral programme management ────────────────────────────────────────────

const referralRouter = router({
  /** List all referrals with referrer names. */
  list: staffProcedure
    .input(z.object({ page: z.number().int().min(1).default(1), status: z.string().optional() }))
    .query(async ({ input }) => {
      const offset = (input.page - 1) * 50;
      const conditions = [];
      if (input.status) conditions.push(eq(referrals.status, input.status));
      const rows = await db
        .select()
        .from(referrals)
        .where(conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])) : undefined)
        .orderBy(desc(referrals.createdAt))
        .limit(50)
        .offset(offset);
      const [countResult] = await db
        .select({ total: count() })
        .from(referrals)
        .where(conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])) : undefined);
      // Resolve referrer names
      const referrerIds = [...new Set(rows.map((r) => r.referrerUserId))];
      const names = new Map<number, string>();
      for (const id of referrerIds) {
        const user = await getUserById(id);
        if (user) names.set(id, displayNameOf(user));
      }
      return {
        rows: rows.map((row) => ({
          id: row.id,
          referrerName: names.get(row.referrerUserId) ?? `User #${row.referrerUserId}`,
          referrerUserId: row.referrerUserId,
          code: row.code,
          orderId: row.orderId,
          rewardCents: row.rewardCents,
          status: row.status,
          createdAt: row.createdAt,
        })),
        total: Number(countResult?.total ?? 0),
      };
    }),

  /** Update referral status (approve/reject/paid). */
  updateStatus: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        status: z.enum(["pending", "approved", "paid", "rejected"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db.update(referrals).set({ status: input.status }).where(eq(referrals.id, input.id));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "referral.status_update",
        entityType: "referral",
        entityId: input.id,
        summary: `Referral #${input.id} status changed to ${input.status}`,
        changes: { status: input.status },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /** Stats: total, pending, approved, paid, total reward. */
  stats: adminProcedure.query(async () => {
    const [totals] = await db
      .select({
        total: count(),
        pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
        approved: sql<number>`SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)`,
        paid: sql<number>`SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END)`,
        totalRewardCents: sql<number>`SUM(reward_cents)`,
      })
      .from(referrals);
    return {
      total: Number(totals?.total ?? 0),
      pending: Number(totals?.pending ?? 0),
      approved: Number(totals?.approved ?? 0),
      paid: Number(totals?.paid ?? 0),
      totalRewardCents: Number(totals?.totalRewardCents ?? 0),
    };
  }),

  /** Get or generate a referral code for the current user. */
  myCode: protectedProcedure.query(async ({ ctx }) => {
    const userRow = await db
      .select({ referralCode: users.referralCode })
      .from(users)
      .where(eq(users.id, ctx.session.user.id))
      .limit(1);
    const existing = userRow[0]?.referralCode;
    if (existing) return { code: existing };
    // Generate a new code: 8 uppercase alphanumeric chars
    const code = randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8).padEnd(8, "X");
    await db.update(users).set({ referralCode: code }).where(eq(users.id, ctx.session.user.id));
    return { code };
  }),

  /** Referral statistics visible only to the current referrer. */
  myStats: protectedProcedure.query(async ({ ctx }) => {
    const [totals] = await db
      .select({
        total: count(),
        pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
        approved: sql<number>`SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)`,
        paid: sql<number>`SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END)`,
        totalRewardCents: sql<number>`SUM(reward_cents)`,
        paidRewardCents: sql<number>`SUM(CASE WHEN status = 'paid' THEN reward_cents ELSE 0 END)`,
      })
      .from(referrals)
      .where(eq(referrals.referrerUserId, ctx.session.user.id));
    return {
      total: Number(totals?.total ?? 0),
      pending: Number(totals?.pending ?? 0),
      approved: Number(totals?.approved ?? 0),
      paid: Number(totals?.paid ?? 0),
      totalRewardCents: Number(totals?.totalRewardCents ?? 0),
      paidRewardCents: Number(totals?.paidRewardCents ?? 0),
    };
  }),

  /** Get the referral reward configuration. */
  getRewardConfig: adminProcedure.query(async () => {
    const rows = await db
      .select({ key: siteSettings.settingKey, value: siteSettings.settingValue })
      .from(siteSettings)
      .where(
        and(
          eq(siteSettings.settingKey, "referral.reward_type"),
        )
      );
    // Also fetch all referral settings
    const allSettings = await db
      .select({ key: siteSettings.settingKey, value: siteSettings.settingValue })
      .from(siteSettings)
      .where(sql`setting_key LIKE 'referral.%'`);
    const map: Record<string, string> = {};
    for (const s of allSettings) map[s.key] = s.value ?? "";
    return {
      rewardType: map["referral.reward_type"] ?? "cash",
      cashAmountCents: Number(map["referral.cash_amount_cents"] ?? "0"),
      discountPercent: Number(map["referral.discount_percent"] ?? "5"),
      commissionPercent: Number(map["referral.commission_percent"] ?? "5"),
      minOrderCents: Number(map["referral.min_order_cents"] ?? "0"),
      enabled: map["referral.enabled"] !== "false",
      couponPrefix: map["referral.coupon_prefix"] ?? "REF-",
    };
  }),

  /** Save the referral reward configuration. */
  saveRewardConfig: adminProcedure
    .input(
      z.object({
        rewardType: z.enum(["cash", "coupon", "both"]),
        cashAmountCents: z.number().int().min(0),
        discountPercent: z.number().min(0).max(100),
        commissionPercent: z.number().min(0).max(100),
        minOrderCents: z.number().int().min(0),
        enabled: z.boolean(),
        couponPrefix: z.string().max(20).default("REF-"),
      })
    )
    .mutation(async ({ input }) => {
      const settings: Record<string, string> = {
        "referral.reward_type": input.rewardType,
        "referral.cash_amount_cents": String(input.cashAmountCents),
        "referral.discount_percent": String(input.discountPercent),
        "referral.commission_percent": String(input.commissionPercent),
        "referral.min_order_cents": String(input.minOrderCents),
        "referral.enabled": input.enabled ? "true" : "false",
        "referral.coupon_prefix": input.couponPrefix,
      };
      for (const [key, value] of Object.entries(settings)) {
        const existing = await db
          .select({ settingKey: siteSettings.settingKey })
          .from(siteSettings)
          .where(eq(siteSettings.settingKey, key))
          .limit(1);
        if (existing.length > 0) {
          await db.update(siteSettings).set({ settingValue: value }).where(eq(siteSettings.settingKey, key));
        } else {
          await db.insert(siteSettings).values({ settingKey: key, settingValue: value, category: "referral", isSecret: false });
        }
      }
    }),
});

// ── Login page configurator ───────────────────────────────────────────────────

const loginConfigRouter = router({
  /** Get the current login page configuration. */
  get: publicProcedure.query(async () => {
    const rows = await db.select().from(loginPageConfig).where(eq(loginPageConfig.id, 1)).limit(1);
    const config = rows[0];
    if (!config) {
      return {
        heroHeadline: null,
        heroSubheadline: null,
        showTestimonial: false,
        testimonialText: null,
        testimonialAuthor: null,
        showFeatureList: true,
        featureList: ["Structured intake and synthesis", "Versioned deliverables in your portal", "Confidential by default — NDA first"] as string[],
        backgroundStyle: "default",
        accentColor: null,
        slideshowSlides: DEFAULT_LOGIN_SLIDES,
      };
    }
    return {
      heroHeadline: config.heroHeadline,
      heroSubheadline: config.heroSubheadline,
      showTestimonial: config.showTestimonial,
      testimonialText: config.testimonialText,
      testimonialAuthor: config.testimonialAuthor,
      showFeatureList: config.showFeatureList,
      featureList: (config.featureList as string[] | null) ?? [],
      backgroundStyle: config.backgroundStyle,
      accentColor: config.accentColor,
      slideshowSlides: loginSlideshowSlidesOrDefault(config.slideshowSlides),
    };
  }),

  /** Update the login page configuration. */
  update: adminProcedure
    .input(
      z.object({
        heroHeadline: z.string().trim().max(255).nullable().optional(),
        heroSubheadline: z.string().trim().max(512).nullable().optional(),
        showTestimonial: z.boolean().optional(),
        testimonialText: z.string().trim().max(1000).nullable().optional(),
        testimonialAuthor: z.string().trim().max(128).nullable().optional(),
        showFeatureList: z.boolean().optional(),
        featureList: z.array(z.string().trim().max(200)).max(10).optional(),
        backgroundStyle: z.enum(["default", "gradient", "dark", "brand"]).optional(),
        accentColor: z.string().trim().max(32).nullable().optional(),
        slideshowSlides: z.array(z.object({
          eyebrow: z.string().trim().min(1).max(80),
          title: z.string().trim().min(1).max(120),
          description: z.string().trim().min(1).max(360),
          imageKey: z.enum(LOGIN_SLIDESHOW_IMAGE_KEYS),
        })).min(1).max(MAX_LOGIN_SLIDESHOW_SLIDES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch: Partial<typeof loginPageConfig.$inferInsert> = {
        updatedByUserId: ctx.session.user.id,
      };
      if (input.heroHeadline !== undefined) patch.heroHeadline = input.heroHeadline;
      if (input.heroSubheadline !== undefined) patch.heroSubheadline = input.heroSubheadline;
      if (input.showTestimonial !== undefined) patch.showTestimonial = input.showTestimonial;
      if (input.testimonialText !== undefined) patch.testimonialText = input.testimonialText;
      if (input.testimonialAuthor !== undefined) patch.testimonialAuthor = input.testimonialAuthor;
      if (input.showFeatureList !== undefined) patch.showFeatureList = input.showFeatureList;
      if (input.featureList !== undefined) patch.featureList = input.featureList;
      if (input.backgroundStyle !== undefined) patch.backgroundStyle = input.backgroundStyle;
      if (input.accentColor !== undefined) patch.accentColor = input.accentColor;
      if (input.slideshowSlides !== undefined) patch.slideshowSlides = input.slideshowSlides;
      const existing = await db.select({ id: loginPageConfig.id }).from(loginPageConfig).where(eq(loginPageConfig.id, 1)).limit(1);
      if (existing[0]) {
        await db
          .update(loginPageConfig)
          .set(patch)
          .where(eq(loginPageConfig.id, 1));
      } else {
        await db.insert(loginPageConfig).values({ id: 1, ...patch });
      }
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "login_page.update",
        entityType: "login_page_config",
        entityId: 1,
        summary: "Login page configuration updated",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),
});

// ── Forum teaser click tracking ───────────────────────────────────────────────

const forumClickRouter = router({
  /** Record a click on a forum teaser topic card (public, fire-and-forget). */
  recordClick: publicProcedure
    .input(
      z.object({
        topicId: z.number().int().positive(),
        sessionId: z.string().trim().max(128).optional(),
        referrer: z.string().trim().max(512).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Hash the IP for deduplication without storing PII
      const ip = (ctx as { clientIp?: string }).clientIp ?? "";
      const ipHash = ip
        ? createHash("sha256").update(ip).digest("hex").slice(0, 64)
        : null;
      // Insert click record
      await db.insert(forumTeaserClicks).values({
        topicId: input.topicId,
        sessionId: input.sessionId ?? null,
        ipHash,
        referrer: input.referrer ?? null,
      });
      // Increment the counter on the topic
      await db
        .update(forumTopics)
        .set({ teaserClickCount: sql`${forumTopics.teaserClickCount} + 1` })
        .where(eq(forumTopics.id, input.topicId));
      return { ok: true as const };
    }),

  /** Get click analytics for the forum teaser (admin). */
  analytics: adminProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(async ({ input }) => {
      // Top topics by click count
      const topTopics = await db
        .select({
          topicId: forumTeaserClicks.topicId,
          clicks: count(),
        })
        .from(forumTeaserClicks)
        .groupBy(forumTeaserClicks.topicId)
        .orderBy(desc(count()))
        .limit(input.limit);

      // Resolve topic titles
      const topicIds = topTopics.map((t) => t.topicId);
      const topicRows = topicIds.length > 0
        ? await db
            .select({ id: forumTopics.id, title: forumTopics.title, teaserClickCount: forumTopics.teaserClickCount })
            .from(forumTopics)
            .where(sql`${forumTopics.id} IN (${sql.join(topicIds.map((id) => sql`${id}`), sql`, `)})`)
        : [];
      const titleMap = new Map(topicRows.map((t) => [t.id, t.title]));
      const countMap = new Map(topicRows.map((t) => [t.id, t.teaserClickCount]));

      // Total clicks
      const [totalResult] = await db.select({ total: count() }).from(forumTeaserClicks);

      return {
        totalClicks: Number(totalResult?.total ?? 0),
        topTopics: topTopics.map((t) => ({
          topicId: t.topicId,
          title: titleMap.get(t.topicId) ?? `Topic #${t.topicId}`,
          sessionClicks: Number(t.clicks),
          totalClicks: countMap.get(t.topicId) ?? 0,
        })),
      };
    }),
});

// ── Activity log replay view ──────────────────────────────────────────────────

const activityReplayRouter = router({
  /** Get activity log entries for a specific entity (replay view). */
  entityHistory: adminProcedure
    .input(
      z.object({
        entityType: z.string().trim().max(48),
        entityId: z.string().trim().max(64),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const resolvedEntityId = input.entityType === "user" ? String(await resolveActivityUserReference(input.entityId)) : String(input.entityId);
      const rows = await db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.entityType, input.entityType),
            eq(activityLogs.entityId, resolvedEntityId),
          ),
        )
        .orderBy(asc(activityLogs.createdAt))
        .limit(input.limit);
      const names = new Map<number, string>();
      for (const actorId of new Set(rows.map((r) => r.actorUserId).filter(Boolean))) {
        const user = await getUserById(actorId as number);
        names.set(actorId as number, user ? displayNameOf(user) : "Deleted user");
      }
      return rows.map((row) => ({
        id: row.id,
        actor: row.actorUserId ? (names.get(row.actorUserId) ?? "Unknown") : "System",
        actorRole: row.actorRole,
        action: row.action,
        severity: row.severity,
        summary: row.summary,
        changes: row.changes as Record<string, unknown> | null,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      }));
    }),

  /** Get a timeline of all actions by a specific user. */
  userTimeline: adminProcedure
    .input(
      z.object({
        userReference: z.string().trim().min(1).max(32),
        limit: z.number().int().min(1).max(200).default(100),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }),
    )
    .query(async ({ input }) => {
      const userId = await resolveActivityUserReference(input.userReference);
      const conditions = [eq(activityLogs.actorUserId, userId)];
      if (input.from) conditions.push(gte(activityLogs.createdAt, new Date(input.from)));
      if (input.to) conditions.push(lte(activityLogs.createdAt, new Date(input.to)));
      const rows = await db
        .select()
        .from(activityLogs)
        .where(and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])))
        .orderBy(desc(activityLogs.createdAt))
        .limit(input.limit);
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        severity: row.severity,
        summary: row.summary,
        changes: row.changes as Record<string, unknown> | null,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      }));
    }),

  /** Cross-system activity search for operational investigation and audit review. */
  search: adminProcedure
    .input(z.object({
      action: z.string().trim().max(96).optional(),
      entityType: z.string().trim().max(48).optional(),
      actorUserReference: z.string().trim().min(1).max(32).optional(),
      severity: z.enum(["debug", "info", "notice", "warning", "error", "critical"]).optional(),
      ipAddress: z.string().trim().max(64).optional(),
      query: z.string().trim().max(160).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).max(50_000).default(0),
    }))
    .query(async ({ input }) => {
      const conditions = [];
      if (input.action) conditions.push(like(activityLogs.action, `%${input.action}%`));
      if (input.entityType) conditions.push(eq(activityLogs.entityType, input.entityType));
      if (input.actorUserReference) conditions.push(eq(activityLogs.actorUserId, await resolveActivityUserReference(input.actorUserReference)));
      if (input.severity) conditions.push(eq(activityLogs.severity, input.severity));
      if (input.ipAddress) conditions.push(like(activityLogs.ipAddress, `%${input.ipAddress}%`));
      if (input.query) conditions.push(or(like(activityLogs.summary, `%${input.query}%`), like(activityLogs.action, `%${input.query}%`), like(activityLogs.entityId, `%${input.query}%`)));
      if (input.from) conditions.push(gte(activityLogs.createdAt, new Date(`${input.from}T00:00:00.000Z`)));
      if (input.to) conditions.push(lte(activityLogs.createdAt, new Date(`${input.to}T23:59:59.999Z`)));
      const where = conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])) : undefined;
      const [rows, totals] = await Promise.all([
        db.select({ entry: activityLogs, actorPublicId: users.publicId }).from(activityLogs).leftJoin(users, eq(users.id, activityLogs.actorUserId)).where(where).orderBy(desc(activityLogs.createdAt)).limit(input.limit).offset(input.offset),
        db.select({ total: count() }).from(activityLogs).where(where),
      ]);
      return { rows: rows.map((row) => ({ ...row.entry, actorPublicId: row.actorPublicId ?? null })), total: Number(totals[0]?.total ?? 0) };
    }),

  /** Summary statistics for the activity log. */
  summary: adminProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const conditions = [];
      if (input?.from) conditions.push(gte(activityLogs.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(activityLogs.createdAt, new Date(input.to)));
      const rows = await db
        .select({
          action: activityLogs.action,
          total: count(),
        })
        .from(activityLogs)
        .where(conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]])) : undefined)
        .groupBy(activityLogs.action)
        .orderBy(desc(count()))
        .limit(30);
      return rows.map((row) => ({ action: row.action, total: Number(row.total) }));
    }),
});

// ── Avatar management ─────────────────────────────────────────────────────────

const avatarRouter = router({
  /** Get the current user's avatar URL (or null). */
  getMyAvatar: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({ avatarStorageKey: users.avatarStorageKey })
      .from(users)
      .where(eq(users.id, ctx.session.user.id))
      .limit(1);
    const key = rows[0]?.avatarStorageKey ?? null;
    return { storageKey: key, hasAvatar: Boolean(key) };
  }),

  /** Delete the current user's avatar. */
  deleteMyAvatar: protectedProcedure.mutation(async ({ ctx }) => {
    const rows = await db
      .select({ avatarStorageKey: users.avatarStorageKey })
      .from(users)
      .where(eq(users.id, ctx.session.user.id))
      .limit(1);
    const key = rows[0]?.avatarStorageKey;
    if (key) {
      await deleteObject(key).catch(() => null);
    }
    await db.update(users).set({ avatarStorageKey: null }).where(eq(users.id, ctx.session.user.id));
    void recordActivity({
      actorUserId: ctx.session.user.id,
      actorRole: ctx.session.user.role,
      action: "profile.avatar_delete",
      entityType: "user",
      entityId: ctx.session.user.id,
      summary: "User deleted their avatar",
      ipAddress: ctx.clientIp,
    });
    return { ok: true as const };
  }),

  /** Admin: get avatar storage key for a specific user. */
  getForUser: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const rows = await db
        .select({ avatarStorageKey: users.avatarStorageKey })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      return { storageKey: rows[0]?.avatarStorageKey ?? null };
    }),

  /** Admin: delete a user's avatar. */
  deleteForUser: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db
        .select({ avatarStorageKey: users.avatarStorageKey })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      const key = rows[0]?.avatarStorageKey;
      if (key) {
        await deleteObject(key).catch(() => null);
      }
      await db.update(users).set({ avatarStorageKey: null }).where(eq(users.id, input.userId));
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "profile.avatar_delete",
        entityType: "user",
        entityId: input.userId,
        summary: `Admin deleted avatar for user #${input.userId}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),
});

// ── SIEM export UI helpers ────────────────────────────────────────────────────

const siemUiRouter = router({
  /** Quick stats for the SIEM export page. */
  stats: adminProcedure.query(async () => {
    const [secCount] = await db.select({ total: count() }).from(securityLogs);
    const [actCount] = await db.select({ total: count() }).from(activityLogs);
    return {
      securityLogCount: Number(secCount?.total ?? 0),
      activityLogCount: Number(actCount?.total ?? 0),
    };
  }),
});

// ── Root Tier 4 router ────────────────────────────────────────────────────────

export const tier4Router = router({
  newsletter: newsletterRouter,
  referral: referralRouter,
  loginConfig: loginConfigRouter,
  forumClick: forumClickRouter,
  activityReplay: activityReplayRouter,
  avatar: avatarRouter,
  siemUi: siemUiRouter,
});
