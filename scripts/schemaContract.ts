import type { Connection, RowDataPacket } from "mysql2/promise";

/**
 * Tables and columns that must exist before the portal can serve its actively
 * shipped order, configuration, backup, integration, native mobile, Tier 3,
 * CRM, scheduling, subscription, selected-site SharePoint, and conversion routes. This operational contract turns a
 * partial or legacy upgrade into a clear startup failure instead of a later
 * generic administrator UI error.
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
    "status",
    "last_seen_at",
    "created_at",
  ],
  mobile_device_sessions: [
    "id",
    "token_family_id",
    "device_id",
    "user_id",
    "scopes",
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
  subscription_plans: ["id", "name", "slug", "price_cents", "interval_days", "is_active", "created_at", "updated_at"],
  subscription_items: ["id", "user_id", "plan_id", "status", "current_period_start", "current_period_end", "created_at", "updated_at"],
  billing_events: ["id", "event_type", "amount_cents", "currency", "provider", "created_at"],
  crm_contacts: ["id", "email_enc", "email_index", "status", "created_at", "updated_at", "deleted_at"],
  crm_notes: ["id", "contact_id", "author_user_id", "body", "note_type", "created_at", "updated_at"],
  crm_tags: ["id", "name", "color", "created_at"],
  ai_sessions: ["id", "model", "status", "token_count", "cost_micro_usd", "created_at", "updated_at"],
  ai_messages: ["id", "session_id", "role", "content", "token_count", "created_at"],
  ai_response_logs: ["id", "model", "prompt_tokens", "completion_tokens", "latency_ms", "created_at"],
  api_key_rate_limits: ["id", "api_key_id", "window_seconds", "max_requests", "updated_at"],
  api_request_logs: ["id", "method", "path", "status_code", "latency_ms", "created_at"],
  api_action_logs: ["id", "action", "result", "created_at"],
  availability_slots: ["id", "owner_user_id", "slot_type", "starts_at", "ends_at", "max_bookings", "current_bookings", "is_available", "created_at"],
  meeting_bookings: ["id", "slot_id", "customer_user_id", "status", "confirmation_token", "created_at", "updated_at"],
  pwa_ab_variants: ["id", "experiment_key", "variant_key", "weight", "is_control", "is_active", "created_at"],
  pwa_ab_events: ["id", "experiment_key", "variant_key", "event_type", "created_at"],
  admin_nav_preferences: ["id", "user_id", "pinned_items", "collapsed_sections", "updated_at"],
  pinned_quick_add: ["id", "user_id", "action_key", "label", "href", "sort_order", "created_at"],
  support_permissions: ["id", "user_id", "can_view_all_tickets", "can_close_tickets", "can_assign_tickets", "can_view_customer_pii", "can_issue_refunds", "granted_by_user_id", "created_at", "updated_at"],
  feature_toggle_schedules: ["id", "flag_key", "scheduled_value", "scheduled_at", "executed_at", "created_at"],
  email_automation_rate_limits: ["id", "automation_id", "user_id", "sent_count", "window_start"],
  sharepoint_connections: ["id", "name", "tenant_id", "client_id", "client_secret_enc", "site_id", "drive_id", "root_folder_path", "enabled", "created_at", "updated_at"],
  sharepoint_target_bindings: ["id", "name", "target_role", "connection_id", "enabled", "created_at", "updated_at"],
  order_sharepoint_locations: ["id", "order_id", "target_binding_id", "customer_name_snapshot", "customer_id_snapshot", "order_number_snapshot", "resolved_path", "created_at", "updated_at"],
  conversion_profiles: ["id", "name", "operation", "settings_json", "revision", "tool_fingerprint", "active", "created_at", "updated_at"],
  conversion_jobs: ["id", "order_id", "source_file_id", "source_file_version", "source_storage_key", "source_sha256", "conversion_profile_id", "profile_revision", "profile_operation", "target_bindings_json", "status", "idempotency_key", "correlation_id", "attempts", "run_after", "created_at", "updated_at"],
  file_derivatives: ["id", "source_file_id", "source_file_version", "source_storage_key", "source_sha256", "conversion_profile_id", "artifact_file_id", "output_sha256", "output_mime", "output_extension", "tool_fingerprint", "created_at"],
  sharepoint_transfer_jobs: ["id", "order_id", "source_file_id", "target_binding_id", "operation_type", "storage_key_snapshot", "sha256_snapshot", "file_name_snapshot", "mime_snapshot", "phase_snapshot", "idempotency_key", "correlation_id", "status", "attempts", "run_after", "created_at", "updated_at"],
  customer_id_change_history: ["id", "user_id", "previous_customer_id", "new_customer_id", "reason", "changed_by_user_id", "created_at"],
  order_id_change_history: ["id", "order_id", "previous_order_number", "new_order_number", "reason", "changed_by_user_id", "created_at"],
  orders: ["id", "project_name_enc", "sharepoint_customer_folder_enc", "sharepoint_order_folder_enc"],
  login_page_config: ["id", "slideshow_slides", "updated_by_user_id", "updated_at"],
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
