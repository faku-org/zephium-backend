import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { cycleAt, registerPolicy } from "../../policy/policy";
import { applyTopup } from "../grants";
import {
  markDispatched,
  openRequest,
  recoverRequests,
  releaseRequest,
  reserveRequest,
  settleRequest,
  unknownRequest,
  usageSummary,
} from "../ledger";
import { charge, emptyUsage, holdCost } from "../pricing";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

async function setup(policy = testPolicy()) {
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  const model = required(policy.models[0]);
  return { policy, model, ...account };
}
async function opened(ctx: Awaited<ReturnType<typeof setup>>, key = crypto.randomUUID()) {
  return openRequest(
    fixture.db,
    ctx.policy,
    ctx.model,
    ctx.userId,
    ctx.sessionId,
    key,
    "/v1/chat/completions",
  );
}
async function grants(userId: string) {
  return fixture.db
    .sql`SELECT kind,grant_key,amount,spent,held,revoked,policy_revision,expires_at FROM credit_grant WHERE user_id=${userId} ORDER BY kind,grant_key`;
}
async function requestRow(id: string) {
  return required(
    (
      await fixture.db
        .sql`SELECT state,reserved,charged,actual_cost,price_snapshot,error_class FROM cloud_request WHERE id=${id}`
    )[0],
  );
}
function codeOf(result: PromiseSettledResult<unknown>) {
  return result.status === "rejected" ? (result.reason as { code?: string }).code : "ok";
}

test("charge uses exact bigints and treats reasoning as part of output", () => {
  const rates = required(testPolicy().models[0]).rates;
  expect(
    charge(
      {
        input: 10,
        cachedInput: 4,
        cacheWrite5m: 2,
        cacheWrite1h: 1,
        output: 7,
        reasoning: 3,
        searchCalls: 2,
      },
      rates,
    ),
  ).toBe(55n);
  expect(
    charge({ ...emptyUsage(), input: 1_000_000_000 }, { ...rates, input: "999999999999999" }),
  ).toBe(999999999999999000n);
  expect(holdCost(10, 7, 2, rates)).toBe(75n);
});

test("calendar cycles clamp month-end anchors, including leap February", () => {
  const monthly = { kind: "calendar_month" } as const;
  const feb = cycleAt(
    new Date("2025-01-31T09:00:00.000Z"),
    new Date("2025-02-28T12:00:00.000Z"),
    monthly,
  );
  expect(feb.start.toISOString()).toBe("2025-02-28T09:00:00.000Z");
  expect(feb.end.toISOString()).toBe("2025-03-31T09:00:00.000Z");
  expect(
    cycleAt(
      new Date("2024-01-31T09:00:00.000Z"),
      new Date("2024-02-29T12:00:00.000Z"),
      monthly,
    ).start.toISOString(),
  ).toBe("2024-02-29T09:00:00.000Z");
});

test("a policy revision cannot be reused with changed content", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  await registerPolicy(fixture.db, policy);
  await expect(registerPolicy(fixture.db, { ...policy, welcomeUnits: "21" })).rejects.toThrow(
    "revision reused",
  );
  expect(
    (
      await fixture.db
        .sql`SELECT count(*)::integer AS count FROM cloud_policy WHERE revision=${policy.revision}`
    )[0]?.count,
  ).toBe(1);
});

test("welcome and period grants are once-only under concurrent account reads", async () => {
  const ctx = await setup();
  await Promise.all(
    Array.from({ length: 6 }, () => usageSummary(fixture.db, ctx.policy, ctx.userId)),
  );
  const rows = await grants(ctx.userId);
  expect(rows.filter((g) => g.kind === "welcome")).toHaveLength(1);
  expect(rows.filter((g) => g.kind === "included")).toHaveLength(1);
  expect(rows.map((g) => [g.kind, String(g.amount)])).toEqual([
    ["included", "100"],
    ["welcome", "20"],
  ]);
  expect((await usageSummary(fixture.db, ctx.policy, ctx.userId)).credits_remaining).toBe("120");
});

