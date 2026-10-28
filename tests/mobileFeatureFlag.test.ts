import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const appSource = readFileSync(resolve(root, "server/app.ts"), "utf8");
const oidcSource = readFileSync(resolve(root, "server/auth/mobileOidc.ts"), "utf8");
const csrfSource = readFileSync(resolve(root, "server/security/csrf.ts"), "utf8");
const samlSource = readFileSync(resolve(root, "server/auth/saml.ts"), "utf8");
const openapiSource = readFileSync(resolve(root, "server/http/mobile/openapi.yaml"), "utf8");

const coreProductionEnvironment = {
  NODE_ENV: "production",
  APP_URL: "https://portal.test.invalid",
  DATABASE_URL: "mysql://rpuser:strong_database_password@127.0.0.1:3306/readypackets",
  SESSION_SECRET: "a".repeat(64),
  DATA_ENCRYPTION_KEY: "b".repeat(64),
  EMAIL_INDEX_KEY: "c".repeat(64),
};

function loadConfiguration(extra: Record<string, string | undefined> = {}) {
  const script = [
    'import { env } from "./server/config/env.ts";',
    'process.stdout.write(JSON.stringify({ mobileEnabled: env.mobile.enabled, redirectUris: env.mobile.redirectUris, mobileSecretLength: env.mobile.accessTokenSecret.length }));',
  ].join("\n");
  return spawnSync("pnpm", ["exec", "tsx", "-e", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...coreProductionEnvironment, ...extra },
  });
}

describe("native mobile feature gate", () => {
  it("keeps a production web-only Portal valid with absent or stale mobile-only values", () => {
    const absent = loadConfiguration({
      MOBILE_ENABLED: undefined,
      MOBILE_OAUTH_ISSUER: undefined,
      MOBILE_OAUTH_REDIRECT_URIS: undefined,
      MOBILE_ACCESS_TOKEN_SECRET: undefined,
      ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS: undefined,
    });
    expect(absent.status, absent.stderr).toBe(0);
    expect(JSON.parse(absent.stdout)).toEqual({ mobileEnabled: false, redirectUris: [], mobileSecretLength: 0 });

    const staleDisabled = loadConfiguration({
      MOBILE_ENABLED: "false",
      MOBILE_OAUTH_ISSUER: "not a URL",
      MOBILE_OAUTH_REDIRECT_URIS: "http://insecure.invalid/not-a-callback",
      MOBILE_ACCESS_TOKEN_SECRET: "weak",
      ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS: "not-a-fingerprint",
    });
    expect(staleDisabled.status, staleDisabled.stderr).toBe(0);
    expect(JSON.parse(staleDisabled.stdout)).toEqual({ mobileEnabled: false, redirectUris: [], mobileSecretLength: 0 });
  });

  it("fails closed when a mobile operator enables OAuth without every required secret and callback", () => {
    const result = loadConfiguration({
      MOBILE_ENABLED: "true",
      MOBILE_OAUTH_REDIRECT_URIS: "",
      MOBILE_ACCESS_TOKEN_SECRET: "",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("MOBILE_OAUTH_REDIRECT_URIS must contain at least one registered HTTPS App or Universal Link callback in production");
    expect(`${result.stdout}\n${result.stderr}`).toContain("MOBILE_ACCESS_TOKEN_SECRET is required but not set");
  });

  it("accepts a fully configured explicitly enabled mobile release", () => {
    const result = loadConfiguration({
      APP_URL: "https://portal.test.ready-packets.test",
      MOBILE_ENABLED: "true",
      MOBILE_OAUTH_ISSUER: "https://portal.test.ready-packets.test",
      MOBILE_OAUTH_REDIRECT_URIS: "https://mobile-callback.test.ready-packets.test/auth/callback",
      MOBILE_ACCESS_TOKEN_SECRET: "d".repeat(64),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mobileEnabled: true,
      redirectUris: ["https://mobile-callback.test.ready-packets.test/auth/callback"],
      mobileSecretLength: 64,
    });
  });

  it("rejects ambiguous mobile feature-flag values instead of silently enabling a security surface", () => {
    const result = loadConfiguration({ MOBILE_ENABLED: "yes" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("MOBILE_ENABLED must be true or false");
  });

  it("withholds mobile discovery, OAuth, Android association, CSRF exemption, and SAML continuations while disabled", () => {
    expect(appSource).toContain("if (env.mobile.enabled) {");
    expect(appSource).toContain('app.all("/.well-known/openid-configuration", mobileNotFound)');
    expect(appSource).toContain('app.use("/api/mobile", mobileNotFound)');
    expect(appSource).toContain('if (!env.mobile.enabled || env.androidAppLink.sha256CertFingerprints.length === 0)');
    expect(appSource).toContain('app.use("/api/mobile/v1", createMobileRouter())');
    expect(csrfSource).toContain('...(env.mobile.enabled ? ["/api/mobile/"] : [])');
    expect(samlSource).toContain('env.mobile.enabled && requestedReturn.startsWith("/api/mobile/v1/authorize?")');
    expect(openapiSource).toContain("MOBILE_ENABLED=true");
    expect(openapiSource).toContain("generic HTTP 404 responses");
  });

  it("does not construct a mobile signing key at module load and protects future direct OAuth calls", () => {
    expect(oidcSource).not.toContain("const key = new TextEncoder().encode(env.mobile.accessTokenSecret)");
    expect(oidcSource).toContain("function requireMobileEnabled(): void");
    expect(oidcSource).toContain("function mobileAccessTokenKey(): Uint8Array");
    expect(oidcSource).toContain("const key = mobileAccessTokenKey();");
    expect(oidcSource).toContain("export async function revokeMobileSessionsForUser");
  });
});
