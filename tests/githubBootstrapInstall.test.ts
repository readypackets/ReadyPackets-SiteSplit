import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const bootstrapPath = resolve(process.cwd(), "deploy/github-bootstrap-install.sh");
const source = readFileSync(bootstrapPath, "utf8");

describe("private portal fresh-server bootstrap", () => {
  it("has valid Bash syntax", () => {
    const result = spawnSync("bash", ["-n", bootstrapPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("requires a reviewed immutable SHA and refuses a non-new deployment target", () => {
    expect(source).toContain('[[ "$COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]');
    expect(source).toContain('[[ ! -e "$PROJECT_DIR" ]]');
    expect(source).toContain('systemctl is-active --quiet readypackets');
    expect(source).not.toContain("git checkout main");
  });

  it("pins GitHub SSH host keys from its authenticated metadata rather than trusting first use", () => {
    expect(source).toContain("https://api.github.com/meta");
    expect(source).toContain("StrictHostKeyChecking=yes");
    expect(source).toContain("UserKnownHostsFile=${GITHUB_KNOWN_HOSTS}");
    expect(source).not.toContain("StrictHostKeyChecking=accept-new");
  });

  it("supports every approved production certificate flow without placing an API token in a command", () => {
    expect(source).toContain("cloudflare-origin-ca");
    expect(source).toContain("--cloudflare-api-token-file");
    expect(source).toContain('CLOUDFLARE_API_TOKEN_FILE" == /*');
    expect(source).toContain('"$(stat -c \'%U:%a\' "$CLOUDFLARE_API_TOKEN_FILE")" == "root:600"');
    expect(source).toContain("--cloudflare-origin-cert");
    expect(source).toContain("--tls-provider letsencrypt");
  });

  it("requires local readiness and performs public reachability as a separately controlled gate", () => {
    expect(source).toContain('verify-public-connectivity.sh" --domain "$DOMAIN" "${verifier_alias_args[@]}" --local-only');
    expect(source).toContain('verifier_alias_args+=(--portal-alias "$portal_alias")');
    expect(source).toContain('"$REQUIRE_PUBLIC_HEALTH" == "no"');
    expect(source).toContain("Local installation is healthy; public HTTPS is pending");
  });
});
