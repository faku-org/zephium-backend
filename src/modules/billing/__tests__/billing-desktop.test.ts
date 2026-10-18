import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { createDatabase } from "../../../platform/db";
import { applyTopup } from "../../credits/grants";
import { registerPolicy } from "../../policy/policy";
import { createBillingService } from "../desktop";
import type { BillingProvider } from "../provider";
import { workOnce } from "../worker";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture.close();
});

const productId = "00000000-0000-4000-8000-000000000101";
function provider(overrides: Partial<BillingProvider> = {}): BillingProvider {
  return {
    state: async () => null,
    checkout: async () => ({
      id: "checkout-fixture",
      url: "https://sandbox.polar.sh/checkout/test",
      expiresAt: new Date(Date.now() + 3600_000),
    }),
    portal: async () => "https://sandbox.polar.sh/portal/test",
    deleteCustomer: async () => {},
    openCheckoutUntil: async () => null,
    productOffer: async (id) => ({
      productId: id,
      productName: "30 credits",
      price: { amount_minor: 500, currency: "USD" },
    }),
    ordersForCheckouts: async () => [],
    ...overrides,
  };
}
const enabledConfig = () => ({ ...fixture.config, BILLING_ENABLED: "true" as const });

test("disabled billing makes no provider calls and has no offers or paid access", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const service = createBillingService(
    fixture.config,
    fixture.db,
    provider({
      state: async () => {
        throw new Error("provider was called");
      },
      productOffer: async () => {
        throw new Error("provider was called");
      },
    }),
    testPolicy(),
  );
  const view = await service.get(userId);
  expect(view.offers).toBeNull();
  expect(view.subscription.status).toBe("not_applicable");
  expect(view.paid).toBe(false);
  await expect(service.portal(userId)).rejects.toMatchObject({ code: "billing_not_enabled" });
  await expect(
    service.recordCheckout(userId, { id: "c1", expiresAt: new Date() }, productId, 1, {
      kind: "topup",
    }),
  ).rejects.toMatchObject({ code: "billing_not_enabled" });
});

test("offers use provider prices, and portal requires an existing customer", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  const service = createBillingService(enabledConfig(), fixture.db, provider(), policy);
  const view = await service.get(userId);
  expect(view.offers?.topups[0]).toEqual({
    id: "test-topup",
    units: "30",
    expires_days: 1,
    product_name: "30 credits",
    price: { amount_minor: 500, currency: "USD" },
  });
  await expect(service.portal(userId)).rejects.toMatchObject({
    code: "no_billing_account",
    status: 409,
  });
  await fixture.db
    .sql`UPDATE billing_customer SET polar_id='polar-customer' WHERE user_id=${userId}`;
  expect(await service.portal(userId)).toBe("https://sandbox.polar.sh/portal/test");
  const broken = createBillingService(
    enabledConfig(),
    fixture.db,
    provider({
      productOffer: async () => {
        throw new Error("invalid product");
      },
    }),
    policy,
  );
  await expect(broken.get(userId)).rejects.toMatchObject({
    code: "billing_unavailable",
    status: 503,
  });
});

test("refresh binds paid top-ups to known checkout and grants once", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const checkoutId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const calls: string[][] = [];
  const service = createBillingService(
    enabledConfig(),
    fixture.db,
    provider({
      ordersForCheckouts: async (id, ids) => {
        expect(id).toBe(userId);
        calls.push(ids);
        return [
          {
            id: orderId,
            checkoutId,
            userId,
            productId,
            paid: true,
            refunded: false,
            createdAt: new Date(),
            policyRevision: policy.revision,
          },
        ];
      },
    }),
    policy,
  );
  await service.recordCheckout(
    userId,
    { id: checkoutId, expiresAt: new Date(Date.now() + 3600_000) },
    productId,
    policy.revision,
    { kind: "topup" },
  );
  await service.refresh(userId);
  await service.refresh(userId);
  expect(calls).toEqual([[checkoutId], [checkoutId]]);
  const grants = await fixture.db
    .sql`SELECT amount,kind,policy_revision FROM credit_grant WHERE user_id=${userId} AND grant_key=${`polar-order:${orderId}`}`;
  expect(grants.length).toBe(1);
  expect(String(grants[0]?.amount)).toBe("30");
  expect(grants[0]?.kind).toBe("topup");
  expect(grants[0]?.policy_revision).toBe(policy.revision);
  const view = await service.get(userId);
  expect(view.subscription.status).toBe("inactive");
});

