import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { adminFactorCredentials, limitAdminAuth } from "../../src/modules/admin/security";
import { privateKey } from "../../src/platform/abuse";
import { testDatabase } from "../support/admin-database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const secret = "isolated-admin-throttle-test-secret".repeat(2);
const prefix = "__Secure-zephium-admin.";
beforeAll(async () => {
  fixture = await testDatabase();
});
beforeEach(async () => {
  await fixture.db.sql`DELETE FROM admin_auth_throttle`;
});
afterAll(async () => {
  await fixture?.close();
});
const limit = (cookie: string, path = "/auth/two-factor/verify-totp", ip = "192.0.2.1") =>
  limitAdminAuth(fixture.db.sql, secret, ip, path, {}, cookie);

test("factor credentials normalize quotes/percent encoding and ignore cookie order or unrelated data", () => {
  const canonical = `${prefix}session_token=alpha%2Bbeta; ${prefix}two_factor=challenge`;
  expect(adminFactorCredentials(canonical, true)).toEqual([
    `${prefix}session_token:alpha+beta`,
    `${prefix}two_factor:challenge`,
  ]);
  expect(
    adminFactorCredentials(
      `junk=random; ${prefix}two_factor="%63hallenge"; ${prefix}session_token="%61lpha%2bbeta"`,
      true,
    ),
  ).toEqual(adminFactorCredentials(canonical, true));
  expect(adminFactorCredentials("zephium-admin.session_token=local", false)).toEqual([
    "zephium-admin.session_token:local",
  ]);
  expect(adminFactorCredentials("better-auth.session_token=customer", true)).toEqual([]);
  expect(() =>
    adminFactorCredentials(`${prefix}session_token=a; ${prefix}session_token=b`, true),
  ).toThrow("invalid_request");
  expect(() => adminFactorCredentials(`${prefix}two_factor=; ${prefix}two_factor=b`, true)).toThrow(
    "invalid_request",
  );
  expect(() => adminFactorCredentials(`${prefix}session_token="alphaX`, true)).toThrow(
    "invalid_request",
  );
});

test("junk and percent-encoded variants cannot reset a credential's five-attempt bucket", async () => {
  const variants = ["alpha", "%61lpha", "a%6cpha", '"al%70ha"', "%61%6c%70ha"];
  for (const [index, value] of variants.entries())
    await limit(`${prefix}session_token=${value}; junk=${index}`);
  await expect(limit(`${prefix}session_token=alph%61; junk=next`)).rejects.toMatchObject({
    status: 429,
    code: "rate_limited",
  });
  const [storage] = await fixture.db
    .sql`SELECT bool_and(key ~ '^[0-9a-f]{64}$') AS hashed FROM admin_auth_throttle`;
  expect(storage?.hashed).toBe(true);
});

test("a forged session cannot mask the stable pending challenge bucket", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    await limit(`${prefix}session_token=forged-${attempt}; ${prefix}two_factor=fixed-challenge`);
  }
  await expect(
    limit(`${prefix}session_token=forged-next; ${prefix}two_factor=fixed-challenge`),
  ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
});

test("a forged challenge cannot mask the stable current session bucket", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    await limit(`${prefix}two_factor=forged-${attempt}; ${prefix}session_token=fixed-session`);
  }
  await expect(
    limit(`${prefix}two_factor=forged-next; ${prefix}session_token=fixed-session`),
  ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
});

test("login/global/network budget exhaustion does not consume the independent logout allowance", async () => {
  // Seed the exhausted admission budgets exactly as the atomic limiter persists them.
  for (const [scope, input, count] of [
    ["admin-auth-global", "all", 61],
    ["admin-auth-network", "192.0.2.1", 21],
  ] as const) {
    await fixture.db.sql`INSERT INTO admin_auth_throttle(key,count,expires_at)
      VALUES (${privateKey(secret, scope, input)},${count},now()+interval '5 minutes')`;
  }
  await expect(limit("", "/auth/get-session")).rejects.toMatchObject({ status: 429 });
  await fixture.db
    .sql`DELETE FROM admin_auth_throttle WHERE key=${privateKey(secret, "admin-auth-global", "all")}`;
  await expect(limit("", "/auth/get-session")).rejects.toMatchObject({ status: 429 });
  await expect(
    limit(`${prefix}session_token=fixed-session`, "/auth/sign-out"),
  ).resolves.toBeUndefined();
  for (let request = 1; request < 20; request++) await limit("", "/auth/sign-out");
  await expect(limit("", "/auth/sign-out")).rejects.toMatchObject({ status: 429 });
});
