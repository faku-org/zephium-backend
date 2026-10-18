import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { migrate } from "../../scripts/migrate";
import { readConfig } from "../../src/platform/config";
import { createDatabase } from "../../src/platform/db";
export async function testDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "zephium-pg-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const password = crypto.randomUUID();
  const pg = new EmbeddedPostgres({
    databaseDir: join(directory, "data"),
    port,
    user: "zephium",
    password,
    authMethod: "scram-sha-256",
    persistent: false,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ["-h", "127.0.0.1", "-k", directory],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("zephium_test");
  const config = readConfig({
    NODE_ENV: "test",
    SIGNUP_PER_IP_PER_DAY: "1000",
    ELIGIBILITY_SECRET: "c".repeat(40),
    DATABASE_URL: `postgres://zephium:${password}@127.0.0.1:${port}/zephium_test`,
    AUTH_SECRET: "a".repeat(40),
    ABUSE_SECRET: "b".repeat(40),
    POLAR_MONTHLY_PRODUCT_ID: "00000000-0000-4000-8000-000000000001",
    POLAR_YEARLY_PRODUCT_ID: "00000000-0000-4000-8000-000000000002",
  });
  const db = createDatabase(config);
  await migrate(db);
  return {
    config,
    db,
    pg,
    directory,
    async close() {
      await db.close();
      await pg.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
