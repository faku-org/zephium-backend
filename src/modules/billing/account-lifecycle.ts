import type { Tx } from "../../platform/db";
import { AppError } from "../../platform/errors";

/** Identity commands participate in the existing billing -> account lock order. */
export async function lockAccountBilling(tx: Tx, userId: string) {
  const [row] = await tx`SELECT user_id FROM billing_customer WHERE user_id=${userId} FOR UPDATE`;
  if (!row) throw new AppError("account_unavailable", 403);
}

export async function scheduleAccountDeletion(tx: Tx, userId: string) {
  await tx`UPDATE billing_customer SET next_attempt=now(),attempts=0 WHERE user_id=${userId}`;
}
