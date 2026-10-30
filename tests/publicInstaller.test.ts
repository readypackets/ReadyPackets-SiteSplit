import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const installerPath = resolve(process.cwd(), "deploy/one-click-install.sh");
const source = readFileSync(installerPath, "utf8");
const portalOnlyInstallerPath = resolve(process.cwd(), "deploy/temporary-public-portal-only-install.sh");
const portalOnlySource = readFileSync(portalOnlyInstallerPath, "utf8");

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

  it("checks Docker public HTTPS directly instead of inheriting an arbitrary egress proxy", () => {
    expect(source).toContain("curl --noproxy '*' -fsS --connect-timeout 5 --max-time 15");
  });

  it("keeps the normal temporary-public installer portal-only, immutable, and secret-safe", () => {
    const result = spawnSync("bash", ["-n", portalOnlyInstallerPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(portalOnlySource).toContain('readonly SOURCE_BRANCH="main"');
    expect(portalOnlySource).toContain('CURRENT_MAIN_COMMIT="$(GIT_TERMINAL_PROMPT=0 git ls-remote');
    expect(portalOnlySource).toContain('prompt_required "Reviewed 40-character Portal commit SHA to install"');
    expect(portalOnlySource).toContain('[[ "$RELEASE_COMMIT" == "$CURRENT_MAIN_COMMIT" ]]');
    expect(portalOnlySource).toContain("verify_current_main_still_selected() {");
    expect(portalOnlySource).toContain('[[ "$latest_main_commit" == "$RELEASE_COMMIT" ]]');
    expect(portalOnlySource).toContain("The public ${SOURCE_BRANCH} candidate changed after review.");
    expect(portalOnlySource).toContain("verify_current_main_still_selected\n  checkout_reviewed_source\n  capture_cloudflare_token");
    expect(portalOnlySource).toContain('git -C "$SOURCE_DIR" fetch --depth=1 origin "$RELEASE_COMMIT"');
    expect(portalOnlySource).toContain('[[ "${resolved,,}" == "$RELEASE_COMMIT" ]]');
    expect(portalOnlySource).toContain('! find "$SOURCE_DIR/drizzle/migrations" -maxdepth 1 -name \'*.sql\' ! -type f -print -quit');
    expect(portalOnlySource).toContain('EXPECTED_MIGRATION_COUNT="$(find "$SOURCE_DIR/drizzle/migrations"');
    expect(portalOnlySource).toContain('Applied ${EXPECTED_MIGRATION_COUNT} migration(s); 48 critical tables verified.');
    expect(portalOnlySource).toContain('read -r -s -p "Cloudflare Origin CA token: " token');
    expect(portalOnlySource).toContain('shred -u -- "$TOKEN_FILE"');
    expect(portalOnlySource).toContain('--portal-alias "$alias"');
    expect(portalOnlySource).toContain('is_reserved_marketing_host "$DOMAIN"');
    expect(portalOnlySource).toContain('is_reserved_marketing_host "$alias"');
    expect(portalOnlySource).toContain('node /opt/readypackets/dist/create-admin.js');
    expect(portalOnlySource).toContain('verify-public-connectivity.sh');
    expect(portalOnlySource).toContain('case "${VERSION_ID:-}" in');
    expect(portalOnlySource).toContain('24.04|26.04) ;;');
    expect(portalOnlySource).toContain("supports a new Ubuntu 24.04 or 26.04 LTS VPS only");
    expect(portalOnlySource).toContain("/var/lib/mysql/readypackets");
    expect(portalOnlySource).toContain("getent passwd readypackets");
    expect(portalOnlySource).toContain("INFORMATION_SCHEMA.SCHEMATA");
    expect(portalOnlySource).toContain("mysql.user WHERE User = 'readypackets'");
    expect(portalOnlySource).not.toContain('readonly RELEASE_COMMIT="ae5bb1ef039cdb0826ed4721ee9b252ca06f9d72"');
    expect(portalOnlySource).not.toContain("--public-domain");
    expect(portalOnlySource).not.toContain("git clone");
  });
});
