import { createHash } from "node:crypto";
import type { Database } from "../../platform/db";
import { AppError } from "../../platform/errors";
import type { CustomerState } from "./provider";

export function subscriptionDecision(
  state: CustomerState | null,
  products: string[],
  now = new Date(),
  ranks: Record<string, number> = {},
) {
  const eligible = state?.subscriptions
    .filter((s) => products.includes(s.productId) && s.status === "active" && s.paidUntil > now)
    .sort(
      (a, b) =>
        (ranks[b.productId] ?? 0) - (ranks[a.productId] ?? 0) ||
        b.paidUntil.getTime() - a.paidUntil.getTime(),
    )[0];
  return {
    status: eligible ? "active" : "inactive",
    paidUntil: eligible?.paidUntil ?? null,
    cancelAtPeriodEnd: eligible?.cancelAtPeriodEnd ?? false,
    subscriptionId: eligible?.id ?? null,
    productId: eligible?.productId ?? null,
    periodStart: eligible?.periodStart ?? null,
    subscriptionStart: eligible?.subscriptionStart ?? null,
  };
}
export async function acceptEvent(
  db: Database,
  id: string,
  body: string,
  accountId: string | null,
  orderId: string | null = null,
) {
  const digest = createHash("sha256").update(body).digest("hex");
  await db.sql.begin(async (tx) => {
    const inserted =
      await tx`INSERT INTO billing_event (id,digest) VALUES (${id},${digest}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!inserted.length) {
      const [old] = await tx`SELECT digest FROM billing_event WHERE id=${id}`;
      if (old?.digest !== digest) throw new AppError("event_identity_conflict", 409);
      return;
    }
    if (accountId)
      await tx`INSERT INTO billing_customer (user_id)
      SELECT id FROM auth_user WHERE id=${accountId}
      ON CONFLICT (user_id) DO UPDATE SET provider_touched=true,requested=billing_customer.requested+1, next_attempt=now(), attempts=0`;
    if (accountId && orderId)
      await tx`INSERT INTO billing_order_job(order_id,user_id) SELECT ${orderId},id FROM auth_user WHERE id=${accountId}
      ON CONFLICT(order_id) DO UPDATE SET requested=billing_order_job.requested+1,next_attempt=now(),attempts=0`;
  });
}
export async function accountAccess(
  db: Database,
  id: string,
  products: readonly { productId: string; plan: string; interval: "monthly" | "yearly" }[] = [],
) {
  const [row] =
    await db.sql`SELECT provider_touched,status,paid_until,cancel_at_period_end,reconciled_at,product_id FROM billing_customer WHERE user_id=${id}`;
  const fresh =
    row?.reconciled_at && new Date(row.reconciled_at).getTime() > Date.now() - 24 * 60 * 60 * 1000;
  const paid = !!(
    fresh &&
    row?.status === "active" &&
    row.paid_until &&
    new Date(row.paid_until) > new Date()
  );
  const product = paid ? products.find((item) => item.productId === row?.product_id) : undefined;
  return {
    subscription: {
      plan: product?.plan ?? null,
      interval: product?.interval ?? null,
      status:
        row?.provider_touched === false
          ? "inactive"
          : fresh
            ? (row?.status ?? "unknown")
            : "unknown",
      paidUntil: row?.paid_until ? new Date(row.paid_until).toISOString() : null,
      cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
    },
    paid,
    capabilities: { hostedAI: false, synchronization: false },
  };
}
