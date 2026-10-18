import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { type CloudPolicy, registerPolicy } from "../../policy/policy";
import { grant } from "../grants";
import { applyPaidUpgrade, type PaidUpgrade } from "../subscription-allowance";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

const start = new Date("2090-01-01T00:00:00.000Z");
const end = new Date("2090-02-01T00:00:00.000Z");
const halfway = new Date("2090-01-16T12:00:00.000Z");

function paidPolicy(pro = "100", max = "500") {
  const policy = testPolicy();
  const base = policy.plans[0];
  if (!base) throw new Error("Missing fixture plan");
  return testPolicy({
    plans: [
      base,
      { ...base, id: "pro", rank: 1, allowanceUnits: pro },
      { ...base, id: "max", rank: 2, allowanceUnits: max },
      { ...base, id: "ultra", rank: 3, allowanceUnits: "900" },
    ],
  });
}

async function setup(policy: CloudPolicy = paidPolicy()) {
  await registerPolicy(fixture.db, policy);
  const account = await createCloudAccount(fixture.db);
  await fixture.db.sql`INSERT INTO credit_wallet(user_id) VALUES (${account.userId})`;
  return { ...account, policy };
}
type Context = Awaited<ReturnType<typeof setup>>;

function change(ctx: Context, overrides: Partial<PaidUpgrade> = {}): PaidUpgrade {
  return {
    fromPlan: "pro",
    toPlan: "max",
    fromAllowance: "100",
    toAllowance: "500",
    policyRevision: ctx.policy.revision,
    subscriptionStart: start,
    paidUntil: end,
    effectiveAt: halfway,
    ...overrides,
  };
}

async function seed(
  ctx: Context,
  options: {
    key?: string;
    plan?: string;
    amount?: string;
    periodStart?: Date;
    expiresAt?: Date;
    legacy?: boolean;
  } = {},
) {
  await fixture.db.sql.begin(async (tx) => {
    await grant(
      tx,
      ctx.userId,
      options.key ?? `included:pro:${start.toISOString()}`,
      "included",
      ctx.policy.revision,
      options.plan ?? "pro",
      options.amount ?? "100",
      options.expiresAt ?? end,
      options.periodStart ?? start,
    );
    if (options.legacy)
      await tx`UPDATE credit_grant SET allowance_basis=NULL WHERE user_id=${ctx.userId}`;
  });
}

async function upgrade(ctx: Context, details = change(ctx)) {
  await fixture.db.sql.begin(async (tx) => {
    await tx`SELECT user_id FROM billing_customer WHERE user_id=${ctx.userId} FOR UPDATE`;
    await applyPaidUpgrade(tx, ctx.userId, details);
  });
}

async function grants(ctx: Context) {
  return fixture.db.sql`SELECT id,grant_key,plan_id,amount::text,spent::text,held::text,
    allowance_basis::text,period_start,expires_at,policy_revision,revoked
    FROM credit_grant WHERE user_id=${ctx.userId} ORDER BY grant_key`;
}

function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("Missing grant");
  return row;
}

test("half-cycle upgrade adds only the allowance difference and retains spent, held, period and key", async () => {
  const ctx = await setup();
  await seed(ctx);
  await fixture.db.sql`UPDATE credit_grant SET spent=30,held=20 WHERE user_id=${ctx.userId}`;
  const before = only(await grants(ctx));
  await upgrade(ctx);
  expect(only(await grants(ctx))).toEqual({
    ...before,
    plan_id: "max",
    amount: "300",
    allowance_basis: "500",
  });
});

test("proration rounds down with exact integer arithmetic beyond Number precision", async () => {
  const ctx = await setup(paidPolicy("100", "999999999999999"));
  await seed(ctx);
  const effectiveAt = new Date(start.getTime() + 1);
  const target = 999999999999999n;
  const duration = BigInt(end.getTime() - start.getTime());
  const numerator = (target - 100n) * (duration - 1n);
  expect(numerator).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  expect(numerator % duration).not.toBe(0n);
  await upgrade(ctx, change(ctx, { toAllowance: target.toString(), effectiveAt }));
  const row = only(await grants(ctx));
  expect(row.amount).toBe((100n + numerator / duration).toString());
  expect(row.allowance_basis).toBe(target.toString());
});

