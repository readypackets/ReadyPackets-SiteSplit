/**
 * Environment configuration with fail-fast validation.
 *
 * A self-hosted deployment fails in production if any required secret is
 * missing, too short, or left at a well-known default value. This prevents the
 * single most common self-hosting mistake: shipping with placeholder secrets.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const FORBIDDEN_SECRET_VALUES = new Set([
  "changeme",
  "change-me",
  "secret",
  "password",
  "insecure",
  "replace-me",
  "development",
  "0000000000000000000000000000000000000000000000000000000000000000",
]);

class ConfigError extends Error {}

const problems: string[] = [];

function str(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    problems.push(`${key} is required but not set`);
    return "";
  }
  return value;
}

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

function num(key: string, fallback: number): number {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    problems.push(`${key} must be a number, received "${raw}"`);
    return fallback;
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * Security-sensitive feature flags must not silently accept ambiguous values.
 * Mobile OAuth is intentionally opt-in: an ordinary web-only Portal deployment
 * remains unavailable to mobile clients until an operator explicitly enables it.
 */
function strictBool(key: string, fallback: boolean): boolean {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  problems.push(`${key} must be true or false`);
  return fallback;
}

function list(key: string): string[] {
  const raw = optional(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const NODE_ENV = (optional("NODE_ENV") ?? "development") as
  | "development"
  | "production"
  | "test";
const isProduction = NODE_ENV === "production";

/** Development-only deterministic fallbacks. Never used when NODE_ENV=production. */
const DEV_FALLBACKS = {
  DATABASE_URL: "mysql://rpuser:rp_dev_password_local@127.0.0.1:3306/readypackets",
  SESSION_SECRET: "dev_session_secret_do_not_use_in_production_0123456789abcdef",
  DATA_ENCRYPTION_KEY: "6465765f6461746100000000000000000000000000000000000000000000dead",
  EMAIL_INDEX_KEY: "6465765f696e646578000000000000000000000000000000000000000000beef",
  MOBILE_ACCESS_TOKEN_SECRET: "dev_mobile_access_token_secret_do_not_use_in_production_0123456789abcdef",
  APP_URL: "http://localhost:3000",
} as const;

function secret(key: keyof typeof DEV_FALLBACKS, minLength: number): string {
  const value = isProduction ? str(key) : str(key, DEV_FALLBACKS[key]);
  if (!value) return "";
  if (isProduction) {
    if (value.length < minLength) {
      problems.push(`${key} must be at least ${minLength} characters in production`);
    }
    if (FORBIDDEN_SECRET_VALUES.has(value.toLowerCase())) {
      problems.push(`${key} is set to a well-known placeholder value`);
    }
    if (value === DEV_FALLBACKS[key]) {
      problems.push(`${key} still holds the development default value`);
    }
  }
  return value;
}

function hexKey(key: "DATA_ENCRYPTION_KEY" | "EMAIL_INDEX_KEY"): Buffer {
  const raw = secret(key, 64);
  if (!raw) return Buffer.alloc(32);
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    problems.push(`${key} must be exactly 64 hexadecimal characters (32 bytes)`);
    return Buffer.alloc(32);
  }
  return Buffer.from(raw, "hex");
}

const appUrlRaw = isProduction ? str("APP_URL") : str("APP_URL", DEV_FALLBACKS.APP_URL);
let appUrl: URL;
try {
  appUrl = new URL(appUrlRaw || DEV_FALLBACKS.APP_URL);
} catch {
  problems.push(`APP_URL must be an absolute URL, received "${appUrlRaw}"`);
  appUrl = new URL(DEV_FALLBACKS.APP_URL);
}
if (isProduction && appUrl.protocol !== "https:") {
  problems.push("APP_URL must use https in production");
}

function httpsUrl(key: string, raw: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    problems.push(`${key} must be an absolute HTTPS URL`);
    return new URL("https://invalid.invalid");
  }
  if (value.protocol !== "https:" || !value.hostname || value.username || value.password || value.hash || value.search) {
    problems.push(`${key} must be an exact HTTPS URL without credentials, query, or fragment`);
  }
  if (isProduction && (value.hostname.endsWith(".example.com") || value.hostname.endsWith(".invalid"))) {
    problems.push(`${key} cannot use a placeholder hostname in production`);
  }
  return value;
}

