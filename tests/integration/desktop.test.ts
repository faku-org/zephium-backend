import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "../../src/apps/api/app";
import { createCloudService } from "../../src/modules/ai/service";
import type { CloudTransport } from "../../src/modules/ai/transport";
import type { BillingProvider } from "../../src/modules/billing/provider";
import { createAuth, type Mailer } from "../../src/modules/identity/auth";
import { registerPolicy } from "../../src/modules/policy/policy";
import type { Config } from "../../src/platform/config";
import type { Database } from "../../src/platform/db";
import { testPolicy } from "../support/cloud-fixture";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
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
}, 30000);
afterAll(async () => {
  await fixture.close();
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

test("public client config is unauthenticated, cacheable, and independent of database availability", async () => {
  const config = {
    ...fixture.config,
    CLIENT_MIN_VERSION: "2.3.4",
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
    min_client_version: "2.3.4",
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
