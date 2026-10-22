import { afterAll, beforeAll, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { createCloudAccount, testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { createApp } from "../../../apps/api/app";
import { createApiServer } from "../../../apps/api/server";
import { markIncomingStart } from "../../../platform/incoming-body";
import type { BillingProvider } from "../../billing/provider";
import { audioHoldCost, charge, emptyUsage } from "../../credits/pricing";
import type { Auth } from "../../identity/auth";
import { policySchema, registerPolicy } from "../../policy/policy";
import {
  audioDeadlineMs,
  audioRequestBytes,
  audioResponseBytes,
  audioRoute,
  inspectWav,
  prepareAudio,
  transcriptionUsage,
} from "../audio";
import { createCloudService } from "../service";
import { type CloudTransport, nativeTransport } from "../transport";

function wav(frames = 8000, sampleRate = 8000): Uint8Array {
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  return data;
}
function multipart(bytes: Uint8Array = wav(), fields: Record<string, string> = {}): FormData {
  const body = new FormData();
  body.set("model", "voice");
  body.set("response_format", "json");
  body.set(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
    "private-recording.wav",
  );
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}
function request(body: FormData = multipart(), key = crypto.randomUUID()): Request {
  return new Request(`http://localhost${audioRoute}`, {
    method: "POST",
    headers: { Authorization: "Bearer test", "Idempotency-Key": key },
    body,
  });
}
const tokenUsage = {
  type: "tokens",
  input_tokens: 12,
  output_tokens: 3,
  total_tokens: 15,
  input_token_details: { audio_tokens: 10, text_tokens: 2 },
};
function success(text = "transcribed", usage: unknown = tokenUsage): Response {
  return Response.json(
    { text, ...(usage === undefined ? {} : { usage }) },
    { headers: { "x-request-id": "provider-audio" } },
  );
}
const base = testPolicy();
const original = base.models[0];
if (!original) throw new Error("Missing test model");
const audioModel = {
  ...original,
  id: "voice",
  upstreamModel: "gpt-4o-mini-transcribe",
  roles: ["transcribe" as const],
  recommendedRoles: ["transcribe" as const],
  contextWindow: 16000,
  maxOutput: 2000,
  maxRequestBytes: audioRequestBytes,
  // Success cases also use this model; allow CI scheduling/DB latency without
  // accidentally exercising timeout paths. Deadline tests below keep the ratio.
  maxDurationMs: 5000,
  idleTimeoutMs: 1000,
  maxSearchCalls: 0,
  supports: {
    tools: false,
    vision: false,
    promptCache: false,
    reasoning: false,
    nativeSearch: false,
  },
  rates: { ...original.rates, audioInput: "2000000", audioMinute: "6000" },
  costRates: { ...original.rates, audioInput: "1000000", audioMinute: "3000" },
};
const plan = base.plans[0];
if (!plan) throw new Error("Missing test plan");
const policy = testPolicy({
  welcomeUnits: "100000000",
  plans: [{ ...plan, allowanceUnits: "100000000" }],
  models: [audioModel, original],
  limits: {
    ...base.limits,
    unconfirmedRequestsPerUserDay: 100,
    providers: {
      ...base.limits.providers,
      openai: { requestsPerMinute: 1000, tokensPerSecond: 10000000 },
    },
  },
});
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let identity: Awaited<ReturnType<typeof createCloudAccount>>;
let service: ReturnType<typeof createCloudService>;
let calls = 0;
let dispatch: NonNullable<CloudTransport["transcribe"]> = async () => success();
const transport: CloudTransport = {
  available: () => true,
  count: async () => 0,
  generate: async () => {
    throw new Error("Audio must not call text transport");
  },
  transcribe: async (...args) => {
    calls++;
    return dispatch(...args);
  },
};
beforeAll(async () => {
  fixture = await testDatabase();
  await registerPolicy(fixture.db, policy);
  identity = await createCloudAccount(fixture.db);
  service = createCloudService(fixture.db, policy, transport, fixture.config.ABUSE_SECRET);
}, 30000);
afterAll(async () => {
  await service?.shutdown();
  await fixture?.close();
});
async function receipt(response: Response) {
  const id = response.headers.get("X-Zephium-Request-Id");
  expect(id).not.toBeNull();
  const [row] = await fixture.db
    .sql`SELECT state,charged::text,usage,error_class FROM cloud_request WHERE id=${id}`;
  return row;
}

test("WAV duration uses PCM frames and accepts lower device sample rates", () => {
  expect(inspectWav(wav())).toEqual({ milliseconds: 1000, sampleRate: 8000, frames: 8000 });
  expect(inspectWav(wav(16000 * 240, 16000)).milliseconds).toBe(240000);
  expect(() => inspectWav(wav(8000 * 240 + 1))).toThrow("audio_too_long");
  for (const mutate of [
    (v: Buffer) => v.writeUInt16LE(2, 22),
    (v: Buffer) => v.writeUInt16LE(3, 20),
    (v: Buffer) => v.writeUInt16LE(8, 34),
    (v: Buffer) => v.writeUInt32LE(48000, 24),
  ]) {
    const data = Buffer.from(wav());
    mutate(data);
    expect(() => inspectWav(data)).toThrow("unsupported_audio_format");
  }
  const invalid = Buffer.from(wav());
  invalid.writeUInt32LE(1, 28);
  expect(() => inspectWav(invalid)).toThrow("invalid_audio");
  expect(() => inspectWav(wav().subarray(0, 43))).toThrow("invalid_audio");
  expect(() => inspectWav(wav(0))).toThrow("invalid_audio");
  expect(() => inspectWav(new TextEncoder().encode("not audio"))).toThrow(
    "unsupported_audio_format",
  );
});

test("multipart rejects duplicate/unsupported fields, non-ISO language, text models and multipart caps", async () => {
  const invalidFields: Record<string, string>[] = [
    { prompt: "private" },
    { stream: "true" },
    { language: "zz" },
    { language: "eng" },
    { response_format: "text" },
    { model: original.id },
    { model: audioModel.upstreamModel },
  ];
  for (const fields of invalidFields)
    await expect(
      prepareAudio(request(multipart(wav(), fields)), policy, 1000),
    ).rejects.toMatchObject({ status: fields.model ? 403 : 400 });
  const repeated = multipart();
  repeated.append("file", new Blob([new Uint8Array(wav())]), "second.wav");
  await expect(prepareAudio(request(repeated), policy, 1000)).rejects.toMatchObject({
    code: "invalid_request",
  });
  const tooLarge = multipart();
  tooLarge.set("file", new Blob([new Uint8Array(audioRequestBytes)]), "large.wav");
  await expect(prepareAudio(request(tooLarge), policy, 1000)).rejects.toMatchObject({
    code: "body_too_large",
    status: 413,
  });
  const smallPolicy = { ...policy, models: [{ ...audioModel, maxRequestBytes: 1024 }] };
  await expect(prepareAudio(request(), smallPolicy, 1000)).rejects.toMatchObject({
    code: "body_too_large",
  });
  const prepared = await prepareAudio(request(multipart(wav(), { language: "pl" })), policy, 1000);
  expect(prepared.audio.language).toBe("pl");
  expect(prepared.audio.file.type).toBe("audio/wav");
});

test("usage requires authoritative disjoint audio/text totals and missing-only fallback", () => {
  const expected = { ...emptyUsage(), input: 2, audioInput: 10, output: 3 };
  expect(transcriptionUsage({ usage: tokenUsage }, 1000, true)).toEqual(expected);
  expect(charge(expected, audioModel.rates)).toBe(31n);
  for (const usage of [
    null,
    {},
    { ...tokenUsage, input_token_details: undefined },
    { ...tokenUsage, total_tokens: 14 },
    { ...tokenUsage, input_token_details: { audio_tokens: 11, text_tokens: 2 } },
    { ...tokenUsage, output_tokens: -1 },
    { ...tokenUsage, input_tokens: 0.5 },
  ])
    expect(transcriptionUsage({ usage }, 1000, true)).toBeNull();
  expect(transcriptionUsage({}, 1001, true)).toEqual({ ...emptyUsage(), audioMilliseconds: 1001 });
  expect(transcriptionUsage({}, 1000, false)).toBeNull();
  expect(charge({ ...emptyUsage(), audioMilliseconds: 1001 }, audioModel.rates)).toBe(101n);
  expect(audioHoldCost(16000, 2000, 240000, audioModel.rates)).toBe(38000n);
  expect(() => charge({ ...expected, audioMilliseconds: 1000 }, audioModel.rates)).toThrow();
});

test("native route requires Bearer + idempotency and rejects text/voice endpoint confusion before dispatch", async () => {
  const missing = request();
  missing.headers.delete("Idempotency-Key");
  expect((await service.transcribe(missing, identity)).status).toBe(400);
  const cookies = request();
  cookies.headers.delete("Authorization");
  expect((await service.transcribe(cookies, identity)).status).toBe(401);
  expect(
    (await service.transcribe(request(multipart(wav(), { model: original.id })), identity)).status,
  ).toBe(403);
  expect(
    (
      await service.generate(
        "openai",
        new Request("http://localhost/openai/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "voice", input: "test" }),
        }),
        identity,
      )
    ).status,
  ).toBe(403);
  expect(calls).toBe(0);
});

test("successful transcription settles a content-free receipt, maps row to native model, and preserves silence", async () => {
  dispatch = async (model, audio) => {
    expect(model.upstreamModel).toBe("gpt-4o-mini-transcribe");
    expect(audio.milliseconds).toBe(1000);
    expect(audio.language).toBe("en");
    return success("");
  };
  const key = crypto.randomUUID();
  const response = await service.transcribe(
    request(multipart(wav(), { language: "en" }), key),
    identity,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "" });
  expect(response.headers.get("X-Zephium-Usage")).toBe("settled");
  const row = await receipt(response);
  expect(row).toMatchObject({
    state: "settled",
    charged: "31",
    usage: { input: 2, audioInput: 10, output: 3 },
  });
  expect(JSON.stringify(row)).not.toContain("private-recording");
  expect((await service.transcribe(request(multipart(), key), identity)).status).toBe(409);
});

