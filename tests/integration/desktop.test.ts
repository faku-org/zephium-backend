import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "../../src/apps/api/app";
import { createCloudService } from "../../src/modules/ai/service";
import type { CloudTransport } from "../../src/modules/ai/transport";
import { processPlanChange } from "../../src/modules/billing/plan-change-worker";
import type { BillingProvider, BillingSubscription } from "../../src/modules/billing/provider";
import { createAuth, type Mailer } from "../../src/modules/identity/auth";
import { registerPolicy } from "../../src/modules/policy/policy";
import type { Config } from "../../src/platform/config";
import type { Database } from "../../src/platform/db";
import { testPolicy } from "../support/cloud-fixture";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let subscriptionFixture: Awaited<ReturnType<typeof testDatabase>>;
const codes = new Map<string, string>();
const mailer: Mailer = {
  sendOTP: async (email, code) => {
    codes.set(email, code);
  },
};
const calls = { product: 0, checkout: 0, portal: 0, orders: 0 };
const productId = "00000000-0000-4000-8000-000000000101";
const checkoutId = crypto.randomUUID();
let checkoutOwner = "";
const provider: BillingProvider = {
  state: async () => null,
  checkout: async (userId) => {
    calls.checkout++;
    checkoutOwner = userId;
    return {
      id: checkoutId,
      url: "https://sandbox.polar.sh/checkout/desktop",
      expiresAt: new Date(Date.now() + 3600_000),
    };
  },
  portal: async () => {
    calls.portal++;
    return "https://sandbox.polar.sh/portal/desktop";
  },
  deleteCustomer: async () => {},
  openCheckoutUntil: async () => null,
  productOffer: async (id) => {
    calls.product++;
    return {
      productId: id,
      productName: "Desktop credits",
      price: { amount_minor: 500, currency: "USD" },
    };
  },
  ordersForCheckouts: async (userId, ids) => {
    calls.orders++;
    return userId === checkoutOwner && ids.includes(checkoutId)
      ? [
          {
            id: "desktop-paid-order",
            checkoutId,
            userId,
            productId,
            paid: true,
            refunded: false,
            createdAt: new Date(),
          },
        ]
      : [];
  },
};
const transport: CloudTransport = {
  available: (name) => name === "openai",
  count: async () => {
    throw new Error("No model traffic in desktop integration tests");
  },
  generate: async () => {
    throw new Error("No model traffic in desktop integration tests");
  },
};

