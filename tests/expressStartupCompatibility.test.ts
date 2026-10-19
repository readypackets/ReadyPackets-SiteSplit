import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";

describe("Express 5 startup compatibility", () => {
  it("constructs the complete application without path-to-regexp startup errors", () => {
    expect(() => createApp()).not.toThrow();
  });

  it("uses a named brace catch-all for the GET-only SPA fallback", () => {
    const source = readFileSync(resolve(process.cwd(), "server/app.ts"), "utf8");
    expect(source).toContain('app.get("/{*splat}", async (req: Request, res: Response) => {');
    expect(source).not.toContain('app.get("*", async (req: Request, res: Response) => {');
  });

  it("ships a syntax-valid, immutable repair helper that preserves existing TLS and data", () => {
    const repairPath = resolve(process.cwd(), "deploy/repair-express5-startup.sh");
    const source = readFileSync(repairPath, "utf8");
    const installerStart = source.indexOf('bash "$SOURCE_DIR/deploy/install.sh"');
    const installerEnd = source.indexOf("</dev/null", installerStart);
    const installerInvocation = source.slice(installerStart, installerEnd + "</dev/null".length);
    expect(spawnSync("bash", ["-n", repairPath], { encoding: "utf8" }).status).toBe(0);
    expect(source).toContain('readonly COMMIT="9cce95ff4ca123d3c358659140c7f25b9feee5d9"');
    expect(installerInvocation).toContain("--skip-packages");
    expect(installerInvocation).toContain("--no-seed");
    expect(source).toContain("TLS certificate: unchanged");
    expect(source).toContain("Database/data: unchanged (migrations only; no seed)");
    expect(installerInvocation).not.toContain("--tls-provider");
    expect(installerInvocation).not.toContain("--cloudflare-api-token");
  });
});
