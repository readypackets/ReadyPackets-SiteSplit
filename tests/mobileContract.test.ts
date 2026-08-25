import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("native mobile contract safeguards", () => {
  it("publishes an OAuth 2.1 PKCE mobile boundary without exposing web tRPC", async () => {
    const [contract, router, oidc] = await Promise.all([
      text("server/http/mobile/openapi.yaml"),
      text("server/http/mobile/index.ts"),
      text("server/auth/mobileOidc.ts"),
    ]);
    expect(contract).toContain("/authorize:");
    expect(contract).toContain("code_challenge_method");
    expect(contract).toContain("S256");
    expect(router).toContain('router.post("/token"');
    expect(router).not.toContain("/api/trpc");
    expect(oidc).toContain("createHash(\"sha256\")");
    expect(oidc).toContain("refresh_token_reuse_or_expiry");
  });

  it("uses purpose-built mobile order DTOs rather than raw internal order records", async () => {
    const router = await text("server/http/mobile/index.ts");
    expect(router).toContain("assertOrderAccess(summary.id");
    expect(router).not.toMatch(/import\s*\{[^}]*getOrderDetail/);
    expect(router).not.toMatch(/getOrderDetail\(summary\./);
    expect(router).toContain("publicOrderId");
    expect(router).toContain("currentStage");
  });

  it("creates mobile orders from listed SKUs with Portal-authoritative pricing and idempotency", async () => {
    const router = await text("server/http/mobile/index.ts");
    expect(router).toContain('router.get("/catalog"');
    expect(router).toContain('router.post("/orders"');
    expect(router).toContain('runIdempotent(req, "POST /orders"');
    expect(router).toContain("requireScope(req, \"mobile:write\")");
    expect(router).toContain("resolveListedProducts(selections)");
    expect(router).toContain("createOrder({");
    expect(router).toContain("productBySku.get(selection.sku)!.id");
    expect(router).not.toContain("req.body?.priceCents");
    expect(router).not.toContain("req.body?.paymentStatus");
  });

  it("keeps browser CSRF protection and exempts only the bearer/code mobile prefix", async () => {
    const csrf = await text("server/security/csrf.ts");
    expect(csrf).toContain('"/api/mobile/"');
    expect(csrf).toContain("CSRF_HEADER");
    expect(csrf).toContain("isAllowedHostname");
  });

  it("requires a bearer mobile principal and does not fall back to browser session authority", async () => {
    const [router, oidc] = await Promise.all([
      text("server/http/mobile/index.ts"),
      text("server/auth/mobileOidc.ts"),
    ]);
    expect(router).toContain('router.use(bearer)');
    expect(router).toContain('header?.startsWith("Bearer ")');
    expect(router).toContain('requireScope(req, "mobile:write")');
    expect(router.slice(router.indexOf("router.use(bearer)"))).not.toContain("resolveSession(req)");
    expect(oidc).not.toContain("ASWebAuthenticationSession");
    expect(oidc).toContain("codeChallenge");
    expect(oidc).toContain("mobile:write");
  });
});
