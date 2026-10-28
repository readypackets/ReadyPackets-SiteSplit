/**
 * Native OAuth 2.1 primitives.
 *
 * The browser session remains the login/MFA authority. Native clients receive
 * only a short-lived authorization code after PKCE validation and persist an
 * opaque rotating refresh token in platform secure storage.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { affectedRows } from "../db/result.js";
import {
  mobileAuthorizationCodes,
  mobileDeviceSessions,
  mobileDevices,
  mobileRefreshTokens,
  users,
} from "../db/schema.js";
import { recordSecurityEvent } from "../observability/audit.js";

export const MOBILE_CLIENT_ID = "readypackets-native";
const ACCESS_AUDIENCE = "readypackets-mobile-v1";
const MOBILE_SCOPES = new Set(["mobile:read", "mobile:write"]);

export class MobileOAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

/**
 * Mobile OAuth is an operator-enabled surface. Keep this defensive guard inside
 * the primitive module as well as at the Express mount so future callers cannot
 * accidentally issue or verify a token from an inert web-only configuration.
 */
function requireMobileEnabled(): void {
  if (!env.mobile.enabled) {
    throw new MobileOAuthError("not_found", "The requested resource was not found.", 404);
  }
}

function mobileAccessTokenKey(): Uint8Array {
  requireMobileEnabled();
  if (!env.mobile.accessTokenSecret) {
    throw new MobileOAuthError("server_error", "Mobile authorization is unavailable.", 503);
  }
  return new TextEncoder().encode(env.mobile.accessTokenSecret);
}

export interface MobilePrincipal {
  userId: number;
  role: string;
  deviceId: string;
  sessionId: string;
  scopes: string[];
}

export interface AuthorizeInput {
  redirectUri: string;
  codeChallenge: string;
  state: string;
  deviceId: string;
  platform: "ios" | "android";
  appVersion: string;
  deviceName?: string;
  scopes: string[];
}

function opaque(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function approvedScopes(requested: string[]): string[] {
  const scopes = requested.length ? requested : ["mobile:read", "mobile:write"];
  if (scopes.some((scope) => !MOBILE_SCOPES.has(scope)) || new Set(scopes).size !== scopes.length) {
    throw new MobileOAuthError("invalid_scope", "The requested mobile permission is not available.");
  }
  return scopes;
}

export function allowedRedirectUri(value: string): string {
  requireMobileEnabled();
  if (!env.mobile.redirectUris.includes(value)) {
    throw new MobileOAuthError("invalid_request", "The mobile redirect URI is not registered.");
  }
  return value;
}

export function validateAuthorizeInput(input: Partial<AuthorizeInput> & { clientId?: string; responseType?: string; challengeMethod?: string }): AuthorizeInput {
  if (input.clientId !== MOBILE_CLIENT_ID || input.responseType !== "code") {
    throw new MobileOAuthError("unauthorized_client", "The native application client is not recognized.", 401);
  }
  if (input.challengeMethod !== "S256" || !input.codeChallenge || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeChallenge)) {
    throw new MobileOAuthError("invalid_request", "A valid S256 PKCE code challenge is required.");
  }
  if (!input.state || input.state.length < 16 || input.state.length > 256) {
    throw new MobileOAuthError("invalid_request", "A valid state value is required.");
  }
  if (!input.deviceId || !/^[A-Za-z0-9._-]{16,96}$/.test(input.deviceId)) {
    throw new MobileOAuthError("invalid_request", "A valid device installation identifier is required.");
  }
  if (input.platform !== "ios" && input.platform !== "android") {
    throw new MobileOAuthError("invalid_request", "A supported mobile platform is required.");
  }
  if (!input.appVersion || input.appVersion.length > 32) {
    throw new MobileOAuthError("invalid_request", "A valid application version is required.");
  }
  return {
    redirectUri: allowedRedirectUri(input.redirectUri ?? ""),
    codeChallenge: input.codeChallenge,
    state: input.state,
    deviceId: input.deviceId,
    platform: input.platform,
    appVersion: input.appVersion,
    deviceName: input.deviceName?.slice(0, 128),
    scopes: approvedScopes(input.scopes ?? []),
  };
}

