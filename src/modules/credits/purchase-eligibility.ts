import type { Tx } from "../../platform/db";
import { AppError } from "../../platform/errors";

/** Call after the account billing lock, before committing a new purchase intent.
 * Refund processing shares this wallet lock. An absent wallet is a new customer,
 * not a reason to create an allowance or deny their first purchase.
 */
export async function assertPurchaseAllowed(tx: Tx, userId: string): Promise<void> {
  const [wallet] = await tx`SELECT suspended FROM credit_wallet WHERE user_id=${userId} FOR UPDATE`;
  if (wallet?.suspended) throw new AppError("billing_review_required", 403);
}
