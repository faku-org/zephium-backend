import { AppError } from "../../platform/errors";
import type { Model, ProviderName } from "../policy";
import type { PreparedAudio } from "./audio";
import type { PreparedRequest } from "./protocol";
export interface CloudTransport {
  available(provider: ProviderName): boolean;
  count(model: Model, request: PreparedRequest, signal: AbortSignal): Promise<number>;
  transcribe?(model: Model, request: PreparedAudio, signal: AbortSignal): Promise<Response>;
  generate(model: Model, request: PreparedRequest, signal: AbortSignal): Promise<Response>;
}
const origins: Record<ProviderName, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai",
  deepseek: "https://api.deepseek.com",
  typesafe: "https://api.typesafe.ai",
};
export async function boundedJSON(
  response: Response,
  maximum = 8 * 1024 * 1024,
  onChunk?: () => void,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; value: unknown }> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("invalid_provider_response", 502);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new AppError("request_cancelled", 408);
      if (done) break;
      onChunk?.();
      length += value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new AppError("provider_response_limit", 502);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  try {
    return { bytes, value: JSON.parse(bytes.toString()) };
  } catch {
    throw new AppError("invalid_provider_response", 502);
  }
}
export type FetchRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function nativeTransport(
  keys: Partial<Record<ProviderName, string>>,
  fetcher: FetchRequest = fetch,
): CloudTransport {
  const headers = (provider: ProviderName) => {
    const key = keys[provider];
    if (!key) throw new AppError("provider_not_configured", 503);
    const h = new Headers({ "Content-Type": "application/json" });
    if (provider === "anthropic") {
      h.set("x-api-key", key);
      h.set("anthropic-version", "2023-06-01");
    } else if (provider === "google") h.set("x-goog-api-key", key);
    else h.set("Authorization", `Bearer ${key}`);
    return h;
  };
  const send = (m: Model, path: string, body: unknown, signal: AbortSignal) =>
    fetcher(`${origins[m.provider]}${path}`, {
      method: "POST",
      headers: headers(m.provider),
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  return {
    available: (provider) => !!keys[provider],
    async count(m, r, signal) {
      let response: Response;
      if (m.provider === "openai") {
        const {
          model,
          input,
          instructions,
          tools,
          tool_choice,
          parallel_tool_calls,
          text,
          reasoning,
        } = r.body;
        response = await send(
          m,
          "/v1/responses/input_tokens",
          { model, input, instructions, tools, tool_choice, parallel_tool_calls, text, reasoning },
          signal,
        );
      } else if (m.provider === "anthropic") {
        // Anthropic's count endpoint rejects server tools. Admission reserves an extra full
        // context per allowed search, covering search overhead/results conservatively.
        const { model, messages, system, thinking } = r.body;
        const tools = (r.body.tools as Record<string, unknown>[] | undefined)?.filter(
          (t) => t.type === undefined,
        );
        response = await send(
          m,
          "/v1/messages/count_tokens",
          { model, messages, system, tools, thinking },
          signal,
        );
      } else if (m.provider === "google") {
        if (!/^[a-zA-Z0-9._-]+$/.test(m.upstreamModel))
          throw new AppError("invalid_model_configuration", 503);
        response = await send(
          m,
          `/v1beta/models/${m.upstreamModel}:countTokens`,
          { generateContentRequest: { model: `models/${m.upstreamModel}`, ...r.body } },
          signal,
        );
      } else return m.contextWindow; // Safe, disclosed ceiling where no native counting endpoint is used.
      if (!response.ok) {
        const retry = Number(response.headers.get("Retry-After"));
        await response.body?.cancel();
        if ([400, 413, 422].includes(response.status))
          throw new AppError("provider_rejected", response.status);
        throw new AppError(
          response.status === 429 ? "provider_rate_limited" : "token_count_unavailable",
          response.status === 429 ? 429 : 503,
          Number.isFinite(retry) && retry > 0 ? Math.min(900, Math.ceil(retry)) : 30,
        );
      }
      const { value } = await boundedJSON(response, 65536, undefined, signal);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new AppError("invalid_provider_response", 502);
      const data = value as Record<string, unknown>;
      const count = m.provider === "google" ? data.totalTokens : data.input_tokens;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > m.contextWindow
      )
        throw new AppError("input_limit_exceeded", 400);
      return count;
    },
    transcribe(m, r, signal) {
      if (m.provider !== "openai") throw new AppError("unsupported_endpoint", 400);
      const body = new FormData();
      body.set("model", m.upstreamModel);
      body.set("file", r.file, "audio.wav");
      body.set("response_format", "json");
      if (r.language) body.set("language", r.language);
      const h = headers(m.provider);
      h.delete("Content-Type"); // Fetch supplies the boundary for this new, normalized multipart body.
      return fetcher(`${origins.openai}/v1/audio/transcriptions`, {
        method: "POST",
        headers: h,
        body,
        redirect: "error",
        signal,
      });
    },
    generate(m, r, signal) {
      const paths: Record<ProviderName, string> = {
        openai: "/v1/responses",
        anthropic: "/v1/messages",
        google: `/v1beta/models/${m.upstreamModel}:streamGenerateContent?alt=sse`,
        openrouter: "/api/v1/chat/completions",
        deepseek: "/v1/chat/completions",
        typesafe: "/v1/systemone",
      };
      return send(m, paths[m.provider], r.body, signal);
    },
  };
}
