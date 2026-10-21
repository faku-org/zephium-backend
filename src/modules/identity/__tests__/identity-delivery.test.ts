import { expect, test } from "bun:test";
import { retryAfterSeconds } from "../../../platform/abuse";
import { readConfig } from "../../../platform/config";
import { AppError } from "../../../platform/errors";
import { boundedMailer, resendMailer } from "../auth";
import { otpEmailLogo } from "../emails/otp";

const config = () =>
  readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/test",
    AUTH_SECRET: "a".repeat(40),
    ABUSE_SECRET: "b".repeat(40),
    RESEND_API_KEY: "test",
  });

test("provider retry accepts seconds and HTTP dates, with safe invalid-header fallback", () => {
  const now = Date.parse("2026-10-18T10:00:00Z");
  expect(retryAfterSeconds("17", now)).toBe(17);
  expect(retryAfterSeconds("17.1", now)).toBe(18);
  expect(retryAfterSeconds("Sun, 18 Oct 2026 10:00:31 GMT", now)).toBe(31);
  expect(retryAfterSeconds("garbage", now)).toBeUndefined();
  expect(retryAfterSeconds(null, now)).toBeUndefined();
  expect(retryAfterSeconds("", now)).toBeUndefined();
});

test("Resend throttling establishes a shared cooldown for all mail purposes without retrying plaintext", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return new Response("private provider response", {
      status: 429,
      headers: { "Retry-After": "23" },
    });
  };
  const mailer = resendMailer(config(), transport);
  await expect(mailer.sendOTP("test@example.test", "123456", "sign-in")).rejects.toMatchObject({
    code: "email_unavailable",
    status: 503,
    retryAfter: 23,
  });
  try {
    await mailer.sendOTP("other@example.test", "654321", "deletion");
    throw new Error("Unexpected delivery");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).retryAfter).toBeGreaterThan(0);
    expect((error as AppError).retryAfter).toBeLessThanOrEqual(23);
  }
  expect(calls).toBe(1);
});

test("mailer bounds work across action purposes and frees capacity after completion", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const mailer = boundedMailer(
    {
      sendOTP: async () => {
        calls++;
        await pending;
      },
    },
    1,
  );
  const first = mailer.sendOTP("test@example.test", "123456", "sign-in");
  await expect(
    mailer.sendOTP("other@example.test", "654321", "email-change"),
  ).rejects.toMatchObject({ code: "email_unavailable", retryAfter: 1 });
  release();
  await first;
  await mailer.sendOTP("other@example.test", "654321", "deletion");
  expect(calls).toBe(2);
});

test("allowlist validates exact email entries and bounded delivery configuration", () => {
  const base = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost/test",
    AUTH_SECRET: "a".repeat(40),
    ABUSE_SECRET: "b".repeat(40),
  };
  expect(
    readConfig({ ...base, SIGNUP_EMAIL_ALLOWLIST: " First+tag@Example.test,second@example.test " })
      .SIGNUP_EMAIL_ALLOWLIST,
  ).toContain("First+tag");
  expect(() => readConfig({ ...base, SIGNUP_EMAIL_ALLOWLIST: "*@example.test" })).toThrow();
  expect(() => readConfig({ ...base, EMAIL_MAX_IN_FLIGHT: "0" })).toThrow();
  expect(() => readConfig({ ...base, EMAIL_MAX_IN_FLIGHT: "17" })).toThrow();
});

test("Resend delivers the complete purpose-specific multipart payload through the existing adapter", async () => {
  const deliveries: { url: string; init: RequestInit }[] = [];
  const mailer = resendMailer(config(), async (url, init) => {
    deliveries.push({ url, init });
    return new Response(null, { status: 202 });
  });
  const purposes = [undefined, "sign-in", "email-change", "deletion"] as const;
  const instructions = [
    "sign in or finish creating your account",
    "sign in or finish creating your account",
    "verify your new email address and confirm the change",
    "Enter this code in Zephium to permanently delete your account.",
  ];
  for (const purpose of purposes) {
    await mailer.sendOTP("recipient@example.test", "012345", purpose);
  }
  expect(deliveries).toHaveLength(purposes.length);
  for (const [index, { url, init }] of deliveries.entries()) {
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    const payload = JSON.parse(init.body as string);
    expect(Object.keys(payload).sort()).toEqual([
      "attachments",
      "from",
      "html",
      "subject",
      "text",
      "to",
    ]);
    expect(payload.attachments).toEqual([otpEmailLogo]);
    expect(payload.html).toContain(`src="cid:${otpEmailLogo.content_id}"`);
    expect(payload.from).toBe(config().EMAIL_FROM);
    expect(payload.to).toBe("recipient@example.test");
    expect(payload.subject).toBe("Your Zephium code is 012345");
    expect(payload.text.split("\n")[0]).toBe(payload.subject);
    expect(payload.text).toContain(instructions[index]);
    expect(payload.html).toContain(instructions[index]);
    expect(payload.html).not.toContain("recipient@example.test");
    expect(payload.html).toContain("<title>Your Zephium code is 012345</title>");
  }
  const keys = deliveries.map(({ init }) => new Headers(init.headers).get("Idempotency-Key"));
  expect(new Set(keys).size).toBe(deliveries.length);
});

test("invalid email template input fails closed before reaching Resend", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return new Response(null, { status: 202 });
  };
  for (const [otp, purpose] of [
    ["<script>", "sign-in"],
    ["123456\n", "deletion"],
    ["012345", "unsupported"],
  ] as const) {
    // Separate mailers avoid the shared cooldown intentionally established on failure.
    const mailer = resendMailer(config(), transport);
    await expect(
      mailer.sendOTP("recipient@example.test", otp, purpose as "sign-in"),
    ).rejects.toMatchObject({ code: "email_unavailable", status: 503 });
  }
  expect(calls).toBe(0);
});
