import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const installerSource = readFileSync(resolve(root, "deploy/install.sh"), "utf8");
const runnerSource = readFileSync(resolve(root, "deploy/migrate-legacy-combined-platform.sh"), "utf8");
const nginxBinary = "/usr/sbin/nginx";
const canRunNginxIntegration = existsSync(nginxBinary) && existsSync("/usr/bin/openssl") && existsSync("/usr/bin/curl");

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

describe("Nginx controlled maintenance gate", () => {
  it("uses an unconditional edge response and keeps readiness off the public proxy", () => {
    expect(installerSource).toContain("# Controlled ReadyPackets maintenance mode. All edge requests return 503.");
    expect(installerSource).toContain("return 503;");
    expect(installerSource).toContain("the direct loopback Node listener, not public Nginx");
    expect(installerSource).not.toContain("Only health probes remain reachable.");
    expect(runnerSource).toContain("# Controlled ReadyPackets maintenance mode. All edge requests return 503.");
    expect(runnerSource).toContain("curl -q --noproxy '*' --insecure --silent --show-error");
    expect(runnerSource).toContain('502/0) probe_classification="upstream_fallthrough"');
  });

  it.skipIf(!canRunNginxIntegration)("returns 503 from an isolated TLS edge even when the configured upstream is unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "readypackets-nginx-maintenance-"));
    const port = 42000 + Math.floor(Math.random() * 1000);
    const deadUpstreamPort = port + 1000;
    const config = join(directory, "nginx.conf");
    const certificate = join(directory, "certificate.pem");
    const privateKey = join(directory, "private-key.pem");
    const gate = join(directory, "maintenance-mode.conf");
    const clientBodyTemp = join(directory, "client-body-temp");
    const proxyTemp = join(directory, "proxy-temp");
    const fastcgiTemp = join(directory, "fastcgi-temp");
    const uwsgiTemp = join(directory, "uwsgi-temp");
    const scgiTemp = join(directory, "scgi-temp");

    try {
      mkdirSync(clientBodyTemp, { mode: 0o700 });
      mkdirSync(proxyTemp, { mode: 0o700 });
      mkdirSync(fastcgiTemp, { mode: 0o700 });
      mkdirSync(uwsgiTemp, { mode: 0o700 });
      mkdirSync(scgiTemp, { mode: 0o700 });
      run("/usr/bin/openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-keyout", privateKey, "-out", certificate,
        "-subj", "/CN=www.readypackets.test",
      ], directory);
      writeFileSync(gate, "# Controlled ReadyPackets maintenance mode. All edge requests return 503.\nreturn 503;\n", { mode: 0o600 });
      writeFileSync(config, `worker_processes 1;\nerror_log ${directory}/error.log notice;\npid ${directory}/nginx.pid;\nevents { worker_connections 16; }\nhttp {\n  access_log off;\n  client_body_temp_path ${clientBodyTemp};\n  proxy_temp_path ${proxyTemp};\n  fastcgi_temp_path ${fastcgiTemp};\n  uwsgi_temp_path ${uwsgiTemp};\n  scgi_temp_path ${scgiTemp};\n  server {\n    listen 127.0.0.1:${port} ssl;\n    server_name www.readypackets.test;\n    ssl_certificate ${certificate};\n    ssl_certificate_key ${privateKey};\n    include ${gate};\n    location / { proxy_pass http://127.0.0.1:${deadUpstreamPort}; }\n  }\n}\n`, { mode: 0o600 });
      run(nginxBinary, ["-t", "-p", directory, "-c", config], directory);
      run(nginxBinary, ["-p", directory, "-c", config], directory);
      const probe = spawnSync("/usr/bin/curl", [
        "-q", "--noproxy", "*", "--insecure", "--silent", "--show-error",
        "--connect-timeout", "2", "--max-time", "8", "--output", "/dev/null", "--write-out", "%{http_code}",
        "--resolve", `www.readypackets.test:${port}:127.0.0.1`,
        "-H", "Host: www.readypackets.test",
        `https://www.readypackets.test:${port}/`,
      ], { encoding: "utf8" });
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout).toBe("503");
    } finally {
      spawnSync(nginxBinary, ["-p", directory, "-c", config, "-s", "stop"], { encoding: "utf8" });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
