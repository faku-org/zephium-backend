import type { TransactionSql } from "postgres";
import { enforce, privateKey } from "../../platform/abuse";
import type { Config } from "../../platform/config";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import type { Auth } from "./auth";
import type { IdentitySession } from "./contracts";

export async function authenticate(
  config: Config,
  db: Database,
  auth: Auth,
  headers: Headers,
): Promise<IdentitySession> {
  const identity = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!identity) throw new AppError("unauthorized", 401);
  if (!identity.user.emailVerified) throw new AppError("email_not_verified", 403);
  const [user] = await db.sql`SELECT lifecycle FROM auth_user WHERE id=${identity.user.id}`;
  if (user?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
  await enforce(db, privateKey(config.ABUSE_SECRET, "account-api", identity.user.id), 60, 1200);
  return identity;
}

/** Call after account locks: revocation and expiry must be checked after waiting. */
export async function assertMutationSession(
  tx: TransactionSql,
  userId: string,
  sessionId: string,
  fresh = false,
): Promise<void> {
  const [session] = await tx`SELECT created_at,expires_at FROM auth_session
    WHERE id=${sessionId} AND user_id=${userId} FOR SHARE`;
  const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
  const now = new Date(clock?.db_now).getTime();
  if (!session || new Date(session.expires_at).getTime() <= now)
    throw new AppError("unauthorized", 401);
  if (fresh && now - new Date(session.created_at).getTime() > 600000)
    throw new AppError("reauthentication_required", 401);
}