beforeAll(async () => {
  fixture = await testDatabase();
  subscriptionFixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await Promise.all([fixture.close(), subscriptionFixture.close()]);
});
function app(config: Config = fixture.config, cloud?: ReturnType<typeof createCloudService>) {
  return createApp(
    config,
    fixture.db,
    createAuth(config, fixture.db, mailer),
    provider,
    () => "198.51.100.12",
    cloud,
    mailer,
  );
}
type App = ReturnType<typeof createApp>;
function request(
  target: App,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  extra: Record<string, string> = {},
) {
  return target.request(`http://localhost:3000${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...extra,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(target: App) {
  const email = `${crypto.randomUUID()}@example.test`;
  expect(
    (
      await request(target, "/api/auth/email-otp/send-verification-otp", "POST", {
        email,
        type: "sign-in",
      })
    ).status,
  ).toBe(202);
  let code: string | undefined;
  for (let i = 0; i < 100 && !code; i++) {
    code = codes.get(email);
    if (!code) await Bun.sleep(10);
  }
  if (!code) throw new Error("OTP was not delivered to injected mailer");
  const signed = await request(target, "/api/auth/sign-in/email-otp", "POST", { email, otp: code });
  expect(signed.status).toBe(200);
  const token = signed.headers.get("set-auth-token");
  if (!token) throw new Error("Signed bearer token missing");
  const body = (await signed.json()) as { user: { id: string } };
  return { id: body.user.id, token };
}

async function subscriptionApp() {
  const db = subscriptionFixture.db;
  const base = testPolicy();
  const free = base.plans[0];
  if (!free) throw new Error("Missing fixture plan");
  const pro = "00000000-0000-4000-8000-000000000201";
  const max = "00000000-0000-4000-8000-000000000202";
  const policy = testPolicy({
    welcomeUnits: "0",
    plans: [
      ...base.plans,
      { ...free, id: "pro", rank: 1, allowanceUnits: "1000000" },
      { ...free, id: "max", rank: 2, allowanceUnits: "5000000" },
    ],
    subscriptions: [
      { plan: "pro", productId: pro, interval: "monthly" },
      { plan: "max", productId: max, interval: "monthly" },
    ],
  });
  await registerPolicy(db, policy);
  const start = new Date(Date.now() - 15 * 86400000);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  let subscription: BillingSubscription = {
    id: crypto.randomUUID(),
    customerId: crypto.randomUUID(),
    accountId: "",
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
  let mutations = 0;
  const billing: BillingProvider = {
    ...provider,
    subscription: async (id) => {
      if (id !== subscription.id) throw new Error("Unknown synthetic subscription");
      return structuredClone(subscription);
    },
    productOffer: async (id) => ({
      productId: id,
      productName: id === max ? "Max" : "Pro",
      price: { amount_minor: id === max ? 10000 : 2000, currency: "USD" },
    }),
    changeSubscription: async (id, productId, behavior) => {
      expect(id).toBe(subscription.id);
      expect(productId).toBe(max);
      expect(behavior).toBe("invoice");
      mutations++;
      subscription = { ...subscription, productId, amountMinor: 10000, modifiedAt: new Date() };
      return structuredClone(subscription);
    },
  };
  const config = { ...subscriptionFixture.config, BILLING_ENABLED: "true" as const };
  const cloud = createCloudService(db, policy, transport, config.ABUSE_SECRET);
  const target = createApp(
    config,
    db,
    createAuth(config, db, mailer),
    billing,
    () => "198.51.100.12",
    cloud,
    mailer,
  );
  const owner = await login(target);
  subscription.accountId = owner.id;
  await db.sql`UPDATE billing_customer SET provider_touched=true,
    polar_id=${subscription.customerId},subscription_id=${subscription.id},product_id=${pro},
    status='active',paid_until=${end.toISOString()},period_start=${start.toISOString()},
    subscription_start=${start.toISOString()},reconciled_at=now() WHERE user_id=${owner.id}`;
  return { target, owner, policy, billing, db, mutations: () => mutations };
}

test("subscription HTTP preview and receipts enforce ownership and duplicate confirmation charges once", async () => {
  const ctx = await subscriptionApp();
  const other = await login(ctx.target);
  const preview = await request(
    ctx.target,
    "/v1/billing/subscription/preview",
    "POST",
    { plan: "max", interval: "monthly" },
    ctx.owner.token,
  );
  expect(preview.status).toBe(200);
  const quote = await preview.json();
  expect(structuredClone(quote)).toMatchObject({
    id: expect.any(String),
    status: "quoted",
    current_plan: "pro",
    target_plan: "max",
    interval: "monthly",
    direction: "upgrade",
    effective_at: null,
    amount_due_estimate: {
      amount_minor: expect.any(Number),
      currency: "USD",
      tax_excluded: null,
      tax_calculation: "not_calculated",
    },
    recurring_price: { amount_minor: 10000, currency: "USD" },
    expires_at: expect.any(String),
    error: null,
  });
  expect(ctx.mutations()).toBe(0);
  // Old persisted quotes must not keep advertising unverified tax-exclusive amounts.
  await ctx.db
    .sql`UPDATE billing_plan_change SET quote=jsonb_set(quote,'{tax_excluded}','true'::jsonb) WHERE id=${quote.id}`;
  const receiptPath = `/v1/billing/subscription/changes/${quote.id}`;
  const owned = await request(ctx.target, receiptPath, "GET", undefined, ctx.owner.token);
  expect(await owned.json()).toEqual(quote);
  expect(owned.status).toBe(200);
  for (const response of [
    await request(ctx.target, receiptPath, "GET", undefined, other.token),
    await request(
      ctx.target,
      "/v1/billing/subscription/change",
      "POST",
      { quote_id: quote.id },
      other.token,
    ),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "plan_change_not_found" },
      request_id: null,
    });
  }
  const confirm = () =>
    request(
      ctx.target,
      "/v1/billing/subscription/change",
      "POST",
      { quote_id: quote.id },
      ctx.owner.token,
    );
  const confirmations = await Promise.all([confirm(), confirm()]);
  for (const response of confirmations) {
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ id: quote.id, status: "queued", error: null });
  }
  expect(ctx.mutations()).toBe(0);
  expect(await processPlanChange(ctx.db, ctx.billing, ctx.policy)).toBe(true);
  expect(await processPlanChange(ctx.db, ctx.billing, ctx.policy)).toBe(false);
  expect(ctx.mutations()).toBe(1);
  const applied = await request(ctx.target, receiptPath, "GET", undefined, ctx.owner.token);
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({ id: quote.id, status: "applied", error: null });
  const repeated = await confirm();
  expect(repeated.status).toBe(202);
  expect(await repeated.json()).toMatchObject({ id: quote.id, status: "applied", error: null });
  expect(ctx.mutations()).toBe(1);
});

test("subscription HTTP confirmation requires a fresh session without queuing a payment", async () => {
  const ctx = await subscriptionApp();
  await ctx.db.sql`UPDATE auth_session SET created_at=now()-interval '11 minutes'
    WHERE user_id=${ctx.owner.id}`;
  const preview = await request(
    ctx.target,
    "/v1/billing/subscription/preview",
    "POST",
    { plan: "max", interval: "monthly" },
    ctx.owner.token,
  );
  expect(preview.status).toBe(200);
  const quote = await preview.json();
  const confirmation = await request(
    ctx.target,
    "/v1/billing/subscription/change",
    "POST",
    { quote_id: quote.id },
    ctx.owner.token,
  );
  expect(confirmation.status).toBe(401);
  expect(await confirmation.json()).toEqual({
    error: { code: "reauthentication_required" },
    request_id: null,
  });
  const receipt = await request(
    ctx.target,
    `/v1/billing/subscription/changes/${quote.id}`,
    "GET",
    undefined,
    ctx.owner.token,
  );
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toMatchObject({ status: "quoted", error: null });
  expect(await processPlanChange(ctx.db, ctx.billing, ctx.policy)).toBe(false);
  expect(ctx.mutations()).toBe(0);
});

test("subscription HTTP routes reject unauthenticated, malformed and unknown quote requests", async () => {
  const ctx = await subscriptionApp();
  const unauthorized = await request(ctx.target, "/v1/billing/subscription/preview", "POST", {
    plan: "max",
    interval: "monthly",
  });
  expect(unauthorized.status).toBe(401);
  const malformed = [
    await request(
      ctx.target,
      "/v1/billing/subscription/preview",
      "POST",
      { plan: "max", interval: "week" },
      ctx.owner.token,
    ),
    await request(
      ctx.target,
      "/v1/billing/subscription/preview",
      "POST",
      { plan: "max", interval: "monthly", product_id: productId },
      ctx.owner.token,
    ),
    await request(
      ctx.target,
      "/v1/billing/subscription/change",
      "POST",
      { quote_id: "not-a-uuid" },
      ctx.owner.token,
    ),
    await request(
      ctx.target,
      "/v1/billing/subscription/change",
      "POST",
      { quote_id: crypto.randomUUID(), plan: "max" },
      ctx.owner.token,
    ),
    await request(
      ctx.target,
      "/v1/billing/subscription/changes/not-a-uuid",
      "GET",
      undefined,
      ctx.owner.token,
    ),
    await ctx.target.request("http://localhost:3000/v1/billing/subscription/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.owner.token}` },
      body: "{",
    }),
  ];
  for (const response of malformed) {
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" }, request_id: null });
  }
  const unknown = crypto.randomUUID();
  for (const response of [
    await request(
      ctx.target,
      `/v1/billing/subscription/changes/${unknown}`,
      "GET",
      undefined,
      ctx.owner.token,
    ),
    await request(
      ctx.target,
      "/v1/billing/subscription/change",
      "POST",
      { quote_id: unknown },
      ctx.owner.token,
    ),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "plan_change_not_found" },
      request_id: null,
    });
  }
  expect(
    await ctx.db.sql`SELECT id FROM billing_plan_change WHERE user_id=${ctx.owner.id}`,
  ).toHaveLength(0);
  expect(ctx.mutations()).toBe(0);
});

