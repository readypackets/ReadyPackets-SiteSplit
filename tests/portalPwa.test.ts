import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const splitConfig = read("vite.split.config.ts");
const legacyConfig = read("vite.config.ts");
const worker = read("client/src/pwa/portal-service-worker.ts");
const portalEntry = read("client/src/portal.tsx");
const portalPrompts = read("client/src/components/PwaPrompts.tsx");
const portalHtml = read("client/portal.html");
const publicHtml = read("client/public.html");
const legacyHtml = read("client/index.html");
const manifest = read("client/public/manifest.webmanifest");
const session = read("client/src/lib/session.tsx");
const pwaRuntime = read("client/src/lib/portalPwa.ts");
const app = read("server/app.ts");
const offlinePage = read("client/public/offline.html");
const offlineStyle = read("client/public/offline.css");
const verifier = read("scripts/verify-pwa-build.mjs");

describe("Portal PWA privacy and cache boundary", () => {
  it("builds an injected-manifest worker only for the dedicated Portal bundle", () => {
    expect(splitConfig).toContain('const isPortalBuild = outDir === "dist-portal"');
    expect(splitConfig).toContain("VitePWA({");
    expect(splitConfig).toContain('strategies: "injectManifest"');
    expect(splitConfig).toContain('injectRegister: false');
    expect(splitConfig).toContain("manifest: false");
    expect(splitConfig).toContain('filename: "portal-service-worker.ts"');
    expect(splitConfig).toContain('...(isPortalBuild ? [portalPwaPlugin(outDir)] : [removePortalPwaArtifacts(outDir)])');
    expect(splitConfig).toContain('"manifest.webmanifest", "offline.html", "offline.css", "portal-service-worker.js", "portal-service-worker.mjs"');
    expect(legacyConfig).toContain("removePortalPwaArtifacts()");
  });

  it("precaches only static code and generic offline assets", () => {
    expect(splitConfig).toContain('"assets/**/*.{js,css,woff2,png,svg,ico,webp}"');
    expect(splitConfig).toContain('"brand/**/*.{png,svg}"');
    expect(splitConfig).toContain('"fonts/**/*.woff2"');
    expect(splitConfig).toContain('"offline.html"');
    expect(splitConfig).toContain('"offline.css"');
    expect(splitConfig).not.toContain('"**/*.{html');
    expect(worker).toContain("precacheAndRoute(self.__WB_MANIFEST");
    expect(worker).toContain("new NetworkOnly()");
    expect(worker).toContain("setDefaultHandler(networkOnly)");
    expect(worker).toContain('request.url.includes("/api/")');
    for (const forbidden of ["CacheFirst", "NetworkFirst", "StaleWhileRevalidate", "BackgroundSyncPlugin", "periodicsync"]) {
      expect(worker).not.toContain(forbidden);
    }
    expect(worker).not.toContain('addEventListener("push"');
  });

  it("offers a generic offline fallback only for anonymous entry routes", () => {
    expect(worker).toContain('const OFFLINE_PAGE_URL = "/offline.html"');
    expect(worker).toContain('path === "/"');
    for (const anonymousPath of ["/login", "/register", "/verify-email", "/forgot-password", "/reset-password"]) {
      expect(worker).toContain(`"${anonymousPath}"`);
    }
    expect(worker).toContain("return (await caches.match(OFFLINE_PAGE_URL)) ?? Response.error()");
    expect(worker).toContain("return Response.error()");
    expect(worker).not.toContain('return caches.match("/portal');
  });

  it("keeps installability and worker registration exclusive to the Portal surface", () => {
    expect(portalHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(portalEntry).toContain("<PwaInstallPrompt />");
    expect(portalEntry).toContain("<PwaUpdatePrompt />");
    expect(portalPrompts).toContain('PORTAL_SERVICE_WORKER_URL');
    expect(portalPrompts).toContain('updateViaCache: "none"');
    expect(publicHtml).not.toContain("manifest.webmanifest");
    expect(legacyHtml).not.toContain("manifest.webmanifest");
  });

  it("uses safe Portal metadata and a maskable-safe approved icon", () => {
    expect(manifest).toContain('"name": "ReadyPackets Portal"');
    expect(manifest).toContain('"start_url": "/login"');
    expect(manifest).toContain('"purpose": "maskable"');
    expect(manifest).toContain("readypackets-approved-icon-light-192.png");
    expect(manifest).toContain("readypackets-approved-icon-maskable-512.png");
  });

  it("clears account-adjacent browser and query state after logout or session loss", () => {
    expect(pwaRuntime).toContain("clearPortalClientRuntimeState");
    expect(pwaRuntime).toContain('PORTAL_STORAGE_PREFIX = "readypackets."');
    expect(pwaRuntime).toContain("CLEAR_PORTAL_RUNTIME_STATE");
    expect(session).toContain("void clearPortalClientRuntimeState()");
    expect(session).toContain("sessionExpiresAt");
    expect(session).toContain("refetchInterval: 5 * 60_000");
    expect(portalEntry).toContain("client.clear()");
    expect(portalEntry).toContain("PortalSessionPrivacyBoundary");
    expect(portalEntry).toContain("SESSION_INVALID_EVENT");
  });

  it("keeps updates user-controlled across tabs and the offline fallback CSP-compatible", () => {
    expect(portalPrompts).toContain("PWA_UPDATE_REQUESTED_KEY");
    expect(portalPrompts).toContain("setUpdateReady(true)");
    expect(portalPrompts).toContain("Another tab may already have activated the worker");
    expect(portalPrompts).toContain("window.location.reload()");
    expect(offlinePage).toContain('rel="stylesheet" href="/offline.css"');
    expect(offlinePage).not.toContain("<style>");
    expect(offlinePage).not.toContain("onclick=");
    expect(offlinePage).toContain('href="/login"');
    expect(offlineStyle).toContain(".retry");
  });

  it("verifies fresh emitted Portal PWA artifacts and rejects non-Portal leakage", () => {
    expect(verifier).toContain("readypackets-approved-icon-light-192.png");
    expect(verifier).toContain("allowedPrecache");
    expect(verifier).toContain("dist-public");
    expect(verifier).toContain("must not contain Portal-only");
  });

  it("makes application APIs and the controlling worker non-storable at the server boundary", () => {
    expect(app).toContain('app.use("/api"');
    expect(app).toContain('"no-store, max-age=0, must-revalidate"');
    expect(app).toContain('app.use("/portal-service-worker.js"');
    expect(app).toContain('"Service-Worker-Allowed", "/"');
  });
});
