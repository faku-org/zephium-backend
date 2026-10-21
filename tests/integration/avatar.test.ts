import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createApp } from "../../src/apps/api/app";
import type { BillingProvider } from "../../src/modules/billing/provider";
import { createAuth, type Mailer } from "../../src/modules/identity/auth";
import { createAvatarService } from "../../src/modules/identity/avatars/service";
import type { IdentitySession } from "../../src/modules/identity/contracts";
import { AppError } from "../../src/platform/errors";
import { testDatabase } from "../support/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let app: ReturnType<typeof createApp>;
let auth: ReturnType<typeof createAuth>;
let original: Buffer;
let processed: Buffer;
const mail = new Map<string, string>();
const mailer: Mailer = {
  sendOTP: async (email, otp) => {
    mail.set(email, otp);
  },
};
const provider: BillingProvider = {
  state: async () => null,
  checkout: async () => ({
    url: "https://sandbox.polar.sh/test",
    expiresAt: new Date(Date.now() + 3600000),
  }),
  portal: async () => "https://sandbox.polar.sh/test",
  openCheckoutUntil: async () => null,
  deleteCustomer: async () => {},
};
beforeAll(async () => {
  fixture = await testDatabase();
  auth = createAuth(fixture.config, fixture.db, mailer);
  app = createApp(fixture.config, fixture.db, auth, provider, undefined, undefined, mailer);
  original = await sharp({
    create: { width: 64, height: 48, channels: 4, background: "#2456ef80" },
  })
    .png()
    .toBuffer();
  processed = await sharp(original).resize(256, 256).webp().toBuffer();
}, 30000);
afterAll(async () => {
  await fixture?.close();
});

