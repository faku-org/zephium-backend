import { expect, test } from "bun:test";
import { polarProvider, SubscriptionChangeRejected } from "../provider";

const subscriptionId = "00000000-0000-4000-8000-000000000301";
const customerId = "00000000-0000-4000-8000-000000000302";
const productId = "00000000-0000-4000-8000-000000000303";
const start = "2026-10-01T12:00:00.000Z";
const end = "2026-11-01T12:00:00.000Z";

// Complete synthetic response exercises the pinned SDK decoder, not an adapter mock.
function subscriptionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: subscriptionId,
    created_at: start,
    modified_at: start,
    amount: 10000,
    currency: "usd",
    recurring_interval: "month",
    recurring_interval_count: 1,
    status: "active",
    current_period_start: start,
    current_period_end: end,
    current_meter_period_start: null,
    current_meter_period_end: null,
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: start,
    ends_at: null,
    ended_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    customer_id: customerId,
    product_id: productId,
    discount_id: null,
    checkout_id: null,
    customer_cancellation_reason: null,
    customer_cancellation_comment: null,
    metadata: { private_test_metadata: "not projected" },
    customer: {
      id: customerId,
      created_at: start,
      modified_at: null,
      metadata: { private_test_metadata: "not projected" },
      external_id: "account-123",
      email: "private-test@example.test",
      email_verified: true,
      type: "individual",
      name: "Private test name",
      billing_name: null,
      billing_address: null,
      tax_id: null,
      organization_id: "test-organization",
      deleted_at: null,
      avatar_url: null,
    },
    product: {
      id: productId,
      created_at: start,
      modified_at: null,
      trial_interval: null,
      trial_interval_count: null,
      name: "Synthetic subscription",
      description: null,
      visibility: "public",
      recurring_interval: "month",
      recurring_interval_count: 1,
      meter_interval: null,
      meter_interval_count: null,
      is_recurring: true,
      is_archived: false,
      organization_id: "test-organization",
      metadata: {},
      prices: [],
      benefits: [],
      medias: [],
      attached_custom_fields: [],
    },
    discount: null,
    prices: [],
    meters: [],
    pending_update: {
      id: "pending-change",
      created_at: start,
      modified_at: null,
      applies_at: end,
      product_id: "next-product",
      seats: null,
    },
    ...overrides,
  };
}

function adapter(fetcher: Parameters<typeof polarProvider>[1]) {
  const provider = polarProvider(
    {
      POLAR_ACCESS_TOKEN: "synthetic-test-token",
      POLAR_ENVIRONMENT: "sandbox",
      BILLING_RETURN_URL: "https://example.test/billing",
    },
    fetcher,
  );
  if (!provider.subscription || !provider.changeSubscription || !provider.productOffer)
    throw new Error("Missing subscription adapter");
  return {
    read: provider.subscription,
    change: provider.changeSubscription,
    offer: provider.productOffer,
  };
}

test("subscription GET projects ownership and billing fields without retaining provider PII", async () => {
  const requests: Request[] = [];
  const provider = adapter(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(subscriptionResponse());
  });
  expect(await provider.read(subscriptionId)).toEqual({
    id: subscriptionId,
    customerId,
    accountId: "account-123",
    productId,
    status: "active",
    periodStart: new Date(start),
    paidUntil: new Date(end),
    subscriptionStart: new Date(start),
    modifiedAt: new Date(start),
    cancelAtPeriodEnd: false,
    amountMinor: 10000,
    currency: "usd",
    recurringInterval: "month",
    recurringIntervalCount: 1,
    discountId: null,
    pendingChange: { productId: "next-product", appliesAt: new Date(end) },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe("GET");
  expect(new URL(requests[0]?.url ?? "").pathname).toBe(`/v1/subscriptions/${subscriptionId}`);
});

test("subscription projection preserves missing ownership, nullable dates and absent plan changes", async () => {
  const raw = subscriptionResponse();
  const provider = adapter(async () =>
    Response.json({
      ...raw,
      modified_at: null,
      started_at: null,
      recurring_interval: "year",
      recurring_interval_count: 2,
      discount_id: "test-discount",
      customer: { ...raw.customer, external_id: null },
      pending_update: { ...raw.pending_update, product_id: null, seats: 2 },
    }),
  );
  expect(await provider.read(subscriptionId)).toMatchObject({
    accountId: null,
    subscriptionStart: null,
    modifiedAt: null,
    pendingChange: null,
    recurringInterval: "year",
    recurringIntervalCount: 2,
    discountId: "test-discount",
  });
});

test("subscription changes PATCH only product and explicit behavior without creating checkout", async () => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const provider = adapter(async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: await request.json(),
    });
    return Response.json(subscriptionResponse());
  });
  for (const behavior of ["invoice", "next_period"] as const) {
    expect((await provider.change(subscriptionId, productId, behavior)).id).toBe(subscriptionId);
  }
  expect(requests).toEqual(
    ["invoice", "next_period"].map((behavior) => ({
      method: "PATCH",
      path: `/v1/subscriptions/${subscriptionId}`,
      body: { product_id: productId, proration_behavior: behavior },
    })),
  );
});

