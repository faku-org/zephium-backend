import { Hono } from "hono";
import { AppError } from "../../../platform/errors";
import type { IdentityEnvironment } from "../contracts";
import { avatarPath } from "./limits";
import type { AvatarService } from "./service";

export function createAvatarRoutes(service: AvatarService) {
  const app = new Hono<IdentityEnvironment>();
  app.put(avatarPath, async (c) => c.json(await service.upload(c.get("identity"), c.req.raw)));
  app.delete(avatarPath, async (c) => c.json(await service.remove(c.get("identity"))));
  app.get(`${avatarPath}/:file`, async (c) => {
    const file = c.req.param("file");
    if (!file.endsWith(".webp")) throw new AppError("avatar_not_found", 404);
    // Resolve ownership/current version before inspecting any conditional header.
    const image = await service.get(c.get("identity"), file.slice(0, -5));
    c.header("Cache-Control", "private, no-cache");
    c.header("Vary", "Authorization", { append: true });
    c.header("ETag", image.etag);
    c.header("X-Content-Type-Options", "nosniff");
    const conditional = c.req.header("If-None-Match");
    if (
      conditional
        ?.split(",")
        .some((item) => item.trim() === "*" || item.trim().replace(/^W\//, "") === image.etag)
    )
      return c.body(null, 304);
    c.header("Content-Type", "image/webp");
    c.header("Content-Length", String(image.bytes.length));
    return c.body(new Uint8Array(image.bytes));
  });
  return app;
}
