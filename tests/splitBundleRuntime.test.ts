import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const splitViteConfigPath = resolve(process.cwd(), "vite.split.config.ts");
const splitViteSource = readFileSync(splitViteConfigPath, "utf8");
const portalViteConfigPath = resolve(process.cwd(), "vite.portal.config.ts");
const portalViteSource = readFileSync(portalViteConfigPath, "utf8");

describe("split client runtime chunking", () => {
  it("uses graph-aware automatic chunking instead of a React/vendor manual chunk cycle", () => {
    expect(splitViteSource).toContain("Rollup's graph-aware automatic chunking preserves the");
    expect(splitViteSource).not.toContain("manualChunks");
    expect(splitViteSource).not.toContain('return "vendor"');
  });

  it("keeps the split bundle CSP nonce transformation enabled", () => {
    expect(splitViteSource).toContain('nonce="__CSP_NONCE__"');
    expect(portalViteSource).toContain('createSplitViteConfig("portal.html", "dist-portal")');
  });
});