test("prospective quota edits preserve an already issued period grant", async () => {
  const ctx = await setup();
  await usageSummary(fixture.db, ctx.policy, ctx.userId);
  const original = required((await grants(ctx.userId)).find((g) => g.kind === "included"));
  const revised = testPolicy({
    plans: [{ ...required(ctx.policy.plans[0]), allowanceUnits: "300" }],
  });
  await registerPolicy(fixture.db, revised);
  const result = await usageSummary(fixture.db, revised, ctx.userId);
  const current = (await grants(ctx.userId)).filter((g) => g.kind === "included");
  expect(current).toHaveLength(1);
  expect(String(current[0]?.amount)).toBe("100");
  expect(new Date(current[0]?.expires_at).toISOString()).toBe(
    new Date(original.expires_at).toISOString(),
  );
  expect(result.allowance.total_units).toBe("100");
});

test("parallel reservations cannot both spend the same balance", async () => {
  const ctx = await setup();
  const first = await opened(ctx);
  const second = await opened(ctx);
  const results = await Promise.allSettled(
    [first, second].map((r) =>
      reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 80n, 1),
    ),
  );
  expect(results.map(codeOf).sort()).toEqual(["insufficient_credits", "ok"]);
  expect((await grants(ctx.userId)).reduce((sum, g) => sum + BigInt(g.held), 0n)).toBe(80n);
  await Promise.all(
    [first, second].map((r) => releaseRequest(fixture.db, r.id, ctx.userId, "test_cleanup")),
  );
});

test("a duplicate client key cannot open a second dispatch", async () => {
  const ctx = await setup();
  const key = crypto.randomUUID();
  const first = await opened(ctx, key);
  await expect(opened(ctx, key)).rejects.toMatchObject({ code: "request_in_progress" });
  await reserveRequest(
    fixture.db,
    ctx.policy,
    ctx.model,
    first.id,
    ctx.userId,
    ctx.sessionId,
    5n,
    1,
  );
  await markDispatched(fixture.db, first.id, ctx.userId, ctx.sessionId);
  await settleRequest(
    fixture.db,
    first.id,
    ctx.userId,
    { ...emptyUsage(), input: 2 },
    200,
    "upstream-1",
  );
  await expect(opened(ctx, key)).rejects.toMatchObject({ code: "request_already_recorded" });
  expect(
    (
      await fixture.db
        .sql`SELECT count(*)::integer AS count FROM cloud_request WHERE user_id=${ctx.userId} AND client_key=${key}`
    )[0]?.count,
  ).toBe(1);
});

test("simultaneous settlement charges once and releases unused hold", async () => {
  const ctx = await setup();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 10n, 1);
  await markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      settleRequest(fixture.db, r.id, ctx.userId, { ...emptyUsage(), input: 3 }, 200, "upstream-2"),
    ),
  );
  expect(await requestRow(r.id)).toMatchObject({
    state: "settled",
    charged: "3",
    actual_cost: "3",
  });
  expect((await grants(ctx.userId)).reduce((sum, g) => sum + BigInt(g.spent), 0n)).toBe(3n);
  expect((await grants(ctx.userId)).reduce((sum, g) => sum + BigInt(g.held), 0n)).toBe(0n);
});

test("release restores holds without charging", async () => {
  const ctx = await setup();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 25n, 1);
  await releaseRequest(fixture.db, r.id, ctx.userId, "pre_dispatch_failure");
  await releaseRequest(fixture.db, r.id, ctx.userId, "retry");
  expect((await usageSummary(fixture.db, ctx.policy, ctx.userId)).credits_remaining).toBe("120");
  expect(await requestRow(r.id)).toMatchObject({ state: "released", charged: "0" });
});

