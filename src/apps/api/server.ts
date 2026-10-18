import { AppError, errorResponse } from "../../platform/errors";
import { markIncomingStart, readIncomingBody } from "../../platform/incoming-body";

type App = { fetch(request: Request): Response | Promise<Response> };
/** Real HTTP boundary shared by production and native smoke tests. */
export function createApiServer(
  build: (peerAddress: (request: Request) => string) => App,
  port: number,
  hostname = "0.0.0.0",
) {
  const peers = new WeakMap<Request, string>();
  let incoming = 0;
  let server: Bun.Server<undefined>;
  const app = build(
    (request) => peers.get(request) ?? server.requestIP(request)?.address ?? "unknown",
  );
  server = Bun.serve<undefined>({
    port,
    hostname,
    maxRequestBodySize: 8 * 1024 * 1024,
    idleTimeout: 15,
    async fetch(request, owner) {
      if (incoming >= 16) return errorResponse(new AppError("server_busy", 503));
      incoming++;
      const startedAt = performance.now();
      let forwarded = request;
      try {
        const path = new URL(request.url).pathname;
        const generation =
          request.method === "POST" &&
          (["/openai/", "/anthropic/", "/google/", "/openrouter/", "/deepseek/"].some((p) =>
            path.startsWith(p),
          ) ||
            path === "/v1/systemone");
        const peer = owner.requestIP(request)?.address ?? "unknown";
        if (request.body) {
          const bytes = await readIncomingBody(
            request,
            generation ? (path === "/v1/systemone" ? 81920 : 8 * 1024 * 1024) : 1024 * 1024,
          );
          const headers = new Headers(request.headers);
          headers.delete("transfer-encoding");
          headers.set("content-length", String(bytes.length));
          forwarded = new Request(request, { body: new Uint8Array(bytes), headers });
        }
        // The peer belongs to the socket, not a caller-controlled header; preserve it across body normalization.
        peers.set(forwarded, peer);
        markIncomingStart(forwarded, startedAt);
        if (generation) owner.timeout(request, 0);
        return await app.fetch(forwarded);
      } catch (error) {
        return errorResponse(error instanceof AppError ? error : new AppError("unavailable", 503));
      } finally {
        peers.delete(forwarded);
        incoming--;
      }
    },
  });
  return server;
}
