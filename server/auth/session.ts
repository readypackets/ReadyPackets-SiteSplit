/**
 * Session management.
 *
 * A signed JWT carries the session identifier, and a matching row in
 * `user_sessions` holds the authoritative state. The token alone is never
 * sufficient: revocation, idle timeout, MFA completion and restriction are all
 * enforced from the database row, which is what makes "revoke session" real.
 */
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { and, eq, lt, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { isRoleBlockedByAdministratorOnlyAccess } from "./adminOnlyAccess.js";
import { db } from "../db/client.js";
import { users, userSessions } from "../db/schema.js";
import { logger } from "../observability/logger.js";
import { recordSecurityEvent } from "../observability/audit.js";
import { generateCsrfToken, setCsrfCookie, clearCsrfCookie } from "../security/csrf.js";
import type { UserRole } from "../../shared/domain.js";
import { affectedRows } from "../db/result.js";

export const SESSION_COOKIE = `${env.cookiePrefix}rp_session`;

const secretKey = new TextEncoder().encode(env.sessionSecret);
const ISSUER = "readypackets";
const AUDIENCE = "readypackets-portal";

export interface SessionUser {
  id: number;
  role: UserRole;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  status: string;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUser;
  csrfSecret: string;
  mfaPending: boolean;
  restricted: boolean;
  expiresAt: Date;
}

async function signSessionToken(sessionId: string, userId: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: sessionId, uid: userId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(now + env.sessionTtlMinutes * 60)
    .sign(secretKey);
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "strict",
    path: "/",
    maxAge: env.sessionTtlMinutes * 60 * 1000,
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "strict",
    path: "/",
  });
  clearCsrfCookie(res);
}

export interface CreateSessionOptions {
  userId: number;
  ipAddress?: string | null;
  userAgent?: string | null;
  mfaPending?: boolean;
  restricted?: boolean;
}

/** Create a session row, issue the cookies, and return the CSRF token. */
export async function createSession(
  res: Response,
  options: CreateSessionOptions,
): Promise<{ sessionId: string; csrfToken: string }> {
  const sessionId = randomBytes(32).toString("hex");
  const csrfToken = generateCsrfToken();
  const expiresAt = new Date(Date.now() + env.sessionTtlMinutes * 60_000);

  await db.insert(userSessions).values({
    id: sessionId,
    userId: options.userId,
    csrfSecret: csrfToken,
    ipAddress: options.ipAddress?.slice(0, 64) ?? null,
    userAgent: options.userAgent?.slice(0, 255) ?? null,
    mfaPending: options.mfaPending ?? false,
    restricted: options.restricted ?? false,
    expiresAt,
  });

  const token = await signSessionToken(sessionId, options.userId);
  setSessionCookie(res, token);
  setCsrfCookie(res, csrfToken);
  return { sessionId, csrfToken };
}

/**
 * Rotate the session identifier while preserving the authenticated user.
 * Called after login completion and privilege change to defeat fixation.
 */
export async function rotateSession(
  res: Response,
  current: ActiveSession,
  changes: { mfaPending?: boolean; restricted?: boolean } = {},
): Promise<{ sessionId: string; csrfToken: string }> {
  // Preserve the source metadata captured at initial sign-in. MFA and password
  // rotations must not make an otherwise attributable session appear anonymous.
  const metadata = await db
    .select({ ipAddress: userSessions.ipAddress, userAgent: userSessions.userAgent })
    .from(userSessions)
    .where(eq(userSessions.id, current.sessionId))
    .limit(1);
  await revokeSession(current.sessionId, "rotated");
  return createSession(res, {
    userId: current.user.id,
    ipAddress: metadata[0]?.ipAddress ?? null,
    userAgent: metadata[0]?.userAgent ?? null,
    mfaPending: changes.mfaPending ?? false,
    restricted: changes.restricted ?? false,
  });
}