test("public client config is unauthenticated, cacheable, and independent of database availability", async () => {
  const config = {
    ...fixture.config,
    CLIENT_MIN_VERSION: "1.0.0-beta.2",
    CLIENT_NOTICE_ID: "desktop-notice",
    CLIENT_NOTICE_TEXT: "Service notice",
    CLOUD_OPENAI_KEY: "private-test-key",
  };
  const unavailableDb = new Proxy({} as Database, {
    get() {
      throw new Error("Database was accessed");
    },
  });
  const target = createApp(
    config,
    unavailableDb,
    createAuth(config, fixture.db, mailer),
    provider,
    () => "198.51.100.12",
    undefined,
    mailer,
  );
  const first = await request(target, "/v1/client-config");
  expect(first.status).toBe(200);
  expect(first.headers.get("Cache-Control")).toContain("public");
  const etag = first.headers.get("ETag");
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  const raw = await first.text();
  expect(raw).not.toContain("private-test-key");
  expect(raw).not.toContain(fixture.config.DATABASE_URL);
  expect(JSON.parse(raw)).toMatchObject({
    schema_version: 1,
    min_client_version: "1.0.0-beta.2",
    signup_open: true,
    billing_enabled: false,
    notice: { id: "desktop-notice", text: "Service notice" },
  });
  const cached = await request(target, "/v1/client-config", "GET", undefined, undefined, {
    "If-None-Match": etag as string,
  });
  expect(cached.status).toBe(304);
  expect(await cached.text()).toBe("");
});

