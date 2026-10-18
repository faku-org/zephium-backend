import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { CloudService } from "../../modules/ai";
import type { IdentityEnvironment } from "../../modules/identity";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
export function installPublicRoutes(
  app: Hono<IdentityEnvironment>,
  config: Config,
  db: Database,
  cloud?: CloudService,
) {
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", async (c) => {
    await db.sql`SELECT 1`;
    return c.json({ status: "ok" });
  });

  app.get("/v1/source", (c) =>
    c.json({ license: "AGPL-3.0-only", source_url: config.SOURCE_URL ?? null }),
  );
  app.get("/v1/client-config", (c) => {
    const body = JSON.stringify({
      schema_version: 1,
      cloud_enabled: !!cloud?.policy.enabled,
      signup_open: config.SIGNUP_OPEN === "true",
      signup_mode:
        config.SIGNUP_OPEN !== "true"
          ? "closed"
          : config.SIGNUP_EMAIL_ALLOWLIST
            ? "allowlist"
            : "open",
      min_client_version: config.CLIENT_MIN_VERSION,
      billing_enabled: config.BILLING_ENABLED === "true",
      notice: config.CLIENT_NOTICE_ID
        ? {
            id: config.CLIENT_NOTICE_ID,
            text: config.CLIENT_NOTICE_TEXT,
            severity: config.CLIENT_NOTICE_SEVERITY,
          }
        : null,
    });
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    c.header("Cache-Control", "public, max-age=300, must-revalidate");
    c.header("ETag", etag);
    if (
      c.req
        .header("If-None-Match")
        ?.split(",")
        .map((v) => v.trim())
        .includes(etag)
    )
      return c.body(null, 304);
    return c.body(body, 200, { "Content-Type": "application/json" });
  });
}
