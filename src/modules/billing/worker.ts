import type { Database } from "../../platform/db";
import { operationalEvent } from "../../platform/errors";
import {
  cleanupExpiredActionCodes,
  cleanupExpiredAuthCodes,
  cleanupExpiredSessions,
  purgeAccount,
} from "../identity";
import type { BillingProvider } from "./provider";
import { subscriptionDecision } from "./service";

/** Row locks provide exclusive ownership and release automatically on crash. Network calls have timeouts. */
export async function workOnce(
  db: Database,
  provider: BillingProvider,
  products: string[],
  ranks: Record<string, number> = {},
): Promise<boolean> {
  return db.sql.begin(async (tx) => {
    const [row] =
      await tx`SELECT b.*, u.lifecycle, u.email FROM billing_customer b JOIN auth_user u ON u.id=b.user_id
      WHERE b.next_attempt <= now() AND b.attempts < 10 AND
      (b.provider_touched OR u.lifecycle='deleting') AND
      (u.lifecycle='deleting' OR b.requested > b.processed OR b.reconciled_at IS NULL OR b.reconciled_at < now()-interval '15 minutes')
      ORDER BY b.next_attempt FOR UPDATE OF b SKIP LOCKED LIMIT 1`;
    if (!row) return false;
    try {
      if (row.lifecycle === "deleting") {
        const [pending] =
          await tx`SELECT EXISTS(SELECT 1 FROM cloud_request WHERE user_id=${row.user_id} AND state IN ('preflight','reserved','running','usage_unknown')) OR EXISTS(SELECT 1 FROM cloud_outbox o JOIN cloud_request r ON r.id=o.request_id WHERE r.user_id=${row.user_id} AND o.delivered_at IS NULL) OR EXISTS(SELECT 1 FROM billing_order_job WHERE user_id=${row.user_id} AND requested>processed) AS waiting`;
        if (pending?.waiting) {
          await tx`UPDATE billing_customer SET next_attempt=now()+interval '1 minute' WHERE user_id=${row.user_id}`;
          return true;
        }
        if (row.checkout_until && new Date(row.checkout_until) > new Date()) {
          await tx`UPDATE billing_customer SET next_attempt=${row.checkout_until} WHERE user_id=${row.user_id}`;
          return true;
        }
        // Seal first, wait out pending checkouts, then cancel/anonymize in Polar before deleting locally.
        // Listing on every retry also recovers a checkout whose create response was lost.
        const openUntil = row.provider_touched
          ? await provider.openCheckoutUntil(row.user_id)
          : null;
        if (openUntil && openUntil > new Date()) {
          await tx`UPDATE billing_customer SET next_attempt=${openUntil.toISOString()} WHERE user_id=${row.user_id}`;
          return true;
        }
        if (row.provider_touched) {
          await provider.deleteCustomer(row.user_id);
          if (await provider.state(row.user_id)) throw new Error("Provider deletion not confirmed");
        }
        await purgeAccount(tx, row.user_id, row.email);
      } else {
        const state = await provider.state(row.user_id);
        if (state && state.accountId !== row.user_id) throw new Error("Identity mismatch");
        const decision = subscriptionDecision(state, products, new Date(), ranks);
        await tx`UPDATE billing_customer SET polar_id=${state?.customerId ?? null}, status=${decision.status}, paid_until=${decision.paidUntil?.toISOString() ?? null},
          subscription_id=${decision.subscriptionId},product_id=${decision.productId},period_start=${decision.periodStart?.toISOString() ?? null},subscription_start=${decision.subscriptionStart?.toISOString() ?? null},
          cancel_at_period_end=${decision.cancelAtPeriodEnd}, reconciled_at=now(), processed=${row.requested}, attempts=0,
          next_attempt=now()+interval '15 minutes' WHERE user_id=${row.user_id}`;
      }
    } catch {
      const attempts = Number(row.attempts) + 1;
      await tx`UPDATE billing_customer SET attempts=${attempts}, next_attempt=now()+${Math.min(3600, 15 * 2 ** attempts)}*interval '1 second' WHERE user_id=${row.user_id}`;
      operationalEvent(attempts >= 10 ? "billing_work_exhausted" : "billing_work_retry");
    }
    return true;
  }) as Promise<boolean>;
}
export async function cleanup(db: Database) {
  await cleanupExpiredActionCodes(db.sql);
  await db.sql`DELETE FROM abuse_bucket WHERE expires_at < now()-interval '1 hour'`;
  await cleanupExpiredAuthCodes(db.sql);
  await cleanupExpiredSessions(db.sql);
  await db.sql`DELETE FROM billing_event WHERE received_at < now()-interval '90 days'`;
}
