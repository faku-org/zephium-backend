import { expect, test } from "bun:test";
import { Hono } from "hono";
import { testPolicy } from "../../../../tests/support/cloud-fixture";
import { testDatabase } from "../../../../tests/support/database";
import { usageSummary } from "../../credits/ledger";
import { registerPolicy } from "../../policy/policy";
import { consumeActionCode, requestActionCode } from "../actions";
import { createAuth } from "../auth";
import { eligibilityKey } from "../eligibility";
import { createIdentityRoutes } from "../routes";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}
async function linkedUser(
  db: Awaited<ReturnType<typeof testDatabase>>["db"],
  email: string,
  key: string,
) {
  const id = crypto.randomUUID();
  await db.sql`INSERT INTO auth_user(id,name,email,email_verified,eligibility_key)
    VALUES (${id},'Linked Test',${email},true,${key})`;
  return id;
}

test("one email keeps welcome and free-period history across deletion and re-signup", async () => {
  const fixture = await testDatabase();
  try {
    const base = testPolicy();
    const policy = testPolicy({
      plans: [{ ...required(base.plans[0]), cycle: { kind: "fixed_days", days: 1 } }],
    });
    await registerPolicy(fixture.db, policy);
    const email = `${crypto.randomUUID()}@example.test`;
    const key = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, email);
    // The original one-day period ends in a few seconds, allowing a real rollover test.
    const [clock] = await fixture.db.sql`SELECT clock_timestamp() AS db_now`;
    const anchor = new Date(new Date(clock?.db_now).getTime() - 86400000 + 4000);
    await fixture.db
      .sql`INSERT INTO email_eligibility(key,free_anchor) VALUES (${key},${anchor.toISOString()})`;
    const first = await linkedUser(fixture.db, email, key);
    const firstReads = await Promise.all(
      Array.from({ length: 6 }, () => usageSummary(fixture.db, policy, first)),
    );
    expect(firstReads.every((summary) => summary.credits_remaining === "120")).toBe(true);
    expect(firstReads[0]?.bonus_remaining).toBe("20");
    expect(firstReads[0]?.bonus_expires_at).toBeTruthy();
    const firstGrants = await fixture.db
      .sql`SELECT kind,amount FROM credit_grant WHERE user_id=${first}`;
    expect(firstGrants).toHaveLength(2);
    expect(firstGrants.map((row) => row.kind).sort()).toEqual(["included", "welcome"]);
    const [original] = await fixture.db
      .sql`SELECT welcome_claimed_at,free_anchor,free_period_end FROM email_eligibility WHERE key=${key}`;
    expect(original?.welcome_claimed_at).toBeTruthy();
    expect(new Date(original?.free_anchor).toISOString()).toBe(anchor.toISOString());
    const firstEnd = new Date(original?.free_period_end);
    expect(firstEnd.getTime()).toBeGreaterThan(Date.now());

    await fixture.db.sql`DELETE FROM auth_user WHERE id=${first}`;
    expect((await fixture.db.sql`SELECT key FROM email_eligibility WHERE key=${key}`).length).toBe(
      1,
    );
    const second = await linkedUser(fixture.db, email, key);
    const repeated = await usageSummary(fixture.db, policy, second);
    expect(repeated.credits_remaining).toBe("0");
    expect(repeated.bonus_remaining).toBe("0");
    expect(repeated.bonus_expires_at).toBeNull();
    expect(repeated.allowance.total_units).toBe("0");
    if (repeated.period_end === null) throw new Error("Expected renewable period end");
    expect(new Date(repeated.period_end).toISOString()).toBe(firstEnd.toISOString());
    const [wallet] = await fixture.db.sql`SELECT anchor FROM credit_wallet WHERE user_id=${second}`;
    expect(new Date(wallet?.anchor).toISOString()).toBe(anchor.toISOString());
    expect((await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${second}`).length).toBe(
      0,
    );

    await Bun.sleep(Math.max(0, firstEnd.getTime() - Date.now() + 150));
    const nextPeriod = await usageSummary(fixture.db, policy, second);
    expect(nextPeriod.credits_remaining).toBe("100");
    expect(nextPeriod.bonus_remaining).toBe("0");
    expect(nextPeriod.allowance.total_units).toBe("100");
    const [after] = await fixture.db
      .sql`SELECT free_anchor,free_period_end FROM email_eligibility WHERE key=${key}`;
    expect(new Date(after?.free_anchor).toISOString()).toBe(anchor.toISOString());
    expect(new Date(after?.free_period_end).getTime()).toBeGreaterThan(firstEnd.getTime());
    expect(
      (await fixture.db.sql`SELECT kind FROM credit_grant WHERE user_id=${second}`).map(
        (row) => row.kind,
      ),
    ).toEqual(["included"]);
  } finally {
    await fixture.close();
  }
}, 30000);

test("a disabled cloud policy does not consume welcome or free-period eligibility", async () => {
  const fixture = await testDatabase();
  try {
    const policy = testPolicy({ enabled: false, models: [] });
    await registerPolicy(fixture.db, policy);
    const email = `${crypto.randomUUID()}@example.test`;
    const key = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, email);
    await fixture.db.sql`INSERT INTO email_eligibility(key) VALUES (${key})`;
    const user = await linkedUser(fixture.db, email, key);
    const summary = await usageSummary(fixture.db, policy, user);
    expect(summary.cloud_enabled).toBe(false);
    expect(summary.credits_remaining).toBe("0");
    expect(summary.bonus_remaining).toBe("0");
    const [eligibility] = await fixture.db
      .sql`SELECT welcome_claimed_at,free_anchor,free_period_end FROM email_eligibility WHERE key=${key}`;
    expect(eligibility?.welcome_claimed_at).toBeNull();
    expect(eligibility?.free_anchor).toBeNull();
    expect(eligibility?.free_period_end).toBeNull();
    expect((await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${user}`).length).toBe(
      0,
    );
  } finally {
    await fixture.close();
  }
}, 30000);