async function ensureDevice(userId: number, input: AuthorizeInput): Promise<void> {
  const existing = await db.select().from(mobileDevices).where(eq(mobileDevices.id, input.deviceId)).limit(1);
  if (existing[0] && existing[0].userId !== userId) {
    throw new MobileOAuthError("invalid_request", "This mobile installation is not available for the current account.", 403);
  }
  if (existing[0]?.status === "revoked") {
    throw new MobileOAuthError("device_revoked", "This mobile installation has been revoked.", 401);
  }
  if (existing[0]) {
    await db.update(mobileDevices).set({ platform: input.platform, appVersion: input.appVersion, deviceName: input.deviceName ?? null, lastSeenAt: new Date() }).where(eq(mobileDevices.id, input.deviceId));
    return;
  }
  await db.insert(mobileDevices).values({ id: input.deviceId, userId, platform: input.platform, appVersion: input.appVersion, deviceName: input.deviceName ?? null });
}

export async function createAuthorizationCode(userId: number, input: AuthorizeInput, audit: { ip?: string | null; userAgent?: string | null }): Promise<string> {
  requireMobileEnabled();
  await ensureDevice(userId, input);
  const code = opaque();
  await db.insert(mobileAuthorizationCodes).values({
    id: opaque(24),
    codeHash: digest(code),
    userId,
    deviceId: input.deviceId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: input.scopes,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  void recordSecurityEvent({
    eventType: "mobile.authorization_granted",
    message: "Native authorization code issued after browser MFA validation",
    userId,
    ipAddress: audit.ip ?? null,
    userAgent: audit.userAgent ?? null,
    metadata: { channel: "mobile", platform: input.platform, scope: input.scopes },
  });
  return code;
}

async function signAccessToken(sessionId: string, userId: number, deviceId: string, scopes: string[]): Promise<string> {
  const key = mobileAccessTokenKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: sessionId, uid: userId, did: deviceId, scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt", kid: env.mobile.accessTokenKeyId })
    .setIssuer(env.mobile.issuer)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + env.mobile.accessTokenTtlSeconds)
    .sign(key);
}

async function issueTokenSet(input: { userId: number; deviceId: string; sessionId: string; familyId: string; scopes: string[] }): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }> {
  const refreshToken = opaque(48);
  const refreshExpiry = new Date(Date.now() + env.mobile.refreshTokenTtlDays * 24 * 60 * 60_000);
  await db.insert(mobileRefreshTokens).values({
    id: opaque(24),
    tokenHash: digest(refreshToken),
    sessionId: input.sessionId,
    tokenFamilyId: input.familyId,
    expiresAt: refreshExpiry,
  });
  const accessToken = await signAccessToken(input.sessionId, input.userId, input.deviceId, input.scopes);
  return { access_token: accessToken, token_type: "Bearer", expires_in: env.mobile.accessTokenTtlSeconds, refresh_token: refreshToken, scope: input.scopes.join(" ") };
}

function accountEligible(user: { status: string; emailVerified: boolean; mfaEnabled: boolean; mustChangePassword: boolean } | undefined): boolean {
  return Boolean(user && user.status === "active" && user.emailVerified && user.mfaEnabled && !user.mustChangePassword);
}

export async function exchangeAuthorizationCode(input: { code: string; codeVerifier: string; redirectUri: string; clientId: string; ip?: string | null; userAgent?: string | null }) {
  requireMobileEnabled();
  if (input.clientId !== MOBILE_CLIENT_ID) throw new MobileOAuthError("unauthorized_client", "The native application client is not recognized.", 401);
  allowedRedirectUri(input.redirectUri);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw new MobileOAuthError("invalid_request", "A valid PKCE verifier is required.");
  const row = (await db.select().from(mobileAuthorizationCodes).where(eq(mobileAuthorizationCodes.codeHash, digest(input.code))).limit(1))[0];
  if (!row || row.usedAt || row.expiresAt <= new Date()) throw new MobileOAuthError("invalid_grant", "The authorization code is invalid or expired.", 401);
  if (row.redirectUri !== input.redirectUri) throw new MobileOAuthError("invalid_grant", "The authorization code was not issued to this redirect URI.", 401);
  const verifierChallenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
  if (verifierChallenge !== row.codeChallenge) throw new MobileOAuthError("invalid_grant", "The PKCE verifier is not valid.", 401);
  const consumeResult = await db.update(mobileAuthorizationCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(mobileAuthorizationCodes.id, row.id), isNull(mobileAuthorizationCodes.usedAt)));
  if (affectedRows(consumeResult) !== 1) {
    throw new MobileOAuthError("invalid_grant", "The authorization code was already used.", 401);
  }
  const user = (await db.select({ id: users.id, status: users.status, emailVerified: users.emailVerified, mfaEnabled: users.mfaEnabled, mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, row.userId)).limit(1))[0];
  if (!accountEligible(user)) throw new MobileOAuthError("invalid_grant", "The account is not eligible for mobile authorization.", 401);
  const sessionId = opaque(24);
  const familyId = opaque(24);
  const expiresAt = new Date(Date.now() + env.mobile.refreshTokenTtlDays * 24 * 60 * 60_000);
  const scopes = approvedScopes(Array.isArray(row.scopes) ? row.scopes.filter((value): value is string => typeof value === "string") : []);
  await db.insert(mobileDeviceSessions).values({ id: sessionId, tokenFamilyId: familyId, deviceId: row.deviceId, userId: row.userId, scopes, expiresAt });
  const tokens = await issueTokenSet({ userId: row.userId, deviceId: row.deviceId, sessionId, familyId, scopes });
  void recordSecurityEvent({ eventType: "mobile.token_issued", message: "Native authorization code exchanged for a device-bound token family", userId: row.userId, ipAddress: input.ip ?? null, userAgent: input.userAgent ?? null, metadata: { channel: "mobile", scope: scopes } });
  return tokens;
}

