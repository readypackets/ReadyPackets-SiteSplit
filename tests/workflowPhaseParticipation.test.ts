import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

function procedure(source: string, name: string, nextName: string) {
  const start = source.indexOf(`  ${name}: protectedProcedure`);
  const end = source.indexOf(`\n\n  ${nextName}:`, start);
  expect(start, `Missing ${name} procedure`).toBeGreaterThanOrEqual(0);
  expect(end, `Missing end of ${name} procedure`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("workflow phase participation", () => {
  it("allows the three authenticated order roles while rejecting unknown roles fail-closed", async () => {
    const router = await text("server/routers/orders.ts");

    expect(router).toContain('const workflowParticipantRoles = new Set(["customer", "staff", "admin"])');
    expect(router).toContain("function assertWorkflowParticipantRole(role: string): void");
    expect(router).toContain("Only authenticated customer, staff, or administrator accounts can complete a workflow phase.");
    expect(router).toContain('if (role === "admin") return "Administrator"');
    expect(router).toContain('if (role === "staff") return "Staff member"');
  });

  it("keeps order writability and configured guided-stage checks in front of submit and Next actions", async () => {
    const router = await text("server/routers/orders.ts");
    const submit = procedure(router, "submitWorkflowPhase", "advanceWorkflowStage");
    const advance = procedure(router, "advanceWorkflowStage", "workflowStageAccess");

    for (const source of [submit, advance]) {
      expect(source).toContain("assertWorkflowParticipantRole(ctx.session.user.role)");
      expect(source).toContain("assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role)");
      expect(source).toContain("assertCustomerWorkflowStageAccess(input.orderId, input.phaseKey)");
      expect(source).not.toContain('ctx.session.user.role !== "customer"');
      expect(source).not.toContain("Only customers can");
    }

    expect(submit).toContain("workflowActorLabel(ctx.session.user.role)");
    expect(submit).toContain("submitted and locked workflow phase");
    expect(advance).toContain("workflowActorLabel(ctx.session.user.role)");
    expect(advance).toContain("continued from workflow phase");
  });

  it("uses role-neutral phase lock copy in browser portal surfaces without widening the customer-only mobile API", async () => {
    const [workflowStage, legacyPhaseTwo, adminOrders, mobileContract, mobileParityContract] = await Promise.all([
      text("client/src/pages/portal/WorkflowStage.tsx"),
      text("client/src/pages/portal/Phase2Artifacts.tsx"),
      text("client/src/pages/admin/Orders.tsx"),
      text("server/http/mobile/openapi.yaml"),
      text("docs/mobile-native/MOBILE_CUSTOMER_PARITY_CONTRACT.md"),
    ]);

    expect(workflowStage).toContain("This locks all files, recordings, and answers in this phase.");
    expect(workflowStage).toContain("locks its files, recordings, and answers");
    expect(legacyPhaseTwo).toContain("This locks documents and recordings in this phase.");
    expect(adminOrders).toContain("Submitted phases are locked until an administrator unlocks the matching stage.");
    expect(adminOrders).toContain("Not submitted yet.");
    expect(adminOrders).not.toContain("Not submitted by the customer yet.");
    expect(mobileContract).toContain("configured customer workflow phase");
    expect(mobileParityContract).toContain("retaining staff and administrator workflows in the browser Portal");
  });
});
