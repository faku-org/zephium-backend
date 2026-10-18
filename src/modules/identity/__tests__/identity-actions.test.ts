import { afterAll, beforeAll, expect, test } from "bun:test";
import { testDatabase } from "../../../../tests/support/database";
import { AppError } from "../../../platform/errors";
import { consumeActionCode, requestActionCode } from "../actions";
import type { Mailer } from "../auth";
import { eligibilityKey } from "../eligibility";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const delivered = new Map<string, { code: string; purpose?: string }>();
const mailer: Mailer = {
  sendOTP: async (email, code, purpose) => {
    delivered.set(email, { code, purpose });
  },
};
beforeAll(async () => {
  fixture = await testDatabase();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});
async function account() {
  const id = crypto.randomUUID();
  const email = `${id}@example.test`;
  const key = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, email);
  await fixture.db
    .sql`INSERT INTO email_eligibility(key,welcome_claimed_at,free_anchor,free_period_end)
    VALUES (${key},clock_timestamp()-interval '1 day',clock_timestamp()-interval '2 days',clock_timestamp()+interval '5 days')`;
  await fixture.db.sql`INSERT INTO auth_user(id,name,email,email_verified,eligibility_key)
    VALUES (${id},'Test User',${email},true,${key})`;
  return { id, email, key };
}
function otherCode(code: string) {
  return code === "000000" ? "111111" : "000000";
}

test("deletion code is owner and purpose bound, hashed, one-use, and seals atomically", async () => {
  const user = await account();
  const other = await account();
  await fixture.db.sql`INSERT INTO auth_session(id,token,user_id,expires_at)
    VALUES (${crypto.randomUUID()},${crypto.randomUUID()},${user.id},clock_timestamp()+interval '1 day')`;
  await requestActionCode(fixture.config, fixture.db, mailer, {
    userId: user.id,
    purpose: "deletion",
  });
  const sent = delivered.get(user.email);
  expect(sent?.purpose).toBe("deletion");
  expect(sent?.code).toMatch(/^\d{6}$/);
  const [stored] = await fixture.db
    .sql`SELECT destination_key,otp_hash,attempts FROM action_otp WHERE owner_user_id=${user.id}`;
  expect(String(stored?.otp_hash)).not.toContain(sent?.code);
  expect(String(stored?.destination_key)).not.toContain(user.email);
  await expect(
    consumeActionCode(fixture.config, fixture.db, {
      userId: other.id,
      purpose: "deletion",
      otp: sent?.code as string,
    }),
  ).rejects.toMatchObject({ code: "invalid_code" });
  await expect(
    consumeActionCode(fixture.config, fixture.db, {
      userId: user.id,
      purpose: "deletion",
      otp: otherCode(sent?.code as string),
    }),
  ).rejects.toMatchObject({ code: "invalid_code" });
  expect(
    (await fixture.db.sql`SELECT attempts FROM action_otp WHERE owner_user_id=${user.id}`)[0]
      ?.attempts,
  ).toBe(1);
  await expect(
    consumeActionCode(
      fixture.config,
      fixture.db,
      { userId: user.id, purpose: "deletion", otp: sent?.code as string },
      async () => {
        throw new Error("rollback effect");
      },
    ),
  ).rejects.toThrow("rollback effect");
  expect(
    (await fixture.db.sql`SELECT otp_hash FROM action_otp WHERE owner_user_id=${user.id}`).length,
  ).toBe(1);
  await consumeActionCode(
    fixture.config,
    fixture.db,
    { userId: user.id, purpose: "deletion", otp: sent?.code as string },
    async (tx) => {
      await tx`UPDATE auth_user SET lifecycle='deleting' WHERE id=${user.id}`;
      await tx`DELETE FROM auth_session WHERE user_id=${user.id}`;
    },
  );
  expect(
    (await fixture.db.sql`SELECT lifecycle FROM auth_user WHERE id=${user.id}`)[0]?.lifecycle,
  ).toBe("deleting");
  expect((await fixture.db.sql`SELECT id FROM auth_session WHERE user_id=${user.id}`).length).toBe(
    0,
  );
  expect(
    (await fixture.db.sql`SELECT otp_hash FROM action_otp WHERE owner_user_id=${user.id}`).length,
  ).toBe(0);
  await expect(
    consumeActionCode(fixture.config, fixture.db, {
      userId: user.id,
      purpose: "deletion",
      otp: sent?.code as string,
    }),
  ).rejects.toMatchObject({ code: "invalid_code" });
});

