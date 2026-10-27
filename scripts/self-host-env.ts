import { randomBytes } from "node:crypto";
import { open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target || !isAbsolute(target))
  throw new Error("Usage: bun scripts/self-host-env.ts /absolute/outside-repository/self-host.env");
const file = resolve(target);
const repository = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const directory = await realpath(dirname(file));
if (directory === repository || directory.startsWith(`${repository}${sep}`))
  throw new Error("Keep self-host secrets outside the repository");
const secret = () => randomBytes(48).toString("base64url");
const owner = secret();
const migrator = secret();
const app = secret();
const lines = [
  "# Private deployment input. Fill every blank before using Compose; never commit this file.",
  "ZEPHIUM_ACCOUNT_IMAGE=",
  "ZEPHIUM_WORKER_IMAGE=",
  "ZEPHIUM_POSTGRES_IMAGE=",
  "ZEPHIUM_POLICY_FILE=",
  "ZEPHIUM_PGBACKREST_CONFIG_FILE=",
  "ZEPHIUM_LOCAL_PORT=3000",
  "API_ORIGIN=",
  "TRUSTED_ORIGINS=",
  "TRUSTED_PROXY_CIDRS=",
  "EMAIL_FROM=",
  "SOURCE_URL=",
  "RESEND_API_KEY=",
  "SIGNUP_OPEN=true",
  "BLOCK_DISPOSABLE_EMAIL=false",
  `POSTGRES_OWNER_PASSWORD=${owner}`,
  `ZEPHIUM_MIGRATOR_PASSWORD=${migrator}`,
  `ZEPHIUM_APP_PASSWORD=${app}`,
  `ZEPHIUM_MIGRATOR_DATABASE_URL=postgres://zephium_migrator:${migrator}@postgres:5432/zephium`,
  `ZEPHIUM_APP_DATABASE_URL=postgres://zephium_app:${app}@postgres:5432/zephium`,
  `AUTH_SECRET=${secret()}`,
  `ABUSE_SECRET=${secret()}`,
  `ELIGIBILITY_SECRET=${secret()}`,
  "CLOUD_OPENAI_KEY=",
  "CLOUD_ANTHROPIC_KEY=",
  "CLOUD_GOOGLE_KEY=",
  "CLOUD_OPENROUTER_KEY=",
  "CLOUD_DEEPSEEK_KEY=",
  "CLOUD_TYPESAFE_KEY=",
  "STT_ORIGIN=",
  "STT_KEY=",
];
const handle = await open(file, "wx", 0o600);
try {
  await handle.writeFile(`${lines.join("\n")}\n`);
  await handle.sync();
} catch (error) {
  await handle.close();
  await rm(file, { force: true });
  throw error;
}
await handle.close();
console.log(`Created private self-host environment file at ${file}`);
