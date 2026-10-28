import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (path: string) => readFile(`${root}/${path}`, "utf8");

function procedure(source: string, name: string, nextName: string) {
  const start = source.indexOf(`  ${name}:`);
  const end = source.indexOf(`\n\n  ${nextName}:`, start);
  expect(start, `Missing ${name} procedure`).toBeGreaterThanOrEqual(0);
  expect(end, `Missing end of ${name} procedure`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("administrator historical order visibility", () => {
  it("returns bounded, stable active-platform pages rather than only a first fixed page", async () => {
    const router = await text("server/routers/admin.ts");
    const orders = procedure(router, "orders", "trashedOrders");

    expect(orders).toContain("orders: staffProcedure");
    expect(orders).toContain("isNull(orders.deletedAt)");
    expect(orders).toContain("const limit = input?.limit ?? 100");
    expect(orders).toContain(".limit(limit + 1)");
    expect(orders).toContain(".offset(offset)");
    expect(orders).toContain(".orderBy(desc(orders.createdAt), desc(orders.id))");
    expect(orders).toContain("const hasMore = pageWithSentinel.length > limit");
    expect(orders).toContain("items: result");
    expect(orders).toContain("total: Number(totalRows[0]?.total ?? 0)");
    expect(orders).toContain('scope: "active_platform" as const');
  });

  it("filters attention states before applying page bounds, retaining historic matching orders", async () => {
    const router = await text("server/routers/admin.ts");
    const orders = procedure(router, "orders", "trashedOrders");

    expect(orders).toContain("const awaitingStaffReview = sql`EXISTS (");
    expect(orders).toContain("const awaitingCustomerResponse = sql`EXISTS (");
    expect(orders).toContain('if (input?.attention === "awaiting_staff_review") conditions.push(awaitingStaffReview)');
    expect(orders).toContain('if (input?.attention === "awaiting_customer_response")');
    expect(orders).toContain("conditions.push(sql`${awaitingCustomerResponse} AND NOT ${awaitingStaffReview}`)");
    expect(orders).not.toContain("result.filter((row) => row.attention.state === input.attention)");
  });

  it("gives operators accessible older/newer navigation and makes search scope explicit", async () => {
    const ui = await text("client/src/pages/admin/Orders.tsx");

    expect(ui).toContain("const ORDER_QUEUE_PAGE_SIZE = 100");
    expect(ui).toContain("const [offset, setOffset] = useState(0)");
    expect(ui).toContain("limit: ORDER_QUEUE_PAGE_SIZE");
    expect(ui).toContain("offset,");
    expect(ui).toContain("function resetToFirstPage()");
    expect(ui).toContain("function goToOffset(nextOffset: number)");
    expect(ui).toContain('aria-label="Order queue pages"');
    expect(ui).toContain("Showing ${pageStart}–${pageEnd} of ${page.total} active order");
    expect(ui).toContain("Newer");
    expect(ui).toContain("Older");
    expect(ui).toContain('label="Search current page"');
    expect(ui).toContain("Searches the active page. Use the page controls to review older orders.");
    expect(ui).not.toContain("limit: 200");
    expect(ui).not.toContain("offset: 0");
  });

  it("preserves customer owner/share scope and does not turn the customer list into an operations queue", async () => {
    const [service, router] = await Promise.all([
      text("server/services/orders.ts"),
      text("server/routers/orders.ts"),
    ]);

    expect(service).toContain("export async function listOrdersForUser(userId: number)");
    expect(service).toContain("orders.userId} = ${userId} OR EXISTS (SELECT 1 FROM order_shares os");
    expect(service).toContain("os.revoked_at IS NULL");
    expect(service).toContain("isNull(orders.deletedAt)");
    expect(router).toContain("list: protectedProcedure.query(async ({ ctx }) => {");
    expect(router).toContain("listOrdersForUser(ctx.session.user.id)");
    expect(router).not.toContain('list: staffProcedure');
  });

  it("keeps soft-deleted orders outside normal staff/admin detail and access paths", async () => {
    const [service, router] = await Promise.all([
      text("server/services/orders.ts"),
      text("server/routers/admin.ts"),
    ]);
    const orderDetail = procedure(router, "orderDetail", "transitionOrder");

    expect(service).toContain("if (role === \"admin\" || role === \"staff\") {");
    expect(service).toContain(".where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))");
    expect(orderDetail).toContain("orderDetail: staffProcedure");
    expect(orderDetail).toContain("where(and(eq(orders.id, input.orderId), isNull(orders.deletedAt)))");
    expect(router).toContain("trashedOrders: adminProcedure");
    expect(router).toContain("sql`${orders.deletedAt} IS NOT NULL`");
    expect(router).toContain("restoreOrder: adminProcedure");
  });

  it("records administrator provisioning and role changes without retaining credentials or account identifiers", async () => {
    const router = await text("server/routers/admin.ts");
    const roleChange = procedure(router, "setCustomerRole", "createStaffAccount");
    const creation = procedure(router, "createStaffAccount", "bulkDisableCustomers");

    expect(roleChange).toContain('action: "account.role_changed"');
    expect(roleChange).toContain("changes: { role: input.role }");
    expect(creation).toContain('action: "account.provisioned"');
    expect(creation).toContain("changes: { role: input.role, mustChangePassword: true }");
    expect(creation).toContain("never retain the temporary password or account identifier");
    expect(creation).not.toContain("changes: { email:");
    expect(creation).not.toContain("changes: { temporaryPassword:");
  });
});
