import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const orderService = readFileSync(resolve(root, "server/services/orders.ts"), "utf8");
const sharepointService = readFileSync(resolve(root, "server/services/sharepoint.ts"), "utf8");
const platformSetupRouter = readFileSync(resolve(root, "server/routers/platformSetup.ts"), "utf8");
const defaultsHelper = resolve(root, "deploy/configure-phase-webhook-defaults.sh");
const helperSource = readFileSync(defaultsHelper, "utf8");

function functionBody(source: string, name: string) {
  const start = source.indexOf(`${name}() {`);
  expect(start, `Missing ${name} helper`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end, `Missing end of ${name} helper`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("phase webhook defaults and automatic delivery compatibility", () => {
  it("queues the worker-recognized webhook job type on automatic phase entry while delivering legacy queued work", () => {
    const enqueueStart = orderService.indexOf("export async function enqueuePhaseJobs");
    const enqueueEnd = orderService.indexOf("\nexport type OrderAttentionState", enqueueStart);
    expect(enqueueStart).toBeGreaterThanOrEqual(0);
    expect(enqueueEnd).toBeGreaterThan(enqueueStart);
    const enqueue = orderService.slice(enqueueStart, enqueueEnd);

    expect(enqueue).toContain('jobs.push({ jobType: "notify_webhooks" })');
    expect(enqueue).not.toContain('jobs.push({ jobType: "dispatch_webhooks" })');
    expect(sharepointService).toContain('case "notify_webhooks": case "dispatch_webhooks":');
    expect(sharepointService).toContain("await jobNotifyWebhooks(job.orderId, job.phase)");
  });

  it("is a root-only interactive helper with no URL command-line, environment, or source default", () => {
    const syntax = spawnSync("bash", ["-n", defaultsHelper], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);
    const help = spawnSync("bash", [defaultsHelper, "--help"], { encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("staging helper");
    expect(help.stdout).toContain("Do not provide them as command-line");

    expect(helperSource).toContain('[[ $EUID -eq 0 ]]');
    expect(helperSource).toContain('[[ -t 0 && -t 1 ]]');
    expect(helperSource).toContain('read -r -s -p "Enter P101 Make HTTPS destination: " P101_URL');
    expect(helperSource).toContain('read -r -s -p "Enter P201 Make HTTPS destination: " P201_URL');
    expect(helperSource).toContain('[[ $# -eq 0 ]]');
    expect(helperSource).toContain('unset P101_URL P201_URL');
    const bannedFirstPath = "hook.us2.make.com/" + ["y", "15"].join("");
    const bannedSecondPath = "hook.us2.make.com/" + ["p", "zt"].join("");
    expect(helperSource).not.toContain(bannedFirstPath);
    expect(helperSource).not.toContain(bannedSecondPath);
    expect(helperSource).not.toMatch(/set\s+-[^\n]*x/);
  });

  it("allows only reviewed Make HTTPS destinations and stages defaults disabled", () => {
    const validator = functionBody(helperSource, "validate_make_destination");
    expect(validator).toContain("https://hook\\.us2\\.make\\.com/");
    expect(validator).toContain("without credentials, query, or fragment");

    const insert = functionBody(helperSource, "insert_disabled_default");
    expect(insert).toContain("LOCK TABLES webhook_endpoints WRITE, activity_logs WRITE");
    expect(insert).toContain("WHERE NOT EXISTS");
    expect(insert).toContain("JSON_QUOTE('phase.start')");
    expect(insert).toContain("JSON_QUOTE('*')");
    expect(insert).toContain("NULL, 0, NULL");
    expect(insert).toContain("UNLOCK TABLES");
    expect(helperSource).toContain("STAGE PHASE WEBHOOK DEFAULTS");
    expect(helperSource).toContain("phase notification gates were not changed");
  });

  it("records only masked host/fingerprint provisioning evidence and preserves a concurrent operator route", () => {
    const stage = functionBody(helperSource, "stage_phase");
    expect(stage).toContain('record_result "$phase" "preserved_existing"');
    expect(stage).toContain('record_result "$phase" "staged"');
    expect(stage).toContain("A concurrent administrator save may have won");
    expect(stage).not.toContain('printf \'%s\\n\' "$url"');

    const record = functionBody(helperSource, "record_result");
    expect(record).toContain("urlHost");
    expect(record).toContain("urlFingerprint");
    expect(record).not.toContain("'url', '");
    expect(record).toContain("webhook.phase_default_");
    expect(helperSource).toContain("authpriv.notice");
  });

  it("keeps phase destination capability URLs out of newly exported secret-free setup profiles", () => {
    expect(platformSetupRouter).toContain('webhooks: { p101: { url: "", enabled: false }, p201: { url: "", enabled: false }');
    expect(platformSetupRouter).toContain("requiresDestinationConfiguration: Boolean(p101 || p201)");
    expect(platformSetupRouter).toContain("webhookDestinationConfigurationRequired");
  });
});
