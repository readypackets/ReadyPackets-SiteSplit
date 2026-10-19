/**
 * Administrative security and system operations.
 *
 * This router exposes the controls that a self-hosted operator needs in order to
 * run the platform without shell access: rate limits, IP lists, feature flags,
 * settings, log review, alert handling, backups, and health.
 *
 * Secret settings are write-only through this API. A secret's value is never
 * returned, only whether it is present, so the admin panel cannot be used to
 * read credentials out of the database.
 */
import { TRPCError } from "@trpc/server";
import net from "node:net";
import { notifyMaintenanceStart, notifyMaintenanceEnd } from "../services/maintenanceNotify.js";
import { and, count, desc, eq, gt, gte, like, lte, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import {
  activityLogs,
  apiKeys,
  backupLog,
  emailLog,
  emailQueue,
  featureFlags,
  ipAllowlist,
  ipBlacklist,
  rateLimitConfigs,
  samlConfigs,
  securityLogs,
  siteSettings,
  systemAlerts,
  userSessions,
  users,
} from "../db/schema.js";
import { hashToken, randomToken } from "../security/crypto.js";
import { displayNameOf, getUserById } from "../db/users.js";
import { recordActivity, recordSecurityEvent } from "../observability/audit.js";
import {
  DEFAULT_RATE_LIMITS,
  getAllFeatureFlags,
  getSetting,
  getSettingBool,
  invalidateSettingsCache,
  setFeatureFlag,
  setSetting,
} from "../services/settings.js";
import { blacklistIp, invalidateIpCaches } from "../security/ipBlacklist.js";
import { detectPatternType, ipMatchesPattern } from "../security/ipAddress.js";
import { countQueuedEmails, sendTestEmail } from "../services/email.js";
import { revokeAllUserSessions, revokeSession } from "../auth/session.js";
import { pingDatabase } from "../db/client.js";
import { adminProcedure, router } from "../trpc/trpc.js";
import { RATE_LIMIT_CATEGORIES } from "../../shared/domain.js";
import { affectedRows } from "../db/result.js";
import { formatBusinessAddress, getBusinessProfile, saveBusinessProfile } from "../services/businessProfile.js";
import { getConsentConfig, getConsentOverview } from "../services/cookieConsent.js";
import { analyticsProviderValidation } from "../services/analyticsConfig.js";

const ipPatternSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(
    /^[0-9a-fA-F.:/-]+$/,
    "Enter a single address, a CIDR block such as 203.0.113.0/24, or a range such as 203.0.113.1-203.0.113.50.",
  );

const CERTIFICATE_CONTROL_SOCKET = "/run/readypackets/certificate-control.sock";

type CertificateControlStatus = {
  provider: "letsencrypt" | "cloudflare_origin" | "unknown";
  configured: boolean;
  rootPresent: boolean;
  certificatePath: string | null;
  subject: string | null;
  issuer: string | null;
  notBefore: string | null;
  notAfter: string | null;
  fingerprint: string | null;
  san: string | null;
  backup?: string;
};

type DomainControlStatus = {
  appUrl: string;
  hostname: string | null;
  aliases: string[];
  aliasesRemaining: number;
  certificate: CertificateControlStatus;
};

type DomainCutoverResult = CertificateControlStatus & {
  previousHostname: string;
  hostname: string;
  backup: string;
};

type PortalAliasResult = DomainControlStatus & {
  addedAlias: string;
  backup: string;
};

function runCertificateControl<T = CertificateControlStatus>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: CERTIFICATE_CONTROL_SOCKET });
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Certificate control request timed out.")); }, 35_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => { response += chunk; if (response.includes("\n")) socket.end(); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("close", () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(response.trim()) as { ok?: boolean; output?: CertificateControlStatus; error?: string };
        result.ok && result.output ? resolve(result.output as T) : reject(new Error(result.error ?? "Certificate control rejected the request."));
      } catch { reject(new Error("Certificate control returned an invalid response.")); }
    });
  });
}

