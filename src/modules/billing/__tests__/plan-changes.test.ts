import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { accountContext } from "../../credits";
import { registerPolicy } from "../../policy/policy";
import { createBillingService } from "../desktop";
import { processPlanChange } from "../plan-change-worker";
import { createPlanChangeService } from "../plan-changes";
import {
  type BillingProvider,
  type BillingSubscription,
  SubscriptionChangeRejected,
} from "../provider";
import { workOnce } from "../worker";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});
const pro = "00000000-0000-4000-8000-000000000201";
const max = "00000000-0000-4000-8000-000000000202";
async function setup(initial: "pro" | "max" = "pro") {
  await fixture.db.sql`UPDATE billing_plan_change SET next_attempt=now()+interval '1 day'`;
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day'`;
  const base = testPolicy();
  const free = base.plans[0];
  if (!free) throw new Error("Missing fixture plan");
  const policy = testPolicy({
    welcomeUnits: "0",
    plans: [
      ...base.plans,
      { ...free, id: "pro", rank: 1, allowanceUnits: "1000000" },
      { ...free, id: "max", rank: 2, allowanceUnits: "5000000" },
    ],
    subscriptions: [
      { plan: "pro", productId: pro, interval: "monthly", checkoutEnabled: true },
      { plan: "max", productId: max, interval: "monthly", checkoutEnabled: true },
    ],
  });
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  const start = new Date(Date.now() - 15 * 86400000);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  let subscription: BillingSubscription = {
    id: crypto.randomUUID(),
    accountId: account.userId,
    customerId: crypto.randomUUID(),
    productId: initial === "pro" ? pro : max,
    status: "active",
    periodStart: start,
    paidUntil: end,
    subscriptionStart: start,
    modifiedAt: start,
    cancelAtPeriodEnd: false,
    amountMinor: initial === "pro" ? 2000 : 10000,
    currency: "usd",
    recurringInterval: "month",
    recurringIntervalCount: 1,
    discountId: null,
    pendingChange: null,
  };
  await fixture.db
    .sql`UPDATE billing_customer SET provider_touched=true,polar_id=${subscription.customerId},
    subscription_id=${subscription.id},product_id=${subscription.productId},status='active',paid_until=${end.toISOString()},
    period_start=${start.toISOString()},subscription_start=${start.toISOString()},reconciled_at=now() WHERE user_id=${account.userId}`;
  await fixture.db.sql.begin((tx) => accountContext(tx, account.userId, policy, account.sessionId));
  let mutations = 0;
  const remote: BillingProvider = {
    state: async () => ({
      accountId: account.userId,
      customerId: subscription.customerId,
      subscriptions: [
        { ...subscription, subscriptionStart: subscription.subscriptionStart ?? undefined },
      ],
    }),
    subscription: async () => structuredClone(subscription),
    productOffer: async (productId) => ({
      productId,
      productName: productId === pro ? "Pro" : "Max",
      price: { amount_minor: productId === pro ? 2000 : 10000, currency: "USD" },
    }),
    changeSubscription: async (_id, productId, behavior) => {
      mutations++;
      if (behavior === "invoice")
        subscription = {
          ...subscription,
          productId,
          amountMinor: productId === pro ? 2000 : 10000,
          modifiedAt: new Date(),
        };
      else
        subscription = {
          ...subscription,
          pendingChange: { productId, appliesAt: end },
          modifiedAt: new Date(),
        };
      return structuredClone(subscription);
    },
    checkout: async () => {
      throw new Error("No checkout should be created");
    },
    portal: async () => "https://sandbox.polar.sh/test",
    deleteCustomer: async () => {},
    openCheckoutUntil: async () => null,
  };
  const config = { ...fixture.config, BILLING_ENABLED: "true" as const };
  const service = createPlanChangeService(fixture.db, remote, policy, config);
  return {
    ...account,
    policy,
    service,
    remote,
    config,
    start,
    end,
    getSubscription: () => subscription,
    setSubscription: (s: BillingSubscription) => {
      subscription = s;
    },
    mutations: () => mutations,
  };
}
async function queued(ctx: Awaited<ReturnType<typeof setup>>, plan = "max") {
  const quote = await ctx.service.preview(ctx.userId, ctx.sessionId, { plan, interval: "monthly" });
  await ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id);
  return quote;
}
async function retry(id: string) {
  await fixture.db
    .sql`UPDATE billing_plan_change SET next_attempt=now()-interval '1 second' WHERE id=${id}`;
}

