/** Versioned, bearer-token mobile API. Browser sessions/tRPC are intentionally not reused as an API contract. */
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { Router, type NextFunction, type Request, type Response } from "express";
import { env } from "../../config/env.js";
import { MOBILE_CLIENT_ID, MobileOAuthError, allowedRedirectUri, createAuthorizationCode, exchangeAuthorizationCode, hashMobileValue, opaqueMobileId, resolveMobilePrincipal, revokeMobileSessionsForUser, revokePresentedRefreshToken, rotateRefreshToken, validateAuthorizeInput, type MobilePrincipal } from "../../auth/mobileOidc.js";
import { resolveSession } from "../../auth/session.js";
import { db } from "../../db/client.js";
import { mobileDeviceSessions, mobileDevices, mobileIdempotencyKeys, mobileRefreshTokens, orders, packetGroups, products, users } from "../../db/schema.js";
import { getUserById, displayNameOf } from "../../db/users.js";
import { recordSecurityEvent } from "../../observability/audit.js";
import { assertOrderAccess, createOrder, listOrdersForUser, OrderStateError } from "../../services/orders.js";
import { createMobileCustomerRouter } from "./customer.js";
import { createMobilePublicRouter } from "./public.js";

interface MobileRequest extends Request { mobile?: MobilePrincipal; }

function correlationId(): string { return randomBytes(9).toString("base64url"); }
function clientIp(res: Response): string | null { return (res.locals.clientIp as string | undefined) ?? null; }
function requestCorrelationId(res: Response): string {
  return (res.locals.mobileCorrelationId as string | undefined) ?? correlationId();
}
function safeProblem(res: Response, status: number, code: string, title: string, detail?: string): void {
  res.status(status).type("application/problem+json").json({ type: `https://readypackets.com/problems/${code}`, title, status, code, detail, correlationId: requestCorrelationId(res) });
}
function serializeDate(value: Date | null | undefined): string | null { return value ? value.toISOString() : null; }
function opaqueOrderId(orderNumber: string): string { return orderNumber; }
function parseLimit(value: unknown): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(50, Math.max(1, parsed)) : 20; }

function requireScope(req: MobileRequest, scope: "mobile:read" | "mobile:write"): void {
  if (!req.mobile?.scopes.includes(scope)) throw new MobileOAuthError("insufficient_scope", `The ${scope} permission is required.`, 403);
}

type MobileSelection = { sku: string; quantity?: number };
function parseSelections(value: unknown): MobileSelection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new MobileOAuthError("invalid_request", "Choose between one and twelve listed packets.");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new MobileOAuthError("invalid_request", "Each packet selection must be valid.");
    const candidate = item as Record<string, unknown>;
    const sku = typeof candidate.sku === "string" ? candidate.sku.trim() : "";
    const quantity = candidate.quantity === undefined ? 1 : Number(candidate.quantity);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sku) || seen.has(sku)) throw new MobileOAuthError("invalid_request", "Each selection must identify a unique listed packet.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) throw new MobileOAuthError("invalid_request", "Packet quantities must be whole numbers between one and twenty-five.");
    seen.add(sku);
    return { sku, quantity };
  });
}

async function resolveListedProducts(selections: MobileSelection[]): Promise<{ id: number; sku: string }[]> {
  const rows = await db.select({ id: products.id, sku: products.sku }).from(products).where(and(inArray(products.sku, selections.map((item) => item.sku)), eq(products.listed, true), eq(products.active, true)));
  if (rows.length !== selections.length) throw new MobileOAuthError("invalid_request", "One or more selected packets are unavailable.");
  return rows;
}

function withMobileError(handler: (req: MobileRequest, res: Response) => Promise<void>) {
  return async (req: MobileRequest, res: Response): Promise<void> => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof MobileOAuthError) { safeProblem(res, error.status, error.code, "Mobile authorization request rejected", error.message); return; }
      safeProblem(res, 500, "internal_error", "Unable to complete the mobile request");
    }
  };
}

