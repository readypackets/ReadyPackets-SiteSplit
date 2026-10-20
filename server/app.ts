/**
 * Express application assembly.
 *
 * Middleware order is deliberate and load-bearing:
 *   1. proxy trust and client IP resolution, so every later decision uses the real address
 *   2. HTTPS redirect, before anything reads a cookie
 *   3. security headers with a fresh per-request CSP nonce
 *   4. IP blacklist, the cheapest possible rejection
 *   5. body and cookie parsing with hard size limits
 *   6. rate limiting, which needs the parsed path but not the session
 *   7. CSRF and Origin validation for state-changing requests
 *   8. maintenance gate
 *   9. routes
 *  10. 404 and the error handler, which never leaks internals
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import cookieParser from "cookie-parser";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { env } from "./config/env.js";
import { appRouter } from "./routers/index.js";
import { createContext } from "./trpc/context.js";
import { securityHeadersMiddleware, httpsRedirectMiddleware } from "./security/headers.js";
import {
  CSRF_COOKIE,
  csrfMiddleware,
  generateCsrfToken,
  isAllowedHostname,
  setCsrfCookie,
} from "./security/csrf.js";
import { rateLimitMiddleware } from "./security/rateLimit.js";
import { ipBlacklistMiddleware } from "./security/ipBlacklist.js";
import { resolveClientIp } from "./security/ipAddress.js";
import { createDownloadRouter } from "./http/downloads.js";
import { createInvoiceDownloadRouter } from "./http/invoiceDownloads.js";
import { singleRouteParam } from "./http/routeParam.js";
import { createUploadRouter } from "./http/uploads.js";
import { createPolicyImportRouter } from "./http/policyImports.js";
import { createConfigurationRestoreRouter } from "./http/configRestore.js";
import { createBackupRestoreRouter } from "./http/backupRestore.js";
import { getCookieConsent, savePublicCookieConsent } from "./http/cookieConsent.js";
import { createAvatarRouter } from "./http/avatar.js";
import { createMobileDiscoveryRouter, createMobileRouter } from "./http/mobile/index.js";
import { createSharePointDelegatedAuthRouter } from "./http/sharepointDelegatedAuth.js";
import { logger } from "./observability/logger.js";
import { getMaintenanceState } from "./services/settings.js";
import { handleStripeWebhook } from "./services/stripe.js";
import { clearSessionCookies, resolveSession } from "./auth/session.js";
import { getCatalog } from "./services/catalog.js";
import {
  handleAcs,
  handleLoginRedirect,
  handleLogout,
  handleMetadata,
} from "./auth/saml.js";
import { db, pingDatabase } from "./db/client.js";
import { marketingCampaigns } from "./db/schema.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the built client assets.
 *
 * The layout differs between running from source (`server/app.ts`, so the build
 * is at `../client/dist`) and running the bundled artefact (`dist/server.js`,
 * so the build is at `../client/dist` relative to `dist/`, i.e. a sibling of
 * the bundle's parent). An explicit override exists for unusual installs.
 * Resolving this once at startup avoids a per-request filesystem probe.
 */
