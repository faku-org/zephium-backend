import { enforce, privateKey } from "../../platform/abuse";
import type { Database, Tx } from "../../platform/db";
import { AppError } from "../../platform/errors";
import { assertMutationSession } from "../identity";
import type { CloudPolicy } from "../policy";
import { type PlanChangeQuote, type PlanChangeTarget, quotePlanChange } from "./plan-change-policy";
import type { BillingProvider } from "./provider";

export type PlanChangeState =
  | "quoted"
  | "queued"
  | "executing"
  | "uncertain"
  | "applied"
  | "scheduled"
  | "failed";
export interface PlanChangeRow {
  id: string;
  user_id: string;
  session_id: string;
  policy_revision: number;
  quote: PlanChangeQuote;
  state: PlanChangeState;
  error_code: string | null;
  attempt_id: string | null;
  attempts: number;
  next_attempt: Date;
  dispatched_at: Date | null;
}
export function planChangeView(row: PlanChangeRow) {
  const q = row.quote;
  return {
    id: row.id,
    status: row.state,
    current_plan: q.current_plan,
    target_plan: q.target_plan,
    interval: q.interval,
    direction: q.direction,
    effective_at: q.direction === "upgrade" ? null : q.period_end,
    amount_due_estimate: {
      amount_minor: q.estimated_prorated_amount_minor,
      currency: q.currency,
      tax_excluded: true,
    },
    recurring_price: { amount_minor: q.target_amount_minor, currency: q.currency },
    expires_at: q.expires_at,
    error: row.error_code ? { code: row.error_code } : null,
  };
}
export async function assertBillingPolicy(tx: Tx, revision: number) {
  const [active] = await tx`SELECT revision FROM cloud_active_policy WHERE singleton=true`;
  if (active?.revision !== revision) throw new AppError("cloud_policy_changed", 503);
}
export async function pendingPlanChange(tx: Tx, userId: string) {
  const [row] = await tx`SELECT id FROM billing_plan_change WHERE user_id=${userId}
    AND state IN ('queued','executing','uncertain') LIMIT 1`;
  return !!row;
}

/** Preview is read-only at Polar. Confirmation records intent; only the worker charges. */
export function createPlanChangeService(
  db: Database,
  provider: BillingProvider,
  policy: CloudPolicy | null,
  config: { BILLING_ENABLED: string; ABUSE_SECRET: string },
) {
  function enabled() {
    if (config.BILLING_ENABLED !== "true") throw new AppError("billing_not_enabled", 503);
    if (!policy || !provider.subscription || !provider.changeSubscription || !provider.productOffer)
      throw new AppError("subscription_change_unavailable", 503);
    return policy;
  }
  async function get(userId: string, id: string) {
    const [row] = await db.sql<
      PlanChangeRow[]
    >`SELECT * FROM billing_plan_change WHERE id=${id} AND user_id=${userId}`;
    if (!row) throw new AppError("plan_change_not_found", 404);
    return planChangeView(row);
  }
  async function preview(userId: string, sessionId: string, target: PlanChangeTarget) {
    const p = enabled();
    const readSubscription = provider.subscription;
    const readOffer = provider.productOffer;
    if (!readSubscription || !readOffer) throw new AppError("billing_unavailable", 503);
    await enforce(db, privateKey(config.ABUSE_SECRET, "billing-plan-preview", userId), 60, 6);
    const products = p.subscriptions.filter(
      (s) =>
        s.plan === target.plan && s.interval === target.interval && s.checkoutEnabled !== false,
    );
    if (products.length !== 1 || !products[0]) throw new AppError("invalid_plan_change", 400);
    const [before] =
      await db.sql`SELECT subscription_id,polar_id,product_id FROM billing_customer WHERE user_id=${userId}`;
    if (!before?.subscription_id) throw new AppError("billing_refresh_required", 409);
    let subscription: Awaited<ReturnType<NonNullable<BillingProvider["subscription"]>>>;
    let offer: Awaited<ReturnType<NonNullable<BillingProvider["productOffer"]>>>;
    try {
      [subscription, offer] = await Promise.all([
        readSubscription(before.subscription_id),
        readOffer(products[0].productId, {
          kind: "subscription",
          interval: target.interval,
        }),
      ]);
    } catch {
      throw new AppError("billing_unavailable", 503);
    }
    if (subscription.accountId !== userId || subscription.customerId !== before.polar_id)
      throw new AppError("provider_identity_mismatch", 503);
    return db.sql.begin(async (tx) => {
      const [b] =
        await tx`SELECT b.*,u.lifecycle FROM billing_customer b JOIN auth_user u ON u.id=b.user_id WHERE b.user_id=${userId} FOR UPDATE OF b`;
      if (b?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
      await assertMutationSession(tx, userId, sessionId);
      await assertBillingPolicy(tx, p.revision);
      if (await pendingPlanChange(tx, userId)) throw new AppError("plan_change_in_progress", 409);
      if (
        b.subscription_id !== subscription.id ||
        b.product_id !== subscription.productId ||
        b.polar_id !== subscription.customerId
      )
        throw new AppError("billing_refresh_required", 409);
      const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
      const quote = quotePlanChange(p, subscription, target, offer, new Date(clock?.db_now));
      const [row] = await tx<
        PlanChangeRow[]
      >`INSERT INTO billing_plan_change(id,user_id,session_id,policy_revision,quote)
        VALUES (${crypto.randomUUID()},${userId},${sessionId},${p.revision},${JSON.stringify(quote)}::jsonb) RETURNING *`;
      if (!row) throw new Error("Plan change not recorded");
      return planChangeView(row);
    });
  }
  async function confirm(userId: string, sessionId: string, id: string) {
    const p = enabled();
    return db.sql.begin(async (tx) => {
      const [b] =
        await tx`SELECT b.*,u.lifecycle FROM billing_customer b JOIN auth_user u ON u.id=b.user_id WHERE b.user_id=${userId} FOR UPDATE OF b`;
      if (b?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
      const [row] = await tx<
        PlanChangeRow[]
      >`SELECT * FROM billing_plan_change WHERE id=${id} AND user_id=${userId} FOR UPDATE`;
      if (!row) throw new AppError("plan_change_not_found", 404);
      await assertMutationSession(tx, userId, sessionId, row.state === "quoted");
      // The quote UUID is the idempotency key. Never enqueue an already submitted operation.
      if (row.state !== "quoted") return planChangeView(row);
      await assertBillingPolicy(tx, p.revision);
      const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
      if (
        row.policy_revision !== p.revision ||
        new Date(row.quote.expires_at) <= new Date(clock?.db_now)
      )
        throw new AppError("plan_change_expired", 409);
      if (await pendingPlanChange(tx, userId)) throw new AppError("plan_change_in_progress", 409);
      if (
        b.subscription_id !== row.quote.subscription_id ||
        b.product_id !== row.quote.current_product_id
      )
        throw new AppError("subscription_change_unavailable", 409);
      await tx`UPDATE billing_plan_change SET state='queued',session_id=${sessionId},next_attempt=clock_timestamp() WHERE id=${id}`;
      // Invalidate refreshes which fetched a snapshot before this mutation was queued.
      await tx`UPDATE billing_customer SET provider_touched=true,requested=requested+1 WHERE user_id=${userId}`;
      return planChangeView({ ...row, state: "queued" });
    });
  }
  return { preview, confirm, get };
}