// Native OAuth is an explicit opt-in feature. Older web-only installations do
// not have mobile secrets or verified callback hosts and must remain deployable.
// When disabled, every mobile-specific value is inert and intentionally ignored.
const mobileEnabled = strictBool("MOBILE_ENABLED", false);
const mobileIssuerFallback = appUrl.origin;
const mobileIssuerUrl = mobileEnabled
  ? httpsUrl("MOBILE_OAUTH_ISSUER", optional("MOBILE_OAUTH_ISSUER") ?? mobileIssuerFallback)
  : appUrl;
if (mobileEnabled && isProduction && mobileIssuerUrl.origin !== appUrl.origin) {
  problems.push("MOBILE_OAUTH_ISSUER must match the canonical APP_URL origin in production");
}
const mobileRedirectUris = mobileEnabled ? list("MOBILE_OAUTH_REDIRECT_URIS") : [];
if (mobileEnabled && isProduction && mobileRedirectUris.length === 0) {
  problems.push("MOBILE_OAUTH_REDIRECT_URIS must contain at least one registered HTTPS App or Universal Link callback in production");
}
if (mobileEnabled) {
  for (const redirectUri of mobileRedirectUris) {
    const callback = httpsUrl("MOBILE_OAUTH_REDIRECT_URIS", redirectUri);
    if (callback.pathname !== "/auth/callback") {
      problems.push("MOBILE_OAUTH_REDIRECT_URIS callbacks must use the exact /auth/callback path");
    }
  }
}
const mobileAccessTokenSecret = mobileEnabled ? secret("MOBILE_ACCESS_TOKEN_SECRET", 48) : "";
if (mobileEnabled && isProduction && mobileAccessTokenSecret === secret("SESSION_SECRET", 48)) {
  problems.push("MOBILE_ACCESS_TOKEN_SECRET must differ from SESSION_SECRET");
}
const mobileAccessTokenKeyId = mobileEnabled ? str("MOBILE_ACCESS_TOKEN_KID", "mobile-access-v1") : "mobile-disabled";
if (mobileEnabled && !/^[A-Za-z0-9._-]{3,64}$/.test(mobileAccessTokenKeyId)) {
  problems.push("MOBILE_ACCESS_TOKEN_KID must contain 3-64 letters, digits, periods, underscores, or hyphens");
}
const mobileAccessTokenTtlSeconds = mobileEnabled ? num("MOBILE_ACCESS_TOKEN_TTL_SECONDS", 600) : 600;
const mobileRefreshTokenTtlDays = mobileEnabled ? num("MOBILE_REFRESH_TOKEN_TTL_DAYS", 30) : 30;

const androidAppLinkPackageName = mobileEnabled ? str("ANDROID_APP_LINK_PACKAGE_NAME", "com.readypackets.mobile") : "com.readypackets.mobile";
if (mobileEnabled && !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(androidAppLinkPackageName)) {
  problems.push("ANDROID_APP_LINK_PACKAGE_NAME must be a valid Android package name");
}
const androidAppLinkCertFingerprints = mobileEnabled ? list("ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS") : [];
if (mobileEnabled) {
  for (const fingerprint of androidAppLinkCertFingerprints) {
    if (!/^[A-Fa-f0-9]{2}(?::[A-Fa-f0-9]{2}){31}$/.test(fingerprint)) {
      problems.push("ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS entries must be colon-separated SHA-256 certificate fingerprints");
    }
  }
}

// APP_URL remains the canonical portal/API origin so existing mail links, SAML
// callbacks, native clients, and session-facing services remain stable. The
// optional public origin is a separate, anonymous marketing surface. Portal-only
// mode keeps external marketing navigation out of trusted portal host checks.
const publicSiteUrlRaw = optional("PUBLIC_SITE_URL") ?? appUrl.origin;
let publicSiteUrl: URL;
try {
  publicSiteUrl = new URL(publicSiteUrlRaw);
} catch {
  problems.push(`PUBLIC_SITE_URL must be an absolute URL, received "${publicSiteUrlRaw}"`);
  publicSiteUrl = appUrl;
}
if (isProduction && publicSiteUrl.protocol !== "https:") {
  problems.push("PUBLIC_SITE_URL must use https in production");
}
const portalOnly = bool("PORTAL_ONLY", false);

