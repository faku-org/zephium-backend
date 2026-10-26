import { beforeAll, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { readAdminConfig } from "../../src/apps/admin/config";
import { createAdminAccess } from "../../src/modules/admin/access";

const config = {
  ADMIN_ACCESS_MODE: "cloudflare" as const,
  ADMIN_ACCESS_ISSUER: "https://zephium-test.cloudflareaccess.com",
  ADMIN_ACCESS_AUDIENCE: "a".repeat(64),
  ADMIN_ACCESS_EMAILS: "founder@example.test",
};
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let document: string;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  document = JSON.stringify({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" }],
  });
});
async function token(claims: Record<string, unknown> = {}, key = pair.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    type: "app",
    email: config.ADMIN_ACCESS_EMAILS,
    sub: "operator-test",
    iat: now,
    exp: now + 3600,
    iss: config.ADMIN_ACCESS_ISSUER,
    aud: [config.ADMIN_ACCESS_AUDIENCE],
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(key);
}
const request = (value: string) =>
  new Request("https://dashboard.example.test/", { headers: { "cf-access-jwt-assertion": value } });

test("Access verifies signed identity and caches keys across concurrent requests", async () => {
  let calls = 0;
  const guard = createAdminAccess(config, async (url, options) => {
    calls++;
    expect(url).toBe(`${config.ADMIN_ACCESS_ISSUER}/cdn-cgi/access/certs`);
    expect(options.redirect).toBe("error");
    expect(options.credentials).toBe("omit");
    expect(new Headers(options.headers).has("cookie")).toBe(false);
    expect(new Headers(options.headers).has("cf-access-jwt-assertion")).toBe(false);
    return new Response(document);
  });
  const jwt = await token();
  await Promise.all(Array.from({ length: 8 }, () => guard(request(jwt))));
  await guard(request(jwt));
  expect(calls).toBe(1);
});

test("missing tokens and spoofed identity headers/cookies cannot reach the origin", async () => {
  let calls = 0;
  const guard = createAdminAccess(config, async () => {
    calls++;
    return new Response(document);
  });
  const headerCases: Record<string, string>[] = [
    {},
    { "cf-access-authenticated-user-email": config.ADMIN_ACCESS_EMAILS },
    { cookie: `CF_Authorization=${await token()}` },
    { "cf-access-jwt-assertion": "a".repeat(8193) },
    { "cf-access-jwt-assertion": "one.two.three,another.token.value" },
  ];
  for (const headers of headerCases) {
    await expect(
      guard(new Request("https://dashboard.example.test", { headers })),
    ).rejects.toMatchObject({ code: "admin_access_required", status: 403 });
  }
  expect(calls).toBe(0);
});

test("wrong issuer, audience, identity, expired/missing dates and non-user tokens fail closed", async () => {
  const guard = createAdminAccess(config, async () => new Response(document));
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { iss: "https://attacker.cloudflareaccess.com" },
    { aud: ["b".repeat(64)] },
    { email: "attacker@example.test" },
    { type: "service" },
    { sub: "" },
    { exp: now - 60 },
    { exp: undefined },
    { iat: undefined },
    { iat: now + 60 },
    { email: undefined },
    { type: undefined },
    { exp: now - 1, iat: now },
  ]) {
    await expect(guard(request(await token(claims)))).rejects.toMatchObject({
      code: "admin_access_required",
      status: 403,
    });
  }
  const other = await generateKeyPair("RS256");
  await expect(guard(request(await token({}, other.privateKey)))).rejects.toMatchObject({
    code: "admin_access_required",
    status: 403,
  });
  const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.fake`;
  await expect(guard(request(unsigned))).rejects.toMatchObject({
    code: "admin_access_required",
    status: 403,
  });
});

test("unavailable, oversized and malformed keys are bounded and failure is cooled down", async () => {
  for (const response of [
    () => new Response("unavailable", { status: 503 }),
    () => new Response("x".repeat(65537)),
    () => new Response('{"keys":[]}'),
    () => new Response("not JSON"),
  ]) {
    let calls = 0;
    const guard = createAdminAccess(config, async () => {
      calls++;
      return response();
    });
    const jwt = await token();
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(guard(request(jwt))).rejects.toMatchObject({
        code: "admin_access_unavailable",
        status: 503,
      });
    expect(calls).toBe(1);
  }
});

test("slow key response bodies time out, cancel, and fail closed", async () => {
  let cancelled = false;
  const guard = createAdminAccess(
    config,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await expect(guard(request(await token()))).rejects.toMatchObject({
    code: "admin_access_unavailable",
    status: 503,
  });
  expect(cancelled).toBe(true);
}, 5000);

test("Access configuration rejects partial settings and arbitrary key-fetch hosts", () => {
  const base = {
    NODE_ENV: "test",
    ADMIN_ORIGIN: "https://dashboard.example.test",
    ADMIN_AUTH_SECRET: "s".repeat(64),
    ADMIN_AUTH_DATABASE_URL: "postgres://auth",
    ADMIN_READ_DATABASE_URL: "postgres://reports",
  };
  for (const bad of [
    { ADMIN_ACCESS_MODE: "cloudflare" },
    { ...config, ADMIN_ACCESS_ISSUER: "https://localhost" },
    { ...config, ADMIN_ACCESS_ISSUER: "https://team.cloudflareaccess.com.evil.test" },
    { ...config, ADMIN_ACCESS_ISSUER: "https://team.cloudflareaccess.com/path" },
    { ...config, ADMIN_ACCESS_ISSUER: "https://u:p@team.cloudflareaccess.com" },
    { ...config, ADMIN_ACCESS_AUDIENCE: "" },
    { ...config, ADMIN_ACCESS_EMAILS: "" },
    { ...config, ADMIN_ACCESS_MODE: "off" },
  ])
    expect(() => readAdminConfig({ ...base, ...bad })).toThrow();
  expect(
    readAdminConfig({ ...base, ...config, ADMIN_ACCESS_EMAILS: " Founder@Example.Test " })
      .ADMIN_ACCESS_EMAILS,
  ).toBe("founder@example.test");
});
