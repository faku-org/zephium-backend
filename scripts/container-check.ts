import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Container-only recovery check. Run explicitly; it fails rather than silently skipping without Docker.
const suffix = crypto.randomUUID().slice(0, 8),
  image = `zephium-backup-check:${suffix}`;
const first = `zephium-db-${suffix}`,
  second = `zephium-restored-${suffix}`,
  volume = `zephium-backup-${suffix}`,
  restoredVolume = `zephium-restore-${suffix}`;
const directory = await mkdtemp(join(tmpdir(), "zephium-backup-check-"));
const password = crypto.randomUUID(),
  cipher = crypto.randomUUID();
async function docker(args: string[], timeout = 60000) {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeout);
  try {
    const [code, out, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    if (code !== 0) {
      const step =
        args[0] === "exec"
          ? (args.find((arg) =>
              ["pgbackrest", "pg_isready", "psql", "chown", "mkdir"].includes(arg),
            ) ?? "exec")
          : args[0];
      const diagnostic = `${out}\n${stderr}`
        .replaceAll(password, "[redacted]")
        .replaceAll(cipher, "[redacted]")
        .slice(-4096);
      throw new Error(
        `Docker check failed: ${step} ${args.filter((arg) => ["stanza-create", "check", "backup", "restore"].includes(arg)).join(" ")}\n${diagnostic}`,
      );
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
const environment = [
  "-e",
  `POSTGRES_PASSWORD=${password}`,
  "-e",
  "PGBACKREST_REPO1_TYPE=posix",
  "-e",
  "PGBACKREST_REPO1_PATH=/backups",
  "-e",
  "PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc",
  "-e",
  `PGBACKREST_REPO1_CIPHER_PASS=${cipher}`,
];
const backupArgs = ["--stanza=zephium", "--log-level-console=error"];
try {
  await docker(["version"]);
  await docker(["build", "-f", "deploy/postgres/Dockerfile", "-t", image, "."], 600000);
  const config = join(directory, "pgbackrest.conf");
  await writeFile(
    config,
    "[zephium]\npg1-path=/var/lib/postgresql/18/docker\n[global]\nrepo1-retention-full=2\n",
    { mode: 0o644 },
  );
  const mounts = ["-v", `${volume}:/backups`, "-v", `${config}:/etc/pgbackrest/pgbackrest.conf:ro`];
  await docker([
    "run",
    "-d",
    "--name",
    first,
    ...environment,
    ...mounts,
    image,
    "postgres",
    "-c",
    "archive_mode=on",
    "-c",
    "archive_timeout=60s",
    "-c",
    "archive_command=pgbackrest --stanza=zephium archive-push %p",
  ]);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      await docker(["exec", first, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
  if (!ready) throw new Error("PostgreSQL did not become ready");
  await docker(["exec", "-u", "root", first, "chown", "postgres:postgres", "/backups"]);
  await docker(["exec", "-u", "postgres", first, "pgbackrest", ...backupArgs, "stanza-create"]);
  await docker([
    "exec",
    "-u",
    "postgres",
    first,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "CREATE TABLE recovery_fixture(id integer PRIMARY KEY, value text); INSERT INTO recovery_fixture VALUES (1, 'durable');",
  ]);
  await docker(["exec", "-u", "postgres", first, "pgbackrest", ...backupArgs, "check"]);
  await docker([
    "exec",
    "-u",
    "postgres",
    first,
    "pgbackrest",
    ...backupArgs,
    "--type=full",
    "backup",
  ]);
  await docker(["rm", "-f", "-v", first]);
  // Restore to a new volume with the original database container gone.
  await docker([
    "run",
    "--rm",
    "-u",
    "root",
    "-v",
    `${restoredVolume}:/var/lib/postgresql`,
    image,
    "sh",
    "-c",
    "mkdir -p /var/lib/postgresql/18/docker && chown -R postgres:postgres /var/lib/postgresql",
  ]);
  await docker([
    "run",
    "--rm",
    "-u",
    "postgres",
    ...environment,
    ...mounts,
    "-v",
    `${restoredVolume}:/var/lib/postgresql`,
    image,
    "pgbackrest",
    ...backupArgs,
    "--type=immediate",
    "--target-action=promote",
    "--archive-mode=off",
    "restore",
  ]);
  await docker([
    "run",
    "-d",
    "--name",
    second,
    ...environment,
    ...mounts,
    "-v",
    `${restoredVolume}:/var/lib/postgresql`,
    image,
  ]);
  let value = "";
  for (let i = 0; i < 60; i++) {
    try {
      value = (
        await docker([
          "exec",
          "-u",
          "postgres",
          second,
          "psql",
          "-At",
          "-c",
          "SELECT value || ':' || (NOT pg_is_in_recovery())::text || ':' || current_setting('archive_mode') FROM recovery_fixture WHERE id=1",
        ])
      ).trim();
      if (value === "durable:true:off") break;
    } catch {}
    await Bun.sleep(250);
  }
  if (value !== "durable:true:off") throw new Error("Restored data did not match");
  console.log("Encrypted pgBackRest backup, WAL check and independent restore passed.");
} finally {
  for (const name of [first, second]) await docker(["rm", "-f", "-v", name]).catch(() => {});
  for (const name of [volume, restoredVolume]) await docker(["volume", "rm", name]).catch(() => {});
  await docker(["image", "rm", image]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