export async function resolveSession(req: Request): Promise<ActiveSession | null> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return null;

  let sessionId: string;
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    if (typeof payload.sid !== "string") return null;
    sessionId = payload.sid;
  } catch {
    return null;
  }

  const rows = await db
    .select({
      sessionId: userSessions.id,
      csrfSecret: userSessions.csrfSecret,
      mfaPending: userSessions.mfaPending,
      restricted: userSessions.restricted,
      status: userSessions.status,
      expiresAt: userSessions.expiresAt,
      lastSeenAt: userSessions.lastSeenAt,
      revokedAt: userSessions.revokedAt,
      userId: users.id,
      role: users.role,
      emailVerified: users.emailVerified,
      mfaEnabled: users.mfaEnabled,
      mustChangePassword: users.mustChangePassword,
      userStatus: users.status,
      deletedAt: users.deletedAt,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(eq(userSessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt || row.status !== "active") return null;
  if (row.deletedAt || row.userStatus !== "active") return null;
  if (await isRoleBlockedByAdministratorOnlyAccess(row.role)) {
    await revokeSession(sessionId, "administrator_only_access");
    void recordSecurityEvent({
      eventType: "session.revoked_administrator_only",
      outcome: "blocked",
      severity: "notice",
      message: "Session revoked by administrator-only access mode",
      userId: row.userId,
    });
    return null;
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await revokeSession(sessionId, "expired");
    return null;
  }

  const idleLimitMs = env.sessionIdleTimeoutMinutes * 60_000;
  if (idleLimitMs > 0 && Date.now() - row.lastSeenAt.getTime() > idleLimitMs) {
    await revokeSession(sessionId, "idle_timeout");
    void recordSecurityEvent({
      eventType: "session.expired",
      outcome: "blocked",
      message: "Session ended after exceeding the idle timeout",
      userId: row.userId,
    });
    return null;
  }

  // Touch at most once per minute to avoid a write on every request.
  if (Date.now() - row.lastSeenAt.getTime() > 60_000) {
    void db
      .update(userSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(userSessions.id, sessionId))
      .catch((error: unknown) => logger.warn("Failed to touch session", { error }));
  }

  return {
    sessionId,
    csrfSecret: row.csrfSecret,
    mfaPending: row.mfaPending,
    restricted: row.restricted,
    expiresAt: row.expiresAt,
    user: {
      id: row.userId,
      role: row.role as UserRole,
      emailVerified: row.emailVerified,
      mfaEnabled: row.mfaEnabled,
      mustChangePassword: row.mustChangePassword,
      status: row.userStatus,
    },
  };
}

export async function markMfaSatisfied(sessionId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ mfaPending: false, restricted: false })
    .where(eq(userSessions.id, sessionId));
}

/**
 * Keep a just-enrolled account inside the restricted MFA surface until the
 * one-time recovery-code screen is deliberately acknowledged. The codes are
 * never persisted in browser storage, so a background session refresh must not
 * make normal Portal navigation available before the user has had that chance.
 */
export async function requireMfaEnrolmentAcknowledgement(sessionId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ mfaPending: false, restricted: true })
    .where(eq(userSessions.id, sessionId));
}

export async function clearSessionRestriction(sessionId: string): Promise<void> {
  await db.update(userSessions).set({ restricted: false }).where(eq(userSessions.id, sessionId));
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ status: "revoked", revokedAt: new Date(), revokedReason: reason.slice(0, 190) })
    .where(eq(userSessions.id, sessionId));
}

export async function suspendSession(sessionId: string): Promise<void> {
  await db.update(userSessions).set({ status: "suspended" }).where(eq(userSessions.id, sessionId));
}

export async function restoreSession(sessionId: string): Promise<void> {
  await db
    .update(userSessions)
    .set({ status: "active", revokedAt: null, revokedReason: null })
    .where(eq(userSessions.id, sessionId));
}

/**
 * Revoke any active sessions that are still awaiting MFA for a given user.
 * Called at the start of a new login so the browser cannot accumulate stale
 * mfaPending cookies that confuse the session refresh after MFA succeeds.
 */
export async function revokePendingMfaSessions(userId: number): Promise<void> {
  await db
    .update(userSessions)
    .set({ status: "revoked", revokedAt: new Date(), revokedReason: "superseded_by_new_login" })
    .where(
      and(
        eq(userSessions.userId, userId),
        eq(userSessions.mfaPending, true),
        eq(userSessions.status, "active"),
      ),
    );
}

/** Revoke every session for a user, optionally sparing the current one. */
export async function revokeAllUserSessions(
  userId: number,
  reason: string,
  exceptSessionId?: string,
): Promise<void> {
  const condition = exceptSessionId
    ? and(eq(userSessions.userId, userId), sql`${userSessions.id} <> ${exceptSessionId}`)
    : eq(userSessions.userId, userId);
  await db
    .update(userSessions)
    .set({ status: "revoked", revokedAt: new Date(), revokedReason: reason.slice(0, 190) })
    .where(condition);
}

export async function listUserSessions(userId: number) {
  return db
    .select({
      id: userSessions.id,
      ipAddress: userSessions.ipAddress,
      userAgent: userSessions.userAgent,
      status: userSessions.status,
      lastSeenAt: userSessions.lastSeenAt,
      expiresAt: userSessions.expiresAt,
      createdAt: userSessions.createdAt,
      revokedAt: userSessions.revokedAt,
    })
    .from(userSessions)
    .where(eq(userSessions.userId, userId))
    .orderBy(sql`${userSessions.lastSeenAt} DESC`)
    .limit(100);
}

/** Remove expired session rows. Invoked by the scheduler. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
  return affectedRows(result);
}
