import type { Usage } from "../credits";
import type { ProviderName } from "../policy";

const MAX_EVENT = 8 * 1024 * 1024;
const MAX_STREAM = 32 * 1024 * 1024;
const MAX_TOKENS = 1_000_000_000;
const MAX_SEARCH = 10_000;
const encoder = new TextEncoder();
export type CacheWriteHint = "unknown" | "5m";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
const field = (value: unknown, key: string): unknown => object(value)?.[key];
const count = (value: unknown, max = MAX_TOKENS): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : null;
const optionalCount = (value: unknown, max = MAX_TOKENS): number | null =>
  value === undefined ? 0 : count(value, max);
const sum = (...values: number[]): number | null => {
  const result = values.reduce((total, value) => total + value, 0);
  return count(result);
};
const usage = (
  input: number,
  cachedInput: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  output: number,
  reasoning: number,
  searchCalls: number,
): Usage | null => {
  if (
    [input, cachedInput, cacheWrite5m, cacheWrite1h, output, reasoning].some(
      (value) => count(value) === null,
    ) ||
    count(searchCalls, MAX_SEARCH) === null ||
    reasoning > output
  )
    return null;
  return { input, cachedInput, cacheWrite5m, cacheWrite1h, output, reasoning, searchCalls };
};

function openAI(value: unknown, nativeSearch: boolean, observed?: Set<string>): Usage | null {
  const data = object(field(value, "usage"));
  if (!data) return null;
  const totalInput = count(data.input_tokens);
  const output = count(data.output_tokens);
  const details = field(data, "input_tokens_details");
  const cachedInput = optionalCount(field(details, "cached_tokens"));
  const cacheWrite5m = optionalCount(field(details, "cache_write_tokens"));
  const reasoning = optionalCount(field(field(data, "output_tokens_details"), "reasoning_tokens"));
  if (
    totalInput === null ||
    output === null ||
    cachedInput === null ||
    cacheWrite5m === null ||
    reasoning === null
  )
    return null;
  const input = totalInput - cachedInput - cacheWrite5m;
  if (input < 0) return null;
  let searchCalls = 0;
  if (nativeSearch) {
    const finalOutput = field(value, "output");
    if (!Array.isArray(finalOutput)) return null;
    const ids = new Set<string>();
    for (const item of finalOutput) {
      if (field(item, "type") !== "web_search_call") continue;
      const id = field(item, "id");
      const action = field(field(item, "action"), "type");
      if (typeof id !== "string" || !id || typeof action !== "string") return null;
      // Only the final completed item confirms that the search action finished.
      if (field(item, "status") !== "completed") return null;
      if (action === "search") ids.add(id);
      // Only search-action pricing is documented unambiguously. Do not assume
      // page-open/find actions are free; ambiguous fees use hold-and-refund recovery.
      else return null;
    }
    if (observed && [...observed].some((id) => !ids.has(id))) {
      // The final response is authoritative, but a missing observed search is ambiguous.
      return null;
    }
    searchCalls = ids.size;
  }
  return usage(input, cachedInput, cacheWrite5m, 0, output, reasoning, searchCalls);
}