async function revokeFamily(familyId: string, reason: string, metadata?: { userId?: number; ip?: string | null; userAgent?: string | null }): Promise<void> {
  const now = new Date();
  await db.update(mobileDeviceSessions).set({ status: "revoked", revokedAt: now, revokedReason: reason }).where(eq(mobileDeviceSessions.tokenFamilyId, familyId));
  await db.update(mobileRefreshTokens).set({ status: "revoked", revokedAt: now }).where(eq(mobileRefreshTokens.tokenFamilyId, familyId));
  if (metadata?.userId) void recordSecurityEvent({ eventType: "mobile.token_revoked", outcome: "blocked", message: "Native token family revoked", userId: metadata.userId, ipAddress: metadata.ip ?? null, userAgent: metadata.userAgent ?? null, metadata: { channel: "mobile", reason } });
}

export async function rotateRefreshToken(input: { refreshToken: string; clientId: string; ip?: string | null; userAgent?: string | null }) {
  requireMobileEnabled();
  if (input.clientId !== MOBILE_CLIENT_ID) throw new MobileOAuthError("unauthorized_client", "The native application client is not recognized.", 401);
  const row = (await db.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.tokenHash, digest(input.refreshToken))).limit(1))[0];
  if (!row) throw new MobileOAuthError("invalid_grant", "The refresh token is invalid.", 401);
  const session = (await db.select().from(mobileDeviceSessions).where(eq(mobileDeviceSessions.id, row.sessionId)).limit(1))[0];
  if (!session || row.status !== "active" || session.status !== "active" || row.expiresAt <= new Date() || session.expiresAt <= new Date()) {
    await revokeFamily(row.tokenFamilyId, "refresh_token_reuse_or_expiry", { userId: session?.userId, ip: input.ip, userAgent: input.userAgent });
    throw new MobileOAuthError("invalid_grant", "The refresh token is no longer valid.", 401);
  }
  const user = (await db.select({ id: users.id, status: users.status, emailVerified: users.emailVerified, mfaEnabled: users.mfaEnabled, mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, session.userId)).limit(1))[0];
  const device = (await db.select({ id: mobileDevices.id, status: mobileDevices.status }).from(mobileDevices).where(eq(mobileDevices.id, session.deviceId)).limit(1))[0];
  if (!accountEligible(user) || !device || device.status !== "active") {
    await revokeFamily(row.tokenFamilyId, "user_or_device_no_longer_active", { userId: session.userId, ip: input.ip, userAgent: input.userAgent });
    throw new MobileOAuthError("invalid_grant", "The mobile session is no longer active.", 401);
  }
  const rotationResult = await db.update(mobileRefreshTokens)
    .set({ status: "rotated", rotatedAt: new Date() })
    .where(and(eq(mobileRefreshTokens.id, row.id), eq(mobileRefreshTokens.status, "active")));
  if (affectedRows(rotationResult) !== 1) {
    await revokeFamily(row.tokenFamilyId, "refresh_token_reuse", { userId: session.userId, ip: input.ip, userAgent: input.userAgent });
    throw new MobileOAuthError("invalid_grant", "The refresh token is no longer valid.", 401);
  }
  await db.update(mobileDeviceSessions).set({ lastSeenAt: new Date() }).where(eq(mobileDeviceSessions.id, session.id));
  const scopes = approvedScopes(Array.isArray(session.scopes) ? session.scopes.filter((value): value is string => typeof value === "string") : []);
  const tokens = await issueTokenSet({ userId: session.userId, deviceId: session.deviceId, sessionId: session.id, familyId: session.tokenFamilyId, scopes });
  void recordSecurityEvent({ eventType: "mobile.token_rotated", message: "Native refresh token rotated", userId: session.userId, ipAddress: input.ip ?? null, userAgent: input.userAgent ?? null, metadata: { channel: "mobile", scope: scopes } });
  return tokens;
}

