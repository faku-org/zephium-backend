import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { TransactionSql } from "postgres";
import { testDatabase } from "../../../../tests/support/database";
import { privateKey } from "../../../platform/abuse";
import { AppError } from "../../../platform/errors";
import { boundedMailer, createAuth, type Mailer } from "../auth";
import { eligibilityKey, normalizeEmail } from "../eligibility";
import { createIdentityRoutes } from "../routes";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let app: Hono;
let auth: ReturnType<typeof createAuth>;
const mail = new Map<string, string>();
const mailer: Mailer = {
  sendOTP: async (email, otp) => {
    mail.set(email, otp);
  },
};
beforeAll(async () => {
  fixture = await testDatabase();
  auth = createAuth(fixture.config, fixture.db, mailer);
  app = new Hono();
  app.route("/api/auth", createIdentityRoutes(fixture.config, fixture.db, auth));
}, 30000);
afterAll(async () => {
  await fixture?.close();
});
function newEmail(domain = "example.test") {
  return `${crypto.randomUUID()}@${domain}`;
}
function request(path: string, body: unknown, target = app, headers: Record<string, string> = {}) {
  return target.request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function waitForCode(email: string) {
  for (let i = 0; i < 200; i++) {
    const code = mail.get(email);
    if (code) return code;
    await Bun.sleep(10);
  }
  throw new Error("Expected in-memory code delivery");
}
async function send(email: string, target = app) {
  const response = await request(
    "/email-otp/send-verification-otp",
    { email, type: "sign-in" },
    target,
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  return waitForCode(normalizeEmail(email));
}

test("email code creates a verified account, signed session, device label and stable eligibility key", async () => {
  const email = newEmail();
  const code = await send(email.toUpperCase());
  const [stored] = await fixture.db
    .sql`SELECT value FROM auth_verification WHERE identifier=${`sign-in-otp-${email}`}`;
  expect(String(stored?.value)).toBe(
    `${privateKey(fixture.config.AUTH_SECRET, "sign-in-otp-storage:v1", code)}:0`,
  );
  expect(String(stored?.value)).not.toBe(
    `${privateKey(fixture.config.ABUSE_SECRET, "sign-in-otp-storage:v1", code)}:0`,
  );
  expect(String(stored?.value)).not.toBe(
    `${privateKey(fixture.config.AUTH_SECRET, "deletion", code)}:0`,
  );
  const response = await request("/sign-in/email-otp", { email, otp: code, device: "MacBook Pro" });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  expect(token).toBeTruthy();
  const body = (await response.json()) as { user: { id: string; emailVerified: boolean } };
  expect(body.user.emailVerified).toBe(true);
  const [user] = await fixture.db
    .sql`SELECT name,eligibility_key FROM auth_user WHERE id=${body.user.id}`;
  expect(user?.name).toBe("");
  expect(body.user).not.toHaveProperty("eligibilityKey");
  expect(user?.eligibility_key).toBe(
    eligibilityKey(fixture.config.ELIGIBILITY_SECRET as string, email),
  );
  expect(
    (await fixture.db.sql`SELECT key FROM email_eligibility WHERE key=${user?.eligibility_key}`)
      .length,
  ).toBe(1);
  const session = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
    query: { disableCookieCache: true },
  });
  expect(session?.user.id).toBe(body.user.id);
  expect(
    (await fixture.db.sql`SELECT device FROM auth_session WHERE user_id=${body.user.id}`)[0]
      ?.device,
  ).toBe("MacBook Pro");
  expect((await request("/sign-in/email-otp", { email, otp: code })).status).toBe(401);
  expect(
    (await request("/sign-up/email", { email, password: "unreachable-password" })).status,
  ).toBe(404);
  expect(
    (await request("/sign-in/email", { email, password: "unreachable-password" })).status,
  ).toBe(404);
});

