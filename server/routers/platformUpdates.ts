import { spawn } from "node:child_process";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { platformUpgradeRuns } from "../db/schema.js";
import { router, adminProcedure } from "../trpc/trpc.js";
import { decryptField, encryptField } from "../security/crypto.js";
import { getSetting, setSetting } from "../services/settings.js";
import { recordActivity } from "../observability/audit.js";

const UPDATE_CONTROL = "/usr/local/sbin/readypackets-platform-update";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/;
const SHA_RE = /^[a-f0-9]{40}$/;

type HelperStatus = { currentCommit: string; serviceActive: boolean };
type HelperApply = { status: "completed"; snapshot: string; targetCommit: string };
type HelperRollback = { status: "rolled_back"; snapshot: string };

function runUpdateControl(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", UPDATE_CONTROL, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Update control exited with ${code}`)));
    child.stdin.end(stdin ?? "");
  });
}

function parseHelper<T>(output: string): T {
  try { return JSON.parse(output) as T; } catch { throw new Error("The platform update helper returned an invalid response."); }
}

function scanRemote(repository: string, branch: string, pat: string, currentCommit: string): Promise<{ targetCommit: string; changedFiles: string[]; summary: { filesChanged: number; insertions: number; deletions: number }; riskSummary: { highRiskPaths: string[]; dependencyFilesChanged: boolean; migrationFilesChanged: boolean; deploymentFilesChanged: boolean } }> {
  return new Promise((resolve, reject) => {
    const script = `
      set -Eeuo pipefail
      repo="$1"; branch="$2"; token="$3"; current="$4"
      work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
      header="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 -w0)"
      export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$header"
      git clone --quiet --no-checkout --filter=blob:none "https://github.com/$repo.git" "$work/repo"
      cd "$work/repo"
      git fetch --quiet origin "$branch"
      target="$(git rev-parse FETCH_HEAD)"
      git fetch --quiet origin "$current" 2>/dev/null || true
      if git cat-file -e "$current^{commit}" 2>/dev/null; then base="$current"; else base="$(git merge-base "$target" "$(git rev-list --max-parents=0 "$target" | tail -n 1)")"; fi
      stats="$(git diff --shortstat "$base" "$target" || true)"
      files="$(git diff --name-only "$base" "$target" | head -n 500)"
      printf '%s\n' "$target"
      printf '%s\n' "$stats"
      printf '%s\n' --FILES--
      printf '%s\n' "$files"
    `;
    const child = spawn("bash", ["-c", script, "--", repository, branch, pat, currentCommit], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || "GitHub scan failed."));
      const [targetCommit = "", stats = "", , ...files] = stdout.trimEnd().split("\n");
      if (!SHA_RE.test(targetCommit)) return reject(new Error("GitHub did not return a valid commit."));
      const parsed = stats.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
      const changedFiles = files.filter(Boolean).slice(0, 500);
      const highRiskPaths = changedFiles.filter((file) => /^(server\/security\/|server\/auth\/|deploy\/|drizzle\/migrations\/|docker-compose|Dockerfile|package\.json|pnpm-lock\.yaml)/.test(file));
      resolve({
        targetCommit,
        changedFiles,
        summary: { filesChanged: Number(parsed?.[1] ?? changedFiles.length), insertions: Number(parsed?.[2] ?? 0), deletions: Number(parsed?.[3] ?? 0) },
        riskSummary: { highRiskPaths, dependencyFilesChanged: changedFiles.some((file) => /(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(file)), migrationFilesChanged: changedFiles.some((file) => file.startsWith("drizzle/migrations/")), deploymentFilesChanged: changedFiles.some((file) => file.startsWith("deploy/") || file === "Dockerfile" || file === "docker-compose.yml") },
      });
    });
  });
}

const repositoryInput = z.object({ repository: z.string().trim().regex(REPO_RE, "Use owner/repository."), branch: z.string().trim().regex(BRANCH_RE, "Invalid branch name.").default("main"), pat: z.string().trim().min(20).max(512).optional() });

