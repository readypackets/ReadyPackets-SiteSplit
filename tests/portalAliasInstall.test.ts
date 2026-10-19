import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const nativeInstaller = resolve(root, "deploy/install.sh");
const unifiedInstaller = resolve(root, "deploy/unified-install.sh");
const bootstrapInstaller = resolve(root, "deploy/github-bootstrap-install.sh");
const masterInstaller = resolve(root, "deploy/master-install.sh");
const nginxTemplate = resolve(root, "deploy/nginx.conf");
const connectivityVerifier = resolve(root, "deploy/verify-public-connectivity.sh");
const certificateController = resolve(root, "deploy/certificate-control-daemon.mjs");
const upgradeController = resolve(root, "deploy/platform-upgrade-control.sh");
const restoreScript = resolve(root, "deploy/restore.sh");
const configMigration = resolve(root, "deploy/config-migration.sh");

const nativeSource = readFileSync(nativeInstaller, "utf8");
const unifiedSource = readFileSync(unifiedInstaller, "utf8");
const bootstrapSource = readFileSync(bootstrapInstaller, "utf8");
const masterSource = readFileSync(masterInstaller, "utf8");
const nginxSource = readFileSync(nginxTemplate, "utf8");
const verifierSource = readFileSync(connectivityVerifier, "utf8");
const certificateSource = readFileSync(certificateController, "utf8");
const upgradeSource = readFileSync(upgradeController, "utf8");
const restoreSource = readFileSync(restoreScript, "utf8");
const configMigrationSource = readFileSync(configMigration, "utf8");