test("billing disabled exposes no offers and rejects portal and checkout", async () => {
  const target = app();
  const user = await login(target);
  const before = { ...calls };
  const result = await request(target, "/v1/billing", "GET", undefined, user.token);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    offers: null,
    paid: false,
    subscription: { status: "not_applicable" },
  });
  expect((await request(target, "/v1/billing/portal", "POST", {}, user.token)).status).toBe(503);
  expect(
    (await request(target, "/v1/billing/checkout", "POST", { topup: "test-topup" }, user.token))
      .status,
  ).toBe(503);
  expect(calls).toEqual(before);
});

test("account export matches disabled billing with enabled cloud without provider calls", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  let providerCalls = 0;
  const unavailable = async () => {
    providerCalls++;
    throw new Error("Injected provider outage");
  };
  const cloud = createCloudService(fixture.db, policy, transport, fixture.config.ABUSE_SECRET);
  const target = createApp(
    fixture.config,
    fixture.db,
    createAuth(fixture.config, fixture.db, mailer),
    { ...provider, state: unavailable, productOffer: unavailable },
    () => "198.51.100.12",
    cloud,
    mailer,
  );
  const owner = await login(target);
  await fixture.db.sql`UPDATE billing_customer SET provider_touched=true,status='active',
    paid_until=now()+interval '1 day',reconciled_at=now() WHERE user_id=${owner.id}`;
  const billing = await request(target, "/v1/billing", "GET", undefined, owner.token);
  expect(billing.status).toBe(200);
  const { offers, ...summary } = await billing.json();
  expect(offers).toBeNull();
  expect(structuredClone(summary)).toMatchObject({
    subscription: { status: "not_applicable" },
    paid: false,
    capabilities: { hostedAI: true, synchronization: false },
  });
  const exported = await request(target, "/v1/account/export", "GET", undefined, owner.token);
  expect(exported.status).toBe(200);
  expect((await exported.json()).billing).toEqual(summary);
  expect(providerCalls).toBe(0);
});