export const platformUpdatesRouter = router({
  settings: adminProcedure.query(async () => ({
    repository: await getSetting("platform_upgrade.repository") ?? "",
    branch: await getSetting("platform_upgrade.branch") ?? "main",
    hasToken: Boolean(await getSetting("platform_upgrade.github_pat_enc")),
    status: await runUpdateControl(["status"]).then(parseHelper<HelperStatus>).catch(() => ({ currentCommit: "unknown", serviceActive: false })),
  })),
  saveSettings: adminProcedure.input(repositoryInput).mutation(async ({ ctx, input }) => {
    await setSetting("platform_upgrade.repository", input.repository, { category: "platform_upgrade", userId: ctx.session.user.id });
    await setSetting("platform_upgrade.branch", input.branch, { category: "platform_upgrade", userId: ctx.session.user.id });
    if (input.pat) await setSetting("platform_upgrade.github_pat_enc", encryptField(input.pat, "platform_upgrade.github_pat"), { category: "platform_upgrade", isSecret: true, userId: ctx.session.user.id });
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_upgrade.settings_saved", entityType: "platform_upgrade", entityId: 0, severity: "warning", summary: "Administrator updated private repository upgrade settings", changes: { repository: input.repository, branch: input.branch, tokenUpdated: Boolean(input.pat) }, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),
  list: adminProcedure.query(async () => db.select().from(platformUpgradeRuns).orderBy(desc(platformUpgradeRuns.createdAt)).limit(100)),
  scan: adminProcedure.input(z.object({ repository: z.string().trim().regex(REPO_RE).optional(), branch: z.string().trim().regex(BRANCH_RE).optional() })).mutation(async ({ ctx, input }) => {
    const repository = input.repository ?? await getSetting("platform_upgrade.repository");
    const branch = input.branch ?? await getSetting("platform_upgrade.branch") ?? "main";
    const encryptedPat = await getSetting("platform_upgrade.github_pat_enc");
    const pat = decryptField(encryptedPat, "platform_upgrade.github_pat");
    if (!repository || !REPO_RE.test(repository) || !pat) throw new Error("Save a private repository and access token before scanning for changes.");
    const status = await runUpdateControl(["status"]).then(parseHelper<HelperStatus>);
    const scan = await scanRemote(repository, branch, pat, status.currentCommit);
    const [result] = await db.insert(platformUpgradeRuns).values({ repository, branch, fromCommit: status.currentCommit, targetCommit: scan.targetCommit, changedFiles: scan.changedFiles, scanSummary: scan.summary, riskSummary: scan.riskSummary, scannedByUserId: ctx.session.user.id });
    const id = Number((result as { insertId: number }).insertId);
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_upgrade.scanned", entityType: "platform_upgrade", entityId: id, severity: scan.riskSummary.highRiskPaths.length ? "warning" : "info", summary: `Scanned ${repository}@${branch} for release ${scan.targetCommit.slice(0, 12)}`, changes: { filesChanged: scan.summary.filesChanged, highRiskFiles: scan.riskSummary.highRiskPaths }, ipAddress: ctx.clientIp });
    return { id, ...scan, fromCommit: status.currentCommit };
  }),
  approve: adminProcedure.input(z.object({ id: z.number().int().positive(), confirmation: z.string().trim().min(10).max(128) })).mutation(async ({ ctx, input }) => {
    const [run] = await db.select().from(platformUpgradeRuns).where(eq(platformUpgradeRuns.id, input.id)).limit(1);
    if (!run || run.status !== "scanned") throw new Error("Only a newly scanned release can be approved.");
    if (input.confirmation !== `APPROVE ${run.targetCommit.slice(0, 12)}`) throw new Error(`Type APPROVE ${run.targetCommit.slice(0, 12)} to approve this exact release.`);
    await db.update(platformUpgradeRuns).set({ status: "approved", approvedByUserId: ctx.session.user.id, approvedAt: new Date() }).where(eq(platformUpgradeRuns.id, input.id));
    void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_upgrade.approved", entityType: "platform_upgrade", entityId: input.id, severity: "warning", summary: `Administrator approved ${run.targetCommit.slice(0, 12)} for upgrade`, ipAddress: ctx.clientIp });
    return { ok: true as const };
  }),
  execute: adminProcedure.input(z.object({ id: z.number().int().positive(), confirmation: z.string().trim().min(10).max(128) })).mutation(async ({ ctx, input }) => {
    const [run] = await db.select().from(platformUpgradeRuns).where(eq(platformUpgradeRuns.id, input.id)).limit(1);
    if (!run || run.status !== "approved") throw new Error("Only an approved release can be installed.");
    if (input.confirmation !== `UPGRADE ${run.targetCommit.slice(0, 12)}`) throw new Error(`Type UPGRADE ${run.targetCommit.slice(0, 12)} to install this exact release.`);
    const pat = decryptField(await getSetting("platform_upgrade.github_pat_enc"), "platform_upgrade.github_pat");
    if (!pat) throw new Error("The encrypted GitHub token is unavailable. Save it again before upgrading.");
    await db.update(platformUpgradeRuns).set({ status: "running", startedAt: new Date() }).where(eq(platformUpgradeRuns.id, input.id));
    await setSetting("maintenance.enabled", "true", { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id });
    try {
      const output = await runUpdateControl(["apply", String(run.id), run.repository, run.branch, run.targetCommit], `${pat}\n`);
      const applied = parseHelper<HelperApply>(output);
      await db.update(platformUpgradeRuns).set({ status: "completed", rollbackSnapshot: applied.snapshot, output: output.slice(0, 12_000), completedAt: new Date() }).where(eq(platformUpgradeRuns.id, input.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_upgrade.completed", entityType: "platform_upgrade", entityId: input.id, severity: "warning", summary: `Installed approved release ${run.targetCommit.slice(0, 12)}`, ipAddress: ctx.clientIp });
      return { ok: true as const, restarted: true };
    } catch (error) {
      await db.update(platformUpgradeRuns).set({ status: "failed", output: String(error instanceof Error ? error.message : error).slice(0, 12_000), completedAt: new Date() }).where(eq(platformUpgradeRuns.id, input.id));
      await setSetting("maintenance.enabled", "false", { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id });
      throw error;
    }
  }),
  rollback: adminProcedure.input(z.object({ id: z.number().int().positive(), confirmation: z.string().trim().min(10).max(128) })).mutation(async ({ ctx, input }) => {
    const [run] = await db.select().from(platformUpgradeRuns).where(and(eq(platformUpgradeRuns.id, input.id), eq(platformUpgradeRuns.status, "completed"))).limit(1);
    if (!run) throw new Error("Only a completed platform upgrade can be rolled back.");
    if (input.confirmation !== `ROLLBACK ${run.id}`) throw new Error(`Type ROLLBACK ${run.id} to restore the pre-upgrade application and database snapshot.`);
    await setSetting("maintenance.enabled", "true", { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id });
    try {
      const output = await runUpdateControl(["rollback", String(run.id)]);
      const restored = parseHelper<HelperRollback>(output);
      await db.update(platformUpgradeRuns).set({ status: "rolled_back", rolledBackByUserId: ctx.session.user.id, rolledBackAt: new Date(), output: output.slice(0, 12_000) }).where(eq(platformUpgradeRuns.id, input.id));
      void recordActivity({ actorUserId: ctx.session.user.id, actorRole: "admin", action: "platform_upgrade.rolled_back", entityType: "platform_upgrade", entityId: input.id, severity: "warning", summary: `Restored pre-upgrade snapshot for run ${run.id}`, changes: { snapshot: restored.snapshot }, ipAddress: ctx.clientIp });
      return { ok: true as const, restarted: true };
    } catch (error) {
      await setSetting("maintenance.enabled", "false", { category: "maintenance", valueType: "boolean", userId: ctx.session.user.id });
      throw error;
    }
  }),
});