function request(
  path: string,
  method = "GET",
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function code(email: string) {
  for (let i = 0; i < 200; i++) {
    const otp = mail.get(email);
    if (otp) return otp;
    await Bun.sleep(10);
  }
  throw new Error("Expected in-memory OTP delivery");
}
async function login() {
  const email = `${crypto.randomUUID()}@example.test`;
  expect(
    (
      await request("/api/auth/email-otp/send-verification-otp", "POST", undefined, {
        email,
        type: "sign-in",
      })
    ).status,
  ).toBe(202);
  const signedIn = await request("/api/auth/sign-in/email-otp", "POST", undefined, {
    email,
    otp: await code(email),
    device: "Avatar test",
  });
  expect(signedIn.status).toBe(200);
  const token = signedIn.headers.get("set-auth-token");
  if (!token) throw new Error("Missing signed-in token");
  const identity = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${token}` }),
    query: { disableCookieCache: true },
  });
  if (!identity) throw new Error("Missing signed-in identity");
  return { email, token, identity };
}
function uploadRequest(bytes = original, signal?: AbortSignal) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "image/png" }),
    "private-filename.png",
  );
  return new Request("http://localhost:3000/v1/account/avatar", {
    method: "PUT",
    body: form,
    signal,
  });
}
async function upload(token: string, bytes = original) {
  const raw = uploadRequest(bytes);
  const headers = new Headers(raw.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return app.request(new Request(raw, { headers }));
}
function path(url: string) {
  return new URL(url).pathname;
}
function version(url: string) {
  return path(url).split("/").at(-1)?.slice(0, -5) as string;
}
async function stored(identity: IdentitySession) {
  return fixture.db
    .sql`SELECT content,version FROM account_avatar WHERE user_id=${identity.user.id}`;
}
function controlledProcessor() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createAvatarService(fixture.config, fixture.db, async () => {
    entered();
    await gate;
    return processed;
  });
  return { service, started, release };
}

test("private current-version GET and 304 enforce ownership, session, headers and byte-exact export", async () => {
  const owner = await login();
  const stranger = await login();
  expect(await (await request("/v1/account", "GET", owner.token)).json()).toMatchObject({
    avatar_url: null,
  });
  const replaced = await upload(owner.token);
  expect(replaced.status).toBe(200);
  expect(replaced.headers.get("cache-control")).toBe("no-store");
  const { avatar_url: url } = (await replaced.json()) as { avatar_url: string };
  expect(new URL(url).origin).toBe(fixture.config.API_ORIGIN);
  const response = await request(path(url), "GET", owner.token);
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(await sharp(bytes).metadata()).toMatchObject({ format: "webp", width: 256, height: 256 });
  const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
  expect(response.headers.get("etag")).toBe(etag);
  expect(response.headers.get("content-type")).toBe("image/webp");
  expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(response.headers.get("vary")?.toLowerCase()).toContain("authorization");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const cached = await request(path(url), "GET", owner.token, undefined, { "If-None-Match": etag });
  expect(cached.status).toBe(304);
  expect((await cached.arrayBuffer()).byteLength).toBe(0);
  expect(cached.headers.get("cache-control")).toBe("private, no-cache");
  expect(
    (await request(path(url), "GET", undefined, undefined, { "If-None-Match": etag })).status,
  ).toBe(401);
  for (const conditional of [etag, "*"]) {
    const foreign = await request(path(url), "GET", stranger.token, undefined, {
      "If-None-Match": conditional,
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "avatar_not_found" } });
  }
  const exported = (await (await request("/v1/account/export", "GET", owner.token)).json()) as {
    account: { avatar_url: string; avatar: { data: string } };
  };
  expect(exported.account.avatar_url).toBe(url);
  expect(exported.account.avatar).toMatchObject({
    media_type: "image/webp",
    width: 256,
    height: 256,
    encoding: "base64",
  });
  expect(Buffer.from(exported.account.avatar.data, "base64").equals(bytes)).toBe(true);
  const replacement = await upload(owner.token);
  const next = (await replacement.json()) as { avatar_url: string };
  expect(next.avatar_url).not.toBe(url);
  expect(
    (await request(path(url), "GET", owner.token, undefined, { "If-None-Match": etag })).status,
  ).toBe(404);
  expect((await request("/v1/logout", "POST", owner.token)).status).toBe(204);
  expect(
    (await request(path(next.avatar_url), "GET", owner.token, undefined, { "If-None-Match": "*" }))
      .status,
  ).toBe(401);
});

test("delete is idempotent, removes export bytes, and account purge cascades", async () => {
  const owner = await login();
  const result = await upload(owner.token);
  const { avatar_url: url } = (await result.json()) as { avatar_url: string };
  for (let i = 0; i < 2; i++) {
    const removed = await request("/v1/account/avatar", "DELETE", owner.token);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ avatar_url: null });
  }
  expect(await stored(owner.identity)).toHaveLength(0);
  expect((await request(path(url), "GET", owner.token)).status).toBe(404);
  expect(await (await request("/v1/account/export", "GET", owner.token)).json()).toMatchObject({
    account: { avatar_url: null, avatar: null },
  });
  expect((await upload(owner.token)).status).toBe(200);
  await fixture.db.sql`DELETE FROM auth_user WHERE id=${owner.identity.user.id}`;
  expect(await stored(owner.identity)).toHaveLength(0);
});

test("a failed processor preserves the previous version and bytes", async () => {
  const owner = await login();
  const service = createAvatarService(fixture.config, fixture.db, async () => processed);
  const first = await service.upload(owner.identity, uploadRequest());
  const failing = createAvatarService(fixture.config, fixture.db, async () => {
    throw new AppError("avatar_processing_failed", 422);
  });
  await expect(failing.upload(owner.identity, uploadRequest())).rejects.toMatchObject({
    code: "avatar_processing_failed",
    status: 422,
  });
  expect(await service.profile(owner.identity.user.id)).toEqual(first);
  expect(
    (await service.get(owner.identity, version(first.avatar_url))).bytes.equals(processed),
  ).toBe(true);
});

test("code-confirmed deletion removes existing bytes before cleanup and cannot be undone by blocked decoding", async () => {
  const owner = await login();
  expect((await upload(owner.token)).status).toBe(200);
  const pending = controlledProcessor();
  const outcome = pending.service.upload(owner.identity, uploadRequest()).then(
    () => null,
    (error: unknown) => error,
  );
  await pending.started;
  try {
    mail.delete(owner.email);
    expect((await request("/v1/account/deletion/code", "POST", owner.token)).status).toBe(202);
    expect(
      (await request("/v1/account/deletion", "POST", owner.token, { otp: await code(owner.email) }))
        .status,
    ).toBe(202);
    expect(await stored(owner.identity)).toHaveLength(0);
    expect(
      (await fixture.db.sql`SELECT lifecycle FROM auth_user WHERE id=${owner.identity.user.id}`)[0]
        ?.lifecycle,
    ).toBe("deleting");
  } finally {
    pending.release();
  }
  expect(await outcome).toMatchObject({ code: "account_unavailable", status: 403 });
  expect(await stored(owner.identity)).toHaveLength(0);
});

test("logout and email change during decode prevent the old session from saving", async () => {
  for (const action of ["logout", "email-change"] as const) {
    const owner = await login();
    const existing = createAvatarService(fixture.config, fixture.db, async () => processed);
    const first = await existing.upload(owner.identity, uploadRequest());
    const pending = controlledProcessor();
    const outcome = pending.service.upload(owner.identity, uploadRequest()).then(
      () => null,
      (error: unknown) => error,
    );
    await pending.started;
    try {
      if (action === "logout")
        expect((await request("/v1/logout", "POST", owner.token)).status).toBe(204);
      else {
        const email = `${crypto.randomUUID()}@example.test`;
        expect(
          (await request("/v1/account/email/code", "POST", owner.token, { email })).status,
        ).toBe(202);
        expect(
          (
            await request("/v1/account/email", "PATCH", owner.token, {
              email,
              otp: await code(email),
            })
          ).status,
        ).toBe(200);
      }
    } finally {
      pending.release();
    }
    expect(await outcome).toMatchObject({ code: "unauthorized", status: 401 });
    expect(await existing.profile(owner.identity.user.id)).toEqual(first);
    expect(Buffer.from((await stored(owner.identity))[0]?.content).equals(processed)).toBe(true);
  }
});

test("an abort after decode starts preserves the existing avatar", async () => {
  const owner = await login();
  const existing = createAvatarService(fixture.config, fixture.db, async () => processed);
  const first = await existing.upload(owner.identity, uploadRequest());
  const pending = controlledProcessor();
  const controller = new AbortController();
  const outcome = pending.service
    .upload(owner.identity, uploadRequest(original, controller.signal))
    .then(
      () => null,
      (error: unknown) => error,
    );
  await pending.started;
  controller.abort();
  pending.release();
  expect(await outcome).toMatchObject({ code: "request_timeout", status: 408 });
  expect(await existing.profile(owner.identity.user.id)).toEqual(first);
});

test("six account uploads per hour are shared by service and API and delete stays available", async () => {
  const owner = await login();
  const service = createAvatarService(fixture.config, fixture.db, async () => processed);
  for (let i = 0; i < 6; i++) await service.upload(owner.identity, uploadRequest());
  const before = await service.profile(owner.identity.user.id);
  const limited = await upload(owner.token);
  expect(limited.status).toBe(429);
  const retry = Number(limited.headers.get("retry-after"));
  expect(retry).toBeGreaterThan(0);
  expect(retry).toBeLessThanOrEqual(3600);
  expect(await limited.json()).toMatchObject({
    error: { code: "rate_limited", retry_after: retry },
  });
  expect(await service.profile(owner.identity.user.id)).toEqual(before);
  expect((await request("/v1/account/avatar", "DELETE", owner.token)).status).toBe(200);
});

test("concurrent replacements retain one complete version with matching digest and export bytes", async () => {
  const owner = await login();
  const slow = controlledProcessor();
  const delayed = slow.service.upload(owner.identity, uploadRequest());
  await slow.started;
  let earlier: { avatar_url: string };
  try {
    const otherBytes = await sharp({
      create: { width: 256, height: 256, channels: 3, background: "red" },
    })
      .webp()
      .toBuffer();
    const fast = createAvatarService(fixture.config, fixture.db, async () => otherBytes);
    earlier = await fast.upload(owner.identity, uploadRequest());
    expect(
      (await fast.get(owner.identity, version(earlier.avatar_url))).bytes.equals(otherBytes),
    ).toBe(true);
  } finally {
    slow.release();
  }
  const last = await delayed;
  expect(last.avatar_url).not.toBe(earlier.avatar_url);
  expect(await stored(owner.identity)).toHaveLength(1);
  expect(await slow.service.profile(owner.identity.user.id)).toEqual(last);
  const current = await slow.service.get(owner.identity, version(last.avatar_url));
  expect(current.bytes.equals(processed)).toBe(true);
  expect(current.etag).toBe(`"${createHash("sha256").update(processed).digest("hex")}"`);
  await expect(slow.service.get(owner.identity, version(earlier.avatar_url))).rejects.toMatchObject(
    { code: "avatar_not_found", status: 404 },
  );
  const exported = await slow.service.export(owner.identity.user.id);
  expect(exported.avatar_url).toBe(last.avatar_url);
  expect(Buffer.from(exported.avatar?.data ?? "", "base64").equals(current.bytes)).toBe(true);
});

test("two sessions share the account avatar and revoking one leaves the other authorized", async () => {
  const first = await login();
  // Seed through the auth server API to avoid the public resend cooldown; the
  // second device still redeems its OTP through the public sign-in boundary.
  const otp = await auth.api.createVerificationOTP({
    body: { email: first.email, type: "sign-in" },
  });
  const signedIn = await request("/api/auth/sign-in/email-otp", "POST", undefined, {
    email: first.email,
    otp,
    device: "Second avatar device",
  });
  expect(signedIn.status).toBe(200);
  const secondToken = signedIn.headers.get("set-auth-token");
  if (!secondToken) throw new Error("Missing second signed-in token");
  expect(secondToken).not.toBe(first.token);
  const secondIdentity = await auth.api.getSession({
    headers: new Headers({ Authorization: `Bearer ${secondToken}` }),
    query: { disableCookieCache: true },
  });
  expect(secondIdentity?.user.id).toBe(first.identity.user.id);
  expect(secondIdentity?.session.id).not.toBe(first.identity.session.id);

  const uploaded = await upload(first.token);
  expect(uploaded.status).toBe(200);
  const { avatar_url: initialUrl } = (await uploaded.json()) as { avatar_url: string };
  expect(await (await request("/v1/account", "GET", secondToken)).json()).toMatchObject({
    avatar_url: initialUrl,
  });
  const downloaded = await request(path(initialUrl), "GET", secondToken);
  expect(downloaded.status).toBe(200);
  const initialBytes = Buffer.from(await downloaded.arrayBuffer());
  const exportedResponse = await request("/v1/account/export", "GET", secondToken);
  expect(exportedResponse.status).toBe(200);
  const exported = (await exportedResponse.json()) as {
    account: { avatar_url: string; avatar: { data: string } };
  };
  expect(exported.account.avatar_url).toBe(initialUrl);
  expect(Buffer.from(exported.account.avatar.data, "base64").equals(initialBytes)).toBe(true);

  const differentImage = await sharp({
    create: { width: 96, height: 80, channels: 3, background: "#ffcc00" },
  })
    .png()
    .toBuffer();
  const replacement = await upload(first.token, differentImage);
  expect(replacement.status).toBe(200);
  const { avatar_url: currentUrl } = (await replacement.json()) as { avatar_url: string };
  expect(currentUrl).not.toBe(initialUrl);
  expect(await (await request("/v1/account", "GET", secondToken)).json()).toMatchObject({
    avatar_url: currentUrl,
  });
  expect((await request(path(initialUrl), "GET", secondToken)).status).toBe(404);
  const current = await request(path(currentUrl), "GET", secondToken);
  expect(current.status).toBe(200);
  expect(Buffer.from(await current.arrayBuffer()).equals(initialBytes)).toBe(false);
  const etag = current.headers.get("etag");
  if (!etag) throw new Error("Missing current avatar ETag");

  expect(
    (await request(`/v1/sessions/${first.identity.session.id}`, "DELETE", secondToken)).status,
  ).toBe(204);
  expect((await request("/v1/account", "GET", first.token)).status).toBe(401);
  expect(
    (await request(path(currentUrl), "GET", first.token, undefined, { "If-None-Match": etag }))
      .status,
  ).toBe(401);
  expect(
    (await request(path(currentUrl), "GET", secondToken, undefined, { "If-None-Match": etag }))
      .status,
  ).toBe(304);
  expect((await request("/v1/account/export", "GET", secondToken)).status).toBe(200);
  expect((await upload(secondToken)).status).toBe(200);
});