test("duplicate confirmation and concurrent workers issue one upgrade and preserve consumed allowance", async () => {
  const ctx = await setup();
  await fixture.db
    .sql`UPDATE credit_grant SET spent=200000,held=100000 WHERE user_id=${ctx.userId}`;
  const quote = await ctx.service.preview(ctx.userId, ctx.sessionId, {
    plan: "max",
    interval: "monthly",
  });
  const confirmations = await Promise.all([
    ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id),
    ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id),
  ]);
  expect(confirmations.map((c) => c.status)).toEqual(["queued", "queued"]);
  await Promise.all([
    processPlanChange(fixture.db, ctx.remote, ctx.policy),
    processPlanChange(fixture.db, ctx.remote, ctx.policy),
  ]);
  expect(ctx.mutations()).toBe(1);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("applied");
  const [op] = await fixture.db
    .sql`SELECT dispatched_at FROM billing_plan_change WHERE id=${quote.id}`;
  const [grant] = await fixture.db.sql`SELECT * FROM credit_grant WHERE user_id=${ctx.userId}`;
  const delta =
    (4000000n * BigInt(ctx.end.getTime() - new Date(op?.dispatched_at).getTime())) /
    BigInt(ctx.end.getTime() - ctx.start.getTime());
  expect(BigInt(grant?.amount)).toBe(1000000n + delta);
  expect(BigInt(grant?.spent)).toBe(200000n);
  expect(BigInt(grant?.held)).toBe(100000n);
  expect(grant?.plan_id).toBe("max");
  expect((await ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id)).status).toBe("applied");
  await fixture.db.sql.begin((tx) => accountContext(tx, ctx.userId, ctx.policy, ctx.sessionId));
  expect(
    (await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${ctx.userId}`).length,
  ).toBe(1);
});

test("lost successful charge is recovered by GET without a second PATCH or a full Max grant", async () => {
  const ctx = await setup();
  const original = ctx.remote.changeSubscription;
  if (!original) throw new Error("Missing fixture adapter");
  ctx.remote.changeSubscription = async (...args) => {
    await original(...args);
    throw new TypeError("lost response");
  };
  const quote = await queued(ctx);
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("uncertain");
  const before = await fixture.db
    .sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`;
  expect(before[0]?.product_id).toBe(pro);
  // A refresh sees Max at Polar, but cannot grant it before durable recovery resolves the charge.
  const billing = createBillingService(ctx.config, fixture.db, ctx.remote, ctx.policy);
  await billing.refresh(ctx.userId);
  expect(
    (await fixture.db.sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`)[0]
      ?.product_id,
  ).toBe(pro);
  await retry(quote.id);
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect(ctx.mutations()).toBe(1);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("applied");
  const [grant] = await fixture.db.sql`SELECT amount FROM credit_grant WHERE user_id=${ctx.userId}`;
  expect(BigInt(grant?.amount)).toBeLessThan(5000000n);
});

test("failed immediate payment leaves the subscription and allowance unchanged", async () => {
  const ctx = await setup();
  ctx.remote.changeSubscription = async () => {
    throw new SubscriptionChangeRejected("payment_failed", 402);
  };
  const quote = await queued(ctx);
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect(await ctx.service.get(ctx.userId, quote.id)).toMatchObject({
    status: "failed",
    error: { code: "payment_failed" },
  });
  expect(
    (await fixture.db.sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`)[0]
      ?.product_id,
  ).toBe(pro);
  expect(
    String(
      (await fixture.db.sql`SELECT amount FROM credit_grant WHERE user_id=${ctx.userId}`)[0]
        ?.amount,
    ),
  ).toBe("1000000");
});