test("expired unknown usage is released without inventing a charge", async () => {
  const ctx = await setup();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 20n, 1);
  await markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId);
  await unknownRequest(fixture.db, r.id, ctx.userId, "network_lost");
  await fixture.db
    .sql`UPDATE cloud_request SET hold_until=now()-interval '1 second' WHERE id=${r.id}`;
  await recoverRequests(fixture.db);
  expect(await requestRow(r.id)).toMatchObject({
    state: "released",
    charged: "0",
    error_class: "unconfirmed_usage_refunded",
  });
  expect((await usageSummary(fixture.db, ctx.policy, ctx.userId)).credits_remaining).toBe("120");
});

test("a policy change does not reprice a running request", async () => {
  const ctx = await setup();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 12n, 1);
  await markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId);
  const revised = testPolicy({
    models: [{ ...ctx.model, rates: { ...ctx.model.rates, input: "9000000" } }],
  });
  await registerPolicy(fixture.db, revised);
  await settleRequest(fixture.db, r.id, ctx.userId, { ...emptyUsage(), input: 4 }, 200, null);
  expect(await requestRow(r.id)).toMatchObject({
    state: "settled",
    charged: "4",
    actual_cost: "4",
  });
});

test("revoked sessions deny dispatch and new requests", async () => {
  const ctx = await setup();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 5n, 1);
  await fixture.db.sql`DELETE FROM auth_session WHERE id=${ctx.sessionId}`;
  await expect(markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId)).rejects.toMatchObject({
    code: "request_expired",
  });
  await expect(opened(ctx)).rejects.toMatchObject({ code: "unauthorized" });
  await releaseRequest(fixture.db, r.id, ctx.userId, "test_cleanup");
});

test("per-user and global concurrent request limits block extra admission", async () => {
  const perUser = await setup(
    testPolicy({ plans: [{ ...required(testPolicy().plans[0]), maxConcurrent: 1 }] }),
  );
  const first = await opened(perUser);
  await expect(opened(perUser)).rejects.toMatchObject({ code: "concurrency_limited" });
  await releaseRequest(fixture.db, first.id, perUser.userId, "test_cleanup");
  const global = await setup(
    testPolicy({ limits: { ...testPolicy().limits, globalConcurrent: 1 } }),
  );
  const other = await createCloudAccount(fixture.db);
  const globalRequest = await opened(global);
  await expect(
    openRequest(
      fixture.db,
      global.policy,
      global.model,
      other.userId,
      other.sessionId,
      crypto.randomUUID(),
      "/v1/chat/completions",
    ),
  ).rejects.toMatchObject({ code: "concurrency_limited" });
  await releaseRequest(fixture.db, globalRequest.id, global.userId, "test_cleanup");
});

test("daily cap counts reserved credit before another request is admitted", async () => {
  const plan = { ...required(testPolicy().plans[0]), dailyLimitUnits: "10" };
  const ctx = await setup(testPolicy({ plans: [plan] }));
  const a = await opened(ctx);
  const b = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, a.id, ctx.userId, ctx.sessionId, 8n, 1);
  await expect(
    reserveRequest(fixture.db, ctx.policy, ctx.model, b.id, ctx.userId, ctx.sessionId, 3n, 1),
  ).rejects.toMatchObject({ code: "daily_limit_reached" });
  await Promise.all(
    [a, b].map((r) => releaseRequest(fixture.db, r.id, ctx.userId, "test_cleanup")),
  );
});

test("duplicate top-up events grant once and purchased credit survives paid cancellation", async () => {
  const ctx = await setup();
  const order = {
    id: crypto.randomUUID(),
    userId: ctx.userId,
    productId: required(ctx.policy.topups[0]).productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
  };
  await Promise.all(Array.from({ length: 3 }, () => applyTopup(fixture.db, ctx.policy, order)));
  await fixture.db
    .sql`UPDATE billing_customer SET status='inactive',paid_until=NULL WHERE user_id=${ctx.userId}`;
  const topups = (await grants(ctx.userId)).filter((g) => g.kind === "topup");
  expect(topups).toHaveLength(1);
  expect(String(topups[0]?.amount)).toBe("30");
  expect((await usageSummary(fixture.db, ctx.policy, ctx.userId)).purchased_remaining).toBe("30");
});

