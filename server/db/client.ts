/**
 * MySQL connection pool and Drizzle handle.
 *
 * All application SQL flows through Drizzle, which parameterises every value,
 * so the query path cannot be used for injection. Multiple statements are
 * disabled on the driver as an additional guard.
 */
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export const pool = mysql.createPool({
  uri: env.databaseUrl,
  waitForConnections: true,
  // Every horizontally scaled instance has its own pool. Keep the aggregate
  // below the managed MySQL primary's connection budget via environment config.
  connectionLimit: env.databaseConnectionLimit,
  queueLimit: 0,
  multipleStatements: false,
  charset: "utf8mb4_unicode_ci",
  timezone: "Z",
  dateStrings: false,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
});

export const db = drizzle(pool, { schema, mode: "default" });

export type Database = typeof db;

export async function pingDatabase(): Promise<boolean> {
  try {
    const connection = await pool.getConnection();
    try {
      await connection.query("SELECT 1");
      return true;
    } finally {
      connection.release();
    }
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
