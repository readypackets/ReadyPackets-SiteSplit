import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const nativeInstaller = resolve(root, "deploy/install.sh");
const controlledUpdater = resolve(root, "deploy/platform-upgrade-control.sh");
const publicExistingUpdater = resolve(root, "deploy/temporary-public-existing-vps-upgrade.sh");
const controlledService = resolve(root, "deploy/readypackets-platform-update-control.service");

const installerSource = readFileSync(nativeInstaller, "utf8");
const controlledSource = readFileSync(controlledUpdater, "utf8");
const publicSource = readFileSync(publicExistingUpdater, "utf8");
const controlledServiceSource = readFileSync(controlledService, "utf8");

function preservationBranch(source: string) {
  const start = source.indexOf('if [[ "$PRESERVE_RUNTIME_CONFIG" == "true" ]]; then\n  # A controlled existing-host upgrade');
  const end = source.indexOf('\nelse\n  log "Writing ${ENV_FILE}"', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("existing-VPS runtime configuration preservation", () => {
  it("keeps every update entrypoint syntactically valid and exposes a non-mutating help path", () => {
    for (const script of [nativeInstaller, controlledUpdater, publicExistingUpdater]) {
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
    }
    const help = spawnSync("bash", [publicExistingUpdater, "--help"], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("reviewed immutable commit");
    expect(help.stdout).toContain("preserves the existing");
  });

  it("preserves the root-owned complete runtime environment instead of serializing defaults on an existing-host update", () => {
    expect(installerSource).toContain('--preserve-runtime-config) PRESERVE_RUNTIME_CONFIG="true"');
    expect(installerSource).toContain("--preserve-runtime-config requires an existing regular");
    expect(installerSource).toContain("Refusing to preserve a runtime environment not owned by root.");
    expect(installerSource).toContain("Refusing to preserve a group- or world-writable runtime environment.");

    const branch = preservationBranch(installerSource);
    expect(branch).toContain("Preserving existing runtime configuration");
    expect(branch).toContain("SMTP, Graph/SharePoint, Stripe");
    expect(branch).toContain("forward-compatible unknown keys");
    expect(branch).not.toContain('cat > "$ENV_FILE"');
    expect(branch).not.toContain("sed -i");
    expect(branch).not.toContain("xargs");

    // The fresh-host default branch remains explicit, but it must never run when
    // the guarded update mode is selected.
    expect(installerSource).toContain('else\n  log "Writing ${ENV_FILE}"');
    expect(installerSource).toContain("STORAGE_DRIVER=local");
    expect(installerSource).toContain("SMTP_HOST=");
    expect(installerSource).toContain("SAML_ENABLED=false");
  });

  it("passes the preservation and no-seed contract through both supported existing-host update paths", () => {
    expect(controlledSource).toContain('--skip-packages --no-seed --preserve-runtime-config');
    expect(publicSource).toContain("--no-seed");
    expect(publicSource).toContain("--preserve-runtime-config");
    expect(installerSource).toContain("Preserving existing runtime configuration");
    expect(publicSource).toContain("protected runtime config preserved byte-for-byte");
    expect(installerSource).toContain("PRESERVE_RUNTIME_CONFIG=\"$REQUESTED_PRESERVE_RUNTIME_CONFIG\"");
  });

  it("uses immutable commits and an update lock rather than moving-branch deployment", () => {
    expect(publicSource).toContain('readonly SHA_RE=\'^[a-f0-9]{40}$\'');
    expect(publicSource).toContain("The branch tip changed after this release was reviewed.");
    expect(publicSource).toContain('git -C "$WORK_DIR/source" fetch --depth=1 origin "$COMMIT"');
    expect(publicSource).toContain("flock -n 9");
    expect(publicSource).toContain("UPGRADE READY PACKETS");
    expect(publicSource).not.toMatch(/git\s+pull|checkout\s+main/);
    expect(controlledSource).toContain("flock -n 9");
  });

  it("snapshots and restores configured database, proxy/TLS, systemd, and root-controller artifacts", () => {
    expect(controlledSource).toContain('mysqldump --single-transaction --routines --events -u root "$RUNTIME_DB_NAME"');
    expect(controlledSource).toContain('mysql -u root "$RUNTIME_DB_NAME"');
    for (const path of [
      "/etc/nginx/sites-available/readypackets",
      "/etc/readypackets/tls",
      "/etc/systemd/system/readypackets.service",
      "/etc/systemd/system/readypackets-platform-update-control.service",
      "/usr/local/sbin/readypackets-platform-update",
      "/usr/local/lib/readypackets/certificate-control-daemon.mjs",
    ]) {
      expect(controlledSource).toContain(path);
      expect(publicSource).toContain(path);
    }
    expect(controlledSource).toContain("host-paths.txt");
    expect(publicSource).toContain("host-paths.txt");
    expect(controlledSource).toContain("queue_platform_update_controller_restart");
    expect(publicSource).toContain("The pre-upgrade full backup and root-only rollback snapshot were retained.");
    expect(controlledServiceSource).toContain("/etc/nginx");
    expect(controlledServiceSource).toContain("/etc/letsencrypt");
    expect(controlledServiceSource).toContain("/etc/systemd/system");
    expect(controlledServiceSource).toContain("/usr/local");
    expect(controlledServiceSource).not.toContain("/etc/ufw");
  });

  it("keeps an independently hosted marketing URL out of a portal-only update’s application host list", () => {
    expect(controlledSource).toContain('RUNTIME_PORTAL_ONLY="$(runtime_env_value PORTAL_ONLY)"');
    expect(controlledSource).toContain('if [[ "$RUNTIME_PORTAL_ONLY" != "true" && -n "$public_site_url" ]]; then');
    expect(publicSource).toContain('if [[ "$portal_only" != "true" && -n "$public_site_url" ]]; then');
  });

  it("does not print or accept runtime secrets in the public existing-VPS updater", () => {
    expect(publicSource).not.toMatch(/cat\s+.*portal\.env|printenv|set\s+-x/);
    expect(publicSource).not.toContain("--token");
    expect(publicSource).not.toContain("GITHUB_PAT");
    expect(publicSource).toContain("Never echo its contents");
    expect(publicSource).toContain("authpriv.notice");
  });
});
