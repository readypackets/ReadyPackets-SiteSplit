import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const runner = resolve(root, "deploy/migrate-legacy-combined-platform.sh");
const installer = resolve(root, "deploy/install.sh");
const nginxTemplate = resolve(root, "deploy/nginx.conf");
const publicUpdater = resolve(root, "deploy/temporary-public-existing-vps-upgrade.sh");
const controlledUpdater = resolve(root, "deploy/platform-upgrade-control.sh");

const runnerSource = readFileSync(runner, "utf8");
const installerSource = readFileSync(installer, "utf8");
const nginxSource = readFileSync(nginxTemplate, "utf8");
const publicUpdaterSource = readFileSync(publicUpdater, "utf8");
const controlledUpdaterSource = readFileSync(controlledUpdater, "utf8");

describe("exact legacy combined-platform migration runner", () => {
  it("is syntactically valid and has a non-mutating help path", () => {
    for (const script of [runner, installer, publicUpdater, controlledUpdater]) {
      const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(syntax.status, `${script}: ${syntax.stderr}`).toBe(0);
    }
    const help = spawnSync("bash", [runner, "--help"], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("9f608821df78b3d003a349606390fa2b8340ac99");
    expect(help.stdout).toContain("--check performs read-only compatibility checks only");
    expect(help.stdout).toContain("reviewed immutable target SHA");
  });

  it("is restricted to the exact restored legacy release and expected schema transition", () => {
    expect(runnerSource).toContain('readonly LEGACY_RELEASE_COMMIT="9f608821df78b3d003a349606390fa2b8340ac99"');
    expect(runnerSource).toContain('readonly LEGACY_MIGRATION_COUNT="48"');
    expect(runnerSource).toContain('readonly TARGET_MIGRATION_COUNT="54"');
    expect(runnerSource).toContain('"$current_source_commit" == "$LEGACY_RELEASE_COMMIT"');
    expect(runnerSource).toContain('"$release_marker" == "$LEGACY_RELEASE_COMMIT"');
    expect(runnerSource).toContain('"$migration_count" == "$LEGACY_MIGRATION_COUNT"');
    expect(runnerSource).toContain('"$migration_files" == "$TARGET_MIGRATION_COUNT"');
    expect(runnerSource).toContain('"$migration_count" == "$TARGET_MIGRATION_COUNT"');
    expect(runnerSource).toContain("This runner is restricted to the restored all-in-one readypackets.com/www.readypackets.com host.");
    expect(runnerSource).toContain("This host already has portal-only topology; use the standard controlled updater instead.");
    expect(runnerSource).toContain("requires no configured portal aliases");
    expect(runnerSource).toContain("restored local-storage legacy topology");
  });

  it("requires an immutable target and rejects moving-branch deployment", () => {
    expect(runnerSource).toContain("readonly SHA_RE='^[a-f0-9]{40}$'");
    expect(runnerSource).toContain('git ls-remote --heads "https://github.com/${REPOSITORY}.git" "refs/heads/${BRANCH}"');
    expect(runnerSource).toContain('"$remote_branch" == "$TARGET_COMMIT"');
    expect(runnerSource).toContain('git -C "$WORK_DIR/source" fetch --depth=1 origin "$TARGET_COMMIT"');
    expect(runnerSource).toContain('"$resolved" == "$TARGET_COMMIT"');
    expect(runnerSource).toContain("flock -n 9");
    expect(runnerSource).toContain("MIGRATE LEGACY READY PACKETS");
    expect(runnerSource).not.toMatch(/git\s+pull|checkout\s+main/);
  });

  it("captures a complete quiescent rollback point and a separately verified full backup", () => {
    expect(runnerSource).toContain('safe_copy_tree "$APP_DIR" "${SNAPSHOT}/app"');
    expect(runnerSource).toContain('safe_copy_tree "$SOURCE_DIR" "${SNAPSHOT}/source"');
    expect(runnerSource).toContain('safe_copy_tree "$DATA_DIR" "${SNAPSHOT}/data"');
    expect(runnerSource).toContain('cp -a -- "$ENV_FILE" "${SNAPSHOT}/portal.env"');
    expect(runnerSource).toContain('mysqldump --single-transaction --routines --events -u root "$DB_NAME"');
    expect(runnerSource).toContain('gunzip -c "${SNAPSHOT}/database.sql.gz" | mysql --protocol=socket -u root "$DB_NAME"');
    expect(runnerSource).toContain('bash "${SOURCE_DIR}/deploy/backup.sh" --output "$backup_dir" --skip-sync');
    expect(runnerSource).toContain('"${SNAPSHOT}/verified-full-backup-name"');
    expect(runnerSource).toContain("/etc/nginx/sites-enabled/default");
    expect(runnerSource).toContain("/etc/readypackets/maintenance-mode.conf");
    expect(runnerSource).toContain("/etc/readypackets/tls");
    expect(runnerSource).toContain("/etc/systemd/system/readypackets.service");
    expect(runnerSource).toContain("/usr/local/sbin/readypackets-platform-update");
  });

  it("compares non-secret account/order/file preservation counters and rolls back on any failed mutation gate", () => {
    for (const counter of ["users", "admin_users", "password_hashes", "orders", "file_records"]) {
      expect(runnerSource).toContain(`CONCAT('${counter}=', COUNT(*))`);
    }
    expect(runnerSource).toContain('cmp -s "${SNAPSHOT}/preservation-counts.before" "${SNAPSHOT}/preservation-counts.after"');
    expect(runnerSource).toContain('if [[ "$status" -ne 0 && "$MUTATION_STARTED" == "true" && "$UPDATE_SUCCEEDED" != "true" ]]; then');
    expect(runnerSource).toContain("restore_snapshot || true");
    expect(runnerSource).toContain('safe_copy_tree "${SNAPSHOT}/data" "$DATA_DIR"');
    expect(runnerSource).toContain("restore_timer_state");
  });

  it("contains customer traffic and background side effects until verification has passed", () => {
    expect(runnerSource).toContain("systemctl disable --now \"$BACKUP_TIMER\"");
    expect(runnerSource).toContain("systemctl stop \"$SERVICE\"");
    expect(runnerSource).toContain("install_scheduler_hold");
    expect(runnerSource).toContain("Environment=INSTANCE_ROLE=web");
    expect(runnerSource).toContain("prepare_edge_maintenance_gate");
    expect(runnerSource).toContain('readonly NGINX_DEFAULT_SITE="/etc/nginx/sites-enabled/default"');
    expect(runnerSource).toContain('readonly TLS_INCLUDE="/etc/readypackets/tls/nginx-tls.conf"');
    expect(runnerSource).toContain('state=removed_ubuntu_default');
    expect(runnerSource).toContain("Nginx default-site symlink has an unexpected target");
    expect(runnerSource).toContain('openssl x509 -in "$certificate" -noout -checkhost "$hostname"');
    expect(runnerSource).toContain('The retained certificate does not cover ${hostname}');
    expect(runnerSource).toContain('NGINX_DIAGNOSTIC_FILE="${AUDIT_ROOT}/${RUN_ID}.nginx-gate.log"');
    expect(runnerSource).toContain('maintenance_gate.tls" "failed" "state=include_missing');
    expect(runnerSource).toContain('maintenance_gate.tls" "failed" "state=coverage_missing');
    expect(runnerSource).toContain('maintenance_gate.default_site" "failed" "state=not_symlink');
    expect(runnerSource).toContain('maintenance_gate.default_site" "failed" "state=unexpected_target');
    expect(runnerSource).toContain('maintenance_gate.render" "failed" "state=placeholder');
    expect(runnerSource).toContain('rendered_app_regex="${DOMAIN//./\\\\.}"');
    expect(runnerSource).toContain('expected_host_guard="    if (\\$host !~* ^(${rendered_app_regex})\\$) {"');
    expect(runnerSource).toContain('maintenance_gate.render" "failed" "state=host_guard');
    expect(runnerSource).toContain("maintenance_gate.nginx_test");
    expect(runnerSource).toContain("maintenance_gate.nginx_reload");
    expect(runnerSource).toContain("maintenance_gate.edge_probe");
    expect(runnerSource).toContain("# Controlled ReadyPackets maintenance mode. All edge requests return 503.");
    expect(runnerSource).toContain("# loopback Node listener, never through public Nginx while this gate is set.");
    expect(runnerSource).toContain('curl -q --noproxy \'*\' --insecure --silent --show-error');
    expect(runnerSource).toContain('--connect-timeout 2 --max-time 8');
    expect(runnerSource).toContain('-H "Host: ${DOMAIN}"');
    expect(runnerSource).toContain('class=${probe_classification}/http=${http_status}/curl=${curl_status}');
    expect(runnerSource).toContain('502/0) probe_classification="upstream_fallthrough"');
    expect(runnerSource).toContain("The temporary edge maintenance gate did not return HTTP 503 for ordinary traffic.");
    expect(runnerSource).toContain("--resolve \"${DOMAIN}:443:127.0.0.1\"");
    expect(runnerSource).toContain("--maintenance-mode");
    expect(runnerSource).toContain("remove_scheduler_hold");
    expect(runnerSource).toContain("restore_timer_state");
    expect(installerSource).toContain('--maintenance-mode) MAINTENANCE_MODE="true"');
    expect(installerSource).toContain("--maintenance-mode requires --preserve-runtime-config.");
    expect(installerSource).toContain('readonly REQUESTED_MAINTENANCE_MODE="$MAINTENANCE_MODE"');
    expect(installerSource).toContain('MAINTENANCE_MODE="$REQUESTED_MAINTENANCE_MODE"');
    expect(installerSource).toContain("write_maintenance_mode_include");
    expect(installerSource).toContain("All edge requests return 503.");
    expect(installerSource).toContain("the direct loopback Node listener, not public Nginx");
    expect(nginxSource).toContain("include /etc/readypackets/maintenance-mode.conf;");
    expect(nginxSource).toContain("returns 503 for every edge");
    expect(nginxSource).toContain("loopback Node");
  });

  it("limits the temporary combined-host exception and preserves normal fresh-install protections", () => {
    expect(installerSource).toContain('--allow-legacy-combined-host-transition) ALLOW_LEGACY_COMBINED_HOST_TRANSITION="true"');
    expect(installerSource).toContain("--allow-legacy-combined-host-transition requires --preserve-runtime-config.");
    expect(installerSource).toContain("--allow-legacy-combined-host-transition cannot be combined with --public-domain.");
    expect(installerSource).toContain("restricted to the retired readypackets.com/www.readypackets.com combined Portal topology.");
    expect(installerSource).toContain("legacy_combined_hostname_transition_allowed");
    expect(installerSource).toContain("is_reserved_public_website_hostname \"$DOMAIN\" && ! legacy_combined_hostname_transition_allowed");
  });

  it("writes only redacted structured audit metadata and never accepts or prints secrets", () => {
    expect(runnerSource).toContain("authpriv.notice");
    expect(runnerSource).toContain("readypackets-legacy-migration");
    expect(runnerSource).toContain("structured local audit trail contains only allowlisted operation metadata");
    expect(runnerSource).toContain("emits runtime configuration, customer data, passwords, tokens, or file paths.");
    expect(runnerSource).not.toMatch(/cat\s+.*portal\.env|printenv|set\s+-x/);
    expect(runnerSource).not.toContain("GITHUB_PAT");
    expect(runnerSource).not.toContain("--token");
  });

  it("keeps the maintenance artifact in routine update rollback snapshots", () => {
    expect(publicUpdaterSource).toContain("/etc/readypackets/maintenance-mode.conf");
    expect(controlledUpdaterSource).toContain("/etc/readypackets/maintenance-mode.conf");
  });
});
