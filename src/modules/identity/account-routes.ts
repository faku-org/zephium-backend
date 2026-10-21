import { Hono } from "hono";
import { z } from "zod";
import type { AccountService } from "./account";
import { createAvatarRoutes } from "./avatars/routes";
import type { IdentityEnvironment } from "./contracts";

export function createAccountRoutes(service: AccountService) {
  const app = new Hono<IdentityEnvironment>();
  const emailChange = z.object({ email: z.email().max(254) }).strict();
  app.route("/", createAvatarRoutes(service.avatars));
  app.get("/v1/account", async (c) => c.json(await service.account(c.get("identity"))));
  app.patch("/v1/account", async (c) => {
    const { name } = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[^\p{Cc}\p{Cf}]*$/u)
          .nullable(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.updateProfile(c.get("identity"), name));
  });
  app.get("/v1/account/export", async (c) =>
    c.json(await service.exportAccount(c.get("identity"))),
  );
  app.get("/v1/sessions", async (c) =>
    c.json({ sessions: await service.sessions(c.get("identity")) }),
  );
  app.delete("/v1/sessions/:id", async (c) => {
    await service.revokeSession(c.get("identity"), c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/v1/logout", async (c) => {
    const identity = c.get("identity");
    await service.revokeSession(identity, identity.session.id);
    return c.body(null, 204);
  });
  app.post("/v1/logout-all", async (c) => {
    await service.revokeAll(c.get("identity"));
    return c.body(null, 204);
  });
  app.post("/v1/account/deletion/code", async (c) => {
    await service.requestDeletion(c.get("identity"));
    return c.json({ accepted: true }, 202);
  });
  app.post("/v1/account/deletion", async (c) => {
    const { otp } = z
      .object({ otp: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(await c.req.json());
    await service.confirmDeletion(c.get("identity"), otp);
    return c.json({ status: "deleting" }, 202);
  });
  app.post("/v1/account/email/code", async (c) => {
    const { email } = emailChange.parse(await c.req.json());
    await service.requestEmailChange(c.get("identity"), email);
    return c.json({ accepted: true }, 202);
  });
  app.patch("/v1/account/email", async (c) => {
    const { email, otp } = emailChange
      .extend({ otp: z.string().regex(/^\d{6}$/) })
      .parse(await c.req.json());
    await service.confirmEmailChange(c.get("identity"), email, otp);
    return c.json({ updated: true, reauthentication_required: true });
  });
  return app;
}