test("self-hosted plan grants configured credits without paid billing state", async () => {
  const fixture = await testDatabase();
  try {
    const base = testPolicy();
    const free = required(base.plans[0]);
    const policy = testPolicy({
      selfHostedPlan: "pro",
      plans: [free, { ...free, id: "pro", rank: 1, allowanceUnits: "300" }],
      models: [{ ...required(base.models[0]), plans: ["free", "pro"] }],
    });
    await registerPolicy(fixture.db, policy);
    const email = `${crypto.randomUUID()}@example.test`;
    const key = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, email);
    await fixture.db.sql`INSERT INTO email_eligibility(key) VALUES (${key})`;
    const user = await linkedUser(fixture.db, email, key);
    const [billing] = await fixture.db
      .sql`SELECT status,paid_until FROM billing_customer WHERE user_id=${user}`;
    expect(billing?.status).not.toBe("active");
    expect(billing?.paid_until).toBeNull();
    const summary = await usageSummary(fixture.db, policy, user);
    expect(summary.plan).toBe("pro");
    expect(summary.allowance.total_units).toBe("300");
    expect(summary.credits_remaining).toBe("320");
    const [grant] = await fixture.db
      .sql`SELECT plan_id,amount FROM credit_grant WHERE user_id=${user} AND kind='included'`;
    expect(grant?.plan_id).toBe("pro");
    expect(String(grant?.amount)).toBe("300");
  } finally {
    await fixture.close();
  }
}, 30000);

