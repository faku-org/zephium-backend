import { expect, test } from "bun:test";
import { testPolicy } from "../../../../tests/support/cloud-fixture";
import { AppError } from "../../../platform/errors";
import {
  assertPlanChangeSubscription,
  type PlanChangeTarget,
  quotePlanChange,
} from "../plan-change-policy";
import type { BillingSubscription, ProductOffer } from "../provider";

const pro = "00000000-0000-4000-8000-000000000401";
const max = "00000000-0000-4000-8000-000000000402";
const proYear = "00000000-0000-4000-8000-000000000403";
const maxYear = "00000000-0000-4000-8000-000000000404";
const start = new Date("2026-10-01T00:00:00.000Z");
const end = new Date("2026-11-01T00:00:00.000Z");
const now = new Date("2026-10-16T12:00:00.000Z");

function fixture() {
  const base = testPolicy();
  const free = base.plans[0];
  if (!free) throw new Error("Missing free test plan");
  const policy = testPolicy({
    welcomeUnits: "0",
    plans: [
      { ...free, cycle: { kind: "once" } },
      { ...free, id: "pro", rank: 1, allowanceUnits: "100" },
      { ...free, id: "max", rank: 2, allowanceUnits: "500" },
    ],
    subscriptions: [
      { plan: "pro", interval: "monthly", productId: pro },
      { plan: "max", interval: "monthly", productId: max },
      { plan: "pro", interval: "yearly", productId: proYear },
      { plan: "max", interval: "yearly", productId: maxYear },
    ],
  });
  const subscription: BillingSubscription = {
    id: "subscription-1",
    customerId: "customer-1",
    accountId: "account-1",
    productId: pro,
    status: "active",
    periodStart: start,
    paidUntil: end,
    subscriptionStart: start,
    modifiedAt: start,
    cancelAtPeriodEnd: false,
    amountMinor: 2000,
    currency: "usd",
    recurringInterval: "month",
    recurringIntervalCount: 1,
    discountId: null,
    pendingChange: null,
  };
  const target: PlanChangeTarget = { plan: "max", interval: "monthly" };
  const offer: ProductOffer = {
    productId: max,
    productName: "Synthetic Max",
    price: { amount_minor: 10000, currency: "USD" },
  };
  return { policy, subscription, target, offer, now };
}

type Fixture = ReturnType<typeof fixture>;
function quote(value: Fixture) {
  return quotePlanChange(value.policy, value.subscription, value.target, value.offer, value.now);
}
function plan(value: Fixture, id: string) {
  const result = value.policy.plans.find((item) => item.id === id);
  if (!result) throw new Error("Missing test plan");
  return result;
}

test("upgrade quote estimates the remaining half period and serializes its full prior state", () => {
  const value = fixture();
  const result = quote(value);
  expect(result).toEqual({
    subscription_id: "subscription-1",
    customer_id: "customer-1",
    account_id: "account-1",
    current_product_id: pro,
    provider_status: "active",
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    subscription_start: start.toISOString(),
    provider_modified_at: start.toISOString(),
    prior_amount_minor: 2000,
    currency: "USD",
    prior_recurring_interval: "month",
    prior_recurring_interval_count: 1,
    prior_discount_id: null,
    prior_cancel_at_period_end: false,
    prior_pending_change: null,
    current_plan: "pro",
    target_plan: "max",
    target_product_id: max,
    interval: "monthly",
    direction: "upgrade",
    behavior: "invoice",
    estimated_prorated_amount_minor: 4000,
    estimate: true,
    tax_excluded: null,
    target_amount_minor: 10000,
    current_allowance_units: "100",
    target_allowance_units: "500",
    policy_revision: value.policy.revision,
    quoted_at: now.toISOString(),
    expires_at: "2026-10-16T12:05:00.000Z",
  });
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  expect(() => assertPlanChangeSubscription(result, value.subscription)).not.toThrow();
});

