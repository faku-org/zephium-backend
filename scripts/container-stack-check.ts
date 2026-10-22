import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const unique = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const project = `zephiumstack${unique}`;
const accountImage = `zephium-stack-check:${unique}-account`;
const workerImage = `zephium-stack-check:${unique}-worker`;
const postgresImage = `zephium-stack-check:${unique}-postgres`;
const directory = await mkdtemp(join(tmpdir(), "zephium-stack-check-"));
const envFile = join(directory, "self-host.env");
const policyFile = join(directory, "self-host.json");
const backupFile = join(directory, "pgbackrest.conf");
const privateValues = new Set<string>();
const compose = [
  "docker",
  "compose",
  "--project-name",
  project,
  "--env-file",
  envFile,
  "-f",
  "deploy/compose.self-host.yaml",
];

async function drain(stream: ReadableStream<Uint8Array>, maximum = 64 * 1024): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let stored = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (stored < maximum) {
        const part = value.subarray(0, maximum - stored);
        chunks.push(part);
        stored += part.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString().trim();
}
async function processResult(args: string[], seconds: number) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(9);
  }, seconds * 1000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      drain(child.stdout),
      drain(child.stderr),
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
async function checked(label: string, args: string[], seconds: number) {
  const result = await processResult(args, seconds);
  if (result.code !== 0 || result.timedOut) {
    let diagnostic = `${result.stdout}\n${result.stderr}`;
    for (const value of privateValues)
      if (value) diagnostic = diagnostic.replaceAll(value, "[redacted]");
    throw new Error(`${label} failed or timed out\n${diagnostic.slice(-4096)}`);
  }
  return result.stdout;
}
const comp = (args: string[]) => [...compose, ...args];
async function container(service: string) {
  const id = await checked(`${service} container lookup`, comp(["ps", "-q", service]), 15);
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error(`${service} container missing`);
  return id;
}
async function waitFor(label: string, probe: () => Promise<boolean>, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch {
      /* A starting service may not answer yet. */
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${label} did not become ready`);
}
async function health(service: string) {
  const id = await container(service);
  return (
    (await checked(
      `${service} health inspection`,
      ["docker", "inspect", "--format", "{{.State.Health.Status}}", id],
      10,
    )) === "healthy"
  );
}
async function appRole(sql: string) {
  return processResult(
    comp([
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'exec env PGPASSWORD="$ZEPHIUM_APP_PASSWORD" psql -X -h 127.0.0.1 -U zephium_app -d zephium -At -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$1"',
      "--",
      sql,
    ]),
    15,
  );
}

let completed = false;
let cleanupFailed = false;
try {
  await checked("Docker daemon", ["docker", "version", "--format", "{{.Server.Version}}"], 15);
  await checked(
    "account image build",
    ["docker", "build", "--target", "account", "-t", accountImage, "."],
    480,
  );
  await checked(
    "worker image build",
    ["docker", "build", "--target", "worker", "-t", workerImage, "."],
    480,
  );
  await checked(
    "PostgreSQL image build",
    ["docker", "build", "-f", "deploy/postgres/Dockerfile", "-t", postgresImage, "."],
    480,
  );

  await checked("private env fixture", ["bun", "scripts/self-host-env.ts", envFile], 15);
  const policy = JSON.parse(await readFile("config/self-host.json", "utf8"));
  if (policy.enabled !== false) throw new Error("Self-host test policy must start disabled");
  await copyFile("config/self-host.json", policyFile);
  const backup =
    "[global]\nrepo1-type=posix\nrepo1-path=/var/lib/postgresql/backups\nlog-level-console=error\nlog-level-file=off\n[zephium]\npg1-path=/var/lib/postgresql/18/docker\npg1-user=zephium_owner\n";
  await writeFile(backupFile, backup, { mode: 0o644 });
  const values = new Map(
    (await readFile(envFile, "utf8"))
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );
  for (const [key, value] of values) {
    if (/(PASSWORD|SECRET|KEY|DATABASE_URL)/.test(key)) privateValues.add(value);
  }
  const port = 21000 + Math.floor(Math.random() * 30000);
  for (const [key, value] of Object.entries({
    ZEPHIUM_ACCOUNT_IMAGE: accountImage,
    ZEPHIUM_WORKER_IMAGE: workerImage,
    ZEPHIUM_POSTGRES_IMAGE: postgresImage,
    ZEPHIUM_POLICY_FILE: policyFile,
    ZEPHIUM_PGBACKREST_CONFIG_FILE: backupFile,
    ZEPHIUM_LOCAL_PORT: String(port),
    API_ORIGIN: "https://api.example.test",
    TRUSTED_ORIGINS: "https://api.example.test",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    EMAIL_FROM: "CI <ci@example.test>",
    SOURCE_URL: "https://example.test/zephium-source",
    RESEND_API_KEY: "ci-only-no-live-email",
    SIGNUP_OPEN: "false",
  }))
    values.set(key, value);
  await writeFile(envFile, `${[...values].map(([key, value]) => `${key}=${value}`).join("\n")}\n`, {
    mode: 0o600,
  });
  if (((await stat(envFile)).mode & 0o077) !== 0)
    throw new Error("Private Compose env fixture permissions are too broad");

  await checked("Compose interpolation", comp(["config", "--quiet"]), 20);

  // Production must support deliberate open enrollment without weakening staging's guard.
  const productionEnvFile = join(directory, "production.env");
  const productionValues = new Map(values);
  productionValues.set("ZEPHIUM_PROXY_NETWORK", "ci-production-private-proxy");
  productionValues.set("OPERATIONS_WEBHOOK", "https://alerts.example.test/ci");
  productionValues.set("BILLING_RETURN_URL", "https://example.test/billing/return");
  productionValues.set("BILLING_SUCCESS_URL", "https://example.test/billing/return");
  productionValues.set("SIGNUP_EMAIL_ALLOWLIST", "");
  productionValues.set("CLIENT_MIN_VERSION", "1.0.0-beta.2");
  await writeFile(
    productionEnvFile,
    `${[...productionValues].map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  const rendered = JSON.parse(
    await checked(
      "Production Compose interpolation",
      [
        "docker",
        "compose",
        "--env-file",
        productionEnvFile,
        "-f",
        "deploy/compose.production.yaml",
        "config",
        "--format",
        "json",
      ],
      20,
    ),
  );
  if (
    rendered.services.api.environment.POLAR_ENVIRONMENT !== "production" ||
    rendered.services.api.environment.SIGNUP_EMAIL_ALLOWLIST !== "" ||
    rendered.services.api.environment.SIGNUP_OPEN !== "false" ||
    rendered.services.api.environment.CLIENT_MIN_VERSION !== "1.0.0-beta.2" ||
    rendered.services.postgres.command.includes("archive_mode=off") ||
    !rendered.services.postgres.volumes.some(
      (v: {
        source: string;
        target: string;
        read_only: boolean;
        bind?: { create_host_path?: boolean };
      }) =>
        v.source === "/etc/zephium/backups/pgbackrest.conf" &&
        v.target === "/etc/pgbackrest/pgbackrest.conf" &&
        v.read_only &&
        v.bind?.create_host_path === false,
    ) ||
    "ZEPHIUM_MIGRATOR_PASSWORD" in rendered.services.api.environment ||
    "POSTGRES_PASSWORD" in rendered.services.api.environment
  )
    throw new Error("Production deployment isolation or backup configuration invalid");
  const restricted = await processResult(
    [
      "docker",
      "compose",
      "--env-file",
      productionEnvFile,
      "-f",
      "deploy/compose.staging.yaml",
      "config",
      "--quiet",
    ],
    20,
  );
  if (
    restricted.code === 0 ||
    restricted.timedOut ||
    !restricted.stderr.includes("SIGNUP_EMAIL_ALLOWLIST")
  )
    throw new Error("Staging must reject an empty signup allowlist");
  await checked("PostgreSQL start", comp(["up", "-d", "postgres"]), 120);
  await waitFor("PostgreSQL", () => health("postgres"));
  await checked(
    "local backup directory",
    comp([
      "exec",
      "-T",
      "-u",
      "root",
      "postgres",
      "sh",
      "-c",
      "mkdir -p /var/lib/postgresql/backups && chown postgres:postgres /var/lib/postgresql/backups",
    ]),
    20,
  );
  await checked(
    "pgBackRest stanza",
    comp([
      "exec",
      "-T",
      "-u",
      "postgres",
      "postgres",
      "pgbackrest",
      "--stanza=zephium",
      "stanza-create",
    ]),
    45,
  );
  await checked(
    "pgBackRest archive check",
    comp(["exec", "-T", "-u", "postgres", "postgres", "pgbackrest", "--stanza=zephium", "check"]),
    60,
  );
  await checked("Compose stack start", comp(["up", "-d"]), 180);
  await waitFor("API", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    return response.ok;
  });
  await waitFor("worker", () => health("worker"));
  await checked(
    "restricted avatar native processor",
    comp(["exec", "-T", "api", "bun", "scripts/avatar-smoke.ts"]),
    20,
  );

  const apiId = await container("api");
  const workerId = await container("worker");
  const postgresId = await container("postgres");
  for (const [name, id] of [
    ["postgres", postgresId],
    ["worker", workerId],
  ] as const) {
    const raw = await checked(
      `${name} port inspection`,
      ["docker", "inspect", "--format", "{{json .HostConfig.PortBindings}}", id],
      10,
    );
    const bindings = JSON.parse(raw) as Record<
      string,
      { HostIp: string; HostPort: string }[] | null
    > | null;
    if (bindings && Object.values(bindings).some((ports) => ports?.length))
      throw new Error(`${name} unexpectedly published a host port`);
  }
  const rawApiPorts = await checked(
    "API port inspection",
    ["docker", "inspect", "--format", "{{json .HostConfig.PortBindings}}", apiId],
    10,
  );
  const apiPorts = JSON.parse(rawApiPorts) as Record<
    string,
    { HostIp: string; HostPort: string }[]
  >;
  if (
    apiPorts["3000/tcp"]?.length !== 1 ||
    apiPorts["3000/tcp"]?.[0]?.HostIp !== "127.0.0.1" ||
    apiPorts["3000/tcp"]?.[0]?.HostPort !== String(port)
  )
    throw new Error("API listener was not bound only to host loopback");
  for (const [name, id] of [
    ["api", apiId],
    ["worker", workerId],
  ] as const) {
    const settings = await checked(
      `${name} security inspection`,
      ["docker", "inspect", "--format", "{{.HostConfig.ReadonlyRootfs}} {{.Config.User}}", id],
      10,
    );
    if (settings !== "true bun") throw new Error(`${name} root filesystem or user is unsafe`);
  }
  await checked(
    "API temporary write",
    comp([
      "exec",
      "-T",
      "api",
      "sh",
      "-c",
      'test "$(id -un)" = bun && test -w /tmp && test ! -w /app',
    ]),
    10,
  );
  await checked(
    "worker temporary write",
    comp([
      "exec",
      "-T",
      "worker",
      "sh",
      "-c",
      'test "$(id -un)" = bun && test -w /tmp && test ! -w /app',
    ]),
    10,
  );

  const configuration = await fetch(`http://127.0.0.1:${port}/v1/client-config`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!configuration.ok) throw new Error("Public client config failed");
  const body = (await configuration.json()) as {
    cloud_enabled?: boolean;
    billing_enabled?: boolean;
    signup_open?: boolean;
  };
  if (body.cloud_enabled !== false || body.billing_enabled !== false || body.signup_open !== false)
    throw new Error("First-use client config was not disabled");
  const source = await fetch(`http://127.0.0.1:${port}/v1/source`, {
    signal: AbortSignal.timeout(3000),
  });
  const sourceOffer = (await source.json()) as { license?: string; source_url?: string };
  if (
    !source.ok ||
    sourceOffer.license !== "AGPL-3.0-only" ||
    sourceOffer.source_url !== "https://example.test/zephium-source"
  )
    throw new Error("Public source offer did not match the configured release URL");
  const denied = await fetch(`http://127.0.0.1:${port}/v1/billing`, {
    signal: AbortSignal.timeout(3000),
  });
  await denied.body?.cancel();
  if (denied.status !== 401) throw new Error("Unauthenticated billing access was not denied");

  const migrations = await appRole("SELECT count(*) FROM schema_migration");
  const migrationCount = (await readdir(join(root, "migrations"))).filter((name) =>
    /^\d+_.+\.sql$/.test(name),
  ).length;
  if (migrations.code !== 0 || Number(migrations.stdout) !== migrationCount)
    throw new Error("App role cannot read all expected migration rows");
  const privilege = await appRole(
    "SELECT current_user || ':' || has_schema_privilege(current_user, 'public', 'CREATE')::text",
  );
  if (privilege.code !== 0 || privilege.stdout !== "zephium_app:false")
    throw new Error("Runtime role has unexpected schema privileges");
  const avatarPrivileges = await appRole(
    "SELECT bool_and(has_table_privilege(current_user, 'account_avatar', privilege))::text FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privilege",
  );
  if (avatarPrivileges.code !== 0 || avatarPrivileges.stdout !== "true")
    throw new Error("Runtime role cannot maintain account avatars");
  const create = await appRole("CREATE TABLE zephium_stack_forbidden(id integer)");
  // psql -c and script execution use different nonzero exit statuses. Assert the
  // actual PostgreSQL permission denial instead of mistaking exit 1 for success.
  if (create.code === 0 || create.timedOut || !create.stderr.includes("42501"))
    throw new Error(`Expected PostgreSQL permission denial, received exit ${create.code}`);
  completed = true;
} finally {
  const down = await processResult(
    comp(["down", "-v", "--remove-orphans", "--timeout", "20"]),
    90,
  ).catch(() => null);
  const images = await processResult(
    ["docker", "image", "rm", accountImage, workerImage, postgresImage],
    30,
  ).catch(() => null);
  await rm(directory, { recursive: true, force: true });
  cleanupFailed = down?.code !== 0 || images?.code !== 0;
}
if (cleanupFailed) throw new Error("Unique self-host smoke project cleanup failed");
if (completed)
  console.log(
    "Self-host Compose stack, private roles, migration, disabled API, worker health and root filesystem checks passed.",
  );
