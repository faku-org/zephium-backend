import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { AppError } from "../../platform/errors";

type AccessConfig = {
  ADMIN_ACCESS_MODE: "off" | "cloudflare";
  ADMIN_ACCESS_ISSUER: string;
  ADMIN_ACCESS_AUDIENCE: string;
  ADMIN_ACCESS_EMAILS: string;
};
type KeyFetch = (url: string, options: RequestInit) => Promise<Response>;

/** An additional perimeter gate, never a replacement for operator authentication/MFA. */
export function createAdminAccess(config: AccessConfig, fetchKeys: KeyFetch = fetch) {
  if (config.ADMIN_ACCESS_MODE === "off") return async (_request: Request) => {};
  const emails = new Set(config.ADMIN_ACCESS_EMAILS.split(","));
  const certs = new URL(`${config.ADMIN_ACCESS_ISSUER}/cdn-cgi/access/certs`);
  let failedUntil = 0;
  const keys = createRemoteJWKSet(certs, {
    timeoutDuration: 3000,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
    [customFetch]: async (url, options) => {
      if (Date.now() < failedUntil) throw new AppError("admin_access_unavailable", 503, 30);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const signal = AbortSignal.any([options.signal as AbortSignal, AbortSignal.timeout(3000)]);
      const cancel = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        // The URL comes only from validated operator configuration, never JWT fields.
        const response = await fetchKeys(url, {
          ...options,
          signal,
          redirect: "error",
          credentials: "omit",
        });
        reader = response.body?.getReader();
        if (response.status !== 200 || !reader) throw new Error("key_response");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          if (signal.aborted) throw new Error("key_timeout");
          const part = await reader.read();
          if (signal.aborted) throw new Error("key_timeout");
          if (part.done) break;
          size += part.value.length;
          if (size > 65536) throw new Error("key_response_size");
          chunks.push(part.value);
        }
        const document: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !document ||
          typeof document !== "object" ||
          !("keys" in document) ||
          !Array.isArray(document.keys) ||
          document.keys.length === 0 ||
          document.keys.length > 20
        )
          throw new Error("key_document");
        return new Response(JSON.stringify(document), {
          headers: { "content-type": "application/json" },
        });
      } catch {
        failedUntil = Date.now() + 30000;
        throw new AppError("admin_access_unavailable", 503, 30);
      } finally {
        signal.removeEventListener("abort", cancel);
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    },
  });
  return async (request: Request): Promise<void> => {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (
      !token ||
      token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw new AppError("admin_access_required", 403);
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: config.ADMIN_ACCESS_ISSUER,
        audience: config.ADMIN_ACCESS_AUDIENCE,
        requiredClaims: ["exp", "iat", "sub", "email", "type"],
        clockTolerance: 5,
      });
      if (
        payload.type !== "app" ||
        typeof payload.sub !== "string" ||
        !payload.sub ||
        typeof payload.email !== "string" ||
        !emails.has(payload.email.toLowerCase()) ||
        typeof payload.iat !== "number" ||
        payload.iat > Date.now() / 1000 + 5 ||
        typeof payload.exp !== "number" ||
        payload.exp <= payload.iat
      )
        throw new Error("access_identity");
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Do not log the JWT, its claims, cookies, or library errors.
      throw new AppError("admin_access_required", 403);
    }
  };
}
