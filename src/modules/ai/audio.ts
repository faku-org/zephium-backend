import { createHash } from "node:crypto";
import type { Database } from "../../platform/db";
import { AppError, errorResponse, operationalEvent } from "../../platform/errors";
import { incomingStart, readIncomingBody } from "../../platform/incoming-body";
import {
  audioHoldCost,
  emptyUsage,
  markDispatched,
  openRequest,
  releaseRequest,
  reserveRequest,
  settleRequest,
  type Usage,
  unknownRequest,
} from "../credits";
import { type CloudPolicy, type Model, requestDuration } from "../policy";
import { boundedJSON, type CloudTransport } from "./transport";

export const audioRequestBytes = 8 * 1024 * 1024;
export const audioResponseBytes = 64 * 1024;
export const audioDeadlineMs = 85000;
export const audioRoute = "/openai/v1/audio/transcriptions";
const languages = new Set(
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(
    " ",
  ),
);
export interface PreparedAudio {
  file: Blob;
  language?: string;
  milliseconds: number;
}
interface AudioIdentity {
  userId: string;
  sessionId: string;
}

/** RIFF PCM is signed little-endian at 16 bits. Inspect bytes, never trust MIME/filename. */
export function inspectWav(bytes: Uint8Array): {
  milliseconds: number;
  sampleRate: number;
  frames: number;
} {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 4 || data.toString("latin1", 0, 4) !== "RIFF")
    throw new AppError("unsupported_audio_format", 415);
  if (data.length < 12) throw new AppError("invalid_audio", 400);
  if (data.toString("latin1", 8, 12) !== "WAVE")
    throw new AppError("unsupported_audio_format", 415);
  if (data.readUInt32LE(4) + 8 !== data.length) throw new AppError("invalid_audio", 400);
  let offset = 12;
  let sampleRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new AppError("invalid_audio", 400);
    const kind = data.toString("latin1", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const next = end + (length % 2);
    if (next > data.length) throw new AppError("invalid_audio", 400);
    if (kind === "fmt ") {
      if (sampleRate !== undefined || length < 16) throw new AppError("invalid_audio", 400);
      const format = data.readUInt16LE(start);
      const channels = data.readUInt16LE(start + 2);
      const rate = data.readUInt32LE(start + 4);
      const byteRate = data.readUInt32LE(start + 8);
      const align = data.readUInt16LE(start + 12);
      const bits = data.readUInt16LE(start + 14);
      if (format !== 1 || channels !== 1 || bits !== 16 || rate > 16000)
        throw new AppError("unsupported_audio_format", 415);
      if (
        rate === 0 ||
        align !== 2 ||
        byteRate !== rate * 2 ||
        ![16, 18].includes(length) ||
        (length === 18 && data.readUInt16LE(start + 16) !== 0)
      )
        throw new AppError("invalid_audio", 400);
      sampleRate = rate;
    } else if (kind === "data") {
      if (dataBytes !== undefined || length === 0 || length % 2 !== 0)
        throw new AppError("invalid_audio", 400);
      dataBytes = length;
    }
    offset = next;
  }
  if (sampleRate === undefined || dataBytes === undefined) throw new AppError("invalid_audio", 400);
  const frames = dataBytes / 2;
  if (frames > 240 * sampleRate) throw new AppError("audio_too_long", 422);
  return { milliseconds: Math.ceil((frames * 1000) / sampleRate), sampleRate, frames };
}

