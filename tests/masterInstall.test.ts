import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const installerPath = resolve(process.cwd(), "deploy/master-install.sh");
const source = readFileSync(installerPath, "utf8");

describe("guided portal master installer", () => {
  it("has valid Bash syntax and publishes a safe interactive-only help contract", () => {
    const syntax = spawnSync("bash", ["-n", installerPath], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);

    const help = spawnSync("bash", [installerPath, "--help"], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("guided master installer");
    expect(help.stdout).toContain("brand-new Ubuntu 24.04 LTS VPS only");
    expect(help.stdout).toContain("No GitHub personal-access token");
  });

  it("refuses existing deployments and requires a real interactive terminal", () => {
    expect(source).toContain('[[ -t 0 && -t 1 ]]');
    expect(source).toContain('for path in "$DEFAULT_PROJECT_DIR" /opt/readypackets /etc/readypackets /var/lib/readypackets');
    expect(source).toContain("systemctl cat readypackets.service");
    expect(source).toContain("will not overwrite a portal");
  });

  it("pins the source to a reviewed immutable commit through strict deploy-key transport", () => {
    expect(source).toContain("DEFAULT_REPOSITORY=\"readypackets/ReadyPackets-SiteSplit\"");
    expect(source).toContain("StrictHostKeyChecking=yes");
    expect(source).toContain("https://api.github.com/meta");
    expect(source).toContain("Reviewed 40-character Git commit SHA to deploy");
    expect(source).toContain('ask_required "Reviewed 40-character Git commit SHA to deploy"');
    expect(source).toContain('[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]');
    expect(source).toContain("git fetch --depth=1 origin \"$COMMIT\"");
    expect(source).toContain("git checkout --detach --force");
    expect(source).not.toContain("git checkout main");
  });

  it("keeps credential and administrator secrets out of command arguments", () => {
    expect(source).toContain('read -r -s -p "Cloudflare Origin CA token: " token');
    expect(source).toContain("CLOUDFLARE_API_TOKEN_FILE");
    expect(source).toContain("shred -u --");
    expect(source).toContain("--generate-password");
    expect(source).toContain("Store the generated password immediately");
    expect(source).not.toMatch(/--github-token|--cloudflare-token|GITHUB_PAT|github_pat_|ghp_/);
  });

  it("captures the required portal identity and requires typed preflight and install approval", () => {
    expect(source).toContain("ReadyPackets portal display name");
    expect(source).toContain("Dedicated portal hostname");
    expect(source).toContain("Initial administrator full name");
    expect(source).toContain("Initial administrator email");
    expect(source).toContain('DEFAULT_ADMIN_EMAIL="tools@readypackets.com"');
    expect(source).toContain('ask_default "Initial administrator email" "$DEFAULT_ADMIN_EMAIL"');
    expect(source).toContain("PREPARE DEPLOY KEY");
    expect(source).toContain("INSTALL READY PACKETS");
    expect(source).toContain("readypackets.com and www.readypackets.com are reserved for the separate public website");
  });
});
