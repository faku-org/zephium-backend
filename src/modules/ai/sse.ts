import { AppError } from "../../platform/errors";

const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/**
 * Finds the last blank-line boundary in SSE bytes. CR at the end of a nonfinal
 * chunk is held because the next byte may be LF; no UTF-8 decoding is needed.
 */
function completePrefix(bytes: Uint8Array, final: boolean): number {
  let lineStart = 0;
  let complete = 0;
  let eventStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== 10 && byte !== 13) continue;
    if (byte === 13 && i + 1 === bytes.length && !final) break;
    const lineLength = i - lineStart;
    let end = i + 1;
    if (byte === 13 && bytes[i + 1] === 10) {
      end++;
      i++;
    }
    if (end - eventStart > MAX_EVENT_BYTES) throw new AppError("provider_response_limit", 502);
    if (lineLength === 0) {
      complete = end;
      eventStart = end;
    }
    lineStart = end;
  }
  if (bytes.length - eventStart > MAX_EVENT_BYTES)
    throw new AppError("provider_response_limit", 502);
  return complete;
}

function safeTrailingComments(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() !== "" && !line.startsWith(":")) return false;
  }
  return true;
}

/** Exact byte framing for provider SSE; JSON and usage validation belong elsewhere. */
export class SseFrames {
  private pending = new Uint8Array(0);
  private finished = false;

  push(chunk: Uint8Array): Uint8Array | null {
    if (this.finished) throw new AppError("invalid_provider_response", 502);
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const complete = completePrefix(joined, false);
    if (joined.length - complete > MAX_EVENT_BYTES)
      throw new AppError("provider_response_limit", 502);
    this.pending = joined.slice(complete);
    return complete ? joined.slice(0, complete) : null;
  }

  finish(): { tail: Uint8Array | null; truncated: boolean } {
    if (this.finished) throw new AppError("invalid_provider_response", 502);
    this.finished = true;
    const bytes = this.pending;
    this.pending = new Uint8Array(0);
    const complete = completePrefix(bytes, true);
    const remainder = bytes.subarray(complete);
    const safe = safeTrailingComments(remainder);
    const length = safe ? bytes.length : complete;
    return {
      tail: length ? bytes.slice(0, length) : null,
      truncated: !safe,
    };
  }
}