test("refresh rejects foreign orders and does not overwrite a newer worker result", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const checkoutId = crypto.randomUUID();
  const foreign = createBillingService(
    enabledConfig(),
    fixture.db,
    provider({
      ordersForCheckouts: async () => [
        {
          id: "foreign",
          checkoutId,
          userId: crypto.randomUUID(),
          productId,
          paid: true,
          refunded: false,
          createdAt: new Date(),
        },
      ],
    }),
    policy,
  );
  await foreign.recordCheckout(
    userId,
    { id: checkoutId, expiresAt: new Date(Date.now() + 3600_000) },
    productId,
    policy.revision,
    { kind: "topup" },
  );
  await expect(foreign.refresh(userId)).rejects.toMatchObject({
    code: "provider_order_identity_invalid",
  });
  const newer = createBillingService(
    enabledConfig(),
    fixture.db,
    provider({
      state: async () => {
        await fixture.db
          .sql`UPDATE billing_customer SET provider_touched=true,status='active',paid_until=now()+interval '1 day',reconciled_at=now(),requested=requested+1 WHERE user_id=${userId}`;
        return null;
      },
    }),
    policy,
  );
  // Avoid the known checkout in this independent race check.
  await fixture.db.sql`DELETE FROM billing_checkout WHERE user_id=${userId}`;
  const view = await newer.refresh(userId);
  expect(view.subscription.status).toBe("active");
  expect(view.paid).toBe(true);
});

test("checkout identity cannot be reassigned to another account", async () => {
  const first = await createCloudAccount(fixture.db);
  const second = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const service = createBillingService(enabledConfig(), fixture.db, provider(), policy);
  const checkout = { id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 3600_000) };
  await service.recordCheckout(first.userId, checkout, productId, policy.revision, {
    kind: "topup",
  });
  await expect(
    service.recordCheckout(second.userId, checkout, productId, policy.revision, { kind: "topup" }),
  ).rejects.toMatchObject({ code: "checkout_identity_conflict", status: 409 });
});

test("refresh is limited to six requests per user per minute", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const service = createBillingService(enabledConfig(), fixture.db, provider(), testPolicy());
  for (let i = 0; i < 6; i++) await service.refresh(userId);
  await expect(service.refresh(userId)).rejects.toMatchObject({
    code: "rate_limited",
    status: 429,
  });
});

test("refund before the first grant durably rejects repeated stale paid observations", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const order = {
    id: crypto.randomUUID(),
    userId,
    productId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
    policyRevision: policy.revision,
  };
  await applyTopup(fixture.db, policy, { ...order, refunded: true, paid: false });
  expect(
    (await fixture.db.sql`SELECT order_id FROM billing_order_reversal WHERE order_id=${order.id}`)
      .length,
  ).toBe(1);
  await Promise.all(Array.from({ length: 4 }, () => applyTopup(fixture.db, policy, order)));
  expect((await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${userId}`).length).toBe(
    0,
  );
});

test("a paid refresh fetched before a worker refund cannot resurrect credit", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const checkoutId = crypto.randomUUID();
  const order = {
    id: crypto.randomUUID(),
    userId,
    productId,
    checkoutId,
    paid: true,
    refunded: false,
    createdAt: new Date(),
    policyRevision: policy.revision,
  };
  let fetched!: () => void;
  const fetching = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const service = createBillingService(
    enabledConfig(),
    fixture.db,
    provider({
      ordersForCheckouts: async () => {
        fetched();
        await waiting;
        return [order];
      },
    }),
    policy,
  );
  await service.recordCheckout(
    userId,
    { id: checkoutId, expiresAt: new Date(Date.now() + 3600_000) },
    productId,
    policy.revision,
    { kind: "topup" },
  );
  const refresh = service.refresh(userId);
  try {
    await fetching;
    await applyTopup(fixture.db, policy, { ...order, refunded: true, paid: false });
  } finally {
    resume();
  }
  await refresh;
  expect((await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${userId}`).length).toBe(
    0,
  );
});

