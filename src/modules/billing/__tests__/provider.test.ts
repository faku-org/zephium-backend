import { afterAll, expect, test } from "bun:test";
import { boundedBillingFetch } from "../provider";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/large") return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
    if (path === "/redirect")
      return new Response(null, { status: 302, headers: { location: "/ok" } });
    return Response.json({ ok: true });
  },
});
afterAll(async () => {
  await server.stop();
});
test("provider transport enforces decoded size, redirects and caller cancellation", async () => {
  const base = `http://127.0.0.1:${server.port}`;
  expect(await (await boundedBillingFetch(`${base}/ok`)).json()).toEqual({ ok: true });
  await expect(boundedBillingFetch(`${base}/large`)).rejects.toThrow();
  await expect(boundedBillingFetch(`${base}/redirect`)).rejects.toThrow();
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    boundedBillingFetch(`${base}/ok`, { signal: cancellation.signal }),
  ).rejects.toThrow();
});