export async function prepareAudio(
  request: Request,
  policy: CloudPolicy,
  remainingMs: number,
): Promise<{ model: Model; audio: PreparedAudio }> {
  if (!/^multipart\/form-data\s*;/i.test(request.headers.get("content-type") ?? ""))
    throw new AppError("invalid_request", 400);
  const bytes = await readIncomingBody(request, audioRequestBytes, remainingMs);
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
      body: new Uint8Array(bytes),
    }).formData();
  } catch {
    throw new AppError("invalid_request", 400);
  }
  const allowed = new Set(["file", "model", "response_format", "language"]);
  for (const [field] of form) {
    if (!allowed.has(field) || form.getAll(field).length !== 1)
      throw new AppError("invalid_request", 400);
  }
  const id = form.get("model");
  const file = form.get("file");
  const format = form.get("response_format");
  const language = form.get("language");
  if (
    typeof id !== "string" ||
    !id ||
    !(file instanceof Blob) ||
    (format !== null && format !== "json") ||
    (language !== null && (typeof language !== "string" || !languages.has(language)))
  )
    throw new AppError("invalid_request", 400);
  // Public model IDs select a reviewed policy row; callers cannot select arbitrary upstream IDs.
  const model = policy.models.find(
    (m) => m.enabled && m.provider === "openai" && m.id === id && m.roles.includes("transcribe"),
  );
  if (!model) throw new AppError("model_not_allowed", 403);
  if (bytes.byteLength > model.maxRequestBytes) throw new AppError("body_too_large", 413);
  const audioBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = inspectWav(audioBytes);
  return {
    model,
    audio: {
      file: new Blob([audioBytes], { type: "audio/wav" }),
      milliseconds: metadata.milliseconds,
      ...(typeof language === "string" ? { language } : {}),
    },
  };
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1000000000;
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
/** Missing usage is distinct from malformed usage; only the former permits a reviewed fallback. */
export function transcriptionUsage(
  value: unknown,
  milliseconds: number,
  fallback: boolean,
): Usage | null {
  const response = record(value);
  if (!response) return null;
  if (!Object.hasOwn(response, "usage"))
    return fallback ? { ...emptyUsage(), audioMilliseconds: milliseconds } : null;
  const usage = record(response.usage);
  const details = record(usage?.input_token_details);
  if (
    usage?.type !== "tokens" ||
    !details ||
    !count(usage.input_tokens) ||
    !count(usage.output_tokens) ||
    !count(usage.total_tokens) ||
    !count(details.audio_tokens) ||
    !count(details.text_tokens) ||
    details.audio_tokens + details.text_tokens !== usage.input_tokens ||
    usage.input_tokens + usage.output_tokens !== usage.total_tokens
  )
    return null;
  return {
    ...emptyUsage(),
    input: details.text_tokens,
    audioInput: details.audio_tokens,
    output: usage.output_tokens,
  };
}

function retryAfter(value: string | null): number {
  const seconds =
    value && /^\d+$/.test(value)
      ? Number(value)
      : value
        ? Math.ceil((Date.parse(value) - Date.now()) / 1000)
        : 1;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 1;
}