function resolveClientDist(): string {
  const candidates = [
    process.env.CLIENT_DIST_PATH,
    path.resolve(here, "..", "client", "dist"),
    path.resolve(here, "client", "dist"),
    path.resolve(process.cwd(), "client", "dist"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  // Fall back to the conventional path so the error message names something real.
  return path.resolve(here, "..", "client", "dist");
}

const legacyClientDist = resolveClientDist();

/**
 * The marketing site and the authenticated portal are independently compiled
 * bundles. A legacy single-bundle install remains supported until PUBLIC_SITE_URL
 * is configured to a distinct hostname, which makes rollback a configuration
 * change rather than a source rollback.
 */
function resolveSplitClientDist(directory: "dist-public" | "dist-portal", fallback: string): string {
  const shell = directory === "dist-public" ? "public.html" : "portal.html";
  const candidates = [
    process.env[directory === "dist-public" ? "PUBLIC_CLIENT_DIST_PATH" : "PORTAL_CLIENT_DIST_PATH"],
    path.resolve(here, "..", "client", directory),
    path.resolve(here, "client", directory),
    path.resolve(process.cwd(), "client", directory),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(path.join(candidate, shell))) ?? fallback;
}

const publicClientDist = resolveSplitClientDist("dist-public", legacyClientDist);
const portalClientDist = resolveSplitClientDist("dist-portal", legacyClientDist);

function isPublicSurface(req: Request): boolean {
  return env.siteSplitEnabled && req.hostname === env.publicHostname;
}

function clientDistFor(req: Request): string {
  if (!env.siteSplitEnabled) return legacyClientDist;
  return isPublicSurface(req) ? publicClientDist : portalClientDist;
}

function clientShellFor(req: Request): string {
  if (!env.siteSplitEnabled) return "index.html";
  return isPublicSurface(req) ? "public.html" : "portal.html";
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[character] ?? character);
}

function pageMetadata(req: Request) {
  const websiteName = (process.env.SITE_NAME?.trim() || "ReadyPackets").slice(0, 100);
  const pages: Record<string, { title: string; description: string }> = {
    "/": { title: "ReadyPackets — Your Business, Professionally Packeted", description: "ReadyPackets turns an idea into a defensible, documented business package: invention architecture, business foundation, operating design, and a launch system." },
    "/packets": { title: "Business packets | ReadyPackets", description: "Explore ReadyPackets business packet groups, selected tiers, and the All-In bundle for a structured business foundation." },
    "/how-it-works": { title: "How ReadyPackets works", description: "Understand the ReadyPackets process, from selecting a business packet to intake, collaboration, and completed materials." },
    "/about": { title: "About ReadyPackets", description: "Learn about ReadyPackets and its approach to creating clear, structured business documentation and operating foundations." },
    "/reviews": { title: "Client reviews | ReadyPackets", description: "Read client feedback about the ReadyPackets business documentation and strategy experience." },
    "/community": { title: "ReadyPackets community", description: "Explore the ReadyPackets community and resources for founders building durable business foundations." },
    "/contact": { title: "Contact ReadyPackets", description: "Contact ReadyPackets for questions about business packets, orders, or customer support." },
    "/faq": { title: "Frequently asked questions | ReadyPackets", description: "Find clear answers about ReadyPackets, business packets, orders, accounts, collaboration, and payment." },
    "/accessibility": { title: "Accessibility | ReadyPackets", description: "Learn about ReadyPackets’ accessibility approach, keyboard support, and how to report an accessibility barrier." },
  };
  const pathName = req.path;
  const publicPath = isPublicSurface(req) && (Boolean(pages[pathName]) || pathName.startsWith("/packets/") || pathName.startsWith("/legal/") || ["/privacy", "/terms", "/refunds", "/disclaimer", "/changelog"].includes(pathName));
  const page = pages[pathName] ?? (pathName.startsWith("/packets/") ? { title: "Business packet | ReadyPackets", description: "Review a ReadyPackets business packet group and its available service tiers." } : { title: "ReadyPackets", description: "ReadyPackets provides structured business documentation and strategy support." });
  return {
    title: page.title.replaceAll("ReadyPackets", websiteName),
    description: page.description.replaceAll("ReadyPackets", websiteName),
    canonical: new URL(pathName, isPublicSurface(req) ? env.publicSiteUrl : env.appUrl).toString(),
    robots: publicPath ? "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" : "noindex, nofollow",
  };
}

/**
 * Serve index.html with the request's CSP nonce injected.
 *
 * The built HTML carries a `__CSP_NONCE__` placeholder on each script and style
 * tag. Substituting it per request is what allows a strict policy with no
 * `unsafe-inline` while still shipping a normal Vite bundle.
 */
async function serveIndex(req: Request, res: Response): Promise<void> {
  try {
    // Anonymous visitors need a CSRF token before they can register, reset a
    // password, or send a contact message. Issuing it with the shell keeps the
    // double-submit check available on the very first mutation, and an existing
    // token is never overwritten because a signed-in session is bound to it.
    if (!req.cookies?.[CSRF_COOKIE]) {
      setCsrfCookie(res, generateCsrfToken());
    }

    const nonce = (res.locals.cspNonce as string | undefined) ?? "";
    const metadata = pageMetadata(req);
    const html = await readFile(path.join(clientDistFor(req), clientShellFor(req)), "utf8");
    const rendered = html
      .replaceAll("__CSP_NONCE__", nonce)
      .replaceAll("__PAGE_TITLE__", escapeXml(metadata.title))
      .replaceAll("__PAGE_DESCRIPTION__", escapeXml(metadata.description))
      .replaceAll("__PAGE_ROBOTS__", metadata.robots)
      .replaceAll("__CANONICAL_URL__", escapeXml(metadata.canonical))
      .replaceAll("__PORTAL_ORIGIN__", escapeXml(env.appUrl));
    res
      .status(200)
      .type("text/html; charset=utf-8")
      .setHeader("Cache-Control", "no-store, must-revalidate")
      .send(rendered);
  } catch (error) {
    logger.error("Failed to serve index.html", { error });
    res
      .status(503)
      .type("text/plain")
      .send("The application build is missing. Run the build step and restart the service.");
  }
}

export function createApp(): Express {
  const app = express();

  // Never advertise the framework.
  app.disable("x-powered-by");
  app.set("etag", false);

  // Trust only the configured number of proxy hops; an unbounded trust would let
  // a client forge X-Forwarded-For and defeat rate limiting and blocklists.
  if (env.trustProxyHops > 0) {
    app.set("trust proxy", env.trustProxyHops);
  } else {
    app.set("trust proxy", false);
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.clientIp = resolveClientIp(req);
    res.locals.requestStart = Date.now();
    next();
  });

  app.use(httpsRedirectMiddleware());

  // Reject a request whose Host header is not one we serve, which blocks
  // host-header poisoning and cache-key confusion.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hostname = req.hostname || null;
    if (!isAllowedHostname(hostname)) {
      res.status(421).type("text/plain").send("Misdirected request");
      return;
    }
    next();
  });

  // Keep old bookmarks useful while keeping the anonymous and authenticated
  // experiences on their intended hosts. Only browser routes cross surfaces;
  // API routes remain same-origin and are never redirected.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!env.siteSplitEnabled || req.path.startsWith("/api/")) return next();
    const portalPath = /^(?:\/login|\/register|\/verify-email|\/forgot-password|\/reset-password|\/portal(?:\/|$)|\/admin(?:\/|$))/.test(req.path);
    const publicPath = /^(?:\/$|\/packets(?:\/|$)|\/how-it-works$|\/about$|\/reviews$|\/community$|\/changelog$|\/contact$|\/faq$|\/accessibility$|\/privacy$|\/terms$|\/refunds$|\/disclaimer$|\/legal(?:\/|$)|\/sitemap\.xml$|\/robots\.txt$)/.test(req.path);
    if (!isPublicSurface(req) && req.path === "/") {
      res.redirect(302, new URL("/login", env.appUrl).toString());
      return;
    }
    if (isPublicSurface(req) && portalPath) {
      res.redirect(302, new URL(`${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`, env.appUrl).toString());
      return;
    }
    if (!isPublicSurface(req) && publicPath) {
      res.redirect(302, new URL(`${req.path}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`, env.publicSiteUrl).toString());
      return;
    }
    next();
  });

  app.use(securityHeadersMiddleware());
  app.use(ipBlacklistMiddleware());

  // Health probes must stay cheap and must not require a session, but they also
  // must not disclose anything useful to an unauthenticated caller.
  app.use(createMobileDiscoveryRouter());

  app.get("/api/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/health/ready", async (_req: Request, res: Response) => {
    const databaseOk = await pingDatabase();
    res.status(databaseOk ? 200 : 503).json({ status: databaseOk ? "ready" : "degraded" });
  });

  // Stripe webhook: must receive the raw body before JSON parsing so the
  // signature can be verified. Registered here, before express.json().
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json", limit: "512kb" }),
    async (req: Request, res: Response) => {
      const sig = req.headers["stripe-signature"];
      if (!sig || typeof sig !== "string") {
        res.status(400).json({ error: "Missing Stripe-Signature header" });
        return;
      }
      try {
        const result = await handleStripeWebhook(req.body as Buffer, sig);
        res.json({ received: true, ...result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Webhook error";
        logger.warn("stripe.webhook.error", { error: msg });
        res.status(400).json({ error: msg });
      }
    }
  );

  app.use(
    express.json({
      limit: "256kb",
      // Reject a body that is not valid JSON before it reaches a handler.
      strict: true,
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(cookieParser());

  app.use(rateLimitMiddleware());
  app.use(csrfMiddleware());

  // Maintenance mode: the API and the site are closed to everyone except an
  // administrator, who must still be able to sign in to turn it off again.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/health")) return next();
    const state = await getMaintenanceState();
    if (!state.enabled) return next();

        const isAdminPath =
      req.path.startsWith("/api/trpc/auth.") ||
      req.path.startsWith("/api/trpc/adminSecurity.") ||
      req.path === "/login" ||
      req.path.startsWith("/admin");
    if (isAdminPath) return next();

    // The administrator shell at /admin is intentionally available in maintenance
    // mode, but its tRPC calls must be available too. Only a fully authenticated,
    // unrestricted administrator is exempted; all customer/staff sessions and all
    // anonymous API requests continue to receive the maintenance response.
    const maintenanceSession = await resolveSession(req);
    const isActiveAdministrator =
      maintenanceSession?.user.role === "admin" &&
      !maintenanceSession.mfaPending &&
      !maintenanceSession.restricted &&
      maintenanceSession.user.status === "active";
    if (isActiveAdministrator) return next();


    if (req.path.startsWith("/api/")) {
      res.status(503).json({
        error: state.message,
        maintenance: true,
        estimatedCompletion: state.estimatedCompletion,
      });
      return;
    }

    // Static assets still load so the maintenance page can render correctly.
    if (/\.[a-z0-9]{2,6}$/i.test(req.path)) return next();
    res.status(503);
    await serveIndex(req, res);
  });

  // SAML SSO routes. These use form-encoded POST bodies (ACS) and plain GET
  // (metadata, login, logout), so they must be registered before the tRPC
  // handler and after the body parser.
  app.get("/api/saml/metadata", handleMetadata);
  app.get("/api/saml/login", handleLoginRedirect);
  app.post("/api/saml/acs", express.urlencoded({ extended: false }), handleAcs);
  app.get("/api/saml/logout", handleLogout);
  app.use("/api/integrations/sharepoint", createSharePointDelegatedAuthRouter());
  // Native OAuth/bearer routes use their own PKCE/token controls and never accept browser cookies as credentials.
  app.use("/api/mobile/v1", createMobileRouter());

  /**
   * Return a same-origin CSRF cookie without accepting any caller-supplied token.
   * Every valid session, including one awaiting MFA or restricted to MFA
   * enrolment, receives its own session-bound secret. Otherwise the route clears
   * an expired/revoked session cookie and issues a fresh anonymous double-submit
   * token so a stale tab can submit a new login without a hard refresh. Every
   * unsafe request remains subject to Origin and CSRF validation; the anonymous
   * token grants no authenticated capability.
   */
  app.get("/api/privacy/consent", getCookieConsent);
  app.post("/api/privacy/consent", savePublicCookieConsent);

  app.get("/api/security/csrf", async (req: Request, res: Response) => {
    const session = await resolveSession(req);
    const csrfToken = session ? session.csrfSecret : generateCsrfToken();

    if (!session) {
      // A stale session cookie can outlive a server-side idle timeout or
      // revocation. Clear it before issuing the anonymous login token. Valid
      // pending-MFA sessions must never be cleared here.
      clearSessionCookies(res);
    }

    setCsrfCookie(res, csrfToken);
    res.status(200).setHeader("Cache-Control", "no-store").json({ csrfToken });
  });

  app.use("/api/files", createDownloadRouter());
  app.use("/api/files", createUploadRouter());
  app.use("/api/policies", createPolicyImportRouter());
  app.use("/api/configuration-restore", createConfigurationRestoreRouter());
  app.use("/api/backup-restore", createBackupRestoreRouter());
  app.use("/api/invoices", createInvoiceDownloadRouter());
  app.use("/api/avatar", createAvatarRouter());

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      onError({ error, path: procedurePath, type }) {
        // Client-caused errors are expected and stay at info level; anything else
        // is a real fault and must be visible in the log.
        if (error.code === "INTERNAL_SERVER_ERROR") {
          logger.error("tRPC procedure failed", {
            procedure: procedurePath,
            type,
            error: error.cause ?? error,
          });
        } else {
          logger.debug("tRPC procedure rejected", {
            procedure: procedurePath,
            code: error.code,
          });
        }
      },
    }),
  );

  // Any other /api path is a client mistake, and must not fall through to the SPA.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // Campaign redirect links track aggregate promotion clicks without logging IP,
  // session, user-agent, or other visitor-identifying data. Campaign destinations
  // are validated on write; an inactive or expired campaign never redirects.
  app.get("/go/:publicKey", async (req: Request, res: Response) => {
    const publicKey = singleRouteParam(req.params.publicKey);
    if (!publicKey) {
      res.status(404).type("text/plain").send("Campaign link is unavailable.");
      return;
    }
    const [campaign] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.publicKey, publicKey)).limit(1);
    const now = new Date();
    if (!campaign || campaign.status !== "active" || (campaign.startsAt && campaign.startsAt > now) || (campaign.endsAt && campaign.endsAt <= now)) {
      res.status(404).type("text/plain").send("Campaign link is unavailable.");
      return;
    }
    const destination = new URL(campaign.destinationUrl, `https://${req.hostname}`);
    if (campaign.utmSource) destination.searchParams.set("utm_source", campaign.utmSource);
    if (campaign.utmMedium) destination.searchParams.set("utm_medium", campaign.utmMedium);
    if (campaign.utmCampaign) destination.searchParams.set("utm_campaign", campaign.utmCampaign);
    if (campaign.utmContent) destination.searchParams.set("utm_content", campaign.utmContent);
    await db.update(marketingCampaigns).set({ clickCount: sql`${marketingCampaigns.clickCount} + 1` }).where(eq(marketingCampaigns.id, campaign.id));
    res.setHeader("Cache-Control", "no-store").redirect(302, destination.toString());
  });

  // Public crawl inventory. Keep portal, administration, API, authentication, and
  // unlisted catalogue resources out of the sitemap; robots.txt reinforces this.
  app.get("/sitemap.xml", async (req: Request, res: Response) => {
    const origin = `https://${req.hostname}`;
    const staticPaths = ["/", "/packets", "/how-it-works", "/about", "/reviews", "/community", "/changelog", "/contact", "/faq", "/accessibility", "/privacy", "/terms", "/refunds", "/disclaimer"];
    const catalog = await getCatalog();
    const urls = [...staticPaths, ...catalog.map((group) => `/packets/${group.slug}`)];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${escapeXml(new URL(url, origin).toString())}</loc></url>`).join("\n")}\n</urlset>\n`;
    res.type("application/xml").setHeader("Cache-Control", "no-cache").send(body);
  });

  // Never serve a compiled HTML shell as a static file: it contains the nonce
  // placeholder and must pass through serveIndex for a fresh CSP nonce.
  app.get(["/index.html", "/public.html", "/portal.html"], (_req: Request, res: Response) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // Static assets. Each hostname reads only its own build directory. Hashed
  // files are immutable; non-hashed assets are revalidated.
  const staticOptions = {
    index: false,
    dotfiles: "ignore",
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res: Response, filePath: string) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (/\.[0-9a-f]{8,}\.(js|css|woff2?|png|svg|jpg|webp)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/\.(png|svg|jpg|jpeg|webp|ico|woff2?)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  };
  const legacyStatic = express.static(legacyClientDist, staticOptions);
  const publicStatic = express.static(publicClientDist, staticOptions);
  const portalStatic = express.static(portalClientDist, staticOptions);
  app.use((req: Request, res: Response, next: NextFunction) => {
    // A native install builds all three client directories. In legacy one-host
    // mode the shell comes from `legacyClientDist`; serving `/assets` from the
    // otherwise-present split portal directory creates an HTML-to-asset hash
    // mismatch and a blank browser page. Keep the static directory and shell
    // selection coupled until a distinct public hostname enables split mode.
    if (!env.siteSplitEnabled) {
      legacyStatic(req, res, next);
      return;
    }
    (isPublicSurface(req) ? publicStatic : portalStatic)(req, res, next);
  });

  // SPA fallback for GET only; a POST to an unknown path is an error, not a page.
  // Express 5's path-to-regexp rejects the legacy anonymous "*" wildcard at
  // application construction time. The named brace form includes the root path
  // as well as nested client-side routes without exposing a route parameter to
  // application logic.
  app.get("/{*splat}", async (req: Request, res: Response) => {
    if (/\.[a-z0-9]{2,6}$/i.test(req.path)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    await serveIndex(req, res);
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // Final error handler. The client is told nothing beyond a correlation id.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const correlationId = Math.random().toString(36).slice(2, 12);
    logger.error("Unhandled request error", {
      correlationId,
      method: req.method,
      path: req.path,
      error,
    });

    if (res.headersSent) {
      res.destroy();
      return;
    }

    // A malformed JSON body is the caller's fault and deserves a 400.
    const isBodyError =
      error instanceof SyntaxError && "body" in (error as unknown as Record<string, unknown>);

    res
      .status(isBodyError ? 400 : 500)
      .json({
        error: isBodyError ? "Malformed request body." : "An unexpected error occurred.",
        correlationId,
      });
  });

  return app;
}