test("a former email resolves to the canonical history after A to B to C changes", async () => {
  const fixture = await testDatabase();
  try {
    const policy = testPolicy();
    await registerPolicy(fixture.db, policy);
    const a = `${crypto.randomUUID()}@example.test`;
    const b = `${crypto.randomUUID()}@example.test`;
    const c = `${crypto.randomUUID()}@example.test`;
    const root = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, a);
    await fixture.db.sql`INSERT INTO email_eligibility(key) VALUES (${root})`;
    const user = await linkedUser(fixture.db, a, root);
    expect((await usageSummary(fixture.db, policy, user)).credits_remaining).toBe("120");
    const delivered = new Map<string, string>();
    const mailer = {
      sendOTP: async (email: string, code: string) => {
        delivered.set(email, code);
      },
    };
    for (const target of [b, c]) {
      await requestActionCode(fixture.config, fixture.db, mailer, {
        userId: user,
        purpose: "email-change",
        destinationEmail: target,
      });
      const code = delivered.get(target);
      if (!code) throw new Error("Missing action code");
      await consumeActionCode(
        fixture.config,
        fixture.db,
        { userId: user, purpose: "email-change", destinationEmail: target, otp: code },
        async (tx) => {
          await tx`UPDATE auth_user SET email=${target} WHERE id=${user}`;
        },
      );
      if (target === b) {
        await fixture.db
          .sql`UPDATE email_eligibility SET free_period_end=free_period_end+interval '40 days' WHERE key=${root}`;
        await fixture.db
          .sql`UPDATE abuse_bucket SET expires_at=clock_timestamp()-interval '1 second'`;
      }
    }
    const bKey = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, b);
    const [oldSnapshot] = await fixture.db
      .sql`SELECT free_period_end FROM email_eligibility WHERE key=${bKey}`;
    const [canonical] = await fixture.db
      .sql`SELECT free_period_end FROM email_eligibility WHERE key=${root}`;
    expect(new Date(oldSnapshot?.free_period_end).getTime()).toBeLessThan(
      new Date(canonical?.free_period_end).getTime(),
    );
    expect(
      (
        await fixture.db
          .sql`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${bKey}`
      )[0]?.canonical_key,
    ).toBe(root);
    const app = new Hono();
    const auth = createAuth(fixture.config, fixture.db, mailer);
    app.route("/api/auth", createIdentityRoutes(fixture.config, fixture.db, auth));
    const post = (path: string, body: unknown) =>
      app.request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (await post("/email-otp/send-verification-otp", { email: b, type: "sign-in" })).status,
    ).toBe(202);
    let code = delivered.get(b);
    for (let i = 0; !code && i < 200; i++) {
      await Bun.sleep(10);
      code = delivered.get(b);
    }
    if (!code) throw new Error("Missing sign-in code");
    const signedIn = await post("/sign-in/email-otp", { email: b, otp: code });
    expect(signedIn.status).toBe(200);
    const body = (await signedIn.json()) as { user: { id: string } };
    expect(body.user.id).not.toBe(user);
    expect(
      (await fixture.db.sql`SELECT eligibility_key FROM auth_user WHERE id=${body.user.id}`)[0]
        ?.eligibility_key,
    ).toBe(root);
    const repeat = await usageSummary(fixture.db, policy, body.user.id);
    expect(repeat.credits_remaining).toBe("0");
    expect(repeat.bonus_remaining).toBe("0");
    expect(repeat.allowance.total_units).toBe("0");
  } finally {
    await fixture.close();
  }
}, 30000);

