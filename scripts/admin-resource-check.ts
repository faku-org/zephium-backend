import { mkdir } from "node:fs/promises";
import { symmetricDecrypt } from "better-auth/crypto";
import { createAdminAuth } from "../src/modules/admin/auth";
import { createAdminDatabase } from "../src/modules/admin/database";
import { provisionAdminOperator } from "../src/modules/admin/operators";
import { registerPolicy } from "../src/modules/policy/policy";
import { testDatabase } from "../tests/support/admin-database";
import { testPolicy } from "../tests/support/cloud-fixture";

const f = await testDatabase();
let child: ReturnType<typeof Bun.spawn> | undefined;
let authDb: ReturnType<typeof createAdminDatabase> | undefined;
await mkdir(".local/admin", { recursive: true });
async function cleanup() {
  child?.kill("SIGTERM");
  if (child) await child.exited;
  await authDb?.close();
  await f.close();
}
try {
  const policy = testPolicy();
  await registerPolicy(f.db, policy);
  await f.db.sql.unsafe(await Bun.file("deploy/postgres/admin-roles.sql").text());
  const urls: string[] = [];
  for (const role of ["zephium_admin_auth", "zephium_admin_report"]) {
    const pass = crypto.randomUUID().replaceAll("-", "");
    await f.db.sql.unsafe(`ALTER ROLE ${role} PASSWORD '${pass}'`);
    const url = new URL(f.config.DATABASE_URL);
    url.username = role;
    url.password = pass;
    urls.push(url.href);
  }
  await f.db
    .sql`INSERT INTO auth_user(id,name,email,email_verified,created_at) SELECT 'fixture-'||i,'Example user '||i,'fixture-'||i||'@example.test',true,now()-i*interval '1 minute' FROM generate_series(1,1000) i`;
  await f.db.sql`INSERT INTO credit_wallet(user_id) SELECT id FROM auth_user`;
  await f.db
    .sql`INSERT INTO cloud_request(id,user_id,session_id,client_key,provider,model_id,route,policy_revision,price_snapshot,cost_rates,usage,state,reserved,charged,dispatched_at,started_at,finished_at,lease_until,hold_until)
    SELECT gen_random_uuid(),u.id,'synthetic','fixture-'||i,'openai','fixture-luna','/openai/v1/responses',${policy.revision},'{}','{}','{"input":1}','settled',10,10,now(),now()-i*interval '1 minute',now(),now(),now() FROM auth_user u CROSS JOIN generate_series(1,5) i`;
  await f.db
    .sql`INSERT INTO cloud_cost_record(request_id,scope,day,reserved,exposure,free_reserved,free_exposure,terminal) SELECT id,'local-qualification',current_date,5,5,5,5,true FROM cloud_request`;
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port;
  await listener.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const [authUrl, reportUrl] = urls;
  if (!authUrl || !reportUrl) throw new Error("Missing fixture roles");
  const env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    ADMIN_ORIGIN: origin,
    ADMIN_PORT: String(port),
    ADMIN_AUTH_SECRET: secret,
    ADMIN_AUTH_DATABASE_URL: authUrl,
    ADMIN_READ_DATABASE_URL: reportUrl,
  };
  authDb = createAdminDatabase(env);
  const authDatabase = authDb;
  const email = "operator@example.test",
    password = "synthetic local review password only";
  await provisionAdminOperator(authDb, email, "Local review", password);
  child = Bun.spawn([process.execPath, "src/apps/admin/main.ts"], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const adminProcess = child;
  const start = performance.now();
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(500) });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Local admin failed readiness");
  const readyMs = performance.now() - start;
  const measurements: { phase: string; rss_kib: number }[] = [];
  const sample = async (phase: string) => {
    const p = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(adminProcess.pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(p.stdout).text();
    if ((await p.exited) === 0) measurements.push({ phase, rss_kib: Number(text.trim()) });
  };
  await sample("ready");
  const cookies = new Map<string, string>();
  const call = async (path: string, body?: object) => {
    const r = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    for (const v of r.headers.getSetCookie()) {
      const pair = v.split(";")[0] ?? "",
        at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    if (!r.ok) throw new Error(`Local qualification HTTP ${r.status} at ${path.split("?")[0]}`);
    return r;
  };
  await call("/auth/sign-in/email", { email, password });
  await sample("password sign-in");
  await call("/auth/two-factor/enable", { password });
  const auth = createAdminAuth(env, authDb);
  const code = async () => {
    const [factor] = await authDatabase.sql`SELECT secret FROM admin_auth_two_factor`;
    const raw = await symmetricDecrypt({ key: secret, data: factor?.secret });
    return (await auth.api.generateTOTP({ body: { secret: raw } })).code;
  };
  await call("/auth/two-factor/verify-totp", { code: await code() });
  await sample("MFA");
  const latency: number[] = [];
  for (let i = 0; i < 12; i++) {
    const t = performance.now();
    const result = await (
      await call(
        i % 3 === 0 ? "/api/overview?days=7" : i % 3 === 1 ? "/api/users" : "/api/users/fixture-1",
      )
    ).json();
    if (i === 0 && result.users.total !== 1000) throw new Error("Synthetic report mismatch");
    latency.push(performance.now() - t);
    await sample(`read ${i + 1}`);
  }
  await sample("after reads");
  const result = {
    scope:
      "local standalone Bun process; synthetic data, excludes PostgreSQL, not staging/container measurement",
    users: 1000,
    requests: 5000,
    ready_ms: Math.round(readyMs),
    rss_samples: measurements,
    observed_max_rss_mib:
      Math.round((Math.max(...measurements.map((m) => m.rss_kib)) / 1024) * 10) / 10,
    report_latency_ms: latency.map((x) => Math.round(x * 10) / 10),
    assets_bytes: {
      html: Bun.file("dist/admin/index.html").size,
      js: Bun.file("dist/admin/client.js").size,
      css: Bun.file("dist/admin/style.css").size,
    },
  };
  await Bun.write(".local/admin/resource-result.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  child.kill("SIGTERM");
  await child.exited;
  const usage = child.resourceUsage();
  if (usage) {
    const final = {
      ...result,
      process_peak_rss_mib: Math.round((Number(usage.maxRSS) / 1024 / 1024) * 10) / 10,
      process_cpu_ms: Math.round(Number(usage.cpuTime.total) / 1000),
    };
    await Bun.write(".local/admin/resource-result.json", JSON.stringify(final, null, 2));
    console.log(
      JSON.stringify({
        process_peak_rss_mib: final.process_peak_rss_mib,
        process_cpu_ms: final.process_cpu_ms,
      }),
    );
  }
} finally {
  await cleanup();
}
