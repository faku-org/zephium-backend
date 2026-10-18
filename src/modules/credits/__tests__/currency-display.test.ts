import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { assertPolicyEvolution, registerPolicy } from "../../policy/policy";
import { grant } from "../grants";
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
    expect(usage.purchased_remaining).toBe("11345677");
    expect(usage.purchased_balance).toEqual({ currency: "USD", amount: "11.345677" });
    expect((await usageSummary(isolated.db, policy, other.userId)).purchased_balance).toEqual({
      currency: "USD",
      amount: "0.000000",
    });
    await isolated.db
      .sql`UPDATE credit_grant SET spent=amount-1,held=0 WHERE user_id=${owner.userId} AND grant_key='paid'`;
    expect((await usageSummary(isolated.db, policy, owner.userId)).purchased_balance).toEqual({
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
