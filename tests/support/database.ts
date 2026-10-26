import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { migrate } from "../../scripts/migrate";
import { readConfig } from "../../src/platform/config";
import { createDatabase } from "../../src/platform/db";

async function reserveTestPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  let released = false;
  return {
    port: address.port,
    async release() {
      if (released) return;
      released = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export async function testDatabase(options: { port?: number } = {}) {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
  )
    throw new Error("Invalid fixture port");
  const directory = await mkdtemp(join(tmpdir(), "zephium-pg-"));
  let reservation: Awaited<ReturnType<typeof reserveTestPort>> | undefined;
  try {
    if (options.port === undefined) reservation = await reserveTestPort();
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const port = options.port ?? reservation?.port;
  if (port === undefined) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Missing fixture port");
  }
  const password = crypto.randomUUID();
  let startupFailure = "unknown";
  let phase = "initialization";
  let started = false;
  let db: ReturnType<typeof createDatabase> | undefined;
  const pg = new EmbeddedPostgres({
    databaseDir: join(directory, "data"),
    port,
    user: "zephium",
    password,
    authMethod: "scram-sha-256",
    persistent: false,
    // Keep only a bounded diagnostic label, never PostgreSQL log text or credentials.
    onLog: (line) => {
      if (/address already in use/i.test(line)) startupFailure = "address_in_use";
      else if (/could not create shared memory/i.test(line)) startupFailure = "shared_memory";
      else if (/no space left on device/i.test(line)) startupFailure = "storage_full";
      else if (/cannot allocate memory/i.test(line)) startupFailure = "out_of_memory";
      else if (/too many open files/i.test(line)) startupFailure = "file_limit";
      else if (/permission denied/i.test(line)) startupFailure = "permission_denied";
    },
    onError: () => {},
    postgresFlags: ["-h", "127.0.0.1", "-k", directory],
  });
  try {
    await pg.initialise();
    phase = "startup";
    // Keep the OS-selected port reserved through initdb, then hand it to PostgreSQL.
    // A competing bind still fails visibly; no test or database operation is retried.
    await reservation?.release();
    await pg.start();
    started = true;
    phase = "database creation";
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
    db = createDatabase(config);
    phase = "migration";
    await migrate(db);
    const database = db;
    return {
      config,
      db: database,
      pg,
      directory,
      async close() {
        await database.close();
        await pg.stop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await reservation?.release().catch(() => {});
    await db?.close().catch(() => {});
    // start() rejects only after child close. Calling stop() on that dead child
    // would wait forever for another exit event in embedded-postgres 18.4.0-beta.17.
    if (started) await pg.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    // The pinned library rejects with undefined on startup failure. Preserve
    // informative errors; give this otherwise silent rejection a phase and label.
    if (error === undefined)
      throw new Error(`PostgreSQL test fixture ${phase} failed (${startupFailure})`);
    throw error;
  }
}
