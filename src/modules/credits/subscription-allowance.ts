import type { Tx } from "../../platform/db";
import { AppError } from "../../platform/errors";
import { cycleAt } from "../policy";
import { grant } from "./grants";

export interface PaidUpgrade {
  fromPlan: string;
  toPlan: string;
  fromAllowance: string;
  toAllowance: string;
  policyRevision: number;
  subscriptionStart: Date;
  paidUntil: Date;
  effectiveAt: Date;
}

/** Caller holds the billing row. Retain the period, spent units and outstanding holds. */
export async function applyPaidUpgrade(tx: Tx, userId: string, change: PaidUpgrade) {
  await tx`INSERT INTO credit_wallet(user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`;
  await tx`SELECT user_id FROM credit_wallet WHERE user_id=${userId} FOR UPDATE`;
  const [clock] = await tx`SELECT clock_timestamp() AS db_now`;
  const now = new Date(clock?.db_now);
  const period = cycleAt(change.subscriptionStart, change.effectiveAt, { kind: "calendar_month" });
  period.end = new Date(Math.min(period.end.getTime(), change.paidUntil.getTime()));
  // Recovery after renewal must not mint spendable credit for a finished period.
  if (period.end <= now) return;
  if (change.effectiveAt < period.start || change.effectiveAt >= period.end)
    throw new AppError("billing_review_required", 403);
  const rows = await tx`SELECT g.*,p.configuration FROM credit_grant g
    JOIN cloud_policy p ON p.revision=g.policy_revision
    WHERE g.user_id=${userId} AND g.kind='included' AND g.plan_id IN (${change.fromPlan},${change.toPlan})
      AND g.period_start<=${change.effectiveAt.toISOString()}::timestamptz
      AND g.expires_at>${change.effectiveAt.toISOString()}::timestamptz AND NOT g.revoked FOR UPDATE OF g`;
  if (rows.length > 1 || (rows[0] && rows[0].plan_id !== change.fromPlan))
    throw new AppError("billing_review_required", 403);
  const existing = rows[0];
  // Existing periods retain their original allowance basis even after policy edits.
  const historical = existing?.configuration?.plans?.find(
    (p: { id: string; allowanceUnits: string }) => p.id === change.fromPlan,
  )?.allowanceUnits;
  const basis = BigInt(existing?.allowance_basis ?? historical ?? change.fromAllowance);
  const target = BigInt(change.toAllowance);
  if (target < basis) throw new AppError("billing_review_required", 403);
  const start = existing ? new Date(existing.period_start) : period.start;
  const end = existing ? new Date(existing.expires_at) : period.end;
  if (start > change.effectiveAt || end <= change.effectiveAt)
    throw new AppError("billing_review_required", 403);
  // Round down credit grants; money estimates elsewhere round up. Never use float math.
  const delta =
    ((target - basis) * BigInt(end.getTime() - change.effectiveAt.getTime())) /
    BigInt(end.getTime() - start.getTime());
  if (existing) {
    await tx`UPDATE credit_grant SET plan_id=${change.toPlan},amount=amount+${delta.toString()},
      allowance_basis=${target.toString()} WHERE id=${existing.id}`;
  } else {
    await grant(
      tx,
      userId,
      `included:${change.fromPlan}:${start.toISOString()}`,
      "included",
      change.policyRevision,
      change.toPlan,
      (basis + delta).toString(),
      end,
      start,
    );
    await tx`UPDATE credit_grant SET allowance_basis=${target.toString()} WHERE user_id=${userId}
      AND grant_key=${`included:${change.fromPlan}:${start.toISOString()}`}`;
  }
}
