import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("universal authenticated order creation", () => {
  it("allows any authenticated portal role to create an order through one protected procedure", async () => {
    const router = await text("server/routers/orders.ts");
    const createSection = router.slice(router.indexOf("  create: protectedProcedure"), router.indexOf("  /* ---------------------------------------------------------------- */", router.indexOf("  create: protectedProcedure")));

    expect(createSection).toContain("create: protectedProcedure");
    expect(createSection).toContain('projectName: z.string().trim().min(1, "Enter an order or project name.").max(190)');
    expect(createSection).toContain("userId: ctx.session.user.id");
    expect(createSection).toContain("actorRole: ctx.session.user.role");
    expect(createSection).not.toContain("customerProcedure");
  });

  it("exposes the same self-service order workspace to portal, staff, and administrator navigation", async () => {
    const [portalApp, fullApp, adminLayout] = await Promise.all([
      text("client/src/PortalApp.tsx"),
      text("client/src/App.tsx"),
      text("client/src/components/layout/AdminLayout.tsx"),
    ]);

    for (const source of [portalApp, fullApp]) {
      expect(source).toContain('{ href: "/portal/orders/new", label: "Create an order"');
      expect(source).toContain('<Route path="/portal/orders/new" component={NewOrderPage} />');
    }
    expect(adminLayout).toContain('{ href: "/portal/orders/new", label: "Create my order"');
  });

  it("keeps every browser and mobile customer-facing entry point aligned to the required project name", async () => {
    const [portalOrders, intake, mobileRouter, mobileContract] = await Promise.all([
      text("client/src/pages/portal/Orders.tsx"),
      text("client/src/pages/portal/Intake.tsx"),
      text("server/http/mobile/index.ts"),
      text("server/http/mobile/openapi.yaml"),
    ]);

    expect(portalOrders).toContain('label="Order or project name"');
    expect(portalOrders).toContain("disabled={selectionList.length === 0 || !projectName.trim()}");
    expect(intake).toContain("Order or project name required");
    expect(intake).toContain("disabled={!projectName.trim()}");
    expect(mobileRouter).toContain("Enter an order or project name before placing an order.");
    expect(mobileContract).toContain("required: [projectName, selections]");
  });
});
