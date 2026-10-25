import { z } from "zod";
import {
  ADMIN_AUTH_PATH,
  ADMIN_SESSION_SECONDS,
  type AdminAuth,
  type AdminAuthDatabase,
} from "./auth";

const signIn = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(128) })
  .strict();
const enable = z.object({ password: z.string().min(1).max(128) }).strict();
const verify = z.object({ code: z.string().min(1).max(64) }).strict();
export const ADMIN_AUTH_ROUTES = new Map([
  [`${ADMIN_AUTH_PATH}/sign-in/email`, "POST"],
  [`${ADMIN_AUTH_PATH}/get-session`, "GET"],
  [`${ADMIN_AUTH_PATH}/two-factor/enable`, "POST"],
  [`${ADMIN_AUTH_PATH}/two-factor/verify-totp`, "POST"],
  [`${ADMIN_AUTH_PATH}/two-factor/verify-backup-code`, "POST"],
  [`${ADMIN_AUTH_PATH}/sign-out`, "POST"],
]);

// Never accept bearer credentials, customer cookies, or trusted-device cookies.
// This exact set also makes future Better Auth cookies opt-in at our boundary.
function authHeaders(input: Headers, secure: boolean): Headers {
  const headers = new Headers(input);
  headers.delete("authorization");
  const prefix = `${secure ? "__Secure-" : ""}zephium-admin.`;
  const names = new Set([
    `${prefix}session_token`,
    `${prefix}two_factor`,
    `${prefix}dont_remember`,
  ]);
  headers.set(
    "cookie",
    (input.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => names.has(part.slice(0, part.indexOf("="))))
      .join("; "),
  );
  return headers;
}
function secureAuth(auth: AdminAuth): boolean {
  return auth.options.baseURL?.toString().startsWith("https://") === true;
}

export async function getAdminSession(headers: Headers, auth: AdminAuth, db: AdminAuthDatabase) {
  const data = await auth.api.getSession({ headers: authHeaders(headers, secureAuth(auth)) });
  if (!data) return null;
  const [row] = await db.sql`
    SELECT s.created_at, s.expires_at, s.mfa_verified_at,
      (u.two_factor_enabled AND f.verified IS TRUE) AS enrolled,
      (s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at > now() - interval '1 hour'
       AND s.created_at > now() - interval '1 hour'
       AND u.two_factor_enabled AND f.verified IS TRUE) AS mfa_verified
    FROM admin_auth_session s JOIN admin_auth_user u ON u.id=s.user_id
    LEFT JOIN admin_auth_two_factor f ON f.user_id=u.id
    WHERE s.id=${data.session.id} AND s.user_id=${data.user.id} AND s.expires_at > now() AND u.active`;
  if (!row) return null;
  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.name,
    enrolled: row.enrolled === true,
    mfaVerified: row.mfa_verified === true,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export type AdminSession = NonNullable<Awaited<ReturnType<typeof getAdminSession>>>;

function json(body: unknown, status = 200, source?: Headers): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const cookie of source?.getSetCookie() ?? []) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
function responseSessionHeaders(requestHeaders: Headers, responseHeaders: Headers): Headers {
  const result = new Headers(requestHeaders);
  const cookies = new Map<string, string>();
  for (const part of (result.get("cookie") ?? "").split(";")) {
    const pair = part.trim();
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  for (const part of responseHeaders.getSetCookie()) {
    const pair = part.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  result.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  return result;
}

/** The app must apply persistent throttling and a request-size limit before this handler. */
export async function handleAdminAuth(
  request: Request,
  auth: AdminAuth,
  db: AdminAuthDatabase,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.search || ADMIN_AUTH_ROUTES.get(url.pathname) !== request.method)
    return json({ error: "not_found" }, 404);
  const origin = new URL(auth.options.baseURL as string).origin;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    return json({ error: "forbidden" }, 403);
  if (request.method === "POST" && request.headers.get("origin") !== origin)
    return json({ error: "forbidden" }, 403);
  const headers = authHeaders(request.headers, secureAuth(auth));
  if (url.pathname.endsWith("/get-session")) {
    const session = await getAdminSession(headers, auth, db);
    return json({ session });
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    return json({ error: "invalid_request" }, 400);
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  let body: unknown;
  if (url.pathname.endsWith("/sign-in/email")) {
    const parsed = signIn.safeParse(input);
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    body = { ...parsed.data, email: parsed.data.email.toLowerCase(), rememberMe: false };
  } else if (url.pathname.endsWith("/two-factor/enable")) {
    const parsed = enable.safeParse(input);
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    const session = await getAdminSession(headers, auth, db);
    if (!session || session.enrolled || Date.now() - Date.parse(session.createdAt) > 600_000)
      return json({ error: "fresh_password_required" }, 403);
    body = { ...parsed.data, method: "totp" };
  } else if (url.pathname.endsWith("/sign-out")) {
    if (!z.object({}).strict().safeParse(input).success)
      return json({ error: "invalid_request" }, 400);
    body = {};
  } else {
    const parsed = verify.safeParse(input);
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    body = { ...parsed.data, trustDevice: false };
  }
  headers.delete("content-length");
  const response = await auth.handler(
    new Request(`${origin}${url.pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok)
    return json({ error: "authentication_failed" }, response.status, response.headers);
  const output = (await response.json()) as Record<string, unknown>;
  if (url.pathname.endsWith("/two-factor/enable"))
    return json(
      { totpURI: output.totpURI, backupCodes: output.backupCodes },
      200,
      response.headers,
    );
  if (url.pathname.endsWith("/verify-totp") || url.pathname.endsWith("/verify-backup-code")) {
    // Better Auth 1.7.3 rotates the enrollment session but returns its old token in
    // JSON. Resolve the signed response cookie instead; never use output.token.
    const verifiedHeaders = authHeaders(
      responseSessionHeaders(headers, response.headers),
      secureAuth(auth),
    );
    const current = await auth.api.getSession({ headers: verifiedHeaders });
    if (!current) return json({ error: "authentication_failed" }, 401, response.headers);
    const marked = await db.sql`
      UPDATE admin_auth_session s SET mfa_verified_at=now(),
        expires_at=LEAST(s.expires_at, s.created_at + ${ADMIN_SESSION_SECONDS} * interval '1 second')
      FROM admin_auth_user u, admin_auth_two_factor f
      WHERE s.id=${current.session.id} AND s.user_id=${current.user.id}
        AND u.id=s.user_id AND f.user_id=u.id AND u.active AND u.two_factor_enabled AND f.verified
        AND s.expires_at > now() AND s.created_at > now() - interval '1 hour'
      RETURNING s.id`;
    if (!marked.length) return json({ error: "totp_enrollment_required" }, 403, response.headers);
  }
  return json(
    { success: true, twoFactorRedirect: output.twoFactorRedirect === true },
    200,
    response.headers,
  );
}
