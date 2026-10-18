import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { testDatabase } from "../../../../tests/support/database";
import { privateKey } from "../../../platform/abuse";
import { createAccountService } from "../account";
import { createAuth, resendMailer } from "../auth";
import { createIdentityRoutes } from "../routes";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
}, 30000);
afterEach(async () => {
  await fixture?.close();
});
function setup(limit = 1000) {
  const codes = new Map<string, string>();
  const mailer = {
    sendOTP: async (email: string, code: string) => {
      codes.set(email, code);
    },
  };
  const config = { ...fixture.config, SIGNUP_PER_IP_PER_DAY: limit };
  const auth = createAuth(config, fixture.db, mailer);
  const app = new Hono();
  app.route(
    "/api/auth",
    createIdentityRoutes(config, fixture.db, auth, () => "192.0.2.88"),
  );
  const request = (path: string, body: object) =>
    app.request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const send = async (email: string) => {
    expect(
      (await request("/email-otp/send-verification-otp", { email, type: "sign-in" })).status,
    ).toBe(202);
    const code = codes.get(email);
    if (!code) throw new Error("Missing code");
    return code;
  };
  return { auth, codes, mailer, request, send, config };
}
const address = () => `${crypto.randomUUID()}@example.test`;
async function ipKey() {
  const [clock] = await fixture.db.sql`SELECT clock_timestamp() AS db_now`;
  return privateKey(
    fixture.config.ABUSE_SECRET,
    "signup-ip-day",
    `192.0.2.88\0${new Date(clock?.db_now).toISOString().slice(0, 10)}`,
  );
}

test("signup auth, session, eligibility and IP admission use one PostgreSQL transaction", async () => {
  const s = setup();
  const key = await ipKey();
  await fixture.db.sql.unsafe(`CREATE TABLE auth_transaction_probe(kind text,transaction_id bigint);
    CREATE FUNCTION record_auth_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO auth_transaction_probe VALUES (TG_TABLE_NAME||':'||TG_OP,txid_current()); RETURN NEW; END $$;
    CREATE TRIGGER probe_user AFTER INSERT OR UPDATE ON auth_user FOR EACH ROW EXECUTE FUNCTION record_auth_transaction();
    CREATE TRIGGER probe_session AFTER INSERT ON auth_session FOR EACH ROW EXECUTE FUNCTION record_auth_transaction();
    CREATE TRIGGER probe_admission AFTER INSERT OR UPDATE ON abuse_bucket FOR EACH ROW WHEN (NEW.key='${key}') EXECUTE FUNCTION record_auth_transaction();`);
  const email = address();
  const otp = await s.send(email);
  expect((await s.request("/sign-in/email-otp", { email, otp, device: "Test Mac" })).status).toBe(
    200,
  );
  const rows = await fixture.db
    .sql`SELECT kind,transaction_id::text AS transaction_id FROM auth_transaction_probe`;
  expect(rows.map((row) => row.kind).sort()).toEqual([
    "abuse_bucket:INSERT",
    "auth_session:INSERT",
    "auth_user:INSERT",
    "auth_user:UPDATE",
  ]);
  expect(new Set(rows.map((row) => row.transaction_id)).size).toBe(1);
});

test("failed signup finalization rolls back user, session, OTP consume and IP admission", async () => {
  const s = setup(1);
  const email = address();
  const otp = await s.send(email);
  await fixture.db.sql.unsafe(`CREATE FUNCTION reject_signup_finalization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.eligibility_key IS NOT NULL THEN RAISE EXCEPTION 'injected finalization failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_signup BEFORE UPDATE ON auth_user FOR EACH ROW EXECUTE FUNCTION reject_signup_finalization();`);
  expect((await s.request("/sign-in/email-otp", { email, otp })).status).toBe(503);
  expect((await fixture.db.sql`SELECT id FROM auth_user WHERE email=${email}`).length).toBe(0);
  expect((await fixture.db.sql`SELECT id FROM auth_session`).length).toBe(0);
  const key = await ipKey();
  expect((await fixture.db.sql`SELECT count FROM abuse_bucket WHERE key=${key}`).length).toBe(0);
  const [verification] = await fixture.db
    .sql`SELECT value FROM auth_verification WHERE identifier=${`sign-in-otp-${email}`}`;
  expect(String(verification?.value).endsWith(":0")).toBe(true);
  await fixture.db.sql.unsafe("DROP TRIGGER reject_signup ON auth_user");
  const other = address();
  const otherCode = await s.send(other);
  expect((await s.request("/sign-in/email-otp", { email: other, otp: otherCode })).status).toBe(
    200,
  );
  const [bucket] = await fixture.db.sql`SELECT count FROM abuse_bucket WHERE key=${key}`;
  expect(bucket?.count).toBe(1);
});