test("account export remains available during product-provider failure and wallet review", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const config = { ...fixture.config, BILLING_ENABLED: "true" as const };
  let providerCalls = 0;
  const unavailable = async () => {
    providerCalls++;
    throw new Error("Injected provider outage");
  };
  const cloud = createCloudService(fixture.db, policy, transport, config.ABUSE_SECRET);
  const target = createApp(
    config,
    fixture.db,
    createAuth(config, fixture.db, mailer),
    { ...provider, state: unavailable, productOffer: unavailable },
    () => "198.51.100.12",
    cloud,
    mailer,
  );
  const owner = await login(target);
  await fixture.db.sql`INSERT INTO credit_wallet(user_id,suspended) VALUES (${owner.id},true)`;
  const billing = await request(target, "/v1/billing", "GET", undefined, owner.token);
  expect(billing.status).toBe(503);
  expect(await billing.json()).toEqual({
    error: { code: "billing_unavailable" },
    request_id: null,
  });
  expect(providerCalls).toBe(1);
  const usage = await request(target, "/v1/usage", "GET", undefined, owner.token);
  expect(usage.status).toBe(403);
  expect(await usage.json()).toEqual({
    error: { code: "billing_review_required" },
    request_id: null,
  });
  const exported = await request(target, "/v1/account/export", "GET", undefined, owner.token);
  expect(exported.status).toBe(200);
  const body = await exported.json();
  expect(body.billing).toMatchObject({
    subscription: { status: "inactive" },
    paid: false,
    capabilities: { hostedAI: true },
  });
  expect(body.billing).not.toHaveProperty("offers");
  expect(body.usage).toMatchObject({ plan: "free", purchased_remaining: "0" });
  expect(providerCalls).toBe(1);
});

