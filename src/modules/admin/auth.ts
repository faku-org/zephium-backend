import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins";
import type postgres from "postgres";
import * as schema from "./auth-schema";

export interface AdminAuthConfig {
  ADMIN_ORIGIN: string;
  ADMIN_AUTH_SECRET: string;
}
export interface AdminAuthDatabase {
  sql: postgres.Sql;
  orm: Parameters<typeof drizzleAdapter>[0];
}
export const ADMIN_AUTH_PATH = "/auth";
export const ADMIN_SESSION_SECONDS = 3600;

export function createAdminAuth(config: AdminAuthConfig, db: AdminAuthDatabase) {
  return betterAuth({
    appName: "Zephium Admin",
    baseURL: config.ADMIN_ORIGIN,
    basePath: ADMIN_AUTH_PATH,
    secret: config.ADMIN_AUTH_SECRET,
    trustedOrigins: [config.ADMIN_ORIGIN],
    database: drizzleAdapter(db.orm, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 16,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    logger: { disabled: true },
    telemetry: { enabled: false },
    advanced: {
      database: { generateId: () => randomUUID() },
      cookiePrefix: "zephium-admin",
      useSecureCookies: config.ADMIN_ORIGIN.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "strict", path: "/" },
      ipAddress: { disableIpTracking: true },
    },
    session: {
      expiresIn: ADMIN_SESSION_SECONDS,
      freshAge: 600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    // The HTTP boundary uses persistent global/account/session buckets. Better Auth's
    // IP limiter is skipped with disableIpTracking, so it is not a security control.
    rateLimit: { enabled: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-out") return;
        // Better Auth's normal logout neither revokes a pending 2FA challenge nor
        // propagates session-deletion errors. This logout must fail closed.
        const challengeCookie = ctx.context.createAuthCookie("two_factor");
        const challenge = await ctx.getSignedCookie(challengeCookie.name, ctx.context.secret);
        const token = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        await db.sql.begin(async (tx) => {
          if (challenge)
            await tx`DELETE FROM admin_auth_verification WHERE identifier IN (${challenge}, ${`2fa-attempts-${challenge}`})`;
          if (token) await tx`DELETE FROM admin_auth_session WHERE token=${token}`;
        });
        expireCookie(ctx, challengeCookie);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [operator] =
              await db.sql`SELECT active FROM admin_auth_user WHERE id=${session.userId}`;
            if (operator?.active !== true) return false;
            // Better Auth 1.7.3 uses a fixed 24h lifetime for rememberMe:false;
            // clamp every issuance, including pre-enrollment and MFA sign-in sessions.
            const expiresAt = new Date(
              Math.min(
                session.expiresAt.getTime(),
                session.createdAt.getTime() + ADMIN_SESSION_SECONDS * 1000,
              ),
            );
            return { data: { ...session, expiresAt, ipAddress: null, userAgent: null } };
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: "Zephium Admin",
        allowPasswordless: false,
        skipVerificationOnEnable: false,
        twoFactorCookieMaxAge: 300,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
    ],
  });
}
export type AdminAuth = ReturnType<typeof createAdminAuth>;