test("rejected OTP attempts persist without consuming signup IP admission; concurrent signups respect the cap", async () => {
  const s = setup(1);
  const first = address();
  const second = address();
  const code = await s.send(first);
  const other = await s.send(second);
  expect(
    (
      await s.request("/sign-in/email-otp", {
        email: first,
        otp: code === "000000" ? "111111" : "000000",
      })
    ).status,
  ).toBe(401);
  const [verification] = await fixture.db
    .sql`SELECT value FROM auth_verification WHERE identifier=${`sign-in-otp-${first}`}`;
  expect(String(verification?.value).endsWith(":1")).toBe(true);
  const key = await ipKey();
  expect((await fixture.db.sql`SELECT count FROM abuse_bucket WHERE key=${key}`).length).toBe(0);
  const replies = await Promise.all([
    s.request("/sign-in/email-otp", { email: first, otp: code }),
    s.request("/sign-in/email-otp", { email: second, otp: other }),
  ]);
  expect(replies.map((response) => response.status).sort()).toEqual([200, 429]);
  expect((await fixture.db.sql`SELECT id FROM auth_user`).length).toBe(1);
  expect((await fixture.db.sql`SELECT id FROM auth_session`).length).toBe(1);
  const [bucket] = await fixture.db.sql`SELECT count FROM abuse_bucket WHERE key=${key}`;
  expect(bucket?.count).toBe(1);
});

test("email change rechecks session revocation after waiting for the lifecycle lock", async () => {
  const s = setup();
  const email = address();
  const otp = await s.send(email);
  const signedIn = await s.request("/sign-in/email-otp", { email, otp });
  const token = signedIn.headers.get("set-auth-token");
  if (!token) throw new Error("Missing token");
  const identity = await s.auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
    query: { disableCookieCache: true },
  });
  if (!identity) throw new Error("Missing identity");
  const service = createAccountService(s.config, fixture.db, s.mailer, {
    beforeAccountMutation: async (tx, userId) => {
      await tx`SELECT user_id FROM billing_customer WHERE user_id=${userId} FOR UPDATE`;
    },
    onDeletionRequested: async () => {},
    exportExtras: async () => ({ billing: null, usage: null }),
  });
  const destination = address();
  await service.requestEmailChange(identity, destination);
  let unlock!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = fixture.db.sql.begin(async (tx) => {
    await tx`SELECT user_id FROM billing_customer WHERE user_id=${identity.user.id} FOR UPDATE`;
    ready();
    await gate;
  });
  await locked;
  const pending = service.confirmEmailChange(
    identity,
    destination,
    s.codes.get(destination) as string,
  );
  try {
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const [row] = await fixture.db
        .sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%billing_customer%FOR UPDATE%') AS blocked`;
      if (row?.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    await service.revokeAll(identity);
    unlock();
    await holder;
    await expect(pending).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    expect(
      (await fixture.db.sql`SELECT email FROM auth_user WHERE id=${identity.user.id}`)[0]?.email,
    ).toBe(email);
    expect(
      (
        await fixture.db
          .sql`SELECT otp_hash FROM action_otp WHERE owner_user_id=${identity.user.id}`
      ).length,
    ).toBe(1);
  } finally {
    unlock();
    await holder;
    await pending.catch(() => {});
  }
});

test("sign-in email subject and first line contain the six-digit code", async () => {
  let sent: { subject: string; text: string } | undefined;
  const mailer = resendMailer({ ...fixture.config, RESEND_API_KEY: "test" }, async (_url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(null, { status: 200 });
  });
  await mailer.sendOTP("test@example.test", "123456", "sign-in");
  expect(sent?.subject).toBe("Your Zephium code is 123456");
  expect(sent?.text.split("\n")[0]).toBe("Your Zephium code is 123456.");
});

test("mutation freshness uses current persisted session state while deletion accepts an older valid session", async () => {
  const s = setup();
  const email = address();
  const otp = await s.send(email);
  const signedIn = await s.request("/sign-in/email-otp", { email, otp });
  const token = signedIn.headers.get("set-auth-token");
  if (!token) throw new Error("Missing token");
  const identity = await s.auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
    query: { disableCookieCache: true },
  });
  if (!identity) throw new Error("Missing identity");
  const service = createAccountService(s.config, fixture.db, s.mailer, {
    beforeAccountMutation: async (tx, userId) => {
      await tx`SELECT user_id FROM billing_customer WHERE user_id=${userId} FOR UPDATE`;
    },
    onDeletionRequested: async () => {},
    exportExtras: async () => ({ billing: null, usage: null }),
  });
  await fixture.db
    .sql`UPDATE auth_session SET created_at=clock_timestamp()-interval '11 minutes' WHERE id=${identity.session.id}`;
  await expect(service.requestEmailChange(identity, address())).rejects.toMatchObject({
    code: "reauthentication_required",
    status: 401,
  });
  await service.requestDeletion(identity);
  const deletionCode = s.codes.get(email) as string;
  await fixture.db
    .sql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${identity.session.id}`;
  await expect(service.confirmDeletion(identity, deletionCode)).rejects.toMatchObject({
    code: "unauthorized",
    status: 401,
  });
  await expect(service.updateProfile(identity, "Must not save")).rejects.toMatchObject({
    code: "unauthorized",
    status: 401,
  });
  expect(
    (await fixture.db.sql`SELECT lifecycle,name FROM auth_user WHERE id=${identity.user.id}`)[0],
  ).toMatchObject({ lifecycle: "active", name: "" });
});