export async function revokePresentedRefreshToken(refreshToken: string, audit: { ip?: string | null; userAgent?: string | null }): Promise<void> {
  const row = (await db.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.tokenHash, digest(refreshToken))).limit(1))[0];
  if (!row) return;
  const session = (await db.select().from(mobileDeviceSessions).where(eq(mobileDeviceSessions.id, row.sessionId)).limit(1))[0];
  await revokeFamily(row.tokenFamilyId, "native_logout", { userId: session?.userId, ip: audit.ip, userAgent: audit.userAgent });
}

/** Revoke every mobile token family when account recovery, lock, or deletion changes trust. */
export async function revokeMobileSessionsForUser(userId: number, reason: string): Promise<void> {
  const sessions = await db.select({ id: mobileDeviceSessions.id }).from(mobileDeviceSessions).where(eq(mobileDeviceSessions.userId, userId));
  const sessionIds = sessions.map((session) => session.id);
  const now = new Date();
  await db.update(mobileDeviceSessions)
    .set({ status: "revoked", revokedAt: now, revokedReason: reason.slice(0, 190) })
    .where(and(eq(mobileDeviceSessions.userId, userId), eq(mobileDeviceSessions.status, "active")));
  if (sessionIds.length) {
    await db.update(mobileRefreshTokens)
      .set({ status: "revoked", revokedAt: now })
      .where(and(inArray(mobileRefreshTokens.sessionId, sessionIds), eq(mobileRefreshTokens.status, "active")));
  }
  void recordSecurityEvent({ eventType: "mobile.token_revoked", outcome: "blocked", message: "All native mobile sessions revoked", userId, metadata: { channel: "mobile", reason } });
}

export async function resolveMobilePrincipal(accessToken: string): Promise<MobilePrincipal> {
  const key = mobileAccessTokenKey();
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(accessToken, key, { issuer: env.mobile.issuer, audience: ACCESS_AUDIENCE, algorithms: ["HS256"] });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new MobileOAuthError("invalid_token", "The mobile access token is invalid or expired.", 401);
  }
  const sessionId = typeof payload.sid === "string" ? payload.sid : "";
  const userId = typeof payload.uid === "number" ? payload.uid : Number.NaN;
  const deviceId = typeof payload.did === "string" ? payload.did : "";
  if (!sessionId || !Number.isSafeInteger(userId) || !deviceId) throw new MobileOAuthError("invalid_token", "The mobile access token is invalid.", 401);
  const session = (await db.select().from(mobileDeviceSessions).where(and(eq(mobileDeviceSessions.id, sessionId), eq(mobileDeviceSessions.userId, userId), eq(mobileDeviceSessions.deviceId, deviceId), eq(mobileDeviceSessions.status, "active"), gt(mobileDeviceSessions.expiresAt, new Date()))).limit(1))[0];
  const user = (await db.select({ id: users.id, role: users.role, status: users.status, emailVerified: users.emailVerified, mfaEnabled: users.mfaEnabled, mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, userId)).limit(1))[0];
  const device = (await db.select({ id: mobileDevices.id, status: mobileDevices.status }).from(mobileDevices).where(eq(mobileDevices.id, deviceId)).limit(1))[0];
  if (!session || !user || !accountEligible(user) || !device || device.status !== "active") throw new MobileOAuthError("invalid_token", "The mobile session is no longer active.", 401);
  await db.update(mobileDeviceSessions).set({ lastSeenAt: new Date() }).where(eq(mobileDeviceSessions.id, session.id));
  return { userId, role: user.role, deviceId, sessionId, scopes: approvedScopes(typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : []) };
}

export function hashMobileValue(value: string): string { return digest(value); }
export function opaqueMobileId(): string { return opaque(24); }