type AnthropicCounts = {
  input: number | null;
  output: number | null;
  cached: number;
  write5m: number;
  write1h: number;
  search: number | null;
};
function anthCounts(value: unknown, cacheWriteHint: CacheWriteHint): AnthropicCounts | null {
  const data = object(value);
  if (!data) return null;
  const input = data.input_tokens === undefined ? null : count(data.input_tokens);
  const output = data.output_tokens === undefined ? null : count(data.output_tokens);
  const cached = optionalCount(data.cache_read_input_tokens);
  const writes = optionalCount(data.cache_creation_input_tokens);
  const creation = field(data, "cache_creation");
  let write5m = optionalCount(field(creation, "ephemeral_5m_input_tokens"));
  const write1h = optionalCount(field(creation, "ephemeral_1h_input_tokens"));
  const rawSearch = field(data.server_tool_use, "web_search_requests");
  const search = rawSearch === undefined ? null : count(rawSearch, MAX_SEARCH);
  if (
    (data.input_tokens !== undefined && input === null) ||
    (data.output_tokens !== undefined && output === null) ||
    cached === null ||
    writes === null ||
    write5m === null ||
    write1h === null ||
    (rawSearch !== undefined && search === null)
  )
    return null;
  if (creation !== undefined && write5m + write1h !== writes) return null;
  if (creation === undefined && writes !== 0) {
    // The caller must establish from the outgoing request that 1h writes are impossible.
    if (cacheWriteHint !== "5m") return null;
    write5m = writes;
  }
  return { input, output, cached, write5m, write1h, search };
}
function anthropic(
  value: unknown,
  nativeSearch: boolean,
  searchObserved: boolean,
  cacheWriteHint: CacheWriteHint,
): Usage | null {
  const counts = anthCounts(field(value, "usage"), cacheWriteHint);
  if (!counts || counts.input === null || counts.output === null) return null;
  if (nativeSearch && searchObserved && counts.search === null) return null;
  const searchCalls = nativeSearch ? (counts.search ?? 0) : 0;
  return usage(
    counts.input,
    counts.cached,
    counts.write5m,
    counts.write1h,
    counts.output,
    0,
    searchCalls,
  );
}
function google(value: unknown, nativeSearch: boolean): Usage | null {
  if (nativeSearch) return null;
  const data = object(field(value, "usageMetadata"));
  if (!data) return null;
  const totalInput = count(data.promptTokenCount);
  const cachedInput = optionalCount(data.cachedContentTokenCount);
  const candidates = count(data.candidatesTokenCount);
  const thoughts = optionalCount(data.thoughtsTokenCount);
  if (totalInput === null || cachedInput === null || candidates === null || thoughts === null)
    return null;
  const output = sum(candidates, thoughts);
  if (cachedInput > totalInput || output === null) return null;
  return usage(totalInput - cachedInput, cachedInput, 0, 0, output, thoughts, 0);
}
function chat(value: unknown, nativeSearch: boolean): Usage | null {
  if (nativeSearch) return null;
  const data = object(field(value, "usage"));
  if (!data) return null;
  const totalInput = count(data.prompt_tokens);
  const output = count(data.completion_tokens);
  const cachedDetail = field(data.prompt_tokens_details, "cached_tokens");
  const hit = data.prompt_cache_hit_tokens;
  const cachedInput = optionalCount(cachedDetail === undefined ? hit : cachedDetail);
  const reasoning = optionalCount(field(data.completion_tokens_details, "reasoning_tokens"));
  if (totalInput === null || output === null || cachedInput === null || reasoning === null)
    return null;
  if (cachedInput > totalInput) return null;
  const miss = data.prompt_cache_miss_tokens;
  if (hit !== undefined || miss !== undefined) {
    const hitCount = count(hit);
    const missCount = count(miss);
    if (
      hitCount === null ||
      missCount === null ||
      (cachedDetail !== undefined && hitCount !== cachedInput) ||
      hitCount + missCount !== totalInput
    )
      return null;
  }
  return usage(totalInput - cachedInput, cachedInput, 0, 0, output, reasoning, 0);
}
function typesafe(value: unknown, nativeSearch: boolean): Usage | null {
  if (nativeSearch || typeof field(value, "model") !== "string") return null;
  const data = object(field(value, "usage"));
  const input = count(data?.input_tokens);
  const output = count(data?.output_tokens);
  if (input === null || output === null) return null;
  return usage(input, 0, 0, 0, output, 0, 0);
}