test("only successful missing usage uses explicit duration fallback; malformed usage stays pending", async () => {
  dispatch = async () => Response.json({ text: "transcribed" });
  const fallback = await service.transcribe(request(), identity);
  expect(fallback.status).toBe(200);
  expect(await receipt(fallback)).toMatchObject({
    state: "settled",
    charged: "100",
    usage: { audioMilliseconds: 1000 },
  });
  dispatch = async () => success("transcribed", {});
  const malformed = await service.transcribe(request(), identity);
  expect(malformed.headers.get("X-Zephium-Usage")).toBe("pending");
  expect(await receipt(malformed)).toMatchObject({ state: "usage_unknown", charged: "0" });
});

test("provider failures and invalid/oversized responses never create duration charges", async () => {
  dispatch = async () => new Response("private provider failure", { status: 503 });
  const failed = await service.transcribe(request(), identity);
  expect(failed.status).toBe(502);
  expect(await receipt(failed)).toMatchObject({ state: "usage_unknown", charged: "0" });
  expect(await failed.text()).not.toContain("private provider failure");
  for (const body of [
    JSON.stringify({ wrong: "shape" }),
    "not json",
    JSON.stringify({ text: "x".repeat(audioResponseBytes) }),
  ]) {
    dispatch = async () => new Response(body);
    const response = await service.transcribe(request(), identity);
    expect(response.status).toBe(502);
    expect(await receipt(response)).toMatchObject({ state: "usage_unknown", charged: "0" });
  }
  dispatch = async () => new Response("rejected", { status: 400 });
  const rejected = await service.transcribe(request(), identity);
  expect(rejected.status).toBe(400);
  expect(await receipt(rejected)).toMatchObject({ state: "released", charged: "0" });
});

