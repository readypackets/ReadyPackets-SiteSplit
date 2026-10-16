/**
 * Server entrypoint.
 *
 * Startup is fail-fast: if the configuration is invalid or the database is
 * unreachable, the process exits rather than serving a half-working site.
 * Shutdown drains in-flight requests before closing the pool, so a deploy does
 * not truncate a customer's download.
 */
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closeDatabase, pingDatabase } from "./db/client.js";
import { logger } from "./observability/logger.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { ensureStorageRoot } from "./services/storage.js";

async function main(): Promise<void> {
  logger.info("Starting ReadyPackets portal", {
    environment: env.nodeEnv,
    node: process.version,
  });

  if (!(await pingDatabase())) {
    logger.error("Database is unreachable. Check DATABASE_URL and that MySQL is running.");
    process.exit(1);
  }

  if (env.storage.driver === "local") {
    await ensureStorageRoot();
  }

  const app = createApp();
  const server = createServer(app);

  // Bound header and body timeouts close the door on slow-loris style attacks.
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 12_000;
  server.maxHeadersCount = 64;

  server.listen(env.port, env.bindHost, () => {
    logger.info("Listening", { host: env.bindHost, port: env.port, appUrl: env.appUrl, instanceRole: env.instanceRole });
    if (env.schedulerEnabled) {
      startScheduler();
    } else {
      logger.info("Scheduler disabled for web-only instance", { instanceRole: env.instanceRole });
    }
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error("Port is already in use", { port: env.port });
    } else {
      logger.error("HTTP server error", { error });
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });

    if (env.schedulerEnabled) stopScheduler();

    // Stop accepting connections, then wait for the active ones to finish.
    const forceExit = setTimeout(() => {
      logger.warn("Shutdown timed out; exiting");
      process.exit(1);
    }, 20_000);
    forceExit.unref();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
    clearTimeout(forceExit);
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A rejection that reaches here is a bug; log it with context and keep serving,
  // because dropping every in-flight request would be worse than the fault.
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason });
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception; shutting down", { error });
    void shutdown("uncaughtException");
  });
}

void main().catch((error) => {
  logger.error("Fatal startup error", { error });
  process.exit(1);
});
