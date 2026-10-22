import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const inspector = resolve(root, "deploy/inspect-existing-platform.sh");
const source = readFileSync(inspector, "utf8");

describe("existing ReadyPackets platform inspector", () => {
  it("is syntactically valid and safely reports that no native deployment is present", () => {
    const syntax = spawnSync("bash", ["-n", inspector], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);

    const run = spawnSync("bash", [inspector], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("ReadyPackets existing-platform report (read-only, no secrets)");
    expect(run.stdout).toContain("Safe next step");
    expect(run.stdout).toContain("Do not share portal.env, backup archives, keys, passwords, tokens, private certificates, or customer/order data.");
  });

  it("reads only an allowlisted set of non-secret runtime topology keys without sourcing portal.env", () => {
    expect(source).toContain("Parse exactly one assignment without command substitution/evaluation.");
    expect(source).not.toMatch(/\n\s*\.\s+[^\n]*portal\.env/);
    expect(source).not.toContain("source \"$ENV_FILE\"");
    for (const key of [
      "APP_URL",
      "PUBLIC_SITE_URL",
      "MARKETING_SITE_URL",
      "PORTAL_ONLY",
      "PORTAL_ALIASES",
      "STORAGE_DRIVER",
      "INSTANCE_ROLE",
      "BEHIND_CLOUDFLARE",
      "TRUST_PROXY_HOPS",
    ]) {
      expect(source).toContain(`for key in APP_URL PUBLIC_SITE_URL MARKETING_SITE_URL PORTAL_ONLY PORTAL_ALIASES STORAGE_DRIVER INSTANCE_ROLE BEHIND_CLOUDFLARE TRUST_PROXY_HOPS;`);
      expect(source).toContain(key);
    }
    expect(source).not.toMatch(/(SESSION_SECRET|DATA_ENCRYPTION_KEY|EMAIL_INDEX_KEY|DATABASE_URL|DB_PASSWORD|STRIPE_SECRET_KEY|SMTP_PASS|S3_SECRET_ACCESS_KEY|GRAPH_CLIENT_SECRET)/);
  });

  it("does not contain lifecycle, filesystem, database-write, or HTTP-write commands", () => {
    expect(source).not.toMatch(/systemctl\s+(?:restart|reload|start|stop|enable|disable)/);
    expect(source).not.toMatch(/(?:^|[;&|\s])(?:rm|mv|cp|install|mkdir|chmod|chown)(?:[;&|\s]|$)/m);
    expect(source).not.toMatch(/(?:^|[;&|])\s*(?:mysql|mysqld)\s/m);
    expect(source).not.toMatch(/curl\s+.*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--request)/);
    expect(source).toContain("read-only, no secrets");
  });
});