test("one-time non-expiring signup credit survives email changes and cannot be claimed by recreated aliases", async () => {
  const fixture = await testDatabase();
  try {
    const base = testPolicy();
    const policy = testPolicy({
      welcomeUnits: "0",
      welcomeExpiresDays: null,
      plans: [{ ...required(base.plans[0]), cycle: { kind: "once" } }],
    });
    await registerPolicy(fixture.db, policy);
    const originalEmail = `${crypto.randomUUID()}@example.test`;
    const changedEmail = `${crypto.randomUUID()}@example.test`;
    const root = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, originalEmail);
    await fixture.db.sql`INSERT INTO email_eligibility(key) VALUES (${root})`;
    const first = await linkedUser(fixture.db, originalEmail, root);
    const summaries = await Promise.all(
      Array.from({ length: 4 }, () => usageSummary(fixture.db, policy, first)),
    );
    expect(summaries.every((summary) => summary.credits_remaining === "100")).toBe(true);
    expect(summaries[0]?.period_end).toBeNull();
    const [grant] = await fixture.db
      .sql`SELECT amount,expires_at FROM credit_grant WHERE user_id=${first}`;
    expect(String(grant?.amount)).toBe("100");
    expect(grant?.expires_at).toBeNull();
    const [claimed] = await fixture.db
      .sql`SELECT signup_claimed_at FROM email_eligibility WHERE key=${root}`;
    expect(claimed?.signup_claimed_at).toBeTruthy();
    const codes = new Map<string, string>();
    const mailer = {
      sendOTP: async (email: string, code: string) => {
        codes.set(email, code);
      },
    };
    await requestActionCode(fixture.config, fixture.db, mailer, {
      userId: first,
      purpose: "email-change",
      destinationEmail: changedEmail,
    });
    await consumeActionCode(
      fixture.config,
      fixture.db,
      {
        userId: first,
        purpose: "email-change",
        destinationEmail: changedEmail,
        otp: required(codes.get(changedEmail)),
      },
      async (tx) => {
        await tx`UPDATE auth_user SET email=${changedEmail} WHERE id=${first}`;
      },
    );
    expect((await usageSummary(fixture.db, policy, first)).credits_remaining).toBe("100");
    expect((await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${first}`).length).toBe(
      1,
    );
    const alias = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, changedEmail);
    const [aliasRow] = await fixture.db
      .sql`SELECT signup_claimed_at FROM email_eligibility WHERE key=${alias}`;
    expect(new Date(aliasRow?.signup_claimed_at).toISOString()).toBe(
      new Date(claimed?.signup_claimed_at).toISOString(),
    );
    await requestActionCode(fixture.config, fixture.db, mailer, {
      userId: first,
      purpose: "deletion",
    });
    await consumeActionCode(
      fixture.config,
      fixture.db,
      { userId: first, purpose: "deletion", otp: required(codes.get(changedEmail)) },
      async (tx) => {
        await tx`UPDATE auth_user SET lifecycle='deleting' WHERE id=${first}`;
      },
    );
    await fixture.db.sql`DELETE FROM auth_user WHERE id=${first}`;
    const app = new Hono();
    app.route(
      "/api/auth",
      createIdentityRoutes(
        fixture.config,
        fixture.db,
        createAuth(fixture.config, fixture.db, mailer),
      ),
    );
    for (const email of [originalEmail, changedEmail]) {
      const post = (path: string, body: unknown) =>
        app.request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      expect(
        (await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).status,
      ).toBe(202);
      const signedIn = await post("/sign-in/email-otp", { email, otp: required(codes.get(email)) });
      expect(signedIn.status).toBe(200);
      const body = (await signedIn.json()) as { user: { id: string } };
      expect(
        (await fixture.db.sql`SELECT eligibility_key FROM auth_user WHERE id=${body.user.id}`)[0]
          ?.eligibility_key,
      ).toBe(root);
      const repeated = await usageSummary(fixture.db, policy, body.user.id);
      expect(repeated.credits_remaining).toBe("0");
      expect(repeated.period_end).toBeNull();
      expect(
        (await fixture.db.sql`SELECT id FROM credit_grant WHERE user_id=${body.user.id}`).length,
      ).toBe(0);
    }
  } finally {
    await fixture.close();
  }
}, 30000);

test("email changes reject a destination with only a one-time signup claim", async () => {
  const fixture = await testDatabase();
  try {
    const sourceEmail = `${crypto.randomUUID()}@example.test`;
    const targetEmail = `${crypto.randomUUID()}@example.test`;
    const source = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, sourceEmail);
    const target = eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, targetEmail);
    await fixture.db.sql`INSERT INTO email_eligibility(key) VALUES (${source})`;
    await fixture.db
      .sql`INSERT INTO email_eligibility(key,signup_claimed_at) VALUES (${target},clock_timestamp())`;
    const owner = await linkedUser(fixture.db, sourceEmail, source);
    let code = "";
    await requestActionCode(
      fixture.config,
      fixture.db,
      {
        sendOTP: async (_email, otp) => {
          code = otp;
        },
      },
      { userId: owner, purpose: "email-change", destinationEmail: targetEmail },
    );
    await expect(
      consumeActionCode(
        fixture.config,
        fixture.db,
        { userId: owner, purpose: "email-change", destinationEmail: targetEmail, otp: code },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "eligibility_conflict", status: 409 });
    expect(
      (
        await fixture.db
          .sql`SELECT canonical_key FROM email_eligibility_alias WHERE alias_key=${target}`
      ).length,
    ).toBe(0);
  } finally {
    await fixture.close();
  }
}, 30000);