test("downgrade schedules renewal and retains Max access and allowance until then", async () => {
  const ctx = await setup("max");
  const quote = await queued(ctx, "pro");
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect(ctx.mutations()).toBe(1);
  expect(await ctx.service.get(ctx.userId, quote.id)).toMatchObject({
    status: "scheduled",
    target_plan: "pro",
    effective_at: ctx.end.toISOString(),
  });
  expect(
    (await fixture.db.sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`)[0]
      ?.product_id,
  ).toBe(max);
  expect(
    (
      await fixture.db
        .sql`SELECT plan_id,amount::text FROM credit_grant WHERE user_id=${ctx.userId}`
    )[0],
  ).toMatchObject({ plan_id: "max", amount: "5000000" });
  await expect(
    ctx.service.preview(ctx.userId, ctx.sessionId, { plan: "pro", interval: "monthly" }),
  ).rejects.toMatchObject({ code: "subscription_change_unavailable" });
});

test("foreign accounts cannot read or confirm quotes, and old sessions must reauthenticate", async () => {
  const ctx = await setup();
  const foreign = await createCloudAccount(fixture.db);
  const quote = await ctx.service.preview(ctx.userId, ctx.sessionId, {
    plan: "max",
    interval: "monthly",
  });
  await expect(ctx.service.get(foreign.userId, quote.id)).rejects.toMatchObject({ status: 404 });
  await expect(
    ctx.service.confirm(foreign.userId, foreign.sessionId, quote.id),
  ).rejects.toMatchObject({ status: 404 });
  await fixture.db
    .sql`UPDATE auth_session SET created_at=now()-interval '11 minutes' WHERE id=${ctx.sessionId}`;
  await expect(ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id)).rejects.toMatchObject({
    code: "reauthentication_required",
  });
  expect(ctx.mutations()).toBe(0);
});

test("revocation during provider preflight prevents dispatch", async () => {
  const ctx = await setup();
  const quote = await queued(ctx);
  ctx.remote.subscription = async () => {
    await fixture.db.sql`DELETE FROM auth_session WHERE id=${ctx.sessionId}`;
    return structuredClone(ctx.getSubscription());
  };
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect(ctx.mutations()).toBe(0);
  expect(await ctx.service.get(ctx.userId, quote.id)).toMatchObject({
    status: "failed",
    error: { code: "unauthorized" },
  });
});

test("lease loss before dispatch prevents a stale worker charging after recovery", async () => {
  const ctx = await setup();
  const quote = await queued(ctx);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    });
  ctx.remote.subscription = async () => {
    entered();
    await wait;
    return structuredClone(ctx.getSubscription());
  };
  const processing = processPlanChange(fixture.db, ctx.remote, ctx.policy);
  await started;
  try {
    await retry(quote.id);
    await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  } finally {
    release();
  }
  await processing;
  expect(ctx.mutations()).toBe(0);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("failed");
});

test("uncertain old state never reissues the mutation and blocks deletion until resolved", async () => {
  const ctx = await setup();
  const quote = await queued(ctx);
  let calls = 0;
  ctx.remote.changeSubscription = async () => {
    calls++;
    throw new TypeError("unknown outcome");
  };
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${ctx.userId}`;
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now() WHERE user_id=${ctx.userId}`;
  let deleted = false;
  ctx.remote.deleteCustomer = async () => {
    deleted = true;
  };
  expect(await workOnce(fixture.db, ctx.remote, [pro, max], { [pro]: 1, [max]: 2 })).toBe(false);
  await retry(quote.id);
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect(calls).toBe(1);
  expect(deleted).toBe(false);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("uncertain");
});

test("a changed price or policy invalidates a queued quote before payment", async () => {
  for (const change of ["price", "policy"]) {
    const ctx = await setup();
    const quote = await queued(ctx);
    if (change === "price")
      ctx.remote.productOffer = async (productId) => ({
        productId,
        productName: "Changed",
        price: { amount_minor: 11000, currency: "USD" },
      });
    else await registerPolicy(fixture.db, { ...ctx.policy, revision: testPolicy().revision });
    await processPlanChange(fixture.db, ctx.remote, ctx.policy);
    expect(ctx.mutations()).toBe(0);
    expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("failed");
  }
});

test("normal reconciliation cannot publish the upgraded plan while its charge is unresolved", async () => {
  const ctx = await setup();
  const quote = await queued(ctx);
  const original = ctx.remote.changeSubscription;
  if (!original) throw new Error("Missing adapter");
  ctx.remote.changeSubscription = async (...args) => {
    const result = await original(...args);
    await fixture.db
      .sql`UPDATE billing_customer SET next_attempt=now() WHERE user_id=${ctx.userId}`;
    expect(await workOnce(fixture.db, ctx.remote, [pro, max], { [pro]: 1, [max]: 2 })).toBe(false);
    const context = await fixture.db.sql.begin((tx) =>
      accountContext(tx, ctx.userId, ctx.policy, ctx.sessionId),
    );
    expect(context.plan.id).toBe("pro");
    return result;
  };
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("applied");
});

test("expired quotes cannot be confirmed and only one distinct operation can be queued", async () => {
  const ctx = await setup();
  const first = await ctx.service.preview(ctx.userId, ctx.sessionId, {
    plan: "max",
    interval: "monthly",
  });
  const second = await ctx.service.preview(ctx.userId, ctx.sessionId, {
    plan: "max",
    interval: "monthly",
  });
  await fixture.db
    .sql`UPDATE billing_plan_change SET quote=jsonb_set(quote,'{expires_at}',to_jsonb((now()-interval '1 second')::text)) WHERE id=${first.id}`;
  await expect(ctx.service.confirm(ctx.userId, ctx.sessionId, first.id)).rejects.toMatchObject({
    code: "plan_change_expired",
  });
  const third = await ctx.service.preview(ctx.userId, ctx.sessionId, {
    plan: "max",
    interval: "monthly",
  });
  const results = await Promise.allSettled([
    ctx.service.confirm(ctx.userId, ctx.sessionId, second.id),
    ctx.service.confirm(ctx.userId, ctx.sessionId, third.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    results.filter((r) => r.status === "rejected" && r.reason.code === "plan_change_in_progress"),
  ).toHaveLength(1);
  expect(ctx.mutations()).toBe(0);
});

test("renewal reconciliation applies a scheduled downgrade with one new Pro allowance period", async () => {
  const ctx = await setup("max");
  await queued(ctx, "pro");
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  // Advance the fixture's completed and current periods around the real database clock.
  const now = new Date();
  const renewal = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  await fixture.db
    .sql`UPDATE credit_grant SET period_start=${prior.toISOString()},expires_at=${renewal.toISOString()} WHERE user_id=${ctx.userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET period_start=${prior.toISOString()},paid_until=${renewal.toISOString()},subscription_start=${prior.toISOString()},next_attempt=now() WHERE user_id=${ctx.userId}`;
  ctx.setSubscription({
    ...ctx.getSubscription(),
    productId: pro,
    amountMinor: 2000,
    periodStart: renewal,
    paidUntil: next,
    subscriptionStart: prior,
    pendingChange: null,
  });
  expect(await workOnce(fixture.db, ctx.remote, [pro, max], { [pro]: 1, [max]: 2 })).toBe(true);
  for (let i = 0; i < 2; i++) {
    const context = await fixture.db.sql.begin((tx) =>
      accountContext(tx, ctx.userId, ctx.policy, ctx.sessionId),
    );
    expect(context.plan.id).toBe("pro");
  }
  const grants = await fixture.db
    .sql`SELECT plan_id,amount::text FROM credit_grant WHERE user_id=${ctx.userId} AND expires_at>now()`;
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ plan_id: "pro", amount: "1000000" });
});

test("billing review blocks an upgrade preview before recording a quote", async () => {
  const ctx = await setup();
  await fixture.db.sql`UPDATE credit_wallet SET suspended=true WHERE user_id=${ctx.userId}`;
  await expect(
    ctx.service.preview(ctx.userId, ctx.sessionId, {
      plan: "max",
      interval: "monthly",
    }),
  ).rejects.toMatchObject({ code: "billing_review_required", status: 403 });
  expect(
    await fixture.db.sql`SELECT id FROM billing_plan_change WHERE user_id=${ctx.userId}`,
  ).toHaveLength(0);
  expect(ctx.mutations()).toBe(0);
});

test("suspension after an upgrade quote rejects confirmation without queuing or changing intent", async () => {
  const ctx = await setup();
  const quote = await ctx.service.preview(ctx.userId, ctx.sessionId, {
    plan: "max",
    interval: "monthly",
  });
  const [before] = await fixture.db
    .sql`SELECT requested FROM billing_customer WHERE user_id=${ctx.userId}`;
  await fixture.db.sql`UPDATE credit_wallet SET suspended=true WHERE user_id=${ctx.userId}`;
  await expect(ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id)).rejects.toMatchObject({
    code: "billing_review_required",
    status: 403,
  });
  expect(await ctx.service.get(ctx.userId, quote.id)).toMatchObject({ status: "quoted" });
  expect(
    (await fixture.db.sql`SELECT dispatched_at FROM billing_plan_change WHERE id=${quote.id}`)[0]
      ?.dispatched_at,
  ).toBeNull();
  expect(
    (await fixture.db.sql`SELECT requested FROM billing_customer WHERE user_id=${ctx.userId}`)[0],
  ).toEqual(before);
  expect(ctx.mutations()).toBe(0);
});

test("suspension after queueing or during upgrade preflight prevents provider dispatch", async () => {
  for (const when of ["queued", "preflight"]) {
    const ctx = await setup();
    const quote = await queued(ctx);
    const suspend = async () => {
      await fixture.db.sql`UPDATE credit_wallet SET suspended=true WHERE user_id=${ctx.userId}`;
    };
    if (when === "queued") await suspend();
    else
      ctx.remote.subscription = async () => {
        await suspend();
        return structuredClone(ctx.getSubscription());
      };
    expect(await processPlanChange(fixture.db, ctx.remote, ctx.policy)).toBe(true);
    expect(ctx.mutations()).toBe(0);
    expect(await ctx.service.get(ctx.userId, quote.id)).toMatchObject({
      status: "failed",
      error: { code: "billing_review_required" },
    });
    expect(
      (await fixture.db.sql`SELECT dispatched_at FROM billing_plan_change WHERE id=${quote.id}`)[0]
        ?.dispatched_at,
    ).toBeNull();
    expect(
      (await fixture.db.sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`)[0]
        ?.product_id,
    ).toBe(pro);
    expect((await ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id)).status).toBe("failed");
  }
});