test("refund revokes unused credit and suspends a wallet if credit was spent", async () => {
  const ctx = await setup();
  const order = {
    id: crypto.randomUUID(),
    userId: ctx.userId,
    productId: required(ctx.policy.topups[0]).productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
  };
  await applyTopup(fixture.db, ctx.policy, order);
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 10n, 1);
  await markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId);
  await settleRequest(fixture.db, r.id, ctx.userId, { ...emptyUsage(), input: 5 }, 200, null);
  const spent = required((await grants(ctx.userId)).find((g) => g.kind === "topup"));
  expect(String(spent.spent)).toBe("5");
  await applyTopup(fixture.db, ctx.policy, { ...order, paid: false, refunded: true });
  expect((await grants(ctx.userId)).find((g) => g.kind === "topup")?.revoked).toBe(true);
  expect(
    (await fixture.db.sql`SELECT suspended FROM credit_wallet WHERE user_id=${ctx.userId}`)[0]
      ?.suspended,
  ).toBe(true);
  await expect(opened(ctx)).rejects.toMatchObject({ code: "billing_review_required" });
  const unused = await setup();
  const unusedOrder = {
    ...order,
    id: crypto.randomUUID(),
    userId: unused.userId,
    productId: required(unused.policy.topups[0]).productId,
  };
  await applyTopup(fixture.db, unused.policy, unusedOrder);
  await applyTopup(fixture.db, unused.policy, { ...unusedOrder, paid: false, refunded: true });
  expect((await grants(unused.userId)).find((g) => g.kind === "topup")?.revoked).toBe(true);
  expect(
    (await fixture.db.sql`SELECT suspended FROM credit_wallet WHERE user_id=${unused.userId}`)[0]
      ?.suspended,
  ).toBe(false);
});

test("a grant expiring while reservation waits on the wallet cannot be spent", async () => {
  const ctx = await setup();
  const r = await opened(ctx);
  await fixture.db
    .sql`UPDATE credit_grant SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE user_id=${ctx.userId}`;
  let release: () => void = () => {};
  let acquired: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const holder = fixture.db.sql.begin(async (tx) => {
    await tx`SELECT user_id FROM credit_wallet WHERE user_id=${ctx.userId} FOR UPDATE`;
    acquired();
    await gate;
  });
  await ready;
  const reservation = reserveRequest(
    fixture.db,
    ctx.policy,
    ctx.model,
    r.id,
    ctx.userId,
    ctx.sessionId,
    5n,
    1,
  );
  let blocked = false;
  for (let i = 0; i < 100; i++) {
    const [state] = await fixture.db
      .sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%credit_wallet%') AS blocked`;
    if (state?.blocked) {
      blocked = true;
      break;
    }
    await Bun.sleep(5);
  }
  try {
    expect(blocked).toBe(true);
    await Bun.sleep(550);
  } finally {
    release();
    await holder;
  }
  await expect(reservation).rejects.toMatchObject({ code: "insufficient_credits" });
  expect(await requestRow(r.id)).toMatchObject({ state: "preflight", reserved: "0" });
  await releaseRequest(fixture.db, r.id, ctx.userId, "test_cleanup");
});