test("desktop checkout and refresh grant paid top-up only to its owner", async () => {
  const policy = testPolicy();
  await registerPolicy(fixture.db, policy);
  const config = { ...fixture.config, BILLING_ENABLED: "true" as const };
  const cloud = createCloudService(fixture.db, policy, transport, config.ABUSE_SECRET);
  const target = app(config, cloud);
  const owner = await login(target);
  const other = await login(target);
  const beforeProduct = calls.product;
  const offers = await request(target, "/v1/billing", "GET", undefined, owner.token);
  expect(offers.status).toBe(200);
  expect(await offers.json()).toMatchObject({
    offers: {
      topups: [
        {
          id: "test-topup",
          product_name: "Desktop credits",
          price: { amount_minor: 500, currency: "USD" },
        },
      ],
    },
  });
  expect(calls.product).toBeGreaterThan(beforeProduct);
  const noCustomer = await request(target, "/v1/billing/portal", "POST", {}, owner.token);
  expect(noCustomer.status).toBe(409);
  expect((await noCustomer.json()).error.code).toBe("no_billing_account");
  const checkout = await request(
    target,
    "/v1/billing/checkout",
    "POST",
    { topup: "test-topup" },
    owner.token,
  );
  expect(checkout.status).toBe(200);
  expect(await checkout.json()).toEqual({ url: "https://sandbox.polar.sh/checkout/desktop" });
  const [binding] = await fixture.db
    .sql`SELECT user_id,product_id,policy_revision FROM billing_checkout WHERE checkout_id=${checkoutId}`;
  expect(binding).toMatchObject({
    user_id: owner.id,
    product_id: productId,
    policy_revision: policy.revision,
  });
  const refreshed = await request(target, "/v1/billing/refresh", "POST", {}, owner.token);
  expect(refreshed.status).toBe(200);
  const grants = await fixture.db
    .sql`SELECT user_id,amount FROM credit_grant WHERE grant_key='polar-order:desktop-paid-order'`;
  expect(grants.length).toBe(1);
  expect(grants[0]).toMatchObject({ user_id: owner.id });
  expect(String(grants[0]?.amount)).toBe("30");
  expect((await request(target, "/v1/billing/refresh", "POST", {}, other.token)).status).toBe(200);
  expect(
    (await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${other.id} AND kind='topup'`)
      .length,
  ).toBe(0);
});

test("authenticated accounts behind one NAT do not share the auth IP cap", async () => {
  const target = app();
  const first = await login(target);
  const second = await login(target);
  for (let i = 0; i < 121; i++) {
    const user = i % 2 === 0 ? first : second;
    const response = await request(target, "/v1/account", "GET", undefined, user.token);
    expect(response.status).toBe(200);
  }
});

test("self-hosted plan shows configured models without Polar or private keys in responses", async () => {
  const prior = testPolicy();
  const free = prior.plans[0];
  const model = prior.models[0];
  if (!free || !model) throw new Error("Test policy is incomplete");
  const selfPlan = { ...free, id: "self", rank: 2 };
  const policy = testPolicy({
    plans: [free, selfPlan],
    selfHostedPlan: "self",
    models: [{ ...model, plans: ["free", "self"] }],
    defaults: { self: { lead: model.id, page: null, light: null, decision: null } },
  });
  await registerPolicy(fixture.db, policy);
  const config = {
    ...fixture.config,
    DEPLOYMENT_MODE: "self_hosted" as const,
    CLOUD_OPENAI_KEY: "private-selfhost-key",
  };
  const target = app(
    config,
    createCloudService(fixture.db, policy, transport, config.ABUSE_SECRET),
  );
  const user = await login(target);
  const models = await request(target, "/v1/models", "GET", undefined, user.token);
  expect(models.status).toBe(200);
  const raw = await models.text();
  expect(raw).not.toContain("private-selfhost-key");
  expect(JSON.parse(raw)).toMatchObject({ cloud_enabled: true, models: [{ id: model.id }] });
  const billing = await request(target, "/v1/billing", "GET", undefined, user.token);
  expect(await billing.json()).toMatchObject({
    offers: null,
    subscription: { status: "not_applicable" },
    paid: false,
  });
});

test("verified account email change durably queues billing contact sync and revokes sessions", async () => {
  const target = app();
  const user = await login(target);
  const email = `${crypto.randomUUID()}@example.test`;
  await fixture.db.sql`UPDATE billing_customer SET provider_touched=true,attempts=4,
    next_attempt=now()+interval '1 day' WHERE user_id=${user.id}`;
  const [before] = await fixture.db
    .sql`SELECT requested FROM billing_customer WHERE user_id=${user.id}`;
  expect(
    (await request(target, "/v1/account/email/code", "POST", { email }, user.token)).status,
  ).toBe(202);
  const otp = codes.get(email);
  expect(otp).toMatch(/^\d{6}$/);
  const result = await request(target, "/v1/account/email", "PATCH", { email, otp }, user.token);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ updated: true, reauthentication_required: true });
  const [account] = await fixture.db.sql`SELECT email FROM auth_user WHERE id=${user.id}`;
  const [billing] = await fixture.db
    .sql`SELECT requested,attempts,provider_touched FROM billing_customer WHERE user_id=${user.id}`;
  const [contact] = await fixture.db
    .sql`SELECT requested,processed,attempts,next_attempt<=clock_timestamp() AS due FROM billing_contact_job WHERE user_id=${user.id}`;
  expect(account?.email).toBe(email);
  expect(billing).toMatchObject({
    requested: Number(before?.requested),
    attempts: 4,
    provider_touched: true,
  });
  expect(contact).toMatchObject({ requested: 1, processed: 0, attempts: 0, due: true });
  expect(await fixture.db.sql`SELECT id FROM auth_session WHERE user_id=${user.id}`).toHaveLength(
    0,
  );
  expect((await request(target, "/v1/account", "GET", undefined, user.token)).status).toBe(401);
});
