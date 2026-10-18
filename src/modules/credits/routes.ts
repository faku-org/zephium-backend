import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import type { IdentityEnvironment } from "../identity";
import { type CloudPolicy, units } from "../policy";
import { setDailyLimit, usageSummary } from "./ledger";
import { requestReceipt, type UsageCursor, usageHistory } from "./queries";

/** Mount only after verified-account middleware has populated the identity context. */
export function createCreditRoutes(db: Database, policy: CloudPolicy) {
  const routes = new Hono<IdentityEnvironment>();
  routes.get("/v1/usage/requests", async (c) => {
    const raw = z.string().max(200).optional().parse(c.req.query("cursor"));
    let cursor: UsageCursor | undefined;
    if (raw) {
      try {
        cursor = z
          .object({ time: z.iso.datetime({ offset: true }), id: z.uuid() })
          .strict()
          .parse(JSON.parse(Buffer.from(raw, "base64url").toString()));
      } catch {
        throw new AppError("invalid_cursor");
      }
    }
    return c.json(await usageHistory(db, c.get("identity").user.id, cursor));
  });
  routes.get("/v1/usage", async (c) =>
    c.json(await usageSummary(db, policy, c.get("identity").user.id)),
  );
  routes.put("/v1/usage/limits", async (c) => {
    const body = z
      .object({ daily_limit_units: units.nullable() })
      .strict()
      .parse(await c.req.json());
    await setDailyLimit(db, policy, c.get("identity").user.id, body.daily_limit_units);
    return c.body(null, 204);
  });
  routes.get("/v1/usage/requests/:id", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    const receipt = await requestReceipt(db, c.get("identity").user.id, id);
    if (!receipt) throw new AppError("not_found", 404);
    return c.json(receipt);
  });
  return routes;
}