test("dispatch rejects expired held credit and settlement still charges a dispatched hold", async () => {
  const expired = await setup();
  const r = await opened(expired);
  await reserveRequest(
    fixture.db,
    expired.policy,
    expired.model,
    r.id,
    expired.userId,
    expired.sessionId,
    5n,
    1,
  );
  await fixture.db
    .sql`UPDATE credit_grant SET expires_at=clock_timestamp()-interval '1 second' WHERE id IN (SELECT grant_id FROM credit_allocation WHERE request_id=${r.id})`;
  await expect(
    markDispatched(fixture.db, r.id, expired.userId, expired.sessionId),
  ).rejects.toMatchObject({ code: "request_expired" });
  await releaseRequest(fixture.db, r.id, expired.userId, "test_cleanup");

  const settled = await setup();
  const running = await opened(settled);
  await reserveRequest(
    fixture.db,
    settled.policy,
    settled.model,
    running.id,
    settled.userId,
    settled.sessionId,
    5n,
    1,
  );
  await markDispatched(fixture.db, running.id, settled.userId, settled.sessionId);
  await fixture.db
    .sql`UPDATE credit_grant SET expires_at=clock_timestamp()-interval '1 second' WHERE id IN (SELECT grant_id FROM credit_allocation WHERE request_id=${running.id})`;
  await settleRequest(
    fixture.db,
    running.id,
    settled.userId,
    { ...emptyUsage(), input: 3 },
    200,
    null,
  );
  expect(await requestRow(running.id)).toMatchObject({ state: "settled", charged: "3" });
});

test("top-up reconciliation never applies today's rules to an older unversioned order", async () => {
  const ctx = await setup();
  await expect(
    applyTopup(fixture.db, ctx.policy, {
      id: crypto.randomUUID(),
      userId: ctx.userId,
      productId: required(ctx.policy.topups[0]).productId,
      paid: true,
      refunded: false,
      createdAt: new Date(0),
    }),
  ).rejects.toMatchObject({ code: "purchase_policy_unavailable" });
});

test("a paid-only model cannot dispatch from top-up credit after paid access ends", async () => {
  const base = testPolicy();
  const paidProduct = "00000000-0000-4000-8000-000000000202";
  const policy = testPolicy({
    freePlan: "free",
    welcomeUnits: "0",
    plans: [
      { ...required(base.plans[0]), allowanceUnits: "0" },
      { ...required(base.plans[0]), id: "pro", rank: 1, allowanceUnits: "0" },
    ],
    subscriptions: [
      { productId: paidProduct, plan: "pro", interval: "monthly", checkoutEnabled: true },
    ],
    models: [{ ...required(base.models[0]), plans: ["pro"] }],
  });
  const ctx = await setup(policy);
  await fixture.db
    .sql`UPDATE billing_customer SET status='active',product_id=${paidProduct},paid_until=clock_timestamp()+interval '1 hour',reconciled_at=clock_timestamp() WHERE user_id=${ctx.userId}`;
  await applyTopup(fixture.db, policy, {
    id: crypto.randomUUID(),
    userId: ctx.userId,
    productId: required(policy.topups[0]).productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
  });
  const r = await opened(ctx);
  await reserveRequest(fixture.db, policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 5n, 1);
  await fixture.db
    .sql`UPDATE billing_customer SET paid_until=clock_timestamp()-interval '1 second' WHERE user_id=${ctx.userId}`;
  await expect(markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId)).rejects.toMatchObject({
    code: "request_expired",
  });
  await releaseRequest(fixture.db, r.id, ctx.userId, "test_cleanup");
});

