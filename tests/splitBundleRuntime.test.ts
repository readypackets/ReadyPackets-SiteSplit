import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const splitViteConfigPath = resolve(root, "vite.split.config.ts");
const splitViteSource = readFileSync(splitViteConfigPath, "utf8");
const legacyViteConfigPath = resolve(root, "vite.config.ts");
const legacyViteSource = readFileSync(legacyViteConfigPath, "utf8");
const portalViteConfigPath = resolve(root, "vite.portal.config.ts");
const portalViteSource = readFileSync(portalViteConfigPath, "utf8");
const repairPath = resolve(root, "deploy/repair-split-portal-bundle.sh");
const repairSource = readFileSync(repairPath, "utf8");

describe("split client runtime chunking", () => {
  it("uses graph-aware automatic chunking instead of a React/vendor manual chunk cycle", () => {
    expect(splitViteSource).toContain("Rollup's graph-aware automatic chunking preserves the");
    expect(splitViteSource).not.toContain("manualChunks");
    expect(splitViteSource).not.toContain('return "vendor"');
    expect(legacyViteSource).toContain("Keep automatic graph-aware chunking.");
    expect(legacyViteSource).not.toContain("manualChunks");
    expect(legacyViteSource).not.toContain('return "vendor"');
  });

  it("keeps the split bundle CSP nonce transformation enabled", () => {
    expect(splitViteSource).toContain('nonce="__CSP_NONCE__"');
    expect(portalViteSource).toContain('createSplitViteConfig("portal.html", "dist-portal")');
  });
});

describe("split portal bundle recovery helper", () => {
  it("is syntactically valid and limited to the immutable client-only correction", () => {
    const syntax = spawnSync("bash", ["-n", repairPath], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(repairSource).toContain('readonly COMMIT="ff92e369a897cba121b894f9a8aaa8eaedaaa733"');
    expect(repairSource).toContain("--confirm-known-split-bundle-cycle");
    expect(repairSource).toContain('printf \'%s\\037%s\\n\' "${APP_URL:-}" "${PUBLIC_SITE_URL:-}"');
    expect(repairSource).toContain('ACTIVE_DIST_NAME="dist"');
    expect(repairSource).toContain('BUILD_COMMAND="build:legacy"');
    expect(repairSource).toContain('ACTIVE_DIST_NAME="dist-portal"');
    expect(repairSource).toContain('BUILD_COMMAND="build:portal"');
    expect(repairSource).toContain('NODE_ENV=production pnpm run "$BUILD_COMMAND"');
    expect(repairSource).toContain('TARGET_PARENT="$(git -C "$SOURCE_DIR" rev-parse "${RESOLVED_COMMIT}^")"');
    expect(repairSource).toContain('diff --quiet "$TARGET_PARENT" "$RESOLVED_COMMIT" -- package.json pnpm-lock.yaml');
    expect(repairSource).toContain('diff --quiet "$TARGET_PARENT" "$RESOLVED_COMMIT" -- drizzle/migrations server deploy');
    expect(repairSource).toContain('ENV_DIGEST_BEFORE="$(sha256sum "$ENV_FILE"');
    expect(repairSource).toContain('mv -- "$ACTIVE_CLIENT_DIST" "$PREVIOUS_CLIENT_DIST"');
    expect(repairSource).toContain('restore_previous_client_dist');
    expect(repairSource).toContain('--resolve "${DOMAIN}:443:127.0.0.1"');
    expect(repairSource).not.toContain('deploy/install.sh');
    expect(repairSource).not.toContain('systemctl restart');
  });
});
