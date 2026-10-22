import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { BRAND_ASSETS } from "../shared/brand.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const publicBrandDirectory = path.join(repositoryRoot, "client", "public", "brand");

function publicAssetPath(assetPath: string): string {
  expect(assetPath).toMatch(/^\/[a-zA-Z0-9._/-]+$/);
  return path.join(repositoryRoot, "client", "public", assetPath);
}

const approvedBrandAssets = [
  ...Object.values(BRAND_ASSETS.light),
  ...Object.values(BRAND_ASSETS.dark),
  BRAND_ASSETS.favicon,
  BRAND_ASSETS.pwaIcon,
];

const retiredBrandToken = /readypackets-(?:full-lockup-square|document-flow|mark-(?:light|dark))/;

describe("ReadyPackets approved updated brand package", () => {
  it("keeps every registered approved asset present and non-empty in the self-hosted public bundle", () => {
    for (const asset of approvedBrandAssets) {
      const resolved = publicAssetPath(asset);
      expect(existsSync(resolved), `${asset} must be present in client/public`).toBe(true);
      expect(statSync(resolved).size, `${asset} must be non-empty`).toBeGreaterThan(0);
    }
    expect(statSync(path.join(repositoryRoot, "client", "public", "favicon.ico")).size).toBeGreaterThan(0);
  });

  it("does not retain a retired logo family in the deployable Portal public directory", () => {
    const filenames = readdirSync(publicBrandDirectory);
    expect(filenames.some((filename) => retiredBrandToken.test(filename))).toBe(false);
  });

  it("uses approved icons for browser and PWA installation surfaces", () => {
    for (const file of ["client/index.html", "client/public.html", "client/portal.html"]) {
      const shell = readFileSync(path.join(repositoryRoot, file), "utf8");
      expect(shell).toContain(BRAND_ASSETS.favicon);
      expect(shell).toContain('href="/favicon.ico"');
      expect(shell).not.toMatch(retiredBrandToken);
    }

    const manifest = readFileSync(path.join(repositoryRoot, "client/public/manifest.webmanifest"), "utf8");
    expect(manifest).toContain(BRAND_ASSETS.pwaIcon);
    expect(manifest).not.toMatch(retiredBrandToken);
  });

  it("keeps Portal code, transactional branding, and metadata on the approved family only", () => {
    for (const file of [
      "shared/brand.ts",
      "client/src/App.tsx",
      "client/src/MarketingApp.tsx",
      "client/src/components/auth/LoginSlideshow.tsx",
      "client/src/components/layout/PublicHeader.tsx",
      "client/src/components/layout/PublicLayout.tsx",
      "client/src/components/layout/PortalLayout.tsx",
      "client/src/components/layout/AdminLayout.tsx",
      "client/src/pages/auth/Login.tsx",
      "server/services/email.ts",
      "server/services/invoices.ts",
    ]) {
      const source = readFileSync(path.join(repositoryRoot, file), "utf8");
      expect(source, `${file} references retired artwork`).not.toMatch(retiredBrandToken);
    }
  });
});
