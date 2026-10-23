import os from "node:os";
import tls from "node:tls";
import { blindIndex } from "../security/crypto.js";
import { env } from "../config/env.js";
import { logger } from "./logger.js";
import type { LogSeverity } from "../../shared/domain.js";

export interface SiemSecurityEvent {
  eventType: string;
  severity: LogSeverity;
  outcome: "success" | "failure" | "blocked";
  userId?: number | null;
  correlationId?: string | null;
}

type Target = { host: string; port: number };
const MAX_QUEUE = 1_000;
const queue: SiemSecurityEvent[] = [];
let sending = false;
let failureLogged = false;

function parseTarget(raw: string | undefined): Target | null {
  if (!raw) return null;
  try {
    const value = new URL(raw);
    if (value.protocol !== "tls:" || !value.hostname || !value.port || value.username || value.password || value.pathname !== "/" || value.search || value.hash) {
      throw new Error("SYSLOG_TARGET must use tls://host:port without credentials or path");
    }
    return { host: value.hostname, port: Number(value.port) };
  } catch (error) {
    logger.error("Secure SIEM forwarding disabled because SYSLOG_TARGET is invalid", { error });
    return null;
  }
}

const target = parseTarget(env.syslogTarget);

function priority(severity: LogSeverity): number {
  const value: Record<LogSeverity, number> = {
    debug: 7,
    info: 6,
    notice: 5,
    warning: 4,
    error: 3,
    critical: 2,
  };
  return 16 * 10 + value[severity];
}

function field(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

function message(event: SiemSecurityEvent): string {
  const timestamp = new Date().toISOString();
  const actor = event.userId ? blindIndex(String(event.userId)).slice(0, 24) : "anonymous";
  const correlation = event.correlationId ? field(event.correlationId) : "none";
  const structured = `[readypackets@32473 event="${field(event.eventType)}" outcome="${field(event.outcome)}" actor_hash="${actor}" correlation_id="${correlation}"]`;
  return `<${priority(event.severity)}>1 ${timestamp} ${field(os.hostname())} readypackets - security - ${structured} ReadyPackets security event\n`;
}

function deliver(event: SiemSecurityEvent): Promise<void> {
  if (!target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: true });
    const timeout = setTimeout(() => socket.destroy(new Error("Secure SIEM connection timed out")), 10_000);
    socket.once("secureConnect", () => socket.end(message(event), "utf8", () => resolve()));
    socket.once("error", reject);
    socket.once("close", () => clearTimeout(timeout));
  });
}

async function flush(): Promise<void> {
  if (sending || !target) return;
  sending = true;
  try {
    while (queue.length) {
      const event = queue[0]!;
      try {
        await deliver(event);
        queue.shift();
        failureLogged = false;
      } catch (error) {
        if (!failureLogged) {
          logger.error("Secure SIEM delivery failed; security events remain queued in memory", { error, pending: queue.length });
          failureLogged = true;
        }
        break;
      }
    }
  } finally {
    sending = false;
  }
}

/**
 * Sends a privacy-minimised RFC 5424 record over TLS. This path never forwards
 * request bodies, tokens, IP addresses, user agents, file names, free-form audit
 * metadata, or customer content. The database audit trail remains authoritative.
 */
export function forwardSecurityEvent(event: SiemSecurityEvent): void {
  if (!target) return;
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    logger.error("Secure SIEM queue reached capacity; oldest event dropped", { queueLimit: MAX_QUEUE });
  }
  queue.push(event);
  void flush();
}

export function secureSiemStatus(): { configured: boolean; pending: number; sending: boolean } {
  return { configured: Boolean(target), pending: queue.length, sending };
}
