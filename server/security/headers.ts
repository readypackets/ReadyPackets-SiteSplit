/**
 * Security response headers, including a nonce-based Content Security Policy.
 *
 * The policy contains no `unsafe-inline` and no `unsafe-eval` in any directive.
 * A fresh 128-bit nonce is generated per request and exposed on `res.locals` so
 * the HTML shell can stamp it onto the module script and stylesheet tags.
 */
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "ambient-light-sensor=()",
  "autoplay=()",
  "battery=()",
  "camera=()",
  "display-capture=()",
  "document-domain=()",
  "encrypted-media=()",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  // Business Pitch recording requires microphone access for same-origin portal pages only.
  "microphone=(self)",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=(self)",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

/**
 * Stripe requires script and frame access. Clarity and PostHog source lists are
 * present for an optional, consent-gated integration; allowing an origin in CSP
 * never loads it. The React provider does not inject either script or make an
 * outbound request until the browser has a recorded affirmative analytics
 * preference. Nonce + strict-dynamic still prevent an injected script from
 * exploiting these allowlists.
 */
function buildCsp(nonce: string, allowStripe: boolean): string {
  // 'strict-dynamic' propagates trust from the nonce to scripts loaded by
  // trusted scripts (i.e. React's dynamically-imported chunks). Without it,
  // only the initial script tag is trusted and React's event delegation breaks.
  // 'self' is kept for browsers that do not support strict-dynamic.
  const scriptSrc = ["'strict-dynamic'", `'nonce-${nonce}'`, "'self'", "https://www.clarity.ms", "https://*.posthog.com"];
  const frameSrc = ["'none'"];
  const connectSrc = ["'self'", "https://www.clarity.ms", "https://*.posthog.com"];
  if (allowStripe) {
    scriptSrc.push("https://js.stripe.com");
    frameSrc.length = 0;
    frameSrc.push("https://js.stripe.com", "https://hooks.stripe.com");
    connectSrc.push("https://api.stripe.com");
  }

  const directives: string[] = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `script-src-attr 'none'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSrc.join(" ")}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    `frame-src ${frameSrc.join(" ")}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ];

  if (env.isProduction) {
    directives.push("upgrade-insecure-requests");
    directives.push("block-all-mixed-content");
  }

  return directives.join("; ");
}

export function securityHeadersMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const nonce = randomBytes(16).toString("base64");
    res.locals.cspNonce = nonce;

    const allowStripe = env.stripe.enabled && req.path.startsWith("/checkout");

    res.setHeader("Content-Security-Policy", buildCsp(nonce, allowStripe));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Origin-Agent-Cluster", "?1");
    res.setHeader("X-DNS-Prefetch-Control", "off");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    // Deliberately no Server or X-Powered-By header.
    res.removeHeader("X-Powered-By");

    // HSTS must be asserted exactly once. The deployed nginx configuration sets it
    // at the edge, and a second copy from here produced two identical
    // Strict-Transport-Security headers on every response of the live site.
    // Browsers disagree on how to treat duplicates -- first wins, last wins, or
    // ignore both -- and ambiguity is not a property a security header should
    // have. So the application asserts it only when nothing in front of it has:
    // the absence of X-Forwarded-Proto means it is terminating TLS itself.
    if (env.isProduction && !req.headers["x-forwarded-proto"]) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
    }

    next();
  };
}

/**
 * Redirect plain HTTP to HTTPS in production. The redirect is suppressed when
 * the request arrived through Cloudflare, because the origin connection may
 * legitimately be HTTP and redirecting would create a loop.
 */
export function httpsRedirectMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!env.isProduction) {
      next();
      return;
    }
    if (req.headers["cf-connecting-ip"]) {
      next();
      return;
    }
    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto =
      typeof forwardedProto === "string" ? forwardedProto.split(",")[0]?.trim() : undefined;
    if (proto === "https" || req.secure) {
      next();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(403).type("text/plain").send("HTTPS required");
      return;
    }
    res.redirect(308, `${env.appUrl}${req.originalUrl}`);
  };
}
