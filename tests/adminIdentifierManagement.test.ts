import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicUserId } from "../server/security/crypto.js";
import {
  normalizeAdministratorIdentifier,
  ORDER_REFERENCE_PATTERN,
  orderReferenceEvidenceLabels,
} from "../server/services/identifierManagement.js";

const root = process.cwd();
const router = readFileSync(resolve(root, "server/routers/admin.ts"), "utf8");
const schema = readFileSync(resolve(root, "server/db/schema.ts"), "utf8");
const migration = readFileSync(resolve(root, "drizzle/migrations/0056_identifier_change_history.sql"), "utf8");
const customersPage = readFileSync(resolve(root, "client/src/pages/admin/Customers.tsx"), "utf8");
const ordersPage = readFileSync(resolve(root, "client/src/pages/admin/Orders.tsx"), "utf8");

describe("administrator identifier management", () => {
  it("accepts only the current opaque customer and order identifier formats", () => {
    expect(isPublicUserId("RP-CUS-7K4M2QPX")).toBe(true);
    expect(isPublicUserId("RP-C000015")).toBe(false);
    expect(ORDER_REFERENCE_PATTERN.test("RP-ORD-7K4M2QPX-2610-ABC234")).toBe(true);
    expect(ORDER_REFERENCE_PATTERN.test("RP-ORD-2610-ABC234")).toBe(true);
    expect(ORDER_REFERENCE_PATTERN.test("RP-C000008-2608-6D823B")).toBe(false);
    expect(normalizeAdministratorIdentifier(" rp-ord-2610-abc234 ")).toBe("RP-ORD-2610-ABC234");
  });

  it("identifies every kind of immutable order evidence that blocks a reference change", () => {
    expect(orderReferenceEvidenceLabels({})).toEqual([]);
    expect(orderReferenceEvidenceLabels({ invoice: true, file: true, webhook: true })).toEqual([
      "invoice",
      "file",
      "webhook delivery",
    ]);
    expect(orderReferenceEvidenceLabels({ sharepoint: true, conversionOrTransfer: true, mnda: true, intake: true })).toEqual([
      "SharePoint record",
      "conversion or transfer record",
      "MNDA acceptance",
      "intake submission",
    ]);
  });

  it("uses administrator-only, confirmed, append-only mutations that reserve retired IDs", () => {
    expect(router).toContain("changeCustomerId: adminProcedure");
    expect(router).toContain("changeOrderId: adminProcedure");
    expect(router).toContain('z.literal("CHANGE CUSTOMER ID")');
    expect(router).toContain('z.literal("CHANGE ORDER ID")');
    expect(router).toContain("tx.insert(customerIdChangeHistory)");
    expect(router).toContain("tx.insert(orderIdChangeHistory)");
    expect(router).toContain("customer.id_changed");
    expect(router).toContain("order.id_changed");
    expect(router).toContain("access.login_whitelist_public_ids");
    expect(router).toContain("orderReferenceEvidenceLabels");
    expect(router).toContain("sharepointTransferJobs");
    expect(router).toContain("webhookDeliveries");
  });

  it("ships history tables in both schema and forward-only migration", () => {
    expect(schema).toContain('mysqlTable(\n  "customer_id_change_history"');
    expect(schema).toContain('mysqlTable(\n  "order_id_change_history"');
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS customer_id_change_history");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS order_id_change_history");
    expect(migration).toContain("customer_id_change_history_previous_unique");
    expect(migration).toContain("order_id_change_history_previous_unique");
  });

  it("requires meaningful reason and exact confirmation in administrator-only accessible UI", () => {
    expect(customersPage).toContain("Change customer ID");
    expect(customersPage).toContain("CHANGE CUSTOMER ID");
    expect(customersPage).toContain("customer historical orders remain unchanged");
    expect(ordersPage).toContain("Change order reference");
    expect(ordersPage).toContain("CHANGE ORDER ID");
    expect(ordersPage).toContain("immutable financial or external evidence");
  });
});