test("four simultaneous checkouts finish with a four-connection pool and release SQL during provider I/O", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const users = await Promise.all(Array.from({ length: 4 }, () => createCloudAccount(fixture.db)));
  const db = createDatabase({ ...fixture.config, DB_POOL_SIZE: 4 });
  let reached = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createBillingService(
    enabledConfig(),
    db,
    provider({
      checkout: async () => {
        if (++reached === 4) release();
        await all;
        // All four remote calls may need pool work; none owns an idle transaction.
        await db.sql`SELECT 1`;
        return {
          id: crypto.randomUUID(),
          url: "https://sandbox.polar.sh/checkout/test",
          expiresAt: new Date(Date.now() + 3600_000),
        };
      },
    }),
    policy,
  );
  try {
    const results = await Promise.all(
      users.map(({ userId }) =>
        service.checkout(userId, "synthetic@example.test", productId, { kind: "topup" }),
      ),
    );
    expect(results.length).toBe(4);
    expect(
      (
        await db.sql`SELECT checkout_id FROM billing_checkout WHERE user_id IN ${db.sql(users.map((u) => u.userId))}`
      ).length,
    ).toBe(4);
  } finally {
    release();
    await db.close();
  }
});

test("deletion seals an in-flight checkout while its durable barrier prevents provider deletion", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  let called!: () => void;
  const entered = new Promise<void>((resolve) => {
    called = resolve;
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deleted = false;
  const remote = provider({
    checkout: async () => {
      called();
      await wait;
      return {
        id: crypto.randomUUID(),
        url: "https://sandbox.polar.sh/checkout/test",
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
    deleteCustomer: async () => {
      deleted = true;
    },
  });
  const service = createBillingService(enabledConfig(), fixture.db, remote, policy);
  const pending = service.checkout(userId, "synthetic@example.test", productId, { kind: "topup" });
  const outcome = pending.then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered;
    await fixture.db.sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day'`;
    await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${userId}`;
    await fixture.db.sql`UPDATE billing_customer SET next_attempt=now() WHERE user_id=${userId}`;
    expect(await workOnce(fixture.db, remote, [])).toBe(true);
    expect(deleted).toBe(false);
    const [barrier] = await fixture.db
      .sql`SELECT provider_touched,checkout_until>now() AS waiting FROM billing_customer WHERE user_id=${userId}`;
    expect(barrier).toMatchObject({ provider_touched: true, waiting: true });
  } finally {
    release();
  }
  expect(await outcome).toMatchObject({ code: "account_unavailable" });
});

test("lost checkout responses retain intent and deletion rechecks remote open checkouts", async () => {
  const { userId } = await createCloudAccount(fixture.db);
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  let checks = 0;
  let deleted = false;
  const remote = provider({
    checkout: async () => {
      throw new Error("synthetic lost response");
    },
    openCheckoutUntil: async () => {
      checks++;
      return new Date(Date.now() + 3600_000);
    },
    deleteCustomer: async () => {
      deleted = true;
    },
  });
  const service = createBillingService(enabledConfig(), fixture.db, remote, policy);
  await expect(
    service.checkout(userId, "synthetic@example.test", productId, { kind: "topup" }),
  ).rejects.toThrow("synthetic lost response");
  const [intent] = await fixture.db
    .sql`SELECT provider_touched,checkout_until>now() AS waiting FROM billing_customer WHERE user_id=${userId}`;
  expect(intent).toMatchObject({ provider_touched: true, waiting: true });
  await fixture.db.sql`UPDATE billing_customer SET next_attempt=now()+interval '1 day'`;
  await fixture.db.sql`UPDATE auth_user SET lifecycle='deleting' WHERE id=${userId}`;
  await fixture.db
    .sql`UPDATE billing_customer SET checkout_until=now()-interval '1 second',next_attempt=now() WHERE user_id=${userId}`;
  await workOnce(fixture.db, remote, []);
  expect(checks).toBe(1);
  expect(deleted).toBe(false);
  expect((await fixture.db.sql`SELECT id FROM auth_user WHERE id=${userId}`).length).toBe(1);
});