test("upgrade rounding uses exact integer arithmetic and expires before the renewal boundary", () => {
  const value = fixture();
  value.now = new Date(end.getTime() - 30_001);
  expect(quote(value)).toMatchObject({
    estimated_prorated_amount_minor: 1,
    expires_at: "2026-10-31T23:59:30.000Z",
  });
  value.now = now;
  value.subscription.amountMinor = 1;
  value.offer.price.amount_minor = Number.MAX_SAFE_INTEGER;
  expect(quote(value).estimated_prorated_amount_minor).toBe(4503599627370495);
});

test("downgrade preserves current terms until renewal with no immediate proration", () => {
  const value = fixture();
  value.subscription.productId = max;
  value.subscription.amountMinor = 10000;
  value.target.plan = "pro";
  value.offer.productId = pro;
  value.offer.price.amount_minor = 2000;
  expect(quote(value)).toMatchObject({
    current_plan: "max",
    target_plan: "pro",
    direction: "downgrade",
    behavior: "next_period",
    estimated_prorated_amount_minor: 0,
    current_allowance_units: "500",
    target_allowance_units: "100",
  });
});

test("annual billing estimates over the actual provider year while allowances stay monthly", () => {
  const value = fixture();
  value.subscription.productId = proYear;
  value.subscription.recurringInterval = "year";
  value.subscription.periodStart = new Date("2024-01-31T00:00:00.000Z");
  value.subscription.paidUntil = new Date("2025-01-31T00:00:00.000Z");
  value.subscription.amountMinor = 20000;
  value.now = new Date("2024-08-01T00:00:00.000Z");
  value.target.interval = "yearly";
  value.offer.productId = maxYear;
  value.offer.price.amount_minor = 100000;
  expect(quote(value)).toMatchObject({
    interval: "yearly",
    estimated_prorated_amount_minor: 40000,
    target_amount_minor: 100000,
  });
});

test("a retired current product can upgrade to an active offer without changing its identity", () => {
  const value = fixture();
  const current = value.policy.subscriptions.find((item) => item.productId === pro);
  if (!current) throw new Error("Missing source product");
  current.checkoutEnabled = false;
  expect(quote(value).current_product_id).toBe(pro);
});