test("email-change code proves destination and carries current eligibility history to aliases", async () => {
  const user = await account();
  const target = `${crypto.randomUUID()}@example.test`;
  const wrong = `${crypto.randomUUID()}@example.test`;
  await requestActionCode(fixture.config, fixture.db, mailer, {
    userId: user.id,
    purpose: "email-change",
    destinationEmail: target,
  });
  const code = delivered.get(target)?.code as string;
  expect(delivered.get(target)?.purpose).toBe("email-change");
  await expect(
    consumeActionCode(
      fixture.config,
      fixture.db,
      { userId: user.id, purpose: "email-change", destinationEmail: wrong, otp: code },
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "invalid_code" });
  await consumeActionCode(
    fixture.config,
    fixture.db,
    { userId: user.id, purpose: "email-change", destinationEmail: target, otp: code },
    async (tx) => {
      await tx`UPDATE auth_user SET email=${target},email_verified=true WHERE id=${user.id}`;
    },
  );
  const [changed] = await fixture.db
    .sql`SELECT email,eligibility_key FROM auth_user WHERE id=${user.id}`;
  expect(changed?.email).toBe(target);
  expect(changed?.eligibility_key).toBe(user.key);
  const alias = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, target);
  const [before] = await fixture.db
    .sql`SELECT welcome_claimed_at,free_anchor,free_period_end FROM email_eligibility WHERE key=${alias}`;
  expect(before?.welcome_claimed_at).toBeTruthy();
  expect(before?.free_anchor).toBeTruthy();
  expect(before?.free_period_end).toBeTruthy();
  await fixture.db
    .sql`UPDATE email_eligibility SET free_period_end=clock_timestamp()+interval '9 days' WHERE key=${user.key}`;
  await requestActionCode(fixture.config, fixture.db, mailer, {
    userId: user.id,
    purpose: "deletion",
  });
  const deletionCode = delivered.get(target)?.code as string;
  await consumeActionCode(fixture.config, fixture.db, {
    userId: user.id,
    purpose: "deletion",
    otp: deletionCode,
  });
  const [after] = await fixture.db
    .sql`SELECT free_period_end FROM email_eligibility WHERE key=${alias}`;
  expect(new Date(after?.free_period_end).getTime()).toBeGreaterThan(
    new Date(before?.free_period_end).getTime(),
  );
});

test("email change refuses a destination with independent eligibility history", async () => {
  const source = await account();
  const destination = await account();
  await requestActionCode(fixture.config, fixture.db, mailer, {
    userId: source.id,
    purpose: "email-change",
    destinationEmail: destination.email,
  });
  const code = delivered.get(destination.email)?.code;
  if (!code) throw new Error("Missing destination code");
  await expect(
    consumeActionCode(
      fixture.config,
      fixture.db,
      {
        userId: source.id,
        purpose: "email-change",
        destinationEmail: destination.email,
        otp: code,
      },
      async (tx) => {
        await tx`UPDATE auth_user SET email=${destination.email} WHERE id=${source.id}`;
      },
    ),
  ).rejects.toMatchObject({ code: "eligibility_conflict", status: 409 });
  expect((await fixture.db.sql`SELECT email FROM auth_user WHERE id=${source.id}`)[0]?.email).toBe(
    source.email,
  );
  expect(
    (await fixture.db.sql`SELECT otp_hash FROM action_otp WHERE owner_user_id=${source.id}`).length,
  ).toBe(1);
  expect(
    (
      await fixture.db
        .sql`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${destination.key}`
    ).length,
  ).toBe(0);
});

test("staging allowlist suppresses email change mail and rejects previously issued destination codes", async () => {
  const user = await account();
  const target = `${crypto.randomUUID()}@example.test`;
  await requestActionCode(fixture.config, fixture.db, mailer, {
    userId: user.id,
    purpose: "email-change",
    destinationEmail: target,
  });
  const code = delivered.get(target)?.code as string;
  const config = { ...fixture.config, SIGNUP_EMAIL_ALLOWLIST: user.email };
  await expect(
    consumeActionCode(
      config,
      fixture.db,
      { userId: user.id, purpose: "email-change", destinationEmail: target, otp: code },
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "invalid_code", status: 401 });
  const other = await account();
  const denied = `${crypto.randomUUID()}@example.test`;
  await requestActionCode(config, fixture.db, mailer, {
    userId: other.id,
    purpose: "email-change",
    destinationEmail: denied,
  });
  expect(delivered.has(denied)).toBe(false);
  expect(
    (await fixture.db.sql`SELECT otp_hash FROM action_otp WHERE owner_user_id=${other.id}`).length,
  ).toBe(0);
  // Restricting sign-in must not trap an existing account's deletion flow.
  await requestActionCode(config, fixture.db, mailer, { userId: other.id, purpose: "deletion" });
  expect(delivered.get(other.email)?.purpose).toBe("deletion");
});

test("failed action mail preserves provider retry and removes its code", async () => {
  const user = await account();
  await expect(
    requestActionCode(
      fixture.config,
      fixture.db,
      {
        sendOTP: async () => {
          throw new AppError("email_unavailable", 503, 41);
        },
      },
      { userId: user.id, purpose: "deletion" },
    ),
  ).rejects.toMatchObject({ code: "email_unavailable", status: 503, retryAfter: 41 });
  expect(
    (await fixture.db.sql`SELECT otp_hash FROM action_otp WHERE owner_user_id=${user.id}`).length,
  ).toBe(0);
});
