import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCloudService } from "../../src/modules/ai/service";
import type { CloudTransport } from "../../src/modules/ai/transport";
import { registerPolicy } from "../../src/modules/policy/policy";
import { createCloudAccount, testPolicy } from "../support/cloud-fixture";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});
function required<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("Missing fixture");
  return v;
}
async function setup(
  options: {
    budget?: string;
    daily?: string;
    count?: CloudTransport["count"];
    provider?: "openai" | "anthropic" | "google";
  } = {},
) {
  const base = testPolicy();
  const provider = options.provider ?? "openai";
  const m = {
    ...required(base.models[0]),
    provider,
    contextWindow: 1_000_000,
    maxOutput: 4096,
    maxRequestBytes: 8192,
    maxSearchCalls: 0,
    supports: { ...required(base.models[0]).supports, vision: true, nativeSearch: false },
    rates: {
      input: "4000000",
      cachedInput: "200000",
      cacheWrite5m: "5000000",
      cacheWrite1h: "8000000",
      output: "20000000",
      searchCall: "20000",
    },
    costRates: {
      input: "2000000",
      cachedInput: "100000",
      cacheWrite5m: "2500000",
      cacheWrite1h: "4000000",
      output: "10000000",
      searchCall: "10000",
    },
  };
  const p = testPolicy({
    models: [m],
    welcomeUnits: "0",
    plans: [
      {
        ...required(base.plans[0]),
        allowanceUnits: "2500000",
        cycle: { kind: "once" },
        dailyLimitUnits: options.daily ?? null,
      },
    ],
    limits: {
      ...base.limits,
      providers: {
        ...base.limits.providers,
        [provider]: { requestsPerMinute: 1000, tokensPerSecond: 10_000_000 },
      },
      budgets: {
        scope: "image-reservation-tests",
        dailyUsdMicros: options.budget ?? "20000000",
        totalUsdMicros: null,
        freeDailyUsdMicros: "20000000",
      },
    },
  });
  await registerPolicy(fixture.db, p);
  const owner = await createCloudAccount(fixture.db);
  let generated = 0,
    counted = 0,
    heldAtDispatch = 0n,
    providerAtDispatch = 0n;
  const transport: CloudTransport = {
    available: () => true,
    count: async (...args) => {
      counted++;
      return options.count ? options.count(...args) : 2000;
    },
    generate: async () => {
      generated++;
      const [r] = await fixture.db
        .sql`SELECT r.reserved,c.reserved AS exposure FROM cloud_request r JOIN cloud_cost_record c ON c.request_id=r.id WHERE r.user_id=${owner.userId} AND r.state='running'`;
      heldAtDispatch = BigInt(r?.reserved ?? 0);
      providerAtDispatch = BigInt(r?.exposure ?? 0);
      if (provider === "anthropic")
        return Response.json({
          type: "message",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 500,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [],
        });
      if (provider === "google")
        return new Response(
          `data: ${JSON.stringify({
            candidates: [{ finishReason: "STOP", content: { parts: [] } }],
            usageMetadata: {
              promptTokenCount: 500,
              candidatesTokenCount: 100,
              totalTokenCount: 600,
              cachedContentTokenCount: 0,
            },
          })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      return Response.json({
        status: "completed",
        usage: { input_tokens: 500, output_tokens: 100 },
        output: [],
      });
    },
  };
  const service = createCloudService(fixture.db, p, transport, fixture.config.ABUSE_SECRET);
  const content = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" };
  const body =
    provider === "openai"
      ? {
          model: m.id,
          input: [{ role: "user", content: [content] }],
          max_output_tokens: 100,
          stream: false,
        }
      : provider === "anthropic"
        ? {
            model: m.id,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                  },
                ],
              },
            ],
            max_tokens: 100,
            stream: false,
          }
        : {
            contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] }],
            generationConfig: { maxOutputTokens: 100 },
          };
  const call = () =>
    service.generate(
      provider,
      new Request("http://localhost/test", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      }),
      owner,
      provider === "google" ? m.id : undefined,
    );
  const state = () => ({ generated, counted, heldAtDispatch, providerAtDispatch });
  return { call, state, owner, p, service };
}

test("all native image providers admit a 250-credit account while retaining full provider exposure", async () => {
  for (const provider of ["openai", "anthropic", "google"] as const) {
    const c = await setup({ provider });
    const response = await c.call();
    await response.text();
    expect(response.status).toBe(200);
    expect(c.state().counted).toBe(1);
    expect(c.state().generated).toBe(1);
    expect(c.state().heldAtDispatch).toBeLessThan(100_000n);
    expect(c.state().providerAtDispatch).toBeGreaterThanOrEqual(4_001_000n);
    const [r] = await fixture.db
      .sql`SELECT r.state,r.charged,c.exposure,c.terminal FROM cloud_request r JOIN cloud_cost_record c ON c.request_id=r.id WHERE r.user_id=${c.owner.userId}`;
    expect(r?.state).toBe("settled");
    expect(BigInt(r?.charged)).toBe(4000n);
    expect(BigInt(r?.exposure)).toBe(2000n);
    expect(r?.terminal).toBe(true);
    const [g] = await fixture.db
      .sql`SELECT sum(held)::text held,sum(spent)::text spent FROM credit_grant WHERE user_id=${c.owner.userId}`;
    expect(g).toMatchObject({ held: "0", spent: "4000" });
  }
});

test("a small counted customer hold cannot bypass the unchanged provider budget", async () => {
  const c = await setup({ budget: "100000" });
  const r = await c.call();
  expect(r.status).toBe(503);
  expect((await r.json()).error.code).toBe("cloud_budget_exhausted");
  expect(c.state().generated).toBe(0);
  const [g] = await fixture.db
    .sql`SELECT sum(held)::text held,sum(spent)::text spent FROM credit_grant WHERE user_id=${c.owner.userId}`;
  expect(g).toMatchObject({ held: "0", spent: "0" });
  const [n] = await fixture.db
    .sql`SELECT count(*)::integer n FROM cloud_cost_record c JOIN cloud_request r ON r.id=c.request_id WHERE r.user_id=${c.owner.userId}`;
  expect(n?.n).toBe(0);
});

test("customer daily caps remain atomic and block dispatch after successful counting", async () => {
  const c = await setup({ daily: "1000" });
  const r = await c.call();
  expect(r.status).toBe(402);
  expect((await r.json()).error.code).toBe("daily_limit_reached");
  expect(c.state().generated).toBe(0);
  const [g] = await fixture.db
    .sql`SELECT sum(held)::text held FROM credit_grant WHERE user_id=${c.owner.userId}`;
  expect(g?.held).toBe("0");
});

test("failed native count cannot dispatch or leave customer/provider holds", async () => {
  const c = await setup({
    count: async () => {
      throw new Error("private detail");
    },
  });
  const r = await c.call();
  expect(r.status).toBe(503);
  expect(r.headers.get("Retry-After")).toBe("30");
  expect((await r.json()).error.code).toBe("token_count_unavailable");
  expect(c.state().generated).toBe(0);
  const [row] = await fixture.db
    .sql`SELECT state,reserved::text,charged::text,dispatched_at FROM cloud_request WHERE user_id=${c.owner.userId}`;
  expect(row).toMatchObject({
    state: "released",
    reserved: "0",
    charged: "0",
    dispatched_at: null,
  });
});

test("revoking a session during counting prevents dispatch", async () => {
  let revoke = async () => {};
  const c = await setup({
    count: async () => {
      await revoke();
      return 2000;
    },
  });
  revoke = async () => {
    await fixture.db.sql`DELETE FROM auth_session WHERE id=${c.owner.sessionId}`;
  };
  const r = await c.call();
  expect(r.status).toBe(401);
  expect(c.state().generated).toBe(0);
});
