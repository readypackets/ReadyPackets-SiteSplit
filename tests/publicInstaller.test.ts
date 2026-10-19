import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const installerPath = resolve(process.cwd(), "deploy/one-click-install.sh");
const source = readFileSync(installerPath, "utf8");

describe("public-source fresh installer defaults", () => {
  it("has valid Bash syntax", () => {
    const result = spawnSync("bash", ["-n", installerPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("uses the approved operations mailbox by default while retaining an explicit override", () => {
    expect(source).toContain('ADMIN_EMAIL="${RP_ADMIN_EMAIL:-tools@readypackets.com}"');
    expect(source).toContain("A caller may deliberately override this with RP_ADMIN_EMAIL");
  });

  it("does not permit administrator passwords or Cloudflare tokens in the reusable settings profile", () => {
    expect(source).toContain("RP_ADMIN_PASSWORD|RP_GITHUB_CONFIG_TOKEN|RP_GITHUB_CONFIG_PASSPHRASE|RP_CLOUDFLARE_ORIGIN_KEY|RP_CLOUDFLARE_API_TOKEN");
    expect(source).toContain("Do not pass a Cloudflare API token through an environment variable");
  });
});