test("socket receipt time bounds the whole request and caller headers cannot reset it", async () => {
  const call = request();
  call.headers.set("X-Zephium-Deadline", String(Date.now() + 999999));
  markIncomingStart(call, performance.now() - audioDeadlineMs - 1);
  const prior = calls;
  const response = await service.transcribe(call, identity);
  expect(response.status).toBe(504);
  expect(calls).toBe(prior);
  dispatch = async (_model, _audio, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  const timed = await service.transcribe(request(), identity);
  expect(timed.status).toBe(504);
  expect(await receipt(timed)).toMatchObject({
    state: "usage_unknown",
    charged: "0",
    error_class: "provider_idle_timeout",
  });
});

test("application HTTP route uses authenticated identity and returns the native JSON envelope", async () => {
  dispatch = async () => success();
  const auth = {
    api: {
      getSession: async () => ({
        user: { id: identity.userId, emailVerified: true },
        session: { id: identity.sessionId },
      }),
    },
  } as unknown as Auth;
  const provider: BillingProvider = {
    state: async () => null,
    checkout: async () => {
      throw new Error("Unused");
    },
    portal: async () => "unused",
    deleteCustomer: async () => {},
    openCheckoutUntil: async () => null,
  };
  const app = createApp(fixture.config, fixture.db, auth, provider, undefined, service);
  const response = await app.fetch(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "transcribed" });
});

