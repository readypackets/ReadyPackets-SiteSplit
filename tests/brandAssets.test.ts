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
  BRAND_ASSETS.light.squareLockup,
  BRAND_ASSETS.light.squareLockupPng,
  BRAND_ASSETS.light.compactMark,
  BRAND_ASSETS.light.full,
  BRAND_ASSETS.light.trademark,
  BRAND_ASSETS.light.wordmark,
  BRAND_ASSETS.light.wordmarkPng,
  BRAND_ASSETS.light.wordmarkTrademark,
  BRAND_ASSETS.light.wordmarkTrademarkPng,
  BRAND_ASSETS.dark.squareLockup,
  BRAND_ASSETS.dark.squareLockupPng,
  BRAND_ASSETS.dark.compactMark,
  BRAND_ASSETS.dark.full,
  BRAND_ASSETS.dark.trademark,
  BRAND_ASSETS.dark.wordmark,
  BRAND_ASSETS.dark.wordmarkPng,
  BRAND_ASSETS.dark.wordmarkTrademark,
  BRAND_ASSETS.dark.wordmarkTrademarkPng,
  ...Object.values(BRAND_ASSETS.mark.light),
  ...Object.values(BRAND_ASSETS.mark.dark),
  BRAND_ASSETS.favicon,
];

describe("ReadyPackets brand package", () => {
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
      BRAND_ASSETS.light.wordmarkTrademark,
      BRAND_ASSETS.dark.full,
      BRAND_ASSETS.dark.trademark,
      BRAND_ASSETS.dark.wordmark,
      BRAND_ASSETS.dark.wordmarkTrademark,
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

  it("uses a supplied-style trademark glyph in every wordmark trademark export", () => {
    for (const asset of [BRAND_ASSETS.light.wordmarkTrademark, BRAND_ASSETS.dark.wordmarkTrademark]) {
      const svg = readFileSync(publicAssetPath(asset), "utf8");
      expect(svg).toContain('id="wordmark-trademark"');
      expect(svg).toContain('aria-label="™"');
    }
  });

  it("keeps browser and PWA icon references on the supplied square lockup", () => {
    for (const file of ["client/index.html", "client/public.html", "client/portal.html"]) {
      const shell = readFileSync(path.join(repositoryRoot, file), "utf8");
      expect(shell).toContain(BRAND_ASSETS.favicon);
      expect(shell).toContain("/brand/readypackets-full-lockup-square-light-192.png");
    }

    const manifest = readFileSync(path.join(repositoryRoot, "client/public/manifest.webmanifest"), "utf8");
    expect(manifest).toContain("/brand/readypackets-full-lockup-square-light-512.png");
  });
});
