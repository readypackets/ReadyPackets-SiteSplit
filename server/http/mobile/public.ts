/**
 * Native public-information boundary.
 *
 * These routes reuse only published Portal content and do not expose customer,
 * staff, administrative, storage, or session data. Account creation, email
 * verification, password recovery and identity assurance intentionally open the
 * verified Portal in the platform system browser.
 */
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { TRPCError } from "@trpc/server";
import { env } from "../../config/env.js";
import { appRouter } from "../../routers/index.js";

function clientIp(res: Response): string {
  return (res.locals.clientIp as string | undefined) ?? "";
}

function problem(res: Response, status: number, code: string, title: string, detail?: string): void {
  res.status(status).type("application/problem+json").json({
    type: `https://readypackets.com/problems/${code}`,
    title, status, code, detail,
    correlationId: crypto.randomUUID(),
  });
}

function withPublicError(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try { await handler(req, res); }
    catch (error) {
      if (res.headersSent) return;
      if (error instanceof TRPCError) {
        const status = error.code === "NOT_FOUND" ? 404 : error.code === "TOO_MANY_REQUESTS" ? 429 : 400;
        problem(res, status, error.code.toLowerCase(), "Public request rejected", error.message);
        return;
      }
      problem(res, 500, "internal_error", "Unable to complete the public request");
    }
  };
}

function publicCaller(req: Request, res: Response) {
  return appRouter.createCaller({
    req: req as never,
    res: res as never,
    session: null,
    clientIp: clientIp(res),
    userAgent: req.headers["user-agent"]?.slice(0, 255) ?? null,
  });
}

export function createMobilePublicRouter(): Router {
  const router = createRouter();

  router.get("/catalog", withPublicError(async (req, res) => {
    const caller = publicCaller(req, res);
    const [items, presentation] = await Promise.all([caller.public.catalog(), caller.public.catalogPresentation()]);
    res.setHeader("Cache-Control", "public, max-age=300").json({
      items,
      pricesVisible: presentation.pricingMode === "show",
      pricingMode: presentation.pricingMode,
      deliveryEstimatesVisible: presentation.publicDeliveryEstimatesVisible,
    });
  }));

  router.get("/faqs", withPublicError(async (req, res) => {
    const caller = publicCaller(req, res);
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    res.setHeader("Cache-Control", "public, max-age=300").json({ items: await caller.faqs.visible({ category }) });
  }));

  router.get("/policies", withPublicError(async (req, res) => {
    const caller = publicCaller(req, res);
    res.setHeader("Cache-Control", "public, max-age=300").json({ items: await caller.public.policyList() });
  }));

  router.get("/policies/:slug", withPublicError(async (req, res) => {
    const caller = publicCaller(req, res);
    res.setHeader("Cache-Control", "public, max-age=300").json(await caller.public.policy({ slug: req.params.slug as never }));
  }));

  router.get("/status", withPublicError(async (req, res) => {
    const caller = publicCaller(req, res);
    res.setHeader("Cache-Control", "public, max-age=60").json(await caller.public.siteStatus());
  }));

  router.post("/contact", withPublicError(async (req, res) => {
    const caller = publicCaller(req, res);
    // `website` is a mandatory empty honeypot field in the existing Portal flow.
    res.status(202).json(await caller.public.submitContact({
      name: req.body?.name, email: req.body?.email, company: req.body?.company,
      topic: req.body?.topic, message: req.body?.message,
      website: req.body?.website ?? "", acceptedPrivacy: req.body?.acceptedPrivacy === true,
    }));
  }));

  router.get("/browser-entrypoints", (_req, res) => {
    res.setHeader("Cache-Control", "no-store").json({
      registrationUrl: new URL("/register", env.appUrl).toString(),
      emailVerificationUrl: new URL("/verify-email", env.appUrl).toString(),
      passwordRecoveryUrl: new URL("/forgot-password", env.appUrl).toString(),
      customerSecurityUrl: new URL("/portal/account/security", env.appUrl).toString(),
      legalUrl: new URL("/policies", env.appUrl).toString(),
      contactUrl: new URL("/contact", env.appUrl).toString(),
    });
  });

  return router;
}
