/**
 * In-process scheduler.
 *
 * A self-hosted install should not need a separate worker container or a cron
 * daemon to stay healthy, so the recurring maintenance work runs inside the
 * application process on plain timers. Every job is wrapped so that a failure is
 * recorded and the schedule survives, and all timers are unreferenced so they
 * cannot keep the process alive during shutdown.
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { RowDataPacket } from "mysql2";
import { db, pool } from "../db/client.js";
import {
  emailQueue,
  emailVerificationTokens,
  orders,
  passwordResetTokens,
  users,
  userSessions,
} from "../db/schema.js";
import { logger } from "../observability/logger.js";
import { raiseAlert } from "../observability/audit.js";
import { processEmailQueue } from "./email.js";

import { invalidateIpCaches, purgeExpiredBlacklistEntries } from "../security/ipBlacklist.js";
import { getSettingNumber, invalidateSettingsCache } from "./settings.js";
import { processPhaseJobs, processPendingFileSyncs, deliverWebhooks } from "./sharepoint.js";
import { processWorkflowCompletionJobs } from "./orders.js";
import { processConversionJobs, processSharepointTransferJobs } from "./conversionPipeline.js";

interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  /** Delay before the first run, so startup is not a thundering herd. */
  initialDelayMs: number;
}
type SchedulerLeaseRow = RowDataPacket & { acquired: number };
const timers: NodeJS.Timeout[] = [];

