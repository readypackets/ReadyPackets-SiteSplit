import { describe, expect, it } from "vitest";
import {
  assertCriticalSchemaContract,
  criticalSchemaContract,
  schemaContractSummary,
  type SchemaContractConnection,
} from "../scripts/schemaContract.js";

function contractRows() {
  return Object.entries(criticalSchemaContract).flatMap(([table, columns]) =>
    columns.map((column) => ({ tableName: table, columnName: column })),
  );
}

function connectionReturning(rows: ReturnType<typeof contractRows>): SchemaContractConnection {
  return {
    query: async () => [rows, []],
  } as unknown as SchemaContractConnection;
}

describe("critical database schema contract", () => {
  it("accepts a complete Phase Kickoff and operational schema", async () => {
    await expect(assertCriticalSchemaContract(connectionReturning(contractRows()))).resolves.toBeUndefined();
    expect(schemaContractSummary()).toMatch(/^\d+ critical tables verified$/);
  });

  it("fails before portal startup when a Phase Kickoff column is absent", async () => {
    const incompleteRows = contractRows().filter(
      (row) => !(row.tableName === "phase_kickoff_configs" && row.columnName === "completion_percent"),
    );

    await expect(assertCriticalSchemaContract(connectionReturning(incompleteRows))).rejects.toThrow(
      "phase_kickoff_configs.completion_percent",
    );
  });

  it("reports a missing operational table by name", async () => {
    const incompleteRows = contractRows().filter((row) => row.tableName !== "outbound_call_logs");

    await expect(assertCriticalSchemaContract(connectionReturning(incompleteRows))).rejects.toThrow(
      "outbound_call_logs (table missing)",
    );
  });

  it("blocks startup when the Security Centre inbound webhook tables are absent", async () => {
    const incompleteRows = contractRows().filter((row) => row.tableName !== "inbound_webhook_events");

    await expect(assertCriticalSchemaContract(connectionReturning(incompleteRows))).rejects.toThrow(
      "inbound_webhook_events (table missing)",
    );
  });

  it("blocks startup when native mobile encrypted-token storage is absent", async () => {
    const incompleteRows = contractRows().filter(
      (row) => !(row.tableName === "mobile_devices" && row.columnName === "push_token_enc"),
    );

    await expect(assertCriticalSchemaContract(connectionReturning(incompleteRows))).rejects.toThrow(
      "mobile_devices.push_token_enc",
    );
  });

  it("blocks startup when the active CRM tables are absent", async () => {
    const incompleteRows = contractRows().filter((row) => row.tableName !== "crm_contacts");

    await expect(assertCriticalSchemaContract(connectionReturning(incompleteRows))).rejects.toThrow(
      "crm_contacts (table missing)",
    );
  });

  it("blocks startup when subscription or scheduling tables are absent", async () => {
    const incompleteRows = contractRows().filter(
      (row) => row.tableName !== "subscription_plans" && row.tableName !== "availability_slots",
    );

    await expect(assertCriticalSchemaContract(connectionReturning(incompleteRows))).rejects.toThrow(
      "subscription_plans (table missing)",
    );
  });

  it("blocks startup when append-only conversion and selected-site tables are absent", async () => {
    const incompleteRows = contractRows().filter((row) => row.tableName !== "conversion_jobs");

    await expect(assertCriticalSchemaContract(connectionReturning(incompleteRows))).rejects.toThrow(
      "conversion_jobs (table missing)",
    );
  });

  it("uses explicit metadata aliases so MySQL column-name casing cannot hide existing tables", async () => {
    let statement = "";
    const connection = {
      query: async (sql: string) => {
        statement = sql;
        return [contractRows(), []];
      },
    } as unknown as SchemaContractConnection;

    await expect(assertCriticalSchemaContract(connection)).resolves.toBeUndefined();
    expect(statement).toContain("table_name AS tableName");
    expect(statement).toContain("column_name AS columnName");
  });
});
