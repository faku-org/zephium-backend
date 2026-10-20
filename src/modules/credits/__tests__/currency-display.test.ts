import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { assertPolicyEvolution, registerPolicy } from "../../policy/policy";
import { applyTopup, grant } from "../grants";
import { usageSummary } from "../ledger";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

test("unlabelled legacy credits never become dollars without an explicit balance review", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const { userId } = await createCloudAccount(fixture.db);
  await usageSummary(fixture.db, policy, userId);
  await fixture.db.sql.begin((tx) =>
    grant(tx, userId, "legacy-purchase", "topup", policy.revision, null, "2000000", null),
  );
  const usage = await usageSummary(fixture.db, policy, userId);
  expect(usage).toMatchObject({ unit_scale: 1000000, credit_units: "10000" });
  expect(usage.purchased_remaining).toBe("2000000");
  expect(usage.purchased_balance).toBeNull();
  const dollars = testPolicy({ ...policy, revision: policy.revision + 1, creditCurrency: "USD" });
  await expect(registerPolicy(fixture.db, dollars)).rejects.toThrow(
    "Review existing purchased balances",
  );
  expect((await fixture.db.sql`SELECT revision FROM cloud_active_policy`)[0]?.revision).toBe(
    policy.revision,
  );
});

test("USD display is exact, excludes held expired and revoked units, and isolates accounts", async () => {
  // A separate fixture represents assigning the denomination before any purchases exist.
  const isolated = await testDatabase();
  try {
    const policy = testPolicy({ creditCurrency: "USD" });
    await registerPolicy(isolated.db, policy);
    const owner = await createCloudAccount(isolated.db),
      other = await createCloudAccount(isolated.db);
    await usageSummary(isolated.db, policy, owner.userId);
    await isolated.db.sql.begin(async (tx) => {
      await grant(tx, owner.userId, "paid", "topup", policy.revision, null, "12345678", null);
      await grant(
        tx,
        owner.userId,
        "expired",
        "topup",
        policy.revision,
        null,
        "9999999",
        new Date(Date.now() - 1000),
      );
      await grant(tx, owner.userId, "revoked", "topup", policy.revision, null, "9999999", null);
      await tx`UPDATE credit_grant SET spent=1000000,held=1 WHERE user_id=${owner.userId} AND grant_key='paid'`;
      await tx`UPDATE credit_grant SET revoked=true WHERE user_id=${owner.userId} AND grant_key='revoked'`;
    });
    const usage = await usageSummary(isolated.db, policy, owner.userId);
    expect(usage).toMatchObject({ unit_scale: 1000000, credit_units: "10000" });
    expect(usage.purchased_remaining).toBe("11345677");
    expect(usage.purchased_balance).toEqual({ currency: "USD", amount: "11.345677" });
    expect((await usageSummary(isolated.db, policy, other.userId)).purchased_balance).toEqual({
      currency: "USD",
      amount: "0.000000",
    });
    await isolated.db
      .sql`UPDATE credit_grant SET spent=amount-1,held=0 WHERE user_id=${owner.userId} AND grant_key='paid'`;
    const smallestBalance = await usageSummary(isolated.db, policy, owner.userId);
    expect(smallestBalance.purchased_remaining).toBe("1");
    expect(smallestBalance.credit_units).toBe("10000");
    expect(smallestBalance.purchased_balance).toEqual({
      currency: "USD",
      amount: "0.000001",
    });
    expect(() => assertPolicyEvolution(policy, { ...policy, creditCurrency: undefined })).toThrow(
      "Keep the established credit currency",
    );
  } finally {
    await isolated.close();
  }
});

test("USD activation waits for legacy purchase windows and reconciliation, then rejects late legacy grants", async () => {
  const isolated = await testDatabase();
  try {
    const base = testPolicy();
    const legacy = testPolicy({
      ...base,
      topups: base.topups.map((t) => ({ ...t, units: "2000000" })),
    });
    await registerPolicy(isolated.db, legacy);
    const { userId } = await createCloudAccount(isolated.db);
    const dollars = testPolicy({
      ...legacy,
      revision: legacy.revision + 1,
      creditCurrency: "USD",
      topups: legacy.topups.map((t) => ({ ...t, units: "1000000" })),
    });
    await isolated.db
      .sql`UPDATE billing_customer SET checkout_until=now()+interval '1 hour' WHERE user_id=${userId}`;
    await expect(registerPolicy(isolated.db, dollars)).rejects.toThrow(
      "Reconcile legacy purchases",
    );
    await isolated.db.sql`UPDATE billing_customer SET checkout_until=NULL WHERE user_id=${userId}`;
    const productId = legacy.topups[0]?.productId;
    if (!productId) throw new Error("Missing top-up fixture");
    await isolated.db
      .sql`INSERT INTO billing_checkout(checkout_id,user_id,product_id,policy_revision,kind,expires_at)
      VALUES ('legacy-checkout',${userId},${productId},${legacy.revision},'topup',now()+interval '1 hour')`;
    await expect(registerPolicy(isolated.db, dollars)).rejects.toThrow(
      "Reconcile legacy purchases",
    );
    await isolated.db.sql`UPDATE billing_checkout SET expires_at=now()-interval '1 second'`;
    await isolated.db
      .sql`INSERT INTO billing_order_job(order_id,user_id) VALUES ('legacy-order',${userId})`;
    await expect(registerPolicy(isolated.db, dollars)).rejects.toThrow(
      "Reconcile legacy purchases",
    );
    await isolated.db.sql`UPDATE billing_order_job SET processed=requested`;
    await isolated.db
      .sql`UPDATE billing_customer SET provider_touched=true WHERE user_id=${userId}`;
    await expect(registerPolicy(isolated.db, dollars)).rejects.toThrow(
      "Reconcile legacy purchases",
    );
    await isolated.db.sql`UPDATE billing_customer SET processed=requested WHERE user_id=${userId}`;
    await registerPolicy(isolated.db, dollars);
    const old = {
      id: "late-legacy",
      userId,
      productId,
      policyRevision: legacy.revision,
      createdAt: new Date(),
      paid: true,
      refunded: false,
    };
    // Even an old worker's policy argument cannot silently denominate a late order.
    await expect(applyTopup(isolated.db, legacy, old)).rejects.toMatchObject({
      code: "purchase_policy_unavailable",
    });
    expect(
      await isolated.db.sql`SELECT id FROM credit_grant WHERE user_id=${userId} AND kind='topup'`,
    ).toHaveLength(0);
    await applyTopup(isolated.db, dollars, { ...old, refunded: true });
    await applyTopup(isolated.db, legacy, old);
    expect(
      await isolated.db.sql`SELECT id FROM credit_grant WHERE user_id=${userId} AND kind='topup'`,
    ).toHaveLength(0);
    await applyTopup(isolated.db, dollars, {
      ...old,
      id: "new-usd",
      policyRevision: dollars.revision,
    });
    expect((await usageSummary(isolated.db, dollars, userId)).purchased_balance).toEqual({
      currency: "USD",
      amount: "1.000000",
    });
  } finally {
    await isolated.close();
  }
});
