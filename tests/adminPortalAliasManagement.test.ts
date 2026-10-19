import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const controllerPath = resolve(root, "deploy/certificate-control-daemon.mjs");
const nginxPath = resolve(root, "deploy/nginx.conf");
const installerPath = resolve(root, "deploy/install.sh");
const servicePath = resolve(root, "deploy/readypackets-certificate-control.service");
const routerPath = resolve(root, "server/routers/adminSecurity.ts");
const systemPagePath = resolve(root, "client/src/pages/admin/System.tsx");

const controller = readFileSync(controllerPath, "utf8");
const nginx = readFileSync(nginxPath, "utf8");
const installer = readFileSync(installerPath, "utf8");
const service = readFileSync(servicePath, "utf8");
const router = readFileSync(routerPath, "utf8");
const systemPage = readFileSync(systemPagePath, "utf8");

function between(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("post-install portal alias administration", () => {
  it("keeps privileged controller and native installer syntax valid", () => {
    const controllerCheck = spawnSync("node", ["--check", controllerPath], { encoding: "utf8" });
    expect(controllerCheck.status, controllerCheck.stderr).toBe(0);
    const installerCheck = spawnSync("bash", ["-n", installerPath], { encoding: "utf8" });
    expect(installerCheck.status, installerCheck.stderr).toBe(0);
  });

  it("adds aliases only through typed, bounded, reserved-host-aware root actions", () => {
    expect(controller).toContain("const MAX_PORTAL_ALIASES = 5");
    expect(controller).toContain('new Set(["readypackets.com", "www.readypackets.com"])');
    expect(controller).toContain("function addablePortalAlias(input)");
    expect(controller).toContain("A portal alias must differ from the canonical portal hostname.");
    expect(controller).toContain("A portal alias must differ from the configured public website hostname.");
    expect(controller).toContain("That portal alias is already configured.");
    expect(controller).toContain("already reserved by an active Nginx virtual host");
    expect(controller).toContain('value.action === "add-portal-alias-letsencrypt"');
    expect(controller).toContain('value.action === "add-portal-alias-cloudflare"');
    expect(controller).toContain('value.confirmation !== "ADD PORTAL ALIAS"');
  });

  it("keeps a pending ACME alias out of TLS routing until SAN validation completes", () => {
    expect(controller).toContain("httpAliases = aliases");
    expect(controller).toContain("aliases: proposed.aliases.filter((alias) => alias !== proposed.alias)");
    expect(controller).toContain("httpAliases: proposed.aliases");
    expect(controller).toContain('"--expand", "--keep-until-expiring"');
    expect(controller).toContain("Let's Encrypt did not issue a certificate covering every configured portal hostname.");
    expect(controller).toContain("verifyAliasRedirect(proposed.alias, proposed.canonical)");
  });

  it("requires replacement Cloudflare material to cover every routed TLS hostname without storing keys in application settings", () => {
    expect(controller).toContain("function certificateHostnames(");
    expect(controller).toContain("validateCloudflare({ hostnames: certificateHostnames(proposed)");
    expect(controller).toContain('"-checkend", "0"');
    expect(controller).toContain("writeAtomic(`${CLOUDFLARE_DIRECTORY}/private-key.pem`, input.privateKey, 0o600)");
    expect(controller).toContain("backupPortalAliasMaterial");
    expect(controller).toContain("restorePortalAliasMaterial(backup)");
    expect(controller).not.toContain("exec(");
  });

  it("gives aliases their own direct-return TLS server and fails closed for unknown TLS SNI", () => {
    const defaultTls = between(nginx, "# Nginx selects a TLS virtual host", "# Explicit portal aliases");
    const aliasTls = between(nginx, "# Explicit portal aliases", "server {\n    # HTTP/2 is enabled");
    const aliasDirectives = aliasTls.replace(/^\s*#.*$/gm, "");
    expect(defaultTls).toContain("listen 443 ssl http2 default_server;");
    expect(defaultTls).toContain("return 421;");
    expect(aliasTls).toContain("server_name __RP_PORTAL_ALIAS_SERVER_NAMES__;");
    expect(aliasTls).toContain("return 308 https://__RP_CANONICAL_DOMAIN__$request_uri;");
    expect(aliasDirectives).not.toContain("proxy_pass");
    expect(nginx).toContain("server_name __RP_APP_SERVER_NAMES__;");
    expect(nginx).toContain("__RP_APP_HOST_REGEX__");
    expect(installer).toContain('s/__RP_PORTAL_ALIAS_SERVER_NAMES__/${PORTAL_ALIAS_SERVER_NAMES}/g');
    expect(installer).toContain("PORTAL_ALIAS_SERVER_NAMES='\"\"'");
    expect(controller).toContain('["__RP_PORTAL_ALIAS_SERVER_NAMES__", aliases.length ? aliases.join(" ") : \'""\']');
    expect(installer).toContain('s/__RP_APP_SERVER_NAMES__/${APP_SERVER_NAMES}/g');
  });

  it("provides audited admin mutations and an explicit console confirmation flow", () => {
    expect(router).toContain("addPortalAliasWithLetsEncrypt: adminProcedure");
    expect(router).toContain("addPortalAliasWithCloudflare: adminProcedure");
    expect(router).toContain("portal_alias.letsencrypt_added");
    expect(router).toContain("portal_alias.cloudflare_added");
    expect(router).toContain("portal_alias.letsencrypt_failed");
    expect(router).toContain("portal_alias.cloudflare_failed");
    expect(router).toContain("aliasesRemaining: number");
    expect(systemPage).toContain("Add a portal redirect alias");
    expect(systemPage).toContain("ADD PORTAL ALIAS");
    expect(systemPage).toContain("addPortalAliasWithLetsEncrypt");
    expect(systemPage).toContain("addPortalAliasWithCloudflare");
    expect(systemPage).toContain("Portal redirect aliases");
  });

  it("confines Certbot writes to the root controller’s explicit systemd write paths", () => {
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("/etc/letsencrypt");
    expect(service).toContain("/var/lib/letsencrypt");
    expect(service).toContain("/var/www/html");
  });
});