async function bearer(req: MobileRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) { safeProblem(res, 401, "invalid_token", "Mobile authentication is required"); return; }
  try { req.mobile = await resolveMobilePrincipal(header.slice("Bearer ".length)); next(); }
  catch (error) {
    const problem = error instanceof MobileOAuthError ? error : new MobileOAuthError("invalid_token", "The mobile access token is invalid.", 401);
    void recordSecurityEvent({ eventType: "mobile.authorization_failed", outcome: "blocked", message: "Mobile bearer authentication rejected", ipAddress: clientIp(res), userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null, metadata: { channel: "mobile", code: problem.code, correlationId: requestCorrelationId(res) } });
    safeProblem(res, problem.status, problem.code, "Mobile authentication failed", problem.message);
  }
}

function validContinuation(value: string | undefined): string | null {
  if (!value || !value.startsWith("/api/mobile/v1/authorize?")) return null;
  return value.length <= 2048 ? value : null;
}

async function runIdempotent<T>(req: MobileRequest, route: string, body: unknown, action: () => Promise<T>): Promise<{ replayed: boolean; value: T }> {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 16 || key.length > 128) throw new MobileOAuthError("idempotency_key_required", "A valid Idempotency-Key is required.");
  const principal = req.mobile!;
  const keyHash = hashMobileValue(key);
  const requestHash = hashMobileValue(JSON.stringify(body ?? null));
  const existing = (await db.select().from(mobileIdempotencyKeys).where(and(eq(mobileIdempotencyKeys.userId, principal.userId), eq(mobileIdempotencyKeys.keyHash, keyHash))).limit(1))[0];
  if (existing) {
    if (existing.requestHash !== requestHash || existing.route !== route) {
      void recordSecurityEvent({ eventType: "mobile.idempotency_conflict", outcome: "blocked", message: "Mobile idempotency key conflicted", userId: principal.userId, metadata: { channel: "mobile", route } });
      throw new MobileOAuthError("idempotency_conflict", "This Idempotency-Key was already used for a different request.", 409);
    }
    void recordSecurityEvent({ eventType: "mobile.idempotency_replayed", message: "Mobile idempotent response replayed", userId: principal.userId, metadata: { channel: "mobile", route } });
    return { replayed: true, value: existing.responseJson as T };
  }
  const value = await action();
  await db.insert(mobileIdempotencyKeys).values({ id: opaqueMobileId(), userId: principal.userId, route, keyHash, requestHash, responseJson: value as Record<string, unknown>, expiresAt: new Date(Date.now() + 24 * 60 * 60_000) });
  return { replayed: false, value };
}

