import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config";
import * as schema from "./schema";
export type Database = ReturnType<typeof createDatabase>;
export function createDatabase(
  config: Pick<Config, "DATABASE_URL" | "DB_POOL_SIZE" | "DATABASE_CA_FILE">,
) {
  const sql = postgres(config.DATABASE_URL, {
    max: config.DB_POOL_SIZE,
    idle_timeout: 20,
    connect_timeout: 5,
    max_lifetime: 1800,
    connection: {
      statement_timeout: 15000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 30000,
    },
    ...(config.DATABASE_CA_FILE
      ? { ssl: { ca: readFileSync(config.DATABASE_CA_FILE, "utf8"), rejectUnauthorized: true } }
      : {}),
    onnotice: () => {},
  });
  return { sql, orm: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}

export type { TransactionSql as Transaction, TransactionSql as Tx } from "postgres";