test("concurrent redemption is one-use and password-era accounts retain their ID", async () => {
  const email = newEmail();
  const userId = crypto.randomUUID();
  await fixture.db
    .sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES (${userId},'Existing',${email},true)`;
  await fixture.db
    .sql`INSERT INTO auth_account(id,account_id,provider_id,user_id,password) VALUES (${crypto.randomUUID()},${userId},'credential',${userId},'legacy-hash')`;
  const code = await send(email);
  const responses = await Promise.all(
    [1, 2].map(() => request("/sign-in/email-otp", { email, otp: code })),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  const success = responses.find((r) => r.status === 200);
  if (!success) throw new Error("Expected successful redemption");
  expect(((await success.json()) as { user: { id: string } }).user.id).toBe(userId);
  expect(
    (
      await fixture.db
        .sql`SELECT id FROM auth_account WHERE user_id=${userId} AND provider_id='credential'`
    ).length,
  ).toBe(1);
});

test("closed signup and disposable domains suppress new-account mail while existing users still sign in", async () => {
  const existing = newEmail("blocked.test");
  const userId = crypto.randomUUID();
  await fixture.db
    .sql`INSERT INTO auth_user(id,name,email,email_verified) VALUES (${userId},'Existing',${existing},true)`;
  const directory = await mkdtemp(join(tmpdir(), "zephium-domains-"));
  const domains = join(directory, "domains.txt");
  await writeFile(domains, "blocked.test\n");
  try {
    const closed = {
      ...fixture.config,
      SIGNUP_OPEN: "false" as const,
      DISPOSABLE_EMAIL_DOMAINS_FILE: domains,
    };
    const closedApp = new Hono();
    closedApp.route(
      "/api/auth",
      createIdentityRoutes(closed, fixture.db, createAuth(closed, fixture.db, mailer)),
    );
    const unknown = newEmail();
    expect(
      (
        await request(
          "/email-otp/send-verification-otp",
          { email: unknown, type: "sign-in" },
          closedApp,
        )
      ).status,
    ).toBe(202);
    expect(mail.has(unknown)).toBe(false);
    const existingCode = await send(existing, closedApp);
    expect(
      (await request("/sign-in/email-otp", { email: existing, otp: existingCode }, closedApp))
        .status,
    ).toBe(200);
    const open = { ...fixture.config, DISPOSABLE_EMAIL_DOMAINS_FILE: domains };
    const openApp = new Hono();
    openApp.route(
      "/api/auth",
      createIdentityRoutes(open, fixture.db, createAuth(open, fixture.db, mailer)),
    );
    const disposable = newEmail("blocked.test");
    expect(
      (
        await request(
          "/email-otp/send-verification-otp",
          { email: disposable, type: "sign-in" },
          openApp,
        )
      ).status,
    ).toBe(202);
    expect(mail.has(disposable)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new-account IP cap counts only successful first logins and reports real retry delay", async () => {
  const limited = { ...fixture.config, SIGNUP_PER_IP_PER_DAY: 1 };
  const limitedApp = new Hono();
  limitedApp.route(
    "/api/auth",
    createIdentityRoutes(
      limited,
      fixture.db,
      createAuth(limited, fixture.db, mailer),
      () => "192.0.2.5",
    ),
  );
  const first = newEmail();
  const firstCode = await send(first, limitedApp);
  expect(
    (await request("/sign-in/email-otp", { email: first, otp: "000000" }, limitedApp)).status,
  ).toBe(401);
  expect(
    (await request("/sign-in/email-otp", { email: first, otp: firstCode }, limitedApp)).status,
  ).toBe(200);
  const second = newEmail();
  const secondCode = await send(second, limitedApp);
  const capped = await request(
    "/sign-in/email-otp",
    { email: second, otp: secondCode },
    limitedApp,
  );
  expect(capped.status).toBe(429);
  expect(Number(capped.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect((await fixture.db.sql`SELECT id FROM auth_user WHERE email=${second}`).length).toBe(0);
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=now()-interval '1 second' WHERE key<>''`;
  mail.delete(first);
  const again = await send(first, limitedApp);
  expect(
    (await request("/sign-in/email-otp", { email: first, otp: again }, limitedApp)).status,
  ).toBe(200);
  const rows = await fixture.db.sql`SELECT key FROM abuse_bucket`;
  expect(rows.some((row) => String(row.key).includes("192.0.2.5"))).toBe(false);
});