// This is navigation-only configuration for a separately hosted marketing
// website. Unlike PUBLIC_SITE_URL, it never participates in host validation,
// Origin checks, static bundle selection, or cookie scope.
const marketingSiteUrlRaw = optional("MARKETING_SITE_URL") ?? "https://www.readypackets.com";
let marketingSiteUrl: URL;
try {
  marketingSiteUrl = new URL(marketingSiteUrlRaw);
  if (
    marketingSiteUrl.protocol !== "https:" ||
    marketingSiteUrl.username ||
    marketingSiteUrl.password ||
    marketingSiteUrl.pathname !== "/" ||
    marketingSiteUrl.search ||
    marketingSiteUrl.hash
  ) {
    problems.push("MARKETING_SITE_URL must be an HTTPS origin without credentials, path, query, or fragment");
    marketingSiteUrl = new URL("https://www.readypackets.com");
  }
} catch {
  problems.push(`MARKETING_SITE_URL must be an absolute HTTPS origin, received "${marketingSiteUrlRaw}"`);
  marketingSiteUrl = new URL("https://www.readypackets.com");
}

const allowedOrigins = list("ALLOWED_ORIGINS");
const allowedHostnames = new Set<string>([appUrl.hostname]);
if (!portalOnly) allowedHostnames.add(publicSiteUrl.hostname);
for (const origin of allowedOrigins) {
  try {
    allowedHostnames.add(new URL(origin).hostname);
  } catch {
    allowedHostnames.add(origin.replace(/^https?:\/\//, "").split("/")[0] ?? origin);
  }
}

const smtpHost = optional("SMTP_HOST");
const syslogTarget = optional("SYSLOG_TARGET");
if (syslogTarget) {
  try {
    const destination = new URL(syslogTarget);
    if (destination.protocol !== "tls:" || !destination.hostname || !destination.port || destination.username || destination.password || destination.pathname !== "/" || destination.search || destination.hash) {
      problems.push("SYSLOG_TARGET must use tls://host:port without credentials, path, query, or fragment");
    }
  } catch {
    problems.push("SYSLOG_TARGET must be an absolute tls://host:port URL");
  }
}

const instanceRoleRaw = (optional("INSTANCE_ROLE") ?? "all").toLowerCase();
const instanceRole = instanceRoleRaw === "web" || instanceRoleRaw === "worker" || instanceRoleRaw === "all"
  ? instanceRoleRaw
  : "all";
if (instanceRoleRaw !== instanceRole) {
  problems.push("INSTANCE_ROLE must be web, worker, or all");
}

const databaseConnectionLimit = Math.floor(num("DATABASE_CONNECTION_LIMIT", isProduction ? 16 : 6));
if (databaseConnectionLimit < 1 || databaseConnectionLimit > 64) {
  problems.push("DATABASE_CONNECTION_LIMIT must be between 1 and 64");
}

const storageDriverRaw = (optional("STORAGE_DRIVER") ?? "local").toLowerCase();
const storageDriver = storageDriverRaw === "local" || storageDriverRaw === "s3" ? storageDriverRaw : "local";
if (storageDriverRaw !== storageDriver) {
  problems.push("STORAGE_DRIVER must be local or s3");
}
if (storageDriver === "s3") {
  for (const key of ["S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
    if (!optional(key)) problems.push(`${key} is required when STORAGE_DRIVER=s3`);
  }
}

export const env = {
  nodeEnv: NODE_ENV,
  isProduction,
  isTest: NODE_ENV === "test",
  port: num("PORT", 3000),
  bindHost: str("BIND_HOST", "127.0.0.1"),
  appUrl: appUrl.origin,
  appHostname: appUrl.hostname,
  publicSiteUrl: publicSiteUrl.origin,
  publicHostname: publicSiteUrl.hostname,
  /** External navigation only; not an application host, Origin, or cookie domain. */
  marketingSiteUrl: marketingSiteUrl.origin,
  portalOnly,
  siteSplitEnabled: portalOnly || publicSiteUrl.hostname !== appUrl.hostname,
  allowedHostnames: [...allowedHostnames],

  databaseUrl: secret("DATABASE_URL", 12),
  databaseConnectionLimit: Math.max(1, Math.min(64, databaseConnectionLimit)),
  sessionSecret: secret("SESSION_SECRET", 48),
  dataEncryptionKey: hexKey("DATA_ENCRYPTION_KEY"),
  emailIndexKey: hexKey("EMAIL_INDEX_KEY"),

  /** Number of reverse-proxy hops to trust when resolving the client address. */
  trustProxyHops: num("TRUST_PROXY_HOPS", 1),
  behindCloudflare: bool("BEHIND_CLOUDFLARE", false),

  sessionTtlMinutes: num("SESSION_TTL_MINUTES", 720),
  sessionIdleTimeoutMinutes: num("SESSION_IDLE_TIMEOUT_MINUTES", 120),
  instanceRole,
  schedulerEnabled: instanceRole !== "web",
  cookiePrefix: isProduction ? "__Host-" : "",

  /** Native clients use OAuth 2.1/OIDC + PKCE; callback hosts are explicitly allowlisted. */
  mobile: {
    enabled: mobileEnabled,
    issuer: mobileIssuerUrl.origin,
    redirectUris: mobileRedirectUris,
    accessTokenSecret: mobileAccessTokenSecret,
    accessTokenKeyId: mobileAccessTokenKeyId,
    accessTokenTtlSeconds: mobileAccessTokenTtlSeconds,
    refreshTokenTtlDays: mobileRefreshTokenTtlDays,
  },
  androidAppLink: {
    packageName: androidAppLinkPackageName,
    sha256CertFingerprints: androidAppLinkCertFingerprints,
  },

  storage: {
    driver: storageDriver,
    localRoot: str("STORAGE_LOCAL_ROOT", path.resolve(process.cwd(), "var", "storage")),
    maxUploadBytes: num("MAX_UPLOAD_BYTES", 52_428_800),
    s3: {
      endpoint: optional("S3_ENDPOINT"),
      region: optional("S3_REGION"),
      bucket: optional("S3_BUCKET"),
      accessKeyId: optional("S3_ACCESS_KEY_ID"),
      secretAccessKey: optional("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: bool("S3_FORCE_PATH_STYLE", true),
    },
  },

  smtp: smtpHost
    ? {
        enabled: true as const,
        host: smtpHost,
        port: num("SMTP_PORT", 587),
        secure: bool("SMTP_SECURE", false),
        user: optional("SMTP_USER"),
        pass: optional("SMTP_PASS"),
        from: str("SMTP_FROM", "no-reply@readypackets.com"),
        replyTo: optional("SMTP_REPLY_TO"),
      }
    : { enabled: false as const },

  stripe: {
    enabled: Boolean(optional("STRIPE_SECRET_KEY")),
    secretKey: optional("STRIPE_SECRET_KEY"),
    webhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
    publishableKey: optional("STRIPE_PUBLISHABLE_KEY"),
  },

  saml: {
    enabled: bool("SAML_ENABLED", false),
    entryPoint: optional("SAML_ENTRY_POINT"),
    issuer: optional("SAML_ISSUER"),
    cert: optional("SAML_IDP_CERT"),
  },

  adminIpAllowlist: list("ADMIN_IP_ALLOWLIST"),
  syslogTarget,
  logLevel: str("LOG_LEVEL", isProduction ? "info" : "debug"),

  /** Microsoft Graph / SharePoint integration. */
  graph: {
    enabled: Boolean(optional("GRAPH_TENANT_ID")),
    tenantId: optional("GRAPH_TENANT_ID"),
    clientId: optional("GRAPH_CLIENT_ID"),
    clientSecret: optional("GRAPH_CLIENT_SECRET"),
    siteId: optional("GRAPH_SHAREPOINT_SITE_ID"),
    driveId: optional("GRAPH_SHAREPOINT_DRIVE_ID"),
    rootFolderPath: str("GRAPH_ROOT_FOLDER_PATH", "ReadyPackets/Orders"),
    /** Mailbox address used as sender when Graph API email transport is active. */
    emailSender: optional("GRAPH_EMAIL_SENDER"),
    /** When GRAPH_EMAIL_SENDER is set, Graph API is used for email delivery. */
    emailEnabled: Boolean(optional("GRAPH_EMAIL_SENDER")),
  },
} as const;

if (problems.length > 0) {
  const message = [
    "Refusing to start: environment configuration is invalid.",
    ...problems.map((problem) => `  - ${problem}`),
    "",
    "Generate strong values with:",
    "  SESSION_SECRET      openssl rand -hex 32",
    "  DATA_ENCRYPTION_KEY openssl rand -hex 32",
    "  EMAIL_INDEX_KEY     openssl rand -hex 32",
  ].join("\n");
  throw new ConfigError(message);
}