for (const rejection of [
  {
    status: 402,
    body: { error: "PaymentFailed", detail: "private provider detail" },
    code: "payment_failed",
    exposedStatus: 402,
  },
  {
    status: 409,
    body: { error: "SubscriptionLocked", detail: "private provider detail" },
    code: "subscription_locked",
    exposedStatus: 409,
  },
  { status: 400, body: {}, code: "invalid_subscription_change", exposedStatus: 400 },
  {
    status: 404,
    body: { error: "ResourceNotFound", detail: "private provider detail" },
    code: "invalid_subscription_change",
    exposedStatus: 400,
  },
  { status: 422, body: { detail: [] }, code: "invalid_subscription_change", exposedStatus: 400 },
  { status: 401, body: {}, code: "billing_unavailable", exposedStatus: 503 },
  {
    status: 403,
    body: { error: "AlreadyCanceledSubscription", detail: "private provider detail" },
    code: "billing_unavailable",
    exposedStatus: 503,
  },
  { status: 429, body: {}, code: "billing_rate_limited", exposedStatus: 429 },
]) {
  test(`subscription change ${rejection.status} is a sanitized definite rejection without retry`, async () => {
    let calls = 0;
    const provider = adapter(async () => {
      calls++;
      return Response.json(rejection.body, {
        status: rejection.status,
        headers: { "retry-after": "7" },
      });
    });
    const error = await provider
      .change(subscriptionId, productId, "invoice")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SubscriptionChangeRejected);
    expect(error).toMatchObject({
      code: rejection.code,
      status: rejection.exposedStatus,
      message: rejection.code,
    });
    expect(JSON.stringify(error)).not.toContain("private provider detail");
    if (rejection.status === 429) expect(error).toMatchObject({ retryAfter: 7 });
    expect(calls).toBe(1);
  });
}

for (const failure of [
  "network",
  "server",
  "decode",
  "malformed-rejection",
  "invalid-json",
  "unexpected-content",
] as const) {
  test(`subscription change ${failure} failure stays uncertain and is not retried`, async () => {
    let calls = 0;
    const provider = adapter(async () => {
      calls++;
      if (failure === "network") throw new TypeError("synthetic connection lost");
      if (failure === "server")
        return Response.json({ detail: "synthetic failure" }, { status: 503 });
      if (failure === "malformed-rejection") return Response.json({}, { status: 402 });
      if (failure === "invalid-json")
        return new Response("{", { status: 402, headers: { "content-type": "application/json" } });
      if (failure === "unexpected-content")
        return new Response("synthetic proxy response", {
          status: 402,
          headers: { "content-type": "text/plain" },
        });
      return Response.json({ id: subscriptionId });
    });
    const error = await provider
      .change(subscriptionId, productId, "invoice")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SubscriptionChangeRejected);
    expect(calls).toBe(1);
  });
}

function productResponse(amount: number) {
  return {
    ...subscriptionResponse().product,
    prices: [
      {
        id: "synthetic-price",
        created_at: start,
        modified_at: null,
        source: "catalog",
        amount_type: "fixed",
        price_currency: "usd",
        tax_behavior: null,
        is_archived: false,
        product_id: productId,
        price_amount: amount,
      },
    ],
  };
}

test("a fresh product offer observes changed pricing despite the display cache", async () => {
  const requests: Request[] = [];
  const provider = adapter(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(productResponse(requests.length === 1 ? 10000 : 10500));
  });
  const purchase = { kind: "subscription", interval: "monthly" } as const;
  expect((await provider.offer(productId, purchase)).price.amount_minor).toBe(10000);
  expect((await provider.offer(productId, purchase)).price.amount_minor).toBe(10000);
  expect(requests).toHaveLength(1);
  expect((await provider.offer(productId, purchase, { fresh: true })).price.amount_minor).toBe(
    10500,
  );
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["GET", `/v1/products/${productId}`],
    ["GET", `/v1/products/${productId}`],
  ]);
});

test("a fresh product offer bypasses an older in-flight display lookup", async () => {
  const started = Promise.withResolvers<void>();
  const displayResponse = Promise.withResolvers<Response>();
  let calls = 0;
  const provider = adapter(async () => {
    calls++;
    if (calls === 1) {
      started.resolve();
      return displayResponse.promise;
    }
    return Response.json(productResponse(10500));
  });
  const purchase = { kind: "subscription", interval: "monthly" } as const;
  const display = provider.offer(productId, purchase);
  await started.promise;
  try {
    expect((await provider.offer(productId, purchase, { fresh: true })).price.amount_minor).toBe(
      10500,
    );
    expect(calls).toBe(2);
  } finally {
    displayResponse.resolve(Response.json(productResponse(10000)));
  }
  expect((await display).price.amount_minor).toBe(10000);
});