test("native OpenAI transport rebuilds multipart using upstream model and normalized metadata", async () => {
  const originalFetch = globalThis.fetch;
  let captured: Request | undefined;
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = new Request(url, init);
    redirect = init?.redirect;
    return success();
  }) as typeof fetch;
  try {
    const native = nativeTransport({ openai: "synthetic-test-key" });
    if (!native.transcribe) throw new Error("Missing native audio adapter");
    await native.transcribe(
      audioModel,
      {
        file: new Blob([new Uint8Array(wav())], { type: "audio/wav" }),
        language: "pl",
        milliseconds: 1000,
      },
      new AbortController().signal,
    );
    if (!captured) throw new Error("No upstream request");
    expect(captured.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(captured.headers.get("authorization")).toBe("Bearer synthetic-test-key");
    expect(redirect).toBe("error");
    const body = await captured.formData();
    expect([...body.keys()].sort()).toEqual(["file", "language", "model", "response_format"]);
    expect(body.get("model")).toBe(audioModel.upstreamModel);
    expect(body.get("response_format")).toBe("json");
    expect(body.get("language")).toBe("pl");
    const file = body.get("file");
    if (!(file instanceof File)) throw new Error("Missing upstream WAV");
    expect(file.name).toBe("audio.wav");
    expect(["audio/wav", "audio/x-wav"]).toContain(file.type);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("slow uploads, stalled provider bodies and client cancellation release readers without invented charges", async () => {
  let uploadCancelled = false;
  const upload = new Request(`http://localhost${audioRoute}`, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body: new ReadableStream<Uint8Array>({
      cancel() {
        uploadCancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit);
  await expect(prepareAudio(upload, policy, 10)).rejects.toMatchObject({
    code: "request_timeout",
    status: 408,
  });
  expect(uploadCancelled).toBe(true);
  let responseCancelled = false;
  dispatch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          responseCancelled = true;
        },
      }),
    );
  const stalled = await service.transcribe(request(), identity);
  expect(stalled.status).toBe(504);
  expect(responseCancelled).toBe(true);
  expect(await receipt(stalled)).toMatchObject({ state: "usage_unknown", charged: "0" });
  const abort = new AbortController();
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  dispatch = async (_model, _audio, signal) => {
    entered();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  };
  const call = new Request(request(), { signal: abort.signal });
  const response = service.transcribe(call, identity);
  await dispatched;
  abort.abort();
  const cancelled = await response;
  expect(cancelled.status).toBe(408);
  expect(await receipt(cancelled)).toMatchObject({
    state: "usage_unknown",
    charged: "0",
    error_class: "client_disconnected",
  });
});

test("audio errors use stable statuses before opening a receipt", async () => {
  for (const [bytes, status, code] of [
    [new Uint8Array([1, 2, 3]), 415, "unsupported_audio_format"],
    [wav().subarray(0, 43), 400, "invalid_audio"],
    [wav(8000 * 240 + 1), 422, "audio_too_long"],
  ] as const) {
    const response = await service.transcribe(request(multipart(bytes)), identity);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code }, request_id: null });
  }
});

test("real chunked HTTP upload consumes the same model deadline as transcription", async () => {
  dispatch = async (_model, _audio, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  const server = createApiServer(
    () => ({ fetch: (call) => service.transcribe(call, identity) }),
    0,
    "127.0.0.1",
  );
  const call = request();
  const bytes = Buffer.from(await call.arrayBuffer());
  try {
    const result = await new Promise<{ status: number | undefined; body: unknown }>(
      (resolve, reject) => {
        const outgoing = httpRequest(
          `http://127.0.0.1:${server.port}${audioRoute}`,
          {
            method: "POST",
            headers: {
              "Content-Type": call.headers.get("Content-Type") ?? "",
              Authorization: "Bearer test",
              "Idempotency-Key": crypto.randomUUID(),
              "Transfer-Encoding": "chunked",
            },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk: Buffer) => {
              text += chunk.toString();
            });
            response.once("end", () =>
              resolve({ status: response.statusCode, body: JSON.parse(text) }),
            );
            response.once("error", reject);
          },
        );
        outgoing.once("error", reject);
        outgoing.write(bytes.subarray(0, 17));
        // Leave less than one idle interval: the whole-request deadline must win.
        setTimeout(
          () => outgoing.end(bytes.subarray(17)),
          audioModel.maxDurationMs - audioModel.idleTimeoutMs / 2,
        );
      },
    );
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({ error: { code: "provider_timeout" } });
  } finally {
    await server.stop(true);
  }
});

