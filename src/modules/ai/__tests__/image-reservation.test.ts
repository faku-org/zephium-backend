import { expect, test } from "bun:test";
import { testPolicy } from "../../../../tests/support/cloud-fixture";
import { AppError } from "../../../platform/errors";
import { customerInputTokens } from "../image-reservation";
import { prepareRequest } from "../protocol";
import { reserveInput } from "../reservation";
import type { CloudTransport } from "../transport";

const template = testPolicy().models[0];
if (!template) throw new Error("Missing model fixture");
const model = {
  ...template,
  contextWindow: 1_000_000,
  supports: { ...template.supports, vision: true },
};
const image = {
  input: [
    {
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }],
    },
  ],
  max_output_tokens: 100,
};
const prepared = prepareRequest(model, image, "test", "test");
const bound = reserveInput(model, prepared);
const transport = (count: CloudTransport["count"]): CloudTransport => ({
  available: () => true,
  count,
  generate: async () => {
    throw new Error("not called");
  },
});

test("provider image count refines customer escrow without changing original exposure or search bounds", async () => {
  const before = structuredClone(bound);
  expect(
    await customerInputTokens(
      model,
      prepared,
      bound,
      transport(async () => 2000),
      new AbortController().signal,
    ),
  ).toBe(10192);
  expect(bound).toEqual(before);
  expect(bound.inputTokens).toBe(1_000_000);
  const search = prepareRequest(
    model,
    { ...image, tools: [{ type: "web_search" }], max_tool_calls: 2 },
    "test",
    "test",
  );
  const searchBound = reserveInput(model, search);
  expect(searchBound.searchInputTokens).toBe(2_000_000);
  await customerInputTokens(
    model,
    search,
    searchBound,
    transport(async () => 2000),
    new AbortController().signal,
  );
  expect(searchBound.searchInputTokens).toBe(2_000_000);
});

test("text requests and unsupported image counters retain local/full estimates without a network call", async () => {
  const text = prepareRequest(model, { input: "hello" }, "test", "test");
  const local = reserveInput(model, text);
  const noCount = transport(async () => {
    throw new Error("unexpected count");
  });
  expect(await customerInputTokens(model, text, local, noCount, new AbortController().signal)).toBe(
    local.inputTokens,
  );
  const router = { ...model, provider: "openrouter" as const };
  const r = prepareRequest(
    router,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
        },
      ],
    },
    "test",
    "test",
  );
  expect(
    await customerInputTokens(
      router,
      r,
      reserveInput(router, r),
      noCount,
      new AbortController().signal,
    ),
  ).toBe(router.contextWindow);
});

test("invalid count results and over-context requests never become a small reservation", async () => {
  for (const count of [-1, NaN, Infinity, 1.5, 1_000_001])
    await expect(
      customerInputTokens(
        model,
        prepared,
        bound,
        transport(async () => count),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  await expect(
    customerInputTokens(
      model,
      prepared,
      bound,
      transport(async () => 999_999),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "context_limit_exceeded" });
});

test("Google response schema bytes supplement native counts instead of being omitted", async () => {
  const google = { ...model, provider: "google" as const };
  const p = prepareRequest(
    google,
    {
      contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] }],
      generationConfig: {
        maxOutputTokens: 100,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { value: { type: "string", description: "x".repeat(1000) } },
        },
      },
    },
    "test",
    "test",
  );
  const b = reserveInput(google, p);
  const result = await customerInputTokens(
    google,
    p,
    b,
    transport(async () => 2000),
    new AbortController().signal,
  );
  expect(result).toBe(
    10192 + new TextEncoder().encode(JSON.stringify(p.body.generationConfig)).length * 2,
  );
});

test("count failure is retryable and does not expose the provider error", async () => {
  await expect(
    customerInputTokens(
      model,
      prepared,
      bound,
      transport(async () => {
        throw new Error("sensitive upstream detail");
      }),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "token_count_unavailable", status: 503, retryAfter: 30 });
  await expect(
    customerInputTokens(
      model,
      prepared,
      bound,
      transport(async () => {
        throw new AppError("provider_rate_limited", 429, 42);
      }),
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "provider_rate_limited", status: 429, retryAfter: 42 });
});

test("image counting has a five-second deadline and aborts its transport", async () => {
  let aborted = false;
  const stalled = transport(
    async (_m, _r, signal) =>
      new Promise<number>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  await expect(
    customerInputTokens(model, prepared, bound, stalled, new AbortController().signal),
  ).rejects.toMatchObject({ code: "token_count_unavailable", status: 503 });
  expect(aborted).toBe(true);
}, 6500);