export function createAudioTranscriber(
  db: Database,
  policy: CloudPolicy,
  transport: CloudTransport,
  registerShutdown: (stop: () => Promise<void>) => () => void,
) {
  return async (request: Request, identity: AudioIdentity): Promise<Response> => {
    const abort = new AbortController();
    const start = incomingStart(request);
    let reason: string | null = null;
    let requestId: string | null = null;
    let dispatched = false;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const interrupt = (code: string) => {
      reason ??= code;
      abort.abort();
    };
    const unregister = registerShutdown(async () => {
      interrupt("server_shutdown");
      await finished;
    });
    const cancel = () => interrupt("client_disconnected");
    request.signal.addEventListener("abort", cancel, { once: true });
    const timeout = (duration: number) =>
      setTimeout(
        () => interrupt("provider_timeout"),
        Math.max(0, duration - (performance.now() - start)),
      );
    let timer = timeout(audioDeadlineMs);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (request.signal.aborted) interrupt("client_disconnected");
      if (abort.signal.aborted)
        throw new AppError(
          reason ?? "request_cancelled",
          reason === "client_disconnected" ? 408 : 504,
        );
    };
    try {
      check();
      if (!/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? ""))
        throw new AppError("unauthorized", 401);
      const rawKey = request.headers.get("Idempotency-Key");
      if (
        !rawKey ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawKey)
      )
        throw new AppError("invalid_idempotency_key", 400);
      const { model, audio } = await prepareAudio(
        request,
        policy,
        Math.max(1, audioDeadlineMs - (performance.now() - start)),
      );
      const duration = Math.min(audioDeadlineMs, requestDuration(policy, model));
      clearTimeout(timer);
      timer = timeout(duration);
      if (performance.now() - start >= duration) interrupt("provider_timeout");
      check();
      if (
        !(transport.transcribeAvailable?.() ?? transport.available("openai")) ||
        !transport.transcribe
      )
        throw new AppError("provider_not_configured", 503);
      const key = createHash("sha256")
        .update(`${identity.userId}:${rawKey.toLowerCase()}`)
        .digest("hex");
      const opened = await openRequest(
        db,
        policy,
        model,
        identity.userId,
        identity.sessionId,
        key,
        audioRoute,
      );
      requestId = opened.id;
      check();
      await reserveRequest(
        db,
        policy,
        model,
        requestId,
        identity.userId,
        identity.sessionId,
        audioHoldCost(model.contextWindow, model.maxOutput, audio.milliseconds, model.rates),
        model.contextWindow,
        model.costRates
          ? audioHoldCost(model.contextWindow, model.maxOutput, audio.milliseconds, model.costRates)
          : undefined,
      );
      check();
      await markDispatched(db, requestId, identity.userId, identity.sessionId);
      dispatched = true;
      check();
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => interrupt("provider_idle_timeout"),
          Math.min(model.idleTimeoutMs, duration),
        );
      };
      touch();
      const upstream = await transport.transcribe(model, audio, abort.signal);
      check();
      touch();
      const headers = new Headers({
        "Cache-Control": "no-store",
        "X-Zephium-Request-Id": requestId,
        "X-Zephium-Policy-Revision": String(policy.revision),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        if ([400, 401, 403, 404, 413, 422, 429].includes(upstream.status))
          await releaseRequest(db, requestId, identity.userId, "provider_rejected");
        else await unknownRequest(db, requestId, identity.userId, "provider_failed");
        const status =
          upstream.status === 429
            ? 429
            : [400, 413, 422].includes(upstream.status)
              ? upstream.status
              : 502;
        return errorResponse(
          new AppError(
            status === 429
              ? "provider_rate_limited"
              : status < 500
                ? "provider_rejected_request"
                : "provider_request_failed",
            status,
            status === 429 ? retryAfter(upstream.headers.get("retry-after")) : undefined,
          ),
          requestId,
          headers,
        );
      }
      const response = await boundedJSON(upstream, audioResponseBytes, touch, abort.signal);
      check();
      const body = record(response.value);
      if (typeof body?.text !== "string") throw new AppError("invalid_provider_response", 502);
      const payload = JSON.stringify({ text: body.text });
      if (Buffer.byteLength(payload) > audioResponseBytes)
        throw new AppError("provider_response_limit", 502);
      const usage = transcriptionUsage(
        body,
        audio.milliseconds,
        model.rates.audioMinute !== undefined &&
          (!model.costRates || model.costRates.audioMinute !== undefined),
      );
      if (usage)
        await settleRequest(
          db,
          requestId,
          identity.userId,
          usage,
          upstream.status,
          upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id"),
        );
      else await unknownRequest(db, requestId, identity.userId, "usage_missing");
      check();
      headers.set("Content-Type", "application/json");
      headers.set("X-Zephium-Usage", usage ? "settled" : "pending");
      return new Response(payload, { status: 200, headers });
    } catch (error) {
      abort.abort();
      const safe = reason
        ? new AppError(reason, reason === "client_disconnected" ? 408 : 504)
        : error instanceof AppError
          ? error
          : new AppError("provider_unavailable", 502);
      if (requestId) {
        try {
          if (dispatched) await unknownRequest(db, requestId, identity.userId, safe.code);
          else await releaseRequest(db, requestId, identity.userId, safe.code);
        } catch {
          operationalEvent("cloud_accounting_recovery_required");
        }
      }
      return errorResponse(safe, requestId);
    } finally {
      clearTimeout(timer);
      clearTimeout(idle);
      request.signal.removeEventListener("abort", cancel);
      unregister();
      done();
    }
  };
}