async function paidPlanTransition() {
  const base = testPolicy();
  const free = required(base.plans[0]);
  const shared = { ...required(base.models[0]), plans: ["pro", "max"] };
  const proProduct = "00000000-0000-4000-8000-000000000202";
  const maxProduct = "00000000-0000-4000-8000-000000000203";
  const policy = testPolicy({
    welcomeUnits: "0",
    plans: [
      { ...free, cycle: { kind: "once" }, allowanceUnits: "0" },
      { ...free, id: "pro", rank: 1, allowanceUnits: "100" },
      { ...free, id: "max", rank: 2, allowanceUnits: "500" },
    ],
    subscriptions: [
      { productId: proProduct, plan: "pro", interval: "monthly" },
      { productId: maxProduct, plan: "max", interval: "monthly" },
    ],
    models: [
      shared,
      { ...shared, id: "max-model", upstreamModel: "synthetic-max-model", plans: ["max"] },
    ],
  });
  const ctx = await setup(policy);
  await fixture.db
    .sql`UPDATE billing_customer SET status='active',product_id=${maxProduct},subscription_id=${crypto.randomUUID()},subscription_start=clock_timestamp(),period_start=clock_timestamp(),paid_until=clock_timestamp()+interval '30 days',reconciled_at=clock_timestamp() WHERE user_id=${ctx.userId}`;
  return {
    ...ctx,
    async downgrade() {
      await fixture.db
        .sql`UPDATE billing_customer SET product_id=${proProduct},reconciled_at=clock_timestamp() WHERE user_id=${ctx.userId}`;
    },
  };
}

async function purchasedTransition() {
  const ctx = await paidPlanTransition();
  await applyTopup(fixture.db, ctx.policy, {
    id: crypto.randomUUID(),
    userId: ctx.userId,
    productId: required(ctx.policy.topups[0]).productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
  });
  return ctx;
}

test("a Max included reservation cannot dispatch after downgrade and releases its hold", async () => {
  const ctx = await paidPlanTransition();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 5n, 1);
  const maxGrant = () =>
    fixture.db
      .sql`SELECT spent::text,held::text FROM credit_grant WHERE user_id=${ctx.userId} AND kind='included' AND plan_id='max'`;
  expect(required((await maxGrant())[0])).toEqual({ spent: "0", held: "5" });
  await ctx.downgrade();
  await expect(markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId)).rejects.toMatchObject({
    code: "request_expired",
    status: 409,
  });
  const [request] = await fixture.db
    .sql`SELECT state,dispatched_at,funding_source FROM cloud_request WHERE id=${r.id}`;
  expect(request).toEqual({ state: "reserved", dispatched_at: null, funding_source: "allowance" });
  await releaseRequest(fixture.db, r.id, ctx.userId, "request_expired");
  expect(required((await maxGrant())[0])).toEqual({ spent: "0", held: "0" });
  expect(await requestRow(r.id)).toMatchObject({ state: "released", charged: "0" });
  expect(
    await fixture.db.sql`SELECT request_id FROM credit_allocation WHERE request_id=${r.id}`,
  ).toHaveLength(0);
});

test("purchased credit for a shared model remains dispatchable after Max to Pro downgrade", async () => {
  const ctx = await purchasedTransition();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 5n, 1);
  const [request] = await fixture.db.sql`SELECT funding_source FROM cloud_request WHERE id=${r.id}`;
  expect(request?.funding_source).toBe("purchased");
  await ctx.downgrade();
  await markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId);
  await settleRequest(fixture.db, r.id, ctx.userId, { ...emptyUsage(), input: 3 }, 200, null);
  expect(await requestRow(r.id)).toMatchObject({ state: "settled", charged: "3" });
  const [topup] = await fixture.db
    .sql`SELECT spent::text,held::text FROM credit_grant WHERE user_id=${ctx.userId} AND kind='topup'`;
  expect(topup).toEqual({ spent: "3", held: "0" });
});

test("purchased credit cannot dispatch a Max-only model after downgrade", async () => {
  const ctx = await purchasedTransition();
  const model = required(ctx.policy.models[1]);
  const r = await opened({ ...ctx, model });
  await reserveRequest(fixture.db, ctx.policy, model, r.id, ctx.userId, ctx.sessionId, 5n, 1);
  const [request] = await fixture.db.sql`SELECT funding_source FROM cloud_request WHERE id=${r.id}`;
  expect(request?.funding_source).toBe("purchased");
  await ctx.downgrade();
  await expect(markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId)).rejects.toMatchObject({
    code: "request_expired",
    status: 409,
  });
  await releaseRequest(fixture.db, r.id, ctx.userId, "request_expired");
  const [topup] = await fixture.db
    .sql`SELECT spent::text,held::text FROM credit_grant WHERE user_id=${ctx.userId} AND kind='topup'`;
  expect(topup).toEqual({ spent: "0", held: "0" });
});

