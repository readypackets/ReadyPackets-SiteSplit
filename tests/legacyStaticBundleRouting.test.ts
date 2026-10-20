import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const appSource = readFileSync(resolve(root, "server/app.ts"), "utf8");
const repairPath = resolve(root, "deploy/repair-legacy-static-assets.sh");
const repairSource = readFileSync(repairPath, "utf8");

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

describe("legacy static asset recovery helper", () => {
  it("is syntactically valid, immutable, and scoped to the known one-host 404 condition", () => {
    const syntax = spawnSync("bash", ["-n", repairPath], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(repairSource).toContain('readonly COMMIT="d412dee82c4ad4e4ee58dba0ec49037befd5dd9b"');
    expect(repairSource).toContain("--confirm-known-legacy-asset-404");
    expect(repairSource).toContain('[[ -z "$PUBLIC_SITE_URL" || "$PUBLIC_SITE_URL" == "$APP_URL" ]]');
    expect(repairSource).toContain('NODE_ENV=production pnpm run build:legacy');
    expect(repairSource).toContain('NODE_ENV=production pnpm run build:server');
    expect(repairSource).toContain('case "$target_file" in');
    expect(repairSource).toContain('SESSION_LOG.md|server/app.ts|tests/legacyStaticBundleRouting.test.ts');
    expect(repairSource).toContain('mv -- "${APP_DIR}/client/dist" "$PREVIOUS_CLIENT_DIST"');
    expect(repairSource).toContain('mv -- "${APP_DIR}/dist/server.js" "$PREVIOUS_SERVER"');
    expect(repairSource).toContain('systemctl restart "$SERVICE"');
    expect(repairSource).toContain('restore_previous_runtime');
    expect(repairSource).toContain('--resolve "${DOMAIN}:443:127.0.0.1"');
    expect(repairSource).not.toContain("deploy/install.sh");
    expect(repairSource).not.toContain("drizzle-kit migrate");
  });
});