test("device labels and request bodies have strict bounds; normalization preserves aliases", async () => {
  expect(normalizeEmail(" Alice+tag@Example.Test ")).toBe("alice+tag@example.test");
  expect(eligibilityKey("x".repeat(40), "alice+tag@example.test")).not.toBe(
    eligibilityKey("x".repeat(40), "alice@example.test"),
  );
  const email = newEmail();
  const code = await send(email);
  expect(
    (await request("/sign-in/email-otp", { email, otp: code, device: "x".repeat(65) })).status,
  ).toBe(400);
  expect(
    (await request("/sign-in/email-otp", { email, otp: code, device: "line\nbreak" })).status,
  ).toBe(400);
  expect(
    (await request("/sign-in/email-otp", { email, otp: code, callbackURL: "https://hostile.test" }))
      .status,
  ).toBe(400);
  const response = await request("/sign-in/email-otp", { email, otp: code }, app, {
    "X-Zephium-Device": "iMac",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  expect(
    (await fixture.db.sql`SELECT device FROM auth_session WHERE user_id=${body.user.id}`)[0]
      ?.device,
  ).toBe("iMac");
});

test("staging allowlist blocks OTP and redemption for unapproved new and existing addresses", async () => {
  const allowed = newEmail();
  const existing = newEmail();
  const denied = newEmail();
  const existingCode = await send(existing);
  const deniedCode = await send(denied);
  const existingId = crypto.randomUUID();
  await fixture.db.sql`INSERT INTO auth_user(id,name,email,email_verified)
    VALUES (${existingId},'Existing',${existing},true)`;
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=now()-interval '1 second' WHERE key<>''`;
  mail.delete(existing);
  mail.delete(denied);
  const config = { ...fixture.config, SIGNUP_EMAIL_ALLOWLIST: ` ${allowed.toUpperCase()} ` };
  const restricted = new Hono();
  restricted.route(
    "/api/auth",
    createIdentityRoutes(config, fixture.db, createAuth(config, fixture.db, mailer)),
  );
  for (const email of [existing, denied, newEmail(), allowed.replace("@", "+alias@")]) {
    const response = await request(
      "/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      restricted,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(mail.has(email)).toBe(false);
  }
  for (const [email, otp] of [
    [existing, existingCode],
    [denied, deniedCode],
  ] as const) {
    const redemption = await request("/sign-in/email-otp", { email, otp }, restricted);
    expect(redemption.status).toBe(401);
    expect(await redemption.json()).toMatchObject({ error: { code: "invalid_code" } });
    expect((await fixture.db.sql`SELECT id FROM auth_user WHERE email=${email}`).length).toBe(
      email === existing ? 1 : 0,
    );
  }
  const allowedCode = await send(allowed, restricted);
  expect(
    (await request("/sign-in/email-otp", { email: allowed, otp: allowedCode }, restricted)).status,
  ).toBe(200);
});

test("delivery capacity rejects honestly, frees the slot, and failed sends leave no redeemable code", async () => {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: string[] = [];
  const slow = boundedMailer(
    {
      sendOTP: async (email) => {
        delivered.push(email);
        start();
        await pending;
      },
    },
    1,
  );
  const config = { ...fixture.config, DB_POOL_SIZE: 12 };
  const limited = new Hono();
  limited.route(
    "/api/auth",
    createIdentityRoutes(config, fixture.db, createAuth(config, fixture.db, slow)),
  );
  const first = newEmail();
  const second = newEmail();
  const firstResponse = request(
    "/email-otp/send-verification-otp",
    { email: first, type: "sign-in" },
    limited,
  );
  await started;
  const rejected = await request(
    "/email-otp/send-verification-otp",
    { email: second, type: "sign-in" },
    limited,
  );
  expect(rejected.status).toBe(503);
  expect(rejected.headers.get("Retry-After")).toBe("1");
  expect(delivered).toEqual([first]);
  expect(
    (
      await fixture.db
        .sql`SELECT value FROM auth_verification WHERE identifier=${`sign-in-otp-${second}`}`
    ).length,
  ).toBe(0);
  release();
  expect((await firstResponse).status).toBe(202);
  expect(
    (
      await request(
        "/email-otp/send-verification-otp",
        { email: newEmail(), type: "sign-in" },
        limited,
      )
    ).status,
  ).toBe(202);

  const failing = new Hono();
  const unavailable: Mailer = {
    sendOTP: async () => {
      throw new AppError("email_unavailable", 503, 37);
    },
  };
  failing.route(
    "/api/auth",
    createIdentityRoutes(config, fixture.db, createAuth(config, fixture.db, unavailable)),
  );
  const failedEmail = newEmail();
  const failed = await request(
    "/email-otp/send-verification-otp",
    { email: failedEmail, type: "sign-in" },
    failing,
  );
  expect(failed.status).toBe(503);
  expect(failed.headers.get("Retry-After")).toBe("37");
  expect(
    (
      await fixture.db
        .sql`SELECT value FROM auth_verification WHERE identifier=${`sign-in-otp-${failedEmail}`}`
    ).length,
  ).toBe(0);
});

test("native Better Auth Retry-After propagates the actual limiter delay", async () => {
  const email = newEmail();
  const code = await send(email);
  const limitedAuth = Object.assign(Object.create(auth), {
    handler: async () => new Response(null, { status: 429, headers: { "X-Retry-After": "73" } }),
    withTransaction: async <T>(
      _tx: TransactionSql,
      operation: (
        instance: Parameters<Parameters<typeof auth.withTransaction>[1]>[0],
      ) => Promise<T>,
    ): Promise<T> =>
      operation(
        Object.assign(Object.create(auth), {
          handler: async () =>
            new Response(null, { status: 429, headers: { "X-Retry-After": "73" } }),
        }),
      ),
  });
  const limited = new Hono();
  limited.route("/api/auth", createIdentityRoutes(fixture.config, fixture.db, limitedAuth));
  const response = await request("/sign-in/email-otp", { email, otp: code }, limited);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("73");
  expect(await response.json()).toMatchObject({ error: { code: "rate_limited", retry_after: 73 } });
});

test("resending rotates the code and keeps only one verification record", async () => {
  const email = newEmail();
  const old = await send(email);
  await fixture.db.sql`UPDATE abuse_bucket SET expires_at=now()-interval '1 second' WHERE key<>''`;
  const response = await request("/email-otp/send-verification-otp", { email, type: "sign-in" });
  expect(response.status).toBe(202);
  const current = mail.get(email) as string;
  expect(
    (
      await fixture.db
        .sql`SELECT value FROM auth_verification WHERE identifier=${`sign-in-otp-${email}`}`
    ).length,
  ).toBe(1);
  // A random generator can produce the same six digits; verify stale rejection only when distinct.
  if (old !== current)
    expect((await request("/sign-in/email-otp", { email, otp: old })).status).toBe(401);
  expect((await request("/sign-in/email-otp", { email, otp: current })).status).toBe(200);
});

test("production enrollment fails closed when enabled disposable-domain data is empty or missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zephium-disposable-data-"));
  const path = join(directory, "domains.txt");
  const config = {
    ...fixture.config,
    NODE_ENV: "production" as const,
    BLOCK_DISPOSABLE_EMAIL: "true" as const,
    DISPOSABLE_EMAIL_DOMAINS_FILE: path,
  };
  try {
    expect(() => createIdentityRoutes(config, fixture.db, auth, () => "127.0.0.1")).toThrow(
      "Disposable email domain data unavailable",
    );
    await writeFile(path, "# Empty list must not silently disable a production protection\n\n");
    expect(() => createIdentityRoutes(config, fixture.db, auth, () => "127.0.0.1")).toThrow(
      "Disposable email domain data unavailable",
    );
    await writeFile(path, "blocked.example\n");
    expect(() => createIdentityRoutes(config, fixture.db, auth, () => "127.0.0.1")).not.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
