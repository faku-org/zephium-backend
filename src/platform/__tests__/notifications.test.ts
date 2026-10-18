import { expect, test } from "bun:test";
import { sendOperationalNotification } from "../notifications";

const telegram = "https://api.telegram.org/botprivate-token/sendMessage?chat_id=-123&text=old";
const failureMessage = "Operational notification failed";
type Fetcher = NonNullable<Parameters<typeof sendOperationalNotification>[2]>;
const responder =
  (response: Response): Fetcher =>
  async () =>
    response;

test("Telegram delivery moves the destination to JSON and requires API success", async () => {
  let called = false;
  const fetcher: Fetcher = async (input, init) => {
    called = true;
    const url = new URL(String(input));
    expect(url.searchParams.has("chat_id")).toBe(false);
    expect(url.searchParams.has("text")).toBe(false);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Attention needed",
      chat_id: "-123",
      link_preview_options: { is_disabled: true },
    });
    expect(init?.signal?.aborted).toBe(false);
    return Response.json({ ok: true, result: { message_id: 123 } });
  };
  await sendOperationalNotification(telegram, "Attention needed", fetcher);
  expect(called).toBe(true);
});

test("Telegram HTTP 200 with API failure is rejected without response details", async () => {
  await expect(
    sendOperationalNotification(
      telegram,
      "Attention needed",
      responder(Response.json({ ok: false, description: "private-token private-body" })),
    ),
  ).rejects.toThrow(failureMessage);
});

test("Telegram needs a configured chat_id before any request", async () => {
  let calls = 0;
  const fetcher: Fetcher = async () => {
    calls++;
    return Response.json({ ok: true });
  };
  for (const query of ["", "?chat_id=", "?chat_id=%20"]) {
    await expect(
      sendOperationalNotification(
        `https://api.telegram.org/botprivate-token/sendMessage${query}`,
        "Attention needed",
        fetcher,
      ),
    ).rejects.toThrow(failureMessage);
  }
  expect(calls).toBe(0);
});

test("Telegram rejects invalid JSON and nonboolean or missing success", async () => {
  for (const body of ["private-body", "null", '"ok"', "{}", '{"ok":"true"}']) {
    await expect(
      sendOperationalNotification(telegram, "Attention needed", responder(new Response(body))),
    ).rejects.toThrow(failureMessage);
  }
});

test("Telegram response reads are limited to 16 KiB and cancel an oversized stream", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    sendOperationalNotification(telegram, "Attention needed", responder(new Response(body))),
  ).rejects.toThrow(failureMessage);
  expect(cancelled).toBe(true);
});

test("Telegram body consumption shares the five-second delivery deadline", async () => {
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher: Fetcher = async (_input, init) => {
    signal = init?.signal;
    return new Response(body);
  };
  const started = performance.now();
  await expect(sendOperationalNotification(telegram, "Attention needed", fetcher)).rejects.toThrow(
    failureMessage,
  );
  expect(performance.now() - started).toBeLessThan(6000);
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
}, 7000);

test("HTTP errors and redirects fail for Telegram and generic destinations", async () => {
  for (const destination of [telegram, "https://hooks.example.test/private-token"]) {
    for (const status of [302, 400, 429, 500]) {
      await expect(
        sendOperationalNotification(
          destination,
          "Attention needed",
          responder(new Response("private-body", { status })),
        ),
      ).rejects.toThrow(failureMessage);
    }
  }
});

test("generic HTTPS webhooks retain their HTTP success contract and cancel response bodies", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const destination = "https://hooks.example.test/private-token?text=original";
  const fetcher: Fetcher = async (input, init) => {
    expect(String(input)).toBe(destination);
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Attention needed" });
    return new Response(body);
  };
  await sendOperationalNotification(destination, "Attention needed", fetcher);
  expect(cancelled).toBe(true);
  await sendOperationalNotification(
    destination,
    "Attention needed",
    responder(new Response(null, { status: 204 })),
  );
});

test("invalid destinations and provider exceptions never expose URL, token or body", async () => {
  const fetcher: Fetcher = async () => {
    throw new Error(`${telegram} private-body`);
  };
  for (const destination of [
    telegram,
    "http://hooks.example.test/private-token",
    "private-token",
  ]) {
    let thrown: unknown;
    try {
      await sendOperationalNotification(destination, "private-body", fetcher);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(failureMessage);
    expect((thrown as Error).cause).toBeUndefined();
    expect(String(thrown)).not.toContain("private-token");
    expect(String(thrown)).not.toContain("private-body");
  }
});
