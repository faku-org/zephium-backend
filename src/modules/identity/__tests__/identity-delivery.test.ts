import { expect, test } from "bun:test";
import { retryAfterSeconds } from "../../../platform/abuse";
import { readConfig } from "../../../platform/config";
import { AppError } from "../../../platform/errors";
import { boundedMailer, resendMailer } from "../auth";

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
