import { afterAll, beforeAll, expect, test } from "bun:test";
import { symmetricDecrypt } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  type AdminAuth,
  type AdminAuthDatabase,
  createAdminAuth,
} from "../../src/modules/admin/auth";
import * as schema from "../../src/modules/admin/auth-schema";
import { getAdminSession, handleAdminAuth } from "../../src/modules/admin/authorization";
import { provisionAdminOperator } from "../../src/modules/admin/operators";
import { testDatabase } from "../support/admin-database";

const origin = "https://admin.example.test";
const config = { ADMIN_ORIGIN: origin, ADMIN_AUTH_SECRET: "separate-admin-secret-".repeat(3) };
const password = "correct horse admin passphrase";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let db: AdminAuthDatabase;
let auth: AdminAuth;
beforeAll(async () => {
  fixture = await testDatabase();
  db = { sql: fixture.db.sql, orm: drizzle(fixture.db.sql, { schema }) };
  auth = createAdminAuth(config, db);
});
afterAll(async () => {
  await fixture?.close();
});

class Browser {
  cookies = new Map<string, string>();
  headers() {
    return new Headers({
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    });
  }
  async request(path: string, body?: unknown, options: { method?: string; origin?: string } = {}) {
    const headers = this.headers();
    headers.set("origin", options.origin ?? origin);
    headers.set("content-type", "application/json");
    headers.set("sec-fetch-site", "same-origin");
    const response = await handleAdminAuth(
      new Request(`${origin}/auth${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      auth,
      db,
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  }
  async session() {
    return getAdminSession(this.headers(), auth, db);
  }
}
async function provision() {
  const email = `operator-${crypto.randomUUID()}@example.test`;
  await provisionAdminOperator(db, email, "Operator", password);
  return email;
}
async function otp(email: string) {
  const [factor] =
    await db.sql`SELECT f.secret FROM admin_auth_two_factor f JOIN admin_auth_user u ON u.id=f.user_id WHERE u.email=${email}`;
  const secret = await symmetricDecrypt({ key: config.ADMIN_AUTH_SECRET, data: factor?.secret });
  return (await auth.api.generateTOTP({ body: { secret } })).code;
}
async function enrolledOperator() {
  const email = await provision();
  const browser = new Browser();
  expect((await browser.request("/sign-in/email", { email, password })).status).toBe(200);
  const enrollment = await browser.request("/two-factor/enable", { password });
  expect(enrollment.status).toBe(200);
  const { backupCodes } = (await enrollment.json()) as { backupCodes: string[] };
  expect(
    (await browser.request("/two-factor/verify-totp", { code: await otp(email) })).status,
  ).toBe(200);
  return { email, browser, backupCodes };
}

test("the public surface blocks signup, recovery, factor removal, trust devices and cross-origin mutations", async () => {
  const browser = new Browser();
  for (const path of [
    "/sign-up/email",
    "/request-password-reset",
    "/reset-password",
    "/two-factor/disable",
    "/two-factor/get-totp-uri",
    "/two-factor/generate-backup-codes",
    "/two-factor/send-otp",
    "/two-factor/verify-otp",
    "/totp/generate",
    "/get-session?disableCookieCache=true",
    "/sign-in/email/",
  ]) {
    expect((await browser.request(path, {})).status).toBe(404);
  }
  expect(
    (await browser.request("/two-factor/verify-totp", { code: "123456", trustDevice: true }))
      .status,
  ).toBe(400);
  expect(
    (
      await browser.request(
        "/sign-in/email",
        { email: "test@example.test", password },
        { origin: "https://attacker.test" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await browser.request("/sign-in/email", {
        email: "test@example.test",
        password,
        callbackURL: "https://attacker.test",
      })
    ).status,
  ).toBe(400);
});

test("password sessions cannot read reports; enrollment proves only the rotated current session", async () => {
  const email = await provision();
  const browser = new Browser();
  const oldBrowser = new Browser();
  const login = await browser.request("/sign-in/email", { email, password });
  expect(login.status).toBe(200);
  expect(await login.json()).toEqual({ success: true, twoFactorRedirect: false });
  expect(
    login.headers
      .getSetCookie()
      .some(
        (cookie) =>
          cookie.includes("HttpOnly") &&
          cookie.includes("Secure") &&
          cookie.includes("SameSite=Strict"),
      ),
  ).toBe(true);
  expect((await oldBrowser.request("/sign-in/email", { email, password })).status).toBe(200);
  expect((await browser.session())?.mfaVerified).toBe(false);
  expect((await browser.request("/two-factor/enable", { password: "wrong password" })).status).toBe(
    400,
  );
  const setup = await browser.request("/two-factor/enable", { password });
  const enrollment = (await setup.json()) as { totpURI: string; backupCodes: string[] };
  expect(enrollment.totpURI.startsWith("otpauth://totp/")).toBe(true);
  expect(enrollment.backupCodes.length).toBeGreaterThan(0);
  expect((await browser.request("/two-factor/verify-totp", { code: "invalid" })).status).toBe(401);
  expect((await browser.session())?.mfaVerified).toBe(false);
  const verified = await browser.request("/two-factor/verify-totp", { code: await otp(email) });
  expect(verified.status).toBe(200);
  expect(await verified.json()).toEqual({ success: true, twoFactorRedirect: false });
  expect((await browser.session())?.mfaVerified).toBe(true);
  expect((await oldBrowser.session())?.enrolled).toBe(true);
  expect((await oldBrowser.session())?.mfaVerified).toBe(false);
  const status = await (await browser.request("/get-session")).json();
  expect(JSON.stringify(status)).not.toContain("token");
  expect(JSON.stringify(status)).not.toContain("secret");
  expect((await browser.request("/two-factor/enable", { password })).status).toBe(403);
});

test("each subsequent password login requires TOTP or a one-use recovery code", async () => {
  const { email, backupCodes } = await enrolledOperator();
  const browser = new Browser();
  const login = await browser.request("/sign-in/email", { email, password });
  expect(await login.json()).toEqual({ success: true, twoFactorRedirect: true });
  expect(await browser.session()).toBeNull();
  expect((await browser.request("/two-factor/verify-totp", { code: "invalid" })).status).toBe(401);
  expect(await browser.session()).toBeNull();
  expect(
    (await browser.request("/two-factor/verify-totp", { code: await otp(email) })).status,
  ).toBe(200);
  expect((await browser.session())?.mfaVerified).toBe(true);
  expect([...browser.cookies.keys()].some((name) => name.includes("trust_device"))).toBe(false);
  const recovery = new Browser();
  await recovery.request("/sign-in/email", { email, password });
  expect(
    (await recovery.request("/two-factor/verify-backup-code", { code: backupCodes[0] })).status,
  ).toBe(200);
  expect((await recovery.session())?.mfaVerified).toBe(true);
  const replay = new Browser();
  await replay.request("/sign-in/email", { email, password });
  expect(
    (await replay.request("/two-factor/verify-backup-code", { code: backupCodes[0] })).status,
  ).toBe(401);
  expect(await replay.session()).toBeNull();
});

test("an unverified enrollment backup code cannot establish MFA proof", async () => {
  const email = await provision();
  const browser = new Browser();
  await browser.request("/sign-in/email", { email, password });
  const enrollment = (await (await browser.request("/two-factor/enable", { password })).json()) as {
    backupCodes: string[];
  };
  expect(
    (await browser.request("/two-factor/verify-backup-code", { code: enrollment.backupCodes[0] }))
      .status,
  ).toBe(403);
  expect((await browser.session())?.mfaVerified).toBe(false);
});

test("session expiry, deactivation and logout immediately remove access; customer and bearer credentials are ignored", async () => {
  const { email, browser } = await enrolledOperator();
  const session = await browser.session();
  expect(session?.mfaVerified).toBe(true);
  const [record] =
    await db.sql`SELECT s.token,s.expires_at,s.created_at,s.ip_address,s.user_agent FROM admin_auth_session s JOIN admin_auth_user u ON u.id=s.user_id WHERE u.email=${email}`;
  expect(
    new Date(record?.expires_at).getTime() - new Date(record?.created_at).getTime(),
  ).toBeLessThanOrEqual(3600_000);
  expect(record?.ip_address).toBeNull();
  expect(record?.user_agent).toBeNull();
  expect(
    await getAdminSession(new Headers({ authorization: `Bearer ${record?.token}` }), auth, db),
  ).toBeNull();
  const other = new Headers({
    cookie: browser.headers().get("cookie")?.replaceAll("zephium-admin.", "better-auth.") ?? "",
  });
  expect(await getAdminSession(other, auth, db)).toBeNull();
  await db.sql`UPDATE admin_auth_user SET active=false WHERE email=${email}`;
  expect(await browser.session()).toBeNull();
  await db.sql`UPDATE admin_auth_user SET active=true WHERE email=${email}`;
  expect((await browser.session())?.mfaVerified).toBe(true);
  await db.sql`UPDATE admin_auth_session SET expires_at=now()-interval '1 second' WHERE user_id=${session?.id ?? ""}`;
  expect(await browser.session()).toBeNull();
  const next = new Browser();
  await next.request("/sign-in/email", { email, password });
  await next.request("/two-factor/verify-totp", { code: await otp(email) });
  expect((await next.session())?.mfaVerified).toBe(true);
  expect((await next.request("/sign-out", {})).status).toBe(200);
  expect(await next.session()).toBeNull();
});

test("pending MFA logout revokes the challenge and repeated failures lock the operator", async () => {
  const { email } = await enrolledOperator();
  const pending = new Browser();
  await pending.request("/sign-in/email", { email, password });
  const stolenChallenge = new Browser();
  stolenChallenge.cookies = new Map(pending.cookies);
  expect((await pending.request("/sign-out", {})).status).toBe(200);
  expect(
    (await pending.request("/two-factor/verify-totp", { code: await otp(email) })).status,
  ).toBe(401);
  expect(
    (await stolenChallenge.request("/two-factor/verify-totp", { code: await otp(email) })).status,
  ).toBe(401);
  const attempts = new Browser();
  await attempts.request("/sign-in/email", { email, password });
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await attempts.request("/two-factor/verify-totp", { code: "invalid" })).status).toBe(
      401,
    );
  }
  const anotherChallenge = new Browser();
  await anotherChallenge.request("/sign-in/email", { email, password });
  expect(
    (await anotherChallenge.request("/two-factor/verify-totp", { code: await otp(email) })).status,
  ).toBe(429);
  expect(await anotherChallenge.session()).toBeNull();
});

test("enrollment requires a fresh password session and disabled operators cannot sign in", async () => {
  const email = await provision();
  const browser = new Browser();
  await browser.request("/sign-in/email", { email, password });
  const session = await browser.session();
  await db.sql`UPDATE admin_auth_session SET created_at=now()-interval '11 minutes' WHERE user_id=${session?.id ?? ""}`;
  expect((await browser.request("/two-factor/enable", { password })).status).toBe(403);
  await db.sql`UPDATE admin_auth_user SET active=false WHERE email=${email}`;
  expect((await new Browser().request("/sign-in/email", { email, password })).ok).toBe(false);
});

test("operator CLI provisions from bounded stdin without printing credentials", async () => {
  const email = `cli-${crypto.randomUUID()}@example.test`;
  const proc = Bun.spawn([process.execPath, "scripts/admin-operator.ts", email, "CLI Operator"], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ...config,
      ADMIN_AUTH_DATABASE_URL: fixture.config.DATABASE_URL,
      ADMIN_READ_DATABASE_URL: fixture.config.DATABASE_URL,
    },
    stdin: new Blob([`${password}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(stdout).toContain("Operator created");
  expect(stdout + stderr).not.toContain(password);
  expect(stdout + stderr).not.toContain(email);
  const browser = new Browser();
  expect((await browser.request("/sign-in/email", { email, password })).status).toBe(200);
  expect((await browser.session())?.mfaVerified).toBe(false);
});

async function operatorCommand(args: string[], input?: string) {
  const proc = Bun.spawn([process.execPath, "scripts/admin-operator.ts", ...args], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ...config,
      ADMIN_AUTH_DATABASE_URL: fixture.config.DATABASE_URL,
      ADMIN_READ_DATABASE_URL: fixture.config.DATABASE_URL,
    },
    stdin: input === undefined ? "ignore" : new Blob([`${input}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  for (const arg of args.filter((value) => value.includes("@")))
    expect(stdout + stderr).not.toContain(arg);
  if (input) expect(stdout + stderr).not.toContain(input);
}
async function pendingLogin(email: string, suppliedPassword = password) {
  const browser = new Browser();
  const response = await browser.request("/sign-in/email", { email, password: suppliedPassword });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { twoFactorRedirect: boolean }).twoFactorRedirect).toBe(true);
  return browser;
}

test("local disable revokes established sessions and pending MFA without affecting another operator", async () => {
  const { email, browser } = await enrolledOperator();
  const other = await enrolledOperator();
  const pending = await pendingLogin(email);
  const [before] =
    await db.sql`SELECT count(*)::integer AS total FROM admin_auth_verification WHERE value=(SELECT id FROM admin_auth_user WHERE email=${email})`;
  expect(before?.total).toBeGreaterThan(0);
  await operatorCommand(["disable", email]);
  expect(await browser.session()).toBeNull();
  expect((await pending.request("/two-factor/verify-totp", { code: await otp(email) })).ok).toBe(
    false,
  );
  expect((await new Browser().request("/sign-in/email", { email, password })).ok).toBe(false);
  expect((await other.browser.session())?.mfaVerified).toBe(true);
  const [operator] =
    await db.sql`SELECT active,two_factor_enabled FROM admin_auth_user WHERE email=${email}`;
  expect(operator?.active).toBe(false);
  expect(operator?.two_factor_enabled).toBe(true);
});

test("local revoke removes session and challenge records while retaining password and MFA enrollment", async () => {
  const { email, browser } = await enrolledOperator();
  const pending = await pendingLogin(email);
  const challenges =
    await db.sql`SELECT identifier FROM admin_auth_verification WHERE value=(SELECT id FROM admin_auth_user WHERE email=${email})`;
  await operatorCommand(["revoke", email]);
  expect(await browser.session()).toBeNull();
  expect((await pending.request("/two-factor/verify-totp", { code: await otp(email) })).ok).toBe(
    false,
  );
  for (const challenge of challenges) {
    const [remaining] =
      await db.sql`SELECT count(*)::integer AS total FROM admin_auth_verification WHERE identifier IN (${challenge.identifier}, ${`2fa-attempts-${challenge.identifier}`})`;
    expect(remaining?.total).toBe(0);
  }
  const fresh = await pendingLogin(email);
  expect((await fresh.request("/two-factor/verify-totp", { code: await otp(email) })).status).toBe(
    200,
  );
  expect((await fresh.session())?.mfaVerified).toBe(true);
});

test("local password reset rejects the old password and pending MFA while preserving enrolled factors", async () => {
  const { email, browser } = await enrolledOperator();
  const pending = await pendingLogin(email);
  const replacement = "a replacement synthetic admin passphrase";
  await operatorCommand(["reset-password", email], replacement);
  expect(await browser.session()).toBeNull();
  expect((await pending.request("/two-factor/verify-totp", { code: await otp(email) })).ok).toBe(
    false,
  );
  expect((await new Browser().request("/sign-in/email", { email, password })).status).toBe(401);
  const fresh = await pendingLogin(email, replacement);
  expect((await fresh.request("/two-factor/verify-totp", { code: await otp(email) })).status).toBe(
    200,
  );
  expect((await fresh.session())?.mfaVerified).toBe(true);
  await operatorCommand(["disable", email]);
  await operatorCommand(["reset-password", email], password);
  const [operator] =
    await db.sql`SELECT active,two_factor_enabled FROM admin_auth_user WHERE email=${email}`;
  expect(operator?.active).toBe(false);
  expect(operator?.two_factor_enabled).toBe(true);
  expect((await new Browser().request("/sign-in/email", { email, password })).ok).toBe(false);
});