test("a dispatched Max included reservation still settles after downgrade", async () => {
  const ctx = await paidPlanTransition();
  const r = await opened(ctx);
  await reserveRequest(fixture.db, ctx.policy, ctx.model, r.id, ctx.userId, ctx.sessionId, 5n, 1);
  await markDispatched(fixture.db, r.id, ctx.userId, ctx.sessionId);
  await ctx.downgrade();
  await settleRequest(fixture.db, r.id, ctx.userId, { ...emptyUsage(), input: 3 }, 200, null);
  expect(await requestRow(r.id)).toMatchObject({ state: "settled", charged: "3" });
  const [grant] = await fixture.db
    .sql`SELECT spent::text,held::text FROM credit_grant WHERE user_id=${ctx.userId} AND kind='included' AND plan_id='max'`;
  expect(grant).toEqual({ spent: "3", held: "0" });
});

test("customer margin tariffs debit exact sub-credit units independently of provider cost rates", async () => {
  const isolated = await testDatabase();
  try {
    const base = testPolicy();
    const original = required(base.models[0]);
    const policy = testPolicy({
      models: [
        {
          ...original,
          rates: { ...original.rates, input: "3000000", output: "6000000" },
          costRates: { ...original.rates },
        },
      ],
      limits: {
        ...base.limits,
        budgets: {
          scope: "customer-margin-test",
          dailyUsdMicros: "1000000",
          totalUsdMicros: "1000000",
          freeDailyUsdMicros: "1000000",
        },
      },
    });
    await registerPolicy(isolated.db, policy);
    const owner = await createCloudAccount(isolated.db);
    const model = required(policy.models[0]);
    const request = await openRequest(
      isolated.db,
      policy,
      model,
      owner.userId,
      owner.sessionId,
      crypto.randomUUID(),
      "/v1/chat/completions",
    );
    const costRates = required(model.costRates);
    const customerHold = holdCost(1, 1, 0, model.rates);
    const providerHold = holdCost(1, 1, 0, costRates);
    await reserveRequest(
      isolated.db,
      policy,
      model,
      request.id,
      owner.userId,
      owner.sessionId,
      customerHold,
      1,
      providerHold,
    );
    await markDispatched(isolated.db, request.id, owner.userId, owner.sessionId);
    const usage = { ...emptyUsage(), input: 1, output: 1 };
    expect(charge(usage, model.rates)).toBe(9n);
    expect(charge(usage, costRates)).toBe(4n);
    await settleRequest(isolated.db, request.id, owner.userId, usage, 200, null);
    expect(
      (
        await isolated.db
          .sql`SELECT state,charged::text,actual_cost::text FROM cloud_request WHERE id=${request.id}`
      )[0],
    ).toMatchObject({ state: "settled", charged: "9", actual_cost: "9" });
    expect(
      (
        await isolated.db
          .sql`SELECT exposure::text,terminal FROM cloud_cost_record WHERE request_id=${request.id}`
      )[0],
    ).toMatchObject({ exposure: "4", terminal: true });
    const summary = await usageSummary(isolated.db, policy, owner.userId);
    expect(summary).toMatchObject({
      unit_scale: 1000000,
      credit_units: "10000",
      credits_remaining: "111",
    });
    expect(
      (
        await isolated.db
          .sql`SELECT sum(spent)::text AS spent FROM credit_grant WHERE user_id=${owner.userId}`
      )[0]?.spent,
    ).toBe("9");
  } finally {
    await isolated.close();
  }
});
