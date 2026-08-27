import type { Connection, RowDataPacket } from "mysql2/promise";

/**
 * Tables and columns that must exist before the portal can serve order workflow,
 * Phase Kickoff, configuration restore, backup, outbound integration, and native mobile routes.
 * This is deliberately a small operational contract rather than a duplicate of
 * the complete Drizzle schema: it turns a partial or legacy upgrade into a clear
 * startup failure instead of a later generic administrator UI error.
 */
export const criticalSchemaContract: Readonly<Record<string, readonly string[]>> = {
  site_settings: [
    "setting_key",
    "setting_value",
    "value_type",
    "category",
    "is_secret",
    "updated_at",
  ],
  inbound_webhook_listeners: [
    "id",
    "name",
    "slug",
    "handler",
    "enabled",
    "created_at",
    "updated_at",
  ],
  inbound_webhook_events: [
    "id",
    "listener_id",
    "payload",
    "signature_valid",
    "processed",
    "created_at",
  ],
  portal_wizard_slides: [
    "id",
    "title",
    "sort_order",
    "is_active",
    "target_audience",
    "created_at",
    "updated_at",
  ],
  phase_kickoff_configs: [
    "id",
    "phase",
    "create_folders",
    "folder_template",
    "attach_placeholders",
    "notify_customer",
    "notify_webhooks",
    "email_template_key",
    "completion_percent",
    "enabled",
    "updated_at",
  ],
  phase_jobs: [
    "id",
    "order_id",
    "phase",
    "job_type",
    "status",
    "attempts",
    "last_error",
    "run_after",
    "completed_at",
    "created_at",
  ],
  webhook_deliveries: [
    "id",
    "endpoint_id",
    "order_id",
    "order_number",
    "customer_name",
    "event_type",
    "payload",
    "status",
    "response_code",
    "response_detail",
    "attempts",
    "last_error",
    "run_after",
    "delivered_at",
    "created_at",
  ],
  email_automations: [
    "id",
    "name",
    "trigger_event",
    "template_key",
    "delay_minutes",
    "enabled",
    "run_count",
    "created_at",
    "updated_at",
  ],
  system_backups: [
    "id",
    "filename",
    "size_bytes",
    "backup_type",
    "status",
    "schema_version",
    "checksum",
    "storage_path",
    "triggered_by",
    "triggered_by_user_id",
    "error",
    "created_at",
  ],
  outbound_connections: [
    "id",
    "name",
    "connection_type",
    "base_url",
    "auth_type",
    "enabled",
    "last_tested_at",
    "last_test_ok",
    "created_at",
  ],
  outbound_call_logs: [
    "id",
    "connection_id",
    "method",
    "url",
    "status_code",
    "latency_ms",
    "error",
    "triggered_by",
    "created_at",
  ],
  mobile_devices: [
    "id",
    "user_id",
    "platform",
    "app_version",
    "push_token_hash",
    "push_token_enc",
    "push_platform",
    "status",
    "last_seen_at",
    "created_at",
  ],
  mobile_device_sessions: [
    "id",
    "token_family_id",
    "device_id",
    "user_id",
    "status",
    "last_seen_at",
    "expires_at",
    "created_at",
  ],
  mobile_authorization_codes: [
    "id",
    "code_hash",
    "user_id",
    "device_id",
    "redirect_uri",
    "code_challenge",
    "scopes",
    "expires_at",
    "created_at",
  ],
  mobile_refresh_tokens: [
    "id",
    "token_hash",
    "session_id",
    "token_family_id",
    "status",
    "expires_at",
    "created_at",
  ],
  mobile_idempotency_keys: [
    "id",
    "user_id",
    "route",
    "key_hash",
    "request_hash",
    "response_json",
    "expires_at",
    "created_at",
  ],
};

export type SchemaContractConnection = Pick<Connection, "query">;

type ColumnRow = RowDataPacket & {
  tableName: string;
  columnName: string;
};

/**
 * Throws a deterministic, actionable error if an old/partial database lacks a
 * critical table or column. Migration callers must execute this after applying
 * all forward-only migrations and before starting the application process.
 */
export async function assertCriticalSchemaContract(
  connection: SchemaContractConnection,
): Promise<void> {
  const tables = Object.keys(criticalSchemaContract);
  const placeholders = tables.map(() => "?").join(", ");
  const [rows] = await connection.query<ColumnRow[]>(
    `SELECT table_name AS tableName, column_name AS columnName
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN (${placeholders})`,
    tables,
  );

  const available = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = available.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    available.set(row.tableName, columns);
  }

  const missing: string[] = [];
  for (const [table, columns] of Object.entries(criticalSchemaContract)) {
    const availableColumns = available.get(table);
    if (!availableColumns) {
      missing.push(`${table} (table missing)`);
      continue;
    }
    for (const column of columns) {
      if (!availableColumns.has(column)) missing.push(`${table}.${column}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      "Database schema contract is incomplete: " +
        `${missing.join(", ")}. ` +
        "Do not start the portal against this partial schema. Ensure the latest source is deployed and re-run deploy/install.sh so all forward-only migrations apply.",
    );
  }
}

export function schemaContractSummary(): string {
  return `${Object.keys(criticalSchemaContract).length} critical tables verified`;
}

export const __testing = { criticalSchemaContract };