async function runJob(job: Job): Promise<void> {
  const started = Date.now();
  // A worker can run in a standby region for high availability. MySQL named
  // locks make the schedule globally singleton without Redis or host-local
  // leader state. The lock lives on this connection until explicitly released.
  const lockName = `readypackets:scheduler:${job.name}`;
  let connection: Awaited<ReturnType<typeof pool.getConnection>> | null = null;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query<SchedulerLeaseRow[]>("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
    if (Number(rows[0]?.acquired ?? 0) !== 1) {
      logger.debug("Scheduled job lease held by another worker", { job: job.name });
      return;
    }
    await job.run();
    const duration = Date.now() - started;
    if (duration > 5_000) {
      logger.warn("Scheduled job was slow", { job: job.name, durationMs: duration });
    }
  } catch (error) {
    logger.error("Scheduled job failed", { job: job.name, error });
    void raiseAlert({
      alertKey: `scheduler.${job.name}`,
      severity: "error",
      source: "scheduler",
      message: `Scheduled job "${job.name}" failed`,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (connection) {
      try {
        await connection.query("DO RELEASE_LOCK(?)", [lockName]);
      } catch (error) {
        logger.warn("Failed to release scheduled job lease", { job: job.name, error });
      } finally {
        connection.release();
      }
    }
  }
}

/** Remove expired sessions, tokens, attempt records and temporary blocks. */
async function purgeExpiredRecords(): Promise<void> {
  const now = new Date();

  await db
    .update(userSessions)
    .set({ status: "expired" })
    .where(and(eq(userSessions.status, "active"), lt(userSessions.expiresAt, now)));

  // Keep a short tail of expired sessions for forensics, then delete.
  const sessionCutoff = new Date(Date.now() - 7 * 86_400_000);
  await db.delete(userSessions).where(lt(userSessions.expiresAt, sessionCutoff));

  await db.delete(passwordResetTokens).where(lt(passwordResetTokens.expiresAt, sessionCutoff));

  await db
    .delete(emailVerificationTokens)
    .where(lt(emailVerificationTokens.expiresAt, sessionCutoff));

  const removed = await purgeExpiredBlacklistEntries();
  if (removed > 0) invalidateIpCaches();
}

/** Fail a queued message that has exhausted its attempts, and alert once. */
/** Permanently remove records held in the administrator-configured trash window. */
async function purgeTrash(): Promise<void> {
  const retentionDays = Math.max(1, Math.min(3650, await getSettingNumber("trash.retention_days", 30)));
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  // Orders and accounts are first soft-deleted in the console; this scheduled task
  // performs the irreversible primary-record purge only after the retention window.
  await db.delete(orders).where(and(sql`${orders.deletedAt} IS NOT NULL`, lt(orders.deletedAt, cutoff)));
  await db.delete(users).where(and(sql`${users.deletedAt} IS NOT NULL`, lt(users.deletedAt, cutoff)));
}

async function reapDeadEmails(): Promise<void> {
  const stuck = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(emailQueue)
    .where(eq(emailQueue.status, "failed"));
  const failed = Number(stuck[0]?.total ?? 0);
  if (failed >= 10) {
    void raiseAlert({
      alertKey: "email.queue_failures",
      severity: "error",
      source: "email",
      message: `${failed} outbound messages have failed permanently`,
      detail: "Check the SMTP settings in Admin → Settings, then use Retry failed emails.",
    });
  }
}

const JOBS: Job[] = [
  {
    name: "email_queue",
    intervalMs: 30_000,
    initialDelayMs: 5_000,
    run: async () => {
      await processEmailQueue(25);
    },
  },
  {
    name: "purge_expired",
    intervalMs: 15 * 60_000,
    initialDelayMs: 60_000,
    run: purgeExpiredRecords,
  },
  {
    name: "trash_purge",
    intervalMs: 24 * 60 * 60_000,
    initialDelayMs: 180_000,
    run: purgeTrash,
  },
  {
    name: "order_health",
    intervalMs: 10 * 60_000,
    initialDelayMs: 90_000,
    run: async () => {
      // Surface a backlog of overdue work rather than letting it go unnoticed.
      const rows = await db
        .select({ total: sql<number>`COUNT(*)` })
        .from(orders)
        .where(
          and(
            isNull(orders.deletedAt),
            isNull(orders.deliveredAt),
            sql`${orders.dueAt} IS NOT NULL AND ${orders.dueAt} < NOW()`,
          ),
        );
      const overdue = Number(rows[0]?.total ?? 0);
      if (overdue > 0) {
        void raiseAlert({
          alertKey: "orders.overdue",
          severity: "warning",
          source: "orders",
          message: `${overdue} orders are past their due date`,
          detail: "Review the order queue in Admin → Orders.",
        });
      }
    },
  },
  {
    name: "settings_refresh",
    intervalMs: 5 * 60_000,
    initialDelayMs: 120_000,
    run: async () => {
      invalidateSettingsCache();
    },
  },
  {
    name: "email_health",
    intervalMs: 30 * 60_000,
    initialDelayMs: 180_000,
    run: reapDeadEmails,
  },
  {
    name: "workflow_completion_jobs",
    intervalMs: 15_000,
    initialDelayMs: 12_000,
    run: async () => {
      await processWorkflowCompletionJobs(25);
    },
  },
  {
    name: "phase_jobs",
    intervalMs: 60_000,
    initialDelayMs: 15_000,
    run: processPhaseJobs,
  },
  {
    name: "sharepoint_file_sync",
    intervalMs: 60_000,
    initialDelayMs: 25_000,
    run: processPendingFileSyncs,
  },
  {
    name: "conversion_pipeline",
    intervalMs: 20_000,
    initialDelayMs: 30_000,
    run: async () => {
      await processConversionJobs(2);
    },
  },
  {
    name: "sharepoint_transfer_outbox",
    intervalMs: 30_000,
    initialDelayMs: 35_000,
    run: async () => {
      await processSharepointTransferJobs(3);
    },
  },
  {
    name: "webhook_delivery",
    intervalMs: 30_000,
    initialDelayMs: 20_000,
    run: deliverWebhooks,
  },
];

export function startScheduler(): void {
  for (const job of JOBS) {
    const start = setTimeout(() => {
      void runJob(job);
      const interval = setInterval(() => void runJob(job), job.intervalMs);
      interval.unref();
      timers.push(interval);
    }, job.initialDelayMs);
    start.unref();
    timers.push(start);
  }
  logger.info("Scheduler started", { jobs: JOBS.map((job) => job.name) });
}

export function stopScheduler(): void {
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.length = 0;
}
