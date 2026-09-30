import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BRAND_ASSETS } from "../shared/brand.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function publicAssetPath(assetPath: string): string {
  expect(assetPath).toMatch(/^\/[a-zA-Z0-9._/-]+$/);
  return path.join(repositoryRoot, "client", "public", assetPath);
}

const brandAssets = [
  BRAND_ASSETS.light.full,
  BRAND_ASSETS.light.trademark,
  BRAND_ASSETS.light.wordmark,
  BRAND_ASSETS.light.wordmarkPng,
  BRAND_ASSETS.dark.full,
  BRAND_ASSETS.dark.trademark,
  BRAND_ASSETS.dark.wordmark,
  BRAND_ASSETS.dark.wordmarkPng,
  ...Object.values(BRAND_ASSETS.mark.light),
  ...Object.values(BRAND_ASSETS.mark.dark),
  BRAND_ASSETS.favicon,
];

describe("Document-Flow brand package", () => {
  it("keeps every registered self-hosted asset present and non-empty", () => {
    for (const asset of brandAssets) {
      const resolved = publicAssetPath(asset);
      expect(existsSync(resolved), `${asset} must be present in client/public`).toBe(true);
      expect(statSync(resolved).size, `${asset} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("keeps supplied SVG logos self-contained and non-executable", () => {
    for (const asset of [
      BRAND_ASSETS.light.full,
      BRAND_ASSETS.light.trademark,
      BRAND_ASSETS.light.wordmark,
      BRAND_ASSETS.dark.full,
      BRAND_ASSETS.dark.trademark,
      BRAND_ASSETS.dark.wordmark,
      BRAND_ASSETS.mark.light.svg,
      BRAND_ASSETS.mark.dark.svg,
    ]) {
      const svg = readFileSync(publicAssetPath(asset), "utf8");
      expect(svg).toContain("<title");
      expect(svg).toContain("<desc");
      expect(svg).not.toMatch(/<script\b|\son[a-z]+\s*=/i);
      expect(svg).not.toMatch(/(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:|javascript:)/i);
    }
  });

  it("keeps browser and PWA icon references on the supplied compact mark", () => {
    for (const file of ["client/index.html", "client/public.html", "client/portal.html"]) {
      const shell = readFileSync(path.join(repositoryRoot, file), "utf8");
      expect(shell).toContain(BRAND_ASSETS.favicon);
      expect(shell).toContain(BRAND_ASSETS.mark.light.px32);
      expect(shell).toContain(BRAND_ASSETS.mark.light.px256);
    }

    const manifest = readFileSync(path.join(repositoryRoot, "client/public/manifest.webmanifest"), "utf8");
    expect(manifest).toContain(BRAND_ASSETS.mark.light.px128);
    expect(manifest).toContain(BRAND_ASSETS.mark.light.px256);
    expect(manifest).toContain(BRAND_ASSETS.mark.light.px512);
    expect(manifest).toContain(BRAND_ASSETS.mark.light.px1024);
  });
});
