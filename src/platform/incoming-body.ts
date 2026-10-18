import { AppError } from "./errors";

const starts = new WeakMap<Request, number>();
/** Internal socket receipt time; caller headers cannot reset the upload budget. */
export function markIncomingStart(request: Request, at = performance.now()): void {
  if (!starts.has(request)) starts.set(request, at);
}
export function incomingStart(request: Request): number {
  return starts.get(request) ?? performance.now();
}
/** Read deadlines cover chunked/slow uploads before the streaming route disables socket idling. */
export async function readIncomingBody(
  request: Request,
  maximum: number,
  timeoutMs = 15000,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0,
    expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (expired || request.signal.aborted) throw new AppError("request_timeout", 408);
      if (part.done) break;
      size += part.value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new AppError("body_too_large", 413);
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
