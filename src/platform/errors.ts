export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}
/** Only stable codes and real admitted request IDs belong in public errors. */
export function errorBody(error: AppError, requestId: string | null = null) {
  return {
    error: {
      code: error.code,
      ...(error.retryAfter === undefined
        ? {}
        : { retry_after: Math.max(1, Math.ceil(error.retryAfter)) }),
    },
    request_id: requestId,
  };
}
export function errorResponse(
  error: AppError,
  requestId: string | null = null,
  headers = new Headers(),
) {
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  if (error.retryAfter !== undefined)
    headers.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfter))));
  if (requestId) headers.set("X-Zephium-Request-Id", requestId);
  return new Response(JSON.stringify(errorBody(error, requestId)), {
    status: error.status,
    headers,
  });
}
/** Never serialize provider errors: they may contain credentials or customer data. */
export function operationalEvent(event: string): void {
  console.error(JSON.stringify({ event, time: new Date().toISOString() }));
}