test("policy separates transcription roles and requires positive customer and provider audio tariffs", () => {
  for (const model of [
    { ...audioModel, provider: "deepseek" },
    { ...audioModel, roles: ["transcribe", "lead"] },
    { ...audioModel, supports: { ...audioModel.supports, tools: true } },
    { ...audioModel, rates: { ...audioModel.rates, audioInput: "0" } },
    { ...audioModel, rates: { ...audioModel.rates, audioMinute: "0" } },
    { ...audioModel, costRates: { ...audioModel.costRates, audioInput: "0" } },
    { ...audioModel, costRates: { ...audioModel.costRates, audioMinute: "0" } },
  ])
    expect(policySchema.safeParse({ ...policy, models: [model] }).success).toBe(false);
  expect(
    policySchema.safeParse({
      ...policy,
      defaults: { free: { lead: "voice", page: null, light: null, transcribe: "voice" } },
    }).success,
  ).toBe(false);
  expect(
    policySchema.safeParse({
      ...policy,
      defaults: { free: { lead: original.id, page: null, light: null, transcribe: "voice" } },
    }).success,
  ).toBe(true);
});

test("catalog publishes transcription defaults, native limits and independent audio tariffs", async () => {
  const catalogService = createCloudService(
    fixture.db,
    {
      ...policy,
      defaults: { free: { lead: original.id, page: null, light: null, transcribe: "voice" } },
    },
    transport,
    fixture.config.ABUSE_SECRET,
  );
  const catalog = await catalogService.catalog(identity.userId);
  expect(catalog.defaults).toMatchObject({ transcribe: "voice" });
  const model = catalog.models.find((m) => m.id === "voice");
  expect(model).toMatchObject({
    roles: ["transcribe"],
    limits: {
      max_duration_ms: audioModel.maxDurationMs,
      max_audio_duration_ms: 240000,
      max_response_bytes: audioResponseBytes,
    },
    price: { per_million_tokens: { audio_input: "2000000" }, per_audio_minute: "6000" },
  });
});

test("successful missing usage charges the explicit tariff while retaining conservative provider exposure", async () => {
  const budgetPolicy = testPolicy({
    ...policy,
    revision: policy.revision + 1,
    models: [audioModel],
    limits: {
      ...policy.limits,
      budgets: {
        scope: "audio-fallback-test",
        dailyUsdMicros: "1000000",
        totalUsdMicros: "1000000",
        freeDailyUsdMicros: "1000000",
      },
    },
  });
  await registerPolicy(fixture.db, budgetPolicy);
  const budgetService = createCloudService(
    fixture.db,
    budgetPolicy,
    transport,
    fixture.config.ABUSE_SECRET,
  );
  const owner = await createCloudAccount(fixture.db);
  dispatch = async () => Response.json({ text: "transcribed" });
  const response = await budgetService.transcribe(request(), owner);
  expect(response.status).toBe(200);
  const id = response.headers.get("X-Zephium-Request-Id");
  const [record] = await fixture.db
    .sql`SELECT reserved::text,exposure::text,terminal FROM cloud_cost_record WHERE request_id=${id}`;
  const bound = audioHoldCost(
    audioModel.contextWindow,
    audioModel.maxOutput,
    1000,
    audioModel.costRates,
  ).toString();
  expect(record).toMatchObject({ reserved: bound, exposure: bound, terminal: false });
  const [customer] = await fixture.db
    .sql`SELECT state,charged::text FROM cloud_request WHERE id=${id}`;
  expect(customer).toMatchObject({ state: "settled", charged: "100" });
  dispatch = async () => success();
  const metered = await budgetService.transcribe(request(), owner);
  expect(metered.status).toBe(200);
  const meteredId = metered.headers.get("X-Zephium-Request-Id");
  const [known] = await fixture.db
    .sql`SELECT exposure::text,terminal FROM cloud_cost_record WHERE request_id=${meteredId}`;
  expect(known).toMatchObject({ exposure: "21", terminal: true });
  await budgetService.shutdown();
});