const invalidCases: {
  name: string;
  mutate: (value: Fixture) => void;
  code: string;
  status: number;
}[] = [
  {
    name: "inactive subscription",
    mutate: (v) => {
      v.subscription.status = "past_due";
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "missing account ownership",
    mutate: (v) => {
      v.subscription.accountId = null;
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "pending change",
    mutate: (v) => {
      v.subscription.pendingChange = { productId: max, appliesAt: end };
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "scheduled cancellation",
    mutate: (v) => {
      v.subscription.cancelAtPeriodEnd = true;
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "discount",
    mutate: (v) => {
      v.subscription.discountId = "discount-1";
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "future period start",
    mutate: (v) => {
      v.subscription.periodStart = new Date(now.getTime() + 1);
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "expired period",
    mutate: (v) => {
      v.subscription.paidUntil = now;
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "renewal safety window",
    mutate: (v) => {
      v.now = new Date(end.getTime() - 30000);
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "invalid provider timestamp",
    mutate: (v) => {
      v.subscription.modifiedAt = new Date(Number.NaN);
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "unsupported cadence",
    mutate: (v) => {
      v.subscription.recurringInterval = "week";
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "multiple cadence units",
    mutate: (v) => {
      v.subscription.recurringIntervalCount = 2;
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "unknown current product",
    mutate: (v) => {
      v.subscription.productId = "unknown-product";
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "current mapping cadence mismatch",
    mutate: (v) => {
      v.subscription.recurringInterval = "year";
    },
    code: "subscription_change_unavailable",
    status: 409,
  },
  {
    name: "same plan",
    mutate: (v) => {
      v.target.plan = "pro";
    },
    code: "invalid_plan_change",
    status: 400,
  },
  {
    name: "cross cadence",
    mutate: (v) => {
      v.target.interval = "yearly";
    },
    code: "invalid_plan_change",
    status: 400,
  },
  {
    name: "unknown target",
    mutate: (v) => {
      v.target.plan = "unknown";
    },
    code: "invalid_plan_change",
    status: 400,
  },
  {
    name: "retired target offer",
    mutate: (v) => {
      const target = v.policy.subscriptions.find((item) => item.productId === max);
      if (target) target.checkoutEnabled = false;
    },
    code: "invalid_plan_change",
    status: 400,
  },
  {
    name: "equal rank",
    mutate: (v) => {
      plan(v, "max").rank = 1;
    },
    code: "invalid_plan_change",
    status: 400,
  },
  {
    name: "higher rank without higher price",
    mutate: (v) => {
      v.offer.price.amount_minor = 2000;
    },
    code: "invalid_plan_change",
    status: 400,
  },
  {
    name: "lower rank with higher price",
    mutate: (v) => {
      plan(v, "max").rank = 0;
    },
    code: "invalid_plan_change",
    status: 400,
  },
  {
    name: "wrong provider offer",
    mutate: (v) => {
      v.offer.productId = pro;
    },
    code: "product_configuration_invalid",
    status: 503,
  },
  {
    name: "currency mismatch",
    mutate: (v) => {
      v.offer.price.currency = "EUR";
    },
    code: "product_configuration_invalid",
    status: 503,
  },
  {
    name: "unsafe target price",
    mutate: (v) => {
      v.offer.price.amount_minor = Number.MAX_SAFE_INTEGER + 1;
    },
    code: "product_configuration_invalid",
    status: 503,
  },
  {
    name: "nonmonthly allowance",
    mutate: (v) => {
      plan(v, "max").cycle = { kind: "fixed_days", days: 30 };
    },
    code: "product_configuration_invalid",
    status: 503,
  },
  {
    name: "upgrade allowance decreases",
    mutate: (v) => {
      plan(v, "max").allowanceUnits = "99";
    },
    code: "product_configuration_invalid",
    status: 503,
  },
];
for (const item of invalidCases) {
  test(`plan quote rejects ${item.name}`, () => {
    const value = fixture();
    item.mutate(value);
    let caught: unknown;
    try {
      quote(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: item.code, status: item.status });
  });
}

test("downgrade requires strictly less allowance and upgrades permit equal allowance", () => {
  const value = fixture();
  plan(value, "max").allowanceUnits = "100";
  expect(quote(value).direction).toBe("upgrade");
  value.subscription.productId = max;
  value.subscription.amountMinor = 10000;
  value.target.plan = "pro";
  value.offer.productId = pro;
  value.offer.price.amount_minor = 2000;
  expect(() => quote(value)).toThrow("product_configuration_invalid");
});

const changes: Partial<BillingSubscription>[] = [
  { id: "other-subscription" },
  { customerId: "other-customer" },
  { accountId: "other-account" },
  { productId: max },
  { status: "past_due" },
  { amountMinor: 2001 },
  { currency: "eur" },
  { periodStart: new Date(start.getTime() + 1) },
  { paidUntil: new Date(end.getTime() + 1) },
  { subscriptionStart: null },
  { modifiedAt: null },
  { modifiedAt: new Date(start.getTime() + 1) },
  { recurringInterval: "year" },
  { recurringIntervalCount: 2 },
  { discountId: "new-discount" },
  { cancelAtPeriodEnd: true },
  { pendingChange: { productId: max, appliesAt: end } },
];
for (const change of changes) {
  test(`confirmation rejects changed subscription ${Object.keys(change)[0]}`, () => {
    const value = fixture();
    const snapshot = quote(value);
    expect(() =>
      assertPlanChangeSubscription(snapshot, { ...value.subscription, ...change }),
    ).toThrow("subscription_change_unavailable");
  });
}
