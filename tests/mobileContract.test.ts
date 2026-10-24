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
    const [contract, router] = await Promise.all([
      text("server/http/mobile/openapi.yaml"),
      text("server/http/mobile/index.ts"),
    ]);
    expect(router).toContain('router.get("/catalog"');
    expect(router).toContain('router.post("/orders"');
    expect(router).toContain('runIdempotent(req, "POST /orders"');
    expect(router).toContain("requireScope(req, \"mobile:write\")");
    expect(router).toContain("resolveListedProducts(selections)");
    expect(router).toContain("createOrder({");
    expect(router).toContain("Enter an order or project name before placing an order.");
    expect(router).toContain("projectName,");
    expect(router).toContain("productBySku.get(selection.sku)!.id");
    expect(router).not.toContain("req.body?.priceCents");
    expect(router).not.toContain("req.body?.paymentStatus");
    expect(contract).toContain("required: [projectName, selections]");
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

  it("keeps customer-parity routes allowlisted, server-authoritative, and separate from public content", async () => {
    const [customer, publicRouter, router] = await Promise.all([
      text("server/http/mobile/customer.ts"),
      text("server/http/mobile/public.ts"),
      text("server/http/mobile/index.ts"),
    ]);
    expect(router).toContain('router.use("/public", createMobilePublicRouter())');
    expect(router).toContain('router.use("/customer", createMobileCustomerRouter())');
    expect(customer).toContain('requireCustomer(req, "mobile:write")');
    expect(customer).toContain('runIdempotent(req, "POST /community/topics"');
    expect(customer).toContain('checkout-handoff');
    expect(customer).toContain('invoice/content');
    expect(customer).not.toContain("caller.admin.");
    expect(publicRouter).toContain('router.get("/catalog"');
    expect(publicRouter).toContain('router.post("/contact"');
    expect(publicRouter).not.toContain("mobile:write");
  });

  it("separates exact-origin secure Portal and public marketing browser handoffs", async () => {
    const [publicRouter, contract] = await Promise.all([
      text("server/http/mobile/public.ts"),
      text("server/http/mobile/openapi.yaml"),
    ]);
    expect(publicRouter).toContain("env.marketingSiteUrl");
    expect(publicRouter).toContain("publicSolutionsUrl");
    expect(publicRouter).toContain("customerSecurityUrl");
    expect(contract).toContain("BrowserEntrypoints:");
    expect(contract).toContain("publicContactUrl");
  });

  it("serves a configured Android App Link association without embedding signing secrets", async () => {
    const [app, env] = await Promise.all([
      text("server/app.ts"),
      text("server/config/env.ts"),
    ]);
    expect(app).toContain('app.get("/.well-known/assetlinks.json"');
    expect(app).toContain("delegate_permission/common.handle_all_urls");
    expect(app).toContain("sha256_cert_fingerprints");
    expect(env).toContain("ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS");
    expect(env).not.toContain("ANDROID_APP_LINK_PRIVATE_KEY");
  });

  it("gives the unsigned iOS simulator build an explicit non-empty application product name", async () => {
    const [manifest, project] = await Promise.all([
      text("mobile/ios/ReadyPackets/project.yml"),
      text("mobile/ios/ReadyPackets/ReadyPackets.xcodeproj/project.pbxproj"),
    ]);

    expect(manifest).toContain("PRODUCT_NAME: ReadyPackets");
    expect(manifest).toContain("excludes:\n          - Info.plist");
    expect(project.match(/PRODUCT_NAME = ReadyPackets;/g)).toHaveLength(2);
    expect(project).toContain("path = ReadyPackets.app;");
    expect(project).toContain("PBXFileSystemSynchronizedBuildFileExceptionSet");
    expect(project).toContain("membershipExceptions = (Info.plist,);");
  });

  it("keeps the Home tab in a conventional SwiftUI view declaration for simulator compilation", async () => {
    const homeView = await text("mobile/ios/ReadyPackets/ReadyPacketsApp/Features/HomeView.swift");

    expect(homeView).toMatch(/struct HomeView: View \{\s+@EnvironmentObject private var container: AppContainer/);
    expect(homeView).toContain("var body: some View {");
    expect(homeView).toContain("NavigationStack {");
    expect(homeView).toContain("private func load() async {");
    expect(homeView).not.toContain("NavigationStack { ScrollView { VStack");
  });

  it("keeps iOS browser authentication, request retries, Keychain reads, and biometric fallbacks compile-safe", async () => {
    const [auth, app, client, security] = await Promise.all([
      text("mobile/ios/ReadyPackets/ReadyPacketsApp/Core/AuthCoordinator.swift"),
      text("mobile/ios/ReadyPackets/ReadyPacketsApp/ReadyPacketsApp.swift"),
      text("mobile/ios/ReadyPackets/ReadyPacketsApp/Core/MobileAPIClient.swift"),
      text("mobile/ios/ReadyPackets/ReadyPacketsApp/Core/Security.swift"),
    ]);

    expect(auth).toContain("var onAuthorizationResult: ((Result<Void, Error>) -> Void)?");
    expect(auth).toContain("await self?.handleBrowserCallback(callback, sessionError: sessionError)");
    expect(auth).toContain("await clearPendingAuthorizationAttempt()");
    expect(app).toContain("coordinator.onAuthorizationResult");
    expect(client).toContain("var urlRequest = URLRequest");
    expect(client).toContain("session.data(for: urlRequest)");
    expect(client).not.toContain("var request = URLRequest(url: AppConfig.portalBaseURL.appending(path: \"/api/mobile/v1\" + path))");
    expect(security).toContain("kSecMatchLimit: kSecMatchLimitOne");
    expect(security).not.toContain("kSecAttrMatchLimit");
    expect(security).toContain("LAError(.biometryNotAvailable)");
  });

  it("keeps order and profile SwiftUI views compiler-safe and preserves their customer security cues", async () => {
    const [orders, profile] = await Promise.all([
      text("mobile/ios/ReadyPackets/ReadyPacketsApp/Features/OrdersView.swift"),
      text("mobile/ios/ReadyPackets/ReadyPacketsApp/Features/ProfileView.swift"),
    ]);

    expect(orders).toContain("struct OrdersView: View {");
    expect(orders).toContain("self.error = error.localizedDescription");
    expect(orders).toContain(".foregroundStyle(Brand.gold)");
    expect(orders).not.toContain("catch { error =");
    expect(profile).toContain("struct ProfileView: View {");
    expect(profile).toContain('Section("Account") {');
    expect(profile).toContain("profile.mfaEnabled ? Brand.teal : Brand.gold");
    expect(profile).not.toContain("Brand.warning");
  });
});
