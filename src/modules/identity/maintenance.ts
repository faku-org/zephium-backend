import type { TransactionSql } from "postgres";
import type { Database } from "../../platform/db";

/** Called only after the deletion coordinator confirms provider and job cleanup. */
export async function purgeAccount(
  tx: TransactionSql,
  userId: string,
  email: string,
): Promise<void> {
  await tx`DELETE FROM auth_verification WHERE identifier=${`sign-in-otp-${email}`}`;
  await tx`DELETE FROM auth_user WHERE id=${userId}`;
}

type MaintenanceSql = Database["sql"] | TransactionSql;

export async function cleanupExpiredActionCodes(sql: MaintenanceSql): Promise<void> {
  await sql`DELETE FROM action_otp WHERE expires_at < now()`;
}

export async function cleanupExpiredAuthCodes(sql: MaintenanceSql): Promise<void> {
  await sql`DELETE FROM auth_verification WHERE expires_at < now()`;
}

export async function cleanupExpiredSessions(sql: MaintenanceSql): Promise<void> {
  await sql`DELETE FROM auth_session WHERE expires_at < now()`;
}
