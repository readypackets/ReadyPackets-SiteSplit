import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "server/app.ts"), "utf8");

describe("legacy single-host client asset routing", () => {
  it("serves legacy shell assets from legacyClientDist before considering split bundle directories", () => {
    expect(appSource).toContain("const legacyStatic = express.static(legacyClientDist, staticOptions);");
    expect(appSource).toContain("if (!env.siteSplitEnabled) {");
    expect(appSource).toContain("legacyStatic(req, res, next);");
    expect(appSource).toContain("return;");
    expect(appSource).toContain("HTML-to-asset hash");
  });

  it("retains separate static middleware only when a distinct public host enables split mode", () => {
    expect(appSource).toContain("const publicStatic = express.static(publicClientDist, staticOptions);");
    expect(appSource).toContain("const portalStatic = express.static(portalClientDist, staticOptions);");
    expect(appSource).toContain("(isPublicSurface(req) ? publicStatic : portalStatic)(req, res, next);");
  });
});