/** Reads a complete provider JSON response; never estimates missing usage. */
export function extractUsage(
  provider: ProviderName,
  value: unknown,
  nativeSearch: boolean,
  cacheWriteHint: CacheWriteHint = "unknown",
): Usage | null {
  switch (provider) {
    case "openai":
      return ["completed", "incomplete", "failed"].includes(String(field(value, "status")))
        ? openAI(value, nativeSearch)
        : null;
    case "anthropic":
      if (field(value, "type") !== "message") return null;
      return anthropic(
        value,
        nativeSearch,
        Array.isArray(field(value, "content")) &&
          (field(value, "content") as unknown[]).some(
            (item) =>
              field(item, "type") === "server_tool_use" && field(item, "name") === "web_search",
          ),
        cacheWriteHint,
      );
    case "google": {
      const candidates = field(value, "candidates");
      return Array.isArray(candidates) &&
        candidates.some(
          (item) =>
            typeof field(item, "finishReason") === "string" &&
            field(item, "finishReason") !== "FINISH_REASON_UNSPECIFIED",
        )
        ? google(value, nativeSearch)
        : null;
    }
    case "deepseek":
    case "openrouter":
      return chat(value, nativeSearch);
    case "typesafe":
      return typesafe(value, nativeSearch);
  }
}

/** Observes provider SSE without retaining emitted content or changing the wire. */
export class UsageObserver {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private bytes = 0;
  private invalid = false;
  private line = "";
  private lineBytes = 0;
  private skipLF = false;
  private eventName = "";
  private dataLines: string[] = [];
  private eventSize = 0;
  private terminal = false;
  private done = false;
  private candidate: Usage | null = null;
  private lastGoogleUsage: unknown = null;
  private googleFinish = false;
  private anthropicStart: AnthropicCounts | null = null;
  private anthropicDelta = false;
  private anthropicSearchObserved = false;
  private openAISearch = new Set<string>();

  constructor(
    private provider: ProviderName,
    private nativeSearch: boolean,
    private cacheWriteHint: CacheWriteHint = "unknown",
  ) {}

