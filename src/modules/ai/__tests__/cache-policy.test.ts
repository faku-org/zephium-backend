import { expect, test } from "bun:test";
import { testPolicy } from "../../../../tests/support/cloud-fixture";
import { prepareRequest } from "../protocol";

const fixtureModel = testPolicy().models[0];
if (!fixtureModel) throw new Error("Missing model fixture");
const model = { ...fixtureModel, provider: "openai" as const };
const prepare = (body: Record<string, unknown>) =>
  prepareRequest(model, { input: "test", ...body }, "test-user", "test-secret");
test("OpenAI extended cache lifetimes are rejected at request and content levels", () => {
  for (const body of [
    { prompt_cache_options: { ttl: "12h" } },
    { prompt_cache_retention: "24h" },
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "test", prompt_cache_breakpoint: { ttl: "12h" } }],
        },
      ],
    },
  ])
    expect(() => prepare(body)).toThrow("extended_cache_not_supported");
});
test("OpenAI default and 30-minute cache policies remain admitted", () => {
  expect(prepare({}).body.store).toBe(false);
  expect(prepare({ prompt_cache_options: { ttl: "30m" } }).body.prompt_cache_options).toEqual({
    ttl: "30m",
  });
});
