/**
 * CSRF defence: origin validation plus a session-bound double-submit token.
 *
 * `SameSite=Strict` is treated as a supplement, not a control. Every unsafe
 * request must satisfy three independent checks:
 *   1. the Origin (or Referer) hostname matches a configured hostname,
 *   2. an `X-RP-CSRF` header is present,
 *   3. the header value matches both the CSRF cookie and the secret recorded on
 *      the session row, compared in constant time.
 *
 * Hostname comparison is used rather than full-URL equality so that a
 * Cloudflare or load-balancer deployment does not break on port or scheme
 * differences.
 */
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { recordSecurityEvent } from "../observability/audit.js";
import { constantTimeEqual, randomToken } from "./crypto.js";

export const CSRF_HEADER = "x-rp-csrf";
export const CSRF_COOKIE = `${env.cookiePrefix}rp_csrf`;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths that authenticate by signature/code/bearer token rather than by browser cookie. */
const EXEMPT_PREFIXES = [
  "/api/stripe/webhook",
  "/api/saml/acs",
  "/api/inbound/",
  ...(env.mobile.enabled ? ["/api/mobile/"] : []),
];

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export function isAllowedHostname(hostname: string | null): boolean {
  if (!hostname) return false;
  return env.allowedHostnames.includes(hostname);
}

/** Issue a CSRF cookie readable by the client script for the double submit. */
export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.isProduction,
    sameSite: "strict",
    path: "/",
    maxAge: env.sessionTtlMinutes * 60 * 1000,
  });
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: env.isProduction,
    sameSite: "strict",
    path: "/",
  });
}

export function generateCsrfToken(): string {
  return randomToken(32);
}

/**
 * CSRF checks run before the tRPC adapter. A plain Express JSON response is not
 * parseable by the tRPC client, which previously obscured an expired browser
 * token as “Unable to transform response from server.” Preserve the normal
 * response shape for tRPC requests so callers receive an actionable message.
 */
function rejectRequest(req: Request, res: Response, message: string): void {
  if (!req.path.startsWith("/api/trpc/")) {
    res.status(403).json({ error: message });
    return;
  }
  const path = req.path.slice("/api/trpc/".length);
  // tRPC's HTTP client expects the serialized error shape under `error.json`.
  // A plain Express-like error object causes its transformer to fail before the
  // caller can see an actionable CSRF message.
  const error = {
    error: {
      json: {
        message,
        code: -32003,
        data: { code: "FORBIDDEN", httpStatus: 403, path, validation: null, stack: undefined },
      },
    },
  };
  // A mutation is normally one operation, but preserve the batch response
  // cardinality when the client supplied multiple calls in one request.
  let count = 1;
  if (req.query.batch === "1" && typeof req.query.input === "string") {
    try {
      const parsed = JSON.parse(req.query.input) as Record<string, unknown>;
      count = Math.max(1, Object.keys(parsed).length);
    } catch {
      // Invalid input is handled by tRPC after an otherwise valid CSRF check.
    }
  }
  res.status(403).json(Array.from({ length: count }, () => error));
}

export function csrfMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    if (EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      next();
      return;
    }

    const originHeader = req.headers.origin;
    const refererHeader = req.headers.referer;
    const originHostname =
      hostnameOf(typeof originHeader === "string" ? originHeader : undefined) ??
      hostnameOf(typeof refererHeader === "string" ? refererHeader : undefined);

    if (!isAllowedHostname(originHostname)) {
      void recordSecurityEvent({
        eventType: "origin.rejected",
        outcome: "blocked",
        severity: "warning",
        message: `Rejected cross-origin ${req.method} to ${req.path}`,
        ipAddress: (res.locals.clientIp as string | undefined) ?? null,
        userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
        metadata: { origin: originHostname ?? "missing", path: req.path },
      });
      rejectRequest(req, res, "Cross-origin request rejected.");
      return;
    }

    const headerValue = req.headers[CSRF_HEADER];
    const headerToken = typeof headerValue === "string" ? headerValue : "";
    const cookieToken = (req.cookies?.[CSRF_COOKIE] as string | undefined) ?? "";
    const sessionSecret = (res.locals.csrfSecret as string | undefined) ?? "";

    const cookieMatches = headerToken !== "" && constantTimeEqual(headerToken, cookieToken);
    // Anonymous requests have no session secret; the double submit alone applies.
    const sessionMatches =
      sessionSecret === "" || constantTimeEqual(headerToken, sessionSecret);

    if (!cookieMatches || !sessionMatches) {
      void recordSecurityEvent({
        eventType: "csrf.rejected",
        outcome: "blocked",
        severity: "warning",
        message: `Rejected ${req.method} to ${req.path} with invalid CSRF token`,
        userId: (res.locals.userId as number | undefined) ?? null,
        ipAddress: (res.locals.clientIp as string | undefined) ?? null,
        metadata: {
          hasHeader: headerToken !== "",
          hasCookie: cookieToken !== "",
          sessionBound: sessionSecret !== "",
        },
      });
      rejectRequest(req, res, "Your security token expired. Reload the page and try again.");
      return;
    }

    next();
  };
}