describe("explicit portal aliases", () => {
  it("keeps every deployment control script syntactically valid", () => {
    for (const script of [nativeInstaller, unifiedInstaller, bootstrapInstaller, masterInstaller, connectivityVerifier, upgradeController, restoreScript, configMigration]) {
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
    }
    const controller = spawnSync("node", ["--check", certificateController], { encoding: "utf8" });
    expect(controller.status, controller.stderr).toBe(0);
  });

  it("requires aliases to be explicit, bounded, normalized, and outside the separate public website boundary", () => {
    expect(nativeSource).toContain('--portal-alias)  PORTAL_ALIAS_INPUTS+=("${2:-}")');
    expect(nativeSource).toContain("At most five explicit --portal-alias values are permitted.");
    expect(nativeSource).toContain("Preserve aliases from the protected environment unless the operator explicitly");
    expect(nativeSource).toContain("grep -m1 '^PORTAL_ALIASES='");
    expect(nativeSource).toContain('DOMAIN="${DOMAIN,,}"');
    expect(nativeSource).toContain('requested_alias="${requested_alias,,}"');
    expect(nativeSource).toContain('[[ "$1" == "readypackets.com" || "$1" == "www.readypackets.com" ]]');
    expect(nativeSource).toContain("cannot be a portal alias");
    expect(nativeSource).toContain("--portal-alias must differ from --public-domain");
    expect(nativeSource).not.toContain("server_name _ $host");
  });

  it("keeps the canonical origin as the only portal application origin while Nginx redirects aliases before cookies reach Node", () => {
    expect(nativeSource).toContain('APP_ALLOWED_ORIGINS="https://${DOMAIN}"');
    expect(nativeSource).toContain("PORTAL_ALIASES=${PORTAL_ALIASES_CSV}");
    expect(nativeSource).toContain("Portal aliases are edge redirects only.");
    expect(nginxSource).toContain("__RP_PORTAL_ALIAS_SERVER_NAMES__");
    expect(nginxSource).toContain("__RP_APP_SERVER_NAMES__");
    expect(nginxSource).toContain("https://__RP_CANONICAL_DOMAIN__$request_uri");
    expect(nginxSource).not.toContain("https://$host$request_uri");
    expect(nginxSource).toContain("listen 80 default_server;");
    expect(nginxSource).toContain("return 421;");
  });

  it("includes every approved hostname in certificate SAN, HTTP-01, and strict Nginx host controls", () => {
    expect(nativeSource).toContain('ALL_ROUTED_HOSTS=("$DOMAIN" "${PORTAL_ALIAS_HOSTS[@]}")');
    expect(nativeSource).toContain('local -a hostnames=("${ALL_ROUTED_HOSTS[@]}")');
    expect(nativeSource).toContain('local -a certificate_hosts=("${ALL_ROUTED_HOSTS[@]}")');
    expect(nativeSource).toContain("jq -n '$ARGS.positional' --args \"${certificate_hosts[@]}\"");
    expect(nativeSource).toContain('EPHEMERAL_SECRET_PATHS+=("$work")');
    expect(nativeSource).toContain('trap cleanup_ephemeral_secret_paths EXIT');
    expect(nativeSource).toContain('for certificate_hostname in "${ALL_ROUTED_HOSTS[@]:1}"; do');
    expect(nativeSource).toContain('acme_hostnames=("${ALL_ROUTED_HOSTS[@]}")');
    expect(nativeSource).toContain('s/__RP_PORTAL_ALIAS_SERVER_NAMES__/${PORTAL_ALIAS_SERVER_NAMES}/g');
    expect(nativeSource).toContain('s/__RP_APP_HOST_REGEX__/${APP_HOST_ALLOWLIST_REGEX}/g');
  });

  it("renders the documented portal alias without mistaking it for a surviving template hostname", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
          set -Eeuo pipefail
          template="$1"
          rendered="$(mktemp)"
          trap 'rm -f "$rendered"' EXIT
          canonical="my.readypackets.com"
          alias="portal.readypackets.com"
          sed -e "s/portal\\.readypackets\\.com/\${canonical}/g" \\
              -e "s/__RP_HTTP_SERVER_NAMES__/\${canonical} \${alias}/g" \\
              -e "s/__RP_PORTAL_ALIAS_SERVER_NAMES__/\${alias}/g" \\
              -e "s/__RP_APP_SERVER_NAMES__/\${canonical}/g" \\
              -e "s/__RP_CANONICAL_DOMAIN__/\${canonical}/g" \\
              -e 's/__RP_APP_HOST_REGEX__/my\\\\.readypackets\\\\.com/g' \\
              -e 's|# __RP_MORE_CLEAR_HEADERS__|# headers-more unavailable|g' \\
              "$template" > "$rendered"
          ! grep -q '__RP_' "$rendered"
          routed=("$canonical" "$alias")
          template_hostname="portal.readypackets.com"
          template_hostname_is_routed="false"
          for configured_hostname in "\${routed[@]}"; do
            if [[ "$configured_hostname" == "$template_hostname" ]]; then
              template_hostname_is_routed="true"
              break
            fi
          done
          if [[ "$template_hostname_is_routed" == "false" ]] \\
             && grep -qE '(^|[^.[:alnum:]-])portal\\.readypackets\\.com' "$rendered"; then
            echo 'template guard would incorrectly reject a configured alias' >&2
            exit 1
          fi
          grep -F 'server_name portal.readypackets.com;' "$rendered" >/dev/null
          grep -F 'return 308 https://my.readypackets.com$request_uri;' "$rendered" >/dev/null
        `,
        "bash",
        nginxTemplate,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(nativeSource).toContain('local template_hostname="portal.readypackets.com"');
    expect(nativeSource).toContain('local template_hostname_is_routed="false"');
    expect(nativeSource).toContain('for configured_hostname in "${ALL_ROUTED_HOSTS[@]}"; do');
  });

  it("requires bounded local portal readiness before claiming a fresh installation succeeded", () => {
    expect(nativeSource).toContain("readiness_attempts=20");
    expect(nativeSource).toContain("readiness_delay_seconds=2");
    expect(nativeSource).toContain("--noproxy '*' --fail --silent --show-error");
    expect(nativeSource).toContain("http://127.0.0.1:3000/api/health/ready");
    expect(nativeSource).toContain("journalctl -u readypackets -b -n 80 --no-pager || true");
    expect(nativeSource).toContain("The portal service is not locally ready. Installation stopped before reporting success");
    expect(nativeSource).not.toContain('warn "The readiness probe failed. Check: journalctl -u readypackets -n 50"');
  });

  it("serializes Cloudflare Origin CA certificate hostnames as JSON data, not jq program text", () => {
    for (const hostnames of [["my.readypackets.com"], ["my.readypackets.com", "portal.readypackets.com"]]) {
      const result = spawnSync("jq", ["-n", "$ARGS.positional", "--args", ...hostnames], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(hostnames);
    }
  });

  it("forwards aliases through both fresh-server installer entrypoints and exposes the guided DNS/TLS requirement", () => {
    expect(unifiedSource).toContain('--portal-alias) PORTAL_ALIASES+=("${2:-}")');
    expect(unifiedSource).toContain('args+=(--portal-alias "$portal_alias")');
    expect(bootstrapSource).toContain('--portal-alias) PORTAL_ALIASES+=("${2:-}")');
    expect(bootstrapSource).toContain('installer+=(--portal-alias "$portal_alias")');
    expect(masterSource).toContain("Additional portal aliases, comma-separated");
    expect(masterSource).toContain('command+=(--portal-alias "$portal_alias")');
    expect(masterSource).toContain("Every listed alias must have DNS pointed to this VPS");
    expect(verifierSource).toContain('--portal-alias) PORTAL_ALIASES+=("${2:-}")');
    expect(verifierSource).toContain("Portal alias redirect: PASS");
    expect(verifierSource).toContain('expected="https://${DOMAIN}/api/health"');
  });

  it("does not silently drop aliases from certificate controls, upgrades, or portable restores", () => {
    expect(certificateSource).toContain("function configuredPortalHostnames()");
    expect(certificateSource).toContain('envValue(safeRead(APP_ENV), "PORTAL_ALIASES")');
    expect(certificateSource).toContain("does not cover every configured portal hostname");
    expect(certificateSource).toContain("Canonical-domain changes are blocked while PORTAL_ALIASES is configured");
    expect(upgradeSource).toContain('RUNTIME_PORTAL_ALIASES=()');
    expect(upgradeSource).toContain('installer_args+=(--portal-alias "$alias")');
    expect(restoreSource).toContain("PUBLIC_SITE_URL ALLOWED_ORIGINS PORTAL_ALIASES");
    expect(configMigrationSource).toContain("APP_URL PUBLIC_SITE_URL ALLOWED_ORIGINS PORTAL_ALIASES");
  });
});
