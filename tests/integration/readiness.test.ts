import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../scripts/migrate";
import { applyTopup } from "../../src/modules/credits/grants";
import {
  markDispatched,
  openRequest,
  recoverRequests,
  releaseRequest,
  reserveRequest,
  settleRequest,
  unknownRequest,
  usageSummary,
} from "../../src/modules/credits/ledger";
import { emptyUsage } from "../../src/modules/credits/pricing";
import { assertActivePolicy, registerPolicy } from "../../src/modules/policy/policy";
import { createDatabase } from "../../src/platform/db";
import { createCloudAccount, testPolicy } from "../support/cloud-fixture";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
}, 30000);
afterEach(async () => {
  await fixture?.close();
});
const required = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error("fixture");
  return x;
};
async function setup(budgets = false) {
  const base = testPolicy();
  const model = { ...required(base.models[0]), costRates: required(base.models[0]).rates };
  const policy = testPolicy({
    models: [model],
    limits: {
      ...base.limits,
      unconfirmedRequestsPerUserDay: 2,
      ...(budgets
        ? {
            budgets: {
              scope: crypto.randomUUID(),
              totalUsdMicros: "50",
              dailyUsdMicros: "20",
              freeDailyUsdMicros: "8",
            },
          }
        : {}),
    },
  });
  await registerPolicy(fixture.db, policy);
  return { policy, model, ...(await createCloudAccount(fixture.db)) };
}
type Context = Omit<Awaited<ReturnType<typeof setup>>, "model"> & {
  model: import("../../src/modules/policy/policy").Model;
};
const open = (c: Context) =>
  openRequest(fixture.db, c.policy, c.model, c.userId, c.sessionId, crypto.randomUUID(), "openai");
const reserve = (c: Context, id: string, cost = 5n) =>
  reserveRequest(fixture.db, c.policy, c.model, id, c.userId, c.sessionId, cost, 1, cost);

