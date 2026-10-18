import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { readWorkerConfig } from "../src/platform/config";
import { createDatabase, type Database } from "../src/platform/db";
export async function migrate(db: Database) {
  await db.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(91843721)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    await tx`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zephium_app') THEN
        REVOKE INSERT,UPDATE,DELETE ON schema_migration FROM zephium_app;
      END IF;
    END $$`;
    for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((n) => /^\d+_.+\.sql$/.test(n))
      .sort()) {
      const body = await Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text();
      const digest = createHash("sha256").update(body).digest("hex");
      const [previous] = await tx`SELECT digest FROM schema_migration WHERE name=${name}`;
      if (previous && previous.digest !== digest)
        throw new Error(`Applied migration changed: ${name}`);
      if (!previous) {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migration (name,digest) VALUES (${name},${digest})`;
      }
    }
    await tx`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zephium_app') THEN
        REVOKE INSERT,UPDATE,DELETE ON cloud_policy,cloud_active_policy FROM zephium_app;
      END IF;
    END $$`;
  });
}
if (import.meta.main) {
  const db = createDatabase(readWorkerConfig());
  try {
    await migrate(db);
    console.log("Migrations applied");
  } finally {
    await db.close();
  }
}
