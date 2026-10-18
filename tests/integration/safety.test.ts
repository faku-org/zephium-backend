import { expect, test } from "bun:test";
import { assertPurchaseProduct } from "../../src/modules/billing/provider";
import { assertPolicyEvolution, policySchema } from "../../src/modules/policy/policy";
import { readIncomingBody } from "../../src/platform/incoming-body";
import { testPolicy } from "../support/cloud-fixture";

test("request uploads have independent byte and wall-clock bounds", async () => {
  let cancelled = false;
  const large = new Request("http://localhost/upload", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  await expect(readIncomingBody(large, 5, 1000)).rejects.toMatchObject({ code: "body_too_large" });
  expect(cancelled).toBe(true);
  const stalled = new Request("http://localhost/upload", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
  });
  await expect(readIncomingBody(stalled, 100, 10)).rejects.toMatchObject({
    code: "request_timeout",
  });
  const normal = new Request("http://localhost/upload", { method: "POST", body: "hello" });
  expect(new TextDecoder().decode(await readIncomingBody(normal, 10, 1000))).toBe("hello");
});
test("a top-up cannot secretly be recurring or metered, and subscription cadence must match", () => {
  const base = {
    isArchived: false,
    isRecurring: false,
    recurringInterval: null,
    recurringIntervalCount: null,
    prices: [{ isArchived: false, amountType: "fixed", priceAmount: 500 }],
  };
  expect(() => assertPurchaseProduct(base, { kind: "topup" })).not.toThrow();
  expect(() =>
    assertPurchaseProduct({ ...base, prices: [...base.prices, ...base.prices] }, { kind: "topup" }),
  ).toThrow();
  expect(() =>
    assertPurchaseProduct(
      { ...base, isRecurring: true, recurringInterval: "month", recurringIntervalCount: 1 },
      { kind: "subscription", interval: "monthly" },
    ),
  ).not.toThrow();
  expect(() => assertPurchaseProduct({ ...base, isRecurring: true }, { kind: "topup" })).toThrow();
  expect(() =>
    assertPurchaseProduct(
      { ...base, prices: [{ isArchived: false, amountType: "metered_unit", priceAmount: 500 }] },
      { kind: "topup" },
    ),
  ).toThrow();
  expect(() =>
    assertPurchaseProduct(
      { ...base, prices: [{ isArchived: false, amountType: "fixed", priceAmount: 0 }] },
      { kind: "topup" },
    ),
  ).toThrow();
  expect(() =>
    assertPurchaseProduct(
      { ...base, isRecurring: true, recurringInterval: "month", recurringIntervalCount: 1 },
      { kind: "subscription", interval: "yearly" },
    ),
  ).toThrow();
});

test("retiring offers preserves purchased plan identity while quotas remain editable", () => {
  const initial = testPolicy();
  const free = initial.plans[0];
  if (!free) throw new Error("Missing test plan");
  const paid = { ...free, id: "pro", rank: 1 };
  const product = {
    productId: "00000000-0000-4000-8000-000000000102",
    plan: "pro",
    interval: "monthly" as const,
  };
  const before = policySchema.parse({
    ...initial,
    plans: [...initial.plans, paid],
    subscriptions: [product],
  });
  const after = {
    ...before,
    revision: before.revision + 1,
    plans: before.plans.map((p) => ({ ...p, allowanceUnits: "500" })),
    subscriptions: [{ ...product, checkoutEnabled: false }],
  };
  expect(() => assertPolicyEvolution(before, after)).not.toThrow();
  expect(() => assertPolicyEvolution(before, { ...after, subscriptions: [] })).toThrow(
    "Keep subscription product mappings",
  );
  expect(() =>
    assertPolicyEvolution(before, { ...after, subscriptions: [{ ...product, plan: "free" }] }),
  ).toThrow("Keep subscription product mappings");
  expect(() => assertPolicyEvolution(before, { ...after, plans: [free] })).toThrow(
    "Keep existing plan identifiers",
  );
});