export const adminSecurityRouter = router({
  /* ---------------------------------------------------------------- */
  /* Rate limiting                                                     */
  /* ---------------------------------------------------------------- */

  rateLimits: adminProcedure.query(async () => {
    const rows = await db.select().from(rateLimitConfigs);
    const stored = new Map(rows.map((row) => [row.category, row]));
    return RATE_LIMIT_CATEGORIES.map((category) => {
      const row = stored.get(category);
      const fallback = DEFAULT_RATE_LIMITS[category];
      return {
        category,
        label: row?.label ?? fallback.label,
        windowSeconds: row?.windowSeconds ?? fallback.windowSeconds,
        maxRequests: row?.maxRequests ?? fallback.maxRequests,
        enabled: row?.enabled ?? fallback.enabled,
        penaltyEnabled: row?.penaltyEnabled ?? fallback.penaltyEnabled,
      };
    });
  }),

  updateRateLimit: adminProcedure
    .input(
      z.object({
        category: z.enum(RATE_LIMIT_CATEGORIES),
        windowSeconds: z.number().int().min(10).max(86_400),
        maxRequests: z.number().int().min(1).max(100_000),
        enabled: z.boolean(),
        penaltyEnabled: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .insert(rateLimitConfigs)
        .values({
          category: input.category,
          label: DEFAULT_RATE_LIMITS[input.category].label,
          windowSeconds: input.windowSeconds,
          maxRequests: input.maxRequests,
          enabled: input.enabled,
          penaltyEnabled: input.penaltyEnabled,
        })
        .onDuplicateKeyUpdate({
          set: {
            windowSeconds: input.windowSeconds,
            maxRequests: input.maxRequests,
            enabled: input.enabled,
            penaltyEnabled: input.penaltyEnabled,
          },
        });
      invalidateSettingsCache();

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "security.rate_limit_update",
        entityType: "rate_limit",
        entityId: input.category,
        severity: "notice",
        summary: `Rate limit for ${input.category} set to ${input.maxRequests} per ${input.windowSeconds}s`,
        changes: { ...input },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* IP lists                                                          */
  /* ---------------------------------------------------------------- */

  blacklist: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(200) }).optional())
    .query(async ({ input }) =>
      db
        .select()
        .from(ipBlacklist)
        .orderBy(desc(ipBlacklist.createdAt))
        .limit(input?.limit ?? 200),
    ),

  addToBlacklist: adminProcedure
    .input(
      z.object({
        pattern: ipPatternSchema,
        reason: z.string().trim().min(3).max(255),
        expiresInHours: z.number().int().min(1).max(8_760).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Refuse to lock the operator out of their own session.
      if (input.pattern === ctx.clientIp) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That is your current address. Blocking it would end your own session.",
        });
      }
      await blacklistIp({
        pattern: input.pattern,
        reason: input.reason,
        source: "manual",
        expiresAt:
          input.expiresInHours === null
            ? null
            : new Date(Date.now() + input.expiresInHours * 3_600_000),
        createdByUserId: ctx.session.user.id,
      });
      void recordSecurityEvent({
        eventType: "ip.blocked",
        severity: "notice",
        message: `Administrator blacklisted ${input.pattern}`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { pattern: input.pattern, reason: input.reason },
      });
      return { ok: true as const };
    }),

  removeFromBlacklist: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db.delete(ipBlacklist).where(eq(ipBlacklist.id, input.id));
      invalidateIpCaches();
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "security.blacklist_remove",
        entityType: "ip_blacklist",
        entityId: input.id,
        summary: "Blacklist entry removed",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  allowlist: adminProcedure.query(async () =>
    db.select().from(ipAllowlist).orderBy(desc(ipAllowlist.createdAt)).limit(200),
  ),

  addToAllowlist: adminProcedure
    .input(
      z.object({
        pattern: ipPatternSchema,
        scope: z.enum(["admin", "maintenance", "all"]).default("admin"),
        note: z.string().trim().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .insert(ipAllowlist)
        .values({
          pattern: input.pattern,
          patternType: detectPatternType(input.pattern),
          scope: input.scope,
          note: input.note ?? null,
          createdByUserId: ctx.session.user.id,
        })
        .onDuplicateKeyUpdate({ set: { scope: input.scope, note: input.note ?? null } });
      invalidateIpCaches();
      return { ok: true as const };
    }),

  removeFromAllowlist: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db.delete(ipAllowlist).where(eq(ipAllowlist.id, input.id));
      invalidateIpCaches();
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Logs                                                              */
  /* ---------------------------------------------------------------- */

  securityLogs: adminProcedure
    .input(
      z
        .object({
          severity: z.enum(["debug", "info", "notice", "warning", "error", "critical"]).optional(),
          eventType: z.string().trim().max(64).optional(),
          limit: z.number().int().min(1).max(500).default(100),
          offset: z.number().int().min(0).max(50_000).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const conditions = [];
      if (input?.severity) conditions.push(eq(securityLogs.severity, input.severity));
      if (input?.eventType) conditions.push(eq(securityLogs.eventType, input.eventType));

      const rows = await db
        .select()
        .from(securityLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(securityLogs.createdAt))
        .limit(input?.limit ?? 100)
        .offset(input?.offset ?? 0);

      return rows.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        severity: row.severity,
        outcome: row.outcome,
        message: row.message,
        userId: row.userId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        metadata: row.metadata,
        createdAt: row.createdAt,
      }));
    }),

  /** Advanced searchable security-log stream for incident review. */
  securityLogSearch: adminProcedure
    .input(z.object({
      severity: z.enum(["debug", "info", "notice", "warning", "error", "critical"]).optional(),
      eventType: z.string().trim().max(64).optional(),
      outcome: z.string().trim().max(32).optional(),
      ipAddress: z.string().trim().max(64).optional(),
      userId: z.number().int().positive().optional(),
      query: z.string().trim().max(160).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).max(50_000).default(0),
    }))
    .query(async ({ input }) => {
      const conditions = [];
      if (input.severity) conditions.push(eq(securityLogs.severity, input.severity));
      if (input.eventType) conditions.push(like(securityLogs.eventType, `%${input.eventType}%`));
      if (input.outcome) conditions.push(eq(securityLogs.outcome, input.outcome));
      if (input.ipAddress) conditions.push(like(securityLogs.ipAddress, `%${input.ipAddress}%`));
      if (input.userId) conditions.push(eq(securityLogs.userId, input.userId));
      if (input.query) conditions.push(or(like(securityLogs.message, `%${input.query}%`), like(securityLogs.eventType, `%${input.query}%`)));
      if (input.from) conditions.push(gte(securityLogs.createdAt, new Date(`${input.from}T00:00:00.000Z`)));
      if (input.to) conditions.push(lte(securityLogs.createdAt, new Date(`${input.to}T23:59:59.999Z`)));
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const [rows, totals, activeBlocks] = await Promise.all([
        db.select({ entry: securityLogs, userPublicId: users.publicId }).from(securityLogs).leftJoin(users, eq(users.id, securityLogs.userId)).where(where).orderBy(desc(securityLogs.createdAt)).limit(input.limit).offset(input.offset),
        db.select({ total: count() }).from(securityLogs).where(where),
        db.select({ pattern: ipBlacklist.pattern }).from(ipBlacklist).where(or(isNull(ipBlacklist.expiresAt), gt(ipBlacklist.expiresAt, new Date()))),
      ]);
      return { rows: rows.map((row) => ({ ...row.entry, userPublicId: row.userPublicId ?? null, isBlocked: row.entry.ipAddress ? activeBlocks.some((block) => ipMatchesPattern(row.entry.ipAddress!, block.pattern)) : false })), total: Number(totals[0]?.total ?? 0) };
    }),

  sourceActivity: adminProcedure
    .input(z.object({ ipAddress: ipPatternSchema, limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ input }) => {
      const [entries, activeBlocks] = await Promise.all([
        db.select({ id: securityLogs.id, eventType: securityLogs.eventType, severity: securityLogs.severity, outcome: securityLogs.outcome, message: securityLogs.message, metadata: securityLogs.metadata, createdAt: securityLogs.createdAt }).from(securityLogs).where(eq(securityLogs.ipAddress, input.ipAddress)).orderBy(desc(securityLogs.createdAt)).limit(input.limit),
        db.select({ pattern: ipBlacklist.pattern }).from(ipBlacklist).where(or(isNull(ipBlacklist.expiresAt), gt(ipBlacklist.expiresAt, new Date()))),
      ]);
      return {
        ipAddress: input.ipAddress,
        blocked: activeBlocks.some((block) => ipMatchesPattern(input.ipAddress, block.pattern)),
        events: entries.map((entry) => {
          const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata as Record<string, unknown> : {};
          return { ...entry, method: typeof metadata.method === "string" ? metadata.method : null, path: typeof metadata.path === "string" ? metadata.path : null };
        }),
      };
    }),

  reviewSecurityLog: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const rows = await db.select({ entry: securityLogs, userPublicId: users.publicId }).from(securityLogs).leftJoin(users, eq(users.id, securityLogs.userId)).where(eq(securityLogs.id, input.id)).limit(1);
      const result = rows[0];
      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Security event not found." });
      const entry = result.entry;
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "security.log_reviewed", entityType: "security_log", entityId: entry.id, severity: "notice", summary: `Reviewed security event ${entry.eventType}`, ipAddress: ctx.clientIp });
      return { ...entry, userPublicId: result.userPublicId ?? null };
    }),

  blockLogIp: adminProcedure
    .input(z.object({ ipAddress: ipPatternSchema, reason: z.string().trim().min(3).max(255) }))
    .mutation(async ({ ctx, input }) => {
      if (input.ipAddress === ctx.clientIp) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot block your own current address." });
      await blacklistIp({ pattern: input.ipAddress, reason: input.reason, source: "security_log", expiresAt: null, createdByUserId: ctx.session.user.id });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "security.log_ip_blocked", entityType: "ip_blacklist", entityId: input.ipAddress, severity: "warning", summary: `Blocked ${input.ipAddress} from security log review`, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  banLogUser: adminProcedure
    .input(z.object({ userId: z.number().int().positive(), reason: z.string().trim().min(3).max(255) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot ban your own account from the log centre." });
      const affected = await db.update(users).set({ status: "deactivated", lockedUntil: null }).where(eq(users.id, input.userId));
      if (affectedRows(affected) === 0) throw new TRPCError({ code: "NOT_FOUND", message: "User account not found." });
      await revokeAllUserSessions(input.userId, "security_log_ban");
      void recordSecurityEvent({ eventType: "account.banned", severity: "warning", outcome: "blocked", message: "Account banned from security log review", userId: input.userId, ipAddress: ctx.clientIp, metadata: { actorUserId: ctx.session.user.id, reason: input.reason } });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "security.log_user_banned", entityType: "user", entityId: input.userId, severity: "warning", summary: `Banned account ${input.userId} from security log review`, changes: { reason: input.reason }, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  activityLogs: adminProcedure
    .input(
      z
        .object({
          action: z.string().trim().max(96).optional(),
          entityType: z.string().trim().max(48).optional(),
          limit: z.number().int().min(1).max(500).default(100),
          offset: z.number().int().min(0).max(50_000).default(0),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const conditions = [];
      if (input?.action) conditions.push(eq(activityLogs.action, input.action));
      if (input?.entityType) conditions.push(eq(activityLogs.entityType, input.entityType));

      const rows = await db
        .select()
        .from(activityLogs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(activityLogs.createdAt))
        .limit(input?.limit ?? 100)
        .offset(input?.offset ?? 0);

      const names = new Map<number, string>();
      for (const actorId of new Set(rows.map((row) => row.actorUserId).filter(Boolean))) {
        const user = await getUserById(actorId as number);
        names.set(actorId as number, user ? displayNameOf(user) : "Deleted user");
      }

      return rows.map((row) => ({
        id: row.id,
        actor: row.actorUserId ? names.get(row.actorUserId) ?? "Unknown" : "System",
        actorRole: row.actorRole,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        severity: row.severity,
        summary: row.summary,
        changes: row.changes,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
      }));
    }),

  emailLog: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input }) =>
      db
        .select({
          id: emailLog.id,
          templateKey: emailLog.templateKey,
          subject: emailLog.subject,
          status: emailLog.status,
          detail: emailLog.detail,
          createdAt: emailLog.createdAt,
        })
        .from(emailLog)
        .orderBy(desc(emailLog.createdAt))
        .limit(input?.limit ?? 100),
    ),

  /** Aggregated failed-login pressure by source address. */
  loginPressure: adminProcedure.query(async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        ipAddress: securityLogs.ipAddress,
        total: count(),
      })
      .from(securityLogs)
      .where(
        and(
          eq(securityLogs.eventType, "login.failure"),
          gte(securityLogs.createdAt, since),
        ),
      )
      .groupBy(securityLogs.ipAddress)
      .orderBy(desc(count()))
      .limit(25);
    return rows.map((row) => ({ ipAddress: row.ipAddress, failures: Number(row.total) }));
  }),

  /* ---------------------------------------------------------------- */
  /* Alerts                                                            */
  /* ---------------------------------------------------------------- */

  alerts: adminProcedure
    .input(z.object({ includeResolved: z.boolean().default(false) }).optional())
    .query(async ({ input }) =>
      db
        .select()
        .from(systemAlerts)
        .where(input?.includeResolved ? undefined : isNull(systemAlerts.resolvedAt))
        .orderBy(desc(systemAlerts.lastSeenAt))
        .limit(200),
    ),

  acknowledgeAlert: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(systemAlerts)
        .set({ acknowledgedByUserId: ctx.session.user.id, acknowledgedAt: new Date() })
        .where(eq(systemAlerts.id, input.id));
      return { ok: true as const };
    }),

  resolveAlert: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await db
        .update(systemAlerts)
        .set({ resolvedAt: new Date() })
        .where(eq(systemAlerts.id, input.id));
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Sessions                                                          */
  /* ---------------------------------------------------------------- */

  activeSessions: adminProcedure.input(z.object({ query: z.string().trim().max(160).optional() }).optional()).query(async ({ input }) => {
    const rows = await db
      .select({
        id: userSessions.id,
        userId: userSessions.userId,
        ipAddress: userSessions.ipAddress,
        userAgent: userSessions.userAgent,
        status: userSessions.status,
        mfaPending: userSessions.mfaPending,
        lastSeenAt: userSessions.lastSeenAt,
        expiresAt: userSessions.expiresAt,
        createdAt: userSessions.createdAt,
      })
      .from(userSessions)
      .where(and(eq(userSessions.status, "active"), sql`${userSessions.expiresAt} > NOW()`))
      .orderBy(desc(userSessions.lastSeenAt))
      .limit(300);

    const names = new Map<number, string>();
    for (const userId of new Set(rows.map((row) => row.userId))) {
      const user = await getUserById(userId);
      names.set(userId, user ? `${displayNameOf(user)} (${user.role})` : "Deleted user");
    }

    const enriched = await Promise.all(rows.map(async (row) => {
      const user = await getUserById(row.userId);
      return { ...row, user: names.get(row.userId) ?? "Unknown", userPublicId: user?.publicId ?? null };
    }));
    const query = input?.query?.toLowerCase();
    return query ? enriched.filter((row) => [row.user, row.userPublicId, row.ipAddress, row.userAgent].some((value) => value?.toLowerCase().includes(query))) : enriched;
  }),

  revokeUserSession: adminProcedure
    .input(z.object({ sessionId: z.string().length(64) }))
    .mutation(async ({ ctx, input }) => {
      await revokeSession(input.sessionId, "admin_revoked");
      void recordSecurityEvent({
        eventType: "session.revoked",
        severity: "notice",
        message: "Administrator revoked a session",
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  revokeAllSessionsForUser: adminProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await revokeAllUserSessions(input.userId, "admin_revoked");
      void recordSecurityEvent({
        eventType: "session.revoked",
        severity: "warning",
        message: "Administrator revoked all sessions for an account",
        userId: input.userId,
        ipAddress: ctx.clientIp,
        metadata: { actorUserId: ctx.session.user.id },
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Settings and flags                                                */
  /* ---------------------------------------------------------------- */

  businessProfile: adminProcedure.query(async () => getBusinessProfile()),

  cookieConsent: adminProcedure.query(async () => ({
    config: await getConsentConfig(),
    overview: await getConsentOverview(),
  })),

  updateCookieConsentConfig: adminProcedure
    .input(z.object({
      cookieConsentEnabled: z.boolean(),
      analyticsTrackingEnabled: z.boolean(),
      marketingTrackingEnabled: z.boolean(),
      confirm: z.literal("UPDATE COOKIE CONSENT SETTINGS"),
    }))
    .mutation(async ({ ctx, input }) => {
      await Promise.all([
        setSetting("privacy.cookie_consent_enabled", String(input.cookieConsentEnabled), { category: "privacy", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("privacy.analytics_tracking_enabled", String(input.analyticsTrackingEnabled), { category: "privacy", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("privacy.marketing_tracking_enabled", String(input.marketingTrackingEnabled), { category: "privacy", valueType: "boolean", userId: ctx.session.user.id }),
      ]);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "privacy.cookie_consent_configured",
        entityType: "privacy",
        entityId: "cookie_consent",
        severity: "warning",
        summary: `Cookie consent banner ${input.cookieConsentEnabled ? "enabled" : "disabled"}; analytics ${input.analyticsTrackingEnabled ? "available" : "disabled"}; marketing ${input.marketingTrackingEnabled ? "available" : "disabled"}`,
        changes: { cookieConsentEnabled: input.cookieConsentEnabled, analyticsTrackingEnabled: input.analyticsTrackingEnabled, marketingTrackingEnabled: input.marketingTrackingEnabled },
        ipAddress: ctx.clientIp,
      });
      return { config: await getConsentConfig(), overview: await getConsentOverview() };
    }),

  /** Non-secret status only; provider values are configured write-only. */
  analyticsProviders: adminProcedure.query(async () => {
    const [clarityEnabled, clarityProjectId, posthogEnabled, posthogProjectKey, posthogHost, crossSiteEnabled] = await Promise.all([
      getSettingBool("privacy.analytics_clarity_enabled", false),
      getSetting("privacy.analytics_clarity_project_id"),
      getSettingBool("privacy.analytics_posthog_enabled", false),
      getSetting("privacy.analytics_posthog_project_key"),
      getSetting("privacy.analytics_posthog_host"),
      getSettingBool("privacy.analytics_cross_site_enabled", false),
    ]);
    return {
      clarityEnabled,
      clarityConfigured: analyticsProviderValidation.isValidClarityProjectId(clarityProjectId),
      posthogEnabled,
      posthogConfigured: analyticsProviderValidation.isValidPostHogProjectKey(posthogProjectKey),
      posthogHost: analyticsProviderValidation.posthogHosts.includes(posthogHost ?? "") ? posthogHost : "https://us.i.posthog.com",
      crossSiteEnabled,
    };
  }),

  updateAnalyticsProviders: adminProcedure
    .input(z.object({
      clarityEnabled: z.boolean(),
      clarityProjectId: z.string().trim().max(64).optional(),
      posthogEnabled: z.boolean(),
      posthogProjectKey: z.string().trim().max(180).optional(),
      posthogHost: z.enum(["https://us.i.posthog.com", "https://eu.i.posthog.com"]),
      crossSiteEnabled: z.boolean(),
      confirm: z.literal("SAVE ANALYTICS CONFIGURATION"),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.clarityEnabled && input.clarityProjectId && !analyticsProviderValidation.isValidClarityProjectId(input.clarityProjectId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid Microsoft Clarity project ID." });
      }
      if (input.posthogEnabled && input.posthogProjectKey && !analyticsProviderValidation.isValidPostHogProjectKey(input.posthogProjectKey)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid PostHog project API key." });
      }
      const writes: Promise<void>[] = [
        setSetting("privacy.analytics_clarity_enabled", String(input.clarityEnabled), { category: "privacy", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("privacy.analytics_posthog_enabled", String(input.posthogEnabled), { category: "privacy", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("privacy.analytics_posthog_host", input.posthogHost, { category: "privacy", valueType: "string", userId: ctx.session.user.id }),
        setSetting("privacy.analytics_cross_site_enabled", String(input.crossSiteEnabled), { category: "privacy", valueType: "boolean", userId: ctx.session.user.id }),
      ];
      // A blank field preserves the stored value. This prevents reads of a
      // configured provider key and permits changes without re-entering it.
      if (input.clarityProjectId) writes.push(setSetting("privacy.analytics_clarity_project_id", input.clarityProjectId, { category: "privacy", valueType: "string", isSecret: true, userId: ctx.session.user.id }));
      if (input.posthogProjectKey) writes.push(setSetting("privacy.analytics_posthog_project_key", input.posthogProjectKey, { category: "privacy", valueType: "string", isSecret: true, userId: ctx.session.user.id }));
      await Promise.all(writes);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "privacy.analytics_providers_configured",
        entityType: "privacy",
        entityId: "analytics_providers",
        severity: "warning",
        summary: `Analytics providers configured: Clarity ${input.clarityEnabled ? "enabled" : "disabled"}; PostHog ${input.posthogEnabled ? "enabled" : "disabled"}; cross-site ${input.crossSiteEnabled ? "enabled" : "disabled"}`,
        changes: { clarityEnabled: input.clarityEnabled, posthogEnabled: input.posthogEnabled, posthogHost: input.posthogHost, crossSiteEnabled: input.crossSiteEnabled, clarityProjectIdUpdated: Boolean(input.clarityProjectId), posthogProjectKeyUpdated: Boolean(input.posthogProjectKey) },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  updateBusinessProfile: adminProcedure
    .input(z.object({
      legalName: z.string().trim().min(2).max(160),
      publicName: z.string().trim().min(2).max(120),
      addressLine1: z.string().trim().min(2).max(160),
      addressLine2: z.string().trim().max(160).nullable().optional(),
      city: z.string().trim().min(2).max(100),
      state: z.string().trim().min(2).max(64),
      postalCode: z.string().trim().min(3).max(32),
      country: z.string().trim().min(2).max(64),
    }))
    .mutation(async ({ ctx, input }) => {
      const profile = await saveBusinessProfile({ ...input, addressLine2: input.addressLine2?.trim() || null }, ctx.session.user.id);
      const address = formatBusinessAddress(profile);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "business_profile.updated",
        entityType: "business_profile",
        entityId: "primary",
        severity: "warning",
        summary: `Updated business profile mailing address to ${address}`,
        changes: { legalName: profile.legalName, publicName: profile.publicName, address },
        ipAddress: ctx.clientIp,
      });
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "notice",
        outcome: "success",
        message: "Administrator updated the business profile address used by future public pages, emails, invoices, and templates.",
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { address },
      });
      return profile;
    }),

  settings: adminProcedure.query(async () => {
    const rows = await db.select().from(siteSettings).orderBy(siteSettings.settingKey);
    return rows.map((row) => ({
      key: row.settingKey,
      // Secrets report presence only.
      value: row.isSecret ? null : row.settingValue,
      hasValue: row.isSecret ? Boolean(row.settingValue) : undefined,
      valueType: row.valueType,
      category: row.category,
      description: row.description,
            isSecret: row.isSecret,
      updatedAt: row.updatedAt,
    }));
  }),

  /** Get settings filtered by category (for targeted panels like launch countdown). */
  getSettings: adminProcedure
    .input(z.object({ category: z.string().trim().min(1).max(48) }))
    .query(async ({ input }) => {
      const rows = await db
        .select()
        .from(siteSettings)
        .where(eq(siteSettings.category, input.category))
        .orderBy(siteSettings.settingKey);
      return rows.map((row) => ({
        key: row.settingKey,
        value: row.isSecret ? null : (row.settingValue ?? ""),
      }));
    }),

  updateSetting: adminProcedure
    .input(
      z.object({
        key: z.string().trim().min(2).max(96),
        value: z.string().max(20_000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db
        .select({ isSecret: siteSettings.isSecret, category: siteSettings.category })
        .from(siteSettings)
        .where(eq(siteSettings.settingKey, input.key))
        .limit(1);

      await setSetting(input.key, input.value, {
        category: existing[0]?.category,
        isSecret: existing[0]?.isSecret,
        userId: ctx.session.user.id,
      });

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "settings.update",
        entityType: "site_setting",
        entityId: input.key,
        severity: "notice",
        summary: `Setting "${input.key}" updated`,
        // The value is deliberately omitted for secrets.
        changes: existing[0]?.isSecret ? { redacted: true } : { value: input.value },
        ipAddress: ctx.clientIp,
      });
      // Fire maintenance subscriber notifications when maintenance.enabled changes.
      if (input.key === "maintenance.enabled") {
        if (input.value === "true" || input.value === "1") {
          void notifyMaintenanceStart();
        } else {
          void notifyMaintenanceEnd();
        }
      }
      return { ok: true as const };
    }),

  mfaPolicy: adminProcedure.query(async () => {
    const [adminPolicy, customerPolicy] = await Promise.all([
      getSetting("security.mfa_admin_policy"),
      getSetting("security.mfa_customer_policy"),
    ]);
    const parse = (value: string | null, fallback: "required" | "optional") =>
      value === "required" || value === "optional" || value === "disabled" ? value : fallback;
    return { adminPolicy: parse(adminPolicy, "required"), customerPolicy: parse(customerPolicy, "optional") };
  }),

  updateMfaPolicy: adminProcedure
    .input(z.object({ adminPolicy: z.enum(["required", "optional", "disabled"]), customerPolicy: z.enum(["required", "optional", "disabled"]) }))
    .mutation(async ({ ctx, input }) => {
      await Promise.all([
        setSetting("security.mfa_admin_policy", input.adminPolicy, { category: "security", valueType: "string", userId: ctx.session.user.id }),
        setSetting("security.mfa_customer_policy", input.customerPolicy, { category: "security", valueType: "string", userId: ctx.session.user.id }),
      ]);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "security.mfa_policy_updated",
        entityType: "security_policy",
        entityId: "mfa",
        severity: input.adminPolicy === "required" ? "notice" : "warning",
        summary: `MFA policy updated: administrators ${input.adminPolicy}; customers ${input.customerPolicy}`,
        changes: input,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  administratorOnlyAccess: adminProcedure.query(async () => ({
    enabled: await getSettingBool("access.administrator_only_enabled", false),
  })),

  updateAdministratorOnlyAccess: adminProcedure
    .input(z.object({ enabled: z.boolean(), confirmation: z.string().trim().max(80).optional() }))
    .mutation(async ({ ctx, input }) => {
      if (input.enabled && input.confirmation !== "ADMINISTRATOR ONLY") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Type ADMINISTRATOR ONLY to enable this access gate." });
      }
      await setSetting("access.administrator_only_enabled", String(input.enabled), {
        category: "access",
        valueType: "boolean",
        userId: ctx.session.user.id,
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "access.administrator_only_updated",
        entityType: "access_policy",
        entityId: "administrator_only",
        severity: input.enabled ? "warning" : "notice",
        summary: `Administrator-only access ${input.enabled ? "enabled" : "disabled"}`,
        changes: { enabled: input.enabled },
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const, enabled: input.enabled };
    }),

  maintenanceConfig: adminProcedure.query(async () => {
    const [enabled, blocksLogin, blocksRegistration, showOnHomepage, message, estimatedCompletion] = await Promise.all([
      getSettingBool("maintenance.enabled", false),
      getSettingBool("maintenance.blocks_login", false),
      getSettingBool("maintenance.blocks_registration", false),
      getSettingBool("maintenance.show_on_homepage", true),
      getSetting("maintenance.message"),
      getSetting("maintenance.estimated_completion"),
    ]);
    return { enabled, blocksLogin, blocksRegistration, showOnHomepage, message: message ?? "We are performing scheduled maintenance. Some features may be briefly unavailable.", estimatedCompletion: estimatedCompletion ?? "" };
  }),

  updateMaintenanceConfig: adminProcedure
    .input(z.object({ enabled: z.boolean(), blocksLogin: z.boolean(), blocksRegistration: z.boolean(), showOnHomepage: z.boolean(), message: z.string().trim().min(3).max(500), estimatedCompletion: z.string().trim().max(120).optional() }))
    .mutation(async ({ ctx, input }) => {
      await Promise.all([
        setSetting("maintenance.enabled", String(input.enabled), { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("maintenance.blocks_login", String(input.blocksLogin), { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("maintenance.blocks_registration", String(input.blocksRegistration), { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("maintenance.show_on_homepage", String(input.showOnHomepage), { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id }),
        setSetting("maintenance.message", input.message, { category: "maintenance", valueType: "string", userId: ctx.session.user.id }),
        setSetting("maintenance.estimated_completion", input.estimatedCompletion || null, { category: "maintenance", valueType: "string", userId: ctx.session.user.id }),
      ]);
      if (input.enabled) void notifyMaintenanceStart(); else void notifyMaintenanceEnd();
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "maintenance.configured", entityType: "maintenance", entityId: "global", severity: "warning", summary: `Maintenance ${input.enabled ? "enabled" : "disabled"}; login ${input.blocksLogin ? "gated" : "open"}; registration ${input.blocksRegistration ? "gated" : "open"}`, changes: { enabled: input.enabled, blocksLogin: input.blocksLogin, blocksRegistration: input.blocksRegistration, showOnHomepage: input.showOnHomepage }, ipAddress: ctx.clientIp });
      return { ok: true as const };
    }),

  featureFlags: adminProcedure.query(async () => {
    const rows = await db.select().from(featureFlags).orderBy(featureFlags.flagKey);
    const effective = await getAllFeatureFlags();
    return rows.map((row) => ({
      key: row.flagKey,
      name: row.name,
      description: row.description,
      enabled: effective[row.flagKey] ?? row.enabled,
      scheduledEnableAt: row.scheduledEnableAt,
      scheduledDisableAt: row.scheduledDisableAt,
      updatedAt: row.updatedAt,
    }));
  }),

  setFeatureFlag: adminProcedure
    .input(z.object({ key: z.string().trim().max(64), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await setFeatureFlag(input.key, input.enabled, ctx.session.user.id);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "settings.feature_flag",
        entityType: "feature_flag",
        entityId: input.key,
        severity: "notice",
        summary: `Feature "${input.key}" ${input.enabled ? "enabled" : "disabled"}`,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* SAML                                                              */
  /* ---------------------------------------------------------------- */

  samlAdministratorMfaSource: adminProcedure.query(async () => {
    const [source, claimName, requiredValue] = await Promise.all([
      getSetting("security.saml_admin_mfa_source"),
      getSetting("security.saml_entra_mfa_claim_name"),
      getSetting("security.saml_entra_mfa_required_value"),
    ]);
    const mfaSource = source === "entra" || source === "both" || source === "local" ? source : "local";
    return {
      source: mfaSource,
      claimName: claimName?.trim() || "http://schemas.microsoft.com/claims/authnmethodsreferences",
      requiredValue: requiredValue?.trim() || "http://schemas.microsoft.com/claims/multipleauthn",
      enabled: mfaSource !== "local",
    };
  }),

  updateSamlAdministratorMfaSource: adminProcedure
    .input(z.object({
      source: z.enum(["local", "entra", "both"]),
      claimName: z.string().trim().min(8).max(500).optional(),
      requiredValue: z.string().trim().min(3).max(500).optional(),
      confirmation: z.string().trim().max(80).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.source !== "local" && input.confirmation !== "TRUST ENTRA MFA") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Type TRUST ENTRA MFA to activate Microsoft Entra-managed MFA." });
      }
      const claimName = input.claimName?.trim() || "http://schemas.microsoft.com/claims/authnmethodsreferences";
      const requiredValue = input.requiredValue?.trim() || "http://schemas.microsoft.com/claims/multipleauthn";
      await Promise.all([
        setSetting("security.saml_admin_mfa_source", input.source, { category: "security", valueType: "string", userId: ctx.session.user.id }),
        setSetting("security.saml_entra_mfa_claim_name", claimName, { category: "security", valueType: "string", userId: ctx.session.user.id }),
        setSetting("security.saml_entra_mfa_required_value", requiredValue, { category: "security", valueType: "string", userId: ctx.session.user.id }),
      ]);
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "security.saml_mfa_source_updated",
        entityType: "security_policy",
        entityId: "saml_administrator_mfa_source",
        severity: input.source === "local" ? "notice" : "warning",
        summary: `SAML SSO MFA source set to ${input.source}`,
        changes: { source: input.source, claimName, requiredValue },
        ipAddress: ctx.clientIp,
      });
      void recordSecurityEvent({
        eventType: "settings.changed",
        outcome: "success",
        severity: input.source === "local" ? "notice" : "warning",
        message: `SAML SSO MFA source changed to ${input.source}`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { claimConfigured: Boolean(claimName), assuranceValueConfigured: Boolean(requiredValue) },
      });
      return { ok: true as const, source: input.source };
    }),

  samlConfig: adminProcedure.query(async () => {
    const rows = await db.select().from(samlConfigs).limit(1);
    const config = rows[0];
    if (!config) return null;
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      entryPoint: config.entryPoint,
      issuer: config.issuer,
      // The certificate is long and sensitive; only its fingerprint is surfaced.
      certificatePresent: config.idpCertificate.length > 0,
      signatureAlgorithm: config.signatureAlgorithm,
      attributeMapping: config.attributeMapping,
      defaultRole: config.defaultRole,
      autoProvision: config.autoProvision,
      acsUrl: `${env.appUrl}/api/saml/acs`,
      metadataUrl: `${env.appUrl}/api/saml/metadata`,
    };
  }),

  upsertSamlConfig: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(120),
        enabled: z.boolean(),
        entryPoint: z.string().trim().url().max(500),
        issuer: z.string().trim().min(2).max(255),
        idpCertificate: z.string().trim().min(100).max(20_000),
        signatureAlgorithm: z.enum(["sha256", "sha512"]).default("sha256"),
        defaultRole: z.enum(["customer", "staff", "admin"]).default("customer"),
        autoProvision: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.select({ id: samlConfigs.id }).from(samlConfigs).limit(1);
      if (existing[0]) {
        await db.update(samlConfigs).set(input).where(eq(samlConfigs.id, existing[0].id));
      } else {
        await db.insert(samlConfigs).values(input);
      }
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        message: `SAML single sign-on configuration ${input.enabled ? "enabled" : "updated"}`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Domain and TLS certificates                                       */
  /* ---------------------------------------------------------------- */

  domainStatus: adminProcedure.query(async () => {
    try {
      return await runCertificateControl<DomainControlStatus>({ action: "domain-status" });
    } catch (error) {
      return {
        appUrl: env.appUrl,
        hostname: new URL(env.appUrl).hostname,
        aliases: [],
        aliasesRemaining: 0,
        certificate: {
          provider: "unknown" as const,
          configured: false,
          rootPresent: false,
          certificatePath: null,
          subject: null,
          issuer: null,
          notBefore: null,
          notAfter: null,
          fingerprint: null,
          san: null,
          controlError: error instanceof Error ? error.message : "Domain control is unavailable.",
        },
      };
    }
  }),

  updateDomainAndRequestLetsEncrypt: adminProcedure
    .input(z.object({
      hostname: z.string().trim().toLowerCase().min(4).max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i, "Enter a valid fully-qualified hostname."),
      email: z.string().trim().email().max(254),
      confirmation: z.literal("CHANGE DOMAIN AND REQUEST CERTIFICATE"),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await runCertificateControl<DomainCutoverResult>({
        action: "update-domain-letsencrypt",
        hostname: input.hostname,
        email: input.email,
        confirmation: input.confirmation,
      });
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        outcome: "success",
        message: `Administrator changed the public portal domain from ${result.previousHostname} to ${result.hostname}`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { previousHostname: result.previousHostname, hostname: result.hostname, certificateFingerprint: result.fingerprint, certificateNotAfter: result.notAfter, rollbackBackup: result.backup },
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "domain.letsencrypt_cutover",
        entityType: "portal_domain",
        entityId: result.hostname,
        severity: "warning",
        summary: `Changed public portal domain from ${result.previousHostname} to ${result.hostname} and requested a Let's Encrypt certificate`,
        changes: { previousHostname: result.previousHostname, hostname: result.hostname, certificateFingerprint: result.fingerprint, certificateNotAfter: result.notAfter, rollbackBackup: result.backup },
        ipAddress: ctx.clientIp,
      });
      return result;
    }),

  addPortalAliasWithLetsEncrypt: adminProcedure
    .input(z.object({
      hostname: z.string().trim().toLowerCase().min(4).max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i, "Enter a valid fully-qualified hostname."),
      email: z.string().trim().email().max(254),
      confirmation: z.literal("ADD PORTAL ALIAS"),
    }))
    .mutation(async ({ ctx, input }) => {
      let result: PortalAliasResult;
      try {
        result = await runCertificateControl<PortalAliasResult>({
          action: "add-portal-alias-letsencrypt",
          hostname: input.hostname,
          email: input.email,
          confirmation: input.confirmation,
        });
      } catch (error) {
        void recordSecurityEvent({ eventType: "settings.changed", severity: "warning", outcome: "failure", message: `Administrator failed to add Let's Encrypt portal alias ${input.hostname}`, userId: ctx.session.user.id, ipAddress: ctx.clientIp, metadata: { alias: input.hostname, provider: "letsencrypt" } });
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "portal_alias.letsencrypt_failed", entityType: "portal_domain", entityId: input.hostname, severity: "warning", summary: `Failed to add Let's Encrypt portal alias ${input.hostname}`, changes: { alias: input.hostname, provider: "letsencrypt" }, ipAddress: ctx.clientIp });
        throw error;
      }
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        outcome: "success",
        message: `Administrator added portal alias ${result.addedAlias} with Let's Encrypt`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { alias: result.addedAlias, aliases: result.aliases, certificateFingerprint: result.certificate.fingerprint, certificateNotAfter: result.certificate.notAfter, rollbackBackup: result.backup },
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "portal_alias.letsencrypt_added",
        entityType: "portal_domain",
        entityId: result.addedAlias,
        severity: "warning",
        summary: `Added portal alias ${result.addedAlias} and expanded the Let's Encrypt certificate`,
        changes: { alias: result.addedAlias, aliases: result.aliases, certificateFingerprint: result.certificate.fingerprint, certificateNotAfter: result.certificate.notAfter, rollbackBackup: result.backup },
        ipAddress: ctx.clientIp,
      });
      return result;
    }),

  addPortalAliasWithCloudflare: adminProcedure
    .input(z.object({
      hostname: z.string().trim().toLowerCase().min(4).max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i, "Enter a valid fully-qualified hostname."),
      certificate: z.string().min(80).max(30_000),
      privateKey: z.string().min(80).max(30_000),
      caRoot: z.string().max(30_000).optional(),
      confirmation: z.literal("ADD PORTAL ALIAS"),
    }))
    .mutation(async ({ ctx, input }) => {
      let result: PortalAliasResult;
      try {
        result = await runCertificateControl<PortalAliasResult>({
          action: "add-portal-alias-cloudflare",
          hostname: input.hostname,
          certificate: input.certificate.endsWith("\n") ? input.certificate : `${input.certificate}\n`,
          privateKey: input.privateKey.endsWith("\n") ? input.privateKey : `${input.privateKey}\n`,
          caRoot: input.caRoot ? (input.caRoot.endsWith("\n") ? input.caRoot : `${input.caRoot}\n`) : "",
          confirmation: input.confirmation,
        });
      } catch (error) {
        void recordSecurityEvent({ eventType: "settings.changed", severity: "warning", outcome: "failure", message: `Administrator failed to add Cloudflare portal alias ${input.hostname}`, userId: ctx.session.user.id, ipAddress: ctx.clientIp, metadata: { alias: input.hostname, provider: "cloudflare_origin" } });
        void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "portal_alias.cloudflare_failed", entityType: "portal_domain", entityId: input.hostname, severity: "warning", summary: `Failed to add Cloudflare portal alias ${input.hostname}`, changes: { alias: input.hostname, provider: "cloudflare_origin" }, ipAddress: ctx.clientIp });
        throw error;
      }
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        outcome: "success",
        message: `Administrator added portal alias ${result.addedAlias} with Cloudflare Origin CA`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { alias: result.addedAlias, aliases: result.aliases, certificateFingerprint: result.certificate.fingerprint, certificateNotAfter: result.certificate.notAfter, rollbackBackup: result.backup },
      });
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "portal_alias.cloudflare_added",
        entityType: "portal_domain",
        entityId: result.addedAlias,
        severity: "warning",
        summary: `Added portal alias ${result.addedAlias} and installed a replacement Cloudflare Origin CA certificate`,
        changes: { alias: result.addedAlias, aliases: result.aliases, certificateFingerprint: result.certificate.fingerprint, certificateNotAfter: result.certificate.notAfter, rollbackBackup: result.backup },
        ipAddress: ctx.clientIp,
      });
      return result;
    }),

  tlsCertificateStatus: adminProcedure.query(async () => {
    try {
      return await runCertificateControl({ action: "status" });
    } catch (error) {
      return {
        provider: "unknown" as const,
        configured: false,
        rootPresent: false,
        certificatePath: null,
        subject: null,
        issuer: null,
        notBefore: null,
        notAfter: null,
        fingerprint: null,
        san: null,
        controlError: error instanceof Error ? error.message : "Certificate control is unavailable.",
      };
    }
  }),

  installCloudflareOriginCertificate: adminProcedure
    .input(z.object({
      hostname: z.string().trim().toLowerCase().min(4).max(253).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i, "Enter a valid fully-qualified hostname."),
      certificate: z.string().min(80).max(30_000),
      privateKey: z.string().min(80).max(30_000),
      caRoot: z.string().max(30_000).optional(),
      confirmation: z.literal("INSTALL CLOUDFLARE ORIGIN CA"),
    }))
    .mutation(async ({ ctx, input }) => {
      const status = await runCertificateControl({
        action: "install-cloudflare-origin",
        hostname: input.hostname,
        certificate: input.certificate.endsWith("\n") ? input.certificate : `${input.certificate}\n`,
        privateKey: input.privateKey.endsWith("\n") ? input.privateKey : `${input.privateKey}\n`,
        caRoot: input.caRoot ? (input.caRoot.endsWith("\n") ? input.caRoot : `${input.caRoot}\n`) : "",
      });
      void recordSecurityEvent({
        eventType: "settings.changed",
        severity: "warning",
        outcome: "success",
        message: `Administrator installed a Cloudflare Origin CA certificate for ${input.hostname}`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
        metadata: { provider: status.provider, fingerprint: status.fingerprint, notAfter: status.notAfter, rootPresent: status.rootPresent },
      });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "tls.cloudflare_origin_installed", entityType: "tls_certificate", entityId: input.hostname, severity: "warning", summary: `Installed Cloudflare Origin CA certificate for ${input.hostname}`, changes: { fingerprint: status.fingerprint, notAfter: status.notAfter, rootPresent: status.rootPresent }, ipAddress: ctx.clientIp });
      return status;
    }),

  activateLetsEncryptCertificate: adminProcedure
    .input(z.object({ hostname: z.string().trim().toLowerCase().min(4).max(253), confirmation: z.literal("USE LETS ENCRYPT") }))
    .mutation(async ({ ctx, input }) => {
      const status = await runCertificateControl({ action: "activate-letsencrypt", hostname: input.hostname, confirmation: input.confirmation });
      void recordSecurityEvent({ eventType: "settings.changed", severity: "warning", outcome: "success", message: `Administrator activated the Let's Encrypt certificate for ${input.hostname}`, userId: ctx.session.user.id, ipAddress: ctx.clientIp, metadata: { fingerprint: status.fingerprint, notAfter: status.notAfter } });
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "tls.letsencrypt_activated", entityType: "tls_certificate", entityId: input.hostname, severity: "warning", summary: `Activated Let's Encrypt certificate for ${input.hostname}`, changes: { fingerprint: status.fingerprint, notAfter: status.notAfter }, ipAddress: ctx.clientIp });
      return status;
    }),

  /* ---------------------------------------------------------------- */
  /* API keys                                                          */
  /* ---------------------------------------------------------------- */

  apiKeys: adminProcedure.query(async () =>
    db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt)),
  ),

  createApiKey: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(120),
        scopes: z.array(z.string().trim().max(48)).max(20).default([]),
        expiresInDays: z.number().int().min(1).max(3_650).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const secret = randomToken(32);
      const prefix = `rp_${secret.slice(0, 8)}`;
      const fullKey = `${prefix}.${secret}`;

      await db.insert(apiKeys).values({
        name: input.name,
        keyPrefix: prefix,
        keyHash: hashToken(fullKey),
        scopes: input.scopes,
        createdByUserId: ctx.session.user.id,
        expiresAt:
          input.expiresInDays === null
            ? null
            : new Date(Date.now() + input.expiresInDays * 86_400_000),
      });

      void recordSecurityEvent({
        eventType: "apikey.created",
        severity: "warning",
        message: `API key "${input.name}" created`,
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
      });

      // The plaintext key is returned exactly once.
      return { ok: true as const, apiKey: fullKey };
    }),

  revokeApiKey: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, input.id));
      void recordSecurityEvent({
        eventType: "apikey.revoked",
        severity: "notice",
        message: "API key revoked",
        userId: ctx.session.user.id,
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /* ---------------------------------------------------------------- */
  /* Health, email and backups                                         */
  /* ---------------------------------------------------------------- */

  health: adminProcedure.query(async () => {
    const databaseOk = await pingDatabase();
    const queue = await countQueuedEmails();
    const [alertRows, sessionRows, userRows] = await Promise.all([
      db
        .select({ total: count() })
        .from(systemAlerts)
        .where(isNull(systemAlerts.resolvedAt)),
      db
        .select({ total: count() })
        .from(userSessions)
        .where(and(eq(userSessions.status, "active"), sql`${userSessions.expiresAt} > NOW()`)),
      db.select({ total: count() }).from(users).where(isNull(users.deletedAt)),
    ]);

    const memory = process.memoryUsage();
    return {
      database: databaseOk,
      smtpConfigured: env.smtp.enabled,
      graphEmailConfigured: env.graph.emailEnabled,
      emailTransport: env.graph.emailEnabled ? "graph" : env.smtp.enabled ? "smtp" : "none",
      // Note: graphEmailConfigured may also be true if set via admin panel (DB settings).
      stripeConfigured: env.stripe.enabled,
      storageDriver: env.storage.driver,
      emailQueue: queue,
      openAlerts: Number(alertRows[0]?.total ?? 0),
      activeSessions: Number(sessionRows[0]?.total ?? 0),
      users: Number(userRows[0]?.total ?? 0),
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMb: {
        rss: Math.round(memory.rss / 1_048_576),
        heapUsed: Math.round(memory.heapUsed / 1_048_576),
      },
      nodeVersion: process.version,
      environment: env.nodeEnv,
    };
  }),

  validateGraphEmail: adminProcedure.mutation(async ({ ctx }) => {
    const { validateGraphConfiguration } = await import("../services/emailGraph.js");
    const result = await validateGraphConfiguration();
    void recordActivity({
      actorUserId: ctx.session.user.id,
      actorRole: "admin",
      action: result.valid ? "email.graph_validated" : "email.graph_validation_failed",
      summary: result.valid ? "Microsoft Graph access token acquired successfully" : `Microsoft Graph validation failed: ${result.error ?? "unknown error"}`,
      ipAddress: ctx.clientIp,
    });
    if (!result.valid) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: result.error ?? "Microsoft Graph validation failed." });
    }
    return { ok: true as const, sender: result.sender, expiresAt: result.expiresAt };
  }),

  sendTestEmail: adminProcedure
    .input(z.object({ to: z.string().trim().toLowerCase().email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      const { isEmailEnabled } = await import("../services/email.js");
      if (!(await isEmailEnabled())) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No email transport configured. Set SMTP_HOST or GRAPH_EMAIL_SENDER.",
        });
      }
      try {
        await sendTestEmail(input.to);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Email delivery failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        });
      }
      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "email.test_sent",
        summary: "Administrator sent an outbound email test message",
        ipAddress: ctx.clientIp,
      });
      return { ok: true as const };
    }),

  /** Return current email transport config from DB settings (for admin panel status display). */
  getEmailConfig: adminProcedure.query(async () => {
    const { getSetting } = await import("../services/settings.js");
    const [tenantId, clientId, clientSecret, emailSender, smtpHost] = await Promise.all([
      getSetting("email.graph_tenant_id"),
      getSetting("email.graph_client_id"),
      getSetting("email.graph_client_secret"),
      getSetting("email.graph_email_sender"),
      getSetting("email.smtp_host"),
    ]);
    const graphConfigured = Boolean(tenantId && clientId && clientSecret && emailSender);
    const smtpConfigured = Boolean(smtpHost) || env.smtp.enabled;
    return {
      transport: graphConfigured ? "graph" : smtpConfigured ? "smtp" : "none",
      graphConfigured,
      smtpConfigured,
      graphTenantId: tenantId ?? env.graph.tenantId ?? "",
      graphClientId: clientId ?? env.graph.clientId ?? "",
      graphEmailSender: emailSender ?? env.graph.emailSender ?? "",
    };
  }),

  retryFailedEmails: adminProcedure.mutation(async () => {
    const result = await db
      .update(emailQueue)
      .set({ status: "pending", attempts: 0, runAfter: new Date() })
      .where(eq(emailQueue.status, "failed"));
    return {
      ok: true as const,
      requeued: affectedRows(result),
    };
  }),

  backups: adminProcedure.query(async () =>
    db.select().from(backupLog).orderBy(desc(backupLog.startedAt)).limit(50),
  ),

  /** Purge log rows older than the retention window. */
  pruneLogs: adminProcedure
    .input(z.object({ retentionDays: z.number().int().min(7).max(3_650).default(365) }))
    .mutation(async ({ ctx, input }) => {
      const cutoff = new Date(Date.now() - input.retentionDays * 86_400_000);
      const securityResult = await db
        .delete(securityLogs)
        .where(sql`${securityLogs.createdAt} < ${cutoff}`);
      const activityResult = await db
        .delete(activityLogs)
        .where(sql`${activityLogs.createdAt} < ${cutoff}`);
      const emailResult = await db
        .delete(emailLog)
        .where(sql`${emailLog.createdAt} < ${cutoff}`);



      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: "admin",
        action: "logs.prune",
        severity: "notice",
        summary: `Pruned log rows older than ${input.retentionDays} days`,
        ipAddress: ctx.clientIp,
      });

      return {
        ok: true as const,
        securityLogs: affectedRows(securityResult),
        activityLogs: affectedRows(activityResult),
        emailLog: affectedRows(emailResult),
      };
    }),
});
