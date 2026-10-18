import { Hono } from "hono";
import { AppError } from "../../platform/errors";
import type { IdentityEnvironment } from "../identity";
import { audioRoute } from "./audio";
import type { CloudService } from "./service";

/** Authentication and account lifecycle checks are installed by the API composition root. */
export function createAiRoutes(cloud: CloudService) {
  const routes = new Hono<IdentityEnvironment>();
  routes.get("/v1/models", async (c) => c.json(await cloud.catalog(c.get("identity").user.id)));
  routes.post(audioRoute, (c) => {
    const identity = c.get("identity");
    return cloud.transcribe(c.req.raw, {
      userId: identity.user.id,
      sessionId: identity.session.id,
    });
  });
  for (const [path, providerName] of [
    ["/openai/v1/responses", "openai"],
    ["/anthropic/v1/messages", "anthropic"],
    ["/openrouter/v1/chat/completions", "openrouter"],
    ["/deepseek/v1/chat/completions", "deepseek"],
    ["/v1/systemone", "typesafe"],
  ] as const) {
    routes.post(path, (c) => {
      const identity = c.get("identity");
      return cloud.generate(providerName, c.req.raw, {
        userId: identity.user.id,
        sessionId: identity.session.id,
      });
    });
  }
  routes.post("/google/v1beta/models/:action", (c) => {
    const action = c.req.param("action");
    if (!/^[A-Za-z0-9._-]+:streamGenerateContent$/.test(action))
      throw new AppError("unsupported_endpoint", 404);
    const identity = c.get("identity");
    return cloud.generate(
      "google",
      c.req.raw,
      { userId: identity.user.id, sessionId: identity.session.id },
      action.split(":")[0],
    );
  });
  return routes;
}