  push(chunk: Uint8Array): void {
    if (this.invalid) return;
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_STREAM) {
      this.invalid = true;
      return;
    }
    try {
      this.feed(this.decoder.decode(chunk, { stream: true }));
    } catch {
      this.invalid = true;
    }
  }

  isComplete(): boolean {
    return this.terminal && !this.invalid;
  }

  finish(): Usage | null {
    if (this.invalid) return null;
    try {
      this.feed(this.decoder.decode());
    } catch {
      return null;
    }
    if (this.line) this.processLine(this.line);
    if (this.invalid) return null;
    if (this.dataLines.length || this.eventName) this.dispatch();
    if (this.invalid || !this.terminal) return null;
    if (this.provider === "google") {
      return this.googleFinish
        ? google({ usageMetadata: this.lastGoogleUsage }, this.nativeSearch)
        : null;
    }
    if (this.provider === "anthropic") {
      const final = this.anthropicStart;
      if (!this.anthropicDelta || !final || final.input === null || final.output === null)
        return null;
      if (this.nativeSearch && this.anthropicSearchObserved && final.search === null) return null;
      return usage(
        final.input,
        final.cached,
        final.write5m,
        final.write1h,
        final.output,
        0,
        this.nativeSearch ? (final.search ?? 0) : 0,
      );
    }
    return this.candidate;
  }

  private feed(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.skipLF) {
        this.skipLF = false;
        if (char === "\n") {
          start = i + 1;
          continue;
        }
      }
      if (char !== "\n" && char !== "\r") continue;
      const segment = text.slice(start, i);
      this.line += segment;
      this.lineBytes += encoder.encode(segment).byteLength;
      if (this.lineBytes + this.eventSize > MAX_EVENT) {
        this.invalid = true;
        return;
      }
      this.processLine(this.line, this.lineBytes);
      this.line = "";
      this.lineBytes = 0;
      if (this.invalid) return;
      this.skipLF = char === "\r";
      start = i + 1;
    }
    const segment = text.slice(start);
    this.line += segment;
    this.lineBytes += encoder.encode(segment).byteLength;
    if (this.lineBytes + this.eventSize > MAX_EVENT) this.invalid = true;
  }

  private processLine(line: string, size = encoder.encode(line).byteLength): void {
    if (!line) {
      this.dispatch();
      return;
    }
    if (this.done && line.trim() !== "" && !line.startsWith(":")) {
      this.invalid = true;
      return;
    }
    this.eventSize += size + 2;
    if (this.eventSize > MAX_EVENT) {
      this.invalid = true;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "event") this.eventName = value;
    else if (name === "data") this.dataLines.push(value);
  }

  private dispatch(): void {
    const name = this.eventName;
    const raw = this.dataLines.join("\n");
    this.eventName = "";
    this.dataLines = [];
    this.eventSize = 0;
    if (!raw) return;
    if (this.done) {
      this.invalid = true;
      return;
    }
    if (raw === "[DONE]") {
      this.done = true;
      if (this.provider === "deepseek" || this.provider === "openrouter") this.terminal = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.invalid = true;
      return;
    }
    const type = field(value, "type") ?? name;
    if (type === "error") {
      this.invalid = true;
      return;
    }
    switch (this.provider) {
      case "openai": {
        if (type === "response.output_item.done" && this.nativeSearch) {
          const item = field(value, "item");
          if (
            field(item, "type") === "web_search_call" &&
            field(field(item, "action"), "type") === "search"
          ) {
            const id = field(item, "id");
            if (typeof id !== "string" || !id) {
              this.invalid = true;
              return;
            }
            this.openAISearch.add(id);
          }
        }
        if (
          type === "response.completed" ||
          type === "response.incomplete" ||
          type === "response.failed"
        ) {
          this.terminal = true;
          const response = field(value, "response");
          this.candidate =
            field(response, "status") === String(type).slice("response.".length)
              ? openAI(response, this.nativeSearch, this.openAISearch)
              : null;
        }
        break;
      }
      case "anthropic": {
        if (type === "message_start") {
          this.anthropicStart = anthCounts(
            field(field(value, "message"), "usage"),
            this.cacheWriteHint,
          );
          if (!this.anthropicStart || this.anthropicStart.input === null) this.invalid = true;
        } else if (
          type === "content_block_start" &&
          this.nativeSearch &&
          field(field(value, "content_block"), "type") === "server_tool_use" &&
          field(field(value, "content_block"), "name") === "web_search"
        ) {
          this.anthropicSearchObserved = true;
        } else if (type === "message_delta") {
          const delta = anthCounts(field(value, "usage"), this.cacheWriteHint);
          if (!delta || !this.anthropicStart) {
            this.invalid = true;
            return;
          }
          this.anthropicDelta = true;
          if (delta.input !== null) this.anthropicStart.input = delta.input;
          if (delta.output !== null) this.anthropicStart.output = delta.output;
          if (field(field(value, "usage"), "cache_read_input_tokens") !== undefined)
            this.anthropicStart.cached = delta.cached;
          if (field(field(value, "usage"), "cache_creation_input_tokens") !== undefined) {
            this.anthropicStart.write5m = delta.write5m;
            this.anthropicStart.write1h = delta.write1h;
          }
          if (delta.search !== null) this.anthropicStart.search = delta.search;
        } else if (type === "message_stop") this.terminal = true;
        break;
      }
      case "google": {
        if (field(value, "error") !== undefined) {
          this.invalid = true;
          return;
        }
        if (field(value, "usageMetadata") !== undefined)
          this.lastGoogleUsage = field(value, "usageMetadata");
        const candidates = field(value, "candidates");
        if (
          Array.isArray(candidates) &&
          candidates.some(
            (item) =>
              typeof field(item, "finishReason") === "string" &&
              field(item, "finishReason") !== "FINISH_REASON_UNSPECIFIED",
          )
        ) {
          this.googleFinish = true;
          this.terminal = true;
        }
        break;
      }
      case "deepseek":
      case "openrouter": {
        if (field(value, "error") !== undefined) {
          this.invalid = true;
          return;
        }
        if (field(value, "usage") !== undefined && field(value, "usage") !== null) {
          this.candidate = chat(value, this.nativeSearch);
        }
        break;
      }
      case "typesafe":
        this.invalid = true;
    }
  }
}
