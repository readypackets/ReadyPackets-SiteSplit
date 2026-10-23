/**
 * Adaptive rate limiter with progressive penalties.
 *
 * Counters live in a bounded in-process map, so no external cache service is
 * required for a single-node self-hosted deployment. Each violation escalates:
 * one minute, then fifteen minutes, then a permanent blacklist entry. Under
 * sustained load the limiter tightens every window, shedding abusive traffic
 * before the database becomes the bottleneck.
 */
import { cpus, loadavg } from "node:os";
import type { NextFunction, Request, Response } from "express";
import { gt, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { rateLimitPenalties } from "../db/schema.js";
import { recordSecurityEvent } from "../observability/audit.js";
import { getRateLimitSettings, getSettingBool, getSettingNumber } from "../services/settings.js";
import { blacklistIp } from "./ipBlacklist.js";
import { resolveClientIp } from "./ipAddress.js";
import type { RateLimitCategory } from "../../shared/domain.js";

interface Counter {
  hits: number;
  windowStart: number;
}

interface Penalty {
  level: number;
  until: number;
}

const MAX_TRACKED_KEYS = 50_000;
const counters = new Map<string, Counter>();
// In-memory penalty cache: loaded from DB on first use, kept in sync on writes.
const penalties = new Map<string, Penalty>();
let penaltiesLoadedFromDb = false;

/** Load active penalties from the database into memory on startup. */
async function loadPenaltiesFromDb(): Promise<void> {
  if (penaltiesLoadedFromDb) return;
  penaltiesLoadedFromDb = true;
  try {
    const now = new Date();
    const rows = await db
      .select()
      .from(rateLimitPenalties)
      .where(gt(rateLimitPenalties.until, now));
    for (const row of rows) {
      penalties.set(row.penaltyKey, { level: row.level, until: row.until.getTime() });
    }
    // Purge expired rows while we're here.
    await db.delete(rateLimitPenalties).where(lt(rateLimitPenalties.until, now));
  } catch {
    // DB unavailable at startup — fall back to in-memory only.
  }
}

/** Persist a penalty to the database. */
async function persistPenalty(penaltyKey: string, ipAddress: string, category: string, level: number, until: Date): Promise<void> {
  try {
    await db
      .insert(rateLimitPenalties)
      .values({ penaltyKey, ipAddress, category, level, until })
      .onDuplicateKeyUpdate({ set: { level, until } });
  } catch {
    // Non-fatal — the in-memory entry is still active.
  }
}

/** Periodically discard stale entries so memory cannot grow without bound. */
const sweeper = setInterval(async () => {
  const now = Date.now();
  for (const [key, counter] of counters) {
    if (now - counter.windowStart > 3_600_000) counters.delete(key);
  }
  for (const [key, penalty] of penalties) {
    if (penalty.until < now - 3_600_000) penalties.delete(key);
  }
  // Purge expired DB rows every hour.
  try {
    await db.delete(rateLimitPenalties).where(lt(rateLimitPenalties.until, new Date(now - 3_600_000)));
  } catch { /* non-fatal */ }
}, 60_000);
sweeper.unref();

/** Load factor in [1, 3]: 1 when idle, higher as the CPU saturates. */
function loadFactor(): number {
  const cores = Math.max(1, cpus().length);
  const oneMinute = loadavg()[0] ?? 0;
  const ratio = oneMinute / cores;
  if (ratio < 0.7) return 1;
  if (ratio < 1.2) return 1.5;
  if (ratio < 2) return 2;
  return 3;
}

/**
 * Route classification. The most sensitive endpoints are matched first so that
 * a password-reset call can never be served by the permissive API bucket.
 */
const AUTH_HIGH_RISK_PROCEDURES = new Set([
  "auth.login",
  "auth.register",
  "auth.requestPasswordReset",
  "auth.resetPassword",
  "auth.verifyEmail",
  "auth.resendVerification",
  "auth.verifyMfa",
  "auth.enrollMfa",
  "auth.confirmMfa",
  "auth.disableMfa",
  "auth.useBackupCode",
  "auth.changePassword",
  "mnda.accept",
]);

const EXPENSIVE_PROCEDURES = new Set([
  "files.bulkDownload",
  "account.exportData",
  "adminOrders.exportCsv",
  "adminCustomers.exportCsv",
  "adminLogs.exportCsv",
]);

const FORM_PROCEDURES = new Set([
  "public.submitContact",
  "public.subscribeNewsletter",
  "public.subscribeMaintenance",
  "intake.save",
  "intake.submit",
  "reviews.create",
  "tickets.create",
  "tickets.reply",
  "forum.createTopic",
  "forum.createPost",
]);

export function classifyRequest(req: Request): RateLimitCategory {
  const path = req.path;

  if (path.startsWith("/api/mobile/v1/token") || path.startsWith("/api/mobile/v1/authorize") || path.startsWith("/api/mobile/v1/revoke")) return "auth_high_risk";
  if (path.startsWith("/api/mobile/") && (path.includes("/uploads") || path.includes("/content"))) return "expensive";
  if (path.startsWith("/api/trpc/")) {
    const procedures = path
      .slice("/api/trpc/".length)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (procedures.some((name) => AUTH_HIGH_RISK_PROCEDURES.has(name))) return "auth_high_risk";
    if (procedures.some((name) => EXPENSIVE_PROCEDURES.has(name))) return "expensive";
    if (procedures.some((name) => FORM_PROCEDURES.has(name))) return "form_submission";
    return "api";
  }

  if (path.startsWith("/api/auth/") || path.startsWith("/api/saml/")) return "auth_high_risk";
  if (path.startsWith("/api/files/") || path.startsWith("/api/export/")) return "expensive";
  if (path.startsWith("/api/")) return "api";
  return "standard_browsing";
}

function penaltyDurationMs(level: number): number | null {
  if (level === 1) return 60_000;
  if (level === 2) return 900_000;
  return null; // level 3 and beyond escalate to a blacklist entry
}

export function rateLimitMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const address = (res.locals.clientIp as string | undefined) ?? resolveClientIp(req);
    const category = classifyRequest(req);
    const settings = await getRateLimitSettings();
    const config = settings.get(category);

    if (!config || !config.enabled) {
      next();
      return;
    }

    const now = Date.now();
    // The penalty is scoped to the category that was abused. A burst against the
    // login endpoint must lock out login attempts, not the entire public site,
    // because a shared corporate NAT address would otherwise take every user
    // behind it offline. Repeated violations still escalate to a full blacklist
    // entry, which is enforced ahead of this middleware and is not category
    // scoped.
    // Load persisted penalties from DB on the first request after startup.
    if (!penaltiesLoadedFromDb) await loadPenaltiesFromDb();

    const penaltyKey = `${category}:${address}`;
    const activePenalty = penalties.get(penaltyKey);
    if (activePenalty && activePenalty.until > now) {
      const retryAfter = Math.ceil((activePenalty.until - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("X-RateLimit-Limit", String(config.maxRequests));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.status(429).type("text/plain").send("Too Many Requests");
      return;
    }

    const adaptive = await getSettingBool("ratelimit.adaptive_enabled", true);
    const factor = adaptive ? loadFactor() : 1;
    const effectiveMax = Math.max(1, Math.floor(config.maxRequests / factor));
    const windowMs = config.windowSeconds * 1000;

    const key = `${category}:${address}`;
    let counter = counters.get(key);
    if (!counter || now - counter.windowStart >= windowMs) {
      counter = { hits: 0, windowStart: now };
      if (counters.size >= MAX_TRACKED_KEYS) counters.clear();
      counters.set(key, counter);
    }
    counter.hits += 1;

    const remaining = Math.max(0, effectiveMax - counter.hits);
    const resetSeconds = Math.ceil((counter.windowStart + windowMs) / 1000);
    res.setHeader("X-RateLimit-Limit", String(effectiveMax));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSeconds));

    if (counter.hits <= effectiveMax) {
      next();
      return;
    }

    const retryAfter = Math.max(1, resetSeconds - Math.ceil(now / 1000));
    res.setHeader("Retry-After", String(retryAfter));

    void recordSecurityEvent({
      eventType: "ratelimit.exceeded",
      outcome: "blocked",
      severity: "warning",
      message: `Rate limit exceeded for category ${category}`,
      ipAddress: address,
      userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
      metadata: {
        category,
        path: req.path,
        limit: effectiveMax,
        loadFactor: factor,
      },
    });

    if (config.penaltyEnabled) {
      const level = (activePenalty?.level ?? 0) + 1;
      const duration = penaltyDurationMs(level);
      if (duration === null) {
        const permanent = await getSettingBool("ratelimit.permanent_ban_enabled", true);
        if (permanent) {
          await blacklistIp({
            pattern: address,
            reason: `Automatic ban after ${level} rate-limit violations (${category})`,
            source: "rate_limiter",
            expiresAt: null,
          });
          void recordSecurityEvent({
            eventType: "ratelimit.penalty",
            outcome: "blocked",
            severity: "critical",
            message: `Address permanently blacklisted after repeated rate-limit violations`,
            ipAddress: address,
            metadata: { category, level },
          });
        } else {
          const fallbackMinutes = await getSettingNumber("ratelimit.max_penalty_minutes", 60);
          penalties.set(penaltyKey, {
            level,
            until: now + fallbackMinutes * 60_000,
          });
        }
      } else {
        const penaltyUntil = new Date(now + duration);
        penalties.set(penaltyKey, { level, until: now + duration });
        void persistPenalty(penaltyKey, address, category, level, penaltyUntil);
        void recordSecurityEvent({
          eventType: "ratelimit.penalty",
          outcome: "blocked",
          severity: "warning",
          message: `Progressive penalty level ${level} applied for ${Math.round(duration / 1000)}s`,
          ipAddress: address,
          metadata: { category, level },
        });
      }
    }

    res.status(429).type("text/plain").send("Too Many Requests");
  };
}

/** Test seam: clears all counters and penalties. */
export function resetRateLimitState(): void {
  counters.clear();
  penalties.clear();
}