test("billing review still permits a downgrade without lifting wallet suspension", async () => {
  const ctx = await setup("max");
  await fixture.db.sql`UPDATE credit_wallet SET suspended=true WHERE user_id=${ctx.userId}`;
  const quote = await queued(ctx, "pro");
  expect(await processPlanChange(fixture.db, ctx.remote, ctx.policy)).toBe(true);
  expect(ctx.mutations()).toBe(1);
  expect(await ctx.service.get(ctx.userId, quote.id)).toMatchObject({
    status: "scheduled",
    target_plan: "pro",
  });
  expect((await ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id)).status).toBe("scheduled");
  expect(
    (await fixture.db.sql`SELECT suspended FROM credit_wallet WHERE user_id=${ctx.userId}`)[0]
      ?.suspended,
  ).toBe(true);
  expect(
    (await fixture.db.sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`)[0]
      ?.product_id,
  ).toBe(max);
});

test("suspension after an already-dispatched charge still allows GET recovery and idempotent receipts", async () => {
  const ctx = await setup();
  const original = ctx.remote.changeSubscription;
  if (!original) throw new Error("Missing fixture adapter");
  ctx.remote.changeSubscription = async (...args) => {
    await original(...args);
    throw new TypeError("Synthetic lost response");
  };
  const quote = await queued(ctx);
  await processPlanChange(fixture.db, ctx.remote, ctx.policy);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("uncertain");
  expect(
    (await fixture.db.sql`SELECT dispatched_at FROM billing_plan_change WHERE id=${quote.id}`)[0]
      ?.dispatched_at,
  ).not.toBeNull();
  await fixture.db.sql`UPDATE credit_wallet SET suspended=true WHERE user_id=${ctx.userId}`;
  expect((await ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id)).status).toBe("uncertain");
  await retry(quote.id);
  expect(await processPlanChange(fixture.db, ctx.remote, ctx.policy)).toBe(true);
  expect(ctx.mutations()).toBe(1);
  expect((await ctx.service.get(ctx.userId, quote.id)).status).toBe("applied");
  expect((await ctx.service.confirm(ctx.userId, ctx.sessionId, quote.id)).status).toBe("applied");
  expect(
    (await fixture.db.sql`SELECT suspended FROM credit_wallet WHERE user_id=${ctx.userId}`)[0]
      ?.suspended,
  ).toBe(true);
  expect(
    (await fixture.db.sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`)[0]
      ?.product_id,
  ).toBe(max);
});