test("an account billing lock does not block unrelated admissions", async () => {
  const a = await setup();
  const b = { ...a, ...(await createCloudAccount(fixture.db)) };
  let unlock = () => {};
  let locked = () => {};
  const ready = new Promise<void>((r) => {
    locked = r;
  });
  const gate = new Promise<void>((r) => {
    unlock = r;
  });
  const holder = fixture.db.sql.begin(async (tx) => {
    await tx`SELECT user_id FROM billing_customer WHERE user_id=${a.userId} FOR UPDATE`;
    locked();
    await gate;
  });
  await ready;
  const pending = open(a);
  try {
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const [row] = await fixture.db
        .sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%FOR SHARE OF b,u%') AS blocked`;
      if (row?.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    const result = await Promise.race([
      open(b),
      Bun.sleep(2000).then(() => {
        throw new Error("unrelated admission blocked");
      }),
    ]);
    await releaseRequest(fixture.db, result.id, b.userId, "test_cleanup");
  } finally {
    unlock();
    await holder;
    const result = await pending;
    await releaseRequest(fixture.db, result.id, a.userId, "test_cleanup");
  }
});

test("unknown cancellation refunds customer credits but cannot recycle risk admission", async () => {
  const c = await setup();
  const before = await usageSummary(fixture.db, c.policy, c.userId);
  for (let i = 0; i < 2; i++) {
    const r = await open(c);
    await reserve(c, r.id);
    await markDispatched(fixture.db, r.id, c.userId, c.sessionId);
    await unknownRequest(fixture.db, r.id, c.userId, "client_disconnected");
    await fixture.db
      .sql`UPDATE cloud_request SET hold_until=clock_timestamp()-interval '1 second' WHERE id=${r.id}`;
    await recoverRequests(fixture.db);
  }
  expect((await usageSummary(fixture.db, c.policy, c.userId)).credits_remaining).toBe(
    before.credits_remaining,
  );
  await expect(open(c)).rejects.toMatchObject({ code: "usage_confirmation_limited", status: 429 });
});

test("free subsidy exhaustion permits prepaid topups but does not remove global cost ceiling", async () => {
  const c = await setup(true);
  const first = await open(c);
  await reserve(c, first.id, 8n);
  await markDispatched(fixture.db, first.id, c.userId, c.sessionId);
  await settleRequest(fixture.db, first.id, c.userId, { ...emptyUsage(), input: 8 }, 200, null);
  const second = await open(c);
  await expect(reserve(c, second.id)).rejects.toMatchObject({
    code: "free_usage_limit_reached",
    status: 429,
  });
  await applyTopup(fixture.db, c.policy, {
    id: crypto.randomUUID(),
    userId: c.userId,
    productId: required(c.policy.topups[0]).productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
  });
  await reserve(c, second.id, 5n);
  const rows = await fixture.db
    .sql`SELECT g.kind FROM credit_allocation a JOIN credit_grant g ON g.id=a.grant_id WHERE a.request_id=${second.id}`;
  expect(rows.map((r) => r.kind)).toEqual(["topup"]);
  const third = await open(c);
  await expect(reserve(c, third.id, 8n)).rejects.toMatchObject({
    code: "cloud_budget_exhausted",
    status: 503,
  });
  await releaseRequest(fixture.db, second.id, c.userId, "not_dispatched");
  await reserve(c, third.id, 8n);
  await releaseRequest(fixture.db, third.id, c.userId, "test_cleanup");
});

test("unconfirmed provider exposure survives refund and account deletion", async () => {
  const c = await setup(true);
  const r = await open(c);
  await reserve(c, r.id, 8n);
  await markDispatched(fixture.db, r.id, c.userId, c.sessionId);
  await unknownRequest(fixture.db, r.id, c.userId, "stream_interrupted");
  await fixture.db
    .sql`UPDATE cloud_request SET hold_until=now()-interval '1 second' WHERE id=${r.id}`;
  await recoverRequests(fixture.db);
  await fixture.db.sql`DELETE FROM auth_user WHERE id=${c.userId}`;
  const [record] = await fixture.db
    .sql`SELECT exposure,terminal FROM cloud_cost_record WHERE request_id=${r.id}`;
  expect(String(record?.exposure)).toBe("8");
  expect(record?.terminal).toBe(false);
  const [total] = await fixture.db
    .sql`SELECT amount FROM cloud_spend_bucket WHERE key=${`${c.policy.limits.budgets?.scope}:total`}`;
  expect(String(total?.amount)).toBe("8");
});

test("read-only account usage export remains accessible during billing review", async () => {
  const c = await setup();
  await usageSummary(fixture.db, c.policy, c.userId);
  await fixture.db.sql`UPDATE credit_wallet SET suspended=true WHERE user_id=${c.userId}`;
  await expect(usageSummary(fixture.db, c.policy, c.userId)).rejects.toMatchObject({
    code: "billing_review_required",
  });
  expect((await usageSummary(fixture.db, c.policy, c.userId, true)).plan).toBe("free");
});

test("failed real API startup cannot activate an unregistered candidate policy", async () => {
  const c = await setup();
  const dir = await mkdtemp(join(tmpdir(), "zephium-startup-"));
  try {
    const candidate = { ...c.policy, revision: c.policy.revision + 1 };
    const path = join(dir, "candidate.json");
    await Bun.write(path, JSON.stringify(candidate));
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "src/apps/api/main.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        NODE_ENV: "test",
        DATABASE_URL: fixture.config.DATABASE_URL,
        AUTH_SECRET: "a".repeat(40),
        ABUSE_SECRET: "b".repeat(40),
        ELIGIBILITY_SECRET: "c".repeat(40),
        CLOUD_CONFIG_PATH: path,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => process.kill(), 10000);
    const [code, , stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    clearTimeout(timer);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Policy is not active");
    await assertActivePolicy(fixture.db, c.policy);
    const r = await open(c);
    await releaseRequest(fixture.db, r.id, c.userId, "test_cleanup");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("locally generated concurrency and quota errors carry Retry-After", async () => {
  const c = await setup();
  const a = await open(c);
  const b = await open(c);
  await expect(open(c)).rejects.toMatchObject({ code: "concurrency_limited", retryAfter: 1 });
  await releaseRequest(fixture.db, a.id, c.userId, "test_cleanup");
  await releaseRequest(fixture.db, b.id, c.userId, "test_cleanup");
});

test("daily spending follows reservation day across midnight and resets the following UTC day", async () => {
  const original = await setup();
  const policy = testPolicy({
    ...original.policy,
    revision: original.policy.revision + 1,
    plans: original.policy.plans.map((plan) => ({ ...plan, dailyLimitUnits: "5" })),
  });
  await registerPolicy(fixture.db, policy);
  const c = { ...original, policy };
  const first = await open(c);
  // Simulate preflight beginning just before midnight, with reservation occurring today.
  await fixture.db.sql`UPDATE cloud_request SET started_at=
    (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 millisecond'
    WHERE id=${first.id}`;
  await reserve(c, first.id, 5n);
  const [reserved] = await fixture.db.sql`SELECT reserved_at>=
    date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS today
    FROM cloud_request WHERE id=${first.id}`;
  expect(reserved?.today).toBe(true);
  const second = await open(c);
  await expect(reserve(c, second.id, 5n)).rejects.toMatchObject({ code: "daily_limit_reached" });
  await markDispatched(fixture.db, first.id, c.userId, c.sessionId);
  await settleRequest(fixture.db, first.id, c.userId, { ...emptyUsage(), input: 5 }, 200, null);
  expect((await usageSummary(fixture.db, policy, c.userId)).spent_today).toBe("5");
  await expect(reserve(c, second.id, 5n)).rejects.toMatchObject({ code: "daily_limit_reached" });
  // Simulate the next UTC day without changing request/credit expiry or wall-clock time.
  await fixture.db.sql`UPDATE cloud_request SET reserved_at=
    (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 millisecond'
    WHERE id=${first.id}`;
  expect((await usageSummary(fixture.db, policy, c.userId)).spent_today).toBe("0");
  await reserve(c, second.id, 5n);
  await releaseRequest(fixture.db, second.id, c.userId, "test_cleanup");
});

test("runtime role can dispatch and settle but cannot activate policy", async () => {
  const c = await setup();
  const password = crypto.randomUUID();
  await fixture.db.sql.unsafe(`CREATE ROLE zephium_app LOGIN PASSWORD '${password}'`);
  await fixture.db.sql`GRANT USAGE ON SCHEMA public TO zephium_app`;
  await fixture.db
    .sql`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO zephium_app`;
  await migrate(fixture.db);
  const url = new URL(fixture.config.DATABASE_URL);
  url.username = "zephium_app";
  url.password = password;
  const appDb = createDatabase({ ...fixture.config, DATABASE_URL: url.href });
  try {
    await assertActivePolicy(appDb, c.policy);
    const r = await openRequest(
      appDb,
      c.policy,
      c.model,
      c.userId,
      c.sessionId,
      crypto.randomUUID(),
      "openai",
    );
    await reserveRequest(appDb, c.policy, c.model, r.id, c.userId, c.sessionId, 5n, 1);
    await markDispatched(appDb, r.id, c.userId, c.sessionId);
    await settleRequest(appDb, r.id, c.userId, { ...emptyUsage(), input: 2 }, 200, null);
    const orderId = crypto.randomUUID();
    await applyTopup(appDb, c.policy, {
      id: orderId,
      userId: c.userId,
      productId: required(c.policy.topups[0]).productId,
      policyRevision: c.policy.revision,
      createdAt: new Date(),
      paid: true,
      refunded: false,
    });
    expect(
      await appDb.sql`SELECT id FROM credit_grant WHERE user_id=${c.userId} AND grant_key=${`polar-order:${orderId}`}`,
    ).toHaveLength(1);
    await expect(
      registerPolicy(appDb, { ...c.policy, revision: c.policy.revision + 1 }),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await appDb.close();
  }
});

test("parallel accounts cannot overbook the same deployment budget", async () => {
  const a = await setup(true);
  const b = { ...a, ...(await createCloudAccount(fixture.db)) };
  await applyTopup(fixture.db, a.policy, {
    id: crypto.randomUUID(),
    userId: a.userId,
    productId: required(a.policy.topups[0]).productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
  });
  await applyTopup(fixture.db, b.policy, {
    id: crypto.randomUUID(),
    userId: b.userId,
    productId: required(b.policy.topups[0]).productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
  });
  const ra = await open(a);
  const rb = await open(b);
  const results = await Promise.allSettled([reserve(a, ra.id, 15n), reserve(b, rb.id, 15n)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    results
      .filter((r) => r.status === "rejected")
      .map((r) => (r as PromiseRejectedResult).reason.code),
  ).toEqual(["cloud_budget_exhausted"]);
});

test("free concurrency headroom leaves an admission slot for paid accounts", async () => {
  const base = testPolicy();
  const productId = crypto.randomUUID();
  const policy = testPolicy({
    limits: { ...base.limits, globalConcurrent: 2, maxFreeConcurrent: 1 },
    plans: [required(base.plans[0]), { ...required(base.plans[0]), id: "pro", rank: 1 }],
    subscriptions: [{ productId, plan: "pro", interval: "monthly" }],
    models: [{ ...required(base.models[0]), plans: ["free", "pro"] }],
  });
  await registerPolicy(fixture.db, policy);
  const a = {
    policy,
    model: required(policy.models[0]),
    ...(await createCloudAccount(fixture.db)),
  };
  const b = { ...a, ...(await createCloudAccount(fixture.db)) };
  await open(a);
  await expect(open(b)).rejects.toMatchObject({ code: "concurrency_limited", retryAfter: 1 });
  await fixture.db
    .sql`UPDATE billing_customer SET status='active',product_id=${productId},paid_until=clock_timestamp()+interval '1 day',reconciled_at=clock_timestamp() WHERE user_id=${b.userId}`;
  expect((await open(b)).plan).toBe("pro");
});

test("failed PostgreSQL fixture startup reports a port conflict and removes temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pg-repro-"));
  const originalTmpdir = process.env.TMPDIR;
  const occupiedPort = Number(new URL(fixture.config.DATABASE_URL).port);
  try {
    process.env.TMPDIR = directory;
    await expect(testDatabase({ port: occupiedPort })).rejects.toThrow(
      "PostgreSQL test fixture startup failed (address_in_use)",
    );
    expect(await readdir(directory)).toEqual([]);
    const [row] = await fixture.db.sql`SELECT 1 AS alive`;
    expect(row?.alive).toBe(1);
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent PostgreSQL fixtures obtain distinct OS-selected ports without disturbing existing fixtures", async () => {
  const results = await Promise.allSettled([testDatabase(), testDatabase(), testDatabase()]);
  const opened = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  try {
    expect(opened).toHaveLength(3);
    const ports = [fixture, ...opened].map((entry) => new URL(entry.config.DATABASE_URL).port);
    expect(new Set(ports).size).toBe(4);
    for (const entry of [fixture, ...opened]) {
      const [row] = await entry.db.sql`SELECT 1 AS alive`;
      expect(row?.alive).toBe(1);
    }
  } finally {
    await Promise.all(opened.map((entry) => entry.close()));
  }
});
