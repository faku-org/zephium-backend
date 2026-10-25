import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "../../src/apps/api/app";
import { requestActionCode } from "../../src/modules/identity/actions";
import { createAuth, type Mailer } from "../../src/modules/identity/auth";
import { admitEmailSend, limitSignInSend } from "../../src/modules/identity/email-limits";
import { AppError } from "../../src/platform/errors";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

test("parallel send admissions share a /64 bucket and retain only HMACs", async () => {
  const config = { ...fixture.config, OTP_SENDS_PER_NETWORK_PER_15_MIN: 3 };
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      limitSignInSend(config, fixture.db, `2001:db8:aaaa::${i + 1}`),
    ),
  );
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  for (const result of attempts)
    if (result.status === "rejected") {
      expect(result.reason).toBeInstanceOf(AppError);
      expect(result.reason.status).toBe(429);
      expect(result.reason.retryAfter).toBeGreaterThan(0);
      expect(result.reason.retryAfter).toBeLessThanOrEqual(900);
    }
  await limitSignInSend(config, fixture.db, "2001:db8:aaab::1");
  const rows = await fixture.db.sql`SELECT key FROM abuse_bucket`;
  expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.key))).toBe(true);
});

test("parallel admissions share one atomic delivery limit across callers", async () => {
  const config = { ...fixture.config, EMAIL_SENDS_PER_MINUTE: 3 };
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => admitEmailSend(config, fixture.db)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  for (const result of results)
    if (result.status === "rejected") {
      expect(result.reason).toMatchObject({ status: 429, code: "rate_limited" });
    }
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=clock_timestamp()-interval '1 second'`;
  await admitEmailSend(config, fixture.db);
});

test("network throttling precedes account lookup and suppresses delivery with Retry-After", async () => {
  let deliveries = 0;
  const config = {
    ...fixture.config,
    OTP_SENDS_PER_NETWORK_PER_15_MIN: 3,
    SIGNUP_EMAIL_ALLOWLIST: "allowed@example.test",
  };
  const mailer: Mailer = {
    sendOTP: async () => {
      deliveries++;
    },
  };
  const app = createApp(
    config,
    fixture.db,
    createAuth(config, fixture.db, mailer),
    {
      state: async () => null,
      checkout: async () => {
        throw new Error("unused");
      },
      portal: async () => {
        throw new Error("unused");
      },
      deleteCustomer: async () => {},
      openCheckoutUntil: async () => null,
    },
    () => "198.51.100.190",
    undefined,
    mailer,
  );
  const send = (email: string) =>
    app.request("http://localhost:3000/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
  for (let i = 0; i < 3; i++) expect((await send(`uninvited${i}@example.test`)).status).toBe(202);
  const denied = await send("allowed@example.test");
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(await denied.json()).toMatchObject({ error: { code: "rate_limited" } });
  expect(deliveries).toBe(0);
});

test("closed signup does not disclose account existence when the shared send budget is exhausted", async () => {
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=clock_timestamp()-interval '1 second'`;
  const id = crypto.randomUUID();
  await fixture.db.sql`INSERT INTO auth_user(id,name,email,email_verified,created_at,updated_at)
    VALUES (${id},'','existing@example.test',true,now(),now())`;
  let sent = 0;
  const config = { ...fixture.config, SIGNUP_OPEN: "false" as const, EMAIL_SENDS_PER_MINUTE: 1 };
  const mailer: Mailer = {
    sendOTP: async () => {
      sent++;
    },
  };
  const app = createApp(
    config,
    fixture.db,
    createAuth(config, fixture.db, mailer),
    {
      state: async () => null,
      checkout: async () => {
        throw new Error("unused");
      },
      portal: async () => {
        throw new Error("unused");
      },
      deleteCustomer: async () => {},
      openCheckoutUntil: async () => null,
    },
    () => "198.51.100.191",
    undefined,
    mailer,
  );
  const send = (email: string) =>
    app.request("http://localhost:3000/api/auth/email-otp/send-verification-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    });
  // A suppressed request consumes the same shared budget as an actual send.
  expect((await send("suppressed@example.test")).status).toBe(202);
  for (const email of ["existing@example.test", "unknown@example.test"]) {
    const response = await send(email);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  }
  expect(sent).toBe(0);
});

test("deletion and email-change sends obey the same budget before creating codes", async () => {
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=clock_timestamp()-interval '1 second'`;
  const config = { ...fixture.config, EMAIL_SENDS_PER_MINUTE: 1 };
  await admitEmailSend(config, fixture.db);
  let sent = 0;
  for (const purpose of ["deletion", "email-change"] as const) {
    await expect(
      requestActionCode(
        config,
        fixture.db,
        {
          sendOTP: async () => {
            sent++;
          },
        },
        {
          userId: crypto.randomUUID(),
          purpose,
          ...(purpose === "email-change" ? { destinationEmail: "new@example.test" } : {}),
        },
      ),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  }
  expect(sent).toBe(0);
  const [row] = await fixture.db.sql`SELECT count(*)::integer AS n FROM action_otp`;
  expect(row?.n).toBe(0);
});
