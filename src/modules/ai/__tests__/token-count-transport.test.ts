import { expect, test } from "bun:test";
import { testPolicy } from "../../../../tests/support/cloud-fixture";
import { prepareRequest } from "../protocol";
import { type FetchRequest, nativeTransport } from "../transport";

const template = testPolicy().models[0];
if (!template) throw new Error("Missing fixture");
const model = { ...template, supports: { ...template.supports, tools: true, vision: true } };
const image = "data:image/png;base64,aGVsbG8=";

test("native counters receive full prompts, images, schemas and model-specific endpoints", async () => {
  for (const provider of ["openai", "anthropic", "google"] as const) {
    const m = { ...model, provider };
    const input =
      provider === "openai"
        ? {
            instructions: "system",
            input: [{ role: "user", content: [{ type: "input_image", image_url: image }] }],
            tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
            text: { format: { type: "json_object" } },
          }
        : provider === "anthropic"
          ? {
              system: "system",
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
              tools: [
                { name: "read", input_schema: { type: "object" } },
                { type: "web_search_20250305", name: "web_search", max_uses: 1 },
              ],
            }
          : {
              systemInstruction: { parts: [{ text: "system" }] },
              contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] }],
              tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "object" } }] }],
            };
    const prepared = prepareRequest(m, input, "owner", "secret");
    let url = "",
      sent: Record<string, unknown> = {};
    const fake = (async (u: unknown, options: RequestInit) => {
      url = String(u);
      sent = JSON.parse(String(options.body));
      expect(options.redirect).toBe("error");
      return Response.json(provider === "google" ? { totalTokens: 1234 } : { input_tokens: 1234 });
    }) as FetchRequest;
    const transport = nativeTransport({ [provider]: "synthetic-test-key" }, fake);
    expect(await transport.count(m, prepared, new AbortController().signal)).toBe(1234);
    if (provider === "openai") {
      expect(url).toBe("https://api.openai.com/v1/responses/input_tokens");
      expect(sent.input).toEqual(prepared.body.input);
      expect(sent.tools).toEqual(prepared.body.tools);
      expect(sent.text).toEqual(prepared.body.text);
      expect(sent.instructions).toBe("system");
    } else if (provider === "anthropic") {
      expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
      expect(sent.messages).toEqual(prepared.body.messages);
      expect(sent.system).toBe("system");
      expect(sent.tools).toEqual([{ name: "read", input_schema: { type: "object" } }]);
    } else {
      expect(url).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${m.upstreamModel}:countTokens`,
      );
      expect(sent.generateContentRequest).toEqual({
        model: `models/${m.upstreamModel}`,
        ...prepared.body,
      });
    }
  }
});

test("count responses are bounded and invalid payloads fail closed", async () => {
  const prepared = prepareRequest(model, { input: "test" }, "owner", "secret");
  for (const payload of [
    null,
    [],
    { input_tokens: "100" },
    { input_tokens: -1 },
    { input_tokens: 0.5 },
    { input_tokens: 100001 },
  ]) {
    const transport = nativeTransport({ openai: "synthetic" }, (async () =>
      Response.json(payload)) as FetchRequest);
    await expect(transport.count(model, prepared, new AbortController().signal)).rejects.toThrow();
  }
  const oversized = nativeTransport(
    { openai: "synthetic" },
    (async () => new Response("x".repeat(65537))) as FetchRequest,
  );
  await expect(
    oversized.count(model, prepared, new AbortController().signal),
  ).rejects.toMatchObject({ code: "provider_response_limit" });
  const valid = nativeTransport({ openai: "synthetic" }, (async () =>
    Response.json({ input_tokens: 0 })) as FetchRequest);
  expect(await valid.count(model, prepared, new AbortController().signal)).toBe(0);
});

test("counting respects upstream retry delay without exposing provider bodies", async () => {
  const prepared = prepareRequest(model, { input: "test" }, "owner", "secret");
  for (const [status, code, expectedStatus] of [
    [429, "provider_rate_limited", 429],
    [500, "token_count_unavailable", 503],
    [401, "token_count_unavailable", 503],
    [400, "provider_rejected", 400],
  ] as const) {
    const transport = nativeTransport(
      { openai: "synthetic" },
      (async () =>
        new Response("secret upstream detail", {
          status,
          headers: { "Retry-After": "42" },
        })) as FetchRequest,
    );
    await expect(
      transport.count(model, prepared, new AbortController().signal),
    ).rejects.toMatchObject({
      code,
      status: expectedStatus,
      ...(status === 400 ? {} : { retryAfter: 42 }),
    });
  }
});