export function createMobileDiscoveryRouter(): Router {
  const router = Router();
  router.get("/.well-known/openid-configuration", (_req, res) => {
    res.setHeader("Cache-Control", "no-store").json({
      issuer: env.mobile.issuer,
      authorization_endpoint: `${env.appUrl}/api/mobile/v1/authorize`,
      token_endpoint: `${env.appUrl}/api/mobile/v1/token`,
      revocation_endpoint: `${env.appUrl}/api/mobile/v1/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mobile:read", "mobile:write"],
    });
  });
  return router;
}

export function createMobileRouter(): Router {
  const router = Router();
  router.use((req, res, next) => {
    const supplied = typeof req.headers["x-correlation-id"] === "string" ? req.headers["x-correlation-id"] : "";
    const id = /^[A-Za-z0-9_-]{12,96}$/.test(supplied) ? supplied : correlationId();
    res.locals.mobileCorrelationId = id;
    res.setHeader("X-Correlation-ID", id);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Vary", "Authorization");
    next();
  });
  router.get("/authorize", withMobileError(async (req, res) => {
    const input = validateAuthorizeInput({
      clientId: typeof req.query.client_id === "string" ? req.query.client_id : undefined,
      responseType: typeof req.query.response_type === "string" ? req.query.response_type : undefined,
      redirectUri: typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : undefined,
      codeChallenge: typeof req.query.code_challenge === "string" ? req.query.code_challenge : undefined,
      challengeMethod: typeof req.query.code_challenge_method === "string" ? req.query.code_challenge_method : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      deviceId: typeof req.query.device_id === "string" ? req.query.device_id : undefined,
      platform: req.query.platform === "ios" || req.query.platform === "android" ? req.query.platform : undefined,
      appVersion: typeof req.query.app_version === "string" ? req.query.app_version : undefined,
      deviceName: typeof req.query.device_name === "string" ? req.query.device_name : undefined,
      scopes: typeof req.query.scope === "string" ? req.query.scope.split(" ").filter(Boolean) : [],
    });
    const session = await resolveSession(req);
    if (!session || session.mfaPending || session.restricted || session.user.status !== "active" || !session.user.emailVerified || !session.user.mfaEnabled || session.user.mustChangePassword) {
      res.redirect(`/login?continue=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    const code = await createAuthorizationCode(session.user.id, input, { ip: clientIp(res), userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null });
    const callback = new URL(input.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", input.state);
    res.setHeader("Cache-Control", "no-store").redirect(callback.toString());
  }));

  router.post("/token", withMobileError(async (req, res) => {
    const grantType = req.body?.grant_type;
    const audit = { ip: clientIp(res), userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null };
    const tokens = grantType === "authorization_code"
      ? await exchangeAuthorizationCode({ code: String(req.body?.code ?? ""), codeVerifier: String(req.body?.code_verifier ?? ""), redirectUri: allowedRedirectUri(String(req.body?.redirect_uri ?? "")), clientId: String(req.body?.client_id ?? ""), ...audit })
      : grantType === "refresh_token"
        ? await rotateRefreshToken({ refreshToken: String(req.body?.refresh_token ?? ""), clientId: String(req.body?.client_id ?? ""), ...audit })
        : (() => { throw new MobileOAuthError("unsupported_grant_type", "The requested grant type is not supported."); })();
    res.setHeader("Cache-Control", "no-store").json(tokens);
  }));

  router.post("/revoke", withMobileError(async (req, res) => {
    await revokePresentedRefreshToken(String(req.body?.token ?? ""), { ip: clientIp(res), userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null });
    res.status(200).json({ revoked: true });
  }));

	// Published catalogue, policy, help and contact content must remain available
	// before sign-in. Auth lifecycle actions use system-browser Portal URLs rather
	// than turning the native API into a parallel identity surface.
	router.use("/public", createMobilePublicRouter());

	router.use(bearer);
	router.use((req, _res, next) => {
	  try { requireScope(req as MobileRequest, "mobile:read"); next(); }
	  catch (error) { next(error); }
	});
	// Customer parity endpoints retain a separate allowlist from the browser tRPC
	// surface. Staff and administrator roles are denied by this subrouter.
	router.use("/customer", createMobileCustomerRouter());

	router.get("/catalog", withMobileError(async (req, res) => {
	  requireScope(req, "mobile:read");
	  const rows = await db
	    .select({
	      groupSlug: packetGroups.slug,
	      groupNumber: packetGroups.groupNumber,
	      groupName: packetGroups.name,
	      groupCategory: packetGroups.category,
	      groupSummary: packetGroups.summary,
	      sku: products.sku,
	      productName: products.name,
	      tier: products.tier,
	      priceCents: products.priceCents,
	      customPricing: products.customPricing,
	      deliveryEstimate: products.deliveryEstimate,
	      outcome: products.outcome,
	      description: products.description,
	    })
	    .from(packetGroups)
	    .innerJoin(products, eq(products.packetGroupId, packetGroups.id))
	    .where(and(eq(packetGroups.listed, true), eq(products.listed, true), eq(products.active, true)))
	    .orderBy(asc(packetGroups.sortOrder), asc(products.sortOrder));
	  const groups = new Map<string, { slug: string; number: number; name: string; category: string; summary: string | null; packets: Array<Record<string, unknown>> }>();
	  for (const row of rows) {
	    const group = groups.get(row.groupSlug) ?? { slug: row.groupSlug, number: row.groupNumber, name: row.groupName, category: row.groupCategory, summary: row.groupSummary, packets: [] };
	    group.packets.push({ sku: row.sku, name: row.productName, tier: row.tier, priceCents: row.priceCents, customPricing: row.customPricing, deliveryEstimate: row.deliveryEstimate, outcome: row.outcome, description: row.description });
	    groups.set(row.groupSlug, group);
	  }
	  res.json({ items: [...groups.values()] });
	}));

	router.post("/orders", withMobileError(async (req, res) => {
	  requireScope(req, "mobile:write");
	  const result = await runIdempotent(req, "POST /orders", req.body, async () => {
	    const selections = parseSelections(req.body?.selections);
	    const listed = await resolveListedProducts(selections);
	    const productBySku = new Map(listed.map((product) => [product.sku, product]));
	    const projectName = typeof req.body?.projectName === "string" ? req.body.projectName.trim() : "";
	    if (!projectName) throw new MobileOAuthError("invalid_request", "Enter an order or project name before placing an order.");
	    if (projectName.length > 160) throw new MobileOAuthError("invalid_request", "The project name must be 160 characters or fewer.");
	    try {
	      const created = await createOrder({
	        userId: req.mobile!.userId,
	        selections: selections.map((selection) => ({ productId: productBySku.get(selection.sku)!.id, quantity: selection.quantity })),
	        projectName,
	        paymentRequirement: "required",
	        actorUserId: req.mobile!.userId,
	        actorRole: req.mobile!.role,
	        ipAddress: clientIp(res),
	      });
	      const quote = created.quote as { totalCents: number; requiresCustomQuote?: boolean };
	      const requiresCustomQuote = quote.requiresCustomQuote === true;
	      return {
	        order: {
	          publicOrderId: opaqueOrderId(created.orderNumber),
	          projectName,
	          status: "new",
	          paymentStatus: requiresCustomQuote ? "awaiting_invoice" : "unpaid",
	          totalCents: quote.totalCents,
	          requiresCustomQuote,
	        },
	        nextAction: requiresCustomQuote ? "await_quote" : "complete_payment_in_portal",
	        message: requiresCustomQuote ? "Your request is recorded. ReadyPackets will provide the required quote in the Portal." : "Your order is recorded. Complete payment through the secure ReadyPackets Portal to activate work.",
	      };
	    } catch (error) {
	      if (error instanceof OrderStateError) throw new MobileOAuthError("order_rejected", error.message, 422);
	      throw error;
	    }
	  });
	  res.status(result.replayed ? 200 : 201).json(result.value);
	}));

	router.get("/me", withMobileError(async (req, res) => {
    const principal = req.mobile!;
    const user = await getUserById(principal.userId);
    if (!user) throw new MobileOAuthError("invalid_token", "The account is not active.", 401);
    const capabilities = user.role === "customer" ? ["dashboard", "orders", "messages", "documents", "profile"] : user.role === "staff" ? ["dashboard", "orders", "messages", "documents", "profile", "staff.work_queue"] : ["dashboard", "orders", "messages", "documents", "profile", "admin.overview"];
    res.json({ id: user.customerNumber ?? user.publicId ?? `usr-${principal.userId}`, displayName: displayNameOf(user), email: user.email, role: user.role, capabilities, mfaEnabled: user.mfaEnabled, emailVerified: user.emailVerified });
  }));

  router.get("/dashboard", withMobileError(async (req, res) => {
    const items = await listOrdersForUser(req.mobile!.userId);
    const attention = items.filter((item) => item.attention.state !== "none");
    res.json({ orderCount: items.length, attentionCount: attention.length, currentOrders: items.filter((item) => !["closed", "cancelled", "refunded"].includes(item.status)).slice(0, 5).map((item) => ({ publicOrderId: opaqueOrderId(item.orderNumber), projectName: item.projectName, status: item.status, completionPercent: item.completionPercent, currentStage: item.currentPhaseLabel, attention: item.attention.state })) });
  }));

  router.get("/orders", withMobileError(async (req, res) => {
    const all = await listOrdersForUser(req.mobile!.userId);
    const limit = parseLimit(req.query.limit);
    const start = typeof req.query.cursor === "string" ? Math.max(0, all.findIndex((order) => order.orderNumber === req.query.cursor) + 1) : 0;
    const page = all.slice(start, start + limit).map((item) => ({ publicOrderId: opaqueOrderId(item.orderNumber), projectName: item.projectName, status: item.status, paymentStatus: item.paymentStatus, completionPercent: item.completionPercent, currentStage: item.currentPhaseLabel, attention: item.attention.state, dueAt: serializeDate(item.dueAt), deliveredAt: serializeDate(item.deliveredAt), createdAt: serializeDate(item.createdAt) }));
    res.json({ items: page, nextCursor: start + limit < all.length ? all[start + limit - 1]?.orderNumber ?? null : null });
  }));

  router.get("/orders/:publicOrderId", withMobileError(async (req, res) => {
    const publicOrderId = req.params.publicOrderId;
    const summary = (await listOrdersForUser(req.mobile!.userId)).find((item) => item.orderNumber === publicOrderId);
    if (!summary) throw new MobileOAuthError("not_found", "The requested order was not found.", 404);
    await assertOrderAccess(summary.id, req.mobile!.userId, req.mobile!.role);
    // Do not expose getOrderDetail(): it intentionally serves browser/admin data,
    // including database identifiers and encrypted/internal fields, not a mobile DTO.
    res.json({
      publicOrderId,
      projectName: summary.projectName,
      status: summary.status,
      paymentStatus: summary.paymentStatus,
      completionPercent: summary.completionPercent,
      currentStage: summary.currentPhaseLabel,
      attention: summary.attention.state,
      dueAt: serializeDate(summary.dueAt),
      deliveredAt: serializeDate(summary.deliveredAt),
      createdAt: serializeDate(summary.createdAt),
    });
  }));

  router.get("/me/devices", withMobileError(async (req, res) => {
    requireScope(req, "mobile:read");
    const rows = await db.select({ id: mobileDevices.id, platform: mobileDevices.platform, appVersion: mobileDevices.appVersion, deviceName: mobileDevices.deviceName, status: mobileDevices.status, lastSeenAt: mobileDevices.lastSeenAt, createdAt: mobileDevices.createdAt, revokedAt: mobileDevices.revokedAt }).from(mobileDevices).where(eq(mobileDevices.userId, req.mobile!.userId)).orderBy(desc(mobileDevices.lastSeenAt));
    res.json({ items: rows.map((row) => ({ ...row, lastSeenAt: serializeDate(row.lastSeenAt), createdAt: serializeDate(row.createdAt), revokedAt: serializeDate(row.revokedAt), current: row.id === req.mobile!.deviceId })) });
  }));

  router.delete("/me/devices/:deviceId", withMobileError(async (req, res) => {
    requireScope(req, "mobile:write");
    const rawDeviceId = req.params.deviceId;
    const deviceId = typeof rawDeviceId === "string" ? rawDeviceId : "";
    if (!/^[A-Za-z0-9._-]{16,96}$/.test(deviceId)) throw new MobileOAuthError("not_found", "The requested device was not found.", 404);
    const result = await runIdempotent(req, "DELETE /me/devices/:deviceId", { deviceId }, async () => {
      const target = (await db.select({ id: mobileDevices.id }).from(mobileDevices).where(and(eq(mobileDevices.id, deviceId), eq(mobileDevices.userId, req.mobile!.userId), eq(mobileDevices.status, "active"))).limit(1))[0];
      if (!target) throw new MobileOAuthError("not_found", "The requested device was not found.", 404);
      const now = new Date();
      await db.update(mobileDevices).set({ status: "revoked", revokedAt: now, revokedReason: "user_requested_mobile_revoke" }).where(eq(mobileDevices.id, deviceId));
      const sessions = await db.select({ id: mobileDeviceSessions.id }).from(mobileDeviceSessions).where(and(eq(mobileDeviceSessions.userId, req.mobile!.userId), eq(mobileDeviceSessions.deviceId, deviceId)));
      const sessionIds = sessions.map((session) => session.id);
      await db.update(mobileDeviceSessions).set({ status: "revoked", revokedAt: now, revokedReason: "user_requested_mobile_revoke" }).where(and(eq(mobileDeviceSessions.userId, req.mobile!.userId), eq(mobileDeviceSessions.deviceId, deviceId), eq(mobileDeviceSessions.status, "active")));
      if (sessionIds.length) await db.update(mobileRefreshTokens).set({ status: "revoked", revokedAt: now }).where(and(inArray(mobileRefreshTokens.sessionId, sessionIds), eq(mobileRefreshTokens.status, "active")));
      void recordSecurityEvent({ eventType: "mobile.device_revoked", message: "Mobile device revoked by account holder", userId: req.mobile!.userId, ipAddress: clientIp(res), metadata: { channel: "mobile", currentDevice: deviceId === req.mobile!.deviceId, correlationId: requestCorrelationId(res) } });
      return { revoked: true };
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  router.post("/devices", withMobileError(async (req, res) => {
    requireScope(req, "mobile:write");
    const result = await runIdempotent(req, "POST /devices", req.body, async () => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new MobileOAuthError("invalid_request", "A valid device registration is required.");
      const body = req.body as Record<string, unknown>;
      if (!/^[A-Za-z0-9._-]{16,96}$/.test(String(body.deviceId ?? ""))) throw new MobileOAuthError("invalid_request", "A valid device installation identifier is required.");
      const platform = typeof body.platform === "string" ? body.platform : "";
      if (!["ios", "android"].includes(platform)) throw new MobileOAuthError("invalid_request", "A supported platform is required.");
      if (!body.appVersion || String(body.appVersion).length > 32) throw new MobileOAuthError("invalid_request", "A valid app version is required.");
      if (body.deviceId !== req.mobile!.deviceId) throw new MobileOAuthError("invalid_request", "Device registration must match the authenticated installation.", 403);
      if ("pushToken" in body || "pushPlatform" in body) throw new MobileOAuthError("invalid_request", "Provider push tokens are not supported by the self-hosted mobile baseline.");
      await db.update(mobileDevices).set({ platform, appVersion: String(body.appVersion), deviceName: typeof body.deviceName === "string" ? body.deviceName.slice(0, 128) : null, lastSeenAt: new Date() }).where(eq(mobileDevices.id, String(body.deviceId)));
      void recordSecurityEvent({ eventType: "mobile.device_registered", message: "Authenticated mobile installation refreshed", userId: req.mobile!.userId, ipAddress: clientIp(res), metadata: { channel: "mobile", platform, correlationId: requestCorrelationId(res) } });
      return { registered: true };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  }));

  router.post("/me/data-deletion-request", withMobileError(async (req, res) => {
    requireScope(req, "mobile:write");
    const result = await runIdempotent(req, "POST /me/data-deletion-request", req.body, async () => {
      if (req.body?.confirmPhrase !== "DELETE MY ACCOUNT") throw new MobileOAuthError("invalid_request", "The deletion confirmation phrase is required.");
      const activeOrders = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.userId, req.mobile!.userId));
      const openOrders = activeOrders.filter((order) => !["closed", "cancelled", "refunded"].includes(order.status));
      await db.update(users).set({ status: "deactivated" }).where(eq(users.id, req.mobile!.userId));
      await db.update(mobileDevices).set({ status: "revoked", revokedAt: new Date(), revokedReason: "account_deletion_requested" }).where(eq(mobileDevices.userId, req.mobile!.userId));
      await revokeMobileSessionsForUser(req.mobile!.userId, "account_deletion_requested");
      void recordSecurityEvent({ eventType: "mobile.account_deletion_requested", severity: "notice", message: "Mobile account deletion request accepted; account deactivated pending retention review", userId: req.mobile!.userId, ipAddress: clientIp(res), metadata: { channel: "mobile", openOrders: openOrders.length, correlationId: requestCorrelationId(res) } });
      return { accepted: true, openOrders: openOrders.length, message: openOrders.length ? "Your account has been deactivated. Our team will contact you about work in progress." : "Your account has been deactivated and the deletion request is recorded." };
    });
    res.status(result.replayed ? 200 : 202).json(result.value);
  }));

  return router;
}
