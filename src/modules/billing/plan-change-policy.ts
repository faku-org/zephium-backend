import { AppError } from "../../platform/errors";
import type { CloudPolicy } from "../policy";
import type { BillingSubscription, ProductOffer } from "./provider";

export type PlanChangeTarget = { plan: string; interval: "monthly" | "yearly" };

function unavailable(): never {
  throw new AppError("subscription_change_unavailable", 409);
}
function invalid(): never {
  throw new AppError("invalid_plan_change", 400);
}
function configuration(): never {
  throw new AppError("product_configuration_invalid", 503);
}
function validDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function subscriptionSnapshot(subscription: BillingSubscription) {
  if (
    !subscription.accountId ||
    !subscription.id ||
    !subscription.customerId ||
    !validDate(subscription.periodStart) ||
    !validDate(subscription.paidUntil) ||
    (subscription.subscriptionStart !== null && !validDate(subscription.subscriptionStart)) ||
    (subscription.modifiedAt !== null && !validDate(subscription.modifiedAt))
  )
    unavailable();
  return {
    subscription_id: subscription.id,
    customer_id: subscription.customerId,
    account_id: subscription.accountId,
    current_product_id: subscription.productId,
    provider_status: subscription.status,
    period_start: subscription.periodStart.toISOString(),
    period_end: subscription.paidUntil.toISOString(),
    subscription_start: subscription.subscriptionStart?.toISOString() ?? null,
    provider_modified_at: subscription.modifiedAt?.toISOString() ?? null,
    prior_amount_minor: subscription.amountMinor,
    currency: subscription.currency.toUpperCase(),
    prior_recurring_interval: subscription.recurringInterval,
    prior_recurring_interval_count: subscription.recurringIntervalCount,
    prior_discount_id: subscription.discountId,
    prior_cancel_at_period_end: subscription.cancelAtPeriodEnd,
    prior_pending_change: subscription.pendingChange
      ? {
          product_id: subscription.pendingChange.productId,
          applies_at: validDate(subscription.pendingChange.appliesAt)
            ? subscription.pendingChange.appliesAt.toISOString()
            : unavailable(),
        }
      : null,
  };
}

/** Pure estimate: Polar remains authoritative for the actual tax-exclusive proration. */
export function quotePlanChange(
  policy: CloudPolicy,
  subscription: BillingSubscription,
  target: PlanChangeTarget,
  offer: ProductOffer,
  now: Date,
) {
  const snapshot = subscriptionSnapshot(subscription);
  const start = subscription.periodStart.getTime();
  const end = subscription.paidUntil.getTime();
  const current = now.getTime();
  const fullPeriod = end - start;
  const expires = Math.min(current + 5 * 60_000, end - 30_000);
  if (
    subscription.status !== "active" ||
    subscription.pendingChange !== null ||
    subscription.cancelAtPeriodEnd ||
    subscription.discountId !== null ||
    !Number.isFinite(current) ||
    start > current ||
    end <= current ||
    !Number.isSafeInteger(fullPeriod) ||
    fullPeriod <= 0 ||
    expires <= current ||
    !Number.isSafeInteger(subscription.amountMinor) ||
    subscription.amountMinor <= 0 ||
    !/^[a-z]{3}$/i.test(subscription.currency) ||
    subscription.recurringIntervalCount !== 1 ||
    !["month", "year"].includes(subscription.recurringInterval)
  )
    unavailable();
  const source = policy.subscriptions.find((item) => item.productId === subscription.productId);
  const currentPlan = policy.plans.find((plan) => plan.id === source?.plan);
  if (
    !source ||
    !currentPlan ||
    currentPlan.id === policy.freePlan ||
    (source.interval === "monthly" ? "month" : "year") !== subscription.recurringInterval
  )
    unavailable();
  if (target.plan === currentPlan.id || target.interval !== source.interval) invalid();
  const products = policy.subscriptions.filter(
    (item) =>
      item.plan === target.plan &&
      item.interval === target.interval &&
      item.checkoutEnabled !== false,
  );
  const destination = products[0];
  const targetPlan = policy.plans.find((plan) => plan.id === target.plan);
  if (products.length !== 1 || !destination || !targetPlan || target.plan === policy.freePlan)
    invalid();
  if (
    offer.productId !== destination.productId ||
    !Number.isSafeInteger(offer.price.amount_minor) ||
    offer.price.amount_minor <= 0 ||
    !/^[a-z]{3}$/i.test(offer.price.currency) ||
    offer.price.currency.toUpperCase() !== snapshot.currency ||
    currentPlan.cycle.kind !== "calendar_month" ||
    targetPlan.cycle.kind !== "calendar_month"
  )
    configuration();
  const direction: "upgrade" | "downgrade" =
    targetPlan.rank > currentPlan.rank && offer.price.amount_minor > subscription.amountMinor
      ? "upgrade"
      : targetPlan.rank < currentPlan.rank && offer.price.amount_minor < subscription.amountMinor
        ? "downgrade"
        : invalid();
  const currentAllowance = BigInt(currentPlan.allowanceUnits);
  const targetAllowance = BigInt(targetPlan.allowanceUnits);
  if (
    (direction === "upgrade" && targetAllowance < currentAllowance) ||
    (direction === "downgrade" && targetAllowance >= currentAllowance)
  )
    configuration();
  const prorated =
    direction === "upgrade"
      ? ((BigInt(offer.price.amount_minor) - BigInt(subscription.amountMinor)) *
          BigInt(end - current) +
          BigInt(fullPeriod) -
          1n) /
        BigInt(fullPeriod)
      : 0n;
  return {
    ...snapshot,
    current_plan: currentPlan.id,
    target_plan: targetPlan.id,
    target_product_id: destination.productId,
    interval: target.interval,
    direction,
    behavior: direction === "upgrade" ? ("invoice" as const) : ("next_period" as const),
    estimated_prorated_amount_minor: Number(prorated),
    estimate: true,
    tax_excluded: null as boolean | null,
    target_amount_minor: offer.price.amount_minor,
    current_allowance_units: currentPlan.allowanceUnits,
    target_allowance_units: targetPlan.allowanceUnits,
    policy_revision: policy.revision,
    quoted_at: now.toISOString(),
    expires_at: new Date(expires).toISOString(),
  };
}

export type PlanChangeQuote = ReturnType<typeof quotePlanChange>;

/** Confirmation must also check quote expiry, policy revision and caller ownership. */
export function assertPlanChangeSubscription(
  quote: PlanChangeQuote,
  subscription: BillingSubscription,
): void {
  const current = subscriptionSnapshot(subscription);
  for (const key of Object.keys(current) as (keyof typeof current)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(quote[key])) unavailable();
  }
}
