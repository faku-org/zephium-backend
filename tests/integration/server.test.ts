import { expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { createApiServer } from "../../src/apps/api/server";

const encoder = new TextEncoder();
const loopback = "127.0.0.1";
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, loopback, resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

test("real chunked POST keeps the socket peer and enforces the exact SystemOne body cap", async () => {
  const server = createApiServer(
    (peerAddress) => ({
      async fetch(request) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        return Response.json({
          peer: peerAddress(request),
          length: bytes.length,
          contentLength: request.headers.get("content-length"),
          transferEncoding: request.headers.get("transfer-encoding"),
        });
      },
    }),
    await freePort(),
    loopback,
  );
  const url = `http://${loopback}:${server.port}/v1/systemone`;
  const post = (size: number): Promise<{ status: number | undefined; body: unknown }> => {
    const payload = encoder.encode("x".repeat(size));
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            "x-forwarded-for": "203.0.113.42",
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
      request.once("error", reject);
      request.write(payload.subarray(0, 17));
      request.end(payload.subarray(17));
    });
  };
  try {
    const accepted = await post(81_920);
    expect(accepted.status).toBe(200);
    const value = accepted.body as Record<string, unknown>;
    expect(value.length).toBe(81_920);
    expect(value.contentLength).toBe("81920");
    expect(value.transferEncoding).toBeNull();
    expect(String(value.peer)).toContain(loopback);
    expect(value.peer).not.toBe("203.0.113.42");

    const rejected = await post(81_921);
    expect(rejected.status).toBe(413);
    expect(rejected.body).toEqual({ error: { code: "body_too_large" }, request_id: null });
  } finally {
    await server.stop(true);
  }
});

test("real HTTP SSE releases its first chunk before the producer finishes", async () => {
  let releaseFinal!: () => void;
  const finalGate = new Promise<void>((resolve) => {
    releaseFinal = resolve;
  });
  let finalReleased = false;
  const server = createApiServer(
    () => ({
      fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: first\n\n"));
              void finalGate.then(() => {
                controller.enqueue(encoder.encode("data: final\n\n"));
                controller.close();
              });
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
        );
      },
    }),
    await freePort(),
    loopback,
  );
  try {
    const response = await fetch(`http://${loopback}:${server.port}/openai/v1/responses`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing HTTP response stream");
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("data: first\n\n");
    expect(finalReleased).toBe(false);
    finalReleased = true;
    releaseFinal();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("data: final\n\n");
    expect((await reader.read()).done).toBe(true);
  } finally {
    releaseFinal();
    await server.stop(true);
  }
});