test("upgrade before the first allowance read creates the base grant plus prorated difference", async () => {
  const ctx = await setup();
  await upgrade(ctx);
  const row = only(await grants(ctx));
  expect(row).toMatchObject({
    grant_key: `included:pro:${start.toISOString()}`,
    plan_id: "max",
    amount: "300",
    spent: "0",
    held: "0",
    allowance_basis: "500",
  });
  expect(new Date(row.period_start).toISOString()).toBe(start.toISOString());
  expect(new Date(row.expires_at).toISOString()).toBe(end.toISOString());
});

test("legacy grant uses its historical policy allowance after the current policy changes", async () => {
  const ctx = await setup();
  await seed(ctx, { legacy: true });
  const revised = paidPolicy("200", "700");
  await registerPolicy(fixture.db, revised);
  await upgrade(
    ctx,
    change(ctx, {
      fromAllowance: "200",
      toAllowance: "700",
      policyRevision: revised.revision,
    }),
  );
  expect(only(await grants(ctx))).toMatchObject({
    amount: "400",
    allowance_basis: "700",
    policy_revision: ctx.policy.revision,
  });
});

test("yearly subscription upgrades use the current monthly allowance period", async () => {
  const ctx = await setup();
  const monthlyStart = new Date("2090-07-01T00:00:00.000Z");
  const monthlyEnd = new Date("2090-08-01T00:00:00.000Z");
  await upgrade(
    ctx,
    change(ctx, {
      paidUntil: new Date("2091-01-01T00:00:00.000Z"),
      effectiveAt: new Date("2090-07-16T12:00:00.000Z"),
    }),
  );
  const row = only(await grants(ctx));
  expect(row.amount).toBe("300");
  expect(row.grant_key).toBe(`included:pro:${monthlyStart.toISOString()}`);
  expect(new Date(row.period_start).toISOString()).toBe(monthlyStart.toISOString());
  expect(new Date(row.expires_at).toISOString()).toBe(monthlyEnd.toISOString());
});

test("delayed recovery after the allowance month ends grants nothing even while annual billing continues", async () => {
  const ctx = await setup();
  await upgrade(
    ctx,
    change(ctx, {
      subscriptionStart: new Date("2020-01-01T00:00:00.000Z"),
      paidUntil: new Date("2091-01-01T00:00:00.000Z"),
      effectiveAt: new Date("2020-07-16T12:00:00.000Z"),
    }),
  );
  expect(await grants(ctx)).toHaveLength(0);
});

test.each([
  ["duplicate source grants", ["pro", "pro"]],
  ["mixed source and target grants", ["pro", "max"]],
  ["an already transitioned target grant", ["max"]],
] as const)("%s reject the entire billing transaction", async (_label, plans) => {
  const ctx = await setup();
  for (const [index, plan] of plans.entries())
    await seed(ctx, { key: `conflicting:${index}`, plan });
  const before = await grants(ctx);
  await expect(
    fixture.db.sql.begin(async (tx) => {
      await tx`SELECT user_id FROM billing_customer WHERE user_id=${ctx.userId} FOR UPDATE`;
      await tx`UPDATE billing_customer SET product_id='synthetic-upgrade' WHERE user_id=${ctx.userId}`;
      await applyPaidUpgrade(tx, ctx.userId, change(ctx));
    }),
  ).rejects.toMatchObject({ code: "billing_review_required" });
  expect(await grants(ctx)).toEqual(before);
  const [billing] = await fixture.db
    .sql`SELECT product_id FROM billing_customer WHERE user_id=${ctx.userId}`;
  expect(billing?.product_id).toBeNull();
});

test("a subsequent higher tier uses the recorded full-cycle basis instead of the prorated grant amount", async () => {
  const ctx = await setup();
  await seed(ctx);
  await upgrade(ctx);
  expect(only(await grants(ctx))).toMatchObject({ amount: "300", allowance_basis: "500" });
  await upgrade(
    ctx,
    change(ctx, {
      fromPlan: "max",
      toPlan: "ultra",
      fromAllowance: "600",
      toAllowance: "900",
      effectiveAt: new Date("2090-01-24T06:00:00.000Z"),
    }),
  );
  expect(only(await grants(ctx))).toMatchObject({
    grant_key: `included:pro:${start.toISOString()}`,
    plan_id: "ultra",
    amount: "400",
    allowance_basis: "900",
  });
});
