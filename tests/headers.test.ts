/**
 * Security response header behaviour.
 *
 * These tests pin two properties that were only observable once the application
 * was deployed behind a real reverse proxy over HTTPS.
 *
 * The first is HSTS duplication. Both nginx and the application asserted
 * Strict-Transport-Security, so every response on the live site carried two
 * identical copies. Browsers do not agree on how to handle duplicate HSTS
 * headers, and an ambiguous security header is a poor kind of security header.
 * The rule is now: the application asserts it only when nothing is in front of
 * it, detected by the absence of X-Forwarded-Proto.
 *
 * The second is that the CSP must never acquire an unsafe source. That is
 * asserted by the live suite too, but pinning it here means a regression fails
 * the build rather than waiting for a deployment.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Request, Response } from "express";
import { securityHeadersMiddleware } from "../server/security/headers.js";

/** Minimal Express request/response doubles that record what was set. */
function runMiddleware(headers: Record<string, string> = {}): {
  set: Record<string, string>;
  removed: string[];
  locals: Record<string, unknown>;
} {
  const set: Record<string, string> = {};
  const removed: string[] = [];
  const locals: Record<string, unknown> = {};

  const req = { headers, path: "/", method: "GET" } as unknown as Request;
  const res = {
    locals,
    setHeader(name: string, value: string) {
      set[name] = value;
    },
    removeHeader(name: string) {
      removed.push(name);
    },
  } as unknown as Response;

  securityHeadersMiddleware()(req, res, () => undefined);
  return { set, removed, locals };
}

describe("security headers", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  it("generates a fresh nonce per request", () => {
    const first = runMiddleware();
    const second = runMiddleware();
    expect(first.locals.cspNonce).toBeTypeOf("string");
    expect(String(first.locals.cspNonce).length).toBeGreaterThan(16);
    expect(first.locals.cspNonce).not.toBe(second.locals.cspNonce);
  });

  it("exposes the nonce to the CSP and the template through the same value", () => {
    const { set, locals } = runMiddleware();
    expect(set["Content-Security-Policy"]).toContain(`'nonce-${locals.cspNonce}'`);
  });

  it("never permits unsafe-inline or unsafe-eval in any directive", () => {
    const csp = runMiddleware().set["Content-Security-Policy"] ?? "";
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("locks down framing, object-src and base-uri", () => {
    const csp = runMiddleware().set["Content-Security-Policy"] ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("permits only documented consent-gated analytics endpoints in addition to nonce protection", () => {
    const csp = runMiddleware().set["Content-Security-Policy"] ?? "";
    expect(csp).toContain("https://www.clarity.ms");
    expect(csp).toContain("https://*.posthog.com");
    expect(csp).toContain("'strict-dynamic'");
  });

  it("allows microphone only for this origin while retaining capture restrictions", () => {
    const policy = runMiddleware().set["Permissions-Policy"] ?? "";
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("display-capture=()");
  });

  it("never advertises the server technology", () => {
    const { set, removed } = runMiddleware();
    expect(removed).toContain("X-Powered-By");
    expect(Object.keys(set).map((key) => key.toLowerCase())).not.toContain("server");
  });

  describe("HSTS is asserted exactly once", () => {
    beforeAll(() => {
      process.env.NODE_ENV = "production";
    });
    afterAll(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it("does not assert HSTS when a proxy is in front", () => {
      // The deployed nginx sets HSTS at the edge and forwards this header. The
      // application must not add a second copy.
      const { set } = runMiddleware({ "x-forwarded-proto": "https" });
      expect(set["Strict-Transport-Security"]).toBeUndefined();
    });
  });
});
