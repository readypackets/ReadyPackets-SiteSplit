/**
 * Audit trail service.
 *
 * Three durable streams are maintained:
 *   security_logs  — authentication, authorisation and abuse events
 *   activity_logs  — user and administrator actions with before/after detail
 *   system_alerts  — deduplicated server faults surfaced in the admin panel
 *
 * Writes never throw into the caller: an audit failure must not break a request,
 * but it is escalated to the application log so it cannot pass unnoticed.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { activityLogs, securityLogs, systemAlerts } from "../db/schema.js";
import { blindIndex } from "../security/crypto.js";
import { logger } from "./logger.js";
import { forwardSecurityEvent } from "./siem.js";
import type { LogSeverity } from "../../shared/domain.js";

export type SecurityEventType =
  | "login.success"
  | "login.failure"
  | "login.locked"
  | "login.mfa_required"
  | "login.mfa_success"
  | "login.mfa_failure"
  | "logout"
  | "register.success"
  | "register.duplicate"
  | "password.reset_requested"
  | "password.reset_completed"
  | "password.changed"
  | "email.verified"
  | "mfa.enrolled"
  | "mfa.enrolment_acknowledged"
  | "mfa.disabled"
  | "mfa.backup_code_used"
  | "mfa.enrolment_required"
  | "magic_link.requested"
  | "magic_link.invalid"
  | "session.revoked"
  | "session.expired"
  | "csrf.rejected"
  | "origin.rejected"
  | "ratelimit.exceeded"
  | "ratelimit.penalty"
  | "ip.blocked"
  | "admin.access_denied"
  | "admin.mfa_required"
  | "admin.ip_denied"
  | "file.access_denied"
  | "file.downloaded"
  | "apikey.created"
  | "apikey.revoked"
  | "settings.changed"
  | "account.banned"
  | "encryption.failure"
  | "login.blocked_administrator_only"
  | "magic_link.blocked_administrator_only"
  | "register.blocked_administrator_only"
  | "session.revoked_administrator_only"
  | "privacy.cookie_consent_saved"
  | "mobile.authorization_granted"
  | "mobile.authorization_denied"
  | "mobile.token_issued"
  | "mobile.token_rotated"
  | "mobile.token_revoked"
  | "mobile.device_registered"
  | "mobile.device_revoked"
  | "mobile.idempotency_replayed"
  | "mobile.idempotency_conflict"
  | "mobile.authorization_failed"
  | "mobile.account_deletion_requested"
  | "saml.login_started";

interface SecurityEventInput {
  eventType: SecurityEventType;
  severity?: LogSeverity;
  outcome?: "success" | "failure" | "blocked";
  message: string;
  userId?: number | null;
  /** Raw identifier such as an email; it is hashed before storage. */
  subject?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  // Derive severity from the *effective* outcome, not the supplied one. Most call
  // sites omit `outcome` because "success" is the sensible default, and reading
  // `input.outcome` directly classified all of those as warnings — which made a
  // successful sign-in look indistinguishable from a rejected one when scanning
  // the log. An audit trail that cries wolf on every row is not an audit trail.
  const outcome = input.outcome ?? "success";
  const severity = input.severity ?? (outcome === "success" ? "info" : "warning");
  try {
    await db.insert(securityLogs).values({
      eventType: input.eventType,
      severity,
      outcome,
      message: input.message.slice(0, 500),
      userId: input.userId ?? null,
      subjectHash: input.subject ? blindIndex(input.subject) : null,
      ipAddress: input.ipAddress?.slice(0, 64) ?? null,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
      metadata: input.metadata ?? null,
    });
  } catch (error) {
    logger.error("Failed to write security log", { error, eventType: input.eventType });
  }
  logger[severity === "critical" || severity === "error" ? "error" : "info"](
    `security:${input.eventType}`,
    { outcome: input.outcome, userId: input.userId, ip: input.ipAddress },
  );
  forwardSecurityEvent({
    eventType: input.eventType,
    severity,
    outcome,
    userId: input.userId ?? null,
    correlationId: typeof input.metadata?.correlationId === "string" ? input.metadata.correlationId : null,
  });
}

interface ActivityEventInput {
  actorUserId?: number | null;
  actorRole?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | number | null;
  severity?: LogSeverity;
  summary: string;
  changes?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export async function recordActivity(input: ActivityEventInput): Promise<void> {
  try {
    await db.insert(activityLogs).values({
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action.slice(0, 96),
      entityType: input.entityType ?? null,
      entityId: input.entityId === null || input.entityId === undefined
        ? null
        : String(input.entityId).slice(0, 64),
      severity: input.severity ?? "info",
      summary: input.summary.slice(0, 500),
      changes: input.changes ?? null,
      ipAddress: input.ipAddress?.slice(0, 64) ?? null,
    });
  } catch (error) {
    logger.error("Failed to write activity log", { error, action: input.action });
  }
}

interface AlertInput {
  alertKey: string;
  severity?: "warning" | "error" | "critical";
  source?: string;
  message: string;
  detail?: string;
}

/**
 * Raise an alert, collapsing repeats of the same key into one row with an
 * occurrence counter so a failure loop cannot flood the table.
 */
export async function raiseAlert(input: AlertInput): Promise<void> {
  const alertKey = input.alertKey.slice(0, 96);
  try {
    const existing = await db
      .select({ id: systemAlerts.id })
      .from(systemAlerts)
      .where(and(eq(systemAlerts.alertKey, alertKey), isNull(systemAlerts.resolvedAt)))
      .limit(1);

    const first = existing[0];
    if (first) {
      await db
        .update(systemAlerts)
        .set({
          occurrences: sql`${systemAlerts.occurrences} + 1`,
          lastSeenAt: new Date(),
          message: input.message.slice(0, 500),
          detail: input.detail ?? null,
        })
        .where(eq(systemAlerts.id, first.id));
      return;
    }

    await db.insert(systemAlerts).values({
      alertKey,
      severity: input.severity ?? "error",
      source: input.source ?? "server",
      message: input.message.slice(0, 500),
      detail: input.detail ?? null,
    });
  } catch (error) {
    logger.error("Failed to write system alert", { error, alertKey });
  }
}
