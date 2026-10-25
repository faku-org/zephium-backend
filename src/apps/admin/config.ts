import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  ADMIN_ORIGIN: z.url(),
  ADMIN_AUTH_SECRET: z.string().min(48),
  ADMIN_AUTH_DATABASE_URL: z.string().startsWith("postgres"),
  ADMIN_READ_DATABASE_URL: z.string().startsWith("postgres"),
  ADMIN_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  ADMIN_TRUSTED_PROXY_CIDRS: z.string().default(""),
  ADMIN_TRUSTED_CLOUDFLARE_CIDRS: z.string().default(""),
});
export type AdminConfig = z.infer<typeof schema>;
export function readAdminConfig(
  env: Record<string, string | undefined> = process.env,
): AdminConfig {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid admin configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = result.data;
  const url = new URL(c.ADMIN_ORIGIN);
  if (
    url.origin !== c.ADMIN_ORIGIN ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        c.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Admin requires an exact HTTPS origin (loopback HTTP allowed only outside production)",
    );
  if (c.NODE_ENV === "production" && c.ADMIN_AUTH_DATABASE_URL === c.ADMIN_READ_DATABASE_URL)
    throw new Error("Admin requires separate authentication and read-only database roles");
  return c;
}
